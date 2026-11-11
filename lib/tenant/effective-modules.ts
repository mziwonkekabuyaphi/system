// lib/tenant/effective-modules.ts
/**
 * ONE answer to "is module X on for this shop?" -- the rules live in the database
 * (public.modules + public.module_requires + public.tenant_effective_modules).
 *
 *   ownOn           the module's own switch / plan entitlement is on
 *   requirementsMet no parent is blocking it (e.g. kiosk needs Booking or Queue)
 *   effective       ownOn AND requirementsMet -- what features should obey
 *
 * Use `effective` to decide whether a feature WORKS. Use `requirementsMet` to decide whether its
 * settings tab is SHOWN for owner-switchable features (kiosk, display, clock-in): the toggle lives in
 * that tab, so an owner who switched it off must still be able to reach it.
 *
 * Child rows are never rewritten: switching a parent back on restores its children.
 * FAILS CLOSED: any error means every module is off. 5s per-instance cache, like lib/tenant/modules.ts.
 */
import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type EffectiveModule = {
  key: string
  kind: string | null
  ownOn: boolean
  requirementsMet: boolean
  effective: boolean
}

export type EffectiveModules = {
  /** Is the module effective (own switch on AND parents satisfied)? */
  on: (key: string) => boolean
  /** Are the module's parents satisfied, regardless of its own switch? */
  available: (key: string) => boolean
  all: Map<string, EffectiveModule>
}

const TTL_MS = 5_000
const cache = new Map<string, { value: Map<string, EffectiveModule>; expiresAt: number }>()

async function load(tenantId: string): Promise<Map<string, EffectiveModule>> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() < hit.expiresAt) return hit.value

  const db = getSupabaseServerClient()
  if (!db) return new Map()

  const { data, error } = await db.rpc("tenant_effective_modules", { p_tenant_id: tenantId })
  if (error) {
    console.error("[effective-modules] failed, treating everything as OFF", { tenantId, error: error.message })
    return new Map()
  }

  const value = new Map<string, EffectiveModule>(
    (data ?? []).map(
      (r: { module_key: string; kind: string | null; own_on: boolean; requirements_met: boolean; effective: boolean }) => [
        r.module_key,
        { key: r.module_key, kind: r.kind, ownOn: r.own_on, requirementsMet: r.requirements_met, effective: r.effective },
      ],
    ),
  )
  cache.set(tenantId, { value, expiresAt: Date.now() + TTL_MS })
  return value
}

export async function getEffectiveModules(tenantId: string): Promise<EffectiveModules> {
  const all = await load(tenantId)
  return {
    all,
    on: (key) => all.get(key)?.effective === true,
    available: (key) => all.get(key)?.requirementsMet === true,
  }
}

export async function isEffective(tenantId: string, key: string): Promise<boolean> {
  return (await getEffectiveModules(tenantId)).on(key)
}

/** Call after a toggle so this instance sees the change at once (other instances catch up within the TTL). */
export function invalidateEffectiveCache(tenantId: string): void {
  cache.delete(tenantId)
}
