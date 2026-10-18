// Local MCP server (Claude Desktop, Claude Code, Cursor…). Talks to a Sealed
// server over HTTP and keeps this agent's key in ~/.sealed/<profile>.json.
//   SEALED_URL=https://… SEALED_PROFILE=maya npx tsx src/mcp/stdio.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, type Api } from "./tools.js";

const base = (process.env.SEALED_URL ?? "http://127.0.0.1:4300").replace(/\/$/, "");
const file = join(process.env.SEALED_HOME ?? join(homedir(), ".sealed"), `${process.env.SEALED_PROFILE ?? "default"}.json`);

const api: Api = async (method, path, body, apiKey) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({ error: "bad_response" })) };
};

const server = buildMcpServer(api, {
  persistent: true,
  sealLocally: true,
  get: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null),
  set: (v) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 });
  },
});
await server.connect(new StdioServerTransport());
