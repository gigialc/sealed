// Runs the sealer as a separate process, exactly as in production, with
// signed agents using the SDK over real HTTP.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SealedAgent } from "../src/client/agent.js";
import { exportPrivateKey, generateKeyPair } from "../src/core/crypto.js";
import { generateSealKey } from "../src/core/seal.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";
import { HttpSealer } from "../src/sealer/sealer.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
const PORT = 4390 + Math.floor(Math.random() * 50);
const TOKEN = randomBytes(24).toString("base64url");
let proc: ChildProcess;
let s: SealedApp;
let url: string;
const schema = `t_${randomBytes(6).toString("hex")}`;

beforeAll(async () => {
  proc = spawn("npx", ["tsx", "src/start.ts"], {
    env: {
      ...process.env, SEALED_ROLE: "sealer", PORT: String(PORT), HOST: "127.0.0.1", SEALER_TOKEN: TOKEN,
      SEALED_ENCRYPTION_KEY: exportPrivateKey(generateSealKey().privateKey), SEALER_STATE_DIR: mkdtempSync(join(tmpdir(), "sealer-")),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    proc.stdout!.on("data", (d) => String(d).includes("[sealer] listening") && res());
    proc.on("exit", () => rej(new Error("sealer exited")));
  });
  await ensureDatabase(DB);
  s = await createApp({ databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("t"), sealer: new HttpSealer(`http://127.0.0.1:${PORT}`, TOKEN), registrationsPerHourPerIp: 1000 });
  await s.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await s.db.query(`drop schema ${schema} cascade`);
  await s.close();
  proc.kill();
});

describe("sealer service", () => {
  it("refuses callers without the token", async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/public-key`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${PORT}/compute`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("two signed agents settle a deal through the separate sealer; plaintext is refused for them", async () => {
    const maya = await SealedAgent.join(url, { name: "Maya" });
    const nova = await SealedAgent.join(url, { name: "Nova" });
    const p = await maya.propose({ to: nova.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR", at_price: 2500 }, my_role: "buyer" });
    const sid = p.session.session_id;
    expect(p.session.trust).toEqual({ [maya.handle]: "signed", [nova.handle]: "signed" });
    await maya.submit(sid, { max: 2900 });
    // A signed agent can't fall back to plaintext: the API could then speak for it.
    const plain = await SealedAgent.raw(url, "POST", `/v1/sealed/${sid}/submit`, { input: { min: 2150 } }, nova.state.api_key);
    expect(plain.status).toBe(400);
    expect(plain.body.error).toBe("signature_required");
    const r = await nova.submit(sid, { min: 2150 });
    expect(r.result).toEqual({ deal_at_price: true, price: 2500, currency: "EUR" });
    expect(await maya.receiptValid(r.receipt)).toBe(true);
  });
});
