// lib/services/booking.ts
/**
 * Salon/Barbershop Appointment Booking Service — tenant-scoped.
 * ---------------------------------------------------------------
 * Same three-step flow as before (browse services, pick a date then a
 * time slot, confirm — auto-assigned staff). All customer-facing copy
 * lives in lib/services/messages/booking.ts — this file only owns state
 * transitions and data access. `BookingSlot` is exported from here since
 * messages/booking.ts imports it as a type (slots/dates are booking's
 * own data shape, not copy).
 *
 * KIOSK REFACTOR: the actual "claim a slot and insert" logic that used
 * to live inline inside handleConfirm() is its own exported function,
 * createBooking(). handleConfirm() calls it and does nothing else with
 * the DB itself. This is the single source of truth for what "create a
 * booking" means — the kiosk's Server Action calls the exact same
 * function, so there's no way for WhatsApp and kiosk bookings to drift
 * apart on staff-claiming, reference generation, or insert shape.
 * Likewise buildDateOptions() and getAvailableSlots() are exported: the
 * kiosk's date/time screens need the identical availability logic
 * WhatsApp uses, not a lookalike reimplementation.
 *
 * BOOKING SETTINGS WIRING (new): availability and creation now actually
 * read and enforce booking_settings, business_hours, and
 * tenant_settings.timezone, via lib/services/shared/tenant-scheduling.ts
 * — previously none of that was true; shop hours were a hardcoded UTC
 * constant and booking_settings was never read here at all. Specifically:
 *   - getAvailableSlots() only offers slots inside the tenant's actual
 *     business_hours for that calendar date (in the tenant's timezone),
 *     that are at least `min_notice_minutes` from now, and only for
 *     dates within `max_advance_days`.
 *   - buildDateOptions() is now async and tenant-aware: "today" is the
 *     tenant's local calendar date, and the number of days offered is
 *     capped at `max_advance_days` (never more than
 *     DAYS_AHEAD_OFFERED, to keep a WhatsApp numbered list usable).
 *   - createBooking() re-validates all of the above immediately before
 *     inserting (assertBookingIsAllowed) — defense in depth against a
 *     stale conversation state or a kiosk client replaying an old slot,
 *     same "never trust the client" posture claimStaffForSlot already
 *     had for staff availability.
 *   - SHOP_OPEN_HOUR/SHOP_CLOSE_HOUR (hardcoded 9-18 "shop hours") are
 *     removed — business_hours is now the only source of truth for
 *     opening hours, per the single-source-of-truth requirement.
 *
 * What changed for multi-tenancy (vs the version this replaces):
 *   1. Every exported function and internal data-access helper now takes
 *      `tenantId` as its first argument, and every raw Supabase query
 *      against `staff`/`bookings` now filters `.eq("tenant_id", tenantId)`.
 *   2. Switched from `@/lib/services/customer` to
 *      `@/lib/services/tenant-customer` (tenant_customers-based).
 *   3. `getBookableServices` (services-catalog.ts) now also needs a
 *      `tenantId` argument.
 *
 * PLAN BILLING (from the separate Plans & Billing work): createBooking()
 * also enforces the tenant's plan visit cap via
 * lib/services/plans.ts's assertWithinVisitLimit() — thrown as
 * PLAN_VISIT_LIMIT_REACHED before any slot is claimed or written, same
 * "check first, write nothing on failure" posture as
 * assertBookingIsAllowed(). This only actually blocks anything for a
 * tenant on the free Mahala plan; metered plans (Growth/Business) have
 * no visit_limit, so this check is a no-op for them and they're never
 * stopped mid-booking — they just accrue toward next month's invoice.
 *
 * ASSUMPTIONS — unchanged from the original:
 *   - `services`/`staff`/`bookings` tables, "don't care who" staff
 *     assignment (best-effort re-check at confirm time, no DB-level
 *     lock), no payment step.
 */

import crypto from "node:crypto"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer, updateCustomer, type Customer } from "@/lib/services/tenant-customer"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { queueService } from "@/lib/services/queue"
import { assertWithinVisitLimit, PLAN_VISIT_LIMIT_REACHED } from "@/lib/services/plans"

