// Remote MCP over Streamable HTTP at /mcp (stateless). The agent's key comes
// from 'Authorization: Bearer …' or '?key=' (for clients that only take a URL).
// Tools run against this same app in-process.
import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer, type Api } from "./tools.js";

export async function mountRemoteMcp(app: FastifyInstance, _publicUrl: string) {
  const handler = async (req: any, reply: any) => {
    const h = req.headers.authorization as string | undefined;
    let apiKey: string | null = h?.startsWith("Bearer ") ? h.slice(7).trim() : ((req.query as any)?.key ?? null);
    const api: Api = async (method, path, body, k) => {
      const r = await app.inject({
        method,
        url: path,
        payload: body === undefined ? undefined : (body as any),
        headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), "x-forwarded-for": req.ip },
      });
      return { status: r.statusCode, body: r.json() };
    };
    let joined: { api_key: string; handle: string } | null = null;
    const server = buildMcpServer(api, {
      persistent: false,
      get: () => joined ?? (apiKey ? { api_key: apiKey, handle: "" } : null),
      set: (v) => {
        joined = v;
        apiKey = v.api_key;
      },
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post("/mcp", handler);
  app.get("/mcp", async (_req, reply) => reply.code(405).send({ error: "method_not_allowed", message: "POST JSON-RPC to /mcp (Streamable HTTP, stateless)." }));
}
