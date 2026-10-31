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

import { randomInt } from "node:crypto"
import { revalidatePath } from "next/cache"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { requireTenantPermission, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { isProductEnabled, staffLimitError, type AddonKey, type ProductKey } from "@/lib/services/plans"
import { calculatePeriodDeductions, inclusiveDayCount } from "@/lib/payroll/paye"
import {
  completeBooking as completeBookingRecord,
  createBooking,
  buildDateOptions,
  getAvailableSlots,
  BOOKING_NOT_FOUND,
  BOOKING_NOT_COMPLETABLE,
  BOOKING_SLOT_NO_LONGER_AVAILABLE,
  BOOKING_OUTSIDE_ALLOWED_WINDOW,
} from "@/lib/services/booking"
import { joinQueue, formatQueueTicketNumber } from "@/lib/services/queue"
import { updateCustomer } from "@/lib/services/tenant-customer"
import { getBookableServices } from "@/lib/services/shared/services-catalog"
import { PLAN_VISIT_LIMIT_REACHED } from "@/lib/services/plans"
import {
  BANK_ACCOUNT_TYPES,
  normalizeBankAccountNumber,
  normalizeBranchCode,
  normalizeIdNumber,
  normalizeIsoDate,
  normalizeShortText,
  normalizeTaxNumber,
  type NormalizeResult,
} from "@/lib/payroll/staff-details"
import { loadDisplayContext, loadQueueEntries } from "./admin-data"
import { addDaysKey, safeTimezone, startOfDayUtc } from "./tz"
import type { AdminActivityCategory, AdminQueueEntry, AdminStaffInput } from "./types"
import type { AdminHybridMode, AdminPayType, AdminPayrollOpenShift, AdminStaffPayProfile } from "./payroll-types"

type ActionResult = { ok: true } | { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

// Matches booking_settings' own column DEFAULT — used only if this
// tenant somehow has no booking_settings row yet, so cancellation never
// hard-fails for a tenant that hasn't touched Settings > Booking.
const DEFAULT_CANCELLATION_WINDOW_MINUTES = 60

/** Signed-in tenant member -> service-role client, with two optional gates:
 *  - `permission`: required on the user's membership (error result, never throws).
 *  - `product`: the shop must have this product/add-on switched ON in
 *    tenant_modules (Booking, Queue, Payroll...). Without it the action is
 *    refused even for an owner, so a shop can't reach a product it doesn't run
 *    by calling the action directly. Fails closed.
 *  Returns an error result so callers can `return` it directly, matching every
 *  other ActionResult in this file. Passing neither = membership only
 *  (kept for the few actions that rely purely on membership). */
async function getTenantScopedClient(
  permission?: PermissionKey,
  product?: ProductKey | AddonKey,
): Promise<{
  supabase: ServerClient | null
  tenantId: string | null
  error?: string
}> {
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

  if (product && !(await isProductEnabled(supabase, tenantId, product))) {
    return { supabase: null as const, tenantId: null, error: `${PRODUCT_LABELS[product]} isn't switched on for this shop.` }
  }
  return { supabase, tenantId, error: undefined as string | undefined }
}

const PRODUCT_LABELS: Record<ProductKey | AddonKey, string> = {
  booking: "Booking",
  queue: "Queue",
  shisha: "Shisha",
  shifts: "Shifts",
  payroll: "Payroll",
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
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "booking")
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
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "booking")
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


// ----------------------------------------------------------------------------
// Create an appointment from the admin (staff booking on a customer's behalf).
// Thin wrappers over lib/services/booking.ts — the SAME createBooking() the
// WhatsApp flow and the kiosk call — so every booking rule applies unchanged:
// business hours, min_notice_minutes, max_advance_days, staff availability
// (staff is auto-assigned, there's no "pick a staff member" in that service)
// and the plan visit cap. Membership-only, matching cancelBooking() and
// completeBooking() above; swap in getTenantScopedClient("bookings.manage")
// if you want to gate it tighter (the key exists but is unused today).
// ----------------------------------------------------------------------------

export interface AdminBookableService {
  id: string
  name: string
  durationMinutes: number
}

/** Services a customer could book (active ones) — fetched here, not taken
 *  from page.tsx's initialServices, which is [] for callers without
 *  services.manage. */
export async function getAdminBookableServices(): Promise<
  { ok: true; services: AdminBookableService[] } | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "booking")
  if (!supabase) return { ok: false, error: error! }
  try {
    const services = await getBookableServices(tenantId!)
    return { ok: true, services: services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes })) }
  } catch (err) {
    console.error("[admin] getAdminBookableServices failed", { tenantId, err })
    return { ok: false, error: "Couldn't load services." }
  }
}

/** The dates the booking flow itself would offer (today + up to 6 days,
 *  capped by booking_settings.max_advance_days), in the shop's timezone. */
export async function getAdminBookingDates(): Promise<
  { ok: true; dates: Array<{ date: string; label: string }> } | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "booking")
  if (!supabase) return { ok: false, error: error! }
  try {
    return { ok: true, dates: await buildDateOptions(tenantId!) }
  } catch (err) {
    console.error("[admin] getAdminBookingDates failed", { tenantId, err })
    return { ok: false, error: "Couldn't load available dates." }
  }
}

export async function getAdminBookingSlots(
  serviceId: string,
  dateISO: string,
): Promise<{ ok: true; slots: Array<{ start: string; label: string }> } | { ok: false; error: string }> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "booking")
  if (!supabase) return { ok: false, error: error! }
  try {
    const service = (await getBookableServices(tenantId!)).find((s) => s.id === serviceId)
    if (!service) return { ok: false, error: "That service isn't available." }
    return { ok: true, slots: await getAvailableSlots(tenantId!, dateISO, service.durationMinutes) }
  } catch (err) {
    console.error("[admin] getAdminBookingSlots failed", { tenantId, err })
    return { ok: false, error: "Couldn't load available times." }
  }
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, "")
  return digits.length >= 9 && digits.length <= 15
}

export async function createAdminBooking(input: {
  serviceId: string
  dateISO: string
  slotStart: string
  phone: string
  name?: string
}): Promise<
  { ok: true; bookingReference: string; ticketLabel: string | null; startTime: string } | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "booking")
  if (!supabase) return { ok: false, error: error! }

  const phone = input.phone.trim()
  if (!looksLikePhone(phone)) return { ok: false, error: "Enter the customer's phone number." }

  try {
    const service = (await getBookableServices(tenantId!)).find((s) => s.id === input.serviceId)
    if (!service) return { ok: false, error: "That service isn't available." }

    // Only accept a start time the availability logic itself offers right
    // now — the client can't submit an arbitrary timestamp.
    const slots = await getAvailableSlots(tenantId!, input.dateISO, service.durationMinutes)
    const slot = slots.find((s) => s.start === input.slotStart)
    if (!slot) return { ok: false, error: "That time is no longer available — please pick another." }

    const result = await createBooking(tenantId!, { service, dateISO: input.dateISO, slot, phone })

    const name = input.name?.trim()
    if (name && name.length >= 2) {
      try {
        await updateCustomer(tenantId!, phone, { name })
      } catch (err) {
        // Booking already exists; losing the name is not worth failing it.
        console.error("[admin] createAdminBooking: saving customer name failed", { tenantId, err })
      }
    }

    await logActivity(supabase, tenantId!, { category: "bookings", action: "Created a booking" })
    revalidatePath("/admin")
    return { ok: true, bookingReference: result.bookingReference, ticketLabel: result.ticketLabel, startTime: result.startTime }
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === BOOKING_SLOT_NO_LONGER_AVAILABLE) {
        return { ok: false, error: "That time was just taken — please pick another." }
      }
      if (err.message === BOOKING_OUTSIDE_ALLOWED_WINDOW) {
        return {
          ok: false,
          error: "That time is outside your booking rules (business hours, minimum notice or how far ahead bookings are allowed).",
        }
      }
      if (err.message === PLAN_VISIT_LIMIT_REACHED) {
        return { ok: false, error: "This shop has reached its visit limit for the current plan." }
      }
    }
    console.error("[admin] createAdminBooking failed", { tenantId, err })
    return { ok: false, error: "Couldn't create the appointment." }
  }
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
  const { supabase, tenantId, error } = await getTenantScopedClient("services.manage")
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
  const { supabase, tenantId, error } = await getTenantScopedClient("services.manage")
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
  const { supabase, tenantId, error } = await getTenantScopedClient("services.manage")
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

