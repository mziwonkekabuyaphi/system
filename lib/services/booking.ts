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
 * tenant on the Free plan (no per-visit rate to bill overage at, so a
 * hard cap is the only option once its 100 lifetime visits are used).
 * Growth and Business both have a price_per_visit_cents, so usage past
 * their visit_limit (Growth's included 2,500/month) or all usage
 * (Business, whose visit_limit is null) simply becomes billable overage
 * on next month's invoice instead of blocking — see
 * lib/services/billing-calculator.ts for the actual math.
 *
 * ASSUMPTIONS — unchanged from the original:
 *   - `services`/`staff`/`bookings` tables, "don't care who" staff
 *     assignment (best-effort re-check at confirm time, no DB-level
 *     lock), no payment step.
 *
 * COMPLETING A BOOKING (new): completeBooking() is the only place that
 * ever moves a booking to status='completed'. Nothing in this file (or
 * anywhere else, as of this addition) called that transition before —
 * bookings only ever went confirmed -> confirmed or confirmed ->
 * cancelled. It matters now because 'completed' is what the billing
 * ledger's booking-side trigger (trg_record_booking_billable_visit,
 * see the billing migration) listens for: a booking that was never
 * promoted into the queue only becomes a billable visit once something
 * calls this. This is a plain exported service function, not a Server
 * Action — the admin dashboard's "mark as done" button should call it
 * from a thin Server Action in app/admin/actions.ts (gated by the
 * existing bookings.manage permission, same as any other write there),
 * the same relationship createBooking() already has with the kiosk's
 * Server Action.
 *
 * MENU + TYPED ENTRY (new): the WhatsApp main menu (lib/whatsapp/utils/
 * services-list.ts) replaces the old "Queue or Book?" button prompt for most
 * customers. "Book Now" calls presentServices() directly (now exported, also
 * available as bookingService.startBookingFlow). handleBooking() still works
 * for typed messages: a clear "queue"/"walk-in" message goes straight to the
 * queue flow, a clear "book"/"appointment" message goes straight to the
 * services list, and anything ambiguous ("I need a haircut") still gets the
 * Queue-or-Book buttons.
 *
 * MULTI-SERVICE (new): a booking can now cover several services, up to the
 * tenant's booking_settings.max_services_per_booking (1-5, default 1 = the
 * old single-service behaviour). createBooking() takes the primary
 * `service` plus optional `extraServices`; the booking is as long as all of
 * them back to back (availability, staff claim and end_time all use the
 * summed duration). bookings.service_id keeps the FIRST service so billing,
 * WhatsApp, the admin list and the public display keep working unchanged,
 * and booking_services holds the full list in order. The limit is enforced
 * here, server-side, not just hidden in the kiosk UI. WhatsApp still offers
 * one service per booking until its flow is updated.
 *
 * RESCHEDULING (new): rescheduleBooking() moves a confirmed booking to a new
 * time in one UPDATE (services, reference and length unchanged). The customer
 * flow that drives it is lib/services/reschedule.ts. getAvailableSlots() and
 * claimStaffForSlot() gained an optional "ignore this booking" argument so a
 * booking never blocks its own new time.
 *
 * ONE-MESSAGE BOOKING (new, AI): when a typed message carries real detail
 * ("haircut tomorrow 3pm", in English, isiXhosa, isiZulu, Afrikaans...),
 * trySmartBooking() asks lib/ai/booking-parser.ts to extract service / date /
 * time and then jumps the SAME state machine forward as far as the message
 * allows: service only -> date screen; service + date -> time list; service +
 * date + a free time -> the confirmation summary. The AI only extracts (against
 * the shop's real services and bookable dates, re-validated); it never creates
 * anything. The customer still replies "yes" at the confirm step, and
 * createBooking() is still the only writer. Any AI failure or missing detail
 * returns null and the ordinary flow below runs exactly as before.
 *
 * SAME AGAIN? (new): a returning customer (one with a completed visit in
 * queue_entries or bookings) is offered their last service(s), the same staff
 * member when staff choice is on, and one concrete free slot near their usual
 * weekday and time, with Yes / Other time / Something else buttons. Yes runs
 * handleConfirm() unchanged, so createBooking() stays the only writer. Entered
 * from handleBooking() (typed "book", "same again", "I need a haircut"...) and,
 * if the caller passes the phone, from presentServices() (the "Book Now" row).
 * The lookup lives in lib/services/rebook.ts and is read-only.
 */


import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer, updateCustomer, type Customer } from "@/lib/services/tenant-customer"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { queueService } from "@/lib/services/queue"
import {
  DEFAULT_BOOKING_NUMBER_PREFIX,
  formatBookingTicketNumber,
  generateBookingReference,
} from "@/lib/services/ticket-format"
import { getCardOption, startCardPayment } from "@/lib/payments/card"
import { formatMoneyFor } from "@/lib/services/orders/orders.tenant"
import { assertProductEnabled, assertWithinVisitLimit, isProductEnabled, PLAN_VISIT_LIMIT_REACHED } from "@/lib/services/plans"
import { getTenantWebLinkNote } from "@/lib/whatsapp/utils/tenant-web-link"
import { buildGoogleCalendarUrl } from "@/lib/services/shared/calendar-link"
import { extractBookingRequest, hasBookingDetail, pickSlotByTime } from "@/lib/ai/booking-parser"
import { isAiEnabledForTenant } from "@/lib/ai/settings"

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
  parseServicePicks,
  tooManyServicesMessage,
  combineServices,
} from "@/lib/services/shared/multi-select"

import { CANCEL_OR_RESCHEDULE_BUTTONS } from "@/lib/services/messages/reschedule"
import {
  LIST_ROWS,
  dayHint,
  listReply,
  loadDayAvailability,
  pageRows,
  soonestChoices,
  soonestSections,
  tappedNumber,
  type DayAvailability,
} from "@/lib/services/shared/tap-lists"
import type { ChoiceRow, ChoiceSection } from "@/lib/whatsapp/utils/choice-list"

import { matchStaffRequest, pickStaffForSlot, type StaffCandidate } from "@/lib/services/shared/staff-request"
import {
  staffRequestedLine,
  staffInactiveMessage,
  staffAmbiguousMessage,
  staffNoLongerAvailableMessage,
  staffChoiceOffMessage,
} from "@/lib/services/messages/booking-staff"

import {
  BOOKING_CONFIRM_BUTTONS,
  CANCEL_BUTTON,
  ENTRY_CHOICE_BUTTONS,
  entryChoicePromptMessage,
  entryChoiceInvalidMessage,
  servicesListMessage,
  confirmationMessage,
  invalidSelectionMessage,
  noSlotsOnDayMessage,
  noTimesAvailableMessage,
  pickFromListMessage,
  startOverMessage,
  noServicesMessage,
  servicesLoadErrorMessage,
  availabilityErrorMessage,
  slotStaleMessage,
  bookingPaymentRequestMessage,
  bookingPaymentUnavailableMessage,
  bookingPaymentLinkFailedMessage,
  bookingWindowClosedMessage,
  bookingCancelledMessage,
  missingBookingDataMessage,
  confirmYesNoReminderMessage,
  bookingErrorMessage,
  bookingConfirmedMessage,
  nameCollectionRetryMessage,
  nameCollectionThanksMessage,
  planLimitReachedMessage,
  bookingAlreadyHasUpcomingMessage,
  addToCalendarNote,
} from "@/lib/services/messages/booking"

import { NO_SERVICE_ID, NO_SERVICE_LABEL, noServiceConfirmationMessage } from "@/lib/services/messages/no-service"

import {
  REBOOK_BUTTONS,
  bookingAlreadyInQueueMessage,
  sameAgainOfferMessage,
  sameAgainReminderMessage,
} from "@/lib/services/messages/rebook"

// ============================================================================
// CONSTANTS
// ============================================================================

const BOOKING_STATE_REBOOK_OFFER = "booking_rebook_offer"
const BOOKING_STATE_ENTRY_CHOICE = "booking_entry_choice"
const BOOKING_STATE_SERVICE_SELECTION = "booking_service_selection"
const BOOKING_STATE_SOONEST_SELECTION = "booking_soonest_selection"
const BOOKING_STATE_STAFF_SELECTION = "booking_staff_selection"
const BOOKING_STATE_DATE_SELECTION = "booking_date_selection"
const BOOKING_STATE_TIME_SELECTION = "booking_time_selection"
const BOOKING_STATE_CONFIRM = "booking_confirm"
const BOOKING_STATE_AWAITING_NAME = "booking_awaiting_name"

const SLOT_INTERVAL_MINUTES = 30 // granularity of offered start times
/** Fallback only, used if a tenant has no booking_settings row (or the
 *  column is unreadable). The real value is booking_settings.max_dates_offered
 *  (admin: Settings > Booking > "Dates shown to customers"). Default 7 =
 *  "today" + 6 more days, which is what every tenant got before it was
 *  configurable. */
const DEFAULT_DATES_OFFERED = 7

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

/** Thrown by createBooking() when the database trigger refuses a second
 *  upcoming booking for the same customer. An expected business-rule
 *  refusal, not a bug — callers should show a friendly message and must
 *  not log it as an error. Exported so the kiosk action can match on it
 *  without string-comparing the raw database text. */
export const BOOKING_ALREADY_HAS_UPCOMING = "BOOKING_ALREADY_HAS_UPCOMING"

/** Thrown by createBooking() when the customer is still in the live walk-in queue
 *  (a 'waiting' or 'called' queue_entries row, including one promoted from an
 *  earlier booking). The database trigger block_duplicate_booking refuses the insert
 *  with "You are already in the queue"; without this code the customer just saw the
 *  generic "something went wrong confirming your booking". */
export const BOOKING_ALREADY_IN_QUEUE = "BOOKING_ALREADY_IN_QUEUE"

/** Thrown by createBooking() when it is called with no service while the shop still
 *  requires one (booking_settings.require_service_selection is on). A stale or
 *  tampered request, not a normal flow: the setting is re-read here every time. */
export const BOOKING_SERVICE_REQUIRED = "BOOKING_SERVICE_REQUIRED"

/** Thrown by createBooking() when more services were sent than the tenant's
 *  booking_settings.max_services_per_booking allows. A stale or tampered kiosk
 *  request, not a bug in normal use. */
export const BOOKING_TOO_MANY_SERVICES = "BOOKING_TOO_MANY_SERVICES"

/** Thrown by createBooking() when the customer asked for a specific staff member
 *  and that person is not an active member of this tenant's staff, or is not free
 *  for the whole slot (including losing a double-booking race at insert time).
 *  NEVER answered by quietly picking someone else. */
export const BOOKING_REQUESTED_STAFF_UNAVAILABLE = "BOOKING_REQUESTED_STAFF_UNAVAILABLE"

/** Thrown by createBooking() when a staff member was requested but the tenant has
 *  booking_settings.allow_customer_staff_choice switched off (e.g. the admin turned
 *  it off while the customer was mid-conversation). */
export const BOOKING_STAFF_CHOICE_DISABLED = "BOOKING_STAFF_CHOICE_DISABLED"

