"use server"
// app/platform/leads/actions.ts — platform admins update a website enquiry.

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

export type LeadStatus = "new" | "contacted" | "closed"

export async function updateContactRequest(
  id: string,
  patch: { status?: LeadStatus; adminNotes?: string },
): Promise<{ ok: boolean; error?: string }> {
  await requirePlatformAdmin() // the real gate: the write below uses the service-role client

  const update: { status?: LeadStatus; admin_notes?: string | null } = {}
  if (patch.status !== undefined) {
    if (!["new", "contacted", "closed"].includes(patch.status)) return { ok: false, error: "Unknown status" }
    update.status = patch.status
  }
  if (patch.adminNotes !== undefined) update.admin_notes = patch.adminNotes.trim().slice(0, 2000) || null
  if (Object.keys(update).length === 0) return { ok: true }

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Database unavailable" }

  const { error } = await supabase.from("contact_requests").update(update).eq("id", id)
  if (error) {
    console.error("[platform/leads] update failed", { id, error })
    return { ok: false, error: "Could not save that change" }
  }
  revalidatePath("/platform/leads")
  revalidatePath("/platform")
  return { ok: true }
}
