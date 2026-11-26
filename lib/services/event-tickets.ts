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
 * WHAT IT DOES
 *   - "Events": what is on sale at this shop, with tiers, prices and what is left
 *   - "My tickets": the customer's own live tickets, with the number the gate scans
 *   - "Buy Tickets": event -> tier -> quantity -> pay. Pay from the Passport balance (one database
 *     transaction), or by card on the SHOP'S OWN Yoco account (we only start the checkout here; the
 *     signed webhook issues the tickets once the payment is verified). Free tiers need no payment.
 *   - All prices and availability come from the database (event_quote_whatsapp), never from memory.
 *
 *   - VVIP tables (module "vvip"): an event with tables on sale gets a "VVIP tables" row in its ticket list,
 *     and typing "tables" / "book a table" goes straight there. The whole table flow lives in vvip-tables.ts.
 *
 * STATES (all prefixed "events_"; this service owns them, module-gated on "events"):
 *   events_choose_event -> events_choose_tier -> events_quantity -> events_choose_payment
 *   events_tbl_event -> events_tbl_package -> events_tbl_payment   (tables; handled by vvip-tables.ts)
 *   Tap-only: event and ticket are WhatsApp lists (ids evt_event:/evt_tier:), quantity is 1/2/"3 or more"
 *   buttons, payment is the Pay Now link. Typed numbers still work for older chats.
 * Menu taps are routed by id in action-router.ts; the buttons come back as typed text that the intent
 * router's exact-phrase fast path maps to the "events" intent.
 * MODULE GATE: action-router.ts gates the row / typed intent, and handle() checks the switch
 * again itself (same belt-and-braces as shisha and passport).
 * PRIVACY: only ever reads tickets of message.from's own customer record (or tickets issued to
 * that exact number at the box office). No way to look up another number's tickets.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getCustomer } from "@/lib/services/tenant-customer"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { formatPassportMoney } from "@/lib/services/passport"
import { getCardOption } from "@/lib/payments/card"
import { generateTicketQrCode, getOrderTicketQrs } from "@/lib/whatsapp/qr-generator"
import { getTenantDisplayName, scheduleOrderTicketImages } from "@/lib/whatsapp/ticket-image"
import { loadEventSalesRules, loadEventTicketDelivery } from "@/lib/services/event-settings"
import { buildChoiceList, clip } from "@/lib/whatsapp/utils/choice-list"
import {
  buyWithPassport,
  getEventPaymentOptions,
  quoteEventPurchase,
  startEventCardCheckout,
} from "@/lib/payments/event-checkout"
import { loadTablePackages, type TablePackage } from "@/lib/payments/vvip-checkout"
import {
  beginTables,
  handleTableState,
  ID_TABLES,
  packageStep,
  readMyTableLines,
  tablesRowFor,
} from "@/lib/services/vvip-tables"

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_EVENTS_SHOWN = 5
const MAX_TICKETS_SHOWN = 10
/** QR images attached to "My Tickets" (the rest are still listed by number). */
const MAX_QR_IN_LIST = 5
/** An event with no end time is treated as still on for this long after it starts. */
const OPEN_ENDED_EVENT_HOURS = 6
const DEFAULT_TZ = "Africa/Johannesburg"

/** Shown when this shop can't take payment on WhatsApp (no Passport, no Yoco). */
const BUY_HELP = "To buy tickets, ask a team member at the shop or use the shop's online page."

export const EVENT_STATE_CHOOSE_EVENT = "events_choose_event"
export const EVENT_STATE_CHOOSE_TIER = "events_choose_tier"
export const EVENT_STATE_QUANTITY = "events_quantity"
export const EVENT_STATE_CHOOSE_PAYMENT = "events_choose_payment"

const MAX_PER_PURCHASE = 10
const BUY_PATTERN = /\bbuy\b/
/** "tables", "book a table", "vip tables", "vvip": the customer wants a VVIP table, not a ticket. */
const TABLE_PATTERN = /\b(tables?|vip|vvip)\b/
/** Button label for paying on the secure online payment page (older chats may still hold a "Card" button). */
const PAY_NOW_BUTTON = "Pay Now"

