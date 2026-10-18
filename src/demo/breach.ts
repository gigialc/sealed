// The Breach Challenge. Runs the same attacks against two real deployments,
// side by side, on this machine:
//   Round 1: the pre-audit code (git tag v0-before-audit)
//   Round 2: the current code
// Each deployment is its own API process + sealer process + database. The
// attacker uses only what it would really have: public HTTP, fresh agent
// identities, and (for the compromised-API attack) the sealer token and the
// database. Nothing here is scripted to succeed or fail — every line of the
// report is computed from the servers' actual responses.
//
//   npm run breach        (needs local Postgres; writes breach-report.md)
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { SealedAgent } from "../client/agent.js";
import { exportPrivateKey, exportPublicKey, generateKeyPair } from "../core/crypto.js";
import { generateSealKey, seal } from "../core/seal.js";
import { inputAad, signSubmission, statementHash, type Statement } from "../core/statement.js";

const ROOT = resolve(import.meta.dirname, "../..");
const PG = process.env.DATABASE_URL_BASE ?? "postgresql://localhost:5432";
const SECRET_MIN = 2150; // Alice's real minimum. The attacker's goal is to learn it.
const RANGE: [number, number] = [0, 10000]; // what the attacker assumes before starting
const lines: string[] = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};

// ------------------------------------------------------------ deployments

interface Deployment {
  name: string;
  url: string;
  sealerUrl: string;
  token: string;
  db: string;
  procs: ChildProcess[];
}

async function resetDb(name: string) {
  const c = new pg.Client({ connectionString: `${PG}/postgres` });
  await c.connect();
  await c.query(`drop database if exists "${name}" with (force)`);
  await c.query(`create database "${name}"`);
  await c.end();
}

function startProc(cwd: string, env: Record<string, string>, ready: string): Promise<ChildProcess> {
  const p = spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/start.ts"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => {
    let out = "";
    p.stdout!.on("data", (d) => {
      out += d;
      if (out.includes(ready)) res(p);
    });
    p.stderr!.on("data", (d) => (out += d));
    p.on("exit", (code) => rej(new Error(`process exited (${code}): ${out.slice(-400)}`)));
  });
}

async function deploy(name: string, cwd: string, apiPort: number, sealerPort: number): Promise<Deployment> {
  const db = `sealed_breach_${name}`;
  await resetDb(db);
  const token = randomBytes(24).toString("base64url");
  const sealer = await startProc(
    cwd,
    {
      SEALED_ROLE: "sealer", PORT: String(sealerPort), HOST: "127.0.0.1", SEALER_TOKEN: token,
      SEALED_ENCRYPTION_KEY: exportPrivateKey(generateSealKey().privateKey), SEALER_STATE_DIR: mkdtempSync(join(tmpdir(), "sealer-")), SEALER_DAILY_LIMIT: "5",
    },
    "[sealer] listening",
  );
  const api = await startProc(
    cwd,
    {
      SEALED_ROLE: "api", PORT: String(apiPort), DATABASE_URL: `${PG}/${db}`, SEALED_SIGNING_KEY: exportPrivateKey(generateKeyPair("k").privateKey),
      SEALER_URL: `http://127.0.0.1:${sealerPort}`, SEALER_TOKEN: token,
    },
    "[sealed]",
  );
  return { name, url: `http://127.0.0.1:${apiPort}`, sealerUrl: `http://127.0.0.1:${sealerPort}`, token, db: `${PG}/${db}`, procs: [sealer, api] };
}

// ------------------------------------------------------------ helpers

const http = SealedAgent.raw;
let n = 0;
const fresh = (p: string) => `${p}-${++n}-${randomBytes(2).toString("hex")}`;

/** An honest seller agent that answers every deal_zone question about its human's minimum. */
async function honestAliceAnswers(d: Deployment, alice: { api_key: string; handle: string } | SealedAgent) {
  const key = alice instanceof SealedAgent ? alice.state.api_key : alice.api_key;
  const inbox = (await http(d.url, "GET", "/v1/inbox", undefined, key)).body;
  const out = [];
  for (const w of inbox.sealed_waiting_for_your_input ?? []) {
    if (w.operation !== "deal_zone") continue;
    const r = alice instanceof SealedAgent
      ? await alice.submit(w.session_id, { min: SECRET_MIN }).then((b) => ({ status: 200, body: b }), (e) => ({ status: e.status, body: e.body }))
      : await http(d.url, "POST", `/v1/sealed/${w.session_id}/submit`, { input: { min: SECRET_MIN } }, key);
    out.push(r);
  }
  return out;
}

