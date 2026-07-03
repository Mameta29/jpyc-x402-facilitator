/**
 * Unit tests for HMAC request authentication (auth.ts).
 *
 * Validates:
 *   - key list parsing, including malformed and duplicate entries
 *   - signRequest <-> authenticate round trip
 *   - rejection of: missing header, unknown keyId, wrong secret, tampered
 *     method/path/body, stale and future timestamps
 *   - hasKeys reflects the configured key count
 */

import { describe, expect, it } from "vitest"
import {
  HmacAuthenticator,
  parseHmacKeys,
  signRequest,
  type HmacKey,
} from "./auth.js"

const KEY: HmacKey = { keyId: "ec-prod", secret: "s3cret-value" }
const enc = new TextEncoder()

/** Sign + authenticate a request with the same authenticator, return result. */
async function roundTrip(args: {
  auth: HmacAuthenticator
  key?: HmacKey
  method?: string
  path?: string
  body?: Uint8Array
  signNow?: Date
  verifyNow?: Date
}) {
  const method = args.method ?? "POST"
  const path = args.path ?? "/settle"
  const body = args.body ?? enc.encode('{"hello":"world"}')
  const header = await signRequest({
    key: args.key ?? KEY,
    method,
    path,
    body,
    now: args.signNow,
  })
  return args.auth.authenticate(
    { method, path, authorizationHeader: header, body },
    args.verifyNow,
  )
}

describe("parseHmacKeys", () => {
  it("returns [] for undefined or empty input", () => {
    expect(parseHmacKeys(undefined)).toEqual([])
    expect(parseHmacKeys("")).toEqual([])
    expect(parseHmacKeys("  ")).toEqual([])
  })

  it("parses a comma-separated list, trimming whitespace", () => {
    expect(parseHmacKeys(" a:1 , b:2 ")).toEqual([
      { keyId: "a", secret: "1" },
      { keyId: "b", secret: "2" },
    ])
  })

  it("keeps a `:` inside the secret (only the first separates)", () => {
    expect(parseHmacKeys("a:base64:secret==")).toEqual([
      { keyId: "a", secret: "base64:secret==" },
    ])
  })

  it("throws on a malformed entry", () => {
    expect(() => parseHmacKeys("noseparator")).toThrow(/malformed/)
    expect(() => parseHmacKeys(":nosecret")).toThrow(/malformed/)
    expect(() => parseHmacKeys("nokeyid:")).toThrow(/malformed/)
  })

  it("throws on a duplicate keyId", () => {
    expect(() => parseHmacKeys("a:1,a:2")).toThrow(/duplicate/)
  })
})

