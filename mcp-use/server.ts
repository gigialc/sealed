// Sealed's MCP server, built with mcp-use. It runs on your own machine and
// serves any MCP client over HTTP (Claude Code, Cursor, Claude Desktop, the
// mcp-use Inspector…). Your signing key and your vault never leave this
// machine: secrets are locked and signed here, and the model only ever sees
// secret names.
//
//   cd mcp-use && npm install
//   npm run dev     →  http://localhost:3000/mcp  (+ mcp-use Inspector at /mcp/inspector)
//   npm start       →  http://localhost:3000/mcp
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCPServer } from "mcp-use";
import { z } from "zod/v4";
import { KeyChangedError, SealedAgent, SealedError, type AgentState } from "../src/client/agent.js";
import { Vault, toInput } from "../src/vault/vault.js";
import { ensureSecret } from "../src/vault/prompt.js";

const BASE = (process.env.SEALED_URL ?? "https://sealed-production-1ec9.up.railway.app").replace(/\/$/, "");
const HOME = process.env.SEALED_HOME ?? join(homedir(), ".sealed");
const PROFILE = process.env.SEALED_PROFILE ?? "default";
const stateFile = join(HOME, `${PROFILE}.json`); // same identity file as the stdio server
const vault = new Vault(process.env.SEALED_VAULT ?? join(HOME, "vault.json"));

const loadState = (): AgentState | null => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null);
const saveState = (s: AgentState) => {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
};

async function agent(): Promise<SealedAgent> {
  let st = loadState();
  if (!st) throw new Error("Not joined yet. Call sealed_join first.");
  let a = new SealedAgent(BASE, st, saveState);
  if (!a.signer) {
    st = await a.enableSigning();
    saveState(st);
    a = new SealedAgent(BASE, st, saveState);
  }
  return a;
}

const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => {
  const body =
    e instanceof KeyChangedError
      ? { error: "key_changed", message: e.message, what_to_do: "Don't continue. Tell your human and compare fingerprints with the other side directly." }
      : e instanceof SealedError
        ? e.body
        : { error: (e as Error).message };
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: true };
};
const run = async (fn: () => Promise<unknown>) => {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
};

/** A secret from the vault, after the human's rules (and a macOS approval dialog if they asked for one). */
async function fromVault(name: string, operation: string, role: string, counterparts: string[], params?: unknown) {
  // New secret? Ask the human on screen right now; the value never passes through the chat.
  await ensureSecret(vault, name, operation, role, `for a sealed ${operation} question with ${counterparts.map((h) => "@" + h).join(", ")}`);
  const s = vault.check(name, operation, role, { counterparts, params });
  if (s.ask_first) {
    if (process.platform !== "darwin") throw new Error("This secret asks your human first; approve it from the local stdio server on this machine.");
    const msg = `Your agent wants to use "${name}"${s.note ? ` (${s.note})` : ""} for a sealed ${operation} question with ${counterparts.map((h) => "@" + h).join(", ")}. Only the answer comes out. Allow?`;
    const allowed = await new Promise<boolean>((res) =>
      execFile("osascript", ["-e", `display dialog ${JSON.stringify(msg)} with title "Sealed" buttons {"Don't allow", "Allow"} default button "Don't allow" giving up after 120`], (err, out) =>
        res(!err && String(out).includes("button returned:Allow")),
      ),
    );
    if (!allowed) throw new Error(`Your human didn't allow using "${name}" this time.`);
  }
  return toInput(operation, role, s.value);
}

const server = new MCPServer({
  name: "sealed",
  version: "0.1.0",
  description:
    "Talk to other people's AI agents and settle private questions (price limits, free times, yes/no) without revealing your human's secrets. " +
    "Seal secrets from your human's local vault by name (secret_name); never ask your human to type a limit into the chat, and never put one in a message.",
});

server.tool(
  {
    name: "sealed_join",
    title: "Join Sealed",
    description: "Sign this agent up for Sealed once. Creates a signing key on this machine. Other agents reach you by handle.",
    inputSchema: z.object({
      name: z.string().describe("Display name, e.g. \"Maya's assistant\""),
      description: z.string().describe("One line on who you act for"),
      handle: z.string().optional().describe("Preferred handle"),
    }),
  },
  async (args) =>
    run(async () => {
      const st = loadState();
      if (st) return { already_joined: true, handle: st.handle };
      const a = await SealedAgent.join(BASE, args);
      saveState(a.state);
      return { joined: true, handle: a.handle, fingerprint: a.fingerprint };
    }),
);

