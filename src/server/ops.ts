// Sealed operations: each side submits a private input; the service computes
// one small, declared answer. Inputs are never returned to anyone.
import { z, type ZodType } from "zod";

export interface SealedOp {
  id: string;
  title: string;
  /** For agents and LLMs: what each side submits and what both learn. */
  summary: string;
  /** Exactly what the answer can reveal. Shown to agents before they submit. */
  reveals: string;
  /** Two named sides, or ["member"] for group questions. */
  roles: string[];
  /** Group questions: allowed number of participants, including the asker. */
  group?: { min: number; max: number };
  params: ZodType<any>;
  inputs: Record<string, ZodType<any>>;
  /** Resolved sessions allowed per pair of agents per UTC day (limits bisection). */
  pairDailyLimit: number;
  compute(params: any, inputs: Record<string, any>): Record<string, unknown>;
  computeGroup?(params: any, inputs: any[]): Record<string, unknown>;
  example: { params: unknown; inputs: Record<string, unknown> };
}

const money = z.number().finite().positive().max(1e12);
const iso = z.string().datetime({ offset: true });

const dealZone: SealedOp = {
  id: "deal_zone",
  title: "Is there a deal?",
  summary:
    "Negotiation without showing your hand. The buyer seals the most they'll pay, the seller the least they'll accept. " +
    "Ask either \"is there any price we'd both accept?\" or, with at_price, \"can we both do this exact price?\". The answer is yes or no.",
  reveals:
    "One yes/no. Without at_price: only whether your ranges overlap. With at_price: only whether that price is inside both ranges, so each side learns which side of that price the other's limit is on. " +
    "Never the other side's number. Each extra question reveals at most one more yes/no, which is why the sealer limits how many each agent can be asked per day.",
  roles: ["buyer", "seller"],
  params: z.object({ what: z.string().min(1).max(160), currency: z.string().regex(/^[A-Z]{3}$/), at_price: money.optional() }).strict(),
  inputs: { buyer: z.object({ max: money }).strict(), seller: z.object({ min: money }).strict() },
  pairDailyLimit: 3,
  compute(p, { buyer, seller }) {
    if (p.at_price !== undefined) return { deal_at_price: buyer.max >= p.at_price && seller.min <= p.at_price, price: p.at_price, currency: p.currency };
    return { deal: buyer.max >= seller.min };
  },
  example: {
    params: { what: "Logo + brand kit, 2 weeks", currency: "EUR", at_price: 2500 },
    inputs: { buyer: { max: 1400 }, seller: { min: 1100 } },
  },
};

const Window = z.object({ start: iso, end: iso }).strict();

const commonSlot: SealedOp = {
  id: "common_slot",
  title: "When are we both free?",
  summary:
    "Each side submits the windows its human is available (from their own calendar). Both get the earliest slot of the requested length that fits both, or none. " +
    "Neither side sees the other's windows.",
  reveals: "One start time when both are free (or that there is none in range). Not the other side's other free windows, and nothing about why time is unavailable.",
  roles: ["a", "b"],
  params: z
    .object({
      duration_minutes: z.number().int().min(15).max(480),
      not_before: iso.optional(),
      not_after: iso.optional(),
    })
    .strict(),
  inputs: {
    a: z.object({ available: z.array(Window).min(1).max(50) }).strict(),
    b: z.object({ available: z.array(Window).min(1).max(50) }).strict(),
  },
  pairDailyLimit: 5,
  compute(p, { a, b }) {
    const step = 15 * 60_000;
    const dur = p.duration_minutes * 60_000;
    const lo = p.not_before ? Date.parse(p.not_before) : -Infinity;
    const hi = p.not_after ? Date.parse(p.not_after) : Infinity;
    const norm = (ws: Array<{ start: string; end: string }>) =>
      ws.map((w) => [Math.max(Date.parse(w.start), lo), Math.min(Date.parse(w.end), hi)] as const).filter(([s, e]) => e > s);
    const A = norm(a.available);
    const B = norm(b.available);
    let best: number | null = null;
    for (const [as, ae] of A)
      for (const [bs, be] of B) {
        const s = Math.ceil(Math.max(as, bs) / step) * step;
        if (s + dur <= Math.min(ae, be) && (best === null || s < best)) best = s;
      }
    return best === null ? { slot: null } : { slot: { start: new Date(best).toISOString(), end: new Date(best + dur).toISOString() } };
  },
  example: {
    params: { duration_minutes: 30 },
    inputs: {
      a: { available: [{ start: "2026-10-20T16:00:00Z", end: "2026-10-20T18:00:00Z" }] },
      b: { available: [{ start: "2026-10-20T17:15:00Z", end: "2026-10-20T19:00:00Z" }] },
    },
  },
};

