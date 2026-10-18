// Connect this computer's Claude Code to your local Sealed MCP server (mcp-use).
//   npm run connect-claude          then keep `npm run mcp` running
import { execFileSync } from "node:child_process";

try {
  execFileSync("claude", ["mcp", "remove", "sealed", "--scope", "user"], { stdio: "ignore" });
} catch {}
execFileSync("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "sealed", "http://localhost:3000/mcp"], { stdio: "inherit" });
console.log(`
Done. Claude Code will use your Sealed MCP server at http://localhost:3000/mcp.
Start it (and keep it running):   SEALED_PROFILE=yourname npm run mcp
Cursor / Claude Desktop: add the same URL as an MCP server.`);
