// lib/services/messages/shisha.ts
/**
 * Customer-facing copy for the Shisha Lounge WhatsApp flow (multi-tenant).
 *
 * Differences from the single-business (Rands) version:
 *   - No wallet / Passport / top-up copy. Payment is handled by staff when
 *     they approve the request, so nothing here promises a wallet deduction.
 *   - No brand name anywhere (white-label).
 *   - No FALLBACK_SESSION_PRICE: a price that can't be read is an error, not
 *     a silent R250 for a tenant that charges something else.
 *   - SHISHA_NEXT_STEPS_BUTTONS no longer offers "Order Menu" (that module
 *     doesn't exist here).
 *
 * "Location" vs "Station": `shisha_locations` is the table name, but every
 * string a customer reads calls it a "Station".
 */

/** Formats a rand amount without a redundant ".00" for whole numbers. */
export function formatRands(amount: number): string {
  return Number.isInteger(amount) ? `R${amount}` : `R${amount.toFixed(2)}`
}

export const WELCOME_MENU =
  "💨 *Shisha Lounge*\n\n" +
  "What would you like to do?\n\n" +
  "1️⃣ Start a new session (Smoke Now)\n" +
  "2️⃣ Request a coal refill\n" +
  "3️⃣ End my session\n" +
  "4️⃣ Report an issue\n" +
  "5️⃣ Track my session\n\n" +
  "Reply with a number."

export const MENU_CHOICE_INVALID =
  "I didn't catch that. Reply 1, 2, 3, 4, or 5 to choose an option, or 'menu' to see them again."

export const NO_LOCATIONS = "There aren't any shisha stations available right now. Please check our with staff."

export const NO_FLAVOURS = "There aren't any flavours available right now. Please check with our staff."

export const LOCATION_REQUEST = "Which station/Table/Location? Reply with a number."

export function invalidLocation(count: number): string {
  return `Please reply with a number between 1 and ${count}.`
}

export const FLAVOUR_REQUEST = "Which flavour would you like? Reply with a number."

export function invalidFlavour(count: number): string {
  return `Please reply with a number between 1 and ${count}.`
}

/** `station` is null when the tenant doesn't use stations (shisha_settings.require_station = false). */
export function sessionConfirmation(station: string | null, flavour: string, price: number): string {
  const stationLine = station ? `📍 Station: ${station}\n` : ""
  return `${stationLine}🍃 Flavour: ${flavour}\n💰 Price: ${formatRands(price)} (staff will confirm payment with you)`
}

export const SESSION_CONFIRM_BUTTONS = ["✅ Yes", "❌ No"]

export const SESSION_CONFIRMATION_INVALID = "Please tap ✅ Yes or ❌ No below to confirm your session."

export function sessionRequestSent(price: number): string {
  return (
    "🆕 Got it — I've sent your session request to staff. They'll set you up shortly " +
    `and confirm payment of ${formatRands(price)}.`
  )
}

export const PRICE_UNAVAILABLE =
  "I couldn't load the price for that flavour right now. Please try again in a moment, or ask a staff member."

/** Shown after a request is sent, and on any other shisha screen that would otherwise dead-end.
 *  "🏠 Main Menu" deliberately contains the word "menu" for action-router's global reset match. */
export const SHISHA_NEXT_STEPS_BUTTONS = ["📡 Track My Hookah", "🏠 Main Menu"]

export const SESSION_REQUEST_CANCELLED = "No problem, I've cancelled that. Anything else?"

export const NO_ACTIVE_SESSION =
  "You don't have an active shisha session right now, so there's nothing to update. Want to start one? Reply 'shisha'."

export const PENDING_REQUEST_EXISTS =
  "⏳ You already have a request with staff — they're on it. Please wait for that to be handled before sending another."

// ============================================================================
// SESSION TRACKING
// ============================================================================

export interface ActiveSessionSummary {
  locationName: string | null
  flavourName: string
  deviceCode: string | null
  remainingTimeSeconds: number
  refillCount: number
  status: "active" | "refill" | "paused" | "expired"
}

function formatRemainingTime(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(clamped / 60)
  const seconds = clamped % 60
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
}

const SESSION_STATUS_LABEL: Record<ActiveSessionSummary["status"], string> = {
  active: "🟢 Active",
  refill: "🔥 Refilling",
  paused: "⏸️ Paused",
  expired: "🔴 Expired",
}

export function sessionStatusMessage(session: ActiveSessionSummary): string {
  const stationLine = session.locationName ? `📍 Station: ${session.locationName}\n` : ""
  const deviceLine = session.deviceCode ? `\n🔌 Device: ${session.deviceCode}` : ""
  return (
    `💨 *Your Hookah Session*\n\n` +
    stationLine +
    `🍃 Flavour: ${session.flavourName}${deviceLine}\n` +
    `${SESSION_STATUS_LABEL[session.status]}\n` +
    `⏳ Time remaining: ${formatRemainingTime(session.remainingTimeSeconds)}\n` +
    `🔥 Refills so far: ${session.refillCount}`
  )
}

export const NO_SESSION_TO_TRACK =
  "You don't have an active shisha session to track right now. Want to start one? Reply 'shisha'."

export const COAL_REFILL_SENT = "🔥 Coal refill requested — staff have been notified and are on their way."

export const END_SESSION_SENT = "⏹️ Got it — I've asked staff to come close out your session."

export const ISSUE_TYPES = [
  { key: "iyatsarha", label: "Iyatsarha" },
  { key: "weak_smoke", label: "Weak / No Smoke" },
  { key: "hose", label: "Hose Problem" },
  { key: "water", label: "Water Needs Changing" },
  { key: "coal_cold", label: "Coal Not Hot Enough" },
  { key: "other", label: "Other" },
] as const

export function issueMenu(): string {
  const lines = ISSUE_TYPES.map((t, i) => `${i + 1}️⃣ ${t.label}`).join("\n")
  return `What's the issue? Reply with a number.\n\n${lines}`
}

export const ISSUE_SELECTION_INVALID = `Please reply with a number from the list.`

export const ISSUE_OTHER_REQUEST = "Please describe the issue in a few words."

export function issueReportSent(label: string): string {
  return `⚠️ Thanks — I've reported "${label}" to staff. Someone will be over shortly.`
}

export const TECHNICAL_DIFFICULTY =
  "Sorry, I'm having a technical issue right now. Please try again in a moment, or ask a staff member for help."

export const UNEXPECTED_ERROR = "Something went wrong on my end. Please try again, or reply 'menu' to start over."

/** Shown when the shop has switched the Shisha module off (stale menu tap, or mid-flow toggle). */
export const SHISHA_UNAVAILABLE = "Sorry, that service isn't available right now. What would you like to do instead?"
