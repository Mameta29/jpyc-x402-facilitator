# Operations runbook

## Top-up relayer wallets

> **Note**: when the facilitator is co-located with the JPYC EC Platform and
> reuses the EC's `EXECUTOR_PRIVATE_KEY`, this is the same operational task
> as the EC's existing relayer top-up. There is no separate facilitator
> wallet to track — both services share one funded address per chain.

The balance monitor logs to stdout when a wallet drops below
`RELAYER_BALANCE_LOW_NATIVE`, and refuses settlement when below
`RELAYER_BALANCE_CRITICAL_NATIVE`. To top up:

1. Identify the relayer address per chain. `GET /supported` returns the
   addresses under `signers["eip155:*"]`. For shared-wallet deployments this
   matches the EC platform's `EXECUTOR_PRIVATE_KEY` address.
2. Send native gas from a hot/operations wallet:
   - Polygon: POL
   - Ethereum: ETH
   - Avalanche: AVAX
   - Kaia: KAIA
   - Arc: USDC (Arc uses USDC as native gas)
3. The next balance refresh (60s by default) will clear the critical flag.

## Stuck transactions

`transferWithAuthorization` is idempotent at the contract level (nonce becomes
used). If a tx is stuck pending:

1. Check the `settlements` table — is the row in `verified` or `settling`?
2. If it has been >5 min and the original tx hasn't mined, re-issue with a
   higher gas price using your wallet tooling. Update the `settlements` row's
   `tx_hash` to match.

## Replaying a missed settlement

Customers occasionally retry the same authorization after the resource server
already settled it. The facilitator returns `200 success=true` with the
original `tx_hash` for any `(chainId, payer, nonce)` it has already settled —
no on-chain action.

## Migrating the schema

Migrations live in `packages/facilitator/drizzle/`. Always run them with
`pnpm --filter @jpyc-x402/facilitator db:migrate` against a backup of
production. The schema is small and additive; rollback is usually safe.

## Disaster recovery

The facilitator holds zero customer funds. The only state worth preserving is
the `settlements` table (audit trail) and the `relayer_wallet_health` table
(operational state). Both can be rebuilt from on-chain data in the worst case.

To restore service after a complete loss:

1. Provision new Postgres and apply migrations.
2. Re-fund relayer wallets.
3. Set `ENABLED_NETWORKS` to the smallest viable set, deploy, monitor.
4. Gradually re-enable additional chains.

## Incident: facilitator wallet compromised

The relayer wallet only spends gas — it cannot authorise transfers of customer
JPYC. Loss is bounded by the wallet's native balance. To rotate:

1. Generate a new private key, fund it.
2. Update `RELAYER_PRIVATE_KEY` (or `RELAYER_PRIVATE_KEY_<chainId>`) and
   redeploy.
3. Drain the old wallet to your treasury.
