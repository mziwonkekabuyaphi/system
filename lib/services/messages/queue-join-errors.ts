// lib/services/messages/queue-join-errors.ts
/**
 * Friendly replies for the three ways the database refuses a walk-in queue
 * join (triggers on queue_entries):
 *   - enforce_walkin_business_hours -> 'Cannot join the queue: this business is currently closed'
 *   - block_duplicate_queue_entry   -> 'You are already in the queue'
 *                                      'You already have an upcoming booking'
 * queue.ts matches on those error messages and uses these instead of its
 * generic "something went wrong" reply.
 */

export function queueShopClosedMessage(): string {
  return (
    "Sorry, we're closed right now, so the walk-in queue isn't open.\n\n" +
    "You can still book an appointment for a time when we're open — tap *Book Now* in the menu."
  )
}

export function queueAlreadyInQueueMessage(): string {
  return "You're already in the queue. 👍 Tap *Check Status* in the menu to see your position, or *Cancel Now* if you'd like to leave the queue."
}

export function queueHasUpcomingBookingMessage(): string {
  return "You already have an upcoming booking, so you don't need to join the queue. Tap *Check Status* in the menu to see it, or *Cancel Now* if you'd like to cancel it first."
}
