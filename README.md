# jpyc-x402-facilitator

[![CI](https://github.com/Mameta29/jpyc-x402-facilitator/actions/workflows/ci.yml/badge.svg)](https://github.com/Mameta29/jpyc-x402-facilitator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [x402](https://x402.org) payment **facilitator** and TypeScript SDKs for **JPYC** (Japanese Yen Stablecoin).

This is the missing piece between the x402 protocol — designed for AI-agent
payments over HTTP — and JPYC, the leading JPY-pegged stablecoin natively
implementing EIP-3009 `transferWithAuthorization`.

> **Status:** active development. APIs are stable; production hosting is in progress.

## What is this?

```
                             ┌──────────────────────────┐
   AI agent / API caller ───▶│  Resource server (e.g.   │
   (signs EIP-3009 auth)     │  jpyc-ec-platform)       │
                             └────────────┬─────────────┘
                                          │ verify / settle
                                          ▼
                             ┌──────────────────────────┐
                             │  jpyc-x402-facilitator   │
                             │  • verify signature      │
                             │  • check balance         │
                             │  • simulate              │
                             │  • settle on-chain       │
                             └────────────┬─────────────┘
                                          │ transferWithAuthorization
                                          ▼
                             ┌──────────────────────────┐
                             │  JPYC (EIP-3009 token)   │
                             │  on Ethereum / Polygon / │
                             │  Avalanche / Kaia / Arc  │
                             └──────────────────────────┘
```

The facilitator is the only on-chain actor in an x402 flow. It pays gas, broadcasts
the transaction signed off-chain by the payer, and reports settlement back to the
resource server. Anyone can self-host this facilitator. There is also a hosted
deployment (see [Hosted facilitator](#hosted-facilitator)).

## Packages

This monorepo publishes the following npm packages under `@jpyc-x402/*`:

| Package | What it does | Use it if you are… |
| ------- | ------------ | ------------------ |
| [`@jpyc-x402/shared`](./packages/shared) | Types, CAIP-2 helpers, JPYC chain registry, EIP-712 domain, base64url, zod schemas | Building anything x402-related |
| [`@jpyc-x402/evm`](./packages/evm) | EIP-3009 verify / settle logic on EVM chains, multi-RPC fallback | Implementing a facilitator |
| [`@jpyc-x402/facilitator`](./packages/facilitator) | Hono router exposing `/verify`, `/settle`, `/supported` | Hosting your own facilitator |
| [`@jpyc-x402/client`](./packages/client) | Sign payloads, call any facilitator over HTTP, fetch wrapper | Resource server or paying client |
| [`@jpyc-x402/mcp`](./packages/mcp) | MCP server wrapping facilitator endpoints | Debugging from an LLM agent |

## Hosted facilitator

A reference deployment is operated by the maintainers. See [`apps/server`](./apps/server)
for the deployable image and [`docs/hosting.md`](./docs/hosting.md) for the public URL,
free tier, and SLA. You can swap to your own facilitator at any time by passing a
different base URL — there is no lock-in.

## Quick start

### Run the facilitator locally

```bash
cp .env.example .env
docker compose -f apps/server/compose.yml up -d   # Postgres
pnpm install
pnpm --filter apps/server dev
# → POST http://localhost:8402/verify
# → POST http://localhost:8402/settle
# → GET  http://localhost:8402/supported
```

### Pay through the facilitator from a TypeScript client

```ts
import { createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { polygon } from "viem/chains"
import { fetchWithPayment } from "@jpyc-x402/client"

const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY!)
const wallet = createWalletClient({ account, chain: polygon, transport: http() })

const res = await fetchWithPayment(
  "https://shop.example.com/api/v1/products/abc/checkout",
  { method: "POST", body: JSON.stringify({ quantity: 1 }) },
  { wallet, facilitatorUrl: "https://facilitator.jpyc-x402.com" },
)
console.log(await res.json())
```

### Add x402 to your own resource server

```ts
import { Hono } from "hono"
import { createPaymentRequirements } from "@jpyc-x402/shared"
import { ExactEvmFacilitator } from "@jpyc-x402/evm"

const app = new Hono()
app.get("/premium", async (c) => {
  const sig = c.req.header("PAYMENT-SIGNATURE")
  if (!sig) {
    const required = createPaymentRequirements({
      chainId: 137,
      amountAtomic: "1000000000000000000",   // 1 JPYC (18 decimals)
      payTo: "0xYourMerchantAddress",
      resource: c.req.url,
      description: "Premium content",
    })
    return c.json({}, 402, {
      "PAYMENT-REQUIRED": btoa(JSON.stringify(required)),
    })
  }
  // forward to facilitator /verify and /settle, then return content
})
```

## Why a separate facilitator?

x402 is intentionally trust-minimized. The facilitator never holds funds and
cannot modify the destination or amount of a payment — it only broadcasts a
pre-signed authorization. That makes it a good public-good piece of
infrastructure, completely independent of any single shop or marketplace.

JPYC natively implements EIP-3009, so x402's `exact` scheme works without any
proxy contracts. There is no smart-contract code to deploy; only an HTTP server
and a relayer wallet per chain.

## Networks and assets

| Chain | CAIP-2 | JPYC contract | Domain `name` / `version` |
| ----- | ------ | ------------- | ------------------------- |
| Ethereum mainnet | `eip155:1` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Polygon mainnet | `eip155:137` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Avalanche mainnet | `eip155:43114` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Sepolia (Ethereum testnet) | `eip155:11155111` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Polygon Amoy testnet | `eip155:80002` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Avalanche Fuji testnet | `eip155:43113` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Kaia Kairos testnet | `eip155:1001` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |
| Arc testnet | `eip155:5042002` | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` | `JPY Coin` / `1` |

Operators can disable individual networks per deployment via `ENABLED_NETWORKS`.

## Documentation

- [Hosting your own facilitator](./docs/hosting.md)
- [OpenAPI specification](./docs/openapi.yaml)
- [Operations runbook](./docs/runbook.md)
- [Threat model](./docs/threat-model.md)

## Related projects

- [jpyc-ec-platform](https://github.com/Mameta29/jpyc-ec-platform) — JPYC EC platform; first integration of this facilitator.
- [coinbase/x402](https://github.com/coinbase/x402) — the protocol specification.

## License

MIT — see [LICENSE](./LICENSE).
This project is independent of and not affiliated with JPYC株式会社 or Coinbase.
