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

/** Payment methods staff can pick, in the order shown. The FIRST one is the default
 *  everywhere a payment is chosen, and there is no "Not recorded" option. */
export const PAYMENT_METHODS = [
  { value: "card", label: "Card" },
  { value: "cash", label: "Cash" },
  { value: "eft", label: "EFT" },
] as const
export type ShishaPaymentMethod = (typeof PAYMENT_METHODS)[number]["value"]
export const DEFAULT_PAYMENT_METHOD: ShishaPaymentMethod = PAYMENT_METHODS[0].value

/** Display name for a stored payment_method. Also knows "tab" (On account), which is
 *  no longer offered but still exists on older sessions, so they keep reading correctly. */
export function paymentMethodLabel(value: string | null): string | null {
  if (!value) return null
  if (value === "tab") return "On account"
  return PAYMENT_METHODS.find((m) => m.value === value)?.label ?? value
}

/** `warning` = the action succeeded but something around it didn't (e.g. the WhatsApp
 *  message to the customer couldn't be sent). `charged` = refill amount just added to a
 *  session. `message` = a ready-made success text from the server (accepted requests). */
export type ShishaActionResult =
  | { ok: true; warning?: string; charged?: number; message?: string }
  | { ok: false; error: string }
export type ShishaActionOk = Extract<ShishaActionResult, { ok: true }>

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
  /** What a new session costs. */
  price: number
  /** What each refill costs (0 = refills are free). */
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
  /** Grand total: session price + refillTotal. */
  totalAmount: number
  /** Part of totalAmount that came from refills. */
  refillTotal: number
  /** What ONE more refill costs right now (the flavour's current refill price; 0 if free
   *  or the flavour was archived). Shown on the Refill button. */
  refillPrice: number
  refillCount: number
  paused: boolean
  /** Stored payment method value (see PAYMENT_METHODS), if already taken at the counter. */
  paymentMethod: string | null
}

export type ShishaRequestType = "order_session" | "maintenance" | "end_session" | "issue_report"

/** A pending WhatsApp request waiting for staff. */
export interface ShishaRequest {
  id: string
  requestType: ShishaRequestType
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  stationName: string | null
  flavourName: string | null
  deviceCode: string | null
  /** The amount stored when the customer asked (what they were quoted, if anything). */
  quotedAmount: number | null
  /** What accepting would charge RIGHT NOW: the flavour's current price (order_session),
   *  the current refill price (maintenance), the session total (end_session). null = n/a
   *  or the flavour/session is gone. */
  currentAmount: number | null
  sessionId: string | null
  /** maintenance / end_session: is the target session still live, and is it paused? */
  sessionLive: boolean
  sessionPaused: boolean
  /** Payment already recorded on the target session (so End doesn't ask again). */
  sessionPaymentMethod: string | null
  /** order_session only: the flavour can't be served as requested. */
  flavourIssue: "out_of_stock" | "missing" | null
  /** issue_report: the label the customer picked / typed. */
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
  /** Requests still waiting for staff, oldest first. */
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
