# Operations runbook

Reference for operating a JPYC x402 facilitator in production. Applies to
both the Cloudflare Workers deployment (`apps/worker`) and the Node
deployment (`apps/server`).

---

## Top-up relayer wallet

> When the facilitator is co-located with the JPYC EC Platform and reuses
> the EC's `EXECUTOR_PRIVATE_KEY`, this is the same operational task as the
> EC's existing relayer top-up. There is no separate wallet to track.

The in-memory balance cache logs to stdout when a wallet drops below
`RELAYER_BALANCE_LOW_NATIVE` (default 0.05) and refuses settlement when
below `RELAYER_BALANCE_CRITICAL_NATIVE` (default 0.005). To top up:

1. Identify the relayer address. `GET /supported` returns it under
   `signers["eip155:*"]`. For shared-wallet deployments this matches the
   EC platform's `EXECUTOR_PRIVATE_KEY` address.
2. Send native gas from a hot/operations wallet:
   - Polygon: POL
   - Ethereum: ETH
   - Avalanche: AVAX
   - Kaia: KAIA
   - Arc: USDC (Arc uses USDC as native gas)
3. The next balance refresh (60 s on both apps) will clear the critical flag.

---

## Stuck transactions

`transferWithAuthorization` is idempotent at the contract level — once the
nonce is consumed, future broadcasts of the same authorization revert. If
a tx is stuck pending for >5 min:

1. Tail the facilitator logs (`pnpm wrangler tail` or your platform's
   stream) to find the broadcast event for that order.
2. If the tx has not mined, re-issue with a higher gas price using your
   wallet tooling. The next legitimate settle on the same chain will
   acquire the next nonce automatically.
3. The original `(payer, nonce)` is still valid because the on-chain
   `_authorizationStates[payer][nonce]` was never set to true.

---

## Replayed authorizations

Customers and AI agents occasionally retry the same authorization. The
facilitator's in-memory `NonceCache` short-circuits replays within a 5-min
window — the second `/settle` returns `success: true` with the cached tx
hash without touching RPC.

If the replay arrives after the cache window, the contract layer takes
over: the second broadcast reverts with `FiatTokenV2: authorization is
used` (or equivalent). The facilitator surfaces this as
`success: false, errorReason: invalid_transaction_state`. Cost: one
revert worth of gas, no double-spend, no money moved twice.

---

## Workers: runtime issues

**DO not responding**: `wrangler tail --env production`. If the DO
exceeded the 30 s `blockConcurrencyWhile` budget, the DO was reset and
the next request rebuilds it cleanly. We split broadcast (in the lock)
from receipt waiting (out of the lock) precisely to prevent this — if it
fires, suspect a hung RPC.

**Cron not refreshing balance**: check the Cloudflare dashboard's
"Triggers" tab. Re-deploy if the cron pattern changed. You can manually
fire one with `curl https://facilitator.jpyc-service.com/__scheduled` if
running `wrangler dev --test-scheduled` locally.

---

## Node: runtime issues

**Mutex stuck**: the Node app uses a per-chain mutex inside
`InProcessSettleRunner`. If a settle hangs, the mutex resolves on
process restart. Set a sensible health-check timeout in your platform.

**Memory growth**: the in-memory `NonceCache` and `RateLimiter` GC lazily
when their internal maps exceed thresholds. If you somehow hit
unprecedented per-payer cardinality (>10k unique payers in 5 min), they
sweep on next access.

---

## Migrating from Postgres-backed (legacy)

Older snapshots of this repo had a `packages/facilitator/src/db/`
directory backed by Drizzle + Postgres. That layer was removed in
favour of in-memory state because:

1. Coinbase's reference facilitator (`coinbase/x402/examples/typescript/facilitator/basic`) is DB-free.
2. EIP-3009 enforces replay protection on-chain; a DB UNIQUE was redundant.
3. Audit trails belong in log aggregators (Workers Logs, Axiom, etc.), not
   in a Postgres table that nobody queries.

If you forked an older version and want to migrate:

1. Drop the `settlements`, `rate_limit_buckets`, `relayer_wallet_health`
   tables. Keeping them does no harm; they're just unused.
2. Update your `.env`: remove `DATABASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`.
3. Pull and redeploy.

---

## Disaster recovery

The facilitator holds **zero customer funds**. The only durable state worth
preserving is the **logs** (audit trail). Both can be rebuilt from
on-chain data in the worst case (`Transfer` events on the JPYC contract
indexed by relayer address).

To restore service after a complete loss:

1. Provision a new Worker / Node instance.
2. Re-fund the relayer wallet (or rotate to a new key).
3. Set `ENABLED_NETWORKS` to the smallest viable set, deploy, monitor.
4. Gradually re-enable additional chains.

No database to restore. No migrations to run.

---

## Incident: facilitator wallet compromised

The relayer wallet only spends native gas — it cannot authorise transfers
of customer JPYC. Loss is bounded by the wallet's native balance.

To rotate:

1. Generate a new private key, fund it with native gas on each chain.
2. Update `RELAYER_PRIVATE_KEY` in the platform's secret store
   (`wrangler secret put RELAYER_PRIVATE_KEY --env production` or your
   Render/Fly secret UI).
3. Re-deploy.
4. Drain the old wallet to your treasury.

If the compromised wallet was shared with `EXECUTOR_PRIVATE_KEY` on the
EC platform, rotate both at the same time.
