// app/admin/voice-notes/VoiceNotesSetting.tsx — drop <VoiceNotesSetting /> into the AI settings page. Nothing else to wire up:
// it loads its own state, so the page around it doesn't need to change.
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getTenantPermissions } from "@/lib/tenant/require-tenant-permission"

import { VoiceNotesToggle } from "./VoiceNotesToggle"

const MODEL = process.env.VOICE_TRANSCRIBE_MODEL?.trim() || "gpt-transcribe"

/** Plain-language reason voice notes can't run for this shop right now, or null. Mirrors resolveVoiceAccess in lib/ai/voice-transcription.ts. */
function problemFor(
  settingsRowExists: boolean,
  r: { provider: string | null; key_source: string | null; blocked_reason: string | null } | null,
): string | null {
  if (!settingsRowExists || !r || r.blocked_reason === "not_configured") return "AI isn't set up for this shop yet."
  if (r.blocked_reason === "disabled") return "AI is switched off for this shop."
  if (r.blocked_reason === "no_key" || r.blocked_reason === "key_invalid") return "the shop's AI key is missing or not valid."
  if (r.blocked_reason === "budget_exceeded") return "this month's AI budget has been used up."
  if (r.blocked_reason === "tenant_inactive") return "this shop isn't active."
  if (r.key_source === "byok" && r.provider !== "openai") return "voice notes need an OpenAI key, and this shop's AI provider can't turn audio into text."
  return null
}

export async function VoiceNotesSetting() {
  const { member, granted } = await getTenantPermissions(["settings.manage"])
  const supabase = getSupabaseServerClient()

  let enabled = false
  let settingsRowExists = false
  let resolved: { provider: string | null; key_source: string | null; blocked_reason: string | null } | null = null
  let costNote: string | null = null

  if (supabase) {
    const [settingsRes, resolveRes, priceRes, fxRes] = await Promise.all([
      supabase.from("tenant_ai_settings").select("voice_notes_enabled").eq("tenant_id", member.tenantId).maybeSingle(),
      supabase.rpc("ai_resolve_tenant", { p_tenant_id: member.tenantId }).maybeSingle(),
      supabase.from("ai_model_pricing").select("audio_usd_per_minute").eq("provider", "openai").eq("model", MODEL).maybeSingle(),
      supabase.from("ai_platform_settings").select("usd_to_zar").maybeSingle(),
    ])
    const row = settingsRes.data as { voice_notes_enabled?: boolean } | null
    settingsRowExists = row !== null
    enabled = row?.voice_notes_enabled === true
    resolved = (resolveRes.data as typeof resolved) ?? null

    const usdPerMinute = Number((priceRes.data as { audio_usd_per_minute?: number | string } | null)?.audio_usd_per_minute)
    const fx = Number((fxRes.data as { usd_to_zar?: number | string } | null)?.usd_to_zar)
    if (usdPerMinute > 0 && fx > 0) {
      const perMinute = usdPerMinute * fx
      costNote = `Costs about R${perMinute.toFixed(2)} per minute of audio (roughly R${(perMinute / 2).toFixed(2)} for a 30 second note). It counts towards your monthly AI budget.`
    } else {
      costNote = "Each voice note is billed per minute of audio and counts towards your monthly AI budget."
    }
  }

  return (
    <VoiceNotesToggle
      initialEnabled={enabled}
      canManage={granted.has("settings.manage")}
      problem={problemFor(settingsRowExists, resolved)}
      costNote={costNote}
    />
  )
}
