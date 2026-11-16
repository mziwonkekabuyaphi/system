// app/admin/orders/orders-data.ts
//
// Server-only loaders for the Orders module. Called from app/admin/page.tsx
// (first paint) and from actions.ts (polling / refresh). Like the rest of the
// admin, this reads through the service-role client, so EVERY query filters by
// .eq("tenant_id", tenantId) — that filter is the tenant boundary, not RLS.

import type { getSupabaseServerClient } from "@/lib/supabase/admin"
import type {
  AdminOrder,
  AdminDeliveryArea,
  AdminOrderSettings,
  AdminOrderVendor,
  AdminProduct,
  AdminProductCategory,
  OrderFulfilment,
  OrdersData,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ProductStatus,
} from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

const ACTIVE_ORDER_STATUSES: OrderStatus[] = ["pending", "scheduled", "placed", "preparing", "ready", "out_for_delivery"]
/** Finished orders stay on the board for this long. */
const FINISHED_WINDOW_HOURS = 24
const ORDER_LIMIT = 500

export const DEFAULT_ORDER_SETTINGS: AdminOrderSettings = {
  configured: false,
  orderNumberPrefix: "O",
  walletLabel: "Wallet",
  allowedPaymentMethods: ["wallet", "card"],
  allowScheduling: true,
  scheduleMinLeadMinutes: 15,
  minAge: null,
  defaultVendorId: null,
  searchAliases: {},
  collectionEnabled: true,
  deliveryEnabled: false,
  dineInEnabled: false,
  collectionInstructions: null,
  prepTimeMinutes: 15,
  deliveryTimeMinutes: 45,
  deliveryAreas: [],
}

const ORDER_SELECT = `id, order_number, status, payment_method, payment_status, total_amount,
  scheduled_for, table_label, fulfilment, delivery_area_name, delivery_address, delivery_fee,
  customer_name, customer_phone, created_at, vendor_id,
  order_items ( product_name, quantity, unit_price, created_at )`

const PRODUCT_SELECT =
  "id, category_id, vendor_id, name, brand, description, short_description, price, status, is_available, track_inventory, stock_quantity, image_url"

export function mapProduct(p: any): AdminProduct {
  return {
    id: p.id,
    categoryId: p.category_id ?? null,
    vendorId: p.vendor_id ?? null,
    name: p.name,
    brand: p.brand ?? null,
    description: p.description ?? null,
    shortDescription: p.short_description ?? null,
    price: Number(p.price),
    status: p.status as ProductStatus,
    isAvailable: !!p.is_available,
    trackInventory: !!p.track_inventory,
    stockQuantity: p.stock_quantity == null ? null : Number(p.stock_quantity),
    imageUrl: p.image_url ?? null,
  }
}

export function mapCategory(c: any): AdminProductCategory {
  return {
    id: c.id,
    key: c.key,
    label: c.label,
    groupKey: c.group_key ?? null,
    groupLabel: c.group_label ?? null,
    emoji: c.emoji ?? null,
    aliases: Array.isArray(c.aliases) ? c.aliases : [],
    ageRestricted: !!c.age_restricted,
    sortOrder: Number(c.sort_order ?? 0),
    isActive: !!c.is_active,
  }
}

export function mapVendor(v: any): AdminOrderVendor {
  return { id: v.id, name: v.name, collectionPoint: v.collection_point, isActive: !!v.is_active }
}

export function mapDeliveryArea(a: any): AdminDeliveryArea {
  return {
    id: a.id,
    name: a.name,
    fee: Number(a.fee),
    minOrder: Number(a.min_order ?? 0),
    freeOver: a.free_over == null ? null : Number(a.free_over),
    isActive: !!a.is_active,
  }
}

export async function loadDeliveryAreas(supabase: ServerClient, tenantId: string): Promise<AdminDeliveryArea[]> {
  const { data, error } = await supabase
    .from("order_delivery_areas")
    .select("id, name, fee, min_order, free_over, is_active")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (error) throw new Error(`Failed to load delivery areas: ${error.message}`)
  return (data ?? []).map(mapDeliveryArea)
}

export function mapSettings(s: any, deliveryAreas: AdminDeliveryArea[] = []): AdminOrderSettings {
  return {
    configured: true,
    orderNumberPrefix: s.order_number_prefix,
    walletLabel: s.wallet_label,
    allowedPaymentMethods: (s.allowed_payment_methods ?? []) as PaymentMethod[],
    allowScheduling: !!s.allow_scheduling,
    scheduleMinLeadMinutes: Number(s.schedule_min_lead_minutes ?? 0),
    minAge: s.min_age == null ? null : Number(s.min_age),
    defaultVendorId: s.default_vendor_id ?? null,
    searchAliases: s.search_aliases && typeof s.search_aliases === "object" ? s.search_aliases : {},
    collectionEnabled: s.collection_enabled ?? true,
    deliveryEnabled: !!s.delivery_enabled,
    dineInEnabled: !!s.dine_in_enabled,
    collectionInstructions: s.collection_instructions ?? null,
    prepTimeMinutes: Number(s.prep_time_minutes ?? 15),
    deliveryTimeMinutes: Number(s.delivery_time_minutes ?? 45),
    deliveryAreas,
  }
}

