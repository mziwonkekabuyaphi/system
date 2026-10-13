// lib/whatsapp/utils/tenant-web-link.ts
/**
 * Customer-facing web link for a tenant, built from tenants.slug.
 *
 * White-label: nothing is hardcoded per shop. Every tenant automatically gets
 * its own link, e.g. https://system-eta-azure.vercel.app/kiosk/test-venue
 *
 * The base URL comes from the NEXT_PUBLIC_APP_URL environment variable
 * (set it in Vercel > Project > Settings > Environment Variables).
 * If it is not set, the fallback below is used.
 */

const FALLBACK_BASE_URL = "https://system-eta-azure.vercel.app"

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || FALLBACK_BASE_URL).replace(/\/+$/, "")

// Today the link reuses the kiosk page. When you later add a customer-facing
// page (for example "b" so links look like /b/test-venue), change ONLY this
// one word and every WhatsApp message updates automatically.
const CUSTOMER_WEB_PATH = "kiosk"

/** Returns the tenant's web link, or null when the tenant has no slug. */
export function buildTenantWebLink(slug: string | null | undefined): string | null {
  const clean = slug?.trim()
  if (!clean) return null
  return `${BASE_URL}/${CUSTOMER_WEB_PATH}/${encodeURIComponent(clean)}`
}
