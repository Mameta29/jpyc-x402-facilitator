/**
 * Unit tests for verify logic.
 *
 * We don't hit a real RPC. Instead we mock `publicClient` so we can drive each
 * branch (insufficient_funds, simulate revert, replay, etc.) deterministically.
 *
 * EIP-712 signing is real — we use viem's `privateKeyToAccount` and the same
 * hash that the facilitator recovers against, which catches any drift in the
 * domain or types.
 */

import { describe, expect, it, vi } from "vitest"
import { hashTypedData, type Hex } from "viem"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildJpycEip712Domain,
  createPaymentRequirements,
  evmChainIdToCaip2,
  type PaymentPayload,
  type PaymentRequirements,
} from "@jpyc-x402/shared"
import {
  BLOCK_TIME_GRACE_SECONDS,
  checkRequirementsMatch,
  checkTimeWindow,
  rejectHighS,
  splitSignatureComponents,
  verifyExactPayment,
} from "./verify.js"

const CHAIN_ID = 80002 // Polygon Amoy
const PAYTO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const
const NONCE = "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480" as const
const VALID_AFTER = 0n
const VALID_BEFORE = 9_999_999_999n
const VALUE = 1_000_000_000_000_000_000n // 1 JPYC

async function buildSignedPayload(
  privateKey: Hex,
  overrides: Partial<{ value: bigint; payTo: `0x${string}`; nonce: Hex }> = {},
): Promise<{
  payload: PaymentPayload
  required: PaymentRequirements
  payerAddress: `0x${string}`
}> {
  const account = privateKeyToAccount(privateKey)
  const value = overrides.value ?? VALUE
  const payTo = overrides.payTo ?? PAYTO
  const nonce = overrides.nonce ?? NONCE
  const message = {
    from: account.address,
    to: payTo,
    value,
    validAfter: VALID_AFTER,
    validBefore: VALID_BEFORE,
    nonce,
  }
  const signature = (await account.signTypedData({
    domain: buildJpycEip712Domain(CHAIN_ID),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  })) as Hex

  const required = createPaymentRequirements({
    chainId: CHAIN_ID,
    amountAtomic: value,
    payTo,
  })
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: required,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payTo,
        value: value.toString(),
        validAfter: VALID_AFTER.toString(),
        validBefore: VALID_BEFORE.toString(),
        nonce,
      },
    },
  }
  return { payload, required, payerAddress: account.address }
}

function mockPublicClient(opts: {
  balance?: bigint
  authorizationUsed?: boolean
  simulateThrows?: Error
}) {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return opts.balance ?? VALUE * 100n
      if (functionName === "authorizationState") return opts.authorizationUsed ?? false
      throw new Error(`unmocked readContract: ${functionName}`)
    }),
    simulateContract: vi.fn(async () => {
      if (opts.simulateThrows) throw opts.simulateThrows
      return {}
    }),
  } as unknown as Parameters<typeof verifyExactPayment>[2]["publicClient"]
}

describe("checkRequirementsMatch", () => {
  it("accepts a payload that mirrors the requirements", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    expect(checkRequirementsMatch(payload, required)).toEqual({ ok: true })
  })

  it.each([
    [{ amount: "999" }, "amount mismatch"],
    [{ payTo: "0x0000000000000000000000000000000000000001" }, "payTo mismatch"],
    [{ network: "eip155:1" }, "network mismatch"],
    [{ asset: "0x0000000000000000000000000000000000000001" }, "asset mismatch"],
  ])("rejects mismatched %j", async (mutation, expected) => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const mutated = { ...payload, accepted: { ...payload.accepted, ...mutation } } as PaymentPayload
    expect(checkRequirementsMatch(mutated, required)).toEqual({ ok: false, reason: expected })
  })

  it("rejects mismatched extra (domain) fields", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const mutated = {
      ...payload,
      accepted: { ...payload.accepted, extra: { ...payload.accepted.extra, name: "Forged" } },
    } as PaymentPayload
    expect(checkRequirementsMatch(mutated, required)).toEqual({
      ok: false,
      reason: "extra.name mismatch (EIP-712 domain name)",
    })
  })
})

/**
 * Build the malleable variant (r, n-s, v ^ 1) of a 65-byte ECDSA signature.
 * Both signatures recover to the same address but have different bytes — used
 * to confirm that high-s rejection blocks the bypass.
 */
