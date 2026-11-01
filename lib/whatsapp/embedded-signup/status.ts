// lib/whatsapp/embedded-signup/status.ts
/**
 * Works out, for the SIGNED-IN user only:
 *   - which tenant they act as and whether they may connect WhatsApp
 *     (getConnectContext), and
 *   - what that tenant's WhatsApp connection currently looks like
 *     (loadConnectionStatus).
 *
 * The tenant always comes from getCurrentTenantMember() (the signed-in user's
 * active tenant_members row). Nothing here takes a tenant id from the browser.
 * Server only; not a "use server" file.
 */

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getCurrentTenantMember, getSessionUser } from "@/lib/tenant/current-tenant-member"
import { MODULE_KEYS, tenantHasModule } from "@/lib/services/plans"
import { asRecord, getGraphVersion, graphRequest } from "./graph"

export interface ConnectConfig {
  appId: string
  configId: string
  graphVersion: string
}

/** Why a signed-in tenant member can't start a connection right now. */
export type ConnectBlock = "not_owner" | "plan" | "not_configured"

export type ConnectContext =
  | { ok: false; reason: "signed_out" | "no_tenant" }
  | { ok: true; tenantId: string; isOwner: boolean; block: null; config: ConnectConfig }
  | { ok: true; tenantId: string; isOwner: boolean; block: ConnectBlock; config: null }

export async function getConnectContext(): Promise<ConnectContext> {
  const member = await getCurrentTenantMember()
  if (!member) {
    return { ok: false, reason: (await getSessionUser()) ? "no_tenant" : "signed_out" }
  }

  const isOwner = member.roleKey === "tenant_owner"
  if (!isOwner) return { ok: true, tenantId: member.tenantId, isOwner, block: "not_owner", config: null }

  // Plan entitlement is the source of truth (plan_modules), same as the rest of the app.
  // Fails closed: if the plan can't be checked, the tenant can't connect.
  let allowed = false
  try {
    allowed = await tenantHasModule(getSupabaseServerClient(), member.tenantId, MODULE_KEYS.whatsapp)
  } catch (error) {
    console.error("[whatsapp-connect] plan check failed", { error: error instanceof Error ? error.message : "unknown" })
  }
  if (!allowed) return { ok: true, tenantId: member.tenantId, isOwner, block: "plan", config: null }

  const appId = (process.env.NEXT_PUBLIC_META_APP_ID ?? "").trim()
  const configId = (process.env.NEXT_PUBLIC_META_ES_CONFIG_ID ?? "").trim()
  const hasSecret = (process.env.WHATSAPP_APP_SECRET ?? "").split(",").some((s) => s.trim())
  if (!appId || !configId || !hasSecret) {
    return { ok: true, tenantId: member.tenantId, isOwner, block: "not_configured", config: null }
  }

  return {
    ok: true,
    tenantId: member.tenantId,
    isOwner,
    block: null,
    config: { appId, configId, graphVersion: getGraphVersion() },
  }
}

export type ConnectionState = "not_connected" | "pending" | "connected" | "error"

export interface ConnectionStatus {
  state: ConnectionState
  /** The number WhatsApp itself reports for this connection. If Meta couldn't be
   *  reached, the last stored label (see displayPhoneVerified). */
  displayPhone: string | null
  /** true = confirmed with Meta just now; false = only the stored label, not confirmed. */
  displayPhoneVerified: boolean
  phoneNumberId: string | null
  /** "embedded_signup", "manual" or null (set up by hand before self-connect existed). */
  connectedVia: string | null
  lastError: string | null
  lastErrorAt: string | null
}

interface IntegrationRow {
  phone_number_id: string
  access_token_secret_id: string | null
  display_phone_number: string | null
  status: "active" | "pending_verification" | "disabled"
  connected_via: string | null
  last_error: string | null
  last_error_at: string | null
}

/**
 * The number on screen must be the number WhatsApp really has for this
 * connection, not a label someone typed into the database. Asks Meta for the
 * display number of phone_number_id and, when it differs from what's stored,
 * corrects the stored label. Never throws and never blocks the page for long:
 * on any problem (no token, Meta unreachable, token expired) it falls back to
 * the stored label and says it is NOT confirmed.
 */
async function confirmNumberWithMeta(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  tenantId: string,
  row: IntegrationRow,
): Promise<{ number: string | null; verified: boolean }> {
  const fallback = { number: row.display_phone_number, verified: false }
  if (!row.access_token_secret_id) return fallback

  try {
    const { data: token } = await supabase.rpc("get_secret_by_id", { p_secret_id: row.access_token_secret_id })
    if (typeof token !== "string" || !token) return fallback

    const result = await graphRequest(row.phone_number_id, {
      token,
      query: { fields: "display_phone_number" },
      timeoutMs: 6000,
    })
    const live = asRecord(result)?.display_phone_number
    if (typeof live !== "string" || !live.trim()) return fallback

    if (live !== row.display_phone_number) {
      const { error } = await supabase
        .from("tenant_whatsapp_integrations")
        .update({ display_phone_number: live })
        .eq("tenant_id", tenantId)
        .eq("phone_number_id", row.phone_number_id)
      if (error) console.error("[whatsapp-connect] couldn't store the confirmed number", { tenantId, error: error.message })
    }
    return { number: live, verified: true }
  } catch (error) {
    // The token is never part of this message (graphRequest strips it).
    console.error("[whatsapp-connect] couldn't confirm the number with Meta", {
      tenantId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return fallback
  }
}

export async function loadConnectionStatus(tenantId: string): Promise<ConnectionStatus> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from("tenant_whatsapp_integrations")
    .select("phone_number_id, access_token_secret_id, display_phone_number, status, connected_via, last_error, last_error_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })

  if (error) {
    console.error("[whatsapp-connect] status lookup failed", { tenantId, error: error.message })
    throw new Error("Couldn't load the WhatsApp connection.")
  }

  const rows = (data ?? []) as IntegrationRow[]
  const active = rows.find((r) => r.status === "active")
  const pending = rows.find((r) => r.status === "pending_verification")
  const row = active ?? pending ?? null

  const state: ConnectionState = active ? "connected" : pending ? (pending.last_error ? "error" : "pending") : "not_connected"

  const confirmed = row ? await confirmNumberWithMeta(supabase, tenantId, row) : { number: null, verified: false }

  return {
    state,
    displayPhone: confirmed.number ?? row?.display_phone_number ?? null,
    displayPhoneVerified: confirmed.verified,
    phoneNumberId: row?.phone_number_id ?? null,
    connectedVia: row?.connected_via ?? null,
    lastError: row?.last_error ?? null,
    lastErrorAt: row?.last_error_at ?? null,
  }
}
