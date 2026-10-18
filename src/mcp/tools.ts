// The Sealed tool set for any MCP client. Same tools locally (stdio) and
// remotely (/mcp). Tools call the public HTTP API, so an MCP agent can do
// exactly what a raw HTTP agent can, nothing more.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOMAINS, stripSignature, verifyBody } from "../core/crypto.js";
import { execFile } from "node:child_process";
import { KeyChangedError, SealedAgent, SealedError, type AgentState } from "../client/agent.js";
import { Vault, toInput } from "../vault/vault.js";

export type Api = (method: "GET" | "POST", path: string, body?: unknown, apiKey?: string | null) => Promise<{ status: number; body: any }>;

export interface Credentials {
  get(): AgentState | null;
  set(v: AgentState): void;
  /** Remote sessions can't persist keys; tell the model how to reconnect instead. */
  persistent: boolean;
  /** Local MCP: this agent has its own signing key and locks + signs secrets on this machine. */
  sealLocally?: boolean;
  /** Base URL for the local SDK (local MCP only). */
  baseUrl?: string;
  /** Local vault of the human's secrets (local MCP only). */
  vault?: Vault;
  /** Remote endpoint URL, for reconnect instructions. */
  mcpUrl?: string;
}

export const INSTRUCTIONS = `Sealed lets you talk to other people's AI agents and settle private questions without revealing your human's secrets.
- Join once with sealed_join. If you already have a Sealed API key saved (in your notes, memory or a file), call sealed_login with it instead of joining again. Find agents with sealed_find_agents. Talk with sealed_send_message; check sealed_inbox for replies.
- If your human keeps secrets in the local vault (see sealed_secrets), seal them by name with secret_name. You never need to know or ask for the value. Don't ask your human to type a limit into the chat.
- NEVER put your human's private limits in a message (their max budget, minimum price, real availability, whether they're interested). Use a sealed question instead: sealed_propose / sealed_submit. Each side submits a secret; both get only the declared answer, plus a signed receipt. The secrets are deleted.
- Before submitting, read the operation's "reveals" text and make sure your human is OK with that answer being shared.
- Two agents: deal_zone (buyer max vs seller min → yes/no: any overlap, or "can we both do at_price?"), common_slot (free windows → one time both can make), mutual_interest (yes/no each → match only if both yes).
- Groups of 3-20 (pass "with": [handles]): group_slot (everyone's free windows → one time for all), group_budget (everyone's max spend → which listed options everyone can afford), unanimous (yes/no each → "everyone's in" or "not everyone", never who).
- Answers arrive only when everyone has sealed. Use sealed_status with wait_seconds to wait for it, or check sealed_inbox later.`;

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError });

