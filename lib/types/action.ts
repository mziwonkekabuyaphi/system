// lib/types/action.ts
/**
 * Result of handling one inbound WhatsApp message: what to say back, and
 * what conversation state to persist next.
 *
 * Delivery order (see lib/whatsapp/send-action-result.ts):
 *   reply (+ buttons) -> media[] -> followUp[]
 */

import type { ConversationState } from "@/lib/services/state"
import type { FollowUpMessage } from "@/lib/types/follow-up"

export interface ActionResult {
  /** Main reply text. */
  reply: string
  /** Up to 3 reply buttons attached to the main reply. */
  buttons: string[]
  /** State to persist; null clears the conversation state. */
  nextState: ConversationState | null
  /**
   * True for a genuine "we don't know what to do" reply. handover.ts's
   * shouldEscalate() reads this flag instead of raw intent confidence.
   */
  unhandled?: boolean
  /** Extra messages sent after the main reply (menu list, ticket image, etc). */
  followUp?: FollowUpMessage[]
  /** Images sent after the main reply, before follow-ups. */
  media?: { url: string; caption?: string }[]
}

/**
 * The ok/fail union that used to be called ActionResult, renamed so it no
 * longer collides with the WhatsApp reply shape above. Only for service
 * functions that return success/failure.
 */
export type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string }
export type ResultSuccess<T = void> = { ok: true; data?: T }
export type ResultFailure = { ok: false; error: string }

export function ok<T = void>(data?: T): Result<T> {
  return { ok: true, data }
}

export function fail(error: string): Result<never> {
  return { ok: false, error }
}
