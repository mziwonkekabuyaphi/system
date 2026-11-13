"use server"

// app/admin/payments/actions.ts
//
// Server Actions for "Settings > Payments": connect / disconnect the shop's OWN card-payment provider
// (Yoco today; Ozow and others as their adapters are registered in lib/payments/providers).
// Same layers as app/admin/events/actions.ts:
//   1. requireTenantPermission("settings.manage") proves the signed-in user may manage THIS shop's
//      settings. The tenantId comes from their membership, never from the browser.
//   2. All writes use the service-role client, always filtered by that tenantId (the payment tables
//      have no write policies, so a browser can never touch them directly).
//   3. Secrets travel: browser -> this action (HTTPS) -> the provider (to prove they work) -> Vault.
//      They are never logged, never stored in a normal table, and never sent back: the screen only ever
//      gets a short hint (the last 4 characters).
//   4. A shop has ONE active provider. The database enforces it (unique index); this checks first so the
//      owner gets a clear message ("Disconnect Yoco first") instead of a constraint error.

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { getAppBaseUrl, getIntegrationConnection, webhookUrlFor } from "@/lib/payments/credentials"
import { ConnectInputError, getProvider, listProviders, ProviderError } from "@/lib/payments/providers"

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

export interface ProviderInfo {
  id: string
  label: string
  description: string
  disconnectNote: string
  fields: Array<{ name: string; label: string; secret: boolean; placeholder?: string; help?: string }>
}

export interface PaymentSettings {
  /** Providers this build can connect. */
  providers: ProviderInfo[]
  /** The shop's active provider, or null. */
  active: { provider: string; label: string; mode: "test" | "live" | null; keyHint: string | null; lastEventAt: string | null } | null
  /** Most recent problem on the shop's connection (also shown when nothing is active any more). */
  lastError: string | null
  /** Ticket payments that came in but could not be issued or refunded automatically. */
  refundsNeeded: number
  /** Which provider portal(s) those are in, e.g. ["Yoco"]. */
  refundProviders: string[]
}

const GENERIC_ERROR = "Something went wrong. Please try again."
const MAX_FIELD = 500

async function scope() {
  const check = await requireTenantPermission("settings.manage")
  if (!check.ok) return { ok: false as const, error: check.error }
  const db = getSupabaseServerClient()
  if (!db) return { ok: false as const, error: "The server isn't configured." }
  return { ok: true as const, db, tenantId: check.member.tenantId }
}

/** camelCase field name -> snake_case, for Vault secret names. */
const snake = (name: string) => name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/[^a-z0-9_]/g, "")

export async function loadPaymentSettings(): Promise<ActionResult<PaymentSettings>> {
  const s = await scope()
  if (!s.ok) return s

  const { data: rows, error } = await s.db
    .from("tenant_payment_integrations")
    .select("provider, status, mode, key_hint, last_error, last_event_at, updated_at")
    .eq("tenant_id", s.tenantId)
    .order("updated_at", { ascending: false })
  if (error) return { ok: false, error: GENERIC_ERROR }

  const { data: owed, error: owedError } = await s.db
    .from("tenant_payments")
    .select("provider")
    .eq("tenant_id", s.tenantId)
    .eq("status", "refund_needed")
    .limit(500)
  if (owedError) return { ok: false, error: GENERIC_ERROR }

  const active = (rows ?? []).find((r) => r.status === "active") ?? null
  const latest = active ?? (rows ?? [])[0] ?? null

  return {
    ok: true,
    data: {
      providers: listProviders().map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        disconnectNote: p.disconnectNote,
        fields: p.fields.map((f) => ({ ...f })),
      })),
      active: active
        ? {
            provider: active.provider as string,
            label: getProvider(active.provider as string)?.label ?? (active.provider as string),
            mode: (active.mode as "test" | "live" | null) ?? null,
            keyHint: (active.key_hint as string | null) ?? null,
            lastEventAt: (active.last_event_at as string | null) ?? null,
          }
        : null,
      lastError: (latest?.last_error as string | null) ?? null,
      refundsNeeded: (owed ?? []).length,
      refundProviders: [...new Set((owed ?? []).map((r) => getProvider(r.provider as string)?.label ?? (r.provider as string)))],
    },
  }
}

