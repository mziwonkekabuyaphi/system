// app/admin/settings-actions.ts
"use server"

/**
 * Settings tab actions — General info / Kiosk toggle / Private Label.
 *
 * Same shape as actions.ts and inbox-actions.ts: requireTenantMember() is
 * the auth+membership gate (redirects to /login if there's no session or
 * no active membership — same call page.tsx's layout already makes, and
 * React's cache() means it's free here), then every query still filters by
 * .eq("tenant_id", tenantId) even though we're on the service-role client.
 * Belt and suspenders on purpose, same reasoning as page.tsx: this bypasses
 * RLS entirely, so the manual filter is the only thing standing between a
 * bug and cross-tenant writes.
 *
 * The one rule that matters most here: remove_powered_by can only be set to
 * true when tenants.plan = 'business'. That's checked below AND by a DB
 * trigger on tenant_branding (added in the same migration as the columns),
 * so even a direct SQL write or a future admin tool can't bypass it.
 */

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"

type ActionResult = { success: true } | { success: false; error: string }

async function tenantContext() {
  const { tenantId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { supabase, tenantId }
}

// ---------------------------------------------------------------------------
// General info — tenant_settings
// ---------------------------------------------------------------------------
export async function updateGeneralInfo(input: {
  timezone: string
  currency: string
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { error } = await supabase
      .from("tenant_settings")
      .update({
        timezone: input.timezone,
        currency: input.currency,
        contact_email: input.contactEmail,
        contact_phone: input.contactPhone,
        address: input.address,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Kiosk toggle — tenant_modules (module key: 'kiosk')
// ---------------------------------------------------------------------------
export async function setKioskEnabled(enabled: boolean): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    const { data: kioskModule, error: moduleLookupError } = await supabase
      .from("modules")
      .select("id")
      .eq("key", "kiosk")
      .single()

    if (moduleLookupError || !kioskModule) {
      return { success: false, error: "Kiosk module is not registered" }
    }

    const { error } = await supabase
      .from("tenant_modules")
      .update({
        enabled,
        enabled_at: enabled ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("module_id", kioskModule.id)

    if (error) return { success: false, error: error.message }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Branding + Private Label — tenant_branding
// ---------------------------------------------------------------------------
export async function updateBranding(input: {
  displayName: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  removePoweredBy: boolean
}): Promise<ActionResult> {
  try {
    const { supabase, tenantId } = await tenantContext()

    if (input.removePoweredBy) {
      const { data: tenant, error: planError } = await supabase
        .from("tenants")
        .select("plan")
        .eq("id", tenantId)
        .single()

      if (planError || !tenant) return { success: false, error: "Could not verify plan" }

      if (tenant.plan !== "business") {
        return {
          success: false,
          error: 'Removing "Powered by" requires the Business plan. Upgrade to enable this.',
        }
      }
    }

    const { error } = await supabase
      .from("tenant_branding")
      .update({
        display_name: input.displayName,
        logo_url: input.logoUrl,
        primary_color: input.primaryColor,
        secondary_color: input.secondaryColor,
        remove_powered_by: input.removePoweredBy,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)

    // Belt-and-suspenders: if the DB trigger is what actually catches this
    // (e.g. plan changed between our check above and this write), turn its
    // raw Postgres exception into the same clean message.
    if (error) {
      if (error.message.includes("remove_powered_by can only be enabled")) {
        return {
          success: false,
          error: 'Removing "Powered by" requires the Business plan. Upgrade to enable this.',
        }
      }
      return { success: false, error: error.message }
    }

    revalidatePath("/admin")
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
