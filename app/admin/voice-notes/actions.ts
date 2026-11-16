// app/admin/voice-notes/actions.ts — the shop's own on/off switch for WhatsApp voice notes.
// Server actions are public endpoints, so the permission check is repeated here. The shop is ALWAYS taken from the
// signed-in session (never from the browser), so one shop can never switch another shop's voice notes.
"use server"

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantPermission } from "@/lib/tenant/require-tenant-permission"

export type VoiceToggleResult = { ok: true } | { ok: false; error: string }

export async function setVoiceNotesEnabled(enable: boolean): Promise<VoiceToggleResult> {
  if (typeof enable !== "boolean") return { ok: false, error: "Invalid request." }

  const check = await requireTenantPermission("settings.manage")
  if (!check.ok) return { ok: false, error: check.error }

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Supabase isn't configured." }

  const { data, error } = await supabase
    .from("tenant_ai_settings")
    .update({ voice_notes_enabled: enable })
    .eq("tenant_id", check.member.tenantId)
    .select("tenant_id")
  if (error) return { ok: false, error: "Couldn't save that. Please try again." }

  // The row is created when a shop first sets up AI. Without it there is nothing to switch.
  if (!data || data.length === 0) {
    return { ok: false, error: "AI isn't set up for this shop yet. Set it up first, then switch voice notes on." }
  }

  // The WhatsApp side reads this flag from the database on every voice note, so there is no cache to clear.
  revalidatePath("/admin", "layout")
  return { ok: true }
}
