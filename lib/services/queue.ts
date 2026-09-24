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
 * QUEUE SIMULATION REWRITE (new): getQueuePosition() previously summed
 * the duration of every entry ahead as if there were exactly one member
 * of staff — a customer in position 6 was told the wait of 6 back-to-back
 * services, even with 3 staff on. It's replaced by getQueueSimulation(),
 * a proper multi-server FIFO simulation: N "server free-at" times
 * (N = active staff count), each entry assigned to whichever server
 * frees up soonest. This is still a heuristic (queue_entries doesn't
 * record which physical staff member is serving a "called" entry, so a
 * called entry is assigned to whichever simulated server is free
 * soonest, not necessarily the real one — see getQueueSimulation()'s doc
 * comment), but it's a large accuracy improvement over a flat sum and
 * needs no schema change.
 *
 * A promoted booking (queue_entries.booking_id set, source = 'booking' —
 * see app/api/cron/promote-bookings/route.ts) has something a walk-in
 * doesn't: an actual appointment time the customer was promised. How
 * that's weighed against plain walk-in fairness is now a tenant setting,
 * booking_settings.queue_priority_mode (added by
 * supabase/migrations/20260915_add_queue_priority_mode.sql):
 *   - 'fifo'     a promoted booking is ordered purely by when it entered
 *                the queue (joined_at) — treated exactly like a walk-in.
 *   - 'priority' a promoted booking is guaranteed to be served at/before
 *                its actual start_time wherever physically possible,
 *                even ahead of walk-ins who joined earlier.
 *   - 'hybrid'   ordered like 'fifo' (no reordering), but flagged
 *                (runningLate) if the simulated wait would run past its
 *                start_time, so staff can see it needs attention.
 * See getQueueSimulation() below for exactly how each mode changes the
 * processing order.
 *
 * KIOSK REFACTOR: the "join and get position" logic that used to live
 * inline inside handleServiceSelection() is its own exported function,
 * joinQueue(). handleServiceSelection() calls it and builds the
 * WhatsApp reply around the result. The kiosk's Server Action calls the
 * exact same function — one source of truth for what "join the queue"
 * means, so a kiosk walk-in and a WhatsApp walk-in land in
 * `queue_entries` identically and both get an accurate position/ETA
 * computed the same way. getQueueSimulation() is ALSO exported directly
 * so the admin dashboard (app/admin/page.tsx's getTodaysQueue) can show
 * the same accurate position/ETA/runningLate for the whole current
 * queue, not just for a customer who's mid-join.
 *
 * What changed for multi-tenancy (vs the version this replaces):
 *   1. `startQueueFlow` and `handleState` take `tenantId` as their first
 *      argument, threaded through to getBookableServices/ensureCustomer/
 *      the queue_entries queries.
 *   2. `queue_entries` queries filter `.eq("tenant_id", tenantId)`.
 *   3. Switched from `@/lib/services/customer` to
 *      `@/lib/services/tenant-customer`.
 *   4. Registered in action-router.ts's `stateHandlers`.
 *
 * ASSUMPTIONS — carried over from the original, still true: no real
 * per-staff assignment tracking for walk-ins (see the simulation's doc
 * comment for how that's approximated).
 *
 * PLAN BILLING (new): joinQueue() now enforces the tenant's plan visit
 * cap via lib/services/plans.ts's assertWithinVisitLimit(), same as
 * booking.ts's createBooking() — see joinQueue()'s doc comment below for
 * why this was missing here until now.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { ensureCustomer, type Customer } from "@/lib/services/tenant-customer"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"
import { getBookingSettings, getTenantTimezone, todayInTimezone, type QueuePriorityMode } from "@/lib/services/shared/tenant-scheduling"
import { assertWithinVisitLimit, PLAN_VISIT_LIMIT_REACHED } from "@/lib/services/plans"

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

// Mirrors queue_settings.default_service_duration_minutes's DB default.
// Only ever used as a last-resort fallback (queue_settings row missing or
// query failed) — the real per-tenant value is normally read from that
// column so an admin can tune it without a code change.
const DEFAULT_SERVICE_DURATION_MINUTES = 15

/**
 * Formats a persisted queue_entries.ticket_number for display/printing —
 * the ONE place this format is defined, so the kiosk's printed slip, any
 * future "Now Serving" display, and (if it's ever added) a WhatsApp
 * confirmation can never disagree on what a ticket number looks like.
 * Zero-padded to 3 digits (Q001..Q999) purely for a tidy, fixed-width
 * printed look — the underlying counter isn't capped at 999, a 4-digit
 * day just prints as "Q1000" rather than wrapping or erroring. `prefix`
 * is the tenant's own queue_settings.ticket_number_prefix (defaults to
 * "Q" at the DB level, so this parameter is only ever actually optional
 * as a defensive fallback — every real call site has a real value to
 * pass).
 */
export function formatQueueTicketNumber(ticketNumber: number, prefix: string = "Q"): string {
  return `${prefix}${String(ticketNumber).padStart(3, "0")}`
}

async function getTicketNumberPrefix(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from("queue_settings")
    .select("ticket_number_prefix")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) {
    console.error("[queue] Failed to load ticket_number_prefix, using fallback", { tenantId, error })
    return "Q"
  }

  return data?.ticket_number_prefix ?? "Q"
}

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
// QUEUE SIMULATION — multi-server FIFO, priority-mode-aware.
// Exported so both joinQueue() (below) and the admin dashboard
// (app/admin/page.tsx's getTodaysQueue) can get the same accurate
// numbers for the same underlying queue.
// ============================================================================

export interface QueuePositionInfo {
  position: number
  etaMinutes: number
}

export interface QueueSimulationEntry {
  id: string
  /** 1-based position in line. Called entries (already being served)
   *  are numbered ahead of every waiting entry, in call order. */
  position: number
  /** Minutes until this entry's simulated turn. 0 for a called entry. */
  etaMinutes: number
  /** Only ever true for a booking-linked entry under 'hybrid' mode —
   *  see this file's header. Always false otherwise, including for
   *  plain walk-ins and for 'fifo'/'priority' modes (the latter avoids
   *  lateness by reordering instead of flagging it). */
  runningLate: boolean
}

interface QueueEntryRow {
  id: string
  status: "waiting" | "called"
  joined_at: string
  called_at: string | null
  booking_id: string | null
  services: { duration_minutes: number } | { duration_minutes: number }[] | null
}

interface SimEntry {
  id: string
  joinedAtMillis: number
  calledAtMillis: number | null
  durationMinutes: number
  /** Resolved start_time of the linked booking, in ms — null for a
   *  plain walk-in or if the linked booking couldn't be found. */
  bookingStartMillis: number | null
}

// `row.services` comes back null/empty from the join whenever
// queue_entries.service_id is null — i.e. exactly the walk-in-with-no-
// -service case require_service_selection=false enables. Falling back to
// 0 there (the old behavior) told the simulation this customer takes no
// time to serve, which understated the wait for everyone queued behind
// them. defaultDurationMinutes (queue_settings.default_service_duration_minutes)
// is the tenant's own estimate for that case instead.
function durationFromRow(row: QueueEntryRow, defaultDurationMinutes: number): number {
  const services = row.services
  if (!services) return defaultDurationMinutes
  const entry = Array.isArray(services) ? services[0] : services
  return entry?.duration_minutes ?? defaultDurationMinutes
}

async function getDefaultServiceDurationMinutes(supabase: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await supabase
    .from("queue_settings")
    .select("default_service_duration_minutes")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) {
    console.error("[queue] Failed to load default_service_duration_minutes, using fallback", { tenantId, error })
    return DEFAULT_SERVICE_DURATION_MINUTES
  }

  return data?.default_service_duration_minutes ?? DEFAULT_SERVICE_DURATION_MINUTES
}

