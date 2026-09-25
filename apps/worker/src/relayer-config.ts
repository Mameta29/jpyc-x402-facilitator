import type { Hex } from "viem"
import type { WorkerEnv } from "./env"

/** Explicit per-chain rollout; unspecified chains retain the previous sender. */
export function relayerChainKeys(env: Pick<WorkerEnv, "RELAYER_CHAIN_PRIVATE_KEYS">): Record<number, Hex> {
  if (!env.RELAYER_CHAIN_PRIVATE_KEYS) return {}
  let value: unknown
  try { value = JSON.parse(env.RELAYER_CHAIN_PRIVATE_KEYS) } catch { throw new Error("invalid_relayer_chain_keys") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_relayer_chain_keys")
  const result: Record<number, Hex> = {}
  for (const [chainId, key] of Object.entries(value)) {
    if (!/^\d+$/.test(chainId) || Number(chainId) <= 0 || typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error("invalid_relayer_chain_keys")
    result[Number(chainId)] = key as Hex
  }
  return result
}

export function usesDurableSettlement(env: Pick<WorkerEnv, "DURABLE_SETTLEMENT_CHAINS">, chainId: number) {
  if (env.DURABLE_SETTLEMENT_CHAINS === undefined) return true
  const ids = env.DURABLE_SETTLEMENT_CHAINS.split(",").map(id => id.trim()).filter(Boolean)
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error("invalid_durable_settlement_chains")
  return ids.includes(String(chainId))
}
