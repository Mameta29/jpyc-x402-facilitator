/**
 * E2E test: real settle on Polygon Amoy testnet.
 *
 * Required env (skip the test if any are missing):
 *
 *   E2E_BUYER_PRIVATE_KEY     — funded with at least 1 wei JPYC on Amoy
 *   E2E_RELAYER_PRIVATE_KEY   — funded with native POL for gas
 *   E2E_SHOP_ADDRESS          — destination address (any 0x...)
 *   RPC_URLS_80002            — Amoy RPC; falls back to public RPC if absent
 *
 * The test signs a 1-wei JPYC `transferWithAuthorization` and broadcasts it
 * via the in-process facilitator, then verifies the on-chain Transfer event.
 */

import { describe, expect, it } from "vitest"
import {
  ExactEvmFacilitator,
  TRANSFER_EVENT_SIGNATURE,
  buildPublicClient,
  envRpcResolver,
  privateKeyRelayerProvider,
} from "@jpyc-x402/evm"
import { signPaymentPayload } from "@jpyc-x402/client"
import { createPaymentRequirements } from "@jpyc-x402/shared"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "viem"

const CHAIN_ID = 80002

const buyerKey = process.env.E2E_BUYER_PRIVATE_KEY as Hex | undefined
const relayerKey = process.env.E2E_RELAYER_PRIVATE_KEY as Hex | undefined
const shopAddress = process.env.E2E_SHOP_ADDRESS as Address | undefined

const haveAll = Boolean(buyerKey && relayerKey && shopAddress)

describe.skipIf(!haveAll)("E2E: Polygon Amoy real settle", () => {
  it("signs 1 wei JPYC and settles on-chain via the facilitator", async () => {
    const buyer = privateKeyToAccount(buyerKey!)
    const facilitator = new ExactEvmFacilitator({
      enabledChainIds: [CHAIN_ID],
      rpcResolver: envRpcResolver(),
      signerProvider: privateKeyRelayerProvider({
        defaultPrivateKey: relayerKey!,
      }),
    })

    const requirements = createPaymentRequirements({
      chainId: CHAIN_ID,
      amountAtomic: "1",
      payTo: shopAddress!,
      maxTimeoutSeconds: 120,
    })
    const payload = await signPaymentPayload({ signer: buyer, requirements })

    const verify = await facilitator.verify(payload, requirements)
    expect(verify.ok).toBe(true)

    const result = await facilitator.settle(payload, requirements)
    expect(result.verify.ok).toBe(true)
    expect(result.settle?.ok).toBe(true)

    if (result.settle?.ok) {
      const publicClient = buildPublicClient(CHAIN_ID, envRpcResolver())
      const receipt = await publicClient.getTransactionReceipt({
        hash: result.settle.txHash,
      })
      expect(receipt.status).toBe("success")
      const transferLog = receipt.logs.find(
        (log) =>
          log.topics[0] === TRANSFER_EVENT_SIGNATURE &&
          log.address.toLowerCase() === requirements.asset.toLowerCase(),
      )
      expect(transferLog).toBeDefined()
    }
  })
})
