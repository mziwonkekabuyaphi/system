// lib/services/passport.ts
/**
 * Passport (customer wallet) — WhatsApp side, multi-tenant, module-gated on "wallet".
 * ----------------------------------------------------------------------------
 * NOT the Rands passport.ts. That one sat on profiles / wallet_transactions /
 * Yoco and also stitched in tickets, VVIP and orders. This platform's wallet
 * lives in `wallets` + `wallet_ledger` (keyed by tenant_id + tenant_customers.id),
 * so this file reads those tables directly and owns nothing else.
 *
 * WHAT IT DOES TODAY (payments come later):
 *   - shows the customer's own balance, Passport status and last few movements
 *   - tells them how to add funds (a team member tops up at the shop, which is
 *     what the admin side's wallet_staff_topup does)
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - create a wallet. Looking is read-only; the first top-up creates it
 *     (wallet_get_or_create), so a customer who only taps "My Passport" never
 *     leaves a wallet row behind. "none" = no Passport yet.
 *   - take a payment. When online top-up is wired, it goes in as a stateful flow
 *     (passport_* states) next to handle(); TOPUP_HELP below is the one line to replace.
 *   - show ledger descriptions or the block reason: those can contain staff notes.
 *     Movements are labelled by entry_type only.
 *
 * STATELESS: nextState is always null; menu taps are routed by id in action-router.ts.
 * MODULE GATE: action-router.ts gates the row / typed intent, and handle() checks the
 * switch again itself (same belt-and-braces as shisha), so it can never answer for a
 * shop that has the module off.
 * PRIVACY: only ever reads the wallet of message.from. No way to ask for another number's.
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

/** Replace this line when online top-up is wired. */
const TOPUP_HELP = "To add funds, ask a team member at the shop to top up your Passport."

const UNAVAILABLE_REPLY = "Sorry, I couldn't load your Passport right now. Please try again in a moment."

export function buildPassportMessage(summary: PassportSummary, movements: PassportMovement[], timeZone: string): string {
  const title = "🪪 *Your Passport*"

  if (summary.status === "none") {
    return [title, "", "You don't have a Passport balance yet.", "", TOPUP_HELP].join("\n")
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
  lines.push("", TOPUP_HELP)
  return lines.join("\n")
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function handle(
  tenantId: string,
  _intent: RoutedIntent,
  message: IncomingMessage,
): Promise<ActionResult> {
  const reply = (text: string): ActionResult => ({ reply: text, buttons: [], nextState: null })

  // Second lock behind the router's gate. Fails closed (isModuleEnabled returns false on error).
  if (!(await isModuleEnabled(tenantId, "wallet"))) {
    return reply("Sorry, that service isn't available right now.")
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) return reply(UNAVAILABLE_REPLY)

  try {
    const customer = await getCustomer(tenantId, message.from)
    const summary: PassportSummary = customer
      ? await readPassportSummary(supabase, tenantId, customer.id)
      : { status: "none", balance: 0, currency: DEFAULT_CURRENCY, walletId: null }

    const [movements, timeZone] = await Promise.all([
      summary.walletId && summary.status === "active"
        ? readRecentMovements(supabase, tenantId, summary.walletId)
        : Promise.resolve<PassportMovement[]>([]),
      getTenantTimezone(supabase, tenantId).catch(() => "Africa/Johannesburg"),
    ])

    return reply(buildPassportMessage(summary, movements, timeZone))
  } catch (error) {
    console.error("[passport] failed to load passport", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return reply(UNAVAILABLE_REPLY)
  }
}

export const passportService = {
  handle,
}
