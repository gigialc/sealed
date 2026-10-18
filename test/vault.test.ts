import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { KeyChangedError, SealedAgent } from "../src/client/agent.js";
import { exportPublicKey, generateKeyPair } from "../src/core/crypto.js";
import { generateSealKey } from "../src/core/seal.js";
import { createApp, type SealedApp } from "../src/server/app.js";
import { ensureDatabase } from "../src/server/db.js";
import { LocalSealer } from "../src/sealer/sealer.js";
import { Vault, toInput } from "../src/vault/vault.js";
import { ensureSecret, parseSecretValue } from "../src/vault/prompt.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
let s: SealedApp;
let url: string;
const schema = `t_${randomBytes(6).toString("hex")}`;
beforeAll(async () => {
  await ensureDatabase(DB);
  s = await createApp({ databaseUrl: DB, schema, publicUrl: "http://sealed.test", signingKey: generateKeyPair("t"), sealer: new LocalSealer(generateSealKey()), registrationsPerHourPerIp: 1000 });
  await s.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await s.db.query(`drop schema ${schema} cascade`);
  await s.close();
});

describe("vault rules", () => {
  it("enforces the human's rules and maps values to the question's shape", () => {
    const v = new Vault(join(mkdtempSync(join(tmpdir(), "vault-")), "vault.json"));
    v.set("logo-max", { value: 2900, allow: ["deal_zone"], role: "buyer", uses_left: 1, ask_first: false });
    expect(v.describe()).toEqual([{ name: "logo-max", allowed_for: ["deal_zone"], role: "buyer", uses_left: 1, asks_human_first: false }]);
    expect(JSON.stringify(v.describe())).not.toContain("2900");
    expect(() => v.check("logo-max", "group_budget", "member")).toThrow(/only allows/);
    expect(() => v.check("logo-max", "deal_zone", "seller")).toThrow(/as buyer/);
    expect(toInput("deal_zone", "buyer", v.check("logo-max", "deal_zone", "buyer").value)).toEqual({ max: 2900 });
    v.recordUse("logo-max");
    expect(() => v.check("logo-max", "deal_zone", "buyer")).toThrow(/no uses left/);
    expect(toInput("deal_zone", "seller", 2150)).toEqual({ min: 2150 });
    expect(toInput("unanimous", "member", true)).toEqual({ yes: true });
    v.set("studio-min", { value: 2150, allow: ["deal_zone"], with: ["maya"], price_range: [2000, 3000], uses_left: null, ask_first: false });
    expect(() => v.check("studio-min", "deal_zone", "seller", { counterparts: ["eve"] })).toThrow(/only allows "studio-min" with/);
    expect(() => v.check("studio-min", "deal_zone", "seller", { counterparts: ["maya"], params: { at_price: 1500 } })).toThrow(/between 2000 and 3000/);
    expect(v.check("studio-min", "deal_zone", "seller", { counterparts: ["@maya"], params: { at_price: 2500 } }).value).toBe(2150);
  });

  it("refuses to seal if the sealer key changes from the pinned one", async () => {
    const maya = await SealedAgent.join(url, { name: "Pinner" });
    const nova = await SealedAgent.join(url, { name: "Pinned" });
    const p = await maya.propose({ to: nova.handle, operation: "mutual_interest", params: { about: "x" }, my_role: "a" });
    process.env.SEALED_SEALER_KEY = "MCowBQYDK2VuAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    try {
      await expect(maya.submit(p.session.session_id, { interested: true })).rejects.toBeInstanceOf(KeyChangedError);
    } finally {
      delete process.env.SEALED_SEALER_KEY;
    }
    await maya.submit(p.session.session_id, { interested: true });
    expect(maya.state.sealer_key).toBeTruthy();
  });
});

describe("secrets on the fly", () => {
  it("parses what a human types, and explains what to do if they cancel", async () => {
    expect(parseSecretValue("€2,900")).toBe(2900);
    expect(parseSecretValue(" 2150 ")).toBe(2150);
    expect(parseSecretValue("yes")).toBe(true);
    process.env.SEALED_NO_POPUP = "1";
    const v = new Vault(join(mkdtempSync(join(tmpdir(), "vault-")), "vault.json"));
    await expect(ensureSecret(v, "new-max", "deal_zone", "buyer", "test")).rejects.toThrow(/npm run secret -- set new-max/);
    v.set("have-it", { value: 1, allow: ["deal_zone"], uses_left: null, ask_first: false });
    await expect(ensureSecret(v, "have-it", "deal_zone", "buyer", "test")).resolves.toBeUndefined();
  });
});

