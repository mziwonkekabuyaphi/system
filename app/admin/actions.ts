// app/admin/actions.ts
"use server"

/**
 * Server Actions for the shop-owner admin view.
 * -----------------------------------------------
 * Access protection, two layers:
 *   1. requireTenantMember() (via getTenantScopedClient below) — proves
 *      there's a signed-in user with an active membership at *some*
 *      tenant, and redirects otherwise. tenantId from that membership
 *      then gets stamped onto every insert and used to scope every
 *      update/delete, so one tenant's admin can't act on another
 *      tenant's row even by guessing a UUID.
 *   2. requireTenantPermission()/getTenantScopedClient(permission) — proves
 *      that membership actually carries the specific permission key the
 *      action needs (staff.view/staff.manage/payroll.view/payroll.manage/
 *      etc.), checked against the *signed-in user's own session* via the
 *      user_has_permission() RPC (see lib/tenant/require-tenant-permission.ts
 *      for why this can't be checked through the service-role client).
 *      This is the layer that actually differentiates a Tenant Owner from
 *      Tenant Staff — membership alone no longer implies "can edit staff"
 *      or "can see payroll", the way it implicitly did when every action
 *      here was gated on the generic bookings.manage.
 *
 * Every payroll- and staff-mutating action below requires its permission
 * BEFORE touching the service-role client, so a caller without
 * payroll.view never even reaches a query that could return salary data —
 * the ActionResult error return happens first.
 */

import { revalidatePath } from "next/cache"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { requireTenantPermission, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { calculatePeriodDeductions, inclusiveDayCount } from "@/lib/payroll/paye"
import {
  completeBooking as completeBookingRecord,
  BOOKING_NOT_FOUND,
  BOOKING_NOT_COMPLETABLE,
} from "@/lib/services/booking"
import type { AdminActivityCategory, AdminStaffInput } from "./types"

type ActionResult = { ok: true } | { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

// Matches booking_settings' own column DEFAULT — used only if this
// tenant somehow has no booking_settings row yet, so cancellation never
// hard-fails for a tenant that hasn't touched Settings > Booking.
const DEFAULT_CANCELLATION_WINDOW_MINUTES = 60

/** Unpermissioned variant — kept only for actions that intentionally rely
 *  purely on membership (none currently do; new actions should prefer
 *  the permissioned overload below). Left as a fallback so this file
 *  doesn't need a second helper name for every call site. */
async function getTenantScopedClient(): Promise<{
  supabase: ServerClient | null
  tenantId: string | null
  error?: string
}>
/** Requires `permission` on the signed-in user's membership before
 *  handing back the service-role client. Returns an error result (never
 *  throws) so callers can `return` it directly, matching every other
 *  ActionResult in this file. */
async function getTenantScopedClient(permission: PermissionKey): Promise<{
  supabase: ServerClient | null
  tenantId: string | null
  error?: string
}>
async function getTenantScopedClient(permission?: PermissionKey) {
  let tenantId: string
  if (permission) {
    const check = await requireTenantPermission(permission)
    if (!check.ok) return { supabase: null as const, tenantId: null, error: check.error }
    tenantId = check.member.tenantId
  } else {
    tenantId = (await requireTenantMember()).tenantId
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return { supabase: null as const, tenantId: null, error: "Supabase isn't configured." }
  return { supabase, tenantId, error: undefined as string | undefined }
}

/** Appends one row to staff_activity_logs. Best-effort: a logging failure
 *  never fails the action it's describing — the write already succeeded
 *  by the time this runs, and losing a log line is far less bad than
 *  reporting a false failure back to the admin who just did the thing. */
async function logActivity(
  supabase: ServerClient,
  tenantId: string,
  entry: { category: AdminActivityCategory; action: string; staffId?: string | null },
) {
  const { userId } = await requireTenantMember()
  const { error } = await supabase.from("staff_activity_logs").insert([
    {
      tenant_id: tenantId,
      staff_id: entry.staffId ?? null,
      actor_profile_id: userId,
      category: entry.category,
      action: entry.action,
    },
  ])
  if (error) console.error(`Failed to log activity (${entry.category}): ${error.message}`)
}

// ============================================================================
// Bookings
// ============================================================================

export async function cancelBooking(bookingId: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  // Load the booking and this tenant's cancellation window together —
  // one round trip, everything the window check needs.
  const [bookingResult, settingsResult] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, start_time, status")
      .eq("id", bookingId)
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase
      .from("booking_settings")
      .select("cancellation_window_minutes")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  ])

  if (bookingResult.error) return { ok: false, error: bookingResult.error.message }
  if (!bookingResult.data) return { ok: false, error: "Booking not found." }
  if (settingsResult.error) return { ok: false, error: settingsResult.error.message }

  const booking = bookingResult.data

  if (booking.status === "cancelled") {
    // Already cancelled (e.g. a second click) — not a failure, nothing
    // more to do.
    return { ok: true }
  }

  const cancellationWindowMinutes =
    settingsResult.data?.cancellation_window_minutes ?? DEFAULT_CANCELLATION_WINDOW_MINUTES
  const cutoffMillis = Date.now() + cancellationWindowMinutes * 60_000

  if (new Date(booking.start_time).getTime() <= cutoffMillis) {
    return {
      ok: false,
      error: `This booking starts within the ${cancellationWindowMinutes}-minute cancellation window and can no longer be cancelled here.`,
    }
  }

  const { error: updateError, data: updated } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .eq("status", "confirmed") // guards against a race between the read above and this write
    .select("id")

  if (updateError) return { ok: false, error: updateError.message }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "This booking was already changed — please refresh and try again." }
  }

  await logActivity(supabase, tenantId!, { category: "bookings", action: "Cancelled a booking" })

  revalidatePath("/admin")
  return { ok: true }
}

