# Hosting your own facilitator

The facilitator is a stateless HTTP service. **No database is required.**
We ship two deployment apps that both consume the same
`@jpyc-x402/facilitator` core, so feature parity is automatic.

| App | Best for | Latency to Tokyo | Cost (low traffic) |
| --- | -------- | ---------------- | ------------------ |
| [`apps/worker`](../apps/worker) | Cloudflare-native, edge global | 5-30 ms (NRT) | **$5/mo Workers Paid** (or Free for staging) |
| [`apps/server`](../apps/server) | Self-host on Render / Fly / VPS | 20-80 ms (NRT/SIN) | $3-7/mo (Fly shared-cpu-1x) |

**Recommended**: run the Worker for production. Keep `apps/server` as the
fallback for emergencies and as a portable deployment for anyone forking
this repo who can't (or doesn't want to) use Cloudflare.

---

## Reference deployment

The maintainers operate a hosted facilitator at:

```
facilitator.jpyc-service.com         (production, mainnets only)
facilitator-staging.jpyc-service.com (testnets only)
```

You can swap to your own deployment at any time by setting
`FACILITATOR_URL` on the resource server side — there is no lock-in.

---

## Required infra

Whichever app you pick, you need:

1. **One private RPC URL per enabled chain**. Public RPCs throttle hard at
   any meaningful traffic. The runtime configures viem's `fallback`
   transport with comma-separated lists, so put a primary + backup per
   chain.

2. **A funded relayer wallet** (`RELAYER_PRIVATE_KEY`). The wallet only
   spends gas to broadcast `transferWithAuthorization` — it never holds
   user funds. ~0.1 native token per chain is enough for months of typical
   traffic.

   For operators of `jpyc-ec-platform`, you can reuse the existing
   `EXECUTOR_PRIVATE_KEY` here. EIP-3009 nonces are scoped per-(token, payer)
   so the おまかせプラン executor and the x402 facilitator never conflict
   at the contract level, even when sharing one wallet.

3. **Secret management**. Never commit `RELAYER_PRIVATE_KEY` to git or bake
   it into a container image. Use the platform's secret store (Workers
   Secrets, Render Secrets, Fly Secrets, AWS/GCP Secret Manager).

You **do not need**: a database, a cache, a queue, a session store. The
facilitator is intentionally stateless — replay protection is enforced
on-chain by EIP-3009's `_authorizationStates` mapping.

---

## Cloudflare Workers (recommended)

```bash
git clone https://github.com/Mameta29/jpyc-x402-facilitator.git
cd jpyc-x402-facilitator/apps/worker

cp .dev.vars.example .dev.vars   # local-only secrets for `wrangler dev`
pnpm install
pnpm wrangler dev                # → http://127.0.0.1:8787
```

For production:

```bash
cd apps/worker

# 1. Push secrets per environment (interactive prompts)
pnpm wrangler secret put RELAYER_PRIVATE_KEY --env staging
pnpm wrangler secret put RELAYER_PRIVATE_KEY --env production

pnpm wrangler secret put RPC_URLS_137 --env production
pnpm wrangler secret put RPC_URLS_1 --env production
# ...etc

# 2. Deploy
pnpm deploy:staging
pnpm deploy:production
```

The default `wrangler.jsonc` already configures:

- **Placement Hints** `aws:ap-northeast-1` (Tokyo) for both envs
- **Routes** `facilitator.jpyc-service.com` (prod) and
  `facilitator-staging.jpyc-service.com` (stg)
- **Durable Object binding** `RELAYER` for nonce serialization
- **Cron** `*/1 * * * *` to refresh the in-memory balance cache

See [`apps/worker/README.md`](../apps/worker/README.md) for details.

---

## Self-hosted Node + Hono

```bash
git clone https://github.com/Mameta29/jpyc-x402-facilitator.git
cd jpyc-x402-facilitator
cp .env.example .env
pnpm install
pnpm --filter @jpyc-x402/server dev
# → http://localhost:8402
```

For production deploys see:

- Render: [`apps/server/README.md#deploying-to-render`](../apps/server/README.md)
- Fly.io: [`apps/server/README.md#deploying-to-flyio`](../apps/server/README.md)

**Pin a single replica** (`numInstances: 1` on Render, `max-machines = 1`
on Fly). The Node app uses an in-process per-chain mutex for nonce
serialization; multiple replicas would race.

---

## Sizing guidance

For ~50 req/s of mixed verify+settle traffic:

- **Workers**: well within the included quotas of Workers Paid ($5/mo).
  CPU per request is sub-15 ms; the 30M CPU-ms/month allowance covers
  ~2M settles/month.
- **Node (Fly shared-cpu-1x 512MB)**: handles the same workload at
  ~30 % CPU utilisation. RAM usage is dominated by viem's RPC client
  caches, well under 200 MB.

Postgres-style scaling concerns (connection pools, slow queries) do not
apply because there is no Postgres.

---

## Operator checklist

Before going live:

- [ ] Relayer wallet funded with native gas on every enabled chain
- [ ] Private RPC URLs configured per chain (not relying on public RPCs)
- [ ] `RELAYER_PRIVATE_KEY` stored in your secret manager, not env files in
      git or images
- [ ] CORS_ORIGINS narrowed to your resource server domain
- [ ] Logs streaming to a destination you can grep (Workers Logs, Logpush,
      Render Logs, Fly Logs)
- [ ] Health check endpoint (`GET /health`) wired into your platform's
      load balancer
- [ ] `GET /supported` returns the list of (scheme, network) kinds you
      expect
