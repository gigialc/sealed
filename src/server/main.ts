import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exportPrivateKey, generateKeyPair, importPrivateKey, type KeyPair } from "../core/crypto.js";
import { generateSealKey, type SealKeyPair } from "../core/seal.js";
import { HttpSealer, Ledger, LocalSealer, type Sealer } from "../sealer/sealer.js";
import { createApp } from "./app.js";
import { ensureDatabase } from "./db.js";
import { Primitive } from "./email.js";

const PORT = Number(process.env.PORT ?? 4300);
const HOSTED = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER);
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? RAILWAY_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/sealed_dev";
const HOST = process.env.HOST ?? (HOSTED ? "0.0.0.0" : "127.0.0.1");

const importSealPrivate = (b64: string): SealKeyPair => {
  const privateKey = createPrivateKey({ key: Buffer.from(b64, "base64url"), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: createPublicKey(privateKey) };
};

/**
 * Production: the API holds only the receipt-signing key (SEALED_SIGNING_KEY) and talks to the
 * separate sealer service (SEALER_URL + SEALER_TOKEN), which alone holds the opening key.
 * Dev: both keys in .keys/server.json and an in-process sealer.
 */
function keys(): { signing: KeyPair; sealer: Sealer } {
  if (process.env.SEALED_SIGNING_KEY && process.env.SEALER_URL && process.env.SEALER_TOKEN) {
    const sk = importPrivateKey(process.env.SEALED_SIGNING_KEY);
    return {
      signing: { keyId: process.env.SEALED_SIGNING_KEY_ID ?? "sealed-1", privateKey: sk, publicKey: createPublicKey(sk) },
      sealer: new HttpSealer(process.env.SEALER_URL, process.env.SEALER_TOKEN),
    };
  }
  if (HOSTED) throw new Error("Set SEALED_SIGNING_KEY, SEALER_URL and SEALER_TOKEN in production.");
  const file = ".keys/server.json";
  let saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!saved.private_key) {
    const kp = generateKeyPair("sealed-dev-1");
    saved = { ...saved, key_id: kp.keyId, private_key: exportPrivateKey(kp.privateKey) };
  }
  if (!saved.encryption_key) saved.encryption_key = exportPrivateKey(generateSealKey().privateKey);
  mkdirSync(".keys", { recursive: true });
  writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  const sk = importPrivateKey(saved.private_key);
  return { signing: { keyId: saved.key_id, privateKey: sk, publicKey: createPublicKey(sk) }, sealer: new LocalSealer(importSealPrivate(saved.encryption_key), { ledger: new Ledger(".sealer-state") }) };
}

if (/localhost|127\.0\.0\.1/.test(DATABASE_URL)) await ensureDatabase(DATABASE_URL);
const k = keys();
// The sealer may still be starting; wait for it rather than crash-looping.
for (let i = 0; ; i++) {
  try {
    await k.sealer.publicKey();
    break;
  } catch (e) {
    if (i >= 30) throw e;
    console.log("[sealed] waiting for sealer…");
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const from = process.env.PRIMITIVE_FROM;
const email = process.env.PRIMITIVE_API_KEY && from?.includes("@") ? new Primitive({ apiKey: process.env.PRIMITIVE_API_KEY, domain: from.split("@")[1]! }) : null;
const { app } = await createApp({ databaseUrl: DATABASE_URL, publicUrl: PUBLIC_URL, signingKey: k.signing, sealer: k.sealer, email });
if (email) console.log(`[sealed] email via Primitive: agents get <handle>@${email.domain}`);
await app.listen({ port: PORT, host: HOST });
console.log(`[sealed] ${PUBLIC_URL}  ·  agents: ${PUBLIC_URL}/llms.txt  ·  mcp: ${PUBLIC_URL}/mcp`);
