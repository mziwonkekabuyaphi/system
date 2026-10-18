// lib/services/messages/no-service.ts
/**
 * Customer-facing copy for shops that turned "require a service" OFF
 * (queue_settings.require_service_selection / booking_settings.require_service_selection).
 * In that mode the WhatsApp flows skip the numbered services list entirely, so
 * these replace the messages that would normally name the chosen service.
 */

/** What a no-service booking is called wherever a service name is expected
 *  (booking reference text, ticket image, the Today list shows "No service"). */
export const NO_SERVICE_LABEL = "Appointment"

/** Placeholder id for the one-line "service" kept in conversation state while a
 *  no-service booking is in progress. Never written to the database. */
export const NO_SERVICE_ID = "no-service"

export function joinedQueueNoServiceMessage(position: number, etaMinutes: number): string {
  const ahead = Math.max(0, position - 1)
  const lines = [
    "You're in the queue ✅",
    "",
    `*Your position:* ${position}${ahead === 0 ? " (you're next)" : ` (${ahead} ahead of you)`}`,
    `*Estimated wait:* about ${etaMinutes} min`,
    "",
    "We'll message you when it's nearly your turn.",
  ]
  return lines.join("\n")
}

export function noServiceConfirmationMessage(dateLabel: string, slotLabel: string): string {
  return ["Just to confirm ✅", "", `*When:* ${dateLabel} at ${slotLabel}`, "", "Reply *yes* to confirm, or *no* to cancel."].join(
    "\n",
  )
}
