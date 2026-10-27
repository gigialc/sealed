# Fresh installation on Render Free and Neon Free

The API and sealer are two independent Render **Free web services**. Each uses
its own Neon **Free project**, with unrelated database credentials. Existing
Railway services and their keys, accounts and history remain unchanged.

## Isolation and durability

- The API receives `DATABASE_URL`, `SEALED_SIGNING_KEY`, `SEALER_URL` and
  `SEALER_TOKEN`. It never receives the sealer's database credentials or opening key.
- The sealer receives `SEALER_DATABASE_URL`, `SEALED_ENCRYPTION_KEY` and
  `SEALER_TOKEN`. Its Postgres ledger stores released answers and budget metadata,
  never private inputs. Transaction locks protect replay and per-key budgets across
  concurrent requests, process restarts and multiple workers.
- The sealer releases an answer only after its ledger transaction commits. Database
  unavailability fails the request; it never falls back to an ephemeral ledger.
- Free Render services cannot receive private-network traffic. The sealer therefore
  uses public **HTTPS**, with a random shared token required for every operation
  except `/v1` health. This is a wider network exposure than the Railway private
  sealer. TLS, token authentication, signed statements and envelopes remain required.
- This remains a trusted-sealer prototype: the sealer operator can see inputs during
  computation. It is not an enclave, MPC or a cryptographic proof of computation.

## Deployment

1. Create two fresh Neon Free projects (Oregon), one for the API and one for the
   sealer. Copy each TLS connection string to only its corresponding Render service.
2. Generate a fresh Ed25519 receipt key, X25519 opening key and 32-byte random token.
   Keys use DER PKCS8 encoded as base64url. Keep backups private; don't commit secrets.
3. Deploy the sealer first using `render.yaml` settings, then set `SEALER_URL` to its
   actual `https://…onrender.com` address when deploying the API. Use the same token
   in both services. `/v1` is the health-check path on both.
4. Use the deployment branch `codex/render-free` for this fresh installation.
   Automatic deploys are off. Do not change Railway's tracked branch or variables.
5. The API uses Render's `RENDER_EXTERNAL_URL` to advertise its own URL. New clients
   must set `SEALED_URL` to this API and use a fresh `SEALED_PROFILE`, so old identities
   and pinned public keys are not silently reused.

The main API exposes HTTP and agent documentation. The separate MCP adapter runs
locally (`SEALED_URL=https://sealed-gigi.onrender.com SEALED_PROFILE=render npm run mcp`).
The older shared mcp-use cloud URL still belongs to the Railway installation and
must not be used to join this one. Email remains disabled unless this installation
gets its own Primitive credentials.

## Free-tier limits

Render sleeps idle services after 15 minutes and waking can take about a minute.
The API starts independently of the sealer, so the homepage, discovery and
messaging do not wait for private computation to wake. Sealer requests have a
15-second deadline; an unavailable sealer returns `503 sealer_unavailable` with
`Retry-After: 5`. Retry the same session request after that delay. Failed public-key
lookups are not cached, and computation retries retain the ledger's replay checks.
The two services share the workspace's 750 monthly free instance-hours; continuous
use of both would exceed that allowance. Neon also has storage, compute and transfer
quotas. This configuration is for occasional prototype use, not an always-on service.
Do not add a paid disk, private service or expiring Render Free Postgres database.

References: [Render Free](https://render.com/docs/free),
[Neon plans](https://neon.com/pricing).