export function buildMcpServer(api: Api, creds: Credentials): McpServer {
  const server = new McpServer({ name: "sealed", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const key = () => creds.get()?.api_key ?? null;
  /** Local MCP only: an SDK agent with this machine's signing key (adds one to older profiles). */
  const localAgent = async () => {
    let st = creds.get()!;
    const persist = (x: AgentState) => creds.set(x);
    let agent = new SealedAgent(creds.baseUrl!, st, persist);
    if (!agent.signer) {
      st = await agent.enableSigning();
      creds.set(st);
      agent = new SealedAgent(creds.baseUrl!, st, persist);
    }
    return agent;
  };

  /** Ask the human outside the conversation: the MCP client's own prompt if it has one, else a macOS dialog. */
  const askHuman = async (message: string): Promise<boolean> => {
    if (server.server.getClientCapabilities()?.elicitation) {
      const r = await server.server.elicitInput({
        message,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Allow" } }, required: ["approve"] },
      } as any);
      return r.action === "accept" && (r.content as any)?.approve === true;
    }
    if (process.platform === "darwin") {
      const script = `display dialog ${JSON.stringify(message)} with title "Sealed" buttons {"Don't allow", "Allow"} default button "Don't allow" giving up after 120`;
      return new Promise((res) => execFile("osascript", ["-e", script], (err, out) => res(!err && String(out).includes("button returned:Allow"))));
    }
    throw new Error("This secret is set to ask your human first, and there's no way to ask from here.");
  };

  /** Read a vault secret for one question, after the human's rules (and approval, if required). Never returned to the model. */
  const vaultInput = async (name: string, operation: string, role: string, counterpart: string) => {
    if (!creds.vault) throw new Error("The secret vault only works with the local Sealed MCP server.");
    const s = creds.vault.check(name, operation, role);
    if (s.ask_first) {
      const ok = await askHuman(`Your agent wants to use "${name}"${s.note ? ` (${s.note})` : ""} to answer a sealed "${operation}" question with ${counterpart}. Only the answer comes out, never the value. Allow?`);
      if (!ok) throw new Error(`Your human didn't allow using "${name}" this time.`);
    }
    return toInput(operation, role, s.value);
  };
  const sdk = async (fn: () => Promise<unknown>) => {
    try {
      return text(await fn());
    } catch (e) {
      if (e instanceof KeyChangedError) return text({ error: "key_changed", message: e.message, what_to_do: "Don't continue. Tell your human and compare fingerprints with the other side directly." }, true);
      return text(e instanceof SealedError ? e.body : { error: (e as Error).message }, true);
    }
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
      if (creds.sealLocally) {
        return sdk(async () => {
          const a = await SealedAgent.join(creds.baseUrl!, args);
          creds.set(a.state);
          return { joined: true, handle: a.handle, signing: "This agent has its own signing key on this machine. Secrets are locked and signed here before they're sent." };
        });
      }
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
                (creds.mcpUrl ? `To connect already signed in, send an 'Authorization: Bearer <api_key>' header to ${creds.mcpUrl}. ` : "") +
                "Note: through this remote connection, your secrets are sent to Sealed over HTTPS and locked there (the 'trusts Sealed' tier). For secrets locked and signed on your own machine, use the local Sealed MCP server.",
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

  server.registerTool("sealed_whoami", { title: "Who am I on Sealed", description: "Your handle, unread count, and (local MCP) your key fingerprint.", inputSchema: {} }, async () => {
    const r = await call("GET", "/v1/me");
    if (!creds.sealLocally || r.isError) return r;
    const a = await localAgent();
    return text({ ...JSON.parse(r.content[0]!.text), fingerprint: a.fingerprint, tell_others: "Others can compare this fingerprint with what their agent shows for you." });
  });

  server.registerTool(
    "sealed_secrets",
    { title: "Your human's secrets", description: "Names and rules of the secrets your human keeps in the local vault. Values are never shown; seal them with secret_name.", inputSchema: {} },
    async () => (creds.vault ? text({ secrets: creds.vault.describe() }) : text("No local vault here. The vault only works with the local Sealed MCP server.", true)),
  );

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
        to: z.string().optional().describe("Two-agent questions: the other agent's handle"),
        with: z.array(z.string()).optional().describe("Group questions: handles of everyone else (2-19 others)"),
        thread_id: z.string().optional(),
        operation: z.enum(["deal_zone", "common_slot", "mutual_interest", "group_slot", "group_budget", "unanimous"]),
        params: z
          .record(z.any())
          .describe(
            "Public terms. deal_zone: {what, currency, at_price?}; common_slot / group_slot: {duration_minutes, not_before?, not_after?}; mutual_interest / unanimous: {about}; group_budget: {what, currency, options:[{id,label,price}]}",
          ),
        my_role: z.string().optional().describe("deal_zone: buyer|seller. common_slot, mutual_interest: a|b. Group questions: omit"),
        deadline_minutes: z.number().optional().describe("How long others have to seal (default 24h)"),
        secret_name: z.string().optional().describe("Local MCP: seal a secret from your human's vault by name (see sealed_secrets). Preferred over my_private_input."),
        my_private_input: z
          .record(z.any())
          .optional()
          .describe("deal_zone buyer {max}, seller {min}; common_slot / group_slot {available:[{start,end}]}; mutual_interest {interested}; group_budget {max}; unanimous {yes}"),
      },
    },
    async ({ my_private_input, secret_name, ...rest }) => {
      if (creds.sealLocally && key()) {
        return sdk(async () => {
          const a = await localAgent();
          const role = rest.my_role ?? "member";
          const counterpart = rest.to ? `@${rest.to}` : (rest.with ?? []).map((h) => `@${h}`).join(", ");
          const input = secret_name ? await vaultInput(secret_name, rest.operation, role, counterpart) : my_private_input;
          const created = await a.proposeChecked(rest);
          if (!input) return created;
          const r = await a.submit(created.session.session_id, input, { operation: rest.operation, params: rest.params });
          if (secret_name) creds.vault!.recordUse(secret_name);
          return { ...r, fingerprints: created.fingerprints, ...(secret_name ? { sealed_from_vault: secret_name } : {}) };
        });
      }
      if (secret_name) return text("The secret vault only works with the local Sealed MCP server.", true);
      return call("POST", "/v1/sealed", { ...rest, ...(my_private_input ? { my_input: my_private_input } : {}) });
    },
  );

  server.registerTool(
    "sealed_submit",
    {
      title: "Answer a sealed question",
      description: "Answer a sealed question another agent asked you, with a vault secret (secret_name) or a private input.",
      inputSchema: {
        session_id: z.string(),
        secret_name: z.string().optional().describe("Local MCP: a secret from your human's vault (see sealed_secrets)"),
        private_input: z.record(z.any()).optional(),
      },
    },
    async ({ session_id, private_input, secret_name }) => {
      if (!secret_name && !private_input) return text("Give secret_name or private_input.", true);
      if (creds.sealLocally && key()) {
        return sdk(async () => {
          const a = await localAgent();
          let input: unknown = private_input;
          if (secret_name) {
            const view = await a.status(session_id);
            const others = (view.parties ?? []).filter((p: any) => !p.you).map((p: any) => `@${p.handle}`).join(", ");
            input = await vaultInput(secret_name, view.operation, view.your_role, others);
          }
          const r = await a.submit(session_id, input);
          if (secret_name) creds.vault!.recordUse(secret_name);
          return { ...r, ...(secret_name ? { sealed_from_vault: secret_name } : {}) };
        });
      }
      if (secret_name) return text("The secret vault only works with the local Sealed MCP server.", true);
      return call("POST", `/v1/sealed/${encodeURIComponent(session_id)}/submit`, { input: private_input });
    },
  );

  server.registerTool(
    "sealed_status",
    {
      title: "Sealed question status",
      description: "Status, result and signed receipt (verified) for a sealed question. Set wait_seconds (up to 30) to wait for the answer instead of checking repeatedly.",
      inputSchema: { session_id: z.string(), wait_seconds: z.number().min(0).max(30).optional() },
    },
    async ({ session_id, wait_seconds }) => {
      if (!key()) return text("Call sealed_join first.", true);
      const r = await api("GET", `/v1/sealed/${encodeURIComponent(session_id)}${wait_seconds ? `?wait=${Math.round(wait_seconds)}` : ""}`, undefined, key());
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
