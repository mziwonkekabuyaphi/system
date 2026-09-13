// lib/tenant/current-tenant-member.ts
//
// Resolves "who is signed in, and which tenant/role do they act as"
// once per request. Every admin query needs a tenant_id to scope by —
// this is where that tenant_id comes from.
//
// NOTE: a profile can have more than one tenant_members row (roles.scope
// distinguishes a platform-wide role from a tenant-scoped one, and
// nothing stops one person being tenant_staff at two shops). This picks
// the first active membership, which is fine while each shop owner has
// exactly one shop. Add a tenant switcher before that assumption breaks.
//
// platform_superadmin members have no tenant_members row at all (that
// role is platform-scoped, not attached to a tenant) — they're treated
// as "no tenant" here and redirected accordingly. A cross-tenant
// platform view is a separate piece of UI, not this admin page.
//
// requireTenantMember() distinguishes two different "not ready" states:
//   - not signed in at all            -> /login
//   - signed in, but no active tenant -> /onboarding (create or join a business)
// Collapsing these into one redirect used to send freshly-confirmed
// signups back to /login, where they had nothing useful to do.

import { cache } from "react";
import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/session-server";

export type CurrentTenantMember = {
  userId: string;
  email: string | null;
  tenantId: string;
  tenantMemberId: string;
  roleKey: "tenant_owner" | "tenant_staff";
};

/**
 * Returns the signed-in Supabase auth user, or null if there's no
 * session. Cached per request so this and getCurrentTenantMember share
 * one auth.getUser() call instead of each paying for their own.
 */
export const getSessionUser = cache(async () => {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * Returns null if the visitor isn't signed in, or is signed in but has no
 * active tenant membership. Cached per request so layout.tsx and
 * page.tsx (and any Server Actions on the same request) don't each pay
 * for their own round trip.
 */
export const getCurrentTenantMember = cache(
  async (): Promise<CurrentTenantMember | null> => {
    const user = await getSessionUser();
    if (!user) return null;

    const supabase = await createSessionClient();
    const { data, error } = await supabase
      .from("tenant_members")
      .select("id, tenant_id, status, roles ( key )")
      .eq("profile_id", user.id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (error || !data || !data.roles) return null;

    const roleKey = (data.roles as unknown as { key: string }).key;
    if (roleKey !== "tenant_owner" && roleKey !== "tenant_staff") return null;

    return {
      userId: user.id,
      email: user.email ?? null,
      tenantId: data.tenant_id,
      tenantMemberId: data.id,
      roleKey,
    };
  }
);

/**
 * Use in layout.tsx / page.tsx / Server Actions that must not run without
 * a signed-in tenant member.
 *
 * - No session at all -> redirect to /login.
 * - Signed in, but no active tenant membership -> redirect to /onboarding,
 *   since this is exactly the state a freshly-confirmed signup is in
 *   before they've created or joined a business.
 */
export async function requireTenantMember(): Promise<CurrentTenantMember> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login?next=/admin");
  }

  const member = await getCurrentTenantMember();
  if (!member) {
    redirect("/onboarding");
  }

  return member;
}
