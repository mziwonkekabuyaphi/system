// app/platform/shisha/actions.ts — platform-admin switch for the Shisha module.
// Server actions are public endpoints, so the platform-admin gate is repeated
// here (the layout check alone is never enough).
"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { invalidateModuleCache } from "@/lib/tenant/modules"

// Literal on purpose: independent of MODULE_KEYS.shisha existing in plans.ts.
const SHISHA_MODULE_KEY = "shisha"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(message: string): never {
  redirect(`/platform/shisha?error=${encodeURIComponent(message)}`)
}

/** Switch Shisha on/off for one shop (writes tenant_modules). Shisha is not in
 *  any plan, so this row is the ONLY thing that grants access. */
export async function setShishaEnabledAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin()

  const tenantId = String(formData.get("tenantId") ?? "")
  const enable = formData.get("enable") === "true"
  if (!UUID.test(tenantId)) fail("Invalid shop.")

  const supabase = getSupabaseServerClient()
  if (!supabase) fail("Supabase isn't configured.")

  const { data: tenant, error: tenantError } = await supabase.from("tenants").select("id").eq("id", tenantId).maybeSingle()
  if (tenantError || !tenant) fail("Shop not found.")

  const { data: mod, error: modError } = await supabase.from("modules").select("id").eq("key", SHISHA_MODULE_KEY).maybeSingle()
  if (modError) fail(`Couldn't read the modules table: ${modError.message}`)
  if (!mod) fail("No 'shisha' row in the modules table of the database this app uses. Check the migration ran on the right project.")

  const { data: existing, error: existingError } = await supabase
    .from("tenant_modules")
    .select("enabled")
    .eq("tenant_id", tenantId)
    .eq("module_id", mod.id)
    .maybeSingle()
  if (existingError) fail(existingError.message)

  const { error } = existing
    ? await supabase.from("tenant_modules").update({ enabled: enable }).eq("tenant_id", tenantId).eq("module_id", mod.id)
    : await supabase.from("tenant_modules").insert([{ tenant_id: tenantId, module_id: mod.id, enabled: enable }])
  if (error) fail(error.message)

  // WhatsApp caches module lookups for a few seconds; drop this shop's entry so
  // the instance that handled the toggle sees it straight away.
  invalidateModuleCache(tenantId, SHISHA_MODULE_KEY)

  revalidatePath("/platform/shisha")
}
