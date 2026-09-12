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
 * What changed for multi-tenancy (vs the version this replaces):
 *   1. Every exported function and internal data-access helper now takes
 *      `tenantId` as its first argument, and every raw Supabase query
 *      against `staff`/`bookings` now filters `.eq("tenant_id", tenantId)`.
 *      Previously none of them did — without it, "don't care who"
 *      availability could pull in a different tenant's staff/bookings.
 *   2. Switched from `@/lib/services/customer` (profiles-based, can't
 *      create a row for an anonymous WhatsApp customer at all) to
 *      `@/lib/services/tenant-customer` (tenant_customers-based, built
 *      for exactly this). `customer.name` is now `tenant_customers.
 *      full_name` under the hood — still called `.name` on the returned
 *      object, so nothing downstream needed to change.
 *   3. `getBookableServices` (services-catalog.ts) now also needs a
 *      `tenantId` argument — that file wasn't part of this rewrite pass,
 *      so it's called here as `getBookableServices(tenantId)`. If that
 *      file hasn't been updated to accept it yet, this won't compile
 *      until it is.
 *
 * ASSUMPTIONS — unchanged from the original:
 *   - `services`/`staff`/`bookings` tables, shop hours as a flat
 *     constant, "don't care who" staff assignment (best-effort re-check
 *     at confirm time, no DB-level lock), no payment step.
 */

import crypto from "node:crypto"

import { getSupabaseServerClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer, updateCustomer } from "@/lib/services/tenant-customer"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { queueService } from "@/lib/services/queue"

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

const SHOP_OPEN_HOUR = 9 // 09:00
const SHOP_CLOSE_HOUR = 18 // 18:00
const SLOT_INTERVAL_MINUTES = 30 // granularity of offered start times
const DAYS_AHEAD_OFFERED = 6 // "today" + next 6 days

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
 * builder signatures (slotsListMessage, confirmationMessage). */
export interface BookingSlot {
  /** ISO start time, e.g. "2026-09-15T10:30:00.000Z" */
  start: string
  /** Human display, e.g. "10:30" */
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
 * Returns booked (staff_id, start_time, end_time) rows for the given date,
 * scoped to this tenant, across all active staff, so slot generation can
 * check overlaps in memory rather than one query per candidate slot.
 */
async function getBookingsForDate(
  supabase: SupabaseClient,
  tenantId: string,
  dateISO: string,
): Promise<Array<{ staffId: string; start: Date; end: Date }>> {
  const dayStart = new Date(`${dateISO}T00:00:00.000Z`)
  const dayEnd = new Date(`${dateISO}T23:59:59.999Z`)

  const { data, error } = await supabase
    .from("bookings")
    .select("staff_id, start_time, end_time")
    .eq("tenant_id", tenantId)
    .eq("status", "confirmed")
    .gte("start_time", dayStart.toISOString())
    .lte("start_time", dayEnd.toISOString())

  if (error) throw new Error(`Failed to load bookings for ${dateISO}: ${error.message}`)

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
 * Generates candidate slots for the date at SLOT_INTERVAL_MINUTES
 * granularity within shop hours, keeping only slots where at least one
 * of THIS TENANT's active staff is free for the full service duration.
 */
async function getAvailableSlots(tenantId: string, dateISO: string, durationMinutes: number): Promise<BookingSlot[]> {
  const supabase = getClientOrThrow()
  const staff = await getActiveStaff(supabase, tenantId)
  if (staff.length === 0) return []

  const existingBookings = await getBookingsForDate(supabase, tenantId, dateISO)

  const slots: BookingSlot[] = []
  const dayBase = new Date(`${dateISO}T00:00:00.000Z`)

  for (let minutes = SHOP_OPEN_HOUR * 60; minutes + durationMinutes <= SHOP_CLOSE_HOUR * 60; minutes += SLOT_INTERVAL_MINUTES) {
    const slotStart = new Date(dayBase.getTime() + minutes * 60_000)
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)

    if (slotStart.getTime() < Date.now()) continue

    const anyStaffFree = staff.some((member) => {
      const memberBookings = existingBookings.filter((b) => b.staffId === member.id)
      return !memberBookings.some((b) => overlaps(slotStart, slotEnd, b.start, b.end))
    })

    if (anyStaffFree) {
      slots.push({
        start: slotStart.toISOString(),
        label: slotStart.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false }),
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
  const existingBookings = await getBookingsForDate(supabase, tenantId, dateISO)
  const slotStart = new Date(slot.start)
  const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)

  const freeStaff = staff.find((member) => {
    const memberBookings = existingBookings.filter((b) => b.staffId === member.id)
    return !memberBookings.some((b) => overlaps(slotStart, slotEnd, b.start, b.end))
  })

  if (!freeStaff) {
    throw new Error("BOOKING_SLOT_NO_LONGER_AVAILABLE")
  }

  return freeStaff
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

function buildDateOptions(): Array<{ date: string; label: string }> {
  const options: Array<{ date: string; label: string }> = []
  const now = new Date()

  for (let i = 0; i <= DAYS_AHEAD_OFFERED; i++) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() + i)
    const dateISO = d.toISOString().slice(0, 10)
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" })
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
  const dateOptions = buildDateOptions()

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

  const supabase = getClientOrThrow()

  try {
    const staff = await claimStaffForSlot(supabase, tenantId, selectedDate, selectedSlot, selectedService.durationMinutes)

    // Minimal (phone-only) tenant_customers row if this is a brand-new
    // customer — no name/email required to book.
    const customer = await ensureCustomer(tenantId, message.from)

    const startTime = new Date(selectedSlot.start)
    const endTime = new Date(startTime.getTime() + selectedService.durationMinutes * 60_000)
    const bookingReference = crypto.randomUUID().slice(0, 8).toUpperCase()

    const { error } = await supabase.from("bookings").insert([
      {
        tenant_id: tenantId,
        customer_id: customer.id,
        service_id: selectedService.id,
        staff_id: staff.id,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        status: "confirmed",
        booking_reference: bookingReference,
      },
    ])

    if (error) throw new Error(error.message)

    return {
      reply: bookingConfirmedMessage({
        customerName: customer.name,
        serviceName: selectedService.name,
        slotLabel: selectedSlot.label,
        bookingReference,
      }),
      buttons: customer.name ? CANCEL_BUTTON : [],
      nextState: customer.name ? null : { state: BOOKING_STATE_AWAITING_NAME, data: {} },
    }
  } catch (error) {
    if (error instanceof Error && error.message === "BOOKING_SLOT_NO_LONGER_AVAILABLE") {
      return { reply: slotStaleMessage(), buttons: [], nextState: null }
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
