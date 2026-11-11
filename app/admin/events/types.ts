// app/admin/events/types.ts
//
// Shapes shared by the Events admin (EventsManager and its panels) and its
// server actions. Mirrors the events_module_multitenant migration:
// events, event_ticket_types, event_orders, event_tickets, event_scans.

export type EventStatus = "draft" | "active" | "cancelled" | "ended"

/** Sidebar entries for the Events area. AdminView maps one tab to each. */
export type EventsSection = "events" | "boxoffice" | "gate"

export type PaymentMethod = "cash" | "card" | "eft" | "wallet" | "complimentary"

/** Resolved once per request in page.tsx and threaded down. These only decide
 *  which controls render; the database re-checks every one of them. */
export interface EventsPermissions {
  /** events.view */
  eventsView: boolean
  /** events.manage — create/edit/delete events and tiers, complimentary tickets. */
  eventsManage: boolean
  /** tickets.view — orders, tickets, sales figures. */
  ticketsView: boolean
  /** tickets.manage — cancel and refund tickets. */
  ticketsManage: boolean
  /** tickets.issue — sell at the box office. */
  ticketsIssue: boolean
  /** tickets.scan — check people in at the gate. */
  ticketsScan: boolean
}

export interface EventTicketType {
  id: string
  eventId: string
  name: string
  description: string | null
  price: number
  capacity: number
  /** Maintained only by the ticketing engine. */
  sold: number
  /** How many times one ticket can be scanned in. */
  entriesAllowed: number
  isActive: boolean
  sortOrder: number
}

export interface EventStats {
  ticketsSold: number
  /** Tickets that have been scanned in at least once. */
  ticketsAdmitted: number
  gross: number
  refunded: number
  failedScans: number
}

export interface EventSummary {
  id: string
  name: string
  description: string | null
  location: string | null
  /** ISO timestamps */
  startTime: string
  endTime: string | null
  status: EventStatus
  imageUrl: string | null
  ticketTypes: EventTicketType[]
  stats: EventStats
}

export type TicketStatus = "issued" | "used" | "cancelled" | "refunded"

export interface EventTicket {
  id: string
  ticketNumber: string
  status: TicketStatus
  entriesUsed: number
  entriesAllowed: number
  pricePaid: number
  refundMethod: "wallet" | "manual" | null
}

export interface EventOrder {
  id: string
  ticketTypeName: string
  customerName: string | null
  customerPhone: string | null
  quantity: number
  total: number
  refundedTotal: number
  channel: "online" | "box_office"
  paymentMethod: PaymentMethod | "free"
  createdAt: string
  tickets: EventTicket[]
}

export type ScanResult = "valid" | "invalid" | "duplicate" | "wrong_event" | "cancelled" | "event_closed"

export interface EventScan {
  id: string
  ticketNumber: string | null
  result: ScanResult
  gate: string | null
  scannedAt: string
}

/** What event_check_in_ticket returns. Failures are results, not errors. */
export interface CheckInResult {
  success: boolean
  result: ScanResult
  message: string
  ticketNumber?: string
  ticketType?: string | null
  holder?: string | null
  entriesUsed?: number
  entriesAllowed?: number
  lastScannedAt?: string | null
}

export interface GateSnapshot {
  recent: EventScan[]
  sold: number
  admitted: number
  failed: number
}

export interface TicketTypeInput {
  /** Present for an existing tier; omitted for a new one. */
  id?: string
  name: string
  price: number
  capacity: number
  entriesAllowed: number
  isActive: boolean
}

export interface EventInput {
  id?: string
  name: string
  description: string
  location: string
  /** ISO timestamps (already converted from the shop's timezone). */
  startTime: string
  endTime: string | null
  status: "draft" | "active"
  ticketTypes: TicketTypeInput[]
}

export interface SellTicketsInput {
  eventId: string
  ticketTypeId: string
  quantity: number
  paymentMethod: PaymentMethod
  customerId: string | null
  phone: string | null
  admit: boolean
  gate: string | null
  /** Same key on a retry returns the same order instead of selling twice. */
  idempotencyKey: string
}

export interface SaleReceipt {
  orderId: string
  total: number
  paymentMethod: PaymentMethod | "free"
  tickets: Array<{ ticketNumber: string; status: TicketStatus }>
}

/** A customer's Passport (wallet) as the box office needs it: enough to warn before a sale. */
export interface PassportBalance {
  balance: number
  /** "none" = the customer has no Passport yet (their first top-up creates it). */
  status: "active" | "blocked" | "closed" | "none"
  blockReason: string | null
}

export interface CustomerHit {
  id: string
  name: string | null
  phone: string
}

export interface RevenuePoint {
  /** YYYY-MM-DD in the shop's timezone */
  date: string
  gross: number
  refunded: number
}