async function getActiveStaffCount(supabase: SupabaseClient, tenantId: string): Promise<number> {
  const { count, error } = await supabase
    .from("staff")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("active", true)

  if (error) throw new Error(`Failed to load staff count: ${error.message}`)
  return count ?? 0
}

async function loadSimEntries(
  supabase: SupabaseClient,
  tenantId: string,
  defaultDurationMinutes: number,
): Promise<SimEntry[]> {
  const { data, error } = await supabase
    .from("queue_entries")
    .select("id, status, joined_at, called_at, booking_id, services ( duration_minutes )")
    .eq("tenant_id", tenantId)
    .in("status", ["waiting", "called"])

  if (error) throw new Error(`Failed to load queue entries: ${error.message}`)

  const rows = (data ?? []) as unknown as QueueEntryRow[]
  const bookingIds = rows.map((r) => r.booking_id).filter((id): id is string => Boolean(id))

  let bookingStartById = new Map<string, number>()
  if (bookingIds.length > 0) {
    const { data: bookingRows, error: bookingsError } = await supabase
      .from("bookings")
      .select("id, start_time")
      .in("id", bookingIds)

    if (bookingsError) throw new Error(`Failed to load linked bookings: ${bookingsError.message}`)
    bookingStartById = new Map(
      (bookingRows ?? []).map((b: { id: string; start_time: string }) => [b.id, new Date(b.start_time).getTime()]),
    )
  }

  return rows.map((row) => ({
    id: row.id,
    joinedAtMillis: new Date(row.joined_at).getTime(),
    calledAtMillis: row.called_at ? new Date(row.called_at).getTime() : null,
    durationMinutes: durationFromRow(row, defaultDurationMinutes),
    bookingStartMillis: row.booking_id ? bookingStartById.get(row.booking_id) ?? null : null,
  }))
}

