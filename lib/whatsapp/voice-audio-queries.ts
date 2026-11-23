// lib/whatsapp/voice-audio-queries.ts
/**
 * For the inbox: which of these messages have a recording staff can still play?
 * Pass the SERVER (service-role) client from a server component, with the signed-in member's tenant id. Every query
 * is filtered by tenant, and a recording past its retention is left out (it's about to be deleted).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { isPastRetention } from "@/lib/whatsapp/voice-audio-store"

export interface VoiceAudioInfo {
  audioId: string
  durationSeconds: number | null
  /** ISO time after which the recording is deleted. */
  keptUntil: string
}

export async function loadVoiceAudioForMessages(
  supabase: SupabaseClient,
  tenantId: string,
  messageIds: string[],
): Promise<Record<string, VoiceAudioInfo>> {
  const result: Record<string, VoiceAudioInfo> = {}
  const ids = [...new Set(messageIds)].filter(Boolean)
  if (ids.length === 0) return result

  try {
    const [rowsRes, settingsRes] = await Promise.all([
      supabase
        .from("message_audio")
        .select("id, message_id, duration_seconds, created_at, purge_now")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .in("message_id", ids),
      supabase.from("tenant_ai_settings").select("voice_store_audio, voice_retention_days").eq("tenant_id", tenantId).maybeSingle(),
    ])
    const settings = settingsRes.data as { voice_store_audio?: boolean; voice_retention_days?: number } | null
    const retentionDays = settings?.voice_retention_days ?? 0

    for (const row of (rowsRes.data ?? []) as Array<{
      id: string
      message_id: string | null
      duration_seconds: number | string | null
      created_at: string
      purge_now: boolean
    }>) {
      if (!row.message_id) continue
      if (isPastRetention({ createdAt: row.created_at, retentionDays, storeAudio: settings?.voice_store_audio, purgeNow: row.purge_now })) continue
      result[row.message_id] = {
        audioId: row.id,
        durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
        keptUntil: new Date(new Date(row.created_at).getTime() + retentionDays * 86_400_000).toISOString(),
      }
    }
  } catch (error) {
    console.error("[voice] could not load recordings for the inbox", { tenantId, error: error instanceof Error ? error.message : "unknown" })
  }
  return result
}
