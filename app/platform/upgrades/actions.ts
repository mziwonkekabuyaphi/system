// app/platform/upgrades/actions.ts — approve / decline plan upgrade requests.
// Server actions are public endpoints, so the platform-admin gate is re-checked here.
"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { isBookingQueuePlanKey } from "@/lib/services/plans"

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

/** Put a request we just claimed ("approved") back to "pending", then stop with `reason`.
 *  Conditional on status = "approved": if anything else has changed the request in the
 *  meantime we leave it alone. Its result is checked, so a failed rollback is reported
 *  instead of silently leaving an approved request with no plan change. */
async function revertClaimAndFail(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  id: string,
  reason: string,
): Promise<never> {
  const { data: reverted, error: revertError } = await supabase
    .from("plan_upgrade_requests")
    .update({ status: "pending", resolved_at: null })
    .eq("id", id)
    .eq("status", "approved")
    .select("id")
    .maybeSingle()

  if (revertError) {
    fail(`${reason} Also, the request could not be put back to pending (${revertError.message}). It may be stuck as approved without a plan change and needs platform-admin attention.`)
  }
  if (!reverted) {
    fail(`${reason} The request was no longer in the approved state when we tried to put it back, so it was left untouched. Please check it on this page; it may need platform-admin attention.`)
  }
  fail(reason)
}

export async function approveUpgrade(formData: FormData) {
  await requirePlatformAdmin()
  const id = String(formData.get("id") ?? "")
  if (!id) fail("Missing request id.")

  const supabase = getSupabaseServerClient()
  if (!supabase) fail("Supabase isn't configured.")

  // Only real Booking & Queue plans may be applied to a shop. Check BEFORE
  // claiming the request, so a bad one (e.g. "shisha", or any key filed before
  // this check existed) stays pending and can simply be declined, and
  // tenants.plan is never touched.
  const { data: pendingRequest, error: lookupError } = await supabase
    .from("plan_upgrade_requests")
    .select("requested_plan_key")
    .eq("id", id)
    .eq("status", "pending")
    .maybeSingle()
  if (lookupError) fail(lookupError.message)
  if (!pendingRequest) fail("That request was already handled.")
  if (!isBookingQueuePlanKey(pendingRequest.requested_plan_key)) {
    fail("This request is for a plan that can't be applied as a Booking & Queue upgrade. Decline it instead.")
  }

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

  // Belt and braces: re-validate the exact value we are about to write.
  if (!isBookingQueuePlanKey(claimed.requested_plan_key)) {
    await revertClaimAndFail(supabase, id, "This request is for a plan that can't be applied as a Booking & Queue upgrade. Decline it instead.")
  }

  const { error: planError } = await supabase
    .from("tenants")
    .update({ plan: claimed.requested_plan_key })
    .eq("id", claimed.tenant_id)

  if (planError) {
    // Put the request back so it can be retried.
    await revertClaimAndFail(supabase, id, `Couldn't change the plan: ${planError.message}.`)
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
