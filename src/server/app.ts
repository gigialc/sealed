// Sealed API. Agents sign themselves up, find each other, message in threads,
// and settle private questions through sealed sessions: each side submits a
// secret, the service computes one declared answer, deletes the secrets, and
// signs a receipt.
import { createHash, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { DOMAINS, canonicalize, exportPublicKey, hashJson, randomId, signBody, type KeyPair } from "../core/crypto.js";
import { createPool, migrate, withTx, type Db, type Tx } from "./db.js";
import { OPS, describeOps } from "./ops.js";
import { agentCard, llmsTxt, watchHtml } from "./pages.js";
import { siteHtml } from "./site.js";
import { mountRemoteMcp } from "../mcp/remote.js";
import { SEAL_ALG, exportSealPublic, open, seal, sealAad, type SealKeyPair, type SealedBlob } from "../core/seal.js";

export interface AppConfig {
  databaseUrl: string;
  schema?: string;
  publicUrl: string;
  signingKey: KeyPair;
  /** X25519 key agents seal their secrets to. Production: from the secret store. */
  encryptionKey: SealKeyPair;
  now?: () => Date;
  registrationsPerHourPerIp?: number;
  sessionTtlHours?: number;
}

export interface SealedApp {
  app: FastifyInstance;
  db: Db;
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
  })
  .strict();
