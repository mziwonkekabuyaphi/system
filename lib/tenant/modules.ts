// lib/tenant/modules.ts
/**
 * "Is module X switched on for this tenant?" — the single question every
 * module-gated feature asks. Delegates to the existing SQL function
 * public.tenant_has_module(p_tenant_id, p_module_key), so the rule lives in
 * ONE place (the database): no tenant_modules row => off, enabled = false =>
 * off, tenant not 'active' => off.
 *
 * Very short per-instance cache (5s) so a burst of WhatsApp messages doesn't pay
 * an RPC each. A toggle takes effect within ~5s on every warm instance: the
 * platform toggle actions also call invalidateModuleCache(), which makes the
 * instance that handled the toggle see it immediately, but each serverless
 * instance has its own memory, so the TTL is what bounds the others.
 * FAILS CLOSED: any error means "off", never "on".
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type ModuleKey = "shisha" | (string & {})

const TTL_MS = 5_000
const cache = new Map<string, { value: boolean; expiresAt: number }>()

export async function isModuleEnabled(tenantId: string, moduleKey: ModuleKey): Promise<boolean> {
  const cacheKey = `${tenantId}:${moduleKey}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() < hit.expiresAt) return hit.value

  const db = getSupabaseServerClient()
  if (!db) return false

  const { data, error } = await db.rpc("tenant_has_module", {
    p_tenant_id: tenantId,
    p_module_key: moduleKey,
  })
  if (error) {
    console.error("[modules] tenant_has_module failed, treating as OFF", { tenantId, moduleKey, error: error.message })
    return false
  }

  const value = Boolean(data)
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS })
  return value
}

/** Call from the module-toggle Server Action so the same instance sees the change immediately. */
export function invalidateModuleCache(tenantId: string, moduleKey?: ModuleKey): void {
  if (moduleKey) {
    cache.delete(`${tenantId}:${moduleKey}`)
    return
  }
  for (const key of cache.keys()) if (key.startsWith(`${tenantId}:`)) cache.delete(key)
}
