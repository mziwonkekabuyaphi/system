"use server"

// app/display/[slug]/actions.ts
/**
 * Public data loader backing the /display/[slug] TV screen.
 *
 * SECURITY: same posture as app/kiosk/[slug]/actions.ts and
 * app/clock/[slug] — resolves tenantId fresh from (slug, status='active')
 * on every call, never trusts a client-supplied id. This route has no
 * writes at all (it's a read-only ambient display), but the resolve step
 * still matters: it's what stops /display/some-other-slug from serving
 * a suspended/inactive tenant's branding.
 *
 * POLLING, NOT PUSH: a TV in a waiting room stays on the same tab for
 * days or weeks — it never naturally reloads to pick up a branding /
 * service / hours change an admin makes. DisplayScreen.tsx calls this
 * same action again every few minutes client-side so the screen catches
 * up without anyone touching the TV. Cheap enough: four small reads,
 * no writes, same shape whether it's the initial server render or a
 * later client poll.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices, type CatalogService } from "@/lib/services/shared/services-catalog"

export interface DisplayBranding {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  tagline: string | null
}

export interface DisplayHours {
  dayOfWeek: number // 0=Sunday..6=Saturday, matches business_hours
  isClosed: boolean
  openTime: string | null // "HH:MM:SS"
  closeTime: string | null
}

export interface DisplayData {
  branding: DisplayBranding
  services: CatalogService[]
  hours: DisplayHours[]
}

export type DisplayResult = { ok: true; data: DisplayData } | { ok: false; error: string }

async function resolveActiveTenantId(slug: string): Promise<string> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle()

  if (error) throw new Error(`Failed to resolve tenant for slug "${slug}": ${error.message}`)
  if (!data) throw new Error("DISPLAY_TENANT_NOT_FOUND")

  return data.id as string
}

export async function fetchDisplayData(slug: string): Promise<DisplayResult> {
  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) throw new Error("Supabase server client is unavailable")

    const tenantId = await resolveActiveTenantId(slug)

    const [brandingResult, hoursResult, services] = await Promise.all([
      supabase
        .from("tenant_branding")
        .select("display_name, logo_url, primary_color, secondary_color, tagline")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      supabase
        .from("business_hours")
        .select("day_of_week, is_closed, open_time, close_time")
        .eq("tenant_id", tenantId)
        .order("day_of_week", { ascending: true }),
      getBookableServices(tenantId),
    ])

    if (brandingResult.error) throw new Error(`Failed to load branding: ${brandingResult.error.message}`)
    if (hoursResult.error) throw new Error(`Failed to load business hours: ${hoursResult.error.message}`)

    const branding: DisplayBranding = {
      displayName: brandingResult.data?.display_name ?? null,
      logoUrl: brandingResult.data?.logo_url ?? null,
      primaryColor: brandingResult.data?.primary_color ?? null,
      secondaryColor: brandingResult.data?.secondary_color ?? null,
      tagline: brandingResult.data?.tagline ?? null,
    }

    const hours: DisplayHours[] = (hoursResult.data ?? []).map((row) => ({
      dayOfWeek: row.day_of_week,
      isClosed: row.is_closed,
      openTime: row.open_time,
      closeTime: row.close_time,
    }))

    return { ok: true, data: { branding, services, hours } }
  } catch (error) {
    console.error("[display] fetchDisplayData failed", { slug, error })
    return { ok: false, error: "Couldn't load display data." }
  }
}