describe("key pinning", () => {
  it("refuses when the directory swaps or drops a key it has seen before", async () => {
    const maya = await SealedAgent.join(url, { name: "Maya" });
    const nova = await SealedAgent.join(url, { name: "Nova" });
    const first = await maya.proposeChecked({ to: nova.handle, operation: "mutual_interest", params: { about: "x" }, my_role: "a" });
    expect(first.fingerprints.find((p: any) => p.handle === nova.handle).fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
    // A compromised API swaps Nova's key for its own.
    await s.db.query(`update agents set signing_key = $1 where handle = $2`, [exportPublicKey(generateKeyPair("evil").publicKey), nova.handle]);
    await expect(maya.proposeChecked({ to: nova.handle, operation: "mutual_interest", params: { about: "y" }, my_role: "a" })).rejects.toBeInstanceOf(KeyChangedError);
    // …or claims Nova has no key at all.
    await s.db.query(`update agents set signing_key = null where handle = $1`, [nova.handle]);
    await expect(maya.proposeChecked({ to: nova.handle, operation: "mutual_interest", params: { about: "z" }, my_role: "a" })).rejects.toThrow(/no key/);
  });
});

describe("the Sealed MCP server (mcp-use) with the vault", () => {
  it("negotiates with a secret the model never sees", async () => {
    const home = mkdtempSync(join(tmpdir(), "sealed-home-"));
    new Vault(join(home, "vault.json")).set("logo-max", { value: 2900, allow: ["deal_zone"], role: "buyer", uses_left: 3, ask_first: false, note: "Maya's max for the logo" });
    // The real mcp-use server, over HTTP, exactly as Claude Code or Cursor would use it.
    const port = 3400 + Math.floor(Math.random() * 300);
    const proc = spawn("mcp-use/node_modules/.bin/tsx", ["mcp-use/start.ts"], { env: { ...process.env, PORT: String(port), SEALED_URL: url, SEALED_HOME: home, SEALED_PROFILE: "maya", SEALED_NO_POPUP: "1" }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((res, rej) => {
      proc.stdout!.on("data", (d) => String(d).includes(`localhost:${port}/mcp`) && res());
      proc.on("exit", () => rej(new Error("mcp-use server exited")));
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
    const seen: string[] = [];
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      seen.push(r.content[0].text);
      return { error: r.isError, body: JSON.parse(r.content[0].text) };
    };
    try {
      await tool("sealed_join", { name: "Maya's assistant", description: "buys design" });
      expect((await tool("sealed_secrets", {})).body.secrets[0]).toMatchObject({ name: "logo-max", allowed_for: ["deal_zone"] });
      const nova = await SealedAgent.join(url, { name: "Nova" });
      const p = await tool("sealed_propose", { to: nova.handle, operation: "deal_zone", params: { what: "Logo", currency: "EUR", at_price: 2500 }, my_role: "buyer", secret_name: "logo-max" });
      expect(p.error).toBeFalsy();
      expect(p.body.sealed_from_vault).toBe("logo-max");
      const answer = await nova.submit(p.body.session.session_id, { min: 2150 });
      expect(answer.result).toEqual({ deal_at_price: true, price: 2500, currency: "EUR" });
      // Not allowed for another kind of question, even if the model asks.
      const wrong = await tool("sealed_propose", { to: nova.handle, operation: "mutual_interest", params: { about: "x" }, my_role: "a", secret_name: "logo-max" });
      expect(wrong.error).toBe(true);
      expect((await tool("sealed_secrets", {})).body.secrets[0].uses_left).toBe(2);
      // The value never appeared in anything the model saw.
      expect(seen.join("\n")).not.toMatch(/\b2900\b/);
    } finally {
      await client.close();
      proc.kill();
    }
  }, 60_000);
});
