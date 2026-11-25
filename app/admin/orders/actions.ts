"use server"

// app/admin/orders/actions.ts
//
// Every action: (1) resolves the tenant from the session (never from the
// client), (2) checks the Orders module is on for that tenant, (3) checks the
// caller's permission, and only then (4) touches the database, always with
// .eq("tenant_id", tenantId). The browser never sends a tenant id.
//
// Actions return { ok, data | error } instead of throwing, so the UI can show
// the message inline.

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { getTenantPermissions, type PermissionKey } from "@/lib/tenant/require-tenant-permission"
import { getEffectiveModules } from "@/lib/tenant/effective-modules"
import { notifyText } from "@/lib/services/orders/orders.integrations"
import { orderAcceptedMessage, orderDeclinedMessage } from "@/lib/services/messages/orders"

import { loadDeliveryAreas, loadOrders, mapCategory, mapProduct, mapSettings, mapVendor } from "./orders-data"
import {
  nextOrderStep,
  PRODUCT_STATUSES,
  type ActionResult,
  type AdminOrder,
  type AdminOrderSettings,
  type AdminOrderVendor,
  type AdminProduct,
  type AdminProductCategory,
  type CategoryInput,
  type DeliveryAreaInput,
  type OrderFulfilment,
  type OrderSettingsInput,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
  type ProductInput,
  type StockTakeDetail,
  type StockTakeResult,
  type StockTakeStatus,
  type StockTakeSummary,
  type VendorInput,
} from "./types"

const PRODUCT_IMAGE_BUCKET = "product-images"
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

class UserError extends Error {}

// Permission keys: add these to PermissionKey in lib/tenant/require-tenant-permission.ts
const VIEW = ["orders.view", "orders.operate", "orders.manage"] as PermissionKey[]
const OPERATE = ["orders.operate", "orders.manage"] as PermissionKey[]
const MANAGE = ["orders.manage"] as PermissionKey[]

async function guard(anyOf: PermissionKey[]) {
  const { tenantId, userId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new UserError("The server isn't configured.")
  const mods = await getEffectiveModules(tenantId)
  if (!mods.on("orders")) throw new UserError("Order management isn't switched on for this shop.")
  const { granted } = await getTenantPermissions(anyOf)
  if (!anyOf.some((k) => granted.has(k))) throw new UserError("You don't have permission to do that.")
  return { supabase, tenantId, userId }
}

async function run<T>(anyOf: PermissionKey[], fn: (c: Awaited<ReturnType<typeof guard>>) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn(await guard(anyOf)) }
  } catch (e) {
    // requireTenantMember() redirects by throwing; let Next handle that.
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw e
    if (e instanceof UserError) return { ok: false, error: e.message }
    console.error("[orders] action failed", e)
    return { ok: false, error: "Something went wrong. Try again." }
  }
}

/** Turns a Postgres error into a sentence the owner can act on. */
function fail(error: { code?: string; message: string }, what: string): never {
  console.error(`[orders] ${what} failed`, error)
  if (error.code === "23505") throw new UserError(`${what}: that name is already in use.`)
  if (error.code === "23503") throw new UserError(`${what}: it's still in use elsewhere. Archive or switch it off instead.`)
  if (error.code === "23514") throw new UserError(`${what}: a value is out of range.`)
  throw new UserError(`${what} failed. Try again.`)
}

const text = (v: string | null | undefined) => {
  const t = (v ?? "").trim()
  return t === "" ? null : t
}

// ============================================================================
// ORDERS
// ============================================================================

export async function listOrders(): Promise<ActionResult<AdminOrder[]>> {
  return run(VIEW, ({ supabase, tenantId }) => loadOrders(supabase, tenantId))
}

/** Moves an order one step forward. `from` is what the screen showed: if the
 *  row has moved on since (another device, a webhook), nothing is written. */
