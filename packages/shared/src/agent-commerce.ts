import { z } from "zod"
import { erc7710PayloadSchema, erc7710RequirementsSchema, paymentKeySchema } from "@jpyc-ec/agent-commerce/core"
import { paymentPayloadSchema, paymentRequirementsSchema } from "./schemas.js"

// Legacy schemas/types remain EIP-3009 for existing clients. HTTP dispatch uses
// these explicit unions; no invented EIP-3009 nonce stands in for an order ID.
export const supportedPaymentPayloadSchema = z.union([paymentPayloadSchema, erc7710PayloadSchema])
export const supportedPaymentRequirementsSchema = z.union([paymentRequirementsSchema, erc7710RequirementsSchema])
export const agentVerifyRequestSchema = z.object({ x402Version: z.literal(2), paymentPayload: erc7710PayloadSchema, paymentRequirements: erc7710RequirementsSchema }).strict()
export type AgentVerifyRequest = z.infer<typeof agentVerifyRequestSchema>
export { paymentKeySchema }
export function requestsAgentCommerce(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const v = value as { paymentPayload?: { accepted?: { extra?: { assetTransferMethod?: unknown } } }; paymentRequirements?: { extra?: { assetTransferMethod?: unknown } } }
  return v.paymentPayload?.accepted?.extra?.assetTransferMethod === "erc7710" || v.paymentRequirements?.extra?.assetTransferMethod === "erc7710"
}