import {
  getBookingSettings,
  getTenantTimezone,
  getBusinessHoursForDate,
  zonedTimeToUtc,
  todayInTimezone,
  addDaysToDateString,
  isWithinAdvanceWindow,
  type DayHours,
} from "@/lib/services/shared/tenant-scheduling"

import {
  CANCEL_BUTTON,
  ENTRY_CHOICE_BUTTONS,
  entryChoicePromptMessage,
  entryChoiceInvalidMessage,
  servicesListMessage,
  dateOptionsMessage,
  slotsListMessage,
  confirmationMessage,
  invalidSelectionMessage,
  startOverMessage,
  noServicesMessage,
  servicesLoadErrorMessage,
  noSlotsMessage,
  availabilityErrorMessage,
  slotStaleMessage,
  bookingWindowClosedMessage,
  bookingCancelledMessage,
  missingBookingDataMessage,
  confirmYesNoReminderMessage,
  bookingErrorMessage,
  bookingConfirmedMessage,
  nameCollectionRetryMessage,
  nameCollectionThanksMessage,
} from "@/lib/services/messages/booking"

// ============================================================================
// CONSTANTS
// ============================================================================

const BOOKING_STATE_ENTRY_CHOICE = "booking_entry_choice"
const BOOKING_STATE_SERVICE_SELECTION = "booking_service_selection"
const BOOKING_STATE_DATE_SELECTION = "booking_date_selection"
const BOOKING_STATE_TIME_SELECTION = "booking_time_selection"
const BOOKING_STATE_CONFIRM = "booking_confirm"
const BOOKING_STATE_AWAITING_NAME = "booking_awaiting_name"

const SLOT_INTERVAL_MINUTES = 30 // granularity of offered start times
const DAYS_AHEAD_OFFERED = 6 // "today" + up to 6 more days, capped further by max_advance_days

/** Thrown by createBooking() when nobody's free anymore by confirm time.
 *  Exported so callers outside this file (the kiosk action) can match on
 *  it without string-comparing error.message. handleConfirm below still
 *  checks the message string too, for zero behavior change there. */
export const BOOKING_SLOT_NO_LONGER_AVAILABLE = "BOOKING_SLOT_NO_LONGER_AVAILABLE"

/** Thrown by createBooking() when the requested slot no longer satisfies
 *  booking_settings/business_hours — e.g. the conversation sat idle long
 *  enough that min_notice_minutes now excludes it, the day is now beyond
 *  max_advance_days, or the tenant's hours changed underneath it. Same
 *  "never trust a client-provided time" posture as slot staleness. */
export const BOOKING_OUTSIDE_ALLOWED_WINDOW = "BOOKING_OUTSIDE_ALLOWED_WINDOW"

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

