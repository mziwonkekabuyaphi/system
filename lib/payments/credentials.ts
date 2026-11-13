// lib/payments/credentials.ts
/**
 * Server-only: reads a shop's card-provider connection (with its secrets) from Vault through
 * service_role-only database functions. Secrets are held in memory for the request, never cached across
 * requests, never logged, never returned to a browser. (There is no cache on purpose: a top-up is rare,
 * and a revoked key must stop working immediately.)
 *
 * A shop has at most ONE active provider (enforced by a unique index in the database).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { getProvider, type PaymentMode, type ProviderConnection } from "./providers"

export interface StoredConnection extends ProviderConnection {
  tenantId: string
  status: string
}

type SecretRow = {
  integration_id?: string
  tenant_id?: string
  provider?: string
  status?: string
  mode?: string
  config?: unknown
  secrets?: unknown
}

/** jsonb comes back as an object; keep only string values so a provider never sees anything odd. */
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[k] = v
  return out
}

function toConnection(row: SecretRow, tenantId: string, status: string): StoredConnection | null {
  const provider = getProvider(row.provider)
  // A row for a provider this build doesn't know yet counts as "not connected", never as a crash.
  if (!provider || !row.integration_id) return null
  const mode: PaymentMode = row.mode === "live" ? "live" : "test"
  return {
    integrationId: row.integration_id,
    provider: provider.id,
    mode,
    config: stringMap(row.config),
    secrets: stringMap(row.secrets),
    tenantId,
    status,
  }
}

/** null = this shop has no active card provider. Throws only on a database error. */
export async function getTenantCardConnection(supabase: SupabaseClient, tenantId: string): Promise<StoredConnection | null> {
  const { data, error } = await supabase.rpc("get_active_payment_integration", { p_tenant_id: tenantId }).maybeSingle()
  if (error) throw new Error(`Payment credential lookup failed: ${error.message}`)
  if (!data) return null
  return toConnection(data as SecretRow, tenantId, "active")
}

/** One connection by id (the webhook receiver and refunds). null if it doesn't exist or the provider is unknown. */
export async function getIntegrationConnection(supabase: SupabaseClient, integrationId: string): Promise<StoredConnection | null> {
  const { data, error } = await supabase.rpc("get_integration_secrets", { p_integration_id: integrationId }).maybeSingle()
  if (error) throw new Error(`Payment credential lookup failed: ${error.message}`)
  const row = data as SecretRow | null
  if (!row?.tenant_id) return null
  return toConnection(row, row.tenant_id, row.status ?? "disabled")
}

/** The shop's currency (tenant_settings.currency), ZAR when it isn't set. */
export async function getTenantCurrency(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data } = await supabase.from("tenant_settings").select("currency").eq("tenant_id", tenantId).maybeSingle()
  const code = typeof data?.currency === "string" ? data.currency.trim().toUpperCase() : ""
  return /^[A-Z]{3}$/.test(code) ? code : "ZAR"
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

/** The URL a provider must call for one connection. The same shape for every provider. */
export function webhookUrlFor(provider: string, integrationId: string): string {
  return `${getAppBaseUrl()}/api/webhooks/${provider}/${integrationId}`
}
