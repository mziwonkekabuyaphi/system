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
 *
 * KIOSK-AVAILABILITY GATE (new): a tenant existing and being active
 * (checked above) is not the same as that tenant having the kiosk
 * *module* turned on — that's a separate on/off switch admins flip from
 * Settings (setKioskEnabled in app/admin/settings-actions.ts), keyed on
 * `modules.key = 'kiosk'` / `tenant_modules.enabled`. This route reuses
 * that exact lookup (see resolveKioskModuleEnabled below) so a tenant
 * that's paused their kiosk gets an explicit "not available" screen
 * instead of the booking flow. This check happens here, server-side, in
 * loadKioskData — before KioskApp is ever rendered and before
 * getBookableServices() is ever called — not as a client-side redirect
 * after the flow has already mounted. No tenant_modules row for 'kiosk'
 * is treated the same as `enabled: false` (fail closed): an unprovisioned
 * module is not an on module.
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
  removePoweredBy: boolean
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
  remove_powered_by: boolean | null
}

type KioskLoadResult =
  | { tenant: TenantRow; branding: KioskBranding; kioskEnabled: true; services: Awaited<ReturnType<typeof getBookableServices>> }
  | { tenant: TenantRow; branding: KioskBranding; kioskEnabled: false; services: [] }

// Same two-step lookup as setKioskEnabled/updateGeneralInfo's sibling in
// app/admin/settings-actions.ts: resolve the `kiosk` row on `modules`,
// then read this tenant's `tenant_modules` row for it. Any failure to
// resolve either row — module not registered, no tenant_modules row yet,
// or a real query error — is treated as "not enabled" rather than
// bubbling an error, since a booking flow silently failing open on a
// misconfigured module row would be far worse than an idle kiosk
// correctly showing "not available."
async function resolveKioskModuleEnabled(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
): Promise<boolean> {
  const { data: kioskModule, error: moduleLookupError } = await supabase
    .from("modules")
    .select("id")
    .eq("key", "kiosk")
    .single()

  if (moduleLookupError || !kioskModule) {
    console.error("[kiosk] kiosk module lookup failed", { tenantId, error: moduleLookupError })
    return false
  }

  const { data: tenantModule, error: tenantModuleError } = await supabase
    .from("tenant_modules")
    .select("enabled")
    .eq("tenant_id", tenantId)
    .eq("module_id", kioskModule.id)
    .maybeSingle()

  if (tenantModuleError) {
    console.error("[kiosk] tenant_modules lookup failed", { tenantId, error: tenantModuleError })
    return false
  }

  return tenantModule?.enabled === true
}

async function loadKioskData(slug: string): Promise<KioskLoadResult | null> {
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
    .select("display_name, logo_url, primary_color, secondary_color, remove_powered_by")
    .eq("tenant_id", tenant.id)
    .maybeSingle<TenantBrandingRow>()

  const resolvedBranding: KioskBranding = {
    displayName: branding?.display_name || tenant.name,
    logoUrl: branding?.logo_url ?? null,
    primaryColor: branding?.primary_color || DEFAULT_PRIMARY_COLOR,
    secondaryColor: branding?.secondary_color || DEFAULT_SECONDARY_COLOR,
    // No row (tenant hasn't touched branding yet) and NULL (column default)
    // both mean "hasn't been granted/enabled" — false either way. This is
    // also independent of `plan`: a tenant that downgrades off Business
    // after having it set stays governed by whatever's actually stored
    // here, since that's what updateBranding's own plan check maintains.
    removePoweredBy: branding?.remove_powered_by === true,
  }

  const kioskEnabled = await resolveKioskModuleEnabled(supabase, tenant.id)

  // Don't even touch the services catalog when the module's off — the
  // whole point of a server-side gate is that the booking flow's data
  // never loads for a kiosk that shouldn't be running it.
  if (!kioskEnabled) {
    return { tenant, branding: resolvedBranding, kioskEnabled: false, services: [] }
  }

  const services = await getBookableServices(tenant.id)

  return { tenant, branding: resolvedBranding, kioskEnabled: true, services }
}

export default async function KioskPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadKioskData(slug)
  if (!data) notFound()

  const { tenant, branding, kioskEnabled, services } = data

  if (!kioskEnabled) {
    return (
      <div className={manrope.className}>
        <KioskUnavailable branding={branding} />
      </div>
    )
  }

  return (
    <div className={manrope.className}>
      <KioskApp slug={tenant.slug} branding={branding} initialServices={services} />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Kiosk-module-off state — deliberately plain: no idle timer, no tap
// target, nothing for a walk-in to interact with. Uses the same
// paper/ink/accent tokens as KioskApp's own <style jsx> so a paused kiosk
// still looks like it belongs to the shop, not like a generic error page.
// ----------------------------------------------------------------------------

function KioskUnavailable({ branding }: { branding: KioskBranding }) {
  return (
    <div
      className="unavailable"
      style={
        {
          "--ink": "#171412",
          "--paper": "#FAF8F5",
          "--accent": branding.primaryColor,
          "--muted": "#6B655C",
        } as React.CSSProperties
      }
    >
      {branding.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logoUrl} alt="" className="logo" />
      )}
      <h1>{branding.displayName}</h1>
      <p className="message">This kiosk isn't available right now.</p>
      <p className="submessage">Please check in at the counter instead.</p>

      <style jsx global>{`
        html,
        body {
          margin: 0;
          padding: 0;
          height: 100%;
          background: #faf8f5;
        }
      `}</style>

      <style jsx>{`
        .unavailable {
          min-height: 100vh;
          width: 100%;
          background: var(--paper);
          color: var(--ink);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 20px;
          padding: 40px;
          text-align: center;
        }
        .logo {
          max-height: 96px;
          max-width: 320px;
          object-fit: contain;
          margin-bottom: 8px;
        }
        h1 {
          font-size: 48px;
          font-weight: 800;
          margin: 0;
          color: var(--ink);
          line-height: 1.1;
        }
        .message {
          font-size: 26px;
          font-weight: 700;
          color: var(--accent);
          margin: 0;
        }
        .submessage {
          font-size: 19px;
          font-weight: 500;
          color: var(--muted);
          margin: 0;
        }
      `}</style>
    </div>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadKioskData(slug)
  if (!data) return { title: "Kiosk" }

  return {
    title: data.kioskEnabled ? `${data.branding.displayName} — Check in` : `${data.branding.displayName} — Kiosk unavailable`,
  }
}