export async function advanceOrder(
  orderId: string,
  from: OrderStatus,
): Promise<ActionResult<{ status: OrderStatus; paymentStatus: PaymentStatus }>> {
  return run(OPERATE, async ({ supabase, tenantId }) => {
    const { data: current, error: readErr } = await supabase
      .from("orders")
      .select("payment_method, payment_status, fulfilment")
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .maybeSingle()
    if (readErr) fail(readErr, "Update order")
    if (!current) throw new UserError("Order not found.")

    const step = nextOrderStep(from, (current.fulfilment ?? "collection") as OrderFulfilment)
    if (!step) throw new UserError("That order can't be moved forward by hand.")
    const to = step.to

    const patch: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() }
    // Cash is taken at the counter (or at the door): handing the order over is the moment it's paid.
    if ((to === "collected" || to === "completed") && current.payment_method === "cash" && current.payment_status === "pending") {
      patch.payment_status = "paid"
    }

    const { data, error } = await supabase
      .from("orders")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .eq("status", from)
      .select("status, payment_status")
      .maybeSingle()
    if (error) fail(error, "Update order")
    if (!data) throw new UserError("This order was just changed somewhere else. The board has been refreshed.")
    return { status: data.status as OrderStatus, paymentStatus: data.payment_status as PaymentStatus }
  })
}

/** cancel_order() refunds wallet payments through the ledger and flags paid
 *  card orders refund_pending (the gateway refund is manual). */
export async function cancelOrder(
  orderId: string,
): Promise<ActionResult<{ orderNumber: string; wasPaid: boolean; paymentStatus: PaymentStatus }>> {
  return run(OPERATE, async ({ supabase, tenantId }) => {
    const { data, error } = await supabase.rpc("cancel_order", { p_tenant: tenantId, p_order: orderId })
    if (error) fail(error, "Cancel order")
    const r = data as { outcome: string; order_number?: string; was_paid?: boolean; payment_status?: PaymentStatus; status?: string }
    if (r.outcome === "not_found") throw new UserError("Order not found.")
    if (r.outcome === "not_cancellable") throw new UserError(`${r.order_number ?? "This order"} is already ${r.status} and can't be cancelled.`)
    if (r.outcome !== "ok") throw new UserError("The order couldn't be cancelled.")
    return { orderNumber: r.order_number ?? "", wasPaid: !!r.was_paid, paymentStatus: (r.payment_status ?? "pending") as PaymentStatus }
  })
}

/** Staff accept an order that is waiting (shops with "Automatically accept orders" switched off).
 *  The customer is told on WhatsApp. */
export async function acceptOrder(orderId: string): Promise<ActionResult<{ status: OrderStatus }>> {
  return run(OPERATE, async ({ supabase, tenantId }) => {
    const { data, error } = await supabase.rpc("accept_order", { p_tenant: tenantId, p_order: orderId })
    if (error) fail(error, "Accept order")
    const r = data as { outcome: string; order_number?: string; status?: string; customer_phone?: string }
    if (r.outcome === "not_found") throw new UserError("Order not found.")
    if (r.outcome === "not_awaiting") throw new UserError(`${r.order_number ?? "This order"} was already dealt with (${r.status}). The board has been refreshed.`)
    if (r.outcome !== "ok") throw new UserError("The order couldn't be accepted.")
    const status = (r.status ?? "placed") as OrderStatus
    if (r.customer_phone) await notifyText(tenantId, r.customer_phone, orderAcceptedMessage(r.order_number ?? "", status === "scheduled"))
    return { status }
  })
}

/** Staff decline an order that is waiting. Goes through cancel_order, so a wallet payment is refunded and stock is
 *  put back; a paid card order is flagged "refund to do". The customer is told on WhatsApp. */
