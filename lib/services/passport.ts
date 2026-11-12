// lib/services/passport.ts
/**
 * Passport (customer wallet) — WhatsApp side, multi-tenant, module-gated on "wallet".
 * ----------------------------------------------------------------------------
 * NOT the Rands passport.ts. That one sat on profiles / wallet_transactions /
 * Yoco and also stitched in tickets, VVIP and orders. This platform's wallet
 * lives in `wallets` + `wallet_ledger` (keyed by tenant_id + tenant_customers.id),
 * so this file reads those tables directly and owns nothing else.
 *
 * WHAT IT DOES:
 *   - shows the customer's own balance, Passport status and last few movements
 *   - "Top Up": when the shop allows online top-up AND has connected its OWN Yoco account
 *     (Settings > Payments), asks for an amount and sends that shop's Yoco payment link.
 *     The credit itself happens only in the signed webhook (app/api/webhooks/yoco/...), never here.
 *   - otherwise tells them to ask a team member (wallet_staff_topup on the admin side)
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - create a wallet. Looking is read-only; the first top-up creates it
 *     (wallet_get_or_create), so a customer who only taps "My Passport" never
 *     leaves a wallet row behind. "none" = no Passport yet.
 *   - take or credit a payment itself. It only starts a checkout (lib/payments/passport-topup.ts).
 *   - show ledger descriptions or the block reason: those can contain staff notes.
 *     Movements are labelled by entry_type only.
 *
 * STATES: only "passport_topup_amount" (waiting for the amount). Everything else is stateless; menu taps
 * are routed by id in action-router.ts.
 * MODULE GATE: action-router.ts gates the row / typed intent, and handle() checks the
 * switch again itself (same belt-and-braces as shisha), so it can never answer for a
 * shop that has the module off.
 * PRIVACY: only ever reads the wallet of message.from. No way to ask for another number's.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { RoutedIntent } from "@/lib/whatsapp/intent-router"
import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { ConversationState } from "@/lib/services/state"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getCustomer } from "@/lib/services/tenant-customer"
import { getTenantTimezone } from "@/lib/services/shared/tenant-scheduling"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { getTopupAvailability, startPassportTopup } from "@/lib/payments/passport-topup"

// ============================================================================
// TYPES
// ============================================================================

/** "none" = the customer has no Passport yet (their first top-up creates it). */
export type PassportStatus = "active" | "blocked" | "closed" | "none"

export interface PassportSummary {
  status: PassportStatus
  balance: number
  currency: string
  /** null when status is "none". */
  walletId: string | null
}

export interface PassportMovement {
  direction: "credit" | "debit"
  entryType: "topup" | "purchase" | "refund" | "adjustment"
  amount: number
  createdAt: string
}

const DEFAULT_CURRENCY = "ZAR"
const RECENT_LIMIT = 5

export const PASSPORT_STATE_TOPUP_AMOUNT = "passport_topup_amount"
/** Typed or tapped "Top Up" / "top-up" / "topup". */
const TOPUP_PATTERN = /\btop\s*-?\s*up\b/i
const CANCEL_PATTERN = /^(cancel|no|stop|back|menu|main menu|nevermind|never mind)[.!]*$/i

// ============================================================================
// READS (also used by profile.ts)
// ============================================================================

/** The customer's Passport in one read. Never creates a wallet. Throws on a database error. */
export async function readPassportSummary(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
): Promise<PassportSummary> {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, balance, currency, status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .maybeSingle()

  if (error) throw new Error(`Failed to read passport: ${error.message}`)

  if (!data) {
    // No wallet yet: still show the shop's currency, falling back quietly.
    let currency = DEFAULT_CURRENCY
    const { data: settings } = await supabase
      .from("wallet_settings")
      .select("currency")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (settings?.currency) currency = settings.currency as string
    return { status: "none", balance: 0, currency, walletId: null }
  }

  const status = data.status === "blocked" || data.status === "closed" ? data.status : "active"
  return {
    status,
    balance: Number(data.balance) || 0,
    currency: (data.currency as string) || DEFAULT_CURRENCY,
    walletId: data.id as string,
  }
}

