// lib/services/shared/staff-request.ts
/**
 * Customer staff requests ("book with Sipho") — pure helpers, no I/O.
 *
 * Kept free of database and WhatsApp imports so the two rules that matter can be
 * unit tested on their own:
 *
 *   1. matchStaffRequest(): which staff member, if any, a typed message names.
 *      Never guesses between two people: two matches is "ambiguous", and the
 *      customer is asked to be specific. Inactive staff are only looked at when
 *      no ACTIVE staff member matches, so the customer can be told "Sipho isn't
 *      taking bookings" instead of being quietly given someone else.
 *
 *   2. pickStaffForSlot(): who gets the booking. When a staff member was
 *      REQUIRED (customer's choice) there is no fallback: if that person isn't
 *      free the result is a failure, never "the next free person". The
 *      reschedule flow's softer `preferStaffId` (keep the same barber if
 *      possible, otherwise anyone) is preserved exactly as it was.
 */

export interface StaffCandidate {
  id: string
  name: string
  active: boolean
}

export type StaffRequestMatch =
  | { kind: "none" }
  | { kind: "match"; staff: StaffCandidate }
  | { kind: "inactive"; staff: StaffCandidate }
  | { kind: "ambiguous"; names: string[] }

/** Lowercase, accents removed, everything that isn't a letter/number becomes one space. */
export function normalizeForMatch(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

// isiZulu / isiXhosa attach "with" to the name: noSipho, naSipho, kuSipho, kwaSipho, ngoSipho.
// Accepted only directly in front of a whole staff name, so ordinary words are not affected.
const NGUNI_WITH_PREFIXES = ["no", "na", "ku", "kwa", "ngo", "nga"]

function containsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false
  const padded = ` ${haystack} `
  if (padded.includes(` ${needle} `)) return true
  return NGUNI_WITH_PREFIXES.some((prefix) => padded.includes(` ${prefix}${needle} `))
}

type Resolution<T> = { kind: "none" } | { kind: "one"; staff: T } | { kind: "many"; staff: T[] }

function resolveAmong<T extends { name: string }>(text: string, pool: T[]): Resolution<T> {
  const normalizedText = normalizeForMatch(text)

  const named = pool
    .map((member) => {
      const full = normalizeForMatch(member.name)
      const first = full.split(" ")[0] ?? ""
      return { member, full, first }
    })
    .filter((entry) => entry.full.length > 0)

  // Full-name hits win; when several full names hit ("Sipho" and "Sipho M" both
  // appear in "sipho m"), the longest, most specific one is the one meant.
  const fullHits = named.filter((entry) => containsWord(normalizedText, entry.full))
  if (fullHits.length > 0) {
    const longest = Math.max(...fullHits.map((entry) => entry.full.length))
    const best = fullHits.filter((entry) => entry.full.length === longest)
    return best.length === 1 ? { kind: "one", staff: best[0].member } : { kind: "many", staff: best.map((e) => e.member) }
  }

  // First-name only. Too-short tokens ("al", "jo") are skipped: they collide with ordinary words.
  const firstHits = named.filter((entry) => entry.first.length >= 3 && containsWord(normalizedText, entry.first))
  if (firstHits.length === 0) return { kind: "none" }
  return firstHits.length === 1
    ? { kind: "one", staff: firstHits[0].member }
    : { kind: "many", staff: firstHits.map((e) => e.member) }
}

export function matchStaffRequest(text: string, staff: StaffCandidate[]): StaffRequestMatch {
  const active = resolveAmong(
    text,
    staff.filter((member) => member.active),
  )
  if (active.kind === "one") return { kind: "match", staff: active.staff }
  if (active.kind === "many") return { kind: "ambiguous", names: active.staff.map((member) => member.name) }

  const inactive = resolveAmong(
    text,
    staff.filter((member) => !member.active),
  )
  if (inactive.kind === "one") return { kind: "inactive", staff: inactive.staff }
  if (inactive.kind === "many") return { kind: "inactive", staff: inactive.staff[0] }
  return { kind: "none" }
}

export type StaffPick<T> = { ok: true; staff: T } | { ok: false; reason: "requested_unavailable" | "none_free" }

export function pickStaffForSlot<T extends { id: string }>(options: {
  /** The tenant's ACTIVE staff only. */
  staff: T[]
  isFree: (member: T) => boolean
  /** Reschedule: keep this person if free, otherwise anyone free. */
  preferStaffId?: string
  /** Customer's choice: this person or nobody. Takes priority over preferStaffId. */
  requireStaffId?: string
}): StaffPick<T> {
  const { staff, isFree, preferStaffId, requireStaffId } = options

  if (requireStaffId) {
    const requested = staff.find((member) => member.id === requireStaffId)
    return requested && isFree(requested) ? { ok: true, staff: requested } : { ok: false, reason: "requested_unavailable" }
  }

  const preferred = preferStaffId ? staff.find((member) => member.id === preferStaffId && isFree(member)) : undefined
  const chosen = preferred ?? staff.find(isFree)
  return chosen ? { ok: true, staff: chosen } : { ok: false, reason: "none_free" }
}
