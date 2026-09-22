import { describe, expect, it, vi } from "vitest"
import { createPublicClient, custom, numberToHex } from "viem"
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
