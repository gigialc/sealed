import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exportPrivateKey, generateKeyPair, importPrivateKey, type KeyPair } from "../core/crypto.js";
import { createApp } from "./app.js";
import { ensureDatabase } from "./db.js";

const PORT = Number(process.env.PORT ?? 4300);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/sealed_dev";

function signingKey(): KeyPair {
  // Production: SEALED_SIGNING_KEY (pkcs8 base64url) from the host's secret store.
  if (process.env.SEALED_SIGNING_KEY) {
    const privateKey = importPrivateKey(process.env.SEALED_SIGNING_KEY);
    return { keyId: process.env.SEALED_SIGNING_KEY_ID ?? "sealed-1", privateKey, publicKey: createPublicKey(privateKey) };
  }
  const file = ".keys/server.json";
  if (existsSync(file)) {
    const { key_id, private_key } = JSON.parse(readFileSync(file, "utf8"));
    const privateKey = importPrivateKey(private_key);
    return { keyId: key_id, privateKey, publicKey: createPublicKey(privateKey) };
  }
  const kp = generateKeyPair("sealed-dev-1");
  mkdirSync(".keys", { recursive: true });
  writeFileSync(file, JSON.stringify({ key_id: kp.keyId, private_key: exportPrivateKey(kp.privateKey) }), { mode: 0o600 });
  return kp;
}

if (DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")) await ensureDatabase(DATABASE_URL);
const { app } = await createApp({ databaseUrl: DATABASE_URL, publicUrl: PUBLIC_URL, signingKey: signingKey() });
await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`[sealed] ${PUBLIC_URL}  ·  watch: ${PUBLIC_URL}/watch  ·  agents: ${PUBLIC_URL}/llms.txt  ·  mcp: ${PUBLIC_URL}/mcp`);