/**
 * Marks a booking as completed -- the customer showed up and was
 * served. This is what feeds the billing ledger for a booking that was
 * never promoted into the queue (see lib/services/booking.ts's
 * completeBooking() and the billing migration's booking-side trigger).
 * Membership-only, matching cancelBooking() right above it -- there's no
 * bookings.manage-gated precedent anywhere else in this file to follow
 * instead (see this file's header: only staff/payroll actions got their
 * own specific permission keys). If a tighter gate is ever wanted here,
 * swap the plain getTenantScopedClient() call for
 * getTenantScopedClient("bookings.manage") -- the permission key already
 * exists, it's just unused today.
 */
export async function completeBooking(bookingId: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  try {
    await completeBookingRecord(tenantId!, bookingId)
  } catch (err) {
    if (err instanceof Error && err.message === BOOKING_NOT_FOUND) {
      return { ok: false, error: "Booking not found." }
    }
    if (err instanceof Error && err.message === BOOKING_NOT_COMPLETABLE) {
      return { ok: false, error: "This booking has already been completed or cancelled." }
    }
    console.error("[admin] Failed to complete booking", { tenantId, bookingId, error: err })
    return { ok: false, error: "Couldn't mark this booking as completed." }
  }

  await logActivity(supabase, tenantId!, { category: "bookings", action: "Marked a booking as completed" })

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Services
// ============================================================================

interface ServiceInput {
  name: string
  price: number
  durationMinutes: number
}

function validateServiceInput(input: ServiceInput): string | null {
  if (!input.name.trim()) return "Name is required."
  if (!Number.isFinite(input.price) || input.price < 0) return "Price must be 0 or more."
  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
    return "Duration must be greater than 0."
  }
  return null
}

export async function addService(input: ServiceInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateServiceInput(input)
  if (validationError) return { ok: false, error: validationError }

  const { error: insertError } = await supabase.from("services").insert([
    {
      tenant_id: tenantId,
      name: input.name.trim(),
      price: input.price,
      duration_minutes: input.durationMinutes,
      active: true,
    },
  ])

  if (insertError) return { ok: false, error: insertError.message }

  await logActivity(supabase, tenantId!, { category: "services", action: `Added service "${input.name.trim()}"` })

  revalidatePath("/admin")
  return { ok: true }
}

export async function updateService(id: string, input: ServiceInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateServiceInput(input)
  if (validationError) return { ok: false, error: validationError }

  const { error: updateError } = await supabase
    .from("services")
    .update({
      name: input.name.trim(),
      price: input.price,
      duration_minutes: input.durationMinutes,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, { category: "services", action: `Updated service "${input.name.trim()}"` })

  revalidatePath("/admin")
  return { ok: true }
}

export async function toggleServiceActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("services")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, {
    category: "services",
    action: active ? "Reactivated a service" : "Deactivated a service",
  })

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Queue
// ============================================================================

