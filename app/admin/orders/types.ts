// app/admin/orders/types.ts
//
// Shapes for the Order management module (tables from 001_orders_multitenant.sql).
// camelCase here, snake_case in the database; orders-data.ts is the one place
// that maps between them.

/** Sidebar entry -> the Orders page it opens (same idea as ShishaSection). */
export type OrdersSection = "board" | "products" | "catalogue" | "settings"

/** orders.view / orders.operate / orders.manage, resolved in app/admin/page.tsx.
 *  All false when the Orders module is switched off for the shop.
 *   view    = see orders and the catalogue
 *   operate = move orders along, cancel them
 *   manage  = edit products, categories, vendors and order settings */
export interface OrdersPermissions {
  view: boolean
  operate: boolean
  manage: boolean
}

export const NO_ORDERS_PERMISSIONS: OrdersPermissions = { view: false, operate: false, manage: false }

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus =
  | "pending" // card checkout started, not paid yet
  | "scheduled" // paid/accepted, waiting for scheduled_for
  | "placed"
  | "preparing"
  | "ready"
  | "collected"
  | "completed"
  | "cancelled"

export type PaymentMethod = "wallet" | "card" | "cash"
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "refund_pending"

/** The one-click forward step for an order. Cancel is separate (cancel_order RPC).
 *  "pending" has no entry on purpose: a card order moves on when the payment
 *  webhook confirms it, never by hand. */
export const NEXT_ORDER_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  scheduled: "placed",
  placed: "preparing",
  preparing: "ready",
  ready: "collected",
}

export const NEXT_ORDER_LABEL: Partial<Record<OrderStatus, string>> = {
  scheduled: "Release now",
  placed: "Start preparing",
  preparing: "Mark ready",
  ready: "Mark collected",
}

export interface AdminOrderItem {
  name: string
  quantity: number
  unitPrice: number
}

export interface AdminOrder {
  id: string
  orderNumber: string
  status: OrderStatus
  paymentMethod: PaymentMethod
  paymentStatus: PaymentStatus
  total: number
  /** ISO timestamp, only for scheduled orders. */
  scheduledFor: string | null
  tableLabel: string | null
  customerName: string | null
  customerPhone: string
  /** ISO timestamp */
  createdAt: string
  vendorId: string
  vendorName: string
  collectionPoint: string
  items: AdminOrderItem[]
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type ProductStatus = "draft" | "active" | "hidden" | "archived"
export const PRODUCT_STATUSES: ProductStatus[] = ["draft", "active", "hidden", "archived"]

export interface AdminProduct {
  id: string
  categoryId: string | null
  vendorId: string | null
  name: string
  brand: string | null
  description: string | null
  shortDescription: string | null
  price: number
  status: ProductStatus
  /** Manual "can be ordered" switch. Wins over stock. */
  isAvailable: boolean
  trackInventory: boolean
  /** Only meaningful while trackInventory is on. null = untracked. */
  stockQuantity: number | null
  /** products.image_url (added in 002_orders_admin.sql). */
  imageUrl: string | null
}

/** Editable product fields: what the Add form and the Manage drawer send. */
export type ProductInput = Omit<AdminProduct, "id">

export interface AdminProductCategory {
  id: string
  /** Stable slug used by the WhatsApp flow. Set on create, never edited. */
  key: string
  label: string
  groupKey: string | null
  groupLabel: string | null
  emoji: string | null
  /** Loose customer phrasing, lower-case. */
  aliases: string[]
  ageRestricted: boolean
  sortOrder: number
  isActive: boolean
}

export type CategoryInput = Omit<AdminProductCategory, "id" | "key">

export interface AdminOrderVendor {
  id: string
  name: string
  collectionPoint: string
  isActive: boolean
}

export type VendorInput = Omit<AdminOrderVendor, "id">

export interface AdminOrderSettings {
  /** false = no order_settings row yet; the bot answers "ordering not configured" until the first save. */
  configured: boolean
  orderNumberPrefix: string
  walletLabel: string
  allowedPaymentMethods: PaymentMethod[]
  allowScheduling: boolean
  scheduleMinLeadMinutes: number
  /** null = no age check. */
  minAge: number | null
  defaultVendorId: string | null
  /** {"henny": "hennessy"} */
  searchAliases: Record<string, string>
}

export type OrderSettingsInput = Omit<AdminOrderSettings, "configured">

export interface OrdersData {
  orders: AdminOrder[]
  products: AdminProduct[]
  categories: AdminProductCategory[]
  vendors: AdminOrderVendor[]
  settings: AdminOrderSettings
}

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }
