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
 *   2. TAP-ONLY: one list of the EARLIEST free times across all days (the booking's current time is
 *      left out), with "📅 Other day" for the rest; that leads to a day list (only days with free times)
 *      and then that day's times. Same helpers as booking.ts: lib/services/shared/tap-lists.ts.
 *      The slot search (getAvailableSlots) is for the
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
  buildBookingCalendarUrl,
  buildDateOptions,
  getAvailableSlots,
  rescheduleBooking,
  type BookingSlot,
} from "@/lib/services/booking"
import { parseYesNo } from "@/lib/services/cancel"
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
import type { ChoiceSection } from "@/lib/whatsapp/utils/choice-list"

import {
  addToCalendarNote,
  availabilityErrorMessage,
  invalidSelectionMessage,
  noSlotsOnDayMessage,
  pickFromListMessage,
} from "@/lib/services/messages/booking"
import {
  CANCEL_OR_RESCHEDULE_BUTTONS,
  RESCHEDULE_CONFIRM_BUTTONS,
  rescheduleAlreadyGoneMessage,
  rescheduleChooseBody,
  rescheduleConfirmMessage,
  rescheduleConfirmReminderMessage,
  rescheduleDoneMessage,
  rescheduleErrorMessage,
  rescheduleInQueueMessage,
  rescheduleInvalidChoiceMessage,
  rescheduleKeptMessage,
  rescheduleMenuPromptMessage,
  rescheduleNoTimesMessage,
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
export const RESCHEDULE_STATE_SOONEST = "reschedule_soonest"
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
  /** The booking's current start (ISO), so the time it already holds is not offered as a "move". Absent in older saved states. */
  startTime?: string
}

interface RescheduleStateData {
  options?: Array<RescheduleOption & { booking: MovableBooking }>
  booking?: MovableBooking
  /** `hint` ("5 times · from 09:00") is shown under the day in the day list. */
  dateOptions?: Array<{ date: string; label: string; hint?: string }>
  /** The "earliest free times" list that was shown, so a tap on a row maps back to a date + slot. */
  pendingChoices?: Array<{ date: string; dateLabel: string; slot: BookingSlot }>
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
      startTime: row.start_time,
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
    return bookingListReply(options, 0)
  } catch (error) {
    console.error("[reschedule] Error starting reschedule flow", { tenantId, error })
    return { reply: rescheduleErrorMessage(), buttons: [], nextState: null }
  }
}

/**
 * One list with the earliest free times across all days (the time the booking already holds is left out),
 * grouped by day, with "📅 Other day" when more exist than fit. Reminder "Move it" -> this list in one tap.
 */
async function startDateStep(tenantId: string, booking: MovableBooking): Promise<ActionResult> {
  let days: DayAvailability[]
  try {
    days = await loadDayAvailability(await buildDateOptions(tenantId), (date) => freeSlots(tenantId, booking, date))
  } catch (error) {
    console.error("[reschedule] Error loading availability", { tenantId, error })
    return { reply: availabilityErrorMessage(), buttons: [], nextState: null }
  }
  if (days.length === 0) return done(rescheduleNoTimesMessage())

  const totalSlots = days.reduce((sum, d) => sum + d.slots.length, 0)
  const showOtherDay = totalSlots > LIST_ROWS
  const choices = soonestChoices(days, showOtherDay ? LIST_ROWS - 1 : LIST_ROWS)
  const sections = soonestSections(choices, TAP_SLOT)
  if (showOtherDay) sections.push(OTHER_DAY_SECTION)

  return listReply(
    `${rescheduleStartMessage(booking.serviceName, booking.currentLabel)}\n\nEarliest free times 👇`,
    "Choose time",
    sections,
    {
      state: RESCHEDULE_STATE_SOONEST,
      data: {
        booking,
        dateOptions: days.map((d) => ({ date: d.date, label: d.label, hint: dayHint(d) })),
        pendingChoices: choices,
      } as ConversationState["data"],
    },
  )
}

// ============================================================================
// STEP: which booking (only when there is more than one)
// ============================================================================

