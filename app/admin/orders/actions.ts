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

import { loadOrders, mapCategory, mapProduct, mapSettings, mapVendor } from "./orders-data"
import {
  NEXT_ORDER_STATUS,
  PRODUCT_STATUSES,
  type ActionResult,
  type AdminOrder,
  type AdminOrderSettings,
  type AdminOrderVendor,
  type AdminProduct,
  type AdminProductCategory,
  type CategoryInput,
  type OrderSettingsInput,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
  type ProductInput,
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
  const { tenantId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new UserError("The server isn't configured.")
  const mods = await getEffectiveModules(tenantId)
  if (!mods.on("orders")) throw new UserError("Order management isn't switched on for this shop.")
  const { granted } = await getTenantPermissions(anyOf)
  if (!anyOf.some((k) => granted.has(k))) throw new UserError("You don't have permission to do that.")
  return { supabase, tenantId }
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
    const to = NEXT_ORDER_STATUS[from]
    if (!to) throw new UserError("That order can't be moved forward by hand.")

    const { data: current, error: readErr } = await supabase
      .from("orders")
      .select("payment_method, payment_status")
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .maybeSingle()
    if (readErr) fail(readErr, "Update order")
    if (!current) throw new UserError("Order not found.")

    const patch: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() }
    // Cash is taken at the counter: collecting it is the moment it's paid.
    if (to === "collected" && current.payment_method === "cash" && current.payment_status === "pending") {
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
    const methods = PAYMENT_METHODS.filter((m) => input.allowedPaymentMethods.includes(m))
    if (methods.length === 0) throw new UserError("Allow at least one payment method.")
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
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" },
      )
      .select("*")
      .single()
    if (error) fail(error, "Save settings")
    return mapSettings(data)
  })
}
