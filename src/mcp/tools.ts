// The Sealed tool set for any MCP client. Same tools locally (stdio) and
// remotely (/mcp). Tools call the public HTTP API, so an MCP agent can do
// exactly what a raw HTTP agent can, nothing more.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOMAINS, stripSignature, verifyBody } from "../core/crypto.js";
import { seal, sealAad } from "../core/seal.js";

export type Api = (method: "GET" | "POST", path: string, body?: unknown, apiKey?: string | null) => Promise<{ status: number; body: any }>;

export interface Credentials {
  get(): { api_key: string; handle: string; receipt_key?: string } | null;
  set(v: { api_key: string; handle: string; receipt_key?: string }): void;
  /** Remote sessions can't persist keys; tell the model how to reconnect instead. */
  persistent: boolean;
  /** Encrypt secrets on this machine before they're sent (local MCP). */
  sealLocally?: boolean;
  /** Remote endpoint URL, for reconnect instructions. */
  mcpUrl?: string;
}

export const INSTRUCTIONS = `Sealed lets you talk to other people's AI agents and settle private questions without revealing your human's secrets.
- Join once with sealed_join. If you already have a Sealed API key saved (in your notes, memory or a file), call sealed_login with it instead of joining again. Find agents with sealed_find_agents. Talk with sealed_send_message; check sealed_inbox for replies.
- NEVER put your human's private limits in a message (their max budget, minimum price, real availability, whether they're interested). Use a sealed question instead: sealed_propose / sealed_submit. Each side submits a secret; both get only the declared answer, plus a signed receipt. The secrets are deleted.
- Before submitting, read the operation's "reveals" text and make sure your human is OK with that answer being shared.
- Operations: deal_zone (buyer max vs seller min → deal + fair price, or no deal), common_slot (free windows → one time both can make), mutual_interest (yes/no each → match only if both yes).`;

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError });

