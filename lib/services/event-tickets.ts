// lib/services/event-tickets.ts
/**
 * Events & tickets — WhatsApp side, multi-tenant, module-gated on "events".
 * ----------------------------------------------------------------------------
 * NOT the Rands tickets.* files. Those sat on purchases / tickets / wallet_transactions /
 * Yoco and a registration gate. This platform's events live in `events`,
 * `event_ticket_types`, `event_orders`, `event_tickets` (the same tables the admin
 * Events screens, box office and gate scanner use), keyed by tenant_id, with the
 * customer being a tenant_customers row.
 *
 * PHASE 1 (this file): READ-ONLY.
 *   - "Events": what is on sale at this shop, with tiers, prices and what is left
 *   - "My tickets": the customer's own live tickets, with the number the gate scans
 * It never writes, so it cannot sell, charge or issue anything.
 *
 * PHASE 2 (buying on WhatsApp, not built): needs a service-role purchase function in
 * the database first. The existing event_purchase_ticket / event_issue_box_office_tickets /
 * wallet_charge all start with `if auth.uid() is null then raise`, and the bot has no signed-in
 * user. See supabase/proposed/event_purchase_ticket_whatsapp.sql. Until then BUY_HELP below
 * is the one line that tells customers how to buy.
 *
 * STATELESS: nextState is always null; menu taps are routed by id in action-router.ts, and the
 * two buttons ("My Tickets" / "Events") come back as typed text that the intent router's
 * exact-phrase fast path maps to the "events" intent.
 * MODULE GATE: action-router.ts gates the row / typed intent, and handle() checks the switch
 * again itself (same belt-and-braces as shisha and passport).
 * PRIVACY: only ever reads tickets of message.from's own customer record (or tickets issued to
 * that exact number at the box office). No way to look up another number's tickets.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getCustomer } from "@/lib/services/tenant-customer"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { isModuleEnabled } from "@/lib/tenant/modules"

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_EVENTS_SHOWN = 5
const MAX_TICKETS_SHOWN = 10
/** An event with no end time is treated as still on for this long after it starts. */
const OPEN_ENDED_EVENT_HOURS = 6
const DEFAULT_TZ = "Africa/Johannesburg"

/** Replace this line when buying on WhatsApp is wired (Phase 2). */
const BUY_HELP = "To buy tickets, ask a team member at the shop or use the shop's online page."

const UNAVAILABLE_REPLY = "Sorry, I couldn't load that right now. Please try again in a moment."

/** Typed (or button) text that means "show me my tickets" rather than "show me the events". */
const MY_TICKETS_PATTERN = /\b(my tickets?|check my tickets?|view tickets?|my events?)\b/

// ============================================================================
// TYPES
// ============================================================================

interface EventRow {
  id: string
  name: string
  location: string | null
  start_time: string
  end_time: string | null
}

interface TierRow {
  id: string
  event_id: string
  name: string
  price: number | string
  capacity: number
  sold: number
}

interface TicketRow {
  ticket_number: string
  event_id: string
  ticket_type_id: string
  status: string
  entries_allowed: number
  entries_used: number
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/** True while the event is still on or yet to start. */
function isStillOn(event: Pick<EventRow, "start_time" | "end_time">, nowMs: number): boolean {
  const end = event.end_time
    ? Date.parse(event.end_time)
    : Date.parse(event.start_time) + OPEN_ENDED_EVENT_HOURS * 3_600_000
  return end > nowMs
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-ZA", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(new Date(iso))
  } catch {
    return ""
  }
}

function formatPrice(price: number): string {
  if (price <= 0) return "Free"
  const whole = Math.abs(price % 1) < 0.005
  return `R${price.toFixed(whole ? 0 : 2)}`
}