// Tap-only purchase: ids carried by the list rows (WhatsApp returns them as message.interactiveId).
// The "evt_" prefix is also what action-router.ts uses to keep these taps out of its reset-word check.
const ID_EVENT = "evt_event:"
const ID_TIER = "evt_tier:"
const ID_MY_TICKETS = "evt_my"
/** One list holds 10 rows; one is kept for "My tickets". */
const MAX_TIER_ROWS = 9
/** Third quantity button when more than 3 tickets can be bought; the customer then types the number. */
const QTY_MORE_BUTTON = "3 or more"

const CANCEL_PATTERN = /^(cancel|no|stop|back|menu|main menu|nevermind|never mind)[.!]*$/i

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
  id: string
  qr_token: string | null
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
  // The shop's "stop selling N minutes before the start" rule: closed events leave the list (the
  // database refuses the sale too, this just stops us offering what can't be bought).
  const { stopSalesMinutesBefore } = await loadEventSalesRules(supabase, tenantId)
  const cutoffMs = stopSalesMinutesBefore * 60_000
  return ((data ?? []) as EventRow[]).filter((e) => isStillOn(e, now) && (cutoffMs === 0 || now < Date.parse(e.start_time) - cutoffMs))
}

/** How many more tickets this customer may buy for the event under the shop's per-customer limit (null = no limit). */
async function remainingForCustomer(supabase: SupabaseClient, tenantId: string, eventId: string, customerId: string, limit: number | null): Promise<number | null> {
  if (limit == null) return null
  const { count } = await supabase
    .from("event_tickets")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("event_id", eventId)
    .eq("customer_id", customerId)
    .in("status", ["issued", "used"])
  return Math.max(limit - (count ?? 0), 0)
}

// ============================================================================
// EVENTS LIST
// ============================================================================

