import { readFileSync } from "node:fs"
import { createPublicClient, http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { AgentPurchaseEngine, type AgentManifest } from "@jpyc-x402/evm/erc7710"
import { signRequest } from "@jpyc-x402/facilitator"
import { AgentJournal } from "./agent-journal.js"
import { DurableAgentRunner } from "./agent-runner.js"

/** Explicit opt-in. Dedicated key/lane and a persistent disk are mandatory. */
export async function createAgentRunner(env = process.env) {
  if (env.AGENT_COMMERCE_ENABLED !== "true") return undefined
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`Missing ${name}`); return value }
  const manifest = JSON.parse(readFileSync(required("AGENT_DEPLOYMENT_MANIFEST"), "utf8")) as AgentManifest
  if (manifest.chainId !== 137 && !(env.NODE_ENV === "test" && [11155111, 31337].includes(manifest.chainId))) throw new Error("Agent runtime requires Polygon (137)")
  const key = required("AGENT_RELAYER_PRIVATE_KEY")
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Invalid agent relayer key")
  // A separate key prevents nonce collisions with legacy Node/Worker senders.
  if (key.toLowerCase() === env.RELAYER_PRIVATE_KEY?.toLowerCase()) throw new Error("Agent and legacy relayers must use separate keys")
  const account = privateKeyToAccount(key as Hex)
  const rpc = new URL(required("AGENT_RPC_URL"))
  const localTestHttp = (url: URL) => env.NODE_ENV === "test" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
  if (rpc.protocol !== "https:" && !localTestHttp(rpc)) throw new Error("Agent RPC requires HTTPS")
  const client = createPublicClient({ transport: http(rpc.href, { timeout: 10000, retryCount: 1 }) })
  const origin = new URL(required("AGENT_EC_ORIGIN"))
  if (origin.protocol !== "https:" && !localTestHttp(origin)) throw new Error("EC requires HTTPS")
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Use an exact EC origin")
  const hmac = { keyId: required("AGENT_EC_KEY_ID"), secret: required("AGENT_EC_HMAC_SECRET") }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(hmac.keyId) || Buffer.byteLength(hmac.secret) < 32) throw new Error("Invalid EC HMAC credentials")
  const resolve = async (executionRef: Hex) => {
    const path = "/internal/agent/executions/resolve", body = JSON.stringify({ executionRef })
    const authorization = await signRequest({ key: hmac, method: "POST", path, body: new TextEncoder().encode(body) })
    const response = await fetch(new URL(path, origin), { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization }, body, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error("Execution resolution failed")
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > 64 * 1024) throw new Error("Execution too large")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Empty execution response")
    let total = 0; const chunks: Uint8Array[] = []
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > 64 * 1024) throw new Error("Execution too large"); chunks.push(value) }
    } finally { await reader.cancel() }
    const bytes = new Uint8Array(total); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  }
  const engine = new AgentPurchaseEngine(manifest, client, account.address, resolve)
  await engine.verifyDeployment()
  const journal = new AgentJournal(required("AGENT_JOURNAL_PATH"))
  return new DurableAgentRunner(engine, journal, account)
}
