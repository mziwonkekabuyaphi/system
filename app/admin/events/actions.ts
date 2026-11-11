// app/admin/events/actions.ts
"use server"

/**
 * Server Actions for Events (ticketed events, box office and gate).
 * ------------------------------------------------------------------
 * Same three layers as app/admin/passport/actions.ts:
 *   1. requireTenantPermission() proves the signed-in user holds the key for
 *      THEIR shop. The tenantId comes from the membership, never the browser.
 *   2. isModuleEnabled() proves the "events" module is switched on (platform
 *      admin > Modules). A switch-off shuts every action, even from a stale page.
 *   3. READS use the service-role client and are always filtered by tenant_id
 *      (RLS is not protecting those, so sales figures are gated explicitly by
 *      tickets.view below). WRITES run on the signed-in user's own session:
 *      row-level security applies to event/tier edits, and sales, scans and
 *      refunds go through the database functions (event_issue_box_office_tickets,
 *      event_check_in_ticket, event_cancel_ticket) that check the permission
 *      again and change everything atomically.
 *
 * A ticket is never sold, admitted or refunded by arithmetic done here: the sold
 * counter, the ticket state and any Passport charge all change inside the database.
 */

import { createSessionClient } from "@/lib/supabase/session-server"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { dateKey } from "./format"
import type {
  CheckInResult,
  CustomerHit,
  EventInput,
  EventOrder,
  EventStats,
  EventSummary,
  EventTicket,
  EventTicketType,
  GateSnapshot,
  PassportBalance,
  PaymentMethod,
  RevenuePoint,
  SaleReceipt,
  ScanResult,
  SellTicketsInput,
  TicketStatus,
} from "./types"

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }
type Fail = { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Scope = { ok: true; read: ServerClient; tenantId: string } | Fail

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/
const MODULE_OFF = "Events isn't switched on for your business."
const GENERIC_ERROR = "Something went wrong. Please try again."
const NOT_FOUND = "Event not found."

const BANNER_BUCKET = "event-banners"
const BANNER_MAX_BYTES = 3 * 1024 * 1024
const BANNER_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }
const SELLABLE_METHODS: PaymentMethod[] = ["cash", "card", "eft", "wallet", "complimentary"]
const PAGE = 1000

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const fail = (error: string): Fail => ({ ok: false, error })
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v)

/** Proves the caller holds ANY ONE of the given keys, and that the module is on. */
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
  if (!(await isModuleEnabled(tenantId, "events"))) return fail(MODULE_OFF)
  return { ok: true, read, tenantId }
}

/** The user's own session client: auth.uid() is set, which the event_* and
 *  wallet_* functions require, and row-level security applies. */
async function sessionDb() {
  return createSessionClient()
}

/** Database messages raised on purpose ("Only 2 left", "Insufficient balance") are written
 *  for people; anything that looks technical is replaced by a generic line. */
function friendly(error: { message?: string } | null | undefined): string {
  const m = (error?.message ?? "").trim()
  if (!m) return GENERIC_ERROR
  if (m.length > 160 || /violates|duplicate key|syntax|relation |column |function |permission denied|row-level security|JWT/i.test(m)) {
    console.error("[events] database error:", m)
    return GENERIC_ERROR
  }
  return m
}

function cleanKey(key: unknown): string | null {
  return typeof key === "string" && KEY_RE.test(key) ? `ui:${key}` : null
}

/** PostgREST caps one response (1,000 rows by default), so a total must be
 *  read page by page or it silently undercounts. */
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

function mapType(r: Record<string, unknown>): EventTicketType {
  return {
    id: String(r.id),
    eventId: String(r.event_id),
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    price: num(r.price),
    capacity: num(r.capacity),
    sold: num(r.sold),
    entriesAllowed: num(r.entries_allowed) || 1,
    isActive: Boolean(r.is_active),
    sortOrder: num(r.sort_order),
  }
}

