// Ask the human for a secret directly on their screen, outside the chat.
// The value goes straight into the local vault; the model only learns that it
// was saved. macOS uses a native dialog with hidden typing.
import { execFile } from "node:child_process";

/** Returns the typed value, or null if the human cancelled. */
export function askHumanForSecret(message: string): Promise<string | null> {
  if (process.platform !== "darwin" || process.env.SEALED_NO_POPUP) return Promise.resolve(null);
  const script =
    `display dialog ${JSON.stringify(message)} with title "Sealed: add a secret" default answer "" with hidden answer ` +
    `buttons {"Cancel", "Save"} default button "Save" giving up after 180`;
  return new Promise((res) =>
    execFile("osascript", ["-e", script], (err, out) => {
      const m = !err && String(out).match(/button returned:Save, text returned:(.*?)(, gave up:.*)?$/m);
      res(m ? m[1]!.trim() : null);
    }),
  );
}

/** "2900" → 2900, "true" → true, JSON stays JSON, anything else stays text. */
export function parseSecretValue(raw: string): unknown {
  const t = raw.trim().replace(/[€$£,\s]/g, "");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^(true|yes)$/i.test(raw.trim())) return true;
  if (/^(false|no)$/i.test(raw.trim())) return false;
  if (raw.trim().startsWith("{")) return JSON.parse(raw);
  return raw.trim();
}

import type { Vault } from "./vault.js";

/** Make sure a vault secret exists: if it doesn't, ask the human on screen and save their answer. */
export async function ensureSecret(vault: Vault, name: string, operation: string, role: string | undefined, purpose: string, uses = 3) {
  if (vault.load().secrets[name]) return;
  const raw = await askHumanForSecret(secretPrompt(name, purpose, operation, role));
  if (raw === null || raw === "") {
    throw new Error(`No secret "${name}" yet, and your human didn't add one. They can type it in the popup, or run: npm run secret -- set ${name} <value> --for ${operation}`);
  }
  vault.set(name, { value: parseSecretValue(raw), allow: [operation], ...(role && role !== "member" ? { role } : {}), uses_left: uses, ask_first: false, note: purpose });
}

export function secretPrompt(name: string, purpose: string, operation: string, role?: string) {
  const what =
    operation === "deal_zone" ? (role === "seller" ? "the LOWEST price you'd accept" : "the MOST you'd pay")
    : operation === "group_budget" ? "the most you'd spend"
    : operation === "mutual_interest" || operation === "unanimous" ? "yes or no"
    : "your answer";
  return `Your agent needs a private value "${name}" (${purpose}).\n\nType ${what}. It's saved only on this computer — your AI never sees it, and other agents only ever get yes/no answers.`;
}
