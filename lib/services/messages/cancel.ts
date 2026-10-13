// lib/services/messages/cancel.ts
/**
 * Customer-facing copy for Cancel Now. Plain functions returning strings,
 * same convention as the rest of lib/services/messages/. cancel.ts (the
 * service) owns the logic; this file owns the wording.
 */

export const CANCEL_CONFIRM_BUTTONS = ["Yes, cancel it", "No, keep it"]

export interface CancelOptionLabel {
  label: string
}

export function cancelMenuPromptMessage(): string {
  return "Is there anything else I can help you with? 👇"
}

export function cancelNothingMessage(): string {
  return (
    "You don't have an upcoming booking or a place in the queue to cancel.\n\n" +
    "Would you like to book a time or join the queue?"
  )
}

export function cancelAlreadyCalledMessage(): string {
  return (
    "You've already been called, so I can't cancel from here. " +
    "Please speak to the team at the front and they'll sort it out."
  )
}

export function cancelChooseMessage(options: CancelOptionLabel[]): string {
  const lines = options.map((option, index) => `${index + 1}. ${option.label}`)
  return `You have more than one thing I can cancel. Which one would you like to cancel?\n\n${lines.join("\n")}\n\nReply with the number.`
}

export function cancelInvalidChoiceMessage(count: number): string {
  return `Please reply with a number from 1 to ${count}, or type *menu* to go back.`
}

export function cancelConfirmMessage(option: CancelOptionLabel): string {
  return `Are you sure you want to cancel this?\n\n${option.label}\n\nTap *Yes, cancel it* or *No, keep it*.`
}

export function cancelConfirmReminderMessage(): string {
  return "Please tap *Yes, cancel it* or *No, keep it* (or reply yes / no)."
}

/** "30 minutes", "1 hour", "2 hours", "1 hour 30 minutes". */
export function formatCancellationWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourText = `${hours} hour${hours === 1 ? "" : "s"}`
  return rest === 0 ? hourText : `${hourText} ${rest} minute${rest === 1 ? "" : "s"}`
}

export function cancelTooLateMessage(windowMinutes: number): string {
  if (windowMinutes <= 0) {
    return (
      "Sorry, this booking has already started, so I can't cancel it here. " +
      "Please contact the shop directly."
    )
  }
  return (
    `Sorry, I can't cancel this one — bookings can only be cancelled at least ${formatCancellationWindow(windowMinutes)} before they start. ` +
    "Please contact the shop directly and they'll help you."
  )
}

export function cancelledBookingMessage(label: string): string {
  return `✅ Done — your booking has been cancelled.\n\n${label}\n\nWe hope to see you another time!`
}

export function cancelledQueueMessage(): string {
  return "✅ Done — you've been removed from the queue. You can join again any time while we're open."
}

export function cancelKeptMessage(): string {
  return "No problem — nothing has been cancelled. 👍"
}

export function cancelAlreadyGoneMessage(): string {
  return "It looks like that was already cancelled or completed, so there's nothing left to cancel."
}

export function cancelErrorMessage(): string {
  return "Sorry, something went wrong and I couldn't cancel that. Please try again in a moment, or contact the shop directly."
}
