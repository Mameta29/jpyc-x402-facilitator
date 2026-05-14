/**
 * RPC resolver that reads `RPC_URLS_<chainId>` from the Workers Env.
 *
 * Mirrors @jpyc-x402/evm's envRpcResolver but sources from Workers Bindings
 * instead of process.env (which doesn't exist on Workers).
 */

import { getJpycChain } from "@jpyc-x402/shared"
import type { ChainRpcConfig, RpcResolver } from "@jpyc-x402/evm"
import type { WorkerEnv } from "./env"

export function workerRpcResolver(env: WorkerEnv): RpcResolver {
  return (chainId: number): ChainRpcConfig => {
    const key = `RPC_URLS_${chainId}` as keyof WorkerEnv
    const raw = env[key]
    if (typeof raw === "string" && raw.length > 0) {
      return {
        urls: raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }
    }
    return { urls: [getJpycChain(chainId).publicRpc] }
  }
}
