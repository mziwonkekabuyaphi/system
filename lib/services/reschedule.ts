// lib/services/reschedule.ts
/**
 * Move my booking — tenant-scoped WhatsApp flow.
 * ------------------------------------------------------------------------
 * Before this existed a customer who wanted a different time could only
 * cancel and start over, and a typed "reschedule" was passed to a human as
 * support. Now it is a short flow that reuses the booking flow's own date and
 * time screens and swaps the time in one step.
 *
 * ENTRY: the "Reschedule" menu row, the reminder's "Move it" button
 * (rem_move:<booking id>, via reminder-reply.ts), or a typed request ("reschedule", "move my booking", "change my
 * appointment"...) matched by RESCHEDULE_REQUEST_PATTERN in action-router.ts.
 * That is deterministic, so it never reaches AI classification.
 *
 * FLOW
 *   1. Load the customer's upcoming CONFIRMED bookings.
 *        none -> say so + menu.   one -> straight to the date list.
 *        several -> ask which (reply with a number).
 *   2. Date list (buildDateOptions, the same list booking uses), then the free
 *      times for that day (getAvailableSlots). The slot search is for the
 *      booking's own length, so a multi-service booking keeps its full
 *      duration, and the booking being moved never blocks its own new time.
 *   3. Yes/no confirmation, then rescheduleBooking() in booking.ts does the
 *      move as a SINGLE update. The old time stays booked until that update
 *      succeeds, so a failure never leaves the customer with nothing.
 *
 * RULES (all enforced again server-side in rescheduleBooking(), never trusted
 * from conversation state):
 *   - same cut-off as cancelling (booking_settings.cancellation_window_minutes):
 *     a booking starting sooner than that cannot be moved here
 *   - a booking already in the live queue, or being served, is left to a human
 *   - the new time must pass business hours, max_advance_days and
 *     min_notice_minutes, and someone must be free for the full length
 *
 * States owned by this service all start with "reschedule_" (action-router.ts
 * relies on that prefix). Customer-facing copy lives in
 * lib/services/messages/reschedule.ts.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { getCustomer } from "@/lib/services/tenant-customer"
import { getBookingSettings, getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { buildServicesListMessage } from "@/lib/whatsapp/utils/services-list"
import {
  BOOKING_OUTSIDE_ALLOWED_WINDOW,
  BOOKING_SLOT_NO_LONGER_AVAILABLE,
  buildDateOptions,
  getAvailableSlots,
  rescheduleBooking,
  type BookingSlot,
} from "@/lib/services/booking"
import { parseYesNo } from "@/lib/services/cancel"

import {
  CANCEL_NOW_BUTTON,
  CONFIRM_BUTTONS,
  availabilityErrorMessage,
  dateOptionsMessage,
  invalidSelectionMessage,
  noSlotsMessage,
  slotsListMessage,
} from "@/lib/services/messages/booking"
import {
  rescheduleAlreadyGoneMessage,
  rescheduleChooseMessage,
  rescheduleConfirmMessage,
  rescheduleConfirmReminderMessage,
  rescheduleDoneMessage,
  rescheduleErrorMessage,
  rescheduleInQueueMessage,
  rescheduleInvalidChoiceMessage,
  rescheduleKeptMessage,
  rescheduleMenuPromptMessage,
  rescheduleNothingMessage,
  rescheduleSlotTakenMessage,
  rescheduleStartMessage,
  rescheduleTooLateMessage,
  rescheduleUnchangedMessage,
  rescheduleWindowClosedMessage,
  type RescheduleOption,
} from "@/lib/services/messages/reschedule"

// ============================================================================
// CONSTANTS
// ============================================================================

export const RESCHEDULE_STATE_CHOOSE = "reschedule_choose"
export const RESCHEDULE_STATE_DATE = "reschedule_date"
export const RESCHEDULE_STATE_TIME = "reschedule_time"
export const RESCHEDULE_STATE_CONFIRM = "reschedule_confirm"

/**
 * Typed requests that mean "move my booking". Matched on the lowercased text,
 * with word boundaries so "reschedule" / "rescheduling" / "re-schedule" count
 * but unrelated words don't. Deliberately about moving an EXISTING booking:
 * "book for tomorrow" or "cancel my booking" never match.
 */
