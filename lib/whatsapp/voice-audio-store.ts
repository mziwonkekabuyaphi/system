// lib/whatsapp/voice-audio-store.ts
/**
 * Keeps a customer's voice note in the PRIVATE "voice-notes" bucket so staff can replay it in the inbox (phase 2).
 * ----------------------------------------------------------------------------
 * Opt-in per shop (tenant_ai_settings.voice_store_audio, off by default). Voice is personal information under POPIA, so:
 *   - the bucket is private with no client policies: only the server touches it, and staff get short-lived signed URLs
 *     after a permission check (see app/api/admin/voice-notes/[audioId]/route.ts);
 *   - files live under the tenant's own folder: <tenant_id>/<yyyy-mm>/<random>.<ext> (no phone number or message id in the name);
 *   - every recording has a deadline: created_at + the shop's retention days. The database sweep that deletes it
 *     (purge_expired_voice_audio -> the voice-retention Edge Function) and isPastRetention() below use the SAME rule,
 *     so playback is refused the moment a recording is past retention, even before the sweep has run.
 *
 * storeVoiceAudio() never throws: a failure to keep the recording must never stop the customer's voice note being answered.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

export const VOICE_BUCKET = "voice-notes"

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
}

export function extensionForMime(mimeType: string): string {
  return EXTENSIONS[mimeType.split(";")[0].trim().toLowerCase()] ?? "ogg"
}

/** <tenant_id>/<yyyy-mm>/<random>.<ext>. The tenant folder keeps one shop's files apart from another's. */
export function buildAudioPath(tenantId: string, now: Date, mimeType: string, id: string = randomUUID()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  return `${tenantId}/${month}/${id}.${extensionForMime(mimeType)}`
}

/** When a recording must be gone: created + the shop's retention days. */
export function audioDeleteAfter(createdAt: string | Date, retentionDays: number): Date {
  return new Date(new Date(createdAt).getTime() + retentionDays * 86_400_000)
}

/**
 * True when a recording must no longer be played. Mirrors claim_voice_audio_to_purge() in the database:
 * due when purge_now, when the shop has no settings / turned "keep recordings" off, or when older than its retention days.
 */
export function isPastRetention(args: {
  createdAt: string | Date
  retentionDays: number | null | undefined
  storeAudio: boolean | null | undefined
  purgeNow?: boolean | null
  now?: Date
}): boolean {
  if (args.purgeNow) return true
  if (args.storeAudio !== true) return true
  const days = args.retentionDays
  if (!days || days < 1) return true
  return audioDeleteAfter(args.createdAt, days).getTime() <= (args.now ?? new Date()).getTime()
}

export type StoreResult = "stored" | "skipped" | "failed"

export async function storeVoiceAudio(args: {
  supabase: SupabaseClient
  tenantId: string
  /** The WhatsApp message id (messages.meta_message_id). The message row already exists: the webhook stores it before processing. */
  waMessageId: string
  bytes: Uint8Array
  mimeType: string
  durationSeconds: number
  now?: Date
}): Promise<StoreResult> {
  const { supabase, tenantId, waMessageId, bytes, mimeType, durationSeconds } = args
  try {
    // Link the recording to its message. No message row = nothing to attach it to, so don't keep it.
    const { data: message } = await supabase
      .from("messages")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("meta_message_id", waMessageId)
      .maybeSingle()
    const messageId = (message as { id?: string } | null)?.id
    if (!messageId) {
      console.error("[voice] not keeping the recording: its message row was not found", { tenantId })
      return "skipped"
    }

    // A retried webhook must not store the same recording twice.
    const { data: existing } = await supabase.from("message_audio").select("id").eq("message_id", messageId).maybeSingle()
    if (existing) return "skipped"

    const contentType = mimeType.split(";")[0].trim().toLowerCase() || "audio/ogg"
    const path = buildAudioPath(tenantId, args.now ?? new Date(), contentType)

    const upload = await supabase.storage.from(VOICE_BUCKET).upload(path, bytes, { contentType, upsert: false })
    if (upload.error) {
      console.error("[voice] could not upload the recording", { tenantId, error: upload.error.message })
      return "failed"
    }

    const { error: insertError } = await supabase.from("message_audio").insert({
      tenant_id: tenantId,
      message_id: messageId,
      storage_path: path,
      mime_type: contentType,
      size_bytes: bytes.length,
      duration_seconds: Math.round(durationSeconds * 10) / 10,
    })
    if (insertError) {
      // Without its row the sweep could never find this file, so remove it now rather than leave it behind.
      console.error("[voice] could not record the recording", { tenantId, error: insertError.message })
      await supabase.storage.from(VOICE_BUCKET).remove([path]).catch(() => undefined)
      return "failed"
    }
    return "stored"
  } catch (error) {
    console.error("[voice] storing the recording failed", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    return "failed"
  }
}
