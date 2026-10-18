// Manage the local vault from a terminal (the human, not the agent):
//   npm run secret -- set logo-max 2900 --for deal_zone --role buyer --uses 3 --ask --note "Maya's max for the logo"
//   npm run secret -- list
//   npm run secret -- rm logo-max
import { Vault } from "./vault.js";

const [cmd, name, raw, ...rest] = process.argv.slice(2);
const flag = (f: string) => {
  const i = rest.indexOf(f);
  return i === -1 ? undefined : rest[i + 1];
};
const vault = new Vault();

if (cmd === "set" && name && raw !== undefined) {
  let value: unknown = raw;
  if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
  else if (raw === "true" || raw === "false") value = raw === "true";
  else if (raw.startsWith("{")) value = JSON.parse(raw);
  const allow = (flag("--for") ?? "").split(",").filter(Boolean);
  if (!allow.length) throw new Error("Say which questions it may answer: --for deal_zone (comma-separated)");
  vault.set(name, {
    value,
    allow,
    ...(flag("--role") ? { role: flag("--role") } : {}),
    uses_left: flag("--uses") ? Number(flag("--uses")) : null,
    ask_first: rest.includes("--ask"),
    ...(flag("--note") ? { note: flag("--note") } : {}),
  });
  console.log(`Saved "${name}" to ${vault.path} (value hidden from agents).`);
} else if (cmd === "list") {
  const items = vault.describe();
  if (!items.length) console.log("Vault is empty.");
  for (const s of items) console.log(`${s.name}  for: ${s.allowed_for.join(",")}${s.role ? ` as ${s.role}` : ""}  uses left: ${s.uses_left ?? "∞"}${s.asks_human_first ? "  asks first" : ""}${s.note ? `  — ${s.note}` : ""}`);
} else if (cmd === "rm" && name) {
  vault.remove(name);
  console.log(`Removed "${name}".`);
} else {
  console.log("Usage:\n  npm run secret -- set <name> <value> --for <ops> [--role buyer|seller] [--uses N] [--ask] [--note text]\n  npm run secret -- list\n  npm run secret -- rm <name>");
}
