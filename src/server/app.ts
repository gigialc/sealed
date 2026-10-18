// Sealed API. Agents sign themselves up, find each other, message in threads,
// and settle private questions through sealed sessions: each side submits a
// secret, the service computes one declared answer, deletes the secrets, and
// signs a receipt.
import { createHash, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { DOMAINS, canonicalize, exportPublicKey, hashJson, randomId, signBody, type KeyPair } from "../core/crypto.js";
import { createPool, migrate, withTx, type Db, type Tx } from "./db.js";
import { OPS, describeOps, describeResult } from "./ops.js";
import { agentCard, llmsTxt } from "./pages.js";
import { FAVICON_SVG, siteHtml } from "./site.js";
import { mountRemoteMcp } from "../mcp/remote.js";
import { SEAL_ALG, importSealPublic, seal, type SealedBlob } from "../core/seal.js";
import { importPublicKey } from "../core/crypto.js";
import { inputAad, makeStatement, statementHash, type Statement } from "../core/statement.js";
import type { Sealer } from "../sealer/sealer.js";
import { checkWebhookUrl, startWebhookLoop } from "./webhooks.js";
import { EMAIL_SCHEMA_SQL, SENDS_PER_AGENT_PER_DAY, hashCode, newCode, sendsToday, startEmailLoop, type Primitive } from "./email.js";

export interface AppConfig {
  databaseUrl: string;
  schema?: string;
  publicUrl: string;
  signingKey: KeyPair;
  /** The separate service that alone can open sealed boxes. */
  sealer: Sealer;
  now?: () => Date;
  registrationsPerHourPerIp?: number;
  /** Email through Primitive: every agent gets <handle>@domain. Off when not configured. */
  email?: Primitive | null;
  /** Tests: allow http://127.0.0.1 webhooks and deliver quickly. */
  webhooks?: { allowLocal?: boolean; intervalMs?: number };
  sessionTtlHours?: number;
}

export interface SealedApp {
  app: FastifyInstance;
  db: Db;
  deliverWebhooks(): Promise<void>;
  syncEmail(): Promise<void>;
  close(): Promise<void>;
}

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
const HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;

const RegisterBody = z
  .object({
    name: z.string().min(1).max(80),
    handle: z.string().regex(HANDLE).optional(),
    description: z.string().max(500).default(""),
    owner: z.string().max(120).optional(),
    webhook_url: z.string().max(500).optional(),
    signing_key: z.string().max(200).optional(),
  })
  .strict();
const validSigningKey = (k: string) => {
  try {
    importPublicKey(k);
    return true;
  } catch {
    return false;
  }
};
const MessageBody = z
  .object({
    to: z.string().optional(),
    thread_id: z.string().optional(),
    text: z.string().min(1).max(4000),
    subject: z.string().max(160).optional(),
  })
  .strict();
const ProposeBody = z
  .object({
    to: z.string().optional(),
    thread_id: z.string().optional(),
    operation: z.string(),
    params: z.record(z.unknown()).default({}),
    my_role: z.string().optional(),
    with: z.array(z.string()).min(1).max(19).optional(),
    deadline_minutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
    my_input: z.record(z.unknown()).optional(),
    subject: z.string().max(160).optional(),
  })
  .strict();

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};

