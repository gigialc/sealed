// The local secret vault. A human stores their private limits here once; the
// agent only ever refers to them by name. The local MCP server reads the value,
// locks and signs it, and sends it — so the number never enters the model's
// conversation. Each secret carries the human's rules: which questions it may
// answer, how many times, and whether to ask first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface VaultSecret {
  /** A number (a budget, a minimum), true/false, or a full input object (e.g. {available: [...]}) */
  value: unknown;
  /** Question types this secret may answer, e.g. ["deal_zone"]. */
  allow: string[];
  /** Optional: only as this role (e.g. "buyer"). */
  role?: string;
  /** Optional: only with these counterparties (handles). */
  with?: string[];
  /** Optional: for deal_zone with at_price, only prices in this range. */
  price_range?: [number, number];
  /** Uses left; null = unlimited. */
  uses_left: number | null;
  /** Ask the human before each use. */
  ask_first: boolean;
  note?: string;
}

export interface VaultFile {
  secrets: Record<string, VaultSecret>;
}

export const defaultVaultPath = () => join(process.env.SEALED_HOME ?? join(homedir(), ".sealed"), "vault.json");

export class Vault {
  constructor(readonly path = defaultVaultPath()) {}

  load(): VaultFile {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as VaultFile) : { secrets: {} };
  }

  save(v: VaultFile) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(v, null, 2), { mode: 0o600 });
  }

  set(name: string, s: VaultSecret) {
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(name)) throw new Error("secret names: lowercase letters, digits, . _ -");
    const v = this.load();
    v.secrets[name] = s;
    this.save(v);
  }

  remove(name: string) {
    const v = this.load();
    delete v.secrets[name];
    this.save(v);
  }

  /** What an agent is allowed to know: names and rules, never values. */
  describe() {
    return Object.entries(this.load().secrets).map(([name, s]) => ({
      name,
      allowed_for: s.allow,
      ...(s.role ? { role: s.role } : {}),
      ...(s.with ? { only_with: s.with } : {}),
      ...(s.price_range ? { only_prices: s.price_range } : {}),
      uses_left: s.uses_left,
      asks_human_first: s.ask_first,
      ...(s.note ? { note: s.note } : {}),
    }));
  }

  /** Check the human's rules for one use. Throws a plain-language reason if not allowed. */
  check(name: string, operation: string, role: string, ctx: { counterparts?: string[]; params?: any } = {}): VaultSecret {
    const s = this.load().secrets[name];
    if (!s) throw new Error(`No secret named "${name}" in the vault. Ask your human to add it: npm run secret -- set ${name} <value> --for ${operation}`);
    if (!s.allow.includes(operation)) throw new Error(`Your human only allows "${name}" for: ${s.allow.join(", ")}. Not ${operation}.`);
    if (s.role && s.role !== role) throw new Error(`Your human only allows "${name}" as ${s.role}, not ${role}.`);
    if (s.uses_left !== null && s.uses_left <= 0) throw new Error(`"${name}" has no uses left. Your human can allow more.`);
    if (s.with && (ctx.counterparts ?? []).some((h) => !s.with!.includes(h.replace(/^@/, "")))) {
      throw new Error(`Your human only allows "${name}" with: ${s.with.map((h) => "@" + h).join(", ")}.`);
    }
    const price = ctx.params?.at_price;
    if (s.price_range && price !== undefined && (price < s.price_range[0] || price > s.price_range[1])) {
      throw new Error(`Your human only allows "${name}" for prices between ${s.price_range[0]} and ${s.price_range[1]}.`);
    }
    return s;
  }

  recordUse(name: string) {
    const v = this.load();
    const s = v.secrets[name];
    if (s && s.uses_left !== null) s.uses_left -= 1;
    this.save(v);
  }
}

/** Turn a stored value into the exact input shape a question expects. */
export function toInput(operation: string, role: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "number") {
    if (operation === "deal_zone") return role === "seller" ? { min: value } : { max: value };
    if (operation === "group_budget") return { max: value };
  }
  if (typeof value === "boolean") {
    if (operation === "mutual_interest") return { interested: value };
    if (operation === "unanimous") return { yes: value };
  }
  throw new Error(`The stored value doesn't fit ${operation} as ${role}.`);
}
