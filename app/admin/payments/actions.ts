"use server"

// app/admin/payments/actions.ts
//
// Server Actions for "Settings > Payments": connect / disconnect the shop's OWN Yoco account.
// Same layers as app/admin/events/actions.ts:
//   1. requireTenantPermission("settings.manage") proves the signed-in user may manage THIS shop's
//      settings. The tenantId comes from their membership, never from the browser.
//   2. All writes use the service-role client, always filtered by that tenantId (the three payment tables
//      have no write policies, so a browser can never touch them directly).
//   3. The secret key travels: browser -> this action (HTTPS) -> Yoco (to prove it works) -> Vault.
//      It is never logged, never stored in a normal table, and never sent back: the screen only ever
//      gets the last 4 characters.

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { getAppBaseUrl } from "@/lib/payments/credentials"
import { isYocoSecretKey, yocoModeFromKey, yocoRegisterWebhook, YocoError } from "@/lib/payments/yoco"

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

export interface PaymentSettings {
  connected: boolean
  status: "pending" | "active" | "disabled" | "error" | null
  mode: "test" | "live" | null
  /** Last 4 characters of the saved secret key. Never the key. */
  keyHint: string | null
  lastError: string | null
  lastEventAt: string | null
  /** Ticket payments that came in but could not be issued or refunded automatically. */
  refundsNeeded: number
}

const GENERIC_ERROR = "Something went wrong. Please try again."

async function scope() {
  const check = await requireTenantPermission("settings.manage")
  if (!check.ok) return { ok: false as const, error: check.error }
  const db = getSupabaseServerClient()
  if (!db) return { ok: false as const, error: "The server isn't configured." }
  return { ok: true as const, db, tenantId: check.member.tenantId }
}

export async function loadPaymentSettings(): Promise<ActionResult<PaymentSettings>> {
  const s = await scope()
  if (!s.ok) return s
  const { data, error } = await s.db
    .from("tenant_payment_integrations")
    .select("status, mode, key_hint, last_error, last_event_at")
    .eq("tenant_id", s.tenantId)
    .eq("provider", "yoco")
    .maybeSingle()
  if (error) return { ok: false, error: GENERIC_ERROR }
  const { count: refundsNeeded } = await s.db
    .from("tenant_payments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", s.tenantId)
    .eq("status", "refund_needed")
  if (!data) return { ok: true, data: { connected: false, status: null, mode: null, keyHint: null, lastError: null, lastEventAt: null, refundsNeeded: refundsNeeded ?? 0 } }
  return {
    ok: true,
    data: {
      connected: data.status === "active",
      status: data.status as PaymentSettings["status"],
      mode: (data.mode as PaymentSettings["mode"]) ?? null,
      keyHint: (data.key_hint as string | null) ?? null,
      lastError: (data.last_error as string | null) ?? null,
      lastEventAt: (data.last_event_at as string | null) ?? null,
      refundsNeeded: refundsNeeded ?? 0,
    },
  }
}

export async function connectYoco(secretKeyRaw: string): Promise<ActionResult<{ mode: "test" | "live" }>> {
  const s = await scope()
  if (!s.ok) return s

  const secretKey = (secretKeyRaw ?? "").trim()
  if (!isYocoSecretKey(secretKey)) {
    return { ok: false, error: "That doesn't look like a Yoco secret key. It starts with sk_test_ or sk_live_." }
  }
  const mode = yocoModeFromKey(secretKey)

  let base: string
  try {
    base = getAppBaseUrl()
  } catch {
    return { ok: false, error: "The platform's public URL isn't configured yet, so payments can't be connected." }
  }

  // The row (and so the webhook URL) exists before we talk to Yoco.
  const { data: row, error: rowError } = await s.db
    .from("tenant_payment_integrations")
    .upsert({ tenant_id: s.tenantId, provider: "yoco", updated_at: new Date().toISOString() }, { onConflict: "tenant_id,provider" })
    .select("id, status")
    .single()
  if (rowError || !row) return { ok: false, error: GENERIC_ERROR }
  const integrationId = row.id as string

  // Registering the webhook is also the key check: Yoco rejects a bad key here, before anything is saved.
  let webhook: { id: string; secret: string }
  try {
    webhook = await yocoRegisterWebhook({ secretKey, name: "Passport payments", url: `${base}/api/webhooks/yoco/${integrationId}` })
  } catch (error) {
    if (row.status === "pending") await s.db.from("tenant_payment_integrations").delete().eq("id", integrationId)
    if (error instanceof YocoError && (error.status === 401 || error.status === 403)) {
      return { ok: false, error: "Yoco didn't accept that key. Check you copied the secret key, not the public one." }
    }
    return { ok: false, error: "Couldn't reach Yoco to connect. Please try again in a moment." }
  }

  const [keyId, whsecId] = await Promise.all([
    s.db.rpc("payments_vault_put_secret", { p_name: `payments_yoco_key_${integrationId}`, p_secret: secretKey, p_description: "Yoco secret key" }),
    s.db.rpc("payments_vault_put_secret", { p_name: `payments_yoco_whsec_${integrationId}`, p_secret: webhook.secret, p_description: "Yoco webhook secret" }),
  ])
  if (keyId.error || whsecId.error || !keyId.data || !whsecId.data) {
    console.error("[payments] vault write failed", { tenantId: s.tenantId })
    return { ok: false, error: GENERIC_ERROR }
  }

  const { error: saveError } = await s.db
    .from("tenant_payment_integrations")
    .update({
      status: "active",
      mode,
      key_hint: secretKey.slice(-4),
      secret_key_secret_id: keyId.data as string,
      webhook_secret_id: whsecId.data as string,
      provider_webhook_id: webhook.id,
      last_error: null,
      last_error_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", integrationId)
    .eq("tenant_id", s.tenantId)
  if (saveError) return { ok: false, error: GENERIC_ERROR }

  return { ok: true, data: { mode } }
}

export async function disconnectYoco(): Promise<ActionResult> {
  const s = await scope()
  if (!s.ok) return s
  const { data: row } = await s.db
    .from("tenant_payment_integrations")
    .select("id")
    .eq("tenant_id", s.tenantId)
    .eq("provider", "yoco")
    .maybeSingle()
  if (!row) return { ok: true, data: undefined }
  const { error } = await s.db.rpc("payments_disconnect", { p_integration_id: row.id })
  if (error) return { ok: false, error: GENERIC_ERROR }
  return { ok: true, data: undefined }
}
