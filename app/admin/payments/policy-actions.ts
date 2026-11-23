// app/admin/payments/policy-actions.ts
"use server"

/**
 * Payment rules (payment_policies) for Bookings and Orders.
 *
 * Same rules as settings-actions.ts: the service-role client bypasses RLS, so
 * the owner check in tenantContext() and the manual .eq("tenant_id", ...) are
 * the real gates. Every value is validated here AND by the table's CHECK
 * constraints, so a bad value fails with a clean message, not a raw Postgres one.
 *
 * payment_timing is the source of truth. A database trigger copies it into
 * booking_settings.require_payment / order_settings.require_payment, so code
 * that still reads those columns keeps working. Do NOT also write
 * require_payment from updateBookingSettings any more, or the two can disagree.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { getCardOption } from "@/lib/payments/card"
import { isProductEnabled } from "@/lib/services/plans"
import {
  DEFAULT_PAYMENT_POLICY,
  type DepositType,
  type PaymentPolicies,
  type PaymentPolicy,
  type PaymentScope,
  type PaymentTiming,
  type RefundMode,
} from "./policy-types"

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const SCOPES: PaymentScope[] = ["booking", "order"]
const TIMINGS: PaymentTiming[] = ["full", "deposit", "after_service"]
const DEPOSIT_TYPES: DepositType[] = ["fixed", "percentage"]
const REFUND_MODES: RefundMode[] = ["full", "partial", "none"]

const MIN_DEADLINE_MINUTES = 5
const MAX_DEADLINE_MINUTES = 7 * 24 * 60
const MAX_FIXED_DEPOSIT = 1_000_000
const MAX_REFUND_NOTE_LENGTH = 500

async function tenantContext() {
  const { tenantId, roleKey } = await requireTenantMember()
  if (roleKey !== "tenant_owner") throw new Error("Not authorized")
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId }
}

interface PolicyRow {
  scope: PaymentScope
  payment_timing: PaymentTiming
  deposit_type: DepositType | null
  deposit_value: number | string | null
  payment_deadline_minutes: number | null
  refund_mode: RefundMode | null
  refund_percent: number | null
  refund_note: string | null
}

function fromRow(row: PolicyRow): PaymentPolicy {
  return {
    paymentTiming: row.payment_timing,
    depositType: row.deposit_type,
    depositValue: row.deposit_value === null ? null : Number(row.deposit_value),
    paymentDeadlineMinutes: row.payment_deadline_minutes,
    refundMode: row.refund_mode,
    refundPercent: row.refund_percent,
    refundNote: row.refund_note,
  }
}

export async function loadPaymentPolicies(): Promise<Result<PaymentPolicies>> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { data, error } = await supabase
      .from("payment_policies")
      .select(
        "scope, payment_timing, deposit_type, deposit_value, payment_deadline_minutes, refund_mode, refund_percent, refund_note",
      )
      .eq("tenant_id", tenantId)

    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as PolicyRow[]
    const find = (scope: PaymentScope) => {
      const row = rows.find((r) => r.scope === scope)
      return row ? fromRow(row) : { ...DEFAULT_PAYMENT_POLICY }
    }

    return {
      ok: true,
      data: { booking: find("booking"), order: find("order"), cardConnected: Boolean(await getCardOption(supabase, tenantId)) },
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function updatePaymentPolicy(scope: PaymentScope, input: PaymentPolicy): Promise<Result<PaymentPolicy>> {
  try {
    if (!SCOPES.includes(scope)) return { ok: false, error: "Unknown payment rules area." }
    if (!TIMINGS.includes(input.paymentTiming)) return { ok: false, error: "Choose when customers pay." }

    const paysUpFront = input.paymentTiming !== "after_service"

    // Deposit
    let depositType: DepositType | null = null
    let depositValue: number | null = null
    if (input.paymentTiming === "deposit") {
      if (!input.depositType || !DEPOSIT_TYPES.includes(input.depositType)) {
        return { ok: false, error: "Choose a fixed amount or a percentage for the deposit." }
      }
      const value = Number(input.depositValue)
      if (!Number.isFinite(value) || value <= 0) return { ok: false, error: "Enter a deposit greater than 0." }
      if (input.depositType === "percentage" && value > 100) return { ok: false, error: "A percentage deposit can't be more than 100." }
      if (input.depositType === "fixed" && value > MAX_FIXED_DEPOSIT) return { ok: false, error: "That deposit amount is too large." }
      depositType = input.depositType
      depositValue = Math.round(value * 100) / 100
    }

    // Deadline: only when something is paid up front.
    let deadline: number | null = null
    if (paysUpFront && input.paymentDeadlineMinutes !== null) {
      const minutes = input.paymentDeadlineMinutes
      if (!Number.isInteger(minutes) || minutes < MIN_DEADLINE_MINUTES || minutes > MAX_DEADLINE_MINUTES) {
        return { ok: false, error: "The payment deadline must be between 5 minutes and 7 days." }
      }
      deadline = minutes
    }

    // Refund policy
    let refundMode: RefundMode | null = null
    let refundPercent: number | null = null
    if (input.refundMode !== null) {
      if (!REFUND_MODES.includes(input.refundMode)) return { ok: false, error: "Choose a refund policy." }
      refundMode = input.refundMode
      if (refundMode === "partial") {
        if (!Number.isInteger(input.refundPercent) || (input.refundPercent as number) < 1 || (input.refundPercent as number) > 99) {
          return { ok: false, error: "A partial refund must be a whole number from 1 to 99 percent." }
        }
        refundPercent = input.refundPercent
      }
    }
    const refundNote = input.refundNote?.trim() || null
    if (refundNote && refundNote.length > MAX_REFUND_NOTE_LENGTH) {
      return { ok: false, error: `The refund note must be ${MAX_REFUND_NOTE_LENGTH} characters or fewer.` }
    }

    const { supabase, tenantId } = await tenantContext()

    if (scope === "booking" && !(await isProductEnabled(supabase, tenantId, "booking"))) {
      return { ok: false, error: "Booking isn't switched on for your shop." }
    }

    // Same rule as the old "require payment" switch: taking payment needs a connected card provider.
    if (paysUpFront && !(await getCardOption(supabase, tenantId))) {
      return { ok: false, error: "Connect a card payment provider first. Payment up front needs one." }
    }

    const saved: PaymentPolicy = {
      paymentTiming: input.paymentTiming,
      depositType,
      depositValue,
      paymentDeadlineMinutes: deadline,
      refundMode,
      refundPercent,
      refundNote,
    }

    const { error } = await supabase.from("payment_policies").upsert(
      {
        tenant_id: tenantId,
        scope,
        payment_timing: saved.paymentTiming,
        deposit_type: saved.depositType,
        deposit_value: saved.depositValue,
        payment_deadline_minutes: saved.paymentDeadlineMinutes,
        refund_mode: saved.refundMode,
        refund_percent: saved.refundPercent,
        refund_note: saved.refundNote,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,scope" },
    )

    if (error) return { ok: false, error: error.message }

    revalidatePath("/admin")
    return { ok: true, data: saved }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
