// lib/services/messages/booking.ts
/**
 * Customer-facing copy for the appointment booking flow.
 * ---------------------------------------------------------
 * Split out of booking.ts so copy can be edited without touching booking
 * logic. booking.ts imports everything it needs from here; nothing in
 * this file talks to Supabase or holds any state.
 *
 * ADDED: bookingWindowClosedMessage(), for booking.ts's new
 * BOOKING_OUTSIDE_ALLOWED_WINDOW case — thrown when a slot that was
 * valid when offered no longer satisfies booking_settings/business_hours
 * by the time the customer confirms (e.g. min_notice_minutes has since
 * caught up to it). Deliberately distinct copy from slotStaleMessage()
 * (which means "someone else took it") since the cause and the
 * customer-facing framing are different.
 *
 * ADDED: planLimitReachedMessage(), for booking.ts's
 * PLAN_VISIT_LIMIT_REACHED case (thrown by assertWithinVisitLimit() in
 * lib/services/plans.ts) — the tenant's own Free-plan visit cap, not
 * anything about this specific slot or customer, so it gets its own
 * distinct copy rather than reusing bookingErrorMessage()'s generic
 * "something went wrong" framing. Only ever reachable on Free: Growth
 * and Business bill overage instead of blocking, so a customer never
 * sees this message for a tenant on a paid plan.
 *
 * ADDED: bookingAlreadyHasUpcomingMessage(), for booking.ts's
 * BOOKING_ALREADY_HAS_UPCOMING case — the database trigger allows one
 * upcoming booking per customer, so a second attempt is refused. An
 * expected business rule, not an error, hence its own copy rather than
 * bookingErrorMessage()'s generic "something went wrong".
 */

import type { CatalogService } from "@/lib/services/shared/services-catalog"
import type { BookingSlot } from "@/lib/services/booking"

// ============================================================================
// BUTTONS
// ============================================================================

export const CANCEL_BUTTON = ["📅 Book again"]

/**
 * Shown with bookingAlreadyHasUpcomingMessage(). "Book again" would be a dead
 * end there (the one-upcoming-booking rule would refuse it), so the only
 * useful next step is cancelling the existing booking. The title matches the
 * "❌ Cancel Now" menu row; intent-router.ts's cancel fast path normalises a
 * tap on it ("[button reply] ❌ Cancel Now" -> "cancel now") to the cancel
 * intent, which action-router.ts hands to cancelService.handleCancel.
 * (Button titles are limited to 20 characters by WhatsApp.)
 */
export const CANCEL_NOW_BUTTON = ["❌ Cancel Now"]

/**
 * Shown with the "Just to confirm" summary (and its yes/no reminder). A tap
 * arrives as the button's title, which handleConfirm reads as yes / no
 * (emoji and the "[button reply]" tag are ignored). Titles are limited to 20
 * characters by WhatsApp.
 */
export const CONFIRM_BUTTONS = ["✅ Yes", "❌ No"]

/**
 * The booking confirm screen only (reschedule has its own set). "Other time" sends the customer back to
 * the free-times list for the same service instead of cancelling the whole booking. handleConfirm() reads
 * the words "other time"; never put "cancel" in a button title (action-router.ts resets the chat on it).
 */
export const BOOKING_CONFIRM_BUTTONS = ["✅ Yes", "🕒 Other time", "❌ No"]

export const ENTRY_CHOICE_BOOK_BUTTON = "📅 Book a time"
export const ENTRY_CHOICE_QUEUE_BUTTON = "🚶 Join the queue"
export const ENTRY_CHOICE_BUTTONS = [ENTRY_CHOICE_BOOK_BUTTON, ENTRY_CHOICE_QUEUE_BUTTON]

// ============================================================================
// ENTRY CHOICE ("book a time" vs "join the queue")
// ============================================================================

export function entryChoicePromptMessage(): string {
  return "Would you like to book a specific time, or join today's walk-in queue? 💈"
}

export function entryChoiceInvalidMessage(): string {
  return "Sorry, I didn't catch that — reply *book* for a specific time, or *queue* to join today's walk-in queue."
}