export const RESCHEDULE_REQUEST_PATTERN =
  /\b(re-?schedul\w*|verskuif\w*|(move|change|shift|swap|postpone|push)\b[^.?!]{0,25}\b(booking|appointment|time|slot)|(booking|appointment)\b[^.?!]{0,25}\b(later|earlier|another (day|time)|different (day|time)))\b/i

/** What the conversation remembers about the booking being moved. Kept small. */
interface MovableBooking {
  id: string
  serviceName: string
  /** endTime - startTime, in minutes. */
  durationMinutes: number
  /** Ready-to-show current time, e.g. "Tue 14 Oct, 10:30". */
  currentLabel: string
  reference: string
}

interface RescheduleStateData {
  options?: Array<RescheduleOption & { booking: MovableBooking }>
  booking?: MovableBooking
  dateOptions?: Array<{ date: string; label: string }>
  selectedDate?: string
  pendingSlots?: BookingSlot[]
  selectedSlot?: BookingSlot
}

function getData(state: ConversationState): RescheduleStateData {
  return (state.data ?? {}) as RescheduleStateData
}

function merge(current: RescheduleStateData, patch: Partial<RescheduleStateData>): ConversationState["data"] {
  return { ...current, ...patch } as ConversationState["data"]
}

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

function rawReplyText(message: IncomingMessage): string {
  return (message.text ?? message.contentSummary ?? "").trim()
}

function normalizedReplyText(message: IncomingMessage): string {
  return (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
}

/** Reply plus the menu, for a flow that ends here. */
function done(reply: string): ActionResult {
  return {
    reply,
    buttons: [],
    nextState: null,
    followUp: [buildServicesListMessage(rescheduleMenuPromptMessage())],
  }
}

function formatLocal(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso))
}

// ============================================================================
// DATA — what can this customer move?
// ============================================================================

interface LoadedBookings {
  movable: MovableBooking[]
  /** Upcoming bookings that are already in the live queue / being served. */
  inQueue: number
  /** Upcoming bookings inside the cancellation window. */
  tooLate: number
  windowMinutes: number
}

async function loadMovableBookings(tenantId: string, customerId: string): Promise<LoadedBookings> {
  const supabase = getClientOrThrow()

  const [settings, timezone, bookingsResult] = await Promise.all([
    getBookingSettings(supabase, tenantId),
    getTenantTimezone(supabase, tenantId),
    supabase
      .from("bookings")
      .select(
        `id, start_time, end_time, booking_reference,
         services!bookings_service_id_fkey ( name ),
         booking_services ( position, services ( name ) )`,
      )
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("status", "confirmed")
      .gt("start_time", new Date().toISOString())
      .order("start_time", { ascending: true })
      .limit(5),
  ])

  if (bookingsResult.error) throw new Error(`Failed to load bookings: ${bookingsResult.error.message}`)
  const rows = bookingsResult.data ?? []

  const liveIds = new Set<string>()
  if (rows.length > 0) {
    const { data: entries, error } = await supabase
      .from("queue_entries")
      .select("booking_id")
      .eq("tenant_id", tenantId)
      .in("booking_id", rows.map((r) => r.id))
      .in("status", ["waiting", "called"])
    if (error) throw new Error(`Failed to check queue entries: ${error.message}`)
    for (const e of entries ?? []) if (e.booking_id) liveIds.add(e.booking_id as string)
  }

  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))
  const now = Date.now()
  const windowMillis = Math.max(0, settings.cancellationWindowMinutes) * 60_000
  const result: LoadedBookings = { movable: [], inQueue: 0, tooLate: 0, windowMinutes: settings.cancellationWindowMinutes }

  for (const row of rows) {
    if (liveIds.has(row.id)) {
      result.inQueue += 1
      continue
    }
    const startMillis = new Date(row.start_time).getTime()
    if (startMillis - now < windowMillis) {
      result.tooLate += 1
      continue
    }

    const names: string[] = []
    const primary = one<{ name: string | null }>(row.services as never)?.name
    if (primary) names.push(primary)
    const links = [...((row.booking_services ?? []) as unknown as Array<{ position: number | null; services: unknown }>)].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    )
    for (const link of links) {
      const n = one<{ name: string | null }>(link.services as never)?.name
      if (n && !names.includes(n)) names.push(n)
    }

    result.movable.push({
      id: row.id,
      serviceName: names.join(" + ") || "Appointment",
      durationMinutes: Math.max(1, Math.round((new Date(row.end_time).getTime() - startMillis) / 60_000)),
      currentLabel: formatLocal(row.start_time, timezone),
      reference: row.booking_reference,
    })
  }

  return result
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function handleReschedule(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  return startFlow(tenantId, message.from)
}

