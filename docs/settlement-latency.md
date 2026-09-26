# Settlement latency and durable admission rejection

The `fix/settlement-latency-20260925` change targets staging Kairos and Sepolia. Keep the existing Durable Object namespace and exclusive sender accounts. No new wallets, migrations, or mainnet activation are required.

## Independent notification delivery

The previous alarm mixed merchant callbacks with receipt polling in one 24-entry, four-worker queue. A receipt wait occupied slots even after other payments had already been mined. In the 2026-09-25 Sepolia 60-payment staging run, the median block-to-first-notification interval was 33.068 seconds; this is separate from inclusion time.

Receipt checks now use one read per hash and retain canonical-block / Transfer / AuthorizationUsed validation. The alarm checks up to 64 rows with eight workers. Terminal callbacks use a separate `notify:` index, a single bounded pump per object, eight workers and at most 64 claims per pump. Confirmation persists the notification obligation before starting background delivery. Delivery attempts use a 15-second crash lease and retry after 1, 2, 4, 8, then up to 15 seconds. Old terminal `due:` entries migrate in place when processed.

`notificationStartedAt` is the first attempt, and `notificationAcknowledgedAt` is the eventual acknowledgement. Both are diagnostic timestamps; neither proves a token transfer. The signed callback includes allow-listed settlement timing, while EC independently verifies the chain evidence before recording an order.

## Safe early rejection

If verification has established signature validity locally but RPC verification fails, or transaction preparation fails, `rejectBeforeBroadcast` atomically arbitrates admission against the transaction journal:

- If a signed transaction is already stored, return its hash. An HTTP timeout never means unpaid.
- Otherwise, persist `closed:settle:<payer>:<nonce>`, bound to the complete signed authorization fingerprint, before returning `jpyc.submissionRejection`.
- Preparation checks the closure in the same storage transaction that allocates the sender nonce and saves signed bytes. A delayed concurrent preparation cannot pass the closure.
- `/settle-status` exposes the same closure after an HTTP response is lost. A missing record without this proof remains unknown.
- Only a matching authenticated proof with no transaction hash permits EC to mark the attempt failed and request a fresh approval. The proof closes this service's intake; it is not on-chain signature cancellation.

Legacy chains do not issue this proof. Signatures, raw transactions and provider URLs are excluded from returned errors and diagnostics. Closures are retained, as are unresolved transaction records.

## Deployment and rollback

Deploy only to staging, retaining namespace `7df3e8bdfcb34b83ab488ce52475b512`. Then deploy the EC receiver and compare actual staging metrics. Local concurrency tests are not a network-latency benchmark.

Once a closure has been issued, **do not roll back to a version that ignores `closed:`** while any such authorization remains valid. Keep the gate in a corrective deployment. A legacy rollback requires stopping intake and confirming expiry of all affected authorizations on chain first. Retain the namespace, transaction journal and recovery alarms; deleting state can permit stale requests or strand unresolved transactions.

## Tests

- 64 blocked receipt rows do not block notification of a separate confirmed row.
- 64 callbacks are delivered with at most eight concurrent requests.
- A failed preparation wins against a delayed parallel preparation without allocating a nonce or sending.
- Lost broadcast response never produces an unpaid proof.
- Worker and EC match a shared signed-authorization hash fixture.
- EC integration tests cover new-approval issuance, old-approval rejection, callback wakeup and active-lease protection.

Physical wallet switching and actual testnet timing require the staging rerun; no production latency guarantee is implied.
