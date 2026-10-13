// lib/sales/auth.ts
//
// Auth gates for the sales-commission feature. Same pattern as
// lib/tenant/require-tenant-permission.ts: identity comes from the SESSION
// client (so auth.uid() resolves), never from anything the browser sends.
//
//  - requireSalesperson(): any signed-in user with an active salespeople row.
//    Their data is read through the salesperson_my_* Postgres functions, which
//    re-derive the salesperson from auth.uid() themselves, so a salesperson can
//    only ever see their own clients and commissions.
//  - requirePlatformAdmin(): rows in platform_admins only. Used by every
//    action that calls an admin-only commission function with the service-role
//    client (those functions trust the service role, so THIS check is the gate).

import { redirect } from "next/navigation"

import { createSessionClient } from "@/lib/supabase/session-server"

export async function requireSalesperson() {
  const supabase = await createSessionClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect("/login")

  const { data: salesperson } = await supabase
    .from("salespeople")
    .select("id, referral_code, status")
    .eq("profile_id", data.user.id)
    .maybeSingle()

  if (!salesperson || salesperson.status === "terminated") redirect("/login")

  return { supabase, userId: data.user.id, salesperson }
}

/** Returns the signed-in user's id if they are a platform admin, else null. */
export async function getPlatformAdminId(): Promise<string | null> {
  const supabase = await createSessionClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return null

  const { data: isAdmin, error } = await supabase.rpc("is_platform_admin")
  if (error || !isAdmin) return null
  return data.user.id
}

export async function requirePlatformAdmin(): Promise<string> {
  const id = await getPlatformAdminId()
  if (!id) redirect("/login")
  return id
}
