// lib/services/profile.ts
/**
 * QLess Profile — the customer's "profile" screen, tenant-scoped.
 * ----------------------------------------------------------------
 * One live read in, one WhatsApp message out. This is an AGGREGATION
 * layer: it owns no business logic and creates no state. Everything is read for ONE customer of ONE tenant:
 *
 *   Identity        → tenant-customer.ts   (getCustomer)
 *   Upcoming booking→ bookings             (next confirmed booking)
 *   Queue spot      → queue_entries + queue.ts (getQueueSimulation /
 *                     formatQueueTicketNumber) — the SAME numbers staff and
 *                     the kiosk see, never a second calculation
 *   Visit history   → billable_visits      (one row per real completed visit)
 *   Shop name       → tenant_branding.display_name, falling back to tenants.name
 *
 * STATELESS: nextState is always null. Taps on the follow-up menu are
 * routed by row id in action-router.ts, exactly like the greeting menu.
 *
 * FAILURE ISOLATION: each section is fetched with Promise.allSettled, so a
 * failing section shows "unavailable" instead of blanking the whole
 * profile. A resolved empty value (no booking, no queue spot) is trusted
 * as-is and never second-guessed into "unavailable".
 *
 * PRIVACY: only ever looks up the phone number the message came from
 * (message.from). There is no way to ask for someone else's profile.
 *
 * White-label: nothing is hardcoded — shop name comes from the tenant.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getCustomer, type Customer } from "@/lib/services/tenant-customer"
import { getQueueSimulation, formatQueueTicketNumber } from "@/lib/services/queue"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { buildServicesListMessage } from "@/lib/whatsapp/utils/services-list"
import { getTenantWebLinkNote } from "@/lib/whatsapp/utils/tenant-web-link"

// ============================================================================
// TYPES
// ============================================================================

type Section<T> = { status: "ok"; value: T } | { status: "unavailable" }

interface UpcomingBooking {
  reference: string
  serviceName: string | null
  startTime: string
}

interface ActiveQueueEntry {
  status: "waiting" | "called"
  ticketLabel: string | null
  serviceName: string | null
  /** null when the simulation couldn't place the entry (shouldn't happen). */
  position: number | null
  etaMinutes: number | null
  runningLate: boolean
}

interface VisitSummary {
  totalVisits: number
  lastVisitAt: string | null
}

interface ProfileData {
  shopName: string | null
  timeZone: string
  firstName: string | null
  booking: Section<UpcomingBooking | null>
  queue: Section<ActiveQueueEntry | null>
  visits: Section<VisitSummary>
}

// ============================================================================
// HELPERS
// ============================================================================

function getClientOrNull(): SupabaseClient | null {
  return getSupabaseServerClient() ?? null
}

/** Supabase returns a to-one join as an object, but typings/edge cases can
 *  give a one-element array — accept both. */
function joinedName(value: { name: string } | { name: string }[] | null | undefined): string | null {
  if (!value) return null
  const row = Array.isArray(value) ? value[0] : value
  return row?.name ?? null
}

function firstNameOf(customer: Customer | null): string | null {
  const name = customer?.name?.trim()
  if (!name) return null
  return name.split(/\s+/)[0] || null
}

async function loadShopName(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const [tenantRow, brandingRow] = await Promise.all([
    supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    supabase.from("tenant_branding").select("display_name").eq("tenant_id", tenantId).maybeSingle(),
  ])
  // Same precedence as the greeting in action-router.ts: the owner's
  // Settings > Branding display name wins, tenants.name is the fallback.
  return brandingRow.data?.display_name?.trim() || tenantRow.data?.name || null
}

// ============================================================================
// SECTION READS — each one is independent and may throw on its own
// ============================================================================