export async function declineOrder(
  orderId: string,
): Promise<ActionResult<{ orderNumber: string; wasPaid: boolean; paymentStatus: PaymentStatus }>> {
  return run(OPERATE, async ({ supabase, tenantId }) => {
    const { data: current, error: readErr } = await supabase
      .from("orders")
      .select("status, customer_phone")
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .maybeSingle()
    if (readErr) fail(readErr, "Decline order")
    if (!current) throw new UserError("Order not found.")
    if (current.status !== "awaiting_acceptance") throw new UserError("This order was already dealt with. The board has been refreshed.")

    const { data, error } = await supabase.rpc("cancel_order", { p_tenant: tenantId, p_order: orderId })
    if (error) fail(error, "Decline order")
    const r = data as { outcome: string; order_number?: string; was_paid?: boolean; payment_status?: PaymentStatus; status?: string }
    if (r.outcome === "not_found") throw new UserError("Order not found.")
    if (r.outcome !== "ok") throw new UserError(`${r.order_number ?? "This order"} is already ${r.status} and can't be declined.`)
    const paymentStatus = (r.payment_status ?? "pending") as PaymentStatus
    if (current.customer_phone) {
      await notifyText(
        tenantId,
        current.customer_phone as string,
        orderDeclinedMessage(r.order_number ?? "", !!r.was_paid),
      )
    }
    return { orderNumber: r.order_number ?? "", wasPaid: !!r.was_paid, paymentStatus }
  })
}

// ============================================================================
// PRODUCTS
// ============================================================================

function productRow(p: Partial<ProductInput>): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  if (p.name !== undefined) {
    const name = p.name.trim()
    if (!name) throw new UserError("Product name is required.")
    r.name = name
  }
  if (p.price !== undefined) {
    if (!Number.isFinite(p.price) || p.price < 0) throw new UserError("Price must be 0 or more.")
    r.price = Math.round(p.price * 100) / 100
  }
  if (p.status !== undefined) {
    if (!PRODUCT_STATUSES.includes(p.status)) throw new UserError("Unknown product status.")
    r.status = p.status
  }
  if (p.stockQuantity !== undefined) {
    if (p.stockQuantity !== null && (!Number.isInteger(p.stockQuantity) || p.stockQuantity < 0)) {
      throw new UserError("Stock must be a whole number, 0 or more.")
    }
    r.stock_quantity = p.stockQuantity
  }
  if (p.imageUrl !== undefined) {
    if (p.imageUrl !== null && !/^https:\/\//.test(p.imageUrl)) throw new UserError("Image link must start with https://")
    r.image_url = p.imageUrl
  }
  if (p.categoryId !== undefined) r.category_id = p.categoryId || null
  if (p.vendorId !== undefined) r.vendor_id = p.vendorId || null
  if (p.brand !== undefined) r.brand = text(p.brand)
  if (p.description !== undefined) r.description = text(p.description)
  if (p.shortDescription !== undefined) r.short_description = text(p.shortDescription)
  if (p.isAvailable !== undefined) r.is_available = !!p.isAvailable
  if (p.trackInventory !== undefined) r.track_inventory = !!p.trackInventory
  r.updated_at = new Date().toISOString()
  return r
}

const PRODUCT_COLUMNS =
  "id, category_id, vendor_id, name, brand, description, short_description, price, status, is_available, track_inventory, stock_quantity, image_url"

export async function createProduct(input: ProductInput): Promise<ActionResult<AdminProduct>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const row = productRow(input)
    if (row.track_inventory && row.stock_quantity == null) row.stock_quantity = 0
    const { data, error } = await supabase
      .from("products")
      .insert({ ...row, tenant_id: tenantId })
      .select(PRODUCT_COLUMNS)
      .single()
    // The composite FK (tenant_id, category_id/vendor_id) rejects another tenant's ids.
    if (error) fail(error, "Add product")
    return mapProduct(data)
  })
}

