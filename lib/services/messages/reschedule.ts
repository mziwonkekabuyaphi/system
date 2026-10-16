// lib/services/messages/reschedule.ts
/**
 * Customer-facing copy for the "move my booking" flow (lib/services/reschedule.ts).
 * Same convention as messages/booking.ts and messages/cancel.ts: wording lives
 * here, the service only owns state and data. WhatsApp formatting (*bold*).
 */

import { CANCEL_NOW_BUTTON } from "@/lib/services/messages/booking"

/**
 * The buttons shown under "you're booked": the existing Cancel Now button, with
 * Reschedule next to it. Buttons are plain strings (sendWhatsAppButtonsMessage
 * takes string[] and assigns its own ids, btn_1, btn_2, ...), so a tap arrives
 * as the button's TITLE, e.g. "[button reply] 🔁 Reschedule". intent-router.ts
 * must map that to the reschedule intent, the same way it already does for
 * "❌ Cancel Now". (Button titles are limited to 20 characters by WhatsApp.)
 */
export const RESCHEDULE_BUTTON = ["🔁 Reschedule"]

export const CANCEL_OR_RESCHEDULE_BUTTONS = [...CANCEL_NOW_BUTTON, ...RESCHEDULE_BUTTON]

export interface RescheduleOption {
  id: string
  /** Ready-to-show line, e.g. "📅 Fade + Beard — Tue 14 Oct, 10:30 (Ref ABC123)". */
  label: string
}

/** 90 -> "1 hour 30 minutes", 45 -> "45 minutes", 1440 -> "24 hours". */
export function formatLeadTime(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`
  const h = Math.floor(m / 60)
  const rest = m % 60
  const hours = `${h} hour${h === 1 ? "" : "s"}`
  return rest === 0 ? hours : `${hours} ${rest} minute${rest === 1 ? "" : "s"}`
}

export function rescheduleNothingMessage(): string {
  return "I couldn't find an upcoming booking to move. You can book a new appointment from the menu below 👇"
}

export function rescheduleChooseMessage(options: RescheduleOption[]): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")
  return `Which booking would you like to move?\n\n${lines}\n\nReply with a number.`
}

export function rescheduleInvalidChoiceMessage(count: number): string {
  return `Please reply with a number between 1 and ${count}.`
}

/** Shown above the date list. */
export function rescheduleStartMessage(serviceName: string, currentLabel: string): string {
  return `Let's move your *${serviceName}* (now ${currentLabel}). Your current time stays booked until you confirm the new one.`
}

export function rescheduleConfirmMessage(args: {
  serviceName: string
  currentLabel: string
  newDateLabel: string
  slotLabel: string
}): string {
  return (
    `Move your *${args.serviceName}*?\n\n` +
    `From: ${args.currentLabel}\n` +
    `To: *${args.newDateLabel} at ${args.slotLabel}*\n\n` +
    `Reply *Yes* to confirm or *No* to keep your current time.`
  )
}

export function rescheduleDoneMessage(args: {
  serviceName: string
  newDateLabel: string
  slotLabel: string
  bookingReference: string
}): string {
  return (
    `✅ Done! Your *${args.serviceName}* is now on *${args.newDateLabel} at ${args.slotLabel}*.\n` +
    `Booking reference: ${args.bookingReference}\n\nSee you then!`
  )
}

export function rescheduleKeptMessage(): string {
  return "No problem — your booking stays exactly as it was."
}

export function rescheduleUnchangedMessage(): string {
  return "That's the time you already have, so nothing has changed. Type *reschedule* if you'd like to pick another."
}

export function rescheduleConfirmReminderMessage(): string {
  return "Please reply *Yes* to move your booking, or *No* to keep your current time."
}

export function rescheduleTooLateMessage(windowMinutes: number): string {
  const rule =
    windowMinutes > 0
      ? `Bookings can only be moved up to ${formatLeadTime(windowMinutes)} before they start`
      : "That booking has already started, so it can't be moved here"
  return `Sorry, it's too late to move this booking. ${rule}. Please contact the shop directly and they'll help.`
}

export function rescheduleInQueueMessage(): string {
  return "Your appointment is already in today's queue (or you're being served), so I can't move it from here. Please speak to someone at the shop."
}

export function rescheduleSlotTakenMessage(): string {
  return "Sorry, that time was just taken. Your original booking is unchanged — type *reschedule* to pick another time."
}

export function rescheduleWindowClosedMessage(): string {
  return "Sorry, that time can no longer be booked. Your original booking is unchanged — type *reschedule* to pick another time."
}

export function rescheduleAlreadyGoneMessage(): string {
  return "I couldn't find that booking any more — it may have been moved or cancelled already."
}

export function rescheduleErrorMessage(): string {
  return "Sorry, something went wrong and your booking was not changed. Please try again in a moment."
}

export function rescheduleMenuPromptMessage(): string {
  return "Is there anything else I can help with? 👇"
}