/** Thrown by createBooking() when the shop requires payment for bookings but cannot take a card
 *  payment right now (no provider connected, the provider can't charge in the shop's currency, or the
 *  total is below the provider's minimum). Never answered by quietly booking for free. */
export const BOOKING_PAYMENT_UNAVAILABLE = "BOOKING_PAYMENT_UNAVAILABLE"

/** Thrown by createBooking() when the payment link could not be created. The held slot has already
 *  been released, so the customer can simply try again. */
export const BOOKING_PAYMENT_LINK_FAILED = "BOOKING_PAYMENT_LINK_FAILED"

/** How long an unpaid booking holds its slot. Keep in sync with bookings_expire_unpaid (p_hold, 15 minutes)
 *  in supabase/proposed/booking_payments.sql. */
export const BOOKING_PAYMENT_HOLD_MINUTES = 15

/** Hard ceiling, mirrors the DB CHECK on max_services_per_booking. */
const ABSOLUTE_MAX_SERVICES_PER_BOOKING = 5

/** Thrown by completeBooking() when no booking with that id exists for
 *  this tenant — re-checked server-side rather than trusted from
 *  whatever id an admin action was passed, same "never trust the
 *  client" posture as everything else in this file. */
export const BOOKING_NOT_FOUND = "BOOKING_NOT_FOUND"

/** Thrown by completeBooking() when the booking isn't in a state that
 *  can transition to 'completed' -- already completed, or cancelled.
 *  Only a 'confirmed' booking can be completed. */
export const BOOKING_NOT_COMPLETABLE = "BOOKING_NOT_COMPLETABLE"

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
  /** Primary service (the first one picked). */
  selectedService?: BookingServiceOffer
  /** 2nd, 3rd... services when the shop allows several. Absent = one service. */
  extraServices?: BookingServiceOffer[]
  /** booking_settings.max_services_per_booking when the list was shown. */
  maxServices?: number
  /** `hint` ("5 times · from 09:00") is shown under the day in the day list. */
  dateOptions?: Array<{ date: string; label: string; hint?: string }>
  /** The "earliest free times" list that was shown, so a tap on a row maps back to a date + slot. */
  pendingChoices?: Array<{ date: string; dateLabel: string; slot: BookingSlot }>
  /** The team members offered by "Choose team member" (only when the shop lets customers choose). */
  staffOptions?: Array<{ id: string; name: string }>
  selectedDate?: string
  pendingSlots?: BookingSlot[]
  selectedSlot?: BookingSlot
  /** The staff member the customer asked for ("book with Sipho"). Only ever set when
   *  booking_settings.allow_customer_staff_choice is on; createBooking() re-checks it. */
  requestedStaff?: { id: string; name: string }
  /** True when the shop has "require a service to book" OFF: the customer was never shown a
   *  services list, `selectedService` is only a placeholder carrying the default appointment
   *  length, and createBooking() is called with no service. */
  noService?: boolean
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
 * Reads booking_settings.allow_customer_staff_choice for this tenant. Its own small
 * query (same approach as getDatesOffered below) so it doesn't touch getBookingSettings.
 * FAILS CLOSED: a missing row, a database error, or a column that hasn't been added yet
 * all mean "off", so customer staff requests are ignored and automatic assignment runs
 * exactly as before.
 */
async function readAllowCustomerStaffChoice(supabase: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select("allow_customer_staff_choice")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) {
    console.error("[booking] Failed to load allow_customer_staff_choice, treating as off", {
      tenantId,
      error: error.message,
    })
    return false
  }
  return data?.allow_customer_staff_choice === true
}

/** This tenant's staff, active or not, for matching a typed name. Tenant-scoped. */
async function getStaffForNameMatching(supabase: SupabaseClient, tenantId: string): Promise<StaffCandidate[]> {
  const { data, error } = await supabase.from("staff").select("id, name, active").eq("tenant_id", tenantId)
  if (error) throw new Error(`Failed to load staff: ${error.message}`)
  return (data ?? []).map((row: { id: string; name: string; active: boolean | null }) => ({
    id: row.id,
    name: row.name,
    active: row.active === true,
  }))
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
  /** Rescheduling: the booking being moved must not block its own new time. */
  excludeBookingId?: string,
): Promise<Array<{ staffId: string; start: Date; end: Date }>> {
  // Release unpaid holds that ran out, so their slots show as free again. The cron jobs only run once a
  // day, so this is what keeps a held slot from staying blocked. Best effort: never stops a read.
  await supabase.rpc("bookings_expire_unpaid", { p_tenant_id: tenantId }).then(
    ({ error }) => {
      if (error) console.error("[booking] bookings_expire_unpaid failed", { tenantId, error: error.message })
    },
    () => {},
  )

  let query = supabase
    .from("bookings")
    .select("staff_id, start_time, end_time")
    .eq("tenant_id", tenantId)
    // An unpaid hold blocks its slot just like a confirmed booking.
    .in("status", ["confirmed", "awaiting_payment"])
    .gte("start_time", windowStart.toISOString())
    .lte("start_time", windowEnd.toISOString())
  if (excludeBookingId) query = query.neq("id", excludeBookingId)

  const { data, error } = await query

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

/**
 * True when a bookings INSERT/UPDATE failed because that staff member already
 * has a confirmed booking at an overlapping time — i.e. we lost a race that the
 * read-then-write check in claimStaffForSlot() cannot rule out on its own.
 * The database is the final arbiter:
 *   - bookings_no_staff_overlap (exclusion constraint, SQLSTATE 23P01):
 *     any overlapping confirmed range for the same staff_id
 *   - bookings_staff_start_time_unique_confirmed (unique index, 23505):
 *     identical start time for the same staff_id
 * The 23505 case is matched by constraint name on purpose: a 23505 on
 * booking_reference (or anything else) is NOT a slot conflict.
 */
function isStaffConflictError(error: { code?: string; message?: string; details?: string } | null | undefined): boolean {
  if (!error) return false
  const text = `${error.message ?? ""} ${error.details ?? ""}`
  // bookings has exactly one exclusion constraint, so any 23P01 here is this one.
  if (error.code === "23P01") return true
  if (error.code === "23505") return text.includes("bookings_staff_start_time_unique_confirmed")
  return false
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
export async function getAvailableSlots(
  tenantId: string,
  dateISO: string,
  durationMinutes: number,
  /** Rescheduling only: ignore this booking when checking who is free. */
  excludeBookingId?: string,
  /** Customer asked for this staff member: only their free times are offered. */
  requestedStaffId?: string,
): Promise<BookingSlot[]> {
  const supabase = getClientOrThrow()
  await assertProductEnabled(supabase, tenantId, "booking")

  const [activeStaff, bookingSettings, dayWindow] = await Promise.all([
    getActiveStaff(supabase, tenantId),
    getBookingSettings(supabase, tenantId),
    resolveDayWindow(supabase, tenantId, dateISO),
  ])

  // A requested staff member that is not in this tenant's ACTIVE list leaves nobody: no slots.
  const staff = requestedStaffId ? activeStaff.filter((member) => member.id === requestedStaffId) : activeStaff
  if (staff.length === 0) return []
  // Closed that day / no hours configured for that weekday at all.
  if (!dayWindow.dayOpenUTC || !dayWindow.dayCloseUTC) return []

  const today = todayInTimezone(dayWindow.timezone)
  if (!isWithinAdvanceWindow(dateISO, today, bookingSettings.maxAdvanceDays)) return []

  const existingBookings = await getBookingsInWindow(
    supabase,
    tenantId,
    dayWindow.dayOpenUTC,
    dayWindow.dayCloseUTC,
    excludeBookingId,
  )

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
  /** Rescheduling: ignore the booking being moved, and keep the customer with
   *  the same staff member when that person is free at the new time. */
  options: { excludeBookingId?: string; preferStaffId?: string; excludeStaffIds?: string[]; requireStaffId?: string } = {},
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

  const existingBookings = await getBookingsInWindow(supabase, tenantId, windowStart, windowEnd, options.excludeBookingId)

  const isFree = (member: ActiveStaff) => {
    // A staff member the database just rejected for this slot (lost a race) is
    // never offered again within the same booking attempt.
    if (options.excludeStaffIds?.includes(member.id)) return false
    const memberBookings = existingBookings.filter((b) => b.staffId === member.id)
    return !memberBookings.some((b) => overlaps(slotStart, slotEnd, b.start, b.end))
  }
  // requireStaffId (the customer's own choice) has NO fallback; preferStaffId
  // (reschedule: keep the same person if free) still falls back to anyone free.
  // isFree() above also honours excludeStaffIds, so a requested person who has just
  // lost a double-booking race counts as unavailable here too.
  const pick = pickStaffForSlot({
    staff,
    isFree,
    preferStaffId: options.preferStaffId,
    requireStaffId: options.requireStaffId,
  })
  if (!pick.ok) {
    throw new Error(
      pick.reason === "requested_unavailable" ? BOOKING_REQUESTED_STAFF_UNAVAILABLE : BOOKING_SLOT_NO_LONGER_AVAILABLE,
    )
  }
  return pick.staff
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

/**
 * Reads booking_settings.max_services_per_booking. Never throws: a missing
 * row, an error or an out-of-range value all mean 1 (single service), the
 * safe default, so a settings hiccup can never let extra services through.
 */
async function readMaxServicesPerBooking(supabase: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select("max_services_per_booking")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) {
    console.error("[booking] Failed to load max_services_per_booking, using 1", { tenantId, error: error.message })
    return 1
  }
  const value = Number(data?.max_services_per_booking)
  return Number.isInteger(value) && value >= 1 && value <= ABSOLUTE_MAX_SERVICES_PER_BOOKING ? value : 1
}

/** Exported for the kiosk's Server Actions, which re-check the limit before
 *  looking anything up. */
export async function getMaxServicesPerBooking(tenantId: string): Promise<number> {
  return readMaxServicesPerBooking(getClientOrThrow(), tenantId)
}

export interface BookingServiceMode {
  /** booking_settings.require_service_selection: false = customers book without choosing one. */
  requireService: boolean
  /** booking_settings.default_duration_minutes: the appointment length when no service is chosen. */
  defaultDurationMinutes: number
}

const FALLBACK_NO_SERVICE_DURATION_MINUTES = 30

async function readBookingServiceMode(supabase: SupabaseClient, tenantId: string): Promise<BookingServiceMode> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select("require_service_selection, default_duration_minutes")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) {
    console.error("[booking] Failed to load require_service_selection, asking for a service", { tenantId, error: error.message })
    return { requireService: true, defaultDurationMinutes: FALLBACK_NO_SERVICE_DURATION_MINUTES }
  }
  const minutes = Number(data?.default_duration_minutes)
  return {
    // Only an explicit false turns the service step off; anything else keeps it.
    requireService: data?.require_service_selection !== false,
    defaultDurationMinutes:
      Number.isInteger(minutes) && minutes >= 5 && minutes <= 480 ? minutes : FALLBACK_NO_SERVICE_DURATION_MINUTES,
  }
}

