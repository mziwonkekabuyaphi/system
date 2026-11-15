// lib/ai/openai.ts
/**
 * Free-text AI replies for the QLess assistant (the shop concierge).
 * ---------------------------------------------------------------------------
 * Despite the file name this is no longer tied to one vendor or one key: every call goes through the
 * tenant AI gateway (lib/ai/gateway.ts), which picks the tenant's own key (BYOK) or QLess's platform
 * key (managed), enforces their monthly limit, and records tokens and cost against the tenant.
 *
 *   - Never throws: every failure comes back as { success: false, error } so a bad key, a timeout,
 *     a spent budget or a provider outage can only ever cost the customer the "smart" part, never
 *     the whole reply.
 *
 * Env vars (set in Vercel). Only used for tenants on QLess-managed AI; BYOK tenants use their own
 * key and chosen model:
 *   OPENAI_API_KEY   QLess's platform key
 *   OPENAI_MODEL     optional model for managed tenants
 *   OPENAI_TIMEOUT   optional, ms, default 8000 (WhatsApp wants fast replies). Applies to everyone.
 */

import { generateText } from "ai"

import { AiUnavailableError, redactSecrets, withTenantAi } from "@/lib/ai/gateway"

export type AiMessageRole = "user" | "assistant"

export interface AiMessage {
  role: AiMessageRole
  content: string
}

export interface AiTextRequest {
  /** Whose AI account this call is billed to. Required. */
  tenantId: string
  systemPrompt: string
  userMessage: string
  /** Plain data the model may use. Serialised as JSON under the system prompt. */
  context?: Record<string, unknown>
  conversation?: AiMessage[]
  temperature?: number
  maxTokens?: number
  /** Overrides OPENAI_TIMEOUT for this call. */
  timeoutMs?: number
}

export interface AiTextResponse {
  success: boolean
  message: string
  /** The model that answered (empty if the call never started). */
  model: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 8000

function getTimeoutMs(override?: number): number {
  if (override && override >= 1000) return override
  const parsed = parseInt(process.env.OPENAI_TIMEOUT ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_TIMEOUT_MS
}

export async function generateAiText(request: AiTextRequest): Promise<AiTextResponse> {
  let modelId = ""
  const fail = (error: string): AiTextResponse => ({ success: false, message: "", model: modelId, error })

  if (!request.tenantId) return fail("tenantId is required")
  if (!request.systemPrompt) return fail("System prompt is required")
  if (!request.userMessage?.trim()) return fail("User message is required")

  let system = request.systemPrompt
  if (request.context && Object.keys(request.context).length > 0) {
    system += `\n\nSHOP DATA (the ONLY facts you may use):\n${JSON.stringify(request.context)}`
  }

  const timeout = getTimeoutMs(request.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const text = await withTenantAi({ tenantId: request.tenantId, purpose: "concierge_reply" }, async (model, ctx) => {
      modelId = ctx.modelId
      const result = await generateText({
        model,
        system,
        messages: [...(request.conversation ?? []), { role: "user", content: request.userMessage }],
        ...ctx.tune({ maxOutputTokens: request.maxTokens ?? 400, temperature: request.temperature ?? 0.3 }),
        abortSignal: controller.signal,
      })
      return { value: result.text, usage: result.usage }
    })

    if (!text.trim()) return fail("No text content in the AI response")
    return { success: true, message: text.trim(), model: modelId }
  } catch (error) {
    if (error instanceof AiUnavailableError) return fail(error.message)
    if (controller.signal.aborted) return fail(`Request timed out after ${timeout}ms`)
    return fail(redactSecrets(error instanceof Error ? error.message : "Unknown error"))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Name of the model QLess-managed tenants use, for logs and display only.
 * (Tenants with their own key choose their own model inside the gateway.)
 */
export function getAiModelName(_tenantId?: string): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini"
}
