// lib/services/addons.ts
//
// Priced add-ons: switchable modules that sit under Order Management or Event Management and carry a
// flat monthly fee of their own (addon_billing_rates, set on /platform/pricing). Plain constants only,
// so the client-side pricing editor and the server billing code share one list.
//
// An add-on is billed only while BOTH the add-on and its parent module are switched on. The charge goes
// on the parent's invoice (Orders invoice / Events invoice) as an itemised line, not a separate invoice.

export interface AddonSpec {
  key: string
  label: string
}

/** Add-ons under Order Management. */
export const ORDER_ADDONS: readonly AddonSpec[] = [
  { key: "stock_take", label: "Stock take" },
  { key: "barcode_labels", label: "Barcode / label printing" },
]

/** Add-ons under Event Management. */
export const EVENT_ADDONS: readonly AddonSpec[] = [
  { key: "box_office", label: "Box office" },
  { key: "vvip", label: "VVIP tables & tabs" },
]

export const ALL_PRICED_ADDONS: readonly AddonSpec[] = [...ORDER_ADDONS, ...EVENT_ADDONS]

/** One add-on charge, as itemised on an invoice and in the tenant's Billing panel. */
export interface AddonCharge {
  key: string
  label: string
  feeCents: number
}
