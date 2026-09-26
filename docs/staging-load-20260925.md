# Real staging payment measurements — 2026-09-25

Code commit `514511e660ec8f33f4811983090db6f15ebc28a1` was deployed to
`jpyc-x402-facilitator-staging`, version `8484142b-f646-48db-8972-2163cef1df4f`.
Kairos (1001) and Sepolia (11155111) use the durable sender. Other staging
chains retain the old broadcast path. Production was not deployed.

Thirty unpublished test shops and thirty buyer wallets were provisioned.
Each checkout transfers 1 test JPYC using a real EIP-3009 signature. Quotes
were paced to respect the API limit; signed settle requests were submitted
concurrently. Wallet app interaction and browser rendering were not measured.
Default Worker placement was used. Staging config now explicitly matches this
measured profile; Tokyo-targeted placement is not covered by these numbers.

| Case | Settled | Submit → order median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Kairos, 60 simultaneous | 60/60 | 15.5 s | 17.8 s | 18.0 s |
| Sepolia, 30 before callback fix | 30/30 | 113.1 s | 129.0 s | 218.7 s |
| Sepolia, 30 after callback fix | 30/30 | 37.7 s | 49.1 s | 50.9 s |
| Sepolia, 60 before RPC fallback | 38/60 | 51.9 s* | 70.1 s* | 82.0 s* |
| Sepolia, 60 after RPC fallback | 60/60 | 82.0 s | 119.3 s | 122.7 s |

*Successful 38 payments only; this was a failed load test. Each row is a single
burst, not a statistically stable performance estimate. Order time is the DB
timestamp within the transaction, not exact COMMIT or UI display time.

Two real faults were found and fixed:

- workerd rejects `fetch` with `redirect: "error"` before sending a callback.
  `manual` now preserves the signed destination, acknowledges 2xx only, and
  retries redirects/5xx. Native fetch regression tests cover 204, 307 and 503.
- The configured Sepolia provider returned HTTP 429 under a 60-payment burst.
  An opt-in staging-only public fallback now applies to verification and DO
  sending. Native fetch tests reproduce failover after 429. Transport errors
  are no longer described as contract reverts; verification logs/responses no
  longer expose provider URLs or request bodies. Existing RPC credentials were
  neither exported nor re-registered.

Across all tests: 286 attempts, 264 settled, 22 conclusively failed, zero
unresolved. Successful receipts, unique transfers, order count, buyer balance
changes and inventory decrements agreed. Twelve duplicate deliveries across six
settled reservations returned the existing orders with no further debit. One
client connection was aborted after six seconds; the server completed the
order around nine seconds and subsequent retries returned that order.

The 22 failures are retained in the results. Seven entered an uncertain state
after RPC failure, and were automatically failed only after expiry and unused
authorization were established at a finalized block: about 20m38s–20m42s after
submission. No manual payment-state edits were made.

Remaining production gates: RPC capacity and independent providers, post-chain
order-recovery latency, and an authoritative not-broadcast outcome to shorten
negative-result waits. The Sepolia 60-payment result is still too slow to claim
production checkout readiness. One exclusive sender per chain was used;
multi-sender allocation/failover was not implemented or tested.

Validation: EVM 74 tests, Worker 37 tests (including native workerd fetch),
EVM build, Worker typecheck and Wrangler staging build passed. Live transfers
used testnets. This is not a claim that production load or wallet-app UX passed.
