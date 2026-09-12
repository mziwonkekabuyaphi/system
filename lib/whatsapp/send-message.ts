// lib/whatsapp/send-message.ts
/**
 * Sends outbound messages via the WhatsApp Cloud API (Meta Graph API) —
 * tenant-scoped rewrite. Every function now takes `tenantId` as its first
 * parameter and resolves that tenant's OWN phone_number_id + access token
 * via `get_tenant_whatsapp_credentials()` (a SECURITY DEFINER Postgres
 * function that reads tenant_whatsapp_integrations + the decrypted Vault
 * secret in one call) — NOT a single global WHATSAPP_ACCESS_TOKEN /
 * WHATSAPP_PHONE_NUMBER_ID env var pair anymore.
 *
 * The decrypted token is held only in memory, per warm instance, for a
 * short TTL (see credentialCache below) — never logged, never returned to
 * a caller, never written anywhere. If a tenant's integration is missing,
 * inactive, or has no token configured, every send function throws a
 * clear, tenant-identified error rather than silently sending with an
 * empty/undefined Authorization header (which would otherwise surface as
 * a confusing 401 from Meta with no indication of which tenant caused it).
 *
 * PHONE NORMALIZATION: now delegates to lib/utils/phone.ts's
 * normalizePhoneNumber() instead of keeping its own private copy
 * (previously `normalizeWhatsAppNumber`, defined only in this file).
 * tenant-customer.ts needed the exact same SA-specific rule to keep kiosk
 * and WhatsApp customers from splitting into two rows — rather than
 * copy-pasting the regex a second time and risking the two drifting
 * apart, both files now import the one implementation.
 */

import { getSupabaseServerClient } from "@/lib/supabase/server"
import { normalizePhoneNumber } from "@/lib/utils/phone"

const GRAPH_API_VERSION = "v21.0"

// ---------------------------------------------------------------------------
// Per-tenant credential resolution + short-lived cache
// ---------------------------------------------------------------------------
// A single webhook POST can trigger several sends for the SAME tenant
// (reply + media + follow-ups) — this cache avoids a DB+Vault round trip
// per send within that burst, and across nearby invocations on a warm
// instance. Deliberately SHORT (unlike state.ts's 10-minute TTL): this
// holds a live secret in memory, and tokens are the one thing here where
// "re-fetch a bit more often" is the right tradeoff over "cache
// aggressively". Never treated as a source of truth beyond its TTL.
interface CachedCredentials {
  readonly phoneNumberId: string
  readonly accessToken: string
  readonly expiresAt: number
}

const CREDENTIAL_CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes
const credentialCache = new Map<string, CachedCredentials>()

interface TenantWhatsAppCredentials {
  phoneNumberId: string
  accessToken: string
}

async function getTenantCredentials(tenantId: string): Promise<TenantWhatsAppCredentials> {
  const cached = credentialCache.get(tenantId)
  if (cached && Date.now() < cached.expiresAt) {
    return { phoneNumberId: cached.phoneNumberId, accessToken: cached.accessToken }
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) {
    throw new Error(`WhatsApp send failed: Supabase is not configured (tenantId=${tenantId})`)
  }

  const { data, error } = await supabase
    .rpc("get_tenant_whatsapp_credentials", { p_tenant_id: tenantId })
    .maybeSingle()

  if (error) {
    throw new Error(`WhatsApp send failed: credential lookup error for tenant ${tenantId}: ${error.message}`)
  }
  if (!data || !data.phone_number_id || !data.access_token) {
    throw new Error(
      `WhatsApp send failed: no active WhatsApp integration/token found for tenant ${tenantId}. ` +
        `Check tenant_whatsapp_integrations.status and access_token_secret_id.`,
    )
  }

  const credentials: TenantWhatsAppCredentials = {
    phoneNumberId: data.phone_number_id as string,
    accessToken: data.access_token as string,
  }

  credentialCache.set(tenantId, { ...credentials, expiresAt: Date.now() + CREDENTIAL_CACHE_TTL_MS })
  return credentials
}

