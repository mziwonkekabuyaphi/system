// lib/whatsapp/embedded-signup/connect.ts
/**
 * The server-side half of WhatsApp Embedded Signup: turns what the Meta
 * popup handed the browser (a one-time code + the WABA / phone number ids)
 * into a working, saved, verified connection for ONE tenant.
 *
 * SERVER ONLY. Not a "use server" file. The only caller is
 * app/onboarding/whatsapp/actions.ts, which has already worked out the
 * tenant from the signed-in user and checked owner role, plan and nonce.
 * `tenantId` is therefore trusted here and must NEVER come from the browser.
 *
 * STEPS (each safe to repeat; a retry just redoes them):
 *   1. Exchange the code for the customer's business token (code lives 30 s).
 *   2. Ask Meta (debug_token) whether that token belongs to OUR app and really
 *      covers the WABA the browser claimed. Nothing is saved before this passes.
 *   3. Ask Meta whether the phone number belongs to that WABA.
 *   4. Put the token (and the number's PIN) in Vault; never in a table column.
 *   5. Save the row as pending_verification (a reconnect of an already-active
 *      number keeps it active).
 *   6. Subscribe the WABA to this app's webhooks.
 *   7. Register the number with a 6-digit PIN.
 *   8. Only now mark it active. If anything above failed, the row stays
 *      pending with a short last_error the settings panel can show.
 *
 * Template submission is a separate follow-up (setUpWhatsAppTemplatesAction)
 * because the existing template code needs an ACTIVE integration.
 *
 * KNOWN LIMIT: one PIN secret per tenant. Replacing a number with a different
 * one overwrites the stored PIN of the old (now disabled) number.
 */

import { randomInt } from "crypto"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { GraphError, asRecord, graphRequest } from "./graph"

export type ConnectErrorCode =
  | "not_configured"
  | "bad_input"
  | "another_number_active"
  | "exchange_failed"
  | "token_invalid"
  | "scope_mismatch"
  | "phone_not_in_waba"
  | "phone_in_use"
  | "waba_in_use"
  | "save_failed"
  | "subscribe_failed"
  | "register_failed"
  | "activate_failed"

export interface ConnectInput {
  tenantId: string
  code: string
  wabaId: string
  phoneNumberId: string
  /** The owner confirmed they may replace a different, currently active number. */
  replace: boolean
}

export type ConnectResult =
  | { ok: true; integrationId: string; displayPhone: string | null }
  | { ok: false; code: ConnectErrorCode; message: string }

class ConnectFailure extends Error {
  readonly code: ConnectErrorCode
  constructor(code: ConnectErrorCode, message: string) {
    super(message)
    this.name = "ConnectFailure"
    this.code = code
  }
}

const ID_PATTERN = /^\d{5,30}$/
const MAX_ERROR_LENGTH = 300

