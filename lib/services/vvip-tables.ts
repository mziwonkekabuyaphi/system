// lib/services/vvip-tables.ts
/**
 * VVIP tables — WhatsApp side. A shop's tables (Admin > VVIP: packages with their own price, bar-tab credit and
 * tables, each linked to an event) can now be bought by customers in the chat.
 * ----------------------------------------------------------------------------
 * Gates: the Events module (the bot's events flow) AND the VVIP module. Both are re-checked by the database.
 *
 * WHERE IT SHOWS UP (event-tickets.ts calls into this file; nothing here imports event-tickets.ts)
 *   - Tap Events -> choose an event -> the list has a "🍾 VVIP tables" row next to the ticket rows.
 *     An event that only has tables (no ticket types) goes straight to its tables.
 *   - Typing "tables" / "book a table" / "vip tables" starts here directly (see EVENT_PHRASES in intent-router.ts).
 *
 * STATES (all start with "events_" so event-tickets.ts / action-router.ts already route them):
 *   events_tbl_event -> events_tbl_package -> events_tbl_payment
 *   Tap-only, like tickets: event and package are WhatsApp lists (ids evt_tblevent: / evt_pkg:), payment is the
 *   Passport button or the Pay Now link.
 *
 * MONEY: Passport (or a free package) is one database call. Card: we only start the checkout; the signed webhook
 *   books the table after the payment is verified (settle.ts -> vvip_fulfil_card_booking_whatsapp), and refunds it
 *   if the last table went while the customer was paying.
 * The customer is given the next free table of the package; the booking reference is what the team looks up.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"
import { formatPassportMoney } from "@/lib/services/passport"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { buildChoiceList, clip } from "@/lib/whatsapp/utils/choice-list"
import { getEventPaymentOptions } from "@/lib/payments/event-checkout"
import {
  buyTableWithPassport,
  loadTablePackages,
  quoteTablePurchase,
  startTableCardCheckout,
  type TablePackage,
  type TableQuote,
} from "@/lib/payments/vvip-checkout"

// ============================================================================
// CONSTANTS
// ============================================================================

export const TABLE_STATE_EVENT = "events_tbl_event"
export const TABLE_STATE_PACKAGE = "events_tbl_package"
export const TABLE_STATE_PAYMENT = "events_tbl_payment"

/** The "🍾 VVIP tables" row in an event's ticket list. */
export const ID_TABLES = "evt_tables:"
const ID_TABLE_EVENT = "evt_tblevent:"
const ID_PACKAGE = "evt_pkg:"

const PAY_NOW_BUTTON = "Pay Now"
const MAX_ROWS = 10
const DEFAULT_TZ = "Africa/Johannesburg"
const UNAVAILABLE_REPLY = "Sorry, I couldn't load that right now. Please try again in a moment."
const BUY_HELP = "To book a table, ask a team member at the shop."

type StateData = Record<string, unknown>

const stay = (state: string, data: StateData, reply: string, buttons: string[] = []): ActionResult => ({
  reply,
  buttons,
  nextState: { state, data },
})
const finish = (reply: string, buttons: string[] = []): ActionResult => ({ reply, buttons, nextState: null })

// ============================================================================
// SMALL HELPERS (own copies: event-tickets.ts imports this file, so it can't be imported back)
// ============================================================================

function money(n: number): string {
  const whole = Math.abs(n % 1) < 0.005
  return `R${n.toFixed(whole ? 0 : 2)}`
}

function priceLabel(price: number): string {
  return price <= 0 ? "Free" : money(price)
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

function parseChoice(raw: string, max: number): number | null {
  const m = /^\s*(\d{1,2})[.)]?\s*$/.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= max ? n : null
}

function tappedId(message: IncomingMessage, prefix: string): string | null {
  const id = message.interactiveId
  return id && id.startsWith(prefix) ? id.slice(prefix.length) : null
}

/** Packages grouped by event, in the order the database returned them (soonest event first). */
function groupByEvent(packages: TablePackage[]): Map<string, TablePackage[]> {
  const byEvent = new Map<string, TablePackage[]>()
  for (const p of packages) byEvent.set(p.eventId, [...(byEvent.get(p.eventId) ?? []), p])
  return byEvent
}

// ============================================================================
// ENTRY POINTS (called by event-tickets.ts)
// ============================================================================