export async function deleteService(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("services.manage")
  if (!supabase) return { ok: false, error: error! }

  const { data: service, error: fetchError } = await supabase
    .from("services")
    .select("id, name")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (fetchError) return { ok: false, error: fetchError.message }
  if (!service) return { ok: false, error: "Service not found." }

  const inUseMessage = `"${service.name}" has bookings or queue history, so it can't be deleted without losing that history. Deactivate it instead: customers won't see it, but your records stay intact.`

  // Refuse to delete a service that past bookings / queue entries point to.
  // Checked explicitly (rather than relying only on the foreign key) so a
  // cascading FK can never silently wipe booking history or billing records.
  const [bookingsUsing, queueUsing] = await Promise.all([
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("service_id", id),
    supabase
      .from("queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("service_id", id),
  ])
  if (bookingsUsing.error) return { ok: false, error: bookingsUsing.error.message }
  if (queueUsing.error) return { ok: false, error: queueUsing.error.message }
  if ((bookingsUsing.count ?? 0) > 0 || (queueUsing.count ?? 0) > 0) {
    return { ok: false, error: inUseMessage }
  }

  const { error: deleteError } = await supabase
    .from("services")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (deleteError) {
    // 23503 = foreign_key_violation (some other table still references it)
    if (deleteError.code === "23503") return { ok: false, error: inUseMessage }
    return { ok: false, error: deleteError.message }
  }

  await logActivity(supabase, tenantId!, { category: "services", action: `Deleted service "${service.name}"` })

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Queue
// ============================================================================

// Status transitions are guarded in the UPDATE's own WHERE clause (same
// pattern cancelBooking() uses with .eq("status", "confirmed")): the write
// only lands if the row is still in the expected state, so two staff members
// clicking "Call" on the same customer at once can't both succeed — the
// loser matches zero rows and gets a clear message. The database has no
// transition constraint of its own (queue_entries_status_check only limits
// the allowed values), so this is the guard.
//
// The status-change triggers on queue_entries (notify + billing) still fire
// exactly as before: nothing here writes anywhere new.

const QUEUE_ENTRY_CHANGED =
  "This queue entry was already changed by someone else — the list has been refreshed."

/** Who gets credit for serving a queue entry (this is what commission is paid on).
 *  An explicit staff id wins (it must be an active member of this shop). Otherwise
 *  it's the staff record linked to the signed-in login, if there is one. null means
 *  nobody could be identified: the entry is still served, it just earns no
 *  commission, and the Payroll tab warns about it. */
async function resolveServedBy(
  supabase: ServerClient,
  tenantId: string,
  explicitStaffId?: string | null,
): Promise<{ ok: true; staffId: string | null; explicit: boolean } | { ok: false; error: string }> {
  if (explicitStaffId) {
    const { data, error } = await supabase
      .from("staff")
      .select("id")
      .eq("id", explicitStaffId)
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: "That staff member isn't available." }
    return { ok: true, staffId: data.id as string, explicit: true }
  }

  const { userId } = await requireTenantMember()
  const { data, error } = await supabase
    .from("staff")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("profile_id", userId)
    .eq("active", true)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, staffId: (data?.id as string | undefined) ?? null, explicit: false }
}

/** @param servedByStaffId Optional. Who is serving this customer; see resolveServedBy(). */
export async function callQueueEntry(id: string, servedByStaffId?: string | null): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "queue")
  if (!supabase) return { ok: false, error: error! }

  const servedBy = await resolveServedBy(supabase, tenantId!, servedByStaffId)
  if (!servedBy.ok) return { ok: false, error: servedBy.error }

  const patch: Record<string, unknown> = { status: "called", called_at: new Date().toISOString() }
  if (servedBy.staffId) patch.staff_id = servedBy.staffId

  const { data: updated, error: updateError } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "waiting") // only a waiting customer can be called
    .select("id")

  if (updateError) return { ok: false, error: updateError.message }
  if (!updated || updated.length === 0) return { ok: false, error: QUEUE_ENTRY_CHANGED }

  await logActivity(supabase, tenantId!, { category: "queue", action: "Called a queue entry" })

  revalidatePath("/admin")
  return { ok: true }
}

/** @param servedByStaffId Optional. If given it replaces whoever was recorded when the
 *  customer was called (e.g. the receptionist who called them isn't the barber who
 *  cut). If omitted, an entry that has nobody yet gets the signed-in user's staff
 *  record, and an entry that already has someone keeps them. Staff must be settled
 *  BEFORE the status flips to done, because the commission trigger runs on that flip. */
export async function markQueueEntryDone(id: string, servedByStaffId?: string | null): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "queue")
  if (!supabase) return { ok: false, error: error! }

  const servedBy = await resolveServedBy(supabase, tenantId!, servedByStaffId)
  if (!servedBy.ok) return { ok: false, error: servedBy.error }

  if (servedBy.staffId) {
    let assign = supabase
      .from("queue_entries")
      .update({ staff_id: servedBy.staffId })
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .eq("status", "called")
    if (!servedBy.explicit) assign = assign.is("staff_id", null)
    const { error: assignError } = await assign
    if (assignError) return { ok: false, error: assignError.message }
  }

  const { data: updated, error: updateError } = await supabase
    .from("queue_entries")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "called") // only a called customer can be marked done
    .select("id")

  if (updateError) return { ok: false, error: updateError.message }
  if (!updated || updated.length === 0) return { ok: false, error: QUEUE_ENTRY_CHANGED }

  await logActivity(supabase, tenantId!, { category: "queue", action: "Marked a queue entry done" })

  revalidatePath("/admin")
  return { ok: true }
}

export async function removeFromQueue(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "queue")
  if (!supabase) return { ok: false, error: error! }

  // Still a hard delete, exactly as before — but only for entries that are
  // still in the live queue. Previously any id in this tenant could be
  // deleted, including a 'done' row (visit history).
  const { data: deleted, error: deleteError } = await supabase
    .from("queue_entries")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .in("status", ["waiting", "called"])
    .select("id")

  if (deleteError) return { ok: false, error: deleteError.message }
  if (!deleted || deleted.length === 0) return { ok: false, error: QUEUE_ENTRY_CHANGED }

  await logActivity(supabase, tenantId!, { category: "queue", action: "Removed a queue entry" })

  revalidatePath("/admin")
  return { ok: true }
}


// ----------------------------------------------------------------------------
// Add a walk-in from the admin. Wraps lib/services/queue.ts's joinQueue() —
// the same function WhatsApp and the kiosk use — so ticket numbering
// (next_queue_ticket_number), the plan visit cap and the business-hours
// trigger all behave identically. joinQueue() documents that its CALLERS
// enforce require_service_selection, so that's checked here. It does not
// enforce queue_settings.max_queue_size either; this action does, counting
// waiting entries.
// ----------------------------------------------------------------------------

