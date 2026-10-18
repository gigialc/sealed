// Ed25519 signing over RFC 8785 canonical JSON with domain separation.
// Uses node:crypto (OpenSSL) — no custom primitives.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import canonicalizeImpl from "canonicalize";

const canonicalizeFn = canonicalizeImpl as unknown as (v: unknown) => string | undefined;

export const DOMAINS = {
  receipt: "SEALED-RECEIPT-v1",
} as const;
export type Domain = (typeof DOMAINS)[keyof typeof DOMAINS];

export function canonicalize(value: unknown): string {
  const out = canonicalizeFn(value);
  if (out === undefined) throw new Error("value is not canonicalizable");
  return out;
}

export function sha256(data: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(canonicalize(value));
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function randomNonce(): string {
  return randomBytes(16).toString("base64url"); // 128 bits
}

function signingInput(domain: Domain, body: unknown): Buffer {
  return Buffer.from(`${domain}\n${canonicalize(body)}`, "utf8");
}

export interface KeyPair {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateKeyPair(keyId: string): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { keyId, privateKey, publicKey };
}

export function exportPublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

export function importPublicKey(b64url: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64url, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an ed25519 key");
  return key;
}

export function exportPrivateKey(key: KeyObject): string {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64url");
}

export function importPrivateKey(b64url: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64url, "base64url"), format: "der", type: "pkcs8" });
}

export function signBody(domain: Domain, body: unknown, key: KeyObject): string {
  return edSign(null, signingInput(domain, body), key).toString("base64url");
}

/** Never throws: malformed keys/signatures verify as false (fail closed). */
export function verifyBody(domain: Domain, body: unknown, signature: string, key: KeyObject | string): boolean {
  try {
    const pub = typeof key === "string" ? importPublicKey(key) : key;
    return edVerify(null, signingInput(domain, body), pub, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Split `{...body, [sigField]: sig}` into body + signature. */
export function stripSignature<T extends Record<string, unknown>, K extends keyof T & string>(obj: T, field: K): { body: Omit<T, K>; signature: T[K] } {
  const { [field]: signature, ...body } = obj;
  return { body: body as Omit<T, K>, signature };
}
