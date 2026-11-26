// app/platform/pricing/page.tsx — one place to set what shops are charged:
// Booking & Queue tiers, Order Management, Event Management, Shisha, and the per-staff fee.
import { redirect } from "next/navigation"

import { PageHeader } from "@/components/platform/PageHeader"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { PricingEditor, type PlanRow, type StaffRates, type ShishaRates, type OrderRates, type EventRates, type AddonRates } from "./PricingEditor"

export const dynamic = "force-dynamic"

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v))
const rands = (cents: number | null) => (cents === null ? "" : String(cents / 100))

export default async function PricingPage() {
  await requirePlatformAdmin() // the real gate: everything below uses the service-role client
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [plansRes, staffRes, shishaRes, orderRes, eventRes, addonRes] = await Promise.all([
    supabase
      .from("plans")
      .select("key, name, price_cents, visit_limit, staff_limit, included_staff, extra_staff_price_cents, visits_per_staff, price_per_visit_cents, updated_at")
      .in("key", ["free", "growth", "business"])
      .order("sort_order", { ascending: true }),
    supabase.from("staff_billing_rates").select("module_key, fee_per_staff, updated_at").is("tenant_id", null).eq("is_active", true),
    supabase.from("shisha_billing_rates").select("session_fee, refill_fee, updated_at").is("tenant_id", null).eq("is_active", true).limit(1).maybeSingle(),
    supabase.from("order_billing_rates").select("monthly_fee, included_orders, per_order_fee, updated_at").is("tenant_id", null).eq("is_active", true).limit(1).maybeSingle(),
    supabase.from("event_billing_rates").select("ticket_fee, updated_at").is("tenant_id", null).eq("is_active", true).limit(1).maybeSingle(),
    supabase.from("addon_billing_rates").select("module_key, monthly_fee").is("tenant_id", null).eq("is_active", true),
  ])

  const loadError = plansRes.error ?? staffRes.error ?? shishaRes.error ?? orderRes.error ?? eventRes.error ?? addonRes.error

  const plans: PlanRow[] = (plansRes.data ?? []).map((p: any) => ({
    key: p.key,
    name: p.name,
    priceRands: rands(p.price_cents),
    includedStaff: str(p.included_staff),
    extraStaffRands: rands(p.extra_staff_price_cents),
    staffLimit: str(p.staff_limit),
    visitsPerStaff: str(p.visits_per_staff),
    perVisitRands: rands(p.price_per_visit_cents),
    visitLimit: str(p.visit_limit),
    updatedAt: p.updated_at ?? null,
  }))

  const staffByKey = new Map((staffRes.data ?? []).map((r: any) => [r.module_key as string, str(r.fee_per_staff)]))
  const staff: StaffRates = {
    staff: staffByKey.get("staff") ?? "",
    payroll: staffByKey.get("payroll") ?? "",
    shifts: staffByKey.get("shifts") ?? "",
  }

  const shisha: ShishaRates = {
    sessionFee: str((shishaRes.data as any)?.session_fee),
    refillFee: str((shishaRes.data as any)?.refill_fee),
  }

  const orders: OrderRates = {
    monthlyFee: str((orderRes.data as any)?.monthly_fee),
    includedOrders: str((orderRes.data as any)?.included_orders),
    perOrderFee: str((orderRes.data as any)?.per_order_fee),
  }
  const events: EventRates = { ticketFee: str((eventRes.data as any)?.ticket_fee) }
  const addonByKey = new Map((addonRes.data ?? []).map((r: any) => [r.module_key as string, str(r.monthly_fee)]))
  const addons: AddonRates = {
    stock_take: addonByKey.get("stock_take") ?? "",
    barcode_labels: addonByKey.get("barcode_labels") ?? "",
    box_office: addonByKey.get("box_office") ?? "",
    vvip: addonByKey.get("vvip") ?? "",
  }

  return (
    <main className="space-y-6">
      <PageHeader
        title="Pricing"
        description="Set what shops are charged for Booking & Queue, Order Management and Event Management (with their add-ons), Shisha and Staff. Changes apply to future bills only; invoices already issued keep their amount."
      />
      {loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Couldn&apos;t load everything: {loadError.message}</p>
      )}
      <PricingEditor plans={plans} staff={staff} shisha={shisha} orders={orders} events={events} addons={addons} />
    </main>
  )
}