function indexOfEarliestFreeServer(serverFreeAtMillis: number[]): number {
  let minIndex = 0
  for (let i = 1; i < serverFreeAtMillis.length; i++) {
    if (serverFreeAtMillis[i] < serverFreeAtMillis[minIndex]) minIndex = i
  }
  return minIndex
}

/**
 * Runs the N-server simulation: `calledEntries` (already being served)
 * occupy a server until their estimated finish; `processingOrder`
 * (waiting entries, already sorted into whatever order this mode uses)
 * are then assigned one at a time to whichever server frees up soonest.
 * Returns each waiting entry's simulated start time.
 *
 * NOTE ON ACCURACY: queue_entries doesn't record which physical staff
 * member is serving a "called" entry, so a called entry here is
 * greedily assigned to whichever simulated server is free soonest — not
 * necessarily the actual staff member serving it. With normal usage
 * (one entry called at a time, staff free when nobody's called) this
 * converges to the right answer quickly; it can be briefly optimistic
 * right when several customers are called back-to-back. Tracking the
 * real assignment would need a staff_id column on queue_entries, which
 * this change deliberately doesn't add (no evidence it's needed yet).
 */
function runServerSimulation(
  calledEntries: SimEntry[],
  processingOrder: SimEntry[],
  staffCount: number,
  nowMillis: number,
): Map<string, number> {
  const serverFreeAtMillis = new Array(Math.max(staffCount, 1)).fill(nowMillis)

  for (const entry of calledEntries) {
    const finishAt = Math.max(nowMillis, (entry.calledAtMillis ?? nowMillis) + entry.durationMinutes * 60_000)
    const serverIndex = indexOfEarliestFreeServer(serverFreeAtMillis)
    serverFreeAtMillis[serverIndex] = finishAt
  }

  const startAtById = new Map<string, number>()
  for (const entry of processingOrder) {
    const serverIndex = indexOfEarliestFreeServer(serverFreeAtMillis)
    const startAt = serverFreeAtMillis[serverIndex]
    startAtById.set(entry.id, startAt)
    serverFreeAtMillis[serverIndex] = startAt + entry.durationMinutes * 60_000
  }

  return startAtById
}

/**
 * Builds the order waiting entries will actually be served in, per
 * `mode`. 'fifo' and 'hybrid' both use plain joined_at order — 'hybrid'
 * never reorders, it only flags lateness afterward (see
 * getQueueSimulation). 'priority' runs the plain FIFO simulation once to
 * see which booking-linked entries WOULD miss their appointment time,
 * then moves only those to the front (earliest appointment first),
 * leaving every other entry's relative order untouched. This is a
 * heuristic that guarantees a late booking gets the earliest possible
 * service without reshuffling the whole line for bookings that were
 * never going to be late anyway — not a globally optimal schedule.
 */
function buildProcessingOrder(
  waiting: SimEntry[],
  calledEntries: SimEntry[],
  staffCount: number,
  mode: QueuePriorityMode,
  nowMillis: number,
): SimEntry[] {
  const fifoOrder = [...waiting].sort((a, b) => a.joinedAtMillis - b.joinedAtMillis)

  if (mode !== "priority" || fifoOrder.length === 0) {
    return fifoOrder
  }

  const tentativeStartById = runServerSimulation(calledEntries, fifoOrder, staffCount, nowMillis)

  const urgent: SimEntry[] = []
  const rest: SimEntry[] = []
  for (const entry of fifoOrder) {
    const deadline = entry.bookingStartMillis
    const tentativeStart = tentativeStartById.get(entry.id) ?? nowMillis
    const wouldMissDeadline = deadline !== null && tentativeStart > deadline
    if (wouldMissDeadline) urgent.push(entry)
    else rest.push(entry)
  }

  // Earliest appointment first among the ones that need rescuing.
  urgent.sort((a, b) => (a.bookingStartMillis as number) - (b.bookingStartMillis as number))
  return [...urgent, ...rest]
}

