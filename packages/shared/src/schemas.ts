/**
 * Zod schemas for the x402 v2 wire format.
 *
 * These mirror the JSON shapes documented in:
 *   - specs/x402-specification-v2.md           (PaymentRequired / PaymentPayload / SettlementResponse / VerifyResponse / SupportedResponse)
 *   - specs/schemes/exact/scheme_exact_evm.md  (Authorization / signature)
 *
 * Choices worth noting:
 *
 *  1. We require `extra.assetTransferMethod === "eip3009"`. This implementation
 *     deliberately rejects Permit2 / ERC-7710 — JPYC supports EIP-3009 natively
 *     so the proxy paths add risk without benefit. Other facilitators are free
 *     to take the wider surface; we are not.
 *
 *  2. `amount` and `value` are strings in the wire format (atomic units).
 *     We keep them as strings in the zod schema and let callers parse to bigint
 *     so that JSON round-trips are loss-free.
 *
 *  3. `accepted` (in PaymentPayload) carries the same shape as one entry of
 *     `accepts` (in PaymentRequired) — modelled with the shared
 *     `paymentRequirementsSchema`.
 */

import { z } from "zod"
import { isCaip2 } from "./caip2.js"
import { X402_VERSION } from "./version.js"

const hexAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "EVM address (0x-prefixed, 20 bytes)")
const hex32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "32-byte hex (0x-prefixed)")
const hexSig = z
  .string()
  .regex(/^0x[a-fA-F0-9]{130}$/, "65-byte ECDSA signature (0x-prefixed)")
const decimalString = z
  .string()
  .regex(/^[0-9]+$/, "non-negative decimal integer string")

export const caip2Schema = z
  .string()
  .refine(isCaip2, { message: "must be a valid CAIP-2 identifier" })

export const resourceInfoSchema = z.object({
  url: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
})
export type ResourceInfo = z.infer<typeof resourceInfoSchema>

export const exactExtraSchema = z.object({
  assetTransferMethod: z.literal("eip3009"),
  /** EIP-712 domain `name` for the asset (e.g. "JPY Coin"). */
  name: z.string().min(1),
  /** EIP-712 domain `version` for the asset (e.g. "1"). */
  version: z.string().min(1),
  /** Optional decimals hint for clients. JPYC = 18 across chains. */
  decimals: z.number().int().nonnegative().optional(),
  /** Optional human symbol for clients. */
  symbol: z.string().optional(),
})
export type ExactExtra = z.infer<typeof exactExtraSchema>

export const paymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: caip2Schema,
  /** atomic units (18 dp for JPYC). */
  amount: decimalString,
  /** ERC-20 contract address. */
  asset: hexAddress,
  /** Recipient address. */
  payTo: hexAddress,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: exactExtraSchema,
})
export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>

export const paymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: resourceInfoSchema,
  accepts: z.array(paymentRequirementsSchema).min(1),
  extensions: z.record(z.unknown()).optional(),
})
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>

export const authorizationSchema = z.object({
  from: hexAddress,
  to: hexAddress,
  /** atomic units. */
  value: decimalString,
  /** unix seconds. */
  validAfter: decimalString,
  /** unix seconds. */
  validBefore: decimalString,
  nonce: hex32,
})
export type Authorization = z.infer<typeof authorizationSchema>

export const exactPayloadSchema = z.object({
  signature: hexSig,
  authorization: authorizationSchema,
})
export type ExactPayload = z.infer<typeof exactPayloadSchema>

export const paymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  resource: resourceInfoSchema.optional(),
  accepted: paymentRequirementsSchema,
  payload: exactPayloadSchema,
  extensions: z.record(z.unknown()).optional(),
})
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>

export const verifyRequestSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  paymentPayload: paymentPayloadSchema,
  paymentRequirements: paymentRequirementsSchema,
})
export type VerifyRequest = z.infer<typeof verifyRequestSchema>

export const verifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: hexAddress.optional(),
})
export type VerifyResponse = z.infer<typeof verifyResponseSchema>

export const settleRequestSchema = verifyRequestSchema
export type SettleRequest = VerifyRequest

export const settlementResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: hexAddress.optional(),
  /** Empty string when settlement failed. */
  transaction: z.string(),
  network: caip2Schema,
  amount: decimalString.optional(),
  extensions: z.record(z.unknown()).optional(),
})
export type SettlementResponse = z.infer<typeof settlementResponseSchema>

export const supportedKindSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal("exact"),
  network: caip2Schema,
  extra: z.record(z.unknown()).optional(),
})
export type SupportedKind = z.infer<typeof supportedKindSchema>

export const supportedResponseSchema = z.object({
  kinds: z.array(supportedKindSchema),
  extensions: z.array(z.string()),
  signers: z.record(z.array(hexAddress)),
})
export type SupportedResponse = z.infer<typeof supportedResponseSchema>