// ============================================================================
// SERVICE / DATE / TIME SELECTION
// ============================================================================

/** `maxServices` > 1 = the shop lets a customer pick several in one booking
 *  (booking_settings.max_services_per_booking). Default 1 = unchanged copy. */
export function servicesListMessage(services: CatalogService[], maxServices: number = 1): string {
  const lines = services.map(
    (s, i) => `${i + 1}. *${s.name}* — R${s.price} (${s.durationMinutes} min)`,
  )
  const ask =
    maxServices > 1
      ? `Reply with a number to pick a service, or up to ${maxServices} numbers together (e.g. *1,3*) to combine them.`
      : "Reply with a number to pick a service."
  return `Here's what we offer 💈\n\n${lines.join("\n")}\n\n${ask}`
}

export function dateOptionsMessage(dateOptions: Array<{ label: string }>): string {
  const lines = dateOptions.map((d, i) => `${i + 1}. ${d.label}`)
  return `Which day works for you? 📅\n\n${lines.join("\n")}\n\nReply with a number.`
}

/** How many times are shown per screen in the booking flow. */
export const SLOTS_PAGE_SIZE = 12

/** Number of the last page (0-based) for a list of slots. */
export function lastSlotsPage(total: number): number {
  return Math.max(0, Math.ceil(total / SLOTS_PAGE_SIZE) - 1)
}

function slotHour(label: string): number {
  const hour = Number(label.slice(0, 2))
  return Number.isFinite(hour) ? hour : 0
}

/**
 * Times grouped under Morning / Afternoon / Evening. Numbers always count from the
 * start of the FULL list, so "reply with a number" maps to the same slot on every page.
 *   page = "all"  -> every slot (used by the reschedule flow, which has no paging)
 *   page = 0,1,.. -> SLOTS_PAGE_SIZE slots at a time, with a "more" hint when there are further ones
 */
export function slotsListMessage(
  serviceName: string,
  dateLabel: string,
  slots: BookingSlot[],
  page: number | "all" = "all",
): string {
  const start = page === "all" ? 0 : page * SLOTS_PAGE_SIZE
  const end = page === "all" ? slots.length : start + SLOTS_PAGE_SIZE
  const visible = slots.slice(start, end)

  const groups: Array<{ title: string; lines: string[] }> = [
    { title: "🌅 Morning", lines: [] },
    { title: "☀️ Afternoon", lines: [] },
    { title: "🌙 Evening", lines: [] },
  ]
  visible.forEach((s, i) => {
    const hour = slotHour(s.label)
    const group = hour < 12 ? groups[0] : hour < 17 ? groups[1] : groups[2]
    group.lines.push(`${start + i + 1}. ${s.label}`)
  })

  const body = groups
    .filter((g) => g.lines.length > 0)
    .map((g) => `*${g.title}*\n${g.lines.join("\n")}`)
    .join("\n\n")

  const hasMore = page !== "all" && end < slots.length
  const ask = hasMore ? "Reply with a number, or *more* for later times." : "Reply with a number."
  return `Available times for *${serviceName}* on ${dateLabel}:\n\n${body}\n\n${ask}`
}

/** "13:30" + 90 minutes -> "15:00". Works on the shop-local label, so no timezone maths is needed. */
function addMinutesToLabel(label: string, minutes: number): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(label.trim())
  if (!match) return null
  const total = (Number(match[1]) * 60 + Number(match[2]) + Math.round(minutes)) % (24 * 60)
  const h = String(Math.floor(total / 60)).padStart(2, "0")
  const m = String(total % 60).padStart(2, "0")
  return `${h}:${m}`
}

export function confirmationMessage(service: CatalogService, dateLabel: string, slot: BookingSlot): string {
  const end = addMinutesToLabel(slot.label, service.durationMinutes)
  return (
    `Just to confirm ✅\n\n` +
    `*Service:* ${service.name}\n` +
    `*Price:* R${service.price}\n` +
    `*When:* ${dateLabel}, ${end ? `${slot.label} to ${end}` : `at ${slot.label}`}\n` +
    `*Duration:* ${service.durationMinutes} min\n\n` +
    `Tap *Yes* to confirm, or *Other time* to pick a different one.`
  )
}