async function handleChoose(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const options = getData(state).options ?? []

  // "More ▸" row when the customer has more bookings than fit one list.
  const page = tappedNumber(message, TAP_MORE)
  if (page !== null) return bookingListReply(options, page)

  const index = tappedNumber(message, TAP_BOOKING) ?? Number(rawReplyText(message)) - 1
  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    return {
      reply: message.interactiveId ? pickFromListMessage() : rescheduleInvalidChoiceMessage(options.length),
      buttons: [],
      nextState: state,
    }
  }

  try {
    return await startDateStep(tenantId, options[index].booking)
  } catch (error) {
    console.error("[reschedule] Error preparing dates", { tenantId, error })
    return { reply: rescheduleErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STEP: earliest times -> confirmation
// ============================================================================

async function handleSoonest(_tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getData(state)
  const booking = data.booking
  if (!booking) return done(rescheduleAlreadyGoneMessage())

  // "📅 Other day": the days that actually have free times.
  if (message.interactiveId === TAP_OTHER_DAY) return dayListReply(data, 0)

  const index = tappedNumber(message, TAP_SLOT) ?? Number(rawReplyText(message)) - 1
  const choice = Number.isInteger(index) ? data.pendingChoices?.[index] : undefined
  if (!choice) return { reply: pickFromListMessage(), buttons: [], nextState: state }

  return confirmStep(data, booking, choice.date, choice.dateLabel, choice.slot)
}

// ============================================================================
// STEP: "Other day" -> day -> free times
// ============================================================================

async function handleDate(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getData(state)
  const booking = data.booking
  const dateOptions = data.dateOptions ?? []
  if (!booking) return done(rescheduleAlreadyGoneMessage())

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

  let slots: BookingSlot[]
  try {
    slots = await freeSlots(tenantId, booking, chosen.date)
  } catch (error) {
    console.error("[reschedule] Error loading slots", { tenantId, date: chosen.date, error })
    return { reply: availabilityErrorMessage(), buttons: [], nextState: null }
  }

  // Normally impossible (the day list only shows days with free times), but a slot can be taken in between.
  if (slots.length === 0) return dayListReply(data, 0, noSlotsOnDayMessage(chosen.label))

  return timeListReply({ ...data, selectedDate: chosen.date, pendingSlots: slots }, booking, chosen.label, slots, 0)
}

// ============================================================================
// STEP: time -> confirmation
// ============================================================================

async function handleTime(_tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getData(state)
  const booking = data.booking
  const slots = data.pendingSlots ?? []
  if (!booking || !data.selectedDate) return done(rescheduleAlreadyGoneMessage())

  if (message.interactiveId === TAP_OTHER_DAY) return dayListReply(data, 0)

  const dateLabel = data.dateOptions?.find((d) => d.date === data.selectedDate)?.label ?? data.selectedDate
  const page = tappedNumber(message, TAP_MORE)
  if (page !== null) return timeListReply(data, booking, dateLabel, slots, page)

  const index = tappedNumber(message, TAP_TIME) ?? Number(rawReplyText(message)) - 1
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return {
      reply: message.interactiveId ? pickFromListMessage() : invalidSelectionMessage(slots.length),
      buttons: [],
      nextState: state,
    }
  }

  return confirmStep(data, booking, data.selectedDate, dateLabel, slots[index])
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

  // "🕒 Other time": back to the earliest free times for this booking. Nothing has changed yet.
  if (booking && /\bother time\b|\bchange time\b|\bdifferent time\b/.test(text)) {
    return await startDateStep(tenantId, booking)
  }

  if (!booking || !selectedDate || !selectedSlot) return done(rescheduleAlreadyGoneMessage())

  if (answer === null) {
    return { reply: rescheduleConfirmReminderMessage(), buttons: RESCHEDULE_CONFIRM_BUTTONS, nextState: state }
  }
  if (answer === "no") return done(rescheduleKeptMessage())

  try {
    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return done(rescheduleAlreadyGoneMessage())

    const result = await rescheduleBooking(tenantId, customer.id, booking.id, selectedDate, selectedSlot)

    switch (result.outcome) {
      case "rescheduled": {
        const newDateLabel = data.dateOptions?.find((d) => d.date === selectedDate)?.label ?? selectedDate
        const serviceName = result.serviceName ?? booking.serviceName
        const bookingReference = result.bookingReference ?? booking.reference
        // The booking keeps its length, so the new end is the new start plus that length.
        const calendarUrl = await buildBookingCalendarUrl(tenantId, {
          serviceNames: [serviceName],
          startISO: selectedSlot.start,
          endISO: new Date(Date.parse(selectedSlot.start) + booking.durationMinutes * 60_000).toISOString(),
          reference: bookingReference,
        })
        return {
          reply:
            rescheduleDoneMessage({
              serviceName,
              newDateLabel,
              slotLabel: selectedSlot.label,
              bookingReference,
            }) + (calendarUrl ? addToCalendarNote(calendarUrl, true) : ""),
          buttons: CANCEL_OR_RESCHEDULE_BUTTONS,
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
    case RESCHEDULE_STATE_SOONEST:
      return handleSoonest(tenantId, state, message)
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

// ============================================================================
// TAP-ONLY LISTS
// ============================================================================
// Row ids come back as message.interactiveId. The "rs_" prefix is what action-router.ts uses to keep these taps
// out of its reset-word check. Typed numbers still work (old chats). Generic helpers: shared/tap-lists.ts.

const TAP_BOOKING = "rs_book:"
const TAP_SLOT = "rs_slot:"
const TAP_DAY = "rs_day:"
const TAP_TIME = "rs_time:"
const TAP_MORE = "rs_more:"
const TAP_OTHER_DAY = "rs_other_day"

const OTHER_DAY_SECTION: ChoiceSection = { title: "More", rows: [{ id: TAP_OTHER_DAY, title: "📅 Other day" }] }

/** Which booking? One row each: the service, then when it is and its reference. */
function bookingListReply(options: Array<RescheduleOption & { booking: MovableBooking }>, page: number): ActionResult {
  const rows = pageRows(
    options,
    page,
    0,
    (o, i) => ({
      id: `${TAP_BOOKING}${i}`,
      title: o.booking.serviceName,
      description: `${o.booking.currentLabel} · Ref ${o.booking.reference}`,
    }),
    TAP_MORE,
  )
  return listReply(rescheduleChooseBody(), "Choose booking", [{ title: "Your bookings", rows }], {
    state: RESCHEDULE_STATE_CHOOSE,
    data: { options } as ConversationState["data"],
  })
}

/**
 * Free times on one day for THIS booking: its own length, ignoring the booking itself (so a small move on the same
 * day isn't blocked by the time it already holds), and without the exact time it already has (that is not a move).
 */
async function freeSlots(tenantId: string, booking: MovableBooking, date: string): Promise<BookingSlot[]> {
  const slots = await getAvailableSlots(tenantId, date, booking.durationMinutes, booking.id)
  const current = booking.startTime ? Date.parse(booking.startTime) : null
  return current === null ? slots : slots.filter((s) => Date.parse(s.start) !== current)
}

/** "Other day": the days in state (already only days with free times), each with how many times and the first one. */
function dayListReply(data: RescheduleStateData, page: number, intro = ""): ActionResult {
  const rows = pageRows(
    data.dateOptions ?? [],
    page,
    0,
    (d, i) => ({ id: `${TAP_DAY}${i}`, title: d.label, ...(d.hint ? { description: d.hint } : {}) }),
    TAP_MORE,
  )
  return listReply(`${intro ? `${intro}\n\n` : ""}Which day works for you? 📅`, "Choose day", [{ title: "Days", rows }], {
    state: RESCHEDULE_STATE_DATE,
    data: merge(data, {}),
  })
}

/** The times on one day. `data` must already carry selectedDate and pendingSlots (saved as the next state). */
function timeListReply(
  data: RescheduleStateData,
  booking: MovableBooking,
  dateLabel: string,
  slots: BookingSlot[],
  page: number,
): ActionResult {
  const rows = pageRows(slots, page, 1, (s, i) => ({ id: `${TAP_TIME}${i}`, title: s.label }), TAP_MORE)
  return listReply(`Available times for *${booking.serviceName}* on ${dateLabel}:`, "Choose time", [{ title: dateLabel, rows }, OTHER_DAY_SECTION], {
    state: RESCHEDULE_STATE_TIME,
    data: merge(data, {}),
  })
}

/** The "Move your booking?" screen. Yes / Other time / No. */
function confirmStep(
  data: RescheduleStateData,
  booking: MovableBooking,
  dateISO: string,
  dateLabel: string,
  slot: BookingSlot,
): ActionResult {
  return {
    reply: rescheduleConfirmMessage({
      serviceName: booking.serviceName,
      currentLabel: booking.currentLabel,
      newDateLabel: dateLabel,
      slotLabel: slot.label,
    }),
    buttons: RESCHEDULE_CONFIRM_BUTTONS,
    nextState: { state: RESCHEDULE_STATE_CONFIRM, data: merge(data, { selectedDate: dateISO, selectedSlot: slot }) },
  }
}

export const rescheduleService = {
  handleReschedule,
  handleRescheduleForBooking,
  handleState,
}
