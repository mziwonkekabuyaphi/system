// lib/whatsapp/send-action-result.ts
/**
 * Delivers an ActionResult to the customer on WhatsApp, IN ORDER:
 *   1. the main `reply` (reply-buttons if `buttons` is set, else plain text)
 *   2. each `media` image
 *   3. each `followUp` message (image, interactive list, reply buttons, or text)
 *
 * Sends are sequential on purpose: WhatsApp delivers in the order the API
 * calls complete, so awaiting each one keeps the greeting above the menu and
 * the confirmation above the ticket. Empty messages are skipped quietly,
 * never sent (Meta rejects a blank text body).
 *
 * Failure policy:
 *   - main reply fails  -> the error is thrown to the caller
 *   - a media fails     -> logged, the remaining media/follow-ups still go out
 *   - a follow-up fails -> logged, the remaining follow-ups are skipped
 *
 * `onSent` is called with a text summary after each successful send so the
 * caller can persist outbound messages (the webhook uses it for
 * storeOutboundMessage). A failing onSent is logged, never thrown.
 *
 * It takes a plain structural type (not ActionResult) so it works for any
 * caller that has these fields.
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
  media?: { url: string; caption?: string }[]
  followUp?: FollowUpMessage[]
}

export interface SendActionResultOptions {
  onSent?: (summary: string) => Promise<void>
}

/** Sends one message. Returns a text summary for storage, or null if nothing was sendable. */
async function sendOne(
  tenantId: string,
  to: string,
  message: { reply: string; buttons?: string[]; list?: FollowUpMessage["list"]; image?: FollowUpMessage["image"] },
): Promise<string | null> {
  const body = message.reply?.trim()

  // An image (e.g. the booking ticket) goes out with `reply` as its caption.
  if (message.image?.url) {
    await sendWhatsAppImageMessage(tenantId, to, message.image.url, body || undefined)
    return body || "[Image]"
  }

  if (message.list && message.list.sections.some((s) => s.rows.length > 0)) {
    const text = body || "Please choose an option:"
    await sendWhatsAppListMessage(tenantId, to, text, message.list.buttonText, message.list.sections)
    return text
  }

  if (!body) return null

  if (message.buttons && message.buttons.length > 0) {
    await sendWhatsAppButtonsMessage(tenantId, to, body, message.buttons)
    return body
  }

  await sendWhatsAppTextMessage(tenantId, to, body)
  return body
}

export async function sendActionResult(
  tenantId: string,
  to: string,
  result: SendableResult,
  options: SendActionResultOptions = {},
): Promise<void> {
  const record = async (summary: string | null): Promise<void> => {
    if (!summary || !options.onSent) return
    try {
      await options.onSent(summary)
    } catch (error) {
      console.error("[send-action-result] onSent callback failed", {
        tenantId,
        error: error instanceof Error ? error.message : error,
      })
    }
  }

  // 1. Main reply: errors propagate so the caller's catch sees them.
  await record(await sendOne(tenantId, to, { reply: result.reply, buttons: result.buttons }))

  // 2. Media
  for (const media of result.media ?? []) {
    try {
      await sendWhatsAppImageMessage(tenantId, to, media.url, media.caption)
      await record(media.caption?.trim() || "[Image]")
    } catch (error) {
      console.error("[send-action-result] Media message failed", {
        tenantId,
        to,
        mediaUrl: media.url,
        error: error instanceof Error ? error.message : error,
      })
    }
  }

  // 3. Follow-ups
  for (const followUp of result.followUp ?? []) {
    try {
      await record(await sendOne(tenantId, to, followUp))
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
