# Threat model

The x402 facilitator is a public, internet-facing service that broadcasts
signed messages on behalf of users. This document enumerates the threats we
explicitly defend against and the ones we accept.

## Defended

### Signature forgery
- Every `verify` recovers the EIP-712 signature against the embedded
  authorization and rejects mismatched recoveries.
- The token contract independently re-verifies on-chain; a bypass at the
  facilitator does not result in funds moving.

### Replay attacks
- **Authoritative**: EIP-3009 marks the nonce as used in
  `_authorizationStates` on the token contract; a second broadcast reverts
  with no fund movement.
- **Optimisation**: an in-memory `NonceCache` (5-min TTL) short-circuits
  retries within the cache window without touching RPC. The cache is
  best-effort — losing it (process restart, isolate eviction) costs at
  most one revert worth of gas, never correctness.

### Front-running
- A malicious node that sees a pending tx can't change it; the authorization
  signs `(from, to, value, validAfter, validBefore, nonce)`. They could
  broadcast it themselves but that doesn't harm the payer or recipient — it
  just spends our gas. Mitigated by the rate limiter.

### Resource exhaustion
- Per-payer rate limit (request count + JPYC value cap) enforced via
  in-memory rolling-window buckets per process.
- Per-chain RPC fallback prevents one bad endpoint from saturating the
  request queue.
- Relayer wallets refuse to settle when below critical native balance.

### Stale RPC / chain reorgs
- We wait for `transferReceipt.status === "success"` and re-verify the
  Transfer event in the receipt before declaring success.
- Reorgs deeper than 1 block on supported chains are rare; if they happen the
  authorization can be re-broadcast (nonce on-chain rolls back too).

## Accepted

### Lost gas on failed broadcasts
- If verify passes but settle fails (network glitch, gas spike), the relayer
  wallet pays gas with no token transfer. Cost is bounded by gas-per-tx and
  the rate limiter; we accept it as the cost of providing the service.

### Censorship by RPC providers
- A colluding RPC provider could refuse to broadcast specific txs. We
  mitigate with multi-RPC fallback. Mainnet is sufficiently decentralised
  that a fully successful censorship attack would require coordinated
  takedowns across providers.

### Denial-of-service on the public endpoint
- We rely on the hosting provider's WAF / Anycast for layer-3/4 protection.
  Application-layer DDoS that gets past the WAF is rate-limited per payer;
  unauthenticated reflection (`GET /supported`) is cheap and cacheable at
  the edge.

### Operator key compromise
- The relayer wallet only spends gas; loss is bounded by its native balance.
  See runbook for rotation procedure.

## Out of scope

- Browser/wallet phishing of the payer. The facilitator only sees signed
  authorizations; UX-layer protections live in the resource server's UI.
- Resource server fraud (asking for more JPYC than the goods are worth). The
  payer must inspect the `accepts[]` block before signing — not our problem.
- JPYC contract bugs. We treat the JPYC contract as authoritative.
