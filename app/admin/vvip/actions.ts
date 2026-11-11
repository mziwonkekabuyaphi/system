// app/admin/vvip/actions.ts
"use server"

/**
 * Server Actions for VVIP tables (premium tables with a prepaid bar tab).
 * ------------------------------------------------------------------------
 * Same layers as app/admin/events/actions.ts and app/admin/passport/actions.ts:
 *   1. requireTenantPermission() proves the signed-in user holds the key for THEIR shop. The
 *      tenantId comes from the membership, never the browser.
 *   2. isModuleEnabled() proves the "vvip" module is on (platform admin > Modules) and so is "events",
 *      which it needs (and Events needs Passport). A switch-off shuts every action, even from a stale page.
 *   3. READS use the service-role client and are always filtered by tenant_id (RLS is not
 *      protecting those, so each loader checks vvip.view first). WRITES never touch a vvip_* table:
 *      the database refuses direct writes. Everything goes through the vvip_* functions, called on
 *      the signed-in user's own session, because those functions identify the user with auth.uid()
 *      and reject service-role calls by design.
 *
 * Nothing here does money arithmetic that matters. The tab balance, the Passport charge and the
 * refund all change inside the database in one transaction. The sums below (revenue, outstanding
 * tabs) are display totals read from complete, paged results.
 */

import { createSessionClient } from "@/lib/supabase/session-server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { isModuleEnabled } from "@/lib/tenant/modules"
import type { CustomerHit, PassportBalance } from "../events/types"
import {
  isLiveStatus,
  isOpenTabStatus,
  type BookTableInput,
  type BookablePayment,
  type BookingPayment,
  type BookingReceipt,
  type BookingStatus,
  type EntryType,
  type PackageStatus,
  type SavePackageInput,
  type TabEntryReceipt,
  type TopupMethod,
  type VvipBooking,
  type VvipData,
  type VvipLedgerEntry,
  type VvipPackage,
  type VvipTabFlow,
  type VvipTable,
} from "./types"

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }
type Fail = { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scope = { ok: true; read: ServerClient; tenantId: string } | Fail
type Row = Record<string, unknown>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/
const MODULE_OFF = "VVIP isn't switched on for your business."
const GENERIC_ERROR = "Something went wrong. Please try again."
const NOT_FOUND_PACKAGE = "Package not found."
const NOT_FOUND_BOOKING = "Booking not found."

const IMAGE_BUCKET = "vvip-images"
const IMAGE_MAX_BYTES = 3 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }
const PAGE = 1000
const MAX_MONEY = 1_000_000
const MAX_TABLES = 200

const BOOKABLE: BookablePayment[] = ["cash", "card", "eft", "wallet", "complimentary"]
const TOPUP_METHODS: TopupMethod[] = ["cash", "card", "eft"]
const PACKAGE_STATUSES: PackageStatus[] = ["active", "inactive", "archived"]
const MOVES: BookingStatus[] = ["checked_in", "seated", "completed", "no_show"]

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const fail = (error: string): Fail => ({ ok: false, error })
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v)
/** Removes float noise from a sum of 2-decimal amounts. Display only. */
const cents = (n: number): number => Math.round(n * 100) / 100
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

/** A money amount to spend, add or adjust: finite, above zero, at most 2 decimals. Returns the exact
 *  2-decimal value, or null if it isn't one. */
function amountOf(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_MONEY) return null
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? Math.round(v * 100) / 100 : null
}

/** Same, but zero is allowed (a package price or tab credit can be nothing). */
function amountOrZero(v: unknown): number | null {
  return v === 0 ? 0 : amountOf(v)
}

/** Proves the caller holds ANY ONE of the given keys, and that the Events module is on. */
async function scoped(...permissions: PermissionKey[]): Promise<Scope> {
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
  if (!tenantId) return fail(lastError)

  const read = getSupabaseServerClient()
  if (!read) return fail("Supabase isn't configured.")
  // VVIP's own switch, and Events (the database functions check Events too, and packages belong to an event).
  if (!(await isModuleEnabled(tenantId, "vvip")) || !(await isModuleEnabled(tenantId, "events"))) return fail(MODULE_OFF)
  return { ok: true, read, tenantId }
}

/** The user's own session client: auth.uid() is set, which every vvip_* function requires. */
async function sessionDb() {
  return createSessionClient()
}

