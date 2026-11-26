// lib/payments/vvip-checkout.ts
/**
 * Buying a VVIP table on WhatsApp: list what is on sale, quote, pay from the Passport, or pay by card on the
 * SHOP'S OWN card provider (same shape as event-checkout.ts, which does this for tickets).
 *
 * Passport / free: one database call (vvip_purchase_table_whatsapp). The debit, the table and the opening tab
 *                  credit are one transaction there.
 * Card:            we only START a checkout here. The booking is made by the signed webhook after the payment is
 *                  verified (vvip_fulfil_card_booking_whatsapp, called from settle.ts), never from this file.
 *
 * Everything the customer is shown (price, tab credit, tables left) comes from the database's own answer.
 * The database functions are service-role only (supabase/migrations/20261126140000_vvip_whatsapp_purchase.sql).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { cardFailureMessage, getCardOption, startCardPayment } from "./card"

/** Database messages that are written for customers; anything else becomes a generic apology. */
const FRIENDLY_DB_MESSAGE = /No tables left|already booked|Table not found|n't on sale|has ended|Passport|balance|Customer not found|not enabled|Package not found|Event not found/i
const GENERIC = "I couldn't complete that. Please try again in a moment."

function friendly(message: string | undefined): string {
  return message && FRIENDLY_DB_MESSAGE.test(message) ? message : GENERIC
}

// ----------------------------------------------------------------------------
// What is on sale
// ----------------------------------------------------------------------------

export interface TablePackage {
  packageId: string
  eventId: string
  eventName: string
  eventLocation: string | null
  eventStart: string
  name: string
  description: string | null
  price: number
  tabCredit: number
  seatsPerTable: number
  benefits: string[]
  tablesLeft: number
}

/**
 * Active packages of events that are on sale, soonest event first, only those with a table left.
 * Never throws: tables are an extra on top of tickets, so a problem here must not break the events list.
 * Returns [] when the shop has VVIP (or Events) switched off, the database says so itself.
 */
