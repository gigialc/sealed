import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMAINS, generateKeyPair, stripSignature, verifyBody } from "../src/core/crypto.js";
import { generateSealKey } from "../src/core/seal.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";
import { LocalSealer } from "../src/sealer/sealer.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
let s: SealedApp;
let schema: string;
beforeEach(async () => {
  await ensureDatabase(DB);
  schema = `t_${randomBytes(6).toString("hex")}`;
  s = await createApp({
    databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("t"), sealer: new LocalSealer(generateSealKey()),
    registrationsPerHourPerIp: 1000, webhooks: { allowLocal: true, intervalMs: 60_000 },
  });
});
afterEach(async () => {
  await s.db.query(`drop schema ${schema} cascade`);
  await s.close();
});
const call = async (method: "GET" | "POST", url: string, body?: unknown, key?: string) => {
  const r = await s.app.inject({ method, url, payload: body as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: r.json() as any, raw: r.body };
};
const join = async (name: string, extra: Record<string, unknown> = {}) => (await call("POST", "/v1/agents", { name, ...extra })).body as { api_key: string; handle: string };

describe("group questions", () => {
  it("group_budget: everyone learns what fits, nobody's number leaks", async () => {
    const [a, b, c] = [await join("Ana"), await join("Ben"), await join("Cleo")];
    const p = await call("POST", "/v1/sealed", {
      with: [b.handle, c.handle], operation: "group_budget",
      params: { what: "Lisbon weekend", currency: "EUR", options: [{ id: "hostel", label: "Hostel", price: 180 }, { id: "hotel", label: "Boutique hotel", price: 420 }, { id: "villa", label: "Villa", price: 900 }] },
      my_input: { max: 517 },
    }, a.api_key);
    expect(p.status).toBe(201);
    expect(p.body.status).toBe("waiting_for_others");
    const sid = p.body.session.session_id;
    expect((await call("GET", "/v1/inbox", undefined, b.api_key)).body.sealed_waiting_for_your_input[0].session_id).toBe(sid);
    expect((await call("POST", `/v1/sealed/${sid}/submit`, { input: { max: 463 } }, b.api_key)).body.status).toBe("waiting_for_others");
    const r = await call("POST", `/v1/sealed/${sid}/submit`, { input: { max: 1290 } }, c.api_key);
    expect(r.body.result).toEqual({ fits: ["hostel", "hotel"], labels: ["Hostel", "Boutique hotel"] });
    expect(r.body.receipt.parties).toHaveLength(3);
    const seen = [r.raw, ...(await Promise.all([a, b, c].map(async (x) => (await call("GET", `/v1/sealed/${sid}`, undefined, x.api_key)).raw)))].join("\n");
    expect(seen).not.toMatch(/\b517\b|\b463\b|\b1290\b/);
  });

  it("unanimous: a single no gives 'not everyone' without saying who", async () => {
    const [a, b, c, d] = [await join("A1"), await join("B1"), await join("C1"), await join("D1")];
    const p = await call("POST", "/v1/sealed", { with: [b.handle, c.handle, d.handle], operation: "unanimous", params: { about: "Move trip" }, my_input: { yes: true } }, a.api_key);
    const sid = p.body.session.session_id;
    await call("POST", `/v1/sealed/${sid}/submit`, { input: { yes: true } }, b.api_key);
    await call("POST", `/v1/sealed/${sid}/submit`, { input: { yes: false } }, c.api_key);
    const r = await call("POST", `/v1/sealed/${sid}/submit`, { input: { yes: true } }, d.api_key);
    expect(r.body.result).toEqual({ everyone_in: false });
  });

  it("group_slot finds one time that works for all", async () => {
    const [a, b, c] = [await join("A2"), await join("B2"), await join("C2")];
    const w = (s: string, e: string) => ({ available: [{ start: `2026-10-24T${s}:00Z`, end: `2026-10-24T${e}:00Z` }] });
    const p = await call("POST", "/v1/sealed", { with: [b.handle, c.handle], operation: "group_slot", params: { duration_minutes: 60 }, my_input: w("14:00", "20:00") }, a.api_key);
    const sid = p.body.session.session_id;
    await call("POST", `/v1/sealed/${sid}/submit`, { input: w("16:30", "22:00") }, b.api_key);
    const r = await call("POST", `/v1/sealed/${sid}/submit`, { input: w("10:00", "18:00") }, c.api_key);
    expect(r.body.result).toEqual({ slot: { start: "2026-10-24T16:30:00.000Z", end: "2026-10-24T17:30:00.000Z" } });
  });

  it("rejects groups that are too small, and wrong shapes for the question type", async () => {
    const [a, b] = [await join("A3"), await join("B3")];
    const small = await call("POST", "/v1/sealed", { with: [b.handle], operation: "unanimous", params: { about: "x" } }, a.api_key);
    expect(small.status).toBe(400);
    expect(small.body.error).toBe("group_size");
    const mixed = await call("POST", "/v1/sealed", { with: [b.handle], operation: "deal_zone", params: { what: "x", currency: "EUR" }, my_role: "buyer" }, a.api_key);
    expect(mixed.status).toBe(400);
  });

  it("if the deadline passes before everyone seals, nothing is released and envelopes are erased", async () => {
    const [a, b, c] = [await join("A4"), await join("B4"), await join("C4")];
    const p = await call("POST", "/v1/sealed", { with: [b.handle, c.handle], operation: "unanimous", params: { about: "x" }, deadline_minutes: 5, my_input: { yes: true } }, a.api_key);
    const sid = p.body.session.session_id;
    await call("POST", `/v1/sealed/${sid}/submit`, { input: { yes: true } }, b.api_key);
    await s.db.query(`update sessions set expires_at = now() - interval '1 second' where session_id = $1`, [sid]);
    const late = await call("POST", `/v1/sealed/${sid}/submit`, { input: { yes: true } }, c.api_key);
    expect(late.status).toBe(409);
    const view = await call("GET", `/v1/sealed/${sid}`, undefined, a.api_key);
    expect(view.body.status).toBe("expired");
    expect(view.body.result).toBeNull();
    expect((await s.db.query(`select count(*)::int n from sealed_inputs where input is not null`)).rows[0].n).toBe(0);
  });
});

describe("waiting for answers", () => {
  it("?wait holds the request until the other side seals", async () => {
    const [a, b] = [await join("A5"), await join("B5")];
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "mutual_interest", params: { about: "x" }, my_role: "a", my_input: { interested: true } }, a.api_key);
    const sid = p.body.session.session_id;
    setTimeout(() => void call("POST", `/v1/sealed/${sid}/submit`, { input: { interested: true } }, b.api_key), 800);
    const t0 = Date.now();
    const r = await call("GET", `/v1/sealed/${sid}?wait=10`, undefined, a.api_key);
    expect(r.body.status).toBe("resolved");
    expect(r.body.result).toEqual({ match: true });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("webhooks", () => {
  it("pushes a signed notification the moment something arrives", async () => {
    const got: Array<{ body: any; sig: string }> = [];
    const hook = createServer((req, res) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        got.push({ body: JSON.parse(d), sig: String(req.headers["x-sealed-signature"]) });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/sealed`;
    const a = await join("A6");
    const b = await join("B6", { webhook_url: url });
    await call("POST", "/v1/messages", { to: b.handle, text: "hello" }, a.api_key);
    await s.deliverWebhooks();
    hook.close();
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toMatchObject({ kind: "message", from: a.handle, text: "hello", to: b.handle });
    const key = (await call("GET", "/v1/keys")).body.keys.find((k: any) => k.use === "sign_receipts").public_key_spki_b64url;
    expect(verifyBody(DOMAINS.webhook, got[0]!.body, got[0]!.sig, key)).toBe(true);
    await s.deliverWebhooks();
    expect(got).toHaveLength(1); // delivered once
  });

  it("refuses webhooks pointing at internal addresses", async () => {
    const a = await join("A7");
    for (const url of ["http://example.com/x", "https://localhost/x", "https://10.0.0.5/x", "https://sealer.railway.internal/x", "https://user:pw@example.com/"]) {
      const r = await call("POST", "/v1/me/webhook", { url }, a.api_key);
      expect(r.status, url).toBe(400);
    }
  });
});
