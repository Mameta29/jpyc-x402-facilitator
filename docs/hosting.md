# Hosting your own facilitator

A facilitator is a stateless HTTP service plus a Postgres database. You can run
it anywhere that supports Node 20+ and outbound connections to your chosen
EVM RPC endpoints.

## Reference deployment

```
facilitator.jpyc-x402.com         (production, mainnets only)
facilitator.staging.jpyc-x402.com (testnets only)
```

The hosted deployment is operated by the maintainers. Free tier is 1,000 settles
per calendar month per origin; above that, contact us for a paid plan. There
is no lock-in — switching to your own deployment is one env var.

## Required infra

| Piece | Sizing for ~50 RPS | Notes |
| ----- | ------------------ | ----- |
| Compute | 0.5 vCPU / 512 MB RAM per replica | Hono is async; CPU-bound only on signature recovery |
| Postgres | shared instance | nonce dedupe + rate limit; <100 MB even for high traffic |
| RPC per chain | 1 private + 1 backup endpoint | public RPCs throttle; we use viem `fallback` |
| Relayer wallet per chain | ~0.1 native token | settle costs <50k gas; top up monthly |

## Bootstrapping

```bash
git clone https://github.com/Mameta29/jpyc-x402-facilitator.git
cd jpyc-x402-facilitator
cp .env.example .env  # fill in DATABASE_URL, RELAYER_PRIVATE_KEY, RPC_URLS_*
docker compose -f apps/server/compose.yml up -d  # local dev only
pnpm install
pnpm --filter @jpyc-x402/facilitator db:generate
pnpm --filter @jpyc-x402/facilitator db:migrate
pnpm --filter @jpyc-x402/server start
```

## Deploying with Docker

```bash
docker build -t jpyc-x402-facilitator -f apps/server/Dockerfile .
docker run -p 8402:8402 --env-file .env jpyc-x402-facilitator
```

Public images are published to `ghcr.io/mameta29/jpyc-x402-facilitator` on each
release. Pin to a release tag in production; the `latest` tag is for dev.

## Choosing chains

By default the facilitator advertises every chain in the JPYC registry filtered
by `NODE_ENV` (production = mainnets, staging = testnets, otherwise all). Set
`ENABLED_NETWORKS` to a comma-separated CAIP-2 list to override:

```env
ENABLED_NETWORKS=eip155:137,eip155:1
```

## Multi-region hosting

The facilitator is stateless beyond Postgres; replicas can run in any region
that has acceptable RPC latency. Use Postgres logical replication or a
multi-AZ managed instance for the rate-limit / nonce tables. The `settlements`
unique constraint on `(chain_id, payer, nonce)` prevents two replicas from
ever broadcasting the same authorization.

## Secrets

Never commit `RELAYER_PRIVATE_KEY` to a git repo or container image. Use:

- Render/Fly secret store for managed PaaS
- AWS Secrets Manager / GCP Secret Manager for cloud
- HashiCorp Vault for self-hosted

The signer abstraction in `@jpyc-x402/evm` (`RelayerSignerProvider`) is the
single seam to swap in a KMS-backed signer.