async function readRecentMovements(
  supabase: SupabaseClient,
  tenantId: string,
  walletId: string,
): Promise<PassportMovement[]> {
  const { data, error } = await supabase
    .from("wallet_ledger")
    .select("direction, entry_type, amount, created_at")
    .eq("tenant_id", tenantId)
    .eq("wallet_id", walletId)
    .order("seq", { ascending: false })
    .limit(RECENT_LIMIT)

  if (error) throw new Error(`Failed to read passport activity: ${error.message}`)
  return (data ?? []).map((row) => ({
    direction: row.direction as PassportMovement["direction"],
    entryType: row.entry_type as PassportMovement["entryType"],
    amount: Number(row.amount) || 0,
    createdAt: row.created_at as string,
  }))
}

// ============================================================================
// FORMATTING
// ============================================================================

export function formatPassportMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency }).format(amount)
  } catch {
    return `R${amount.toFixed(2)}`
  }
}

function formatDay(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", timeZone }).format(new Date(iso))
  } catch {
    return ""
  }
}

const MOVEMENT_LABEL: Record<PassportMovement["entryType"], string> = {
  topup: "Top-up",
  purchase: "Purchase",
  refund: "Refund",
  adjustment: "Adjustment",
}

function movementLine(m: PassportMovement, currency: string, timeZone: string): string {
  const sign = m.direction === "credit" ? "➕" : "➖"
  const day = formatDay(m.createdAt, timeZone)
  return `${sign} ${MOVEMENT_LABEL[m.entryType] ?? "Movement"} ${formatPassportMoney(m.amount, currency)}${day ? ` · ${day}` : ""}`
}

/** Shown when online top-up is not available for this shop. */
const TOPUP_HELP = "To add funds, ask a team member at the shop to top up your Passport."

const UNAVAILABLE_REPLY = "Sorry, I couldn't load your Passport right now. Please try again in a moment."

export function buildPassportMessage(
  summary: PassportSummary,
  movements: PassportMovement[],
  timeZone: string,
  canTopUp = false,
): string {
  const addFunds = canTopUp ? "Tap *Top Up* to add funds by card." : TOPUP_HELP
  const title = "🪪 *Your Passport*"

  if (summary.status === "none") {
    return [title, "", "You don't have a Passport balance yet.", "", addFunds].join("\n")
  }
  if (summary.status === "blocked") {
    return [title, "", "Your Passport is on hold right now. Please contact the shop and they'll help you."].join("\n")
  }
  if (summary.status === "closed") {
    return [title, "", "This Passport has been closed. Please contact the shop if you think that's a mistake."].join("\n")
  }

  const lines = [title, "", `💰 *Balance:* ${formatPassportMoney(summary.balance, summary.currency)}`]
  if (movements.length > 0) {
    lines.push("", "*Recent activity*", ...movements.map((m) => movementLine(m, summary.currency, timeZone)))
  }
  lines.push("", addFunds)
  return lines.join("\n")
}

// ============================================================================
// ENTRY POINT
// ============================================================================

function plainReply(text: string): ActionResult {
  return { reply: text, buttons: [], nextState: null }
}

function formatLimit(amount: number): string {
  return formatPassportMoney(amount, DEFAULT_CURRENCY).replace(/[.,]00$/, "")
}

