// lib/services/shisha-notify.ts
/**
 * Sends the customer a WhatsApp message when staff accept or reject a shisha request.
 *
 * >>> ONE THING LEFT TO WIRE <<<
 * The files this was built from don't include the app's outbound WhatsApp sender
 * (the code that resolves a tenant's WhatsApp credentials and calls the Cloud API),
 * so `deliver()` below throws until you connect it. Until then every accept/reject
 * still WORKS; staff just see the warning "couldn't send the WhatsApp message".
 * That is intentional: a missing sender must never silently look like a delivered message.
 *
 * To wire it, replace the body of `deliver()` with a call to your existing helper,
 * e.g. `await sendWhatsAppText(tenantId, phone, text)`. Keep it per-tenant: the message
 * must go out from THIS tenant's WhatsApp number, never a shared one.
 *
 * Outside the 24-hour customer-service window WhatsApp only allows approved templates.
 * Customers are replying to a request they sent minutes ago, so plain text is normally
 * fine; if a request sat unanswered for over 24h, the send can fail. That failure
 * comes back as the same staff warning and never undoes the accept/reject.
 */

async function deliver(_tenantId: string, _phone: string, _text: string): Promise<void> {
  throw new Error("Outbound WhatsApp sender not wired: see lib/services/shisha-notify.ts")
}

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
    await deliver(tenantId, phone, text)
    return null
  } catch (err) {
    console.error("[shisha] customer notification failed", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    })
    return "Done, but the WhatsApp message to the customer couldn't be sent. Let them know in person."
  }
}
