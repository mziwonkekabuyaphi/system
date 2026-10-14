// app/platform/upgrades/actions.ts — approve / decline plan upgrade requests.
// Server actions are public endpoints, so the platform-admin gate is re-checked here.
"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

const BACK = "/platform/upgrades"

function fail(message: string): never {
  redirect(`${BACK}?error=${encodeURIComponent(message)}`)
}

function refresh() {
  revalidatePath("/platform")
  revalidatePath(BACK)
  revalidatePath("/platform/tenants")
  revalidatePath("/admin")
}

export async function approveUpgrade(formData: FormData) {
  await requirePlatformAdmin()
  const id = String(formData.get("id") ?? "")
  if (!id) fail("Missing request id.")

  const supabase = getSupabaseServerClient()
  if (!supabase) fail("Supabase isn't configured.")

  // Claim the request first (only while still pending) so a double click or a
  // second admin can't approve it twice.
  const { data: claimed, error: claimError } = await supabase
    .from("plan_upgrade_requests")
    .update({ status: "approved", resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, tenant_id, requested_plan_key")
    .maybeSingle()

  if (claimError) fail(claimError.message)
  if (!claimed) fail("That request was already handled.")

  const { error: planError } = await supabase
    .from("tenants")
    .update({ plan: claimed.requested_plan_key })
    .eq("id", claimed.tenant_id)

  if (planError) {
    // Put the request back so it can be retried.
    await supabase.from("plan_upgrade_requests").update({ status: "pending", resolved_at: null }).eq("id", id)
    fail(`Couldn't change the plan: ${planError.message}`)
  }

  refresh()
  redirect(`${BACK}?done=approved`)
}

export async function declineUpgrade(formData: FormData) {
  await requirePlatformAdmin()
  const id = String(formData.get("id") ?? "")
  if (!id) fail("Missing request id.")

  const supabase = getSupabaseServerClient()
  if (!supabase) fail("Supabase isn't configured.")

  const { data: declined, error } = await supabase
    .from("plan_upgrade_requests")
    .update({ status: "declined", resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle()

  if (error) fail(error.message)
  if (!declined) fail("That request was already handled.")

  refresh()
  redirect(`${BACK}?done=declined`)
}
