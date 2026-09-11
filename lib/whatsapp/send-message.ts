// lib/whatsapp/send-message.ts
/**
 * Sends outbound messages via the WhatsApp Cloud API (Meta Graph API).
 * This is the only place in the codebase that talks to Meta's send-message
 * endpoint — the webhook route calls this after buildReply() decides what
 * to say.
 */

const GRAPH_API_VERSION = "v21.0"

function getAccessToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim()
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN environment variable is required")
  return token
}

function getPhoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()
  if (!id) throw new Error("WHATSAPP_PHONE_NUMBER_ID environment variable is required")
  return id
}

/**
 * Normalizes a phone number to the E.164-without-"+" format the WhatsApp
 * Cloud API requires (e.g. "27672903141"), regardless of how it was typed
 * or stored upstream.
 *
 * This is a defensive last line, not a replacement for validating/
 * normalizing input where it's first captured (e.g. the ticket-delivery
 * flow) — it exists here because this file is the one place ALL outbound
 * sends funnel through, so fixing it here guarantees every send gets a
 * correctly-formatted number no matter which caller or code path it came
 * from, current or future.
 *
 * KNOWN LIMITATION: only handles South African numbers specifically
 * (leading "0" -> country code "27"), since that's the only market this
 * bot currently serves. A number already given with a country code, or a
 * "+", passes through as digits-only. If this ever needs to support other
 * countries, this function must be replaced with a proper phone-parsing
 * library (e.g. libphonenumber) rather than extended with more
 * special-cased prefixes.
 */
function normalizeWhatsAppNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "")

  if (digits.startsWith("27")) return digits
  if (digits.startsWith("0")) return `27${digits.slice(1)}`

  return digits
}

/**
 * Sends a plain text message to a WhatsApp user.
 *
 * @param to Recipient phone number in E.164 without "+" (e.g. "27831234567").
 * @param body The message text to send.
 */
export async function sendWhatsAppTextMessage(to: string, body: string): Promise<void> {
  const phoneNumberId = getPhoneNumberId()
  const normalizedTo = normalizeWhatsAppNumber(to)

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAccessToken()}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: { body },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    console.error("WhatsApp Text API Error")
    console.error("Status:", response.status)
    console.error("Body:", errorBody)
    console.error("Recipient (raw -> normalized):", to, "->", normalizedTo)
    throw new Error(`WhatsApp text send failed (${response.status})`)
  }
}

/**
 * Sends an image message (e.g. a generated ticket QR code) to a WhatsApp
 * user, referenced by a publicly-fetchable URL.
 *
 * NOTE: Meta fetches the image from `imageUrl` itself, so the URL must be
 * reachable from the public internet (a Supabase Storage public bucket
 * URL works fine) — it cannot point at localhost or a private network.
 *
 * @param to Recipient phone number in E.164 without "+".
 * @param imageUrl Public URL of the PNG/JPEG to send.
 * @param caption Optional caption shown under the image.
 */
export async function sendWhatsAppImageMessage(
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<void> {
  const phoneNumberId = getPhoneNumberId()
  const normalizedTo = normalizeWhatsAppNumber(to)

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAccessToken()}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "image",
      image: {
        link: imageUrl,
        ...(caption ? { caption } : {}),
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    console.error("WhatsApp Image API Error")
    console.error("Status:", response.status)
    console.error("Body:", errorBody)
    console.error("Recipient (raw -> normalized):", to, "->", normalizedTo)
    throw new Error(`WhatsApp image send failed (${response.status}): ${errorBody}`)
  }
}

/**
 * A single selectable row within a WhatsApp list message (e.g. one
 * service: "🪪 Rands Passport" / "Check balance, top up, view
 * transactions"). `id` is what comes back in the webhook payload as
 * `list_reply.id` when tapped — kept as a plain sequential token
 * (`row_1`, `row_2`, ...) rather than something semantic, matching how
 * sendWhatsAppButtonsMessage's `btn_${index+1}` ids work: routing reads
 * the *title* text back (see action-router.ts's GLOBAL_INTERRUPT_KEYWORDS
 * comment), not the id, so the id itself doesn't need to carry meaning.
 */
export interface WhatsAppListRow {
  id: string
  title: string
  description?: string
}

export interface WhatsAppListSection {
  title?: string
  rows: WhatsAppListRow[]
}

