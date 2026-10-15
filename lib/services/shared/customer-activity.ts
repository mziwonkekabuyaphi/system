// lib/services/shared/customer-activity.ts
/**
 * "What does this customer currently have with this shop?" — the one loader
 * shared by Check Status (status.ts) and Cancel Now (cancel.ts), so both
 * always agree on what counts as an upcoming booking or an active queue spot.
 *
 * Tables/columns used (verified against the QLess Supabase schema):
 *   - bookings:      status IN ('confirmed','cancelled','completed'); only
 *                    'confirmed' with end_time in the future counts as upcoming.
 *   - queue_entries: status IN ('waiting','called','done','cancelled'); only
 *                    'waiting' and 'called' are active. booking_id is set when
 *                    the entry was promoted from a booking (source='booking').
 *   - queue_settings.ticket_number_prefix for formatting tickets.
 *   - tenant_settings.timezone for showing times in the shop's local time.
 *
 * A booking that has been promoted into the queue is ONE visit, so it is
 * returned as a booking with its `queueEntry` attached — not as two separate
 * things. A queue entry with no matching upcoming booking is a plain walk-in.
 *
 * Every query is scoped by tenant_id AND customer_id.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"

export interface ActiveQueueEntry {
  id: string
  status: "waiting" | "called"
  ticketNumber: number | null
  serviceName: string | null
  bookingId: string | null
  joinedAt: string
}

export interface UpcomingBooking {
  id: string
  reference: string
  startTime: string
  endTime: string
  serviceName: string | null
  /** Set when this booking has been promoted into the live queue. */
  queueEntry: ActiveQueueEntry | null
}

export interface CustomerActivity {
  timezone: string
  ticketPrefix: string
  bookings: UpcomingBooking[]
  /** Queue entries that are not tied to an upcoming booking. */
  walkIns: ActiveQueueEntry[]
}

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

/** PostgREST returns a joined row as an object or a one-item array. */
function joinedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value
  const name = (row as { name?: string } | null | undefined)?.name
  return typeof name === "string" && name.trim() ? name : null
}

/**
 * bookings and queue_entries each reach `services` two ways: the direct
 * service_id FK (the first service) and the booking_services /
 * queue_entry_services join tables (the full ordered list). A bare
 * `services ( name )` embed is therefore ambiguous and PostgREST answers
 * HTTP 300 (PGRST201), so every embed below names its FK explicitly.
 *
 * Display name: all picked services in the order the customer chose them,
 * e.g. "Skin Fade + Hair Wash & Style". Falls back to the direct FK service
 * for older rows that have no join-table rows.
 */
function serviceNameFrom(links: unknown, direct: unknown): string | null {
  const rows = (Array.isArray(links) ? links : []) as { position?: number | null; services?: unknown }[]
  const names = [...rows]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((r) => joinedName(r.services))
    .filter((n): n is string => Boolean(n))
  return names.length > 0 ? names.join(" + ") : joinedName(direct)
}

async function loadTicketPrefix(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from("queue_settings")
    .select("ticket_number_prefix")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) {
    console.error("[customer-activity] Failed to load ticket prefix, using fallback", { tenantId, error })
    return "Q"
  }
  return data?.ticket_number_prefix ?? "Q"
}

export async function loadCustomerActivity(tenantId: string, customerId: string): Promise<CustomerActivity> {
  const supabase = getClientOrThrow()
  const nowIso = new Date().toISOString()

  const [timezone, ticketPrefix, bookingsResult, queueResult] = await Promise.all([
    getTenantTimezone(supabase, tenantId),
    loadTicketPrefix(supabase, tenantId),
    supabase
      .from("bookings")
      .select(
        "id, booking_reference, start_time, end_time, " +
          "services!bookings_service_id_fkey ( name ), " +
          "booking_services ( position, services ( name ) )",
      )
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("status", "confirmed")
      .gt("end_time", nowIso)
      .order("start_time", { ascending: true }),
    supabase
      .from("queue_entries")
      .select(
        "id, status, ticket_number, joined_at, booking_id, " +
          "services!queue_entries_service_id_fkey ( name ), " +
          "queue_entry_services ( position, services ( name ) )",
      )
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .in("status", ["waiting", "called"])
      .order("joined_at", { ascending: true }),
  ])

  if (bookingsResult.error) throw new Error(`Failed to load bookings: ${bookingsResult.error.message}`)
  if (queueResult.error) throw new Error(`Failed to load queue entries: ${queueResult.error.message}`)

  const queueEntries: ActiveQueueEntry[] = (queueResult.data ?? []).map((row) => ({
    id: row.id as string,
    status: row.status as "waiting" | "called",
    ticketNumber: (row.ticket_number as number | null) ?? null,
    serviceName: serviceNameFrom(row.queue_entry_services, row.services),
    bookingId: (row.booking_id as string | null) ?? null,
    joinedAt: row.joined_at as string,
  }))

  const bookings: UpcomingBooking[] = (bookingsResult.data ?? []).map((row) => ({
    id: row.id as string,
    reference: row.booking_reference as string,
    startTime: row.start_time as string,
    endTime: row.end_time as string,
    serviceName: serviceNameFrom(row.booking_services, row.services),
    queueEntry: queueEntries.find((q) => q.bookingId === row.id) ?? null,
  }))

  const linkedQueueIds = new Set(bookings.map((b) => b.queueEntry?.id).filter(Boolean))
  const walkIns = queueEntries.filter((q) => !linkedQueueIds.has(q.id))

  return { timezone, ticketPrefix, bookings, walkIns }
}

/** "Tue 14 Oct, 10:30" in the shop's local time. */
export function formatLocalDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso)
  const day = new Intl.DateTimeFormat("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(date)
  const time = new Intl.DateTimeFormat("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date)
  return `${day}, ${time}`
}