async function readUpcomingBooking(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
): Promise<UpcomingBooking | null> {
  const { data, error } = await supabase
    .from("bookings")
    .select("booking_reference, start_time, services ( name )")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "confirmed")
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to load upcoming booking: ${error.message}`)
  if (!data) return null

  const row = data as unknown as {
    booking_reference: string
    start_time: string
    services: { name: string } | { name: string }[] | null
  }

  return {
    reference: row.booking_reference,
    serviceName: joinedName(row.services),
    startTime: row.start_time,
  }
}

async function readActiveQueueEntry(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
): Promise<ActiveQueueEntry | null> {
  const { data, error } = await supabase
    .from("queue_entries")
    .select("id, status, ticket_number, services ( name )")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("status", ["waiting", "called"])
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to load queue entry: ${error.message}`)
  if (!data) return null

  const row = data as unknown as {
    id: string
    status: "waiting" | "called"
    ticket_number: number | null
    services: { name: string } | { name: string }[] | null
  }

  // Ticket prefix is a tenant setting; fall back to "Q" like queue.ts does.
  let ticketLabel: string | null = null
  if (row.ticket_number !== null) {
    const { data: settings } = await supabase
      .from("queue_settings")
      .select("ticket_number_prefix")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    ticketLabel = formatQueueTicketNumber(row.ticket_number, settings?.ticket_number_prefix ?? "Q")
  }

  // Live position/ETA from the single source of truth.
  const simulation = await getQueueSimulation(tenantId)
  const own = simulation.get(row.id)

  return {
    status: row.status,
    ticketLabel,
    serviceName: joinedName(row.services),
    position: own?.position ?? null,
    etaMinutes: own?.etaMinutes ?? null,
    runningLate: own?.runningLate ?? false,
  }
}

async function readVisitSummary(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
): Promise<VisitSummary> {
  const [countResult, lastResult] = await Promise.all([
    supabase
      .from("billable_visits")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId),
    supabase
      .from("billable_visits")
      .select("visit_date")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("visit_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (countResult.error) throw new Error(`Failed to count visits: ${countResult.error.message}`)
  if (lastResult.error) throw new Error(`Failed to load last visit: ${lastResult.error.message}`)

  return {
    totalVisits: countResult.count ?? 0,
    lastVisitAt: lastResult.data?.visit_date ?? null,
  }
}

function unavailable<T>(): Section<T> {
  return { status: "unavailable" }
}

function settled<T>(result: PromiseSettledResult<T>): Section<T> {
  return result.status === "fulfilled" ? { status: "ok", value: result.value } : unavailable<T>()
}

async function buildProfileData(tenantId: string, phone: string): Promise<ProfileData> {
  const supabase = getClientOrNull()

  // No DB connection: still return a renderable (all-unavailable) profile.
  if (!supabase) {
    return {
      shopName: null,
      timeZone: "Africa/Johannesburg",
      firstName: null,
      booking: unavailable(),
      queue: unavailable(),
      visits: unavailable(),
    }
  }

  let customer: Customer | null = null
  try {
    customer = await getCustomer(tenantId, phone)
  } catch (error) {
    console.error("[profile] getCustomer failed", { tenantId, error })
  }

  const [shopNameResult, timeZoneResult] = await Promise.allSettled([
    loadShopName(supabase, tenantId),
    getTenantTimezone(supabase, tenantId),
  ])

  const shopName = shopNameResult.status === "fulfilled" ? shopNameResult.value : null
  const timeZone = timeZoneResult.status === "fulfilled" ? timeZoneResult.value : "Africa/Johannesburg"

  // Brand-new number with no tenant_customers row: nothing to look up, and
  // that is a real answer ("nothing yet"), not a failure.
  if (!customer) {
    return {
      shopName,
      timeZone,
      firstName: null,
      booking: { status: "ok", value: null },
      queue: { status: "ok", value: null },
      visits: { status: "ok", value: { totalVisits: 0, lastVisitAt: null } },
    }
  }

  const [bookingResult, queueResult, visitsResult] = await Promise.allSettled([
    readUpcomingBooking(supabase, tenantId, customer.id),
    readActiveQueueEntry(supabase, tenantId, customer.id),
    readVisitSummary(supabase, tenantId, customer.id),
  ])

  for (const [label, result] of [
    ["booking", bookingResult],
    ["queue", queueResult],
    ["visits", visitsResult],
  ] as const) {
    if (result.status === "rejected") {
      console.error(`[profile] ${label} section failed`, { tenantId, error: result.reason })
    }
  }

  return {
    shopName,
    timeZone,
    firstName: firstNameOf(customer),
    booking: settled(bookingResult),
    queue: settled(queueResult),
    visits: settled(visitsResult),
  }
}

// ============================================================================
// FORMATTING
// ============================================================================

function formatWhen(iso: string, timeZone: string): string {
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
  return `${day} at ${time}`
}

function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", year: "numeric", timeZone }).format(
    new Date(iso),
  )
}

