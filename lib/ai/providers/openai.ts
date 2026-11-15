// lib/ai/providers/openai.ts
import { APICallError } from "ai"
import { createOpenAI } from "@ai-sdk/openai"

import type { AiProvider, AiProviderError, KeyCheck } from "@/lib/ai/providers/types"

const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,}$/
const VALIDATE_TIMEOUT_MS = 6000

function openAiErrorCode(error: APICallError): string | undefined {
  const data = error.data as { error?: { code?: unknown } } | undefined
  const code = data?.error?.code
  return typeof code === "string" ? code : undefined
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
    if (status === 401) return { code: "invalid_api_key", message: "OpenAI rejected the API key." }
    if (status === 429) {
      return openAiErrorCode(error) === "insufficient_quota"
        ? { code: "quota_exceeded", message: "The OpenAI account is out of credit." }
        : { code: "rate_limited", message: "OpenAI is rate limiting this key." }
    }
    if (status === 403 || status === 404) {
      return { code: "model_unavailable", message: "This key cannot use the selected model." }
    }
    return { code: "provider_error", message: `OpenAI error (HTTP ${status ?? "unknown"}).` }
  }

  if (error instanceof Error && error.name === "AI_NoObjectGeneratedError") {
    return { code: "invalid_output", message: "The model's answer was not in the expected format." }
  }

  return { code: "unknown", message: error instanceof Error ? error.message : "Unknown error." }
}

export const openaiProvider: AiProvider = {
  id: "openai",
  label: "OpenAI",
  keyHelpUrl: "https://platform.openai.com/api-keys",
  keyPlaceholder: "sk-…",

  looksLikeKey(apiKey) {
    return KEY_PATTERN.test(apiKey.trim())
  },

  platformApiKey() {
    const key = process.env.OPENAI_API_KEY?.trim()
    return key && key.length >= 20 ? key : null
  },

  createModel(apiKey, modelId) {
    return createOpenAI({ apiKey })(modelId)
  },

  classifyError: classify,

  /** GET /v1/models/{model}: free, proves the key is real and can see the model. It does not
   *  prove the account has credit; that surfaces on the first real call as quota_exceeded. */
  async validateKey(apiKey, modelId): Promise<KeyCheck> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
    try {
      const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(modelId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        cache: "no-store",
      })
      if (response.ok) return { ok: true }
      if (response.status === 401) {
        return { ok: false, code: "invalid_api_key", message: "OpenAI rejected this key. Check it was copied in full." }
      }
      if (response.status === 403 || response.status === 404) {
        return { ok: false, code: "model_unavailable", message: `This key can't use ${modelId}. Pick another model or check the key's permissions.` }
      }
      if (response.status === 429) return { ok: true } // rate limited means the key was recognised
      return { ok: false, code: "provider_error", message: `OpenAI could not check the key right now (HTTP ${response.status}). Try again.` }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError"
      return {
        ok: false,
        code: timedOut ? "timeout" : "provider_error",
        message: timedOut ? "OpenAI didn't answer in time. Try again." : "Couldn't reach OpenAI. Try again.",
      }
    } finally {
      clearTimeout(timer)
    }
  },
}
