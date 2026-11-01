// lib/services/shisha-notify.ts
/**
 * Sends the customer a WhatsApp message when staff accept or reject a shisha request
 * (session started, refill accepted, session ended, issue received, or rejected).
 *
 * It sends through the tenant's OWN WhatsApp number (the same sender the rest of the
 * app uses for replies), never a shared one.
 *
 * Outside the 24-hour customer-service window WhatsApp only allows approved templates.
 * Customers are replying to a request they sent minutes ago, so plain text is normally
 * fine; if a request sat unanswered for over 24h, the send can fail. That failure comes
 * back as a staff warning and never undoes the accept/reject.
 */

import { sendWhatsAppTextMessage } from "@/lib/whatsapp/send-message"

/**
 * Best-effort customer notification. Never throws. Returns a staff-facing warning
 * string if the customer could not be told, or null when the message went out.
 */
export async function notifyShishaCustomer(
  tenantId: string,
  phone: string | null,
  text: string,
): Promise<string | null> {
  if (!phone) return "Done, but this customer has no phone number on file, so they weren't messaged."
  try {
    await sendWhatsAppTextMessage(tenantId, phone, text)
    return null
  } catch (err) {
    console.error("[shisha] customer notification failed", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    })
    return "Done, but the WhatsApp message to the customer couldn't be sent. Let them know in person."
  }
}
