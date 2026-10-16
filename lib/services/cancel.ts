// lib/services/cancel.ts
/**
 * Cancel Now — tenant-scoped, small two-step state machine.
 * ------------------------------------------------------------------------
 * Reached by tapping the "Cancel Now" menu row (routed by row id in
 * action-router.ts) or by typing a cancel request ("cancel my booking",
 * "leave the queue") which intent-router.ts classifies as the "cancel" intent.
 *
 * FLOW
 *   1. Load what this customer can cancel (shared/customer-activity.ts):
 *        - upcoming CONFIRMED bookings
 *        - queue entries that are still WAITING
 *      Nothing -> say so + show the menu. Exactly one -> go straight to the
 *      yes/no question. More than one -> ask which (reply with a number).
 *   2. Yes/no confirmation (state `cancel_confirm`, buttons Yes / No).
 *   3. Cancel:
 *        - booking:     bookings.status = 'cancelled'. Respects
 *                       booking_settings.cancellation_window_minutes: if the
 *                       booking starts sooner than that, it is NOT cancelled
 *                       and the customer is told politely. If the booking was
 *                       promoted into the queue, its waiting queue entry is
 *                       cancelled too.
 *        - queue entry: queue_entries.status = 'cancelled' — this takes them
 *                       out of the live queue (getQueueSimulation only counts
 *                       'waiting'/'called'), and the existing DB trigger then
 *                       sends position updates to the people behind them. A
 *                       cancelled entry is never billed (billable_visits is
 *                       only written for status 'done').
 *
 * SAFETY: the target is re-loaded from the database at the moment of
 * cancelling (never trusted from conversation state), and every UPDATE is
 * scoped by tenant_id + customer_id + the expected current status, so a stale
 * conversation or a double tap can never cancel the wrong or an already
 * finished record.
 *
 * Nothing here changes the database schema. Customer-facing copy lives in
 * lib/services/messages/cancel.ts.
 *
 * States owned by this service all start with "cancel_" — action-router.ts
 * relies on that prefix (typed "cancel"/"Yes, cancel it" inside this flow
 * must reach THIS service, not reset to the menu).
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { getCustomer } from "@/lib/services/tenant-customer"
import { formatQueueTicketNumber } from "@/lib/services/queue"
import {
  loadCustomerActivity,
  formatLocalDateTime,
  type CustomerActivity,
} from "@/lib/services/shared/customer-activity"
import { getBookingSettings } from "@/lib/services/shared/tenant-scheduling"
import { buildServicesListMessage, MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"

import {
  CANCEL_CONFIRM_BUTTONS,
  cancelAlreadyCalledMessage,
  cancelAlreadyGoneMessage,
  cancelChooseMessage,
  cancelConfirmMessage,
  cancelConfirmReminderMessage,
  cancelErrorMessage,
  cancelInvalidChoiceMessage,
  cancelKeptMessage,
  cancelMenuPromptMessage,
  cancelNothingMessage,
  cancelTooLateMessage,
  cancelledBookingMessage,
  cancelledQueueMessage,
} from "@/lib/services/messages/cancel"

// ============================================================================
// CONSTANTS
// ============================================================================

export const CANCEL_STATE_CHOOSE = "cancel_choose"
export const CANCEL_STATE_CONFIRM = "cancel_confirm"

type CancelKind = "booking" | "queue"

/** What a customer can pick. Kept small: it lives in conversation state. */
interface CancelOption {
  kind: CancelKind
  id: string
  /** Ready-to-show description, e.g. "📅 Haircut — Tue 14 Oct, 10:30 (Ref ABC123)". */
  label: string
}

interface CancelStateData {
  options?: CancelOption[]
  option?: CancelOption
}

function getCancelData(state: ConversationState): CancelStateData {
  return (state.data ?? {}) as CancelStateData
}

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

