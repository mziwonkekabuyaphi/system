// lib/ai/voice-transcription.ts
/**
 * Speech-to-text for voice notes, behind the same per-shop controls as the rest of the AI features.
 * ----------------------------------------------------------------------------
 * Access (resolveVoiceAccess): a shop gets transcription only when ALL of these hold:
 *   - tenant_ai_settings.voice_notes_enabled is true   (own switch, OFF by default: it costs money)
 *   - ai_resolve_tenant() has no blocked_reason         (AI switched on, shop active, key fine, monthly budget not used up)
 *   - there is a speech provider we can use:
 *       managed shop        -> the PLATFORM key (OPENAI_API_KEY)
 *       bring-your-own-key  -> the shop's own key, but only if that key is an OpenAI one.
 *                              A shop whose key is Anthropic (which has no speech-to-text) gets "no_provider",
 *                              and the customer is asked to type. Platform-key fallback is deliberately NOT
 *                              automatic, because then the platform would pay for that shop's voice notes.
 *
 * Cost: every call (success or failure) is written by the database function ai_record_audio_usage()
 * with purpose "voice_transcription". It prices by the minute (ai_model_pricing.audio_usd_per_minute) and adds
 * to the monthly total, so the existing monthly budget counts voice too.
 *
 * MODEL: VOICE_TRANSCRIBE_MODEL, default "gpt-transcribe". Several older OpenAI transcription models
 * (whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe) are reported to retire on 26 Feb 2027, so avoid them.
 * Changing the model needs a matching row in ai_model_pricing, or the cost is logged as unpriced.
 *
 * Nothing here throws.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

const PURPOSE = "voice_transcription"
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions"
const REQUEST_TIMEOUT_MS = 20_000

export function transcriptionModel(): string {
  return process.env.VOICE_TRANSCRIBE_MODEL?.trim() || "gpt-transcribe"
}

export type VoiceAccess =
  | { ok: true; apiKey: string; keySource: "byok" | "managed" }
  | { ok: false; reason: "not_enabled" | "disabled" | "budget" | "no_provider" }

export async function resolveVoiceAccess(supabase: SupabaseClient, tenantId: string): Promise<VoiceAccess> {
  try {
    const { data: settings } = await supabase
      .from("tenant_ai_settings")
      .select("voice_notes_enabled")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (!(settings as { voice_notes_enabled?: boolean } | null)?.voice_notes_enabled) return { ok: false, reason: "not_enabled" }

    const { data, error } = await supabase.rpc("ai_resolve_tenant", { p_tenant_id: tenantId }).maybeSingle()
    if (error || !data) return { ok: false, reason: "disabled" }
    const row = data as { provider: string | null; api_key: string | null; key_source: "byok" | "managed" | null; blocked_reason: string | null }

    if (row.blocked_reason === "budget_exceeded") return { ok: false, reason: "budget" }
    if (row.blocked_reason) return { ok: false, reason: "disabled" }

    if (row.key_source === "byok") {
      return row.provider === "openai" && row.api_key
        ? { ok: true, apiKey: row.api_key, keySource: "byok" }
        : { ok: false, reason: "no_provider" }
    }
    const platformKey = process.env.OPENAI_API_KEY?.trim()
    return platformKey ? { ok: true, apiKey: platformKey, keySource: "managed" } : { ok: false, reason: "no_provider" }
  } catch (error) {
    console.error("[voice] access check failed", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    return { ok: false, reason: "disabled" }
  }
}

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "failed" | "timeout" }

function filenameFor(mimeType: string): string {
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "voice.ogg"
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "voice.mp3"
  if (mimeType.includes("mp4") || mimeType.includes("aac") || mimeType.includes("m4a")) return "voice.m4a"
  if (mimeType.includes("wav")) return "voice.wav"
  if (mimeType.includes("webm")) return "voice.webm"
  return "voice.ogg"
}

async function recordUsage(
  supabase: SupabaseClient,
  tenantId: string,
  access: Extract<VoiceAccess, { ok: true }>,
  status: "ok" | "error",
  seconds: number,
  latencyMs: number,
  conversationId: string | null,
  errorCode: string | null,
  errorMessage: string | null,
) {
  try {
    const { error } = await supabase.rpc("ai_record_audio_usage", {
      p_tenant_id: tenantId,
      p_provider: "openai",
      p_model: transcriptionModel(),
      p_purpose: PURPOSE,
      p_key_source: access.keySource,
      p_status: status,
      p_error_code: errorCode,
      p_error_message: errorMessage,
      p_audio_seconds: Math.max(0, Math.round(seconds)),
      p_latency_ms: Math.round(latencyMs),
      p_conversation_id: conversationId,
    })
    if (error) console.error("[voice] could not record usage", { tenantId, error: error.message })
  } catch (error) {
    console.error("[voice] could not record usage", { tenantId, error: error instanceof Error ? error.message : "unknown" })
  }
}

/** Sends the audio to OpenAI and records what it cost. */
export async function transcribeAudio(args: {
  supabase: SupabaseClient
  tenantId: string
  access: Extract<VoiceAccess, { ok: true }>
  bytes: Uint8Array
  mimeType: string
  seconds: number
  conversationId: string | null
}): Promise<TranscribeResult> {
  const { supabase, tenantId, access, bytes, mimeType, seconds, conversationId } = args
  const started = Date.now()

  try {
    const form = new FormData()
    form.append("file", new Blob([bytes as BlobPart], { type: mimeType || "audio/ogg" }), filenameFor(mimeType))
    form.append("model", transcriptionModel())

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${access.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      const code = response.status === 401 ? "invalid_api_key" : response.status === 429 ? "rate_limited" : `http_${response.status}`
      // Failed calls are not billed by OpenAI, so they are logged with 0 seconds.
      await recordUsage(supabase, tenantId, access, "error", 0, Date.now() - started, conversationId, code, body)
      return { ok: false, reason: "failed" }
    }

    const json = (await response.json()) as { text?: unknown }
    const text = typeof json.text === "string" ? json.text.replace(/\s+/g, " ").trim() : ""
    await recordUsage(supabase, tenantId, access, "ok", seconds, Date.now() - started, conversationId, null, null)
    return text ? { ok: true, text } : { ok: false, reason: "empty" }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    await recordUsage(
      supabase, tenantId, access, "error", 0, Date.now() - started, conversationId,
      timedOut ? "timeout" : "network_error", error instanceof Error ? error.message : null,
    )
    return { ok: false, reason: timedOut ? "timeout" : "failed" }
  }
}