/** Never throws: any failure means "ask for a service" (the long-standing behaviour).
 *  Exported for the kiosk's Server Actions. */
export async function getBookingServiceMode(tenantId: string): Promise<BookingServiceMode> {
  try {
    return await readBookingServiceMode(getClientOrThrow(), tenantId)
  } catch (error) {
    console.error("[booking] Could not read the booking service setting, asking for a service", { tenantId, error })
    return { requireService: true, defaultDurationMinutes: FALLBACK_NO_SERVICE_DURATION_MINUTES }
  }
}

/** Keeps the first occurrence of each service id, preserving order. The link
 *  table has one row per (booking, service), so a repeat would fail anyway. */
function dedupeServices(list: CatalogService[]): CatalogService[] {
  const seen = new Set<string>()
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
}

export interface CreateBookingParams {
  /** The full catalog entry, not just an id — both callers already have
   *  it in hand (WhatsApp from conversation state, kiosk from its own
   *  services fetch), and durationMinutes is needed for the claim check
   *  regardless. This is the PRIMARY service: it is what bookings.service_id
   *  stores. Null ONLY when the shop has booking_settings.require_service_selection
   *  off (re-checked in createBooking, which throws BOOKING_SERVICE_REQUIRED otherwise):
   *  the booking then lasts default_duration_minutes, bookings.service_id is stored
   *  null and no booking_services rows are written. */
  service: CatalogService | null
  /** Further services in the same visit (multi-service). Omit for the usual
   *  single-service booking. Total count, primary included, must not exceed
   *  booking_settings.max_services_per_booking. */
  extraServices?: CatalogService[]
  dateISO: string
  slot: BookingSlot
  /** Raw or normalized — ensureCustomer() normalizes internally, so
   *  either is safe to pass here. */
  phone: string
  /** The staff member the customer asked for. Omit for automatic assignment. Only honoured
   *  while the tenant's allow_customer_staff_choice is on (re-read here, never trusted from
   *  the caller); the slot is then booked with this person or not at all. */
  requestedStaffId?: string
  /** "auto" = if the shop requires payment (booking_settings.require_payment) and the total is above 0, hold
   *  the slot and return a card payment link instead of confirming. Used by the WhatsApp and kiosk channels.
   *  "skip" (default) = always confirm, e.g. a booking staff create in the admin. */
  payment?: "auto" | "skip"
  /** Where the booking came from. Stored with a payment so the webhook knows how to reach the customer afterwards. */
  channel?: "whatsapp" | "kiosk"
}

/** What the customer pays, when the booking is waiting for payment. */
export interface BookingPaymentInfo {
  url: string
  paymentId: string
  amount: number
  currency: string
  /** How long the slot is held for. */
  holdMinutes: number
}

export interface CreateBookingResult {
  /** bookings.id — used for the ticket image's file name. */
  bookingId: string
  customer: Customer
  /** Every service on the booking, primary first. */
  services: CatalogService[]
  /** Sum of the services' durations; endTime - startTime. */
  totalDurationMinutes: number
  /** Random 5-character code the customer quotes, e.g. "H456R". */
  bookingReference: string
  /** Running per-shop number assigned by the database, e.g. 12. Null only if the trigger didn't run. */
  ticketNumber: number | null
  /** ticketNumber with the shop's booking prefix, e.g. "B0012". */
  ticketLabel: string | null
  startTime: string
  endTime: string
  /** Who the booking was assigned to. */
  staffName?: string
  /** "awaiting_payment" = the slot is held and `payment` has the link; the webhook confirms it once paid. */
  status: "confirmed" | "awaiting_payment"
  /** Sum of the services' prices. */
  totalPrice: number
  /** Set only while status is "awaiting_payment". */
  payment: BookingPaymentInfo | null
}

/**
 * Validates the slot against booking_settings/business_hours, claims a
 * staff member for it, and inserts the `bookings` row. Throws an Error
 * with message BOOKING_OUTSIDE_ALLOWED_WINDOW if the slot no longer
 * satisfies booking policy, or BOOKING_SLOT_NO_LONGER_AVAILABLE if the
 * slot was taken between when it was offered and now — callers should
 * catch both and show a "pick another time" style message rather than a
 * generic error, since both are expected races/edge cases, not bugs.
 * Also throws BOOKING_ALREADY_HAS_UPCOMING when the customer already has an
 * upcoming booking (enforced by a database trigger), and
 * BOOKING_TOO_MANY_SERVICES when more services were sent than the tenant's
 * max_services_per_booking allows.
 */
export async function createBooking(tenantId: string, params: CreateBookingParams): Promise<CreateBookingResult> {
  const { service, extraServices = [], dateISO, slot, phone } = params
  const supabase = getClientOrThrow()
  // Booking is a per-shop switch (tenant_modules); a shop without it takes no bookings from any channel.
  await assertProductEnabled(supabase, tenantId, "booking")

  // Primary first, repeats dropped. Everything below uses this list, so the
  // length check, the summed duration and the link rows can't disagree.
  const services = service ? dedupeServices([service, ...extraServices]) : []
  let totalDurationMinutes = services.reduce((sum, s) => sum + s.durationMinutes, 0)
  if (!service) {
    // No service is only legal while the shop has the step switched off.
    const mode = await readBookingServiceMode(supabase, tenantId)
    if (mode.requireService) throw new Error(BOOKING_SERVICE_REQUIRED)
    totalDurationMinutes = mode.defaultDurationMinutes
  }

  // Limit check first: it writes nothing and is a stricter rule than any
  // below. Read from the database every time, never from the client.
  if (services.length > (await readMaxServicesPerBooking(supabase, tenantId))) {
    throw new Error(BOOKING_TOO_MANY_SERVICES)
  }

  // Plan enforcement runs first and cheapest — no point checking business
  // hours or claiming a staff member for a booking that's about to be
  // rejected because the tenant is over their monthly visit cap anyway.
  await assertWithinVisitLimit(supabase, tenantId)

  await assertBookingIsAllowed(supabase, tenantId, dateISO, slot, totalDurationMinutes)

  // A customer-requested staff member is only honoured while the shop allows it; otherwise
  // refuse rather than quietly assigning someone the customer didn't choose.
  if (params.requestedStaffId && !(await readAllowCustomerStaffChoice(supabase, tenantId))) {
    throw new Error(BOOKING_STAFF_CHOICE_DISABLED)
  }

  // Does this booking have to be paid for first? Only for the channels that ask for it, only when the
  // shop switched it on, and only when there is something to pay (the payment table refuses 0).
  const totalPrice = Math.round(services.reduce((sum, s) => sum + Number(s.price), 0) * 100) / 100
  let cardOption: Awaited<ReturnType<typeof getCardOption>> = null
  let payable = false
  if (params.payment === "auto" && (await readRequirePayment(supabase, tenantId)) && totalPrice > 0) {
    cardOption = await getCardOption(supabase, tenantId)
    // The shop wants payment but can't take it right now: say so rather than booking for free.
    if (!cardOption || !(totalPrice >= cardOption.minAmount)) throw new Error(BOOKING_PAYMENT_UNAVAILABLE)
    payable = true
  }

  // A customer starting over (kiosk "back", a second WhatsApp attempt) must not be blocked by their own
  // earlier unpaid hold, so release it BEFORE looking for a free staff member.
  let customer: Customer | null = null
  if (payable) {
    customer = await ensureCustomer(tenantId, phone)
    const { error: releaseError } = await supabase.rpc("bookings_release_unpaid_for_customer", {
      p_tenant_id: tenantId,
      p_customer_id: customer.id,
    })
    if (releaseError) throw new Error(`Failed to release the earlier unpaid booking: ${releaseError.message}`)
  }

  let staff = await claimStaffForSlot(supabase, tenantId, dateISO, slot, totalDurationMinutes, {
    requireStaffId: params.requestedStaffId,
  })

  // Minimal (phone-only) tenant_customers row if this is a brand-new
  // customer — no name/email required to book, on either channel.
  const bookedCustomer = customer ?? (await ensureCustomer(tenantId, phone))

  const startTime = new Date(slot.start)
  const endTime = new Date(startTime.getTime() + totalDurationMinutes * 60_000)
  let bookingReference = generateBookingReference()
  let referenceRetries = 0

  // claimStaffForSlot() is a read, this insert is the write, and two customers
  // can slip between them. The database (bookings_no_staff_overlap exclusion
  // constraint + bookings_staff_start_time_unique_confirmed) is what actually
  // refuses a double-booking; when it does, take the next free staff member
  // instead of failing a customer who could still be served. Each conflict adds
  // one staff id to `conflicted`, so this ends in at most (active staff) tries,
  // and when nobody is left claimStaffForSlot() throws
  // BOOKING_SLOT_NO_LONGER_AVAILABLE like it always has.
  const conflicted: string[] = []
  let inserted: { id: string; ticket_number: number | null }
  for (;;) {
    const { data, error } = await supabase
      .from("bookings")
      .insert([
        {
          tenant_id: tenantId,
          customer_id: bookedCustomer.id,
          service_id: service?.id ?? null,
          staff_id: staff.id,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          status: payable ? "awaiting_payment" : "confirmed",
          booking_reference: bookingReference,
        },
      ])
      .select("id, ticket_number")
      .single()

    if (!error) {
      inserted = data as { id: string; ticket_number: number | null }
      break
    }

    // Two bookings drew the same 5-character reference: draw another and retry. Checked
    // before the staff-conflict test below, which must not mistake this for a busy slot.
    if (error.code === "23505" && error.message.includes("bookings_booking_reference_key") && referenceRetries < 8) {
      referenceRetries += 1
      bookingReference = generateBookingReference()
      continue
    }

    // The bookings trigger raises this text when the customer already has an
    // upcoming booking. Translate it into a stable code so every caller can
    // handle it without matching on database wording.
    if (error.message.includes("already have an upcoming booking")) {
      throw new Error(BOOKING_ALREADY_HAS_UPCOMING)
    }
    if (error.message.includes("already in the queue")) {
      throw new Error(BOOKING_ALREADY_IN_QUEUE)
    }

    if (isStaffConflictError(error)) {
      conflicted.push(staff.id)
      // requireStaffId stays set: if the customer's chosen person lost the race this throws
      // BOOKING_REQUESTED_STAFF_UNAVAILABLE instead of moving them to someone else.
      staff = await claimStaffForSlot(supabase, tenantId, dateISO, slot, totalDurationMinutes, {
        excludeStaffIds: conflicted,
        requireStaffId: params.requestedStaffId,
      })
      continue
    }

    throw new Error(error.message)
  }

  // Full service list, in the order the customer picked them. If this fails
  // the booking is removed again so the customer is never left holding a slot
  // whose length (end_time) covers services the record doesn't list.
  // A no-service booking has nothing to link.
  const { error: linkError } = services.length === 0 ? { error: null } : await supabase.from("booking_services").insert(
    services.map((s, index) => ({
      booking_id: inserted.id,
      service_id: s.id,
      tenant_id: tenantId,
      position: index + 1,
    })),
  )

  if (linkError) {
    await supabase.from("bookings").delete().eq("id", inserted.id).eq("tenant_id", tenantId)
    throw new Error(`Failed to save the booking's services: ${linkError.message}`)
  }

  // Paid bookings: the slot is held, the customer gets a card link, and the signed webhook confirms the
  // booking once the money has arrived (lib/payments/settle.ts). If no link can be made the hold is
  // removed again, so nobody is left waiting for a payment they cannot make.
  let payment: BookingPaymentInfo | null = null
  if (payable && cardOption) {
    const started = await startCardPayment({
      supabase,
      tenantId,
      option: cardOption,
      purpose: "booking_payment",
      purposeId: inserted.id,
      amount: totalPrice,
      description: `Booking: ${services.map((s) => s.name).join(" + ") || "Appointment"}`,
      recordMetadata: { booking_id: inserted.id, customer_id: bookedCustomer.id, channel: params.channel ?? "whatsapp" },
      providerMetadata: { booking_id: inserted.id },
      idempotencyPrefix: "booking",
    })
    if (!started.ok) {
      await supabase.from("bookings").delete().eq("id", inserted.id).eq("tenant_id", tenantId).eq("status", "awaiting_payment")
      throw new Error(BOOKING_PAYMENT_LINK_FAILED)
    }
    payment = {
      url: started.url,
      paymentId: started.paymentId,
      amount: totalPrice,
      currency: cardOption.currency,
      holdMinutes: BOOKING_PAYMENT_HOLD_MINUTES,
    }
  }

  return {
    bookingId: inserted.id as string,
    customer: bookedCustomer,
    status: payable ? "awaiting_payment" : "confirmed",
    totalPrice,
    payment,
    services,
    totalDurationMinutes,
    bookingReference,
    ticketNumber: inserted.ticket_number ?? null,
    ticketLabel:
      inserted.ticket_number == null
        ? null
        : formatBookingTicketNumber(inserted.ticket_number, await readBookingNumberPrefix(supabase, tenantId)),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    staffName: staff.name,
  }
}

