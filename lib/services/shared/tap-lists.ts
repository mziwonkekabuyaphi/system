// lib/services/shared/tap-lists.ts
/**
 * Building blocks for the tap-only booking screens (WhatsApp lists), shared by booking.ts and
 * reschedule.ts so both flows pick times in exactly the same way.
 *
 * PURE: no database access, and booking.ts is only imported as a TYPE (erased at build time), so
 * either flow can import this file without a circular import. Anything that needs the database
 * (available slots, staff) is passed in by the caller.
 *
 * Each flow uses its own row-id prefix (bk_ / rs_). A list holds 10 rows in total (WhatsApp's limit),
 * so long lists page with a "More" row; the full list always lives in the conversation state.
 */

import type { IncomingMessage } from "@/lib/whatsapp/parse-webhook"
import type { ActionResult } from "@/lib/types/action"
import type { BookingSlot } from "@/lib/services/booking"
import { buildChoiceList, type ChoiceRow, type ChoiceSection } from "@/lib/whatsapp/utils/choice-list"

/** Rows in one WhatsApp list, across all sections. */
export const LIST_ROWS = 10
/** In the "earliest times" list, at most this many per day, so the list reaches beyond today. */
const SOONEST_PER_DAY = 3

/** The number in a tapped row id ("bk_svc:2" -> 2), or null for typed text or a different tap. */
export function tappedNumber(message: IncomingMessage, prefix: string): number | null {
  const id = message.interactiveId
  if (!id || !id.startsWith(prefix)) return null
  const n = Number(id.slice(prefix.length))
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * One WhatsApp list as the whole reply. The main reply is empty on purpose: send-action-result.ts
 * skips an empty reply, so the list (with `body` as its text) goes out as ONE message.
 */
export function listReply(
  body: string,
  buttonText: string,
  sections: ChoiceSection[],
  nextState: NonNullable<ActionResult["nextState"]>,
): ActionResult {
  return { reply: "", buttons: [], nextState, followUp: [buildChoiceList(body, buttonText, sections)] }
}

/**
 * All items when they fit; otherwise one page plus a "More ▸" (or "back to the start") row.
 * `reserved` = rows the caller adds itself. `moreId` is the flow's "more" prefix (e.g. "bk_more:").
 */
export function pageRows<T>(
  items: T[],
  page: number,
  reserved: number,
  toRow: (item: T, absoluteIndex: number) => ChoiceRow,
  moreId: string,
): ChoiceRow[] {
  const capacity = LIST_ROWS - reserved
  if (items.length <= capacity) return items.map((item, i) => toRow(item, i))
  const perPage = capacity - 1
  const last = Math.ceil(items.length / perPage) - 1
  const current = Math.min(Math.max(page, 0), last)
  const start = current * perPage
  const rows = items.slice(start, start + perPage).map((item, i) => toRow(item, start + i))
  rows.push(
    current < last
      ? { id: `${moreId}${current + 1}`, title: "More ▸" }
      : { id: `${moreId}0`, title: "◂ Back to the start" },
  )
  return rows
}

export interface DayAvailability {
  date: string
  label: string
  slots: BookingSlot[]
}

export interface SoonestChoice {
  date: string
  dateLabel: string
  slot: BookingSlot
}

/**
 * Free times for each offered day, fetched in parallel by the caller's `fetchSlots`. Days with nothing
 * free are left out (so no "No open slots on that day" dead end). If EVERY day fails to load that is an
 * outage, not "nothing free", so it throws and the caller says something went wrong.
 */
export async function loadDayAvailability(
  dateOptions: Array<{ date: string; label: string }>,
  fetchSlots: (date: string) => Promise<BookingSlot[]>,
): Promise<DayAvailability[]> {
  let failures = 0
  const perDay = await Promise.all(
    dateOptions.map((d) =>
      fetchSlots(d.date).catch((error) => {
        failures += 1
        console.error("[tap-lists] Could not load slots", { date: d.date, error })
        return [] as BookingSlot[]
      }),
    ),
  )
  if (dateOptions.length > 0 && failures === dateOptions.length) throw new Error("Availability could not be loaded")

  return dateOptions
    .map((d, i) => ({
      date: d.date,
      label: d.label,
      slots: [...perDay[i]].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    }))
    .filter((d) => d.slots.length > 0)
}

/** "5 times · from 09:00", shown under a day in the day list. */
export function dayHint(day: DayAvailability): string {
  return `${day.slots.length} time${day.slots.length === 1 ? "" : "s"} · from ${day.slots[0].label}`
}

/** The earliest times, spread over the days (the first few of each day) and shown in time order. */
export function soonestChoices(days: DayAvailability[], limit: number): SoonestChoice[] {
  const all = days.flatMap((d) => d.slots.map((slot, rankInDay) => ({ date: d.date, dateLabel: d.label, slot, rankInDay })))
  const picked = new Set<number>()
  if (all.length <= limit) {
    all.forEach((_, i) => picked.add(i))
  } else {
    all.forEach((c, i) => {
      if (c.rankInDay < SOONEST_PER_DAY && picked.size < limit) picked.add(i)
    })
    // Few days: fill the rest with the earliest remaining times.
    all.forEach((_, i) => {
      if (picked.size < limit) picked.add(i)
    })
  }
  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => ({ date: all[i].date, dateLabel: all[i].dateLabel, slot: all[i].slot }))
}

/** The earliest-times rows grouped under their day. Row id = `${slotPrefix}${index into choices}`. */
export function soonestSections(choices: SoonestChoice[], slotPrefix: string): ChoiceSection[] {
  const sections: ChoiceSection[] = []
  choices.forEach((c, i) => {
    let section = sections[sections.length - 1]
    if (!section || section.title !== c.dateLabel) {
      section = { title: c.dateLabel, rows: [] }
      sections.push(section)
    }
    section.rows.push({ id: `${slotPrefix}${i}`, title: c.slot.label })
  })
  return sections
}
