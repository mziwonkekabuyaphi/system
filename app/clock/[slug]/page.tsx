// app/clock/[slug]/page.tsx
/**
 * Public, unauthenticated staff clock-in pad for one tenant, at
 * /clock/[their-slug] — meant to sit open on a shared tablet at the shop,
 * the same way /kiosk/[slug] does for customers.
 *
 * Resolves the tenant by (slug, status = 'active') with the service-role
 * client, same trust model as /kiosk/[slug]/page.tsx: this route is
 * trusted server code resolving a public slug, not an RLS-gated user
 * request, so it deliberately doesn't use an anon-scoped client.
 *
 * Branding here is display-only (name/logo/accent color so the tablet
 * looks like it belongs to the shop) — the actual PIN lookup and shift
 * read/write happens in ./actions.ts, re-resolving the tenant itself.
 */

import { notFound } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { ClockApp } from "@/components/clock/ClockApp"

// Branding can change any time a shop owner edits it, and the pad should
// never show a stale name/color to whoever's standing at the tablet.
export const dynamic = "force-dynamic"

const DEFAULT_PRIMARY_COLOR = "#2B6F5C"

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
}

async function loadClockTenant(slug: string) {
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
    .select("display_name, logo_url, primary_color")
    .eq("tenant_id", tenant.id)
    .maybeSingle<TenantBrandingRow>()

  return {
    slug: tenant.slug,
    displayName: branding?.display_name || tenant.name,
    logoUrl: branding?.logo_url ?? null,
    primaryColor: branding?.primary_color || DEFAULT_PRIMARY_COLOR,
  }
}

export default async function ClockPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadClockTenant(slug)
  if (!data) notFound()

  return (
    <ClockApp
      slug={data.slug}
      displayName={data.displayName}
      logoUrl={data.logoUrl}
      primaryColor={data.primaryColor}
    />
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadClockTenant(slug)
  if (!data) return { title: "Clock in" }
  return { title: `${data.displayName} — Clock in` }
}
