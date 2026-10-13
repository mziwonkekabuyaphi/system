// app/platform/sales/actions.ts
"use server"

// Platform-admin actions for the commission system. The commission SQL
// functions trust the service-role client, so EVERY action here first calls
// requirePlatformAdmin() (session-based) — that check is the real gate.

import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

type R<T = object> = ({ success: true } & T) | { success: false; error: string }

async function ctx() {
  const actor = await requirePlatformAdmin()
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Admin isn't configured")
  return { actor, supabase }
}

const fail = (e: unknown): { success: false; error: string } => ({
  success: false,
  error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e),
})
const done = () => {
  revalidatePath("/platform/sales")
  return { success: true as const }
}

export async function approveSignup(input: { signupId: string; slug: string; plan: string }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    const slug = input.slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return { success: false, error: "Slug: lowercase letters, numbers and dashes only." }
    if (!["free", "growth", "business"].includes(input.plan)) return { success: false, error: "Pick a valid plan." }
    const { error } = await supabase.rpc("approve_referral_signup", {
      p_signup_id: input.signupId, p_slug: slug, p_plan: input.plan, p_actor: actor,
    })
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}

export async function rejectSignup(input: { signupId: string; reason: string }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    const { error } = await supabase.rpc("reject_referral_signup", {
      p_signup_id: input.signupId, p_reason: input.reason.trim() || "rejected", p_actor: actor,
    })
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}

export async function createSalespersonAccount(input: { email: string; fullName: string; password: string }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    const email = input.email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { success: false, error: "Enter a valid email." }
    if (input.password.length < 8) return { success: false, error: "Password must be at least 8 characters." }
    const { data, error } = await supabase.auth.admin.createUser({
      email, password: input.password, email_confirm: true,
      user_metadata: { full_name: input.fullName.trim() },
    })
    if (error || !data.user) return fail(error ?? "Could not create user")
    const { error: spErr } = await supabase.rpc("create_salesperson", { p_profile_id: data.user.id, p_code: null, p_actor: actor })
    if (spErr) return fail(spErr)
    return done()
  } catch (e) { return fail(e) }
}

export async function setSalespersonStatus(input: { salespersonId: string; status: "active" | "suspended" | "terminated" }): Promise<R> {
  try {
    const { supabase } = await ctx()
    const { error } = await supabase.from("salespeople").update({ status: input.status }).eq("id", input.salespersonId)
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}

export async function reassignTenant(input: { tenantId: string; salespersonId: string; reason: string }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    if (input.reason.trim().length < 5) return { success: false, error: "Give a reason (at least 5 characters)." }
    const { error } = await supabase.rpc("reassign_tenant_referral", {
      p_tenant_id: input.tenantId, p_new_salesperson_id: input.salespersonId, p_reason: input.reason.trim(), p_actor: actor,
    })
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}

export async function runMonthlyPayouts(input: { period: string }): Promise<R<{ message: string }>> {
  try {
    const { actor, supabase } = await ctx()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) return { success: false, error: "Period must look like 2026-10." }
    const { data: approved, error: aErr } = await supabase.rpc("approve_due_commissions", { p_actor: actor })
    if (aErr) return fail(aErr)
    const { data: people } = await supabase.from("salespeople").select("id").neq("status", "terminated")
    let built = 0
    for (const p of people ?? []) {
      const { error } = await supabase.rpc("build_commission_payout", { p_salesperson_id: p.id, p_period: input.period, p_actor: actor })
      if (!error) built++ // "nothing_to_pay" is an expected skip
    }
    revalidatePath("/platform/sales")
    return { success: true, message: `${approved ?? 0} commissions became payable; ${built} payout(s) prepared.` }
  } catch (e) { return fail(e) }
}

export async function markPayoutPaid(input: { payoutId: string; reference: string }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    if (input.reference.trim().length < 3) return { success: false, error: "Enter the EFT reference." }
    const { error } = await supabase.rpc("mark_commission_payout_paid", {
      p_payout_id: input.payoutId, p_reference: input.reference.trim(), p_actor: actor,
    })
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}

export async function addAdjustment(input: { salespersonId: string; rands: number; note: string }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    const cents = Math.round(input.rands * 100)
    if (!Number.isFinite(cents) || cents === 0) return { success: false, error: "Enter a non-zero amount." }
    if (input.note.trim().length < 3) return { success: false, error: "Add a note." }
    const { error } = await supabase.rpc("add_commission_adjustment", {
      p_salesperson_id: input.salespersonId, p_amount_cents: cents, p_note: input.note.trim(), p_actor: actor,
    })
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}

export async function updateRule(input: { planKey: string; bountyRands: number; ratePercent: number }): Promise<R> {
  try {
    const { actor, supabase } = await ctx()
    const { error } = await supabase.rpc("set_commission_rule", {
      p_plan_key: input.planKey,
      p_bounty_cents: Math.round(input.bountyRands * 100),
      p_rate_bps: Math.round(input.ratePercent * 100),
      p_effective_from: new Date().toISOString(),
      p_actor: actor,
    })
    if (error) return fail(error)
    return done()
  } catch (e) { return fail(e) }
}
