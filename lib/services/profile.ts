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
 *   Shisha session → shisha_sessions       (live session, via shisha.ts)
 *   Visit history   → billable_visits      (one row per real completed visit)
 *   Shop name       → tenant_branding.display_name, falling back to tenants.name
 *
 * MODULE SWITCHES: a section only exists for a product the shop has switched
 * ON (tenant_modules: Booking, Queue, Shisha). A switched-off product is not
 * read and not shown, and neither are its follow-up menu rows. Visit history
 * counts Booking/Queue visits, so it needs at least one of those two on.
 * Fails closed: if the switches can't be read, nothing optional is shown.
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
import { getEnabledProducts } from "@/lib/services/plans"
import { getShishaProfileSession } from "@/lib/services/shisha"
import type { ActiveSessionSummary } from "@/lib/services/messages/shisha"
import { getQueueSimulation, formatQueueTicketNumber } from "@/lib/services/queue"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { buildServicesListMessage, MENU_ROW_IDS } from "@/lib/whatsapp/utils/services-list"
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

/** Which products this shop runs (tenant_modules). Decides which sections exist. */
interface ShownProducts {
  booking: boolean
  queue: boolean
  shisha: boolean
}

interface ProfileData {
  shopName: string | null
  timeZone: string
  firstName: string | null
  show: ShownProducts
  booking: Section<UpcomingBooking | null>
  queue: Section<ActiveQueueEntry | null>
  shisha: Section<ActiveSessionSummary | null>
  visits: Section<VisitSummary>
}

const NOTHING_SHOWN: ShownProducts = { booking: false, queue: false, shisha: false }

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

/**
 * bookings / queue_entries reach `services` both directly (service_id) and via
 * the booking_services / queue_entry_services join tables, so a bare
 * `services ( name )` embed is ambiguous (PostgREST HTTP 300, PGRST201).
 * Embeds below name the FK; this builds "A + B" from the ordered join rows,
 * falling back to the direct service for older single-service rows.
 */
