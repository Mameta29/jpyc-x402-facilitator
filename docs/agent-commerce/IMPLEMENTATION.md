# ETHGlobal Tokyo agent commerce implementation

Started 2026-09-26 at the user’s explicit request. Design 35 is the architecture; review 36 defines the first delivery slice.

## Baseline and provenance

- Base commit: `9fa9cb121acbd6535ccc9e55f76d9a98f2914e73`.
- Branch: `ETHGlobalTokyo2026`, in an isolated worktree.
- Original working trees are preserved. Existing uncommitted changes were **not** automatically imported.
- Design 35/36, interfaces, and signature fixtures predate implementation; the first EC documentation commit imports that baseline only.
- Local inventory of pre-existing edits and patches: `/private/tmp/ethtokyo-agent-commerce-baseline`.
- AI assistance: Codex implements and tests the user’s chosen architecture.

## First delivery slice

Polygon PoS mainnet (137) for device/public-chain acceptance; fixed MetaMask Manager/account; JPYC transfer and one-hop USDC→JPYC exact-output; Node durable settlement; existing EC orders; LINE primary and thin English Telegram/Web entry. No alternative transfer or mock verification is silently substituted.

## Acceptance evidence

The first delivery slice is implemented with local automated tests and two EC merchant orders on a Polygon fork. Real MetaMask permission acceptance, live World/Intercepta, public deployment and public-chain purchases remain unverified. The user will perform the MetaMask device check later. See [runtime/deployment instructions](./POLYGON.md); local/fork results are not public purchase evidence.

## External setup

World confidential-client registration, Intercepta API key, deployment manifest, and a dedicated Polygon agent relayer must be configured through secrets, never pasted into chat or committed. Live credentials were not found in the inspected local configuration key names.

## Implemented: Node settlement

The Node host supports explicit `erc7710` + `jpyc.purchase` dispatch alongside EIP-3009. The fixed-origin HMAC resolver, pinned deployment code, full Gate simulation, event/Transfer receipt checks, and SQLite WAL/FULL journal are implemented. The journal commits nonce and unsigned fields before signing, and raw bytes/hash before broadcast. Recovery only rebroadcasts identical bytes; finalized records do not expire. A reserved nonce is consumed with the original transaction even if it has expired, avoiding gaps that block later orders. The Gate will revert expired execution.

134 existing shared/EVM/facilitator tests and six new persistence/restart tests pass. An actual local 7702 transaction with a deliberately lost send response was recovered after reopening SQLite, with one broadcast and exactly one payment. See `evidence/local-recovery.json`. This is not a live JPYC or sponsor-integration test.

Node 22.14+ is required (`node:sqlite` is experimental on Node 22). Use a persistent writable volume and a dedicated agent relayer key. Worker/DO support is intentionally disabled and not advertised. No public deployment has occurred.

Enable only with `AGENT_COMMERCE_ENABLED=true`, `AGENT_DEPLOYMENT_MANIFEST`, `AGENT_RELAYER_PRIVATE_KEY`, `AGENT_RPC_URL`, `AGENT_EC_ORIGIN`, `AGENT_EC_KEY_ID`, `AGENT_EC_HMAC_SECRET`, `AGENT_JOURNAL_PATH`, and existing `FACILITATOR_HMAC_KEYS`. The manifest must pin Gate, Manager, account implementation, adapter, enforcers, token proxy/implementation and router/factory code.

## Owner-signed lifecycle relay

Authenticated `POST /agent/gate-action` accepts only typed register/update/revoke/cancel requests signed by the account owner; the target is the pinned Gate, with zero native value and a maximum five-minute deadline. It uses the purchase journal's same atomic nonce allocator, records signed bytes before broadcast, and verifies the corresponding Gate event. `POST /agent/gate-action-status` takes `actionId`. It never accepts a request URL, target address or arbitrary calldata.

Local real-chain integration now also recovers a policy update and revoke after accepted-but-lost RPC responses and SQLite restart. Both preserve their original hash, the policy is revoked on chain, and period spending survives the version update. Six HTTP dispatch tests verify authentication, body size, strict method dispatch, unsupported-runtime rejection and unknown/pending semantics. Protocol tarball 0.1.2 is pinned with source commit and SHA-256 in `vendor/agent-commerce-source.json`.

Deployment checks follow the Gate's actual immutable dependencies to require validator, seven enforcers, router and factory code pins. Both Polygon and Sepolia require both token proxy implementation pins. Each entry supports an explicit `slot`; JPYC uses the EIP-1967 default. Circle's [FiatToken proxy implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol) uses `0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3`. Deployment tooling must verify the actual chain slot/code before saving a manifest.

## Polygon device target, 2026-09-26

The user explicitly selected Polygon PoS mainnet (`137`, `0x89`, `eip155:137`); this overrides the Sepolia-only acceptance wording in design 35. Local and Sepolia evidence remains development evidence. The ordinary business budget OR a fresh, registered-person, exact-order World/H exception is unchanged, including period-budget overruns. Expiry, revoke, tampering and replay remain non-overridable. Polygon fork swaps do not establish MetaMask permission acceptance or a completed public purchase. See the root `HANDOFF-polygon-device-test-2026-09-26.md`.

## Polygon fork integration (local only)

The pinned Polygon fork passed nine Gate checks using the deployed JPYC (18 decimals), native USDC (6 decimals), Uniswap router/pool and official MetaMask contracts. A 9,000 JPYC ordinary purchase succeeded; a further 2,000 JPYC was rejected with `HumanApprovalRequired`, then succeeded with an order-specific test H signature and atomic USDC funding. The ledger remained 11,000; the net USDC debit matched the owner's balance and unused input was refunded. Replay and direct Manager bypass were rejected. Fork token provisioning used impersonated administrators **only on loopback Anvil**. No public writes occurred.

Nine cross-repository checks also passed: the facilitator recovered the exact original transaction after a deliberately lost send response and a SQLite restart, paid once, then recovered owner-signed policy update/revoke through the same durable nonce lane. These results use manually signed test parents and M/R/P/H attestations. They do not establish wallet 7715, World, Intercepta, independent live price, EC order completion or public deployment acceptance.

Public deployment manifests now require the configured relayer address to match. Four deployment tests include absent/mismatched relayers; 58 EVM and six Node server tests pass after the protocol update. See [Polygon operation instructions](./POLYGON.md) and `evidence/polygon-fork-recovery.json`.

## Final local verification

167 tests pass across shared (41), EVM (58), HTTP facilitator (46) and Node (22); the complete workspace builds. Node startup adds Polygon-only production manifests, fixed HTTPS transports, HMAC configuration checks and test-only loopback exceptions. The Docker dependency/runtime stages now contain the protocol tarball; environment files and SQLite state are excluded from the image context. Docker image execution is pending because no daemon is available in this environment.

[EC flow evidence](./evidence/polygon-ec-flow.json) records the isolated signer, this durable runner, two finalized merchant orders, fresh controlled World approval of a period exception, actual fork USDC swap/refund and recovery after both lost RPC response and rolled-back EC persistence. Risk refusal releases inventory without a send; owner update retains 11,000 JPYC spending, and owner revoke stops the policy. Parents/IdP/Intercepta/price HTTP remain controlled fixtures.

A repeated integration run found that a long-running local Anvil rejected finalized nonce reads with `BlockOutOfRangeError`; the runner left the already stored raw transaction pending and did not broadcast. Recreating the pinned fork with explicit `--prune-history 2048` and writable `--cache-path` made the complete test pass again. No production finality check was weakened. EC's `docs/agent-commerce/OPERATIONS.md` records the reproducer.
