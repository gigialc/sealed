// The sealer's own guarantees, tested as a compromised API would attack them:
// it holds the sealer token and every stored envelope, and controls what it
// sends. None of these rely on the API behaving.
import { describe, expect, it } from "vitest";
import { exportPublicKey, generateKeyPair, type KeyPair } from "../src/core/crypto.js";
import { exportSealPublic, generateSealKey, seal } from "../src/core/seal.js";
import { inputAad, makeStatement, signSubmission, statementHash, type Statement } from "../src/core/statement.js";
import { Ledger, LocalSealer, type Envelope } from "../src/sealer/sealer.js";

const sealKey = generateSealKey();
const pub = exportSealPublic(sealKey.publicKey);
const newSealer = (limit = 5) => new LocalSealer(sealKey, { ledger: new Ledger(), dailyLimitPerKey: limit });
const agent = (handle: string) => ({ handle, kp: generateKeyPair(handle) });
type A = ReturnType<typeof agent>;
let n = 0;

function statementFor(buyer: A, seller: A, params: Record<string, unknown> = { what: "Logo", currency: "EUR", at_price: 2500 }, minutes = 60): Statement {
  return makeStatement({
    session_id: `sx_test${++n}`,
    operation: "deal_zone",
    params,
    participants: [
      { handle: buyer.handle, role: "buyer", key: exportPublicKey(buyer.kp.publicKey) },
      { handle: seller.handle, role: "seller", key: exportPublicKey(seller.kp.publicKey) },
    ],
    expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
  });
}
function envelope(st: Statement, who: A, input: unknown, signer: KeyPair = who.kp): Envelope {
  const me = st.participants.find((p) => p.handle === who.handle)!;
  const h = statementHash(st);
  const blob = seal(pub, { input, salt: "agent-side-salt-0123456789" }, inputAad(h, me.role, me.handle));
  return { handle: who.handle, blob, signature: signSubmission(signer, h, blob) };
}

describe("sealer against a compromised API", () => {
  it("computes an honest question exactly once", async () => {
    const sealer = newSealer();
    const [maya, nova] = [agent("maya"), agent("nova")];
    const st = statementFor(maya, nova);
    const envs = [envelope(st, maya, { max: 2900 }), envelope(st, nova, { min: 2150 })];
    expect(await sealer.compute(st, envs)).toEqual({ ok: true, result: { deal_at_price: true, price: 2500, currency: "EUR" } });
    expect(await sealer.compute(st, envs)).toEqual({ ok: false, error: "already_computed" });
  });

  it("refuses an envelope forged for a signed agent (the API can encrypt, but can't sign as them)", async () => {
    const sealer = newSealer();
    const [maya, nova, api] = [agent("maya"), agent("nova"), agent("evil-api")];
    const st = statementFor(maya, nova);
    const forged = envelope(st, nova, { min: 2899.99 }, api.kp); // chosen input, attacker's own key
    expect(await sealer.compute(st, [envelope(st, maya, { max: 2900 }), forged])).toEqual({ ok: false, error: "bad_signature" });
  });

  it("refuses to reuse a stored envelope in a new question the API made up", async () => {
    const sealer = newSealer();
    const [maya, nova, api] = [agent("maya"), agent("nova"), agent("evil-api")];
    const real = statementFor(maya, nova);
    const mayas = envelope(real, maya, { max: 2900 });
    // New session where the API plays the seller with a chosen minimum.
    const fake = statementFor(maya, api);
    const r = await sealer.compute(fake, [{ ...mayas }, envelope(fake, api, { min: 2000 })]);
    expect(r.ok).toBe(false);
    expect(["bad_signature", "cannot_open"]).toContain((r as { error: string }).error);
  });

  it("refuses when the terms are changed after agents sealed", async () => {
    const sealer = newSealer();
    const [maya, nova] = [agent("maya"), agent("nova")];
    const st = statementFor(maya, nova);
    const envs = [envelope(st, maya, { max: 2900 }), envelope(st, nova, { min: 2150 })];
    const tampered = { ...st, params: { ...(st.params as object), at_price: 2149 } } as Statement;
    expect((await sealer.compute(tampered, envs)).ok).toBe(false);
  });

  it("refuses expired questions, missing envelopes and extra people", async () => {
    const sealer = newSealer();
    const [maya, nova, eve] = [agent("maya"), agent("nova"), agent("eve")];
    const old = statementFor(maya, nova, undefined, -1);
    expect(await sealer.compute(old, [envelope(old, maya, { max: 1 }), envelope(old, nova, { min: 1 })])).toEqual({ ok: false, error: "expired" });
    const st = statementFor(maya, nova);
    expect(await sealer.compute(st, [envelope(st, maya, { max: 1 })])).toEqual({ ok: false, error: "not_all_participants" });
    expect((await sealer.compute(st, [envelope(st, maya, { max: 1 }), envelope(st, nova, { min: 1 }), { ...envelope(st, nova, { min: 1 }), handle: eve.handle }])).ok).toBe(false);
  });

  it("caps questions about one key's secret per day, no matter how many new identities ask", async () => {
    const sealer = newSealer(5);
    const nova = agent("nova");
    const results = [];
    for (let i = 0; i < 7; i++) {
      const sybil = agent(`sybil-${i}`); // a brand-new requester every time
      const st = statementFor(sybil, nova, { what: "Logo", currency: "EUR", at_price: 2000 + i * 100 });
      results.push(await sealer.compute(st, [envelope(st, sybil, { max: 99999 }), envelope(st, nova, { min: 2150 })]));
    }
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.slice(5)).toEqual([{ ok: false, error: "budget_exhausted" }, { ok: false, error: "budget_exhausted" }]);
  });

  it("the ledger survives a sealer restart (file-backed)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const [maya, nova] = [agent("maya"), agent("nova")];
    const st = statementFor(maya, nova);
    const envs = [envelope(st, maya, { max: 2900 }), envelope(st, nova, { min: 2150 })];
    expect((await new LocalSealer(sealKey, { ledger: new Ledger(dir) }).compute(st, envs)).ok).toBe(true);
    expect(await new LocalSealer(sealKey, { ledger: new Ledger(dir) }).compute(st, envs)).toEqual({ ok: false, error: "already_computed" });
  });
});