/**
 * The single source of truth for "where does everyone currently stand in
 * the queue" — called entries plus waiting entries, tenant-wide. Called
 * by joinQueue() right after a new entry is inserted (to answer "what's
 * MY position"), and importable directly by the admin dashboard to show
 * the same numbers for the whole visible queue.
 */
export async function getQueueSimulation(tenantId: string): Promise<Map<string, QueueSimulationEntry>> {
  const supabase = getClientOrThrow()

  // Resolved once up front so loadSimEntries can use it for every
  // service_id = null row in a single pass, rather than each row
  // re-querying queue_settings.
  const defaultDurationMinutes = await getDefaultServiceDurationMinutes(supabase, tenantId)

  const [entries, staffCount, bookingSettings, statusRowsResult] = await Promise.all([
    loadSimEntries(supabase, tenantId, defaultDurationMinutes),
    getActiveStaffCount(supabase, tenantId),
    getBookingSettings(supabase, tenantId),
    supabase.from("queue_entries").select("id, status").eq("tenant_id", tenantId).in("status", ["waiting", "called"]),
  ])

  if (statusRowsResult.error) {
    throw new Error(`Failed to load queue entry statuses: ${statusRowsResult.error.message}`)
  }

  const statusById = new Map(
    (statusRowsResult.data ?? []).map((r: { id: string; status: "waiting" | "called" }) => [r.id, r.status]),
  )

  const now = Date.now()
  const calledEntries = entries
    .filter((e) => statusById.get(e.id) === "called")
    .sort((a, b) => (a.calledAtMillis ?? 0) - (b.calledAtMillis ?? 0))
  const waitingEntries = entries.filter((e) => statusById.get(e.id) === "waiting")

  const processingOrder = buildProcessingOrder(
    waitingEntries,
    calledEntries,
    staffCount,
    bookingSettings.queuePriorityMode,
    now,
  )
  const startAtById = runServerSimulation(calledEntries, processingOrder, staffCount, now)

  const result = new Map<string, QueueSimulationEntry>()

  calledEntries.forEach((entry, index) => {
    result.set(entry.id, { id: entry.id, position: index + 1, etaMinutes: 0, runningLate: false })
  })

  processingOrder.forEach((entry, index) => {
    const startAt = startAtById.get(entry.id) ?? now
    const etaMinutes = Math.max(0, Math.round((startAt - now) / 60_000))
    const runningLate =
      bookingSettings.queuePriorityMode === "hybrid" &&
      entry.bookingStartMillis !== null &&
      startAt > entry.bookingStartMillis

    result.set(entry.id, {
      id: entry.id,
      position: calledEntries.length + index + 1,
      etaMinutes,
      runningLate,
    })
  })

  return result
}

// ============================================================================
// SHARED CORE — join + position. Called by handleServiceSelection
// (WhatsApp) AND the kiosk's Server Action.
// ============================================================================

export interface JoinQueueParams {
  /** The full catalog entry, not just an id — both callers already have
   *  it in hand. Null when the tenant has queue_settings.require_service_
   *  selection off and the customer was never asked to pick one — the
   *  inserted queue_entries row gets service_id = null, and the wait
   *  estimate falls back to queue_settings.default_service_duration_minutes
   *  (see durationFromRow/getDefaultServiceDurationMinutes above). Callers
   *  (WhatsApp's handleServiceSelection, the kiosk's submitKioskQueueJoin)
   *  are responsible for enforcing require_service_selection themselves
   *  BEFORE calling this — joinQueue() itself doesn't re-check the flag,
   *  it just accepts whatever service (or lack of one) it's given. */
  service: CatalogService | null
  /** Raw or normalized — ensureCustomer() normalizes internally. */
  phone: string
}

export interface JoinQueueResult {
  customer: Customer
  position: number
  etaMinutes: number
  /** Permanent for this entry's lifetime — see formatQueueTicketNumber()
   *  and the queue_entries.ticket_number column comment. This is what
   *  should be printed on a kiosk slip or shown on a "Now Serving"
   *  display; `position` above is a live number that reshuffles as the
   *  queue moves and is NOT safe to print on paper. */
  ticketNumber: number
  /** This tenant's queue_settings.ticket_number_prefix — pass this to
   *  formatQueueTicketNumber() alongside ticketNumber rather than
   *  hardcoding "Q" at the call site. */
  ticketPrefix: string
}

