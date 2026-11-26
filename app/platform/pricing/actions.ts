// app/platform/pricing/actions.ts — platform-admin actions that change what shops are charged.
// Same rule as app/platform/tenants/actions.ts: requirePlatformAdmin() runs FIRST in every action
// (server actions are public endpoints) because the writes use the service-role client.
//
// What changes where (so nothing here surprises you):
//   Booking & Queue  -> `plans` rows (money in CENTS). Read by the monthly invoice cron, the admin Billing panel
//                       and the public /pricing page, so all three update together.
//   Staff Management -> `staff_billing_rates` global rows (tenant_id null, money in RANDS).
//   Shisha           -> `shisha_billing_rates` global row (tenant_id null, money in RANDS).
//   Order Management -> `order_billing_rates` global row: monthly fee + included orders + per-order rate (RANDS).
//   Event Management -> `event_billing_rates` global row: fee per ticket sold (RANDS).
//   Add-ons          -> `addon_billing_rates` global rows (RANDS; column is still called monthly_fee, the unit
//                       comes from lib/services/addons.ts). Orders: stock_take, barcode_labels = per month.
//                       Events: box_office = per box-office ticket, vvip (Tables and Tabs) = per table.
//                       Billed on the parent's invoice.
// Staff are billed per head on Shisha, Orders, Events and standalone Staff (the "staff" rate above); Booking &
// Queue include staff in their plan, so they never pay the per-head rate on top.
// Prices only affect FUTURE billing: invoices already issued keep the amount they were issued at, and shisha
// events already recorded keep the fee they were recorded with.
"use server"

import { revalidatePath } from "next/cache"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

type R = { success: true } | { success: false; error: string }

async function ctx() {
  await requirePlatformAdmin()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return supabase
}

const fail = (e: unknown): { success: false; error: string } => ({
  success: false,
  error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e),
})

const MAX_RANDS = 1_000_000

/** Rands (number) -> validated, rounded to 2 decimals. Throws a friendly message otherwise. */
function rands(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(",", "."))
  if (!Number.isFinite(n) || n < 0 || n > MAX_RANDS) throw new Error(`${label}: enter an amount in rands from 0 to ${MAX_RANDS.toLocaleString("en-US")}.`)
  return Math.round(n * 100) / 100
}
const cents = (r: number) => Math.round(r * 100)