/** Events on sale (status active) that have not finished, soonest first. Throws on a database error. */
async function readOnSaleEvents(supabase: SupabaseClient, tenantId: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select("id, name, location, start_time, end_time")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    // A day of slack so a long-running event that started yesterday still shows; isStillOn does the exact cut.
    .gte("start_time", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .order("start_time", { ascending: true })
    .limit(20)
  if (error) throw new Error(`Failed to read events: ${error.message}`)
  const now = Date.now()
  return ((data ?? []) as EventRow[]).filter((e) => isStillOn(e, now))
}

// ============================================================================
// EVENTS LIST
// ============================================================================

function tierLine(t: TierRow): string {
  const left = Math.max(t.capacity - t.sold, 0)
  const status = left === 0 ? "sold out" : left <= 10 ? `only ${left} left` : `${left} left`
  return `${t.name} · ${formatPrice(Number(t.price) || 0)} (${status})`
}

async function buildEventsReply(supabase: SupabaseClient, tenantId: string, timeZone: string): Promise<ActionResult> {
  const events = (await readOnSaleEvents(supabase, tenantId)).slice(0, MAX_EVENTS_SHOWN)

  if (events.length === 0) {
    return {
      reply: "🎟️ *Events*\n\nThere are no events on sale right now. Check back soon!",
      buttons: ["My Tickets", "Main Menu"],
      nextState: null,
    }
  }

  const { data: tierData, error } = await supabase
    .from("event_ticket_types")
    .select("id, event_id, name, price, capacity, sold")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .in("event_id", events.map((e) => e.id))
    .order("sort_order", { ascending: true })
  if (error) throw new Error(`Failed to read ticket types: ${error.message}`)
  const tiers = (tierData ?? []) as TierRow[]

  const blocks = events.map((event, i) => {
    const lines = [`${i + 1}. *${event.name}*`, `   📅 ${formatWhen(event.start_time, timeZone)}`]
    if (event.location) lines.push(`   📍 ${event.location}`)
    const eventTiers = tiers.filter((t) => t.event_id === event.id)
    if (eventTiers.length > 0) lines.push(...eventTiers.map((t) => `   🎟️ ${tierLine(t)}`))
    return lines.join("\n")
  })

  return {
    reply: ["🎟️ *Upcoming events*", "", blocks.join("\n\n"), "", BUY_HELP].join("\n"),
    buttons: ["My Tickets", "Main Menu"],
    nextState: null,
  }
}

// ============================================================================
// MY TICKETS
// ============================================================================

/** Customers' live tickets: issued (not yet fully used) for events that are still on. */
async function readUpcomingTickets(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string | null,
  phone: string,
): Promise<{ tickets: TicketRow[]; events: Map<string, EventRow>; types: Map<string, string> }> {
  // Own customer record, plus anything issued to exactly this number at the box office.
  const safePhone = phone.replace(/[^0-9+]/g, "")
  const filters = [customerId ? `customer_id.eq.${customerId}` : null, safePhone ? `customer_phone.eq.${safePhone}` : null].filter(
    (f): f is string => f !== null,
  )
  if (filters.length === 0) return { tickets: [], events: new Map(), types: new Map() }

  const { data, error } = await supabase
    .from("event_tickets")
    .select("ticket_number, event_id, ticket_type_id, status, entries_allowed, entries_used")
    .eq("tenant_id", tenantId)
    .eq("status", "issued")
    .or(filters.join(","))
    .order("issued_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(`Failed to read tickets: ${error.message}`)
  const rows = (data ?? []) as TicketRow[]
  if (rows.length === 0) return { tickets: [], events: new Map(), types: new Map() }

  const eventIds = [...new Set(rows.map((t) => t.event_id))]
  const typeIds = [...new Set(rows.map((t) => t.ticket_type_id))]
  const [eventRes, typeRes] = await Promise.all([
    supabase.from("events").select("id, name, location, start_time, end_time, status").eq("tenant_id", tenantId).in("id", eventIds),
    supabase.from("event_ticket_types").select("id, name").eq("tenant_id", tenantId).in("id", typeIds),
  ])
  if (eventRes.error) throw new Error(`Failed to read ticket events: ${eventRes.error.message}`)
  if (typeRes.error) throw new Error(`Failed to read ticket tiers: ${typeRes.error.message}`)

  const now = Date.now()
  const events = new Map<string, EventRow>()
  for (const e of (eventRes.data ?? []) as Array<EventRow & { status: string }>) {
    // A cancelled or finished event's tickets are not "upcoming".
    if (e.status !== "cancelled" && isStillOn(e, now)) events.set(e.id, e)
  }
  const types = new Map<string, string>(((typeRes.data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]))

  const tickets = rows
    .filter((t) => events.has(t.event_id))
    .sort((a, b) => Date.parse(events.get(a.event_id)!.start_time) - Date.parse(events.get(b.event_id)!.start_time))
  return { tickets, events, types }
}

/** How many live tickets this customer has. Used by the profile screen. Throws on a database error. */
export async function countUpcomingTickets(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  phone: string,
): Promise<number> {
  const { tickets } = await readUpcomingTickets(supabase, tenantId, customerId, phone)
  return tickets.length
}

async function buildMyTicketsReply(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string | null,
  phone: string,
  timeZone: string,
): Promise<ActionResult> {
  const { tickets, events, types } = await readUpcomingTickets(supabase, tenantId, customerId, phone)

  if (tickets.length === 0) {
    return {
      reply: ["🎟️ *My tickets*", "", "You don't have any upcoming tickets.", "", BUY_HELP].join("\n"),
      buttons: ["Events", "Main Menu"],
      nextState: null,
    }
  }

  const shown = tickets.slice(0, MAX_TICKETS_SHOWN)
  const blocks = shown.map((t, i) => {
    const event = events.get(t.event_id)!
    const lines = [
      `${i + 1}. ${types.get(t.ticket_type_id) ?? "Ticket"} — *${event.name}*`,
      `   📅 ${formatWhen(event.start_time, timeZone)}`,
      `   Ticket #: ${t.ticket_number} • Valid`,
    ]
    if (t.entries_allowed > 1) lines.push(`   Entries used: ${t.entries_used} of ${t.entries_allowed}`)
    return lines.join("\n")
  })
  const more = tickets.length > shown.length ? `\n\n…and ${tickets.length - shown.length} more.` : ""

  return {
    reply: ["🎟️ *My tickets*", "", blocks.join("\n\n") + more, "", "Show your ticket number at the gate."].join("\n"),
    buttons: ["Events", "Main Menu"],
    nextState: null,
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function handle(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  const reply = (text: string): ActionResult => ({ reply: text, buttons: [], nextState: null })

  // Second lock behind the router's gate. Fails closed (isModuleEnabled returns false on error).
  if (!(await isModuleEnabled(tenantId, "events"))) {
    return reply("Sorry, that service isn't available right now.")
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return reply(UNAVAILABLE_REPLY)

  const typed = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()
  const wantsMyTickets = MY_TICKETS_PATTERN.test(typed)

  try {
    const timeZone = await getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ)
    if (!wantsMyTickets) return await buildEventsReply(supabase, tenantId, timeZone)

    const customer = await getCustomer(tenantId, message.from)
    return await buildMyTicketsReply(supabase, tenantId, customer?.id ?? null, message.from, timeZone)
  } catch (error) {
    console.error("[event-tickets] failed to load", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return reply(UNAVAILABLE_REPLY)
  }
}

export const eventTicketsService = {
  handle,
}