/** The tables row for an event's ticket list, or null when the event has no table on sale. */
export function tablesRowFor(eventId: string, packages: TablePackage[]) {
  const mine = packages.filter((p) => p.eventId === eventId)
  if (mine.length === 0) return null
  const cheapest = Math.min(...mine.map((p) => p.price))
  const left = mine.reduce((sum, p) => sum + p.tablesLeft, 0)
  return {
    id: `${ID_TABLES}${eventId}`,
    title: "🍾 VVIP tables",
    description: `${cheapest > 0 ? `From ${money(cheapest)}` : "Free"} · ${left} table${left === 1 ? "" : "s"} left`,
  }
}

/** The package list for one event. `packages` = this event's packages (already filtered to tables left). */
export function packageStep(packages: TablePackage[], timeZone: string): ActionResult {
  const event = packages[0]
  const shown = packages.slice(0, MAX_ROWS)
  const header = [
    `🍾 *VVIP tables*`,
    `*${event.eventName}*`,
    `📅 ${formatWhen(event.eventStart, timeZone)}`,
    ...(event.eventLocation ? [`📍 ${event.eventLocation}`] : []),
  ].join("\n")

  const lines = shown.map((p) => {
    const parts = [priceLabel(p.price)]
    if (p.tabCredit > 0) parts.push(`${money(p.tabCredit)} bar tab`)
    if (p.seatsPerTable > 0) parts.push(`${p.seatsPerTable} seats`)
    return `• *${p.name}*: ${parts.join(" · ")}`
  })
  // A WhatsApp list body is at most 1024 characters: if many packages push past it, fall back to the header only.
  let body = `${header}\n\n${lines.join("\n")}\n\nWhich table would you like?`
  if (body.length > 1000) body = `${header}\n\nWhich table would you like?`

  return {
    // Empty main reply on purpose: send-action-result.ts skips it, so the header lives in the list body.
    ...stay(TABLE_STATE_PACKAGE, { eventId: event.eventId, packageIds: shown.map((p) => p.packageId) }, ""),
    followUp: [
      buildChoiceList(body, "Choose table", [
        {
          title: "Tables",
          rows: shown.map((p) => {
            const price = priceLabel(p.price)
            return {
              id: `${ID_PACKAGE}${p.packageId}`,
              title: `${clip(p.name, 24 - 3 - price.length)} · ${price}`,
              description: [p.tabCredit > 0 ? `${money(p.tabCredit)} bar tab` : null, `${p.tablesLeft} left`].filter(Boolean).join(" · "),
            }
          }),
        },
      ]),
    ],
  }
}

/**
 * Typed "tables" / "book a table": straight to the tables, without going through the ticket list.
 * One event with tables -> its packages; several -> an event list; none -> a short message.
 */
export async function beginTables(supabase: SupabaseClient, tenantId: string, timeZone: string): Promise<ActionResult> {
  const packages = await loadTablePackages(supabase, tenantId)
  if (packages.length === 0) {
    return finish("🍾 *VVIP tables*\n\nThere are no tables on sale right now. Check back soon!", ["Events", "Main Menu"])
  }
  const byEvent = groupByEvent(packages)
  if (byEvent.size === 1) return packageStep([...byEvent.values()][0], timeZone)

  const events = [...byEvent.values()].slice(0, MAX_ROWS)
  return {
    ...stay(TABLE_STATE_EVENT, { eventIds: events.map((list) => list[0].eventId) }, ""),
    followUp: [
      buildChoiceList("🍾 *VVIP tables*\n\nWhich event would you like a table for?", "Choose event", [
        {
          title: "Events",
          rows: events.map((list) => ({
            id: `${ID_TABLE_EVENT}${list[0].eventId}`,
            title: list[0].eventName,
            description: [formatWhen(list[0].eventStart, timeZone), list[0].eventLocation].filter(Boolean).join(" · "),
          })),
        },
      ]),
    ],
  }
}

// ============================================================================
// PACKAGE -> PAYMENT
// ============================================================================

interface PackageExtras {
  description: string | null
  benefits: string[]
}

