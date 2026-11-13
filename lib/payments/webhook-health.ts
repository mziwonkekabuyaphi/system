// lib/payments/webhook-health.ts
/**
 * Keeps each shop's Yoco webhook alive.
 *
 * WHY: the webhook is the only thing that credits a Passport or issues tickets. Yoco switches a webhook
 * off after 5 days with no successful delivery, and "a new one must be registered". Nobody would notice
 * until a customer paid and nothing happened.
 *
 * WHAT (per active Yoco connection, using the shop's OWN key):
 *   1. Ask Yoco which webhooks exist on the account (GET /webhooks).
 *   2. Ours present (same id AND same URL): healthy. Any OTHER webhook with exactly our URL is a leftover
 *      from an earlier "Replace key" (it would send events we can't verify): delete it.
 *   3. Ours missing (deleted in the Yoco portal, or Yoco removed it): register a new one, store the new
 *      signing secret in Vault, and save the new webhook id. Self-healing, no owner action needed.
 *   4. Yoco rejects the key (revoked / rotated): switch the connection to 'error' so customers are no
 *      longer offered card payment, and tell the owner to reconnect in Settings > Payments.
 *   5. Yoco unreachable / any other failure: change nothing and try again on the next run.
 *
 * LIMIT (Yoco's list has no status field): a webhook Yoco has switched off but still lists cannot be
 * told apart from a healthy one here. That case is only caught if Yoco also drops it from the list.
 *
 * Secrets are never logged. Server only.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { getAppBaseUrl, getIntegrationConnection, webhookUrlFor } from "./credentials"
import { YocoError, yocoDeleteWebhook, yocoListWebhooks, yocoRegisterWebhook } from "./yoco"

export type HealthOutcome = "healthy" | "cleaned_duplicates" | "re_registered" | "key_rejected" | "skipped" | "failed"

export interface HealthSummary {
  checked: number
  healthy: number
  reRegistered: number
  duplicatesRemoved: number
  keyRejected: number
  skipped: number
  failed: number
}

async function checkOne(db: SupabaseClient, integration: { id: string; tenant_id: string; provider_webhook_id: string | null }): Promise<{ outcome: HealthOutcome; removed: number }> {
  // The shop's own Yoco key, read by integration id (works the same whatever other provider a shop may use later).
  const connection = await getIntegrationConnection(db, integration.id)
  const secretKey = connection?.secrets.secretKey
  if (!connection || connection.provider !== "yoco" || connection.status !== "active" || !secretKey) return { outcome: "skipped", removed: 0 }
  const creds = { secretKey }

  const url = webhookUrlFor("yoco", integration.id)

  let subs
  try {
    subs = await yocoListWebhooks(creds.secretKey)
  } catch (error) {
    if (error instanceof YocoError && (error.status === 401 || error.status === 403)) {
      await db
        .from("tenant_payment_integrations")
        .update({
          status: "error",
          last_error: "Yoco no longer accepts the saved key, so card payments are switched off. Reconnect Yoco in Settings > Payments.",
          last_error_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", integration.id)
      return { outcome: "key_rejected", removed: 0 }
    }
    return { outcome: "skipped", removed: 0 } // Yoco down or slow: try again next run
  }

  const ours = subs.find((w) => w.id === integration.provider_webhook_id && w.url === url)

  if (ours) {
    let removed = 0
    for (const stale of subs.filter((w) => w.url === url && w.id !== ours.id)) {
      try {
        await yocoDeleteWebhook(creds.secretKey, stale.id)
        removed += 1
      } catch {
        /* leave it; harmless, retried next run */
      }
    }
    return { outcome: removed > 0 ? "cleaned_duplicates" : "healthy", removed }
  }

  // Ours is gone: register a fresh one. Delete any same-URL leftovers first so Yoco doesn't hold two.
  for (const stale of subs.filter((w) => w.url === url)) {
    await yocoDeleteWebhook(creds.secretKey, stale.id).catch(() => undefined)
  }
  try {
    const webhook = await yocoRegisterWebhook({ secretKey: creds.secretKey, name: "Passport payments", url })
    const { data: secretId, error: vaultError } = await db.rpc("payments_vault_put_secret", {
      p_name: `payments_yoco_whsec_${integration.id}`,
      p_secret: webhook.secret,
      p_description: "Yoco webhook secret",
    })
    if (vaultError || !secretId) throw new Error("vault write failed")
    // The database reads `secret_ids` first and only falls back to the legacy webhook_secret_id column when
    // secret_ids is empty (payments_secret_ids). Keep BOTH current, or the new webhook would be verified
    // against the OLD secret and every payment notice would be rejected.
    const { data: current } = await db.from("tenant_payment_integrations").select("secret_ids").eq("id", integration.id).maybeSingle()
    const ids = (current?.secret_ids ?? {}) as Record<string, string>
    const secretIds = Object.keys(ids).length > 0 ? { secret_ids: { ...ids, webhookSecret: secretId as string } } : {}
    const { error: saveError } = await db
      .from("tenant_payment_integrations")
      .update({ webhook_secret_id: secretId as string, ...secretIds, provider_webhook_id: webhook.id, updated_at: new Date().toISOString() })
      .eq("id", integration.id)
    if (saveError) throw new Error("save failed")
    return { outcome: "re_registered", removed: 0 }
  } catch (error) {
    await db
      .from("tenant_payment_integrations")
      .update({
        last_error: "Your Yoco webhook was missing and we couldn't re-create it automatically. Card payments may not be credited. Reconnect Yoco in Settings > Payments.",
        last_error_at: new Date().toISOString(),
      })
      .eq("id", integration.id)
    console.error("[webhook-health] re-registration failed", { integrationId: integration.id, error: error instanceof Error ? error.message : String(error) })
    return { outcome: "failed", removed: 0 }
  }
}

export async function runWebhookHealthCheck(db: SupabaseClient): Promise<HealthSummary> {
  const summary: HealthSummary = { checked: 0, healthy: 0, reRegistered: 0, duplicatesRemoved: 0, keyRejected: 0, skipped: 0, failed: 0 }

  getAppBaseUrl() // fail early (throws) if the public URL isn't configured
  const { data, error } = await db
    .from("tenant_payment_integrations")
    .select("id, tenant_id, provider_webhook_id")
    .eq("provider", "yoco")
    .eq("status", "active")
  if (error) throw new Error(`Failed to list integrations: ${error.message}`)

  for (const row of (data ?? []) as Array<{ id: string; tenant_id: string; provider_webhook_id: string | null }>) {
    summary.checked += 1
    try {
      const { outcome, removed } = await checkOne(db, row)
      summary.duplicatesRemoved += removed
      if (outcome === "healthy" || outcome === "cleaned_duplicates") summary.healthy += 1
      else if (outcome === "re_registered") summary.reRegistered += 1
      else if (outcome === "key_rejected") summary.keyRejected += 1
      else if (outcome === "skipped") summary.skipped += 1
      else summary.failed += 1
    } catch (error) {
      summary.failed += 1
      console.error("[webhook-health] check failed", { integrationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return summary
}