export async function loadTablePackages(supabase: SupabaseClient, tenantId: string): Promise<TablePackage[]> {
  try {
    const { data, error } = await supabase.rpc("vvip_packages_whatsapp", { p_tenant_id: tenantId })
    if (error) {
      console.error("[vvip-checkout] could not read packages", { tenantId, error: error.message })
      return []
    }
    return ((data ?? []) as Record<string, unknown>[])
      .map((r) => ({
        packageId: r.package_id as string,
        eventId: r.event_id as string,
        eventName: r.event_name as string,
        eventLocation: (r.event_location as string | null) ?? null,
        eventStart: r.event_start as string,
        name: r.package_name as string,
        description: (r.description as string | null) ?? null,
        price: Number(r.price) || 0,
        tabCredit: Number(r.tab_credit) || 0,
        seatsPerTable: Number(r.seats_per_table) || 0,
        benefits: Array.isArray(r.benefits) ? (r.benefits as string[]) : [],
        tablesLeft: Number(r.tables_left) || 0,
      }))
      .filter((p) => p.tablesLeft > 0)
  } catch (error) {
    console.error("[vvip-checkout] packages lookup failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

/** A table nobody holds right now, for the "pick your table" step. */
export interface FreeTable {
  tableId: string
  label: string
}

/** Free tables of one package in the order the shop set them up. [] on any problem (the caller then falls back to "next free table"). */
export async function loadFreeTables(supabase: SupabaseClient, tenantId: string, packageId: string): Promise<FreeTable[]> {
  try {
    const { data, error } = await supabase.rpc("vvip_free_tables_whatsapp", { p_tenant_id: tenantId, p_package_id: packageId })
    if (error) {
      console.error("[vvip-checkout] could not read free tables", { tenantId, error: error.message })
      return []
    }
    return ((data ?? []) as Array<{ table_id: string; label: string }>).map((r) => ({ tableId: r.table_id, label: r.label }))
  } catch (error) {
    console.error("[vvip-checkout] free tables lookup failed", { tenantId, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

// ----------------------------------------------------------------------------
// Quote
// ----------------------------------------------------------------------------

export interface TableQuote {
  packageId: string
  packageName: string
  eventId: string
  eventName: string
  eventStart: string
  price: number
  tabCredit: number
  seatsPerTable: number
  tablesLeft: number
}

export type TableQuoteResult = { ok: true; quote: TableQuote } | { ok: false; message: string }

export async function quoteTablePurchase(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
  packageId: string,
): Promise<TableQuoteResult> {
  const { data, error } = await supabase
    .rpc("vvip_quote_whatsapp", { p_tenant_id: tenantId, p_customer_id: customerId, p_package_id: packageId })
    .maybeSingle()
  if (error || !data) return { ok: false, message: friendly(error?.message) }
  const r = data as Record<string, unknown>
  return {
    ok: true,
    quote: {
      packageId: r.package_id as string,
      packageName: r.package_name as string,
      eventId: r.event_id as string,
      eventName: r.event_name as string,
      eventStart: r.event_start as string,
      price: Number(r.price) || 0,
      tabCredit: Number(r.tab_credit) || 0,
      seatsPerTable: Number(r.seats_per_table) || 0,
      tablesLeft: Number(r.tables_left) || 0,
    },
  }
}

// ----------------------------------------------------------------------------
// Pay from the Passport (or a free package)
// ----------------------------------------------------------------------------

export type TablePurchaseResult = { ok: true; bookingId: string } | { ok: false; message: string }

export async function buyTableWithPassport(args: {
  supabase: SupabaseClient
  tenantId: string
  customerId: string
  packageId: string
  /** The table the customer picked. Omit/null = the next free table of the package. */
  tableId?: string | null
  /** Generated once per confirmation screen: a double tap returns the same booking instead of taking a second table. */
  idempotencyKey: string
}): Promise<TablePurchaseResult> {
  const { data, error } = await args.supabase.rpc("vvip_purchase_table_whatsapp", {
    p_tenant_id: args.tenantId,
    p_customer_id: args.customerId,
    p_package_id: args.packageId,
    p_idempotency_key: args.idempotencyKey,
    p_table_id: args.tableId ?? null,
  })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row) {
    console.error("[vvip-checkout] passport purchase failed", { tenantId: args.tenantId, error: error?.message })
    return { ok: false, message: friendly(error?.message) }
  }
  return { ok: true, bookingId: (row as { id: string }).id }
}

// ----------------------------------------------------------------------------
// Pay by card: start a checkout on the shop's own provider (the table is booked later, by the webhook)
// ----------------------------------------------------------------------------

export type StartTableCardResult = { ok: true; url: string; mode: "test" | "live" } | { ok: false; message: string }

export async function startTableCardCheckout(args: {
  supabase: SupabaseClient
  tenantId: string
  customerId: string
  quote: TableQuote
  /** The table the customer picked, kept with the payment. If it is taken before the payment clears they get the next free one. */
  tableId?: string | null
}): Promise<StartTableCardResult> {
  const { supabase, tenantId, customerId, quote } = args

  const option = await getCardOption(supabase, tenantId)
  if (!option) return { ok: false, message: "Card payment isn't set up for this shop yet." }
  if (quote.price < option.minAmount) return { ok: false, message: `Card payments start at R${option.minAmount}.` }

  // The attempt is recorded BEFORE the provider is asked, with everything needed to book the table later.
  const attempt = await startCardPayment({
    supabase,
    tenantId,
    option,
    purpose: "vvip_booking",
    amount: quote.price,
    description: `${quote.packageName} table, ${quote.eventName}`,
    recordMetadata: {
      customer_id: customerId,
      package_id: quote.packageId,
      event_id: quote.eventId,
      ...(args.tableId ? { table_id: args.tableId } : {}),
    },
    idempotencyPrefix: "vvip",
  })
  if (!attempt.ok) {
    return { ok: false, message: attempt.stage === "record" ? GENERIC : cardFailureMessage(attempt.error, GENERIC) }
  }
  return { ok: true, url: attempt.url, mode: attempt.mode }
}
