// lib/ai/openai.ts
/**
 * OpenAI client for the QLess assistant — tenant-agnostic, env-configured.
 * ---------------------------------------------------------------------------
 * Adapted from the old Rands `lib/ai/claude.ts`. What changed:
 *   - No `ai_settings` table. That row was a single global admin override for
 *     one business; QLess is multi-tenant, so per-shop switching lives in
 *     lib/ai/settings.ts (message_settings.ai_enabled_default) instead.
 *   - Names say what they are (generateAiText, not generateClaudeResponse).
 *   - Never throws: every failure comes back as { success: false, error } so
 *     a bad key / timeout / OpenAI outage can only ever cost the customer the
 *     "smart" part, never the whole reply.
 *
 * Env vars (set in Vercel):
 *   OPENAI_API_KEY   required
 *   OPENAI_MODEL     optional, default gpt-4o-mini
 *   OPENAI_TIMEOUT   optional, ms, default 8000 (WhatsApp wants fast replies;
 *                    the old 20s default is too slow for a live chat)
 */

export type AiMessageRole = "user" | "assistant"

export interface AiMessage {
  role: AiMessageRole
  content: string
}

export interface AiTextRequest {
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
  model: string
  error?: string
}

const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_TIMEOUT_MS = 8000

/** Model name shared by every AI call (also used by the `ai` SDK callers). */
export function getAiModelName(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL
}

/** True when an API key is present. Cheap check callers can use to skip AI. */
export function isAiConfigured(): boolean {
  const key = process.env.OPENAI_API_KEY?.trim()
  return Boolean(key && key.length >= 20)
}

function getTimeoutMs(override?: number): number {
  if (override && override >= 1000) return override
  const parsed = parseInt(process.env.OPENAI_TIMEOUT ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_TIMEOUT_MS
}

export async function generateAiText(request: AiTextRequest): Promise<AiTextResponse> {
  const model = getAiModelName()
  const fail = (error: string): AiTextResponse => ({ success: false, message: "", model, error })

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return fail("OPENAI_API_KEY environment variable is required")
  if (!request.systemPrompt) return fail("System prompt is required")
  if (!request.userMessage?.trim()) return fail("User message is required")

  let system = request.systemPrompt
  if (request.context && Object.keys(request.context).length > 0) {
    system += `\n\nSHOP DATA (the ONLY facts you may use):\n${JSON.stringify(request.context)}`
  }

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      ...(request.conversation ?? []),
      { role: "user", content: request.userMessage },
    ],
    max_tokens: request.maxTokens ?? 400,
    temperature: request.temperature ?? 0.3,
  }

  const timeout = getTimeoutMs(request.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const json = (await response.json()) as { error?: { message?: string } }
        if (json?.error?.message) detail = json.error.message
      } catch {
        /* keep the HTTP status */
      }
      return fail(`OpenAI API error (${response.status}): ${detail}`)
    }

    const data = (await response.json()) as {
      model?: string
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== "string" || !text.trim()) return fail("No text content in OpenAI response")

    return { success: true, message: text.trim(), model: data.model || model }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return fail(`Request timed out after ${timeout}ms`)
    return fail(error instanceof Error ? error.message : "Unknown error")
  } finally {
    clearTimeout(timer)
  }
}