export async function getWalkInOptions(): Promise<
  | { ok: true; services: AdminBookableService[]; requireServiceSelection: boolean }
  | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "queue")
  if (!supabase) return { ok: false, error: error! }
  try {
    const [services, settings] = await Promise.all([
      getBookableServices(tenantId!),
      supabase.from("queue_settings").select("require_service_selection").eq("tenant_id", tenantId).maybeSingle(),
    ])
    if (settings.error) return { ok: false, error: settings.error.message }
    return {
      ok: true,
      services: services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes })),
      requireServiceSelection: settings.data?.require_service_selection ?? true,
    }
  } catch (err) {
    console.error("[admin] getWalkInOptions failed", { tenantId, err })
    return { ok: false, error: "Couldn't load walk-in options." }
  }
}

export async function addWalkIn(input: {
  serviceId: string | null
  phone: string
  name?: string
}): Promise<
  | { ok: true; ticketLabel: string; position: number; etaMinutes: number }
  | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "queue")
  if (!supabase) return { ok: false, error: error! }

  const phone = input.phone.trim()
  if (!looksLikePhone(phone)) return { ok: false, error: "Enter the customer's phone number." }

  try {
    const { data: settings, error: settingsError } = await supabase
      .from("queue_settings")
      .select("require_service_selection, max_queue_size")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (settingsError) return { ok: false, error: settingsError.message }

    const requireService = settings?.require_service_selection ?? true
    if (requireService && !input.serviceId) return { ok: false, error: "Choose a service." }

    let service = null
    if (input.serviceId) {
      service = (await getBookableServices(tenantId!)).find((s) => s.id === input.serviceId) ?? null
      if (!service) return { ok: false, error: "That service isn't available." }
    }

    const maxSize: number | null = settings?.max_queue_size ?? null
    if (maxSize !== null) {
      const { count, error: countError } = await supabase
        .from("queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "waiting")
      if (countError) return { ok: false, error: countError.message }
      if ((count ?? 0) >= maxSize) {
        return { ok: false, error: `The queue is full (${maxSize} waiting).` }
      }
    }

    const joined = await joinQueue(tenantId!, { service, phone })

    const name = input.name?.trim()
    if (name && name.length >= 2) {
      try {
        await updateCustomer(tenantId!, phone, { name })
      } catch (err) {
        console.error("[admin] addWalkIn: saving customer name failed", { tenantId, err })
      }
    }

    await logActivity(supabase, tenantId!, { category: "queue", action: "Added a walk-in to the queue" })
    revalidatePath("/admin")
    return {
      ok: true,
      ticketLabel: formatQueueTicketNumber(joined.ticketNumber, joined.ticketPrefix),
      position: joined.position,
      etaMinutes: joined.etaMinutes,
    }
  } catch (err) {
    if (err instanceof Error && err.message === PLAN_VISIT_LIMIT_REACHED) {
      return { ok: false, error: "This shop has reached its visit limit for the current plan." }
    }
    // The business-hours trigger (enforce_walkin_business_hours) raises a
    // Postgres error when the shop is closed; its text is passed through so
    // staff see the real reason rather than a generic failure.
    console.error("[admin] addWalkIn failed", { tenantId, err })
    return { ok: false, error: err instanceof Error && err.message ? err.message : "Couldn't add the walk-in." }
  }
}

/** Read-only snapshot of this tenant's live queue, for the Queue screen's
 *  periodic refresh. Uses the same loader as page.tsx's first render, and
 *  deliberately does NOT call revalidatePath — it must not re-run the whole
 *  admin page (inbox, settings, …) every few seconds. */
export async function refreshQueue(): Promise<
  { ok: true; entries: AdminQueueEntry[] } | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient(undefined, "queue")
  if (!supabase) return { ok: false, error: error! }

  try {
    const ctx = await loadDisplayContext(supabase, tenantId!)
    return { ok: true, entries: await loadQueueEntries(supabase, tenantId!, ctx) }
  } catch (err) {
    console.error("[admin] refreshQueue failed", { tenantId, error: err })
    return { ok: false, error: "Couldn't refresh the queue." }
  }
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
  return null
}

// ----------------------------------------------------------------------------
// Pay profile (hourly / commission / hybrid). Lives in staff_pay_profiles; a
// staff member with no row is hourly. Commission is a percentage of the LIST
// price of the services someone delivered, written to staff_commission_entries
// by database triggers when a booking is completed or a queue entry is done.
// ----------------------------------------------------------------------------

const PAY_TYPES: AdminPayType[] = ["hourly", "commission", "hybrid"]
const HYBRID_MODES: AdminHybridMode[] = ["base_plus_commission", "higher_of"]

type PayProfileRow = { pay_type: AdminPayType; commission_rate_bps: number | null; hybrid_mode: AdminHybridMode }
type PayProfilePrep = { ok: true; row: PayProfileRow | null } | { ok: false; error: string }

/** Server Action arguments are untrusted JSON, so everything is re-validated here.
 *  row === null means "the input didn't carry a payProfile: leave it alone". */
function preparePayProfile(input: AdminStaffInput): PayProfilePrep {
  const p = input.payProfile
  if (p === undefined) return { ok: true, row: null }
  if (p === null || typeof p !== "object") return { ok: false, error: "Invalid input." }
  if (!PAY_TYPES.includes(p.payType)) return { ok: false, error: "Choose how this person is paid." }

  const hybridMode = p.hybridMode ?? "base_plus_commission"
  if (!HYBRID_MODES.includes(hybridMode)) return { ok: false, error: "Choose how hybrid pay works." }

  if (p.payType === "hourly") {
    return { ok: true, row: { pay_type: "hourly", commission_rate_bps: null, hybrid_mode: "base_plus_commission" } }
  }

  const percent = p.commissionRatePercent
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { ok: false, error: "Enter a commission rate between 0 and 100%." }
  }
  return {
    ok: true,
    row: {
      pay_type: p.payType,
      commission_rate_bps: Math.round(percent * 100),
      hybrid_mode: p.payType === "hybrid" ? hybridMode : "base_plus_commission",
    },
  }
}

/** Upsert; staff_id/tenant_id are stamped from the already-scoped caller and the
 *  composite FK (staff_id, tenant_id) rejects another tenant's staff id. */
async function savePayProfile(
  supabase: ServerClient,
  tenantId: string,
  staffId: string,
  row: PayProfileRow | null,
): Promise<string | null> {
  if (!row) return null
  const { error } = await supabase
    .from("staff_pay_profiles")
    .upsert([{ staff_id: staffId, tenant_id: tenantId, ...row }], { onConflict: "staff_id" })
  return error ? error.message : null
}

function describePayType(row: PayProfileRow): string {
  if (row.pay_type === "hourly") return "hourly"
  if (row.pay_type === "commission") return "commission"
  return row.hybrid_mode === "higher_of" ? "hybrid (higher of hourly or commission)" : "hybrid (hourly plus commission)"
}

/** Everyone's pay profile for the Staff screen. Needs payroll.view. Staff with
 *  no row are simply absent from the result (the UI treats them as hourly). */
