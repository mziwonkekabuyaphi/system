// lib/ai/settings.ts
/**
 * Per-shop AI switch. Replaces the old single-row `ai_settings` table.
 *
 * A shop's owner turns the assistant's AI off by setting
 * message_settings.ai_enabled_default = false. A missing row, or any read
 * error, means "on" — a settings hiccup must not silently make every shop
 * dumb. A missing OPENAI_API_KEY means "off" regardless.
 * Cached for a few seconds so a burst of messages doesn't re-read it each time.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isAiConfigured } from "@/lib/ai/openai"

const CACHE_MS = 15_000
const cache = new Map<string, { enabled: boolean; at: number }>()

export async function isAiEnabledForTenant(tenantId: string): Promise<boolean> {
  if (!isAiConfigured()) return false

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