export async function callQueueEntry(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("queue_entries")
    .update({ status: "called", called_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, { category: "queue", action: "Called a queue entry" })

  revalidatePath("/admin")
  return { ok: true }
}

export async function markQueueEntryDone(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("queue_entries")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, { category: "queue", action: "Marked a queue entry done" })

  revalidatePath("/admin")
  return { ok: true }
}

export async function removeFromQueue(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: deleteError } = await supabase
    .from("queue_entries")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (deleteError) return { ok: false, error: deleteError.message }

  await logActivity(supabase, tenantId!, { category: "queue", action: "Removed a queue entry" })

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Staff
// ============================================================================

function validateStaffInput(input: AdminStaffInput): string | null {
  if (!input.name.trim()) return "Name is required."
  if (
    "hourlyRate" in input &&
    input.hourlyRate !== null &&
    input.hourlyRate !== undefined &&
    (!Number.isFinite(input.hourlyRate) || input.hourlyRate < 0)
  ) {
    return "Hourly rate must be 0 or more."
  }
  if (input.clockInPin && !/^\d{4,6}$/.test(input.clockInPin)) {
    return "PIN must be 4-6 digits."
  }
  return null
}

// Pre-check for a friendly error message — the DB's partial unique index
// on (tenant_id, clock_in_pin) is the real guard (see the
// add_staff_hr_profile_and_shifts migration); this just avoids a raw
// constraint-violation message reaching the admin. Scoped to this tenant
// only, since the same PIN is fine across different shops.
async function assertPinAvailable(
  supabase: ServerClient,
  tenantId: string,
  pin: string,
  excludeStaffId?: string,
): Promise<string | null> {
  if (!pin) return null
  let query = supabase.from("staff").select("id, name").eq("tenant_id", tenantId).eq("clock_in_pin", pin)
  if (excludeStaffId) query = query.neq("id", excludeStaffId)
  const { data } = await query.maybeSingle()
  if (data) return `That PIN is already used by ${data.name}.`
  return null
}

export async function addStaff(input: AdminStaffInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  // hourlyRate is compensation data: setting it — even to null — always
  // needs payroll.manage, independent of the staff.manage check above.
  // Checked against the same signed-in session, not re-derived.
  if ("hourlyRate" in input) {
    const payrollCheck = await requireTenantPermission("payroll.manage")
    if (!payrollCheck.ok) return { ok: false, error: payrollCheck.error }
  }

  const validationError = validateStaffInput(input)
  if (validationError) return { ok: false, error: validationError }

  if (input.clockInPin) {
    const pinError = await assertPinAvailable(supabase, tenantId!, input.clockInPin)
    if (pinError) return { ok: false, error: pinError }
  }

  const { error: insertError } = await supabase.from("staff").insert([
    {
      tenant_id: tenantId,
      name: input.name.trim(),
      job_title: input.jobTitle.trim() || null,
      hourly_rate: "hourlyRate" in input ? input.hourlyRate : null,
      phone: input.phone.trim() || null,
      email: input.email.trim() || null,
      clock_in_pin: input.clockInPin || null,
      active: true,
    },
  ])
  if (insertError) {
    if (insertError.message.includes("staff_tenant_clock_in_pin_unique")) {
      return { ok: false, error: "That PIN is already in use by another staff member." }
    }
    return { ok: false, error: insertError.message }
  }

  await logActivity(supabase, tenantId!, { category: "staff", action: `Added staff member "${input.name.trim()}"` })

  revalidatePath("/admin")
  return { ok: true }
}

