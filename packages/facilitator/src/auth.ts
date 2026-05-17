/**
 * HMAC request authentication for the facilitator's mutating + advertising
 * endpoints (/verify, /settle, /supported).
 *
 * Why this exists
 * ---------------
 * The facilitator pays gas to broadcast `transferWithAuthorization` on behalf
 * of callers. Without authentication, anyone who learns the URL can make the
 * relayer wallet spend native gas. EIP-712 signature verification protects the
 * *payer's funds* but not the *relayer's gas budget* — that's what this guards.
 *
 * Design (a lightweight take on Coinbase CDP's JWT-per-request scheme)
 * --------------------------------------------------------------------
 * CDP requires every facilitator call to carry a short-lived JWT signed with a
 * CDP API key secret. That model assumes a key-issuance backend and many
 * self-service developers. This facilitator is DB-free and serves a small,
 * known set of callers, so we keep CDP's *properties* (per-request signature,
 * replay resistance, per-caller revocation) without its *infrastructure*:
 *
 *   - Keys are `keyId:secret` pairs listed in the FACILITATOR_HMAC_KEYS env
 *     var. Revoking a caller means removing one entry and redeploying.
 *   - Each request carries an HMAC-SHA256 over a canonical string covering the
 *     method, path, timestamp and body — so the signature can't be replayed
 *     against a different route or mutated body.
 *   - A timestamp skew window bounds replay of an identical request.
 *
 * Wire format
 * -----------
 *   Authorization: X402-HMAC keyId=<id>, ts=<unix-seconds>, sig=<hex>
 *
 *   signing string = `${keyId}\n${ts}\n${METHOD}\n${path}\n${sha256hex(body)}`
 *   sig            = hex( HMAC_SHA256(secret, signing string) )
 *
 * Hashing the body (rather than signing it directly) keeps the signing string
 * a fixed small size and lets the verifier compare against the raw bytes it
 * already buffered.
 */

const SCHEME = "X402-HMAC"

/** Default tolerated clock skew, in seconds, for the request timestamp. */
export const DEFAULT_HMAC_SKEW_SECONDS = 300

export interface HmacKey {
  keyId: string
  secret: string
}

/**
 * Parse FACILITATOR_HMAC_KEYS — a comma-separated list of `keyId:secret`
 * pairs. Whitespace around entries is tolerated; empty input yields [].
 *
 * keyId must be non-empty and contain no `:` (the pair separator) or `,`
 * (the list separator). secret may contain anything except `,`.
 */
export function parseHmacKeys(raw: string | undefined): HmacKey[] {
  if (!raw) return []
  const keys: HmacKey[] = []
  const seen = new Set<string>()
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const sep = trimmed.indexOf(":")
    if (sep <= 0 || sep === trimmed.length - 1) {
      throw new Error(
        `FACILITATOR_HMAC_KEYS: malformed entry (expected 'keyId:secret'): ${trimmed}`,
      )
    }
    const keyId = trimmed.slice(0, sep)
    const secret = trimmed.slice(sep + 1)
    if (seen.has(keyId)) {
      throw new Error(`FACILITATOR_HMAC_KEYS: duplicate keyId '${keyId}'`)
    }
    seen.add(keyId)
    keys.push({ keyId, secret })
  }
  return keys
}

/**
 * Why a request failed authentication. Logged server-side only — never sent
 * to the client, so it gives operators a diagnosis without handing an
 * attacker a probe oracle.
 */
export type AuthFailureDetail =
  | "no_header"
  | "malformed_header"
  | "unknown_key_id"
  | "bad_timestamp"
  | "timestamp_skew"
  | "signature_mismatch"

/** Outcome of authenticating one request. */
export type AuthResult =
  | { ok: true; keyId: string }
  | { ok: false; status: 401; reason: string; detail: AuthFailureDetail }

interface ParsedAuthHeader {
  keyId: string
  ts: string
  sig: string
}