function normalizedReplyText(message: IncomingMessage): string {
  return (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
}

function rawReplyText(message: IncomingMessage): string {
  return (message.text ?? message.contentSummary ?? "").trim()
}

// ============================================================================
// STATE DATA
// ============================================================================

type BookingServiceOffer = CatalogService

/** Exported: messages/booking.ts imports this as a type for its message
 * builder signatures (slotsListMessage, confirmationMessage), and the
 * kiosk's Server Actions import it as the shape returned by
 * getAvailableSlots() / passed into createBooking(). */
export interface BookingSlot {
  /** ISO start time, e.g. "2026-09-15T10:30:00.000Z" */
  start: string
  /** Human display, e.g. "10:30" — formatted in the tenant's timezone. */
  label: string
}

interface BookingStateData {
  services?: BookingServiceOffer[]
  selectedService?: BookingServiceOffer
  dateOptions?: Array<{ date: string; label: string }>
  selectedDate?: string
  pendingSlots?: BookingSlot[]
  selectedSlot?: BookingSlot
}

function getBookingData(state: ConversationState): BookingStateData {
  return (state.data ?? {}) as BookingStateData
}

function mergeBookingData(current: BookingStateData, patch: Partial<BookingStateData>): ConversationState["data"] {
  return { ...current, ...patch } as ConversationState["data"]
}

// ============================================================================
// DATA ACCESS — availability, tenant-scoped
// ============================================================================

interface ActiveStaff {
  id: string
  name: string
}

async function getActiveStaff(supabase: SupabaseClient, tenantId: string): Promise<ActiveStaff[]> {
  const { data, error } = await supabase
    .from("staff")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("active", true)
  if (error) throw new Error(`Failed to load staff: ${error.message}`)
  return data ?? []
}

/**
 * Returns booked (staff_id, start_time, end_time) rows whose start_time
 * falls within [windowStart, windowEnd] (inclusive), scoped to this
 * tenant, across all active staff — used to check slot overlaps in
 * memory rather than one query per candidate slot. Bounds are now the
 * tenant's actual business-hours window for a date (see resolveDayWindow
 * below), not a fixed UTC calendar day — a shop whose local day doesn't
 * align with the UTC day (anything not UTC+0) previously risked missing
 * or double counting bookings near midnight.
 */
async function getBookingsInWindow(
  supabase: SupabaseClient,
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Array<{ staffId: string; start: Date; end: Date }>> {
  const { data, error } = await supabase
    .from("bookings")
    .select("staff_id, start_time, end_time")
    .eq("tenant_id", tenantId)
    .eq("status", "confirmed")
    .gte("start_time", windowStart.toISOString())
    .lte("start_time", windowEnd.toISOString())

  if (error) throw new Error(`Failed to load bookings: ${error.message}`)

  return (data ?? []).map((b) => ({
    staffId: b.staff_id,
    start: new Date(b.start_time),
    end: new Date(b.end_time),
  }))
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

interface DayWindow {
  timezone: string
  hours: DayHours
  /** null when the tenant is closed that day / has no hours configured. */
  dayOpenUTC: Date | null
  dayCloseUTC: Date | null
}

/**
 * Resolves everything needed to reason about one calendar date for one
 * tenant: their timezone, their configured hours for that weekday, and
 * those hours converted to UTC instants. The one place this
 * timezone+business-hours resolution happens, shared by availability
 * generation, staff claiming, and the final pre-insert check — so all
 * three agree by construction instead of three separate calculations
 * that could drift apart.
 */
async function resolveDayWindow(supabase: SupabaseClient, tenantId: string, dateISO: string): Promise<DayWindow> {
  const timezone = await getTenantTimezone(supabase, tenantId)
  const hours = await getBusinessHoursForDate(supabase, tenantId, dateISO)

  if (hours.isClosed || !hours.openTime || !hours.closeTime) {
    return { timezone, hours, dayOpenUTC: null, dayCloseUTC: null }
  }

  return {
    timezone,
    hours,
    dayOpenUTC: zonedTimeToUtc(dateISO, hours.openTime, timezone),
    dayCloseUTC: zonedTimeToUtc(dateISO, hours.closeTime, timezone),
  }
}

/**
 * Generates candidate slots for the date at SLOT_INTERVAL_MINUTES
 * granularity within the tenant's ACTUAL business hours for that
 * weekday (business_hours, in the tenant's timezone), excluding
 * anything inside `min_notice_minutes` of now and any date outside
 * `max_advance_days`, keeping only slots where at least one of this
 * tenant's active staff is free for the full service duration.
 *
 * Exported: the kiosk's time-selection screen calls this directly so
 * it's checking the exact same availability WhatsApp would show for the
 * same tenant/date/service, not a second calculation that could disagree.
 */
export async function getAvailableSlots(tenantId: string, dateISO: string, durationMinutes: number): Promise<BookingSlot[]> {
  const supabase = getClientOrThrow()

  const [staff, bookingSettings, dayWindow] = await Promise.all([
    getActiveStaff(supabase, tenantId),
    getBookingSettings(supabase, tenantId),
    resolveDayWindow(supabase, tenantId, dateISO),
  ])

  if (staff.length === 0) return []
  // Closed that day / no hours configured for that weekday at all.
  if (!dayWindow.dayOpenUTC || !dayWindow.dayCloseUTC) return []

  const today = todayInTimezone(dayWindow.timezone)
  if (!isWithinAdvanceWindow(dateISO, today, bookingSettings.maxAdvanceDays)) return []

  const existingBookings = await getBookingsInWindow(supabase, tenantId, dayWindow.dayOpenUTC, dayWindow.dayCloseUTC)

  const minNoticeCutoffMillis = Date.now() + bookingSettings.minNoticeMinutes * 60_000

  const slots: BookingSlot[] = []
  for (
    let slotStartMillis = dayWindow.dayOpenUTC.getTime();
    slotStartMillis + durationMinutes * 60_000 <= dayWindow.dayCloseUTC.getTime();
    slotStartMillis += SLOT_INTERVAL_MINUTES * 60_000
  ) {
    if (slotStartMillis < minNoticeCutoffMillis) continue

    const slotStart = new Date(slotStartMillis)
    const slotEnd = new Date(slotStartMillis + durationMinutes * 60_000)

    const anyStaffFree = staff.some((member) => {
      const memberBookings = existingBookings.filter((b) => b.staffId === member.id)
      return !memberBookings.some((b) => overlaps(slotStart, slotEnd, b.start, b.end))
    })

    if (anyStaffFree) {
      slots.push({
        start: slotStart.toISOString(),
        label: new Intl.DateTimeFormat("en-ZA", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: dayWindow.timezone,
        }).format(slotStart),
      })
    }
  }

  return slots
}

/**
 * Re-checks and claims a staff member for the exact slot right before
 * insert — best-effort with fallback. Throws if genuinely nobody on
 * THIS TENANT is free anymore.
 */
async function claimStaffForSlot(
  supabase: SupabaseClient,
  tenantId: string,
  dateISO: string,
  slot: BookingSlot,
  durationMinutes: number,
): Promise<ActiveStaff> {
  const staff = await getActiveStaff(supabase, tenantId)
  const dayWindow = await resolveDayWindow(supabase, tenantId, dateISO)

  const slotStart = new Date(slot.start)
  const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)

  // Fall back to a window around just this slot if the day somehow has
  // no resolved hours here (assertBookingIsAllowed, called before this
  // in createBooking, already rejects that case — this is a defensive
  // fallback, not the expected path).
  const windowStart = dayWindow.dayOpenUTC ?? slotStart
  const windowEnd = dayWindow.dayCloseUTC ?? slotEnd

  const existingBookings = await getBookingsInWindow(supabase, tenantId, windowStart, windowEnd)

  const freeStaff = staff.find((member) => {
    const memberBookings = existingBookings.filter((b) => b.staffId === member.id)
    return !memberBookings.some((b) => overlaps(slotStart, slotEnd, b.start, b.end))
  })

  if (!freeStaff) {
    throw new Error(BOOKING_SLOT_NO_LONGER_AVAILABLE)
  }

  return freeStaff
}

/**
 * Final server-side gate before a booking is inserted — re-validates
 * business hours, max_advance_days, and min_notice_minutes against the
 * requested slot. Never trusts that a slot offered earlier in the
 * conversation (or passed in by the kiosk) is still valid: a customer
 * can sit on a "confirm?" prompt for a while, booking_settings can
 * change mid-conversation, and the kiosk calls createBooking() directly
 * with client-supplied data. Throws BOOKING_OUTSIDE_ALLOWED_WINDOW if
 * anything no longer holds.
 */
async function assertBookingIsAllowed(
  supabase: SupabaseClient,
  tenantId: string,
  dateISO: string,
  slot: BookingSlot,
  durationMinutes: number,
): Promise<void> {
  const [bookingSettings, dayWindow] = await Promise.all([
    getBookingSettings(supabase, tenantId),
    resolveDayWindow(supabase, tenantId, dateISO),
  ])

  if (!dayWindow.dayOpenUTC || !dayWindow.dayCloseUTC) {
    throw new Error(BOOKING_OUTSIDE_ALLOWED_WINDOW)
  }

  const today = todayInTimezone(dayWindow.timezone)
  if (!isWithinAdvanceWindow(dateISO, today, bookingSettings.maxAdvanceDays)) {
    throw new Error(BOOKING_OUTSIDE_ALLOWED_WINDOW)
  }

  const slotStart = new Date(slot.start)
  const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)

  if (slotStart.getTime() < dayWindow.dayOpenUTC.getTime() || slotEnd.getTime() > dayWindow.dayCloseUTC.getTime()) {
    throw new Error(BOOKING_OUTSIDE_ALLOWED_WINDOW)
  }

  const minNoticeCutoffMillis = Date.now() + bookingSettings.minNoticeMinutes * 60_000
  if (slotStart.getTime() < minNoticeCutoffMillis) {
    throw new Error(BOOKING_OUTSIDE_ALLOWED_WINDOW)
  }
}

