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

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "eft", label: "EFT" },
  { value: "tab", label: "On account" },
] as const
export type ShishaPaymentMethod = (typeof PAYMENT_METHODS)[number]["value"]

export type ShishaActionResult = { ok: true } | { ok: false; error: string }

export interface ShishaSettings {
  coalDurationMinutes: number
  refillThresholdMinutes: number
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
  settings: ShishaSettings
  /** ISO 4217 code from tenant_settings.currency */
  currency: string
  stations: ShishaStation[]
  flavours: ShishaFlavour[]
  devices: ShishaDevice[]
  /** Live sessions only (active / refill / paused). */
  sessions: ShishaSession[]
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