export async function updateProduct(id: string, patch: Partial<ProductInput>): Promise<ActionResult<AdminProduct>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const row = productRow(patch)
    if (row.track_inventory === true && row.stock_quantity === undefined) {
      // Turning tracking on with no number would leave stock null ("unlimited"): start at 0 instead.
      const { data: cur } = await supabase.from("products").select("stock_quantity").eq("tenant_id", tenantId).eq("id", id).maybeSingle()
      if (cur && cur.stock_quantity == null) row.stock_quantity = 0
    }
    const { data, error } = await supabase
      .from("products")
      .update(row)
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select(PRODUCT_COLUMNS)
      .maybeSingle()
    if (error) fail(error, "Save product")
    if (!data) throw new UserError("Product not found.")
    return mapProduct(data)
  })
}

export async function duplicateProduct(id: string): Promise<ActionResult<AdminProduct>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { data: src, error: readErr } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .maybeSingle()
    if (readErr) fail(readErr, "Duplicate product")
    if (!src) throw new UserError("Product not found.")
    const { id: _id, ...rest } = src as Record<string, unknown>
    // The copy starts as a draft so it can't be ordered until you've checked it.
    const { data, error } = await supabase
      .from("products")
      .insert({ ...rest, name: `${src.name} (copy)`, status: "draft", tenant_id: tenantId })
      .select(PRODUCT_COLUMNS)
      .single()
    if (error) fail(error, "Duplicate product")
    return mapProduct(data)
  })
}

export async function deleteProduct(id: string): Promise<ActionResult> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { error } = await supabase.from("products").delete().eq("tenant_id", tenantId).eq("id", id)
    if (error?.code === "23503") {
      throw new UserError("This product is on past orders, so it can't be deleted. Set its status to Archived instead.")
    }
    if (error) fail(error, "Delete product")
  })
}

