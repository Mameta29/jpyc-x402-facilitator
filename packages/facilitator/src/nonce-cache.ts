/**
 * Short-term in-memory cache of recently-settled (chainId, payer, nonce) tuples.
 *
 * Purpose: skip pre-broadcast RPC simulation + on-chain broadcast when the
 * caller retries the same authorization within a short window. The contract's
 * `_authorizationStates` mapping is the *authoritative* source of truth — a
 * second broadcast simply reverts. This cache is a gas/latency optimisation,
 * not a security boundary.
 *
 * TTL is short (5 minutes default — comfortably longer than the typical x402
 * `maxTimeoutSeconds` of 60-90s, but well below any practical retry burst
 * the agent could mount). Old entries are GC'd lazily.
 */

export interface NonceCacheRecord {
  /** First time we settled this triple. */
  firstSeenMs: number
  /** Most recent settle attempt (success or failure). */
  lastSeenMs: number
  /** On-chain tx hash, when we successfully settled. */
  txHash?: string
  /** Sticky outcome — if true, replays return the cached tx_hash without RPC. */
  settled: boolean
}

export class NonceCache {
  private readonly entries = new Map<string, NonceCacheRecord>()
  private readonly ttlMs: number

  constructor(ttlSeconds = 300) {
    this.ttlMs = ttlSeconds * 1000
  }

  private key(chainId: number, payer: string, nonce: string): string {
    return `${chainId}:${payer.toLowerCase()}:${nonce.toLowerCase()}`
  }

  get(chainId: number, payer: string, nonce: string): NonceCacheRecord | undefined {
    const k = this.key(chainId, payer, nonce)
    const entry = this.entries.get(k)
    if (!entry) return undefined
    if (Date.now() - entry.firstSeenMs > this.ttlMs) {
      this.entries.delete(k)
      return undefined
    }
    return entry
  }

  remember(
    chainId: number,
    payer: string,
    nonce: string,
    patch: Partial<NonceCacheRecord> = {},
  ): NonceCacheRecord {
    const k = this.key(chainId, payer, nonce)
    const now = Date.now()
    const existing = this.entries.get(k)
    const next: NonceCacheRecord = {
      firstSeenMs: existing?.firstSeenMs ?? now,
      lastSeenMs: now,
      txHash: patch.txHash ?? existing?.txHash,
      settled: patch.settled ?? existing?.settled ?? false,
    }
    this.entries.set(k, next)

    // Lazy GC.
    if (this.entries.size > 10_000) {
      for (const [key, value] of this.entries) {
        if (now - value.firstSeenMs > this.ttlMs) this.entries.delete(key)
      }
    }

    return next
  }

  /** Test helper. */
  reset(): void {
    this.entries.clear()
  }
}
