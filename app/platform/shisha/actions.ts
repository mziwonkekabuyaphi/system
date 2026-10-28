// app/platform/shisha/actions.ts — platform-admin switch for the Shisha module.
// Server actions are public endpoints, so the platform-admin gate is repeated
// here (the layout check alone is never enough).
"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { MODULE_KEYS } from "@/lib/services/plans"

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

  const { data: mod, error: modError } = await supabase.from("modules").select("id").eq("key", MODULE_KEYS.shisha).maybeSingle()
  if (modError || !mod) fail("The shisha module isn't registered yet. Run the shisha migration first.")

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

  revalidatePath("/platform/shisha")
}
