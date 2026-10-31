// app/admin/admin-data.ts
//
// Server-side loaders shared by page.tsx (first render) and actions.ts
// (refreshQueue, the Queue screen's periodic refresh). Having ONE queue query
// means the first paint and every later refresh can never disagree about
// which statuses/days are included.
//
// Every query filters by tenant_id — same belt-and-braces posture as page.tsx,
// since these run on the service-role client and bypass RLS.

import type { getSupabaseServerClient } from "@/lib/supabase/admin"

import { formatQueueTicketNumber, getQueueSimulation, type QueueSimulationEntry } from "@/lib/services/queue"
import { formatBookingTicketNumber } from "@/lib/services/ticket-format"

import { DEFAULT_TIMEZONE, dateKeyInTz, safeTimezone, startOfDayUtc } from "./tz"
import type { AdminQueueEntry } from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

const DEFAULT_TICKET_PREFIX = "Q"

/** One label for a visit's services, e.g. "Fade + Beard". The primary
 *  (service_id) service always comes first; link-table rows (booking_services /
 *  queue_entry_services) add the rest in `position` order. Duplicates are
 *  dropped, so it works whether or not the link table also repeats the primary. */
export function joinServiceLabels(
  primaryName: string | null | undefined,
  links: Array<{ position?: number | null; services?: { name?: string | null } | null }> | null | undefined,
): string | null {
  const names: string[] = []
  if (primaryName) names.push(primaryName)
  const sorted = [...(links ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  for (const l of sorted) {
    const n = l.services?.name
    if (n && !names.includes(n)) names.push(n)
  }
  return names.length ? names.join(" + ") : null
}

/** Tenant timezone + ticket prefix. Neither is sensitive (the prefix is
 *  printed on public tickets), so every admin caller gets them — unlike the
 *  rest of tenant_settings/queue_settings, which stay settings.manage-only in
 *  page.tsx. Never throws: a missing row degrades to the defaults. */
export async function loadDisplayContext(
  supabase: ServerClient,
  tenantId: string,
): Promise<{ timezone: string; ticketPrefix: string }> {
  const [settings, queueSettings] = await Promise.all([
    supabase.from("tenant_settings").select("timezone").eq("tenant_id", tenantId).maybeSingle(),
    supabase.from("queue_settings").select("ticket_number_prefix").eq("tenant_id", tenantId).maybeSingle(),
  ])
  return {
    timezone: settings.error ? DEFAULT_TIMEZONE : safeTimezone(settings.data?.timezone),
    ticketPrefix: queueSettings.error
      ? DEFAULT_TICKET_PREFIX
      : (queueSettings.data?.ticket_number_prefix as string | undefined) || DEFAULT_TICKET_PREFIX,
  }
}

/** Live queue: everything still waiting or being served (regardless of when
 *  it joined — a customer who joined before midnight is still in the queue),
 *  plus entries finished since the start of the shop's day, which feed the
 *  "Done today" count. Cancelled entries are never shown. */
export async function loadQueueEntries(
  supabase: ServerClient,
  tenantId: string,
  { timezone, ticketPrefix }: { timezone: string; ticketPrefix: string },
): Promise<AdminQueueEntry[]> {
  const dayStart = startOfDayUtc(dateKeyInTz(new Date(), timezone), timezone).toISOString()

  const { data, error } = await supabase
    .from("queue_entries")
    .select(
      `id, status, joined_at, called_at, completed_at, source, ticket_number, booking_id, service_id,
       services!queue_entries_service_id_fkey ( name ),
       queue_entry_services ( position, services ( name ) ),
       tenant_customers ( full_name, phone )`,
    )
    .eq("tenant_id", tenantId)
    .or(`status.in.(waiting,called),and(status.eq.done,completed_at.gte.${dayStart})`)
    .order("joined_at", { ascending: true })
    .limit(500)

  if (error) throw new Error(`Failed to load queue: ${error.message}`)

  // Entries promoted from a booking have no queue ticket number, so look up the
  // booking's own ticket (B0001) and reference (bookings.booking_reference) to show in its place.
  // A separate query rather than a nested select, and a failure here only
  // means those rows fall back to "—" — it never takes the queue down.
  const bookingIds = (data ?? [])
    .map((q: any) => q.booking_id as string | null)
    .filter((id: string | null): id is string => Boolean(id))
  let referenceByBookingId = new Map<string, string>()
  let bookingTicketById = new Map<string, string>()
  if (bookingIds.length > 0) {
    const { data: refRows, error: refError } = await supabase
      .from("bookings")
      .select("id, booking_reference, ticket_number")
      .eq("tenant_id", tenantId)
      .in("id", bookingIds)
    if (refError) {
      console.error("[admin] Failed to load booking references", { tenantId, error: refError.message })
    } else {
      const rows = (refRows ?? []) as Array<{ id: string; booking_reference: string; ticket_number: number | null }>
      referenceByBookingId = new Map(rows.map((b) => [b.id, b.booking_reference]))
      if (rows.some((b) => b.ticket_number != null)) {
        const { data: prefixRow } = await supabase
          .from("booking_settings")
          .select("booking_number_prefix")
          .eq("tenant_id", tenantId)
          .maybeSingle()
        const bookingPrefix = (prefixRow?.booking_number_prefix as string | undefined)?.trim() || "B"
        for (const b of rows) {
          if (b.ticket_number != null) bookingTicketById.set(b.id, formatBookingTicketNumber(b.ticket_number, bookingPrefix))
        }
      }
    }
  }

  // Order/ETA come from the SAME simulation the WhatsApp/kiosk join flow
  // uses, so staff see what customers were told and the tenant's
  // fifo/priority/hybrid mode is respected. It is a heuristic and it adds a
  // few queries, so a failure degrades to "no ETA, joined_at order" rather
  // than taking the whole queue screen down.
  let simulation = new Map<string, QueueSimulationEntry>()
  try {
    simulation = await getQueueSimulation(tenantId)
  } catch (err) {
    console.error("[admin] getQueueSimulation failed — falling back to joined_at order", { tenantId, err })
  }

  return (data ?? []).map((q: any) => {
    const sim = simulation.get(q.id)
    return {
      id: q.id,
      status: q.status,
      joinedAt: q.joined_at,
      calledAt: q.called_at,
      completedAt: q.completed_at,
      source: q.source,
      ticketNumber: q.ticket_number,
      ticketLabel: q.ticket_number == null ? null : formatQueueTicketNumber(q.ticket_number, ticketPrefix),
      bookingTicketLabel: q.booking_id ? (bookingTicketById.get(q.booking_id) ?? null) : null,
      bookingReference: q.booking_id ? (referenceByBookingId.get(q.booking_id) ?? null) : null,
      position: sim?.position ?? null,
      etaMinutes: q.status === "waiting" ? (sim?.etaMinutes ?? null) : null,
      runningLate: sim?.runningLate ?? false,
      bookingId: q.booking_id,
      serviceId: q.service_id,
      // service_id is nullable (queue_settings.require_service_selection = false)
      serviceName: joinServiceLabels(q.services?.name, q.queue_entry_services) ?? "No service",
      customerName: q.tenant_customers?.full_name ?? null,
      customerPhone: q.tenant_customers?.phone ?? "",
    }
  })
}
