// lib/ai/gateway.ts
/**
 * The single door every AI request goes through. It answers three questions for a tenant before a
 * model is called, and records what happened after:
 *
 *   1. May this tenant use AI right now?   AI switched on, a working key (BYOK) or platform key
 *                                          (managed), and this month's estimated spend still under
 *                                          their own limit.
 *   2. Whose key pays?                     BYOK: the tenant's own key, read from Supabase Vault.
 *                                          Managed: QLess's platform key (OPENAI_API_KEY).
 *   3. What did it cost?                   Tokens in/out are written to public.ai_usage_ledger and the
 *                                          monthly rollup, priced from public.ai_model_pricing.
 *
 * Failure contract (same as the rest of lib/ai): never makes things worse. When AI is unavailable the
 * caller gets AiUnavailableError, which every call site already treats like any other AI failure and
 * falls back to the plain menu flow. A failed or blocked call never breaks the customer's reply.
 *
 * Security: the tenant's API key exists in this process's memory only for the length of the cache
 * window (10s). It is never logged, never returned from this module, and never sent to the browser.
 * Usage rows hold token counts and cost only, never prompts or replies.
 */

import type { LanguageModel, LanguageModelUsage } from "ai"

import { getProvider } from "@/lib/ai/providers"
import type { AiCallSettings } from "@/lib/ai/providers"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type AiPurpose =
  | "intent_classification"
  | "booking_parser"
  | "shisha_entry"
  | "concierge_reply"
  | "ticket_entry"
  | "order_entry"
export type AiKeySource = "byok" | "managed"

export type AiBlockedReason =
  | "not_configured" // no tenant_ai_settings row
  | "tenant_inactive"
  | "disabled" // the owner switched AI off
  | "no_key" // BYOK tenant has not added a key (or removed it)
  | "key_invalid" // the provider rejected the tenant's key
  | "budget_exceeded" // this month's estimated spend reached the tenant's limit
  | "unavailable" // we couldn't determine it (database error, platform key missing, unknown provider)

const BLOCKED_REASONS = new Set<string>([
  "not_configured",
  "tenant_inactive",
  "disabled",
  "no_key",
  "key_invalid",
  "budget_exceeded",
  "unavailable",
])

export class AiUnavailableError extends Error {
  constructor(public readonly reason: AiBlockedReason) {
    super(`AI unavailable: ${reason}`)
    this.name = "AiUnavailableError"
  }
}

/** What callers may know about a tenant's AI state. Never includes the key. */
export interface TenantAiStatus {
  provider: string
  model: string
  keySource: AiKeySource | null
  blockedReason: AiBlockedReason | null
  spentZar: number
  limitZar: number | null
  percentUsed: number | null
}

interface Resolved extends TenantAiStatus {
  apiKey: string | null
}

// ── Resolution (cached 10s per tenant; one RPC) ────────────────────────────────────────────────

const CACHE_MS = 10_000
const cache = new Map<string, { at: number; value: Resolved }>()

export function invalidateTenantAiCache(tenantId: string): void {
  cache.delete(tenantId)
}

const UNAVAILABLE: Resolved = {
  provider: "",
  model: "",
  keySource: null,
  apiKey: null,
  blockedReason: "unavailable",
  spentZar: 0,
  limitZar: null,
  percentUsed: null,
}

async function resolve(tenantId: string): Promise<Resolved> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  try {
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase.rpc("ai_resolve_tenant", { p_tenant_id: tenantId })
    if (error) {
      console.error("[ai/gateway] resolve failed:", error.message)
      return UNAVAILABLE // fail closed: an unreadable budget must not become free AI
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
    if (!row) return UNAVAILABLE

    const reason = typeof row.blocked_reason === "string" ? row.blocked_reason : null
    const value: Resolved = {
      provider: typeof row.provider === "string" ? row.provider : "",
      model: typeof row.model === "string" ? row.model : "",
      keySource: row.key_source === "byok" || row.key_source === "managed" ? row.key_source : null,
      apiKey: typeof row.api_key === "string" && row.api_key ? row.api_key : null,
      blockedReason: reason ? (BLOCKED_REASONS.has(reason) ? (reason as AiBlockedReason) : "unavailable") : null,
      spentZar: Number(row.spent_zar ?? 0),
      limitZar: row.limit_zar == null ? null : Number(row.limit_zar),
      percentUsed: row.percent_used == null ? null : Number(row.percent_used),
    }
    cache.set(tenantId, { at: Date.now(), value })
    return value
  } catch (error) {
    console.error("[ai/gateway] resolve threw:", error instanceof Error ? error.message : "unknown error")
    return UNAVAILABLE
  }
}

/** Status without the key. For UI and logging. */
export async function getTenantAiStatus(tenantId: string): Promise<TenantAiStatus> {
  const { apiKey: _apiKey, ...status } = await resolve(tenantId)
  return status
}

/** True when a call made right now would be allowed to run. Cheap; shares the 10s cache. */
export async function isTenantAiAvailable(tenantId: string): Promise<boolean> {
  const r = await resolve(tenantId)
  if (r.blockedReason) return false
  const provider = getProvider(r.provider)
  if (!provider) return false
  if (r.keySource === "managed" && !provider.platformApiKey()) return false
  return true
}

// ── Running a call ──────────────────────────────────────────────────────────────────────────────────

export interface AiRunContext {
  modelId: string
  provider: string
  keySource: AiKeySource
  /** Spread into generateText/generateObject: `...ctx.tune({ temperature: 0, maxOutputTokens: 40 })`.
   *  Makes the settings valid for whichever vendor this tenant uses. */
  tune: (settings: AiCallSettings) => AiCallSettings
}

