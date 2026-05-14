/**
 * In-memory cache of relayer wallet native-token balances.
 *
 * DB-free replacement for the old `relayer_wallet_health` Postgres table.
 * The cache is refreshed:
 *   - At app startup (warms the cache)
 *   - On a 60 s interval (Node: setInterval; Workers: scheduled trigger)
 *   - Lazily on first read for any chain not yet seen
 *
 * The settle path consults `isCritical(chainId)` synchronously; we never
 * block a request on a fresh RPC read.
 */

import { formatEther, type Account, type PublicClient } from "viem"

export interface BalanceCacheEntry {
  chainId: number
  address: string
  lastBalanceNative: number
  lastCheckedAt: Date
  isCritical: boolean
}

export interface BalanceThresholds {
  lowNative: number
  criticalNative: number
}

export interface MonitoredChain {
  chainId: number
  publicClient: PublicClient
  account: Account
}

export class BalanceCache {
  private readonly entries = new Map<number, BalanceCacheEntry>()

  constructor(private readonly thresholds: BalanceThresholds) {}

  isCritical(chainId: number): boolean {
    return this.entries.get(chainId)?.isCritical ?? false
  }

  isLow(chainId: number): boolean {
    const entry = this.entries.get(chainId)
    return entry ? entry.lastBalanceNative < this.thresholds.lowNative : false
  }

  snapshot(): BalanceCacheEntry[] {
    return [...this.entries.values()]
  }

  async refreshOne(chain: MonitoredChain): Promise<BalanceCacheEntry> {
    const balanceWei = await chain.publicClient.getBalance({ address: chain.account.address })
    const balanceNative = Number(formatEther(balanceWei))
    const entry: BalanceCacheEntry = {
      chainId: chain.chainId,
      address: chain.account.address.toLowerCase(),
      lastBalanceNative: balanceNative,
      lastCheckedAt: new Date(),
      isCritical: balanceNative < this.thresholds.criticalNative,
    }
    this.entries.set(chain.chainId, entry)
    if (entry.isCritical) {
      console.warn(
        `[balance] CRITICAL chain=${chain.chainId} address=${entry.address} balance=${balanceNative}`,
      )
    } else if (this.isLow(chain.chainId)) {
      console.warn(
        `[balance] low chain=${chain.chainId} address=${entry.address} balance=${balanceNative}`,
      )
    }
    return entry
  }

  async refreshAll(chains: MonitoredChain[]): Promise<BalanceCacheEntry[]> {
    const results = await Promise.allSettled(chains.map((c) => this.refreshOne(c)))
    return results
      .filter((r): r is PromiseFulfilledResult<BalanceCacheEntry> => r.status === "fulfilled")
      .map((r) => r.value)
  }

  /** Test helper: wipe state. */
  reset(): void {
    this.entries.clear()
  }
}