/** Parse the `X402-HMAC keyId=..., ts=..., sig=...` Authorization header. */
function parseAuthHeader(header: string): ParsedAuthHeader | null {
  if (!header.startsWith(`${SCHEME} `)) return null
  const params = header.slice(SCHEME.length + 1)
  const out: Record<string, string> = {}
  for (const part of params.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  if (!out.keyId || !out.ts || !out.sig) return null
  return { keyId: out.keyId, ts: out.ts, sig: out.sig }
}

/** Lowercase hex of SHA-256(bytes) using Web Crypto (Node 20+ and Workers). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return bufToHex(new Uint8Array(digest))
}

/** Lowercase hex of HMAC-SHA256(secret, message) using Web Crypto. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return bufToHex(new Uint8Array(sig))
}

function bufToHex(buf: Uint8Array): string {
  let hex = ""
  for (const b of buf) hex += b.toString(16).padStart(2, "0")
  return hex
}

/**
 * Constant-time comparison of two equal-length lowercase hex strings.
 * Returns false on length mismatch without leaking where they diverge.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export interface VerifyRequestAuthInput {
  method: string
  /** Request path only — no query string, no origin. */
  path: string
  authorizationHeader: string | undefined
  /** Raw request body bytes exactly as received (empty for bodyless GET). */
  body: Uint8Array
}

export interface HmacAuthenticatorOptions {
  keys: HmacKey[]
  /** Tolerated clock skew in seconds. Defaults to DEFAULT_HMAC_SKEW_SECONDS. */
  skewSeconds?: number
}

/**
 * Verifies HMAC-signed requests against a fixed set of keys.
 *
 * The authenticator holds no per-request state; one instance can be shared
 * across requests and (in Workers) reused for the isolate's lifetime.
 */
export class HmacAuthenticator {
  private readonly keysById: Map<string, string>
  private readonly skewSeconds: number

  constructor(opts: HmacAuthenticatorOptions) {
    this.keysById = new Map(opts.keys.map((k) => [k.keyId, k.secret]))
    this.skewSeconds = opts.skewSeconds ?? DEFAULT_HMAC_SKEW_SECONDS
  }

  /** Whether any keys are configured. False means every request is rejected. */
  get hasKeys(): boolean {
    return this.keysById.size > 0
  }

  /**
   * Authenticate one request. Resolves to {ok:true} only when the header is
   * well-formed, the keyId is known, the timestamp is within the skew window
   * and the recomputed HMAC matches in constant time.
   *
   * Failure reasons are intentionally coarse — we don't tell the caller
   * whether it was the keyId, the timestamp or the signature that failed.
   */
  async authenticate(
    input: VerifyRequestAuthInput,
    now: Date = new Date(),
  ): Promise<AuthResult> {
    const fail = (detail: AuthFailureDetail): AuthResult => ({
      ok: false,
      status: 401,
      reason: "unauthorized",
      detail,
    })
    if (!input.authorizationHeader) return fail("no_header")

    const parsed = parseAuthHeader(input.authorizationHeader)
    if (!parsed) return fail("malformed_header")

    const secret = this.keysById.get(parsed.keyId)
    if (secret === undefined) return fail("unknown_key_id")

    const tsSeconds = Number(parsed.ts)
    if (!Number.isFinite(tsSeconds) || !Number.isInteger(tsSeconds)) {
      return fail("bad_timestamp")
    }
    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (Math.abs(nowSeconds - tsSeconds) > this.skewSeconds) {
      return fail("timestamp_skew")
    }

    const bodyHash = await sha256Hex(input.body)
    const signingString = [
      parsed.keyId,
      parsed.ts,
      input.method.toUpperCase(),
      input.path,
      bodyHash,
    ].join("\n")
    const expected = await hmacSha256Hex(secret, signingString)

    // parsed.sig is attacker-controlled; normalize case before the
    // constant-time compare so a valid sig in uppercase still matches.
    if (!timingSafeEqualHex(expected, parsed.sig.toLowerCase())) {
      return fail("signature_mismatch")
    }

    return { ok: true, keyId: parsed.keyId }
  }
}

/**
 * Helper for callers (e.g. the JPYC EC backend, tests, tooling): build the
 * `Authorization` header value for a request. Kept here so the signing and
 * verifying logic live side by side and can't drift.
 */
export async function signRequest(args: {
  key: HmacKey
  method: string
  path: string
  body: Uint8Array
  now?: Date
}): Promise<string> {
  const ts = Math.floor((args.now ?? new Date()).getTime() / 1000).toString()
  const bodyHash = await sha256Hex(args.body)
  const signingString = [
    args.key.keyId,
    ts,
    args.method.toUpperCase(),
    args.path,
    bodyHash,
  ].join("\n")
  const sig = await hmacSha256Hex(args.key.secret, signingString)
  return `${SCHEME} keyId=${args.key.keyId}, ts=${ts}, sig=${sig}`
}
