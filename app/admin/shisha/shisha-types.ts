// app/admin/shisha/shisha-types.ts
//
// Types + pure helpers shared by the server loader/actions and ShishaManager.
// No "use server" and no server-only imports, so the client can import it.

export type ShishaLiveStatus = "active" | "refill" | "paused"
export type ShishaDeviceStatus = "available" | "in_use" | "maintenance"

/** What the UI shows. Only "paused" is stored as such; "refill" and "expired"
 *  are derived from the clock, so the stored status can lag behind them. */
export type ShishaDisplayStatus = "active" | "refill" | "paused" | "expired"

/** Stored statuses that count as "live" (matches the partial unique index on
 *  shisha_sessions that allows one live session per device). */
export const SHISHA_LIVE_STATUSES: ShishaLiveStatus[] = ["active", "refill", "paused"]

/** Shisha is billed by the platform on a fixed calendar, independent of the
 *  shop's own timezone, so "this month" always matches what is invoiced
 *  (the shisha_usage_monthly view uses the same zone). */
export const SHISHA_BILLING_TIMEZONE = "Africa/Johannesburg"

export const DEFAULT_COAL_DURATION_MINUTES = 60
export const DEFAULT_REFILL_THRESHOLD_MINUTES = 15
/** Shops that never saved settings behave as if "Require a station" is on. */
export const DEFAULT_REQUIRE_STATION = true

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "eft", label: "EFT" },
  { value: "tab", label: "On account" },
] as const
export type ShishaPaymentMethod = (typeof PAYMENT_METHODS)[number]["value"]

/** `warning` on the ok branch: the action worked, but something secondary didn't
 *  (e.g. the WhatsApp message to the customer couldn't be sent). run() shows it to staff. */
export type ShishaActionResult = { ok: true; warning?: string } | { ok: false; error: string }

export interface ShishaSettings {
  coalDurationMinutes: number
  refillThresholdMinutes: number
  /** Every session must have a station (explicit pick, else the device's usual
   *  one). Only enforced while the shop has at least one active station. */
  requireStation: boolean
}

export interface ShishaStation {
  id: string
  name: string
  isActive: boolean
}

export interface ShishaFlavour {
  id: string
  name: string
  price: number
  /** What a coal refill costs for this flavour. 0 = free refill. */
  refillPrice: number
  isAvailable: boolean
}

export interface ShishaDevice {
  id: string
  deviceCode: string
  deviceName: string | null
  locationId: string | null
  /** Stored status. A device with a live session is occupied regardless of this. */
  status: ShishaDeviceStatus
}

export interface ShishaSession {
  id: string
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  deviceId: string | null
  deviceCode: string
  productId: string | null
  flavourName: string
  locationId: string | null
  stationName: string | null
  /** ISO timestamp */
  startTime: string
  /** ISO timestamp. Timer anchor: set on start, refill and resume. */
  lastRefillTime: string
  /** Seconds left AT the anchor above (frozen value while paused). */
  remainingSeconds: number
  totalAmount: number
  refillCount: number
  paused: boolean
  /** Stored payment method value (see PAYMENT_METHODS), if already taken at the counter. */
  paymentMethod: string | null
  /** Sum of refill charges. totalAmount stays the grand total (session price + refills). */
  refillTotal: number
  /** How much of totalAmount has been settled. Balance = totalAmount - paidAmount. */
  paidAmount: number
  /** How a later balance (refills) was paid, when it differs from paymentMethod. */
  balancePaymentMethod: string | null
}

/** Amount still owed on a session (refills added after an up-front payment). */
export function sessionBalance(s: { totalAmount: number; paidAmount: number }): number {
  return Math.max(Math.round((s.totalAmount - s.paidAmount) * 100) / 100, 0)
}

export type ShishaRequestType = "order_session" | "maintenance" | "end_session" | "issue_report"

export const SHISHA_REQUEST_LABEL: Record<ShishaRequestType, string> = {
  order_session: "New session",
  maintenance: "Coal refill",
  end_session: "End session",
  issue_report: "Issue report",
}

/** A customer request waiting for staff (status = pending). */
export interface ShishaRequest {
  id: string
  requestType: ShishaRequestType
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  /** Station name as the customer saw it. */
  locationName: string | null
  flavourName: string | null
  deviceCode: string | null
  /** The amount stored on the request: the price the customer was quoted. */
  quotedAmount: number | null
  /** What it costs NOW, resolved server-side: the flavour's session price for a new
   *  session, its refill price for a refill. null when it doesn't apply or can't be found. */
  currentPrice: number | null
  sessionId: string | null
  issueLabel: string | null
  /** ISO timestamp */
  createdAt: string
}

export interface ShishaTodaySummary {
  sessions: number
  revenue: number
}

/** This month's platform service fees (per session + per refill). This is what
 *  the business OWES for using the module, not its session revenue. */
export interface ShishaUsageSummary {
  /** "YYYY-MM" in SHISHA_BILLING_TIMEZONE */
  month: string
  sessions: number
  refills: number
  amount: number
  /** Currency of the fee ledger (not necessarily tenant_settings.currency) */
  currency: string
}

export interface ShishaSnapshot {
  /** Shop name, used on printed receipts. May be empty if it couldn't be read. */
  shopName: string
  settings: ShishaSettings
  /** ISO 4217 code from tenant_settings.currency */
  currency: string
  stations: ShishaStation[]
  flavours: ShishaFlavour[]
  devices: ShishaDevice[]
  /** Live sessions only (active / refill / paused). */
  sessions: ShishaSession[]
  /** Pending customer requests, oldest first (max 200). */
  requests: ShishaRequest[]
  today: ShishaTodaySummary
  /** Only loaded for callers with shisha.manage; null for everyone else, and
   *  null if the ledger couldn't be read (the tab still works without it). */
  usage: ShishaUsageSummary | null
}

/** Seconds left on a session right now. */
export function liveRemainingSeconds(
  s: { paused: boolean; remainingSeconds: number; lastRefillTime: string },
  nowMs: number,
): number {
  if (s.paused) return Math.max(s.remainingSeconds, 0)
  const elapsed = Math.max(Math.floor((nowMs - new Date(s.lastRefillTime).getTime()) / 1000), 0)
  return Math.max(s.remainingSeconds - elapsed, 0)
}

/** Like liveRemainingSeconds but NOT clamped at zero: negative = seconds the
 *  session is overdue. Used to rank "needs attention" most overdue first.
 *  Paused sessions report their frozen (non-negative) value. */
export function signedRemainingSeconds(
  s: { paused: boolean; remainingSeconds: number; lastRefillTime: string },
  nowMs: number,
): number {
  if (s.paused) return Math.max(s.remainingSeconds, 0)
  const elapsed = Math.max(Math.floor((nowMs - new Date(s.lastRefillTime).getTime()) / 1000), 0)
  return s.remainingSeconds - elapsed
}

export function deriveDisplayStatus(
  remainingSeconds: number,
  paused: boolean,
  refillThresholdMinutes: number,
): ShishaDisplayStatus {
  if (paused) return "paused"
  if (remainingSeconds <= 0) return "expired"
  if (remainingSeconds <= refillThresholdMinutes * 60) return "refill"
  return "active"
}