/** booking_settings.require_payment (default false). Never throws on a missing row: no row = payment off. */
async function readRequirePayment(supabase: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select("require_payment")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  // 42703 = the column doesn't exist yet (the paid-bookings migration hasn't been applied): payment is off.
  if (error && (error as { code?: string }).code === "42703") return false
  if (error) {
    // Fail closed: if we can't tell whether the shop wants payment, don't hand out a free booking.
    console.error("[booking] require_payment lookup failed", { tenantId, error: error.message })
    throw new Error(`Failed to read booking payment setting: ${error.message}`)
  }
  return data?.require_payment === true
}

/** booking_settings.booking_number_prefix (default "B"). Never throws: a failed read just means "B". */
async function readBookingNumberPrefix(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select("booking_number_prefix")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) console.error("[booking] booking_number_prefix lookup failed", { tenantId, error: error.message })
  return (data?.booking_number_prefix as string | undefined)?.trim() || DEFAULT_BOOKING_NUMBER_PREFIX
}

// ============================================================================
// COMPLETING A BOOKING — the customer showed up and was served. See this
// file's header comment for why this exists and what it feeds into.
// ============================================================================

export interface CompleteBookingResult {
  id: string
  status: "completed"
}

/**
 * Marks a booking 'completed' -- the only transition a billable visit
 * can come from on the booking side (a booking that got promoted into
 * the queue is billed via its queue_entries completion instead; see the
 * billing migration's trg_record_booking_billable_visit, which checks
 * for exactly that and skips inserting a second ledger row when it finds
 * one). Re-validates tenant ownership and current status server-side --
 * never trusts that whatever called this already confirmed either.
 *
 * Idempotent in effect, not just in the ledger: calling this again on an
 * already-'completed' booking throws BOOKING_NOT_COMPLETABLE rather than
 * silently no-op'ing, so a caller can tell "already done" apart from
 * "this succeeded" -- but even if that check were somehow bypassed, the
 * ledger's unique(source, source_id) means a duplicate UPDATE could never
 * produce a second billable visit regardless.
 */
export async function completeBooking(tenantId: string, bookingId: string): Promise<CompleteBookingResult> {
  const supabase = getClientOrThrow()

  const { data: existing, error: fetchError } = await supabase
    .from("bookings")
    .select("id, status")
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (fetchError) throw new Error(`Failed to load booking: ${fetchError.message}`)
  if (!existing) throw new Error(BOOKING_NOT_FOUND)
  if (existing.status !== "confirmed") throw new Error(BOOKING_NOT_COMPLETABLE)

  const { error: updateError } = await supabase
    .from("bookings")
    .update({ status: "completed" })
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)

  if (updateError) throw new Error(updateError.message)

  return { id: bookingId, status: "completed" }
}

// ============================================================================
// RESCHEDULING — move a confirmed booking to a new time in ONE step.
// ============================================================================

export type RescheduleOutcome = "rescheduled" | "unchanged" | "too_late" | "already_gone" | "in_queue"

export interface RescheduleBookingResult {
  outcome: RescheduleOutcome
  /** booking_settings.cancellation_window_minutes — reported so the caller can
   *  explain a "too_late". Moving a booking follows the same cut-off as
   *  cancelling it: both give the slot back. */
  windowMinutes: number
  bookingReference?: string
  /** "Fade + Beard" for a multi-service booking. */
  serviceName?: string
  startTime?: string
  endTime?: string
}

/**
 * Moves one confirmed booking to a new slot. Only the time (and, if the same
 * person isn't free, the staff member) changes: the services, the reference and
 * the booking's length stay as they are, so a multi-service booking keeps its
 * full duration. It is a single UPDATE, so the customer is never without a
 * booking half-way through: if the new time can't be had, the old one stands.
 *
 * Everything is re-checked here, never trusted from the conversation:
 *   - the booking is this customer's, this tenant's and still 'confirmed'
 *   - it is not closer than the cancellation window (too_late)
 *   - it is not already in the live queue or being served (in_queue) — a human
 *     needs to handle that one
 *   - the new slot passes business hours / max_advance / min_notice
 *   - somebody is free for the booking's full length (its own old slot doesn't
 *     count against it)
 * and the UPDATE only applies if the booking still starts at the time we read,
 * so two taps or a staff edit in between can't be overwritten silently.
 *
 * Throws BOOKING_SLOT_NO_LONGER_AVAILABLE / BOOKING_OUTSIDE_ALLOWED_WINDOW, the
 * same codes createBooking() uses; every other outcome is returned.
 */
export async function rescheduleBooking(
  tenantId: string,
  customerId: string,
  bookingId: string,
  dateISO: string,
  slot: BookingSlot,
): Promise<RescheduleBookingResult> {
  const supabase = getClientOrThrow()
  await assertProductEnabled(supabase, tenantId, "booking")

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(
      `id, start_time, end_time, staff_id, booking_reference,
       services!bookings_service_id_fkey ( name ),
       booking_services ( position, services ( name ) )`,
    )
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "confirmed")
    .maybeSingle()

  if (error) throw new Error(`Failed to load booking: ${error.message}`)

  const settings = await getBookingSettings(supabase, tenantId)
  const windowMinutes = settings.cancellationWindowMinutes
  if (!booking) return { outcome: "already_gone", windowMinutes }

  const oldStartMillis = new Date(booking.start_time).getTime()
  const nowMillis = Date.now()
  if (oldStartMillis <= nowMillis || oldStartMillis - nowMillis < Math.max(0, windowMinutes) * 60_000) {
    return { outcome: "too_late", windowMinutes }
  }

  const { data: liveEntry, error: queueError } = await supabase
    .from("queue_entries")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("booking_id", bookingId)
    .in("status", ["waiting", "called"])
    .limit(1)
  if (queueError) throw new Error(`Failed to check queue entry: ${queueError.message}`)
  if ((liveEntry ?? []).length > 0) return { outcome: "in_queue", windowMinutes }

  // Names for the confirmation: primary first, then the link table in order.
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))
  const names: string[] = []
  const primaryName = one<{ name: string | null }>(booking.services as never)?.name
  if (primaryName) names.push(primaryName)
  const links = [...((booking.booking_services ?? []) as unknown as Array<{ position: number | null; services: unknown }>)].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  )
  for (const link of links) {
    const n = one<{ name: string | null }>(link.services as never)?.name
    if (n && !names.includes(n)) names.push(n)
  }
  const serviceName = names.join(" + ") || "Appointment"

  const durationMinutes = Math.max(
    1,
    Math.round((new Date(booking.end_time).getTime() - oldStartMillis) / 60_000),
  )

  if (new Date(slot.start).getTime() === oldStartMillis) {
    return {
      outcome: "unchanged",
      windowMinutes,
      bookingReference: booking.booking_reference,
      serviceName,
      startTime: booking.start_time,
      endTime: booking.end_time,
    }
  }

  await assertBookingIsAllowed(supabase, tenantId, dateISO, slot, durationMinutes)

  const staff = await claimStaffForSlot(supabase, tenantId, dateISO, slot, durationMinutes, {
    excludeBookingId: booking.id,
    preferStaffId: booking.staff_id,
  })

  const newStart = new Date(slot.start)
  const newEnd = new Date(newStart.getTime() + durationMinutes * 60_000)

  const { data: updated, error: updateError } = await supabase
    .from("bookings")
    .update({
      start_time: newStart.toISOString(),
      end_time: newEnd.toISOString(),
      staff_id: staff.id,
      // The reminder and the customer's "I'm coming" tap belonged to the OLD
      // time: clear both so the reminder goes out again for the new one.
      reminder_sent_at: null,
      customer_confirmed_at: null,
    })
    .eq("id", booking.id)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "confirmed")
    .eq("start_time", booking.start_time)
    .select("id")

  // Someone else took this staff member's time between the check above and
  // this UPDATE: the database refused it. Same outcome as a slot that was
  // already full at claim time, and the old booking is untouched.
  if (isStaffConflictError(updateError)) throw new Error(BOOKING_SLOT_NO_LONGER_AVAILABLE)
  if (updateError) throw new Error(`Failed to reschedule booking: ${updateError.message}`)
  if (!updated || updated.length === 0) return { outcome: "already_gone", windowMinutes }

  return {
    outcome: "rescheduled",
    windowMinutes,
    bookingReference: booking.booking_reference,
    serviceName,
    startTime: newStart.toISOString(),
    endTime: newEnd.toISOString(),
  }
}

// ============================================================================
// ENTRY POINT — fresh "booking" intent
// ============================================================================

// Typed-message hints. Word-boundary matches on the lowercased text, so
// "booking"/"book"/"appointment" and "queue"/"walk-in"/"walk in" are
// recognised but "bookmark" or "queueing up the next song" are not.
const QUEUE_REQUEST_PATTERN = /\b(queue|walk[\s-]?in|walkin)\b/
const BOOK_REQUEST_PATTERN = /\b(book|booking|appointment|reserve|reservation)\b/
/** Phrases handled by the "Same again?" offer; never worth an AI parse. */
const NO_PARSE_PATTERN = /\b(same again|same as last time|the usual|my usual|usual|rebook|re-book)\b/

