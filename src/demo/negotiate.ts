// Two agents from different "companies" negotiate through the public API.
// Both have their own signing keys: every secret is locked and signed on the
// agent's side. For the attacks, see breach.ts.
import { SealedAgent } from "../client/agent.js";

const BASE = (process.env.SEALED_URL ?? "http://127.0.0.1:4300").replace(/\/$/, "");
const PACE = Number(process.env.PACE_MS ?? 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const suffix = Math.random().toString(36).slice(2, 5);
const log = (who: string, msg: string) => console.log(`${who.padEnd(18)} ${msg}`);

const maya = await SealedAgent.join(BASE, { name: "Maya's assistant", handle: `maya-${suffix}`, description: "Founder of a 3-person climate startup; hiring a designer", owner: "Maya" });
const nova = await SealedAgent.join(BASE, { name: "Nova Studio agent", handle: `nova-studio-${suffix}`, description: "Books projects for Nova, a two-person brand studio", owner: "Nova Studio" });
log("@" + maya.handle, "joined (own signing key)");
log("@" + nova.handle, "joined (own signing key)");

let thread = "";
const say = async (from: SealedAgent, to: SealedAgent, text: string) => {
  const r = await from.call("POST", "/v1/messages", thread ? { thread_id: thread, text } : { to: to.handle, text, subject: "Brand identity for Maya's startup" });
  thread = r.thread_id;
  log("@" + from.handle, text);
  await sleep(PACE);
};

await say(maya, nova, "Hi! Maya needs a logo + brand kit in 2 weeks. Is Nova taking projects?");
await say(nova, maya, "Yes. What budget did Maya have in mind?");
await say(maya, nova, "Let's not anchor. First, sealed: is there any price we'd both accept?");

// Maya's max (€2,900) and Nova's min (€2,150) never appear in a message.
const q1 = await maya.propose({ thread_id: thread, operation: "deal_zone", params: { what: "Logo + brand kit, 2 weeks", currency: "EUR" }, my_role: "buyer" });
await maya.submit(q1.session.session_id, { max: 2900 });
const a1 = await nova.submit(q1.session.session_id, { min: 2150 });
log("sealed", `any overlap? → ${JSON.stringify(a1.result)}  (receipt valid: ${await maya.receiptValid(a1.receipt)})`);
await sleep(PACE);

await say(nova, maya, "Good, there's room. Can we both do €2,500? Sealed again.");
const q2 = await nova.propose({ thread_id: thread, operation: "deal_zone", params: { what: "Logo + brand kit, 2 weeks", currency: "EUR", at_price: 2500 }, my_role: "seller" });
await nova.submit(q2.session.session_id, { min: 2150 });
const a2 = await maya.submit(q2.session.session_id, { max: 2900 });
log("sealed", `both do €2,500? → ${JSON.stringify(a2.result)}`);
await sleep(PACE);

await say(maya, nova, "€2,500 it is. Each of us learned one yes/no per question, never the other's number.");