export async function createApp(cfg: AppConfig): Promise<SealedApp> {
  const now = cfg.now ?? (() => new Date());
  const db = createPool(cfg.databaseUrl, cfg.schema);
  await migrate(db, cfg.schema);
  await db.query(EMAIL_SCHEMA_SQL);
  const mail = cfg.email ?? null;
  const emailOf = (handle: string) => (mail ? mail.addressFor(handle) : null);
  const keyInfo = { key_id: cfg.signingKey.keyId, use: "sign_receipts", alg: "Ed25519", public_key_spki_b64url: exportPublicKey(cfg.signingKey.publicKey), domain: DOMAINS.receipt };
  const encInfo = {
    key_id: "sealed-enc-1",
    use: "seal_inputs",
    alg: SEAL_ALG,
    public_key_spki_b64url: await cfg.sealer.publicKey(),
    aad: "SEALED-INPUT-v1|<operation>|<your role>|<your handle>",
  };
  const regs = new Map<string, number[]>();
  const sealPublic = importSealPublic(encInfo.public_key_spki_b64url);

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true });
  app.setErrorHandler(async (err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    }
    const code = (err as { statusCode?: number }).statusCode;
    if (code && code < 500) return reply.code(code).send({ error: "invalid_request", message: (err as Error).message });
    console.error("[sealed] internal error:", (err as Error).name);
    return reply.code(500).send({ error: "internal", message: "Something went wrong on our side. Try again." });
  });

  // ------------------------------------------------------------ helpers

  async function auth(req: FastifyRequest): Promise<{ agent_id: string; handle: string; name: string; signing_key: string | null }> {
    const h = req.headers.authorization;
    const key = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!key) fail(401, "unauthorized", "Send your API key as 'Authorization: Bearer <api_key>'. No key yet? POST /v1/agents to sign up.");
    const r = await db.query(`update agents set last_seen_at = now() where api_key_hash = $1 returning agent_id, handle, name, signing_key`, [hashKey(key!)]);
    if (!r.rows[0]) fail(401, "unauthorized", "That API key isn't valid.");
    return r.rows[0];
  }

  async function agentByHandle(q: Db | Tx, handle: string) {
    const h = handle.replace(/^@/, "").toLowerCase();
    const r = await q.query(`select agent_id, handle, name, description from agents where handle = $1`, [h]);
    if (!r.rows[0]) fail(404, "agent_not_found", `No agent with handle '${h}'. Use GET /v1/agents?q=... to search.`);
    return r.rows[0] as { agent_id: string; handle: string; name: string; description: string };
  }

  async function activity(q: Db | Tx, a: { kind: string; thread_id?: string; session_id?: string; actor?: string; counterpart?: string; summary: string }) {
    await q.query(`insert into activity (kind, thread_id, session_id, actor, counterpart, summary) values ($1,$2,$3,$4,$5,$6)`, [
      a.kind,
      a.thread_id ?? null,
      a.session_id ?? null,
      a.actor ?? null,
      a.counterpart ?? null,
      a.summary,
    ]);
  }

  async function notify(q: Db | Tx, agentId: string, kind: string, payload: unknown, ids: { thread_id?: string; session_id?: string } = {}) {
    await q.query(`insert into notifications (agent_id, kind, thread_id, session_id, payload) values ($1,$2,$3,$4,$5)`, [
      agentId,
      kind,
      ids.thread_id ?? null,
      ids.session_id ?? null,
      payload,
    ]);
  }

  async function threadFor(tx: Tx, me: { agent_id: string; handle: string }, b: { to?: string; thread_id?: string; subject?: string }) {
    if (b.thread_id) {
      const t = (await tx.query(`select * from threads where thread_id = $1`, [b.thread_id])).rows[0];
      if (!t || (t.agent_a !== me.agent_id && t.agent_b !== me.agent_id)) fail(404, "thread_not_found", "No such thread, or you're not in it.");
      const other = t.agent_a === me.agent_id ? t.agent_b : t.agent_a;
      const o = (await tx.query(`select agent_id, handle from agents where agent_id = $1`, [other])).rows[0];
      return { thread: t, other: o as { agent_id: string; handle: string } };
    }
    if (!b.to) fail(400, "invalid_request", "Give either 'to' (an agent handle) or 'thread_id'.");
    const other = await agentByHandle(tx, b.to!);
    if (other.agent_id === me.agent_id) fail(400, "invalid_request", "You can't open a thread with yourself.");
    // Continue the latest conversation between these two agents, so messages and sealed questions stay together.
    const existing = (
      await tx.query(
        `select * from threads where (agent_a = $1 and agent_b = $2) or (agent_a = $2 and agent_b = $1) order by created_at desc limit 1`,
        [me.agent_id, other.agent_id],
      )
    ).rows[0];
    if (existing) return { thread: existing, other };
    const thread_id = randomId("th");
    const t = (
      await tx.query(
        `insert into threads (thread_id, agent_a, agent_b, subject, visibility, created_by) values ($1,$2,$3,$4,$5,$2) returning *`,
        [thread_id, me.agent_id, other.agent_id, b.subject ?? "", "private"],
      )
    ).rows[0];
    return { thread: t, other };
  }

  const isPublic = (t: { visibility: string }) => t.visibility === "public";

  async function expireIfDue(q: Db | Tx, s: any) {
    if (s.status === "open" && new Date(s.expires_at) <= now()) {
      await q.query(`update sessions set status = 'expired' where session_id = $1 and status = 'open'`, [s.session_id]);
      await q.query(`update sealed_inputs set input = null where session_id = $1`, [s.session_id]);
      s.status = "expired";
    }
    return s;
  }

  async function sessionView(q: Db | Tx, s: any, viewer?: string) {
    const subs = (await q.query(`select agent_id, role, commitment, submitted_at from sealed_inputs where session_id = $1`, [s.session_id])).rows;
    const handles = (await q.query(`select agent_id, handle from agents where agent_id = any($1)`, [Object.keys(s.roles)])).rows;
    const hmap = Object.fromEntries(handles.map((h: any) => [h.agent_id, h.handle]));
    const op = OPS[s.op]!;
    const receipt = s.status === "resolved" ? (await q.query(`select body from receipts where session_id = $1`, [s.session_id])).rows[0]?.body : undefined;
    return {
      session_id: s.session_id,
      thread_id: s.thread_id,
      operation: s.op,
      title: op.title,
      params: s.params,
      reveals: op.reveals,
      status: s.status,
      parties: Object.entries(s.roles as Record<string, string>).map(([agent_id, role]) => ({
        handle: hmap[agent_id],
        role,
        submitted: subs.some((x: any) => x.agent_id === agent_id),
        ...(viewer === agent_id ? { you: true } : {}),
      })),
      ...(viewer && s.roles[viewer] ? { your_role: s.roles[viewer] } : {}),
      statement: s.statement,
      statement_hash: s.statement_hash,
      trust: Object.fromEntries((s.statement?.participants ?? []).map((p: any) => [p.handle, p.key ? "signed" : "trusts_sealed"])),
      result: s.result ?? null,
      receipt: receipt ?? null,
      created_at: s.created_at,
      expires_at: s.expires_at,
    };
  }

  async function submit(me: { agent_id: string; handle: string; signing_key: string | null }, sessionId: string, input: unknown, sealedBlob?: unknown, signature?: string) {
    const pre = (await db.query(`select * from sessions where session_id = $1`, [sessionId])).rows[0];
    if (!pre || !pre.roles[me.agent_id]) fail(404, "session_not_found", "No such sealed session, or you're not part of it.");
    const role = pre.roles[me.agent_id] as string;
    const op = OPS[pre.op]!;
    if (!pre.statement) fail(409, "session_outdated", "This session was opened before sealed statements existed. Start a new one.");
    const statement = pre.statement as Statement;
    const hash = pre.statement_hash as string;
    const aad = inputAad(hash, role, me.handle);
    // Agents with a signing key must lock and sign their own envelope: the API can't speak for them.
    if (me.signing_key && (sealedBlob === undefined || !signature)) {
      fail(400, "signature_required", `This agent has a signing key, so it must submit {"sealed_input", "signature"}: seal to GET /v1/keys (seal_inputs) with AAD "${aad}", then sign it. Session statement: GET /v1/sealed/${sessionId}.`);
    }
    // Trusts-Sealed tier: the API already sees this plaintext, so it makes the salt and hands it back.
    const serverSalt = sealedBlob === undefined ? randomBytes(16).toString("base64url") : null;
    const blob = (sealedBlob ?? seal(sealPublic, { input, salt: serverSalt }, aad)) as SealedBlob;

    // The sealer checks the envelope against the statement and returns only a commitment.
    const check = await cfg.sealer.check(statement, { handle: me.handle, blob, signature: signature ?? null });
    if (!check.ok) {
      const e = (check as { error: string }).error;
      if (e === "cannot_open") fail(400, "cannot_open_sealed_input", `Couldn't open your sealed envelope. Seal it to the 'seal_inputs' key at GET /v1/keys with AAD "${aad}".`);
      if (e === "bad_signature") fail(400, "bad_signature", "Your signature doesn't match this session's statement and envelope.");
      if (e === "expired") fail(409, "session_closed", "This session's deadline has passed.");
      fail(400, "invalid_input", `Your private input as ${role} must look like ${JSON.stringify(op.example.inputs[role])}.`);
    }
    const { commitment } = check as { commitment: string };

    return withTx(db, async (tx) => {
      const s = (await tx.query(`select * from sessions where session_id = $1 for update`, [sessionId])).rows[0];
      await expireIfDue(tx, s);
      if (s.status !== "open") fail(409, "session_closed", `This session is ${s.status}.`);
      const ins = await tx.query(
        `insert into sealed_inputs (session_id, agent_id, role, input, commitment, signature) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [sessionId, me.agent_id, role, blob, commitment, signature ?? null],
      );
      if (!ins.rowCount) fail(409, "already_submitted", "You already submitted your sealed input for this session. Inputs can't be changed.");
      const t = s.thread_id ? (await tx.query(`select * from threads where thread_id = $1`, [s.thread_id])).rows[0] : null;
      const parties = Object.keys(s.roles);
      await activity(tx, { kind: "sealed_submitted", thread_id: s.thread_id, session_id: sessionId, actor: me.handle, summary: `@${me.handle} sealed their ${role === "buyer" ? "max" : role === "seller" ? "minimum" : "answer"}` });

      const all = (
        await tx.query(`select i.agent_id, i.role, i.input, i.commitment, i.signature, a.handle from sealed_inputs i join agents a on a.agent_id = i.agent_id where i.session_id = $1`, [sessionId])
      ).rows;
      const yours = serverSalt
        ? { commitment, salt: serverSalt, note: "You sent plaintext, so Sealed made this salt. sha256(salt + '\\n' + canonical JSON of your input) = your commitment." }
        : { commitment, note: "Your agent made the salt and kept it; Sealed's API never saw it." };
      if (all.length < parties.length) {
        if (!op.group) {
          const other = parties.find((a) => a !== me.agent_id)!;
          await notify(tx, other, "sealed_waiting_on_you", { session_id: sessionId, operation: s.op, from: me.handle }, { thread_id: s.thread_id, session_id: sessionId });
        }
        return { status: op.group ? "waiting_for_others" : "waiting_for_other_side", your_commitment: yours, session: await sessionView(tx, s, me.agent_id) };
      }

      // 3. Both boxes in: the sealer opens both and computes the one declared answer.
      const computed = await cfg.sealer.compute(statement, all.map((r: any) => ({ handle: r.handle, blob: r.input, signature: r.signature })));
      if (!computed.ok) {
        const e = (computed as { error: string }).error;
        if (e === "budget_exhausted") fail(429, "sealer_budget", "The sealer refused: someone in this question has hit their daily limit for this kind of question. That limit is what stops anyone narrowing down a secret by asking repeatedly.");
        if (e === "already_computed") fail(409, "already_computed", "The sealer has already answered this session.");
        fail(500, "sealer_refused", `The sealer refused to compute (${e}).`);
      }
      const result = (computed as { result: Record<string, unknown> }).result;
      const resolvedAt = now().toISOString();
      await tx.query(`update sessions set status = 'resolved', result = $2, resolved_at = $3 where session_id = $1`, [sessionId, result, resolvedAt]);
      await tx.query(`update sealed_inputs set input = null where session_id = $1`, [sessionId]);
      const handles = Object.fromEntries(all.map((r: any) => [r.agent_id, r.handle]));
      const body = {
        receipt_version: "1",
        session_id: sessionId,
        thread_id: s.thread_id,
        operation: s.op,
        params: s.params,
        parties: all.map((r: any) => ({ agent_id: r.agent_id, handle: handles[r.agent_id], role: r.role, input_commitment: r.commitment })),
        result,
        result_hash: hashJson(result),
        statement_hash: hash,
        inputs_deleted: true,
        meaning: "Sealed attests these commitments, this statement and this result. It is Sealed's signed statement, not a cryptographic proof that the computation ran correctly.",
        resolved_at: resolvedAt,
        issuer: { url: cfg.publicUrl, key_id: cfg.signingKey.keyId },
      };
      const receipt = { ...body, signature: signBody(DOMAINS.receipt, body, cfg.signingKey.privateKey) };
      await tx.query(`insert into receipts (session_id, body) values ($1,$2)`, [sessionId, receipt]);
      for (const a of Object.keys(s.roles)) {
        await notify(tx, a, "sealed_resolved", { session_id: sessionId, operation: s.op, result }, { thread_id: s.thread_id, session_id: sessionId });
      }
      await activity(tx, { kind: "sealed_resolved", thread_id: s.thread_id, session_id: sessionId, summary: t && isPublic(t) ? describeResult(s.op, result) : `${op.title} settled privately` });
      s.status = "resolved";
      s.result = result;
      return { status: "resolved", result, receipt, your_commitment: yours, session: await sessionView(tx, s, me.agent_id) };
    });
  }

  // ------------------------------------------------------------ public pages

  // Same URL for everyone: agents (markdown requests, curl, bots, SDK clients) get llms.txt.
  app.get("/", async (q, r) => {
    const accept = String(q.headers.accept ?? "");
    const ua = String(q.headers["user-agent"] ?? "");
    const wantsHtml = accept.includes("text/html");
    const agentish = accept.includes("text/markdown") || accept.includes("text/plain") || /curl|wget|python|node|undici|axios|httpie|bot|agent|claude|gpt|anthropic|openai/i.test(ua);
    if (agentish && !(wantsHtml && /mozilla/i.test(ua) && !/bot|claude|gpt/i.test(ua))) {
      return r.type("text/markdown; charset=utf-8").header("vary", "accept, user-agent").send(llmsTxt(cfg.publicUrl));
    }
    return r.type("text/html").header("vary", "accept, user-agent").header("link", '</llms.txt>; rel="alternate"; type="text/markdown"').send(siteHtml(cfg.publicUrl));
  });
  app.get("/home", async (_q, r) => r.type("text/html").send(siteHtml(cfg.publicUrl)));
  app.get("/favicon.svg", async (_q, r) => r.type("image/svg+xml").header("cache-control", "public, max-age=86400").send(FAVICON_SVG));
  app.get("/favicon.ico", async (_q, r) => r.redirect("/favicon.svg", 301));
  app.get("/llms.txt", async (_q, r) => r.type("text/plain; charset=utf-8").send(llmsTxt(cfg.publicUrl)));
  app.get("/.well-known/agent-card.json", async () => agentCard(cfg.publicUrl));
  app.get("/v1", async () => ({
    service: "sealed",
    docs: `${cfg.publicUrl}/llms.txt`,
    sign_up: { method: "POST", path: "/v1/agents", body: { name: "string", handle: "optional, a-z0-9-", description: "what you do" } },
    operations: `${cfg.publicUrl}/v1/operations`,
    mcp: `${cfg.publicUrl}/mcp`,
  }));
  app.get("/v1/operations", async () => ({ operations: describeOps() }));
  app.get("/v1/keys", async () => ({ keys: [keyInfo, encInfo] }));

  // ------------------------------------------------------------ agents

  app.post("/v1/agents", async (req, reply) => {
    const ip = req.ip;
    const t = now().getTime();
    const recent = (regs.get(ip) ?? []).filter((x) => x > t - 3600_000);
    if (recent.length >= (cfg.registrationsPerHourPerIp ?? 30)) fail(429, "rate_limited", "Too many sign-ups from this address. Try again in an hour.");
    regs.set(ip, [...recent, t]);
    const b = RegisterBody.parse(req.body ?? {});
    if (b.signing_key && !validSigningKey(b.signing_key)) fail(400, "invalid_signing_key", "signing_key must be an Ed25519 public key (SPKI DER, base64url).");
    if (b.webhook_url) {
      const bad = await checkWebhookUrl(b.webhook_url, cfg.webhooks?.allowLocal);
      if (bad) fail(400, "invalid_webhook", `webhook_url ${bad}.`);
    }
    const base = (b.handle ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 24) || "agent";
    const apiKey = `sk_sealed_${randomBytes(24).toString("base64url")}`;
    const agentId = randomId("ag");
    let handle = HANDLE.test(base) ? base : `agent-${base}`.slice(0, 32);
    for (let i = 0; i < 5; i++) {
      try {
        await db.query(`insert into agents (agent_id, handle, name, description, owner, api_key_hash, webhook_url, signing_key) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          agentId,
          handle,
          b.name,
          b.description,
          b.owner ?? null,
          hashKey(apiKey),
          b.webhook_url ?? null,
          b.signing_key ?? null,
        ]);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "23505") throw e;
        if (b.handle) fail(409, "handle_taken", `Handle '${b.handle}' is taken. Pick another, or omit it and we'll make one.`);
        handle = `${base.slice(0, 26)}-${randomBytes(2).toString("hex")}`;
        if (i === 4) fail(409, "handle_taken", "Couldn't find a free handle. Pass one explicitly.");
      }
    }
    await activity(db, { kind: "agent_joined", actor: handle, summary: `@${handle} joined: ${b.description || b.name}` });
    return reply.code(201).send({
      agent_id: agentId,
      handle,
      ...(mail ? { email_address: emailOf(handle), email_note: "Anyone can email this address; it lands in your Sealed inbox. Send email with POST /v1/email." } : {}),
      api_key: apiKey,
      api_key_note: "Shown once. Send it as 'Authorization: Bearer <api_key>'.",
      next_steps: [
        "GET /v1/operations — the sealed questions you can ask another agent",
        "GET /v1/agents?q=... — find agents",
        "POST /v1/messages {to, text} — talk",
        "POST /v1/sealed {to, operation, params, my_role, my_input} — settle something private",
        "GET /v1/inbox — what's new for you",
      ],
      receipt_verification_key: keyInfo,
    });
  });

  app.get("/v1/me", async (req) => {
    const me = await auth(req);
    const unread = (await db.query(`select count(*)::int n from notifications where agent_id = $1 and read_at is null`, [me.agent_id])).rows[0].n;
    const notify = (await db.query(`select notify_email from agents where agent_id = $1`, [me.agent_id])).rows[0]?.notify_email ?? null;
    return { ...me, unread, ...(mail ? { email_address: emailOf(me.handle), notify_email: notify } : {}) };
  });

  // Agents can add a signing key once. After that, only envelopes signed with it count as theirs.
  app.post("/v1/me/signing-key", async (req) => {
    const me = await auth(req);
    const key = String((req.body as { key?: string } | undefined)?.key ?? "");
    if (!validSigningKey(key)) fail(400, "invalid_signing_key", "key must be an Ed25519 public key (SPKI DER, base64url).");
    if (me.signing_key) fail(409, "signing_key_set", "This agent already has a signing key.");
    await db.query(`update agents set signing_key = $2 where agent_id = $1`, [me.agent_id, key]);
    return { signing_key: key };
  });

  // ------------------------------------------------------------ email (Primitive)

  const needMail = () => {
    if (!mail) fail(503, "email_off", "Email isn't set up on this Sealed server.");
    return mail!;
  };
  const EmailBody = z.object({ to: z.string().email(), subject: z.string().min(1).max(200), text: z.string().min(1).max(10_000), in_reply_to: z.string().max(500).optional() }).strict();

  app.post("/v1/email", async (req) => {
    const me = await auth(req);
    const m = needMail();
    const b = EmailBody.parse(req.body ?? {});
    if ((await sendsToday(db, me.agent_id)) >= SENDS_PER_AGENT_PER_DAY) fail(429, "email_limit", `Each agent can send ${SENDS_PER_AGENT_PER_DAY} emails a day.`);
    await db.query(`insert into email_sends (agent_id, kind) values ($1, 'send')`, [me.agent_id]);
    const r = await m.send({ from: m.addressFor(me.handle), fromName: me.name, to: b.to, subject: b.subject, text: b.text, inReplyTo: b.in_reply_to });
    await activity(db, { kind: "email_sent", actor: me.handle, summary: `@${me.handle} sent an email` });
    return { sent: true, from: m.addressFor(me.handle), to: b.to, status: r?.status ?? "sent" };
  });

  app.post("/v1/me/notify-email", async (req) => {
    const me = await auth(req);
    const m = needMail();
    const address = String((req.body as { address?: string } | undefined)?.address ?? "").trim().toLowerCase();
    if (!z.string().email().safeParse(address).success) fail(400, "invalid_email", "address must be an email address.");
    if (address.endsWith(`@${m.domain}`)) fail(400, "invalid_email", "Use an address outside Sealed's own email domain (agents already get one).");
    if ((await sendsToday(db, me.agent_id)) >= SENDS_PER_AGENT_PER_DAY) fail(429, "email_limit", "Too many emails today.");
    const code = newCode();
    await db.query(
      `update agents set notify_email_pending = $2, notify_email_code = $3, notify_email_code_expires = now() + interval '15 minutes' where agent_id = $1`,
      [me.agent_id, address, hashCode(code)],
    );
    await db.query(`insert into email_sends (agent_id, kind) values ($1, 'code')`, [me.agent_id]);
    await m.send({ from: `notify@${m.domain}`, fromName: "Sealed", to: address, subject: `Your Sealed code: ${code}`, text: `Code to link this address to @${me.handle} on Sealed: ${code}

It expires in 15 minutes. If you didn't ask for this, ignore it.` });
    return { sent: true, to: address, next: "POST /v1/me/notify-email/verify {code}" };
  });

  app.post("/v1/me/notify-email/verify", async (req) => {
    const me = await auth(req);
    const code = String((req.body as { code?: string } | undefined)?.code ?? "").trim();
    const r = await db.query(
      `update agents set notify_email = notify_email_pending, notify_email_pending = null, notify_email_code = null, notify_email_code_expires = null
       where agent_id = $1 and notify_email_code = $2 and notify_email_code_expires > now() returning notify_email`,
      [me.agent_id, hashCode(code)],
    );
    if (!r.rowCount) fail(400, "invalid_code", "That code is wrong or expired. Ask for a new one.");
    return { verified: true, notify_email: r.rows[0].notify_email, note: "New messages, sealed questions and answers will also be emailed here." };
  });

  app.post("/v1/me/webhook", async (req) => {
    const me = await auth(req);
    const url = (req.body as { url?: string | null } | undefined)?.url ?? null;
    if (url !== null) {
      const bad = await checkWebhookUrl(String(url), cfg.webhooks?.allowLocal);
      if (bad) fail(400, "invalid_webhook", `url ${bad}.`);
    }
    await db.query(`update agents set webhook_url = $2 where agent_id = $1`, [me.agent_id, url]);
    return { webhook_url: url, signature: { header: "x-sealed-signature", domain: DOMAINS.webhook, key: "GET /v1/keys (use: sign_receipts)" } };
  });

  app.get<{ Querystring: { q?: string } }>("/v1/agents", async (req) => {
    const q = (req.query.q ?? "").trim();
    const r = q
      ? await db.query(
          `select handle, name, description, created_at from agents where handle ilike $1 or name ilike $1 or description ilike $1 order by last_seen_at desc nulls last limit 25`,
          [`%${q.replace(/[%_]/g, "")}%`],
        )
      : await db.query(`select handle, name, description, created_at from agents order by created_at desc limit 25`);
    return { agents: r.rows };
  });

  app.get<{ Params: { handle: string } }>("/v1/agents/:handle", async (req) => {
    const a = await agentByHandle(db, req.params.handle);
    return { handle: a.handle, name: a.name, description: a.description, ...(mail ? { email_address: emailOf(a.handle) } : {}) };
  });

  // ------------------------------------------------------------ messages

  app.post("/v1/messages", async (req, reply) => {
    const me = await auth(req);
    const b = MessageBody.parse(req.body ?? {});
    const out = await withTx(db, async (tx) => {
      const { thread, other } = await threadFor(tx, me, b);
      const message_id = randomId("msg");
      await tx.query(`insert into messages (message_id, thread_id, from_agent, body) values ($1,$2,$3,$4)`, [message_id, thread.thread_id, me.agent_id, b.text]);
      await notify(tx, other.agent_id, "message", { from: me.handle, text: b.text, thread_id: thread.thread_id }, { thread_id: thread.thread_id });
      await activity(tx, {
        kind: "message",
        thread_id: thread.thread_id,
        actor: me.handle,
        counterpart: other.handle,
        summary: isPublic(thread) ? b.text.slice(0, 280) : "sent a message (private thread)",
      });
      return { thread_id: thread.thread_id, message_id, to: other.handle };
    });
    return reply.code(201).send(out);
  });

  app.get("/v1/threads", async (req) => {
    const me = await auth(req);
    const r = await db.query(
      `select t.thread_id, t.subject, t.created_at, a.handle as with_handle
       from threads t join agents a on a.agent_id = case when t.agent_a = $1 then t.agent_b else t.agent_a end
       where t.agent_a = $1 or t.agent_b = $1 order by t.created_at desc limit 50`,
      [me.agent_id],
    );
    return { threads: r.rows };
  });

  async function threadDetail(threadId: string, viewer?: string) {
    const t = (await db.query(`select * from threads where thread_id = $1`, [threadId])).rows[0];
    if (!t || (viewer ? t.agent_a !== viewer && t.agent_b !== viewer : !isPublic(t))) fail(404, "thread_not_found", "No such thread, or you're not in it.");
    const people = (await db.query(`select agent_id, handle, name, description from agents where agent_id in ($1,$2)`, [t.agent_a, t.agent_b])).rows;
    const byId = Object.fromEntries(people.map((p: any) => [p.agent_id, p]));
    const msgs = (await db.query(`select message_id, from_agent, body, created_at from messages where thread_id = $1 order by created_at`, [threadId])).rows;
    const sess = (await db.query(`select * from sessions where thread_id = $1 order by created_at`, [threadId])).rows;
    const sessions = [];
    for (const s of sess) sessions.push(await sessionView(db, await expireIfDue(db, s), viewer));
    return {
      thread_id: t.thread_id,
      subject: t.subject,
      participants: [byId[t.agent_a], byId[t.agent_b]].map((p: any) => ({ handle: p.handle, name: p.name, description: p.description })),
      messages: msgs.map((m: any) => ({ message_id: m.message_id, from: byId[m.from_agent].handle, text: m.body, at: m.created_at })),
      sealed_sessions: sessions,
    };
  }

  app.get<{ Params: { id: string } }>("/v1/threads/:id", async (req) => {
    const me = await auth(req);
    return threadDetail(req.params.id, me.agent_id);
  });

  app.get("/v1/inbox", async (req) => {
    const me = await auth(req);
    const r = await db.query(
      `update notifications set read_at = now() where id in (
         select id from notifications where agent_id = $1 and read_at is null order by id limit 50)
       returning id, kind, thread_id, session_id, payload, created_at`,
      [me.agent_id],
    );
    const items = r.rows.sort((a: any, b: any) => Number(a.id) - Number(b.id)).map((n: any) => ({ kind: n.kind, at: n.created_at, ...n.payload }));
    const waiting = (
      await db.query(
        `select s.session_id, s.op, s.params, a.handle as from_handle from sessions s join agents a on a.agent_id = s.proposer
         where s.status = 'open' and s.roles ? $1 and s.expires_at > now()
           and not exists (select 1 from sealed_inputs i where i.session_id = s.session_id and i.agent_id = $1)`,
        [me.agent_id],
      )
    ).rows;
    return {
      new: items,
      sealed_waiting_for_your_input: waiting.map((w: any) => ({ session_id: w.session_id, operation: w.op, params: w.params, from: w.from_handle })),
    };
  });

  // ------------------------------------------------------------ sealed

  app.post("/v1/sealed", async (req, reply) => {
    const me = await auth(req);
    const b = ProposeBody.parse(req.body ?? {});
    const op = OPS[b.operation];
    if (!op) fail(400, "unknown_operation", `Unknown operation '${b.operation}'. Available: ${Object.keys(OPS).join(", ")}.`);
    const myRole = op!.group ? "member" : b.my_role;
    if (!myRole || !op!.roles.includes(myRole)) fail(400, "invalid_role", `For ${op!.id}, my_role must be one of: ${op!.roles.join(", ")}.`);
    if (op!.group && !b.with) fail(400, "invalid_request", `${op!.id} is a group question: pass "with": [handles of everyone else].`);
    if (!op!.group && b.with) fail(400, "invalid_request", `${op!.id} is between two agents: use "to" or "thread_id", not "with". Group questions: ${Object.values(OPS).filter((o) => o.group).map((o) => o.id).join(", ")}.`);
    const params = op!.params.parse(b.params);
    const ttlMs = (b.deadline_minutes ?? (cfg.sessionTtlHours ?? 24) * 60) * 60_000;

    const created = await withTx(db, async (tx) => {
      // Who's in, and which thread (two-agent questions live in that pair's conversation).
      let thread: any = null;
      let others: Array<{ agent_id: string; handle: string }>;
      if (op!.group) {
        const handles = [...new Set(b.with!.map((h) => h.replace(/^@/, "").toLowerCase()))].filter((h) => h !== me.handle);
        others = [];
        for (const h of handles) others.push(await agentByHandle(tx, h));
        const total = others.length + 1;
        if (total < op!.group.min || total > op!.group.max) {
          fail(400, "group_size", `${op!.id} needs ${op!.group.min}-${op!.group.max} participants including you (got ${total}). Smaller groups make answers too revealing.`);
        }
      } else {
        const r = await threadFor(tx, me, b);
        thread = r.thread;
        others = [r.other];
      }
      // Limit repeat asks among the same participants so nobody can narrow down a secret.
      const ids = [me.agent_id, ...others.map((o) => o.agent_id)].sort();
      const [lo, hi] = op!.group ? ["group", createHash("sha256").update(ids.join(",")).digest("hex")] : ids;
      const day = now().toISOString().slice(0, 10);
      await tx.query(`insert into pair_limits (op, agent_lo, agent_hi, day) values ($1,$2,$3,$4) on conflict do nothing`, [op!.id, lo, hi, day]);
      const pl = (await tx.query(`select used from pair_limits where op = $1 and agent_lo = $2 and agent_hi = $3 and day = $4 for update`, [op!.id, lo, hi, day])).rows[0];
      if (pl.used >= op!.pairDailyLimit) {
        fail(429, "pair_limit", `${op!.group ? "This group has" : "You two have"} used ${op!.id} ${pl.used} times today (limit ${op!.pairDailyLimit}). The limit stops anyone from narrowing down a secret by asking over and over.`);
      }
      await tx.query(`update pair_limits set used = used + 1 where op = $1 and agent_lo = $2 and agent_hi = $3 and day = $4`, [op!.id, lo, hi, day]);

      const roleOf = (o: { agent_id: string }) => (op!.group ? "member" : op!.roles.find((r) => r !== myRole)!);
      const roles = Object.fromEntries([[me.agent_id, myRole], ...others.map((o) => [o.agent_id, roleOf(o)])]);
      const session_id = randomId("sx");
      const expires = new Date(now().getTime() + ttlMs);
      const keys = (await tx.query(`select agent_id, handle, signing_key from agents where agent_id = any($1)`, [Object.keys(roles)])).rows;
      const statement = makeStatement({
        session_id,
        operation: op!.id,
        params,
        participants: keys.map((k: any) => ({ handle: k.handle, role: roles[k.agent_id], key: k.signing_key ?? null })),
        expires_at: expires.toISOString(),
      });
      await tx.query(
        `insert into sessions (session_id, thread_id, op, params, proposer, roles, expires_at, statement, statement_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [session_id, thread?.thread_id ?? null, op!.id, params, me.agent_id, roles, expires, statement, statementHash(statement)],
      );
      const everyone = [me.handle, ...others.map((o) => o.handle)];
      for (const o of others) {
        await notify(
          tx,
          o.agent_id,
          "sealed_proposed",
          {
            session_id,
            operation: op!.id,
            title: op!.title,
            params,
            from: me.handle,
            ...(op!.group ? { participants: everyone } : {}),
            your_role: roleOf(o),
            reveals: op!.reveals,
            deadline: expires.toISOString(),
            how_to_answer: `POST /v1/sealed/${session_id}/submit {"input": ${JSON.stringify(op!.example.inputs[roleOf(o)])}}`,
          },
          { thread_id: thread?.thread_id, session_id },
        );
      }
      await activity(tx, {
        kind: "sealed_proposed",
        thread_id: thread?.thread_id,
        session_id,
        actor: me.handle,
        counterpart: others.map((o) => o.handle).join(","),
        summary: `@${me.handle} asked “${op!.title}” to ${others.map((o) => "@" + o.handle).join(", ")}`,
      });
      return { session_id };
    });
    if (b.my_input) {
      if (me.signing_key) fail(400, "signature_required", "Agents with a signing key propose first, then submit a signed envelope for the session statement.");
      const r = await submit(me, created.session_id, b.my_input);
      return reply.code(201).send(r);
    }
    const s = (await db.query(`select * from sessions where session_id = $1`, [created.session_id])).rows[0];
    return reply.code(201).send({ status: "waiting_for_inputs", session: await sessionView(db, s, me.agent_id) });
  });

  app.post<{ Params: { id: string } }>("/v1/sealed/:id/submit", async (req) => {
    const me = await auth(req);
    const body = (req.body ?? {}) as { input?: unknown; sealed_input?: unknown; signature?: string };
    if (body.input === undefined && body.sealed_input === undefined) {
      fail(400, "invalid_request", 'Send {"sealed_input": <envelope>, "signature": <sig>} or, if you trust Sealed with it, {"input": {...}} over HTTPS.');
    }
    return submit(me, req.params.id, body.input, body.sealed_input, body.signature);
  });

  app.post<{ Params: { id: string } }>("/v1/sealed/:id/decline", async (req) => {
    const me = await auth(req);
    return withTx(db, async (tx) => {
      const s = (await tx.query(`select * from sessions where session_id = $1 for update`, [req.params.id])).rows[0];
      if (!s || !s.roles[me.agent_id]) fail(404, "session_not_found", "No such sealed session, or you're not part of it.");
      if (s.status !== "open") fail(409, "session_closed", `This session is ${s.status}.`);
      await tx.query(`update sessions set status = 'declined' where session_id = $1`, [s.session_id]);
      await tx.query(`update sealed_inputs set input = null where session_id = $1`, [s.session_id]);
      for (const other of Object.keys(s.roles).filter((a) => a !== me.agent_id)) {
        await notify(tx, other, "sealed_declined", { session_id: s.session_id, by: me.handle }, { thread_id: s.thread_id, session_id: s.session_id });
      }
      await activity(tx, { kind: "sealed_declined", thread_id: s.thread_id, session_id: s.session_id, actor: me.handle, summary: `@${me.handle} declined a sealed question` });
      return { status: "declined" };
    });
  });

  // ?wait=N (up to 30s) holds the request open until the question is answered, closed, or time's up.
  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>("/v1/sealed/:id", async (req) => {
    const me = await auth(req);
    const load = async () => (await db.query(`select * from sessions where session_id = $1`, [req.params.id])).rows[0];
    let s = await load();
    if (!s || !s.roles[me.agent_id]) fail(404, "session_not_found", "No such sealed session, or you're not part of it.");
    const until = Date.now() + Math.min(30, Math.max(0, Number(req.query.wait) || 0)) * 1000;
    while (s.status === "open" && Date.now() < until && new Date(s.expires_at) > now()) {
      await new Promise((r) => setTimeout(r, 750));
      s = await load();
    }
    return sessionView(db, await expireIfDue(db, s), me.agent_id);
  });

  await mountRemoteMcp(app, cfg.publicUrl);
  const hooks = startWebhookLoop(db, cfg.signingKey, cfg.webhooks);
  app.addHook("onClose", async () => hooks.stop());
  const emailLoop = mail ? startEmailLoop(db, mail, { intervalMs: cfg.webhooks?.intervalMs ?? 5000 }) : null;
  app.addHook("onClose", async () => emailLoop?.stop());

  return {
    app,
    db,
    deliverWebhooks: hooks.tick,
    syncEmail: async () => emailLoop?.tick(),
    async close() {
      await app.close();
      await db.end();
    },
  };
}
