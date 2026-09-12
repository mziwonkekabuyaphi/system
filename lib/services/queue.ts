// lib/services/queue.ts
/**
 * Salon/Barbershop Walk-in Queue Service — tenant-scoped.
 * ---------------------------------------------------------
 * Sibling to booking.ts: lets a WhatsApp customer join today's walk-in
 * queue instead of booking a specific time slot. Entered only via
 * booking.ts's handleEntryChoice — there's no standalone "queue" intent.
 *
 * All customer-facing copy lives in lib/services/messages/queue.ts — this
 * file only owns state transitions and data access, same convention as
 * booking.ts.
 *
 * KIOSK REFACTOR (new): the "join and get position" logic that used to
 * live inline inside handleServiceSelection() is now its own exported
 * function, joinQueue(). handleServiceSelection() calls it and builds
 * the WhatsApp reply around the result. The kiosk's Server Action calls
 * the exact same function — one source of truth for what "join the
 * queue" means, so a kiosk walk-in and a WhatsApp walk-in land in
 * `queue_entries` identically and both get an accurate position/ETA
 * computed the same way.
 *
 * What changed for multi-tenancy (vs the version this replaces):
 *   1. `startQueueFlow` and `handleState` now take `tenantId` as their
 *      first argument (matching the StatefulService/IntentService shape
 *      action-router.ts expects), threaded through to
 *      getBookableServices/ensureCustomer/the queue_entries queries.
 *   2. `queue_entries` queries now filter `.eq("tenant_id", tenantId)` —
 *      previously ungated, so a position/ETA calculation could count
 *      another tenant's customers as "ahead in line."
 *   3. Switched from `@/lib/services/customer` (single-arg
 *      `ensureCustomer(phone)`, profiles-based) to
 *      `@/lib/services/tenant-customer` (`ensureCustomer(tenantId, phone)`,
 *      tenant_customers-based).
 *   4. Registered in action-router.ts's `stateHandlers`. It wasn't
 *      before, even pre-multi-tenant — `queue_service_selection` had no
 *      path back into this file on a customer's next reply. Unrelated to
 *      tenancy, just a pre-existing gap fixed while this file was open.
 *
 * ASSUMPTIONS — unchanged from the original: no availability/staff
 * awareness, no confirm step, naive ETA (sum of durations for everyone
 * ahead, no parallelism awareness).
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer, type Customer } from "@/lib/services/tenant-customer"
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

async function startQueueFlow(tenantId: string): Promise<ActionResult> {
  let services: CatalogService[]
  try {
    services = await getBookableServices(tenantId)
  } catch (error) {
    console.error("[queue] Error loading services", { tenantId, error })
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
// SHARED CORE — join + position. Called by handleServiceSelection
// (WhatsApp) AND the kiosk's Server Action.
// ============================================================================

export interface QueuePositionInfo {
  position: number
  etaMinutes: number
}

/**
 * Counts everyone ahead of `joinedAt`, SCOPED TO THIS TENANT, who's still
 * waiting or already called, and sums their service durations for a
 * naive ETA. See file-header ASSUMPTIONS — no idea how many staff can
 * work in parallel.
 */
async function getQueuePosition(supabase: SupabaseClient, tenantId: string, joinedAt: string): Promise<QueuePositionInfo> {
  const { data, error } = await supabase
    .from("queue_entries")
    .select("joined_at, services ( duration_minutes )")
    .eq("tenant_id", tenantId)
    .in("status", ["waiting", "called"])
    .lt("joined_at", joinedAt)

  if (error) throw new Error(`Failed to compute queue position: ${error.message}`)

  const ahead = data ?? []
  const etaMinutes = ahead.reduce((sum: number, row: any) => sum + (row.services?.duration_minutes ?? 0), 0)

  return { position: ahead.length + 1, etaMinutes }
}

export interface JoinQueueParams {
  /** The full catalog entry, not just an id — both callers already have
   *  it in hand. */
  service: CatalogService
  /** Raw or normalized — ensureCustomer() normalizes internally. */
  phone: string
}

export interface JoinQueueResult {
  customer: Customer
  position: number
  etaMinutes: number
}

/**
 * Creates the tenant_customers row if needed, inserts the queue_entries
 * row, and returns this customer's position + naive ETA. The one place a
 * `queue_entries` row gets created from a customer-facing flow.
 */
export async function joinQueue(tenantId: string, params: JoinQueueParams): Promise<JoinQueueResult> {
  const { service, phone } = params
  const supabase = getClientOrThrow()

  // Same minimal (phone-only) customer creation as booking.ts's
  // createBooking() — queueing isn't gated behind full registration
  // either.
  const customer = await ensureCustomer(tenantId, phone)
  const joinedAt = new Date().toISOString()

  const { error } = await supabase.from("queue_entries").insert([
    {
      tenant_id: tenantId,
      customer_id: customer.id,
      service_id: service.id,
      status: "waiting",
      joined_at: joinedAt,
    },
  ])
  if (error) throw new Error(error.message)

  const { position, etaMinutes } = await getQueuePosition(supabase, tenantId, joinedAt)

  return { customer, position, etaMinutes }
}

// ============================================================================
// STEP: service selection → join immediately
// ============================================================================

async function handleServiceSelection(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult> {
  const data = getQueueData(state)
  const services = data.services ?? []
  const index = Number(rawReplyText(message)) - 1

  if (!Number.isInteger(index) || index < 0 || index >= services.length) {
    return { reply: invalidSelectionMessage(services.length), buttons: [], nextState: state }
  }

  const selectedService = services[index]

  try {
    const { position, etaMinutes } = await joinQueue(tenantId, { service: selectedService, phone: message.from })

    return {
      reply: joinedQueueMessage(selectedService, position, etaMinutes),
      buttons: [],
      nextState: null,
    }
  } catch (error) {
    console.error("[queue] Error joining queue", { tenantId, error })
    return { reply: queueErrorMessage(), buttons: [], nextState: null }
  }
}

// ============================================================================
// STATE DISPATCH
// ============================================================================

async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  switch (state.state) {
    case QUEUE_STATE_SERVICE_SELECTION:
      return handleServiceSelection(tenantId, state, message)
    default:
      return null
  }
}

export const queueService = {
  startQueueFlow,
  handleState,
}
