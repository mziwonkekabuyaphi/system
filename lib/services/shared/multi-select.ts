// lib/services/shared/multi-select.ts
/**
 * WhatsApp multi-service helpers, shared by booking.ts and queue.ts so both
 * flows read "1,3" the same way.
 *
 * The limit itself lives in the database (booking_settings.max_services_per_booking
 * / queue_settings.max_services_per_queue_entry) and is enforced again by
 * createBooking()/joinQueue(); the check here only gives the customer a
 * friendly message before they get that far.
 *
 * When the limit is 1 nothing changes: a single number picks a single service,
 * exactly as before.
 */

import type { CatalogService } from "@/lib/services/shared/services-catalog"

export type ServicePicks =
  | { ok: true; indexes: number[] }
  | { ok: false; reason: "invalid" | "too_many" }

/**
 * Reads "2", "1,3", "1 3", "1 and 3", "1 + 3", "1 & 3" (also "na"/"en", the
 * isiXhosa/Afrikaans "and"). Repeats are dropped, order is kept (the first
 * number is the primary service). Anything else is "invalid".
 */
export function parseServicePicks(rawText: string, serviceCount: number, maxServices: number): ServicePicks {
  const cleaned = rawText
    .toLowerCase()
    .replace(/\b(and|na|en)\b/g, " ")
    .replace(/[+&,;/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!/^\d+( \d+)*$/.test(cleaned)) return { ok: false, reason: "invalid" }

  const seen = new Set<number>()
  const indexes: number[] = []
  for (const token of cleaned.split(" ")) {
    const index = Number(token) - 1
    if (!Number.isInteger(index) || index < 0 || index >= serviceCount) return { ok: false, reason: "invalid" }
    if (!seen.has(index)) {
      seen.add(index)
      indexes.push(index)
    }
  }

  // More than one number while only one service is allowed reads as a
  // mistake, not as "1" — say so rather than quietly dropping the rest.
  if (indexes.length > Math.max(1, maxServices)) return { ok: false, reason: "too_many" }
  return { ok: true, indexes }
}

export function tooManyServicesMessage(maxServices: number): string {
  return maxServices <= 1
    ? "You can only choose one service. Please reply with a single number."
    : `You can choose up to ${maxServices} services. Please pick fewer and reply with the numbers again, e.g. 1,3`
}

/**
 * One catalog-shaped entry standing for the whole visit: names joined,
 * duration and price summed. Used ONLY to feed the existing single-service
 * message builders and the slot search; the id stays the primary service's,
 * and the real list is what createBooking()/joinQueue() receive.
 */
export function combineServices(services: CatalogService[]): CatalogService {
  if (services.length === 1) return services[0]
  const [first] = services
  return {
    ...first,
    name: services.map((s) => s.name).join(" + "),
    durationMinutes: services.reduce((sum, s) => sum + s.durationMinutes, 0),
    price: services.reduce((sum, s) => sum + (Number((s as { price?: number }).price) || 0), 0),
  } as CatalogService
}
