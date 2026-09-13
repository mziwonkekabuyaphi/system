"use server";

import { randomBytes } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSessionClient } from "@/lib/supabase/session-server";
import { getSupabaseServerClient } from "@/lib/supabase/admin";

const TENANT_OWNER_ROLE_KEY = "tenant_owner";

async function getCurrentUserOrRedirect() {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function uniqueSlug(
  admin: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  base: string
): Promise<string> {
  const root = slugify(base) || "business";
  let candidate = root;
  let suffix = 1;

  while (true) {
    const { data, error } = await admin
      .from("tenants")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw new Error(`Failed to check slug availability: ${error.message}`);
    if (!data) return candidate;
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
}

export async function createTenantAction(formData: FormData) {
  const user = await getCurrentUserOrRedirect();
  const businessName = String(formData.get("businessName") ?? "").trim();

  if (!businessName) {
    return { error: "Enter a business name." };
  }

  const admin = getSupabaseServerClient();
  if (!admin) {
    return { error: "Admin isn't configured. Set SUPABASE_SERVICE_ROLE_KEY." };
  }

  const { data: ownerRole, error: roleError } = await admin
    .from("roles")
    .select("id")
    .eq("key", TENANT_OWNER_ROLE_KEY)
    .single();

  if (roleError || !ownerRole) {
    return { error: "Couldn't find the tenant_owner role. Check the roles table." };
  }

  const slug = await uniqueSlug(admin, businessName);

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: businessName, slug })
    .select("id")
    .single();

  if (tenantError || !tenant) {
    return { error: `Failed to create business: ${tenantError?.message}` };
  }

  // trg_handle_new_tenant fires here and creates tenant_settings,
  // tenant_branding, booking_settings, queue_settings, message_settings
  // in the same transaction -- nothing else to insert for those.

  const { error: memberError } = await admin.from("tenant_members").insert({
    tenant_id: tenant.id,
    profile_id: user.id,
    role_id: ownerRole.id,
    status: "active",
  });

  if (memberError) {
    await admin.from("tenants").delete().eq("id", tenant.id);
    return { error: `Failed to link you to the business: ${memberError.message}` };
  }

  revalidatePath("/admin");
  redirect("/admin");
}

export async function joinTenantAction(formData: FormData) {
  const user = await getCurrentUserOrRedirect();
  const code = String(formData.get("inviteCode") ?? "").trim();

  if (!code) {
    return { error: "Enter an invite code." };
  }

  const admin = getSupabaseServerClient();
  if (!admin) {
    return { error: "Admin isn't configured. Set SUPABASE_SERVICE_ROLE_KEY." };
  }

  const { data: invite, error: inviteError } = await admin
    .from("tenant_invites")
    .select("id, tenant_id, role_id, email, status, expires_at")
    .eq("code", code)
    .maybeSingle();

  if (inviteError) return { error: `Failed to look up invite: ${inviteError.message}` };
  if (!invite) return { error: "That invite code isn't valid." };
  if (invite.status !== "pending") return { error: "That invite has already been used or revoked." };
  if (new Date(invite.expires_at) < new Date()) return { error: "That invite code has expired." };
  if (invite.email && invite.email.toLowerCase() !== (user.email ?? "").toLowerCase()) {
    return { error: "This invite was issued for a different email address." };
  }

  const { error: memberError } = await admin.from("tenant_members").insert({
    tenant_id: invite.tenant_id,
    profile_id: user.id,
    role_id: invite.role_id,
    status: "active",
  });

  if (memberError) {
    if (memberError.code === "23505") {
      return { error: "You're already a member of that business." };
    }
    return { error: `Failed to join: ${memberError.message}` };
  }

  await admin
    .from("tenant_invites")
    .update({ status: "accepted", accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  revalidatePath("/admin");
  redirect("/admin");
}

// For later: wire this to an "Invite teammate" button in the admin Team
// settings tab. joinTenantAction above has nothing to redeem without it.
export async function createInviteAction(
  tenantId: string,
  roleKey: "tenant_owner" | "tenant_staff",
  email?: string
) {
  const user = await getCurrentUserOrRedirect();
  const admin = getSupabaseServerClient();
  if (!admin) throw new Error("Admin isn't configured.");

  const { data: membership } = await admin
    .from("tenant_members")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("profile_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (!membership) throw new Error("You're not a member of this business.");

  const { data: role, error: roleError } = await admin
    .from("roles")
    .select("id")
    .eq("key", roleKey)
    .single();
  if (roleError || !role) throw new Error("Unknown role.");

  const code = randomBytes(5).toString("hex");

  const { data: invite, error } = await admin
    .from("tenant_invites")
    .insert({ tenant_id: tenantId, role_id: role.id, email: email || null, code, created_by: user.id })
    .select("code, expires_at")
    .single();

  if (error || !invite) throw new Error(`Failed to create invite: ${error?.message}`);

  return invite;
}
