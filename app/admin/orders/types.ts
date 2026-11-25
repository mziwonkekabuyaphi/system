// app/admin/orders/types.ts

import type { StatusNotifications } from "@/lib/services/orders/orders.status-notify"
//
// Shapes for the Order management module (tables from 001_orders_multitenant.sql).
// camelCase here, snake_case in the database; orders-data.ts is the one place
// that maps between them.

/** Sidebar entry -> the Orders page it opens (same idea as ShishaSection). */
export type OrdersSection = "board" | "products" | "catalogue"

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
  | "awaiting_acceptance" // placed (and paid, if the shop requires it), waiting for staff to accept or decline
  | "scheduled" // paid/accepted, waiting for scheduled_for
  | "placed"
  | "preparing"
  | "ready"
  | "out_for_delivery" // delivery orders only: with the driver
  | "collected"
  | "completed"
  | "cancelled"

/** How the order reaches the customer (orders.fulfilment). */
export type OrderFulfilment = "collection" | "delivery" | "dine_in"

export type PaymentMethod = "wallet" | "card" | "cash"
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "refund_pending"

/** The one-click forward step for an order. Cancel is separate (cancel_order RPC).
 *  "pending" has no entry on purpose: a card order moves on when the payment
 *  webhook confirms it, never by hand. */
const BASE_STEPS: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  scheduled: { to: "placed", label: "Release now" },
  placed: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
}

/** The next hand-moved step, which depends on how the order is fulfilled:
 *  collection  ready -> collected      dine-in  ready -> collected ("Mark served")
 *  delivery    ready -> out_for_delivery -> completed ("Mark delivered") */
export function nextOrderStep(status: OrderStatus, fulfilment: OrderFulfilment): { to: OrderStatus; label: string } | null {
  const base = BASE_STEPS[status]
  if (base) return base
  if (status === "ready") {
    if (fulfilment === "delivery") return { to: "out_for_delivery", label: "Out for delivery" }
    return { to: "collected", label: fulfilment === "dine_in" ? "Mark served" : "Mark collected" }
  }
  if (status === "out_for_delivery") return { to: "completed", label: "Mark delivered" }
  return null
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
  fulfilment: OrderFulfilment
  /** Delivery orders only. */
  deliveryArea: string | null
  deliveryAddress: string | null
  /** The fee is charged once per checkout and sits on the first order of it; 0 elsewhere. */
  deliveryFee: number
  customerName: string | null
  customerPhone: string
  /** Delivery orders only: the driver who has (or was given) the job. */
  driverId: string | null
  driverName: string | null
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

export interface AdminDeliveryArea {
  id: string
  name: string
  fee: number
  /** null = never free. Delivery is free once the items total reaches this. */
  freeOver: number | null
  isActive: boolean
}

/** Editable area: `id` is absent for rows not saved yet. */
export type DeliveryAreaInput = Omit<AdminDeliveryArea, "id"> & { id?: string }

/** first_come = ready deliveries are offered to every on-duty driver, first to tap gets it.
 *  dispatcher = nothing is offered; staff pick a driver on the board. */
export type DriverDispatchMode = "first_come" | "dispatcher"

export interface AdminDriver {
  id: string
  name: string
  /** "+27821234567" */
  phone: string
  isActive: boolean
  /** Set by the driver replying "on duty" on WhatsApp. */
  onDuty: boolean
}

export type DriverInput = { id?: string; name: string; phone: string; isActive: boolean }

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
  collectionEnabled: boolean
  deliveryEnabled: boolean
  dineInEnabled: boolean
  /** Shown after a collection order, e.g. "Show your order number at the bar." */
  collectionInstructions: string | null
  prepTimeMinutes: number
  deliveryTimeMinutes: number
  deliveryAreas: AdminDeliveryArea[]
  /** true = new orders go straight to the board. false = staff must accept each one first. */
  autoAcceptOrders: boolean
  /** true = customers must pay up front (wallet or card); "pay at counter" is not offered. */
  requirePayment: boolean
  /** Smallest items total (delivery fee not counted) a customer can check out with. 0 = no minimum. */
  minOrderValue: number
  /** Largest items total a customer can check out with. null = no maximum. */
  maxOrderValue: number | null
  /** Which WhatsApp updates customers get as staff move an order along. */
  statusNotifications: StatusNotifications
  /** How delivery jobs reach drivers. */
  driverDispatchMode: DriverDispatchMode
}

export type OrderSettingsInput = Omit<AdminOrderSettings, "configured" | "deliveryAreas"> & { deliveryAreas: DeliveryAreaInput[] }

export interface OrdersData {
  orders: AdminOrder[]
  products: AdminProduct[]
  categories: AdminProductCategory[]
  vendors: AdminOrderVendor[]
  drivers: AdminDriver[]
  settings: AdminOrderSettings
}

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Stock take (stock_takes / stock_take_lines)
// ---------------------------------------------------------------------------

export type StockTakeStatus = "in_progress" | "completed" | "cancelled"

export interface StockTakeSummary {
  id: string
  name: string
  notes: string | null
  status: StockTakeStatus
  /** ISO timestamps */
  createdAt: string
  completedAt: string | null
  lineCount: number
  countedCount: number
  /** Completed counts only: products whose stock was changed. */
  adjustedCount: number
  unitsAdded: number
  unitsRemoved: number
}

export interface StockTakeLine {
  productId: string
  name: string
  categoryLabel: string | null
  /** What the system said when the count started. */
  expected: number
  /** null = not counted yet. */
  counted: number | null
  /** Completed counts only: the change that was applied to stock. */
  appliedDelta: number | null
  stockAfter: number | null
}

export interface StockTakeDetail {
  summary: StockTakeSummary
  lines: StockTakeLine[]
}

export interface StockTakeResult {
  counted: number
  adjusted: number
  unitsAdded: number
  unitsRemoved: number
  /** productId -> stock after the count, to refresh the product list on screen. */
  stock: Record<string, number>
}