function malleate(sig: Hex): Hex {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const { r, s, v } = splitSignatureComponents(sig)
  const flipped = (N - BigInt(s)).toString(16).padStart(64, "0")
  const flippedV = (v ^ 1).toString(16).padStart(2, "0")
  return `0x${r.slice(2)}${flipped}${flippedV}` as Hex
}

describe("rejectHighS", () => {
  it("accepts canonical (low-s) signatures", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const sig = (await account.signTypedData({
      domain: buildJpycEip712Domain(CHAIN_ID),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: PAYTO,
        value: VALUE,
        validAfter: VALID_AFTER,
        validBefore: VALID_BEFORE,
        nonce: NONCE,
      },
    })) as Hex
    expect(() => rejectHighS(sig)).not.toThrow()
  })

  it("rejects the malleable (high-s) variant of a canonical signature", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const sig = (await account.signTypedData({
      domain: buildJpycEip712Domain(CHAIN_ID),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: PAYTO,
        value: VALUE,
        validAfter: VALID_AFTER,
        validBefore: VALID_BEFORE,
        nonce: NONCE,
      },
    })) as Hex
    const variant = malleate(sig)
    expect(variant).not.toBe(sig)
    expect(() => rejectHighS(variant)).toThrow(/high-s/)
  })
})

describe("verifyExactPayment + malleability", () => {
  it("rejects the malleable variant of an otherwise-valid signature", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const variant = malleate(payload.payload.signature as Hex)
    const tampered: PaymentPayload = {
      ...payload,
      payload: { ...payload.payload, signature: variant },
    }
    const publicClient = mockPublicClient({ balance: VALUE * 5n })
    const res = await verifyExactPayment(tampered, required, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/invalid_exact_evm_payload_signature/)
      expect(res.reason).toMatch(/high-s/)
    }
  })
})

describe("splitSignatureComponents", () => {
  it("splits a 65-byte signature into v/r/s", () => {
    const sig = ("0x" +
      "1".repeat(64) + // r
      "2".repeat(64) + // s
      "1c") as Hex // v=28
    const parts = splitSignatureComponents(sig)
    expect(parts.r).toHaveLength(66)
    expect(parts.s).toHaveLength(66)
    expect(parts.v).toBe(0x1c)
  })

  it("throws on malformed signatures", () => {
    expect(() => splitSignatureComponents("0xdeadbeef" as Hex)).toThrow()
  })
})

describe("checkTimeWindow", () => {
  const AFTER = 1_000n
  const BEFORE = 2_000n

  it("returns null when now is comfortably inside the window", () => {
    expect(checkTimeWindow(AFTER, BEFORE, 1_500n)).toBeNull()
  })

  it("rejects when now is before validAfter", () => {
    expect(checkTimeWindow(AFTER, BEFORE, AFTER - 1n)).toBe(
      "invalid_exact_evm_payload_authorization_valid_after",
    )
  })

  it("rejects when now is at or past validBefore", () => {
    expect(checkTimeWindow(AFTER, BEFORE, BEFORE)).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    )
    expect(checkTimeWindow(AFTER, BEFORE, BEFORE + 100n)).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    )
  })

  it("rejects within the block-time grace before validBefore", () => {
    // Still strictly before validBefore, but inside the grace → rejected.
    const justInsideGrace = BEFORE - BLOCK_TIME_GRACE_SECONDS
    expect(checkTimeWindow(AFTER, BEFORE, justInsideGrace)).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    )
    // One second earlier than the grace boundary → still accepted.
    expect(checkTimeWindow(AFTER, BEFORE, justInsideGrace - 1n)).toBeNull()
  })
})

