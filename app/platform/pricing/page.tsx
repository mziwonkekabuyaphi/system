// app/platform/pricing/page.tsx — one place to set what shops are charged:
// Booking & Queue tiers, Staff Management per-staff fees, and Shisha session/refill fees.
import { redirect } from "next/navigation"

import { PageHeader } from "@/components/platform/PageHeader"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { PricingEditor, type PlanRow, type StaffRates, type ShishaRates } from "./PricingEditor"

export const dynamic = "force-dynamic"

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v))
const rands = (cents: number | null) => (cents === null ? "" : String(cents / 100))

export default async function PricingPage() {
  await requirePlatformAdmin() // the real gate: everything below uses the service-role client
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const [plansRes, staffRes, shishaRes] = await Promise.all([
    supabase
      .from("plans")
      .select("key, name, price_cents, visit_limit, staff_limit, included_staff, extra_staff_price_cents, visits_per_staff, price_per_visit_cents, updated_at")
      .in("key", ["free", "growth", "business"])
      .order("sort_order", { ascending: true }),
    supabase.from("staff_billing_rates").select("module_key, fee_per_staff, updated_at").is("tenant_id", null).eq("is_active", true),
    supabase.from("shisha_billing_rates").select("session_fee, refill_fee, updated_at").is("tenant_id", null).eq("is_active", true).limit(1).maybeSingle(),
  ])

  const loadError = plansRes.error ?? staffRes.error ?? shishaRes.error

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

  return (
    <main className="space-y-6">
      <PageHeader
        title="Pricing"
        description="Set what shops are charged for Booking & Queue, Staff Management and Shisha. Changes apply to future bills only; invoices already issued keep their amount."
      />
      {loadError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Couldn&apos;t load everything: {loadError.message}</p>
      )}
      <PricingEditor plans={plans} staff={staff} shisha={shisha} />
    </main>
  )
}
