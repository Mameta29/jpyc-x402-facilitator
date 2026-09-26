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

Sepolia; fixed MetaMask Manager/account; JPYC transfer and one-hop USDC→JPYC exact-output; Node durable settlement; existing EC orders; LINE primary and thin English Telegram/Web entry. No alternative transfer or mock verification is silently substituted.

## Acceptance evidence

Implementation in progress. No wallet permission, World login, Intercepta live screening, public-chain deployment, swap, or completed EC purchase is claimed by this document. Each will be recorded separately.

## External setup

World confidential-client registration, Intercepta API key, deployment manifest, and a dedicated testnet relayer must be configured through secrets, never pasted into chat or committed. Live credentials were not found in the inspected local configuration key names.

## Implemented: Node settlement

The Node host supports explicit `erc7710` + `jpyc.purchase` dispatch alongside EIP-3009. The fixed-origin HMAC resolver, pinned deployment code, full Gate simulation, event/Transfer receipt checks, and SQLite WAL/FULL journal are implemented. The journal commits nonce and unsigned fields before signing, and raw bytes/hash before broadcast. Recovery only rebroadcasts identical bytes; finalized records do not expire. A reserved nonce is consumed with the original transaction even if it has expired, avoiding gaps that block later orders. The Gate will revert expired execution.

134 existing shared/EVM/facilitator tests and six new persistence/restart tests pass. An actual local 7702 transaction with a deliberately lost send response was recovered after reopening SQLite, with one broadcast and exactly one payment. See `evidence/local-recovery.json`. This is not a live JPYC or sponsor-integration test.

Node 22.14+ is required (`node:sqlite` is experimental on Node 22). Use a persistent writable volume and a dedicated agent relayer key. Worker/DO support is intentionally disabled and not advertised. No public deployment has occurred.

Enable only with `AGENT_COMMERCE_ENABLED=true`, `AGENT_DEPLOYMENT_MANIFEST`, `AGENT_RELAYER_PRIVATE_KEY`, `AGENT_RPC_URL`, `AGENT_EC_ORIGIN`, `AGENT_EC_KEY_ID`, `AGENT_EC_HMAC_SECRET`, `AGENT_JOURNAL_PATH`, and existing `FACILITATOR_HMAC_KEYS`. The manifest must pin Gate, Manager, account implementation, adapter, enforcers, token proxy/implementation and router/factory code.