/** "👤 With Sipho" + blank line, or "" when no staff member was requested. */
function staffPrefix(requestedStaff: { name: string } | undefined): string {
  return requestedStaff ? `${staffRequestedLine(requestedStaff.name)}\n\n` : ""
}

type StaffRequestOutcome =
  | { kind: "none" }
  | { kind: "use"; staff: { id: string; name: string } }
  | { kind: "reply"; result: ActionResult }

/**
 * Looks for a staff member's name in a typed booking message ("book with Sipho").
 *
 *  - Setting OFF (or unreadable): returns "none" and the message is treated exactly as
 *    before; the customer's staff preference is ignored.
 *  - Setting ON: names are matched only against THIS tenant's staff. A match on an
 *    inactive person, or on a name shared by several people, is answered with an explicit
 *    message. Nothing here ever picks a different person on the customer's behalf.
 * Only typed text is inspected: list/button taps never name a person.
 */
async function resolveStaffRequest(tenantId: string, message: IncomingMessage): Promise<StaffRequestOutcome> {
  if (message.interactiveId || message.type !== "text") return { kind: "none" }
  const text = rawReplyText(message)
  if (!text) return { kind: "none" }

  const supabase = getSupabaseServerClient()
  if (!supabase || !(await readAllowCustomerStaffChoice(supabase, tenantId))) return { kind: "none" }

  let match
  try {
    match = matchStaffRequest(text, await getStaffForNameMatching(supabase, tenantId))
  } catch (error) {
    // Staff choice is ON but we can't tell who was asked for: say so rather than assign anyone.
    console.error("[booking] Could not check the requested staff member", { tenantId, error })
    return { kind: "reply", result: { reply: availabilityErrorMessage(), buttons: [], nextState: null } }
  }

  switch (match.kind) {
    case "match":
      return { kind: "use", staff: { id: match.staff.id, name: match.staff.name } }
    case "inactive":
      return { kind: "reply", result: { reply: staffInactiveMessage(match.staff.name), buttons: [], nextState: null } }
    case "ambiguous":
      return { kind: "reply", result: { reply: staffAmbiguousMessage(match.names), buttons: [], nextState: null } }
    default:
      return { kind: "none" }
  }
}

/**
 * AI shortcut for a typed booking request that already contains detail.
 * Returns null whenever it can't (or shouldn't) help, so the caller falls
 * through to the normal flow. Never throws.
 */
async function trySmartBooking(
  tenantId: string,
  message: IncomingMessage,
  requestedStaff?: { id: string; name: string },
): Promise<ActionResult | null> {
  try {
    const text = rawReplyText(message)
    if (message.interactiveId || !hasBookingDetail(text)) return null

    // Cost guards: no detail to extract in these, so skip the AI parse.
    const lower = text.toLowerCase()
    // "same again" / "the usual" are handled by the one-tap offer, not the parser.
    if (NO_PARSE_PATTERN.test(lower)) return null
    // Bare queue phrases ("join the queue", "walk in please") carry no detail.
    if (
      QUEUE_REQUEST_PATTERN.test(lower) &&
      !BOOK_REQUEST_PATTERN.test(lower) &&
      !requestedStaff &&
      text.split(/\s+/).filter(Boolean).length <= 4
    ) {
      return null
    }
    // No-service shop: the parse result would be thrown away (see below), so check before paying for it.
    if (!(await getBookingServiceMode(tenantId)).requireService) return null
    if (!(await isAiEnabledForTenant(tenantId))) return null

    const [services, dateOptions] = await Promise.all([getBookableServices(tenantId), buildDateOptions(tenantId)])
    if (services.length === 0 || dateOptions.length === 0) return null

    const parsed = await extractBookingRequest(
      text,
      services.map((s) => ({ name: s.name, durationMinutes: s.durationMinutes })),
      dateOptions,
    )
    if (!parsed) return null

    // "can I come now" in any language -> straight to the walk-in queue.
    // A queue ticket can't be for one staff member: don't drop the request, let the normal
    // flow below ask "Queue or Book?" with it still attached.
    if (parsed.wantsQueue) {
      // Queue switched off: ignore the queue wish and let the normal booking flow carry on.
      if (!(await isProductEnabled(getClientOrThrow(), tenantId, "queue"))) return null
      return requestedStaff ? null : queueService.startQueueFlow(tenantId, message.from)
    }

    // Without a recognised service there is nothing to pre-fill.
    if (parsed.serviceIndex === null) return null
    const service = services[parsed.serviceIndex]

    const data: BookingStateData = {
      services,
      selectedService: service,
      dateOptions,
      ...(requestedStaff ? { requestedStaff } : {}),
    }

    // Service only (a time without a date can't be trusted) -> date screen.
    const chosen = parsed.date ? dateOptions.find((d) => d.date === parsed.date) : undefined
    if (!chosen) return presentSoonest(tenantId, data)

    const slots = await getAvailableSlots(tenantId, chosen.date, service.durationMinutes, undefined, requestedStaff?.id)
    if (slots.length === 0) {
      return presentSoonest(tenantId, data, noSlotsOnDayMessage(chosen.label, requestedStaff?.name))
    }

    const withDate: BookingStateData = { ...data, selectedDate: chosen.date, pendingSlots: slots }

    const slot = pickSlotByTime(slots, parsed.time)
    if (slot) {
      return {
        reply: staffPrefix(requestedStaff) + confirmationMessage(service, chosen.label, slot),
        buttons: BOOKING_CONFIRM_BUTTONS,
        nextState: { state: BOOKING_STATE_CONFIRM, data: mergeBookingData(withDate, { selectedSlot: slot }) },
      }
    }

    const notFree = parsed.time ? `Sorry, ${parsed.time} isn't available on ${chosen.label}. Here's what is free:` : ""
    return timeListReply(withDate, service.name, chosen.label, slots, 0, notFree)
  } catch (error) {
    console.error("[booking] smart booking failed, using normal flow", { tenantId, error })
    return null
  }
}

async function handleBooking(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  const text = normalizedReplyText(message)
  const wantsQueue = QUEUE_REQUEST_PATTERN.test(text)
  const wantsBooking = BOOK_REQUEST_PATTERN.test(text)

  // "Book with Sipho": only when the shop allows it, and never for a queue-only message.
  let requestedStaff: { id: string; name: string } | undefined
  if (!(wantsQueue && !wantsBooking)) {
    const staffRequest = await resolveStaffRequest(tenantId, message)
    if (staffRequest.kind === "reply") return staffRequest.result
    if (staffRequest.kind === "use") requestedStaff = staffRequest.staff
  }

  // AI shortcut first: a message like "haircut tomorrow 3pm" skips ahead.
  const smart = await trySmartBooking(tenantId, message, requestedStaff)
  if (smart) return smart

  // Returning customer: offer "Same again?" before the Queue-or-Book question or the
  // services list. Skipped when they asked for a specific person (they have a plan) or
  // clearly want the queue. Returns null when there is nothing sensible to offer.
  if (!requestedStaff && !(wantsQueue && !wantsBooking)) {
    const sameAgain = await offerSameAgain(tenantId, message.from)
    if (sameAgain) return sameAgain
  }

  // Only ONE of the two clearly mentioned -> the customer already told us
  // what they want, so skip the "Queue or Book?" question. Both mentioned,
  // or neither (e.g. "I need a haircut"), is genuinely ambiguous -> ask.
  // Queue switched off: there is no "Queue or Book?" to ask, so go straight to booking.
  if (!(await isProductEnabled(getClientOrThrow(), tenantId, "queue"))) return presentServices(tenantId, requestedStaff)

  if (wantsQueue && !wantsBooking) return queueService.startQueueFlow(tenantId, message.from)
  if (wantsBooking && !wantsQueue) return presentServices(tenantId, requestedStaff)

  return {
    reply: entryChoicePromptMessage(),
    buttons: ENTRY_CHOICE_BUTTONS,
    nextState: { state: BOOKING_STATE_ENTRY_CHOICE, data: requestedStaff ? { requestedStaff } : {} },
  }
}

async function handleEntryChoice(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const text = normalizedReplyText(message)
  const requestedStaff = getBookingData(state).requestedStaff

  if (text.includes("queue")) {
    return queueService.startQueueFlow(tenantId, message.from)
  }
  if (text.includes("book")) {
    return presentServices(tenantId, requestedStaff)
  }

  return {
    reply: entryChoiceInvalidMessage(),
    buttons: ENTRY_CHOICE_BUTTONS,
    nextState: { state: BOOKING_STATE_ENTRY_CHOICE, data: requestedStaff ? { requestedStaff } : {} },
  }
}

// ============================================================================
// SAME AGAIN? — one-tap rebooking for returning customers (see rebook.ts)
// ============================================================================

/**
 * Builds the "Same again?" offer for a returning customer, or returns null when
 * there is nothing to offer (new customer, upcoming booking, retired service, no
 * free slot...). Never throws; the caller just carries on with the normal flow.
 *
 * The offer is a normal booking in waiting: the state below carries exactly what
 * the ordinary confirm step needs, so tapping "Yes" runs handleConfirm() and gets
 * its ticket image, name prompt, plan-limit and stale-slot handling for free.
 */
async function offerSameAgain(tenantId: string, phone: string): Promise<ActionResult | null> {
  try {
    // A shop that books without services has no "same service" to repeat.
    if (!(await getBookingServiceMode(tenantId)).requireService) return null

    // Lazy: rebook.ts imports availability helpers from this file.
    const { findSameAgainOffer } = await import("@/lib/services/rebook")
    const offer = await findSameAgainOffer(tenantId, phone)
    if (!offer) return null

    const [selectedService, ...extraServices] = offer.services
    const visit = combineServices(offer.services)

    const data: BookingStateData = {
      selectedService,
      extraServices,
      maxServices: offer.maxServices,
      dateOptions: offer.dateOptions,
      selectedDate: offer.dateISO,
      selectedSlot: offer.slot,
      ...(offer.staff ? { requestedStaff: offer.staff } : {}),
    }

    return {
      reply: sameAgainOfferMessage({
        customerName: offer.customerName,
        serviceName: visit.name,
        dateLabel: offer.dateLabel,
        slotLabel: offer.slot.label,
        staffName: offer.staff?.name,
      }),
      buttons: REBOOK_BUTTONS,
      nextState: { state: BOOKING_STATE_REBOOK_OFFER, data: mergeBookingData({}, data) },
    }
  } catch (error) {
    console.error("[booking] same-again offer failed, using normal flow", { tenantId, error })
    return null
  }
}

type RebookChoice = "yes" | "other_time" | "something_else" | "unknown"

