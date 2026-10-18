// Postgres store. Sealed inputs live here only until both sides have
// submitted; resolution deletes them in the same transaction and keeps a
// salted commitment for the receipt.
import pg from "pg";

export const SCHEMA_SQL = `
create table if not exists agents (
  agent_id text primary key,
  handle text not null unique,
  name text not null,
  description text not null default '',
  owner text,
  api_key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create table if not exists threads (
  thread_id text primary key,
  agent_a text not null references agents(agent_id),
  agent_b text not null references agents(agent_id),
  subject text not null default '',
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_by text not null,
  created_at timestamptz not null default now()
);
create table if not exists messages (
  message_id text primary key,
  thread_id text not null references threads(thread_id),
  from_agent text not null references agents(agent_id),
  body text not null,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  session_id text primary key,
  thread_id text not null references threads(thread_id),
  op text not null,
  params jsonb not null,
  proposer text not null references agents(agent_id),
  roles jsonb not null,
  status text not null default 'open' check (status in ('open','resolved','declined','expired')),
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz
);
alter table sessions alter column thread_id drop not null;
create table if not exists sealed_inputs (
  session_id text not null references sessions(session_id),
  agent_id text not null references agents(agent_id),
  role text not null,
  input jsonb,
  commitment text not null,
  submitted_at timestamptz not null default now(),
  primary key (session_id, agent_id)
);
create table if not exists receipts (
  session_id text primary key references sessions(session_id),
  body jsonb not null
);
create table if not exists pair_limits (
  op text not null,
  agent_lo text not null,
  agent_hi text not null,
  day text not null,
  used int not null default 0,
  primary key (op, agent_lo, agent_hi, day)
);
create table if not exists notifications (
  id bigserial primary key,
  agent_id text not null references agents(agent_id),
  kind text not null,
  thread_id text,
  session_id text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
alter table agents add column if not exists webhook_url text;
alter table notifications add column if not exists webhook_delivered_at timestamptz;
alter table notifications add column if not exists webhook_attempts int not null default 0;
create index if not exists notifications_unread on notifications (agent_id) where read_at is null;
create table if not exists activity (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,
  thread_id text,
  session_id text,
  actor text,
  counterpart text,
  summary text not null
);
`;

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string, schema?: string): Db {
  return new pg.Pool({ connectionString: url, max: 20, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
}

export async function migrate(db: Db, schema?: string) {
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
    await db.query(`create schema if not exists ${schema}`);
  }
  await db.query(SCHEMA_SQL);
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    const out = await fn(tx);
    await tx.query("commit");
    return out;
  } catch (e) {
    await tx.query("rollback").catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

export async function ensureDatabase(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const r = await c.query(`select 1 from pg_database where datname = $1`, [name]);
  if (!r.rowCount) {
    await c.query(`create database "${name.replace(/"/g, "")}"`).catch((err) => {
      if (!["42P04", "23505"].includes(err.code)) throw err;
    });
  }
  await c.end();
}
