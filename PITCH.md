# Sealed: 3-minute pitch and demo

## Setup (before you go on)

Terminal 1, the studio's agent, which keeps running:
```bash
cd ~/sealed && SEALED_URL=https://sealed-production-1ec9.up.railway.app STUDIO_MIN=2150 STUDIO_HANDLE=nova-studio-demo npm run responder
```

Terminal 2, Maya's vault. Use a fresh demo home so it's clean:
```bash
export SEALED_HOME=~/sealed-demo-home
npm run secret -- set logo-max 2900 --for deal_zone --role buyer --uses 3 --note "Maya's max for the logo"
claude mcp add sealed -e SEALED_URL=https://sealed-production-1ec9.up.railway.app -e SEALED_HOME=$SEALED_HOME -e SEALED_PROFILE=maya -- npx tsx ~/sealed/src/mcp/stdio.ts
```

Terminal 3: run `npm run breach` once beforehand to warm it up (~1 min).

Have the homepage open: https://sealed-production-1ec9.up.railway.app

## The 3 minutes

**0:00 — The problem (20s).** Agents are starting to negotiate for us: prices, meetings, intros. To make progress, an agent has to say its human's limit, and once it's said, it's out. If you tell your agent "my max is €2,900", that number sits in the conversation and in the model provider's logs, and the other agent can talk it out of it.

**0:20 — What Sealed is (20s).** Private computation for agents. Any agent can join Sealed on its own, find other agents and talk. When something private has to be settled, both sides seal their limit, and only a small answer comes out: yes or no.

**0:40 — Live: an agent negotiating with a number it doesn't know (60s).** In terminal 2, run `claude` and say:
> "You're Maya's assistant. She needs a logo and brand kit in 2 weeks. Her budget is in her Sealed vault. Find @nova-studio-demo, check if there's a deal, then whether you can both do €2,500."

Point at three things:
- Claude calls `sealed_secrets` and sees the name `logo-max`, not the value.
- Terminal 1 shows Nova sealing its minimum.
- The answers come back: yes, then yes at €2,500. "Search this whole conversation for 2,900. It isn't there. The model never saw it."

**1:40 — We attacked it (40s).** In terminal 3, show `npm run breach` output (or `breach-report.md`):
- Before our fixes, three attacks recovered Alice's exact secret: reversing the price answer, asking over and over with new identities, and a compromised server replaying her envelope.
- Now: 0 of 3. The best attacker gets a ±€156 range after 5 questions, then the sealer refuses. The honest deal still closes.

**2:20 — How it holds (25s).** Point at the homepage diagram:
- Each envelope is locked and signed on the agent's side, for one exact question.
- The server carries envelopes but can't open, forge or reuse them.
- A tiny separate service, the sealer, holds the only key. It answers each question once, checks every signature, and caps how often anyone's secret can be asked about.

**2:45 — Honest + next (15s).** Today the sealer is a service we run, and it sees inputs while computing. Next is attested hardware so not even we can open an envelope, then multi-party computation. After prices and calendars: letting an agent work on code it can't read.

## Likely questions

- **"Isn't this just an escrow?"** Yes, for now: a trusted middle party. The difference is everything around it. Envelopes are bound to one question, there's signed single use, per-key budgets enforced by the sealer itself, and secrets the model never sees. The breach results show what that buys.
- **"Can't you learn the limit by asking a lot?"** Each answer is one yes/no, and the sealer caps questions per key per day. You can narrow it a bit, not find it.
- **"What if your server is hacked?"** It can't open envelopes, can't forge a signed agent's answer, and can't replay a stored envelope. That's attack C in the breach report. It could still swap someone's key in the directory once; the local agent pins keys and refuses if a known key changes.
- **"Which agents can use it?"** Anything that speaks HTTP or MCP: Claude Code, Claude Desktop, Cursor, custom agents. Agents onboard themselves from `/llms.txt`.
- **"Why not just use A2A or email between agents?"** Use them for talking. Sealed is for the part you can't say out loud.
