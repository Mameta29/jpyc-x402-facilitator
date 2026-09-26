import { describe, expect, it, vi } from "vitest"
import { createPublicClient, createWalletClient, custom, numberToHex, parseTransaction } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { polygon, avalanche, kaia } from "viem/chains"
import { resolveViemChain } from "./viem-chains.js"

function client(chainId: number, priority: bigint | Error) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x1",
        hash: `0x${"ab".repeat(32)}`,
        baseFeePerGas: "0x3b9aca00",
        timestamp: "0x1",
        transactions: [],
      }
    if (method === "eth_maxPriorityFeePerGas") {
      if (priority instanceof Error) throw priority
      return numberToHex(priority)
    }
    if (method === "eth_gasPrice") return "0x3b9aca00"
    throw new Error(`Unexpected ${method}`)
  })
  return {
    rpc: createPublicClient({
      chain: resolveViemChain(chainId),
      transport: custom({ request }, { retryCount: 0 }),
    }),
    request,
  }
}

describe("Ethereum payment fees", () => {
  it.each(
    [1, 11155111].flatMap((chainId) =>
      [0n, 1_000_000n, 3_000_000_000n].map((tip) => ({ chainId, tip })),
    ),
  )(
    "enforces the floor in the signed transaction when RPC fills fees ($chainId, $tip)",
    async ({ chainId, tip }) => {
      const account = privateKeyToAccount(`0x${"01".repeat(32)}`)
      let signed: ReturnType<typeof parseTransaction> | undefined
      const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_fillTransaction")
          return {
            raw: "0x",
            tx: {
              type: "0x2",
              chainId: numberToHex(chainId),
              nonce: "0x0",
              gas: "0x186a0",
              from: account.address,
              to: `0x${"22".repeat(20)}`,
              input: "0x",
              value: "0x0",
              maxPriorityFeePerGas: numberToHex(tip),
              maxFeePerGas: numberToHex(4_000_000_000n),
            },
          }
        if (method === "eth_sendRawTransaction") {
          signed = parseTransaction(params![0] as `0x${string}`)
          return `0x${"ab".repeat(32)}`
        }
        throw new Error(`Unexpected ${method}`)
      })
      const wallet = createWalletClient({
        account,
        chain: resolveViemChain(chainId),
        transport: custom({ request }, { retryCount: 0 }),
      })
      await wallet.sendTransaction({ to: `0x${"22".repeat(20)}`, value: 0n })
      const expectedTip = tip < 100_000_000n ? 100_000_000n : tip
      expect(signed?.maxPriorityFeePerGas).toBe(expectedTip)
      // The provider cap is multiplied by the chain setting; retain that
      // headroom when raising the tip, without an extra RPC round trip.
      expect(signed?.maxFeePerGas).toBe(8_000_000_000n + expectedTip - tip)
      expect(request.mock.calls.map(([r]) => r.method)).toEqual([
        "eth_fillTransaction",
        "eth_sendRawTransaction",
      ])
    },
  )
  it.each([1, 11155111])(
    "keeps zero RPC tips from leaving short-lived authorizations waiting on chain %s",
    async (chainId) => {
      const { rpc, request } = client(chainId, 0n)
      const fees = await rpc.estimateFeesPerGas()
      expect(fees.maxPriorityFeePerGas).toBe(100_000_000n)
      expect(fees.maxFeePerGas).toBe(2_100_000_000n)
      expect(
        request.mock.calls.filter(([arg]) => arg.method === "eth_maxPriorityFeePerGas"),
      ).toHaveLength(1)
    },
  )
  it("preserves a higher live priority estimate", async () => {
    expect((await client(1, 3_000_000_000n).rpc.estimateFeesPerGas()).maxPriorityFeePerGas).toBe(
      3_000_000_000n,
    )
  })
  it("also applies the floor when the provider falls back to gas price minus base fee", async () => {
    expect(
      (await client(1, new Error("method unavailable")).rpc.estimateFeesPerGas())
        .maxPriorityFeePerGas,
    ).toBe(100_000_000n)
  })
  it.each([polygon, avalanche, kaia])(
    "preserves the other networks' native fee policies ($id)",
    (chain) => {
      expect(resolveViemChain(chain.id)).toBe(chain)
    },
  )
})
