// lib/services/rebook.ts
/**
 * "Same again?" — one-tap rebooking for returning customers.
 * ----------------------------------------------------------
 * Looks up a customer's last COMPLETED visit and turns it into one concrete
 * proposal: the same service(s), the same staff member when that applies, and a
 * real free slot near their usual weekday and time of day. booking.ts owns the
 * conversation (state booking_rebook_offer) and the actual booking: this file
 * only answers "is there an offer for this person, and what is it?". It never
 * writes anything, and createBooking() re-validates everything at confirm time.
 *
 * Visit history (no schema change needed):
 *   - queue_entries   status = 'done'      (completed_at)   walk-ins + promoted bookings
 *   - bookings        status = 'completed' (start_time)     appointments
 * The most recent of the two wins. Services come from the link tables
 * (queue_entry_services / booking_services, in `position` order); entries written
 * before multi-service existed, or by the promote-bookings cron, have no link rows,
 * so we fall back to the promoted booking's rows, then to the single service_id.
 *
 * No offer (returns null) when any of these holds, so the normal flow just runs:
 *   - no phone match, no completed visit, or the visit had no service
 *   - the customer already has an upcoming booking or is in the live queue
 *     (the database would refuse a new booking anyway: block_duplicate_booking)
 *   - a service from that visit is no longer bookable, or the visit had more
 *     services than booking_settings.max_services_per_booking allows today
 *   - nothing is free in the dates offered
 * Never throws: a failed lookup only means the customer doesn't see the shortcut.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { pickSuggestedSlot } from "@/lib/services/shared/rebook-pick"
import {
  buildDateOptions,
  getAvailableSlots,
  getMaxServicesPerBooking,
  type BookingSlot,
} from "@/lib/services/booking"

export interface SameAgainOffer {
  customerName: string | null
  /** Primary first, exactly as they were saved on the last visit. */
  services: CatalogService[]
  /** Set only when the last visit was a booking with an active staff member AND the
   *  shop lets customers choose staff. The suggested slot is free for this person. */
  staff?: { id: string; name: string }
  dateISO: string
  dateLabel: string
  slot: BookingSlot
  /** The dates the normal flow would list, kept so "Other time" can jump straight to them. */
  dateOptions: Array<{ date: string; label: string }>
  maxServices: number
}

interface LastVisit {
  source: "queue" | "booking"
  id: string
  at: Date
  serviceId: string | null
  /** The booking this visit belongs to, when there is one (always for source = booking). */
  bookingId: string | null
}

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

/** Customers are stored as "0821234567" or "27821234567", so match on the last 9 digits
 *  (the same key whatsapp_optins uses) instead of trusting one exact format. */
function phoneKey(phone: string): string | null {
  const digits = phone.replace(/\D/g, "")
  return digits.length >= 9 ? digits.slice(-9) : null
}

async function loadLastVisit(supabase: SupabaseClient, tenantId: string, customerIds: string[]): Promise<LastVisit | null> {
  const [queueResult, bookingResult] = await Promise.all([
    supabase
      .from("queue_entries")
      .select("id, service_id, booking_id, completed_at")
      .eq("tenant_id", tenantId)
      .in("customer_id", customerIds)
      .eq("status", "done")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1),
    supabase
      .from("bookings")
      .select("id, service_id, start_time")
      .eq("tenant_id", tenantId)
      .in("customer_id", customerIds)
      .eq("status", "completed")
      // A booking marked complete before its start time (done early, or while testing) is not a
      // visit that has happened yet: without this it would outrank every real past visit.
      .lte("start_time", new Date().toISOString())
      .order("start_time", { ascending: false })
      .limit(1),
  ])

  if (queueResult.error) throw new Error(`Failed to load last queue visit: ${queueResult.error.message}`)
  if (bookingResult.error) throw new Error(`Failed to load last booking visit: ${bookingResult.error.message}`)

  const q = queueResult.data?.[0]
  const b = bookingResult.data?.[0]

  const fromQueue: LastVisit | null = q
    ? {
        source: "queue",
        id: q.id,
        at: new Date(q.completed_at),
        serviceId: q.service_id ?? null,
        bookingId: q.booking_id ?? null,
      }
    : null
  const fromBooking: LastVisit | null = b
    ? { source: "booking", id: b.id, at: new Date(b.start_time), serviceId: b.service_id ?? null, bookingId: b.id }
    : null

  if (fromQueue && fromBooking) return fromQueue.at >= fromBooking.at ? fromQueue : fromBooking
  return fromQueue ?? fromBooking
}

async function loadLinkedServiceIds(
  supabase: SupabaseClient,
  tenantId: string,
  table: "queue_entry_services" | "booking_services",
  parentColumn: "queue_entry_id" | "booking_id",
  parentId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from(table)
    .select("service_id, position")
    .eq("tenant_id", tenantId)
    .eq(parentColumn, parentId)
    .order("position", { ascending: true })
  if (error) throw new Error(`Failed to load ${table}: ${error.message}`)
  return (data ?? []).map((row: { service_id: string }) => row.service_id)
}

/** Everything the last visit included, in order. */
async function loadVisitServiceIds(supabase: SupabaseClient, tenantId: string, visit: LastVisit): Promise<string[]> {
  if (visit.source === "queue") {
    const own = await loadLinkedServiceIds(supabase, tenantId, "queue_entry_services", "queue_entry_id", visit.id)
    if (own.length > 0) return own
  }
  if (visit.bookingId) {
    const viaBooking = await loadLinkedServiceIds(supabase, tenantId, "booking_services", "booking_id", visit.bookingId)
    if (viaBooking.length > 0) return viaBooking
  }
  return visit.serviceId ? [visit.serviceId] : []
}

