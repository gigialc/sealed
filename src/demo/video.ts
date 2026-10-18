// Everything for the 2-minute video, in one command:
//   npm run video
// Makes a fresh demo vault (Maya's max: €2,900), starts Nova's agent (min: €2,150),
// and prints the one command + prompt to paste into a second terminal.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Vault } from "../vault/vault.js";

const ROOT = resolve(import.meta.dirname, "../..");
const URL = process.env.SEALED_URL ?? "https://sealed-production-1ec9.up.railway.app";
const DIR = join(homedir(), "sealed-video");
const tag = Math.random().toString(36).slice(2, 5);
const nova = `nova-studio-${tag}`;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "home"), { recursive: true });
new Vault(join(DIR, "home", "vault.json")).set("logo-max", {
  value: 2900, allow: ["deal_zone"], role: "buyer", uses_left: 3, ask_first: false, note: "Maya's max for the logo",
});
// Maya's agent: the mcp-use server, on this laptop, shared by every client.
writeFileSync(join(DIR, "mcp.json"), JSON.stringify({ mcpServers: { sealed: { type: "http", url: "http://localhost:3000/mcp" } } }, null, 2));
spawn(join(ROOT, "mcp-use/node_modules/.bin/tsx"), [join(ROOT, "mcp-use/start.ts")], {
  cwd: join(ROOT, "mcp-use"),
  env: { ...process.env, SEALED_URL: URL, SEALED_HOME: join(DIR, "home"), SEALED_PROFILE: `maya-${tag}`, PORT: "3000" },
  stdio: "ignore",
});

console.log(`
──────────────── 2-minute video setup ────────────────
Maya's vault has "logo-max" (€2,900). Claude will never be told the number.
Email goes through Primitive: every agent has its own address.
Nova's agent (this terminal) has a sealed minimum of €2,150.

Maya's Sealed MCP server (mcp-use) is running at http://localhost:3000/mcp.

Client 1, Claude Code. In a SECOND terminal:
  cd ~/sealed-video && claude --mcp-config mcp.json --strict-mcp-config --allowedTools "mcp__sealed__*"

Client 2, Cursor. Settings → MCP → add:  { "sealed": { "url": "http://localhost:3000/mcp" } }
  then in Cursor's chat ask: "Use Sealed: who am I, and what's in my vault?" (it's the same agent)

Then paste:

  You're Maya's assistant. She needs a logo and brand kit in 2 weeks. Join Sealed, then email @${nova} (find their address with sealed_find_agents) to introduce the project and wait for their reply in your inbox. Then ask them sealed, using Maya's secret logo-max: is there a deal, and can we both do €2,500?

Afterwards, to prove it: grep -c 2900 ~/.claude/projects/*sealed-video*/*.jsonl   (prints 0)
──────────────────────────────────────────────────────
`);
spawn(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "src/demo/responder.ts")], {
  cwd: ROOT,
  env: { ...process.env, SEALED_URL: URL, STUDIO_MIN: "2150", STUDIO_HANDLE: nova, RUN_MINUTES: "30" },
  stdio: "inherit",
});
