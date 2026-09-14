"use server"

// app/clock/[slug]/actions.ts
/**
 * Public Server Action backing the /clock/[slug] PIN pad.
 *
 * SECURITY: takes `slug` (from the URL the tablet is physically sitting
 * at) and re-resolves tenantId from (slug, status = 'active') itself, on
 * every call — same trust model as /kiosk/[slug]/actions.ts. This is a
 * public, unauthenticated surface; nothing here ever accepts a tenantId
 * from the client. The PIN is looked up scoped to that resolved tenantId,
 * so a PIN can never accidentally (or deliberately) clock in a staff
 * member at the wrong shop, even if two tenants happen to reuse the same
 * digits.
 *
 * TOGGLE BEHAVIOR: no explicit "clock in" / "clock out" choice on the pad
 * — entering a PIN toggles based on whether that staff member already has
 * an open (status = 'active') row in staff_shifts. There's only ever at
 * most one open shift per staff member at a time, so this is unambiguous.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type ClockAction = "in" | "out"

export type ClockResult =
  | { ok: true; data: { staffName: string; action: ClockAction; time: string; hoursWorked?: number } }
  | { ok: false; error: string }

export async function submitClockPin(slug: string, pin: string): Promise<ClockResult> {
  if (!/^\d{4,6}$/.test(pin)) {
    return { ok: false, error: "Enter your 4-6 digit PIN." }
  }

  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return { ok: false, error: "This isn't set up yet. Please ask a manager." }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle()
    if (tenantError) throw new Error(tenantError.message)
    if (!tenant) return { ok: false, error: "This clock-in page isn't available." }

    const { data: member, error: staffError } = await supabase
      .from("staff")
      .select("id, name")
      .eq("tenant_id", tenant.id)
      .eq("clock_in_pin", pin)
      .eq("active", true)
      .maybeSingle()
    if (staffError) throw new Error(staffError.message)
    if (!member) return { ok: false, error: "PIN not recognized. Please try again." }

    const { data: openShift, error: openShiftError } = await supabase
      .from("staff_shifts")
      .select("id, login_time")
      .eq("tenant_id", tenant.id)
      .eq("staff_id", member.id)
      .eq("status", "active")
      .maybeSingle()
    if (openShiftError) throw new Error(openShiftError.message)

    const now = new Date()

    // Already clocked in -> this PIN entry clocks them out.
    if (openShift) {
      const hoursWorked = (now.getTime() - new Date(openShift.login_time).getTime()) / (1000 * 60 * 60)

      const { error: updateError } = await supabase
        .from("staff_shifts")
        .update({
          logout_time: now.toISOString(),
          status: "completed",
          hours_worked: Number(hoursWorked.toFixed(2)),
        })
        .eq("id", openShift.id)
      if (updateError) throw new Error(updateError.message)

      return {
        ok: true,
        data: { staffName: member.name, action: "out", time: now.toISOString(), hoursWorked: Number(hoursWorked.toFixed(2)) },
      }
    }

    // Not clocked in -> this PIN entry clocks them in.
    const { error: insertError } = await supabase.from("staff_shifts").insert([
      {
        tenant_id: tenant.id,
        staff_id: member.id,
        login_time: now.toISOString(),
        status: "active",
      },
    ])
    if (insertError) throw new Error(insertError.message)

    return { ok: true, data: { staffName: member.name, action: "in", time: now.toISOString() } }
  } catch (error) {
    console.error("[clock] submitClockPin failed", { slug, error })
    return { ok: false, error: "Something went wrong. Please try again or ask a manager." }
  }
}
