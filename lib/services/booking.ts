// lib/services/booking.ts
/**
 * Salon/Barbershop Appointment Booking Service
 * ---------------------------------------------
 * Lets a WhatsApp customer:
 *   1. Browse bookable services (haircut, beard trim, colour, etc.)
 *   2. Pick a date, then a time slot
 *   3. Confirm — an available staff member is auto-assigned (the shop has
 *      multiple staff, but the customer doesn't choose which one — see
 *      ASSUMPTIONS below).
 *
 * Implements the same two contracts action-router.ts expects from every
 * domain service (mirrors vvipService / ticketsService exactly):
 *   - bookingService.handleBooking — entry point for a fresh "booking" intent.
 *   - bookingService.handleState   — StatefulService.handleState for any
 *     in-progress "booking_*" conversation state.
 *
 * All customer-facing copy lives in lib/services/messages/booking.ts — this
 * file only owns state transitions, availability logic, and data access.
 *
 * ============================================================================
 * ASSUMPTIONS — adjust these to match your real schema before wiring up
 * ============================================================================
 * 1. `services` table: id, name, price, duration_minutes, active (bool)
 * 2. `staff` table: id, name, active (bool)
 * 3. `bookings` table: id, customer_id, service_id, staff_id, start_time,
 *    end_time, status ('confirmed'|'cancelled'), booking_reference
 * 4. Shop hours are a flat constant (SHOP_OPEN_HOUR / SHOP_CLOSE_HOUR) —
 *    swap for a real `business_hours` table if hours vary by day.
 * 5. "Don't care who" booking: a time slot is offered if AT LEAST ONE
 *    active staff member has no overlapping booking in that window. At
 *    confirm time, the first free staff member is assigned — re-checked
 *    right before insert (same best-effort-with-fallback pattern
 *    vvip.ts uses for table assignment), not a hard DB-level lock. Good
 *    enough for a prototype; add a unique constraint on
 *    (staff_id, start_time) as a hard backstop against double-booking
 *    before going to production.
 * 6. No payment step. Booking confirms immediately on "yes". If you want
 *    a deposit later, insert a payment-method step here the same way
 *    vvip.ts's buildPaymentMethodStep does, reusing debitWallet/initiatePayment.
 * ============================================================================
 */

import crypto from "node:crypto"

import { getSupabaseServerClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer, updateCustomer } from "@/lib/services/customer"
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
// STATE DATA — typed get/merge, same pattern as vvip.ts's getVvipData
// ============================================================================

// Local alias so the rest of this file reads the same as before the
// catalog helper moved to services-catalog.ts.
type BookingServiceOffer = CatalogService