function readConfig() {
  const appId = (process.env.NEXT_PUBLIC_META_APP_ID ?? "").trim()
  const secrets = (process.env.WHATSAPP_APP_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return { appId, secrets }
}

function extractToken(result: unknown): string | null {
  if (typeof result === "string") {
    const token = result.trim()
    return token && !token.startsWith("{") ? token : null
  }
  const token = asRecord(result)?.access_token
  return typeof token === "string" && token ? token : null
}

/** Tries each configured app secret (there can be two while moving between apps). */
async function exchangeCode(appId: string, secrets: string[], code: string): Promise<{ token: string; secret: string }> {
  let lastError: GraphError | null = null
  for (const secret of secrets) {
    try {
      const result = await graphRequest("oauth/access_token", {
        query: { client_id: appId, client_secret: secret, code },
      })
      const token = extractToken(result)
      if (token) return { token, secret }
    } catch (error) {
      if (error instanceof GraphError) lastError = error
      else throw error
    }
  }
  throw new ConnectFailure(
    "exchange_failed",
    lastError
      ? `Meta wouldn't accept the sign-up code (${lastError.message}). Please try again.`
      : "Meta didn't return an access token. Please try again.",
  )
}

/** The token must be valid, belong to OUR app, and be granted for this exact WABA. */
async function assertTokenCoversWaba(appId: string, secret: string, token: string, wabaId: string): Promise<void> {
  let data: Record<string, unknown> | null
  try {
    const result = await graphRequest("debug_token", {
      query: { input_token: token, access_token: `${appId}|${secret}` },
    })
    data = asRecord(asRecord(result)?.data)
  } catch (error) {
    const detail = error instanceof GraphError ? error.message : "unknown error"
    throw new ConnectFailure("token_invalid", `Couldn't verify the access token with Meta (${detail}).`)
  }

  if (!data || data.is_valid !== true || String(data.app_id) !== appId) {
    throw new ConnectFailure("token_invalid", "Meta says this access token isn't valid for this app. Please try again.")
  }

  const granular = (Array.isArray(data.granular_scopes) ? data.granular_scopes : []).map(asRecord)
  const management = granular.find((g) => g?.scope === "whatsapp_business_management")
  const targets = Array.isArray(management?.target_ids) ? (management?.target_ids as unknown[]).map(String) : []
  const hasMessaging =
    granular.some((g) => g?.scope === "whatsapp_business_messaging") ||
    (Array.isArray(data.scopes) && (data.scopes as unknown[]).includes("whatsapp_business_messaging"))

  if (!targets.includes(wabaId) || !hasMessaging) {
    console.error("[whatsapp-connect] token does not cover the claimed WABA", {
      granularScopes: granular.map((g) => g?.scope),
      managementTargetCount: targets.length,
      hasMessaging,
    })
    throw new ConnectFailure(
      "scope_mismatch",
      "The WhatsApp account you picked isn't covered by the permissions Meta granted. Nothing was saved. Please try again and approve all the permissions.",
    )
  }

  console.log("[whatsapp-connect] token validated", { expiresAt: data.expires_at ?? null })
}

async function readPhoneNumber(token: string, wabaId: string, phoneNumberId: string): Promise<string | null> {
  let list: unknown[] = []
  try {
    const result = await graphRequest(`${wabaId}/phone_numbers`, {
      token,
      query: { fields: "id,display_phone_number", limit: "50" },
    })
    const data = asRecord(result)?.data
    list = Array.isArray(data) ? data : []
  } catch (error) {
    const detail = error instanceof GraphError ? error.message : "unknown error"
    throw new ConnectFailure("phone_not_in_waba", `Couldn't read the phone numbers on that WhatsApp account (${detail}).`)
  }

  const match = list.map(asRecord).find((p) => p?.id === phoneNumberId)
  if (!match) {
    throw new ConnectFailure("phone_not_in_waba", "That phone number doesn't belong to the WhatsApp account you picked. Nothing was saved.")
  }
  return typeof match.display_phone_number === "string" ? match.display_phone_number : null
}

type Supabase = ReturnType<typeof getSupabaseServerClient>

async function putSecret(supabase: Supabase, name: string, secret: string, description: string): Promise<string> {
  const { data, error } = await supabase.rpc("whatsapp_vault_put_secret", {
    p_name: name,
    p_secret: secret,
    p_description: description,
  })
  if (error || typeof data !== "string") {
    console.error("[whatsapp-connect] vault write failed", { name, error: error?.message })
    throw new ConnectFailure("save_failed", "Couldn't store the connection securely. Please try again.")
  }
  return data
}

/** Re-uses the PIN already stored for this number (a number keeps the PIN it was registered with). */
async function getOrCreatePin(supabase: Supabase, tenantId: string, phoneNumberId: string): Promise<{ pin: string; secretId: string }> {
  const { data: existing } = await supabase
    .from("tenant_whatsapp_integrations")
    .select("pin_secret_id")
    .eq("tenant_id", tenantId)
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle()

  if (existing?.pin_secret_id) {
    const { data: stored } = await supabase.rpc("get_secret_by_id", { p_secret_id: existing.pin_secret_id })
    if (typeof stored === "string" && /^\d{6}$/.test(stored)) {
      return { pin: stored, secretId: existing.pin_secret_id as string }
    }
  }

  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const secretId = await putSecret(supabase, `whatsapp_pin_${tenantId}`, pin, "WhatsApp number two-step PIN")
  return { pin, secretId }
}

async function recordError(supabase: Supabase, tenantId: string, integrationId: string, message: string): Promise<void> {
  const { error } = await supabase
    .from("tenant_whatsapp_integrations")
    .update({ last_error: message.slice(0, MAX_ERROR_LENGTH), last_error_at: new Date().toISOString() })
    .eq("id", integrationId)
    .eq("tenant_id", tenantId)
  if (error) console.error("[whatsapp-connect] couldn't record error", { integrationId, error: error.message })
}

function mapSqlError(message: string, fallback: ConnectErrorCode): ConnectFailure {
  if (message.includes("phone_in_use")) {
    return new ConnectFailure("phone_in_use", "That WhatsApp number is already connected to another business on ZozoQueue.")
  }
  if (message.includes("waba_in_use")) {
    return new ConnectFailure("waba_in_use", "That WhatsApp Business account is already connected to another business on ZozoQueue.")
  }
  if (message.includes("another_number_active")) {
    return new ConnectFailure("another_number_active", "This business already has a different active WhatsApp number.")
  }
  return new ConnectFailure(fallback, "Couldn't save the connection. Please try again.")
}

export async function connectWhatsApp(input: ConnectInput): Promise<ConnectResult> {
  const { tenantId, code, wabaId, phoneNumberId, replace } = input

  if (!ID_PATTERN.test(wabaId) || !ID_PATTERN.test(phoneNumberId) || !code || code.length > 2000) {
    return { ok: false, code: "bad_input", message: "The sign-up details from Meta looked incomplete. Please try again." }
  }

  const { appId, secrets } = readConfig()
  if (!appId || secrets.length === 0) {
    return { ok: false, code: "not_configured", message: "WhatsApp connection isn't set up on this platform yet." }
  }

  const supabase = getSupabaseServerClient()
  let integrationId: string | null = null

  try {
    // Refuse BEFORE spending the 30-second code if this would silently swap out a live number.
    if (!replace) {
      const { data: active } = await supabase
        .from("tenant_whatsapp_integrations")
        .select("phone_number_id")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
        .maybeSingle()
      if (active && active.phone_number_id !== phoneNumberId) {
        throw new ConnectFailure("another_number_active", "This business already has a different active WhatsApp number.")
      }
    }

    const { token, secret } = await exchangeCode(appId, secrets, code)
    await assertTokenCoversWaba(appId, secret, token, wabaId)
    const displayPhone = await readPhoneNumber(token, wabaId, phoneNumberId)

    const tokenSecretId = await putSecret(supabase, `whatsapp_token_${tenantId}`, token, "WhatsApp access token (Embedded Signup)")
    const { pin, secretId: pinSecretId } = await getOrCreatePin(supabase, tenantId, phoneNumberId)

    const { data: savedId, error: saveError } = await supabase.rpc("whatsapp_connect_save", {
      p_tenant_id: tenantId,
      p_phone_number_id: phoneNumberId,
      p_waba_id: wabaId,
      p_display_phone: displayPhone,
      p_token_secret_id: tokenSecretId,
      p_pin_secret_id: pinSecretId,
    })
    if (saveError || typeof savedId !== "string") {
      throw mapSqlError(saveError?.message ?? "", "save_failed")
    }
    integrationId = savedId

    try {
      const subscribed = asRecord(await graphRequest(`${wabaId}/subscribed_apps`, { method: "POST", token }))
      if (subscribed?.success !== true) throw new Error("Meta did not confirm the subscription.")
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error"
      throw new ConnectFailure("subscribe_failed", `Couldn't connect this WhatsApp account to ZozoQueue (${detail}).`)
    }

    try {
      const registered = asRecord(
        await graphRequest(`${phoneNumberId}/register`, {
          method: "POST",
          token,
          body: { messaging_product: "whatsapp", pin },
        }),
      )
      if (registered?.success !== true) throw new Error("Meta did not confirm the registration.")
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error"
      throw new ConnectFailure(
        "register_failed",
        `Couldn't register the phone number (${detail}). If it already has a two-step PIN, turn that off in WhatsApp Manager and try again.`,
      )
    }

    const { error: activateError } = await supabase.rpc("whatsapp_connect_activate", {
      p_tenant_id: tenantId,
      p_integration_id: integrationId,
      p_replace: replace,
    })
    if (activateError) {
      const mapped = mapSqlError(activateError.message, "activate_failed")
      throw mapped
    }

    console.log("[whatsapp-connect] connected", { tenantId, integrationId })
    return { ok: true, integrationId, displayPhone }
  } catch (error) {
    const failure =
      error instanceof ConnectFailure
        ? error
        : new ConnectFailure("save_failed", "Something went wrong while connecting WhatsApp. Please try again.")
    if (!(error instanceof ConnectFailure)) {
      console.error("[whatsapp-connect] unexpected error", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    } else {
      console.error("[whatsapp-connect] failed", { tenantId, code: failure.code, message: failure.message })
    }
    if (integrationId) await recordError(supabase, tenantId, integrationId, failure.message)
    return { ok: false, code: failure.code, message: failure.message }
  }
}
