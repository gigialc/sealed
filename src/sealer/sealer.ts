// The sealer: the only code that can open sealed envelopes. It enforces the
// rules itself instead of trusting the API that calls it:
//   - an envelope opens only under the exact session statement it was sealed for
//   - envelopes from agents with a signing key must carry that agent's signature
//   - the statement's deadline must not have passed
//   - each session is computed at most once, ever (its own ledger)
//   - each participant key has a daily budget per question type, counted here,
//     so new requester identities can't buy extra questions about one secret
// It never stores secrets and never returns an input.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { canonicalize } from "../core/crypto.js";
import { exportSealPublic, open, type SealKeyPair, type SealedBlob } from "../core/seal.js";
import { inputAad, statementHash, verifySubmission, type Statement } from "../core/statement.js";
import { OPS, runCompute } from "../server/ops.js";

export type CheckResult = { ok: true; commitment: string } | { ok: false; error: string };
export type ComputeResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
export interface Envelope {
  handle: string;
  blob: SealedBlob;
  signature?: string | null;
}

/** What the API needs from the sealer. In-process for dev/tests, over HTTP in production. */
export interface Sealer {
  publicKey(): Promise<string>;
  check(statement: Statement, envelope: Envelope): Promise<CheckResult>;
  compute(statement: Statement, envelopes: Envelope[]): Promise<ComputeResult>;
}

const StatementSchema = z
  .object({
    v: z.literal("2"),
    session_id: z.string().min(4).max(64),
    operation: z.string(),
    params: z.unknown(),
    participants: z.array(z.object({ handle: z.string(), role: z.string(), key: z.string().nullable() }).strict()).min(2).max(20),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

// ------------------------------------------------------------ ledger

export interface LedgerEntry {
  session_id: string;
  statement_hash?: string;
  /** The declared answer (already released to every participant), kept so a retry gets the same answer. */
  result?: Record<string, unknown>;
  op: string;
  at: number;
  /** Budget subjects: participant keys (or handle for unsigned participants). */
  subjects: string[];
}

export interface LedgerAccess {
  get(sessionId: string): LedgerEntry | undefined | Promise<LedgerEntry | undefined>;
  used(subject: string, op: string, since: number): number | Promise<number>;
  record(entry: LedgerEntry): void | Promise<void>;
}

export interface SealerLedger {
  withLock<T>(sessionId: string, subjects: string[], op: string, action: (ledger: LedgerAccess) => Promise<T>): Promise<T>;
}

/** The sealer's own memory of what it computed. Optionally file-backed; hosted instances can use PostgresLedger. */
export class Ledger implements SealerLedger {
  private readonly sessions = new Map<string, LedgerEntry>();
  private readonly entries: LedgerEntry[] = [];
  private readonly file: string | null;
  private pending: Promise<void> = Promise.resolve();

  async withLock<T>(_sessionId: string, _subjects: string[], _op: string, action: (ledger: LedgerAccess) => Promise<T>): Promise<T> {
    const prior = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await action(this); } finally { release(); }
  }

  constructor(dir?: string) {
    this.file = dir ? join(dir, "computed.jsonl") : null;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      if (existsSync(this.file!)) {
        for (const line of readFileSync(this.file!, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as LedgerEntry;
          this.sessions.set(e.session_id, e);
          this.entries.push(e);
        }
      }
    }
  }
  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }
  used(subject: string, op: string, since: number) {
    return this.entries.filter((e) => e.op === op && e.at >= since && e.subjects.includes(subject)).length;
  }
  record(e: LedgerEntry) {
    if (this.file) appendFileSync(this.file, JSON.stringify(e) + "\n");
    this.sessions.set(e.session_id, e);
    this.entries.push(e);
  }
}

export interface SealerOptions {
  ledger?: SealerLedger;
  /** Max computations per participant key, per question type, per rolling day. */
  dailyLimitPerKey?: number;
  now?: () => Date;
}

/** sha256(salt + "\n" + canonical input). Only the submitter (and the sealer, briefly) knows the salt. */
export const commitmentOf = (salt: string, input: unknown) => "sha256:" + createHash("sha256").update(`${salt}\n${canonicalize(input)}`).digest("hex");

const subjectOf = (p: { handle: string; key: string | null }) => (p.key ? `key:${p.key}` : `handle:${p.handle}`);

export class LocalSealer implements Sealer {
  private readonly ledger: SealerLedger;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(private readonly key: SealKeyPair, opts: SealerOptions = {}) {
    this.ledger = opts.ledger ?? new Ledger();
    this.limit = opts.dailyLimitPerKey ?? 5;
    this.now = opts.now ?? (() => new Date());
  }

  async publicKey() {
    return exportSealPublic(this.key.publicKey);
  }

