// lib/services/waitlist-reply.ts
/**
 * The "See times" button on a waitlist alert (sent by the waitlist-notify
 * edge function):
 *
 *   "wl_book:<waitlist_id>"  -> "See times"  shows the free times for the day the customer
 *                                            was waiting for and drops them into the normal
 *                                            booking flow at the time-picking step.
 *
 * Reached from action-router.ts's routeAction() BEFORE menu rows and state, exactly like
 * reminder-reply.ts, so a tap works whether or not the customer has a conversation open.
 *
 * AN OFFER IS ONLY GOOD WHILE THE ENTRY IS 'notified'. public.process_waitlist() puts an
 * entry back to 'waiting' once its 10-minute hold has run out (and the next person is
 * alerted), and marks it 'expired' when its day has passed. So any other status, or a day
 * in the past, means "sorry, that offer has expired" — no timer logic is needed here.
 *
 * AFTER THIS: the customer picks a time and confirms through booking.ts as normal
 * (state "booking_time_selection" -> "booking_confirm" -> createBooking()). When that booking
 * is inserted, the database trigger trg_booking_resolves_waitlist marks this waitlist entry
 * 'booked' by itself, so nothing here (or in booking.ts) has to.
 *
 * SAFETY: the waitlist id comes from the button, which a customer could in theory forge, so
 * the lookup is scoped by tenant_id AND the customer found from the sender's own phone number.
 * Someone else's id just reads as an expired offer.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import { getCustomer } from "@/lib/services/tenant-customer"
import { buildDateOptions, getAvailableSlots, presentServices } from "@/lib/services/booking"
import { getBookableServices } from "@/lib/services/shared/services-catalog"
import { combineServices } from "@/lib/services/shared/multi-select"
import { getTenantTimezone, todayInTimezone } from "@/lib/services/shared/tenant-scheduling"
import { bookingErrorMessage, noSlotsMessage, slotsListMessage } from "@/lib/services/messages/booking"

/** Matches the button id the edge function sends. Group 1 = waitlist id. */
export const WAITLIST_TAP_PATTERN = /^wl_book:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

// Must match BOOKING_STATE_TIME_SELECTION in booking.ts (not exported there).
const BOOKING_STATE_TIME_SELECTION = "booking_time_selection"

function reply(text: string): ActionResult {
  return { reply: text, buttons: [], nextState: null }
}

// TODO: move into lib/services/messages/ as a proper message, like the other inlined replies.
function offerExpiredMessage(stillWaiting: boolean): string {
  return stillWaiting
    ? "Sorry, that offer has expired. 😕 You're still on the waitlist, so we'll message you if another time opens up."
    : "Sorry, that offer has expired."
}

/** "Today" / "Tomorrow" / "Sat, 17 Oct" for a tenant-local calendar date. */
function dateLabelFor(dateISO: string, today: string): string {
  if (dateISO === today) return "Today"
  const tomorrow = new Date(`${today}T12:00:00.000Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  if (dateISO === tomorrow.toISOString().slice(0, 10)) return "Tomorrow"
  return new Date(`${dateISO}T12:00:00.000Z`).toLocaleDateString("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
}

export async function handleWaitlistTap(tenantId: string, message: IncomingMessage): Promise<ActionResult> {
  const match = WAITLIST_TAP_PATTERN.exec(message.interactiveId ?? "")
  if (!match) return reply(offerExpiredMessage(false))
  const waitlistId = match[1].toLowerCase()

  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) throw new Error("Supabase server client is unavailable")

    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return reply(offerExpiredMessage(false))

    // Must be THIS customer's entry.
    const { data: entry, error } = await supabase
      .from("booking_waitlist")
      .select("id, service_id, extra_service_ids, wait_date, status")
      .eq("id", waitlistId)
      .eq("tenant_id", tenantId)
      .eq("customer_id", customer.id)
      .maybeSingle()

    if (error) throw new Error(`Failed to load waitlist entry: ${error.message}`)
    if (!entry) return reply(offerExpiredMessage(false))

    // The offer is only live while the entry is 'notified' (see header).
    if (entry.status !== "notified") return reply(offerExpiredMessage(entry.status === "waiting"))

    const timezone = await getTenantTimezone(supabase, tenantId)
    const today = todayInTimezone(timezone)
    if (entry.wait_date < today) return reply(offerExpiredMessage(false))

    // The service(s) they were waiting for, from the shop's current bookable list.
    const services = await getBookableServices(tenantId)
    const selectedService = services.find((s) => s.id === entry.service_id)
    if (!selectedService) {
      // That service is no longer bookable: let them start a normal booking instead.
      return presentServices(tenantId)
    }
    const extraIds = new Set<string>((entry.extra_service_ids ?? []) as string[])
    const extraServices = services.filter((s) => extraIds.has(s.id) && s.id !== selectedService.id)

    // One entry standing for the whole visit: names joined, minutes summed.
    const visit = combineServices([selectedService, ...extraServices])

    const slots = await getAvailableSlots(tenantId, entry.wait_date, visit.durationMinutes)
    if (slots.length === 0) return reply(noSlotsMessage())

    const dateOptions = await buildDateOptions(tenantId)
    const dateLabel = dateOptions.find((d) => d.date === entry.wait_date)?.label ?? dateLabelFor(entry.wait_date, today)

    return {
      reply: slotsListMessage(visit.name, dateLabel, slots),
      buttons: [],
      nextState: {
        state: BOOKING_STATE_TIME_SELECTION,
        data: {
          services,
          selectedService,
          extraServices,
          // handleTimeSelection() reads the date's label back out of dateOptions.
          dateOptions: dateOptions.some((d) => d.date === entry.wait_date)
            ? dateOptions
            : [...dateOptions, { date: entry.wait_date, label: dateLabel }],
          selectedDate: entry.wait_date,
          pendingSlots: slots,
        },
      },
    }
  } catch (error) {
    console.error("[waitlist-reply] Error handling waitlist tap", { tenantId, waitlistId, error })
    return reply(bookingErrorMessage())
  }
}
