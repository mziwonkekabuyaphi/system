// app/admin/payments/policy-types.ts
//
// Types for the Payments panel's "Payment rules" section (payment_policies table).
// Kept out of policy-actions.ts because that file is "use server".

export type PaymentScope = "booking" | "order"
export type PaymentTiming = "full" | "deposit" | "after_service"
export type DepositType = "fixed" | "percentage"
export type RefundMode = "full" | "partial" | "none"

export interface PaymentPolicy {
  paymentTiming: PaymentTiming
  /** Only set when paymentTiming = "deposit". */
  depositType: DepositType | null
  /** Rand for "fixed", 0-100 for "percentage". */
  depositValue: number | null
  /** null = no deadline. Always null when paymentTiming = "after_service". */
  paymentDeadlineMinutes: number | null
  /** null = no refund policy stated. */
  refundMode: RefundMode | null
  /** 1-99, only when refundMode = "partial". */
  refundPercent: number | null
  refundNote: string | null
}

export interface PaymentPolicies {
  booking: PaymentPolicy
  order: PaymentPolicy
  /** Card payments need a connected provider; the rules above "after service" are refused without one. */
  cardConnected: boolean
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  paymentTiming: "after_service",
  depositType: null,
  depositValue: null,
  paymentDeadlineMinutes: null,
  refundMode: null,
  refundPercent: null,
  refundNote: null,
}
