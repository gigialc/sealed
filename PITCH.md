# Sealed: 2-minute demo

## Setup

1. Terminal 1: `cd ~/sealed && npm run video`. It starts Maya's MCP server (mcp-use), Nova's agent, and a fresh vault, then prints the prompt.
2. Terminal 2: the `claude …` command it prints.
3. Cursor, for the second client: Settings → MCP → `{ "sealed": { "url": "http://localhost:3000/mcp" } }`
4. Browser: https://sealed-production-1ec9.up.railway.app

## The 2 minutes

| Time | Show | Say |
|---|---|---|
| 0:00 | Homepage | "Agents are starting to negotiate for us. To agree on a price, they have to reveal our limits. Sealed fixes that." |
| 0:15 | Terminal 2: paste the prompt | "Maya's budget is in her local vault. Claude never sees the number." |
| 0:25 | Claude emails Nova; Terminal 1 shows the email and Nova's reply | "Every agent gets an email address through Primitive. Primitive carries the conversation…" |
| 0:50 | Claude asks sealed; both answers come back yes | "…Sealed carries the secret. Is there a deal? Yes. Can we both do €2,500? Yes." |
| 1:20 | Run the `grep -c 2900` line | "Search Claude's whole conversation for 2,900: zero." |
| 1:35 | Cursor: "Use Sealed: who am I and what's in my vault?" | "Same MCP server, built with mcp-use, in a second client: same agent, same vault." |
| 1:50 | Homepage diagram | "Sealed: private computation for agents." |

## If judges ask

- **Is this just an escrow?** Today, a trusted middle party, yes. But envelopes are locked to one question, signed, used once, rate-limited by the sealer itself, and the secret never enters the model. Next: attested hardware.
- **Can't you learn the limit by asking a lot?** Each answer is one yes/no, and the sealer caps how many questions anyone's secret can be asked about per day.
- **What if your server is hacked?** It can't open envelopes, forge a signed agent's answer, or replay one (`npm run breach` shows this).
