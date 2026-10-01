// lib/tenant/require-tenant-permission.ts
//
// Permission gate that sits on top of requireTenantMember(). Every admin
// Server Action (and every server-side data load in app/admin/page.tsx
// that touches staff or payroll data) should go through this instead of
// just requireTenantMember() alone — membership only proves "this person
// works at this shop", not "this person is allowed to see/edit this".
//
// WHY THIS CAN'T USE THE SERVICE-ROLE CLIENT
// -------------------------------------------
// public.user_has_permission(p_tenant_id, p_permission_key, p_uid) is
// SECURITY DEFINER with `p_uid uuid default auth.uid()`, and its body
// (see is_platform_admin()) treats an explicitly-passed p_uid that
// doesn't match the *caller's own* auth.uid() as untrusted unless the
// real caller is already a platform admin:
//
//   if p_uid is null or p_uid = auth.uid() then v_effective_uid := auth.uid();
//   elsif <caller is already a platform admin> then v_effective_uid := p_uid;
//   else v_effective_uid := auth.uid(); -- spoofed uid silently ignored
//
// getSupabaseServerClient() (lib/supabase/admin.ts) authenticates with the
// service-role key, which carries no user JWT — auth.uid() is null in
// that context. Passing our own userId as p_uid from a service-role
// connection hits the "silently ignored" branch above and always
// resolves to null, so the RPC would always return false. The RPC has to
// run on the session-scoped client instead, where auth.uid() resolves
// naturally from the signed-in user's own JWT.
//
// The service-role client is still what actually reads/writes the scoped
// data afterwards (same as every other action in app/admin/actions.ts) —
// this helper only answers "is this user allowed", it never fetches rows.

import { createSessionClient } from "@/lib/supabase/session-server"
import { requireTenantMember, type CurrentTenantMember } from "./current-tenant-member"

// Keep in sync with the `permissions.key` rows the staff/payroll
// migration inserted, plus the pre-existing keys already in use
// elsewhere in app/admin/actions.ts.
export type PermissionKey =
  | "staff.view"
  | "staff.manage"
  | "payroll.view"
  | "payroll.manage"
  | "bookings.view"
  | "bookings.manage"
  | "services.manage"
  | "settings.manage"
  | "queue.view"
  | "queue.manage"

export type PermissionCheckResult =
  | { ok: true; member: CurrentTenantMember }
  | { ok: false; error: string }

/**
 * Redirects (via requireTenantMember()) if there's no session / no active
 * tenant membership, then checks the given permission against the
 * *signed-in user's own* session — never trusts a client-supplied
 * tenantId or userId. Returns an ActionResult-shaped result rather than
 * redirecting on a failed permission check, since Server Actions need to
 * surface "you don't have permission" as UI state, not a navigation.
 */
export async function requireTenantPermission(
  permission: PermissionKey,
): Promise<PermissionCheckResult> {
  const member = await requireTenantMember()

  const supabase = await createSessionClient()
  const { data, error } = await supabase.rpc("user_has_permission", {
    p_tenant_id: member.tenantId,
    p_permission_key: permission,
  })

  if (error) {
    return { ok: false, error: "Couldn't verify your permissions — try again." }
  }
  if (!data) {
    return { ok: false, error: "You don't have permission to do that." }
  }

  return { ok: true, member }
}

/**
 * Bulk variant for a Server Component data load (app/admin/page.tsx) that
 * needs to know several permissions up front to decide what to fetch at
 * all — e.g. skip the payroll query entirely for a viewer without
 * payroll.view, rather than fetching and then hiding it client-side.
 * One round trip: user_has_permission is STABLE, so this batches cleanly.
 */
export async function getTenantPermissions(
  keys: PermissionKey[],
): Promise<{ member: CurrentTenantMember; granted: Set<PermissionKey> }> {
  const member = await requireTenantMember()
  const supabase = await createSessionClient()

  const results = await Promise.all(
    keys.map((key) =>
      supabase
        .rpc("user_has_permission", { p_tenant_id: member.tenantId, p_permission_key: key })
        .then((r) => [key, !r.error && Boolean(r.data)] as const),
    ),
  )

  return { member, granted: new Set(results.filter(([, ok]) => ok).map(([key]) => key)) }
}
