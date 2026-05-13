/**
 * Tool definitions exposed by the generic facilitator MCP server.
 *
 * The contract here is intentionally thin: every tool is a 1:1 wrapper around
 * a FacilitatorClient method, plus one composite tool
 * (`create_and_settle_jpyc_payment`) for the common agent flow. Resource-
 * server-specific tools (search products, place order) belong in a separate
 * skill (jpyc-skill repo) — this package's job is to make raw facilitator
 * access ergonomic from any LLM agent.
 */

import { z } from "zod"
import {
  FacilitatorClient,
  signPaymentPayload,
  type SignerLike,
} from "@jpyc-x402/client"
import {
  paymentRequirementsSchema,
  paymentPayloadSchema,
  type PaymentPayload,
  type PaymentRequirements,
} from "@jpyc-x402/shared"
import { privateKeyToAccount } from "viem/accounts"
import type { Hex } from "viem"

export interface ToolDeps {
  /**
   * Resolves a signer for a given payment. Default reads `BUYER_PRIVATE_KEY`
   * from env on every call. Replace with a wallet-session-aware version if
   * you want SIWx-style identity persistence.
   */
  resolveSigner: () => SignerLike
}

export function defaultSignerFromEnv(env: NodeJS.ProcessEnv = process.env): SignerLike {
  const key = env.BUYER_PRIVATE_KEY as Hex | undefined
  if (!key) {
    throw new Error("BUYER_PRIVATE_KEY env var is required")
  }
  return privateKeyToAccount(key)
}

const facilitatorUrlInput = z.object({ url: z.string().url() })
const verifySettleInput = z.object({
  url: z.string().url(),
  paymentPayload: paymentPayloadSchema,
  paymentRequirements: paymentRequirementsSchema.optional(),
})
const createPaymentInput = z.object({
  paymentRequirements: paymentRequirementsSchema,
})
const createAndSettleInput = z.object({
  url: z.string().url(),
  paymentRequirements: paymentRequirementsSchema,
})

/** A single MCP tool — used by the in-process registry below and by tests. */
export interface ToolDef<TInput, TOutput> {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
  handler: (input: TInput, deps: ToolDeps) => Promise<TOutput>
}

export const tools = {
  facilitator_supported: {
    name: "facilitator_supported",
    description: "Fetch a facilitator's /supported endpoint and return its kinds and signers.",
    inputSchema: facilitatorUrlInput,
    handler: async ({ url }, _deps) => {
      const client = new FacilitatorClient({ baseUrl: url })
      return await client.supported()
    },
  } satisfies ToolDef<{ url: string }, unknown>,

  create_jpyc_payment: {
    name: "create_jpyc_payment",
    description:
      "Sign an EIP-3009 authorization for a given PaymentRequirements. Returns a PaymentPayload ready for /verify or /settle.",
    inputSchema: createPaymentInput,
    handler: async ({ paymentRequirements }, deps) => {
      const signer = deps.resolveSigner()
      return await signPaymentPayload({ signer, requirements: paymentRequirements })
    },
  } satisfies ToolDef<{ paymentRequirements: PaymentRequirements }, PaymentPayload>,

  verify_jpyc_payment: {
    name: "verify_jpyc_payment",
    description:
      "Call POST /verify on the facilitator. paymentRequirements defaults to the `accepted` block in the payload.",
    inputSchema: verifySettleInput,
    handler: async ({ url, paymentPayload, paymentRequirements }, _deps) => {
      const client = new FacilitatorClient({ baseUrl: url })
      const requirements = paymentRequirements ?? paymentPayload.accepted
      return await client.verify(paymentPayload, requirements)
    },
  } satisfies ToolDef<
    { url: string; paymentPayload: PaymentPayload; paymentRequirements?: PaymentRequirements },
    unknown
  >,

  settle_jpyc_payment: {
    name: "settle_jpyc_payment",
    description:
      "Call POST /settle on the facilitator. paymentRequirements defaults to the `accepted` block in the payload.",
    inputSchema: verifySettleInput,
    handler: async ({ url, paymentPayload, paymentRequirements }, _deps) => {
      const client = new FacilitatorClient({ baseUrl: url })
      const requirements = paymentRequirements ?? paymentPayload.accepted
      return await client.settle(paymentPayload, requirements)
    },
  } satisfies ToolDef<
    { url: string; paymentPayload: PaymentPayload; paymentRequirements?: PaymentRequirements },
    unknown
  >,

  create_and_settle_jpyc_payment: {
    name: "create_and_settle_jpyc_payment",
    description:
      "Convenience: sign + verify + settle in one call. Returns { paymentPayload, verification, settlement }.",
    inputSchema: createAndSettleInput,
    handler: async ({ url, paymentRequirements }, deps) => {
      const signer = deps.resolveSigner()
      const payload = await signPaymentPayload({ signer, requirements: paymentRequirements })
      const client = new FacilitatorClient({ baseUrl: url })
      const verification = await client.verify(payload, paymentRequirements)
      if (!verification.isValid) {
        return { paymentPayload: payload, verification, settlement: null }
      }
      const settlement = await client.settle(payload, paymentRequirements)
      return { paymentPayload: payload, verification, settlement }
    },
  } satisfies ToolDef<{ url: string; paymentRequirements: PaymentRequirements }, unknown>,
}