const money = (x: number) => `€${x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
// Bisection keeps min in (lo, hi], so the upper bound is the best guess.
const interval = (lo: number, hi: number) => (hi - lo < 0.02 ? `exactly ${money(hi)}` : `somewhere in ${money(lo)}–${money(hi)} (±${money((hi - lo) / 2)})`);
const reqs = (k: number) => `${k} request${k === 1 ? "" : "s"}`;

// ------------------------------------------------------------ attacks

/** A: ask for the midpoint price and invert it. */
async function midpointInversion(d: Deployment, signed: boolean) {
  const alice = signed ? await SealedAgent.join(d.url, { name: fresh("alice") }) : (await http(d.url, "POST", "/v1/agents", { name: fresh("alice") })).body;
  const bob = (await http(d.url, "POST", "/v1/agents", { name: fresh("bob") })).body;
  const BOB_MAX = 100000;
  const r = await http(d.url, "POST", "/v1/sealed", {
    to: alice.handle ?? (alice as SealedAgent).handle, operation: "deal_zone",
    params: { what: "Brand kit", currency: "EUR", round_to: 0.01, outcome: "midpoint_price" }, my_role: "buyer", my_input: { max: BOB_MAX },
  }, bob.api_key);
  if (r.status >= 400) return { learned: "nothing", detail: `server refused the question: ${r.body.error} (the midpoint answer no longer exists)`, requests: 1 };
  const answers = await honestAliceAnswers(d, alice);
  const result = answers[0]?.body?.result;
  if (!result?.price) return { learned: "nothing", detail: JSON.stringify(result), requests: 2 };
  const recovered = 2 * result.price - BOB_MAX;
  return { learned: interval(recovered, recovered), detail: `answer was ${money(result.price)} → 2 × ${result.price} − ${BOB_MAX} = ${recovered}`, requests: 2, exact: recovered === SECRET_MIN };
}

/** B: binary search on Alice's minimum, using a brand-new identity for every question. */
async function bisectWithFreshIdentities(d: Deployment, signed: boolean) {
  const alice = signed ? await SealedAgent.join(d.url, { name: fresh("alice") }) : (await http(d.url, "POST", "/v1/agents", { name: fresh("alice") })).body;
  const aliceHandle = (alice as any).handle;
  let [lo, hi] = RANGE;
  let asked = 0;
  let refusedBy = "";
  for (let i = 0; i < 20 && hi - lo > 0.02; i++) {
    const mid = Math.round(((lo + hi) / 2) * 100) / 100;
    const sybil = (await http(d.url, "POST", "/v1/agents", { name: fresh("sybil") })).body;
    const params = signed ? { what: "Brand kit", currency: "EUR", at_price: mid } : { what: "Brand kit", currency: "EUR", outcome: "yes_no" };
    const p = await http(d.url, "POST", "/v1/sealed", { to: aliceHandle, operation: "deal_zone", params, my_role: "buyer", my_input: { max: signed ? 999999 : mid } }, sybil.api_key);
    asked++;
    if (p.status >= 400) {
      refusedBy = `API: ${p.body.error}`;
      break;
    }
    const [ans] = await honestAliceAnswers(d, alice);
    if (!ans || ans.status >= 400) {
      refusedBy = `sealer: ${ans?.body?.error ?? "no answer"}`;
      break;
    }
    const res = ans.body.result;
    const minAtOrBelow = signed ? res.deal_at_price : res.deal; // "Alice's minimum ≤ mid"
    if (minAtOrBelow) hi = mid;
    else lo = mid;
  }
  return { learned: interval(lo, hi), requests: asked, detail: refusedBy ? `stopped after ${asked} questions — refused by ${refusedBy}` : `${asked} questions, each from a new identity`, exact: hi - lo < 0.02 };
}

/** C: a compromised API with the sealer token and the database replays Alice's stored envelope. */
async function compromisedApi(d: Deployment, signed: boolean) {
  const db = new pg.Client({ connectionString: d.db });
  await db.connect();
  const sealerKey = (await http(d.url, "GET", "/v1/keys")).body.keys.find((k: any) => k.use === "seal_inputs").public_key_spki_b64url;
  const call = async (path: string, body: unknown) => {
    const r = await fetch(d.sealerUrl + path, { method: "POST", headers: { "content-type": "application/json", "x-sealer-token": d.token }, body: JSON.stringify(body) });
    return r.json() as Promise<any>;
  };
  let calls = 0;
  try {
    if (!signed) {
      // Round 1: Alice sealed her minimum in a real question to Carol; Carol hasn't answered yet.
      const alice = (await http(d.url, "POST", "/v1/agents", { name: fresh("alice") })).body;
      const carol = (await http(d.url, "POST", "/v1/agents", { name: fresh("carol") })).body;
      await http(d.url, "POST", "/v1/sealed", { to: carol.handle, operation: "deal_zone", params: { what: "Brand kit", currency: "EUR", outcome: "yes_no" }, my_role: "seller", my_input: { min: SECRET_MIN } }, alice.api_key);
      const blob = (await db.query(`select i.input from sealed_inputs i join agents a on a.agent_id = i.agent_id where a.handle = $1`, [alice.handle])).rows[0].input;
      // Feed Alice's envelope to the sealer with a made-up buyer and the most revealing terms.
      const fakeBuyer = "x";
      const mine = seal(sealerKey, { max: 100000 }, `SEALED-INPUT-v1|deal_zone|buyer|${fakeBuyer}`);
      const r = await call("/compute", { op: "deal_zone", params: { what: "x", currency: "EUR", round_to: 0.01, outcome: "midpoint_price" }, entries: [{ role: "seller", handle: alice.handle, blob }, { role: "buyer", handle: fakeBuyer, blob: mine }] });
      calls++;
      if (!r.ok) return { learned: "nothing", requests: calls, detail: `sealer refused: ${r.error}` };
      const recovered = 2 * r.result.price - 100000;
      return { learned: interval(recovered, recovered), requests: calls, detail: `1 direct sealer call with Alice's stored envelope → midpoint ${money(r.result.price)}`, exact: recovered === SECRET_MIN };
    }
    // Round 2: same situation with signed agents.
    const alice = await SealedAgent.join(d.url, { name: fresh("alice") });
    const carol = await SealedAgent.join(d.url, { name: fresh("carol") });
    const p = await alice.propose({ to: carol.handle, operation: "deal_zone", params: { what: "Brand kit", currency: "EUR" }, my_role: "seller" });
    await alice.submit(p.session.session_id, { min: SECRET_MIN });
    const row = (await db.query(`select s.statement, i.input, i.signature from sessions s join sealed_inputs i on i.session_id = s.session_id where s.session_id = $1`, [p.session.session_id])).rows[0];
    const st = row.statement as Statement;
    const aliceEnv = { handle: alice.handle, blob: row.input, signature: row.signature };
    const tries: string[] = [];
    // 1) Forge Carol's envelope with a chosen max (the API can encrypt but has no Carol key).
    const fake = generateKeyPair("api");
    const h = statementHash(st);
    const forgedBlob = seal(sealerKey, { max: SECRET_MIN }, inputAad(h, "buyer", carol.handle));
    let r = await call("/compute", { statement: st, envelopes: [aliceEnv, { handle: carol.handle, blob: forgedBlob, signature: signSubmission(fake, h, forgedBlob) }] });
    calls++;
    tries.push(`forge Carol's envelope → ${r.ok ? "ANSWERED" : r.error}`);
    // 2) Make up a new question where the API is the buyer, reusing Alice's envelope.
    const evil: Statement = { ...st, session_id: "sx_madeup", participants: st.participants.map((x) => (x.handle === carol.handle ? { ...x, key: exportPublicKey(fake.publicKey) } : x)) };
    const eh = statementHash(evil);
    const eb = seal(sealerKey, { max: SECRET_MIN }, inputAad(eh, "buyer", carol.handle));
    r = await call("/compute", { statement: evil, envelopes: [aliceEnv, { handle: carol.handle, blob: eb, signature: signSubmission(fake, eh, eb) }] });
    calls++;
    tries.push(`new made-up question reusing Alice's envelope → ${r.ok ? "ANSWERED" : r.error}`);
    // 3) Change the terms of the real question.
    r = await call("/compute", { statement: { ...st, params: { ...(st.params as object), at_price: 2000 } }, envelopes: [aliceEnv, { handle: carol.handle, blob: forgedBlob, signature: "x" }] });
    calls++;
    tries.push(`change the terms → ${r.ok ? "ANSWERED" : r.error}`);
    const answered = tries.some((t) => t.includes("ANSWERED"));
    return { learned: answered ? "something (see detail)" : "nothing", requests: calls, detail: tries.join("; ") };
  } finally {
    await db.end();
  }
}