describe("verifyExactPayment", () => {
  it("returns ok for a properly signed authorization", async () => {
    const sk = generatePrivateKey()
    const { payload, required, payerAddress } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const publicClient = mockPublicClient({ balance: VALUE * 5n })
    const res = await verifyExactPayment(payload, required, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.payer.toLowerCase()).toBe(payerAddress.toLowerCase())
      expect(res.chainId).toBe(CHAIN_ID)
      expect(res.valueAtomic).toBe(VALUE)
    }
  })

  it("rejects forged signatures (signed by a different key)", async () => {
    const real = generatePrivateKey()
    const attacker = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(real)
    // Sign the same body with the attacker key but keep the original `from`.
    const attackerAccount = privateKeyToAccount(attacker)
    const forged = (await attackerAccount.signTypedData({
      domain: buildJpycEip712Domain(CHAIN_ID),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payload.payload.authorization.from as `0x${string}`,
        to: payload.payload.authorization.to as `0x${string}`,
        value: BigInt(payload.payload.authorization.value),
        validAfter: BigInt(payload.payload.authorization.validAfter),
        validBefore: BigInt(payload.payload.authorization.validBefore),
        nonce: payload.payload.authorization.nonce as Hex,
      },
    })) as Hex
    const tampered = { ...payload, payload: { ...payload.payload, signature: forged } }
    const publicClient = mockPublicClient({})
    const res = await verifyExactPayment(tampered, required, {
      publicClient,
      relayerAccount: attackerAccount,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/invalid_exact_evm_payload_signature/)
  })

  it("rejects authorizations outside the time window", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const publicClient = mockPublicClient({})
    // now > validBefore
    const res = await verifyExactPayment(
      payload,
      required,
      { publicClient, relayerAccount: account },
      () => VALID_BEFORE + 1n,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("authorization_valid_before")
  })

  it("rejects insufficient funds", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const publicClient = mockPublicClient({ balance: VALUE - 1n })
    const res = await verifyExactPayment(payload, required, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("insufficient_funds")
  })

  it("rejects already-used nonces", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const publicClient = mockPublicClient({ authorizationUsed: true })
    const res = await verifyExactPayment(payload, required, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/nonce already used/)
  })

  it("propagates simulation failures (e.g. revert)", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const publicClient = mockPublicClient({
      simulateThrows: new Error("execution reverted: FiatTokenV2: invalid signature"),
    })
    const res = await verifyExactPayment(payload, required, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/invalid_transaction_state/)
  })

  it("rejects payloads whose `accepted.amount` differs from authorization.value", async () => {
    const sk = generatePrivateKey()
    const { payload, required, payerAddress } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    // Pretend the agent shaved 1 wei off the on-chain value but kept accepted.amount honest.
    // Catch this in checkRequirementsMatch via amount mismatch when we mutate accepted instead;
    // here we mutate authorization.value and ensure the explicit value-mismatch check fires.
    const tampered: PaymentPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        authorization: { ...payload.payload.authorization, value: (VALUE - 1n).toString() },
      },
    }
    const publicClient = mockPublicClient({ balance: VALUE * 5n })
    const res = await verifyExactPayment(tampered, required, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // signature recovery happens first against the tampered (lower) value;
      // since the signature was produced for the original VALUE, recovery will
      // not match `from`, so we expect the signature error path.
      expect(res.reason).toMatch(/invalid_exact_evm_payload_signature/)
      expect(res.payer?.toLowerCase()).not.toBe(payerAddress.toLowerCase())
    }
  })

  it("rejects requirements pointing at a non-JPYC asset for the chain", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildSignedPayload(sk)
    const account = privateKeyToAccount(sk)
    const tamperedReq: PaymentRequirements = {
      ...required,
      asset: "0x0000000000000000000000000000000000000123",
    }
    // and re-mirror in payload so checkRequirementsMatch passes
    const tamperedPayload: PaymentPayload = {
      ...payload,
      accepted: { ...payload.accepted, asset: tamperedReq.asset },
    }
    const publicClient = mockPublicClient({})
    const res = await verifyExactPayment(tamperedPayload, tamperedReq, {
      publicClient,
      relayerAccount: account,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/invalid_network/)
  })

  it("rejects when CAIP-2 network is for a chain not registered (sanity check)", async () => {
    const sk = generatePrivateKey()
    const { payload, required, payerAddress } = await buildSignedPayload(sk)
    void payerAddress
    const account = privateKeyToAccount(sk)
    const publicClient = mockPublicClient({})
    const tamperedReq: PaymentRequirements = { ...required, network: evmChainIdToCaip2(99999) }
    const tamperedPayload: PaymentPayload = {
      ...payload,
      accepted: { ...payload.accepted, network: tamperedReq.network },
    }
    await expect(
      verifyExactPayment(tamperedPayload, tamperedReq, { publicClient, relayerAccount: account }),
    ).rejects.toThrow()
  })
})