/** Can this person charge a customer's Passport? Same rule as the box office. */
async function mayChargePassport(): Promise<boolean> {
  for (const key of ["wallet.operate", "wallet.manage"] as const) {
    if ((await requireTenantPermission(key)).ok) return true
  }
  return false
}

/** Database messages raised on purpose ("Insufficient tab balance", "That table is already booked")
 *  are written for people and pass through; anything that looks technical is replaced by a generic
 *  line and logged here. The product calls the customer wallet "Passport", so that word is swapped in. */
function friendly(error: { message?: string } | null | undefined): string {
  const m = (error?.message ?? "").trim()
  if (!m) return GENERIC_ERROR
  if (m.length > 160 || /violates|duplicate key|syntax|relation |column |function |permission denied|row-level security|JWT/i.test(m)) {
    console.error("[vvip] database error:", m)
    return GENERIC_ERROR
  }
  return m.replace(/customer wallets/gi, "customer Passports").replace(/\bwallet\b/gi, "Passport")
}

function cleanKey(key: unknown): string | null {
  return typeof key === "string" && KEY_RE.test(key) ? `ui:${key}` : null
}

/** PostgREST caps one response (1,000 rows by default), so a total must be read page by page or it
 *  silently undercounts. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  cap = 50_000,
): Promise<{ rows: T[]; error?: string }> {
  const rows: T[] = []
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) return { rows, error: error.message }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return { rows }
}

/** An id list in an .in() filter goes into the URL, so long lists are read in chunks. */
function chunks<T>(list: T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** rpc() on a function that returns one row can come back as an object or a one-item array. */
function oneRow(data: unknown): Row | null {
  const first = Array.isArray(data) ? data[0] : data
  return first && typeof first === "object" ? (first as Row) : null
}

// ============================================================================
// Loading
// ============================================================================

/** Everything both VVIP pages need, in one round trip: packages with their tables, bookings with
 *  buyer names, the shop's events, and the headline totals. */
export async function loadVvip(): Promise<ActionResult<VvipData>> {
  const c = await scoped("vvip.view")
  if (!c.ok) return c
  const { read, tenantId } = c

  const [pkgs, tbls, bks, evs] = await Promise.all([
    fetchAll<Row>((a, b) =>
      read
        .from("vvip_packages")
        .select("id,event_id,name,description,price,tab_credit,seats_per_table,benefits,image_url,status,created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(a, b),
    ),
    fetchAll<Row>((a, b) =>
      read.from("vvip_tables").select("id,package_id,label,sort_order").eq("tenant_id", tenantId).order("id").range(a, b),
    ),
    fetchAll<Row>((a, b) =>
      read
        .from("vvip_bookings")
        .select(
          "id,package_id,table_id,customer_id,reference,status,price_paid,tab_credit_issued,tab_balance,payment_method,refunded_amount,refund_method,cancel_reason,notes,created_at",
        )
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(a, b),
    ),
    fetchAll<Row>((a, b) =>
      read.from("events").select("id,name,start_time,status").eq("tenant_id", tenantId).order("start_time", { ascending: false }).order("id").range(a, b),
    ),
  ])
  // A partial read would show wrong totals, so any failed page fails the whole load.
  const broken = pkgs.error ?? tbls.error ?? bks.error ?? evs.error
  if (broken) {
    console.error("[vvip] loadVvip failed", broken)
    return fail("Couldn't load VVIP tables.")
  }

  // Buyer names, read in chunks so a long id list can't overflow the request URL.
  const customerIds = [...new Set(bks.rows.map((b) => str(b.customer_id)).filter((v): v is string => !!v))]
  const customers = new Map<string, { name: string | null; phone: string | null }>()
  for (const part of chunks(customerIds)) {
    const { data, error } = await read.from("tenant_customers").select("id,full_name,phone").in("id", part).eq("tenant_id", tenantId)
    if (error) {
      console.error("[vvip] customers failed", error.message)
      return fail("Couldn't load VVIP tables.")
    }
    for (const r of (data ?? []) as Row[]) customers.set(String(r.id), { name: str(r.full_name), phone: str(r.phone) })
  }

  const events = evs.rows.map((e) => ({ id: String(e.id), name: String(e.name), startTime: String(e.start_time), status: String(e.status) }))
  const eventById = new Map(events.map((e) => [e.id, e]))

  // A table counts as booked while it has a live booking (not cancelled, not a no-show).
  const bookedTables = new Set<string>()
  for (const b of bks.rows) {
    const tableId = str(b.table_id)
    if (tableId && isLiveStatus(b.status as BookingStatus)) bookedTables.add(tableId)
  }

  const tablesByPackage = new Map<string, VvipTable[]>()
  const tableLabel = new Map<string, string>()
  for (const t of tbls.rows) {
    const table: VvipTable = { id: String(t.id), label: String(t.label), sortOrder: num(t.sort_order), booked: bookedTables.has(String(t.id)) }
    tableLabel.set(table.id, table.label)
    const list = tablesByPackage.get(String(t.package_id)) ?? []
    list.push(table)
    tablesByPackage.set(String(t.package_id), list)
  }

  const packageName = new Map(pkgs.rows.map((p) => [String(p.id), String(p.name)]))
  const revenueByPackage = new Map<string, number>()
  const bookedByPackage = new Map<string, number>()

  const bookings: VvipBooking[] = bks.rows.map((b) => {
    const customer = customers.get(String(b.customer_id))
    const status = b.status as BookingStatus
    const packageId = String(b.package_id)
    if (status !== "cancelled") {
      revenueByPackage.set(packageId, (revenueByPackage.get(packageId) ?? 0) + num(b.price_paid) - num(b.refunded_amount))
    }
    if (isLiveStatus(status) && str(b.table_id)) bookedByPackage.set(packageId, (bookedByPackage.get(packageId) ?? 0) + 1)
    const tableId = str(b.table_id)
    return {
      id: String(b.id),
      reference: String(b.reference ?? ""),
      packageId,
      packageName: packageName.get(packageId) ?? "Package",
      tableId,
      tableLabel: tableId ? tableLabel.get(tableId) ?? null : null,
      customerId: String(b.customer_id),
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      status,
      pricePaid: num(b.price_paid),
      tabCreditIssued: num(b.tab_credit_issued),
      tabBalance: num(b.tab_balance),
      paymentMethod: b.payment_method as BookingPayment,
      refundedAmount: num(b.refunded_amount),
      refundMethod: (b.refund_method as VvipBooking["refundMethod"]) ?? null,
      cancelReason: str(b.cancel_reason),
      notes: str(b.notes),
      createdAt: String(b.created_at),
    }
  })

  const packages: VvipPackage[] = pkgs.rows.map((p) => {
    const id = String(p.id)
    const event = eventById.get(String(p.event_id))
    const tables = (tablesByPackage.get(id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, undefined, { numeric: true }))
    return {
      id,
      eventId: String(p.event_id),
      eventName: event?.name ?? null,
      eventStart: event?.startTime ?? null,
      name: String(p.name),
      description: str(p.description),
      price: num(p.price),
      tabCredit: num(p.tab_credit),
      seatsPerTable: num(p.seats_per_table),
      benefits: Array.isArray(p.benefits) ? (p.benefits as unknown[]).filter((x): x is string => typeof x === "string") : [],
      imageUrl: str(p.image_url),
      status: p.status as PackageStatus,
      tables,
      bookedCount: tables.filter((t) => t.booked).length,
      revenue: cents(revenueByPackage.get(id) ?? 0),
    }
  })

  const live = bookings.filter((b) => isLiveStatus(b.status))
  const summary = {
    buyers: new Set(live.map((b) => b.customerId)).size,
    tablesSold: live.length,
    tabOutstanding: cents(bookings.filter((b) => isOpenTabStatus(b.status)).reduce((n, b) => n + b.tabBalance, 0)),
    revenue: cents(bookings.filter((b) => b.status !== "cancelled").reduce((n, b) => n + b.pricePaid - b.refundedAmount, 0)),
  }

  return { ok: true, data: { packages, bookings, events, summary } }
}

/** One tab's history, newest first. Ordered by seq (the database's own sequence), never by time. */
export async function loadTabLedger(bookingId: string): Promise<ActionResult<VvipLedgerEntry[]>> {
  const c = await scoped("vvip.view")
  if (!c.ok) return c
  if (!isUuid(bookingId)) return fail(NOT_FOUND_BOOKING)

  const { data, error } = await c.read
    .from("vvip_tab_ledger")
    .select("id,seq,direction,entry_type,amount,balance_after,description,created_at")
    .eq("tenant_id", c.tenantId)
    .eq("booking_id", bookingId)
    .order("seq", { ascending: false })
    .limit(500)
  if (error) return fail(friendly(error))

  return {
    ok: true,
    data: ((data ?? []) as Row[]).map((r) => ({
      id: String(r.id),
      seq: num(r.seq),
      direction: r.direction === "debit" ? "debit" : "credit",
      entryType: r.entry_type as EntryType,
      amount: num(r.amount),
      balanceAfter: num(r.balance_after),
      description: str(r.description),
      createdAt: String(r.created_at),
    })),
  }
}

/** Spend and top-ups per booking, for the analytics panel's utilisation and top-customers lists.
 *  Paged, because one busy night can put well over 1,000 spend rows in the ledger. */
export async function loadTabFlow(): Promise<ActionResult<VvipTabFlow[]>> {
  const c = await scoped("vvip.view")
  if (!c.ok) return c
  const { read, tenantId } = c

  const { rows, error } = await fetchAll<Row>((a, b) =>
    read
      .from("vvip_tab_ledger")
      .select("booking_id,entry_type,amount")
      .eq("tenant_id", tenantId)
      .in("entry_type", ["spend", "topup"])
      .order("seq")
      .range(a, b),
  )
  if (error) return fail(friendly({ message: error }))

  const byBooking = new Map<string, VvipTabFlow>()
  for (const r of rows) {
    const id = String(r.booking_id)
    const flow = byBooking.get(id) ?? { bookingId: id, spent: 0, toppedUp: 0 }
    if (r.entry_type === "spend") flow.spent += num(r.amount)
    else flow.toppedUp += num(r.amount)
    byBooking.set(id, flow)
  }
  return { ok: true, data: [...byBooking.values()].map((f) => ({ ...f, spent: cents(f.spent), toppedUp: cents(f.toppedUp) })) }
}

// ============================================================================
// Packages and tables
// ============================================================================

function validatePackage(input: SavePackageInput): string | null {
  if (!input.name.trim()) return "Give the package a name."
  if (input.name.trim().length > 120) return "Keep the package name under 120 characters."
  if (amountOrZero(input.price) === null) return "Set a price of 0 or more, with at most 2 decimals."
  if (amountOrZero(input.tabCredit) === null) return "Set a tab credit of 0 or more, with at most 2 decimals."
  if (!Number.isInteger(input.seatsPerTable) || input.seatsPerTable < 1 || input.seatsPerTable > 100) return "Seats per table must be a whole number from 1 to 100."
  if (!PACKAGE_STATUSES.includes(input.status)) return "Choose a status."
  if (input.tableLabels.length < 1 || input.tableLabels.length > MAX_TABLES) return `A package needs between 1 and ${MAX_TABLES} tables.`
  const seen = new Set<string>()
  for (const raw of input.tableLabels) {
    const label = raw.trim()
    if (!label) return "Every table needs a name."
    if (label.length > 40) return "Keep table names under 40 characters."
    if (seen.has(label.toLowerCase())) return `Two tables are called "${label}". Give each its own name.`
    seen.add(label.toLowerCase())
  }
  if (input.benefits.length > 20) return "A package can list up to 20 benefits."
  if (input.benefits.some((b) => b.trim().length === 0 || b.trim().length > 120)) return "Keep each benefit under 120 characters."
  return null
}

/** Create or update a package AND sync its tables to the named list, in one database call. */
export async function savePackage(input: SavePackageInput): Promise<ActionResult<{ id: string }>> {
  const c = await scoped("vvip.manage")
  if (!c.ok) return c
  const { read, tenantId } = c
  if (!isUuid(input.eventId)) return fail("Choose an event for this package.")
  if (input.id !== undefined && !isUuid(input.id)) return fail(NOT_FOUND_PACKAGE)
  const invalid = validatePackage(input)
  if (invalid) return fail(invalid)

  // Both ids must belong to this shop. The function checks too; this keeps the message friendly.
  const { data: event } = await read.from("events").select("id").eq("id", input.eventId).eq("tenant_id", tenantId).maybeSingle()
  if (!event) return fail("That event wasn't found. Reload and try again.")
  if (input.id) {
    const { data: existing } = await read.from("vvip_packages").select("id").eq("id", input.id).eq("tenant_id", tenantId).maybeSingle()
    if (!existing) return fail(NOT_FOUND_PACKAGE)
  }

  const write = await sessionDb()
  const { data, error } = await write.rpc("vvip_save_package", {
    p_event_id: input.eventId,
    p_package_id: input.id ?? null,
    p_name: input.name.trim(),
    p_description: input.description.trim().slice(0, 2000) || null,
    p_price: amountOrZero(input.price),
    p_tab_credit: amountOrZero(input.tabCredit),
    p_seats_per_table: input.seatsPerTable,
    p_benefits: input.benefits.map((b) => b.trim()),
    p_status: input.status,
    p_table_labels: input.tableLabels.map((l) => l.trim()),
  })
  if (error) return fail(friendly(error))
  if (!isUuid(data)) return fail("The package didn't save. Reload and check before trying again.")
  return { ok: true, data: { id: data } }
}

/** Upload happens on the user's session (the bucket policy checks the {tenant_id}/ path), then the
 *  URL is stored through vvip_set_package_image. A failure here never undoes the saved package. */
export async function uploadPackageImage(packageId: string, formData: FormData): Promise<ActionResult<{ url: string }>> {
  const c = await scoped("vvip.manage")
  if (!c.ok) return c
  const { read, tenantId } = c
  if (!isUuid(packageId)) return fail(NOT_FOUND_PACKAGE)

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return fail("Choose an image to upload.")
  const ext = IMAGE_TYPES[file.type]
  if (!ext) return fail("Use a PNG, JPG or WebP image.")
  if (file.size > IMAGE_MAX_BYTES) return fail("The image must be under 3 MB.")

  const { data: pkg } = await read.from("vvip_packages").select("id,image_url").eq("id", packageId).eq("tenant_id", tenantId).maybeSingle()
  if (!pkg) return fail(NOT_FOUND_PACKAGE)

  // Path convention required by the bucket policy: {tenant_id}/{package_id}/{file}
  const write = await sessionDb()
  const path = `${tenantId}/${packageId}/${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await write.storage.from(IMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) return fail(friendly(uploadError))

  const url = write.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
  const { error: saveError } = await write.rpc("vvip_set_package_image", { p_package_id: packageId, p_image_url: url })
  if (saveError) {
    await write.storage.from(IMAGE_BUCKET).remove([path])
    return fail(friendly(saveError))
  }

  // Tidy up the image this replaces (best effort).
  const old = typeof pkg.image_url === "string" ? pkg.image_url : null
  const marker = `/${IMAGE_BUCKET}/`
  if (old && old.includes(marker)) {
    const oldPath = decodeURIComponent(old.split(marker)[1] ?? "")
    if (oldPath.startsWith(`${tenantId}/`)) await write.storage.from(IMAGE_BUCKET).remove([oldPath])
  }
  return { ok: true, data: { url } }
}

export async function setPackageStatus(packageId: string, status: PackageStatus): Promise<ActionResult> {
  const c = await scoped("vvip.manage")
  if (!c.ok) return c
  if (!isUuid(packageId) || !PACKAGE_STATUSES.includes(status)) return fail(NOT_FOUND_PACKAGE)
  const write = await sessionDb()
  const { error } = await write.rpc("vvip_set_package_status", { p_package_id: packageId, p_status: status })
  if (error) return fail(friendly(error))
  return { ok: true, data: undefined }
}

/** Permanent delete. The database refuses it once the package has ever had a booking, and that
 *  message ("...Archive it instead") is shown as it is. */
export async function deletePackage(packageId: string): Promise<ActionResult> {
  const c = await scoped("vvip.manage")
  if (!c.ok) return c
  if (!isUuid(packageId)) return fail(NOT_FOUND_PACKAGE)
  const write = await sessionDb()
  const { error } = await write.rpc("vvip_delete_package", { p_package_id: packageId })
  if (error) return fail(friendly(error))
  return { ok: true, data: undefined }
}

// ============================================================================
// Booking a table
// ============================================================================

export async function searchVvipCustomers(query: string): Promise<ActionResult<CustomerHit[]>> {
  const c = await scoped("vvip.operate")
  if (!c.ok) return c
  // Strip characters that have meaning inside a PostgREST filter.
  const q = (typeof query === "string" ? query : "").replace(/[%,()*\\]/g, " ").trim().slice(0, 60)
  if (q.length < 2) return { ok: true, data: [] }
  const { data, error } = await c.read
    .from("tenant_customers")
    .select("id,full_name,phone")
    .eq("tenant_id", c.tenantId)
    .eq("status", "active")
    .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(8)
  if (error) return fail(friendly(error))
  return {
    ok: true,
    data: ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), name: str(r.full_name), phone: String(r.phone ?? "") })),
  }
}

/** The customer's Passport balance, so the dialog can warn before a Passport sale. Only people who
 *  can book a table AND charge a Passport may look. */
export async function loadVvipPassportBalance(customerId: string): Promise<ActionResult<PassportBalance>> {
  const c = await scoped("vvip.operate")
  if (!c.ok) return c
  if (!isUuid(customerId)) return fail("Customer not found.")
  if (!(await mayChargePassport())) return fail("You don't have permission to charge a Passport.")
  if (!(await isModuleEnabled(c.tenantId, "wallet"))) return fail("Passport isn't switched on for your business.")

  const { data, error } = await c.read
    .from("wallets")
    .select("balance,status,block_reason")
    .eq("tenant_id", c.tenantId)
    .eq("customer_id", customerId)
    .maybeSingle()
  if (error) return fail(friendly(error))
  if (!data) return { ok: true, data: { balance: 0, status: "none", blockReason: null } }
  return {
    ok: true,
    data: { balance: num(data.balance), status: data.status as PassportBalance["status"], blockReason: str(data.block_reason) },
  }
}

export async function bookTable(input: BookTableInput): Promise<ActionResult<BookingReceipt>> {
  const c = await scoped("vvip.operate")
  if (!c.ok) return c

  const key = cleanKey(input.idempotencyKey)
  if (!key) return fail("Couldn't start the booking. Reload the page and try again.")
  if (!isUuid(input.packageId)) return fail("That package isn't available any more. Reload and try again.")
  if (input.tableId !== null && !isUuid(input.tableId)) return fail("That table isn't available any more. Reload and try again.")
  if (!isUuid(input.customerId)) return fail("Choose the customer who is booking.")
  if (!BOOKABLE.includes(input.paymentMethod)) return fail("Choose how the customer is paying.")

  // The function re-checks both, but a clear message here beats a generic one.
  if (input.paymentMethod === "complimentary" && !(await requireTenantPermission("vvip.manage")).ok) {
    return fail("Only VVIP managers can give a table away")
  }
  if (input.paymentMethod === "wallet") {
    if (!(await mayChargePassport())) return fail("Not authorized to charge customer Passports")
    if (!(await isModuleEnabled(c.tenantId, "wallet"))) return fail("Passport isn't switched on for your business.")
  }

  const write = await sessionDb()
  const { data, error } = await write.rpc("vvip_book_table", {
    p_package_id: input.packageId,
    p_customer_id: input.customerId,
    p_table_id: input.tableId,
    p_payment_method: input.paymentMethod,
    p_notes: text(input.notes, 500) || null,
    p_idempotency_key: key,
  })
  if (error) return fail(friendly(error))
  const booking = oneRow(data)
  if (!booking?.id) return fail("The booking didn't go through. Check the buyers list before trying again.")
  return { ok: true, data: { bookingId: String(booking.id), reference: String(booking.reference ?? "") } }
}

// ============================================================================
// Booking lifecycle
// ============================================================================

export async function setBookingStatus(bookingId: string, status: BookingStatus, note?: string): Promise<ActionResult> {
  const c = await scoped("vvip.operate")
  if (!c.ok) return c
  if (!isUuid(bookingId)) return fail(NOT_FOUND_BOOKING)
  // Only the four moves staff can make. The function enforces which are allowed from the current status.
  if (!MOVES.includes(status)) return fail("That isn't a status you can set.")
  const write = await sessionDb()
  const { error } = await write.rpc("vvip_set_booking_status", {
    p_booking_id: bookingId,
    p_status: status,
    p_note: text(note, 200) || null,
  })
  if (error) return fail(friendly(error))
  return { ok: true, data: undefined }
}

/** Cancel a booking. Refused by the database when the tab has had any activity. The refund goes to
 *  Passport when it was paid that way, otherwise it is recorded as a manual refund. */
export async function cancelBooking(bookingId: string, refund: boolean, reason: string): Promise<ActionResult> {
  const c = await scoped("vvip.manage")
  if (!c.ok) return c
  if (!isUuid(bookingId)) return fail(NOT_FOUND_BOOKING)
  const write = await sessionDb()
  const { error } = await write.rpc("vvip_cancel_booking", {
    p_booking_id: bookingId,
    p_refund: Boolean(refund),
    p_reason: text(reason, 200) || null,
  })
  if (error) return fail(friendly(error))
  return { ok: true, data: undefined }
}

// ============================================================================
// The tab
// ============================================================================

function receiptOf(data: unknown): ActionResult<TabEntryReceipt> {
  const r = oneRow(data)
  if (!r?.id) return fail("The entry didn't go through. Reload and check the tab before trying again.")
  return {
    ok: true,
    data: {
      entryId: String(r.id),
      direction: r.direction === "debit" ? "debit" : "credit",
      entryType: r.entry_type as EntryType,
      amount: num(r.amount),
      balanceAfter: num(r.balance_after),
    },
  }
}

export async function tabSpend(bookingId: string, amount: number, description: string, idempotencyKey: string): Promise<ActionResult<TabEntryReceipt>> {
  const c = await scoped("vvip.operate")
  if (!c.ok) return c
  const key = cleanKey(idempotencyKey)
  if (!key) return fail("Couldn't start the entry. Reload the page and try again.")
  if (!isUuid(bookingId)) return fail(NOT_FOUND_BOOKING)
  const value = amountOf(amount)
  if (value === null) return fail("Enter an amount above 0, with at most 2 decimals.")

  const write = await sessionDb()
  const { data, error } = await write.rpc("vvip_tab_spend", {
    p_booking_id: bookingId,
    p_amount: value,
    p_description: text(description, 200) || "Bar tab spend",
    p_idempotency_key: key,
  })
  if (error) return fail(friendly(error))
  return receiptOf(data)
}

export async function tabTopup(
  bookingId: string,
  amount: number,
  method: TopupMethod,
  description: string,
  idempotencyKey: string,
): Promise<ActionResult<TabEntryReceipt>> {
  const c = await scoped("vvip.operate")
  if (!c.ok) return c
  const key = cleanKey(idempotencyKey)
  if (!key) return fail("Couldn't start the entry. Reload the page and try again.")
  if (!isUuid(bookingId)) return fail(NOT_FOUND_BOOKING)
  const value = amountOf(amount)
  if (value === null) return fail("Enter an amount above 0, with at most 2 decimals.")
  if (!TOPUP_METHODS.includes(method)) return fail("Choose cash, card or EFT.")

  const write = await sessionDb()
  const { data, error } = await write.rpc("vvip_tab_topup", {
    p_booking_id: bookingId,
    p_amount: value,
    p_payment_method: method,
    p_description: text(description, 200) || "Tab top-up",
    p_idempotency_key: key,
  })
  if (error) return fail(friendly(error))
  return receiptOf(data)
}

/** A correction up or down. Managers only, and the reason is required (it is the audit trail). */
export async function tabAdjust(
  bookingId: string,
  direction: "credit" | "debit",
  amount: number,
  reason: string,
  idempotencyKey: string,
): Promise<ActionResult<TabEntryReceipt>> {
  const c = await scoped("vvip.manage")
  if (!c.ok) return c
  const key = cleanKey(idempotencyKey)
  if (!key) return fail("Couldn't start the entry. Reload the page and try again.")
  if (!isUuid(bookingId)) return fail(NOT_FOUND_BOOKING)
  if (direction !== "credit" && direction !== "debit") return fail("Choose whether the adjustment adds or removes credit.")
  const value = amountOf(amount)
  if (value === null) return fail("Enter an amount above 0, with at most 2 decimals.")
  const why = text(reason, 200)
  if (!why) return fail("A reason is required for adjustments")

  const write = await sessionDb()
  const { data, error } = await write.rpc("vvip_tab_adjust", {
    p_booking_id: bookingId,
    p_direction: direction,
    p_amount: value,
    p_reason: why,
    p_idempotency_key: key,
  })
  if (error) return fail(friendly(error))
  return receiptOf(data)
}