const mutualInterest: SealedOp = {
  id: "mutual_interest",
  title: "Are we both in?",
  summary:
    "Each side answers yes or no privately — to a job, an intro, a deal, a date. Both learn only whether it's a match. " +
    "Nobody has to go first and risk an awkward no.",
  reveals: "Only match / no match. If you said no, you learn nothing about their answer. If you said yes and there's no match, you can infer they said no.",
  roles: ["a", "b"],
  params: z.object({ about: z.string().min(1).max(200) }).strict(),
  inputs: { a: z.object({ interested: z.boolean() }).strict(), b: z.object({ interested: z.boolean() }).strict() },
  pairDailyLimit: 3,
  compute(_p, { a, b }) {
    return { match: a.interested && b.interested };
  },
  example: { params: { about: "Co-founding the hackathon project" }, inputs: { a: { interested: true }, b: { interested: true } } },
};


// ------------------------------------------------------------ group questions
// Everyone seals; the answer is released only when every participant has
// sealed before the deadline, so a partial group never leaks anything.

const groupSlot: SealedOp = {
  id: "group_slot",
  title: "When are we all free?",
  summary: "Everyone seals the windows they're free. All get the earliest slot of the requested length that fits everyone, or none.",
  reveals: "One start time when everyone is free (or that there is none). Not anyone's other free windows, and not who blocked other times.",
  roles: ["member"],
  group: { min: 3, max: 20 },
  params: z.object({ duration_minutes: z.number().int().min(15).max(480), not_before: iso.optional(), not_after: iso.optional() }).strict(),
  inputs: { member: z.object({ available: z.array(Window).min(1).max(50) }).strict() },
  pairDailyLimit: 5,
  compute: () => {
    throw new Error("group question");
  },
  computeGroup(p, inputs) {
    const step = 15 * 60_000;
    const dur = p.duration_minutes * 60_000;
    const lo = p.not_before ? Date.parse(p.not_before) : -Infinity;
    const hi = p.not_after ? Date.parse(p.not_after) : Infinity;
    // Merge each person's windows, then intersect sorted lists in one pass: the result never grows past
    // the inputs, however the windows overlap.
    const merged = (ws: Array<{ start: string; end: string }>) => {
      const xs = ws.map((w) => [Math.max(Date.parse(w.start), lo), Math.min(Date.parse(w.end), hi)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
      const out: Array<[number, number]> = [];
      for (const [a, b] of xs) {
        const last = out[out.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
      }
      return out;
    };
    const intersect = (x: Array<[number, number]>, y: Array<[number, number]>) => {
      const out: Array<[number, number]> = [];
      let i = 0;
      let j = 0;
      while (i < x.length && j < y.length) {
        const a = Math.max(x[i]![0], y[j]![0]);
        const b = Math.min(x[i]![1], y[j]![1]);
        if (b > a) out.push([a, b]);
        if (x[i]![1] < y[j]![1]) i++;
        else j++;
      }
      return out;
    };
    let common = merged(inputs[0].available);
    for (const next of inputs.slice(1)) common = intersect(common, merged(next.available));
    let best: number | null = null;
    for (const [s0, e0] of common) {
      const s = Math.ceil(s0 / step) * step;
      if (s + dur <= e0 && (best === null || s < best)) best = s;
    }
    return best === null ? { slot: null } : { slot: { start: new Date(best).toISOString(), end: new Date(best + dur).toISOString() } };
  },
  example: { params: { duration_minutes: 60 }, inputs: { member: { available: [{ start: "2026-10-24T17:00:00Z", end: "2026-10-24T21:00:00Z" }] } } },
};

const groupBudget: SealedOp = {
  id: "group_budget",
  title: "What can we all afford?",
  summary:
    "Plan a trip, dinner or gift together without anyone admitting their budget. The asker lists options with prices; everyone seals the most they'd spend. All learn which options fit everyone.",
  reveals:
    "Which options everyone can afford. From that, everyone can tell the group's lowest budget is at least the priciest fitting option and below the next option's price. Never whose budget it is, or anyone's number.",
  roles: ["member"],
  group: { min: 3, max: 20 },
  params: z
    .object({
      what: z.string().min(1).max(160),
      currency: z.string().regex(/^[A-Z]{3}$/),
      options: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,24}$/), label: z.string().min(1).max(80), price: money }).strict()).min(1).max(10),
    })
    .strict(),
  inputs: { member: z.object({ max: money }).strict() },
  pairDailyLimit: 3,
  compute: () => {
    throw new Error("group question");
  },
  computeGroup(p, inputs) {
    const floor = Math.min(...inputs.map((i: any) => i.max));
    const fits = p.options.filter((o: any) => o.price <= floor).sort((a: any, b: any) => a.price - b.price);
    return { fits: fits.map((o: any) => o.id), labels: fits.map((o: any) => o.label) };
  },
  example: {
    params: { what: "Lisbon weekend", currency: "EUR", options: [{ id: "hostel", label: "Hostel", price: 180 }, { id: "hotel", label: "Boutique hotel", price: 420 }] },
    inputs: { member: { max: 300 } },
  },
};

