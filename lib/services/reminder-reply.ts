// lib/services/reminder-reply.ts
/**
 * The two buttons on a booking reminder (sent by the booking-reminder edge
 * function):
 *
 *   "rem_confirm:<booking_id>"  -> "Confirm"        stamps bookings.customer_confirmed_at
 *   "rem_cancel:<booking_id>"   -> "Can't make it"  cancels through cancel.ts's cancelBooking()
 *
 * Reached from action-router.ts's routeAction() BEFORE menu rows and state, so a tap
 * works whether or not the customer has a conversation open.
 *
 * SAFETY: the booking id comes from the button, which a customer could in theory forge, so
 * every query is scoped by tenant_id AND the customer found from the sender's own phone
 * number. Someone else's booking id just reads as "already gone".
 *
 * "Can't make it" deliberately goes through cancelBooking() so the same rules apply as the
 * Cancel Now flow: the cancellation window, a called queue entry needing a human, and the
 * promoted queue entry being cancelled too. If the booking is inside the window the customer
 * is told politely, exactly like Cancel Now.
 *
 * Customer-facing copy that already exists is reused from lib/services/messages/cancel.ts.
 * The confirmation line below is inlined, same as the TODOs in booking.ts / queue.ts.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import { getCustomer } from "@/lib/services/tenant-customer"
import { cancelBooking } from "@/lib/services/cancel"
import {
  cancelAlreadyCalledMessage,
  cancelAlreadyGoneMessage,
  cancelErrorMessage,
  cancelTooLateMessage,
  cancelledBookingMessage,
} from "@/lib/services/messages/cancel"

/** Matches the button ids the edge function sends. Group 1 = action, group 2 = booking id. */
export const REMINDER_TAP_PATTERN = /^rem_(confirm|cancel):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function reply(text: string): ActionResult {
  return { reply: text, buttons: [], nextState: null }
}

export async function handleReminderTap(tenantId: string, message: IncomingMessage): Promise<ActionResult> {
  const match = REMINDER_TAP_PATTERN.exec(message.interactiveId ?? "")
  if (!match) return reply(cancelAlreadyGoneMessage())
  const action = match[1].toLowerCase() as "confirm" | "cancel"
  const bookingId = match[2].toLowerCase()

  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) throw new Error("Supabase server client is unavailable")

    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return reply(cancelAlreadyGoneMessage())

    // Must be THIS customer's booking, still confirmed.
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("id, booking_reference")
      .eq("id", bookingId)
      .eq("tenant_id", tenantId)
      .eq("customer_id", customer.id)
      .eq("status", "confirmed")
      .maybeSingle()

    if (error) throw new Error(`Failed to load booking: ${error.message}`)
    if (!booking) return reply(cancelAlreadyGoneMessage())

    if (action === "confirm") {
      const { error: updateError } = await supabase
        .from("bookings")
        .update({ customer_confirmed_at: new Date().toISOString() })
        .eq("id", bookingId)
        .eq("tenant_id", tenantId)
        .eq("customer_id", customer.id)
        .eq("status", "confirmed")
      if (updateError) throw new Error(`Failed to confirm booking: ${updateError.message}`)
      // TODO: move into lib/services/messages/ as a proper message, like the other inlined replies.
      return reply("Thanks, you're confirmed ✅ See you soon!")
    }

    const { outcome, windowMinutes } = await cancelBooking(tenantId, customer.id, bookingId)
    switch (outcome) {
      case "cancelled":
        return reply(cancelledBookingMessage(`📅 Booking ${booking.booking_reference}`))
      case "too_late":
        return reply(cancelTooLateMessage(windowMinutes))
      case "called":
        return reply(cancelAlreadyCalledMessage())
      default:
        return reply(cancelAlreadyGoneMessage())
    }
  } catch (error) {
    console.error("[reminder-reply] Error handling reminder tap", { tenantId, action, bookingId, error })
    return reply(cancelErrorMessage())
  }
}
