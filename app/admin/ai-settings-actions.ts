"use server"

// app/admin/ai-settings-actions.ts
/**
 * Owner-only actions behind Settings > AI.
 *
 * A tenant either brings their own AI provider key (BYOK: they pay the provider directly) or, for
 * shops QLess still hosts, runs on QLess-managed AI. Either way every request is metered per tenant
 * (see lib/ai/gateway.ts), and the shop can set a monthly spending limit.
 *
 * Key handling:
 *   - The key arrives in saveAiKey() over the server-action POST, is checked against the provider,
 *     and goes straight into Supabase Vault via ai_save_tenant_key() (service role only).
 *   - It is never returned, never logged, and never written to any table in plain text. The browser
 *     only ever sees the last 4 characters.
 */

import { getTenantAiStatus, invalidateTenantAiCache, redactSecrets } from "@/lib/ai/gateway"
import { getProvider, listProviders } from "@/lib/ai/providers"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"

type Result<T = object> = ({ success: true } & T) | { success: false; error: string }

export interface AiModelOption {
  id: string
  label: string
  inputUsdPer1m: number
  outputUsdPer1m: number
}

/** A vendor the owner can choose when adding a key, with the models listed for it. */
export interface AiProviderOption {
  id: string
  label: string
  keyHelpUrl: string
  keyPlaceholder: string
  models: AiModelOption[]
}

export interface AiUsageRow {
  purpose: string
  model: string
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  costZar: number
}

export interface AiSettingsDto {
  mode: "byok" | "managed"
  enabled: boolean
  provider: string
  providerLabel: string
  keyHelpUrl: string
  model: string
  models: AiModelOption[]
  /** Every supported vendor with its models, for choosing one when adding or replacing a key. */
  providers: AiProviderOption[]
  keyStatus: "none" | "active" | "invalid"
  keyLast4: string | null
  keySavedAt: string | null
  monthlyLimitZar: number | null
  warnAtPercent: number
  lastError: string | null
  lastErrorAt: string | null
  /** Why AI is off right now, or null when it can run. */
  blockedReason: string | null
  month: {
    periodStart: string
    requests: number
    errors: number
    inputTokens: number
    outputTokens: number
    costZar: number
    percentUsed: number | null
  }
  /** Last 30 days, grouped by what the AI was used for. */
  breakdown: AiUsageRow[]
}

const MAX_MONTHLY_LIMIT_ZAR = 1_000_000

async function ownerContext() {
  const { tenantId, roleKey } = await requireTenantMember()
  if (roleKey !== "tenant_owner") throw new Error("Only the shop owner can change AI settings.")
  return { tenantId, supabase: getSupabaseServerClient() }
}