export async function getStaffPayProfiles(): Promise<
  { ok: true; profiles: Record<string, AdminStaffPayProfile> } | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.view", "payroll")
  if (!supabase) return { ok: false, error: error! }

  const { data, error: fetchError } = await supabase
    .from("staff_pay_profiles")
    .select("staff_id, pay_type, commission_rate_bps, hybrid_mode")
    .eq("tenant_id", tenantId)
  if (fetchError) return { ok: false, error: fetchError.message }

  const profiles: Record<string, AdminStaffPayProfile> = {}
  for (const r of data ?? []) {
    profiles[r.staff_id as string] = {
      payType: r.pay_type as AdminPayType,
      commissionRatePercent: r.commission_rate_bps === null ? null : Number(r.commission_rate_bps) / 100,
      hybridMode: r.hybrid_mode as AdminHybridMode,
    }
  }
  return { ok: true, profiles }
}

// Normalised, validated versions of the optional HR / payroll fields on
// AdminStaffInput. Server Action arguments are untrusted JSON, so every value
// is type-checked here rather than trusting the TypeScript signature.
//   staffPatch    -> columns on `staff` (employee_number, start_date): staff.manage
//   detailsPatch  -> columns on `staff_payroll_details`: payroll.manage, which the
//                    caller has ALREADY been checked for before this runs.
// A key is only present in a patch when the input asked to change it
// (undefined = leave unchanged, null/"" = clear).
type StaffExtras =
  | { ok: false; error: string }
  | { ok: true; staffPatch: Record<string, string | null>; detailsPatch: Record<string, string | null> }

function prepareStaffExtras(input: AdminStaffInput): StaffExtras {
  const staffPatch: Record<string, string | null> = {}
  const detailsPatch: Record<string, string | null> = {}

  // undefined -> skip; null -> ""; string -> as is; anything else -> invalid.
  const text = (v: unknown): string | undefined | "INVALID" =>
    v === undefined ? undefined : v === null ? "" : typeof v === "string" ? v : "INVALID"

  const apply = (
    target: Record<string, string | null>,
    column: string,
    raw: unknown,
    run: (value: string) => NormalizeResult,
  ): string | null => {
    const v = text(raw)
    if (v === undefined) return null
    if (v === "INVALID") return "Invalid input."
    const result = run(v)
    if (!result.ok) return result.error
    target[column] = result.value
    return null
  }

  const errors = [
    apply(staffPatch, "employee_number", input.employeeNumber, (v) => normalizeShortText(v, "Employee number", 30)),
    apply(staffPatch, "start_date", input.startDate, (v) => normalizeIsoDate(v, "Start date")),
  ]

  const d = input.payrollDetails
  if (d !== undefined) {
    if (d === null || typeof d !== "object") return { ok: false, error: "Invalid input." }
    errors.push(
      apply(detailsPatch, "id_number", d.idNumber, normalizeIdNumber),
      apply(detailsPatch, "tax_number", d.taxNumber, normalizeTaxNumber),
      apply(detailsPatch, "bank_name", d.bankName, (v) => normalizeShortText(v, "Bank name", 60)),
      apply(detailsPatch, "bank_account_number", d.bankAccountNumber, normalizeBankAccountNumber),
      apply(detailsPatch, "bank_branch_code", d.bankBranchCode, normalizeBranchCode),
      apply(detailsPatch, "bank_account_type", d.bankAccountType, (v) =>
        v === "" || (BANK_ACCOUNT_TYPES as string[]).includes(v)
          ? { ok: true, value: v || null }
          : { ok: false, error: "Choose a valid account type." },
      ),
    )
  }

  const firstError = errors.find((e) => e !== null)
  if (firstError) return { ok: false, error: firstError }
  return { ok: true, staffPatch, detailsPatch }
}

/** Upserts only the columns present in `patch`; existing columns not in the
 *  patch keep their value (ON CONFLICT updates only the supplied columns).
 *  staff_id/tenant_id are stamped here from the already-scoped caller, and the
 *  composite FK (staff_id, tenant_id) -> staff(id, tenant_id) means a staff id
 *  belonging to another tenant is rejected by the database as well. */
async function saveStaffPayrollDetails(
  supabase: ServerClient,
  tenantId: string,
  staffId: string,
  patch: Record<string, string | null>,
): Promise<string | null> {
  if (Object.keys(patch).length === 0) return null
  const { error } = await supabase
    .from("staff_payroll_details")
    .upsert([{ staff_id: staffId, tenant_id: tenantId, ...patch }], { onConflict: "staff_id" })
  return error ? error.message : null
}

// ---- Clock-in PINs: reset and see once -------------------------------------
// PINs are never stored readable and never sent back to the browser. Resetting
// generates a random 6-digit PIN here on the server, the database stores only a
// bcrypt hash (set_staff_clock_in_pin), and the plain PIN is returned ONCE so the
// owner can pass it on. It is never written to the activity log.

const CLOCK_PIN_LENGTH = 6

function generateClockInPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10 ** CLOCK_PIN_LENGTH)).padStart(CLOCK_PIN_LENGTH, "0")
    // Skip the obvious ones (000000, 111111, 123456, 654321...).
    if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) continue
    return pin
  }
}

export async function resetStaffClockInPin(
  staffId: string,
): Promise<{ ok: true; pin: string } | { ok: false; error: string }> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  const { data: member, error: memberError } = await supabase
    .from("staff")
    .select("id, name")
    .eq("id", staffId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (memberError) return { ok: false, error: memberError.message }
  if (!member) return { ok: false, error: "Staff member not found." }

  // A random PIN can collide with a colleague's; just draw again.
  for (let attempt = 0; attempt < 8; attempt++) {
    const pin = generateClockInPin()
    const { data: result, error: rpcError } = await supabase.rpc("set_staff_clock_in_pin", {
      p_tenant_id: tenantId,
      p_staff_id: staffId,
      p_pin: pin,
    })
    if (rpcError) return { ok: false, error: "Couldn't set the PIN. Please try again." }
    if (result === "duplicate") continue
    if (result !== "ok") return { ok: false, error: "Couldn't set the PIN. Please try again." }

    await logActivity(supabase, tenantId!, {
      category: "staff",
      action: `Reset clock-in PIN for staff member "${member.name}"`,
      staffId,
    })
    revalidatePath("/admin")
    return { ok: true, pin }
  }
  return { ok: false, error: "Couldn't find a free PIN. Please try again." }
}

// ---- Staff sign-in (auth user + profile + tenant membership) ----------------
// A `staff` row is only a roster/clock-in record. To let someone sign in to
// /admin they also need: an auth.users row (the handle_new_auth_user trigger
// then creates their profiles row), and an active tenant_members row with the
// "Tenant Staff" role. staff.profile_id links the two.

const MIN_LOGIN_PASSWORD = 8

async function provisionStaffLogin(
  supabase: ServerClient,
  tenantId: string,
  person: { name: string; email: string; password: string },
): Promise<{ ok: true; profileId: string } | { ok: false; error: string }> {
  const email = person.email.trim().toLowerCase()
  if (!email) return { ok: false, error: "An email is required to give someone a login." }
  if (person.password.length < MIN_LOGIN_PASSWORD) {
    return { ok: false, error: `Login password must be at least ${MIN_LOGIN_PASSWORD} characters.` }
  }

  const { data: role, error: roleError } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "Tenant Staff")
    .maybeSingle()
  if (roleError || !role) return { ok: false, error: "Couldn't find the Tenant Staff role." }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password: person.password,
    email_confirm: true, // owner vouches for the address; no confirmation email round-trip
    user_metadata: { full_name: person.name.trim() },
  })
  if (createError || !created?.user) {
    const msg = createError?.message ?? "Couldn't create the login."
    if (/already (been )?registered|already exists/i.test(msg)) {
      return { ok: false, error: "Someone already has an account with that email. Use a different email." }
    }
    return { ok: false, error: msg }
  }

  const profileId = created.user.id
  const { error: memberError } = await supabase
    .from("tenant_members")
    .insert([{ tenant_id: tenantId, profile_id: profileId, role_id: role.id, status: "active" }])
  if (memberError) {
    await supabase.auth.admin.deleteUser(profileId) // roll back so we don't leave an orphan login
    return { ok: false, error: memberError.message }
  }

  return { ok: true, profileId }
}

