// The sealer has its own database credentials. Never give these to the API.
// Persist only released results and accounting metadata, never private inputs.
import pg from "pg";
import type { LedgerAccess, LedgerEntry, SealerLedger } from "./sealer.js";

export class PostgresLedger implements SealerLedger {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 15_000 });
  }

  async init() {
    await this.pool.query(`create table if not exists sealer_computations (
      session_id text primary key,
      statement_hash text not null,
      result jsonb not null,
      op text not null,
      at bigint not null,
      subjects text[] not null
    )`);
    await this.pool.query(`create index if not exists sealer_computations_budget on sealer_computations (op, at)`);
  }

  async close() { await this.pool.end(); }

  async withLock<T>(sessionId: string, subjects: string[], op: string, action: (ledger: LedgerAccess) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query("begin");
      // All workers acquire the same ordered locks. A budget check and its charge
      // are atomic even across process restarts, overlapping sessions or instances.
      const locks = [...new Set([`session:${sessionId}`, ...subjects.map((s) => `budget:${op}:${s}`)])].sort();
      for (const lock of locks) await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      const access: LedgerAccess = {
        get: async (id) => {
          const row = (await tx.query("select * from sealer_computations where session_id = $1", [id])).rows[0];
          return row ? { ...row, at: Number(row.at) } as LedgerEntry : undefined;
        },
        used: async (subject, operation, since) => Number((await tx.query(
          "select count(*) as used from sealer_computations where op = $1 and at >= $2 and $3 = any(subjects)",
          [operation, since, subject],
        )).rows[0].used),
        record: async (e) => {
          await tx.query(
            "insert into sealer_computations (session_id, statement_hash, result, op, at, subjects) values ($1,$2,$3,$4,$5,$6)",
            [e.session_id, e.statement_hash, e.result, e.op, e.at, e.subjects],
          );
        },
      };
      const result = await action(access);
      await tx.query("commit");
      return result;
    } catch (error) {
      await tx.query("rollback").catch(() => {});
      throw error;
    } finally { tx.release(); }
  }
}