/** The customer can't book while they have an upcoming booking or a live queue entry. */
async function hasBlockingVisit(supabase: SupabaseClient, tenantId: string, customerIds: string[]): Promise<boolean> {
  const [upcoming, live] = await Promise.all([
    supabase
      .from("bookings")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("customer_id", customerIds)
      .eq("status", "confirmed")
      .gt("end_time", new Date().toISOString())
      .limit(1),
    supabase
      .from("queue_entries")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("customer_id", customerIds)
      .in("status", ["waiting", "called"])
      .limit(1),
  ])
  if (upcoming.error) throw new Error(`Failed to check upcoming bookings: ${upcoming.error.message}`)
  if (live.error) throw new Error(`Failed to check live queue entries: ${live.error.message}`)
  return (upcoming.data ?? []).length > 0 || (live.data ?? []).length > 0
}

/** The staff member who served the last booking, only if the shop lets customers pick
 *  staff and that person is still active. Queue visits don't record who served them. */
async function loadPreferredStaff(
  supabase: SupabaseClient,
  tenantId: string,
  bookingId: string | null,
): Promise<{ id: string; name: string } | undefined> {
  if (!bookingId) return undefined

  const [settings, booking] = await Promise.all([
    supabase.from("booking_settings").select("allow_customer_staff_choice").eq("tenant_id", tenantId).maybeSingle(),
    supabase.from("bookings").select("staff_id").eq("id", bookingId).eq("tenant_id", tenantId).maybeSingle(),
  ])
  if (settings.error || booking.error) return undefined
  if (settings.data?.allow_customer_staff_choice !== true || !booking.data?.staff_id) return undefined

  const { data: staff, error } = await supabase
    .from("staff")
    .select("id, name, active")
    .eq("id", booking.data.staff_id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error || !staff || staff.active !== true) return undefined
  return { id: staff.id, name: staff.name }
}

export async function findSameAgainOffer(tenantId: string, phone: string): Promise<SameAgainOffer | null> {
  try {
    const key = phoneKey(phone)
    if (!key) return null

    const supabase = getClientOrThrow()

    const { data: customers, error: customerError } = await supabase
      .from("tenant_customers")
      .select("id, full_name")
      .eq("tenant_id", tenantId)
      .like("phone", `%${key}`)
      .order("created_at", { ascending: false })
    if (customerError) throw new Error(`Failed to look up customer: ${customerError.message}`)
    if (!customers || customers.length === 0) return null

    const customerIds = customers.map((c: { id: string }) => c.id)

    if (await hasBlockingVisit(supabase, tenantId, customerIds)) return null

    const visit = await loadLastVisit(supabase, tenantId, customerIds)
    if (!visit) return null

    const serviceIds = await loadVisitServiceIds(supabase, tenantId, visit)
    if (serviceIds.length === 0) return null

    // Resolve against what is bookable TODAY, so price/duration are current and a
    // retired service never gets offered. A partly-missing visit isn't "the same".
    const [catalog, maxServices] = await Promise.all([getBookableServices(tenantId), getMaxServicesPerBooking(tenantId)])
    const byId = new Map(catalog.map((s) => [s.id, s]))
    const services = serviceIds.map((id) => byId.get(id))
    if (services.some((s) => !s)) return null
    const resolved = services as CatalogService[]
    if (resolved.length > maxServices) return null

    const [dateOptions, timezone, preferredStaff] = await Promise.all([
      buildDateOptions(tenantId),
      getTenantTimezone(supabase, tenantId),
      loadPreferredStaff(supabase, tenantId, visit.bookingId),
    ])
    if (dateOptions.length === 0) return null

    const durationMinutes = resolved.reduce((sum, s) => sum + s.durationMinutes, 0)

    const slotsFor = (staffId?: string) =>
      Promise.all(
        dateOptions.map((d) =>
          getAvailableSlots(tenantId, d.date, durationMinutes, undefined, staffId).catch((error) => {
            console.error("[rebook] Could not load slots", { tenantId, date: d.date, error })
            return [] as BookingSlot[]
          }),
        ),
      )

    // Their usual person first; if that person has nothing free in the window, offer the
    // shop's automatic assignment instead of no shortcut at all (and don't name anyone).
    let staff = preferredStaff
    let pick = pickSuggestedSlot({
      dates: dateOptions,
      slotsByDate: await slotsFor(staff?.id),
      lastVisitAt: visit.at,
      timezone,
    })
    if (!pick && staff) {
      staff = undefined
      pick = pickSuggestedSlot({
        dates: dateOptions,
        slotsByDate: await slotsFor(undefined),
        lastVisitAt: visit.at,
        timezone,
      })
    }
    if (!pick) return null

    return {
      customerName: (customers[0] as { full_name: string | null }).full_name ?? null,
      services: resolved,
      ...(staff ? { staff } : {}),
      dateISO: pick.date.date,
      dateLabel: pick.date.label,
      slot: pick.slot,
      dateOptions,
      maxServices,
    }
  } catch (error) {
    console.error("[rebook] Could not build a same-again offer, using the normal flow", { tenantId, error })
    return null
  }
}