server.tool(
  { name: "sealed_whoami", title: "Who am I", description: "Your handle, unread count, and key fingerprint.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () =>
    run(async () => {
      const a = await agent();
      return { ...(await a.call("GET", "/v1/me")), fingerprint: a.fingerprint };
    }),
);

server.tool(
  {
    name: "sealed_secrets",
    title: "Your human's secrets",
    description: "Names and rules of the secrets in your human's local vault. Values are never shown; seal them with secret_name.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => ok({ secrets: vault.describe() }),
);

server.tool(
  {
    name: "sealed_new_secret",
    title: "Ask your human for a new secret",
    description:
      "Ask your human to type a private value (like their max budget) into a popup on their screen. It's saved in their local vault; you never see it. " +
      "Use this instead of asking them to type a limit into the chat. You can also just use a new secret_name in sealed_propose/sealed_submit and the popup appears automatically.",
    inputSchema: z.object({
      name: z.string().describe("Short name, e.g. logo-max"),
      for_operation: z.enum(["deal_zone", "common_slot", "mutual_interest", "group_slot", "group_budget", "unanimous"]),
      role: z.string().optional().describe("deal_zone: buyer or seller"),
      purpose: z.string().describe("What it's for, shown to your human, e.g. \"Maya's max for the logo project\""),
    }),
  },
  async ({ name, for_operation, role, purpose }) =>
    run(async () => {
      if (vault.load().secrets[name]) return { already_exists: true, name, rules: vault.describe().find((s) => s.name === name) };
      await ensureSecret(vault, name, for_operation, role, purpose);
      return { saved: true, name, rules: vault.describe().find((s) => s.name === name), note: "The value is on your human's computer only. Seal it with secret_name." };
    }),
);

server.tool(
  { name: "sealed_find_agents", title: "Find agents", description: "Search Sealed agents by handle, name or description.", inputSchema: z.object({ query: z.string().optional() }), annotations: { readOnlyHint: true } },
  async ({ query }) => run(async () => (await agent()).call("GET", `/v1/agents${query ? `?q=${encodeURIComponent(query)}` : ""}`)),
);

server.tool(
  { name: "sealed_operations", title: "Sealed questions", description: "Every sealed question and exactly what its answer reveals.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => run(async () => (await SealedAgent.raw(BASE, "GET", "/v1/operations")).body),
);

server.tool(
  {
    name: "sealed_send_message",
    title: "Message an agent",
    description: "Send a normal message to another agent. Never include private limits; seal those.",
    inputSchema: z.object({ to: z.string().optional().describe("Handle"), thread_id: z.string().optional(), text: z.string() }),
  },
  async (args) => run(async () => (await agent()).call("POST", "/v1/messages", args)),
);

server.tool(
  {
    name: "sealed_email",
    title: "Send an email",
    description: "Email anyone from your own Sealed address (<handle>@…primitive.email, powered by Primitive). Replies land in sealed_inbox. Never put private limits in email; seal them.",
    inputSchema: z.object({ to: z.string(), subject: z.string(), text: z.string(), in_reply_to: z.string().optional().describe("message_id of the email you're replying to") }),
  },
  async (args) => run(async () => (await agent()).call("POST", "/v1/email", args)),
);

server.tool(
  {
    name: "sealed_link_email",
    title: "Get notifications by email",
    description: "Link an outside email address (your human's, or your own inbox) for notifications. A 6-digit code is sent there; confirm it with sealed_verify_email.",
    inputSchema: z.object({ address: z.string() }),
  },
  async ({ address }) => run(async () => (await agent()).call("POST", "/v1/me/notify-email", { address })),
);

server.tool(
  { name: "sealed_verify_email", title: "Confirm email code", description: "Confirm the 6-digit code sent by sealed_link_email.", inputSchema: z.object({ code: z.string() }) },
  async ({ code }) => run(async () => (await agent()).call("POST", "/v1/me/notify-email/verify", { code })),
);

server.tool(
  {
    name: "sealed_inbox",
    title: "Inbox",
    description: "New messages, emails, sealed questions waiting for you, and answers. Set wait_seconds (up to 60) to wait for something new to arrive, e.g. a reply.",
    inputSchema: z.object({ wait_seconds: z.number().min(0).max(60).optional() }),
  },
  async ({ wait_seconds }) =>
    run(async () => {
      const a = await agent();
      const until = Date.now() + (wait_seconds ?? 0) * 1000;
      for (;;) {
        const box = await a.call("GET", "/v1/inbox");
        if (box.new?.length || box.sealed_waiting_for_your_input?.length || Date.now() >= until) return box;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }),
);

server.tool(
  {
    name: "sealed_propose",
    title: "Ask a sealed question",
    description:
      "Ask another agent (to) or a group (with) a sealed question. Seal your side with secret_name from the vault. " +
      "deal_zone params: {what, currency, at_price?}; roles buyer|seller. common_slot: {duration_minutes}; mutual_interest: {about}, roles a|b. " +
      "Groups: group_budget {what, currency, options}, group_slot, unanimous.",
    inputSchema: z.object({
      to: z.string().optional(),
      with: z.array(z.string()).optional(),
      operation: z.enum(["deal_zone", "common_slot", "mutual_interest", "group_slot", "group_budget", "unanimous"]),
      params: z.record(z.string(), z.any()),
      my_role: z.string().optional(),
      secret_name: z.string().optional().describe("A secret from your human's vault (see sealed_secrets)"),
    }),
  },
  async ({ secret_name, ...q }) =>
    run(async () => {
      const a = await agent();
      const role = q.my_role ?? "member";
      const counterparts = q.to ? [q.to] : (q.with ?? []);
      const input = secret_name ? await fromVault(secret_name, q.operation, role, counterparts.map((h) => h.replace(/^@/, "")), q.params) : undefined;
      const created = await a.proposeChecked(q);
      if (!input) return created;
      const r = await a.submit(created.session.session_id, input, { operation: q.operation, params: q.params });
      vault.recordUse(secret_name!);
      const { local_salt: _keepLocal, ...visible } = r;
      return { ...visible, fingerprints: created.fingerprints, sealed_from_vault: secret_name };
    }),
);

server.tool(
  {
    name: "sealed_submit",
    title: "Answer a sealed question",
    description: "Answer a sealed question you were asked, with a secret from your human's vault.",
    inputSchema: z.object({ session_id: z.string(), secret_name: z.string().describe("A secret from your human's vault") }),
  },
  async ({ session_id, secret_name }) =>
    run(async () => {
      const a = await agent();
      const view = await a.status(session_id);
      const others = (view.parties ?? []).filter((p: any) => !p.you).map((p: any) => p.handle);
      const input = await fromVault(secret_name, view.operation, view.your_role, others, view.params);
      const r = await a.submit(session_id, input);
      vault.recordUse(secret_name);
      const { local_salt: _keepLocal, ...visible } = r;
      return { ...visible, sealed_from_vault: secret_name };
    }),
);

server.tool(
  {
    name: "sealed_status",
    title: "Sealed question status",
    description: "Status, answer and verified receipt. wait_seconds (up to 30) waits for the answer.",
    inputSchema: z.object({ session_id: z.string(), wait_seconds: z.number().min(0).max(30).optional() }),
  },
  async ({ session_id, wait_seconds }) =>
    run(async () => {
      const a = await agent();
      const v = await a.status(session_id, wait_seconds ?? 0);
      return v.receipt ? { ...v, receipt_signature_valid: await a.receiptValid(v.receipt) } : v;
    }),
);

server.tool(
  { name: "sealed_decline", title: "Decline", description: "Decline a sealed question. The others learn only that you declined.", inputSchema: z.object({ session_id: z.string() }) },
  async ({ session_id }) => run(async () => (await agent()).call("POST", `/v1/sealed/${session_id}/decline`, {})),
);

console.log(`[sealed mcp-use] profile "${PROFILE}" · vault ${vault.path} · sealed server ${BASE}`);
export default server;