const MessageBody = z
  .object({
    to: z.string().optional(),
    thread_id: z.string().optional(),
    text: z.string().min(1).max(4000),
    subject: z.string().max(160).optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();
const ProposeBody = z
  .object({
    to: z.string().optional(),
    thread_id: z.string().optional(),
    operation: z.string(),
    params: z.record(z.unknown()).default({}),
    my_role: z.string(),
    my_input: z.record(z.unknown()).optional(),
    my_sealed_input: z.record(z.unknown()).optional(),
    subject: z.string().max(160).optional(),
    visibility: z.enum(["private", "public"]).optional(),
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
  const keyInfo = { key_id: cfg.signingKey.keyId, use: "sign_receipts", alg: "Ed25519", public_key_spki_b64url: exportPublicKey(cfg.signingKey.publicKey), domain: DOMAINS.receipt };
  const encInfo = {
    key_id: "sealed-enc-1",
    use: "seal_inputs",
    alg: SEAL_ALG,
    public_key_spki_b64url: exportSealPublic(cfg.encryptionKey.publicKey),
    aad: "SEALED-INPUT-v1|<operation>|<your role>|<your handle>",
  };
  const regs = new Map<string, number[]>();

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

  async function auth(req: FastifyRequest): Promise<{ agent_id: string; handle: string; name: string }> {
    const h = req.headers.authorization;
    const key = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!key) fail(401, "unauthorized", "Send your API key as 'Authorization: Bearer <api_key>'. No key yet? POST /v1/agents to sign up.");
    const r = await db.query(`update agents set last_seen_at = now() where api_key_hash = $1 returning agent_id, handle, name`, [hashKey(key!)]);
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

  async function threadFor(tx: Tx, me: { agent_id: string; handle: string }, b: { to?: string; thread_id?: string; subject?: string; visibility?: string }) {
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
    const thread_id = randomId("th");
    const t = (
      await tx.query(
        `insert into threads (thread_id, agent_a, agent_b, subject, visibility, created_by) values ($1,$2,$3,$4,$5,$2) returning *`,
        [thread_id, me.agent_id, other.agent_id, b.subject ?? "", b.visibility ?? "private"],
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
      result: s.result ?? null,
      receipt: receipt ?? null,
      created_at: s.created_at,
      expires_at: s.expires_at,
    };
  }

  async function submit(me: { agent_id: string; handle: string }, sessionId: string, input: unknown, sealedBlob?: unknown) {
    return withTx(db, async (tx) => {
      const s = (await tx.query(`select * from sessions where session_id = $1 for update`, [sessionId])).rows[0];
      if (!s || !s.roles[me.agent_id]) fail(404, "session_not_found", "No such sealed session, or you're not part of it.");
      await expireIfDue(tx, s);
      if (s.status !== "open") fail(409, "session_closed", `This session is ${s.status}.`);
      const role = s.roles[me.agent_id] as string;
      const op = OPS[s.op]!;
      const aad = sealAad(s.op, role, me.handle);
      if (sealedBlob !== undefined) {
        try {
          input = open(cfg.encryptionKey, sealedBlob as SealedBlob, aad);
        } catch {
          fail(400, "cannot_open_sealed_input", `Couldn't open your sealed box. Seal it to the 'seal_inputs' key at GET /v1/keys with AAD "${aad}".`);
        }
      }
      const parsed = op.inputs[role]!.safeParse(input);
      if (!parsed.success) {
        fail(400, "invalid_input", `Your private input as ${role} must look like ${JSON.stringify(op.example.inputs[role])}. ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      const salt = randomBytes(16).toString("base64url");
      const commitment = "sha256:" + createHash("sha256").update(`${salt}\n${canonicalize(parsed.data)}`).digest("hex");
      const ins = await tx.query(
        `insert into sealed_inputs (session_id, agent_id, role, input, commitment) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        // Only ciphertext is stored. Plaintext submissions are sealed here before they touch the database.
        [sessionId, me.agent_id, role, sealedBlob ?? seal(cfg.encryptionKey.publicKey, parsed.data, aad), commitment],
      );
      if (!ins.rowCount) fail(409, "already_submitted", "You already submitted your sealed input for this session. Inputs can't be changed.");
      const t = (await tx.query(`select * from threads where thread_id = $1`, [s.thread_id])).rows[0];
      const other = Object.keys(s.roles).find((a) => a !== me.agent_id)!;
      await activity(tx, { kind: "sealed_submitted", thread_id: s.thread_id, session_id: sessionId, actor: me.handle, summary: `@${me.handle} sealed their ${role} input` });

      const all = (
        await tx.query(`select i.agent_id, i.role, i.input, i.commitment, a.handle from sealed_inputs i join agents a on a.agent_id = i.agent_id where i.session_id = $1`, [sessionId])
      ).rows;
      const yours = { commitment, salt, note: "Keep the salt: sha256(salt + '\\n' + canonical JSON of your input) must equal your commitment in the receipt." };
      if (all.length < 2) {
        await notify(tx, other, "sealed_waiting_on_you", { session_id: sessionId, operation: s.op, from: me.handle }, { thread_id: s.thread_id, session_id: sessionId });
        return { status: "waiting_for_other_side", your_commitment: yours, session: await sessionView(tx, s, me.agent_id) };
      }

      // Both sides in: compute, delete the secrets, sign.
      // Opened in memory only, for this one computation.
      const inputs = Object.fromEntries(all.map((r: any) => [r.role, open(cfg.encryptionKey, r.input, sealAad(s.op, r.role, r.handle))]));
      const result = op.compute(s.params, inputs);
      const resolvedAt = now().toISOString();
      await tx.query(`update sessions set status = 'resolved', result = $2, resolved_at = $3 where session_id = $1`, [sessionId, result, resolvedAt]);
      await tx.query(`update sealed_inputs set input = null where session_id = $1`, [sessionId]);
      const handles = Object.fromEntries((await tx.query(`select agent_id, handle from agents where agent_id = any($1)`, [Object.keys(s.roles)])).rows.map((h: any) => [h.agent_id, h.handle]));
      const body = {
        receipt_version: "1",
        session_id: sessionId,
        thread_id: s.thread_id,
        operation: s.op,
        params: s.params,
        parties: all.map((r: any) => ({ agent_id: r.agent_id, handle: handles[r.agent_id], role: r.role, input_commitment: r.commitment })),
        result,
        result_hash: hashJson(result),
        inputs_deleted: true,
        resolved_at: resolvedAt,
        issuer: { url: cfg.publicUrl, key_id: cfg.signingKey.keyId },
      };
      const receipt = { ...body, signature: signBody(DOMAINS.receipt, body, cfg.signingKey.privateKey) };
      await tx.query(`insert into receipts (session_id, body) values ($1,$2)`, [sessionId, receipt]);
      for (const a of Object.keys(s.roles)) {
        await notify(tx, a, "sealed_resolved", { session_id: sessionId, operation: s.op, result }, { thread_id: s.thread_id, session_id: sessionId });
      }
      await activity(tx, {
        kind: "sealed_resolved",
        thread_id: s.thread_id,
        session_id: sessionId,
        summary: isPublic(t) ? `${op.title} → ${JSON.stringify(result)}` : `${op.title} → resolved (private thread)`,
      });
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
  app.get("/llms.txt", async (_q, r) => r.type("text/plain; charset=utf-8").send(llmsTxt(cfg.publicUrl)));
  app.get("/.well-known/agent-card.json", async () => agentCard(cfg.publicUrl));
  app.get("/watch", async (_q, r) => r.type("text/html").send(watchHtml()));
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
    const base = (b.handle ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 24) || "agent";
    const apiKey = `sk_sealed_${randomBytes(24).toString("base64url")}`;
    const agentId = randomId("ag");
    let handle = HANDLE.test(base) ? base : `agent-${base}`.slice(0, 32);
    for (let i = 0; i < 5; i++) {
      try {
        await db.query(`insert into agents (agent_id, handle, name, description, owner, api_key_hash) values ($1,$2,$3,$4,$5,$6)`, [
          agentId,
          handle,
          b.name,
          b.description,
          b.owner ?? null,
          hashKey(apiKey),
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
    return { ...me, unread };
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
    return { handle: a.handle, name: a.name, description: a.description };
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
      `select t.thread_id, t.subject, t.visibility, t.created_at, a.handle as with_handle
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
      visibility: t.visibility,
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
    if (!op!.roles.includes(b.my_role)) fail(400, "invalid_role", `For ${op!.id}, my_role must be one of: ${op!.roles.join(", ")}.`);
    const params = op!.params.parse(b.params);
    const created = await withTx(db, async (tx) => {
      const { thread, other } = await threadFor(tx, me, b);
      const [lo, hi] = [me.agent_id, other.agent_id].sort();
      const day = now().toISOString().slice(0, 10);
      await tx.query(`insert into pair_limits (op, agent_lo, agent_hi, day) values ($1,$2,$3,$4) on conflict do nothing`, [op!.id, lo, hi, day]);
      const pl = (await tx.query(`select used from pair_limits where op = $1 and agent_lo = $2 and agent_hi = $3 and day = $4 for update`, [op!.id, lo, hi, day])).rows[0];
      if (pl.used >= op!.pairDailyLimit) {
        fail(429, "pair_limit", `You two have used ${op!.id} ${pl.used} times today (limit ${op!.pairDailyLimit}). The limit stops either side from narrowing down the other's secret by asking over and over.`);
      }
      await tx.query(`update pair_limits set used = used + 1 where op = $1 and agent_lo = $2 and agent_hi = $3 and day = $4`, [op!.id, lo, hi, day]);
      const otherRole = op!.roles.find((r) => r !== b.my_role)!;
      const session_id = randomId("sx");
      const expires = new Date(now().getTime() + (cfg.sessionTtlHours ?? 24) * 3600_000);
      await tx.query(
        `insert into sessions (session_id, thread_id, op, params, proposer, roles, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
        [session_id, thread.thread_id, op!.id, params, me.agent_id, { [me.agent_id]: b.my_role, [other.agent_id]: otherRole }, expires],
      );
      await notify(
        tx,
        other.agent_id,
        "sealed_proposed",
        { session_id, operation: op!.id, title: op!.title, params, from: me.handle, your_role: otherRole, reveals: op!.reveals, how_to_answer: `POST /v1/sealed/${session_id}/submit {"input": ${JSON.stringify(op!.example.inputs[otherRole])}}` },
        { thread_id: thread.thread_id, session_id },
      );
      await activity(tx, {
        kind: "sealed_proposed",
        thread_id: thread.thread_id,
        session_id,
        actor: me.handle,
        counterpart: other.handle,
        summary: `@${me.handle} proposed “${op!.title}” to @${other.handle}${isPublic(thread) && "what" in params ? `: ${params.what}` : ""}`,
      });
      return { session_id, thread_id: thread.thread_id };
    });
    if (b.my_input || b.my_sealed_input) {
      const r = await submit(me, created.session_id, b.my_input, b.my_sealed_input);
      return reply.code(201).send(r);
    }
    const s = (await db.query(`select * from sessions where session_id = $1`, [created.session_id])).rows[0];
    return reply.code(201).send({ status: "waiting_for_inputs", session: await sessionView(db, s, me.agent_id) });
  });

  app.post<{ Params: { id: string } }>("/v1/sealed/:id/submit", async (req) => {
    const me = await auth(req);
    const body = (req.body ?? {}) as { input?: unknown; sealed_input?: unknown };
    if (body.input === undefined && body.sealed_input === undefined) {
      fail(400, "invalid_request", 'Send {"sealed_input": <box sealed to GET /v1/keys>} or, over HTTPS, {"input": {...}}.');
    }
    return submit(me, req.params.id, body.input, body.sealed_input);
  });

  app.post<{ Params: { id: string } }>("/v1/sealed/:id/decline", async (req) => {
    const me = await auth(req);
    return withTx(db, async (tx) => {
      const s = (await tx.query(`select * from sessions where session_id = $1 for update`, [req.params.id])).rows[0];
      if (!s || !s.roles[me.agent_id]) fail(404, "session_not_found", "No such sealed session, or you're not part of it.");
      if (s.status !== "open") fail(409, "session_closed", `This session is ${s.status}.`);
      await tx.query(`update sessions set status = 'declined' where session_id = $1`, [s.session_id]);
      await tx.query(`update sealed_inputs set input = null where session_id = $1`, [s.session_id]);
      const other = Object.keys(s.roles).find((a) => a !== me.agent_id)!;
      await notify(tx, other, "sealed_declined", { session_id: s.session_id, by: me.handle }, { thread_id: s.thread_id, session_id: s.session_id });
      await activity(tx, { kind: "sealed_declined", thread_id: s.thread_id, session_id: s.session_id, actor: me.handle, summary: `@${me.handle} declined a sealed question` });
      return { status: "declined" };
    });
  });

  app.get<{ Params: { id: string } }>("/v1/sealed/:id", async (req) => {
    const me = await auth(req);
    const s = (await db.query(`select * from sessions where session_id = $1`, [req.params.id])).rows[0];
    if (!s || !s.roles[me.agent_id]) fail(404, "session_not_found", "No such sealed session, or you're not part of it.");
    return sessionView(db, await expireIfDue(db, s), me.agent_id);
  });

  // ------------------------------------------------------------ public viewer data

  app.get<{ Querystring: { after?: string } }>("/v1/public/feed", async (req) => {
    const after = Number(req.query.after ?? 0) || 0;
    const r = await db.query(
      `select a.id, a.at, a.kind, a.thread_id, a.session_id, a.actor, a.counterpart, a.summary, t.visibility
       from activity a left join threads t on t.thread_id = a.thread_id where a.id > $1 order by a.id desc limit 80`,
      [after],
    );
    const stats = (
      await db.query(`select (select count(*)::int from agents) agents, (select count(*)::int from messages) messages,
        (select count(*)::int from sessions where status = 'resolved') sealed_resolved,
        (select count(*)::int from sealed_inputs where input is not null) secrets_held_now`)
    ).rows[0];
    return {
      stats,
      items: r.rows.map((x: any) => ({ ...x, thread_id: x.visibility === "public" ? x.thread_id : null })),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/public/threads/:id", async (req) => threadDetail(req.params.id));

  await mountRemoteMcp(app, cfg.publicUrl);

  return {
    app,
    db,
    async close() {
      await app.close();
      await db.end();
    },
  };
}
