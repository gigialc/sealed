// Runs the sealer as a separate process, exactly as in production, and sends
// a deal through it over HTTP.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPrivateKey, generateKeyPair } from "../src/core/crypto.js";
import { generateSealKey, seal, sealAad } from "../src/core/seal.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";
import { HttpSealer } from "../src/sealer/sealer.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
const PORT = 4390 + Math.floor(Math.random() * 50);
const TOKEN = randomBytes(24).toString("base64url");
const key = generateSealKey();
let proc: ChildProcess;
let s: SealedApp;
const schema = `t_${randomBytes(6).toString("hex")}`;

beforeAll(async () => {
  proc = spawn("npx", ["tsx", "src/start.ts"], {
    env: { ...process.env, SEALED_ROLE: "sealer", PORT: String(PORT), HOST: "127.0.0.1", SEALER_TOKEN: TOKEN, SEALED_ENCRYPTION_KEY: exportPrivateKey(key.privateKey) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    proc.stdout!.on("data", (d) => String(d).includes("[sealer] listening") && res());
    proc.on("exit", () => rej(new Error("sealer exited")));
  });
  await ensureDatabase(DB);
  s = await createApp({ databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("t"), sealer: new HttpSealer(`http://127.0.0.1:${PORT}`, TOKEN), registrationsPerHourPerIp: 1000 });
}, 30_000);

afterAll(async () => {
  await s.db.query(`drop schema ${schema} cascade`);
  await s.close();
  proc.kill();
});

const call = async (method: "GET" | "POST", url: string, body?: unknown, k?: string) => {
  const r = await s.app.inject({ method, url, payload: body as any, headers: k ? { authorization: `Bearer ${k}` } : {} });
  return { status: r.statusCode, body: r.json() as any };
};

describe("sealer service", () => {
  it("refuses callers without the token", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/public-key`);
    expect(r.status).toBe(401);
    const c = await fetch(`http://127.0.0.1:${PORT}/compute`, { method: "POST", body: "{}" });
    expect(c.status).toBe(401);
  });

  it("settles a deal end to end through the separate sealer", async () => {
    const a = (await call("POST", "/v1/agents", { name: "Maya" })).body;
    const b = (await call("POST", "/v1/agents", { name: "Studio" })).body;
    const enc = (await call("GET", "/v1/keys")).body.keys.find((k: any) => k.use === "seal_inputs").public_key_spki_b64url;
    const box = seal(enc, { max: 2900 }, sealAad("deal_zone", "buyer", a.handle));
    const p = await call("POST", "/v1/sealed", { to: b.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR", round_to: 50 }, my_role: "buyer", my_sealed_input: box }, a.api_key);
    expect(p.status).toBe(201);
    const r = await call("POST", `/v1/sealed/${p.body.session.session_id}/submit`, { input: { min: 2150 } }, b.api_key);
    expect(r.body.result).toEqual({ deal: true, price: 2550, currency: "EUR" });
    const bad = await call("POST", "/v1/sealed", { to: b.handle, operation: "deal_zone", params: { what: "x", currency: "EUR" }, my_role: "buyer", my_input: { max: -1 } }, a.api_key);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("-1");
  });
});
