// app/kiosk/[slug]/page.tsx
/**
 * Public, unauthenticated kiosk landing page for one tenant, at
 * /kiosk/[their-slug] — e.g. /kiosk/rands-cape-town if that's what
 * `tenants.slug` is set to for that shop.
 *
 * Resolves the tenant by (slug, status = 'active') using the same
 * privileged server client booking.ts/queue.ts/send-message.ts already
 * use — NOT a cookie/anon-scoped client. This matters here specifically:
 * `tenants_select` and `services_select` RLS policies only allow
 * `is_platform_admin()` or `is_tenant_member(...)` — there is no public
 * SELECT path on either table. A kiosk visitor has no auth.uid() at all,
 * so an anon-scoped read would 404 a real, active shop. This route is
 * trusted server code resolving a public slug (the same trust model the
 * WhatsApp webhook already uses for unauthenticated inbound traffic),
 * not an RLS-gated user request — so it deliberately reaches for the
 * service-role client instead.
 *
 * `tenant_branding` IS public-selectable (`tenant_branding_select: true`)
 * but is keyed 1:1 on tenant_id with every color column nullable, and a
 * tenant may have no branding row at all yet — both cases fall back to
 * the default palette below, which is also passed to KioskApp so a shop
 * that sets only one color still gets sane values for the rest.
 *
 * NEXT.JS 15/16 FIX: `params` is now a Promise (not a plain object) in
 * route/page components — must be awaited before use. The old sync
 * `{ params: { slug: string } }` shape silently resolved `params.slug`
 * to `undefined`, which made loadKioskData(undefined) return null via
 * an empty (not erroring) Supabase query, which triggered notFound() —
 * a real tenant 404'ing with zero errors logged anywhere. Both the page
 * component and generateMetadata needed this fix, since each
 * independently destructures `params`.
 */

import { notFound } from "next/navigation"
import { Manrope } from "next/font/google"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices } from "@/lib/services/shared/services-catalog"
import { KioskApp } from "@/components/kiosk/KioskApp"

const manrope = Manrope({ subsets: ["latin"], weight: ["500", "600", "700", "800"] })

// Kiosk data (services, branding) can change any time a shop owner edits
// their catalog or colors — a walk-in kiosk should never serve a cached
// version of either.
export const dynamic = "force-dynamic"

export interface KioskBranding {
  displayName: string
  logoUrl: string | null
  primaryColor: string
  secondaryColor: string
}

// Fallback palette from the design brief. tenant_branding.primary_color
// overrides `primaryColor` (used for the main accent/CTA color);
// secondary_color overrides `secondaryColor` (used for the ticket-stub
// accent). Every other token (ink, paper, line, muted) is structural,
// not brand, and stays fixed regardless of tenant.
const DEFAULT_PRIMARY_COLOR = "#2B6F5C" // accent
const DEFAULT_SECONDARY_COLOR = "#C97A3D" // ticket-amber

interface TenantRow {
  id: string
  name: string
  slug: string
  status: string
}

interface TenantBrandingRow {
  display_name: string | null
  logo_url: string | null
  primary_color: string | null
  secondary_color: string | null
}

async function loadKioskData(slug: string) {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id, name, slug, status")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle<TenantRow>()

  if (tenantError) throw new Error(`Failed to resolve tenant for slug "${slug}": ${tenantError.message}`)
  if (!tenant) return null

  const { data: branding } = await supabase
    .from("tenant_branding")
    .select("display_name, logo_url, primary_color, secondary_color")
    .eq("tenant_id", tenant.id)
    .maybeSingle<TenantBrandingRow>()

  const resolvedBranding: KioskBranding = {
    displayName: branding?.display_name || tenant.name,
    logoUrl: branding?.logo_url ?? null,
    primaryColor: branding?.primary_color || DEFAULT_PRIMARY_COLOR,
    secondaryColor: branding?.secondary_color || DEFAULT_SECONDARY_COLOR,
  }

  const services = await getBookableServices(tenant.id)

  return { tenant, branding: resolvedBranding, services }
}

export default async function KioskPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadKioskData(slug)
  if (!data) notFound()

  const { tenant, branding, services } = data

  return (
    <div className={manrope.className}>
      <KioskApp slug={tenant.slug} branding={branding} initialServices={services} />
    </div>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadKioskData(slug)
  return {
    title: data ? `${data.branding.displayName} — Check in` : "Kiosk",
  }
}