function bookingLines(section: ProfileData["booking"], timeZone: string): string[] {
  if (section.status === "unavailable") return ["📅 *Booking:* temporarily unavailable"]
  const booking = section.value
  if (!booking) return ["📅 *Booking:* none upcoming"]

  const lines = [`📅 *Booking:* ${formatWhen(booking.startTime, timeZone)}`]
  if (booking.serviceName) lines.push(`   ${booking.serviceName}`)
  lines.push(`   Ref: ${booking.reference}`)
  return lines
}

function queueLines(section: ProfileData["queue"]): string[] {
  if (section.status === "unavailable") return ["🎟️ *Queue:* temporarily unavailable"]
  const entry = section.value
  if (!entry) return ["🎟️ *Queue:* not in the queue"]

  if (entry.status === "called") {
    return [`🎟️ *Queue:* you've been called${entry.ticketLabel ? ` (${entry.ticketLabel})` : ""} — please head in!`]
  }

  const header = entry.ticketLabel ? `🎟️ *Queue:* ticket ${entry.ticketLabel}` : "🎟️ *Queue:* you're in the queue"
  const lines = [header]
  if (entry.serviceName) lines.push(`   ${entry.serviceName}`)
  if (entry.position !== null) lines.push(`   Position: ${entry.position}`)
  if (entry.etaMinutes !== null) {
    lines.push(entry.etaMinutes <= 0 ? "   You're up next" : `   Estimated wait: ~${entry.etaMinutes} min`)
  }
  return lines
}

function visitLines(section: ProfileData["visits"], timeZone: string): string[] {
  if (section.status === "unavailable") return ["✂️ *Visits:* temporarily unavailable"]
  const { totalVisits, lastVisitAt } = section.value
  if (totalVisits === 0) return ["✂️ *Visits:* none yet"]

  const lines = [`✂️ *Visits:* ${totalVisits}`]
  if (lastVisitAt) lines.push(`   Last visit: ${formatDay(lastVisitAt, timeZone)}`)
  return lines
}

function buildProfileMessage(data: ProfileData): string {
  const title = data.shopName ? `👤 *${data.shopName} Profile*` : "👤 *Your Profile*"
  const hello = data.firstName ? `Hi ${data.firstName}! Here's where you stand:` : "Here's where you stand:"

  return [
    title,
    hello,
    "",
    ...bookingLines(data.booking, data.timeZone),
    "",
    ...queueLines(data.queue),
    "",
    ...visitLines(data.visits, data.timeZone),
  ].join("\n")
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function handleProfile(
  tenantId: string,
  _intent: RoutedIntent,
  message: IncomingMessage,
): Promise<ActionResult> {
  const data = await buildProfileData(tenantId, message.from)
  const reply = buildProfileMessage(data) + (await getTenantWebLinkNote(tenantId).catch(() => ""))

  return {
    reply,
    buttons: [],
    nextState: null,
    // Same four-row menu as the greeting: Book Now / Join Queue /
    // Check Status / Cancel Now. Row taps are routed by id upstream.
    followUp: [buildServicesListMessage("What would you like to do next? 👇")],
  }
}

export const profileService = {
  handleProfile,
}