/**
 * Creates the tenant_customers row if needed, inserts the queue_entries
 * row, and returns this customer's position + ETA via the same
 * getQueueSimulation() the admin dashboard uses — so a customer joining
 * by WhatsApp/kiosk and staff looking at the dashboard are always
 * looking at the same number, never two separate calculations that can
 * disagree. The one place a `queue_entries` row gets created from a
 * customer-facing flow.
 *
 * PLAN BILLING: enforces the tenant's plan visit cap via
 * assertWithinVisitLimit(), same as booking.ts's createBooking() — run
 * first and cheapest, before the ticket-number round trip or the insert,
 * for the same "check first, write nothing on failure" reason. This was
 * previously missing here entirely (createBooking() had it, joinQueue()
 * didn't), which meant a walk-in queue join never counted against a
 * Free-plan tenant's cap no matter how many they'd already used — fixed
 * as part of the billing work; see PLAN_VISIT_LIMIT_REACHED handling in
 * handleServiceSelection below for the customer-facing message.
 *
 * TICKET NUMBER ASSIGNMENT: resolved via next_queue_ticket_number() —
 * atomic per (tenant, calendar day in the TENANT's own timezone) — and
 * included in the insert. This is a separate round-trip from the insert
 * itself (not one atomic transaction with it), so a network failure
 * between the two could in principle leave a gap in the day's numbering
 * (a number allocated but never used). That's an acceptable, standard
 * trade-off for this kind of ticketing — the guarantee that actually
 * matters is uniqueness (never two entries sharing a number), not
 * gaplessness, and uniqueness is guaranteed by the counter table's atomic
 * UPSERT regardless.
 *
 * KNOWN GAP: this is currently the ONLY place that assigns a
 * ticket_number. A queue_entries row inserted by any other path — most
 * notably the promote_bookings_to_queue() pg_cron job that unify-with-
 * queue relies on (see booking_settings.unify_with_queue) — will have
 * ticket_number = null unless that job is separately updated to call
 * next_queue_ticket_number() itself. Flagging this rather than silently
 * leaving promoted bookings ticket-less.
 */
export async function joinQueue(tenantId: string, params: JoinQueueParams): Promise<JoinQueueResult> {
  const { service, phone } = params
  const supabase = getClientOrThrow()

  // Plan enforcement runs first and cheapest — no point assigning a
  // ticket number or claiming anything for a join that's about to be
  // rejected because the tenant is over their monthly visit cap anyway.
  await assertWithinVisitLimit(supabase, tenantId)

  // Same minimal (phone-only) customer creation as booking.ts's
  // createBooking() — queueing isn't gated behind full registration
  // either.
  const customer = await ensureCustomer(tenantId, phone)
  const joinedAt = new Date().toISOString()

  const timezone = await getTenantTimezone(supabase, tenantId)
  const ticketDate = todayInTimezone(timezone)

  const { data: ticketNumber, error: ticketError } = await supabase.rpc("next_queue_ticket_number", {
    p_tenant_id: tenantId,
    p_ticket_date: ticketDate,
  })

  if (ticketError) throw new Error(`Failed to assign a queue ticket number: ${ticketError.message}`)

  const ticketPrefix = await getTicketNumberPrefix(supabase, tenantId)

  const { data: inserted, error } = await supabase
    .from("queue_entries")
    .insert([
      {
        tenant_id: tenantId,
        customer_id: customer.id,
        service_id: service?.id ?? null,
        status: "waiting",
        joined_at: joinedAt,
        ticket_number: ticketNumber,
      },
    ])
    .select("id")
    .single()

  if (error) throw new Error(error.message)

  const simulation = await getQueueSimulation(tenantId)
  const own = simulation.get(inserted.id)

  // Fallbacks below only matter if the simulation somehow doesn't contain
  // the entry we just inserted, which shouldn't happen — defensive, not
  // the expected path. The etaMinutes fallback mirrors durationFromRow's
  // own fallback (service's real duration when we have one, otherwise the
  // same constant durationFromRow would have used).
  return {
    customer,
    position: own?.position ?? 1,
    etaMinutes: own?.etaMinutes ?? service?.durationMinutes ?? DEFAULT_SERVICE_DURATION_MINUTES,
    ticketNumber,
    ticketPrefix,
  }
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
    if (error instanceof Error && error.message === PLAN_VISIT_LIMIT_REACHED) {
      // TODO: move this into lib/services/messages/queue.ts as a proper
      // planLimitReachedMessage(), same as booking.ts's matching TODO —
      // inlined here for now for the same reason: not guessing at that
      // file's conventions mid-merge.
      return {
        reply: "Sorry, this shop has reached its queue limit for this month. Please try again next month, or contact them directly.",
        buttons: [],
        nextState: null,
      }
    }
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
