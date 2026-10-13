// lib/whatsapp/utils/tenant-web-link.ts
/**
 * Customer-facing web link for a tenant, built from tenants.slug.
 *
 * White-label: nothing is hardcoded per shop. Every tenant automatically gets
 * its own link, e.g. https://system-eta-azure.vercel.app/web/test-venue
 *
 * The link is ONLY returned when it will actually work:
 *   - the tenant exists and is active, and
 *   - the tenant's plan includes the kiosk/web module and they have not
 *     switched it off (same rule the web page itself uses: isKioskEnabled).
 * Otherwise this returns null and WhatsApp simply leaves the link line out,
 * so a customer is never sent to a "not available" page.
 *
 * The base URL comes from the NEXT_PUBLIC_APP_URL environment variable
 * (Vercel > Project > Settings > Environment Variables). If it is not set,
 * the fallback below is used.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isKioskEnabled } from "@/lib/services/plans"

const FALLBACK_BASE_URL = "https://system-eta-azure.vercel.app"

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || FALLBACK_BASE_URL).replace(/\/+$/, "")

// The customer-facing page lives at app/web/[slug]/page.tsx. To change the
// word in the link later, rename that folder and change this one word.
const CUSTOMER_WEB_PATH = "web"

/** Builds the URL from a slug. No database lookup, no plan check. */
export function buildTenantWebLink(slug: string | null | undefined): string | null {
  const clean = slug?.trim()
  if (!clean) return null
  return `${BASE_URL}/${CUSTOMER_WEB_PATH}/${encodeURIComponent(clean)}`
}

/**
 * Looks up the tenant and returns its web link ONLY if the page will work.
 * Never throws: any problem returns null so a WhatsApp reply is never broken
 * just because the link could not be worked out.
 */
export async function getTenantWebLink(tenantId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) return null

    const { data: tenant, error } = await supabase
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .eq("status", "active")
      .maybeSingle()

    if (error || !tenant?.slug) return null

    const enabled = await isKioskEnabled(supabase, tenantId)
    if (!enabled) return null

    return buildTenantWebLink(tenant.slug)
  } catch (error) {
    console.error("[tenant-web-link] could not build web link:", error)
    return null
  }
}

/**
 * Ready-made closing line for confirmation messages (booking confirmed,
 * joined the queue). Returns "" when there is no usable link, so it is safe
 * to append straight onto any reply.
 */
export async function getTenantWebLinkNote(tenantId: string): Promise<string> {
  const link = await getTenantWebLink(tenantId)
  return link ? `\n\nNext time you can also book or join the queue online: ${link}` : ""
}
