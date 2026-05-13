/**
 * Relayer wallet balance monitor.
 *
 * On a schedule (or on demand from /supported), reads each relayer's native
 * balance and persists it. The settle path consults the persisted state to
 * refuse work when a relayer is critically low on gas.
 *
 * We deliberately do NOT block verify on low balance — verify is read-only,
 * and we want clients to know up-front whether their authorization would
 * settle on a *different* facilitator.
 */

import type { Account, PublicClient } from "viem"
import { formatEther } from "viem"
import { eq } from "drizzle-orm"
import { relayerWalletHealth, type Database } from "./db/index.js"

export interface MonitoredChain {
  chainId: number
  publicClient: PublicClient
  account: Account
}

export interface BalanceThresholds {
  lowNative: number
  criticalNative: number
}

export class BalanceMonitor {
  constructor(
    private readonly db: Database,
    private readonly thresholds: BalanceThresholds,
  ) {}

  async refreshOne(chain: MonitoredChain): Promise<void> {
    const balanceWei = await chain.publicClient.getBalance({ address: chain.account.address })
    const balanceNative = Number(formatEther(balanceWei))
    const isCritical = balanceNative < this.thresholds.criticalNative
    await this.db
      .insert(relayerWalletHealth)
      .values({
        chainId: chain.chainId,
        address: chain.account.address.toLowerCase(),
        lastBalanceNative: balanceNative,
        lastCheckedAt: new Date(),
        isCritical,
      })
      .onConflictDoUpdate({
        target: relayerWalletHealth.chainId,
        set: {
          address: chain.account.address.toLowerCase(),
          lastBalanceNative: balanceNative,
          lastCheckedAt: new Date(),
          isCritical,
        },
      })
  }

  async refreshAll(chains: MonitoredChain[]): Promise<void> {
    await Promise.allSettled(chains.map((c) => this.refreshOne(c)))
  }

  async isCritical(chainId: number): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(relayerWalletHealth)
      .where(eq(relayerWalletHealth.chainId, chainId))
      .limit(1)
    return rows[0]?.isCritical ?? false
  }
}
