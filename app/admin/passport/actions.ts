// app/admin/passport/actions.ts
"use server"

/**
 * Server Actions for Passport (the customer wallet).
 * ---------------------------------------------------
 * Three layers, like app/admin/shisha/actions.ts:
 *   1. requireTenantPermission() proves the signed-in user holds the wallet key
 *      (wallet.view / wallet.operate / wallet.manage) for THEIR shop. The tenantId comes
 *      from the membership, never from the browser.
 *   2. isModuleEnabled() proves the "wallet" module is switched on for the shop (platform
 *      admin > Modules). A switch-off shuts every action, even from a stale open page.
 *   3. READS use the service-role client and are always filtered by tenant_id (RLS is not
 *      protecting those). WRITES go through the database's own wallet_* functions on the
 *      signed-in user's session: they re-check the module and the permission, lock the
 *      wallet row, keep the ledger append-only and make a repeated click harmless
 *      (idempotency keys). The browser can never write a balance directly.
 *
 * The money itself is never computed here: the balance only ever changes inside
 * public._wallet_post, which also writes the ledger row in the same transaction.
 */

import { createSessionClient } from "@/lib/supabase/session-server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { isModuleEnabled } from "@/lib/tenant/modules"
import {
  ACCOUNTS_PAGE_SIZE,
  DEFAULT_PASSPORT_SETTINGS,
  PAYMENT_METHODS,
  type PassportAccount,
  type PassportAccountDetail,
  type PassportAccountsQuery,
  type PassportActivity,
  type PassportLedgerEntry,
  type PassportOverview,
  type PassportRefund,
  type PassportResult,
  type PassportSettings,
  type WalletStatus,
} from "./passport-types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scoped = { ok: true; supabase: ServerClient; tenantId: string } | { ok: false; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/
const MODULE_OFF = "Passport isn't switched on for your business."
const GENERIC_ERROR = "Something went wrong. Please try again."

const round2 = (n: number): number => Math.round(n * 100) / 100
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Proves the caller holds ANY ONE of the given keys, and that the module is on. */
async function scoped(...permissions: PermissionKey[]): Promise<Scoped> {
  let tenantId: string | null = null
  let lastError = "You don't have permission to do that."
  for (const permission of permissions) {
    const check = await requireTenantPermission(permission)
    if (check.ok) {
      tenantId = check.member.tenantId
      break
    }
    lastError = check.error
  }
  if (!tenantId) return { ok: false, error: lastError }

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Supabase isn't configured." }
  if (!(await isModuleEnabled(tenantId, "wallet"))) return { ok: false, error: MODULE_OFF }
  return { ok: true, supabase, tenantId }
}

/** Database messages raised on purpose ("Insufficient balance", "Top-up must be between…") are
 *  written for people; anything that looks technical is replaced by a generic line. */
function friendly(error: { message?: string } | null | undefined): string {
  const m = (error?.message ?? "").trim()
  if (!m) return GENERIC_ERROR
  if (m.length > 160 || /violates|duplicate key|syntax|relation |column |function |permission denied|JWT/i.test(m)) {
    console.error("[passport] database error:", m)
    return GENERIC_ERROR
  }
  return m
}

function cleanKey(key: unknown): string | null {
  if (typeof key !== "string" || !KEY_RE.test(key)) return null
  return `ui:${key}`
}

function cleanAmount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null
  return round2(n)
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

