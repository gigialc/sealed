import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/core/crypto.js";
import { generateSealKey } from "../src/core/seal.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";
import type { Primitive } from "../src/server/email.js";
import { LocalSealer } from "../src/sealer/sealer.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
const DOMAIN = "test-whale.primitive.email";

class FakePrimitive {
  sent: any[] = [];
  inbox: any[] = [];
  domain = DOMAIN;
  addressFor(h: string) {
    return `${h}@${DOMAIN}`;
  }
  async send(m: any) {
    this.sent.push(m);
    return { status: "delivered" };
  }
  async recent() {
    return this.inbox;
  }
  async get(id: string) {
    return this.inbox.find((e) => e.id === id);
  }
}

let s: SealedApp;
let schema: string;
let mail: FakePrimitive;
beforeEach(async () => {
  await ensureDatabase(DB);
  schema = `t_${randomBytes(6).toString("hex")}`;
  mail = new FakePrimitive();
  s = await createApp({
    databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("t"), sealer: new LocalSealer(generateSealKey()),
    registrationsPerHourPerIp: 1000, email: mail as unknown as Primitive, webhooks: { intervalMs: 60_000 },
  });
});
afterEach(async () => {
  await s.db.query(`drop schema ${schema} cascade`);
  await s.close();
});
const call = async (method: "GET" | "POST", url: string, body?: unknown, key?: string) => {
  const r = await s.app.inject({ method, url, payload: body as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: r.json() as any };
};
const join = async (name: string) => (await call("POST", "/v1/agents", { name })).body;

describe("email through Primitive", () => {
  it("every agent gets its own address and can send from it, up to a daily cap", async () => {
    const maya = await join("Maya");
    expect(maya.email_address).toBe(`${maya.handle}@${DOMAIN}`);
    const r = await call("POST", "/v1/email", { to: "studio@example.com", subject: "Logo project", text: "Hi! Can we talk?" }, maya.api_key);
    expect(r.body).toMatchObject({ sent: true, from: `${maya.handle}@${DOMAIN}` });
    expect(mail.sent[0]).toMatchObject({ from: `${maya.handle}@${DOMAIN}`, to: "studio@example.com", subject: "Logo project" });
    for (let i = 0; i < 19; i++) await call("POST", "/v1/email", { to: "a@example.com", subject: "x", text: "x" }, maya.api_key);
    expect((await call("POST", "/v1/email", { to: "a@example.com", subject: "x", text: "x" }, maya.api_key)).status).toBe(429);
  });

  it("mail to an agent's address lands in its Sealed inbox", async () => {
    const maya = await join("Maya");
    mail.inbox.push({ id: "e1", to_email: maya.email_address, from_email: "human@example.com", subject: "Hello", body_text: "Are you free Tuesday?", message_id: "<m1>", received_at: new Date().toISOString() });
    mail.inbox.push({ id: "e2", to_email: `nobody@${DOMAIN}`, from_email: "x@example.com", subject: "spam", body_text: "x", received_at: new Date().toISOString() });
    await s.syncEmail();
    await s.syncEmail(); // processed once
    const inbox = (await call("GET", "/v1/inbox", undefined, maya.api_key)).body.new;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "email", from: "human@example.com", subject: "Hello", text: "Are you free Tuesday?", message_id: "<m1>" });
  });

  it("verifies a notification address with a code, then emails new activity there", async () => {
    const maya = await join("Maya");
    const nova = await join("Nova");
    expect((await call("POST", "/v1/me/notify-email", { address: `x@${DOMAIN}` }, maya.api_key)).status).toBe(400);
    await call("POST", "/v1/me/notify-email", { address: "maya@example.com" }, maya.api_key);
    const code = mail.sent.at(-1).subject.match(/(\d{6})/)[1];
    expect((await call("POST", "/v1/me/notify-email/verify", { code: "000000" === code ? "111111" : "000000" }, maya.api_key)).status).toBe(400);
    expect((await call("POST", "/v1/me/notify-email/verify", { code }, maya.api_key)).body).toMatchObject({ verified: true, notify_email: "maya@example.com" });
    await call("POST", "/v1/messages", { to: maya.handle, text: "Hi Maya" }, nova.api_key);
    await s.syncEmail();
    expect(mail.sent.at(-1)).toMatchObject({ to: "maya@example.com", subject: `New message from @${nova.handle}` });
  });
});
