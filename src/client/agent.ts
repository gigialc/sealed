// Agent SDK: join, ask and answer sealed questions with envelopes locked and
// signed on the agent's side. It checks the session statement itself, so the
// API can't quietly swap the question, the people or this agent's key.
import { createHash, createPublicKey } from "node:crypto";
import { DOMAINS, exportPrivateKey, exportPublicKey, generateKeyPair, importPrivateKey, stripSignature, verifyBody, type KeyPair } from "../core/crypto.js";
import { seal } from "../core/seal.js";
import { inputAad, signSubmission, statementHash, type Statement } from "../core/statement.js";

export interface AgentState {
  api_key: string;
  handle: string;
  signing_private_key?: string;
  receipt_key?: string;
  /** Keys this agent has seen for other handles (trust on first use). */
  pins?: Record<string, string>;
}

/** Short, human-comparable fingerprint of a public key, like a safety number. */
export function fingerprint(key: string): string {
  return createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex").slice(0, 20).match(/.{4}/g)!.join(" ");
}

export class KeyChangedError extends Error {}

export class SealedError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
  }
}

export class SealedAgent {
  private sealKey: string | null = null;
  readonly signer: KeyPair | null;

  constructor(readonly baseUrl: string, readonly state: AgentState, private readonly onStateChange?: (s: AgentState) => void) {
    this.signer = state.signing_private_key
      ? (() => {
          const privateKey = importPrivateKey(state.signing_private_key!);
          return { keyId: state.handle, privateKey, publicKey: createPublicKey(privateKey) };
        })()
      : null;
  }

  get handle() {
    return this.state.handle;
  }
  get publicKey() {
    return this.signer ? exportPublicKey(this.signer.publicKey) : null;
  }

  static async raw(baseUrl: string, method: string, path: string, body?: unknown, apiKey?: string) {
    const r = await fetch(baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  }

  /** Join with a fresh signing key (sign=false makes an agent that trusts Sealed to submit for it). */
  static async join(baseUrl: string, info: { name: string; handle?: string; description?: string; owner?: string }, opts: { sign?: boolean } = {}) {
    const kp = opts.sign === false ? null : generateKeyPair("agent");
    const r = await SealedAgent.raw(baseUrl, "POST", "/v1/agents", { ...info, ...(kp ? { signing_key: exportPublicKey(kp.publicKey) } : {}) });
    if (r.status >= 400) throw new SealedError(r.status, r.body);
    return new SealedAgent(baseUrl, {
      api_key: r.body.api_key,
      handle: r.body.handle,
      receipt_key: r.body.receipt_verification_key?.public_key_spki_b64url,
      ...(kp ? { signing_private_key: exportPrivateKey(kp.privateKey) } : {}),
    });
  }

  async call(method: string, path: string, body?: unknown) {
    const r = await SealedAgent.raw(this.baseUrl, method, path, body, this.state.api_key);
    if (r.status >= 400) throw new SealedError(r.status, r.body);
    return r.body;
  }

  private async sealPublicKey() {
    if (!this.sealKey) this.sealKey = (await this.call("GET", "/v1/keys")).keys.find((k: any) => k.use === "seal_inputs").public_key_spki_b64url;
    return this.sealKey!;
  }

  /** Add a signing key to an agent that joined without one. */
  async enableSigning(): Promise<AgentState> {
    if (this.signer) return this.state;
    const kp = generateKeyPair("agent");
    await this.call("POST", "/v1/me/signing-key", { key: exportPublicKey(kp.publicKey) });
    return { ...this.state, signing_private_key: exportPrivateKey(kp.privateKey) };
  }

  async proposeChecked(q: Parameters<SealedAgent["propose"]>[0]) {
    const created = await this.propose(q);
    const people = this.checkPins(created.session.statement as Statement);
    return { ...created, fingerprints: people };
  }

  async propose(q: { to?: string; with?: string[]; thread_id?: string; operation: string; params: Record<string, unknown>; my_role?: string; deadline_minutes?: number }) {
    return this.call("POST", "/v1/sealed", q);
  }

  get fingerprint() {
    return this.publicKey ? fingerprint(this.publicKey) : null;
  }

  /**
   * Compare everyone's key to the one we saw before (first contact pins it). A changed or
   * missing key means the directory may be lying, so refuse rather than seal.
   */
  checkPins(statement: Statement) {
    const pins = { ...(this.state.pins ?? {}) };
    let changed = false;
    for (const p of statement.participants) {
      if (p.handle === this.handle) continue;
      const known = pins[p.handle];
      if (known && known !== p.key) {
        throw new KeyChangedError(
          `@${p.handle}'s key is different from the one you saw before (was ${fingerprint(known)}, now ${p.key ? fingerprint(p.key) : "no key"}). ` +
            `Check the fingerprint with them directly before continuing.`,
        );
      }
      if (!known && p.key) {
        pins[p.handle] = p.key;
        changed = true;
      }
    }
    if (changed) {
      this.state.pins = pins;
      this.onStateChange?.(this.state);
    }
    return statement.participants.map((p) => ({ handle: p.handle, role: p.role, fingerprint: p.key ? fingerprint(p.key) : "no key (trusts Sealed)" }));
  }

  /** Check the statement the API gave us is the one we expect, from our own point of view. */
  checkStatement(statement: Statement, expect?: { operation?: string; params?: unknown }) {
    this.checkPins(statement);
    const me = statement.participants.find((p) => p.handle === this.handle);
    if (!me) throw new Error("statement doesn't include this agent");
    if (this.signer && me.key !== this.publicKey) throw new Error("statement lists a different key for this agent");
    if (new Date(statement.expires_at) <= new Date()) throw new Error("statement already expired");
    if (expect?.operation && statement.operation !== expect.operation) throw new Error("statement is for a different question");
    if (expect?.params && JSON.stringify(statement.params) !== JSON.stringify({ ...(statement.params as object), ...(expect.params as object) })) {
      throw new Error("statement terms differ from what was asked");
    }
    return me;
  }

  /** Lock (and sign) a private input for one session. Never sends plaintext. */
  async submit(sessionId: string, input: unknown, expect?: { operation?: string; params?: unknown }) {
    const view = await this.call("GET", `/v1/sealed/${sessionId}`);
    const statement = view.statement as Statement;
    const me = this.checkStatement(statement, expect);
    const hash = statementHash(statement); // computed here, not taken from the API
    const blob = seal(await this.sealPublicKey(), input, inputAad(hash, me.role, me.handle));
    const body: Record<string, unknown> = { sealed_input: blob };
    if (this.signer) body.signature = signSubmission(this.signer, hash, blob);
    return this.call("POST", `/v1/sealed/${sessionId}/submit`, body);
  }

  async status(sessionId: string, waitSeconds = 0) {
    return this.call("GET", `/v1/sealed/${sessionId}${waitSeconds ? `?wait=${waitSeconds}` : ""}`);
  }

  async receiptValid(receipt: any) {
    const key = this.state.receipt_key ?? (await this.call("GET", "/v1/keys")).keys.find((k: any) => k.use === "sign_receipts").public_key_spki_b64url;
    const { body, signature } = stripSignature(receipt, "signature");
    return verifyBody(DOMAINS.receipt, body, String(signature), key);
  }
}
