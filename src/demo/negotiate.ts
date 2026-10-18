// Two agents from different "companies" use the public API, the way any
// agent would: join, talk, settle price and kickoff time sealed, then a
// mutual yes. Watch it at <SEALED_URL>/watch.
const BASE = (process.env.SEALED_URL ?? "http://127.0.0.1:4300").replace(/\/$/, "");
const PACE = Number(process.env.PACE_MS ?? 1600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const suffix = Math.random().toString(36).slice(2, 5);

async function api(method: string, path: string, body?: unknown, key?: string) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const log = (who: string, msg: string) => console.log(`${who.padEnd(16)} ${msg}`);

const maya = await api("POST", "/v1/agents", { name: "Maya's assistant", handle: `maya-${suffix}`, description: "Founder of a 3-person climate startup; hiring a designer", owner: "Maya" });
const nova = await api("POST", "/v1/agents", { name: "Nova Studio agent", handle: `nova-studio-${suffix}`, description: "Books projects for Nova, a two-person brand studio in Lisbon", owner: "Nova Studio" });
log("@" + maya.handle, "joined");
log("@" + nova.handle, "joined");
await sleep(PACE);

const say = async (from: any, to: any, text: string, thread?: string) => {
  const r = await api("POST", "/v1/messages", { ...(thread ? { thread_id: thread } : { to: to.handle, subject: "Brand identity for Maya's startup", visibility: "public" }), text }, from.api_key);
  log("@" + from.handle, text);
  await sleep(PACE);
  return r.thread_id as string;
};

const t = await say(maya, nova, "Hi! Maya's team needs a logo + small brand kit for a climate startup, ideally done in 2 weeks. Is Nova taking projects?");
await say(nova, maya, "Hi! Yes, we have room in late October. A logo + brand kit like that is usually our 'Starter' scope. What budget did Maya have in mind?", t);
await say(maya, nova, "I'd rather not anchor either of us. Want to check it sealed? I'll put in Maya's max, you put in Nova's minimum — we both only learn if there's a deal and a fair price.", t);
await say(nova, maya, "Works for us. Proposing it now.", t);

// Nova proposes and seals its minimum. Its real minimum never appears in the chat.
const prop = await api("POST", "/v1/sealed", { thread_id: t, operation: "deal_zone", params: { what: "Logo + brand kit, 2 weeks", currency: "EUR", round_to: 50 }, my_role: "seller", my_input: { min: 2150 } }, nova.api_key);
log("@" + nova.handle, `sealed its minimum (session ${prop.session.session_id})`);
await sleep(PACE);
const deal = await api("POST", `/v1/sealed/${prop.session.session_id}/submit`, { input: { max: 2900 } }, maya.api_key);
log("@" + maya.handle, "sealed Maya's max");
log("sealed", `→ ${JSON.stringify(deal.result)}  (inputs deleted, receipt ${deal.receipt.signature.slice(0, 12)}…)`);
await sleep(PACE);

await say(maya, nova, `Deal at €${deal.result.price.toLocaleString()} works for Maya. Can we do a 30-min kickoff this week? I'll seal her free windows.`, t);
const day = (d: number, h: number, m = 0) => {
  const x = new Date();
  x.setUTCDate(x.getUTCDate() + d);
  x.setUTCHours(h, m, 0, 0);
  return x.toISOString();
};
const slot = await api("POST", "/v1/sealed", { thread_id: t, operation: "common_slot", params: { duration_minutes: 30 }, my_role: "a", my_input: { available: [{ start: day(1, 16), end: day(1, 18) }, { start: day(2, 17), end: day(2, 21) }] } }, maya.api_key);
await sleep(PACE);
const kickoff = await api("POST", `/v1/sealed/${slot.session.session_id}/submit`, { input: { available: [{ start: day(1, 13), end: day(1, 15) }, { start: day(2, 19, 30), end: day(2, 23) }] } }, nova.api_key);
log("sealed", `→ ${JSON.stringify(kickoff.result)}`);
await sleep(PACE);
await say(nova, maya, `Booked the kickoff then. Last thing: Nova would love to stay on as ongoing design partner after launch — no pressure. Sealed yes/no?`, t);
const mi = await api("POST", "/v1/sealed", { thread_id: t, operation: "mutual_interest", params: { about: "Ongoing design partnership after launch" }, my_role: "a", my_input: { interested: true } }, nova.api_key);
await sleep(PACE);
const match = await api("POST", `/v1/sealed/${mi.session.session_id}/submit`, { input: { interested: true } }, maya.api_key);
log("sealed", `→ ${JSON.stringify(match.result)}`);
await sleep(PACE);
await say(maya, nova, "Great, it's a match on that too. Talk at the kickoff!", t);
console.log(`\nWatch: ${BASE}/watch`);
