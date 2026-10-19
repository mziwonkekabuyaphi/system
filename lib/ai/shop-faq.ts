// lib/ai/shop-faq.ts
/**
 * Template answers for the three most common shop questions: opening hours,
 * address and prices/services. Pure functions, no I/O, no AI.
 * ---------------------------------------------------------------------------
 * Why: these answers are already structured in the shop's own data
 * (lib/ai/shop-context.ts), so paying a model to turn a table into a sentence
 * is waste. Used in two places:
 *   - intent-router.ts: a matching message is classified "support" without a
 *     classifier call.
 *   - concierge.ts: tried BEFORE the model; the model is only used when this
 *     returns null.
 *
 * Deliberately conservative: English only, short messages, a single topic,
 * and nothing about the customer's own booking/queue. Anything else (other
 * languages, combined questions, "is there space", complaints) returns null
 * and goes to the model exactly as before. If the shop's data is missing the
 * answer, buildFaqAnswer returns null too, so the model can say so.
 */

import type { ShopContext } from "@/lib/ai/shop-context"

export type ShopFaqKind = "hours" | "address" | "prices"

const MAX_WORDS = 10
const MAX_PRICE_LINES = 15

/** Anything about the customer's own booking/queue, or a complaint: not a plain FAQ. */
const NOT_A_FAQ =
  /\b(book|booking|booked|appointment|reserve|reservation|cancel|reschedul\w*|change|move|late|complain\w*|problem|issue|refund|my|queue|wait|waiting|line|staff|barber|stylist|space|busy|available|slot)\b/

const HOURS_PATTERNS: RegExp[] = [
  /\b(what time|what times|when)\b.*\b(open|close|opening|closing)\b/,
  /\b(opening|closing|business|trading|working|shop|salon) (hours|times)\b/,
  /\bhours\b/,
  /\b(are|r) (you|u) (open|closed)\b/,
  /\b(do|will) (you|u) (open|close)\b/,
  /\b(open|closed) (today|now|tomorrow|tonight|on)\b/,
]

const ADDRESS_PATTERNS: RegExp[] = [
  /\b(address|location|located|directions?)\b/,
  /\bwhere (are|r) (you|u)\b/,
  /\bwhere is (the|your) (shop|salon|place|barbershop|barber shop)\b/,
  /\b(find|get to) (you|u|the shop|the salon)\b/,
]

const PRICE_PATTERNS: RegExp[] = [
  /\b(prices?|pricing|price list|rates?|how much|costs?|charge|charges)\b/,
  /\bwhat services\b/,
  /\bservices (do )?(you )?(offer|have|provide)\b/,
  /\bwhat (do|can) (you|u) (offer|do)\b/,
]

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const
const WEEKDAY_SHORT: Record<string, (typeof WEEKDAYS)[number]> = {
  sun: "sunday", mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday",
  thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", sat: "saturday",
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Which FAQ (if any) is this message? null when it isn't a clean, single-topic,
 * English FAQ, so the caller falls back to the model.
 */
export function detectShopFaq(text: string): ShopFaqKind | null {
  const t = normalize(text)
  if (!t) return null
  if (t.split(" ").length > MAX_WORDS) return null
  if (NOT_A_FAQ.test(t)) return null

  const kinds: ShopFaqKind[] = []
  if (HOURS_PATTERNS.some((p) => p.test(t))) kinds.push("hours")
  if (ADDRESS_PATTERNS.some((p) => p.test(t))) kinds.push("address")
  if (PRICE_PATTERNS.some((p) => p.test(t))) kinds.push("prices")

  return kinds.length === 1 ? kinds[0] : null
}

function titleCase(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1)
}

function money(currency: string | undefined, price: number): string {
  const amount = Number.isInteger(price) ? String(price) : price.toFixed(2)
  if (!currency || currency.toUpperCase() === "ZAR" || currency === "R") return `R${amount}`
  return `${currency} ${amount}`
}

/** Which weekday (lowercase) is the customer asking about, if any. */
function askedWeekday(t: string, context: ShopContext): string | null {
  for (const day of WEEKDAYS) if (new RegExp(`\\b${day}\\b`).test(t)) return day
  for (const [short, day] of Object.entries(WEEKDAY_SHORT)) if (new RegExp(`\\b${short}\\b`).test(t)) return day

  const today = context.now?.weekday?.toLowerCase()
  if (/\b(today|now|tonight)\b/.test(t)) return today && (WEEKDAYS as readonly string[]).includes(today) ? today : null
  if (/\btomorrow\b/.test(t) && today) {
    const index = (WEEKDAYS as readonly string[]).indexOf(today)
    return index >= 0 ? WEEKDAYS[(index + 1) % 7] : null
  }
  return null
}

function hoursAnswer(t: string, context: ShopContext): string | null {
  const rows = context.openingHours
  if (!rows || rows.length === 0) return null

  const day = askedWeekday(t, context)
  if (day) {
    const row = rows.find((r) => r.day.toLowerCase() === day)
    if (!row) return null
    const name = titleCase(day)
    const isToday = context.now?.weekday?.toLowerCase() === day
    if (row.hours === "Closed") return `We're *closed* on ${name}.`
    const nowNote = isToday && /\b(now|tonight)\b/.test(t) && context.now?.time ? ` (it's ${context.now.time} right now)` : ""
    return `On ${name} we're open *${row.hours}*${nowNote}.`
  }

  return `⏰ Our opening hours:\n${rows.map((r) => `${r.day}: *${r.hours}*`).join("\n")}`
}

function addressAnswer(context: ShopContext): string | null {
  const address = context.shop?.address
  if (!address) return null
  const phone = context.shop?.phone
  return `📍 You can find us at *${address}*.${phone ? `\nCall us on ${phone}.` : ""}`
}

function pricesAnswer(t: string, context: ShopContext): string | null {
  const services = context.services
  if (!services || services.length === 0) return null

  const line = (s: (typeof services)[number]) =>
    `${s.name}: *${money(context.currency, s.price)}*${s.durationMinutes > 0 ? ` (${s.durationMinutes} min)` : ""}`

  // "how much is a haircut" -> just that service (service name appears in the question).
  const named = services.filter((s) => s.name.trim().length >= 3 && t.includes(normalize(s.name)))
  if (named.length > 0 && named.length <= 3) return named.map(line).join("\n")

  const shown = services.slice(0, MAX_PRICE_LINES)
  const extra = services.length - shown.length
  return `💈 Our services and prices:\n${shown.map((s) => `• ${line(s)}`).join("\n")}${extra > 0 ? `\n…and ${extra} more.` : ""}`
}

/**
 * Builds the customer-ready answer from the shop's data, or null when the
 * data doesn't contain it (the caller then lets the model say so / hand off).
 */
export function buildFaqAnswer(kind: ShopFaqKind, text: string, context: ShopContext): string | null {
  const t = normalize(text)
  switch (kind) {
    case "hours":
      return hoursAnswer(t, context)
    case "address":
      return addressAnswer(context)
    case "prices":
      return pricesAnswer(t, context)
    default:
      return null
  }
}