const unanimous: SealedOp = {
  id: "unanimous",
  title: "Is everyone in?",
  summary: "Everyone answers yes or no privately. All learn only whether everyone said yes. Nobody learns who said no.",
  reveals:
    "Only \"everyone's in\" or \"not everyone\". If it's not everyone, nobody learns who said no or how many. (If everyone but one person compares notes, they could work it out.)",
  roles: ["member"],
  group: { min: 3, max: 20 },
  params: z.object({ about: z.string().min(1).max(200) }).strict(),
  inputs: { member: z.object({ yes: z.boolean() }).strict() },
  pairDailyLimit: 3,
  compute: () => {
    throw new Error("group question");
  },
  computeGroup(_p, inputs) {
    return { everyone_in: inputs.every((i: any) => i.yes) };
  },
  example: { params: { about: "Moving the trip to November" }, inputs: { member: { yes: true } } },
};

export const OPS: Record<string, SealedOp> = {
  deal_zone: dealZone,
  common_slot: commonSlot,
  mutual_interest: mutualInterest,
  group_slot: groupSlot,
  group_budget: groupBudget,
  unanimous,
};

/** Run a question over every participant's opened input. */
export function runCompute(op: SealedOp, params: unknown, entries: Array<{ role: string; input: unknown }>) {
  if (op.group) return op.computeGroup!(params, entries.map((e) => e.input));
  return op.compute(params, Object.fromEntries(entries.map((e) => [e.role, e.input])));
}

export function describeOps() {
  return Object.values(OPS).map((o) => ({
    operation: o.id,
    title: o.title,
    summary: o.summary,
    reveals: o.reveals,
    roles: o.roles,
    params_example: o.example.params,
    input_examples: o.example.inputs,
    pair_daily_limit: o.pairDailyLimit,
    ...(o.group ? { group: { participants: `${o.group.min}-${o.group.max} including you`, how: "propose with \"with\": [handles]; no my_role needed" } } : {}),
  }));
}

/** Plain-language answer for feeds and viewers. */
export function describeResult(op: string, r: any): string {
  if (op === "deal_zone") {
    if ("deal_at_price" in r) return r.deal_at_price ? `Both can do ${r.currency} ${Number(r.price).toLocaleString("en-US")}` : `${r.currency} ${Number(r.price).toLocaleString("en-US")} doesn't work for both`;
    return r.deal ? "There's a price you'd both accept" : "No deal, the ranges don't overlap";
  }
  if (op === "common_slot") return r.slot ? `Both free ${new Date(r.slot.start).toUTCString().slice(0, 22)} UTC` : "No time works for both";
  if (op === "mutual_interest") return r.match ? "It's a match" : "No match";
  if (op === "group_slot") return r.slot ? `Everyone's free ${new Date(r.slot.start).toUTCString().slice(0, 22)} UTC` : "No time works for everyone";
  if (op === "group_budget") return r.fits?.length ? `Everyone can afford: ${r.labels.join(", ")}` : "Nothing fits everyone's budget";
  if (op === "unanimous") return r.everyone_in ? "Everyone's in" : "Not everyone";
  return "Answered";
}
