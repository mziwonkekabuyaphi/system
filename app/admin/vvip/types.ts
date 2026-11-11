// app/admin/vvip/types.ts
//
// Shapes shared by the VVIP admin (VvipManager and its views) and its server actions. Mirrors the
// vvip_packages / vvip_tables / vvip_bookings / vvip_tab_ledger tables. Plain data only: this file is
// imported by the server actions AND the client components, so it must not import anything server-only.

/** Sidebar entries for the VVIP area. AdminView maps one tab to each. */
export type VvipSection = "tables" | "tabs"

/** Resolved once per request in page.tsx. These only decide which controls render;
 *  the database re-checks every one of them. */
export interface VvipPermissions {
  /** vvip.view: see packages, tables, bookings, tabs. */
  view: boolean
  /** vvip.operate: book a table, check in / seat / complete, log tab spend and top-ups. */
  operate: boolean
  /** vvip.manage: packages and tables, cancel bookings, adjust tabs, give a table away. */
  manage: boolean
}

export type PackageStatus = "active" | "inactive" | "archived"
export type BookingStatus = "confirmed" | "checked_in" | "seated" | "completed" | "cancelled" | "no_show"
export type BookingPayment = "wallet" | "cash" | "card" | "eft" | "complimentary" | "free"
/** What staff can choose in the Book a table dialog. */
export type BookablePayment = "cash" | "card" | "eft" | "wallet" | "complimentary"
/** vvip_tab_topup accepts these three only. */
export type TopupMethod = "cash" | "card" | "eft"
export type EntryType = "opening" | "topup" | "spend" | "refund" | "adjustment"

/** A table is "booked" while it has a booking that is neither cancelled nor a no-show. */
export function isLiveStatus(status: BookingStatus): boolean {
  return status !== "cancelled" && status !== "no_show"
}

/** The tab still holds (or can still take) money while the booking is in one of these. */
export function isOpenTabStatus(status: BookingStatus): boolean {
  return status === "confirmed" || status === "checked_in" || status === "seated"
}

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: "Confirmed",
  checked_in: "Checked in",
  seated: "Seated",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
}

export const BOOKING_STATUS_TONE: Record<BookingStatus, "neutral" | "good" | "warn" | "bad" | "accent"> = {
  confirmed: "accent",
  checked_in: "good",
  seated: "good",
  completed: "neutral",
  cancelled: "bad",
  no_show: "warn",
}

export const PAYMENT_LABEL: Record<BookingPayment, string> = {
  wallet: "Passport",
  cash: "Cash",
  card: "Card",
  eft: "EFT",
  complimentary: "Complimentary",
  free: "Free",
}

export const PACKAGE_STATUS_LABEL: Record<PackageStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  archived: "Archived",
}

export const ENTRY_LABEL: Record<EntryType, string> = {
  opening: "Opening credit",
  topup: "Top-up",
  spend: "Spend",
  refund: "Refund",
  adjustment: "Adjustment",
}

/** The status moves vvip_set_booking_status allows, per current status. Anything else is refused by the database. */
export const NEXT_STATUSES: Record<BookingStatus, Array<{ status: "checked_in" | "seated" | "completed" | "no_show"; label: string; icon: string }>> = {
  confirmed: [
    { status: "checked_in", label: "Check in", icon: "right-to-bracket" },
    { status: "no_show", label: "No-show", icon: "user-slash" },
  ],
  checked_in: [
    { status: "seated", label: "Seat", icon: "chair" },
    { status: "completed", label: "Complete", icon: "flag-checkered" },
  ],
  seated: [{ status: "completed", label: "Complete", icon: "flag-checkered" }],
  completed: [],
  cancelled: [],
  no_show: [],
}

export interface VvipTable {
  id: string
  label: string
  sortOrder: number
  /** Has a live booking. Derived, never stored. */
  booked: boolean
}

export interface VvipPackage {
  id: string
  eventId: string
  eventName: string | null
  eventStart: string | null
  name: string
  description: string | null
  price: number
  tabCredit: number
  seatsPerTable: number
  benefits: string[]
  imageUrl: string | null
  status: PackageStatus
  /** In sort order. The table count is simply the length of this list. */
  tables: VvipTable[]
  bookedCount: number
  /** Sum of price_paid - refunded_amount over this package's bookings that are not cancelled. */
  revenue: number
}

export interface VvipBooking {
  id: string
  reference: string
  packageId: string
  packageName: string
  tableId: string | null
  tableLabel: string | null
  customerId: string
  customerName: string | null
  customerPhone: string | null
  status: BookingStatus
  pricePaid: number
  tabCreditIssued: number
  tabBalance: number
  paymentMethod: BookingPayment
  refundedAmount: number
  refundMethod: "wallet" | "manual" | null
  cancelReason: string | null
  notes: string | null
  createdAt: string
}

export interface VvipEventOption {
  id: string
  name: string
  startTime: string
  status: string
}

export interface VvipSummary {
  /** Distinct customers with a live booking. */
  buyers: number
  /** Live bookings. */
  tablesSold: number
  /** Sum of tab_balance over confirmed / checked_in / seated bookings. */
  tabOutstanding: number
  /** Sum of price_paid - refunded_amount over bookings that are not cancelled. */
  revenue: number
}

export interface VvipData {
  packages: VvipPackage[]
  bookings: VvipBooking[]
  events: VvipEventOption[]
  summary: VvipSummary
}

export interface VvipLedgerEntry {
  id: string
  seq: number
  direction: "credit" | "debit"
  entryType: EntryType
  /** Always positive; `direction` gives the sign. */
  amount: number
  balanceAfter: number
  description: string | null
  createdAt: string
}

/** Spend and top-ups per booking, for the analytics panel. */
export interface VvipTabFlow {
  bookingId: string
  spent: number
  toppedUp: number
}

export interface SavePackageInput {
  /** Present when editing; omitted to create. */
  id?: string
  eventId: string
  name: string
  description: string
  price: number
  tabCredit: number
  seatsPerTable: number
  benefits: string[]
  status: PackageStatus
  /** One name per table, in order. The database syncs the tables to this list. */
  tableLabels: string[]
}

export interface BookTableInput {
  packageId: string
  /** null = first free table. */
  tableId: string | null
  customerId: string
  paymentMethod: BookablePayment
  notes: string
  /** Same key on a retry returns the same booking instead of selling twice. */
  idempotencyKey: string
}

export interface BookingReceipt {
  bookingId: string
  reference: string
}

export interface TabEntryReceipt {
  entryId: string
  direction: "credit" | "debit"
  entryType: EntryType
  amount: number
  balanceAfter: number
}
