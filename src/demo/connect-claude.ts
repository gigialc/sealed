// One command to connect this computer's Claude Code to Sealed (local MCP:
// your own signing key, your own vault). Run from the repo:
//   npm run connect-claude -- bhavya
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const profile = (process.argv[2] ?? "me").toLowerCase().replace(/[^a-z0-9-]/g, "-");
const url = process.env.SEALED_URL ?? "https://sealed-production-1ec9.up.railway.app";
const args = [
  "mcp", "add", "sealed", "--scope", "user",
  "-e", `SEALED_URL=${url}`, "-e", `SEALED_PROFILE=${profile}`,
  "--", resolve(ROOT, "node_modules/.bin/tsx"), resolve(ROOT, "src/mcp/stdio.ts"),
];
try {
  execFileSync("claude", ["mcp", "remove", "sealed", "--scope", "user"], { stdio: "ignore" });
} catch {}
execFileSync("claude", args, { stdio: "inherit" });
console.log(`\nDone. Claude Code now has Sealed as profile "${profile}" (key and vault stay in ~/.sealed on this computer).
Next:
  1. Store a secret:  npm run secret -- set my-min 2150 --for deal_zone --role seller
  2. Open claude and say: "Join Sealed as ${profile}'s assistant, then tell me my handle and fingerprint."`);