// ============================================================================
// Events
// ============================================================================

export async function loadEvents(): Promise<ActionResult<EventSummary[]>> {
  const c = await scoped("events.view")
  if (!c.ok) return c
  const { read, tenantId } = c

  // Sales figures are money: a service-role read ignores RLS, so tickets.view is checked here.
  const canSeeSales = (await requireTenantPermission("tickets.view")).ok

  const eventsQuery = read
    .from("events")
    .select(
      "id,name,description,location,start_time,end_time,status,image_url," +
        "event_ticket_types(id,event_id,name,description,price,capacity,sold,entries_allowed,is_active,sort_order)",
    )
    .eq("tenant_id", tenantId)
    .order("start_time", { ascending: false })

  const empty = <T,>() => Promise.resolve({ rows: [] as T[] })
  const [events, tickets, orders, scans] = await Promise.all([
    eventsQuery,
    canSeeSales
      ? fetchAll<{ event_id: string; status: string; entries_used: number }>((a, b) =>
          read.from("event_tickets").select("event_id,status,entries_used").eq("tenant_id", tenantId).order("id").range(a, b),
        )
      : empty<{ event_id: string; status: string; entries_used: number }>(),
    canSeeSales
      ? fetchAll<{ event_id: string; total: number; refunded_total: number }>((a, b) =>
          read.from("event_orders").select("event_id,total,refunded_total").eq("tenant_id", tenantId).order("id").range(a, b),
        )
      : empty<{ event_id: string; total: number; refunded_total: number }>(),
    canSeeSales
      ? fetchAll<{ event_id: string }>((a, b) =>
          read.from("event_scans").select("event_id").eq("tenant_id", tenantId).neq("result", "valid").order("id").range(a, b),
        )
      : empty<{ event_id: string }>(),
  ])
  if (events.error) {
    console.error("[events] loadEvents failed", events.error.message)
    return fail("Couldn't load events.")
  }

  const stats = new Map<string, EventStats>()
  const stat = (id: string): EventStats => {
    let s = stats.get(id)
    if (!s) {
      s = { ticketsSold: 0, ticketsAdmitted: 0, gross: 0, refunded: 0, failedScans: 0 }
      stats.set(id, s)
    }
    return s
  }
  for (const t of tickets.rows) {
    if (t.status !== "issued" && t.status !== "used") continue
    const s = stat(t.event_id)
    s.ticketsSold += 1
    if (num(t.entries_used) > 0) s.ticketsAdmitted += 1
  }
  for (const o of orders.rows) {
    const s = stat(o.event_id)
    s.gross += num(o.total)
    s.refunded += num(o.refunded_total)
  }
  for (const sc of scans.rows) stat(sc.event_id).failedScans += 1

  const rows = (events.data ?? []) as unknown as Array<Record<string, unknown>>
  return {
    ok: true,
    data: rows.map((e) => {
      const types = ((e.event_ticket_types as Array<Record<string, unknown>> | null) ?? [])
        .map(mapType)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.price - b.price)
      const fallbackSold = types.reduce((n, t) => n + t.sold, 0)
      const s = stats.get(String(e.id))
      return {
        id: String(e.id),
        name: String(e.name),
        description: (e.description as string | null) ?? null,
        location: (e.location as string | null) ?? null,
        startTime: String(e.start_time),
        endTime: (e.end_time as string | null) ?? null,
        status: e.status as EventSummary["status"],
        imageUrl: (e.image_url as string | null) ?? null,
        ticketTypes: types,
        // Tiers carry an exact sold count even for a caller who can't see sales.
        stats: s ?? { ticketsSold: fallbackSold, ticketsAdmitted: 0, gross: 0, refunded: 0, failedScans: 0 },
      }
    }),
  }
}

