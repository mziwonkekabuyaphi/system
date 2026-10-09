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

import { DEFAULT_TIMEZONE, dateKeyInTz, safeTimezone, startOfDayUtc } from "./tz"
import type { AdminQueueEntry } from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

const DEFAULT_TICKET_PREFIX = "Q"

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
       services ( name ),
       tenant_customers ( full_name, phone )`,
    )
    .eq("tenant_id", tenantId)
    .or(`status.in.(waiting,called),and(status.eq.done,completed_at.gte.${dayStart})`)
    .order("joined_at", { ascending: true })
    .limit(500)

  if (error) throw new Error(`Failed to load queue: ${error.message}`)

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
      position: sim?.position ?? null,
      etaMinutes: q.status === "waiting" ? (sim?.etaMinutes ?? null) : null,
      runningLate: sim?.runningLate ?? false,
      bookingId: q.booking_id,
      serviceId: q.service_id,
      // service_id is nullable (queue_settings.require_service_selection = false)
      serviceName: q.services?.name ?? "No service",
      customerName: q.tenant_customers?.full_name ?? null,
      customerPhone: q.tenant_customers?.phone ?? "",
    }
  })
}
