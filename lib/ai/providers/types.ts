// lib/ai/providers/types.ts
/**
 * The seam between QLess and an AI vendor. Everything vendor-specific (how to build a model from an
 * API key, what an auth failure looks like, how to check a key) lives behind this interface, so the
 * WhatsApp router, the gateway and the settings UI never mention a vendor by name.
 *
 * Adding a provider = one file implementing AiProvider + one line in providers/index.ts + rows in
 * public.ai_model_pricing. No router changes.
 */

import type { LanguageModel } from "ai"

export type AiProviderId = "openai"

export type AiErrorCode =
  | "invalid_api_key" // 401: wrong or revoked key. Marks a BYOK key invalid so we stop calling.
  | "quota_exceeded" // the tenant's own provider account is out of credit
  | "rate_limited"
  | "model_unavailable" // key has no access to the model, or the model doesn't exist
  | "invalid_output" // the model answered, but not in the shape we asked for (tokens were still billed)
  | "timeout"
  | "provider_error"
  | "unknown"

export interface AiProviderError {
  code: AiErrorCode
  /** Safe to store and show: never contains the API key. */
  message: string
}

export type KeyCheck = { ok: true } | ({ ok: false } & AiProviderError)

export interface AiProvider {
  readonly id: AiProviderId
  readonly label: string
  /** Where the tenant creates a key. Shown beside the key field. */
  readonly keyHelpUrl: string

  /** Offline shape check only. Catches paste mistakes; does not prove the key works. */
  looksLikeKey(apiKey: string): boolean

  /** QLess's own key for this provider (managed mode only), or null when not configured. */
  platformApiKey(): string | null

  createModel(apiKey: string, modelId: string): LanguageModel

  /** Turns anything a model call can throw into a stable code + safe message. */
  classifyError(error: unknown): AiProviderError

  /** Free live check that the key works and may use the model. Never throws, never logs the key. */
  validateKey(apiKey: string, modelId: string): Promise<KeyCheck>
}
