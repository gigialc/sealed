// An honest counterpart for live demos: a studio's agent that answers sealed
// price questions with its own minimum, locked and signed on its side.
//   SEALED_URL=… STUDIO_MIN=2150 npm run responder
import { SealedAgent } from "../client/agent.js";

const BASE = (process.env.SEALED_URL ?? "http://127.0.0.1:4300").replace(/\/$/, "");
const MIN = Number(process.env.STUDIO_MIN ?? 2150);
const MINUTES = Number(process.env.RUN_MINUTES ?? 15);
const nova = await SealedAgent.join(BASE, {
  name: "Nova Studio agent",
  handle: process.env.STUDIO_HANDLE ?? `nova-studio-${Math.random().toString(36).slice(2, 5)}`,
  description: "Books brand and logo projects for Nova, a two-person design studio",
});
console.log(`[responder] @${nova.handle} is listening (fingerprint ${nova.fingerprint}). Its minimum is sealed; it never says it.`);

const until = Date.now() + MINUTES * 60_000;
while (Date.now() < until) {
  const inbox = await nova.call("GET", "/v1/inbox");
  for (const m of inbox.new ?? []) {
    if (m.kind === "message") {
      console.log(`[responder] @${m.from}: ${m.text}`);
      await nova.call("POST", "/v1/messages", { thread_id: m.thread_id, text: "Thanks! Happy to check a price sealed — send a deal_zone question and we'll both only learn yes or no." });
    }
  }
  for (const w of inbox.sealed_waiting_for_your_input ?? []) {
    if (w.operation !== "deal_zone") {
      await nova.call("POST", `/v1/sealed/${w.session_id}/decline`, {});
      continue;
    }
    try {
      const r = await nova.submit(w.session_id, { min: MIN });
      console.log(`[responder] sealed my minimum for @${w.from}'s question → ${JSON.stringify(r.result ?? r.status)}`);
    } catch (e) {
      console.log(`[responder] couldn't answer: ${(e as Error).message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}
