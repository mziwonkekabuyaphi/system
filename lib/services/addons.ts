// lib/services/addons.ts
//
// Priced add-ons: switchable modules that sit under Order Management or Event Management and carry a
// fee of their own (addon_billing_rates, set on /platform/pricing). Plain constants only, so the
// client-side pricing editor and the server billing code share one list.
//
// HOW EACH ONE IS CHARGED (its `unit`):
//   month  flat monthly fee, only while the add-on AND its parent module are switched on
//          (Orders: Stock take, Barcode / label printing)
//   ticket a fee per ticket sold through the box office, on top of the Events per-ticket fee
//          (Events: Box office). Charged for every box-office ticket sold, even if the add-on was
//          switched off before invoicing: the sales happened.
//   table  a fee per table booked (Events: Tables and Tabs; one booking = one table)
// The charge goes on the parent's invoice (Orders invoice / Events invoice) as an itemised line.

export type AddonUnit = "month" | "ticket" | "table"

export interface AddonSpec {
  key: string
  label: string
  unit: AddonUnit
}

/** Add-ons under Order Management. */
export const ORDER_ADDONS: readonly AddonSpec[] = [
  { key: "stock_take", label: "Stock take", unit: "month" },
  { key: "barcode_labels", label: "Barcode / label printing", unit: "month" },
]

/** Add-ons under Event Management. */
export const EVENT_ADDONS: readonly AddonSpec[] = [
  { key: "box_office", label: "Box office", unit: "ticket" },
  { key: "vvip", label: "Tables and Tabs", unit: "table" },
]

export const ALL_PRICED_ADDONS: readonly AddonSpec[] = [...ORDER_ADDONS, ...EVENT_ADDONS]

/** One add-on charge, as itemised on an invoice and in the tenant's Billing panel. */
export interface AddonCharge {
  key: string
  label: string
  unit: AddonUnit
  /** Months (always 1), tickets or tables the charge covers. */
  quantity: number
  /** Rate per unit, in cents. */
  rateCents: number
  /** quantity x rateCents: what this line adds to the bill. */
  feeCents: number
}

/** "Box office", "per ticket" style wording shared by the panel and the pricing editor. */
export const ADDON_UNIT_SUFFIX: Record<AddonUnit, string> = { month: "/ month", ticket: "per ticket", table: "per table" }
export const ADDON_UNIT_NOUN: Record<AddonUnit, { one: string; many: string }> = {
  month: { one: "month", many: "months" },
  ticket: { one: "ticket", many: "tickets" },
  table: { one: "table", many: "tables" },
}
