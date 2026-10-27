import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/core/crypto.js";
import { generateSealKey } from "../src/core/seal.js";
import { HttpSealer, LocalSealer, SealerUnavailable } from "../src/sealer/sealer.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
const schema = `t_${randomBytes(6).toString("hex")}`;
const token = randomBytes(24).toString("base64url");
const local = new LocalSealer(generateSealKey());
let mode: "asleep" | "ready" | "compute_unavailable" | "invalid_key" | "stalled_body" = "asleep";
let keyRequests = 0;
let app: SealedApp;
let sealer: HttpSealer;
const upstream = createServer(async (req, res) => {
  if (req.headers["x-sealer-token"] !== token) { res.writeHead(401).end(); return; }
  if (req.url === "/public-key") keyRequests++;
  if (mode === "asleep" || (mode === "compute_unavailable" && req.url === "/compute")) {
    res.writeHead(502).end("upstream waking"); return;
  }
  res.setHeader("content-type", "application/json");
  if (mode === "stalled_body") { res.writeHead(200); res.write('{"public_key_spki_b64url":'); return; }
  if (req.url === "/public-key") {
    res.end(JSON.stringify({ public_key_spki_b64url: mode === "invalid_key" ? "invalid" : await local.publicKey() })); return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const b = JSON.parse(Buffer.concat(chunks).toString());
  const result = req.url === "/check" ? await local.check(b.statement, b.envelope) : await local.compute(b.statement, b.envelopes);
  res.writeHead(result.ok ? 200 : 422).end(JSON.stringify(result));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  sealer = new HttpSealer(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, token, 500);
  await ensureDatabase(DB);
  // This must succeed even though the sealer returns 502 throughout startup.
  app = await createApp({ databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("cold-start"), sealer });
});

afterAll(async () => {
  if (app) { await app.db.query(`drop schema ${schema} cascade`); await app.close(); }
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("independently sleeping sealer", () => {
  it("serves the homepage, discovery and messaging without contacting the sealer", async () => {
    for (const url of ["/", "/llms.txt", "/v1", "/.well-known/agent-card.json"]) {
      expect((await app.app.inject({ url })).statusCode).toBe(200);
    }
    const a = (await app.app.inject({ method: "POST", url: "/v1/agents", payload: { name: "Cold buyer" } })).json();
    const b = (await app.app.inject({ method: "POST", url: "/v1/agents", payload: { name: "Cold seller" } })).json();
    const sent = await app.app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${a.api_key}` }, payload: { to: b.handle, text: "Hello during sealer sleep" } });
    expect(sent.statusCode).toBe(201);
    expect(keyRequests).toBe(0);
  });

  it("returns a retryable 503 for unavailable or invalid keys, then recovers without restarting", async () => {
    for (const state of ["asleep", "invalid_key"] as const) {
      mode = state;
      const response = await app.app.inject({ url: "/v1/keys" });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.json().error).toBe("sealer_unavailable");
      expect(response.body).not.toContain(token);
    }
    mode = "ready";
    const before = keyRequests;
    const responses = await Promise.all(Array.from({ length: 3 }, () => app.app.inject({ url: "/v1/keys" })));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json().keys[1].public_key_spki_b64url).toBe(await local.publicKey());
    }
    expect(keyRequests - before).toBe(1);
  });

  it("rolls back a submission when computation is unavailable and resolves the same session on retry", async () => {
    const a = (await app.app.inject({ method: "POST", url: "/v1/agents", payload: { name: "Retry buyer" } })).json();
    const b = (await app.app.inject({ method: "POST", url: "/v1/agents", payload: { name: "Retry seller" } })).json();
    const proposal = await app.app.inject({ method: "POST", url: "/v1/sealed", headers: { authorization: `Bearer ${a.api_key}` }, payload: { to: b.handle, operation: "deal_zone", params: { what: "Test", currency: "USD", at_price: 25 }, my_role: "buyer", my_input: { max: 30 } } });
    expect(proposal.statusCode).toBe(201);
    const sid = proposal.json().session.session_id;
    const submit = () => app.app.inject({ method: "POST", url: `/v1/sealed/${sid}/submit`, headers: { authorization: `Bearer ${b.api_key}` }, payload: { input: { min: 20 } } });
    mode = "compute_unavailable";
    expect((await submit()).statusCode).toBe(503);
    expect((await app.db.query("select status from sessions where session_id = $1", [sid])).rows[0].status).toBe("open");
    expect((await app.db.query("select * from sealed_inputs where session_id = $1", [sid])).rowCount).toBe(1);
    mode = "ready";
    const resolved = await submit();
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().result).toEqual({ deal_at_price: true, price: 25, currency: "USD" });
  });

  it("bounds even a stalled response body, without an automatic retry", async () => {
    mode = "stalled_body";
    const before = keyRequests;
    const started = Date.now();
    await expect(sealer.publicKey()).rejects.toBeInstanceOf(SealerUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(keyRequests - before).toBe(1);
    mode = "ready";
    expect(await sealer.publicKey()).toBe(await local.publicKey());
  });
});
