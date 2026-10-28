// app/platform/modules/actions.ts — platform-admin on/off switch for the
// modules that are switchable per shop. Server actions are public endpoints,
// so the platform-admin gate is repeated here.
"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

// ONLY these can be switched. Everything else is decided by the shop's plan
// (plan_modules), where a tenant_modules row would do nothing. Keep in sync
// with SWITCHABLE in ./page.tsx.
const SWITCHABLE_KEYS = ["kiosk", "display", "staff_clock_in", "shisha"] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(message: string): never {
  redirect(`/platform/modules?error=${encodeURIComponent(message)}`)
}

export async function setTenantModuleAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin()

  const tenantId = String(formData.get("tenantId") ?? "")
  const moduleKey = String(formData.get("moduleKey") ?? "")
  const enable = formData.get("enable") === "true"

  if (!UUID.test(tenantId)) fail("Invalid shop.")
  if (!(SWITCHABLE_KEYS as readonly string[]).includes(moduleKey)) {
    fail("That module is set by the shop's plan and can't be switched here.")
  }

  const supabase = getSupabaseServerClient()
  if (!supabase) fail("Supabase isn't configured.")

  const { data: tenant, error: tenantError } = await supabase.from("tenants").select("id").eq("id", tenantId).maybeSingle()
  if (tenantError) fail(`Couldn't read the shop: ${tenantError.message}`)
  if (!tenant) fail("Shop not found.")

  const { data: mod, error: modError } = await supabase.from("modules").select("id").eq("key", moduleKey).maybeSingle()
  if (modError) fail(`Couldn't read the modules table: ${modError.message}`)
  if (!mod) fail(`Module '${moduleKey}' isn't registered in the modules table.`)

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

  revalidatePath("/platform/modules")
  revalidatePath("/platform/shisha")
}
