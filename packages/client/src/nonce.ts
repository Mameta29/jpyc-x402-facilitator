/**
 * Generate a 32-byte random nonce, returned as 0x-prefixed hex.
 *
 * Uses Web Crypto when available (browsers, Node 20+, edge runtimes) and
 * falls back to `node:crypto` only on environments that don't expose it.
 */

export function generateRandomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32)
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    // Top-level await isn't available in this lib build — but every modern
    // runtime exposes Web Crypto, so this branch is an escape hatch only.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require("node:crypto") as typeof import("node:crypto")
    nodeCrypto.randomFillSync(bytes)
  }
  let hex = "0x"
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex as `0x${string}`
}
