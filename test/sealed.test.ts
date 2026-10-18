import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMAINS, canonicalize, generateKeyPair, stripSignature, verifyBody } from "../src/core/crypto.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";
import { generateSealKey, seal } from "../src/core/seal.js";
import { inputAad } from "../src/core/statement.js";
import { LocalSealer } from "../src/sealer/sealer.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
let s: SealedApp;
let schema: string;

beforeEach(async () => {
  await ensureDatabase(DB);
  schema = `t_${randomBytes(6).toString("hex")}`;
  s = await createApp({ databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("test-1"), sealer: new LocalSealer(generateSealKey()), registrationsPerHourPerIp: 1000 });
});
afterEach(async () => {
  await s.db.query(`drop schema ${schema} cascade`);
  await s.close();
});

const call = async (method: "GET" | "POST", url: string, body?: unknown, key?: string) => {
  const r = await s.app.inject({ method, url, payload: body as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: r.json() as any, raw: r.body };
};
const join = async (name: string, handle?: string) => (await call("POST", "/v1/agents", { name, handle, description: `${name} agent` })).body as { api_key: string; handle: string };

async function negotiate(buyerMax: number, sellerMin: number) {
  const buyer = await join("Maya");
  const seller = await join("Studio");
  const p = await call("POST", "/v1/sealed", { to: seller.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR", at_price: 1250 }, my_role: "buyer", my_input: { max: buyerMax } }, buyer.api_key);
  expect(p.status).toBe(201);
  const sid = p.body.session.session_id;
  const r = await call("POST", `/v1/sealed/${sid}/submit`, { input: { min: sellerMin } }, seller.api_key);
  return { buyer, seller, sid, proposal: p, result: r };
}

describe("onboarding", () => {
  it("an agent signs itself up with no human and gets docs pointing at next steps", async () => {
    const txt = await s.app.inject({ url: "/llms.txt" });
    expect(txt.body).toContain("POST http://sealed.test/v1/agents");
    const card = await call("GET", "/.well-known/agent-card.json");
    expect(card.body.skills.map((x: any) => x.id)).toContain("deal_zone");
    const a = await call("POST", "/v1/agents", { name: "Maya's assistant", description: "books design work" });
    expect(a.status).toBe(201);
    expect(a.body.api_key).toMatch(/^sk_sealed_/);
    expect((await call("GET", "/v1/me", undefined, a.body.api_key)).body.handle).toBe(a.body.handle);
    expect((await call("GET", "/v1/me", undefined, "sk_sealed_nope")).status).toBe(401);
  });

  it("the homepage answers agents in markdown and browsers in HTML", async () => {
    const agent = await s.app.inject({ url: "/", headers: { "user-agent": "curl/8.4.0", accept: "*/*" } });
    expect(agent.headers["content-type"]).toContain("text/markdown");
    expect(agent.body).toContain("POST http://sealed.test/v1/agents");
    const md = await s.app.inject({ url: "/", headers: { accept: "text/markdown" } });
    expect(md.headers["content-type"]).toContain("text/markdown");
    const browser = await s.app.inject({ url: "/", headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605", accept: "text/html,application/xhtml+xml" } });
    expect(browser.headers["content-type"]).toContain("text/html");
    expect(browser.body).toContain("A tiny post office where agents keep secrets.");
    expect(browser.body).not.toContain("/watch");
    expect((await s.app.inject({ url: "/watch" })).statusCode).toBe(404);
  });

  it("handles are unique; taken handles get a clear error", async () => {
    await join("A", "studio");
    const r = await call("POST", "/v1/agents", { name: "B", handle: "studio" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("handle_taken");
  });
});

describe("messaging", () => {
  it("delivers messages to the other agent's inbox once", async () => {
    const a = await join("Maya");
    const b = await join("Studio");
    const m = await call("POST", "/v1/messages", { to: b.handle, text: "Hi! Can you do a logo in 2 weeks?" }, a.api_key);
    expect(m.status).toBe(201);
    const inbox = await call("GET", "/v1/inbox", undefined, b.api_key);
    expect(inbox.body.new[0]).toMatchObject({ kind: "message", from: a.handle, text: "Hi! Can you do a logo in 2 weeks?" });
    expect((await call("GET", "/v1/inbox", undefined, b.api_key)).body.new).toHaveLength(0);
  });
});

describe("threads", () => {
  it("a sealed question sent with 'to' continues the existing conversation", async () => {
    const a = await join("Maya");
    const b = await join("Studio");
    const m = await call("POST", "/v1/messages", { to: b.handle, text: "Hi!" }, a.api_key);
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "mutual_interest", params: { about: "Work together" }, my_role: "a" }, a.api_key);
    expect(p.body.session.thread_id).toBe(m.body.thread_id);
    const r = await call("POST", "/v1/messages", { to: a.handle, text: "Hello back" }, b.api_key);
    expect(r.body.thread_id).toBe(m.body.thread_id);
  });
});

describe("deal_zone", () => {
  it("answers yes/no without revealing either limit, deletes inputs, signs a receipt", async () => {
    const { buyer, seller, sid, result } = await negotiate(1437, 1088);
    expect(result.body.status).toBe("resolved");
    expect(result.body.result).toEqual({ deal_at_price: true, price: 1250, currency: "EUR" });

    // Neither secret appears in anything either agent, or the public, can read.
    const seen = [
      result.raw,
      (await call("GET", `/v1/sealed/${sid}`, undefined, buyer.api_key)).raw,
      (await call("GET", `/v1/sealed/${sid}`, undefined, seller.api_key)).raw,
      JSON.stringify((await call("GET", "/v1/inbox", undefined, buyer.api_key)).body),
      JSON.stringify((await call("GET", "/v1/inbox", undefined, seller.api_key)).body),
      (await call("GET", `/v1/threads/${result.body.session.thread_id}`, undefined, buyer.api_key)).raw,
    ].join("\n");
    expect(seen).not.toMatch(/\b1437\b|\b1088\b/);

    const left = await s.db.query(`select count(*)::int n from sealed_inputs where input is not null`);
    expect(left.rows[0].n).toBe(0);

    const receipt = result.body.receipt;
    const keys = (await call("GET", "/v1/keys")).body.keys[0];
    const { body, signature } = stripSignature(receipt, "signature");
    expect(verifyBody(DOMAINS.receipt, body, signature, keys.public_key_spki_b64url)).toBe(true);
    expect(verifyBody(DOMAINS.receipt, { ...body, result: { deal_at_price: false } }, signature, keys.public_key_spki_b64url)).toBe(false);
    expect(receipt.meaning).toMatch(/not a cryptographic proof/);
    // The seller can prove what it submitted from its salt.
    const mine = receipt.parties.find((p: any) => p.role === "seller").input_commitment;
    const recomputed = "sha256:" + createHash("sha256").update(`${result.body.your_commitment.salt}\n${canonicalize({ min: 1088 })}`).digest("hex");
    expect(recomputed).toBe(mine);
  });

  it("no overlap → no deal, and nothing else", async () => {
    const { result } = await negotiate(900, 1100);
    expect(result.body.result).toEqual({ deal_at_price: false, price: 1250, currency: "EUR" });
  });

  it("limits repeated asks per pair, so a limit can't be bisected", async () => {
    const a = await join("Maya");
    const b = await join("Studio");
    const ask = () => call("POST", "/v1/sealed", { to: b.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR" }, my_role: "buyer", my_input: { max: 1000 } }, a.api_key);
    for (let i = 0; i < 3; i++) expect((await ask()).status).toBe(201);
    const fourth = await ask();
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe("pair_limit");
    // Swapping who asks doesn't reset it.
    const swapped = await call("POST", "/v1/sealed", { to: a.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR" }, my_role: "seller" }, b.api_key);
    expect(swapped.status).toBe(429);
  });

  it("inputs can't be changed, outsiders can't touch a session, and wrong shapes are explained", async () => {
    const a = await join("Maya");
    const b = await join("Studio");
    const c = await join("Eve");
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR" }, my_role: "buyer", my_input: { max: 1000 } }, a.api_key);
    const sid = p.body.session.session_id;
    expect((await call("POST", `/v1/sealed/${sid}/submit`, { input: { max: 2000 } }, a.api_key)).status).toBe(409);
    expect((await call("GET", `/v1/sealed/${sid}`, undefined, c.api_key)).status).toBe(404);
    expect((await call("POST", `/v1/sealed/${sid}/submit`, { input: { min: 1 } }, c.api_key)).status).toBe(404);
    const bad = await call("POST", `/v1/sealed/${sid}/submit`, { input: { max: 5 } }, b.api_key);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('{"min":1100}');
  });

  it("simultaneous final submissions resolve exactly once", async () => {
    const a = await join("Maya");
    const b = await join("Studio");
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "mutual_interest", params: { about: "Cofounding" }, my_role: "a" }, a.api_key);
    const sid = p.body.session.session_id;
    const [r1, r2] = await Promise.all([
      call("POST", `/v1/sealed/${sid}/submit`, { input: { interested: true } }, a.api_key),
      call("POST", `/v1/sealed/${sid}/submit`, { input: { interested: true } }, b.api_key),
    ]);
    expect([r1.body.status, r2.body.status].sort()).toEqual(["resolved", "waiting_for_other_side"]);
    expect((await s.db.query(`select count(*)::int n from receipts`)).rows[0].n).toBe(1);
  });
});

describe("the sealed box", () => {
  it("stores only ciphertext, accepts boxes sealed by the agent, and rejects boxes sealed for another use", async () => {
    const a = await join("Maya");
    const b = await join("Studio");
    const keys = (await call("GET", "/v1/keys")).body.keys;
    const enc = keys.find((k: any) => k.use === "seal_inputs").public_key_spki_b64url;
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR", at_price: 2700 }, my_role: "buyer" }, a.api_key);
    expect(p.status).toBe(201);
    const view = p.body.session;
    // Maya locks her max on her own machine against this session's statement; the server never sees the plaintext.
    const box = seal(enc, { input: { max: 3333 }, salt: "maya-local-salt-0123456789" }, inputAad(view.statement_hash, "buyer", a.handle));
    expect((await call("POST", `/v1/sealed/${view.session_id}/submit`, { sealed_input: box }, a.api_key)).status).toBe(200);
    const stored = await s.db.query(`select input::text from sealed_inputs`);
    expect(stored.rows[0].input).not.toContain("3333");
    expect(JSON.parse(stored.rows[0].input).alg).toBe("X25519-HKDF-SHA256-AES256GCM");

    // The same envelope can't be replayed into another session, even with the same roles.
    const p2 = await call("POST", "/v1/sealed", { to: b.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR", at_price: 2700 }, my_role: "buyer" }, a.api_key);
    const replay = await call("POST", `/v1/sealed/${p2.body.session.session_id}/submit`, { sealed_input: box }, a.api_key);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("cannot_open_sealed_input");

    // Plaintext over HTTPS still works for agents without a signing key, and is locked before it's stored.
    const r = await call("POST", `/v1/sealed/${view.session_id}/submit`, { input: { min: 2111 } }, b.api_key);
    expect(r.body.result).toEqual({ deal_at_price: true, price: 2700, currency: "EUR" });
    await call("POST", `/v1/sealed/${p2.body.session.session_id}/decline`, {}, b.api_key);
    const after = await s.db.query(`select count(*)::int n from sealed_inputs where input is not null`);
    expect(after.rows[0].n).toBe(0); // resolved boxes are erased; the rejected box was never stored
  });
});

describe("other operations", () => {
  it("common_slot returns one shared time and mutual_interest only a match bit", async () => {
    const a = await join("A");
    const b = await join("B");
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "common_slot", params: { duration_minutes: 30 }, my_role: "a", my_input: { available: [{ start: "2026-10-20T16:00:00Z", end: "2026-10-20T18:00:00Z" }] } }, a.api_key);
    const r = await call("POST", `/v1/sealed/${p.body.session.session_id}/submit`, { input: { available: [{ start: "2026-10-20T17:10:00Z", end: "2026-10-20T19:00:00Z" }] } }, b.api_key);
    expect(r.body.result).toEqual({ slot: { start: "2026-10-20T17:15:00.000Z", end: "2026-10-20T17:45:00.000Z" } });

    const m = await call("POST", "/v1/sealed", { to: b.handle, operation: "mutual_interest", params: { about: "Intro" }, my_role: "a", my_input: { interested: false } }, a.api_key);
    const mr = await call("POST", `/v1/sealed/${m.body.session.session_id}/submit`, { input: { interested: true } }, b.api_key);
    expect(mr.body.result).toEqual({ match: false });
  });
});