// ============================================================================
// SHARED CORE — claim + insert. Called by handleConfirm (WhatsApp) AND
// the kiosk's Server Action. This is the ONE place a `bookings` row gets
// created from a customer-facing flow.
// ============================================================================

export interface CreateBookingParams {
  /** The full catalog entry, not just an id — both callers already have
   *  it in hand (WhatsApp from conversation state, kiosk from its own
   *  services fetch), and durationMinutes is needed for the claim check
   *  regardless. */
  service: CatalogService
  dateISO: string
  slot: BookingSlot
  /** Raw or normalized — ensureCustomer() normalizes internally, so
   *  either is safe to pass here. */
  phone: string
}

export interface CreateBookingResult {
  customer: Customer
  bookingReference: string
  startTime: string
  endTime: string
}

/**
 * Validates the slot against booking_settings/business_hours, claims a
 * staff member for it, and inserts the `bookings` row. Throws an Error
 * with message BOOKING_OUTSIDE_ALLOWED_WINDOW if the slot no longer
 * satisfies booking policy, or BOOKING_SLOT_NO_LONGER_AVAILABLE if the
 * slot was taken between when it was offered and now — callers should
 * catch both and show a "pick another time" style message rather than a
 * generic error, since both are expected races/edge cases, not bugs.
 */