function validateEvent(input: EventInput, soldByTier: Map<string, number>): string | null {
  if (!input.name.trim()) return "Give the event a name."
  if (input.name.trim().length > 120) return "Keep the event name under 120 characters."
  const start = Date.parse(input.startTime)
  if (Number.isNaN(start)) return "Choose a start date and time."
  if (input.endTime) {
    const end = Date.parse(input.endTime)
    if (Number.isNaN(end) || end <= start) return "The end time must be after the start time."
  }
  if (input.ticketTypes.length === 0) return "Add at least one ticket tier."
  if (input.ticketTypes.length > 20) return "An event can have up to 20 ticket tiers."
  const seen = new Set<string>()
  for (const t of input.ticketTypes) {
    const name = t.name.trim()
    if (!name) return "Every ticket tier needs a name."
    if (seen.has(name.toLowerCase())) return `Two tiers are called "${name}". Give each its own name.`
    seen.add(name.toLowerCase())
    if (!Number.isFinite(t.price) || t.price < 0 || t.price > 1_000_000) return `Set a price of 0 or more for ${name}.`
    if (!Number.isInteger(t.capacity) || t.capacity < 0 || t.capacity > 1_000_000) return `Capacity for ${name} must be a whole number.`
    if (!Number.isInteger(t.entriesAllowed) || t.entriesAllowed < 1 || t.entriesAllowed > 100) return `${name} must allow between 1 and 100 entries.`
    const sold = t.id ? soldByTier.get(t.id) ?? 0 : 0
    if (t.capacity < sold) return `${name} has already sold ${sold}, so its capacity can't go below that.`
  }
  return null
}

export async function saveEvent(input: EventInput): Promise<ActionResult<{ id: string }>> {
  const c = await scoped("events.manage")
  if (!c.ok) return c
  const { read, tenantId } = c
  if (input.id !== undefined && !isUuid(input.id)) return fail(NOT_FOUND)
  if (input.ticketTypes.some((t) => t.id !== undefined && !isUuid(t.id))) return fail("One of the tiers wasn't found. Reload and try again.")

  // Existing tiers (for the capacity-vs-sold check and for removals).
  let existing: Array<{ id: string; name: string; sold: number }> = []
  if (input.id) {
    const { data, error } = await read.from("event_ticket_types").select("id,name,sold").eq("event_id", input.id).eq("tenant_id", tenantId)
    if (error) return fail(friendly(error))
    existing = (data ?? []).map((r: Record<string, unknown>) => ({ id: String(r.id), name: String(r.name), sold: num(r.sold) }))
  }
  const soldByTier = new Map(existing.map((t) => [t.id, t.sold]))
  const invalid = validateEvent(input, soldByTier)
  if (invalid) return fail(invalid)

  const fields = {
    name: input.name.trim(),
    description: input.description.trim().slice(0, 2000) || null,
    location: input.location.trim().slice(0, 200) || null,
    start_time: input.startTime,
    end_time: input.endTime,
    status: input.status,
  }

  const write = await sessionDb()
  let eventId = input.id ?? ""
  const creating = !input.id
  if (creating) {
    const { data, error } = await write.from("events").insert([{ ...fields, tenant_id: tenantId }]).select("id").single()
    if (error || !data) return fail(friendly(error))
    eventId = String(data.id)
  } else {
    const { data: current } = await read.from("events").select("status").eq("id", eventId).eq("tenant_id", tenantId).maybeSingle()
    if (!current) return fail(NOT_FOUND)
    // Don't let the form flip a cancelled/ended event back onto sale.
    const patch: Record<string, unknown> = { ...fields }
    if (current.status === "cancelled" || current.status === "ended") delete patch.status
    const { error } = await write.from("events").update(patch).eq("id", eventId).eq("tenant_id", tenantId)
    if (error) return fail(friendly(error))
  }

  // Tiers: update the ones we know, add the new ones, remove the dropped ones.
  const keep = new Set(input.ticketTypes.map((t) => t.id).filter((id): id is string => !!id))
  const dropped = existing.filter((t) => !keep.has(t.id))
  const blocked = dropped.find((t) => t.sold > 0)
  if (blocked) {
    return fail(`${blocked.name} has sold tickets and can't be removed. Switch it off instead and it stops selling.`)
  }

  for (const [index, t] of input.ticketTypes.entries()) {
    const row = {
      name: t.name.trim(),
      price: t.price,
      capacity: t.capacity,
      entries_allowed: t.entriesAllowed,
      is_active: t.isActive,
      sort_order: index,
    }
    const { error } = t.id
      ? await write.from("event_ticket_types").update(row).eq("id", t.id).eq("event_id", eventId).eq("tenant_id", tenantId)
      : await write.from("event_ticket_types").insert([{ ...row, event_id: eventId, tenant_id: tenantId }])
    if (error) {
      if (creating) await write.from("events").delete().eq("id", eventId).eq("tenant_id", tenantId)
      return fail(friendly(error))
    }
  }
  if (dropped.length > 0) {
    const { error } = await write.from("event_ticket_types").delete().in("id", dropped.map((t) => t.id)).eq("tenant_id", tenantId)
    if (error) return fail(friendly(error))
  }

  return { ok: true, data: { id: eventId } }
}