/**
 * Starts the flow for ONE booking — used by the reminder's "Move it" button
 * (reminder-reply.ts), whose id carries the booking. The caller has already
 * checked the booking is this customer's and still confirmed; everything is
 * checked again here and in rescheduleBooking().
 */
async function handleRescheduleForBooking(tenantId: string, message: IncomingMessage, bookingId: string): Promise<ActionResult> {
  return startFlow(tenantId, message.from, bookingId)
}

async function startFlow(tenantId: string, phone: string, onlyBookingId?: string): Promise<ActionResult> {
  try {
    const customer = await getCustomer(tenantId, phone)
    if (!customer) return done(rescheduleNothingMessage())

    const loaded = await loadMovableBookings(tenantId, customer.id)

    if (onlyBookingId) {
      const target = loaded.movable.find((b) => b.id === onlyBookingId)
      if (target) return await startDateStep(tenantId, target)
    }

    if (loaded.movable.length === 0 || onlyBookingId) {
      if (loaded.inQueue > 0) return done(rescheduleInQueueMessage())
      if (loaded.tooLate > 0) return done(rescheduleTooLateMessage(loaded.windowMinutes))
      return done(rescheduleNothingMessage())
    }

    if (loaded.movable.length === 1) return await startDateStep(tenantId, loaded.movable[0])

    const options = loaded.movable.map((b) => ({
      id: b.id,
      label: `📅 ${b.serviceName} — ${b.currentLabel} (Ref ${b.reference})`,
      booking: b,
    }))
    return {
      reply: rescheduleChooseMessage(options),
      buttons: [],
      nextState: { state: RESCHEDULE_STATE_CHOOSE, data: { options } as ConversationState["data"] },
    }
  } catch (error) {
    console.error("[reschedule] Error starting reschedule flow", { tenantId, error })
    return { reply: rescheduleErrorMessage(), buttons: [], nextState: null }
  }
}

async function startDateStep(tenantId: string, booking: MovableBooking): Promise<ActionResult> {
  const dateOptions = await buildDateOptions(tenantId)
  if (dateOptions.length === 0) return done(rescheduleNothingMessage())

  return {
    reply: `${rescheduleStartMessage(booking.serviceName, booking.currentLabel)}\n\n${dateOptionsMessage(dateOptions)}`,
    buttons: [],
    nextState: { state: RESCHEDULE_STATE_DATE, data: { booking, dateOptions } as ConversationState["data"] },
  }
}

// ============================================================================
// STEP: which booking (only when there is more than one)
// ============================================================================