export async function updateStaff(id: string, input: AdminStaffInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  // Same independent payroll.manage requirement as addStaff — and if it's
  // NOT present, the update below must omit hourly_rate entirely rather
  // than writing it as null/unchanged, so a staff.manage-only caller
  // can't accidentally (or via a crafted request) wipe an existing rate.
  const canTouchRate = "hourlyRate" in input
  if (canTouchRate) {
    const payrollCheck = await requireTenantPermission("payroll.manage")
    if (!payrollCheck.ok) return { ok: false, error: payrollCheck.error }
  }

  const validationError = validateStaffInput(input)
  if (validationError) return { ok: false, error: validationError }

  if (input.clockInPin) {
    const pinError = await assertPinAvailable(supabase, tenantId!, input.clockInPin, id)
    if (pinError) return { ok: false, error: pinError }
  }

  const patch: Record<string, unknown> = {
    name: input.name.trim(),
    job_title: input.jobTitle.trim() || null,
    phone: input.phone.trim() || null,
    email: input.email.trim() || null,
    clock_in_pin: input.clockInPin || null,
  }
  if (canTouchRate) patch.hourly_rate = input.hourlyRate

  const { error: updateError } = await supabase.from("staff").update(patch).eq("id", id).eq("tenant_id", tenantId)

  if (updateError) {
    if (updateError.message.includes("staff_tenant_clock_in_pin_unique")) {
      return { ok: false, error: "That PIN is already in use by another staff member." }
    }
    return { ok: false, error: updateError.message }
  }

  await logActivity(supabase, tenantId!, { category: "staff", action: `Updated staff member "${input.name.trim()}"`, staffId: id })

  revalidatePath("/admin")
  return { ok: true }
}

export async function toggleStaffActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("staff")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, {
    category: "staff",
    action: active ? "Reactivated staff member" : "Deactivated staff member",
    staffId: id,
  })

  revalidatePath("/admin")
  return { ok: true }
}

// ----------------------------------------------------------------------------
// Shifts — the actual clock-in/clock-out writes happen at the public
// /clock/[slug] PIN pad (app/clock/[slug]/actions.ts), which re-resolves
// tenantId from the slug the same way /kiosk/[slug] does and doesn't go
// through requireTenantMember() at all (there's no admin session at a
// shared tablet). The only shift-related action admins get here is an
// emergency override for a shift someone forgot to clock out of.
// ----------------------------------------------------------------------------

export async function forceClockOutShift(shiftId: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  const { data: shift, error: fetchError } = await supabase
    .from("staff_shifts")
    .select("id, staff_id, login_time")
    .eq("id", shiftId)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle()

  if (fetchError) return { ok: false, error: fetchError.message }
  if (!shift) return { ok: false, error: "That shift is no longer active — try refreshing." }

  const now = new Date()
  const hoursWorked = (now.getTime() - new Date(shift.login_time).getTime()) / (1000 * 60 * 60)

  const { error: updateError } = await supabase
    .from("staff_shifts")
    .update({
      logout_time: now.toISOString(),
      status: "completed",
      hours_worked: Number(hoursWorked.toFixed(2)),
      force_logout: true,
    })
    .eq("id", shiftId)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, {
    category: "clock",
    action: `Force clocked out after ${hoursWorked.toFixed(1)}h`,
    staffId: shift.staff_id,
  })

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Payroll — staff_payroll rows are calculated from completed staff_shifts
// (status = 'completed', so an open/active shift never contributes hours
// until it's clocked out). Every action here requires payroll.view or
// payroll.manage, checked before any query touches staff_payroll or
// staff.hourly_rate — see getTenantScopedClient() above.
// ============================================================================

function payslipStaffRow(row: { id: string; name: string; job_title: string | null; hourly_rate: number | null }) {
  return { id: row.id, name: row.name, jobTitle: row.job_title, hourlyRate: row.hourly_rate }
}

/** Fetches previously-calculated payroll rows for a period — read-only,
 *  used by the Payroll tab's table and by the payslip PDF generator.
 *  Does NOT recalculate; use calculatePayroll() for that. */