export async function uploadEventBanner(eventId: string, formData: FormData): Promise<ActionResult<{ url: string }>> {
  const c = await scoped("events.manage")
  if (!c.ok) return c
  const { read, tenantId } = c
  if (!isUuid(eventId)) return fail(NOT_FOUND)

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return fail("Choose an image to upload.")
  const ext = BANNER_TYPES[file.type]
  if (!ext) return fail("Use a PNG, JPG or WebP image.")
  if (file.size > BANNER_MAX_BYTES) return fail("The image must be under 3 MB.")

  const { data: event } = await read.from("events").select("id,image_url").eq("id", eventId).eq("tenant_id", tenantId).maybeSingle()
  if (!event) return fail(NOT_FOUND)

  // Path convention required by the bucket policy: {tenant_id}/{event_id}/{file}
  const write = await sessionDb()
  const path = `${tenantId}/${eventId}/${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await write.storage.from(BANNER_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) return fail(friendly(uploadError))

  const url = write.storage.from(BANNER_BUCKET).getPublicUrl(path).data.publicUrl
  const { error: saveError } = await write.from("events").update({ image_url: url }).eq("id", eventId).eq("tenant_id", tenantId)
  if (saveError) {
    await write.storage.from(BANNER_BUCKET).remove([path])
    return fail(friendly(saveError))
  }

  // Tidy up the banner this replaces (best effort).
  const old = typeof event.image_url === "string" ? event.image_url : null
  const marker = `/${BANNER_BUCKET}/`
  if (old && old.includes(marker)) {
    const oldPath = decodeURIComponent(old.split(marker)[1] ?? "")
    if (oldPath.startsWith(`${tenantId}/`)) await write.storage.from(BANNER_BUCKET).remove([oldPath])
  }
  return { ok: true, data: { url } }
}

export async function setEventStatus(eventId: string, status: "draft" | "active" | "ended" | "cancelled"): Promise<ActionResult> {
  const c = await scoped("events.manage")
  if (!c.ok) return c
  if (!isUuid(eventId) || !["draft", "active", "ended", "cancelled"].includes(status)) return fail(NOT_FOUND)
  const write = await sessionDb()
  const { error } = await write.from("events").update({ status }).eq("id", eventId).eq("tenant_id", c.tenantId)
  if (error) return fail(friendly(error))
  return { ok: true, data: undefined }
}

export async function deleteEvent(eventId: string): Promise<ActionResult> {
  const c = await scoped("events.manage")
  if (!c.ok) return c
  if (!isUuid(eventId)) return fail(NOT_FOUND)
  const write = await sessionDb()
  const { error } = await write.from("events").delete().eq("id", eventId).eq("tenant_id", c.tenantId)
  if (error) {
    if (/foreign key/i.test(error.message)) return fail("This event has ticket sales or VVIP bookings, so it can't be deleted. Cancel it instead.")
    return fail(friendly(error))
  }
  return { ok: true, data: undefined }
}

// ============================================================================
// Orders and tickets
// ============================================================================

export async function loadEventOrders(eventId: string): Promise<ActionResult<EventOrder[]>> {
  const c = await scoped("tickets.view")
  if (!c.ok) return c
  const { read, tenantId } = c
  if (!isUuid(eventId)) return fail(NOT_FOUND)

  const { data: orders, error } = await read
    .from("event_orders")
    .select("id,ticket_type_id,customer_id,customer_phone,quantity,total,refunded_total,channel,payment_method,created_at")
    .eq("event_id", eventId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(40)
  if (error) return fail(friendly(error))
  const list = (orders ?? []) as Array<Record<string, unknown>>
  if (list.length === 0) return { ok: true, data: [] }

  const orderIds = list.map((o) => String(o.id))
  const customerIds = [...new Set(list.map((o) => o.customer_id).filter((v): v is string => typeof v === "string"))]
  const typeIds = [...new Set(list.map((o) => String(o.ticket_type_id)))]

  const [tickets, customers, types] = await Promise.all([
    read
      .from("event_tickets")
      .select("id,order_id,ticket_number,status,entries_used,entries_allowed,price_paid,refund_method")
      .in("order_id", orderIds)
      .eq("tenant_id", tenantId)
      .order("ticket_number"),
    customerIds.length
      ? read.from("tenant_customers").select("id,full_name,phone").in("id", customerIds).eq("tenant_id", tenantId)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    read.from("event_ticket_types").select("id,name").in("id", typeIds).eq("tenant_id", tenantId),
  ])

  const customerById = new Map<string, { name: string | null; phone: string | null }>(
    ((customers.data ?? []) as Array<Record<string, unknown>>).map((r) => [
      String(r.id),
      { name: (r.full_name as string | null) ?? null, phone: (r.phone as string | null) ?? null },
    ]),
  )
  const typeName = new Map<string, string>(((types.data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), String(r.name)]))
  const ticketsByOrder = new Map<string, EventTicket[]>()
  for (const t of (tickets.data ?? []) as Array<Record<string, unknown>>) {
    const key = String(t.order_id)
    const arr = ticketsByOrder.get(key) ?? []
    arr.push({
      id: String(t.id),
      ticketNumber: String(t.ticket_number),
      status: t.status as TicketStatus,
      entriesUsed: num(t.entries_used),
      entriesAllowed: num(t.entries_allowed) || 1,
      pricePaid: num(t.price_paid),
      refundMethod: (t.refund_method as EventTicket["refundMethod"]) ?? null,
    })
    ticketsByOrder.set(key, arr)
  }

  return {
    ok: true,
    data: list.map((o) => {
      const customer = typeof o.customer_id === "string" ? customerById.get(o.customer_id) : undefined
      return {
        id: String(o.id),
        ticketTypeName: typeName.get(String(o.ticket_type_id)) ?? "Ticket",
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? (o.customer_phone as string | null) ?? null,
        quantity: num(o.quantity),
        total: num(o.total),
        refundedTotal: num(o.refunded_total),
        channel: o.channel as EventOrder["channel"],
        paymentMethod: o.payment_method as EventOrder["paymentMethod"],
        createdAt: String(o.created_at),
        tickets: ticketsByOrder.get(String(o.id)) ?? [],
      }
    }),
  }
}

export async function searchCustomers(query: string): Promise<ActionResult<CustomerHit[]>> {
  const c = await scoped("tickets.issue")
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
    data: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      name: (r.full_name as string | null) ?? null,
      phone: String(r.phone ?? ""),
    })),
  }
}

/** The customer's Passport balance, so the box office can warn before a wallet sale.
 *  Only people who can charge a Passport (wallet.operate / wallet.manage) may look. */
export async function loadPassportBalance(customerId: string): Promise<ActionResult<PassportBalance>> {
  const c = await scoped("wallet.operate", "wallet.manage")
  if (!c.ok) return c
  if (!isUuid(customerId)) return fail("Customer not found.")
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
    data: {
      balance: num(data.balance),
      status: data.status as PassportBalance["status"],
      blockReason: (data.block_reason as string | null) ?? null,
    },
  }
}

export async function sellTickets(input: SellTicketsInput): Promise<ActionResult<SaleReceipt>> {
  const c = await scoped("tickets.issue")
  if (!c.ok) return c

  const key = cleanKey(input.idempotencyKey)
  if (!key) return fail("Couldn't start the sale. Reload the page and try again.")
  if (!isUuid(input.eventId) || !isUuid(input.ticketTypeId)) return fail("That ticket isn't available any more. Reload and try again.")
  if (input.customerId !== null && !isUuid(input.customerId)) return fail("Customer not found.")
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 50) return fail("Sell between 1 and 50 tickets at a time.")
  if (!SELLABLE_METHODS.includes(input.paymentMethod)) return fail("Choose how the customer is paying.")

  const write = await sessionDb()
  const { data, error } = await write.rpc("event_issue_box_office_tickets", {
    p_event_id: input.eventId,
    p_ticket_type_id: input.ticketTypeId,
    p_quantity: input.quantity,
    p_payment_method: input.paymentMethod,
    p_customer_id: input.customerId,
    p_customer_phone: input.phone?.trim().slice(0, 32) || null,
    p_admit: Boolean(input.admit),
    p_gate: input.gate?.trim().slice(0, 40) || null,
    p_idempotency_key: key,
  })
  if (error) return fail(friendly(error))
  const order = data as Record<string, unknown> | null
  if (!order?.id) return fail("The sale didn't go through. Check Recent purchases before trying again.")

  const { data: tickets } = await c.read
    .from("event_tickets")
    .select("ticket_number,status")
    .eq("order_id", String(order.id))
    .eq("tenant_id", c.tenantId)
    .order("ticket_number")

  return {
    ok: true,
    data: {
      orderId: String(order.id),
      total: num(order.total),
      paymentMethod: order.payment_method as PaymentMethod | "free",
      tickets: ((tickets ?? []) as Array<Record<string, unknown>>).map((t) => ({
        ticketNumber: String(t.ticket_number),
        status: t.status as TicketStatus,
      })),
    },
  }
}

export async function cancelTicket(ticketId: string, refund: boolean, reason: string): Promise<ActionResult> {
  const c = await scoped("tickets.manage")
  if (!c.ok) return c
  if (!isUuid(ticketId)) return fail("Ticket not found.")
  const write = await sessionDb()
  const { error } = await write.rpc("event_cancel_ticket", {
    p_ticket_id: ticketId,
    p_refund: Boolean(refund),
    p_reason: (typeof reason === "string" ? reason.trim().slice(0, 200) : "") || null,
  })
  if (error) return fail(friendly(error))
  return { ok: true, data: undefined }
}

// ============================================================================
// Gate
// ============================================================================

export async function checkInTicket(eventId: string, code: string, gate: string | null): Promise<ActionResult<CheckInResult>> {
  const c = await scoped("tickets.scan")
  if (!c.ok) return c
  if (!isUuid(eventId)) return fail(NOT_FOUND)
  const clean = (typeof code === "string" ? code : "").trim().slice(0, 200)
  if (!clean) return fail("Scan or type a ticket first.")

  const write = await sessionDb()
  const { data, error } = await write.rpc("event_check_in_ticket", {
    p_event_id: eventId,
    p_code: clean,
    p_gate: gate?.trim().slice(0, 40) || null,
  })
  if (error) return fail(friendly(error))
  const r = (data ?? {}) as Record<string, unknown>
  return {
    ok: true,
    data: {
      success: Boolean(r.success),
      result: (r.result as ScanResult) ?? "invalid",
      message: String(r.message ?? ""),
      ticketNumber: (r.ticket_number as string | undefined) ?? undefined,
      ticketType: (r.ticket_type as string | null | undefined) ?? undefined,
      holder: (r.holder as string | null | undefined) ?? undefined,
      entriesUsed: r.entries_used === undefined ? undefined : num(r.entries_used),
      entriesAllowed: r.entries_allowed === undefined ? undefined : num(r.entries_allowed),
      lastScannedAt: (r.last_scanned_at as string | null | undefined) ?? undefined,
    },
  }
}

export async function loadGate(eventId: string): Promise<ActionResult<GateSnapshot>> {
  const c = await scoped("tickets.scan")
  if (!c.ok) return c
  const { read, tenantId } = c
  if (!isUuid(eventId)) return fail(NOT_FOUND)

  const [scans, types, admitted, failed] = await Promise.all([
    read
      .from("event_scans")
      .select("id,ticket_number,result,gate,scanned_at")
      .eq("event_id", eventId)
      .eq("tenant_id", tenantId)
      .order("scanned_at", { ascending: false })
      .limit(25),
    read.from("event_ticket_types").select("sold").eq("event_id", eventId).eq("tenant_id", tenantId),
    read
      .from("event_tickets")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("tenant_id", tenantId)
      .in("status", ["issued", "used"])
      .gt("entries_used", 0),
    read.from("event_scans").select("id", { count: "exact", head: true }).eq("event_id", eventId).eq("tenant_id", tenantId).neq("result", "valid"),
  ])
  if (scans.error) return fail(friendly(scans.error))

  return {
    ok: true,
    data: {
      recent: ((scans.data ?? []) as Array<Record<string, unknown>>).map((s) => ({
        id: String(s.id),
        ticketNumber: (s.ticket_number as string | null) ?? null,
        result: s.result as ScanResult,
        gate: (s.gate as string | null) ?? null,
        scannedAt: String(s.scanned_at),
      })),
      sold: ((types.data ?? []) as Array<Record<string, unknown>>).reduce((n, t) => n + num(t.sold), 0),
      admitted: admitted.count ?? 0,
      failed: failed.count ?? 0,
    },
  }
}

// ============================================================================
// Analytics
// ============================================================================

/** Gross and refunds per day for the last `days` days, in the shop's timezone,
 *  with empty days filled in so the chart has no gaps. */
export async function loadRevenueTrend(timezone: string, days = 14): Promise<ActionResult<RevenuePoint[]>> {
  const c = await scoped("tickets.view")
  if (!c.ok) return c
  const { read, tenantId } = c
  const span = Math.min(Math.max(Math.trunc(days) || 14, 1), 90)

  const since = new Date(Date.now() - (span + 1) * 86_400_000).toISOString()
  const { rows, error } = await fetchAll<{ total: number; refunded_total: number; created_at: string }>((a, b) =>
    read
      .from("event_orders")
      .select("total,refunded_total,created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", since)
      .order("created_at")
      .range(a, b),
  )
  if (error) return fail(friendly({ message: error }))

  const byDay = new Map<string, RevenuePoint>()
  for (let i = span - 1; i >= 0; i -= 1) {
    const key = dateKey(new Date(Date.now() - i * 86_400_000), timezone)
    byDay.set(key, { date: key, gross: 0, refunded: 0 })
  }
  for (const o of rows) {
    const point = byDay.get(dateKey(o.created_at, timezone))
    if (!point) continue
    point.gross += num(o.total)
    point.refunded += num(o.refunded_total)
  }
  return { ok: true, data: [...byDay.values()] }
}