function normalizedReplyText(message: IncomingMessage): string {
  return (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
}

/**
 * The menu shown at the end of the cancel flow: Book Now, Join Queue and My
 * Profile. Cancel Now and Check Status are left off — the customer has just
 * dealt with exactly that. Filtered from the shared menu by row id, so titles
 * and ids stay defined in one place.
 */
function menuFollowUp() {
  const menu = buildServicesListMessage(cancelMenuPromptMessage())
  const keep: string[] = [MENU_ROW_IDS.book, MENU_ROW_IDS.queue, MENU_ROW_IDS.profile]
  if (!menu.list) return [menu]
  return [
    {
      ...menu,
      list: {
        ...menu.list,
        sections: menu.list.sections.map((section) => ({
          ...section,
          rows: section.rows.filter((row) => keep.includes(row.id)),
        })),
      },
    },
  ]
}

function done(reply: string): ActionResult {
  return { reply, buttons: [], nextState: null, followUp: menuFollowUp() }
}

// ============================================================================
// POLICY — pure helpers (exported so they can be tested without a database)
// ============================================================================

/**
 * True when a booking starting at `startIso` can still be cancelled: it must
 * start at least `windowMinutes` from `nowMillis`. A booking that has already
 * started can never be cancelled here (even with a window of 0).
 */
export function isWithinCancellationWindow(startIso: string, windowMinutes: number, nowMillis: number): boolean {
  const startMillis = new Date(startIso).getTime()
  if (startMillis <= nowMillis) return false
  return startMillis - nowMillis >= Math.max(0, windowMinutes) * 60_000
}

/** Yes/no parsing for the confirm step. Handles button titles too. */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "")
  if (!t) return null
  if (t === "y" || t === "yes" || t.startsWith("yes ") || t.startsWith("yes,") || ["yeah", "yep", "yup", "confirm", "ok", "okay", "sure", "ewe", "yebo", "ja", "ja asseblief"].includes(t)) {
    return "yes"
  }
  if (t === "n" || t === "no" || t.startsWith("no ") || t.startsWith("no,") || ["nope", "nah", "hayi", "cha", "nee"].includes(t) || t.includes("keep")) {
    return "no"
  }
  return null
}

// ============================================================================
// BUILD THE LIST OF THINGS THAT CAN BE CANCELLED
// ============================================================================

function buildOptions(activity: CustomerActivity): { options: CancelOption[]; hasCalled: boolean } {
  const options: CancelOption[] = []
  let hasCalled = false

  for (const booking of activity.bookings) {
    if (booking.queueEntry?.status === "called") {
      hasCalled = true
      continue
    }
    options.push({
      kind: "booking",
      id: booking.id,
      label: `📅 ${booking.serviceName ?? "Appointment"} — ${formatLocalDateTime(booking.startTime, activity.timezone)} (Ref ${booking.reference})`,
    })
  }

  for (const entry of activity.walkIns) {
    if (entry.status === "called") {
      hasCalled = true
      continue
    }
    const ticket =
      entry.ticketNumber !== null ? ` ${formatQueueTicketNumber(entry.ticketNumber, activity.ticketPrefix)}` : ""
    options.push({
      kind: "queue",
      id: entry.id,
      label: `🚶 Queue${ticket}${entry.serviceName ? ` — ${entry.serviceName}` : ""}`,
    })
  }

  return { options, hasCalled }
}

// ============================================================================
// ENTRY POINT — menu row tap or typed cancel request
// ============================================================================

async function handleCancel(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  try {
    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return done(cancelNothingMessage())

    const activity = await loadCustomerActivity(tenantId, customer.id)
    const { options, hasCalled } = buildOptions(activity)

    if (options.length === 0) {
      return done(hasCalled ? cancelAlreadyCalledMessage() : cancelNothingMessage())
    }

    if (options.length === 1) {
      return promptConfirm(tenantId, options[0])
    }

    return {
      reply: cancelChooseMessage(options),
      buttons: [],
      nextState: { state: CANCEL_STATE_CHOOSE, data: { options } },
    }
  } catch (error) {
    console.error("[cancel] Error starting cancel flow", { tenantId, error })
    return { reply: cancelErrorMessage(), buttons: [], nextState: null }
  }
}

/**
 * Asks "are you sure?" — but first, for a booking, checks the cancellation
 * window so a customer who is too late is told straight away instead of
 * being asked to confirm something that will be refused.
 */
async function promptConfirm(tenantId: string, option: CancelOption): Promise<ActionResult> {
  if (option.kind === "booking") {
    const supabase = getClientOrThrow()
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("start_time")
      .eq("id", option.id)
      .eq("tenant_id", tenantId)
      .eq("status", "confirmed")
      .maybeSingle()

    if (error) throw new Error(`Failed to load booking: ${error.message}`)
    if (!booking) return done(cancelAlreadyGoneMessage())

    const settings = await getBookingSettings(supabase, tenantId)
    if (!isWithinCancellationWindow(booking.start_time, settings.cancellationWindowMinutes, Date.now())) {
      return done(cancelTooLateMessage(settings.cancellationWindowMinutes))
    }
  }

  return {
    reply: cancelConfirmMessage(option),
    buttons: CANCEL_CONFIRM_BUTTONS,
    nextState: { state: CANCEL_STATE_CONFIRM, data: { option } },
  }
}

// ============================================================================
// STEP: choose which one (only when there is more than one)
// ============================================================================