/** requireTenantMember() redirects by throwing; that must reach Next, not be turned into an error string. */
function failure(error: unknown, fallback: string): { success: false; error: string } {
  const digest = (error as { digest?: unknown } | null)?.digest
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw error
  const message = error instanceof Error ? redactSecrets(error.message) : fallback
  return { success: false, error: message || fallback }
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function getAiSettings(): Promise<Result<{ settings: AiSettingsDto }>> {
  try {
    const { tenantId, supabase } = await ownerContext()

    const { data: row, error } = await supabase
      .from("tenant_ai_settings")
      .select("mode, enabled, provider, model, key_status, key_last4, key_saved_at, monthly_limit_zar, warn_at_percent, last_error, last_error_at")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (error) return { success: false, error: "Could not load AI settings." }
    if (!row) return { success: false, error: "AI settings are not set up for this shop yet. Contact support." }

    const provider = getProvider(row.provider)
    const { data: periodData } = await supabase.rpc("ai_period_start", { p_tenant_id: tenantId })
    const periodStart = typeof periodData === "string" ? periodData : new Date().toISOString().slice(0, 7) + "-01"

    const [pricing, monthly, breakdown, status] = await Promise.all([
      supabase
        .from("ai_model_pricing")
        .select("provider, model, display_name, input_usd_per_1m, output_usd_per_1m")
        .eq("is_active", true)
        .order("input_usd_per_1m", { ascending: true }),
      supabase
        .from("ai_usage_monthly")
        .select("requests, errors, input_tokens, output_tokens, cost_zar")
        .eq("tenant_id", tenantId)
        .eq("period_start", periodStart)
        .maybeSingle(),
      supabase.rpc("ai_usage_breakdown", { p_tenant_id: tenantId, p_days: 30 }),
      getTenantAiStatus(tenantId),
    ])

    const costZar = num(monthly.data?.cost_zar)
    const limit = row.monthly_limit_zar == null ? null : num(row.monthly_limit_zar)

    const toOption = (m: { model: unknown; display_name: unknown; input_usd_per_1m: unknown; output_usd_per_1m: unknown }): AiModelOption => ({
      id: String(m.model),
      label: String(m.display_name),
      inputUsdPer1m: num(m.input_usd_per_1m),
      outputUsdPer1m: num(m.output_usd_per_1m),
    })
    const pricingRows = pricing.data ?? []

    const settings: AiSettingsDto = {
      mode: row.mode === "managed" ? "managed" : "byok",
      enabled: row.enabled === true,
      provider: row.provider,
      providerLabel: provider?.label ?? row.provider,
      keyHelpUrl: provider?.keyHelpUrl ?? "",
      model: row.model,
      models: pricingRows.filter((m) => m.provider === row.provider).map(toOption),
      providers: listProviders()
        .map((p) => ({
          id: p.id,
          label: p.label,
          keyHelpUrl: p.keyHelpUrl,
          keyPlaceholder: p.keyPlaceholder,
          models: pricingRows.filter((m) => m.provider === p.id).map(toOption),
        }))
        .filter((p) => p.models.length > 0),
      keyStatus: row.key_status === "active" || row.key_status === "invalid" ? row.key_status : "none",
      keyLast4: row.key_last4 ?? null,
      keySavedAt: row.key_saved_at ?? null,
      monthlyLimitZar: limit,
      warnAtPercent: num(row.warn_at_percent) || 80,
      lastError: row.last_error ?? null,
      lastErrorAt: row.last_error_at ?? null,
      blockedReason: status.blockedReason,
      month: {
        periodStart,
        requests: num(monthly.data?.requests),
        errors: num(monthly.data?.errors),
        inputTokens: num(monthly.data?.input_tokens),
        outputTokens: num(monthly.data?.output_tokens),
        costZar,
        percentUsed: limit && limit > 0 ? Math.round((costZar / limit) * 10000) / 100 : null,
      },
      breakdown: ((breakdown.data as Record<string, unknown>[] | null) ?? []).map((b) => ({
        purpose: String(b.purpose),
        model: String(b.model),
        requests: num(b.requests),
        errors: num(b.errors),
        inputTokens: num(b.input_tokens),
        outputTokens: num(b.output_tokens),
        costZar: num(b.cost_zar),
      })),
    }
    return { success: true, settings }
  } catch (error) {
    return failure(error, "Could not load AI settings.")
  }
}

export async function updateAiSettings(input: {
  enabled: boolean
  model: string
  monthlyLimitZar: number | null
  warnAtPercent: number
}): Promise<Result> {
  try {
    const { tenantId, supabase } = await ownerContext()

    const { data: current } = await supabase
      .from("tenant_ai_settings")
      .select("mode, provider, model")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (!current) return { success: false, error: "AI settings are not set up for this shop yet." }

    let limit: number | null = null
    if (input.monthlyLimitZar !== null) {
      if (!Number.isFinite(input.monthlyLimitZar) || input.monthlyLimitZar < 0 || input.monthlyLimitZar > MAX_MONTHLY_LIMIT_ZAR) {
        return { success: false, error: `The monthly limit must be between R0 and R${MAX_MONTHLY_LIMIT_ZAR.toLocaleString("en-ZA")}, or left empty for no limit.` }
      }
      limit = Math.round(input.monthlyLimitZar * 100) / 100
    }

    const warn = Math.round(input.warnAtPercent)
    if (!Number.isFinite(warn) || warn < 1 || warn > 100) {
      return { success: false, error: "The warning level must be between 1% and 100%." }
    }

    const model = input.model.trim()
    if (model !== current.model) {
      if (current.mode === "managed") return { success: false, error: "The model is chosen by QLess while you're on QLess-managed AI." }
      const { data: allowed } = await supabase
        .from("ai_model_pricing")
        .select("model")
        .eq("provider", current.provider)
        .eq("model", model)
        .eq("is_active", true)
        .maybeSingle()
      if (!allowed) return { success: false, error: "That model isn't available." }
    }

    const { error } = await supabase
      .from("tenant_ai_settings")
      .update({ enabled: input.enabled === true, model, monthly_limit_zar: limit, warn_at_percent: warn })
      .eq("tenant_id", tenantId)
    if (error) return { success: false, error: "Could not save AI settings." }

    invalidateTenantAiCache(tenantId)
    return { success: true }
  } catch (error) {
    return failure(error, "Could not save AI settings.")
  }
}

/**
 * Checks the key with the provider, then stores it encrypted. Switches the shop to its own key (BYOK).
 * `providerId` / `modelId` let the owner move to another vendor in the same step; without them the
 * shop keeps its current provider and model.
 */
export async function saveAiKey(apiKey: string, providerId?: string, modelId?: string): Promise<Result> {
  try {
    const { tenantId, supabase } = await ownerContext()
    const key = typeof apiKey === "string" ? apiKey.trim() : ""

    const { data: current } = await supabase
      .from("tenant_ai_settings")
      .select("provider, model")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (!current) return { success: false, error: "AI settings are not set up for this shop yet." }

    const targetId = (typeof providerId === "string" && providerId.trim()) || current.provider
    const provider = getProvider(targetId)
    if (!provider) return { success: false, error: "This AI provider isn't supported." }
    if (!provider.looksLikeKey(key)) {
      return { success: false, error: `That doesn't look like a ${provider.label} API key. Copy the whole key from your ${provider.label} account.` }
    }

    // Model for the new key: the one asked for, else the shop's current one (same vendor), else the vendor's cheapest.
    const { data: listed } = await supabase
      .from("ai_model_pricing")
      .select("model")
      .eq("provider", provider.id)
      .eq("is_active", true)
      .order("input_usd_per_1m", { ascending: true })
    const available = (listed ?? []).map((m) => String(m.model))
    const wanted = (typeof modelId === "string" && modelId.trim()) || (provider.id === current.provider ? current.model : "")
    const model = wanted && available.includes(wanted) ? wanted : available[0]
    if (!model) return { success: false, error: "No models are available for that provider yet." }

    // Managed shops move onto their own key, so check it can use the model they'll end up on.
    const check = await provider.validateKey(key, model)
    if (!check.ok) return { success: false, error: check.message }

    const switching = provider.id !== current.provider || model !== current.model
    const { error } = await supabase.rpc("ai_save_tenant_key", {
      p_tenant_id: tenantId,
      p_api_key: key,
      ...(switching ? { p_provider: provider.id, p_model: model } : {}),
    })
    if (error) return { success: false, error: "Could not store the key. Please try again." }

    invalidateTenantAiCache(tenantId)
    return { success: true }
  } catch (error) {
    return failure(error, "Could not save the key.")
  }
}

/** Deletes the stored key. A shop without a key has no AI until it adds one. */
export async function removeAiKey(): Promise<Result> {
  try {
    const { tenantId, supabase } = await ownerContext()
    const { error } = await supabase.rpc("ai_remove_tenant_key", { p_tenant_id: tenantId })
    if (error) return { success: false, error: "Could not remove the key. Please try again." }
    invalidateTenantAiCache(tenantId)
    return { success: true }
  } catch (error) {
    return failure(error, "Could not remove the key.")
  }
}