/** The user's own session client: auth.uid() is set, which the wallet_* functions require. */
async function sessionDb() {
  return createSessionClient()
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings(supabase: ServerClient, tenantId: string): Promise<PassportSettings> {
  const { data, error } = await supabase
    .from("wallet_settings")
    .select("currency, min_topup, max_topup, max_balance, allow_customer_topup")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return DEFAULT_PASSPORT_SETTINGS
  return {
    currency: data.currency ?? DEFAULT_PASSPORT_SETTINGS.currency,
    minTopup: num(data.min_topup),
    maxTopup: num(data.max_topup),
    maxBalance: data.max_balance === null || data.max_balance === undefined ? null : num(data.max_balance),
    allowCustomerTopup: data.allow_customer_topup !== false,
  }
}

export async function getPassportSettings(): Promise<PassportResult<{ settings: PassportSettings }>> {
  const ctx = await scoped("wallet.view", "wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  try {
    return { ok: true, settings: await loadSettings(ctx.supabase, ctx.tenantId) }
  } catch (error) {
    console.error("[passport] getPassportSettings failed", error)
    return { ok: false, error: "Couldn't load the Passport settings." }
  }
}

export async function updatePassportSettings(input: {
  minTopup: number
  maxTopup: number
  maxBalance: number | null
  allowCustomerTopup: boolean
}): Promise<PassportResult<{ settings: PassportSettings }>> {
  const ctx = await scoped("wallet.manage")
  if (!ctx.ok) return ctx

  const minTopup = round2(num(input?.minTopup))
  const maxTopup = round2(num(input?.maxTopup))
  const maxBalance = input?.maxBalance === null || input?.maxBalance === undefined ? null : round2(num(input.maxBalance))
  if (minTopup < 1 || minTopup > 100_000) return { ok: false, error: "The smallest top-up must be between 1 and 100,000." }
  if (maxTopup < minTopup || maxTopup > 1_000_000) {
    return { ok: false, error: "The largest top-up must be at least the smallest, and no more than 1,000,000." }
  }
  if (maxBalance !== null && (maxBalance < maxTopup || maxBalance > 10_000_000)) {
    return { ok: false, error: "The balance limit must be at least the largest top-up (or leave it blank for no limit)." }
  }

  // Only these four columns are written. The currency is fixed when the first Passport is created,
  // so changing it here would leave one shop with two currencies.
  const { error } = await ctx.supabase.from("wallet_settings").upsert(
    {
      tenant_id: ctx.tenantId,
      min_topup: minTopup,
      max_topup: maxTopup,
      max_balance: maxBalance,
      allow_customer_topup: input?.allowCustomerTopup !== false,
    },
    { onConflict: "tenant_id" },
  )
  if (error) {
    console.error("[passport] updatePassportSettings failed", error.message)
    return { ok: false, error: "Couldn't save the settings." }
  }
  try {
    return { ok: true, settings: await loadSettings(ctx.supabase, ctx.tenantId) }
  } catch {
    return { ok: true, settings: { ...DEFAULT_PASSPORT_SETTINGS, minTopup, maxTopup, maxBalance, allowCustomerTopup: input?.allowCustomerTopup !== false } }
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function dayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number)
  if (!y || !m || !d) return key
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return `${names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`
}

async function namesByStaffId(supabase: ServerClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v && UUID_RE.test(v)))]
  const map = new Map<string, string>()
  if (unique.length === 0) return map
  const { data } = await supabase.from("profiles").select("id, full_name").in("id", unique)
  for (const row of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
    if (row.full_name) map.set(row.id, row.full_name)
  }
  return map
}

type LedgerRow = {
  id: string
  wallet_id: string
  direction: "credit" | "debit"
  entry_type: string
  amount: number | string
  balance_after: number | string
  description: string | null
  created_at: string
  created_by: string | null
}

const LEDGER_COLUMNS = "id, wallet_id, direction, entry_type, amount, balance_after, description, created_at, created_by"

function toEntry(row: LedgerRow, names: Map<string, string>): PassportLedgerEntry {
  return {
    id: row.id,
    direction: row.direction,
    entryType: row.entry_type,
    amount: num(row.amount),
    balanceAfter: num(row.balance_after),
    description: row.description,
    createdAt: row.created_at,
    by: row.created_by ? (names.get(row.created_by) ?? null) : null,
  }
}

