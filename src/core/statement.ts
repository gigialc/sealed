// A session statement is the exact terms of one sealed question. Every
// envelope is encrypted against its fingerprint and (for agents with a signing
// key) signed together with it, so an envelope only ever opens for this one
// session — not a replay, not a different question, not different people.
import { DOMAINS, hashJson, signBody, verifyBody, type KeyPair } from "./crypto.js";
import type { SealedBlob } from "./seal.js";

export interface Participant {
  handle: string;
  role: string;
  /** Ed25519 public key (spki, base64url), or null for agents that trust Sealed to submit for them. */
  key: string | null;
}

export interface Statement {
  v: "2";
  session_id: string;
  operation: string;
  params: unknown;
  participants: Participant[];
  expires_at: string;
}

export function makeStatement(s: Omit<Statement, "v" | "participants"> & { participants: Participant[] }): Statement {
  return { v: "2", ...s, participants: [...s.participants].sort((a, b) => a.handle.localeCompare(b.handle)) };
}

export const statementHash = (s: Statement) => hashJson(s);

export const inputAad = (statementHashValue: string, role: string, handle: string) => `SEALED-INPUT-v2|${statementHashValue}|${role}|${handle}`;

/** What an agent signs when it submits: "this envelope is my answer to exactly this statement". */
export const submitBody = (statementHashValue: string, blob: SealedBlob) => ({ statement_hash: statementHashValue, envelope_hash: hashJson(blob) });

export function signSubmission(key: KeyPair, statementHashValue: string, blob: SealedBlob): string {
  return signBody(DOMAINS.submit, submitBody(statementHashValue, blob), key.privateKey);
}

export function verifySubmission(publicKey: string, statementHashValue: string, blob: SealedBlob, signature: string): boolean {
  return verifyBody(DOMAINS.submit, submitBody(statementHashValue, blob), signature, publicKey);
}
