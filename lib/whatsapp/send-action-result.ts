// lib/whatsapp/send-action-result.ts
/**
 * Delivers an ActionResult to the customer on WhatsApp, IN ORDER:
 *   1. the main `reply` (as reply-buttons if `buttons` is set, else plain text)
 *   2. each `followUp` message, in array order (an interactive list, reply
 *      buttons, or plain text)
 *
 * This is the piece that makes "greeting, then menu" work: without something
 * like this, `followUp` messages are silently dropped. The webhook route
 * (app/api/whatsapp/webhook/route.ts or wherever messages are sent after
 * processIncomingMessage()) should call this instead of sending only
 * `result.reply` itself.
 *
 * It takes a plain structural type (not ActionResult) so it works whether or
 * not lib/types/action.ts has been updated yet.
 *
 * Sends are sequential on purpose — WhatsApp delivers messages in the order
 * the API calls complete, so awaiting each one keeps the greeting above the
 * menu. If a follow-up fails, the error is logged and the remaining
 * follow-ups are skipped, but the main reply (already sent) is not undone.
 */

import {
  sendWhatsAppButtonsMessage,
  sendWhatsAppImageMessage,
  sendWhatsAppListMessage,
  sendWhatsAppTextMessage,
} from "@/lib/whatsapp/send-message"
import type { FollowUpMessage } from "@/lib/types/follow-up"

export interface SendableResult {
  reply: string
  buttons?: string[]
  followUp?: FollowUpMessage[]
}

async function sendOne(
  tenantId: string,
  to: string,
  message: { reply: string; buttons?: string[]; list?: FollowUpMessage["list"]; image?: FollowUpMessage["image"] },
): Promise<void> {
  const body = message.reply?.trim()

  // An image (e.g. the booking ticket) goes out with `reply` as its caption.
  if (message.image?.url) {
    await sendWhatsAppImageMessage(tenantId, to, message.image.url, body || undefined)
    return
  }

  if (message.list && message.list.sections.some((s) => s.rows.length > 0)) {
    await sendWhatsAppListMessage(tenantId, to, body || "Please choose an option:", message.list.buttonText, message.list.sections)
    return
  }

  if (!body) return

  if (message.buttons && message.buttons.length > 0) {
    await sendWhatsAppButtonsMessage(tenantId, to, body, message.buttons)
    return
  }

  await sendWhatsAppTextMessage(tenantId, to, body)
}

export async function sendActionResult(tenantId: string, to: string, result: SendableResult): Promise<void> {
  await sendOne(tenantId, to, { reply: result.reply, buttons: result.buttons })

  for (const followUp of result.followUp ?? []) {
    try {
      await sendOne(tenantId, to, followUp)
    } catch (error) {
      console.error("[send-action-result] Follow-up message failed", {
        tenantId,
        to,
        error: error instanceof Error ? error.message : error,
      })
      return
    }
  }
}