async function readExtras(supabase: SupabaseClient, tenantId: string, packageId: string): Promise<PackageExtras> {
  const { data } = await supabase
    .from("vvip_packages")
    .select("description, benefits")
    .eq("tenant_id", tenantId)
    .eq("id", packageId)
    .maybeSingle()
  const row = data as { description?: string | null; benefits?: unknown } | null
  return {
    description: row?.description?.trim() || null,
    benefits: Array.isArray(row?.benefits) ? (row?.benefits as string[]).filter((b) => typeof b === "string" && b.trim()) : [],
  }
}

function summaryLines(quote: TableQuote, extras: PackageExtras, timeZone: string, note?: string): string[] {
  return [
    ...(note ? [note, ""] : []),
    "🧾 *Table summary*",
    `🍾 *${quote.packageName}*`,
    `🎪 ${quote.eventName}`,
    `📅 ${formatWhen(quote.eventStart, timeZone)}`,
    ...(quote.seatsPerTable > 0 ? [`🪑 Seats ${quote.seatsPerTable} guests`] : []),
    ...(quote.tabCredit > 0 ? [`🥂 ${money(quote.tabCredit)} bar tab included`] : []),
    ...(extras.description ? [`ℹ️ ${clip(extras.description, 200)}`] : []),
    ...extras.benefits.slice(0, 6).map((b) => `✔️ ${clip(b, 100)}`),
    "",
    `*Total: ${priceLabel(quote.price)}*`,
    "",
  ]
}

async function cardCheckoutReply(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  quote: TableQuote,
  lines: string[],
): Promise<ActionResult> {
  const card = await startTableCardCheckout({ supabase, tenantId, customerId, quote })
  if (!card.ok) return finish(card.message, ["Events", "Main Menu"])
  const testNote = card.mode === "test" ? "\n\n_Test mode: no real money is charged._" : ""
  return finish(
    [
      ...lines,
      "💳 Tap the link to pay securely:",
      card.url,
      "",
      "Your table is booked and confirmed here as soon as the payment goes through.",
    ].join("\n") + testNote,
  )
}

/** Quote -> free table, the "how would you like to pay" screen, or straight to the card link. */
async function proceedToTablePayment(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  packageId: string,
  timeZone: string,
  note?: string,
): Promise<ActionResult> {
  const q = await quoteTablePurchase(supabase, tenantId, customerId, packageId)
  if (!q.ok) return finish(q.message, ["Events", "Main Menu"])
  const quote = q.quote
  const extras = await readExtras(supabase, tenantId, packageId)

  // Free package: no payment step. The database books it directly.
  if (quote.price <= 0) {
    const res = await buyTableWithPassport({ supabase, tenantId, customerId, packageId, idempotencyKey: randomUUID() })
    if (!res.ok) return finish(res.message, ["Events", "Main Menu"])
    return await confirmedReply(supabase, tenantId, res.bookingId)
  }

  const options = await getEventPaymentOptions(supabase, tenantId, customerId, quote.price)
  const lines = summaryLines(quote, extras, timeZone, note)

  // Card is the only way to pay: summary + link straight away.
  if (options.card && !options.passport.ok) return await cardCheckoutReply(supabase, tenantId, customerId, quote, lines)

  const choices: string[] = []
  if (options.passport.ok) {
    choices.push("Passport")
    lines.push(`💰 *Passport* (balance ${formatPassportMoney(options.passport.balance, options.passport.currency)})`)
  } else if (options.passport.reason === "low_balance") {
    lines.push(`Your Passport balance (${formatPassportMoney(options.passport.balance, options.passport.currency)}) is too low for this table.`)
  }
  if (options.card) {
    choices.push(PAY_NOW_BUTTON)
    lines.push("💳 *Online Payment* (Secure Payment page)")
  }

  if (choices.length === 0) {
    return finish([...lines, "", "Online payment isn't available for this table right now.", BUY_HELP].join("\n"), ["Events", "Main Menu"])
  }

  const buttons = [...choices, "Cancel"]
  lines.push("", "How would you like to pay?")
  return stay(
    TABLE_STATE_PAYMENT,
    { packageId, total: quote.price, nonce: randomUUID(), buttons },
    lines.join("\n"),
    buttons,
  )
}

// ============================================================================
// CONFIRMATION (shared by the bot and the card webhook)
// ============================================================================