async function handleChoice(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const options = getCancelData(state).options ?? []
  const index = Number((message.text ?? message.contentSummary ?? "").trim()) - 1

  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    return { reply: cancelInvalidChoiceMessage(options.length), buttons: [], nextState: state }
  }

  try {
    return await promptConfirm(tenantId, options[index])
  } catch (error) {
    console.error("[cancel] Error preparing confirmation", { tenantId, error })
    return { reply: cancelErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STEP: yes / no -> cancel
// ============================================================================

export type CancelOutcome = "cancelled" | "too_late" | "already_gone" | "called"

/** Exported so the reminder's "Can't make it" button (reminder-reply.ts) cancels through
 *  exactly the same rules as the Cancel Now flow: window, called-entry check, queue cleanup. */
export async function cancelBooking(tenantId: string, customerId: string, bookingId: string): Promise<{ outcome: CancelOutcome; windowMinutes: number }> {
  const supabase = getClientOrThrow()

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id, start_time")
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "confirmed")
    .maybeSingle()

  if (error) throw new Error(`Failed to load booking: ${error.message}`)
  if (!booking) return { outcome: "already_gone", windowMinutes: 0 }

  const settings = await getBookingSettings(supabase, tenantId)
  const windowMinutes = settings.cancellationWindowMinutes

  if (!isWithinCancellationWindow(booking.start_time, windowMinutes, Date.now())) {
    return { outcome: "too_late", windowMinutes }
  }

  // If the shop has already called this customer for the booking, a human
  // needs to handle it.
  const { data: calledEntry, error: calledError } = await supabase
    .from("queue_entries")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("booking_id", bookingId)
    .eq("status", "called")
    .limit(1)
  if (calledError) throw new Error(`Failed to check queue entry: ${calledError.message}`)
  if ((calledEntry ?? []).length > 0) return { outcome: "called", windowMinutes }

  const { data: updated, error: updateError } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "confirmed")
    .select("id")

  if (updateError) throw new Error(`Failed to cancel booking: ${updateError.message}`)
  if (!updated || updated.length === 0) return { outcome: "already_gone", windowMinutes }

  // A booking that was promoted into the queue must leave the queue too.
  const { error: queueError } = await supabase
    .from("queue_entries")
    .update({ status: "cancelled" })
    .eq("tenant_id", tenantId)
    .eq("booking_id", bookingId)
    .eq("status", "waiting")
  if (queueError) {
    console.error("[cancel] Booking cancelled but its queue entry could not be cancelled", { tenantId, bookingId, queueError })
  }

  return { outcome: "cancelled", windowMinutes }
}

async function cancelQueueEntry(tenantId: string, customerId: string, entryId: string): Promise<CancelOutcome> {
  const supabase = getClientOrThrow()

  const { data: updated, error } = await supabase
    .from("queue_entries")
    .update({ status: "cancelled" })
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "waiting")
    .select("id")

  if (error) throw new Error(`Failed to cancel queue entry: ${error.message}`)
  if (updated && updated.length > 0) return "cancelled"

  // Nothing updated: either it was already finished/cancelled, or the shop
  // called them in the meantime.
  const { data: current, error: lookupError } = await supabase
    .from("queue_entries")
    .select("status")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .maybeSingle()
  if (lookupError) throw new Error(`Failed to look up queue entry: ${lookupError.message}`)

  return current?.status === "called" ? "called" : "already_gone"
}

async function handleConfirm(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const answer = parseYesNo(normalizedReplyText(message))
  const option = getCancelData(state).option

  if (!option) return done(cancelAlreadyGoneMessage())

  if (answer === null) {
    return {
      reply: cancelConfirmReminderMessage(),
      buttons: CANCEL_CONFIRM_BUTTONS,
      nextState: state,
    }
  }

  if (answer === "no") return done(cancelKeptMessage())

  try {
    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return done(cancelAlreadyGoneMessage())

    if (option.kind === "booking") {
      const { outcome, windowMinutes } = await cancelBooking(tenantId, customer.id, option.id)
      switch (outcome) {
        case "cancelled":
          return done(cancelledBookingMessage(option.label))
        case "too_late":
          return done(cancelTooLateMessage(windowMinutes))
        case "called":
          return done(cancelAlreadyCalledMessage())
        default:
          return done(cancelAlreadyGoneMessage())
      }
    }

    const outcome = await cancelQueueEntry(tenantId, customer.id, option.id)
    switch (outcome) {
      case "cancelled":
        return done(cancelledQueueMessage())
      case "called":
        return done(cancelAlreadyCalledMessage())
      default:
        return done(cancelAlreadyGoneMessage())
    }
  } catch (error) {
    console.error("[cancel] Error cancelling", { tenantId, option, error })
    return { reply: cancelErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STATE DISPATCH
// ============================================================================

async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case CANCEL_STATE_CHOOSE:
      return handleChoice(tenantId, state, message)
    case CANCEL_STATE_CONFIRM:
      return handleConfirm(tenantId, state, message)
    default:
      return null
  }
}

export const cancelService = {
  handleCancel,
  handleState,
}
