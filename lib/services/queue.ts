// lib/services/queue.ts
/**
 * Salon/Barbershop Walk-in Queue Service
 * ---------------------------------------
 * Sibling to booking.ts: lets a WhatsApp customer join today's walk-in
 * queue instead of booking a specific time slot.
 *
 * There is no standalone "queue" intent — booking.ts's entry point offers
 * "book a time" vs "join the queue" up front, and calls
 * queueService.startQueueFlow() when the customer picks the latter (see
 * booking.ts's handleEntryChoice). Everything from that point on
 * ("queue_*" states) is owned entirely by this file, registered as its own
 * StatefulService in action-router.ts's stateHandlers — exactly the same
 * shape every other service already uses, just entered from inside
 * booking.ts instead of from intentHandlers directly.
 *
 * All customer-facing copy lives in lib/services/messages/queue.ts — this
 * file only owns state transitions and data access.
 *
 * ============================================================================
 * ASSUMPTIONS
 * ============================================================================
 * 1. `queue_entries` table: id, customer_id, service_id, status
 *    ('waiting'|'called'|'done'|'cancelled'), joined_at, called_at,
 *    completed_at — see queue_schema.sql.
 * 2. Deliberately blind to the booking calendar: joining the queue does
 *    NOT check staff availability or existing bookings at all. The shop
 *    works walk-ins in between booked slots by eye. This is one level
 *    simpler than booking.ts's own "don't care who" tradeoff — there's no
 *    scheduling logic here whatsoever, just a join-order line.
 * 3. No separate yes/no confirm step before joining (unlike booking.ts's
 *    BOOKING_STATE_CONFIRM) — joining the queue costs the customer
 *    nothing and commits to no specific time, so the extra round trip
 *    isn't worth the friction. Picking a service both selects it and
 *    joins the queue in the same turn.
 * 4. ETA is a naive, optimistic estimate: sum of durationMinutes for
 *    everyone ahead (status IN ('waiting','called') with an earlier
 *    joined_at). It has NO awareness of how many staff are actually free
 *    to work in parallel, so it will run slow whenever more than one
 *    person can be served at once. Good enough to set rough expectations
 *    for a prototype; swap for a staff-aware estimate before production.
 * 5. Calling a customer forward (admin's "Call" action) sends an
 *    automatic WhatsApp notification — see app/admin/actions.ts's
 *    callQueueEntry, which is the only place that happens (this file
 *    never sends messages itself, matching the pattern that booking.ts's
 *    bot-side code never calls send-message.ts directly either — replies
 *    always flow back through the webhook route via ActionResult).
 * ============================================================================
 */

import { getSupabaseServerClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer } from "@/lib/services/customer"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"

import {
  servicesListMessage,
  noServicesMessage,
  invalidSelectionMessage,
  joinedQueueMessage,
  queueErrorMessage,
} from "@/lib/services/messages/queue"

// ============================================================================
// CONSTANTS
// ============================================================================

const QUEUE_STATE_SERVICE_SELECTION = "queue_service_selection"

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

function rawReplyText(message: IncomingMessage): string {
  return (message.text ?? message.contentSummary ?? "").trim()
}

// ============================================================================
// STATE DATA
// ============================================================================

interface QueueStateData {
  services?: CatalogService[]
}

function getQueueData(state: ConversationState): QueueStateData {
  return (state.data ?? {}) as QueueStateData
}

// ============================================================================
// ENTRY POINT — called by booking.ts's handleEntryChoice
// ============================================================================

async function startQueueFlow(): Promise<ActionResult> {
  let services: CatalogService[]
  try {
    services = await getBookableServices()
  } catch (error) {
    console.error("[queue] Error loading services", { error })
    return { reply: queueErrorMessage(), buttons: [], nextState: null }
  }

  if (services.length === 0) {
    return { reply: noServicesMessage(), buttons: [], nextState: null }
  }

  return {
    reply: servicesListMessage(services),
    buttons: [],
    nextState: { state: QUEUE_STATE_SERVICE_SELECTION, data: { services } },
  }
}

// ============================================================================
// STEP: service selection → join immediately
// ============================================================================

interface QueuePositionInfo {
  position: number
  etaMinutes: number
}

/**
 * Counts everyone ahead of `joinedAt` who's still waiting or already
 * called (i.e. currently being served), and sums their service durations
 * for a naive ETA. See file-header ASSUMPTIONS #4 for the known
 * limitation — this has no idea how many staff can work in parallel.
 */
async function getQueuePosition(supabase: SupabaseClient, joinedAt: string): Promise<QueuePositionInfo> {
  const { data, error } = await supabase
    .from("queue_entries")
    .select("joined_at, services ( duration_minutes )")
    .in("status", ["waiting", "called"])
    .lt("joined_at", joinedAt)

  if (error) throw new Error(`Failed to compute queue position: ${error.message}`)

  const ahead = data ?? []
  const etaMinutes = ahead.reduce((sum: number, row: any) => sum + (row.services?.duration_minutes ?? 0), 0)

  return { position: ahead.length + 1, etaMinutes }
}

async function handleServiceSelection(state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getQueueData(state)
  const services = data.services ?? []
  const index = Number(rawReplyText(message)) - 1

  if (!Number.isInteger(index) || index < 0 || index >= services.length) {
    return { reply: invalidSelectionMessage(services.length), buttons: [], nextState: state }
  }

  const selectedService = services[index]
  const supabase = getClientOrThrow()

  try {
    // Same minimal (phone-only) profile creation as booking.ts's
    // handleConfirm — queueing isn't gated behind full registration
    // either.
    const customer = await ensureCustomer(message.from)
    const joinedAt = new Date().toISOString()

    const { error } = await supabase.from("queue_entries").insert([
      {
        customer_id: customer.id,
        service_id: selectedService.id,
        status: "waiting",
        joined_at: joinedAt,
      },
    ])
    if (error) throw new Error(error.message)

    const { position, etaMinutes } = await getQueuePosition(supabase, joinedAt)

    return {
      reply: joinedQueueMessage(selectedService, position, etaMinutes),
      buttons: [],
      nextState: null,
    }
  } catch (error) {
    console.error("[queue] Error joining queue", { error })
    return { reply: queueErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STATE DISPATCH
// ============================================================================

async function handleState(state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case QUEUE_STATE_SERVICE_SELECTION:
      return handleServiceSelection(state, message)
    default:
      return null
  }
}

export const queueService = {
  startQueueFlow,
  handleState,
}
