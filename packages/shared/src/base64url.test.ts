import { describe, expect, it } from "vitest"
import {
  decodeJsonBase64Url,
  encodeJsonBase64Url,
  looksLikeBase64Header,
} from "./base64url.js"

describe("base64url JSON helpers", () => {
  it("round-trips primitives and objects", () => {
    const sample = {
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:137", amount: "10000" }],
      nullable: null,
      flag: true,
    }
    const encoded = encodeJsonBase64Url(sample)
    const decoded = decodeJsonBase64Url(encoded)
    expect(decoded).toEqual(sample)
  })

  it("serialises bigint as decimal string", () => {
    const encoded = encodeJsonBase64Url({ value: 123n })
    const decoded = decodeJsonBase64Url<{ value: string }>(encoded)
    expect(decoded.value).toBe("123")
  })

  it("decodes both base64 and base64url forms", () => {
    const sample = { msg: "ok" }
    const url = encodeJsonBase64Url(sample) // base64url
    const std = Buffer.from(JSON.stringify(sample)).toString("base64") // standard base64
    expect(decodeJsonBase64Url(url)).toEqual(sample)
    expect(decodeJsonBase64Url(std)).toEqual(sample)
  })

  it("recognises header-shaped strings", () => {
    expect(looksLikeBase64Header("YWJj")).toBe(true)
    expect(looksLikeBase64Header("YWJj==")).toBe(true)
    expect(looksLikeBase64Header("a-b_c")).toBe(true)
    expect(looksLikeBase64Header("")).toBe(false)
    expect(looksLikeBase64Header("not base64 because spaces")).toBe(false)
  })
})