/**
 * Sends a WhatsApp interactive LIST message — the standard fix for menus
 * with more than 3 options, since interactive buttons messages are
 * hard-capped by Meta at 3 buttons (see sendWhatsAppButtonsMessage's
 * `.slice(0, 3)` below). A list message instead opens as a single tappable
 * button that reveals up to 10 rows, each with a title and an optional
 * description line — the right shape for something like a 5-service
 * concierge menu.
 *
 * Applies the same defensive truncation as sendWhatsAppButtonsMessage,
 * against Meta's actual limits for this message type:
 *   - buttonText (the label on the button that opens the list): 20 chars
 *   - section title: 24 chars
 *   - row title: 24 chars
 *   - row description: 72 chars
 *   - total rows across all sections: 10
 *
 * @param to Recipient phone number in E.164 without "+".
 * @param body Message text shown above the list button.
 * @param buttonText Label on the button that opens the list (e.g. "View Services").
 * @param sections One or more row groups. Most callers will pass a single
 *                 unnamed section; multiple sections are supported for
 *                 cases that want grouped headers (e.g. "Popular" vs "All").
 */
export async function sendWhatsAppListMessage(
  to: string,
  body: string,
  buttonText: string,
  sections: WhatsAppListSection[],
): Promise<void> {
  const phoneNumberId = getPhoneNumberId()
  const normalizedTo = normalizeWhatsAppNumber(to)

  const truncatedButtonText = buttonText.substring(0, 20)

  // WhatsApp caps total rows at 10 across all sections combined — trim from
  // the end (later sections lose rows first) rather than erroring, and warn
  // so an overflowing menu is visible in logs instead of silently missing
  // an entry.
  let rowsRemaining = 10
  const truncatedSections = sections
    .map(section => {
      if (rowsRemaining <= 0) return null
      const rows = section.rows.slice(0, rowsRemaining).map(row => ({
        id: row.id,
        title: row.title.substring(0, 24),
        ...(row.description ? { description: row.description.substring(0, 72) } : {}),
      }))
      rowsRemaining -= rows.length
      return {
        ...(section.title ? { title: section.title.substring(0, 24) } : {}),
        rows,
      }
    })
    .filter((section): section is NonNullable<typeof section> => section !== null && section.rows.length > 0)

  const totalRows = truncatedSections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < sections.reduce((sum, s) => sum + s.rows.length, 0)) {
    console.warn("[send-message] List message exceeded 10 rows; extra rows were dropped", { to })
  }

  if (totalRows === 0) {
    console.warn("[send-message] No rows available for list message, sending as text message")
    return sendWhatsAppTextMessage(to, body)
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAccessToken()}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normalizedTo,
        type: "interactive",
        interactive: {
          type: "list",
          body: {
            text: body,
          },
          action: {
            button: truncatedButtonText,
            sections: truncatedSections,
          },
        },
      }),
    }
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    console.error("WhatsApp List API Error")
    console.error("Status:", response.status)
    console.error("Body:", errorBody)
    console.error("Recipient (raw -> normalized):", to, "->", normalizedTo)
    throw new Error(`WhatsApp list send failed (${response.status}): ${errorBody}`)
  }
}

/**
 * Sends a WhatsApp interactive buttons message.
 * Automatically deduplicates button titles to prevent Meta API errors.
 */
export async function sendWhatsAppButtonsMessage(
  to: string,
  body: string,
  buttons: string[],
): Promise<void> {
  const phoneNumberId = getPhoneNumberId()
  const normalizedTo = normalizeWhatsAppNumber(to)

  // 🔥 FIX: Deduplicate button titles while preserving order
  const seen = new Set<string>()
  const uniqueButtons: string[] = []
  
  for (const button of buttons) {
    // Truncate to 20 characters as WhatsApp requires
    const truncated = button.substring(0, 20)
    if (!seen.has(truncated)) {
      seen.add(truncated)
      uniqueButtons.push(truncated)
    } else {
      console.warn(`[send-message] Duplicate button title removed: "${button}"`)
    }
  }

  // WhatsApp allows max 3 buttons
  const finalButtons = uniqueButtons.slice(0, 3)

  // If no buttons after deduplication, send as text message instead
  if (finalButtons.length === 0) {
    console.warn("[send-message] No unique buttons available, sending as text message")
    return sendWhatsAppTextMessage(to, body)
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAccessToken()}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normalizedTo,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: body,
          },
          action: {
            buttons: finalButtons.map((button, index) => ({
              type: "reply",
              reply: {
                id: `btn_${index + 1}`,
                title: button, // Already truncated and deduplicated
              },
            })),
          },
        },
      }),
    }
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    console.error("WhatsApp Buttons API Error")
    console.error("Status:", response.status)
    console.error("Body:", errorBody)
    console.error("Recipient (raw -> normalized):", to, "->", normalizedTo)
    throw new Error(`WhatsApp button send failed (${response.status}): ${errorBody}`)
  }
}