async function rollbackStaffLogin(supabase: ServerClient, profileId: string) {
  // Cascades to profiles -> tenant_members; staff.profile_id is ON DELETE SET NULL.
  await supabase.auth.admin.deleteUser(profileId)
}

export async function addStaff(input: AdminStaffInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  // hourlyRate and payrollDetails (ID/tax/bank) are compensation data:
  // setting either — even to null — always needs payroll.manage, independent
  // of the staff.manage check above. Checked against the same signed-in
  // session, not re-derived.
  if ("hourlyRate" in input || "payrollDetails" in input || "payProfile" in input) {
    const payrollCheck = await requireTenantPermission("payroll.manage")
    if (!payrollCheck.ok) return { ok: false, error: payrollCheck.error }
  }

  const validationError = validateStaffInput(input)
  if (validationError) return { ok: false, error: validationError }

  const extras = prepareStaffExtras(input)
  if (!extras.ok) return { ok: false, error: extras.error }

  const payProfile = preparePayProfile(input)
  if (!payProfile.ok) return { ok: false, error: payProfile.error }

  // Plan staff cap (Mahala 1, Growth 8, Business unlimited). Staff above the
  // plan's included seats but under the cap are allowed and billed as extra staff.
  const limitError = await staffLimitError(supabase, tenantId!)
  if (limitError) return { ok: false, error: limitError }

  let profileId: string | null = null
  if (input.loginPassword) {
    const login = await provisionStaffLogin(supabase, tenantId!, {
      name: input.name,
      email: input.email,
      password: input.loginPassword,
    })
    if (!login.ok) return { ok: false, error: login.error }
    profileId = login.profileId
  }

  const { data: inserted, error: insertError } = await supabase
    .from("staff")
    .insert([
      {
        tenant_id: tenantId,
        profile_id: profileId,
        name: input.name.trim(),
        job_title: input.jobTitle.trim() || null,
        hourly_rate: "hourlyRate" in input ? input.hourlyRate : null,
        phone: input.phone.trim() || null,
        email: input.email.trim() || null,
        employee_number: extras.staffPatch.employee_number ?? null,
        start_date: extras.staffPatch.start_date ?? null,
        active: true,
      },
    ])
    .select("id")
    .single()
  if (insertError || !inserted) {
    if (profileId) await rollbackStaffLogin(supabase, profileId)
    if (insertError?.message.includes("staff_tenant_clock_in_pin_unique")) {
      return { ok: false, error: "That PIN is already in use by another staff member." }
    }
    return { ok: false, error: insertError?.message ?? "Couldn't add the staff member." }
  }

  // Sensitive fields go to their own payroll.manage-gated table. If that
  // write fails, undo the staff row (and login) so the admin can simply
  // resubmit instead of ending up with a half-created duplicate.
  const detailsError = await saveStaffPayrollDetails(supabase, tenantId!, inserted.id, extras.detailsPatch)
  if (detailsError) {
    await supabase.from("staff").delete().eq("id", inserted.id).eq("tenant_id", tenantId)
    if (profileId) await rollbackStaffLogin(supabase, profileId)
    return { ok: false, error: `Couldn't save payroll details: ${detailsError}` }
  }

  const profileError = await savePayProfile(supabase, tenantId!, inserted.id, payProfile.row)
  if (profileError) {
    await supabase.from("staff").delete().eq("id", inserted.id).eq("tenant_id", tenantId)
    if (profileId) await rollbackStaffLogin(supabase, profileId)
    return { ok: false, error: `Couldn't save pay settings: ${profileError}` }
  }

  await logActivity(supabase, tenantId!, { category: "staff", action: `Added staff member "${input.name.trim()}"`, staffId: inserted.id })
  if (payProfile.row) {
    await logActivity(supabase, tenantId!, {
      category: "payroll",
      action: `Set pay type for staff member "${input.name.trim()}" to ${describePayType(payProfile.row)}`,
      staffId: inserted.id,
    })
  }
  // Never put the ID, tax or bank numbers in the log: only that they changed.
  if (Object.keys(extras.detailsPatch).length) {
    await logActivity(supabase, tenantId!, {
      category: "payroll",
      action: `Set payroll details for staff member "${input.name.trim()}"`,
      staffId: inserted.id,
    })
  }

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
  if (canTouchRate || "payrollDetails" in input || "payProfile" in input) {
    const payrollCheck = await requireTenantPermission("payroll.manage")
    if (!payrollCheck.ok) return { ok: false, error: payrollCheck.error }
  }

  const validationError = validateStaffInput(input)
  if (validationError) return { ok: false, error: validationError }

  const extras = prepareStaffExtras(input)
  if (!extras.ok) return { ok: false, error: extras.error }

  const payProfile = preparePayProfile(input)
  if (!payProfile.ok) return { ok: false, error: payProfile.error }

  const patch: Record<string, unknown> = {
    name: input.name.trim(),
    job_title: input.jobTitle.trim() || null,
    phone: input.phone.trim() || null,
    email: input.email.trim() || null,
  }
  if (canTouchRate) patch.hourly_rate = input.hourlyRate
  // Only the HR fields the input actually carried; omitted keys stay as they are.
  Object.assign(patch, extras.staffPatch)

  // Login access: grant (no profile yet), reset password, and keep the
  // sign-in email in step with the staff email.
  const { data: existing, error: existingError } = await supabase
    .from("staff")
    .select("profile_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (existingError) return { ok: false, error: existingError.message }
  if (!existing) return { ok: false, error: "Staff member not found." }

  if (existing.profile_id) {
    const attrs: { password?: string; email?: string } = {}
    if (input.loginPassword) {
      if (input.loginPassword.length < MIN_LOGIN_PASSWORD) {
        return { ok: false, error: `Login password must be at least ${MIN_LOGIN_PASSWORD} characters.` }
      }
      attrs.password = input.loginPassword
    }
    if (input.email.trim()) attrs.email = input.email.trim().toLowerCase()
    if (Object.keys(attrs).length) {
      const { error: authError } = await supabase.auth.admin.updateUserById(existing.profile_id, {
        ...attrs,
        email_confirm: true,
      })
      if (authError) return { ok: false, error: authError.message }
    }
  } else if (input.loginPassword) {
    const login = await provisionStaffLogin(supabase, tenantId!, {
      name: input.name,
      email: input.email,
      password: input.loginPassword,
    })
    if (!login.ok) return { ok: false, error: login.error }
    patch.profile_id = login.profileId
  }

  const { error: updateError } = await supabase.from("staff").update(patch).eq("id", id).eq("tenant_id", tenantId)

  if (updateError) {
    if (patch.profile_id) await rollbackStaffLogin(supabase, patch.profile_id as string)
    if (updateError.message.includes("staff_tenant_clock_in_pin_unique")) {
      return { ok: false, error: "That PIN is already in use by another staff member." }
    }
    return { ok: false, error: updateError.message }
  }

  const detailsError = await saveStaffPayrollDetails(supabase, tenantId!, id, extras.detailsPatch)
  if (detailsError) {
    return { ok: false, error: `Staff details were saved, but payroll details couldn't be: ${detailsError}` }
  }

  const profileError = await savePayProfile(supabase, tenantId!, id, payProfile.row)
  if (profileError) {
    return { ok: false, error: `Staff details were saved, but pay settings couldn't be: ${profileError}` }
  }

  await logActivity(supabase, tenantId!, { category: "staff", action: `Updated staff member "${input.name.trim()}"`, staffId: id })
  if (payProfile.row) {
    await logActivity(supabase, tenantId!, {
      category: "payroll",
      action: `Changed pay type for staff member "${input.name.trim()}" to ${describePayType(payProfile.row)}`,
      staffId: id,
    })
  }
  // Never put the ID, tax or bank numbers in the log: only that they changed.
  if (Object.keys(extras.detailsPatch).length) {
    await logActivity(supabase, tenantId!, {
      category: "payroll",
      action: `Updated payroll details for staff member "${input.name.trim()}"`,
      staffId: id,
    })
  }

  revalidatePath("/admin")
  return { ok: true }
}

export async function toggleStaffActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  // Reactivating takes a seat back, so it must respect the plan's staff cap too.
  // (Deactivating is always allowed -- it's how an over-limit tenant gets back under.)
  if (active) {
    const limitError = await staffLimitError(supabase, tenantId!)
    if (limitError) return { ok: false, error: limitError }
  }

  const { data: row, error: updateError } = await supabase
    .from("staff")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("profile_id")
    .maybeSingle()
  if (updateError) return { ok: false, error: updateError.message }

  // Deactivated staff must not be able to sign in either (and get access
  // back when reactivated).
  if (row?.profile_id) {
    const { error: memberError } = await supabase
      .from("tenant_members")
      .update({ status: active ? "active" : "suspended" })
      .eq("tenant_id", tenantId)
      .eq("profile_id", row.profile_id)
    if (memberError) return { ok: false, error: memberError.message }
  }

  await logActivity(supabase, tenantId!, {
    category: "staff",
    action: active ? "Reactivated staff member" : "Deactivated staff member",
    staffId: id,
  })

  revalidatePath("/admin")
  return { ok: true }
}