  /** Validates the statement and one envelope; returns the opened value only to the caller inside this file. */
  private openOne(raw: unknown, env: Envelope): { ok: true; value: unknown; salt: string; statement: Statement; hash: string } | { ok: false; error: string } {
    const st = StatementSchema.safeParse(raw);
    if (!st.success) return { ok: false, error: "bad_statement" };
    const statement = st.data as Statement;
    const def = OPS[statement.operation];
    if (!def || !def.params.safeParse(statement.params).success) return { ok: false, error: "bad_statement" };
    if (new Date(statement.expires_at) <= this.now()) return { ok: false, error: "expired" };
    const me = statement.participants.find((p) => p.handle === env.handle);
    if (!me) return { ok: false, error: "not_a_participant" };
    const hash = statementHash(statement);
    if (me.key && !(env.signature && verifySubmission(me.key, hash, env.blob, env.signature))) return { ok: false, error: "bad_signature" };
    let value: unknown;
    try {
      value = open(this.key, env.blob, inputAad(hash, me.role, me.handle));
    } catch {
      return { ok: false, error: "cannot_open" };
    }
    // Envelopes carry {input, salt}. The salt is made on the agent's side and never leaves the sealer,
    // so whoever sees the commitment can't test guesses against it.
    const wrapped = value as { input?: unknown; salt?: unknown };
    if (!wrapped || typeof wrapped.salt !== "string" || wrapped.salt.length < 16) return { ok: false, error: "missing_salt" };
    const schema = def.inputs[me.role];
    const parsed = schema?.safeParse(wrapped.input);
    if (!parsed?.success) return { ok: false, error: `invalid_shape: expected ${JSON.stringify(def.example.inputs[me.role])}` };
    return { ok: true, value: parsed.data, salt: wrapped.salt, statement, hash };
  }

  async check(statement: Statement, env: Envelope): Promise<CheckResult> {
    const r = this.openOne(statement, env);
    if (!r.ok) return r;
    return { ok: true, commitment: commitmentOf(r.salt, r.value) };
  }

  async compute(statement: Statement, envelopes: Envelope[]): Promise<ComputeResult> {
    const st = StatementSchema.safeParse(statement);
    if (!st.success) return { ok: false, error: "bad_statement" };
    const s = st.data as Statement;
    const def = OPS[s.operation];
    if (!def) return { ok: false, error: "bad_statement" };
    const sizeOk = def.group
      ? s.participants.length >= def.group.min && s.participants.length <= def.group.max && s.participants.every((p) => p.role === "member")
      : s.participants.length === 2 && new Set(s.participants.map((p) => p.role)).size === 2;
    const handles = new Set(s.participants.map((p) => p.handle));
    if (!sizeOk || handles.size !== s.participants.length) return { ok: false, error: "bad_statement" };
    // Exactly one envelope from every participant, nobody else.
    if (envelopes.length !== s.participants.length || new Set(envelopes.map((e) => e.handle)).size !== envelopes.length || envelopes.some((e) => !handles.has(e.handle))) {
      return { ok: false, error: "not_all_participants" };
    }
    return this.ledger.withLock(s.session_id, s.participants.map(subjectOf), s.operation, async (ledger) => {
      const done = await ledger.get(s.session_id);
      if (done) {
        // Same statement: hand back the same answer (e.g. the API crashed before saving it). Anything else: refuse.
        if (done.statement_hash === statementHash(s) && done.result) {
          for (const env of envelopes) if (!this.openOne(s, env).ok) return { ok: false, error: "already_computed" };
          return { ok: true, result: done.result };
        }
        return { ok: false, error: "already_computed" };
      }
      const since = this.now().getTime() - 86_400_000;
      for (const p of s.participants) if (await ledger.used(subjectOf(p), s.operation, since) >= this.limit) return { ok: false, error: "budget_exhausted" };

      const opened: Array<{ role: string; input: unknown }> = [];
      for (const env of envelopes) {
        const r = this.openOne(s, env);
        if (!r.ok) return r;
        opened.push({ role: s.participants.find((p) => p.handle === env.handle)!.role, input: r.value });
      }
      // Record before releasing: a crash after this point can't be replayed into a second answer.
      const result = runCompute(def, s.params, opened);
      await ledger.record({ session_id: s.session_id, statement_hash: statementHash(s), result, op: s.operation, at: this.now().getTime(), subjects: s.participants.map(subjectOf) });
      return { ok: true, result };
    });
  }
}

export class SealerUnavailable extends Error {
  constructor() { super("Sealer temporarily unavailable"); this.name = "SealerUnavailable"; }
}

/** Talks to the sealer over a private network or authenticated HTTPS. */
export class HttpSealer implements Sealer {
  constructor(private readonly url: string, private readonly token: string, private readonly timeoutMs = 15_000) {}

  private async call(path: string, body?: unknown) {
    try {
      const r = await fetch(this.url.replace(/\/$/, "") + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-sealer-token": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      if (!r.ok && r.status !== 422) {
        await r.body?.cancel();
        throw new SealerUnavailable();
      }
      return await r.json() as any;
    } catch {
      // Do not retry POSTs here: a timed-out computation may already have been
      // committed. The caller can retry the same statement using the ledger.
      throw new SealerUnavailable();
    }
  }

  async publicKey() {
    return (await this.call("/public-key")).public_key_spki_b64url as string;
  }
  check(statement: Statement, envelope: Envelope) {
    return this.call("/check", { statement, envelope }) as Promise<CheckResult>;
  }
  compute(statement: Statement, envelopes: Envelope[]) {
    return this.call("/compute", { statement, envelopes }) as Promise<ComputeResult>;
  }
}
