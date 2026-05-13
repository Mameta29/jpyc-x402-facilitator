# @jpyc-x402/e2e

End-to-end tests that broadcast real transactions to public testnets.

These tests **never** run in the default `pnpm test` cycle. They run:

- on-demand via `pnpm test:e2e`, when the required env vars are set
- nightly in CI via `.github/workflows/e2e-testnet.yml`

If env vars are missing the test suite skips with a clear `describe.skipIf`
banner — it doesn't fail.

## Required env vars

```env
E2E_BUYER_PRIVATE_KEY=0x...      # holds JPYC on Amoy
E2E_RELAYER_PRIVATE_KEY=0x...    # holds native POL for gas
E2E_SHOP_ADDRESS=0x...           # arbitrary recipient
RPC_URLS_80002=https://...       # optional; falls back to public Amoy RPC
```

## Funding the test wallets

JPYC on Polygon Amoy is `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`. Send
the buyer wallet a few JPYC (at least the `amount` in the test, currently
1 wei) and the relayer wallet ~0.1 POL. The test only spends 1 wei JPYC
per run so a few cents goes a long way.

Public POL faucet for Amoy:
- https://faucet.polygon.technology/