function serviceNameFrom(
  links: { position: number | null; services: { name: string } | { name: string }[] | null }[] | null | undefined,
  direct: { name: string } | { name: string }[] | null | undefined,
): string | null {
  const names = [...(links ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((l) => joinedName(l.services))
    .filter((n): n is string => Boolean(n))
  return names.length > 0 ? names.join(" + ") : joinedName(direct)
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
    .select(
      "booking_reference, start_time, " +
        "services!bookings_service_id_fkey ( name ), " +
        "booking_services ( position, services ( name ) )",
    )
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
    booking_services: { position: number | null; services: { name: string } | { name: string }[] | null }[] | null
  }

  return {
    reference: row.booking_reference,
    serviceName: serviceNameFrom(row.booking_services, row.services),
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
    .select(
      "id, status, ticket_number, " +
        "services!queue_entries_service_id_fkey ( name ), " +
        "queue_entry_services ( position, services ( name ) )",
    )
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
    queue_entry_services: { position: number | null; services: { name: string } | { name: string }[] | null }[] | null
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
    serviceName: serviceNameFrom(row.queue_entry_services, row.services),
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

  // No DB connection: nothing can be read, and we can't tell which products the
  // shop runs, so show no sections (fail closed) rather than guess.
  if (!supabase) {
    return {
      shopName: null,
      timeZone: "Africa/Johannesburg",
      firstName: null,
      show: NOTHING_SHOWN,
      booking: unavailable(),
      queue: unavailable(),
      shisha: unavailable(),
      visits: unavailable(),
    }
  }

  let customer: Customer | null = null
  try {
    customer = await getCustomer(tenantId, phone)
  } catch (error) {
    console.error("[profile] getCustomer failed", { tenantId, error })
  }

  const [shopNameResult, timeZoneResult, products] = await Promise.all([
    Promise.allSettled([loadShopName(supabase, tenantId)]).then((r) => r[0]),
    Promise.allSettled([getTenantTimezone(supabase, tenantId)]).then((r) => r[0]),
    getEnabledProducts(supabase, tenantId),
  ])

  const shopName = shopNameResult.status === "fulfilled" ? shopNameResult.value : null
  const timeZone = timeZoneResult.status === "fulfilled" ? timeZoneResult.value : "Africa/Johannesburg"
  const show: ShownProducts = { booking: products.booking, queue: products.queue, shisha: products.shisha }
  const showVisits = show.booking || show.queue

  // Brand-new number with no tenant_customers row: nothing to look up, and
  // that is a real answer ("nothing yet"), not a failure.
  if (!customer) {
    return {
      shopName,
      timeZone,
      firstName: null,
      show,
      booking: { status: "ok", value: null },
      queue: { status: "ok", value: null },
      shisha: { status: "ok", value: null },
      visits: { status: "ok", value: { totalVisits: 0, lastVisitAt: null } },
    }
  }

  const customerId = customer.id
  // A switched-off product is never read: its tables aren't touched at all.
  const skipped = <T,>(value: T): Promise<T> => Promise.resolve(value)
  const [bookingResult, queueResult, shishaResult, visitsResult] = await Promise.allSettled([
    show.booking ? readUpcomingBooking(supabase, tenantId, customerId) : skipped(null),
    show.queue ? readActiveQueueEntry(supabase, tenantId, customerId) : skipped(null),
    show.shisha ? getShishaProfileSession(tenantId, phone) : skipped(null),
    showVisits ? readVisitSummary(supabase, tenantId, customerId) : skipped({ totalVisits: 0, lastVisitAt: null }),
  ])

  for (const [label, result] of [
    ["booking", bookingResult],
    ["queue", queueResult],
    ["shisha", shishaResult],
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
    show,
    booking: settled(bookingResult),
    queue: settled(queueResult),
    shisha: settled(shishaResult),
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

function formatRemaining(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(clamped / 60)}m ${(clamped % 60).toString().padStart(2, "0")}s`
}

const SHISHA_STATUS_LABEL: Record<ActiveSessionSummary["status"], string> = {
  active: "active",
  refill: "refilling",
  paused: "paused",
  expired: "expired",
}

function shishaLines(section: ProfileData["shisha"]): string[] {
  if (section.status === "unavailable") return ["💨 *Shisha:* temporarily unavailable"]
  const session = section.value
  if (!session) return ["💨 *Shisha:* no active session"]

  const lines = [`💨 *Shisha:* session ${SHISHA_STATUS_LABEL[session.status]}`]
  lines.push(`   ${session.flavourName}${session.locationName ? ` · ${session.locationName}` : ""}`)
  lines.push(`   Time left: ${formatRemaining(session.remainingTimeSeconds)}`)
  if (session.refillCount > 0) lines.push(`   Refills: ${session.refillCount}`)
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

  // Only the products the shop runs get a section; blocks are separated by a blank line.
  const blocks: string[][] = []
  if (data.show.booking) blocks.push(bookingLines(data.booking, data.timeZone))
  if (data.show.queue) blocks.push(queueLines(data.queue))
  if (data.show.shisha) blocks.push(shishaLines(data.shisha))
  if (data.show.booking || data.show.queue) blocks.push(visitLines(data.visits, data.timeZone))

  if (blocks.length === 0) return [title, "", "There's nothing to show on your profile here yet."].join("\n")

  const hello = data.firstName ? `Hi ${data.firstName}! Here's where you stand:` : "Here's where you stand:"
  return [title, hello, "", ...blocks.flatMap((lines, i) => (i === 0 ? lines : ["", ...lines]))].join("\n")
}

// ============================================================================
// FOLLOW-UP MENU
// ============================================================================

/**
 * The same menu as the greeting, minus:
 *  - the rows this screen already covers (Check Status, My Profile: the profile
 *    shows the booking and queue spot, and they're already looking at it), and
 *  - the rows for products the shop has switched OFF (Book Now / Reschedule
 *    without Booking, Join Queue without Queue, Cancel Now with neither).
 * The Shisha Lounge row appears when Shisha is on. Filtered by row id, so the
 * greeting menu is untouched. Returns null when no row is left to offer.
 * (Mirrors hiddenMenuRows() in action-router.ts, which can't be imported here
 * without a circular import.)
 */
function buildProfileFollowUp(bodyText: string, show: ShownProducts) {
  const menu = buildServicesListMessage(bodyText, { shisha: show.shisha })
  const hidden = new Set<string>([MENU_ROW_IDS.status, MENU_ROW_IDS.profile])
  if (!show.booking) {
    hidden.add(MENU_ROW_IDS.book)
    hidden.add(MENU_ROW_IDS.reschedule)
  }
  if (!show.queue) hidden.add(MENU_ROW_IDS.queue)
  if (!show.booking && !show.queue) hidden.add(MENU_ROW_IDS.cancel)
  if (!menu.list) return menu

  const sections = menu.list.sections
    .map((section) => ({ ...section, rows: section.rows.filter((row) => !hidden.has(row.id)) }))
    .filter((section) => section.rows.length > 0)
  return sections.length > 0 ? { ...menu, list: { ...menu.list, sections } } : null
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
  const followUp = buildProfileFollowUp("What would you like to do next? 👇", data.show)

  return {
    reply,
    buttons: [],
    nextState: null,
    // The greeting menu without Check Status and My Profile, and without any
    // product the shop has switched off. Row taps are routed by id upstream.
    followUp: followUp ? [followUp] : [],
  }
}

export const profileService = {
  handleProfile,
}
