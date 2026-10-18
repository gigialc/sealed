// Email for agents, through Primitive (primitive.dev). Every Sealed agent gets
// its own address, <handle>@<domain>: anyone can email it and the mail lands in
// the agent's Sealed inbox, and the agent can email anyone from it. Agents can
// also verify an outside address to get notifications by email.
// Private limits still never go in email: they go sealed.
import { createHash, randomInt } from "node:crypto";
import type { Db } from "./db.js";

export interface EmailConfig {
  apiKey: string;
  /** e.g. cozy-whale.primitive.email */
  domain: string;
}

const API = "https://api.primitive.dev/v1";
export const SENDS_PER_AGENT_PER_DAY = 20;
/** Across all agents, so many new agents can't spend the account's credits or spam from its domain. */
export const DEFAULT_GLOBAL_SENDS_PER_DAY = 200;

export async function sendsTodayAll(db: Db) {
  return (await db.query(`select count(*)::int n from email_sends where at > now() - interval '1 day'`)).rows[0].n as number;
}

export class Primitive {
  constructor(private readonly cfg: EmailConfig) {}
  get domain() {
    return this.cfg.domain;
  }
  addressFor(handle: string) {
    return `${handle}@${this.cfg.domain}`;
  }
  private async call(method: string, path: string, body?: unknown) {
    const r = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || j.success === false) throw new Error(`primitive ${path}: ${r.status} ${j?.error?.message ?? j?.message ?? ""}`.trim());
    return j.data;
  }
  send(m: { from: string; fromName?: string; to: string; subject: string; text: string; inReplyTo?: string }) {
    return this.call("POST", "/send-mail", {
      from: m.fromName ? `${m.fromName.replace(/[<>"]/g, "")} <${m.from}>` : m.from,
      to: m.to,
      subject: m.subject,
      body_text: m.text,
      ...(m.inReplyTo ? { in_reply_to: m.inReplyTo } : {}),
    });
  }
  recent(limit = 25): Promise<any[]> {
    return this.call("GET", `/emails?limit=${limit}`);
  }
  get(id: string): Promise<any> {
    return this.call("GET", `/emails/${id}`);
  }
}

export const EMAIL_SCHEMA_SQL = `
alter table agents add column if not exists notify_email text;
alter table agents add column if not exists notify_email_pending text;
alter table agents add column if not exists notify_email_code text;
alter table agents add column if not exists notify_email_code_expires timestamptz;
alter table notifications add column if not exists email_delivered_at timestamptz;
create table if not exists email_sends (id bigserial primary key, agent_id text not null, kind text not null, at timestamptz not null default now());
create table if not exists inbound_emails (email_id text primary key, agent_id text, at timestamptz not null default now());
`;

export const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Sends per agent in the last 24h, so one agent can't spend the whole account. */
export async function sendsToday(db: Db, agentId: string) {
  return (await db.query(`select count(*)::int n from email_sends where agent_id = $1 and at > now() - interval '1 day'`, [agentId])).rows[0].n as number;
}

/**
 * Background loop:
 *  - inbound: new mail to <handle>@domain becomes an "email" item in that agent's inbox
 *  - outbound: unread inbox items are emailed to agents' verified notification addresses
 */
export function startEmailLoop(db: Db, p: Primitive, opts: { intervalMs?: number; since?: Date; globalCap?: number } = {}) {
  const since = opts.since ?? new Date(Date.now() - 3600_000);
  const notifyFrom = `notify@${p.domain}`;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Inbound.
      for (const e of await p.recent(25)) {
        if (new Date(e.received_at ?? e.created_at) < since) continue;
        const seen = await db.query(`insert into inbound_emails (email_id) values ($1) on conflict do nothing returning email_id`, [e.id]);
        if (!seen.rowCount) continue;
        const to = String(e.to_email ?? e.recipient ?? "").toLowerCase();
        const [local, dom] = to.split("@");
        if (dom !== p.domain || !local || (e.from_email ?? e.sender) === notifyFrom) continue;
        const agent = (await db.query(`select agent_id from agents where handle = $1`, [local])).rows[0];
        if (!agent) continue;
        const full = await p.get(e.id);
        await db.query(`update inbound_emails set agent_id = $2 where email_id = $1`, [e.id, agent.agent_id]);
        await db.query(`insert into notifications (agent_id, kind, payload) values ($1, 'email', $2)`, [
          agent.agent_id,
          {
            from: full.from_email ?? full.sender,
            subject: full.subject ?? "",
            text: String(full.body_text ?? full.snippet ?? "").slice(0, 4000),
            message_id: full.message_id,
            how_to_reply: "Use sealed_email with in_reply_to set to this message_id. Never put private limits in email; seal them.",
          },
        ]);
      }
      // Outbound notifications to verified addresses.
      const due = (
        await db.query(
          `select n.id, n.kind, n.payload, a.handle, a.notify_email from notifications n join agents a on a.agent_id = n.agent_id
           where a.notify_email is not null and n.email_delivered_at is null and n.kind <> 'email' and n.created_at > now() - interval '1 hour'
           order by n.id limit 20`,
        )
      ).rows;
      for (const n of due) {
        const what =
          n.kind === "message" ? `New message from @${n.payload.from}` :
          n.kind === "sealed_proposed" ? `@${n.payload.from} asked you a sealed question (${n.payload.operation})` :
          n.kind === "sealed_resolved" ? `A sealed question was answered` :
          n.kind === "sealed_declined" ? `@${n.payload.by} declined a sealed question` : `Sealed: ${n.kind}`;
        const body =
          n.kind === "message" ? `${n.payload.text}\n\n— @${n.payload.from}` :
          n.kind === "sealed_resolved" ? `Answer: ${JSON.stringify(n.payload.result)}\n\nCheck your Sealed inbox for the signed receipt.` :
          `Open your Sealed inbox to see it.`;
        if ((await sendsTodayAll(db)) >= (opts.globalCap ?? DEFAULT_GLOBAL_SENDS_PER_DAY)) {
          await db.query(`update notifications set email_delivered_at = now() where id = $1`, [n.id]); // over the daily cap: inbox only
          continue;
        }
        try {
          await db.query(`insert into email_sends (agent_id, kind) select agent_id, 'notify' from notifications where id = $1`, [n.id]);
          await p.send({ from: notifyFrom, fromName: "Sealed", to: n.notify_email, subject: what, text: `${body}\n\n(For @${n.handle} on Sealed.)` });
          await db.query(`update notifications set email_delivered_at = now() where id = $1`, [n.id]);
        } catch {
          await db.query(`update notifications set email_delivered_at = now() where id = $1`, [n.id]); // best effort; the inbox has it
        }
      }
    } catch {
      // Email is best effort; the Sealed inbox is the source of truth.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 5000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
