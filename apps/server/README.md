# @jpyc-x402/server

Deployable Hono server hosting the JPYC x402 facilitator.

## Local development

```bash
# 1. Start Postgres
docker compose -f apps/server/compose.yml up -d

# 2. Apply schema
cp .env.example .env
pnpm --filter @jpyc-x402/facilitator db:generate
pnpm --filter @jpyc-x402/facilitator db:migrate

# 3. Run
pnpm --filter @jpyc-x402/server dev
```

## Production

A production deployment needs:

1. **Postgres 13+** — managed (Neon, Render Postgres, Supabase, RDS).
2. **One private RPC URL per enabled chain** — public RPCs rate-limit at scale.
3. **A relayer wallet per chain** funded with a few cents of native gas. The
   facilitator never touches token balances; it only spends gas to broadcast
   `transferWithAuthorization`. See [docs/runbook.md](../../docs/runbook.md)
   for top-up procedures.
4. **Secret management** — `RELAYER_PRIVATE_KEY` belongs in a KMS / sealed
   secret store, not a `.env` file in the container image.

### Deploying to Render

```bash
# render.yaml (sample)
services:
  - type: web
    name: jpyc-x402-facilitator
    env: docker
    plan: standard
    dockerfilePath: ./apps/server/Dockerfile
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: jpyc-x402-pg
          property: connectionString
      - key: RELAYER_PRIVATE_KEY
        sync: false   # secret
```

### Deploying to Fly.io

```bash
fly launch --dockerfile apps/server/Dockerfile --no-deploy
fly secrets set RELAYER_PRIVATE_KEY=0x... DATABASE_URL=postgres://...
fly deploy
```

## Health checks

The load balancer should poll `GET /health`. It returns `{ "ok": true }` and
exits the request without touching the DB.

## Telemetry

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to point at any OTel collector. The Hono
logger middleware emits structured request lines on stdout regardless.