/** Offer buying only when this shop can take payment here: Passport on, a card provider connected, or a free tier. */
async function canBuyHere(supabase: SupabaseClient, tenantId: string, tiers: TierRow[], hasFreeTables = false): Promise<boolean> {
  return (
    tiers.some((t) => Number(t.price) <= 0 && t.capacity > t.sold) ||
    // A free table needs no payment; a paid one needs Passport or a card (the next two lines).
    hasFreeTables ||
    (await isModuleEnabled(tenantId, "wallet")) ||
    Boolean(await getCardOption(supabase, tenantId))
  )
}

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

  // Offer "Buy Tickets" only when this shop can take payment here: Passport on, a card provider connected, or a free tier.
  const canBuy = await canBuyHere(supabase, tenantId, tiers)

  return {
    reply: ["🎟️ *Upcoming events*", "", blocks.join("\n\n"), "", canBuy ? "Tap *Buy Tickets* to get yours." : BUY_HELP].join("\n"),
    buttons: canBuy ? ["Buy Tickets", "My Tickets", "Main Menu"] : ["My Tickets", "Main Menu"],
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
    .select("id, qr_token, ticket_number, event_id, ticket_type_id, status, entries_allowed, entries_used")
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
  const delivery = await loadEventTicketDelivery(supabase, tenantId)
  // Upcoming VVIP tables of this customer (a table has a reference, not a QR; [] when none or VVIP is off).
  const tableLines = customerId ? await readMyTableLines(supabase, tenantId, customerId, timeZone) : []

  if (tickets.length === 0) {
    return {
      reply:
        tableLines.length > 0
          ? ["🎟️ *My tickets*", "", "You don't have any upcoming tickets.", "", "🍾 *Your tables*", ...tableLines, "", "Show your reference at the venue."].join("\n")
          : ["🎟️ *My tickets*", "", "You don't have any upcoming tickets.", "", BUY_HELP].join("\n"),
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

  // QR images for the first few tickets (best effort; the numbers above always work at the gate).
  // Skipped when the shop only sends the ticket image: that image is in the chat from when they bought.
  const media: { url: string; caption: string }[] = []
  for (const t of delivery.qr ? shown.slice(0, MAX_QR_IN_LIST) : []) {
    if (!t.qr_token) continue
    try {
      media.push({ url: await generateTicketQrCode(tenantId, t.id, t.qr_token), caption: `Ticket #${t.ticket_number}` })
    } catch (error) {
      console.error("[event-tickets] QR failed in My Tickets", { tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    reply: [
      "🎟️ *My tickets*",
      "",
      blocks.join("\n\n") + more,
      "",
      delivery.qr ? "Show the QR code (or the ticket number) at the gate." : "Show your ticket image (or the ticket number) at the gate.",
      ...(tableLines.length > 0 ? ["", "🍾 *Your tables*", ...tableLines, "", "Show your reference at the venue."] : []),
    ].join("\n"),
    buttons: ["Events", "Main Menu"],
    nextState: null,
    ...(media.length > 0 ? { media } : {}),
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

// ============================================================================
// BUYING
// ============================================================================

type StateData = Record<string, unknown>

const stay = (state: string, data: StateData, reply: string, buttons: string[] = []): ActionResult => ({
  reply,
  buttons,
  nextState: { state, data },
})
const finish = (reply: string, buttons: string[] = []): ActionResult => ({ reply, buttons, nextState: null })

function parseChoice(raw: string, max: number): number | null {
  const m = /^\s*(\d{1,2})[.)]?\s*$/.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= max ? n : null
}

async function readTier(supabase: SupabaseClient, tenantId: string, tierId: string): Promise<TierRow | null> {
  const { data, error } = await supabase
    .from("event_ticket_types")
    .select("id, event_id, name, price, capacity, sold, is_active")
    .eq("tenant_id", tenantId)
    .eq("id", tierId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read ticket type: ${error.message}`)
  const row = data as (TierRow & { is_active: boolean }) | null
  return row && row.is_active ? row : null
}

async function readSellableTiers(supabase: SupabaseClient, tenantId: string, eventId: string): Promise<TierRow[]> {
  const { data, error } = await supabase
    .from("event_ticket_types")
    .select("id, event_id, name, price, capacity, sold")
    .eq("tenant_id", tenantId)
    .eq("event_id", eventId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
  if (error) throw new Error(`Failed to read ticket types: ${error.message}`)
  return ((data ?? []) as TierRow[]).filter((t) => t.capacity > t.sold)
}

/** The id of a tapped list row with this prefix, or null (typed text, or some other tap). */
function tappedId(message: IncomingMessage, prefix: string): string | null {
  const id = message.interactiveId
  return id && id.startsWith(prefix) ? id.slice(prefix.length) : null
}

/** "General · R150", with "Only 15 left" shown only when stock is low. The name is cut first so the price always shows. */
function tierRow(t: TierRow) {
  const price = formatPrice(Number(t.price) || 0)
  const left = Math.max(t.capacity - t.sold, 0)
  return {
    id: `${ID_TIER}${t.id}`,
    title: `${clip(t.name, 24 - 3 - price.length)} · ${price}`,
    ...(left <= 10 ? { description: `Only ${left} left` } : {}),
  }
}

const MY_TICKETS_ROW = { title: "More", rows: [{ id: ID_MY_TICKETS, title: "My tickets" }] }

/** Event header, then one list: tap a ticket. Replaces the old "Which ticket? Reply with the number" screen. */
function beginTierStep(event: EventRow, tiers: TierRow[], timeZone: string, packages: TablePackage[] = []): ActionResult {
  // Tables for this event: its own row in the list (one of the 10 rows WhatsApp allows, so one ticket row less).
  const tablesRow = tablesRowFor(event.id, packages)
  const shown = tiers.slice(0, MAX_TIER_ROWS - (tablesRow ? 1 : 0))
  const header = [
    `🎟️ *${event.name}*`,
    `📅 ${formatWhen(event.start_time, timeZone)}`,
    ...(event.location ? [`📍 ${event.location}`] : []),
  ].join("\n")
  return {
    // Empty main reply on purpose: send-action-result.ts skips it, so the header lives in the list body.
    ...stay(EVENT_STATE_CHOOSE_TIER, { eventId: event.id, tierIds: shown.map((t) => t.id) }, ""),
    followUp: [
      buildChoiceList(`${header}\n\nWhich ticket would you like?`, "Choose ticket", [
        { title: "Tickets", rows: shown.map(tierRow) },
        ...(tablesRow ? [{ title: "VVIP", rows: [tablesRow] }] : []),
        MY_TICKETS_ROW,
      ]),
    ],
  }
}

/**
 * One event: its ticket list (with a tables row when it has tables). An event that has tables but no ticket
 * left goes straight to its tables.
 */
function eventStep(event: EventRow, tiers: TierRow[], packages: TablePackage[], timeZone: string): ActionResult {
  const mine = packages.filter((p) => p.eventId === event.id)
  if (tiers.length === 0 && mine.length > 0) return packageStep(mine, timeZone)
  return beginTierStep(event, tiers, timeZone, packages)
}

/** 1 / 2 / "3 or more" buttons (only as many as are actually left). Only the big number is ever typed. */
function quantityStep(tier: TierRow, max: number): ActionResult {
  const buttons = max <= 3 ? Array.from({ length: max }, (_, i) => String(i + 1)) : ["1", "2", QTY_MORE_BUTTON]
  return stay(EVENT_STATE_QUANTITY, { tierId: tier.id, max }, `How many *${tier.name}* tickets?`, buttons)
}

/**
 * Starts the tap-only purchase: the ticket list (one event) or the event list (several).
 * With onlyIfPayable it returns null when there is nothing to buy or this shop cannot take
 * payment here, so the caller can fall back to the read-only events text.
 */
async function beginPurchase(
  supabase: SupabaseClient,
  tenantId: string,
  timeZone: string,
  opts: { onlyIfPayable?: boolean } = {},
): Promise<ActionResult | null> {
  const events = (await readOnSaleEvents(supabase, tenantId)).slice(0, MAX_EVENTS_SHOWN)
  // VVIP tables on sale (empty when the shop has VVIP off). An event counts if it has tickets OR tables.
  const packages = await loadTablePackages(supabase, tenantId)
  const withTiers: Array<{ event: EventRow; tiers: TierRow[] }> = []
  for (const event of events) {
    const tiers = await readSellableTiers(supabase, tenantId, event.id)
    if (tiers.length > 0 || packages.some((p) => p.eventId === event.id)) withTiers.push({ event, tiers })
  }

  if (withTiers.length === 0) {
    if (opts.onlyIfPayable) return null
    return finish("🎟️ *Buy tickets*\n\nThere are no tickets available right now.", ["My Tickets", "Main Menu"])
  }
  if (opts.onlyIfPayable && !(await canBuyHere(supabase, tenantId, withTiers.flatMap((x) => x.tiers), packages.some((p) => p.price <= 0)))) return null

  if (withTiers.length === 1) return eventStep(withTiers[0].event, withTiers[0].tiers, packages, timeZone)

  return {
    ...stay(EVENT_STATE_CHOOSE_EVENT, { eventIds: withTiers.map((x) => x.event.id) }, ""),
    followUp: [
      buildChoiceList("🎟️ *Upcoming events*\n\nWhich event would you like?", "Choose event", [
        {
          title: "Events",
          rows: withTiers.map(({ event }) => ({
            id: `${ID_EVENT}${event.id}`,
            title: event.name,
            description: [formatWhen(event.start_time, timeZone), event.location].filter(Boolean).join(" · "),
          })),
        },
        MY_TICKETS_ROW,
      ]),
    ],
  }
}

/** Confirmation text for an issued order. Shared by the bot (Passport) and the webhook (card). */
export async function buildOrderConfirmation(
  supabase: SupabaseClient,
  tenantId: string,
  orderId: string,
  heading = "🎉 *Your tickets are confirmed!*",
): Promise<string> {
  const { data: order, error } = await supabase
    .from("event_orders")
    .select("id, event_id, ticket_type_id, quantity, total, payment_method")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .maybeSingle()
  if (error || !order) throw new Error("order not found for confirmation")

  const [eventRes, typeRes, ticketRes, timeZone, shopName, delivery] = await Promise.all([
    supabase.from("events").select("name, start_time, location").eq("tenant_id", tenantId).eq("id", order.event_id).maybeSingle(),
    supabase.from("event_ticket_types").select("name").eq("tenant_id", tenantId).eq("id", order.ticket_type_id).maybeSingle(),
    supabase.from("event_tickets").select("ticket_number").eq("tenant_id", tenantId).eq("order_id", orderId).order("created_at", { ascending: true }),
    getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ),
    getTenantDisplayName(supabase, tenantId),
    loadEventTicketDelivery(supabase, tenantId),
  ])
  const event = eventRes.data as { name: string; start_time: string; location: string | null } | null
  const tier = (typeRes.data as { name: string } | null)?.name ?? "Ticket"
  const numbers = ((ticketRes.data ?? []) as Array<{ ticket_number: string }>).map((t) => t.ticket_number)

  const paid =
    Number(order.total) <= 0
      ? "Free"
      : order.payment_method === "wallet"
        ? `${formatPrice(Number(order.total))} · paid from your Passport`
        : order.payment_method === "card"
          ? `${formatPrice(Number(order.total))} · paid by card`
          : formatPrice(Number(order.total))

  const lines = [heading, ""]
  if (event) {
    lines.push(`*${event.name}*`, `📅 ${formatWhen(event.start_time, timeZone)}`)
    if (event.location) lines.push(`📍 ${event.location}`)
    lines.push("")
  }
  lines.push(`${order.quantity} × ${tier}`, paid, "", "*Your ticket numbers*", ...numbers.map((n, i) => `${i + 1}. ${n}`), "")
  // Wording follows what this shop sends (Event settings > Ticket): QR only, image only, or both.
  lines.push(delivery.qr ? "Show the QR code (or a ticket number) at the gate." : "Show your ticket image (or a ticket number) at the gate.")
  // The branded ticket image takes about 30 seconds, so tell the customer it is coming (see ticket-image.ts).
  // Skipped when the shop has switched ticket images off.
  if (delivery.image) {
    lines.push(
      "",
      `⏳ *${shopName}* is generating your ticket image. It will arrive here in about 30 seconds, so no need to worry.${delivery.qr ? " Your QR code already works." : " Your ticket number already works at the gate."}`,
    )
  }
  return lines.join("\n")
}

/** Confirmation text, then one QR image per ticket (sent after the text, see ActionResult.media). */
async function confirmedOrderReply(supabase: SupabaseClient, tenantId: string, orderId: string, phone: string): Promise<ActionResult> {
  const text = await buildOrderConfirmation(supabase, tenantId, orderId)
  // Plain QR codes only when the shop sends them; image-only shops get just the ticket image below.
  const delivery = await loadEventTicketDelivery(supabase, tenantId)
  const media = delivery.qr ? await getOrderTicketQrs(supabase, tenantId, orderId) : []
  // Runs after the reply (text + QR codes) has gone out, then sends the ticket images.
  scheduleOrderTicketImages(tenantId, orderId, phone)
  return { ...finish(text, ["My Tickets", "Main Menu"]), ...(media.length > 0 ? { media } : {}) }
}

/** One message: order summary + Yoco link. Used when card is the only way to pay, and after "Pay Now". */
async function cardCheckoutReply(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  quote: Parameters<typeof startEventCardCheckout>[0]["quote"],
  note?: string,
): Promise<ActionResult> {
  const card = await startEventCardCheckout({ supabase, tenantId, customerId, quote })
  if (!card.ok) return finish(card.message, ["Events", "Main Menu"])
  const testNote = card.mode === "test" ? "\n\n_Test mode: no real money is charged._" : ""
  return finish(
    [
      ...(note ? [note, ""] : []),
      "🧾 *Order summary*",
      `${quote.quantity} × ${quote.ticketTypeName} — ${quote.eventName}`,
      `*Total: ${formatPrice(quote.total)}*`,
      "",
      "💳 Tap the link to pay securely:",
      card.url,
      "",
      "Your tickets will be sent to you here as soon as the payment goes through.",
    ].join("\n") + testNote,
  )
}

/** Quote -> free ticket, or the "how would you like to pay" screen. */
async function proceedToPayment(
  supabase: SupabaseClient,
  tenantId: string,
  phone: string,
  customerId: string,
  tierId: string,
  quantity: number,
  note?: string,
): Promise<ActionResult> {
  const q = await quoteEventPurchase(supabase, tenantId, customerId, tierId, quantity)
  if (!q.ok) return finish(q.message, ["Events", "Main Menu"])
  const quote = q.quote

  // Free tier: no payment step. The database issues it directly.
  if (quote.total <= 0) {
    const res = await buyWithPassport({ supabase, tenantId, customerId, ticketTypeId: tierId, quantity, idempotencyKey: randomUUID() })
    if (!res.ok) return finish(res.message, ["Events", "Main Menu"])
    return await confirmedOrderReply(supabase, tenantId, res.orderId, phone)
  }

  const options = await getEventPaymentOptions(supabase, tenantId, customerId, quote.total)

  // Card is the only way to pay: no menu, send summary + link straight away.
  if (options.card && !options.passport.ok) {
    return await cardCheckoutReply(supabase, tenantId, customerId, quote, note)
  }

  const choices: string[] = []
  const lines = [
    ...(note ? [note, ""] : []),
    "🧾 *Order summary*",
    `${quote.quantity} × ${quote.ticketTypeName} — ${quote.eventName}`,
    `*Total: ${formatPrice(quote.total)}*`,
    "",
  ]

  if (options.passport.ok) {
    choices.push("Passport")
    lines.push(`💰 *Passport* (balance ${formatPassportMoney(options.passport.balance, options.passport.currency)})`)
  } else if (options.passport.reason === "low_balance") {
    lines.push(`Your Passport balance (${formatPassportMoney(options.passport.balance, options.passport.currency)}) is too low for this order.`)
  }
  if (options.card) {
    choices.push(PAY_NOW_BUTTON)
    lines.push("💳 *Online Payment* (Secure Payment page)")
  }

  if (choices.length === 0) {
    return finish(
      [...lines, "", "Online payment isn't available for this order right now.", BUY_HELP].join("\n"),
      ["Events", "Main Menu"],
    )
  }

  const buttons = [...choices, "Cancel"]
  lines.push("", "How would you like to pay?")
  return stay(
    EVENT_STATE_CHOOSE_PAYMENT,
    { tierId, quantity, total: quote.total, nonce: randomUUID(), buttons },
    lines.join("\n"),
    buttons,
  )
}

// ============================================================================
// STATE CONTINUATION
// ============================================================================

/** Owns "events_*" states. null = not mine. */
async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  if (!state.state.startsWith("events_")) return null

  if (!(await isModuleEnabled(tenantId, "events"))) return finish("Sorry, that service isn't available right now.")

  const typed = (message.text ?? message.contentSummary ?? "").trim()
  if (CANCEL_PATTERN.test(typed)) return finish("No problem, nothing was charged. Send *menu* whenever you need me.")

  const supabase = getSupabaseServerClient()
  if (!supabase) return finish(UNAVAILABLE_REPLY)
  const data = (state.data ?? {}) as StateData

  try {
    const customer = await getCustomer(tenantId, message.from)
    if (!customer) return finish(UNAVAILABLE_REPLY)
    const timeZone = await getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ)

    // "My tickets" row at the bottom of either list.
    if (message.interactiveId === ID_MY_TICKETS) {
      return await buildMyTicketsReply(supabase, tenantId, customer.id, message.from, timeZone)
    }

    // Table purchase steps (events_tbl_*) live in vvip-tables.ts.
    if (state.state.startsWith("events_tbl_")) {
      return await handleTableState({ supabase, tenantId, customerId: customer.id, state, message, typed, timeZone })
    }

    switch (state.state) {
      case EVENT_STATE_CHOOSE_EVENT: {
        const ids = (data.eventIds as string[] | undefined) ?? []
        // A list tap carries the event id; a typed number still works for old chats.
        const n = parseChoice(typed, ids.length)
        const eventId = tappedId(message, ID_EVENT) ?? (n !== null ? ids[n - 1] : null)
        if (!eventId) return stay(state.state, data, "Please pick an event from the list above (tap *Choose event*), or reply *cancel*.")
        const events = await readOnSaleEvents(supabase, tenantId)
        const event = events.find((e) => e.id === eventId)
        if (!event) return finish("Sorry, that event is no longer available.", ["Events", "Main Menu"])
        const tiers = await readSellableTiers(supabase, tenantId, event.id)
        const packages = await loadTablePackages(supabase, tenantId)
        if (tiers.length === 0 && !packages.some((p) => p.eventId === event.id)) return finish("Sorry, that event just sold out.", ["Events", "Main Menu"])
        return eventStep(event, tiers, packages, timeZone)
      }

      case EVENT_STATE_CHOOSE_TIER: {
        // The "🍾 VVIP tables" row of this event's list.
        const tablesEventId = tappedId(message, ID_TABLES)
        if (tablesEventId) {
          const mine = (await loadTablePackages(supabase, tenantId)).filter((p) => p.eventId === tablesEventId)
          if (mine.length === 0) return finish("Sorry, there are no tables left for that event.", ["Events", "Main Menu"])
          return packageStep(mine, timeZone)
        }
        const ids = (data.tierIds as string[] | undefined) ?? []
        const n = parseChoice(typed, ids.length)
        const tierId = tappedId(message, ID_TIER) ?? (n !== null ? ids[n - 1] : null)
        if (!tierId) return stay(state.state, data, "Please pick a ticket from the list above (tap *Choose ticket*), or reply *cancel*.")
        const tier = await readTier(supabase, tenantId, tierId)
        const left = tier ? Math.max(tier.capacity - tier.sold, 0) : 0
        if (!tier || left === 0) return finish("Sorry, that ticket just sold out.", ["Events", "Main Menu"])
        const rules = await loadEventSalesRules(supabase, tenantId)
        const remaining = await remainingForCustomer(supabase, tenantId, tier.event_id, customer.id, rules.maxPerCustomer)
        if (remaining !== null && remaining <= 0) {
          return finish(`Sorry, there's a limit of ${rules.maxPerCustomer} ticket${rules.maxPerCustomer === 1 ? "" : "s"} per person for this event, and you already have ${rules.maxPerCustomer === 1 ? "it" : "them"}.`, ["My Tickets", "Events", "Main Menu"])
        }
        const max = Math.min(rules.maxPerPurchase, left, remaining ?? Number.POSITIVE_INFINITY)
        // Only one left: nothing to ask, go straight to payment.
        if (max === 1) return await proceedToPayment(supabase, tenantId, message.from, customer.id, tier.id, 1)
        return quantityStep(tier, max)
      }

      case EVENT_STATE_QUANTITY: {
        const tierId = data.tierId as string | undefined
        const max = Number(data.max) || MAX_PER_PURCHASE
        if (!tierId) return finish(UNAVAILABLE_REPLY)
        // "3 or more" button: this is the only time the customer types a number.
        if (typed.toLowerCase() === QTY_MORE_BUTTON.toLowerCase()) {
          return stay(state.state, data, `Type how many you need (3 to ${max}).`)
        }
        const quantity = parseChoice(typed, max)
        if (quantity === null) return stay(state.state, data, `Please type a number from 1 to ${max}, or *cancel*.`)
        return await proceedToPayment(supabase, tenantId, message.from, customer.id, tierId, quantity)
      }

      case EVENT_STATE_CHOOSE_PAYMENT: {
        const tierId = data.tierId as string
        const quantity = Number(data.quantity)
        const shownTotal = Number(data.total)
        const nonce = data.nonce as string
        const buttons = (data.buttons as string[] | undefined) ?? ["Cancel"]
        const choice = typed.toLowerCase()
        const wantsPassport = choice.includes("passport")
        const wantsCard = choice.includes("pay now") || choice.includes("card") || choice.includes("online")
        if (!wantsPassport && !wantsCard) {
          return stay(state.state, data, `Please tap *Passport* or *${PAY_NOW_BUTTON}* (or reply *cancel*).`, buttons)
        }

        // Re-ask the database right before taking money: price and availability may have moved.
        const q = await quoteEventPurchase(supabase, tenantId, customer.id, tierId, quantity)
        if (!q.ok) return finish(q.message, ["Events", "Main Menu"])
        if (Math.abs(q.quote.total - shownTotal) > 0.001) {
          return await proceedToPayment(supabase, tenantId, message.from, customer.id, tierId, quantity, "⚠️ The price changed, so here is your updated order.")
        }

        if (wantsPassport) {
          if (!buttons.includes("Passport")) return stay(state.state, data, "Passport isn't available for this order. Please choose another option.", buttons)
          const res = await buyWithPassport({ supabase, tenantId, customerId: customer.id, ticketTypeId: tierId, quantity, idempotencyKey: nonce })
          if (!res.ok) return finish(res.message, ["Events", "Main Menu"])
          return await confirmedOrderReply(supabase, tenantId, res.orderId, message.from)
        }

        if (!buttons.includes(PAY_NOW_BUTTON) && !buttons.includes("Card")) return stay(state.state, data, "Online payment isn't available for this order. Please choose another option.", buttons)
        return await cardCheckoutReply(supabase, tenantId, customer.id, q.quote)
      }

      default:
        return null
    }
  } catch (error) {
    console.error("[event-tickets] purchase step failed", {
      tenantId,
      state: state.state,
      error: error instanceof Error ? error.message : String(error),
    })
    return finish(UNAVAILABLE_REPLY)
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function handle(tenantId: string, _intent: RoutedIntent, message: IncomingMessage): Promise<ActionResult> {
  // Second lock behind the router's gate. Fails closed (isModuleEnabled returns false on error).
  if (!(await isModuleEnabled(tenantId, "events"))) {
    return finish("Sorry, that service isn't available right now.")
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return finish(UNAVAILABLE_REPLY)

  const typed = (message.contentSummary ?? message.text ?? "").trim().toLowerCase()

  try {
    const timeZone = await getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ)

    if (MY_TICKETS_PATTERN.test(typed)) {
      const customer = await getCustomer(tenantId, message.from)
      return await buildMyTicketsReply(supabase, tenantId, customer?.id ?? null, message.from, timeZone)
    }

    const customer = await getCustomer(tenantId, message.from)

    // "tables" / "book a table" / "vip tables": straight to the tables (module and stock are checked inside).
    if (TABLE_PATTERN.test(typed) && customer) {
      return await beginTables(supabase, tenantId, timeZone)
    }

    if (BUY_PATTERN.test(typed) && customer) {
      const purchase = await beginPurchase(supabase, tenantId, timeZone)
      if (purchase) return purchase
    }

    // "Events" itself now goes straight to the tap list (the old read-only events text repeated
    // what the ticket list shows). Shops that can't take payment here keep the read-only view.
    if (customer) {
      const purchase = await beginPurchase(supabase, tenantId, timeZone, { onlyIfPayable: true })
      if (purchase) return purchase
    }

    return await buildEventsReply(supabase, tenantId, timeZone)
  } catch (error) {
    console.error("[event-tickets] failed to load", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return finish(UNAVAILABLE_REPLY)
  }
}

export const eventTicketsService = {
  handle,
  handleState,
}
