// lib/services/messages/rebook.ts
/**
 * Customer-facing copy for the "Same again?" one-tap rebook. Same convention as
 * messages/booking.ts: wording lives here, state transitions live in booking.ts.
 */

// WhatsApp reply buttons are plain titles (send-message.ts numbers the ids itself,
// btn_1..btn_3, and a tap arrives in booking.ts as its title text). Max 3 buttons,
// titles are cut at 20 characters, so keep them short. booking.ts's readRebookChoice()
// matches on the words "book it", "other" and "else": keep those if you reword.
export const REBOOK_BUTTONS: string[] = ["✅ Yes, book it", "🕒 Other time", "↩️ Something else"]

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
