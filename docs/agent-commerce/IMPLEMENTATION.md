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