// Exported so lib/services/messages/booking.ts can type its slot-related
// message builders without duplicating this shape.
export interface BookingSlot {
  /** ISO start time, e.g. "2026-09-15T10:30:00.000Z" */
  start: string
  /** Human display, e.g. "Tue 15 Sep, 10:30" */
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
// DATA ACCESS — availability
// ============================================================================

interface ActiveStaff {
  id: string
  name: string
}

async function getActiveStaff(supabase: SupabaseClient): Promise<ActiveStaff[]> {
  const { data, error } = await supabase.from("staff").select("id, name").eq("active", true)
  if (error) throw new Error(`Failed to load staff: ${error.message}`)
  return data ?? []
}

/**
 * Returns booked (staff_id, start_time, end_time) rows for the given date,
 * across all active staff, so slot generation can check overlaps in memory
 * rather than one query per candidate slot.
 */
async function getBookingsForDate(
  supabase: SupabaseClient,
  dateISO: string,
): Promise<Array<{ staffId: string; start: Date; end: Date }>> {
  const dayStart = new Date(`${dateISO}T00:00:00.000Z`)
  const dayEnd = new Date(`${dateISO}T23:59:59.999Z`)

  const { data, error } = await supabase
    .from("bookings")
    .select("staff_id, start_time, end_time")
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
 * granularity within shop hours, and keeps only slots where at least one
 * active staff member is free for the full service duration. "Don't care
 * who" means we never expose which staff member — just that a slot works.
 */
async function getAvailableSlots(dateISO: string, durationMinutes: number): Promise<BookingSlot[]> {
  const supabase = getClientOrThrow()
  const staff = await getActiveStaff(supabase)
  if (staff.length === 0) return []

  const existingBookings = await getBookingsForDate(supabase, dateISO)

  const slots: BookingSlot[] = []
  const dayBase = new Date(`${dateISO}T00:00:00.000Z`)

  for (let minutes = SHOP_OPEN_HOUR * 60; minutes + durationMinutes <= SHOP_CLOSE_HOUR * 60; minutes += SLOT_INTERVAL_MINUTES) {
    const slotStart = new Date(dayBase.getTime() + minutes * 60_000)
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)

    // Don't offer slots already in the past for "today".
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
 * insert — best-effort with fallback, same reasoning as vvip.ts's table
 * reservation: minutes may have passed since the slot was offered, so the
 * first-choice staff member might now be booked. Throws if genuinely
 * nobody is free anymore (slot went stale between offer and confirm).
 */
async function claimStaffForSlot(
  supabase: SupabaseClient,
  dateISO: string,
  slot: BookingSlot,
  durationMinutes: number,
): Promise<ActiveStaff> {
  const staff = await getActiveStaff(supabase)
  const existingBookings = await getBookingsForDate(supabase, dateISO)
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
//
// Offers "book a time" vs "join the queue" up front, before either flow
// starts. There's no separate top-level "queue" intent — queueing lives
// inside the booking intent's entry choice, so this is the only place in
// the app that knows queue.ts exists at all. Everything past this point
// (queue_* states) is owned entirely by queue.ts, registered as its own
// StatefulService in action-router.ts's stateHandlers.

async function handleBooking(_intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  return {
    reply: entryChoicePromptMessage(),
    buttons: ENTRY_CHOICE_BUTTONS,
    nextState: { state: BOOKING_STATE_ENTRY_CHOICE, data: {} },
  }
}

/**
 * Matched with `.includes()` against the button title / typed text, same
 * loose-matching convention as action-router.ts's GLOBAL_INTERRUPT_KEYWORDS
 * — "📅 Book a time" and a plain typed "book" both need to land here.
 */
async function handleEntryChoice(message: IncomingMessage): Promise<ActionResult> {
  const text = normalizedReplyText(message)

  if (text.includes("queue")) {
    return queueService.startQueueFlow()
  }
  if (text.includes("book")) {
    return presentServices()
  }

  return {
    reply: entryChoiceInvalidMessage(),
    buttons: ENTRY_CHOICE_BUTTONS,
    nextState: { state: BOOKING_STATE_ENTRY_CHOICE, data: {} },
  }
}

async function presentServices(): Promise<ActionResult> {
  let services: BookingServiceOffer[]
  try {
    services = await getBookableServices()
  } catch (error) {
    console.error("[booking] Error loading services", { error })
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

async function handleServiceSelection(state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
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

async function handleDateSelection(state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
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
    slots = await getAvailableSlots(chosen.date, selectedService.durationMinutes)
  } catch (error) {
    console.error("[booking] Error loading slots", { date: chosen.date, error })
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

async function handleTimeSelection(state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
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

async function handleConfirm(state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
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
    const staff = await claimStaffForSlot(supabase, selectedDate, selectedSlot, selectedService.durationMinutes)

    // Creates a minimal (phone-only) profile if this is a brand-new
    // customer — no name/email required to book. Unlike Rands' wallet/VVIP
    // flows, appointment booking is deliberately NOT gated behind full
    // registration (see registration.ts's file header before reusing it
    // elsewhere — it collects email and an alcohol age-gate that don't
    // apply here).
    const customer = await ensureCustomer(message.from)

    const startTime = new Date(selectedSlot.start)
    const endTime = new Date(startTime.getTime() + selectedService.durationMinutes * 60_000)
    const bookingReference = crypto.randomUUID().slice(0, 8).toUpperCase()

    const { error } = await supabase.from("bookings").insert([
      {
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
      // If we don't have a name yet, stay in a lightweight "collect name"
      // state — NOT the full registration.ts flow (no email, no age-gate).
      // The booking itself is already confirmed either way; this only
      // improves the record for the shop owner.
      nextState: customer.name ? null : { state: BOOKING_STATE_AWAITING_NAME, data: {} },
    }
  } catch (error) {
    if (error instanceof Error && error.message === "BOOKING_SLOT_NO_LONGER_AVAILABLE") {
      return { reply: slotStaleMessage(), buttons: [], nextState: null }
    }
    console.error("[booking] Error creating booking", { error })
    return { reply: bookingErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// POST-BOOKING: lightweight name collection (NOT registration.ts)
// ============================================================================

async function handleNameCollection(message: IncomingMessage): Promise<ActionResult> {
  const name = rawReplyText(message)

  if (!name || name.length < 2) {
    return {
      reply: nameCollectionRetryMessage(),
      buttons: [],
      nextState: { state: BOOKING_STATE_AWAITING_NAME, data: {} },
    }
  }

  try {
    await updateCustomer(message.from, { name })
  } catch (error) {
    // Non-fatal — the appointment is already booked either way; the name
    // is just a nice-to-have for the shop's records.
    console.error("[booking] Failed to save customer name", { error })
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

async function handleState(state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case BOOKING_STATE_ENTRY_CHOICE:
      return handleEntryChoice(message)
    case BOOKING_STATE_SERVICE_SELECTION:
      return handleServiceSelection(state, message)
    case BOOKING_STATE_DATE_SELECTION:
      return handleDateSelection(state, message)
    case BOOKING_STATE_TIME_SELECTION:
      return handleTimeSelection(state, message)
    case BOOKING_STATE_CONFIRM:
      return handleConfirm(state, message)
    case BOOKING_STATE_AWAITING_NAME:
      return handleNameCollection(message)
    default:
      return null
  }
}

export const bookingService = {
  handleBooking,
  handleState,
}