function graphMessagesUrl(phoneNumberId: string): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`
}

async function logAndThrowGraphError(kind: string, response: Response, to: string, normalizedTo: string, tenantId: string): Promise<never> {
  const errorBody = await response.text().catch(() => "")
  console.error(`WhatsApp ${kind} API Error`)
  console.error("Tenant:", tenantId)
  console.error("Status:", response.status)
  console.error("Body:", errorBody)
  console.error("Recipient (raw -> normalized):", to, "->", normalizedTo)
  throw new Error(`WhatsApp ${kind.toLowerCase()} send failed (${response.status}) for tenant ${tenantId}`)
}

/**
 * Sends a plain text message to a WhatsApp user, via `tenantId`'s own
 * WhatsApp integration.
 */
export async function sendWhatsAppTextMessage(tenantId: string, to: string, body: string): Promise<void> {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId)
  const normalizedTo = normalizePhoneNumber(to)

  const response = await fetch(graphMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: { body },
    }),
  })

  if (!response.ok) {
    await logAndThrowGraphError("Text", response, to, normalizedTo, tenantId)
  }
}

/**
 * Sends an image message to a WhatsApp user, referenced by a
 * publicly-fetchable URL, via `tenantId`'s own WhatsApp integration.
 */
export async function sendWhatsAppImageMessage(
  tenantId: string,
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<void> {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId)
  const normalizedTo = normalizePhoneNumber(to)

  const response = await fetch(graphMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
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
    await logAndThrowGraphError("Image", response, to, normalizedTo, tenantId)
  }
}

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
 * Sends a WhatsApp interactive LIST message, via `tenantId`'s own
 * WhatsApp integration. Truncation behavior against Meta's limits is
 * unchanged from the single-tenant version.
 */
export async function sendWhatsAppListMessage(
  tenantId: string,
  to: string,
  body: string,
  buttonText: string,
  sections: WhatsAppListSection[],
): Promise<void> {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId)
  const normalizedTo = normalizePhoneNumber(to)

  const truncatedButtonText = buttonText.substring(0, 20)

  let rowsRemaining = 10
  const truncatedSections = sections
    .map((section) => {
      if (rowsRemaining <= 0) return null
      const rows = section.rows.slice(0, rowsRemaining).map((row) => ({
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
    console.warn("[send-message] List message exceeded 10 rows; extra rows were dropped", { tenantId, to })
  }

  if (totalRows === 0) {
    console.warn("[send-message] No rows available for list message, sending as text message", { tenantId })
    return sendWhatsAppTextMessage(tenantId, to, body)
  }

  const response = await fetch(graphMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: truncatedButtonText,
          sections: truncatedSections,
        },
      },
    }),
  })

  if (!response.ok) {
    await logAndThrowGraphError("List", response, to, normalizedTo, tenantId)
  }
}

/**
 * Sends a WhatsApp interactive buttons message, via `tenantId`'s own
 * WhatsApp integration. Deduplication/truncation behavior against Meta's
 * 3-button limit is unchanged from the single-tenant version.
 */
export async function sendWhatsAppButtonsMessage(tenantId: string, to: string, body: string, buttons: string[]): Promise<void> {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId)
  const normalizedTo = normalizePhoneNumber(to)

  const seen = new Set<string>()
  const uniqueButtons: string[] = []

  for (const button of buttons) {
    const truncated = button.substring(0, 20)
    if (!seen.has(truncated)) {
      seen.add(truncated)
      uniqueButtons.push(truncated)
    } else {
      console.warn(`[send-message] Duplicate button title removed: "${button}"`, { tenantId })
    }
  }

  const finalButtons = uniqueButtons.slice(0, 3)

  if (finalButtons.length === 0) {
    console.warn("[send-message] No unique buttons available, sending as text message", { tenantId })
    return sendWhatsAppTextMessage(tenantId, to, body)
  }

  const response = await fetch(graphMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: finalButtons.map((button, index) => ({
            type: "reply",
            reply: { id: `btn_${index + 1}`, title: button },
          })),
        },
      },
    }),
  })

  if (!response.ok) {
    await logAndThrowGraphError("Buttons", response, to, normalizedTo, tenantId)
  }
}
