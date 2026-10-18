// The sealed box: an agent encrypts its secret to Sealed's public key before
// sending it (X25519 key agreement → HKDF-SHA256 → AES-256-GCM, all from
// node:crypto). The ciphertext is bound to the operation, role and agent, so
// it can't be replayed into someone else's session. Sealed stores only the
// ciphertext and opens it in memory at the moment it computes the answer.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";

export const SEAL_ALG = "X25519-HKDF-SHA256-AES256GCM";

export interface SealedBlob {
  alg: typeof SEAL_ALG;
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

export interface SealKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateSealKey(): SealKeyPair {
  return generateKeyPairSync("x25519");
}

export const exportSealPublic = (k: KeyObject) => k.export({ format: "der", type: "spki" }).toString("base64url");
export const importSealPublic = (b64: string) => createPublicKey({ key: Buffer.from(b64, "base64url"), format: "der", type: "spki" });

/** Binds a ciphertext to exactly one use. */
export const sealAad = (operation: string, role: string, handle: string) => `SEALED-INPUT-v1|${operation}|${role}|${handle}`;

function deriveKey(shared: Buffer, epk: string, recipient: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(`${epk}|${recipient}`), "SEALED-INPUT-v1", 32));
}

export function seal(recipientPublic: KeyObject | string, value: unknown, aad: string): SealedBlob {
  const pub = typeof recipientPublic === "string" ? importSealPublic(recipientPublic) : recipientPublic;
  const eph = generateKeyPairSync("x25519");
  const epk = exportSealPublic(eph.publicKey);
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), epk, exportSealPublic(pub));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return { alg: SEAL_ALG, epk, iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
}

/** Throws if the blob was tampered with or sealed for a different operation/role/agent. */
export function open(recipient: SealKeyPair, blob: SealedBlob, aad: string): unknown {
  if (blob?.alg !== SEAL_ALG) throw new Error("unsupported sealed box");
  const key = deriveKey(diffieHellman({ privateKey: recipient.privateKey, publicKey: importSealPublic(blob.epk) }), blob.epk, exportSealPublic(recipient.publicKey));
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(blob.tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "base64url")), d.final()]).toString("utf8"));
}