export async function createBooking(tenantId: string, params: CreateBookingParams): Promise<CreateBookingResult> {
  const { service, dateISO, slot, phone } = params
  const supabase = getClientOrThrow()

  // Plan enforcement runs first and cheapest — no point checking business
  // hours or claiming a staff member for a booking that's about to be
  // rejected because the tenant is over their monthly visit cap anyway.
  await assertWithinVisitLimit(supabase, tenantId)

  await assertBookingIsAllowed(supabase, tenantId, dateISO, slot, service.durationMinutes)

  const staff = await claimStaffForSlot(supabase, tenantId, dateISO, slot, service.durationMinutes)

  // Minimal (phone-only) tenant_customers row if this is a brand-new
  // customer — no name/email required to book, on either channel.
  const customer = await ensureCustomer(tenantId, phone)

  const startTime = new Date(slot.start)
  const endTime = new Date(startTime.getTime() + service.durationMinutes * 60_000)
  const bookingReference = crypto.randomUUID().slice(0, 8).toUpperCase()

  const { error } = await supabase.from("bookings").insert([
    {
      tenant_id: tenantId,
      customer_id: customer.id,
      service_id: service.id,
      staff_id: staff.id,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      status: "confirmed",
      booking_reference: bookingReference,
    },
  ])

  if (error) throw new Error(error.message)

  return {
    customer,
    bookingReference,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  }
}

// ============================================================================
// ENTRY POINT — fresh "booking" intent
// ============================================================================

async function handleBooking(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  return {
    reply: entryChoicePromptMessage(),
    buttons: ENTRY_CHOICE_BUTTONS,
    nextState: { state: BOOKING_STATE_ENTRY_CHOICE, data: {} },
  }
}

async function handleEntryChoice(tenantId: string, message: IncomingMessage): Promise<ActionResult> {
  const text = normalizedReplyText(message)

  if (text.includes("queue")) {
    return queueService.startQueueFlow(tenantId)
  }
  if (text.includes("book")) {
    return presentServices(tenantId)
  }

  return {
    reply: entryChoiceInvalidMessage(),
    buttons: ENTRY_CHOICE_BUTTONS,
    nextState: { state: BOOKING_STATE_ENTRY_CHOICE, data: {} },
  }
}

async function presentServices(tenantId: string): Promise<ActionResult> {
  let services: BookingServiceOffer[]
  try {
    services = await getBookableServices(tenantId)
  } catch (error) {
    console.error("[booking] Error loading services", { tenantId, error })
    return { reply: servicesLoadErrorMessage(), buttons: [], nextState: null }
  }

  if (services.length === 0) {
    return { reply: noServicesMessage(), buttons: [], nextState: null }
  }

  return {
    reply: servicesListMessage(services),
    buttons: [],
    nextState: { state: BOOKING_STATE_SERVICE_SELECTION, data: { services } },
  }
}