export async function getPayrollForPeriod(periodStart: string, periodEnd: string) {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.view")
  if (!supabase) return { ok: false as const, error: error! }

  const { data, error: fetchError } = await supabase
    .from("staff_payroll")
    .select(
      `id, staff_id, period_start, period_end, hours_worked, hourly_rate, gross_pay, paye, uif, deductions,
       final_pay, payment_status, paid_at, paid_by,
       staff ( name, job_title ),
       paid_by_profile:profiles!staff_payroll_paid_by_fkey ( full_name )`,
    )
    .eq("tenant_id", tenantId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .order("created_at", { ascending: true })

  if (fetchError) return { ok: false as const, error: fetchError.message }

  return {
    ok: true as const,
    records: (data ?? []).map((r: any) => ({
      id: r.id,
      staffId: r.staff_id,
      staffName: r.staff?.name ?? "Unknown staff",
      jobTitle: r.staff?.job_title ?? null,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      hoursWorked: Number(r.hours_worked),
      hourlyRate: Number(r.hourly_rate),
      grossPay: Number(r.gross_pay),
      paye: Number(r.paye),
      uif: Number(r.uif),
      deductions: Number(r.deductions),
      finalPay: Number(r.final_pay),
      paymentStatus: r.payment_status,
      paidAt: r.paid_at,
      paidByName: r.paid_by_profile?.full_name ?? null,
    })),
  }
}

/** Recalculates payroll for every active staff member with completed
 *  shifts in [periodStart, periodEnd] (both inclusive), using each
 *  member's *current* hourly_rate — a rate change doesn't retroactively
 *  touch shifts already paid out, but does apply the next time this runs
 *  for a not-yet-paid period. Deletes and replaces any 'pending' rows for
 *  this exact period first, same as the old standalone app, so
 *  recalculating (e.g. after fixing a shift) doesn't duplicate rows;
 *  'paid' rows for the same period are left untouched — recalculating
 *  never un-pays something already marked paid. */
export async function calculatePayroll(periodStart: string, periodEnd: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.manage")
  if (!supabase) return { ok: false, error: error! }

  if (!periodStart || !periodEnd) return { ok: false, error: "Select both a start and end date." }
  if (periodEnd < periodStart) return { ok: false, error: "End date must be on or after the start date." }

  const periodDays = inclusiveDayCount(periodStart, periodEnd)
  const periodStartUTC = `${periodStart}T00:00:00.000Z`
  const periodEndUTC = `${periodEnd}T23:59:59.999Z`

  const { data: staffRows, error: staffError } = await supabase
    .from("staff")
    .select("id, name, job_title, hourly_rate")
    .eq("tenant_id", tenantId)

  if (staffError) return { ok: false, error: staffError.message }
  if (!staffRows?.length) return { ok: false, error: "No staff on file." }

  const { data: shiftRows, error: shiftError } = await supabase
    .from("staff_shifts")
    .select("staff_id, hours_worked")
    .eq("tenant_id", tenantId)
    .eq("status", "completed")
    .gte("login_time", periodStartUTC)
    .lte("login_time", periodEndUTC)

  if (shiftError) return { ok: false, error: shiftError.message }

  const hoursByStaff = new Map<string, number>()
  for (const shift of shiftRows ?? []) {
    hoursByStaff.set(shift.staff_id, (hoursByStaff.get(shift.staff_id) ?? 0) + (Number(shift.hours_worked) || 0))
  }

  const rowsToInsert = staffRows
    .map((staff) => payslipStaffRow(staff))
    .filter((staff) => (hoursByStaff.get(staff.id) ?? 0) > 0)
    .map((staff) => {
      const hours = hoursByStaff.get(staff.id)!
      const rate = staff.hourlyRate ?? 0
      const gross = hours * rate
      const deductions = calculatePeriodDeductions(gross, periodDays)
      const net = Math.max(gross - deductions.total, 0)
      return {
        tenant_id: tenantId,
        staff_id: staff.id,
        period_start: periodStart,
        period_end: periodEnd,
        hours_worked: Number(hours.toFixed(2)),
        hourly_rate: rate,
        gross_pay: Number(gross.toFixed(2)),
        paye: Number(deductions.paye.toFixed(2)),
        uif: Number(deductions.uif.toFixed(2)),
        deductions: Number(deductions.total.toFixed(2)),
        final_pay: Number(net.toFixed(2)),
        payment_status: "pending" as const,
      }
    })

  if (!rowsToInsert.length) {
    return { ok: false, error: "No completed shifts found in that period." }
  }

  const { error: deleteError } = await supabase
    .from("staff_payroll")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .eq("payment_status", "pending")
  if (deleteError) return { ok: false, error: deleteError.message }

  const { error: insertError } = await supabase.from("staff_payroll").insert(rowsToInsert)
  if (insertError) return { ok: false, error: insertError.message }

  await logActivity(supabase, tenantId!, {
    category: "payroll",
    action: `Calculated payroll for ${periodStart} to ${periodEnd} (${rowsToInsert.length} staff)`,
  })

  revalidatePath("/admin")
  return { ok: true }
}

/** Shared by markPayrollPaid/markAllPayrollPaid: a single payroll.manage
 *  check that also hands back the signed-in userId, needed for the
 *  paid_by audit column — getTenantScopedClient() only surfaces
 *  tenantId, not the user, so this goes straight to
 *  requireTenantPermission() instead of layering both helpers. */
async function getPayrollWriteContext() {
  const check = await requireTenantPermission("payroll.manage")
  if (!check.ok) return { supabase: null as const, tenantId: null, userId: null, error: check.error }
  const supabase = getSupabaseServerClient()
  if (!supabase) return { supabase: null as const, tenantId: null, userId: null, error: "Supabase isn't configured." }
  return { supabase, tenantId: check.member.tenantId, userId: check.member.userId, error: undefined as string | undefined }
}

export async function markPayrollPaid(payrollId: string): Promise<ActionResult> {
  const { supabase, tenantId, userId, error } = await getPayrollWriteContext()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("staff_payroll")
    .update({ payment_status: "paid", paid_at: new Date().toISOString(), paid_by: userId })
    .eq("id", payrollId)
    .eq("tenant_id", tenantId)
    .eq("payment_status", "pending")

  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, { category: "payroll", action: "Marked a payslip as paid" })

  revalidatePath("/admin")
  return { ok: true }
}

