import type { AgentVerifyRequest, SettlementResponse, SupportedKind, VerifyResponse } from "@jpyc-x402/shared"
import type { PaymentKey } from "@jpyc-ec/agent-commerce"

/** Hosts must explicitly supply a durable agent runner; Workers stays disabled until migrated. */
export interface AgentCommerceHandler {
  supported(): SupportedKind[]
  verify(request: AgentVerifyRequest): Promise<VerifyResponse>
  settle(request: AgentVerifyRequest): Promise<SettlementResponse>
  status(key: PaymentKey): Promise<Record<string, unknown>>
}
