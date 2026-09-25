# @jpyc-x402/worker

Cloudflare Workers + Durable Objects deployment of the JPYC x402 facilitator.

This is the **edge-native** deployment target. For self-hosted Node deployments
(Render, Fly.io, VPS), see [`apps/server`](../server). Both apps consume the
same `@jpyc-x402/facilitator` core, so feature parity is automatic.

## Why a Worker (and a DO)

- Cloudflare Workers gives us the lowest possible latency between the agent
  and the facilitator (Placement Hints `aws:ap-northeast-1` puts the Worker
  in Tokyo for JPYC's Japanese user base).
- Workers don't charge for I/O wait time, so the 2-30s `eth_getTransactionReceipt`
  await is free even though the request is "open" the whole time.
- One **Durable Object per chain** owns the broadcast lane for that chain.
  `blockConcurrencyWhile` inside the DO serialises nonce assignment so two
  parallel settle requests on the same chain can never grab the same nonce.
- We deliberately keep the DO lock to **broadcast only**. Receipt waiting
  runs back in the parent Worker, fully concurrent. This avoids the DO's
  hard 30-second `blockConcurrencyWhile` timeout, which would otherwise
  reset the DO when an Ethereum mainnet receipt takes too long.

## Local development

```bash
cd apps/worker
cp .dev.vars.example .dev.vars  # fill RELAYER_PRIVATE_KEY + RPC_URLS_*
pnpm install
pnpm wrangler dev
# → http://127.0.0.1:8787
```

`wrangler dev` runs the Worker in `workerd` locally, including the DO
binding (`miniflare`-backed in-process). Cron triggers don't fire under
`wrangler dev` by default — use `wrangler dev --test-scheduled` and
`curl http://127.0.0.1:8787/__scheduled` to fire one manually.

## Production deploy

### One-time setup

1. **Add the domain to your Cloudflare zone**. The default config expects
   `facilitator.jpyc-service.com` and `facilitator-staging.jpyc-service.com`
   under the `jpyc-service.com` zone.

2. **Push secrets** for both environments:

   ```bash
   wrangler secret put RELAYER_PRIVATE_KEY --env staging
   wrangler secret put RELAYER_PRIVATE_KEY --env production

   wrangler secret put RPC_URLS_137 --env production    # Polygon
   wrangler secret put RPC_URLS_1 --env production      # Ethereum
   wrangler secret put RPC_URLS_43114 --env production  # Avalanche

   wrangler secret put RPC_URLS_80002 --env staging     # Polygon Amoy
   wrangler secret put RPC_URLS_11155111 --env staging  # Sepolia
   # …etc per chain
   ```

3. **Deploy**:

   ```bash
   pnpm deploy:staging      # → https://facilitator-staging.jpyc-service.com
   pnpm deploy:production   # → https://facilitator.jpyc-service.com
   ```

### Tail logs

```bash
pnpm tail:staging
pnpm tail:production
```

## Configuration matrix

| | Staging | Production |
| - | - | - |
| Worker name | jpyc-x402-facilitator-staging | jpyc-x402-facilitator-production |
| Domain | facilitator-staging.jpyc-service.com | facilitator.jpyc-service.com |
| Placement | `aws:ap-northeast-1` | `aws:ap-northeast-1` |
| Chains | testnets (Amoy, Sepolia, Fuji, Kairos, Arc) | mainnets (Ethereum, Polygon, Avalanche) |
| Workers plan | Free is OK for testing | Paid ($5/mo) |

## Cost expectations

- Workers Paid `$5/month` includes 10M requests + 30M CPU-ms. A facilitator
  request is sub-15ms of CPU even on heavy verify (signature recovery), so
  practical capacity is **2M+ settles/month within the included quota**.
- Durable Objects: 1M requests/month included on Paid; we hit one DO per
  settle so 1M settles/month is also within the included quota.
- I/O wait time (Polygon receipt: 2-3s, Ethereum: 12-30s) is **not billed**
  on Workers — only CPU time is.

## Operations

### Chain-scoped durable rollout

Staging enables the durable transaction journal on Kairos (1001) and Sepolia
(11155111) through `DURABLE_SETTLEMENT_CHAINS`. Other staging chains retain the
previous broadcast path. An omitted allowlist enables the durable path on all
chains; an empty string disables it on all chains.

`RELAYER_CHAIN_PRIVATE_KEYS` is an optional **secret** containing a JSON object
from chain IDs to private keys. It overrides `RELAYER_PRIVATE_KEY` only on the
listed chains, including verification, sending and balance monitoring. Never
put these values in Wrangler vars or source control. Only override chains that
are opted into the durable path.

Each durable sender must be exclusive to this facilitator's nonce allocator.
Fund and verify it on each selected testnet before activating a version. Keep
the existing default key for chains outside the rollout. This is one sender
per chain, not a multi-wallet load-balancing pool. Check pending settlements
before rollout or rollback, and retain their journal and signing configuration
until they have reached a terminal state.

`SETTLEMENT_NOTIFY_SECRET` must match the staging storefront callback secret.
The callback URL is fixed in Wrangler configuration; customer requests cannot
choose its destination.

- **Cron**: `*/1 * * * *` triggers `scheduled()` to refresh balance cache
  for every enabled chain. Failures per chain are isolated.
- **Logs**: Workers Logs (free 200k/day, paid 20M/month) automatically
  captures `console.info` / `console.error`. Run `wrangler tail` to stream.
- **Audit trail**: every successful settle emits a structured `settle.ok`
  JSON log line with payer / payTo / value / tx hash / gas — pipe to Logpush
  if you need long-term retention beyond Workers Logs' 7-day window.
