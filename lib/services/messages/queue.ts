// lib/services/messages/queue.ts
/**
 * Customer-facing copy for the walk-in queue flow.
 * ---------------------------------------------------
 * Split out of queue.ts so message copy can be edited without touching
 * queue logic — same convention as messages/booking.ts and
 * messages/registration.ts. queue.ts imports everything it needs from
 * here; nothing in this file talks to Supabase or holds any state.
 */

import type { CatalogService } from "@/lib/services/shared/services-catalog"

export function servicesListMessage(services: CatalogService[]): string {
  const lines = services.map((s, i) => `${i + 1}. *${s.name}* — R${s.price} (${s.durationMinutes} min)`)
  return `What are you here for? 🚶\n\n${lines.join("\n")}\n\nReply with a number to join the queue.`
}

export function noServicesMessage(): string {
  return "We don't have any services set up right now — please check back shortly, or reply *support* for help."
}

export function invalidSelectionMessage(max: number): string {
  return `Please reply with a number between 1 and ${max}.`
}

export function joinedQueueMessage(service: CatalogService, position: number, etaMinutes: number): string {
  const etaLine = position === 1 ? "You're next!" : `Estimated wait: about ${etaMinutes} min`
  return (
    `You're in the queue for *${service.name}* 🚶\n\n` +
    `*Position:* ${position}\n` +
    `${etaLine}\n\n` +
    `We'll message you the moment we're ready for you. Reply *menu* any time to see other options.`
  )
}

export function queueErrorMessage(): string {
  return "Sorry, something went wrong joining the queue. Please try again, or reply *support* for help."
}