async function handleChoose(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const options = getData(state).options ?? []
  const index = Number(rawReplyText(message)) - 1

  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    return { reply: rescheduleInvalidChoiceMessage(options.length), buttons: [], nextState: state }
  }

  try {
    return await startDateStep(tenantId, options[index].booking)
  } catch (error) {
    console.error("[reschedule] Error preparing dates", { tenantId, error })
    return { reply: rescheduleErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STEP: date -> free times
// ============================================================================

async function handleDate(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getData(state)
  const booking = data.booking
  const dateOptions = data.dateOptions ?? []
  if (!booking) return done(rescheduleAlreadyGoneMessage())

  const index = Number(rawReplyText(message)) - 1
  if (!Number.isInteger(index) || index < 0 || index >= dateOptions.length) {
    return { reply: invalidSelectionMessage(dateOptions.length), buttons: [], nextState: state }
  }

  const chosen = dateOptions[index]

  let slots: BookingSlot[]
  try {
    // The booking's own length, and ignoring the booking itself, so moving a
    // little later in the same day isn't blocked by the time it already holds.
    slots = await getAvailableSlots(tenantId, chosen.date, booking.durationMinutes, booking.id)
  } catch (error) {
    console.error("[reschedule] Error loading slots", { tenantId, date: chosen.date, error })
    return { reply: availabilityErrorMessage(), buttons: [], nextState: null }
  }

  if (slots.length === 0) {
    return { reply: `${noSlotsMessage()}\n\n${dateOptionsMessage(dateOptions)}`, buttons: [], nextState: state }
  }

  return {
    reply: slotsListMessage(booking.serviceName, chosen.label, slots),
    buttons: [],
    nextState: {
      state: RESCHEDULE_STATE_TIME,
      data: merge(data, { selectedDate: chosen.date, pendingSlots: slots }),
    },
  }
}

// ============================================================================
// STEP: time -> confirmation
// ============================================================================

async function handleTime(_tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getData(state)
  const booking = data.booking
  const slots = data.pendingSlots ?? []
  if (!booking) return done(rescheduleAlreadyGoneMessage())

  const index = Number(rawReplyText(message)) - 1
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { reply: invalidSelectionMessage(slots.length), buttons: [], nextState: state }
  }

  const selectedSlot = slots[index]
  const newDateLabel = data.dateOptions?.find((d) => d.date === data.selectedDate)?.label ?? data.selectedDate ?? ""

  return {
    reply: rescheduleConfirmMessage({
      serviceName: booking.serviceName,
      currentLabel: booking.currentLabel,
      newDateLabel,
      slotLabel: selectedSlot.label,
    }),
    buttons: CONFIRM_BUTTONS,
    nextState: { state: RESCHEDULE_STATE_CONFIRM, data: merge(data, { selectedSlot }) },
  }
}

// ============================================================================
// STEP: yes / no -> move it
// ============================================================================

async function handleConfirm(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  // A button tap arrives as its title ("✅ Yes", maybe tagged "[button reply]"):
  // drop the tag, emoji and punctuation so it reads like a typed yes / no.
  const text = normalizedReplyText(message)
    .replace(/^\[(?:button|interactive) reply\]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  const answer = parseYesNo(text)

  const data = getData(state)
  const { booking, selectedDate, selectedSlot } = data

  if (!booking || !selectedDate || !selectedSlot) return done(rescheduleAlreadyGoneMessage())

  if (answer === null) {
    return { reply: rescheduleConfirmReminderMessage(), buttons: CONFIRM_BUTTONS, nextState: state }
  }
  if (answer === "no") return done(rescheduleKeptMessage())

  try {
    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return done(rescheduleAlreadyGoneMessage())

    const result = await rescheduleBooking(tenantId, customer.id, booking.id, selectedDate, selectedSlot)

    switch (result.outcome) {
      case "rescheduled": {
        const newDateLabel = data.dateOptions?.find((d) => d.date === selectedDate)?.label ?? selectedDate
        return {
          reply: rescheduleDoneMessage({
            serviceName: result.serviceName ?? booking.serviceName,
            newDateLabel,
            slotLabel: selectedSlot.label,
            bookingReference: result.bookingReference ?? booking.reference,
          }),
          buttons: CANCEL_NOW_BUTTON,
          nextState: null,
        }
      }
      case "unchanged":
        return done(rescheduleUnchangedMessage())
      case "too_late":
        return done(rescheduleTooLateMessage(result.windowMinutes))
      case "in_queue":
        return done(rescheduleInQueueMessage())
      default:
        return done(rescheduleAlreadyGoneMessage())
    }
  } catch (error) {
    if (error instanceof Error && error.message === BOOKING_SLOT_NO_LONGER_AVAILABLE) {
      return { reply: rescheduleSlotTakenMessage(), buttons: [], nextState: null }
    }
    if (error instanceof Error && error.message === BOOKING_OUTSIDE_ALLOWED_WINDOW) {
      return { reply: rescheduleWindowClosedMessage(), buttons: [], nextState: null }
    }
    console.error("[reschedule] Error rescheduling", { tenantId, bookingId: booking.id, error })
    return { reply: rescheduleErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STATE DISPATCH
// ============================================================================

async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case RESCHEDULE_STATE_CHOOSE:
      return handleChoose(tenantId, state, message)
    case RESCHEDULE_STATE_DATE:
      return handleDate(tenantId, state, message)
    case RESCHEDULE_STATE_TIME:
      return handleTime(tenantId, state, message)
    case RESCHEDULE_STATE_CONFIRM:
      return handleConfirm(tenantId, state, message)
    default:
      return null
  }
}

export const rescheduleService = {
  handleReschedule,
  handleRescheduleForBooking,
  handleState,
}
