# @jpyc-x402/server

Deployable **Node + Hono** server hosting the JPYC x402 facilitator.

This is the single-machine deployment target. The opt-in ERC-7710 agent
lane requires Node 22.14+, a persistent writable SQLite volume and a dedicated
relayer. See [Polygon configuration and recovery](../../docs/agent-commerce/POLYGON.md).

## When to use this vs. apps/worker

| Scenario | Pick |
| -------- | ---- |
| Self-hosting on Render / Fly.io / a VPS | **apps/server** (this one) |
| Cloudflare-native deployment, edge global | apps/worker |
| Need stronger nonce serialization across many replicas | apps/worker (Durable Object) |
| Want a dependency-light, easy-to-fork reference | **apps/server** |
| Polygon ERC-7710 / PurchaseGate agent purchases | **apps/server** with a persistent disk |

Both apps share the legacy EIP-3009 core. Worker/DO agent execution is disabled;
switching hosts does not migrate the agent journal or its nonce lane.

## Local development

```bash
cp .env.example .env   # fill RELAYER_PRIVATE_KEY + RPC_URLS_*
pnpm install
pnpm --filter @jpyc-x402/server dev
# → http://localhost:8402
```

Legacy-only mode requires no application database. Agent mode stores raw
transactions before sending and resumes them from SQLite after a restart.

## Production deploy

The examples below describe the legacy lane. Agent deployments additionally need
all settings in the [environment template](../../docs/agent-commerce/facilitator.env.example)
and one persistent journal volume. Use a secret manager or `node --env-file=/secure/facilitator.env apps/server/dist/main.js`;
the server does not automatically load a `.env` file.

Three things you actually need:

1. **One private RPC URL per enabled chain** (`RPC_URLS_<chainId>`). Public
   RPCs throttle at any meaningful traffic; viem's fallback transport will
   try each comma-separated URL in order.
2. **A funded relayer wallet** (`RELAYER_PRIVATE_KEY`) with a small native
   balance per chain (POL / ETH / AVAX / KAIA). The facilitator never holds
   user funds; it only spends gas to broadcast `transferWithAuthorization`.
3. **Secret management** — `RELAYER_PRIVATE_KEY` belongs in your platform's
   secret store (Render Secrets, Fly Secrets, AWS Secrets Manager), not a
   `.env` baked into the image.

Single-machine deployment is the supported topology. Pin `max-machines = 1`
(Fly) or `numReplicas = 1` (Render) so the in-process per-chain mutex
provides the only nonce serialization point.

### Deploying to Render

```yaml
# render.yaml
services:
  - type: web
    name: jpyc-x402-facilitator
    runtime: docker
    dockerfilePath: ./apps/server/Dockerfile
    plan: starter           # 0.5 vCPU / 512MB / no spin-down
    region: singapore
    healthCheckPath: /health
    numInstances: 1         # nonce safety
    envVars:
      - key: NODE_ENV
        value: production
      - key: RELAYER_PRIVATE_KEY
        sync: false         # secret
      - key: RPC_URLS_137
        sync: false
```

### Deploying to Fly.io

```bash
fly launch --dockerfile apps/server/Dockerfile --no-deploy
fly secrets set \
  RELAYER_PRIVATE_KEY=0x... \
  RPC_URLS_137=https://...
fly deploy
```

`fly.toml` should set `auto_stop_machines = "off"` and `min_machines_running = 1`
in `[http_service]`, plus `max_machines = 1` so two relayer instances never
hold the nonce mutex independently.

## Health checks

`GET /health` returns `{ "ok": true }` and never touches RPC. Wire your
load balancer / platform to this path.

## Telemetry

Hono's `logger` middleware writes structured stdout lines for every request.
Settlement successes additionally emit `{"ev":"settle.ok",...}` JSON lines.
Pipe stdout into any log aggregator (Render's built-in viewer, Fly Logs,
Axiom, Better Stack, Datadog, …) — no agent or sidecar required.
