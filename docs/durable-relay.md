# Durable checkout relay (2026-09-24)

Implemented on `fix/payment-durable-lifecycle-20260924`, with staging rollout fixes
on `fix/staging-payment-measurement-20260925`. Kairos and Sepolia are deployed to
staging; see [real load measurements](staging-load-20260925.md). Production is unchanged.

## Invariants

- One Durable Object per chain (`chain-${chainId}`) is the exclusive writer of that chain's configured relayer account. Nonce cursors also identify the signer. The EC refund/subscription relayer, scripts, and other services **must use different accounts**. Do not deploy a nonce journal around an account with independent writers.
- Gas estimation and RPC nonce reads run outside the storage transaction. Only nonce allocation, local signing, raw transaction/hash persistence, and the next alarm commit together.
- Nothing broadcasts before that commit. On a lost broadcast response, the known hash and identical signed bytes remain available. Returning a hash means prepared; it does not assert network-wide mempool inclusion.
- Replays bind `(payer, authorization nonce)` to the full authorization fingerprint. Receipt verification matches the JPYC contract, payer, recipient, amount, AuthorizationUsed nonce, and canonical block hash. Zero-value transfers use the same checks.
- A `prepared`/`broadcast` record cannot be overwritten by a fresh authorization for that key. Late send/recovery results and notification acknowledgements cannot regress a newer confirmed observation.
- Unresolved records never expire. Indexed due keys avoid scanning the payment history.

## Bounded work

The due queue processes at most 24 records per alarm, with four concurrent checks. A due record is moved forward **before** RPC; interruption leaves a persisted retry. Young unresolved records retry after five seconds, then 30 seconds after five minutes, and five minutes after one hour. Merchant callback errors retry after 15 seconds. Cloudflare may deliver alarms late: these are earliest retry intervals, not timing guarantees.

New nonce allocation stops when the relayer has 128 unmined transactions on that chain (`durable next nonce - latest mined nonce`). Existing transactions continue being checked. Capacity rejection allocates no nonce and sends no transaction. The EC journal retries the same signed authorization while it is valid. This protects the queue; it is not an assertion that arbitrary transaction volume can complete within the signature window.

After 45 seconds, a pending transaction can be replaced with **the same nonce, calldata, amount and recipient**, changing only fees. Both old and replacement hashes are checked. At most three replacements, capped at four times the initial maximum gas price. Exceeding that budget leaves observation active and emits `settlement.needs_attention`. It never obtains another customer signature. All replacement bytes are also persisted before broadcast.

The synchronous path waits for a receipt for at most eight seconds (configured by the EC client) and returns immediately on a verified receipt. Alarm-based recovery runs independently of browser/HTTP lifetime. This uses canonical inclusion for positive EIP-3009 merchant acceptance, not Ethereum economic finality. A reverted receipt is observed until canonical finalized inclusion before the DO stops retrying; the EC independently uses finalized evidence before declaring an authorization unused or canceled.

## EC callback

`SETTLEMENT_NOTIFY_URL` is a fixed HTTPS deployment setting. `SETTLEMENT_NOTIFY_SECRET` is a distinct secret shared with the EC storefront in the **same environment**. Never reuse the facilitator authentication key. No URL from a shopper payload is fetched.

The JSON body is `{ chainId, payer, nonce, txHash, timestamp }`; `X-Settlement-Signature` is lowercase hex HMAC-SHA256 of the exact body. The EC accepts a five-minute clock window. No raw transaction or customer signature is transmitted by this callback. The endpoint independently checks the chain and writes the order; the callback alone is not payment evidence. HTTP 503 means retry, including when a different EC worker holds a recovery lease. HTTP 204 acknowledges a terminal result or a payment belonging to another integrator.

When callback configuration is absent, EC polling and cron still recover payments. Fast browser-independent EC finalization requires both callback settings. DO alarms resume notification after a process restart. Existing records without raw bytes remain readable during rolling deployment and use EC log recovery.

## Rollout

1. Verify relayer account isolation against every transaction writer (checkout, refunds, subscriptions, jobs and manual scripts). Native gas funding must be sufficient on every enabled chain. If accounts overlap, provision/fund a dedicated account before enabling this release. Do not merely declare a shared account exclusive.
2. Apply EC migrations 109 and 110. No historic settlement statuses are changed by these migrations.
3. Configure a different `SETTLEMENT_NOTIFY_SECRET` for staging and production, each identically in its Worker and storefront. The URL is set in `wrangler.jsonc`.
4. Deploy this Worker, then the corresponding EC branch. A not-yet-ready callback returns an error and remains queued. Preserve the existing DO namespace/migration binding and journal across deployments; never delete it to clear pending payments.
5. In staging, verify a normal payment, browser close after approval, lost send response, duplicate delivery, fee replacement, and a payment requiring stock/refund review. Measure wallet, server, chain, and order intervals separately. Confirm journal keys never leak through `/settle-status`.
6. Roll out production after those checks. If reverting code, preserve the new worker's journal/alarm support while it has unresolved records. Restoring the previous binary can stop its alarms; EC cron is a fallback, not a substitute for the raw-transaction journal.

All 27 local workerd tests pass, covering 64 concurrent allocations, storage rollback before broadcast, lost responses, backlog admission, legacy/EIP-1559 fee replacement budgets, acceptance of an earlier winning hash, finalized revert evidence, stale recovery races, and signed callback retries. Shared/EVM/facilitator builds and all four package type checks pass. The installed test runtime predates the requested compatibility date; a staging test on the actual Cloudflare runtime is still required. No real transfers or deployment are performed by these tests.