/** What `run` hands back: the value for the caller, plus the SDK's usage so it can be billed. */
export interface AiRunResult<T> {
  value: T
  usage?: LanguageModelUsage
}

function pickModelId(r: Resolved, purpose: AiPurpose): string {
  // BYOK: the tenant chose the model. Managed: the platform decides, exactly as before BYOK existed
  // (OPENAI_MODEL, and the optional cheaper OPENAI_CLASSIFIER_MODEL for the six-label classifier).
  if (r.keySource !== "managed" || r.provider !== "openai") return r.model
  const cheap =
    purpose === "intent_classification" ||
    purpose === "shisha_entry" ||
    purpose === "ticket_entry" ||
    purpose === "order_entry"
  const override = cheap ? process.env.OPENAI_CLASSIFIER_MODEL?.trim() : undefined
  return override || process.env.OPENAI_MODEL?.trim() || r.model
}

/** Strips anything shaped like an API key from text that is about to be logged or shown. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_\-*.]+/g, "sk-***").replace(/[A-Za-z0-9_-]{32,}/g, "***")
}

function tokenCount(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Some SDK errors (e.g. the model answered in the wrong shape) still carry the usage that was billed. */
function usageFromError(error: unknown): LanguageModelUsage | undefined {
  const usage = (error as { usage?: LanguageModelUsage } | null)?.usage
  return usage && typeof usage === "object" ? usage : undefined
}

/**
 * Runs `run` with a model bound to the right key, then records usage. Throws AiUnavailableError when
 * the tenant may not use AI right now; rethrows whatever `run` throws (after recording it), so call
 * sites keep their existing timeout/fallback handling unchanged.
 */
export async function withTenantAi<T>(
  opts: { tenantId: string; purpose: AiPurpose; conversationId?: string | null },
  run: (model: LanguageModel, ctx: AiRunContext) => Promise<AiRunResult<T>>,
): Promise<T> {
  const { tenantId, purpose } = opts
  const resolved = await resolve(tenantId)
  if (resolved.blockedReason || !resolved.keySource) {
    throw new AiUnavailableError(resolved.blockedReason ?? "unavailable")
  }

  const provider = getProvider(resolved.provider)
  if (!provider) throw new AiUnavailableError("unavailable")
  const apiKey = resolved.keySource === "byok" ? resolved.apiKey : provider.platformApiKey()
  if (!apiKey) throw new AiUnavailableError(resolved.keySource === "byok" ? "no_key" : "unavailable")

  const ctx: AiRunContext = {
    modelId: pickModelId(resolved, purpose),
    provider: resolved.provider,
    keySource: resolved.keySource,
    tune: (settings) => provider.tuneCall?.(settings) ?? settings,
  }

  const startedAt = Date.now()
  let result: AiRunResult<T>
  try {
    result = await run(provider.createModel(apiKey, ctx.modelId), ctx)
  } catch (error) {
    const { code, message } = provider.classifyError(error)
    const usage = usageFromError(error)
    await record({
      ...opts,
      ctx,
      status: "error",
      errorCode: code,
      errorMessage: message,
      inputTokens: tokenCount(usage?.inputTokens),
      outputTokens: tokenCount(usage?.outputTokens),
      latencyMs: Date.now() - startedAt,
    })
    if (code === "invalid_api_key") invalidateTenantAiCache(tenantId) // stop using a key the provider just rejected
    throw error
  }

  await record({
    ...opts,
    ctx,
    status: "ok",
    inputTokens: tokenCount(result.usage?.inputTokens),
    outputTokens: tokenCount(result.usage?.outputTokens),
    latencyMs: Date.now() - startedAt,
  })
  return result.value
}

// ── Recording ───────────────────────────────────────────────────────────────────────────────────────

async function record(args: {
  tenantId: string
  purpose: AiPurpose
  conversationId?: string | null
  ctx: AiRunContext
  status: "ok" | "error"
  errorCode?: string
  errorMessage?: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}): Promise<void> {
  // Metering must never break a customer's reply: log and move on.
  try {
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase.rpc("ai_record_usage", {
      p_tenant_id: args.tenantId,
      p_provider: args.ctx.provider,
      p_model: args.ctx.modelId,
      p_purpose: args.purpose,
      p_key_source: args.ctx.keySource,
      p_status: args.status,
      p_error_code: args.errorCode ?? null,
      p_error_message: args.errorMessage ?? null,
      p_input_tokens: args.inputTokens,
      p_output_tokens: args.outputTokens,
      p_latency_ms: args.latencyMs,
      p_conversation_id: args.conversationId ?? null,
    })
    if (error) {
      console.error("[ai/gateway] usage record failed:", error.message)
      return
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
    if (row) tightenCache(args.tenantId, Number(row.month_spent_zar), row.limit_zar == null ? null : Number(row.limit_zar), row.percent_used == null ? null : Number(row.percent_used))
  } catch (error) {
    console.error("[ai/gateway] usage record threw:", error instanceof Error ? error.message : "unknown error")
  }
}

/** After a call, move this instance's cached spend forward so the limit bites without waiting for the cache to expire. */
function tightenCache(tenantId: string, spentZar: number, limitZar: number | null, percentUsed: number | null): void {
  const hit = cache.get(tenantId)
  if (!hit || !Number.isFinite(spentZar)) return
  const overLimit = limitZar !== null && spentZar >= limitZar
  hit.value = {
    ...hit.value,
    spentZar,
    limitZar,
    percentUsed,
    ...(overLimit ? { blockedReason: "budget_exceeded" as const, apiKey: null } : {}),
  }
}
