// lib/services/tenant-modules.ts
//
// Writes a new shop's starting modules. The lists (SELF_SIGNUP_MODULES,
// CREATABLE_MODULES) live in ./new-shop-modules.ts so client components can use them.

import type { SupabaseClient } from "@supabase/supabase-js"

import { invalidateModuleCache } from "@/lib/tenant/modules"
import type { NewShopModule } from "@/lib/services/new-shop-modules"

/** Switches the given modules ON for a shop (tenant_modules, enabled_at = now). Throws on any failure so
 *  the caller can roll the new shop back instead of leaving it half set up. */
export async function enableModulesForNewShop(
  supabase: SupabaseClient,
  tenantId: string,
  keys: NewShopModule[],
): Promise<void> {
  if (keys.length === 0) return

  const { data: mods, error: modError } = await supabase.from("modules").select("id, key").in("key", keys)
  if (modError) throw new Error(`Couldn't read the modules table: ${modError.message}`)

  const idByKey = new Map((mods ?? []).map((m: { id: string; key: string }) => [m.key, m.id]))
  const missing = keys.filter((k) => !idByKey.has(k))
  if (missing.length > 0) throw new Error(`Module(s) not registered in the modules table: ${missing.join(", ")}`)

  const now = new Date().toISOString()
  const { error } = await supabase.from("tenant_modules").upsert(
    keys.map((k) => ({ tenant_id: tenantId, module_id: idByKey.get(k)!, enabled: true, enabled_at: now, updated_at: now })),
    { onConflict: "tenant_id,module_id" },
  )
  if (error) throw new Error(`Couldn't switch on the shop's modules: ${error.message}`)

  for (const k of keys) invalidateModuleCache(tenantId, k)
}