export async function loadPassportOverview(): Promise<PassportResult<{ overview: PassportOverview }>> {
  const ctx = await scoped("wallet.view", "wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  const { supabase, tenantId } = ctx

  try {
    const settings = await loadSettings(supabase, tenantId)
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()

    const [walletsRes, ledgerRes, pendingRes, recentRes, tzRes] = await Promise.all([
      supabase.from("wallets").select("balance, status").eq("tenant_id", tenantId).limit(20000),
      supabase
        .from("wallet_ledger")
        .select("direction, entry_type, amount, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .limit(50000),
      supabase.from("wallet_refund_requests").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "pending"),
      supabase.from("wallet_ledger").select(LEDGER_COLUMNS).eq("tenant_id", tenantId).order("seq", { ascending: false }).limit(10),
      supabase.from("tenant_settings").select("timezone").eq("tenant_id", tenantId).maybeSingle(),
    ])
    for (const r of [walletsRes, ledgerRes, pendingRes, recentRes]) if (r.error) throw new Error(r.error.message)

    const timeZone = (tzRes.data as { timezone?: string } | null)?.timezone || "Africa/Johannesburg"

    let totalBalance = 0
    let activeCount = 0
    let blockedCount = 0
    const wallets = (walletsRes.data ?? []) as Array<{ balance: number | string; status: string }>
    for (const w of wallets) {
      totalBalance += num(w.balance)
      if (w.status === "active") activeCount += 1
      if (w.status === "blocked") blockedCount += 1
    }

    // Seven day buckets in the shop's own timezone, oldest first.
    const today = new Date()
    const keys: string[] = []
    for (let i = 6; i >= 0; i -= 1) keys.push(dayKey(new Date(today.getTime() - i * 86_400_000), timeZone))
    const daily = new Map(keys.map((k) => [k, { day: k, label: dayLabel(k), topups: 0, spent: 0 }]))

    let topupsTotal = 0
    let spentTotal = 0
    let refundedTotal = 0
    for (const row of (ledgerRes.data ?? []) as Array<{ direction: string; entry_type: string; amount: number | string; created_at: string }>) {
      const amount = num(row.amount)
      const bucket = daily.get(dayKey(new Date(row.created_at), timeZone))
      if (row.entry_type === "topup" && row.direction === "credit") {
        topupsTotal += amount
        if (bucket) bucket.topups += amount
      } else if (row.entry_type === "purchase" && row.direction === "debit") {
        spentTotal += amount
        if (bucket) bucket.spent += amount
      } else if (row.entry_type === "refund" && row.direction === "credit") {
        refundedTotal += amount
      }
    }

    // Recent activity needs the customer's name: ledger -> wallet -> customer.
    const recentRows = (recentRes.data ?? []) as LedgerRow[]
    const walletIds = [...new Set(recentRows.map((r) => r.wallet_id))]
    const customerByWallet = new Map<string, string>()
    if (walletIds.length > 0) {
      const { data: wRows } = await supabase.from("wallets").select("id, customer_id").eq("tenant_id", tenantId).in("id", walletIds)
      const customerIds = [...new Set(((wRows ?? []) as Array<{ customer_id: string }>).map((w) => w.customer_id))]
      const { data: cRows } = customerIds.length
        ? await supabase.from("tenant_customers").select("id, full_name, phone").eq("tenant_id", tenantId).in("id", customerIds)
        : { data: [] as Array<{ id: string; full_name: string | null; phone: string | null }> }
      const nameByCustomer = new Map(
        ((cRows ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>).map((c) => [c.id, c.full_name?.trim() || c.phone || "Customer"]),
      )
      for (const w of (wRows ?? []) as Array<{ id: string; customer_id: string }>) {
        customerByWallet.set(w.id, nameByCustomer.get(w.customer_id) ?? "Customer")
      }
    }
    const staffNames = await namesByStaffId(supabase, recentRows.map((r) => r.created_by))
    const recent: PassportActivity[] = recentRows.map((r) => ({
      ...toEntry(r, staffNames),
      customerName: customerByWallet.get(r.wallet_id) ?? "Customer",
    }))

    return {
      ok: true,
      overview: {
        currency: settings.currency,
        totalBalance: round2(totalBalance),
        walletCount: wallets.length,
        activeCount,
        blockedCount,
        topupsTotal: round2(topupsTotal),
        spentTotal: round2(spentTotal),
        refundedTotal: round2(refundedTotal),
        pendingRefunds: pendingRes.count ?? 0,
        daily: keys.map((k) => {
          const d = daily.get(k)!
          return { ...d, topups: round2(d.topups), spent: round2(d.spent) }
        }),
        recent,
      },
    }
  } catch (error) {
    console.error("[passport] loadPassportOverview failed", error)
    return { ok: false, error: "Couldn't load the Passport overview." }
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

type CustomerRow = {
  id: string
  full_name: string | null
  phone: string | null
  email: string | null
  status: string
  created_at: string
}
type WalletRow = {
  id: string
  customer_id: string
  balance: number | string
  currency: string
  status: WalletStatus
  block_reason: string | null
}

function toAccount(c: CustomerRow, w: WalletRow | undefined, currency: string): PassportAccount {
  return {
    customerId: c.id,
    name: c.full_name?.trim() || c.phone || "Customer",
    phone: c.phone,
    email: c.email,
    customerStatus: c.status,
    customerSince: c.created_at,
    walletId: w?.id ?? null,
    balance: w ? num(w.balance) : 0,
    status: w?.status ?? null,
    blockReason: w?.block_reason ?? null,
    currency: w?.currency ?? currency,
  }
}

/** Letters, digits, spaces and a few name characters only: the term goes into a PostgREST filter. */
function searchTerm(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[^\p{L}\p{N}\s@.+'-]/gu, "").trim().slice(0, 60) : ""
}

/**
 * The Accounts list: every customer of the shop, with their Passport when they have one.
 *  - "All" + Newest / Name: customers first (a customer with no Passport yet still shows, so staff can
 *    open the first top-up from here).
 *  - A status filter or "Highest balance": Passports first (only customers who have one).
 *    Name sorting there orders the rows on the page, not the whole list.
 */
export async function listPassportAccounts(
  query: PassportAccountsQuery,
): Promise<PassportResult<{ accounts: PassportAccount[]; total: number; page: number; pageSize: number }>> {
  const ctx = await scoped("wallet.view", "wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  const { supabase, tenantId } = ctx

  try {
    const settings = await loadSettings(supabase, tenantId)
    const page = Math.max(0, Math.floor(Number(query?.page) || 0))
    const from = page * ACCOUNTS_PAGE_SIZE
    const to = from + ACCOUNTS_PAGE_SIZE - 1
    const search = searchTerm(query?.search)
    const status = query?.status === "active" || query?.status === "blocked" || query?.status === "closed" ? query.status : "all"
    const sort = query?.sort === "name" || query?.sort === "balance" ? query.sort : "newest"

    // Search narrows to a list of customer ids first (name, phone or email).
    let searchIds: string[] | null = null
    if (search) {
      const like = `%${search}%`
      const { data, error } = await supabase
        .from("tenant_customers")
        .select("id")
        .eq("tenant_id", tenantId)
        .or(`full_name.ilike.${like},phone.ilike.${like},email.ilike.${like}`)
        .limit(200)
      if (error) throw new Error(error.message)
      searchIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (searchIds.length === 0) return { ok: true, accounts: [], total: 0, page, pageSize: ACCOUNTS_PAGE_SIZE }
    }

    const walletFirst = status !== "all" || sort === "balance"

    if (walletFirst) {
      let q = supabase
        .from("wallets")
        .select("id, customer_id, balance, currency, status, block_reason", { count: "exact" })
        .eq("tenant_id", tenantId)
      if (status !== "all") q = q.eq("status", status)
      if (searchIds) q = q.in("customer_id", searchIds)
      q = sort === "balance" ? q.order("balance", { ascending: false }) : q.order("created_at", { ascending: false })
      const { data, error, count } = await q.range(from, to)
      if (error) throw new Error(error.message)
      const wallets = (data ?? []) as WalletRow[]
      const ids = wallets.map((w) => w.customer_id)
      const { data: cRows, error: cErr } = ids.length
        ? await supabase.from("tenant_customers").select("id, full_name, phone, email, status, created_at").eq("tenant_id", tenantId).in("id", ids)
        : { data: [] as CustomerRow[], error: null }
      if (cErr) throw new Error(cErr.message)
      const byId = new Map(((cRows ?? []) as CustomerRow[]).map((c) => [c.id, c]))
      let accounts = wallets
        .map((w) => {
          const c = byId.get(w.customer_id)
          return c ? toAccount(c, w, settings.currency) : null
        })
        .filter((a): a is PassportAccount => a !== null)
      if (sort === "name") accounts = accounts.sort((a, b) => a.name.localeCompare(b.name))
      return { ok: true, accounts, total: count ?? accounts.length, page, pageSize: ACCOUNTS_PAGE_SIZE }
    }

    let q = supabase
      .from("tenant_customers")
      .select("id, full_name, phone, email, status, created_at", { count: "exact" })
      .eq("tenant_id", tenantId)
    if (searchIds) q = q.in("id", searchIds)
    q = sort === "name" ? q.order("full_name", { ascending: true, nullsFirst: false }) : q.order("created_at", { ascending: false })
    const { data, error, count } = await q.range(from, to)
    if (error) throw new Error(error.message)
    const customers = (data ?? []) as CustomerRow[]
    const ids = customers.map((c) => c.id)
    const { data: wRows, error: wErr } = ids.length
      ? await supabase.from("wallets").select("id, customer_id, balance, currency, status, block_reason").eq("tenant_id", tenantId).in("customer_id", ids)
      : { data: [] as WalletRow[], error: null }
    if (wErr) throw new Error(wErr.message)
    const walletBy = new Map(((wRows ?? []) as WalletRow[]).map((w) => [w.customer_id, w]))
    return {
      ok: true,
      accounts: customers.map((c) => toAccount(c, walletBy.get(c.id), settings.currency)),
      total: count ?? customers.length,
      page,
      pageSize: ACCOUNTS_PAGE_SIZE,
    }
  } catch (error) {
    console.error("[passport] listPassportAccounts failed", error)
    return { ok: false, error: "Couldn't load the accounts." }
  }
}

function toRefund(
  r: {
    id: string
    wallet_id: string
    amount: number | string
    reason: string
    status: string
    review_note: string | null
    created_at: string
    processed_at: string | null
  },
  customerName: string,
  customerPhone: string | null,
): PassportRefund {
  return {
    id: r.id,
    walletId: r.wallet_id,
    customerName,
    customerPhone,
    amount: num(r.amount),
    reason: r.reason,
    status: r.status === "approved" || r.status === "rejected" ? r.status : "pending",
    reviewNote: r.review_note,
    createdAt: r.created_at,
    processedAt: r.processed_at,
  }
}

const REFUND_COLUMNS = "id, wallet_id, amount, reason, status, review_note, created_at, processed_at"

export async function getPassportAccount(customerId: string): Promise<PassportResult<{ detail: PassportAccountDetail }>> {
  const ctx = await scoped("wallet.view", "wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  if (!UUID_RE.test(customerId ?? "")) return { ok: false, error: "That customer wasn't found." }
  const { supabase, tenantId } = ctx

  try {
    const settings = await loadSettings(supabase, tenantId)
    const { data: c, error: cErr } = await supabase
      .from("tenant_customers")
      .select("id, full_name, phone, email, status, created_at")
      .eq("tenant_id", tenantId)
      .eq("id", customerId)
      .maybeSingle()
    if (cErr) throw new Error(cErr.message)
    if (!c) return { ok: false, error: "That customer wasn't found." }

    const { data: w, error: wErr } = await supabase
      .from("wallets")
      .select("id, customer_id, balance, currency, status, block_reason")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .maybeSingle()
    if (wErr) throw new Error(wErr.message)

    const account = toAccount(c as CustomerRow, (w ?? undefined) as WalletRow | undefined, settings.currency)
    if (!w) {
      return {
        ok: true,
        detail: { account, ledger: [], refunds: [], totals: { topups: 0, spent: 0, refunded: 0, adjustments: 0 } },
      }
    }

    const [ledgerRes, allRes, refundRes] = await Promise.all([
      supabase.from("wallet_ledger").select(LEDGER_COLUMNS).eq("tenant_id", tenantId).eq("wallet_id", w.id).order("seq", { ascending: false }).limit(200),
      supabase.from("wallet_ledger").select("direction, entry_type, amount").eq("tenant_id", tenantId).eq("wallet_id", w.id).limit(50000),
      supabase.from("wallet_refund_requests").select(REFUND_COLUMNS).eq("tenant_id", tenantId).eq("wallet_id", w.id).order("created_at", { ascending: false }).limit(50),
    ])
    for (const r of [ledgerRes, allRes, refundRes]) if (r.error) throw new Error(r.error.message)

    const rows = (ledgerRes.data ?? []) as LedgerRow[]
    const names = await namesByStaffId(supabase, rows.map((r) => r.created_by))

    const totals = { topups: 0, spent: 0, refunded: 0, adjustments: 0 }
    for (const r of (allRes.data ?? []) as Array<{ direction: string; entry_type: string; amount: number | string }>) {
      const a = num(r.amount)
      if (r.entry_type === "topup" && r.direction === "credit") totals.topups += a
      else if (r.entry_type === "purchase" && r.direction === "debit") totals.spent += a
      else if (r.entry_type === "refund" && r.direction === "credit") totals.refunded += a
      else if (r.entry_type === "adjustment") totals.adjustments += r.direction === "credit" ? a : -a
    }

    return {
      ok: true,
      detail: {
        account,
        ledger: rows.map((r) => toEntry(r, names)),
        refunds: ((refundRes.data ?? []) as Array<Parameters<typeof toRefund>[0]>).map((r) => toRefund(r, account.name, account.phone)),
        totals: {
          topups: round2(totals.topups),
          spent: round2(totals.spent),
          refunded: round2(totals.refunded),
          adjustments: round2(totals.adjustments),
        },
      },
    }
  } catch (error) {
    console.error("[passport] getPassportAccount failed", error)
    return { ok: false, error: "Couldn't load this account." }
  }
}

// ---------------------------------------------------------------------------
// Counter actions (top-up, deduct, block / unblock, refunds)
// ---------------------------------------------------------------------------

/** Cash / card / EFT top-up taken at the counter. Needs wallet.operate or wallet.manage. */
export async function topUpPassport(input: {
  customerId: string
  amount: number
  method: string
  note?: string
  key: string
}): Promise<PassportResult<{ balance: number }>> {
  const ctx = await scoped("wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  if (!UUID_RE.test(input?.customerId ?? "")) return { ok: false, error: "That customer wasn't found." }
  const amount = cleanAmount(input?.amount)
  if (amount === null) return { ok: false, error: "Enter an amount above zero." }
  const method = PAYMENT_METHODS.find((m) => m.value === input?.method)?.value
  if (!method) return { ok: false, error: "Choose how the customer paid." }
  const key = cleanKey(input?.key)
  if (!key) return { ok: false, error: GENERIC_ERROR }

  const db = await sessionDb()
  const { data, error } = await db.rpc("wallet_staff_topup", {
    p_tenant_id: ctx.tenantId,
    p_customer_id: input.customerId,
    p_amount: amount,
    p_payment_method: method,
    p_idempotency_key: key,
    p_note: cleanText(input?.note, 200) || null,
  })
  if (error) return { ok: false, error: friendly(error) }
  return { ok: true, balance: num((data as { balance_after?: number } | null)?.balance_after) }
}

/** Manager correction: add or remove money with a written reason. Needs wallet.manage. */
export async function adjustPassport(input: {
  customerId: string
  direction: "credit" | "debit"
  amount: number
  reason: string
  key: string
}): Promise<PassportResult<{ balance: number }>> {
  const ctx = await scoped("wallet.manage")
  if (!ctx.ok) return ctx
  if (!UUID_RE.test(input?.customerId ?? "")) return { ok: false, error: "That customer wasn't found." }
  if (input?.direction !== "credit" && input?.direction !== "debit") return { ok: false, error: GENERIC_ERROR }
  const amount = cleanAmount(input?.amount)
  if (amount === null) return { ok: false, error: "Enter an amount above zero." }
  const reason = cleanText(input?.reason, 200)
  if (!reason) return { ok: false, error: "Please write a reason for the correction." }
  const key = cleanKey(input?.key)
  if (!key) return { ok: false, error: GENERIC_ERROR }

  const db = await sessionDb()
  const { data, error } = await db.rpc("wallet_adjust", {
    p_tenant_id: ctx.tenantId,
    p_customer_id: input.customerId,
    p_direction: input.direction,
    p_amount: amount,
    p_reason: reason,
    p_idempotency_key: key,
  })
  if (error) return { ok: false, error: friendly(error) }
  return { ok: true, balance: num((data as { balance_after?: number } | null)?.balance_after) }
}

/** Block, unblock or close a Passport. Needs wallet.manage. */
export async function setPassportStatus(input: {
  walletId: string
  status: WalletStatus
  reason?: string
}): Promise<PassportResult> {
  const ctx = await scoped("wallet.manage")
  if (!ctx.ok) return ctx
  if (!UUID_RE.test(input?.walletId ?? "")) return { ok: false, error: "That Passport wasn't found." }
  if (!["active", "blocked", "closed"].includes(input?.status)) return { ok: false, error: GENERIC_ERROR }

  // The shop check is made here, so an id from another shop is reported as "not found".
  const { data: own } = await ctx.supabase.from("wallets").select("id").eq("tenant_id", ctx.tenantId).eq("id", input.walletId).maybeSingle()
  if (!own) return { ok: false, error: "That Passport wasn't found." }

  const db = await sessionDb()
  const { error } = await db.rpc("wallet_set_status", {
    p_wallet_id: input.walletId,
    p_status: input.status,
    p_reason: cleanText(input?.reason, 200) || null,
  })
  if (error) return { ok: false, error: friendly(error) }
  return { ok: true }
}

/** Raise a refund request on a customer's behalf. Needs wallet.operate or wallet.manage. */
export async function requestPassportRefund(input: {
  customerId: string
  amount: number
  reason: string
}): Promise<PassportResult> {
  const ctx = await scoped("wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  if (!UUID_RE.test(input?.customerId ?? "")) return { ok: false, error: "That customer wasn't found." }
  const amount = cleanAmount(input?.amount)
  if (amount === null) return { ok: false, error: "Enter an amount above zero." }
  const reason = cleanText(input?.reason, 200)
  if (!reason) return { ok: false, error: "Please write a reason for the refund." }

  const db = await sessionDb()
  const { error } = await db.rpc("wallet_request_refund", {
    p_tenant_id: ctx.tenantId,
    p_amount: amount,
    p_reason: reason,
    p_customer_id: input.customerId,
    p_reference_type: null,
    p_reference_id: null,
  })
  if (error) return { ok: false, error: friendly(error) }
  return { ok: true }
}

export async function listPassportRefunds(
  status: "pending" | "approved" | "rejected" | "all",
): Promise<PassportResult<{ refunds: PassportRefund[]; pending: number }>> {
  const ctx = await scoped("wallet.view", "wallet.operate", "wallet.manage")
  if (!ctx.ok) return ctx
  const { supabase, tenantId } = ctx

  try {
    let q = supabase.from("wallet_refund_requests").select(REFUND_COLUMNS).eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(100)
    if (status !== "all") q = q.eq("status", status)
    const [listRes, pendingRes] = await Promise.all([
      q,
      supabase.from("wallet_refund_requests").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "pending"),
    ])
    if (listRes.error) throw new Error(listRes.error.message)
    if (pendingRes.error) throw new Error(pendingRes.error.message)

    const rows = (listRes.data ?? []) as Array<Parameters<typeof toRefund>[0]>
    const walletIds = [...new Set(rows.map((r) => r.wallet_id))]
    const nameByWallet = new Map<string, { name: string; phone: string | null }>()
    if (walletIds.length > 0) {
      const { data: wRows } = await supabase.from("wallets").select("id, customer_id").eq("tenant_id", tenantId).in("id", walletIds)
      const customerIds = [...new Set(((wRows ?? []) as Array<{ customer_id: string }>).map((w) => w.customer_id))]
      const { data: cRows } = customerIds.length
        ? await supabase.from("tenant_customers").select("id, full_name, phone").eq("tenant_id", tenantId).in("id", customerIds)
        : { data: [] as Array<{ id: string; full_name: string | null; phone: string | null }> }
      const byCustomer = new Map(((cRows ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>).map((c) => [c.id, c]))
      for (const w of (wRows ?? []) as Array<{ id: string; customer_id: string }>) {
        const c = byCustomer.get(w.customer_id)
        nameByWallet.set(w.id, { name: c?.full_name?.trim() || c?.phone || "Customer", phone: c?.phone ?? null })
      }
    }
    return {
      ok: true,
      refunds: rows.map((r) => {
        const who = nameByWallet.get(r.wallet_id)
        return toRefund(r, who?.name ?? "Customer", who?.phone ?? null)
      }),
      pending: pendingRes.count ?? 0,
    }
  } catch (error) {
    console.error("[passport] listPassportRefunds failed", error)
    return { ok: false, error: "Couldn't load the refund requests." }
  }
}

/** Approve (credits the customer's Passport) or decline a refund request. Needs wallet.manage. */
export async function reviewPassportRefund(input: { requestId: string; approve: boolean; note?: string }): Promise<PassportResult> {
  const ctx = await scoped("wallet.manage")
  if (!ctx.ok) return ctx
  if (!UUID_RE.test(input?.requestId ?? "")) return { ok: false, error: "That request wasn't found." }

  const { data: own } = await ctx.supabase
    .from("wallet_refund_requests")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("id", input.requestId)
    .maybeSingle()
  if (!own) return { ok: false, error: "That request wasn't found." }

  const db = await sessionDb()
  const { error } = await db.rpc("wallet_review_refund", {
    p_request_id: input.requestId,
    p_approve: input.approve === true,
    p_note: cleanText(input?.note, 200) || null,
  })
  if (error) return { ok: false, error: friendly(error) }
  return { ok: true }
}