export function invalidSelectionMessage(max: number): string {
  return `Please reply with a number between 1 and ${max}.`
}

/** A list tap was expected (the list is still in the chat above). */
export function pickFromListMessage(): string {
  return "Please pick one from the list above (tap the button under it), or reply *menu* to start over."
}

/** Nothing is free on any of the days we offer. */
export function noTimesAvailableMessage(): string {
  return "Sorry, there's nothing free in the days we're taking bookings for right now. Please try again later, or contact the shop directly."
}

/** A day the customer chose (or typed, e.g. "tomorrow 3pm") has nothing free. Shown above the list that follows. */
export function noSlotsOnDayMessage(dateLabel: string, staffName?: string): string {
  return staffName
    ? `${staffName} has nothing free on ${dateLabel}, sorry. Here's what is:`
    : `Nothing is free on ${dateLabel}, sorry. Here's what is:`
}

export function startOverMessage(): string {
  return "Let's start over — reply *menu*."
}

// ============================================================================
// ERRORS / EDGE CASES
// ============================================================================

export function noServicesMessage(): string {
  return "We don't have any bookable services set up right now — please check back shortly, or reply *support* for help."
}

export function servicesLoadErrorMessage(): string {
  return "Sorry, something went wrong loading our services. Please try again shortly."
}

export function noSlotsMessage(): string {
  return "No open slots on that day, sorry! Reply with another day, or type *menu* to start over."
}

export function availabilityErrorMessage(): string {
  return "Sorry, something went wrong checking availability. Please try again."
}

export function slotStaleMessage(): string {
  return "Sorry, that slot was just taken. Let's find you another one — reply *menu* to start over."
}

export function bookingWindowClosedMessage(): string {
  return "Sorry, that time's no longer bookable — please reply *menu* and pick a new time."
}

export function planLimitReachedMessage(): string {
  return "Sorry, this shop has reached its booking limit for this month. Please try again next month, or contact them directly."
}

export function bookingAlreadyHasUpcomingMessage(): string {
  return "You already have an upcoming booking with us. To make a new one, please cancel the existing booking first, or choose *Check Status* to see it."
}

export function bookingCancelledMessage(): string {
  return "No problem, your booking wasn't made. Reply *menu* any time to book again."
}

export function missingBookingDataMessage(): string {
  return "Something's missing — let's start over. Reply *menu*."
}

export function confirmYesNoReminderMessage(): string {
  return "Please tap *Yes* to confirm, *Other time* to change it, or *No* to cancel."
}

export function bookingErrorMessage(): string {
  return "Sorry, something went wrong confirming your booking. Please try again."
}

// ============================================================================
// CONFIRM SUCCESS / NAME COLLECTION
// ============================================================================

export function bookingConfirmedMessage(params: {
  customerName: string | null | undefined
  serviceName: string
  slotLabel: string
  bookingReference: string
  /** Running per-shop ticket number, e.g. "B0012". Omitted lines up with older callers. */
  ticketLabel?: string | null
}): string {
  const { customerName, serviceName, slotLabel, bookingReference, ticketLabel } = params
  const greetingName = customerName ? `, ${customerName}` : ""
  return (
    `You're booked${greetingName}! 🎉\n\n` +
    `*${serviceName}* on ${slotLabel}\n` +
    (ticketLabel ? `Ticket: *${ticketLabel}*\n` : "") +
    `Reference: *${bookingReference}*\n\n` +
    (customerName
      ? "See you then!"
      : "One more thing — what name should we book this under? (Reply with your name and we'll save it for next time.)")
  )
}

export function nameCollectionRetryMessage(): string {
  return "Sorry, didn't catch that — what name should we save this booking under?"
}

export function nameCollectionThanksMessage(name: string): string {
  return `Thanks, ${name}! See you then 👋`
}