async function handle(
  tenantId: string,
  _intent: RoutedIntent,
  message: IncomingMessage,
): Promise<ActionResult> {
  const reply = plainReply

  // Second lock behind the router's gate. Fails closed (isModuleEnabled returns false on error).
  if (!(await isModuleEnabled(tenantId, "wallet"))) {
    return reply("Sorry, that service isn't available right now.")
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return reply(UNAVAILABLE_REPLY)

  const typed = (message.contentSummary ?? message.text ?? "").trim()

  try {
    const customer = await getCustomer(tenantId, message.from)
    const summary: PassportSummary = customer
      ? await readPassportSummary(supabase, tenantId, customer.id)
      : { status: "none", balance: 0, currency: DEFAULT_CURRENCY, walletId: null }

    // Can this customer top up online right now? (Shop allows it + has its own Yoco connected + wallet usable.)
    const walletUsable = summary.status === "active" || summary.status === "none"
    const topup = walletUsable ? await getTopupAvailability(supabase, tenantId) : null
    const canTopUp = Boolean(topup?.available)

    if (canTopUp && TOPUP_PATTERN.test(typed) && customer) {
      return {
        reply: `💳 *Top up your Passport*\n\nHow much would you like to add? Reply with an amount between ${formatLimit(topup!.min)} and ${formatLimit(topup!.max)}, for example *200*.\n\nReply *cancel* to stop.`,
        buttons: [],
        nextState: { state: PASSPORT_STATE_TOPUP_AMOUNT, data: {} },
      }
    }

    const [movements, timeZone] = await Promise.all([
      summary.walletId && summary.status === "active"
        ? readRecentMovements(supabase, tenantId, summary.walletId)
        : Promise.resolve<PassportMovement[]>([]),
      getTenantTimezone(supabase, tenantId).catch(() => "Africa/Johannesburg"),
    ])

    return {
      reply: buildPassportMessage(summary, movements, timeZone, canTopUp),
      buttons: canTopUp ? ["Top Up"] : [],
      nextState: null,
    }
  } catch (error) {
    console.error("[passport] failed to load passport", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return reply(UNAVAILABLE_REPLY)
  }
}

/** "200", "R200", "r 200.50", "200,50" -> number; anything else -> null. */
export function parseTopupAmount(raw: string): number | null {
  const m = /^r?\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/i.exec(raw.trim())
  if (!m) return null
  const value = Number(m[1].replace(",", "."))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Owns "passport_*" states (currently just the amount step). null = not mine. */
async function handleState(tenantId: string, state: ConversationState, message: IncomingMessage): Promise<ActionResult | null> {
  if (!state.state.startsWith("passport_")) return null

  if (!(await isModuleEnabled(tenantId, "wallet"))) {
    return plainReply("Sorry, that service isn't available right now.")
  }
  if (state.state !== PASSPORT_STATE_TOPUP_AMOUNT) return null

  const typed = (message.text ?? message.contentSummary ?? "").trim()
  if (CANCEL_PATTERN.test(typed)) {
    return plainReply("No problem, nothing was charged. Send *menu* whenever you need me.")
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return plainReply(UNAVAILABLE_REPLY)

  try {
    const customer = await getCustomer(tenantId, message.from)
    const topup = await getTopupAvailability(supabase, tenantId)
    if (!customer || !topup.available) {
      return plainReply("Card top-up isn't available right now. Please ask a team member to top up your Passport.")
    }

    const again = (text: string): ActionResult => ({ reply: text, buttons: [], nextState: { state: PASSPORT_STATE_TOPUP_AMOUNT, data: {} } })

    const amount = parseTopupAmount(typed)
    if (amount === null) {
      return again(`Please reply with just the amount, for example *200*. (Or reply *cancel*.)`)
    }
    if (amount < topup.min || amount > topup.max) {
      return again(`Please choose an amount between ${formatLimit(topup.min)} and ${formatLimit(topup.max)}.`)
    }

    const result = await startPassportTopup({ supabase, tenantId, customerId: customer.id, amount })
    if (!result.ok) return plainReply(result.message)

    const testNote = result.mode === "test" ? "\n\n_Test mode: no real money is charged._" : ""
    return plainReply(
      `💳 *Top up ${formatPassportMoney(amount, topup.currency)}*\n\nTap the link to pay securely by card:\n${result.url}\n\nYour Passport updates automatically as soon as the payment goes through, and I'll message you to confirm.${testNote}`,
    )
  } catch (error) {
    console.error("[passport] top-up step failed", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return plainReply(UNAVAILABLE_REPLY)
  }
}

export const passportService = {
  handle,
  handleState,
}
