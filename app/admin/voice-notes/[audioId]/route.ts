// app/api/admin/voice-notes/[audioId]/route.ts
// GET -> { url } : a short-lived signed link to ONE recording, for staff to play in the inbox.
// ----------------------------------------------------------------------------
// The bucket is private and has no client policies, so this is the ONLY way a recording is ever played. Rules:
//   - the signed-in member needs the "whatsapp.view" permission (the same one the inbox itself needs);
//   - the shop is ALWAYS taken from the session, never from the request, so one shop can't play another's recordings
//     (the lookup filters on both the id AND the member's tenant, so a foreign id looks like "not found");
//   - a recording past its retention (or whose shop turned "keep recordings" off) is refused with 410 even if the
//     deletion sweep hasn't run yet;
//   - the link lasts 5 minutes and the response is never cached;
//   - every play is logged (voice_audio_access_log). If the log can't be written the link is NOT given out.
import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"
import { VOICE_BUCKET, isPastRetention } from "@/lib/whatsapp/voice-audio-store"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNED_URL_SECONDS = 300
const NO_STORE = { "Cache-Control": "no-store" }

const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE })

export async function GET(_request: Request, context: { params: Promise<{ audioId: string }> | { audioId: string } }) {
  const { audioId } = await Promise.resolve(context.params)
  if (!UUID.test(audioId)) return reply({ error: "Invalid recording." }, 400)

  const check = await requireTenantPermission("whatsapp.view")
  if (!check.ok) return reply({ error: check.error }, 403)
  const tenantId = check.member.tenantId

  const supabase = getSupabaseServerClient()
  if (!supabase) return reply({ error: "Supabase isn't configured." }, 500)

  const { data: audio } = await supabase
    .from("message_audio")
    .select("id, storage_path, created_at, purge_now, deleted_at")
    .eq("id", audioId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  const row = audio as { id: string; storage_path: string; created_at: string; purge_now: boolean; deleted_at: string | null } | null
  if (!row) return reply({ error: "Recording not found." }, 404)
  if (row.deleted_at) return reply({ error: "This recording has been deleted." }, 410)

  const { data: settings } = await supabase
    .from("tenant_ai_settings")
    .select("voice_store_audio, voice_retention_days")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  const s = settings as { voice_store_audio?: boolean; voice_retention_days?: number } | null
  if (isPastRetention({ createdAt: row.created_at, retentionDays: s?.voice_retention_days, storeAudio: s?.voice_store_audio, purgeNow: row.purge_now })) {
    return reply({ error: "This recording has passed its retention period and is being deleted." }, 410)
  }

  // Log first: no log entry, no link.
  const member = check.member as unknown as { profileId?: string; userId?: string }
  const { error: logError } = await supabase
    .from("voice_audio_access_log")
    .insert({ tenant_id: tenantId, audio_id: row.id, user_id: member.profileId ?? member.userId ?? null, action: "play" })
  if (logError) {
    console.error("[voice] could not log the playback", { tenantId, error: logError.message })
    return reply({ error: "Couldn't record this playback. Please try again." }, 500)
  }

  const { data: signed, error: signError } = await supabase.storage.from(VOICE_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_SECONDS)
  if (signError || !signed?.signedUrl) {
    console.error("[voice] could not sign the recording link", { tenantId, error: signError?.message })
    return reply({ error: "Couldn't load this recording." }, 500)
  }

  return reply({ url: signed.signedUrl, expiresInSeconds: SIGNED_URL_SECONDS }, 200)
}
