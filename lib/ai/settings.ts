// lib/ai/settings.ts
/**
 * "May AI run for this shop right now?" Two independent switches, both must allow it:
 *
 *   1. The tenant's AI account (lib/ai/gateway.ts): AI switched on in Settings > AI, a working key
 *      (their own, or QLess's for managed shops), and this month's estimated spend under their limit.
 *      If that can't be determined (database error) the answer is NO: an unreadable budget must not
 *      turn into free AI at QLess's expense.
 *   2. The per-shop "AI replies by default" switch, message_settings.ai_enabled_default, unchanged.
 *      A missing row, or a read error, means "on": a settings hiccup must not silently make every
 *      shop dumb. Cached for a few seconds so a burst of messages doesn't re-read it each time.
 *
 * When this returns false, every caller already falls back to the plain menu flow.
 */

import { isTenantAiAvailable } from "@/lib/ai/gateway"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

const CACHE_MS = 15_000
const cache = new Map<string, { enabled: boolean; at: number }>()

export async function isAiEnabledForTenant(tenantId: string): Promise<boolean> {
  if (!(await isTenantAiAvailable(tenantId))) return false

  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.enabled

  let enabled = true
  try {
    const supabase = getSupabaseServerClient()
    if (supabase) {
      const { data, error } = await supabase
        .from("message_settings")
        .select("ai_enabled_default")
        .eq("tenant_id", tenantId)
        .maybeSingle()
      if (error) console.error("[ai/settings] read failed, defaulting to on:", error.message)
      else if (data && data.ai_enabled_default === false) enabled = false
    }
  } catch (error) {
    console.error("[ai/settings] threw, defaulting to on:", error)
  }

  cache.set(tenantId, { enabled, at: Date.now() })
  return enabled
}
