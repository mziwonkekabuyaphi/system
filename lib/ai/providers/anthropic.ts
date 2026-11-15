// lib/ai/providers/anthropic.ts
import { APICallError } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"

import type { AiCallSettings, AiProvider, AiProviderError, KeyCheck } from "@/lib/ai/providers/types"

const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/
const VALIDATE_TIMEOUT_MS = 6000
const ANTHROPIC_VERSION = "2023-06-01"

/** Claude 5.x thinks by default and thinking tokens count against the output cap, so a cap sized for
 *  a bare answer (the intent classifier uses 40) can end the reply before any text. Give it room. */
const MIN_OUTPUT_TOKENS = 1024
const DEFAULT_OUTPUT_TOKENS = 2048

function anthropicMessage(error: APICallError): string {
  const data = error.data as { error?: { message?: unknown } } | undefined
  const message = data?.error?.message
  return typeof message === "string" ? message : ""
}

function classify(error: unknown): AiProviderError {
  // The AI SDK wraps repeated failures in a RetryError; the real cause is on lastError.
  if (error && typeof error === "object" && "lastError" in error && (error as { lastError?: unknown }).lastError) {
    return classify((error as { lastError: unknown }).lastError)
  }

  if (error instanceof Error && error.name === "AbortError") {
    return { code: "timeout", message: "The request timed out." }
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    if (status === 401) return { code: "invalid_api_key", message: "Anthropic rejected the API key." }
    // Anthropic reports an empty balance as 400 "credit balance is too low" (or 402 billing_error).
    if (status === 402 || (status === 400 && /credit balance/i.test(anthropicMessage(error)))) {
      return { code: "quota_exceeded", message: "The Anthropic account is out of credit." }
    }
    if (status === 429) return { code: "rate_limited", message: "Anthropic is rate limiting this key." }
    if (status === 403 || status === 404) {
      return { code: "model_unavailable", message: "This key cannot use the selected model." }
    }
    return { code: "provider_error", message: `Anthropic error (HTTP ${status ?? "unknown"}).` }
  }

  if (error instanceof Error && error.name === "AI_NoObjectGeneratedError") {
    return { code: "invalid_output", message: "The model's answer was not in the expected format." }
  }

  return { code: "unknown", message: error instanceof Error ? error.message : "Unknown error." }
}

export const anthropicProvider: AiProvider = {
  id: "anthropic",
  label: "Claude (Anthropic)",
  keyHelpUrl: "https://console.anthropic.com/settings/keys",
  keyPlaceholder: "sk-ant-…",

  looksLikeKey(apiKey) {
    return KEY_PATTERN.test(apiKey.trim())
  },

  platformApiKey() {
    const key = process.env.ANTHROPIC_API_KEY?.trim()
    return key && key.length >= 20 ? key : null
  },

  createModel(apiKey, modelId) {
    return createAnthropic({ apiKey })(modelId)
  },

  tuneCall(settings: AiCallSettings): AiCallSettings {
    // Claude 5.x rejects temperature (the SDK would drop it with a warning anyway). Keep thinking short
    // with the lowest effort level: these are small classification / extraction / FAQ calls.
    const { temperature: _temperature, maxOutputTokens, providerOptions, ...rest } = settings
    return {
      ...rest,
      maxOutputTokens: maxOutputTokens == null ? DEFAULT_OUTPUT_TOKENS : Math.max(maxOutputTokens, MIN_OUTPUT_TOKENS),
      providerOptions: { ...providerOptions, anthropic: { ...providerOptions?.anthropic, effort: "low" } },
    }
  },

  classifyError: classify,

  /** GET /v1/models/{model}: free, proves the key is real and can see the model. It does not prove
   *  the account has credit; that surfaces on the first real call as quota_exceeded. */
  async validateKey(apiKey, modelId): Promise<KeyCheck> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
    try {
      const response = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(modelId)}`, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal: controller.signal,
        cache: "no-store",
      })
      if (response.ok) return { ok: true }
      if (response.status === 401) {
        return { ok: false, code: "invalid_api_key", message: "Anthropic rejected this key. Check it was copied in full." }
      }
      if (response.status === 403 || response.status === 404) {
        return { ok: false, code: "model_unavailable", message: `This key can't use ${modelId}. Pick another model or check the key's permissions.` }
      }
      if (response.status === 429) return { ok: true } // rate limited means the key was recognised
      return { ok: false, code: "provider_error", message: `Anthropic could not check the key right now (HTTP ${response.status}). Try again.` }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError"
      return {
        ok: false,
        code: timedOut ? "timeout" : "provider_error",
        message: timedOut ? "Anthropic didn't answer in time. Try again." : "Couldn't reach Anthropic. Try again.",
      }
    } finally {
      clearTimeout(timer)
    }
  },
}
