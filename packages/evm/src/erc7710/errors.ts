export class AgentPaymentError extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 400) { super(code) }
}
