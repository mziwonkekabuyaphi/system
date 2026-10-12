// app/clock/[slug]/page.tsx
/**
 * Public, unauthenticated staff clock-in pad for one tenant, at
 * /clock/[their-slug] — meant to sit open on a shared tablet at the shop.
 *
 * Resolves the tenant by (slug, status = 'active') with the service-role
 * client, same trust model as /kiosk/[slug]/page.tsx.
 *
 * Branding + look are display-only here (name/logo/colors/wording so the
 * tablet looks like it belongs to the shop). The actual PIN lookup and shift
 * read/write happens in ./actions.ts, re-resolving the tenant itself.
 *
 * Custom logo, brand color and the "custom" background theme need the
 * 'branding' module, same rule as /display and /kiosk. Stored values are
 * ignored (not deleted) without it, so they return on upgrade. Display name,
 * dark/light theme and all wording are free on every plan.
 */

import { notFound } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { tenantHasModule, MODULE_KEYS } from "@/lib/services/plans"
import { ClockApp } from "@/components/clock/ClockApp"
import { parseClockSettings, resolveClockLook } from "./clockSettings"

// Branding can change any time a shop owner edits it.
export const dynamic = "force-dynamic"

interface TenantRow {
  id: string
  name: string
  slug: string
  status: string
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

  const [{ data: branding }, brandingEntitled] = await Promise.all([
    supabase
      .from("tenant_branding")
      .select(
        "display_name, logo_url, primary_color, " +
          "clock_theme, clock_background_color, clock_tagline, clock_title, clock_prompt, " +
          "clock_clocked_in_label, clock_clocked_out_label, clock_invalid_pin_text",
      )
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    tenantHasModule(supabase, tenant.id, MODULE_KEYS.branding).catch(() => false),
  ])

  const raw = parseClockSettings(branding as Record<string, unknown> | null)
  const settings = brandingEntitled
    ? raw
    : { ...raw, theme: raw.theme === "custom" ? ("dark" as const) : raw.theme, backgroundColor: null }

  const primaryColor = brandingEntitled ? ((branding as any)?.primary_color ?? null) : null
  const look = resolveClockLook(settings, primaryColor)

  return {
    slug: tenant.slug,
    displayName: (branding as any)?.display_name || tenant.name,
    logoUrl: brandingEntitled ? ((branding as any)?.logo_url ?? null) : null,
    look,
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
      themeVars={data.look.vars}
      bgSolid={data.look.bgSolid}
      copy={data.look.copy}
    />
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadClockTenant(slug)
  if (!data) return { title: "Clock in" }
  return { title: `${data.displayName} — ${data.look.copy.title}` }
}