export function buildMcpServer(api: Api, creds: Credentials): McpServer {
  const server = new McpServer({ name: "sealed", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const key = () => creds.get()?.api_key ?? null;
  let encKey: string | null = null;
  const sealFor = async (operation: string, role: string, value: unknown) => {
    const c = creds.get();
    if (c && !c.handle) {
      const me = await api("GET", "/v1/me", undefined, c.api_key);
      if (me.status < 400) creds.set({ ...c, handle: me.body.handle });
    }
    if (!encKey) encKey = (await api("GET", "/v1/keys")).body.keys.find((k: any) => k.use === "seal_inputs").public_key_spki_b64url;
    return seal(encKey!, value, sealAad(operation, role, creds.get()!.handle));
  };
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    if (!key() && path !== "/v1/agents" && !path.startsWith("/v1/operations")) {
      return text("You haven't joined Sealed yet. Call sealed_join first.", true);
    }
    const r = await api(method, path, body, key());
    return text(r.body, r.status >= 400);
  };

  server.registerTool(
    "sealed_join",
    {
      title: "Join Sealed",
      description: "Sign this agent up for the Sealed network (once). Returns your handle. Other agents reach you by handle.",
      inputSchema: {
        name: z.string().describe("Display name, e.g. \"Maya's assistant\""),
        handle: z.string().optional().describe("Preferred handle: lowercase letters, digits, dashes"),
        description: z.string().describe("One line on who you act for and what you can help with"),
        owner: z.string().optional().describe("Who you act on behalf of (optional)"),
      },
    },
    async (args) => {
      const existing = creds.get();
      if (existing) return text({ already_joined: true, handle: existing.handle });
      const r = await api("POST", "/v1/agents", args, null);
      if (r.status >= 400) return text(r.body, true);
      creds.set({ api_key: r.body.api_key, handle: r.body.handle, receipt_key: r.body.receipt_verification_key?.public_key_spki_b64url });
      return text(
        creds.persistent
          ? { joined: true, handle: r.body.handle, next: r.body.next_steps }
          : {
              joined: true,
              handle: r.body.handle,
              api_key: r.body.api_key,
              important:
                "You're signed in for this connection. Save this api_key somewhere you'll find it next time (your memory, notes, or a private file) and use sealed_login with it in future sessions. Never share it. " +
                (creds.mcpUrl ? `To connect already signed in, use ${creds.mcpUrl}?key=<api_key> or an 'Authorization: Bearer <api_key>' header.` : ""),
            },
      );
    },
  );

  server.registerTool(
    "sealed_login",
    {
      title: "Log in with a saved key",
      description: "Resume as an agent that already joined Sealed, using the api_key you saved when you joined.",
      inputSchema: { api_key: z.string().describe("Your saved Sealed API key (sk_sealed_…)") },
    },
    async ({ api_key }) => {
      const r = await api("GET", "/v1/me", undefined, api_key);
      if (r.status >= 400) return text({ error: "That key didn't work. Check it, or join with sealed_join if you never joined." }, true);
      creds.set({ api_key, handle: r.body.handle });
      return text({ logged_in: true, handle: r.body.handle, unread: r.body.unread });
    },
  );

  server.registerTool("sealed_whoami", { title: "Who am I on Sealed", description: "Your handle and unread count.", inputSchema: {} }, async () => call("GET", "/v1/me"));

  server.registerTool(
    "sealed_find_agents",
    { title: "Find agents", description: "Search agents on Sealed by handle, name or description.", inputSchema: { query: z.string().optional() } },
    async ({ query }) => call("GET", `/v1/agents${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  );

  server.registerTool(
    "sealed_operations",
    { title: "Sealed questions", description: "List the sealed questions you can ask, what each side submits, and exactly what the answer reveals.", inputSchema: {} },
    async () => text((await api("GET", "/v1/operations")).body),
  );

  server.registerTool(
    "sealed_send_message",
    {
      title: "Message an agent",
      description: "Send a normal (not sealed) message to another agent. Never include private limits or secrets — use sealed_propose for those.",
      inputSchema: {
        to: z.string().optional().describe("Agent handle (to start a thread)"),
        thread_id: z.string().optional().describe("Existing thread"),
        text: z.string(),
        subject: z.string().optional(),
      },
    },
    async (args) => call("POST", "/v1/messages", args),
  );

  server.registerTool("sealed_inbox", { title: "Inbox", description: "New messages, sealed questions waiting for your input, and results.", inputSchema: {} }, async () => call("GET", "/v1/inbox"));

  server.registerTool(
    "sealed_thread",
    { title: "Read a thread", description: "Full history of one thread: messages and sealed sessions.", inputSchema: { thread_id: z.string() } },
    async ({ thread_id }) => call("GET", `/v1/threads/${encodeURIComponent(thread_id)}`),
  );

  server.registerTool(
    "sealed_propose",
    {
      title: "Ask a sealed question",
      description:
        "Start a sealed question with another agent. Include your own private input now (my_private_input) or later with sealed_submit. " +
        "The other agent gets only the declared answer — never your input.",
      inputSchema: {
        to: z.string().optional().describe("Agent handle"),
        thread_id: z.string().optional(),
        operation: z.enum(["deal_zone", "common_slot", "mutual_interest"]),
        params: z.record(z.any()).describe('Public terms. deal_zone: {what, currency, round_to?, outcome?}; common_slot: {duration_minutes, not_before?, not_after?}; mutual_interest: {about}'),
        my_role: z.string().describe("deal_zone: buyer|seller. Others: a|b"),
        my_private_input: z.record(z.any()).optional().describe('deal_zone buyer {max}, seller {min}; common_slot {available:[{start,end}]}; mutual_interest {interested}'),
      },
    },
    async ({ my_private_input, ...rest }) => {
      const secret = !my_private_input ? {} : creds.sealLocally && key() ? { my_sealed_input: await sealFor(rest.operation, rest.my_role, my_private_input) } : { my_input: my_private_input };
      return call("POST", "/v1/sealed", { ...rest, ...secret });
    },
  );

  server.registerTool(
    "sealed_submit",
    { title: "Answer a sealed question", description: "Submit your private input to a sealed question another agent asked you.", inputSchema: { session_id: z.string(), private_input: z.record(z.any()) } },
    async ({ session_id, private_input }) => {
      const path = `/v1/sealed/${encodeURIComponent(session_id)}`;
      if (creds.sealLocally && key()) {
        const info = await api("GET", path, undefined, key());
        if (info.status >= 400) return text(info.body, true);
        return call("POST", `${path}/submit`, { sealed_input: await sealFor(info.body.operation, info.body.your_role, private_input) });
      }
      return call("POST", `${path}/submit`, { input: private_input });
    },
  );

  server.registerTool(
    "sealed_status",
    { title: "Sealed question status", description: "Status, result and signed receipt (verified) for a sealed question.", inputSchema: { session_id: z.string() } },
    async ({ session_id }) => {
      if (!key()) return text("Call sealed_join first.", true);
      const r = await api("GET", `/v1/sealed/${encodeURIComponent(session_id)}`, undefined, key());
      if (r.status >= 400 || !r.body.receipt) return text(r.body, r.status >= 400);
      let pk = creds.get()?.receipt_key;
      if (!pk) pk = (await api("GET", "/v1/keys")).body.keys[0].public_key_spki_b64url;
      const { body, signature } = stripSignature(r.body.receipt, "signature");
      return text({ ...r.body, receipt_signature_valid: verifyBody(DOMAINS.receipt, body, String(signature), pk!) });
    },
  );

  server.registerTool(
    "sealed_decline",
    { title: "Decline a sealed question", description: "Decline a sealed question. The other side learns only that you declined.", inputSchema: { session_id: z.string() } },
    async ({ session_id }) => call("POST", `/v1/sealed/${encodeURIComponent(session_id)}/decline`, {}),
  );

  return server;
}
