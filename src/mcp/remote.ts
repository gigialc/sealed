// Remote MCP over Streamable HTTP at /mcp, with sessions: an agent that joins
// (or logs in with a saved key) stays signed in for the whole connection.
// A key can also be supplied up front via an 'Authorization: Bearer …' header.
// Tools run against this same app in-process.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, type Api } from "./tools.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  creds: { api_key: string; handle: string } | null;
  lastSeen: number;
}

const IDLE_MS = 24 * 3600_000;

export async function mountRemoteMcp(app: FastifyInstance, publicUrl: string) {
  const sessions = new Map<string, Session>();
  const sweep = setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.lastSeen > IDLE_MS) {
      s.transport.close();
      sessions.delete(id);
    }
  }, 600_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  const keyFrom = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    // Header only: keys in URLs end up in logs and browser history.
    return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
  };

  const api: (ip: string) => Api = (ip) => async (method, path, body, k) => {
    const r = await app.inject({
      method,
      url: path,
      payload: body === undefined ? undefined : (body as any),
      headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), "x-forwarded-for": ip },
    });
    return { status: r.statusCode, body: r.json() };
  };

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let session = sid ? sessions.get(sid) : undefined;

    if (!session) {
      if (sid || req.method !== "POST" || !isInitializeRequest(req.body)) {
        return reply.code(sid ? 404 : 400).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: sid ? "Session expired. Reconnect to start a new one." : "Start with an initialize request." },
          id: null,
        });
      }
      const initialKey = keyFrom(req);
      const fresh: Session = { transport: undefined as any, creds: initialKey ? { api_key: initialKey, handle: "" } : null, lastSeen: Date.now() };
      fresh.transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, fresh);
        },
      });
      fresh.transport.onclose = () => {
        for (const [id, s] of sessions) if (s === fresh) sessions.delete(id);
      };
      const server = buildMcpServer(api(req.ip), {
        persistent: false,
        mcpUrl: `${publicUrl}/mcp`,
        get: () => fresh.creds,
        set: (v) => {
          fresh.creds = v;
        },
      });
      await server.connect(fresh.transport);
      session = fresh;
    }

    session.lastSeen = Date.now();
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
}