// ============================================================================
// STEP 2: service → date options
// ============================================================================

/**
 * Exported: the kiosk's date-selection screen calls this directly so
 * "today, tomorrow, next N days" is computed identically for both
 * channels — no separate date-formatting logic to keep in sync.
 *
 * Tenant-aware (new): "today" is the tenant's own local calendar date
 * (tenant_settings.timezone), not the server's/UTC's. The number of
 * days offered is capped at booking_settings.max_advance_days — a shop
 * with a 3-day advance window won't show 6 days of dates that would
 * just get rejected server-side if picked.
 */
export async function buildDateOptions(tenantId: string): Promise<Array<{ date: string; label: string }>> {
  const supabase = getClientOrThrow()

  const [timezone, bookingSettings] = await Promise.all([
    getTenantTimezone(supabase, tenantId),
    getBookingSettings(supabase, tenantId),
  ])

  const today = todayInTimezone(timezone)
  const daysToOffer = Math.min(DAYS_AHEAD_OFFERED, Math.max(0, bookingSettings.maxAdvanceDays))

  const options: Array<{ date: string; label: string }> = []
  for (let i = 0; i <= daysToOffer; i++) {
    const dateISO = addDaysToDateString(today, i)
    const label =
      i === 0
        ? "Today"
        : i === 1
          ? "Tomorrow"
          : // Anchored at UTC noon purely so formatting this pure calendar
            // date can't roll over to the adjacent day in any timezone —
            // dateISO already IS the tenant-local calendar date, no further
            // timezone conversion is needed just to format it as text.
            new Date(`${dateISO}T12:00:00.000Z`).toLocaleDateString("en-ZA", {
              weekday: "short",
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            })
    options.push({ date: dateISO, label })
  }

  return options
}

async function handleServiceSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const services = data.services ?? []
  const index = Number(rawReplyText(message)) - 1

  if (!Number.isInteger(index) || index < 0 || index >= services.length) {
    return { reply: invalidSelectionMessage(services.length), buttons: [], nextState: state }
  }

  const selectedService = services[index]
  const dateOptions = await buildDateOptions(tenantId)

  return {
    reply: dateOptionsMessage(dateOptions),
    buttons: [],
    nextState: {
      state: BOOKING_STATE_DATE_SELECTION,
      data: mergeBookingData(data, { selectedService, dateOptions }),
    },
  }
}

// ============================================================================
// STEP 3: date → time slots
// ============================================================================

async function handleDateSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const dateOptions = data.dateOptions ?? []
  const selectedService = data.selectedService
  const index = Number(rawReplyText(message)) - 1

  if (!selectedService) {
    return { reply: startOverMessage(), buttons: [], nextState: null }
  }

  if (!Number.isInteger(index) || index < 0 || index >= dateOptions.length) {
    return { reply: invalidSelectionMessage(dateOptions.length), buttons: [], nextState: state }
  }

  const chosen = dateOptions[index]

  let slots: BookingSlot[]
  try {
    slots = await getAvailableSlots(tenantId, chosen.date, selectedService.durationMinutes)
  } catch (error) {
    console.error("[booking] Error loading slots", { tenantId, date: chosen.date, error })
    return { reply: availabilityErrorMessage(), buttons: [], nextState: null }
  }

  if (slots.length === 0) {
    return { reply: noSlotsMessage(), buttons: [], nextState: { state: BOOKING_STATE_DATE_SELECTION, data } }
  }

  return {
    reply: slotsListMessage(selectedService.name, chosen.label, slots),
    buttons: [],
    nextState: {
      state: BOOKING_STATE_TIME_SELECTION,
      data: mergeBookingData(data, { selectedDate: chosen.date, pendingSlots: slots }),
    },
  }
}

// ============================================================================
// STEP 4: time slot → confirmation summary
// ============================================================================

