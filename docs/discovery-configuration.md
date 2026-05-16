# x402 Bazaar Discovery Configuration

The facilitator can expose an **x402 Bazaar discovery layer** at
`GET /discovery/resources`, letting AI agents and clients enumerate the
x402-payable resources this facilitator fronts (e.g. a JPYC EC checkout
endpoint).

This document explains how to configure that catalog.

## TL;DR

`X402_DISCOVERY_RESOURCES` is **not a URL**. It is a JSON string — an array
of `DiscoveryResource` objects. Set it as an env var (Node) or a
var/secret (Workers). If it is absent or malformed, discovery is simply
disabled and `verify` / `settle` are unaffected.

## Why a static catalog

This facilitator is **DB-free** by design. The CDP Bazaar populates its
catalog dynamically from observed settlements; we have no datastore to do
that. Instead the catalog is **declared up front** via configuration. For a
single-tenant deployment (one facilitator fronting one EC platform) this is
both sufficient and simpler — the catalog rarely changes.

## The `X402_DISCOVERY_RESOURCES` variable

A JSON array. Each element is a `DiscoveryResource`
(`packages/shared/src/schemas.ts`, `discoveryResourceSchema`):

| Field | Type | Required | Meaning |
| ----- | ---- | -------- | ------- |
| `resource` | string | ✅ | The monetized endpoint URL (the x402-payable resource) |
| `type` | `"http"` | ✅ | Protocol designation; only `"http"` is supported |
| `x402Version` | `2` | ✅ | x402 protocol version (must be `2`) |
| `accepts` | array | ✅ | One or more `PaymentRequirements` the resource accepts (one per supported chain) |
| `lastUpdated` | string | ✅ | ISO 8601 timestamp of the last catalog refresh |
| `metadata` | object | optional | `description` + Bazaar `inputSchema` / `outputSchema` (JSON Schema) |

Each `accepts[]` entry is a `PaymentRequirements`:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `scheme` | `"exact"` | Payment scheme |
| `network` | string | CAIP-2 network id, e.g. `eip155:137` |
| `amount` | string | Atomic-unit amount (18 dp for JPYC). For a catalog entry this is a representative / minimum price |
| `asset` | string | ERC-20 contract address (the JPYC token on that chain) |
| `payTo` | string | Recipient address |
| `maxTimeoutSeconds` | number | Authorization validity window |
| `extra` | object | `{ assetTransferMethod: "eip3009", name, version, decimals?, symbol? }` — EIP-712 domain info for the asset |

Validation: the value is parsed by `parseDiscoveryConfig()`
(`packages/facilitator/src/discovery-config.ts`) against the zod schema.
Invalid JSON or a schema mismatch is **logged and treated as "discovery
disabled"** — it never crashes the host.

## Example

A catalog with one resource — the JPYC EC checkout on Polygon:

```json
[
  {
    "resource": "https://ec.jpyc-service.com/api/v1/checkout",
    "type": "http",
    "x402Version": 2,
    "accepts": [
      {
        "scheme": "exact",
        "network": "eip155:137",
        "amount": "100000000000000000000",
        "asset": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
        "payTo": "0x0000000000000000000000000000000000000000",
        "maxTimeoutSeconds": 300,
        "extra": {
          "assetTransferMethod": "eip3009",
          "name": "JPY Coin",
          "version": "1",
          "decimals": 18,
          "symbol": "JPYC"
        }
      }
    ],
    "lastUpdated": "2026-05-16T00:00:00Z",
    "metadata": {
      "description": "JPYC EC Platform checkout — buy producer-direct goods (rice, sake, crafts) with the JPYC stablecoin via x402."
    }
  }
]
```

Notes on the example:

- `payTo` in a catalog entry is informational. The real recipient is set
  per-order in the live `PAYMENT-REQUIRED` challenge; the all-zero address
  above is a placeholder. Use the platform/shop wallet if you want a
  meaningful value.
- `amount` for a catalog entry is representative — actual per-order amounts
  are computed at checkout time. Use a minimum/typical price.
- Add one `accepts[]` entry per chain the resource supports (e.g. another
  with `"network": "eip155:1"` for Ethereum mainnet).

## Setting the variable

### Node host (`apps/server`)

Set `X402_DISCOVERY_RESOURCES` in the environment. The JSON must be a single
line (or a properly escaped multi-line value):

```bash
export X402_DISCOVERY_RESOURCES='[{"resource":"https://ec.jpyc-service.com/api/v1/checkout","type":"http","x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:137","amount":"100000000000000000000","asset":"0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29","payTo":"0x0000000000000000000000000000000000000000","maxTimeoutSeconds":300,"extra":{"assetTransferMethod":"eip3009","name":"JPY Coin","version":"1","decimals":18,"symbol":"JPYC"}}],"lastUpdated":"2026-05-16T00:00:00Z","metadata":{"description":"JPYC EC checkout"}}]'
```

### Workers host (`apps/worker`)

Either a var in `wrangler.jsonc` or a secret:

```bash
# As a secret (recommended for a long JSON payload):
wrangler secret put X402_DISCOVERY_RESOURCES
# then paste the JSON array when prompted
```

## Verifying

Once configured:

```bash
# The discovery extension is advertised in /supported
curl -s https://<facilitator-host>/supported | jq '.extensions'
# → ["bazaar"]

# The catalog itself
curl -s https://<facilitator-host>/discovery/resources | jq .
# → { "x402Version": 2, "items": [...], "pagination": { "limit": 100, "offset": 0, "total": 1 } }
```

`/discovery/resources` supports `?limit=` and `?offset=` query parameters
(limit clamped to 1–1000, default 100).

If `X402_DISCOVERY_RESOURCES` is unset, `/supported` reports
`"extensions": []` and `/discovery/resources` returns an empty `items`
array — both are valid, non-error states.