function readRebookChoice(message: IncomingMessage): RebookChoice {
  // A button tap arrives as its title (ids are btn_1..3, assigned by send-message.ts), so
  // taps and typed answers are read the same way, with the same clean-up as handleConfirm().
  const text = normalizedReplyText(message)
    .replace(/^\[(?:button|interactive) reply\]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (text.includes("else") || text.includes("different") || text.includes("menu") || NO_WORDS.has(text)) {
    return "something_else"
  }
  if (YES_WORDS.has(text) || text.includes("book it")) return "yes"
  if (text.includes("other") || text.includes("time")) return "other_time"
  return "unknown"
}

async function handleRebookOffer(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)

  switch (readRebookChoice(message)) {
    case "yes": {
      if (!data.selectedService || !data.selectedDate || !data.selectedSlot) {
        return { reply: missingBookingDataMessage(), buttons: [], nextState: null }
      }
      // Exactly a "yes" at the normal confirm step. createBooking() inside re-checks
      // business hours, notice, the one-upcoming-booking rule, staff and the slot itself.
      return handleConfirm(
        tenantId,
        { ...state, state: BOOKING_STATE_CONFIRM },
        { ...message, text: "yes", contentSummary: "yes" },
      )
    }

    case "other_time":
      // Services are already chosen: skip straight to the earliest free times.
      return presentSoonest(tenantId, { ...data, selectedDate: undefined, selectedSlot: undefined, pendingSlots: undefined })

    case "something_else":
      // No phone passed, so this can't loop back into the offer.
      return presentServices(tenantId)

    default:
      return { reply: sameAgainReminderMessage(), buttons: REBOOK_BUTTONS, nextState: state }
  }
}

/**
 * Shows this shop's services and starts the booking flow (the numbered "reply
 * with a number" list). Exported so the "Book Now" menu row can go straight
 * here instead of through the Queue-or-Book question.
 */
export async function presentServices(
  tenantId: string,
  /** Customer asked for this person (only ever passed when the shop allows staff choice). */
  requestedStaff?: { id: string; name: string },
  /** Pass the customer's phone (e.g. from the "Book Now" menu tap) to show a returning
   *  customer the one-tap "Same again?" offer first. Omit it to go straight to the list. */
  customerPhone?: string,
): Promise<ActionResult> {
  // Backstop for entry points that bypass the router (waitlist tap, same-again): Booking is a per-shop switch.
  if (!(await isProductEnabled(getClientOrThrow(), tenantId, "booking"))) {
    return { reply: "Sorry, this shop doesn't take bookings here.", buttons: [], nextState: null }
  }

  if (customerPhone && !requestedStaff) {
    const sameAgain = await offerSameAgain(tenantId, customerPhone)
    if (sameAgain) return sameAgain
  }

  // "Require a service to book" is off: no list, straight to the date. Checked before
  // loading services so a shop with none set up can still take appointments.
  const mode = await getBookingServiceMode(tenantId)
  if (!mode.requireService) return startNoServiceBooking(tenantId, mode.defaultDurationMinutes, requestedStaff)

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

  // How many may be picked. Failure means 1: the list then behaves as before.
  let maxServices = 1
  try {
    maxServices = await getMaxServicesPerBooking(tenantId)
  } catch (error) {
    console.error("[booking] Could not read max services, using 1", { tenantId, error })
  }

  // One service per booking (the usual shop): tap a row. A shop that lets customers combine services
  // keeps the typed "1,3" list below, because a WhatsApp list can only select one row.
  if (maxServices <= 1) {
    // Nothing to choose: straight to the earliest free times.
    if (services.length === 1) {
      return presentSoonest(tenantId, {
        services,
        maxServices,
        selectedService: services[0],
        extraServices: [],
        ...(requestedStaff ? { requestedStaff } : {}),
      })
    }
    return serviceListReply(services, maxServices, requestedStaff, 0)
  }

  return {
    reply: staffPrefix(requestedStaff) + servicesListMessage(services, maxServices),
    buttons: [],
    nextState: {
      state: BOOKING_STATE_SERVICE_SELECTION,
      data: { services, maxServices, ...(requestedStaff ? { requestedStaff } : {}) },
    },
  }
}

/**
 * Starts a booking for a shop with "require a service to book" OFF. The customer is
 * never shown a services list: they go straight to choosing a day. The state keeps a
 * placeholder one-line "service" (so every later step works unchanged) whose duration is
 * the shop's default appointment length, plus `noService: true` so the confirm step
 * knows to book with no service.
 */
async function startNoServiceBooking(
  tenantId: string,
  durationMinutes: number,
  requestedStaff?: { id: string; name: string },
): Promise<ActionResult> {
  const placeholder: BookingServiceOffer = { id: NO_SERVICE_ID, name: NO_SERVICE_LABEL, price: 0, durationMinutes }

  // No services list: straight to the earliest free times.
  return presentSoonest(tenantId, {
    selectedService: placeholder,
    extraServices: [],
    noService: true,
    ...(requestedStaff ? { requestedStaff } : {}),
  })
}

// ============================================================================
// STEP 2: service → date options
// ============================================================================

/**
 * Reads booking_settings.max_dates_offered for this tenant. Kept as its own
 * small query (rather than a field on getBookingSettings, which lives in
 * tenant-scheduling.ts) so this change is self-contained; fold it into
 * getBookingSettings if you prefer one round trip. Never throws: a missing
 * row or error falls back to DEFAULT_DATES_OFFERED so the date screen can't
 * break over a presentation setting.
 */
async function getDatesOffered(supabase: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await supabase
    .from("booking_settings")
    .select("max_dates_offered")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) {
    console.error("[booking] Failed to load max_dates_offered", { tenantId, error: error.message })
    return DEFAULT_DATES_OFFERED
  }
  const value = Number(data?.max_dates_offered)
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_DATES_OFFERED
}

/**
 * Exported: the kiosk's date-selection screen calls this directly so
 * "today, tomorrow, next N days" is computed identically for both
 * channels — no separate date-formatting logic to keep in sync.
 *
 * Tenant-aware: "today" is the tenant's own local calendar date
 * (tenant_settings.timezone), not the server's/UTC's. How many dates are
 * listed is per-tenant: booking_settings.max_dates_offered (admin-editable),
 * further capped by max_advance_days so a shop with a 3-day advance window
 * never lists dates that would just get rejected server-side if picked.
 */
export async function buildDateOptions(tenantId: string): Promise<Array<{ date: string; label: string }>> {
  const supabase = getClientOrThrow()

  const [timezone, bookingSettings, datesOffered] = await Promise.all([
    getTenantTimezone(supabase, tenantId),
    getBookingSettings(supabase, tenantId),
    getDatesOffered(supabase, tenantId),
  ])

  const today = todayInTimezone(timezone)
  // Two independent limits, the stricter wins: max_advance_days is the rule
  // (what can be booked at all); max_dates_offered is presentation (how many
  // date buttons are listed, today included). Offering index i = today + i,
  // so the last offered index is min(datesOffered - 1, maxAdvanceDays).
  const daysToOffer = Math.min(Math.max(1, datesOffered) - 1, Math.max(0, bookingSettings.maxAdvanceDays))

  const options: Array<{ date: string; label: string }> = []
  for (let i = 0; i <= daysToOffer; i++) {
    const dateISO = addDaysToDateString(today, i)
    // Anchored at UTC noon purely so formatting this pure calendar
    // date can't roll over to the adjacent day in any timezone —
    // dateISO already IS the tenant-local calendar date, no further
    // timezone conversion is needed just to format it as text.
    const formatted = new Date(`${dateISO}T12:00:00.000Z`).toLocaleDateString("en-ZA", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
    // "Today" / "Tomorrow" always carry the real date, so there is never any doubt which day it is.
    const label = i === 0 ? `Today (${formatted})` : i === 1 ? `Tomorrow (${formatted})` : formatted
    options.push({ date: dateISO, label })
  }

  return options
}

async function handleServiceSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const services = data.services ?? []
  const maxServices = data.maxServices ?? 1

  // "More ▸" row on a long service list.
  const page = tappedNumber(message, TAP_MORE)
  if (page !== null) return serviceListReply(services, maxServices, data.requestedStaff, page)

  let chosen: BookingServiceOffer[]
  const tapped = tappedNumber(message, TAP_SERVICE)
  if (tapped !== null && services[tapped]) {
    chosen = [services[tapped]]
  } else {
    // Typed answer: a number, or "1,3" for shops that allow several services.
    const picks = parseServicePicks(rawReplyText(message), services.length, maxServices)
    if (!picks.ok) {
      return {
        reply: message.interactiveId
          ? pickFromListMessage()
          : picks.reason === "too_many"
            ? tooManyServicesMessage(maxServices)
            : invalidSelectionMessage(services.length),
        buttons: [],
        nextState: state,
      }
    }
    chosen = picks.indexes.map((i) => services[i])
  }

  const [selectedService, ...extraServices] = chosen
  return presentSoonest(tenantId, { ...data, selectedService, extraServices })
}

// ============================================================================
// STEP 3: earliest free times (one list across all days)
// ============================================================================

async function handleSoonestSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)

  // "📅 Other day": the days that actually have free times.
  if (message.interactiveId === TAP_OTHER_DAY) return dayListReply(data, 0)

  // "👤 Choose team member": only offered when the shop allows it; re-checked here (it may have been switched off).
  if (message.interactiveId === TAP_PICK_STAFF) {
    const staff = await loadStaffOptions(tenantId)
    if (staff.length < 2) return presentSoonest(tenantId, data)
    return staffListReply(data, staff, 0)
  }

  const index = tappedNumber(message, TAP_SLOT) ?? Number(rawReplyText(message)) - 1
  const choice = Number.isInteger(index) ? data.pendingChoices?.[index] : undefined
  if (!choice) return { reply: pickFromListMessage(), buttons: [], nextState: state }

  return confirmStep(data, choice.date, choice.dateLabel, choice.slot)
}

// ============================================================================
// STEP 3a: "Choose team member" → earliest times for that person
// ============================================================================

async function handleStaffSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const staff = data.staffOptions ?? []

  const page = tappedNumber(message, TAP_MORE)
  if (page !== null) return staffListReply(data, staff, page)

  // Back to the shop's automatic assignment (whoever is free soonest).
  if (message.interactiveId === TAP_STAFF_ANY) {
    return presentSoonest(tenantId, { ...data, requestedStaff: undefined })
  }

  const index = tappedNumber(message, TAP_STAFF)
  const picked = index !== null ? staff[index] : undefined
  if (!picked) return { reply: pickFromListMessage(), buttons: [], nextState: state }

  // createBooking() re-checks that this person is active and free, and that staff choice is still on.
  return presentSoonest(tenantId, { ...data, requestedStaff: { id: picked.id, name: picked.name } }, "", () =>
    Promise.resolve(
      staffListReply(data, staff, 0, `${picked.name} has nothing free in the days we're taking bookings for. Please pick someone else:`),
    ),
  )
}

// ============================================================================
// STEP 3b: "Other day" → date → time slots
// ============================================================================

