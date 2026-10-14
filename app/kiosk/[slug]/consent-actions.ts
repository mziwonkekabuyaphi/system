"use server"

// app/kiosk/[slug]/consent-actions.ts
/**
 * Public Server Actions for the kiosk's "Send me WhatsApp updates" checkbox.
 *
 * Same trust model as ./actions.ts: the tenant is re-resolved from (slug, status = 'active') on every
 * call and a tenantId is never accepted from the client.
 *
 * WHY A SEPARATE TABLE: the queue insert fires the "joined" WhatsApp message immediately (DB trigger),
 * before the customer row's consent could be updated. So consent is recorded first in whatsapp_optins,
 * keyed by the last 9 digits of the phone, and the queue-notify edge function checks it.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"

async function resolveTenantId(slug: string): Promise<string | null> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return null
  const { data } = await supabase.from("tenants").select("id").eq("slug", slug).eq("status", "active").maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/** Only offer the checkbox when this shop actually has WhatsApp connected. */
export async function isWhatsAppAvailable(slug: string): Promise<boolean> {
  try {
    const supabase = getSupabaseServerClient()
    const tenantId = await resolveTenantId(slug)
    if (!supabase || !tenantId) return false
    const { data } = await supabase
      .from("tenant_whatsapp_integrations")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle()
    return !!data
  } catch {
    return false
  }
}

export async function recordWhatsAppOptIn(slug: string, phone: string): Promise<{ ok: boolean }> {
  try {
    const digits = phone.replace(/\D/g, "")
    if (digits.length < 9 || digits.length > 15) return { ok: false }

    const supabase = getSupabaseServerClient()
    const tenantId = await resolveTenantId(slug)
    if (!supabase || !tenantId) return { ok: false }

    const { error } = await supabase
      .from("whatsapp_optins")
      .upsert({ tenant_id: tenantId, phone_key: digits.slice(-9), source: "kiosk" }, { onConflict: "tenant_id,phone_key", ignoreDuplicates: true })
    if (error) {
      console.error("[kiosk] recordWhatsAppOptIn failed", { slug, error: error.message })
      return { ok: false }
    }
    return { ok: true }
  } catch (error) {
    console.error("[kiosk] recordWhatsAppOptIn failed", { slug, error })
    return { ok: false }
  }
}
