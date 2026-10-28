"use server"

// app/clock/[slug]/actions.ts
/**
 * Public Server Action backing the /clock/[slug] PIN pad.
 *
 * SECURITY: takes `slug` (from the URL the tablet is physically sitting at)
 * and re-resolves tenantId from (slug, status = 'active') itself on every
 * call. Nothing here accepts a tenantId from the client.
 *
 * PINs are stored only as bcrypt hashes (staff.clock_in_pin_hash). The check
 * runs inside the database function clock_in_lookup(), scoped to this
 * tenant's active staff, so the app never reads a PIN back.
 *
 * BRUTE-FORCE GUARD: failed attempts are counted per shop on the existing
 * rate_limits table. After MAX_FAILS wrong PINs inside the window the pad
 * pauses for that shop until the window passes.
 *
 * TOGGLE BEHAVIOR: entering a PIN toggles based on whether that staff member
 * already has an open (status = 'active') row in staff_shifts.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type ClockAction = "in" | "out"

export type ClockResult =
  | { ok: true; data: { staffName: string; action: ClockAction; time: string; hoursWorked?: number } }
  | { ok: false; error: string; code?: "invalid_pin" }

const PIN_LENGTH = 6
const MAX_FAILS = 10
const FAIL_WINDOW_SECONDS = 300

export async function submitClockPin(slug: string, pin: string): Promise<ClockResult> {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    return { ok: false, error: `Enter your ${PIN_LENGTH}-digit PIN.` }
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

    const failKey = `clockfail:${tenant.id}`

    const { data: limited, error: limitError } = await supabase.rpc("is_rate_limited", {
      p_key: failKey,
      p_limit: MAX_FAILS,
      p_window_seconds: FAIL_WINDOW_SECONDS,
    })
    if (limitError) throw new Error(limitError.message)
    if (limited) {
      return { ok: false, error: "Too many wrong PINs. Please wait a few minutes or ask a manager." }
    }

    const { data: matches, error: staffError } = await supabase.rpc("clock_in_lookup", {
      p_tenant_id: tenant.id,
      p_pin: pin,
    })
    if (staffError) throw new Error(staffError.message)

    const member = Array.isArray(matches) ? matches[0] : null
    if (!member) {
      // Count the failure (best effort; never blocks the response).
      await supabase.rpc("check_rate_limit", {
        p_key: failKey,
        p_limit: MAX_FAILS,
        p_window_seconds: FAIL_WINDOW_SECONDS,
      })
      return { ok: false, error: "PIN not recognized. Please try again.", code: "invalid_pin" }
    }

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