/** Confirmation text for a booked table: reference, table, event, tab. Throws on a database error. */
export async function buildTableConfirmation(
  supabase: SupabaseClient,
  tenantId: string,
  bookingId: string,
  headline = "✅ *Your table is booked!*",
): Promise<string> {
  const { data: booking, error } = await supabase
    .from("vvip_bookings")
    .select("reference, package_id, table_id, price_paid, tab_credit_issued, payment_method")
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .maybeSingle()
  if (error || !booking) throw new Error(`Failed to read table booking: ${error?.message ?? "not found"}`)
  const b = booking as {
    reference: string
    package_id: string
    table_id: string | null
    price_paid: number | string
    tab_credit_issued: number | string
    payment_method: string
  }

  const [pkgRes, tableRes, timeZone] = await Promise.all([
    supabase.from("vvip_packages").select("name, seats_per_table, event_id").eq("tenant_id", tenantId).eq("id", b.package_id).maybeSingle(),
    b.table_id
      ? supabase.from("vvip_tables").select("label").eq("tenant_id", tenantId).eq("id", b.table_id).maybeSingle()
      : Promise.resolve({ data: null }),
    getTenantTimezone(supabase, tenantId).catch(() => DEFAULT_TZ),
  ])
  const pkg = pkgRes.data as { name: string; seats_per_table: number; event_id: string } | null
  const { data: eventData } = pkg
    ? await supabase.from("events").select("name, start_time, location").eq("tenant_id", tenantId).eq("id", pkg.event_id).maybeSingle()
    : { data: null }
  const event = eventData as { name: string; start_time: string; location: string | null } | null
  const label = (tableRes.data as { label?: string } | null)?.label

  const paid = Number(b.price_paid) || 0
  const credit = Number(b.tab_credit_issued) || 0
  const lines = [headline, ""]
  if (pkg) lines.push(`🍾 *${pkg.name}*`)
  if (event) {
    lines.push(`🎪 ${event.name}`, `📅 ${formatWhen(event.start_time, timeZone)}`)
    if (event.location) lines.push(`📍 ${event.location}`)
  }
  if (label) lines.push(`🪑 Table: *${label}*${pkg?.seats_per_table ? ` (${pkg.seats_per_table} seats)` : ""}`)
  lines.push(`🔖 Reference: *${b.reference}*`)
  if (paid > 0) lines.push(`💳 Paid: ${money(paid)}`)
  if (credit > 0) lines.push(`🥂 Bar tab: ${money(credit)} loaded and ready to use`)
  lines.push("", "Show your reference at the venue and the team will take you to your table.")
  return lines.join("\n")
}

async function confirmedReply(supabase: SupabaseClient, tenantId: string, bookingId: string): Promise<ActionResult> {
  const text = await buildTableConfirmation(supabase, tenantId, bookingId)
  return finish(text, ["Events", "Main Menu"])
}