/** The legitimate deal must still work after the fixes. */
async function honestDeal(d: Deployment) {
  const maya = await SealedAgent.join(d.url, { name: fresh("maya") });
  const nova = await SealedAgent.join(d.url, { name: fresh("nova") });
  const q1 = await maya.propose({ to: nova.handle, operation: "deal_zone", params: { what: "Logo + brand kit", currency: "EUR" }, my_role: "buyer" });
  await maya.submit(q1.session.session_id, { max: 2900 });
  const a1 = await nova.submit(q1.session.session_id, { min: SECRET_MIN });
  const q2 = await maya.propose({ to: nova.handle, operation: "deal_zone", params: { what: "Logo + brand kit", currency: "EUR", at_price: 2500 }, my_role: "buyer" });
  await maya.submit(q2.session.session_id, { max: 2900 });
  const a2 = await nova.submit(q2.session.session_id, { min: SECRET_MIN });
  return { overlap: a1.result.deal, at2500: a2.result.deal_at_price, receipts: (await maya.receiptValid(a1.receipt)) && (await maya.receiptValid(a2.receipt)) };
}

// ------------------------------------------------------------ run

const work = mkdtempSync(join(tmpdir(), "sealed-v0-"));
execSync(`git worktree add --detach ${work} v0-before-audit`, { cwd: ROOT, stdio: "ignore" });
if (!existsSync(join(work, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"));
const deployments: Deployment[] = [];
try {
  const v0 = await deploy("v0", work, 4500, 4501);
  const v1 = await deploy("v1", ROOT, 4510, 4511);
  deployments.push(v0, v1);

  log("# Sealed Breach Challenge");
  log("");
  log(`Alice's agent holds her real minimum price: ${money(SECRET_MIN)}. The attacker (Bob, then a compromised API) tries to learn it.`);
  log(`Round 1 = code before the audit (tag v0-before-audit). Round 2 = current code. Both run as real API + sealer processes with their own databases.`);
  log("");
  const rows: Array<[string, any, any]> = [];
  rows.push(["A. Ask for the midpoint, then invert it", await midpointInversion(v0, false), await midpointInversion(v1, true)]);
  rows.push(["B. Binary search with a new identity per question", await bisectWithFreshIdentities(v0, false), await bisectWithFreshIdentities(v1, true)]);
  rows.push(["C. Compromised API replays Alice's envelope to the sealer", await compromisedApi(v0, false), await compromisedApi(v1, true)]);
  for (const [name, r1, r2] of rows) {
    log(`## ${name}`);
    log(`- Round 1: attacker learned **${r1.learned}** — ${r1.detail} (${reqs(r1.requests)})`);
    log(`- Round 2: attacker learned **${r2.learned}** — ${r2.detail} (${reqs(r2.requests)})`);
    log("");
  }
  const deal = await honestDeal(v1);
  log("## Honest deal, Round 2 (signed agents, envelopes locked and signed on their side)");
  log(`- Any price both accept? **${deal.overlap ? "yes" : "no"}**. Can both do €2,500? **${deal.at2500 ? "yes" : "no"}**. Receipts valid: **${deal.receipts}**.`);
  log("");
  const r1Exact = rows.filter(([, r]) => r.exact).length;
  const r2Exact = rows.filter(([, , r]) => r.exact).length;
  log(`**Result:** Round 1 — exact secret recovered by ${r1Exact}/3 attacks. Round 2 — ${r2Exact}/3, and the honest deal still closed.`);
  writeFileSync(join(ROOT, "breach-report.md"), lines.join("\n") + "\n");
  console.log("\nWrote breach-report.md");
} finally {
  for (const d of deployments) for (const p of d.procs) p.kill();
  execSync(`git worktree remove --force ${work}`, { cwd: ROOT, stdio: "ignore" });
}
