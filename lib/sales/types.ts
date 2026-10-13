// lib/sales/types.ts
// Shapes returned by the salesperson_* Postgres functions and the commission tables.

export interface SalesSummary {
  referral_code: string
  clients_total: number
  clients_pending_approval: number
  pending_cents: number
  approved_cents: number
  paid_cents: number
  earned_this_month_cents: number
}

export interface SalesClient {
  tenant_id: string
  tenant_name: string
  tenant_slug: string
  tenant_status: string
  plan_key: string
  plan_name: string | null
  referral_status: "pending" | "approved" | "rejected"
  signed_up_at: string
  approved_at: string | null
  visits_this_month: number
  visits_last_month: number
  last_visit_at: string | null
  visit_limit: number | null
  billed_cents: number
  paid_cents: number
  commission_pending_cents: number
  commission_approved_cents: number
  commission_paid_cents: number
}

export interface SalesCommission {
  id: string
  tenant_id: string | null
  kind: "bounty" | "recurring" | "clawback" | "adjustment"
  amount_cents: number
  status: "pending" | "approved" | "paid" | "void"
  payable_after: string
  created_at: string
  note: string | null
}

export interface SalesPayout {
  id: string
  period: string
  total_cents: number
  status: "draft" | "paid"
  payment_reference: string | null
  paid_at: string | null
  created_at: string
}

export interface SalesPendingSignup {
  id: string
  business_name: string
  created_at: string
}