async function handleDateSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const dateOptions = data.dateOptions ?? []
  const selectedService = data.selectedService

  if (!selectedService) {
    return { reply: startOverMessage(), buttons: [], nextState: null }
  }

  const page = tappedNumber(message, TAP_MORE)
  if (page !== null) return dayListReply(data, page)

  const index = tappedNumber(message, TAP_DAY) ?? Number(rawReplyText(message)) - 1
  if (!Number.isInteger(index) || index < 0 || index >= dateOptions.length) {
    return {
      reply: message.interactiveId ? pickFromListMessage() : invalidSelectionMessage(dateOptions.length),
      buttons: [],
      nextState: state,
    }
  }

  const chosen = dateOptions[index]
  // One entry standing for the whole visit: names joined, minutes summed.
  const visit = combineServices([selectedService, ...(data.extraServices ?? [])])

  let slots: BookingSlot[]
  try {
    slots = await getAvailableSlots(tenantId, chosen.date, visit.durationMinutes, undefined, data.requestedStaff?.id)
  } catch (error) {
    console.error("[booking] Error loading slots", { tenantId, date: chosen.date, error })
    return { reply: availabilityErrorMessage(), buttons: [], nextState: null }
  }

  // Normally impossible (the day list only shows days with free times), but a slot can be taken in between.
  if (slots.length === 0) return dayListReply(data, 0, noSlotsOnDayMessage(chosen.label, data.requestedStaff?.name))

  return timeListReply({ ...data, selectedDate: chosen.date, pendingSlots: slots }, visit.name, chosen.label, slots, 0)
}

// ============================================================================
// STEP 4: time slot → confirmation summary
// ============================================================================

async function handleTimeSelection(_tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getBookingData(state)
  const slots = data.pendingSlots ?? []
  const selectedService = data.selectedService

  if (!selectedService || !data.selectedDate) {
    return { reply: startOverMessage(), buttons: [], nextState: null }
  }
  if (message.interactiveId === TAP_OTHER_DAY) return dayListReply(data, 0)

  const dateLabel = data.dateOptions?.find((d) => d.date === data.selectedDate)?.label ?? data.selectedDate
  const page = tappedNumber(message, TAP_MORE)
  if (page !== null) {
    const visit = combineServices([selectedService, ...(data.extraServices ?? [])])
    return timeListReply(data, visit.name, dateLabel, slots, page)
  }

  const index = tappedNumber(message, TAP_TIME) ?? Number(rawReplyText(message)) - 1
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return {
      reply: message.interactiveId ? pickFromListMessage() : invalidSelectionMessage(slots.length),
      buttons: [],
      nextState: state,
    }
  }

  return confirmStep(data, data.selectedDate, dateLabel, slots[index])
}

// ============================================================================
// STEP 5: confirm → create the booking
// ============================================================================

/** Plain yes/no answers in the languages customers actually use here. */
const YES_WORDS = new Set(["yes", "y", "ewe", "yebo", "ja", "ja asseblief", "yes please", "ewe nceda", "yebo ngiyabonga"])
const NO_WORDS = new Set(["no", "n", "hayi", "cha", "nee", "no thanks", "hayi enkosi"])

