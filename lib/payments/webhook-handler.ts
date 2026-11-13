// lib/payments/webhook-handler.ts
/**
 * The ONE webhook pipeline for every provider. The route files (app/api/webhooks/...) only pass the request
 * and the provider id in; this decides what happens. It is the only place a payment turns into money in a
 * Passport or tickets (through settle.ts).
 *
 * Before anything is credited (each step fails closed):
 *   1. The integration exists, is ACTIVE, belongs to THIS provider, and we can read its secrets from Vault.
 *   2. The provider's own signature check passes against the RAW body (the adapter does this).
 *   3. This delivery id has not been processed before (providers retry; a replay does nothing).
 *   4. settle.ts then matches the checkout to a payment we created, the exact amount and currency, and
 *      applies it through idempotent database functions.
 *
 * A "failed" notice is deliberately NOT acted on: a customer can retry and then succeed, and failing the
 * payment on the first failure would make that later success un-creditable. It is only logged.
 *
 * Responses: 2xx = "received, stop retrying". Non-2xx (400 bad signature, 500 our error) = the provider retries.
 * Providers expect an answer within seconds, so nothing slow runs here.
 */

import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getIntegrationConnection } from "./credentials"
import { getProvider } from "./providers"
import { recordProblem, settleSucceeded } from "./settle"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function handleProviderWebhook(req: Request, providerId: string, integrationId: string): Promise<NextResponse> {
  const provider = getProvider(providerId)
  if (!provider || !UUID_RE.test(integrationId)) return NextResponse.json({ error: "not_found" }, { status: 404 })
  const tag = `[${provider.id}-webhook]`

  const rawBody = await req.text()
  const db = getSupabaseServerClient()
  if (!db) return NextResponse.json({ error: "server_unavailable" }, { status: 500 })

  // 1. Whose webhook is this, and what are their secrets?
  let connection
  try {
    connection = await getIntegrationConnection(db, integrationId)
  } catch (error) {
    console.error(`${tag} credential lookup failed`, { integrationId, error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "server_error" }, { status: 500 })
  }
  // Unknown id, a disconnected integration, or an id that belongs to a different provider: all look the same from outside.
  if (!connection || connection.status !== "active" || connection.provider !== provider.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // 2. Signature, over the raw body, by the provider's own rules.
  const verified = provider.verifyWebhook({ rawBody, headers: req.headers, connection })
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason === "bad_body" ? "invalid_body" : "invalid_signature" }, { status: 400 })
  }
  const event = verified.event
  const { deliveryId } = event

  // 3. Replay / retry protection.
  const { error: dupError } = await db
    .from("payment_webhook_events")
    .insert({ provider: provider.id, webhook_id: deliveryId, integration_id: integrationId, event_type: event.eventType })
  if (dupError) {
    if ((dupError as { code?: string }).code === "23505") return NextResponse.json({ received: true, duplicate: true })
    console.error(`${tag} could not record event`, { integrationId, error: dupError.message })
    return NextResponse.json({ error: "server_error" }, { status: 500 })
  }
  await db.from("tenant_payment_integrations").update({ last_event_at: new Date().toISOString() }).eq("id", integrationId)

  let outcome = "ignored"
  try {
    if (event.type === "succeeded") {
      outcome = await settleSucceeded({ db, provider, connection, event, deliveryId })
    } else if (event.type === "failed") {
      outcome = "failed_attempt_logged" // see header: never fail the payment here
    }
  } catch (error) {
    // Let the provider retry. The delivery row is removed so the retry isn't mistaken for a duplicate.
    await db.from("payment_webhook_events").delete().eq("provider", provider.id).eq("webhook_id", deliveryId)
    await recordProblem(db, integrationId, "Could not apply a payment. It will be retried.")
    console.error(`${tag} handling failed`, { integrationId, error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "server_error" }, { status: 500 })
  }

  await db.from("payment_webhook_events").update({ outcome }).eq("provider", provider.id).eq("webhook_id", deliveryId)
  return NextResponse.json({ received: true })
}
