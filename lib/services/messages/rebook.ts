// lib/services/messages/rebook.ts
/**
 * Customer-facing copy for the "Same again?" one-tap rebook. Same convention as
 * messages/booking.ts: wording lives here, state transitions live in booking.ts.
 */

import type { ActionResult } from "@/lib/types/action"

/** Ids booking.ts matches a button tap against (it falls back to the typed/title text). */
export const REBOOK_BUTTON_IDS = {
  yes: "rebook_yes",
  other: "rebook_other",
  menu: "rebook_menu",
} as const

// WhatsApp reply buttons: max 3, titles max 20 characters.
// NOTE: written as { id, title }. If your buttons in messages/booking.ts use a different
// shape, adjust it here: it is the only place this feature builds one.
export const REBOOK_BUTTONS: NonNullable<ActionResult["buttons"]> = [
  { id: REBOOK_BUTTON_IDS.yes, title: "✅ Yes, book it" },
  { id: REBOOK_BUTTON_IDS.other, title: "🕒 Other time" },
  { id: REBOOK_BUTTON_IDS.menu, title: "↩️ Something else" },
]

export function sameAgainOfferMessage(args: {
  customerName: string | null
  serviceName: string
  dateLabel: string
  slotLabel: string
  staffName?: string
}): string {
  const greeting = args.customerName ? `Welcome back, ${args.customerName}! 👋` : "Welcome back! 👋"
  const lines = [
    greeting,
    "",
    "Same again?",
    `✂️ *${args.serviceName}*`,
    `📅 ${args.dateLabel} at ${args.slotLabel}`,
  ]
  if (args.staffName) lines.push(`👤 With ${args.staffName}`)
  lines.push("", "Tap *Yes, book it* and you're done.")
  return lines.join("\n")
}

export function sameAgainReminderMessage(): string {
  return "Please tap one of the buttons: *Yes, book it*, *Other time* or *Something else*."
}
