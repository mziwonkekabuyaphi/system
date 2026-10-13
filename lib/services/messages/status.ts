// lib/services/messages/status.ts
/**
 * Customer-facing copy for Check Status. Plain functions that return
 * strings — same convention as the other files in lib/services/messages/.
 * status.ts (the service) decides WHAT to say; this file decides HOW.
 *
 * WhatsApp formatting: *bold* uses single asterisks.
 */

import { formatQueueTicketNumber, type QueueSimulationEntry } from "@/lib/services/queue"
import {
  formatLocalDateTime,
  type ActiveQueueEntry,
  type CustomerActivity,
} from "@/lib/services/shared/customer-activity"

export function statusMenuPromptMessage(): string {
  return "What would you like to do next? 👇"
}

export function statusNothingMessage(): string {
  return (
    "You don't have an upcoming booking or a place in the queue right now.\n\n" +
    "Would you like to book a time or join the queue?"
  )
}

export function statusErrorMessage(): string {
  return "Sorry, I couldn't look that up right now. Please try again in a moment."
}

function waitText(sim: QueueSimulationEntry | undefined): string {
  if (!sim) return ""
  if (sim.etaMinutes <= 0) return "you're next — any moment now"
  return `about ${sim.etaMinutes} min wait`
}

function queueLines(entry: ActiveQueueEntry, activity: CustomerActivity, sim: QueueSimulationEntry | undefined): string[] {
  if (entry.status === "called") {
    return ["📣 *You've been called!* Please head to the front now."]
  }

  const lines: string[] = []
  if (entry.ticketNumber !== null) {
    lines.push(`• Ticket: *${formatQueueTicketNumber(entry.ticketNumber, activity.ticketPrefix)}*`)
  }
  if (sim) {
    lines.push(`• Position: *${sim.position}* (${waitText(sim)})`)
  } else {
    lines.push("• You're in the queue")
  }
  return lines
}

export function statusSummaryMessage(
  activity: CustomerActivity,
  simulation: Map<string, QueueSimulationEntry> | null,
): string {
  const blocks: string[] = []

  for (const booking of activity.bookings) {
    const lines = [
      "📅 *Your booking*",
      `• Service: ${booking.serviceName ?? "Appointment"}`,
      `• When: ${formatLocalDateTime(booking.startTime, activity.timezone)}`,
      `• Reference: ${booking.reference}`,
    ]
    if (booking.queueEntry) {
      lines.push("", "🚶 *You're in the queue for it now*")
      lines.push(...queueLines(booking.queueEntry, activity, simulation?.get(booking.queueEntry.id)))
    }
    blocks.push(lines.join("\n"))
  }

  for (const entry of activity.walkIns) {
    const lines = ["🚶 *Your place in the queue*"]
    if (entry.serviceName) lines.push(`• Service: ${entry.serviceName}`)
    lines.push(...queueLines(entry, activity, simulation?.get(entry.id)))
    blocks.push(lines.join("\n"))
  }

  return blocks.join("\n\n")
}
