// Push notifications to agents that registered a webhook. A background loop
// sends each unread notification once (with a few retries), signed with the
// receipt key so agents can check it really came from Sealed. Inbox polling
// keeps working either way.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DOMAINS, signBody, type KeyPair } from "../core/crypto.js";
import type { Db } from "./db.js";

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) =>
  isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1|::|fc|fd|fe80|::ffff:(10|127|169\.254|192\.168)\.)/i.test(ip);

/** Only public https endpoints, so a webhook can't be used to reach internal services. */
export async function checkWebhookUrl(raw: string, allowLocal = false): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (allowLocal && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) return null;
  if (u.protocol !== "https:") return "must be https";
  if (u.username || u.password) return "must not contain credentials";
  if (/\.internal$|\.local$|^localhost$/i.test(u.hostname)) return "must be a public host";
  try {
    const addrs = await lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) return "must resolve to a public address";
  } catch {
    return "host doesn't resolve";
  }
  return null;
}

export function startWebhookLoop(db: Db, signingKey: KeyPair, opts: { intervalMs?: number; allowLocal?: boolean } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = (
        await db.query(
          `select n.id, n.kind, n.payload, n.created_at, a.webhook_url, a.handle from notifications n join agents a on a.agent_id = n.agent_id
           where a.webhook_url is not null and n.webhook_delivered_at is null and n.webhook_attempts < 5 and n.created_at > now() - interval '1 hour'
           order by n.id limit 25`,
        )
      ).rows;
      for (const n of due) {
        const body = { id: String(n.id), to: n.handle, kind: n.kind, at: n.created_at, ...n.payload };
        let ok = false;
        // Re-check at send time: DNS can change after registration.
        if (!(await checkWebhookUrl(n.webhook_url, opts.allowLocal))) {
          try {
            const r = await fetch(n.webhook_url, {
              method: "POST",
              redirect: "manual",
              signal: AbortSignal.timeout(5000),
              headers: { "content-type": "application/json", "x-sealed-key-id": signingKey.keyId, "x-sealed-signature": signBody(DOMAINS.webhook, body, signingKey.privateKey) },
              body: JSON.stringify(body),
            });
            ok = r.status >= 200 && r.status < 300;
          } catch {}
        }
        await db.query(
          ok ? `update notifications set webhook_delivered_at = now() where id = $1` : `update notifications set webhook_attempts = webhook_attempts + 1 where id = $1`,
          [n.id],
        );
      }
    } catch {
      // Delivery is best effort; the inbox still has everything.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 2000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
