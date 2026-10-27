// Sealer service. Runs separately behind a shared token and holds the
// only copy of the opening key. Use a private network or HTTPS. Logs no request bodies. Kept small on purpose
// so it can be read in one sitting and moved into a hardware enclave as is.
import { createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Ledger, LocalSealer } from "./sealer.js";
import { PostgresLedger } from "./postgres-ledger.js";

const keyB64 = process.env.SEALED_ENCRYPTION_KEY;
const token = process.env.SEALER_TOKEN ?? "";
if (!keyB64 || token.length < 24) throw new Error("Set SEALED_ENCRYPTION_KEY and SEALER_TOKEN (24+ chars).");
const privateKey = createPrivateKey({ key: Buffer.from(keyB64, "base64url"), format: "der", type: "pkcs8" });
// The ledger uses its own database credentials or volume, out of the API's reach.
const stateDir = process.env.SEALER_STATE_DIR ?? ".sealer-state";
const databaseUrl = process.env.SEALER_DATABASE_URL;
if (process.env.RENDER && !databaseUrl && !process.env.SEALER_STATE_DIR) {
  throw new Error("Render requires SEALER_DATABASE_URL or SEALER_STATE_DIR on a persistent disk.");
}
const databaseLedger = databaseUrl ? new PostgresLedger(databaseUrl) : undefined;
if (databaseLedger) await databaseLedger.init();
const sealer = new LocalSealer(
  { privateKey, publicKey: createPublicKey(privateKey) },
  { ledger: databaseLedger ?? new Ledger(stateDir), dailyLimitPerKey: Number(process.env.SEALER_DAILY_LIMIT ?? 5) },
);

const authorized = (req: IncomingMessage) => {
  const got = Buffer.from(String(req.headers["x-sealer-token"] ?? ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("too_large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1") return send(res, 200, { ok: true, service: "sealer" }); // health check
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/public-key") return send(res, 200, { public_key_spki_b64url: await sealer.publicKey() });
    if (req.method === "POST" && req.url === "/check") {
      const b = await readJson(req);
      const r = await sealer.check(b.statement, b.envelope ?? {});
      return send(res, r.ok ? 200 : 422, r);
    }
    if (req.method === "POST" && req.url === "/compute") {
      const b = await readJson(req);
      const r = await sealer.compute(b.statement, Array.isArray(b.envelopes) ? b.envelopes : []);
      return send(res, r.ok ? 200 : 422, r);
    }
    return send(res, 404, { error: "not_found" });
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
});

const port = Number(process.env.PORT ?? 4301);
// "::" accepts IPv4 and IPv6 (Railway's private network uses IPv6).
server.listen(port, process.env.HOST ?? "::", () => console.log(`[sealer] listening on ${port} · ledger in ${databaseLedger ? "Postgres" : stateDir}`));

process.once("SIGTERM", () => {
  server.close(() => { void Promise.resolve(databaseLedger?.close()).finally(() => process.exit(0)); });
});
