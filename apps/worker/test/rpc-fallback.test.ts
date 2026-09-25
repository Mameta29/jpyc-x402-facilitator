import { fetchMock } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { buildPublicClient } from "@jpyc-x402/evm"
import { workerRpcResolver } from "../src/rpc"
import type { WorkerEnv } from "../src/env"

const config = {
  NODE_ENV: "staging", RPC_URLS_11155111: "https://private.invalid/provider",
  STAGING_SEPOLIA_PUBLIC_RPC_FALLBACK: "true",
} as WorkerEnv

describe("staging RPC fallback", () => {
  it("uses a second provider after the configured provider returns HTTP 429", async () => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    fetchMock.get("https://private.invalid").intercept({ path: "/provider", method: "POST" }).reply(429, "rate limited")
    fetchMock.get("https://ethereum-sepolia-rpc.publicnode.com").intercept({ path: "/", method: "POST" })
      .reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }), { headers: { "content-type": "application/json" } })
    try {
      expect(await buildPublicClient(11155111, workerRpcResolver(config)).getChainId()).toBe(11155111)
      fetchMock.assertNoPendingInterceptors()
    } finally { fetchMock.deactivate() }
  })

  it("keeps configured production providers unchanged even if the flag is set", () => {
    expect(workerRpcResolver({ ...config, NODE_ENV: "production" })(11155111).urls).toEqual(["https://private.invalid/provider"])
  })

  it("does not change other chains or duplicate an existing public fallback", () => {
    expect(workerRpcResolver({ ...config, RPC_URLS_1001: "https://kairos.invalid" })(1001).urls).toEqual(["https://kairos.invalid"])
    expect(workerRpcResolver({ ...config, RPC_URLS_11155111: "https://ethereum-sepolia-rpc.publicnode.com" })(11155111).urls).toHaveLength(1)
  })
})
