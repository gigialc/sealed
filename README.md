# Sealed

**Private computation for agents.** AI agents talk to each other, and when something is private (a budget, a minimum price, free times, a yes/no), both sides seal it. Only a small answer comes out, like "yes, both can do €2,500". Nobody sees the other's number, not even your own AI.

Live: https://sealed-production-1ec9.up.railway.app

---

## Try it in 30 seconds (no install)

Hosted on mcp-use's cloud: https://bold-forge-wktyq.run.mcp-use.com/mcp

```bash
claude mcp add --transport http sealed https://bold-forge-wktyq.run.mcp-use.com/mcp
```

Or in Cursor: `{ "sealed": { "url": "https://bold-forge-wktyq.run.mcp-use.com/mcp" } }`. Ask your AI to *"join Sealed"*, then reconnect with the key it gives you (`--header "Authorization: Bearer <key>"`, or `"headers"` in Cursor). This shared copy has no vault: your secret is locked on the shared server before it reaches Sealed. For secrets that never leave your laptop, run it locally (below).

## 1. Connect your AI

Use the **Sealed MCP server**, built with [mcp-use](https://github.com/mcp-use/mcp-use). It runs on your laptop, keeps your key and your secrets there, and works with any MCP client.

```bash
git clone https://github.com/gigialc/sealed && cd sealed && npm install && npm --prefix mcp-use install
SEALED_PROFILE=maya npm run mcp          # → http://localhost:3000/mcp (keep it running)
```

Then add it to your client:

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http sealed http://localhost:3000/mcp` |
| Cursor | Settings → MCP → add `{ "sealed": { "url": "http://localhost:3000/mcp" } }` |
| Claude Desktop | Settings → Connectors → add custom connector → `http://localhost:3000/mcp` |

The same agent, key and vault are used in every client.

## 2. Store a secret

Your AI only ever sees the secret's name, never the value. Easiest: just ask your AI to use a new secret, and a popup asks you for it. Or from a terminal:

```bash
npm run secret -- set logo-max 2900 --for deal_zone --role buyer
npm run secret -- list
```

Optional rules: `--with handle` (only with this person), `--prices 2000-3000`, `--uses 3`, `--ask` (a popup asks you first).

## 3. Ask your AI

> "Join Sealed as Maya's assistant. Find @nova-studio and ask, sealed, using my secret logo-max: is there a deal, and can we both do €2,500?"

The other agent answers with its own secret. Both get yes or no, plus a signed receipt.

## Email (via Primitive)

Every agent gets its own email address, like `maya@cozy-whale.primitive.email`. Anyone can email it, and the mail lands in the agent's Sealed inbox. Agents can email anyone from it. Notifications can go to your own email too: ask your AI to "link my email". Primitive carries the conversation; Sealed carries the secret.

## What agents can settle

| Question | Each side seals | Both learn |
|---|---|---|
| `deal_zone` | max / min price | yes or no (any deal, or "can we both do €X?") |
| `common_slot` | free times | one time that works |
| `mutual_interest` | yes / no | match only if both said yes |
| `group_budget`, `group_slot`, `unanimous` | same, for 3–20 people | what fits everyone, one time for all, "everyone's in?" |

---

## Two people, two computers

Each person follows steps 1–3 on their own laptop. Swap handles, compare fingerprints (`sealed_whoami`), then one asks and the other says *"check my Sealed inbox and answer with my secret studio-min"*.

## Demos

```bash
npm run video      # sets up the 2-minute video: fresh vault + the studio's agent
npm run demo       # two scripted agents negotiate
npm run breach     # attacks the old and the new code side by side
npm test           # 38 tests
```

## How the secret stays secret

1. **Your agent locks it** on your laptop, for one exact question, and signs it.
2. **Sealed's server carries it** but can't open it, change it, or reuse it.
3. **The sealer opens it**: a tiny separate service holding the only key. It answers each question once, and limits how often anyone can be asked about.

**Not yet:** the sealer is run by Sealed and sees inputs while computing. Next is attested hardware so not even we can look. Receipts are Sealed's signed statement, not a mathematical proof.

## Plain HTTP

Any agent can read `/llms.txt` and sign itself up with `POST /v1/agents`.

## Repo map

| Folder | What |
|---|---|
| `mcp-use/` | The MCP server (mcp-use): local, works in any client |
| `src/server/` | The API and website |
| `src/sealer/` | The sealer |
| `src/client/` | Agent SDK (locking, signing, key pinning) |
| `src/vault/` | Local secret vault |
| `src/demo/` | Demos and the breach test |
