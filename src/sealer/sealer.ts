// The sealer: the only code that can open sealed boxes. It holds the opening
// key, checks a box when it arrives, and computes an answer when both boxes
// are in. It never stores anything and never returns a secret — only
// commitments, a yes/no on whether a box is valid, and the declared answer.
import { createHash, randomBytes } from "node:crypto";
import { canonicalize } from "../core/crypto.js";
import { exportSealPublic, open, sealAad, type SealKeyPair, type SealedBlob } from "../core/seal.js";
import { OPS } from "../server/ops.js";

export type CheckResult = { ok: true; commitment: string; salt: string } | { ok: false; error: string };
export type ComputeResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
export interface SealedEntry {
  role: string;
  handle: string;
  blob: SealedBlob;
}

/** What the API needs from the sealer. Implemented in-process (dev/tests) and over HTTP (production). */
export interface Sealer {
  publicKey(): Promise<string>;
  check(op: string, role: string, handle: string, blob: SealedBlob): Promise<CheckResult>;
  compute(op: string, params: unknown, entries: SealedEntry[]): Promise<ComputeResult>;
}

export class LocalSealer implements Sealer {
  constructor(private readonly key: SealKeyPair) {}

  async publicKey() {
    return exportSealPublic(this.key.publicKey);
  }

  private openValid(op: string, role: string, handle: string, blob: SealedBlob): { ok: true; value: unknown } | { ok: false; error: string } {
    const def = OPS[op];
    const schema = def?.inputs[role];
    if (!def || !schema) return { ok: false, error: "unknown_operation_or_role" };
    let value: unknown;
    try {
      value = open(this.key, blob, sealAad(op, role, handle));
    } catch {
      return { ok: false, error: "cannot_open" };
    }
    const parsed = schema.safeParse(value);
    // Never echo the input back: say what shape was expected, not what was received.
    if (!parsed.success) return { ok: false, error: `invalid_shape: expected ${JSON.stringify(def.example.inputs[role])}` };
    return { ok: true, value: parsed.data };
  }

  async check(op: string, role: string, handle: string, blob: SealedBlob): Promise<CheckResult> {
    const r = this.openValid(op, role, handle, blob);
    if (!r.ok) return r;
    const salt = randomBytes(16).toString("base64url");
    const commitment = "sha256:" + createHash("sha256").update(`${salt}\n${canonicalize(r.value)}`).digest("hex");
    return { ok: true, commitment, salt };
  }

  async compute(op: string, params: unknown, entries: SealedEntry[]): Promise<ComputeResult> {
    const def = OPS[op];
    if (!def || entries.length !== 2 || new Set(entries.map((e) => e.role)).size !== 2) return { ok: false, error: "bad_request" };
    const p = def.params.safeParse(params);
    if (!p.success) return { ok: false, error: "bad_params" };
    const inputs: Record<string, unknown> = {};
    for (const e of entries) {
      const r = this.openValid(op, e.role, e.handle, e.blob);
      if (!r.ok) return r;
      inputs[e.role] = r.value;
    }
    return { ok: true, result: def.compute(p.data, inputs) };
  }
}

/** Talks to the sealer service over the private network. */
export class HttpSealer implements Sealer {
  constructor(private readonly url: string, private readonly token: string) {}

  private async call(path: string, body?: unknown) {
    const r = await fetch(this.url.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-sealer-token": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok && r.status !== 422) throw new Error(`sealer ${path} ${r.status}`);
    return r.json() as Promise<any>;
  }

  async publicKey() {
    return (await this.call("/public-key")).public_key_spki_b64url as string;
  }
  check(op: string, role: string, handle: string, blob: SealedBlob) {
    return this.call("/check", { op, role, handle, blob }) as Promise<CheckResult>;
  }
  compute(op: string, params: unknown, entries: SealedEntry[]) {
    return this.call("/compute", { op, params, entries }) as Promise<ComputeResult>;
  }
}
