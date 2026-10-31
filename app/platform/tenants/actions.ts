// app/platform/tenants/actions.ts
"use server"

// Platform-admin actions for shops. Same rule as app/platform/sales/actions.ts:
// every action calls requirePlatformAdmin() FIRST (session-based) because the
// writes below use the service-role client and trust the caller completely.

import { randomBytes } from "crypto"
import { revalidatePath } from "next/cache"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"
import { cleanModuleKeys, type NewShopModule } from "@/lib/services/new-shop-modules"
import { enableModulesForNewShop } from "@/lib/services/tenant-modules"

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

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

async function newOwnerInvite(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
  email: string | null,
  actor: string,
): Promise<string> {
  const { data: role, error: roleError } = await supabase.from("roles").select("id").eq("key", "tenant_owner").single()
  if (roleError || !role) throw new Error("Couldn't find the tenant_owner role. Check the roles table.")

  const code = randomBytes(5).toString("hex")
  const { error } = await supabase
    .from("tenant_invites")
    .insert({ tenant_id: tenantId, role_id: role.id, email, code, created_by: actor })
  if (error) throw new Error(`Failed to create invite: ${error.message}`)
  return code
}

/** Creates a shop and an owner invite code. The owner signs up, then redeems the code. */
export async function createShop(input: {
  name: string
  slug: string
  ownerEmail: string
  /** Modules to switch on from day one (booking, queue, shisha, shifts, payroll). */
  modules: NewShopModule[]
}): Promise<R<{ slug: string; inviteCode: string }>> {
  try {
    const { actor, supabase } = await ctx()
    const name = input.name.trim()
    const slug = input.slug.trim().toLowerCase()
    const ownerEmail = input.ownerEmail.trim().toLowerCase()

    if (name.length < 2) return { success: false, error: "Enter the business name." }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return { success: false, error: "Web address: lowercase letters, numbers and dashes only." }
    if (ownerEmail && !EMAIL.test(ownerEmail)) return { success: false, error: "Enter a valid owner email, or leave it blank." }

    const { data: taken, error: takenError } = await supabase.from("tenants").select("id").eq("slug", slug).maybeSingle()
    if (takenError) return fail(takenError)
    if (taken) return { success: false, error: "That web address is already taken." }

    // trg_handle_new_tenant creates the shop's settings rows in the same transaction.
    const { data: tenant, error: tenantError } = await supabase.from("tenants").insert({ name, slug }).select("id").single()
    if (tenantError || !tenant) return { success: false, error: `Failed to create shop: ${tenantError?.message}` }

    // No tenant_modules row means OFF, so write the chosen modules now (the form defaults to Booking + Queue).
    try {
      await enableModulesForNewShop(supabase, tenant.id, cleanModuleKeys(input.modules))
    } catch (e) {
      await supabase.from("tenants").delete().eq("id", tenant.id) // don't leave a shop with nothing on
      return fail(e)
    }

    let inviteCode: string
    try {
      inviteCode = await newOwnerInvite(supabase, tenant.id, ownerEmail || null, actor)
    } catch (e) {
      await supabase.from("tenants").delete().eq("id", tenant.id) // don't leave an ownerless shop behind
      return fail(e)
    }

    revalidatePath("/platform")
    revalidatePath("/platform/tenants")
    return { success: true, slug, inviteCode }
  } catch (e) { return fail(e) }
}

/** A fresh owner invite for an existing shop (the first one expired, or the owner changed). */
export async function createOwnerInvite(input: { tenantId: string; ownerEmail: string }): Promise<R<{ inviteCode: string }>> {
  try {
    const { actor, supabase } = await ctx()
    const ownerEmail = input.ownerEmail.trim().toLowerCase()
    if (ownerEmail && !EMAIL.test(ownerEmail)) return { success: false, error: "Enter a valid owner email, or leave it blank." }

    const { data: tenant, error } = await supabase.from("tenants").select("id").eq("id", input.tenantId).maybeSingle()
    if (error) return fail(error)
    if (!tenant) return { success: false, error: "Shop not found." }

    const inviteCode = await newOwnerInvite(supabase, tenant.id, ownerEmail || null, actor)
    return { success: true, inviteCode }
  } catch (e) { return fail(e) }
}