function mapOrder(o: any, vendors: Map<string, AdminOrderVendor>): AdminOrder {
  const vendor = vendors.get(o.vendor_id)
  const items = [...(o.order_items ?? [])].sort((a: any, b: any) =>
    String(a.created_at).localeCompare(String(b.created_at)),
  )
  return {
    id: o.id,
    orderNumber: o.order_number,
    status: o.status as OrderStatus,
    paymentMethod: o.payment_method as PaymentMethod,
    paymentStatus: o.payment_status as PaymentStatus,
    total: Number(o.total_amount),
    scheduledFor: o.scheduled_for ?? null,
    tableLabel: o.table_label ?? null,
    fulfilment: (o.fulfilment ?? "collection") as OrderFulfilment,
    deliveryArea: o.delivery_area_name ?? null,
    deliveryAddress: o.delivery_address ?? null,
    deliveryFee: Number(o.delivery_fee ?? 0),
    customerName: o.customer_name ?? null,
    customerPhone: o.customer_phone,
    createdAt: o.created_at,
    vendorId: o.vendor_id,
    vendorName: vendor?.name ?? "Unknown vendor",
    collectionPoint: vendor?.collectionPoint ?? "",
    items: items.map((i: any) => ({ name: i.product_name, quantity: i.quantity, unitPrice: Number(i.unit_price) })),
  }
}

export async function loadVendors(supabase: ServerClient, tenantId: string): Promise<AdminOrderVendor[]> {
  const { data, error } = await supabase
    .from("order_vendors")
    .select("id, name, collection_point, is_active")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true })
  if (error) throw new Error(`Failed to load vendors: ${error.message}`)
  return (data ?? []).map(mapVendor)
}

/** Open orders (any age) plus everything from the last FINISHED_WINDOW_HOURS. */
export async function loadOrders(
  supabase: ServerClient,
  tenantId: string,
  vendors?: AdminOrderVendor[],
): Promise<AdminOrder[]> {
  const since = new Date(Date.now() - FINISHED_WINDOW_HOURS * 3600_000).toISOString()
  const [{ data, error }, vendorList] = await Promise.all([
    supabase
      .from("orders")
      .select(ORDER_SELECT)
      .eq("tenant_id", tenantId)
      .or(`status.in.(${ACTIVE_ORDER_STATUSES.join(",")}),created_at.gte.${since}`)
      .order("created_at", { ascending: false })
      .limit(ORDER_LIMIT),
    vendors ? Promise.resolve(vendors) : loadVendors(supabase, tenantId),
  ])
  if (error) throw new Error(`Failed to load orders: ${error.message}`)
  const byId = new Map(vendorList.map((v) => [v.id, v]))
  return (data ?? []).map((o) => mapOrder(o, byId))
}

export async function loadOrdersData(supabase: ServerClient, tenantId: string): Promise<OrdersData> {
  const [productsRes, categoriesRes, settingsRes, vendors, deliveryAreas] = await Promise.all([
    supabase.from("products").select(PRODUCT_SELECT).eq("tenant_id", tenantId).order("name", { ascending: true }),
    supabase
      .from("product_categories")
      .select("id, key, label, group_key, group_label, emoji, aliases, age_restricted, sort_order, is_active")
      .eq("tenant_id", tenantId)
      .order("sort_order", { ascending: true })
      .order("label", { ascending: true }),
    supabase.from("order_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
    loadVendors(supabase, tenantId),
    loadDeliveryAreas(supabase, tenantId),
  ])
  if (productsRes.error) throw new Error(`Failed to load products: ${productsRes.error.message}`)
  if (categoriesRes.error) throw new Error(`Failed to load categories: ${categoriesRes.error.message}`)
  if (settingsRes.error) throw new Error(`Failed to load order settings: ${settingsRes.error.message}`)

  const orders = await loadOrders(supabase, tenantId, vendors)

  return {
    orders,
    products: (productsRes.data ?? []).map(mapProduct),
    categories: (categoriesRes.data ?? []).map(mapCategory),
    vendors,
    settings: settingsRes.data ? mapSettings(settingsRes.data, deliveryAreas) : { ...DEFAULT_ORDER_SETTINGS, deliveryAreas },
  }
}
