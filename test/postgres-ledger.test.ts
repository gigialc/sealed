import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPublicKey, generateKeyPair } from "../src/core/crypto.js";
import { exportSealPublic, generateSealKey, seal } from "../src/core/seal.js";
import { inputAad, makeStatement, signSubmission, statementHash, type Statement } from "../src/core/statement.js";
import { ensureDatabase } from "../src/server/db.js";
import { PostgresLedger } from "../src/sealer/postgres-ledger.js";
import { LocalSealer, type Envelope } from "../src/sealer/sealer.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/sealed_test";
const schema = `ledger_test_${randomBytes(6).toString("hex")}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const ledgers: PostgresLedger[] = [];
const key = generateSealKey();
const buyerKey = generateKeyPair("buyer");
const sellerKey = generateKeyPair("seller");

async function ledger() {
  const l = new PostgresLedger(scopedUrl.toString());
  await l.init();
  ledgers.push(l);
  return l;
}

function question(sessionId = `sx_${randomBytes(6).toString("hex")}`) {
  const statement = makeStatement({
    session_id: sessionId,
    operation: "deal_zone",
    params: { what: "Synthetic test", currency: "EUR", at_price: 2500 },
    participants: [
      { handle: "buyer", role: "buyer", key: exportPublicKey(buyerKey.publicKey) },
      { handle: "seller", role: "seller", key: exportPublicKey(sellerKey.publicKey) },
    ],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { statement, envelopes: envelopesFor(statement) };
}

function envelopesFor(statement: Statement): Envelope[] {
  return statement.participants.map((p) => {
    const hash = statementHash(statement);
    const blob = seal(exportSealPublic(key.publicKey), {
      input: p.role === "buyer" ? { max: 2900 } : { min: 2150 },
      salt: randomBytes(24).toString("base64url"),
    }, inputAad(hash, p.role, p.handle));
    return { handle: p.handle, blob, signature: signSubmission(p.role === "buyer" ? buyerKey : sellerKey, hash, blob) };
  });
}

beforeAll(async () => {
  await ensureDatabase(databaseUrl);
  await admin.query(`create schema ${schema}`);
});
afterAll(async () => {
  await Promise.all(ledgers.map((l) => l.close()));
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

describe("durable sealer ledger", () => {
  it("preserves results, replay protection and budget across a restart", async () => {
    const first = await ledger();
    const q = question();
    const a = new LocalSealer(key, { ledger: first, dailyLimitPerKey: 1 });
    const result = await a.compute(q.statement, q.envelopes);
    expect(result.ok).toBe(true);
    await first.close();
    ledgers.splice(ledgers.indexOf(first), 1);
    const restarted = new LocalSealer(key, { ledger: await ledger(), dailyLimitPerKey: 1 });
    expect(await restarted.compute(q.statement, q.envelopes)).toEqual(result);
    const altered = { ...q.statement, params: { ...(q.statement.params as object), at_price: 2200 } };
    expect(await restarted.compute(altered, envelopesFor(altered))).toEqual({ ok: false, error: "already_computed" });
    const next = question();
    expect(await restarted.compute(next.statement, next.envelopes)).toEqual({ ok: false, error: "budget_exhausted" });
    const row = (await admin.query(`select * from ${schema}.sealer_computations where session_id=$1`, [q.statement.session_id])).rows[0];
    expect(Object.keys(row).sort()).toEqual(["at", "op", "result", "session_id", "statement_hash", "subjects"]);
    expect(JSON.stringify(row)).not.toMatch(/2900|2150|agent-side-salt/);
  });

  it("charges one budget slot for concurrent retries from different workers", async () => {
    const q = question();
    const a = new LocalSealer(key, { ledger: await ledger(), dailyLimitPerKey: 100 });
    const b = new LocalSealer(key, { ledger: await ledger(), dailyLimitPerKey: 100 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).compute(q.statement, q.envelopes)));
    expect(results.every((r) => r.ok)).toBe(true);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(Number((await admin.query(`select count(*) from ${schema}.sealer_computations where session_id=$1`, [q.statement.session_id])).rows[0].count)).toBe(1);
  });

  it("enforces a shared budget atomically across simultaneous different sessions", async () => {
    const previous = Number((await admin.query(`select count(*) from ${schema}.sealer_computations`)).rows[0].count);
    const a = new LocalSealer(key, { ledger: await ledger(), dailyLimitPerKey: previous + 2 });
    const b = new LocalSealer(key, { ledger: await ledger(), dailyLimitPerKey: previous + 2 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const q = question();
      return (i % 2 ? a : b).compute(q.statement, q.envelopes);
    }));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toEqual(Array(6).fill({ ok: false, error: "budget_exhausted" }));
  });

  it("rolls back a failed transaction and permits a later retry", async () => {
    const l = await ledger();
    const id = `rollback_${randomBytes(6).toString("hex")}`;
    await expect(l.withLock(id, ["synthetic"], "test", async (tx) => {
      await tx.record({ session_id: id, statement_hash: "test", result: { ok: true }, op: "test", at: Date.now(), subjects: ["synthetic"] });
      throw new Error("simulated failure before commit");
    })).rejects.toThrow("simulated failure");
    await l.withLock(id, ["synthetic"], "test", async (tx) => {
      expect(await tx.get(id)).toBeUndefined();
      expect(await tx.used("synthetic", "test", 0)).toBe(0);
      await tx.record({ session_id: id, statement_hash: "test", result: { ok: true }, op: "test", at: Date.now(), subjects: ["synthetic"] });
    });
  });

  it("releases no answer when durable storage is unavailable", async () => {
    const closed = await ledger();
    await closed.close();
    ledgers.splice(ledgers.indexOf(closed), 1);
    const q = question();
    await expect(new LocalSealer(key, { ledger: closed }).compute(q.statement, q.envelopes)).rejects.toThrow();
    expect((await admin.query(`select * from ${schema}.sealer_computations where session_id=$1`, [q.statement.session_id])).rowCount).toBe(0);
  });
});
