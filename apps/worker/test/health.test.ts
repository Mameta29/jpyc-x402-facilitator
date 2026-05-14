/**
 * Smoke tests for the Worker entrypoint. Runs in workerd via vitest-pool-workers.
 *
 * We exercise the routes that don't touch RPC (so no testnet account / live
 * connectivity is required for CI):
 *
 *   - GET /health     → { ok: true }
 *   - GET /supported  → kinds[] for the configured ENABLED_NETWORKS
 *   - GET /           → meta info
 *
 * /verify and /settle are covered by the package-level tests in
 * @jpyc-x402/evm + @jpyc-x402/facilitator and the e2e suite under e2e/.
 */

import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

describe("Worker entrypoint", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch("http://example.com/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("GET /supported lists configured testnet kinds", async () => {
    const res = await SELF.fetch("http://example.com/supported")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kinds: { network: string }[]
      extensions: string[]
    }
    // wrangler.jsonc default vars set ENABLED_NETWORKS to the testnet list.
    expect(body.kinds.some((k) => k.network === "eip155:80002")).toBe(true)
  })

  it("GET / returns meta info including x402 version", async () => {
    const res = await SELF.fetch("http://example.com/")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { x402Version: number; name: string }
    expect(body.x402Version).toBe(2)
    expect(body.name).toBe("jpyc-x402-facilitator")
  })
})