async function handleConfirm(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  // A button tap arrives as its title ("✅ Yes", maybe tagged "[button reply]"):
  // drop the tag, emoji and punctuation so it reads exactly like a typed
  // "yes" / "no".
  const text = normalizedReplyText(message)
    .replace(/^\[(?:button|interactive) reply\]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  const data = getBookingData(state)

  // "🕒 Other time": back to the earliest free times for the same service (and team member). Nothing is booked or lost.
  if (/\bother time\b|\bchange time\b|\bdifferent time\b/.test(text)) {
    return presentSoonest(tenantId, { ...data, selectedDate: undefined, selectedSlot: undefined, pendingSlots: undefined })
  }

  if (NO_WORDS.has(text) || text.includes("cancel")) {
    return { reply: bookingCancelledMessage(), buttons: CANCEL_BUTTON, nextState: null }
  }

  if (!YES_WORDS.has(text) && !text.includes("confirm")) {
    return { reply: confirmYesNoReminderMessage(), buttons: BOOKING_CONFIRM_BUTTONS, nextState: state }
  }

  const { selectedService, selectedDate, selectedSlot } = data
  if (!selectedService || !selectedDate || !selectedSlot) {
    return { reply: missingBookingDataMessage(), buttons: [], nextState: null }
  }

  try {
    const extraServices = data.extraServices ?? []
    const result = await createBooking(tenantId, {
      // No service when the customer was never asked for one (createBooking re-checks the setting).
      service: data.noService ? null : selectedService,
      extraServices: data.noService ? [] : extraServices,
      dateISO: selectedDate,
      slot: selectedSlot,
      phone: message.from,
      // Re-validated inside createBooking(): tenant, active, free, and the setting still on.
      requestedStaffId: data.requestedStaff?.id,
      // A shop that requires payment gets a held slot + a card link instead of an instant confirmation.
      payment: "auto",
      channel: "whatsapp",
    })

    // Waiting for payment: no ticket, no calendar link yet. The signed webhook confirms the booking and
    // sends all of that once the money has arrived (lib/payments/settle.ts).
    if (result.status === "awaiting_payment" && result.payment) {
      return {
        reply: bookingPaymentRequestMessage({
          serviceName: result.services.map((s) => s.name).join(" + ") || NO_SERVICE_LABEL,
          slotLabel: selectedSlot.label,
          amountLabel: formatMoneyFor(result.payment.currency, result.payment.amount),
          url: result.payment.url,
          holdMinutes: result.payment.holdMinutes,
        }),
        buttons: [],
        nextState: null,
      }
    }

    // The web link goes on the confirmation only when we are NOT about to ask
    // for the customer's name (that prompt must stay the last thing they see;
    // the link is added to the "thanks" message instead, see handleNameCollection).
    const webNote = result.customer.name ? await getTenantWebLinkNote(tenantId) : ""

    // The shop-branded ticket image, sent right AFTER the confirmation text
    // (and its Cancel/Reschedule buttons) as a follow-up. Never throws: null
    // means tickets are off for this shop or generation failed, and the customer
    // simply gets the text confirmation as before.
    // Loaded lazily so the PNG engine (native resvg) is only pulled in on this
    // WhatsApp path, not into every bundle that imports booking.ts (e.g. the kiosk).
    const { tryGenerateBookingTicketUrl } = await import("@/lib/whatsapp/booking-ticket-image")
    // The "add to calendar" link is built alongside it (best effort: null just leaves the link out).
    const [ticketUrl, calendarUrl] = await Promise.all([
      tryGenerateBookingTicketUrl(tenantId, {
        bookingId: result.bookingId,
        bookingReference: result.bookingReference,
        customerName: result.customer.name,
        customerPhone: message.from,
        serviceNames: result.services.map((s) => s.name),
        totalPrice: result.services.reduce((sum, s) => sum + Number(s.price), 0),
        startTime: result.startTime,
        endTime: result.endTime,
      }),
      buildBookingCalendarUrl(tenantId, {
        serviceNames: result.services.map((s) => s.name),
        startISO: result.startTime,
        endISO: result.endTime,
        reference: result.bookingReference,
        ticketLabel: result.ticketLabel,
      }),
    ])

    return {
      reply:
        bookingConfirmedMessage({
          customerName: result.customer.name,
          serviceName: result.services.map((s) => s.name).join(" + ") || NO_SERVICE_LABEL,
          slotLabel: selectedSlot.label,
          bookingReference: result.bookingReference,
          ticketLabel: result.ticketLabel,
        }) +
        (data.requestedStaff ? `\n${staffRequestedLine(result.staffName ?? data.requestedStaff.name)}` : "") +
        // With the name prompt coming, the link waits for the "thanks" message (the prompt must stay last).
        (result.customer.name && calendarUrl ? addToCalendarNote(calendarUrl) : "") +
        webNote,
      // "Book again" would be a dead end right after booking (one upcoming
      // booking per customer), so offer the one useful next step instead.
      buttons: result.customer.name ? CANCEL_OR_RESCHEDULE_BUTTONS : [],
      nextState: result.customer.name
        ? null
        : { state: BOOKING_STATE_AWAITING_NAME, data: calendarUrl ? { calendarUrl } : {} },
      ...(ticketUrl ? { followUp: [{ reply: "", image: { url: ticketUrl } }] } : {}),
    }
  } catch (error) {
    if (error instanceof Error && error.message === BOOKING_SLOT_NO_LONGER_AVAILABLE) {
      return { reply: slotStaleMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_REQUESTED_STAFF_UNAVAILABLE) {
      return {
        reply: staffNoLongerAvailableMessage(data.requestedStaff?.name ?? "That team member"),
        buttons: [],
        nextState: null,
      }
    }
    if (error instanceof Error && error.message === BOOKING_STAFF_CHOICE_DISABLED) {
      return { reply: staffChoiceOffMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_OUTSIDE_ALLOWED_WINDOW) {
      return { reply: bookingWindowClosedMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_TOO_MANY_SERVICES) {
      return { reply: tooManyServicesMessage(data.maxServices ?? 1), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_PAYMENT_UNAVAILABLE) {
      return { reply: bookingPaymentUnavailableMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_PAYMENT_LINK_FAILED) {
      return { reply: bookingPaymentLinkFailedMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === PLAN_VISIT_LIMIT_REACHED) {
      return { reply: planLimitReachedMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_ALREADY_HAS_UPCOMING) {
      return {
        reply: bookingAlreadyHasUpcomingMessage(),
        buttons: CANCEL_OR_RESCHEDULE_BUTTONS,
        nextState: null,
      }
    }
    if (error instanceof Error && error.message === BOOKING_ALREADY_IN_QUEUE) {
      return { reply: bookingAlreadyInQueueMessage(), buttons: [], nextState: null }
    }
    console.error("[booking] Error creating booking", { tenantId, error })
    return { reply: bookingErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// POST-BOOKING: lightweight name collection
// ============================================================================

/**
 * "Add to calendar" link for a confirmed (or moved) booking, or null if it can't be built. Exported so reschedule.ts
 * uses the same title/details. The shop name is read lazily (like the ticket image: it sits behind the PNG engine,
 * which must stay out of bundles that only import booking.ts, e.g. the kiosk) and is optional. Never throws.
 */
export async function buildBookingCalendarUrl(
  tenantId: string,
  args: { serviceNames: string[]; startISO: string; endISO: string; reference: string; ticketLabel?: string | null },
): Promise<string | null> {
  try {
    let shopName = ""
    try {
      const { getTenantDisplayName } = await import("@/lib/whatsapp/ticket-image")
      shopName = (await getTenantDisplayName(getClientOrThrow(), tenantId)) ?? ""
    } catch (error) {
      console.error("[booking] Could not read the shop name for the calendar link", { tenantId, error })
    }

    const service = args.serviceNames.join(" + ") || NO_SERVICE_LABEL
    return buildGoogleCalendarUrl({
      title: shopName ? `${service} at ${shopName}` : service,
      startISO: args.startISO,
      endISO: args.endISO,
      details: [`Booking reference: ${args.reference}`, ...(args.ticketLabel ? [`Ticket: ${args.ticketLabel}`] : [])].join("\n"),
    })
  } catch (error) {
    console.error("[booking] Could not build the calendar link", { tenantId, error })
    return null
  }
}

async function handleNameCollection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const name = rawReplyText(message)
  // Carried from the confirmation: the link couldn't go there because the name prompt had to be last.
  const calendarUrl = (state.data as { calendarUrl?: string } | null | undefined)?.calendarUrl

  if (!name || name.length < 2) {
    return {
      reply: nameCollectionRetryMessage(),
      buttons: [],
      nextState: { state: BOOKING_STATE_AWAITING_NAME, data: calendarUrl ? { calendarUrl } : {} },
    }
  }

  try {
    await updateCustomer(tenantId, message.from, { name })
  } catch (error) {
    console.error("[booking] Failed to save customer name", { tenantId, error })
  }

  return {
    reply: nameCollectionThanksMessage(name) + (calendarUrl ? addToCalendarNote(calendarUrl) : "") + (await getTenantWebLinkNote(tenantId)),
    buttons: CANCEL_OR_RESCHEDULE_BUTTONS,
    nextState: null,
  }
}

// ============================================================================
// STATE DISPATCH
// ============================================================================

async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case BOOKING_STATE_REBOOK_OFFER:
      return handleRebookOffer(tenantId, state, message)
    case BOOKING_STATE_ENTRY_CHOICE:
      return handleEntryChoice(tenantId, state, message)
    case BOOKING_STATE_SERVICE_SELECTION:
      return handleServiceSelection(tenantId, state, message)
    case BOOKING_STATE_SOONEST_SELECTION:
      return handleSoonestSelection(tenantId, state, message)
    case BOOKING_STATE_STAFF_SELECTION:
      return handleStaffSelection(tenantId, state, message)
    case BOOKING_STATE_DATE_SELECTION:
      return handleDateSelection(tenantId, state, message)
    case BOOKING_STATE_TIME_SELECTION:
      return handleTimeSelection(tenantId, state, message)
    case BOOKING_STATE_CONFIRM:
      return handleConfirm(tenantId, state, message)
    case BOOKING_STATE_AWAITING_NAME:
      return handleNameCollection(tenantId, state, message)
    default:
      return null
  }
}

// ============================================================================
// TAP-ONLY LISTS (services, earliest times, team member, days, times)
// ============================================================================
// Generic list helpers live in lib/services/shared/tap-lists.ts (shared with reschedule.ts). Every row here
// carries an id that WhatsApp returns as message.interactiveId. The "bk_" prefix is what action-router.ts uses
// to keep these taps out of its reset-word check, so a service called "Stop Smoking Massage" can't throw the
// customer back to the main menu. Typed numbers still work (old chats, waitlist-reply.ts).

const TAP_SERVICE = "bk_svc:"
const TAP_SLOT = "bk_slot:"
const TAP_DAY = "bk_day:"
const TAP_TIME = "bk_time:"
const TAP_STAFF = "bk_staff:"
const TAP_MORE = "bk_more:"
const TAP_OTHER_DAY = "bk_other_day"
const TAP_PICK_STAFF = "bk_pick_staff"
const TAP_STAFF_ANY = "bk_staff_any"

const OTHER_DAY_SECTION: ChoiceSection = { title: "More", rows: [{ id: TAP_OTHER_DAY, title: "📅 Other day" }] }

function serviceListReply(
  services: BookingServiceOffer[],
  maxServices: number,
  requestedStaff: { id: string; name: string } | undefined,
  page: number,
): ActionResult {
  const rows = pageRows(
    services,
    page,
    0,
    (s, i) => ({ id: `${TAP_SERVICE}${i}`, title: s.name, description: `R${s.price} · ${s.durationMinutes} min` }),
    TAP_MORE,
  )
  return listReply(`${staffPrefix(requestedStaff)}Here's what we offer 💈`, "Choose service", [{ title: "Services", rows }], {
    state: BOOKING_STATE_SERVICE_SELECTION,
    data: { services, maxServices, ...(requestedStaff ? { requestedStaff } : {}) },
  })
}

/**
 * The team members a customer may choose between: empty unless the shop allows customer staff choice AND has at
 * least two active people (with one there is nothing to choose). Never throws: any failure means "no picker".
 */
async function loadStaffOptions(tenantId: string): Promise<ActiveStaff[]> {
  try {
    const supabase = getClientOrThrow()
    if (!(await readAllowCustomerStaffChoice(supabase, tenantId))) return []
    const staff = await getActiveStaff(supabase, tenantId)
    return staff.length >= 2 ? [...staff].sort((a, b) => a.name.localeCompare(b.name)) : []
  } catch (error) {
    console.error("[booking] Could not load staff for the picker", { tenantId, error })
    return []
  }
}

/** "Who would you like to see?": Anyone (earliest) first, then each active team member. */
function staffListReply(data: BookingStateData, staff: ActiveStaff[], page: number, intro = ""): ActionResult {
  const rows: ChoiceRow[] = [
    { id: TAP_STAFF_ANY, title: "👥 Anyone (earliest)" },
    ...pageRows(staff, page, 1, (s, i) => ({ id: `${TAP_STAFF}${i}`, title: s.name }), TAP_MORE),
  ]
  return listReply(`${intro ? `${intro}\n\n` : ""}Who would you like to see? 👤`, "Choose team member", [{ title: "Team", rows }], {
    state: BOOKING_STATE_STAFF_SELECTION,
    data: mergeBookingData(data, { staffOptions: staff.map((s) => ({ id: s.id, name: s.name })) }),
  })
}

/**
 * THE step after the service: one list with the earliest free times across all days, grouped by day. A "More"
 * section adds "📅 Other day" (only when more times exist than fit) and "👤 Choose team member" (only when the
 * shop allows it). Service -> time -> confirm = two taps. Looks at every offered day in parallel; days with
 * nothing free never appear. `onNoTimes` replaces the default "nothing free" reply. Never throws.
 */
async function presentSoonest(
  tenantId: string,
  data: BookingStateData,
  intro = "",
  onNoTimes?: () => Promise<ActionResult>,
): Promise<ActionResult> {
  const selectedService = data.selectedService
  if (!selectedService) return { reply: startOverMessage(), buttons: [], nextState: null }
  const visit = combineServices([selectedService, ...(data.extraServices ?? [])])

  let loaded: [DayAvailability[], ActiveStaff[]]
  try {
    const dateOptions = await buildDateOptions(tenantId)
    loaded = await Promise.all([
      loadDayAvailability(dateOptions, (date) =>
        getAvailableSlots(tenantId, date, visit.durationMinutes, undefined, data.requestedStaff?.id),
      ),
      loadStaffOptions(tenantId),
    ])
  } catch (error) {
    console.error("[booking] Error loading availability", { tenantId, error })
    return { reply: availabilityErrorMessage(), buttons: [], nextState: null }
  }
  const [days, staffOptions] = loaded

  if (days.length === 0) {
    if (onNoTimes) return onNoTimes()
    return { reply: staffPrefix(data.requestedStaff) + noTimesAvailableMessage(), buttons: [], nextState: null }
  }

  const canPickStaff = staffOptions.length >= 2
  const reserved = canPickStaff ? 1 : 0
  const totalSlots = days.reduce((sum, d) => sum + d.slots.length, 0)
  const showOtherDay = totalSlots > LIST_ROWS - reserved
  const choices = soonestChoices(days, showOtherDay ? LIST_ROWS - reserved - 1 : LIST_ROWS - reserved)

  const sections = soonestSections(choices, TAP_SLOT)
  const moreRows: ChoiceRow[] = []
  if (showOtherDay) moreRows.push({ id: TAP_OTHER_DAY, title: "📅 Other day" })
  if (canPickStaff) {
    moreRows.push({ id: TAP_PICK_STAFF, title: data.requestedStaff ? "👤 Change team member" : "👤 Choose team member" })
  }
  if (moreRows.length > 0) sections.push({ title: "More", rows: moreRows })

  const serviceLine = data.noService ? "" : `✂️ *${visit.name}* · R${visit.price}\n\n`
  const body = `${staffPrefix(data.requestedStaff)}${intro ? `${intro}\n\n` : ""}${serviceLine}Earliest free times 👇`

  return listReply(body, "Choose time", sections, {
    state: BOOKING_STATE_SOONEST_SELECTION,
    data: mergeBookingData(data, {
      // Only days with free times, with a hint, so "Other day" never leads to an empty day.
      dateOptions: days.map((d) => ({ date: d.date, label: d.label, hint: dayHint(d) })),
      pendingChoices: choices,
      selectedDate: undefined,
      selectedSlot: undefined,
      pendingSlots: undefined,
    }),
  })
}

/** "Other day": the days in state (already only days with free times), each with how many times and the first one. */
function dayListReply(data: BookingStateData, page: number, intro = ""): ActionResult {
  const dateOptions = data.dateOptions ?? []
  const rows = pageRows(
    dateOptions,
    page,
    0,
    (d, i) => ({ id: `${TAP_DAY}${i}`, title: d.label, ...(d.hint ? { description: d.hint } : {}) }),
    TAP_MORE,
  )
  return listReply(
    `${staffPrefix(data.requestedStaff)}${intro ? `${intro}\n\n` : ""}Which day works for you? 📅`,
    "Choose day",
    [{ title: "Days", rows }],
    { state: BOOKING_STATE_DATE_SELECTION, data: mergeBookingData(data, {}) },
  )
}

/** The times on one day. `data` must already carry selectedDate and pendingSlots (saved as the next state). */
function timeListReply(
  data: BookingStateData,
  visitName: string,
  dateLabel: string,
  slots: BookingSlot[],
  page: number,
  intro = "",
): ActionResult {
  const rows = pageRows(slots, page, 1, (s, i) => ({ id: `${TAP_TIME}${i}`, title: s.label }), TAP_MORE)
  const body = `${staffPrefix(data.requestedStaff)}${intro ? `${intro}\n\n` : ""}Available times for *${visitName}* on ${dateLabel}:`
  return listReply(body, "Choose time", [{ title: dateLabel, rows }, OTHER_DAY_SECTION], {
    state: BOOKING_STATE_TIME_SELECTION,
    data: mergeBookingData(data, {}),
  })
}

/** The "Just to confirm" screen. Yes / Other time / No. */
function confirmStep(data: BookingStateData, dateISO: string, dateLabel: string, slot: BookingSlot): ActionResult {
  const selectedService = data.selectedService
  if (!selectedService) return { reply: startOverMessage(), buttons: [], nextState: null }
  return {
    reply:
      staffPrefix(data.requestedStaff) +
      (data.noService
        ? noServiceConfirmationMessage(dateLabel, slot.label)
        : confirmationMessage(combineServices([selectedService, ...(data.extraServices ?? [])]), dateLabel, slot)),
    buttons: BOOKING_CONFIRM_BUTTONS,
    nextState: {
      state: BOOKING_STATE_CONFIRM,
      data: mergeBookingData(data, { selectedDate: dateISO, selectedSlot: slot }),
    },
  }
}

export const bookingService = {
  handleBooking,
  /** Straight to the services list — used by the "Book Now" menu row. */
  startBookingFlow: presentServices,
  handleState,
}