async function handleTimeSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const slots = data.pendingSlots ?? []
  const index = Number(rawReplyText(message)) - 1

  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { reply: invalidSelectionMessage(slots.length), buttons: [], nextState: state }
  }

  const selectedSlot = slots[index]
  const selectedService = data.selectedService
  const dateLabel = data.dateOptions?.find((d) => d.date === data.selectedDate)?.label ?? data.selectedDate ?? ""

  if (!selectedService) {
    return { reply: startOverMessage(), buttons: [], nextState: null }
  }

  return {
    reply: confirmationMessage(selectedService, dateLabel, selectedSlot),
    buttons: [],
    nextState: {
      state: BOOKING_STATE_CONFIRM,
      data: mergeBookingData(data, { selectedSlot }),
    },
  }
}

// ============================================================================
// STEP 5: confirm → create the booking
// ============================================================================

async function handleConfirm(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const text = normalizedReplyText(message)
  const data = getBookingData(state)

  if (text === "no" || text.includes("cancel")) {
    return { reply: bookingCancelledMessage(), buttons: CANCEL_BUTTON, nextState: null }
  }

  if (text !== "yes" && !text.includes("confirm")) {
    return { reply: confirmYesNoReminderMessage(), buttons: [], nextState: state }
  }

  const { selectedService, selectedDate, selectedSlot } = data
  if (!selectedService || !selectedDate || !selectedSlot) {
    return { reply: missingBookingDataMessage(), buttons: [], nextState: null }
  }

  try {
    const result = await createBooking(tenantId, {
      service: selectedService,
      dateISO: selectedDate,
      slot: selectedSlot,
      phone: message.from,
    })

    return {
      reply: bookingConfirmedMessage({
        customerName: result.customer.name,
        serviceName: selectedService.name,
        slotLabel: selectedSlot.label,
        bookingReference: result.bookingReference,
      }),
      buttons: result.customer.name ? CANCEL_BUTTON : [],
      nextState: result.customer.name ? null : { state: BOOKING_STATE_AWAITING_NAME, data: {} },
    }
  } catch (error) {
    if (error instanceof Error && error.message === BOOKING_SLOT_NO_LONGER_AVAILABLE) {
      return { reply: slotStaleMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_OUTSIDE_ALLOWED_WINDOW) {
      return { reply: bookingWindowClosedMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === PLAN_VISIT_LIMIT_REACHED) {
      // TODO: move this into lib/services/messages/booking.ts as a proper
      // planLimitReachedMessage() alongside the other booking copy, once
      // that file's conventions are in hand — inlined here for now so this
      // merge doesn't guess at that file's shape.
      return {
        reply: "Sorry, this shop has reached its booking limit for this month. Please try again next month, or contact them directly.",
        buttons: [],
        nextState: null,
      }
    }
    console.error("[booking] Error creating booking", { tenantId, error })
    return { reply: bookingErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// POST-BOOKING: lightweight name collection
// ============================================================================

async function handleNameCollection(tenantId: string, message: IncomingMessage): Promise<ActionResult> {
  const name = rawReplyText(message)

  if (!name || name.length < 2) {
    return {
      reply: nameCollectionRetryMessage(),
      buttons: [],
      nextState: { state: BOOKING_STATE_AWAITING_NAME, data: {} },
    }
  }

  try {
    await updateCustomer(tenantId, message.from, { name })
  } catch (error) {
    console.error("[booking] Failed to save customer name", { tenantId, error })
  }

  return {
    reply: nameCollectionThanksMessage(name),
    buttons: CANCEL_BUTTON,
    nextState: null,
  }
}

// ============================================================================
// STATE DISPATCH
// ============================================================================

async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case BOOKING_STATE_ENTRY_CHOICE:
      return handleEntryChoice(tenantId, message)
    case BOOKING_STATE_SERVICE_SELECTION:
      return handleServiceSelection(tenantId, state, message)
    case BOOKING_STATE_DATE_SELECTION:
      return handleDateSelection(tenantId, state, message)
    case BOOKING_STATE_TIME_SELECTION:
      return handleTimeSelection(tenantId, state, message)
    case BOOKING_STATE_CONFIRM:
      return handleConfirm(tenantId, state, message)
    case BOOKING_STATE_AWAITING_NAME:
      return handleNameCollection(tenantId, message)
    default:
      return null
  }
}

export const bookingService = {
  handleBooking,
  handleState,
}