export async function connectProvider(providerId: string, rawFields: Record<string, string>): Promise<ActionResult<{ mode: "test" | "live"; label: string }>> {
  const s = await scope()
  if (!s.ok) return s

  const provider = getProvider(providerId)
  if (!provider) return { ok: false, error: "That payment provider isn't available." }

  // Every field the provider asks for, trimmed and bounded. Nothing else from the browser is used.
  const fields: Record<string, string> = {}
  for (const f of provider.fields) {
    const value = typeof rawFields?.[f.name] === "string" ? rawFields[f.name].trim() : ""
    if (!value) return { ok: false, error: `Enter ${f.label}.` }
    if (value.length > MAX_FIELD) return { ok: false, error: `${f.label} is too long.` }
    fields[f.name] = value
  }

  try {
    getAppBaseUrl()
  } catch {
    return { ok: false, error: "The platform's public URL isn't configured yet, so payments can't be connected." }
  }

  // One active provider per shop. Replacing the SAME provider's credentials is fine; switching is not, until the old one is disconnected.
  const { data: current, error: currentError } = await s.db
    .from("tenant_payment_integrations")
    .select("provider")
    .eq("tenant_id", s.tenantId)
    .eq("status", "active")
    .maybeSingle()
  if (currentError) return { ok: false, error: GENERIC_ERROR }
  if (current && current.provider !== provider.id) {
    const other = getProvider(current.provider as string)?.label ?? (current.provider as string)
    return { ok: false, error: `${other} is already connected. Disconnect it first to switch to ${provider.label}.` }
  }

  // The row (and so the webhook URL) exists before we talk to the provider.
  const { data: row, error: rowError } = await s.db
    .from("tenant_payment_integrations")
    .upsert({ tenant_id: s.tenantId, provider: provider.id, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,provider" })
    .select("id, status")
    .single()
  if (rowError || !row) return { ok: false, error: GENERIC_ERROR }
  const integrationId = row.id as string

  // The provider proves the credentials work before anything is saved.
  let result
  try {
    result = await provider.connect({ integrationId, fields, webhookUrl: webhookUrlFor(provider.id, integrationId) })
  } catch (error) {
    if (row.status === "pending") await s.db.from("tenant_payment_integrations").delete().eq("id", integrationId)
    if (error instanceof ConnectInputError) return { ok: false, error: error.message }
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) return { ok: false, error: provider.invalidCredentialsMessage }
    console.error("[payments] connect failed", { tenantId: s.tenantId, provider: provider.id, error: error instanceof Error ? error.message : String(error) })
    return { ok: false, error: `Couldn't reach ${provider.label} to connect. Please try again in a moment.` }
  }

  // Secrets go to Vault under names the database function accepts: payments_<provider>_<field>_<integration id>.
  const names = Object.keys(result.secrets)
  const stored = await Promise.all(
    names.map((name) =>
      s.db.rpc("payments_vault_put_secret", {
        p_name: `payments_${provider.id}_${provider.vaultNames?.[name] ?? snake(name)}_${integrationId}`,
        p_secret: result.secrets[name],
        p_description: `${provider.label} ${name}`,
      }),
    ),
  )
  if (stored.some((r) => r.error || !r.data)) {
    console.error("[payments] vault write failed", { tenantId: s.tenantId, provider: provider.id })
    return { ok: false, error: GENERIC_ERROR }
  }
  const secretIds: Record<string, string> = {}
  names.forEach((name, i) => { secretIds[name] = stored[i].data as string })

  const { error: saveError } = await s.db
    .from("tenant_payment_integrations")
    .update({
      status: "active",
      mode: result.mode,
      key_hint: result.keyHint,
      secret_ids: secretIds,
      config: result.config,
      // The two legacy columns are kept in step, so rolling the app back to the Yoco-only code still works.
      secret_key_secret_id: secretIds.secretKey ?? null,
      webhook_secret_id: secretIds.webhookSecret ?? null,
      provider_webhook_id: result.providerWebhookId,
      last_error: null,
      last_error_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", integrationId)
    .eq("tenant_id", s.tenantId)
  if (saveError) {
    if ((saveError as { code?: string }).code === "23505") {
      // Two connects raced; the database's one-active-provider rule won. Undo this one.
      await s.db.rpc("payments_disconnect", { p_integration_id: integrationId })
      return { ok: false, error: "Another payment provider was connected at the same time. Disconnect it first, then try again." }
    }
    return { ok: false, error: GENERIC_ERROR }
  }

  return { ok: true, data: { mode: result.mode, label: provider.label } }
}

export async function disconnectProvider(): Promise<ActionResult> {
  const s = await scope()
  if (!s.ok) return s
  const { data: rows, error } = await s.db
    .from("tenant_payment_integrations")
    .select("id, provider, provider_webhook_id")
    .eq("tenant_id", s.tenantId)
    .neq("status", "disabled")
  if (error) return { ok: false, error: GENERIC_ERROR }
  for (const row of rows ?? []) {
    // Remove our webhook from the shop's account at the provider too, while we still hold the credentials.
    // Best effort: if the provider can't be reached or it is already gone, we still disconnect (the owner can
    // delete a leftover in their portal).
    const provider = getProvider(row.provider as string)
    if (provider?.removeWebhook && row.provider_webhook_id) {
      try {
        const connection = await getIntegrationConnection(s.db, row.id as string)
        if (connection) await provider.removeWebhook({ connection, providerWebhookId: row.provider_webhook_id as string })
      } catch {
        /* ignore */
      }
    }
    const { error: rpcError } = await s.db.rpc("payments_disconnect", { p_integration_id: row.id })
    if (rpcError) return { ok: false, error: GENERIC_ERROR }
  }
  return { ok: true, data: undefined }
}
