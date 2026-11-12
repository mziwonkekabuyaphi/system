// lib/payments/credentials.ts
/**
 * Server-only: reads a shop's gateway secret from Vault through a service_role-only database function.
 * The key is held in memory for the request, never cached across requests, never logged, never returned
 * to a browser. (Unlike WhatsApp tokens there is no cache here: a top-up is rare, and a revoked key must
 * stop working immediately.)
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export interface TenantYocoCredentials {
  integrationId: string
  mode: "test" | "live"
  secretKey: string
}

/** null = this shop has no active Yoco connection. Throws only on a database error. */
export async function getTenantYocoCredentials(supabase: SupabaseClient, tenantId: string): Promise<TenantYocoCredentials | null> {
  const { data, error } = await supabase.rpc("get_tenant_payment_credentials", { p_tenant_id: tenantId, p_provider: "yoco" }).maybeSingle()
  if (error) throw new Error(`Payment credential lookup failed: ${error.message}`)
  const row = data as { integration_id?: string; mode?: string; secret_key?: string } | null
  if (!row?.integration_id || !row.secret_key) return null
  return { integrationId: row.integration_id, mode: row.mode === "live" ? "live" : "test", secretKey: row.secret_key }
}

/** Public base URL for webhooks and return pages. Throws if none is configured. */
export function getAppBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")
  if (!raw) throw new Error("Set NEXT_PUBLIC_APP_URL to this app's public https URL (needed for payment webhooks).")
  return raw.replace(/\/+$/, "")
}