export async function deleteStaff(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.manage")
  if (!supabase) return { ok: false, error: error! }

  const { userId } = await requireTenantMember()

  const { data: member, error: fetchError } = await supabase
    .from("staff")
    .select("id, name, profile_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (fetchError) return { ok: false, error: fetchError.message }
  if (!member) return { ok: false, error: "Staff member not found." }

  // Never let someone delete the record they are signed in with — it would
  // remove their own access to the admin.
  if (member.profile_id && member.profile_id === userId) {
    return { ok: false, error: "You can't delete the staff record you're signed in with." }
  }

  // If this person has a login, only remove it when it is an ordinary
  // "Tenant Staff" login — never an owner's.
  if (member.profile_id) {
    const [membershipResult, roleResult] = await Promise.all([
      supabase
        .from("tenant_members")
        .select("role_id")
        .eq("tenant_id", tenantId)
        .eq("profile_id", member.profile_id)
        .maybeSingle(),
      supabase.from("roles").select("id").eq("name", "Tenant Staff").maybeSingle(),
    ])
    if (membershipResult.error) return { ok: false, error: membershipResult.error.message }
    if (roleResult.error) return { ok: false, error: roleResult.error.message }
    if (membershipResult.data && roleResult.data && membershipResult.data.role_id !== roleResult.data.id) {
      return {
        ok: false,
        error: `${member.name} has an owner/admin login, so they can't be deleted here. Deactivate them instead.`,
      }
    }
  }

  const inUseMessage = `${member.name} has bookings, shifts or payroll records, so they can't be deleted without losing that history. Deactivate them instead: they won't be able to clock in or sign in, but your records stay intact.`

  // Refuse to delete someone that bookings / shifts / payroll point to.
  // Checked explicitly (rather than relying only on the foreign keys) so a
  // cascading FK can never silently wipe bookings, hours worked or payslips.
  const [bookingsUsing, shiftsUsing, payrollUsing] = await Promise.all([
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("staff_id", id),
    supabase
      .from("staff_shifts")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("staff_id", id),
    supabase
      .from("staff_payroll")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("staff_id", id),
  ])
  if (bookingsUsing.error) return { ok: false, error: bookingsUsing.error.message }
  if (shiftsUsing.error) return { ok: false, error: shiftsUsing.error.message }
  if (payrollUsing.error) return { ok: false, error: payrollUsing.error.message }
  if ((bookingsUsing.count ?? 0) > 0 || (shiftsUsing.count ?? 0) > 0 || (payrollUsing.count ?? 0) > 0) {
    return { ok: false, error: inUseMessage }
  }

  // The activity log keeps pointing at a staff member (NO ACTION foreign key),
  // which would block the delete. Detach those rows instead of deleting them:
  // the log entries stay (their text already names the person), they just no
  // longer link to a staff record that is about to disappear.
  const { error: detachError } = await supabase
    .from("staff_activity_logs")
    .update({ staff_id: null })
    .eq("tenant_id", tenantId)
    .eq("staff_id", id)
  if (detachError) return { ok: false, error: detachError.message }

  const { error: deleteError } = await supabase.from("staff").delete().eq("id", id).eq("tenant_id", tenantId)
  if (deleteError) {
    // 23503 = foreign_key_violation (some other table still references them)
    if (deleteError.code === "23503") return { ok: false, error: inUseMessage }
    return { ok: false, error: deleteError.message }
  }

  // Remove their sign-in access too. The login account itself is only
  // deleted if they don't belong to any other shop.
  if (member.profile_id) {
    const { error: revokeError } = await supabase
      .from("tenant_members")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("profile_id", member.profile_id)
    if (revokeError) {
      return {
        ok: false,
        error: `${member.name} was deleted, but their sign-in couldn't be fully removed: ${revokeError.message}`,
      }
    }

    const { count: remainingMemberships } = await supabase
      .from("tenant_members")
      .select("profile_id", { count: "exact", head: true })
      .eq("profile_id", member.profile_id)
    if ((remainingMemberships ?? 0) === 0) {
      await rollbackStaffLogin(supabase, member.profile_id)
    }
  }

  await logActivity(supabase, tenantId!, { category: "staff", action: `Deleted staff member "${member.name}"` })

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** [start of periodStart, start of the day AFTER periodEnd) as UTC instants,
 *  on the shop's own calendar (tenant_settings.timezone), not UTC. A shift is
 *  counted in the period its clock-in falls in, as seen on the shop's wall
 *  clock. (Previously this used UTC midnights, which for a UTC+2 shop pushed
 *  a 00:00-02:00 clock-in into the previous day's period.) */
async function periodBoundsUtc(
  supabase: ServerClient,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ ok: true; startIso: string; endExclusiveIso: string } | { ok: false; error: string }> {
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd)) {
    return { ok: false, error: "Select both a start and end date." }
  }
  const { data, error } = await supabase
    .from("tenant_settings")
    .select("timezone")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  const tz = safeTimezone(data?.timezone)
  return {
    ok: true,
    startIso: startOfDayUtc(periodStart, tz).toISOString(),
    endExclusiveIso: startOfDayUtc(addDaysKey(periodEnd, 1), tz).toISOString(),
  }
}

function payslipStaffRow(row: { id: string; name: string; job_title: string | null; hourly_rate: number | null }) {
  return { id: row.id, name: row.name, jobTitle: row.job_title, hourlyRate: row.hourly_rate }
}

/** Fetches previously-calculated payroll rows for a period — read-only,
 *  used by the Payroll tab's table and by the payslip PDF generator.
 *  Does NOT recalculate; use calculatePayroll() for that. */
export async function getPayrollForPeriod(periodStart: string, periodEnd: string) {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.view", "payroll")
  if (!supabase) return { ok: false as const, error: error! }

  const { data, error: fetchError } = await supabase
    .from("staff_payroll")
    .select(
      `id, staff_id, period_start, period_end, hours_worked, hourly_rate, gross_pay, paye, uif, deductions,
       final_pay, payment_status, paid_at, paid_by,
       pay_type, hybrid_mode, base_pay, commission_earned, commission_pay, commission_sales, commission_rate_bps, services_count,
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
      payType: (r.pay_type ?? "hourly") as AdminPayType,
      hybridMode: (r.hybrid_mode ?? null) as AdminHybridMode | null,
      basePay: Number(r.base_pay ?? 0),
      commissionEarned: Number(r.commission_earned ?? 0),
      commissionPay: Number(r.commission_pay ?? 0),
      commissionSales: Number(r.commission_sales ?? 0),
      commissionRatePercent: r.commission_rate_bps == null ? null : Number(r.commission_rate_bps) / 100,
      servicesCount: Number(r.services_count ?? 0),
    })),
  }
}

/** Shifts still open (clocked in, not out) whose clock-in is inside the
 *  period. calculatePayroll() only counts 'completed' shifts, so these hours
 *  are left out of the pay until someone clocks out (or Force clock out). The
 *  Payroll tab shows this as a warning before you calculate or pay. */
export async function getPayrollPeriodWarnings(periodStart: string, periodEnd: string) {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.view", "payroll")
  if (!supabase) return { ok: false as const, error: error! }

  const bounds = await periodBoundsUtc(supabase, tenantId!, periodStart, periodEnd)
  if (!bounds.ok) return { ok: false as const, error: bounds.error }

  const { data, error: fetchError } = await supabase
    .from("staff_shifts")
    .select("login_time, staff ( name )")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .gte("login_time", bounds.startIso)
    .lt("login_time", bounds.endExclusiveIso)
    .order("login_time", { ascending: true })

  if (fetchError) return { ok: false as const, error: fetchError.message }

  const openShifts: AdminPayrollOpenShift[] = (data ?? []).map((r: any) => ({
    staffName: r.staff?.name ?? "Unknown staff",
    loginTime: r.login_time,
  }))

  // Finished walk-ins nobody was credited for. Best-effort: a failure here must not
  // hide the open-shift warning or the table, so it just reports 0.
  const { data: unattributed, error: unattributedError } = await supabase.rpc("staff_commission_unattributed", {
    p_tenant: tenantId,
    p_start: bounds.startIso,
    p_end: bounds.endExclusiveIso,
  })
  const unattributedServices = unattributedError ? 0 : Number(unattributed ?? 0)

  return { ok: true as const, openShifts, unattributedServices }
}

/** Recalculates payroll for every staff member who has pay due in
 *  [periodStart, periodEnd] (both inclusive). What "pay due" means depends on
 *  how each person is paid (staff_pay_profiles; no row = hourly):
 *    hourly      completed shift hours x their current hourly_rate (as before)
 *    commission  commission on the services they delivered in the period
 *                (staff_commission_entries; price and rate were snapshotted
 *                when each service was completed)
 *    hybrid      base_plus_commission: hourly pay AND commission on top
 *                higher_of:            whichever of the two is bigger
 *  Hourly pay uses the *current* hourly_rate. Commission uses each entry's own
 *  snapshotted rate, so a later rate change never rewrites finished services.
 *  Deletes and replaces any 'pending' rows for this exact period first, so
 *  recalculating doesn't duplicate rows; 'paid' rows are left untouched and
 *  recalculating never un-pays something already marked paid. */
export async function calculatePayroll(periodStart: string, periodEnd: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.manage", "payroll")
  if (!supabase) return { ok: false, error: error! }

  if (!periodStart || !periodEnd) return { ok: false, error: "Select both a start and end date." }
  if (periodEnd < periodStart) return { ok: false, error: "End date must be on or after the start date." }

  const bounds = await periodBoundsUtc(supabase, tenantId!, periodStart, periodEnd)
  if (!bounds.ok) return { ok: false, error: bounds.error }

  const periodDays = inclusiveDayCount(periodStart, periodEnd)

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
    .gte("login_time", bounds.startIso)
    .lt("login_time", bounds.endExclusiveIso)

  if (shiftError) return { ok: false, error: shiftError.message }

  const { data: profileRows, error: profileError } = await supabase
    .from("staff_pay_profiles")
    .select("staff_id, pay_type, commission_rate_bps, hybrid_mode")
    .eq("tenant_id", tenantId)
  if (profileError) return { ok: false, error: profileError.message }
  const profiles = new Map((profileRows ?? []).map((r) => [r.staff_id as string, r]))

  // Aggregated in SQL: a busy month can have more entries than one API page returns.
  const { data: commissionRows, error: commissionError } = await supabase.rpc("staff_commission_totals", {
    p_tenant: tenantId,
    p_start: bounds.startIso,
    p_end: bounds.endExclusiveIso,
  })
  if (commissionError) return { ok: false, error: commissionError.message }
  const commissionByStaff = new Map<string, { services: number; salesCents: number; commissionCents: number }>()
  for (const r of (commissionRows ?? []) as Array<{
    staff_id: string
    services_count: number | string
    sales_cents: number | string
    commission_cents: number | string
  }>) {
    commissionByStaff.set(r.staff_id, {
      services: Number(r.services_count),
      salesCents: Number(r.sales_cents),
      commissionCents: Number(r.commission_cents),
    })
  }

  // Staff already marked paid for this exact period keep their paid row. They
  // must not also get a fresh 'pending' row: the delete below only removes
  // 'pending' rows, so without this a recalculation after paying one person
  // would double-count them.
  const { data: paidRows, error: paidError } = await supabase
    .from("staff_payroll")
    .select("staff_id")
    .eq("tenant_id", tenantId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .eq("payment_status", "paid")
  if (paidError) return { ok: false, error: paidError.message }
  const alreadyPaid = new Set((paidRows ?? []).map((r) => r.staff_id as string))

  const hoursByStaff = new Map<string, number>()
  for (const shift of shiftRows ?? []) {
    hoursByStaff.set(shift.staff_id, (hoursByStaff.get(shift.staff_id) ?? 0) + (Number(shift.hours_worked) || 0))
  }

  const round2 = (n: number) => Number(n.toFixed(2))

  // Who has pay due this period, given how they are paid.
  const due = staffRows.filter((staff) => {
    const payType = (profiles.get(staff.id)?.pay_type ?? "hourly") as AdminPayType
    const hasHours = (hoursByStaff.get(staff.id) ?? 0) > 0
    const hasServices = (commissionByStaff.get(staff.id)?.services ?? 0) > 0
    if (payType === "hourly") return hasHours
    if (payType === "commission") return hasServices
    return hasHours || hasServices
  })

  const rowsToInsert = due
    .filter((staff) => !alreadyPaid.has(staff.id))
    .map((staff) => {
      const member = payslipStaffRow(staff)
      const profile = profiles.get(staff.id)
      const payType = (profile?.pay_type ?? "hourly") as AdminPayType
      const hybridMode = (profile?.hybrid_mode ?? "base_plus_commission") as AdminHybridMode
      const hours = hoursByStaff.get(staff.id) ?? 0
      const commission = payType === "hourly" ? undefined : commissionByStaff.get(staff.id)

      // Commission-only staff have no hourly component, whatever hourly_rate says.
      const rate = payType === "commission" ? 0 : (member.hourlyRate ?? 0)
      const basePay = round2(payType === "commission" ? 0 : hours * rate)
      const commissionEarned = round2((commission?.commissionCents ?? 0) / 100)

      let gross: number
      let commissionPay: number
      if (payType === "hybrid" && hybridMode === "higher_of") {
        gross = Math.max(basePay, commissionEarned)
        commissionPay = round2(gross - basePay) // only the part above the hourly amount
      } else {
        commissionPay = commissionEarned
        gross = round2(basePay + commissionPay)
      }

      const deductions = calculatePeriodDeductions(gross, periodDays)
      const net = Math.max(gross - deductions.total, 0)
      return {
        tenant_id: tenantId,
        staff_id: staff.id,
        period_start: periodStart,
        period_end: periodEnd,
        hours_worked: round2(hours),
        hourly_rate: rate,
        gross_pay: round2(gross),
        paye: round2(deductions.paye),
        uif: round2(deductions.uif),
        deductions: round2(deductions.total),
        final_pay: round2(net),
        payment_status: "pending" as const,
        pay_type: payType,
        hybrid_mode: payType === "hybrid" ? hybridMode : null,
        base_pay: basePay,
        commission_earned: commissionEarned,
        commission_pay: commissionPay,
        commission_sales: round2((commission?.salesCents ?? 0) / 100),
        commission_rate_bps: payType === "hourly" ? null : (profile?.commission_rate_bps ?? null),
        services_count: commission?.services ?? 0,
      }
    })

  if (!rowsToInsert.length) {
    return {
      ok: false,
      error:
        due.length > 0
          ? "Everyone with pay due in that period has already been paid."
          : // Keep the "No completed shifts" prefix: PayrollManager shows it as an info message, not an error.
            "No completed shifts or commission services found in that period.",
    }
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
  const { supabase, tenantId, error } = await getTenantScopedClient("staff.view", "payroll", "payroll")
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
  const { supabase, tenantId, error } = await getTenantScopedClient("payroll.view", "payroll")
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

// ============================================================================
// Customers — read-only directory of THIS shop's own customers
// (tenant_customers), with how many bookings / queue visits each has.
// Owner-only (settings.manage), same as the Inbox: it lists customer phone
// numbers and emails. Loaded when the Customers tab is opened rather than
// with the whole admin page, so it doesn't slow down every page load.
// ============================================================================

export interface AdminCustomer {
  id: string
  name: string | null
  phone: string
  email: string | null
  /** Bookings that weren't cancelled. */
  bookingCount: number
  /** Walk-in queue visits (cancelled ones aren't counted). */
  queueCount: number
  /** Start time of their most recent non-cancelled booking (ISO), if any. */
  latestBookingAt: string | null
}

export async function loadCustomers(): Promise<
  { ok: true; customers: AdminCustomer[] } | { ok: false; error: string }
> {
  const { supabase, tenantId, error } = await getTenantScopedClient("settings.manage")
  if (!supabase) return { ok: false, error: error! }

  try {
    // Supabase returns at most 1000 rows per request, so read in pages.
    const PAGE = 1000
    const MAX_ROWS = 50_000
    const fetchAll = async (table: string, columns: string, onlyWithCustomer: boolean): Promise<any[]> => {
      const rows: any[] = []
      for (let from = 0; from < MAX_ROWS; from += PAGE) {
        let query = (supabase as any).from(table).select(columns).eq("tenant_id", tenantId)
        if (onlyWithCustomer) query = query.not("customer_id", "is", null)
        const { data, error: pageError } = await query.order("id", { ascending: true }).range(from, from + PAGE - 1)
        if (pageError) throw new Error(`${table}: ${pageError.message}`)
        rows.push(...(data ?? []))
        if (!data || data.length < PAGE) break
      }
      return rows
    }

    const [customerRows, bookingRows, queueRows] = await Promise.all([
      fetchAll("tenant_customers", "id, full_name, phone, email", false),
      fetchAll("bookings", "id, customer_id, start_time, status", true),
      fetchAll("queue_entries", "id, customer_id, status, source", true),
    ])

    const bookingCounts = new Map<string, number>()
    const latestBooking = new Map<string, string>()
    for (const b of bookingRows) {
      if (b.status === "cancelled") continue
      bookingCounts.set(b.customer_id, (bookingCounts.get(b.customer_id) ?? 0) + 1)
      const current = latestBooking.get(b.customer_id)
      if (!current || b.start_time > current) latestBooking.set(b.customer_id, b.start_time)
    }
    const queueCounts = new Map<string, number>()
    for (const q of queueRows) {
      // Queue entries promoted from a booking (source = 'booking') are already
      // counted as that booking, so only genuine walk-ins count here.
      if (q.status === "cancelled" || q.source !== "walk_in") continue
      queueCounts.set(q.customer_id, (queueCounts.get(q.customer_id) ?? 0) + 1)
    }

    return {
      ok: true,
      customers: customerRows.map((c: any) => ({
        id: c.id,
        name: c.full_name ?? null,
        phone: c.phone ?? "",
        email: c.email ?? null,
        bookingCount: bookingCounts.get(c.id) ?? 0,
        queueCount: queueCounts.get(c.id) ?? 0,
        latestBookingAt: latestBooking.get(c.id) ?? null,
      })),
    }
  } catch (err) {
    console.error("[admin] loadCustomers failed", { tenantId, err })
    return { ok: false, error: "Couldn't load your customers." }
  }
}

export async function deleteCustomer(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient("settings.manage")
  if (!supabase) return { ok: false, error: error! }

  const { data: customer, error: fetchError } = await supabase
    .from("tenant_customers")
    .select("id, full_name, phone")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (fetchError) return { ok: false, error: fetchError.message }
  if (!customer) return { ok: false, error: "Customer not found." }

  const label = customer.full_name?.trim() || customer.phone || "This customer"

  // Don't delete someone who is about to be served: an upcoming booking or a
  // place in today's queue. Those should be cancelled / removed first, so a
  // customer never silently vanishes from the day's schedule.
  const nowIso = new Date().toISOString()
  const [upcomingBookings, activeQueue] = await Promise.all([
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("customer_id", id)
      .eq("status", "confirmed")
      .gt("end_time", nowIso),
    supabase
      .from("queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("customer_id", id)
      .in("status", ["waiting", "called"]),
  ])
  if (upcomingBookings.error) return { ok: false, error: upcomingBookings.error.message }
  if (activeQueue.error) return { ok: false, error: activeQueue.error.message }
  if ((upcomingBookings.count ?? 0) > 0 || (activeQueue.count ?? 0) > 0) {
    return {
      ok: false,
      error: `${label} has an upcoming booking or is in the queue right now. Cancel the booking or remove them from the queue first, then delete them.`,
    }
  }

  // The billing ledger (billable_visits) must keep its rows so past invoices
  // and visit counts stay correct. It blocks deleting the customer, so detach
  // those rows from the customer first (customer_id becomes empty).
  const { error: detachError } = await supabase
    .from("billable_visits")
    .update({ customer_id: null })
    .eq("tenant_id", tenantId)
    .eq("customer_id", id)
  if (detachError) return { ok: false, error: detachError.message }

  // Deleting the customer also deletes their bookings and queue entries
  // (cascade). Their WhatsApp conversations are kept, just unlinked.
  const { error: deleteError } = await supabase
    .from("tenant_customers")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (deleteError) return { ok: false, error: deleteError.message }

  // Deliberately generic: don't write the customer's details into the log.
  await logActivity(supabase, tenantId!, { category: "bookings", action: "Deleted a customer" })

  revalidatePath("/admin")
  return { ok: true }
}
