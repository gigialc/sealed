// Plain HTTP listener (no Inspector). For the Inspector, use `npm run dev`.
import server from "./server.js";

const port = Number(process.env.PORT ?? 3000);
await server.listen(port);
console.log(`[sealed mcp-use] http://localhost:${port}/mcp`);