/** The customer's upcoming tables, as lines for the "My tickets" reply. Never throws; [] when none. */
export async function readMyTableLines(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  timeZone: string,
): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("vvip_bookings")
      .select("reference, package_id, table_id, status, tab_balance")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .in("status", ["confirmed", "checked_in", "seated"])
      .order("created_at", { ascending: false })
      .limit(5)
    const bookings = (data ?? []) as Array<{ reference: string; package_id: string; table_id: string | null; tab_balance: number | string }>
    if (bookings.length === 0) return []

    const packageIds = [...new Set(bookings.map((b) => b.package_id))]
    const { data: pkgData } = await supabase.from("vvip_packages").select("id, name, event_id").eq("tenant_id", tenantId).in("id", packageIds)
    const pkgs = new Map(((pkgData ?? []) as Array<{ id: string; name: string; event_id: string }>).map((p) => [p.id, p]))
    const eventIds = [...new Set([...pkgs.values()].map((p) => p.event_id))]
    const { data: eventData } = await supabase.from("events").select("id, name, start_time, end_time").eq("tenant_id", tenantId).in("id", eventIds)
    const events = new Map(((eventData ?? []) as Array<{ id: string; name: string; start_time: string; end_time: string | null }>).map((e) => [e.id, e]))
    const tableIds = bookings.map((b) => b.table_id).filter((v): v is string => Boolean(v))
    const { data: tableData } = tableIds.length
      ? await supabase.from("vvip_tables").select("id, label").eq("tenant_id", tenantId).in("id", tableIds)
      : { data: [] }
    const labels = new Map(((tableData ?? []) as Array<{ id: string; label: string }>).map((t) => [t.id, t.label]))

    const now = Date.now()
    const lines: string[] = []
    for (const b of bookings) {
      const pkg = pkgs.get(b.package_id)
      const event = pkg ? events.get(pkg.event_id) : undefined
      if (!pkg || !event) continue
      const end = event.end_time ? Date.parse(event.end_time) : Date.parse(event.start_time) + 6 * 3_600_000
      if (end < now) continue // that event is over
      const label = b.table_id ? labels.get(b.table_id) : null
      const tab = Number(b.tab_balance) || 0
      lines.push(
        `🍾 *${pkg.name}*${label ? ` · ${label}` : ""}`,
        `   ${event.name} · ${formatWhen(event.start_time, timeZone)}`,
        `   Ref *${b.reference}*${tab > 0 ? ` · tab ${money(tab)}` : ""}`,
      )
    }
    return lines
  } catch (error) {
    console.error("[vvip-tables] my tables failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

// ============================================================================
// STATE CONTINUATION
// ============================================================================

/**
 * Owns the three events_tbl_* states. Returns null when the state isn't one of them, so event-tickets.ts can carry on.
 * The caller has already checked the Events module, the cancel words, and loaded the customer and timezone.
 */
export async function handleTableState(args: {
  supabase: SupabaseClient
  tenantId: string
  customerId: string
  state: ConversationState
  message: IncomingMessage
  typed: string
  timeZone: string
}): Promise<ActionResult | null> {
  const { supabase, tenantId, customerId, state, message, typed, timeZone } = args
  if (!state.state.startsWith("events_tbl_")) return null
  const data = (state.data ?? {}) as StateData

  try {
    switch (state.state) {
      case TABLE_STATE_EVENT: {
        const ids = (data.eventIds as string[] | undefined) ?? []
        const n = parseChoice(typed, ids.length)
        const eventId = tappedId(message, ID_TABLE_EVENT) ?? (n !== null ? ids[n - 1] : null)
        if (!eventId) return stay(state.state, data, "Please pick an event from the list above (tap *Choose event*), or reply *cancel*.")
        const mine = (await loadTablePackages(supabase, tenantId)).filter((p) => p.eventId === eventId)
        if (mine.length === 0) return finish("Sorry, there are no tables left for that event.", ["Events", "Main Menu"])
        return packageStep(mine, timeZone)
      }

      case TABLE_STATE_PACKAGE: {
        const ids = (data.packageIds as string[] | undefined) ?? []
        const n = parseChoice(typed, ids.length)
        const packageId = tappedId(message, ID_PACKAGE) ?? (n !== null ? ids[n - 1] : null)
        if (!packageId) return stay(state.state, data, "Please pick a table from the list above (tap *Choose table*), or reply *cancel*.")
        return await proceedToTablePayment(supabase, tenantId, customerId, packageId, timeZone)
      }

      case TABLE_STATE_PAYMENT: {
        const packageId = data.packageId as string
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
        const q = await quoteTablePurchase(supabase, tenantId, customerId, packageId)
        if (!q.ok) return finish(q.message, ["Events", "Main Menu"])
        if (Math.abs(q.quote.price - shownTotal) > 0.001) {
          return await proceedToTablePayment(supabase, tenantId, customerId, packageId, timeZone, "⚠️ The price changed, so here is your updated order.")
        }

        if (wantsPassport) {
          if (!buttons.includes("Passport")) return stay(state.state, data, "Passport isn't available for this table. Please choose another option.", buttons)
          const res = await buyTableWithPassport({ supabase, tenantId, customerId, packageId, idempotencyKey: nonce })
          if (!res.ok) return finish(res.message, ["Events", "Main Menu"])
          return await confirmedReply(supabase, tenantId, res.bookingId)
        }

        if (!buttons.includes(PAY_NOW_BUTTON)) return stay(state.state, data, "Online payment isn't available for this table. Please choose another option.", buttons)
        const extras = await readExtras(supabase, tenantId, packageId)
        return await cardCheckoutReply(supabase, tenantId, customerId, q.quote, summaryLines(q.quote, extras, timeZone))
      }

      default:
        return null
    }
  } catch (error) {
    console.error("[vvip-tables] step failed", { tenantId, state: state.state, error: error instanceof Error ? error.message : String(error) })
    return finish(UNAVAILABLE_REPLY)
  }
}