export async function markAllPayrollPaid(periodStart: string, periodEnd: string): Promise<ActionResult> {
  const { supabase, tenantId, userId, error } = await getPayrollWriteContext()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("staff_payroll")
    .update({ payment_status: "paid", paid_at: new Date().toISOString(), paid_by: userId })
    .eq("tenant_id", tenantId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .eq("payment_status", "pending")

  if (updateError) return { ok: false, error: updateError.message }

  await logActivity(supabase, tenantId!, {
    category: "payroll",
    action: `Marked all pending payslips paid for ${periodStart} to ${periodEnd}`,
  })

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Activity log — read-only from the client's perspective; every write
// happens via logActivity() calls threaded through the actions above.
// category='payroll' rows are additionally gated behind payroll.view at
// the RLS layer (defense-in-depth); this query itself is scoped by
// whichever single permission the caller asked to view, so a staff.view
// caller's query never even requests payroll rows.
// ============================================================================

export async function getActivityLog(limit = 100) {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.view")
  if (!supabase) return { ok: false as const, error: error! }

  const { data, error: fetchError } = await supabase
    .from("staff_activity_logs")
    .select(
      `id, category, action, created_at,
       staff ( id, name ),
       actor:profiles ( full_name )`,
    )
    .eq("tenant_id", tenantId)
    .neq("category", "payroll") // staff.view never includes payroll activity — see getPayrollActivityLog()
    .order("created_at", { ascending: false })
    .limit(limit)

  if (fetchError) return { ok: false as const, error: fetchError.message }

  return {
    ok: true as const,
    entries: (data ?? []).map((r: any) => ({
      id: r.id,
      category: r.category,
      action: r.action,
      staffId: r.staff?.id ?? null,
      staffName: r.staff?.name ?? null,
      actorName: r.actor?.full_name ?? null,
      createdAt: r.created_at,
    })),
  }
}

/** Same as getActivityLog(), but for payroll.view callers who also want
 *  the payroll-category entries merged in. Kept as a second function
 *  (rather than a flag on getActivityLog) so the "staff.view never sees
 *  payroll" invariant is a property of which function you call, not a
 *  runtime branch that could be gotten wrong. */
export async function getPayrollActivityLog(limit = 50) {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.view")
  if (!supabase) return { ok: false as const, error: error! }

  const { data, error: fetchError } = await supabase
    .from("staff_activity_logs")
    .select(`id, category, action, created_at, staff ( id, name ), actor:profiles ( full_name )`)
    .eq("tenant_id", tenantId)
    .eq("category", "payroll")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (fetchError) return { ok: false as const, error: fetchError.message }

  return {
    ok: true as const,
    entries: (data ?? []).map((r: any) => ({
      id: r.id,
      category: r.category,
      action: r.action,
      staffId: r.staff?.id ?? null,
      staffName: r.staff?.name ?? null,
      actorName: r.actor?.full_name ?? null,
      createdAt: r.created_at,
    })),
  }
}