/** FormData: file. Stored under <tenantId>/ so one shop's files never mix with another's. */
export async function uploadProductImage(formData: FormData): Promise<ActionResult<string>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const file = formData.get("file")
    if (!(file instanceof File)) throw new UserError("Choose an image first.")
    const ext = IMAGE_TYPES[file.type]
    if (!ext) throw new UserError("Use a PNG, JPG or WebP image.")
    if (file.size > MAX_IMAGE_BYTES) throw new UserError("Images can be up to 2 MB.")
    const path = `${tenantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabase.storage
      .from(PRODUCT_IMAGE_BUCKET)
      .upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, cacheControl: "3600" })
    if (error) fail(error, "Upload image")
    return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
  })
}

// ============================================================================
// CATEGORIES
// ============================================================================

function categoryRow(c: CategoryInput) {
  const label = c.label.trim()
  if (!label) throw new UserError("Category name is required.")
  const slug = (s: string | null) => text(s)?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || null
  return {
    label,
    group_key: slug(c.groupKey),
    group_label: text(c.groupLabel),
    emoji: text(c.emoji),
    aliases: [...new Set(c.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))],
    age_restricted: !!c.ageRestricted,
    sort_order: Number.isInteger(c.sortOrder) ? c.sortOrder : 0,
    is_active: !!c.isActive,
  }
}

export async function createCategory(input: CategoryInput): Promise<ActionResult<AdminProductCategory>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const row = categoryRow(input)
    const key = row.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    if (!key) throw new UserError("Category name needs at least one letter or number.")
    const { data, error } = await supabase
      .from("product_categories")
      .insert({ ...row, key, tenant_id: tenantId })
      .select("id, key, label, group_key, group_label, emoji, aliases, age_restricted, sort_order, is_active")
      .single()
    if (error) fail(error, "Add category")
    return mapCategory(data)
  })
}

export async function updateCategory(id: string, input: CategoryInput): Promise<ActionResult<AdminProductCategory>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { data, error } = await supabase
      .from("product_categories")
      .update(categoryRow(input))
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select("id, key, label, group_key, group_label, emoji, aliases, age_restricted, sort_order, is_active")
      .maybeSingle()
    if (error) fail(error, "Save category")
    if (!data) throw new UserError("Category not found.")
    return mapCategory(data)
  })
}

export async function deleteCategory(id: string): Promise<ActionResult> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { error } = await supabase.from("product_categories").delete().eq("tenant_id", tenantId).eq("id", id)
    if (error?.code === "23503") throw new UserError("Products still use this category. Move them first, or switch the category off.")
    if (error) fail(error, "Delete category")
  })
}

// ============================================================================
// VENDORS (collection points)
// ============================================================================

function vendorRow(v: VendorInput) {
  const name = v.name.trim()
  const collection = v.collectionPoint.trim()
  if (!name) throw new UserError("Vendor name is required.")
  if (!collection) throw new UserError("Say where customers collect from.")
  return { name, collection_point: collection, is_active: !!v.isActive }
}

export async function createVendor(input: VendorInput): Promise<ActionResult<AdminOrderVendor>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { data, error } = await supabase
      .from("order_vendors")
      .insert({ ...vendorRow(input), tenant_id: tenantId })
      .select("id, name, collection_point, is_active")
      .single()
    if (error) fail(error, "Add vendor")
    return mapVendor(data)
  })
}

export async function updateVendor(id: string, input: VendorInput): Promise<ActionResult<AdminOrderVendor>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { data, error } = await supabase
      .from("order_vendors")
      .update(vendorRow(input))
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select("id, name, collection_point, is_active")
      .maybeSingle()
    if (error) fail(error, "Save vendor")
    if (!data) throw new UserError("Vendor not found.")
    return mapVendor(data)
  })
}

export async function deleteVendor(id: string): Promise<ActionResult> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { error } = await supabase.from("order_vendors").delete().eq("tenant_id", tenantId).eq("id", id)
    if (error?.code === "23503") throw new UserError("This vendor has products or orders. Switch it off instead of deleting it.")
    if (error) fail(error, "Delete vendor")
  })
}

// ============================================================================
// SETTINGS
// ============================================================================

const PAYMENT_METHODS: PaymentMethod[] = ["wallet", "card", "cash"]

export async function saveOrderSettings(input: OrderSettingsInput): Promise<ActionResult<AdminOrderSettings>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const prefix = input.orderNumberPrefix.trim().toUpperCase()
    if (!/^[A-Z0-9]{1,4}$/.test(prefix)) throw new UserError("Order number prefix is 1 to 4 letters or numbers.")
    const requirePayment = !!input.requirePayment
    // Paying up front means "pay at counter" can't be offered at all.
    const methods = PAYMENT_METHODS.filter((m) => input.allowedPaymentMethods.includes(m) && !(requirePayment && m === "cash"))
    if (methods.length === 0) {
      throw new UserError(
        requirePayment
          ? "Customers must pay before ordering, so allow wallet or card payments (cash can't be the only option)."
          : "Allow at least one payment method.",
      )
    }

    // Order value limits (items total, delivery fee not counted).
    const limit = (v: unknown, what: string) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new UserError(`${what} must be between 0 and 1,000,000.`)
      return Math.round(n * 100) / 100
    }
    const minOrderValue = limit(input.minOrderValue ?? 0, "Minimum order value")
    const maxOrderValue = input.maxOrderValue == null ? null : limit(input.maxOrderValue, "Maximum order value")
    if (maxOrderValue !== null && maxOrderValue <= 0) throw new UserError("Maximum order value must be more than 0, or switched off.")
    if (maxOrderValue !== null && maxOrderValue < minOrderValue) throw new UserError("Maximum order value can't be lower than the minimum.")
    if (!Number.isInteger(input.scheduleMinLeadMinutes) || input.scheduleMinLeadMinutes < 0) {
      throw new UserError("Minimum lead time must be 0 or more minutes.")
    }
    if (input.minAge !== null && (!Number.isInteger(input.minAge) || input.minAge < 1 || input.minAge > 99)) {
      throw new UserError("Minimum age must be between 1 and 99.")
    }
    const aliases: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.searchAliases)) {
      const key = k.trim().toLowerCase()
      const val = String(v).trim().toLowerCase()
      if (key && val) aliases[key] = val
    }

    // Fulfilment
    if (!input.collectionEnabled && !input.deliveryEnabled && !input.dineInEnabled) {
      throw new UserError("Turn on at least one way for customers to get their order: collection, delivery or dine-in.")
    }
    const instructions = text(input.collectionInstructions)
    if (instructions && instructions.length > 200) throw new UserError("Collection instructions must be 200 characters or fewer.")
    if (!Number.isInteger(input.prepTimeMinutes) || input.prepTimeMinutes < 0 || input.prepTimeMinutes > 240) {
      throw new UserError("Preparation time must be 0 to 240 minutes.")
    }
    if (!Number.isInteger(input.deliveryTimeMinutes) || input.deliveryTimeMinutes < 5 || input.deliveryTimeMinutes > 240) {
      throw new UserError("Delivery time must be 5 to 240 minutes.")
    }
    const areas = cleanAreas(input.deliveryAreas)
    if (input.deliveryEnabled && !areas.some((a) => a.isActive)) {
      throw new UserError("Add at least one active delivery area before turning delivery on.")
    }

    const { data, error } = await supabase
      .from("order_settings")
      .upsert(
        {
          tenant_id: tenantId,
          order_number_prefix: prefix,
          wallet_label: input.walletLabel.trim() || "Wallet",
          allowed_payment_methods: methods,
          allow_scheduling: !!input.allowScheduling,
          schedule_min_lead_minutes: input.scheduleMinLeadMinutes,
          min_age: input.minAge,
          default_vendor_id: input.defaultVendorId || null,
          search_aliases: aliases,
          collection_enabled: !!input.collectionEnabled,
          delivery_enabled: !!input.deliveryEnabled,
          dine_in_enabled: !!input.dineInEnabled,
          collection_instructions: instructions,
          prep_time_minutes: input.prepTimeMinutes,
          delivery_time_minutes: input.deliveryTimeMinutes,
          auto_accept_orders: !!input.autoAcceptOrders,
          require_payment: requirePayment,
          min_order_value: minOrderValue,
          max_order_value: maxOrderValue,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" },
      )
      .select("*")
      .single()
    if (error) fail(error, "Save settings")

    await syncDeliveryAreas(supabase, tenantId, areas)
    return mapSettings(data, await loadDeliveryAreas(supabase, tenantId))
  })
}

type CleanArea = Required<Omit<DeliveryAreaInput, "id">> & { id?: string; sortOrder: number }

/** Validates the area list the owner submitted (names unique, money sane). */
function cleanAreas(input: DeliveryAreaInput[]): CleanArea[] {
  const seen = new Set<string>()
  return (input ?? []).map((a, i) => {
    const name = (a.name ?? "").trim()
    if (!name) throw new UserError("Every delivery area needs a name.")
    if (name.length > 60) throw new UserError(`"${name.slice(0, 20)}…" is too long: area names are 60 characters or fewer.`)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new UserError(`"${name}" is listed twice. Area names must be different.`)
    seen.add(key)
    const money = (v: unknown, what: string) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw new UserError(`${name}: ${what} must be 0 or more.`)
      return Math.round(n * 100) / 100
    }
    const freeOver = a.freeOver == null || (a.freeOver as unknown) === "" ? null : money(a.freeOver, "the free delivery amount")
    if (freeOver !== null && freeOver <= 0) throw new UserError(`${name}: the free delivery amount must be more than 0, or left empty.`)
    return { id: a.id, name, fee: money(a.fee, "the delivery fee"), freeOver, isActive: !!a.isActive, sortOrder: i }
  })
}

/** Makes order_delivery_areas match the submitted list: update by id, insert new rows, delete removed ones.
 *  Past orders keep their own copy of the area name and address, so deleting an area is safe. */
async function syncDeliveryAreas(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  areas: CleanArea[],
) {
  const { data: existing, error: readErr } = await supabase.from("order_delivery_areas").select("id").eq("tenant_id", tenantId)
  if (readErr) fail(readErr, "Save delivery areas")
  const existingIds = new Set((existing ?? []).map((r) => r.id as string))
  const keepIds = new Set(areas.filter((a) => a.id && existingIds.has(a.id)).map((a) => a.id as string))

  const removeIds = [...existingIds].filter((id) => !keepIds.has(id))
  if (removeIds.length > 0) {
    const { error } = await supabase.from("order_delivery_areas").delete().eq("tenant_id", tenantId).in("id", removeIds)
    if (error) fail(error, "Save delivery areas")
  }
  for (const a of areas) {
    const row = { name: a.name, fee: a.fee, free_over: a.freeOver, is_active: a.isActive, sort_order: a.sortOrder }
    const query =
      a.id && existingIds.has(a.id)
        ? supabase.from("order_delivery_areas").update(row).eq("tenant_id", tenantId).eq("id", a.id)
        : supabase.from("order_delivery_areas").insert({ tenant_id: tenantId, ...row })
    const { error } = await query
    if (error) fail(error, "Save delivery areas")
  }
}


// ============================================================================
// STOCK TAKE
// ============================================================================

type TakeRow = { id: string; name: string; notes: string | null; status: StockTakeStatus; created_at: string; completed_at: string | null }
type LineRow = {
  product_id: string | null
  product_name: string
  category_label: string | null
  expected_qty: number
  counted_qty: number | null
  applied_delta: number | null
  stock_after: number | null
}

function summarise(t: TakeRow, lines: Pick<LineRow, "counted_qty" | "applied_delta">[]): StockTakeSummary {
  let adjusted = 0
  let up = 0
  let down = 0
  let counted = 0
  for (const l of lines) {
    if (l.counted_qty !== null) counted++
    if (t.status === "completed" && l.applied_delta) {
      adjusted++
      if (l.applied_delta > 0) up += l.applied_delta
      else down += -l.applied_delta
    }
  }
  return {
    id: t.id,
    name: t.name,
    notes: t.notes,
    status: t.status,
    createdAt: t.created_at,
    completedAt: t.completed_at,
    lineCount: lines.length,
    countedCount: counted,
    adjustedCount: adjusted,
    unitsAdded: up,
    unitsRemoved: down,
  }
}

const TAKE_COLUMNS = "id, name, notes, status, created_at, completed_at"

export async function listStockTakes(): Promise<ActionResult<StockTakeSummary[]>> {
  return run(VIEW, async ({ supabase, tenantId }) => {
    const { data: takes, error } = await supabase
      .from("stock_takes")
      .select(TAKE_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(30)
    if (error) fail(error, "Load stock takes")
    const rows = (takes ?? []) as unknown as TakeRow[]
    if (rows.length === 0) return []
    const { data: lines, error: lerr } = await supabase
      .from("stock_take_lines")
      .select("stock_take_id, counted_qty, applied_delta")
      .eq("tenant_id", tenantId)
      .in("stock_take_id", rows.map((r) => r.id))
      .limit(50000)
    if (lerr) fail(lerr, "Load stock takes")
    const by = new Map<string, Pick<LineRow, "counted_qty" | "applied_delta">[]>()
    for (const l of (lines ?? []) as unknown as Array<{ stock_take_id: string; counted_qty: number | null; applied_delta: number | null }>) {
      const arr = by.get(l.stock_take_id) ?? []
      arr.push(l)
      by.set(l.stock_take_id, arr)
    }
    return rows.map((r) => summarise(r, by.get(r.id) ?? []))
  })
}

export async function getStockTake(id: string): Promise<ActionResult<StockTakeDetail>> {
  return run(VIEW, async ({ supabase, tenantId }) => {
    const { data: take, error } = await supabase.from("stock_takes").select(TAKE_COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
    if (error) fail(error, "Load stock take")
    if (!take) throw new UserError("That stock take wasn't found.")
    const { data: lines, error: lerr } = await supabase
      .from("stock_take_lines")
      .select("product_id, product_name, category_label, expected_qty, counted_qty, applied_delta, stock_after")
      .eq("tenant_id", tenantId)
      .eq("stock_take_id", id)
      .order("product_name", { ascending: true })
      .limit(50000)
    if (lerr) fail(lerr, "Load stock take")
    const rows = (lines ?? []) as unknown as LineRow[]
    return {
      summary: summarise(take as unknown as TakeRow, rows),
      lines: rows
        .filter((l) => l.product_id)
        .map((l) => ({
          productId: l.product_id as string,
          name: l.product_name,
          categoryLabel: l.category_label,
          expected: l.expected_qty,
          counted: l.counted_qty,
          appliedDelta: l.applied_delta,
          stockAfter: l.stock_after,
        })),
    }
  })
}

export async function startStockTake(name: string, notes?: string): Promise<ActionResult<{ id: string }>> {
  return run(MANAGE, async ({ supabase, tenantId, userId }) => {
    const n = name.trim()
    if (n.length < 1 || n.length > 80) throw new UserError("Give the stock take a name (up to 80 characters).")
    if ((notes ?? "").length > 500) throw new UserError("Notes can be up to 500 characters.")
    const { data, error } = await supabase.rpc("start_stock_take", { p_tenant: tenantId, p_user: userId, p_name: n, p_notes: notes ?? null })
    if (error) fail(error, "Start stock take")
    const r = data as { outcome: string; stock_take_id?: string }
    if (r.outcome === "nothing_to_count") throw new UserError("No products have stock tracking switched on yet. Turn on \"Track inventory\" for the products you want to count.")
    if ((r.outcome === "ok" || r.outcome === "already_in_progress") && r.stock_take_id) return { id: r.stock_take_id }
    throw new UserError("Couldn't start the stock take. Try again.")
  })
}

export async function saveStockTakeCounts(id: string, counts: Array<{ productId: string; counted: number | null }>): Promise<ActionResult<{ saved: number }>> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const payload = counts.map((c) => ({ product_id: c.productId, counted: c.counted }))
    const { data, error } = await supabase.rpc("save_stock_take_counts", { p_tenant: tenantId, p_take: id, p_counts: payload })
    if (error) fail(error, "Save counts")
    const r = data as { outcome: string; saved?: number }
    if (r.outcome === "ok") return { saved: r.saved ?? 0 }
    if (r.outcome === "invalid_count") throw new UserError("Counts must be whole numbers from 0 upwards.")
    if (r.outcome === "not_in_progress") throw new UserError("This stock take is already finished.")
    throw new UserError("That stock take wasn't found.")
  })
}

export async function completeStockTake(id: string): Promise<ActionResult<StockTakeResult>> {
  return run(MANAGE, async ({ supabase, tenantId, userId }) => {
    const { data, error } = await supabase.rpc("complete_stock_take", { p_tenant: tenantId, p_take: id, p_user: userId })
    if (error) fail(error, "Finish stock take")
    const r = data as { outcome: string; counted: number; adjusted: number; units_added: number; units_removed: number; stock: Record<string, number> }
    if (r.outcome === "not_in_progress") throw new UserError("This stock take is already finished.")
    if (r.outcome !== "ok") throw new UserError("That stock take wasn't found.")
    return { counted: r.counted, adjusted: r.adjusted, unitsAdded: r.units_added, unitsRemoved: r.units_removed, stock: r.stock ?? {} }
  })
}

export async function cancelStockTake(id: string): Promise<ActionResult> {
  return run(MANAGE, async ({ supabase, tenantId }) => {
    const { data, error } = await supabase
      .from("stock_takes")
      .update({ status: "cancelled" })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "in_progress")
      .select("id")
    if (error) fail(error, "Cancel stock take")
    if (!data || data.length === 0) throw new UserError("This stock take is already finished.")
  })
}