describe("HmacAuthenticator", () => {
  it("hasKeys reflects whether keys are configured", () => {
    expect(new HmacAuthenticator({ keys: [] }).hasKeys).toBe(false)
    expect(new HmacAuthenticator({ keys: [KEY] }).hasKeys).toBe(true)
  })

  it("accepts a correctly signed request", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const result = await roundTrip({ auth })
    expect(result).toEqual({ ok: true, keyId: "ec-prod" })
  })

  it("accepts an empty body (e.g. GET /supported)", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const result = await roundTrip({
      auth,
      method: "GET",
      path: "/supported",
      body: new Uint8Array(0),
    })
    expect(result.ok).toBe(true)
  })

  it("rejects a missing Authorization header", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const result = await auth.authenticate({
      method: "POST",
      path: "/settle",
      authorizationHeader: undefined,
      body: new Uint8Array(0),
    })
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "unauthorized",
      detail: "no_header",
    })
  })

  it("rejects a malformed header", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    for (const header of ["Bearer abc", "X402-HMAC keyId=ec-prod", "garbage"]) {
      const result = await auth.authenticate({
        method: "POST",
        path: "/settle",
        authorizationHeader: header,
        body: new Uint8Array(0),
      })
      expect(result.ok).toBe(false)
    }
  })

  it("rejects an unknown keyId with detail=unknown_key_id", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const result = await roundTrip({
      auth,
      key: { keyId: "stranger", secret: "whatever" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toBe("unknown_key_id")
  })

  it("rejects a known keyId + wrong secret with detail=signature_mismatch", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const result = await roundTrip({
      auth,
      key: { keyId: "ec-prod", secret: "wrong-secret" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toBe("signature_mismatch")
  })

  it("rejects when the body is tampered after signing", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const body = enc.encode('{"amount":"100"}')
    const header = await signRequest({ key: KEY, method: "POST", path: "/settle", body })
    const tampered = enc.encode('{"amount":"999999"}')
    const result = await auth.authenticate({
      method: "POST",
      path: "/settle",
      authorizationHeader: header,
      body: tampered,
    })
    expect(result.ok).toBe(false)
  })

  it("rejects when the path differs from what was signed", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const body = enc.encode("{}")
    const header = await signRequest({ key: KEY, method: "POST", path: "/verify", body })
    const result = await auth.authenticate({
      method: "POST",
      path: "/settle",
      authorizationHeader: header,
      body,
    })
    expect(result.ok).toBe(false)
  })

  it("rejects when the method differs from what was signed", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const body = new Uint8Array(0)
    const header = await signRequest({ key: KEY, method: "GET", path: "/supported", body })
    const result = await auth.authenticate({
      method: "POST",
      path: "/supported",
      authorizationHeader: header,
      body,
    })
    expect(result.ok).toBe(false)
  })

  it("rejects a stale timestamp outside the skew window", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY], skewSeconds: 60 })
    const signNow = new Date("2026-05-17T00:00:00Z")
    const verifyNow = new Date("2026-05-17T00:02:00Z") // 120s later
    const result = await roundTrip({ auth, signNow, verifyNow })
    expect(result.ok).toBe(false)
  })

  it("rejects a timestamp too far in the future", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY], skewSeconds: 60 })
    const signNow = new Date("2026-05-17T00:05:00Z")
    const verifyNow = new Date("2026-05-17T00:00:00Z") // signed 5min ahead
    const result = await roundTrip({ auth, signNow, verifyNow })
    expect(result.ok).toBe(false)
  })

  it("accepts a timestamp within the skew window", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY], skewSeconds: 300 })
    const signNow = new Date("2026-05-17T00:00:00Z")
    const verifyNow = new Date("2026-05-17T00:04:00Z") // 240s — within 300s
    const result = await roundTrip({ auth, signNow, verifyNow })
    expect(result.ok).toBe(true)
  })

  it("accepts an uppercase signature (hex is case-insensitive)", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY] })
    const body = enc.encode("{}")
    const header = await signRequest({ key: KEY, method: "POST", path: "/settle", body })
    const upper = header.replace(/sig=([0-9a-f]+)/, (_m, s) => `sig=${s.toUpperCase()}`)
    const result = await auth.authenticate({
      method: "POST",
      path: "/settle",
      authorizationHeader: upper,
      body,
    })
    expect(result.ok).toBe(true)
  })

  it("rejects a replayed (identical) request with detail=replayed_nonce", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY], skewSeconds: 300 })
    const body = enc.encode('{"amount":"100"}')
    const now = new Date("2026-05-17T00:00:00Z")
    const header = await signRequest({ key: KEY, method: "POST", path: "/settle", body, now })

    // First send: accepted.
    const first = await auth.authenticate(
      { method: "POST", path: "/settle", authorizationHeader: header, body },
      now,
    )
    expect(first.ok).toBe(true)

    // Exact same header + body, still within the skew window: rejected as replay.
    const replay = await auth.authenticate(
      { method: "POST", path: "/settle", authorizationHeader: header, body },
      new Date("2026-05-17T00:01:00Z"),
    )
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.detail).toBe("replayed_nonce")
  })

  it("accepts two distinct requests (different nonces) from the same caller", async () => {
    const auth = new HmacAuthenticator({ keys: [KEY], skewSeconds: 300 })
    // roundTrip generates a fresh random nonce each time → both accepted.
    const r1 = await roundTrip({ auth })
    const r2 = await roundTrip({ auth })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  it("selects the matching key when several are configured", async () => {
    const k2: HmacKey = { keyId: "partner-a", secret: "another-secret" }
    const auth = new HmacAuthenticator({ keys: [KEY, k2] })
    const r1 = await roundTrip({ auth, key: KEY })
    const r2 = await roundTrip({ auth, key: k2 })
    expect(r1).toEqual({ ok: true, keyId: "ec-prod" })
    expect(r2).toEqual({ ok: true, keyId: "partner-a" })
  })
})