function wholeNumber(value: unknown, label: string, min: number, max = 100000): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: enter a whole number from ${min} to ${max.toLocaleString("en-US")}.`)
  return n
}

function revalidateAll() {
  revalidatePath("/platform/pricing")
  revalidatePath("/pricing") // public marketing page reads the same plans rows
  revalidatePath("/")
  revalidatePath("/admin") // tenants' Billing panel
}

// ---------------------------------------------------------------------------
// Booking & Queue (plans table)
// ---------------------------------------------------------------------------

/** The only plan rows this page edits. Placeholder plans (shisha, staff, wallet, events) are not tiers. */
const METERED_KEYS = ["growth", "business"] as const

export async function updateBookingQueuePlan(input: {
  key: string
  priceRands: string
  includedStaff: string
  extraStaffRands: string
  /** Blank = unlimited. */
  staffLimit: string
  visitsPerStaff: string
  perVisitRands: string
}): Promise<R> {
  try {
    const supabase = await ctx()
    if (!(METERED_KEYS as readonly string[]).includes(input.key)) return { success: false, error: "That plan can't be edited here." }

    const price = rands(input.priceRands, "Monthly price")
    const extraStaff = rands(input.extraStaffRands, "Price per extra staff")
    const perVisit = rands(input.perVisitRands, "Price per extra visit")
    const includedStaff = wholeNumber(input.includedStaff, "Staff included", 1, 1000)
    const visitsPerStaff = wholeNumber(input.visitsPerStaff, "Visits per staff each month", 1)
    const staffLimit = input.staffLimit.trim() === "" ? null : wholeNumber(input.staffLimit, "Staff limit", 1, 10000)

    if (price <= 0) return { success: false, error: "Monthly price must be more than R0 (R0 is what the Free plan is for)." }
    if (perVisit <= 0) return { success: false, error: "Price per extra visit must be more than R0. A plan with no per-visit rate is treated as Free and stops being invoiced." }
    if (staffLimit !== null && staffLimit < includedStaff) return { success: false, error: "Staff limit can't be lower than the staff included." }

    const { data, error } = await supabase
      .from("plans")
      .update({
        price_cents: cents(price),
        included_staff: includedStaff,
        extra_staff_price_cents: cents(extraStaff),
        staff_limit: staffLimit,
        visits_per_staff: visitsPerStaff,
        price_per_visit_cents: cents(perVisit),
        updated_at: new Date().toISOString(),
      })
      .eq("key", input.key)
      .select("key")
      .maybeSingle()
    if (error) return fail(error)
    if (!data) return { success: false, error: "Plan not found." }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}

/** The Free plan has no price and no per-visit rate; only its once-off visit allowance and staff are adjustable. */
export async function updateFreePlan(input: { visitLimit: string; includedStaff: string }): Promise<R> {
  try {
    const supabase = await ctx()
    const visitLimit = wholeNumber(input.visitLimit, "Free visits", 1)
    const includedStaff = wholeNumber(input.includedStaff, "Staff included", 1, 1000)

    const { data, error } = await supabase
      .from("plans")
      .update({ visit_limit: visitLimit, included_staff: includedStaff, staff_limit: includedStaff, updated_at: new Date().toISOString() })
      .eq("key", "free")
      .select("key")
      .maybeSingle()
    if (error) return fail(error)
    if (!data) return { success: false, error: "Free plan not found." }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ---------------------------------------------------------------------------
// Staff Management (staff_billing_rates, platform default rows)
// ---------------------------------------------------------------------------

const STAFF_RATE_KEYS = ["staff", "payroll", "shifts"] as const

export async function updateStaffRates(input: { staff: string; payroll: string; shifts: string }): Promise<R> {
  try {
    const supabase = await ctx()
    const values: Record<(typeof STAFF_RATE_KEYS)[number], number> = {
      staff: rands(input.staff, "Staff Management fee"),
      payroll: rands(input.payroll, "Payroll fee"),
      shifts: rands(input.shifts, "Shifts fee"),
    }

    for (const key of STAFF_RATE_KEYS) {
      const { data, error } = await supabase
        .from("staff_billing_rates")
        .update({ fee_per_staff: values[key], is_active: true, updated_at: new Date().toISOString() })
        .eq("module_key", key)
        .is("tenant_id", null)
        .select("id")
      if (error) return fail(error)
      if (!data || data.length === 0) {
        const { error: insertError } = await supabase
          .from("staff_billing_rates")
          .insert({ tenant_id: null, module_key: key, fee_per_staff: values[key], currency: "ZAR", is_active: true })
        if (insertError) return fail(insertError)
      }
    }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ---------------------------------------------------------------------------
// Shisha (shisha_billing_rates, platform default row)
// ---------------------------------------------------------------------------

export async function updateShishaRates(input: { sessionFee: string; refillFee: string }): Promise<R> {
  try {
    const supabase = await ctx()
    const sessionFee = rands(input.sessionFee, "Fee per session")
    const refillFee = rands(input.refillFee, "Fee per refill")

    const { data, error } = await supabase
      .from("shisha_billing_rates")
      .update({ session_fee: sessionFee, refill_fee: refillFee, is_active: true, updated_at: new Date().toISOString() })
      .is("tenant_id", null)
      .select("id")
    if (error) return fail(error)
    if (!data || data.length === 0) {
      const { error: insertError } = await supabase
        .from("shisha_billing_rates")
        .insert({ tenant_id: null, session_fee: sessionFee, refill_fee: refillFee, currency: "ZAR", is_active: true })
      if (insertError) return fail(insertError)
    }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ---------------------------------------------------------------------------
// Order Management (order_billing_rates, platform default row)
// ---------------------------------------------------------------------------

export async function updateOrderRates(input: { monthlyFee: string; includedOrders: string; perOrderFee: string }): Promise<R> {
  try {
    const supabase = await ctx()
    const monthlyFee = rands(input.monthlyFee, "Monthly fee")
    const perOrderFee = rands(input.perOrderFee, "Fee per extra order")
    const includedOrders = wholeNumber(input.includedOrders, "Orders included", 0, 10_000_000)

    const { data, error } = await supabase
      .from("order_billing_rates")
      .update({ monthly_fee: monthlyFee, included_orders: includedOrders, per_order_fee: perOrderFee, is_active: true, updated_at: new Date().toISOString() })
      .is("tenant_id", null)
      .select("id")
    if (error) return fail(error)
    if (!data || data.length === 0) {
      const { error: insertError } = await supabase
        .from("order_billing_rates")
        .insert({ tenant_id: null, monthly_fee: monthlyFee, included_orders: includedOrders, per_order_fee: perOrderFee, currency: "ZAR", is_active: true })
      if (insertError) return fail(insertError)
    }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ---------------------------------------------------------------------------
// Event Management (event_billing_rates, platform default row)
// ---------------------------------------------------------------------------

export async function updateEventRates(input: { ticketFee: string }): Promise<R> {
  try {
    const supabase = await ctx()
    const ticketFee = rands(input.ticketFee, "Fee per ticket")

    const { data, error } = await supabase
      .from("event_billing_rates")
      .update({ ticket_fee: ticketFee, is_active: true, updated_at: new Date().toISOString() })
      .is("tenant_id", null)
      .select("id")
    if (error) return fail(error)
    if (!data || data.length === 0) {
      const { error: insertError } = await supabase
        .from("event_billing_rates")
        .insert({ tenant_id: null, ticket_fee: ticketFee, currency: "ZAR", is_active: true })
      if (insertError) return fail(insertError)
    }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}

// ---------------------------------------------------------------------------
// Add-ons (addon_billing_rates, platform default rows): monthly, per ticket or per table
// ---------------------------------------------------------------------------

const ADDON_KEYS = ["stock_take", "barcode_labels", "box_office", "vvip"] as const
const ADDON_LABELS: Record<(typeof ADDON_KEYS)[number], string> = {
  stock_take: "Stock take",
  barcode_labels: "Barcode / label printing",
  box_office: "Box office",
  vvip: "Tables and Tabs",
}

/** Saves the rate (R per month / ticket / table, see lib/services/addons.ts) of the add-ons named in `fees` (any subset of the four). Unknown keys are refused. */
export async function updateAddonRates(fees: Record<string, string>): Promise<R> {
  try {
    const supabase = await ctx()
    const entries = Object.entries(fees ?? {})
    for (const [key] of entries) {
      if (!(ADDON_KEYS as readonly string[]).includes(key)) return { success: false, error: "That add-on can't be priced here." }
    }
    const values = entries.map(([key, v]) => [key, rands(v, `${ADDON_LABELS[key as (typeof ADDON_KEYS)[number]]} fee`)] as const)

    for (const [key, fee] of values) {
      const { data, error } = await supabase
        .from("addon_billing_rates")
        .update({ monthly_fee: fee, is_active: true, updated_at: new Date().toISOString() })
        .eq("module_key", key)
        .is("tenant_id", null)
        .select("id")
      if (error) return fail(error)
      if (!data || data.length === 0) {
        const { error: insertError } = await supabase
          .from("addon_billing_rates")
          .insert({ tenant_id: null, module_key: key, monthly_fee: fee, currency: "ZAR", is_active: true })
        if (insertError) return fail(insertError)
      }
    }

    revalidateAll()
    return { success: true }
  } catch (e) { return fail(e) }
}
