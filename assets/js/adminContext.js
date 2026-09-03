/**
 * config/adminContext.js — QLess V2 Tenant Admin Shell
 *
 * This file does NOT implement authentication, tenant resolution, role
 * resolution, or permission resolution. All of that already exists in
 * config/auth.js and the database (get_my_context, tenant_members, roles,
 * role_permissions, tenant_modules). This file only ADAPTS those existing
 * primitives into one stable shape — `AdminContext` — that the Tenant Admin
 * Shell consumes, so the shell never needs to know how auth/tenant/role/
 * permission resolution actually works.
 *
 * enabledModules here is UI/application entitlement data (what the sidebar
 * shows), NOT a security boundary. RLS and the existing permission
 * functions (user_has_permission, tenant_has_module) remain the real
 * authorization layer regardless of what this returns.
 */

import { supabase } from './supabase.js';
import { requireAuth, signOutUser } from './auth.js';

/**
 * @typedef {Object} AdminContext
 * @property {{id: string, email: string}} user
 * @property {{fullName: string|null, avatarUrl: string|null}|null} profile
 * @property {boolean} isPlatformAdmin
 * @property {{id: string, name: string, slug: string}|null} activeTenant
 * @property {{key: string, name: string}|null} role
 * @property {string[]} permissions
 * @property {{name: string, logoUrl: string|null, primaryColor: string|null, secondaryColor: string|null}|null} branding
 * @property {{key: string, name: string, icon: string|null, path: string|null}[]} enabledModules
 */

const FALLBACK_ICON = 'fa-solid fa-square';

/**
 * Resolves the full AdminContext for the currently authenticated tenant
 * owner/admin on this hostname. Redirects (via requireAuth) if the user
 * isn't signed in, isn't recognized on this domain's tenant, or isn't a
 * tenant_owner — mirroring exactly what every other protected V2 page does.
 *
 * @param {string[]} allowedRoles - defaults to tenant_owner only for this phase
 * @returns {Promise<AdminContext|null>} null means requireAuth already redirected
 */
export async function loadAdminContext(allowedRoles = ['tenant_owner']) {
  const auth = await requireAuth(allowedRoles);
  if (!auth) return null; // already redirected by requireAuth

  const { user, context, role } = auth;

  const [profileResult, brandingResult, modulesResult, permissionsResult] = await Promise.all([
    fetchProfile(user.id),
    fetchBranding(context.tenant_id),
    fetchEnabledModules(context.tenant_id),
    fetchPermissionKeys(context.tenant_id, user.id),
  ]);

  return {
    user: { id: user.id, email: user.email },
    profile: profileResult,
    isPlatformAdmin: !!context.is_platform_admin,
    activeTenant: context.tenant_id
      ? { id: context.tenant_id, name: context.tenant_name, slug: context.tenant_slug }
      : null,
    role: role ? { key: role, name: roleDisplayName(role) } : null,
    permissions: permissionsResult,
    branding: brandingResult,
    enabledModules: modulesResult,
  };
}

function roleDisplayName(roleKey) {
  const names = {
    platform_superadmin: 'Platform Superadmin',
    tenant_owner: 'Tenant Owner/Admin',
    tenant_staff: 'Tenant Staff',
    customer: 'Customer',
  };
  return names[roleKey] ?? roleKey;
}

async function fetchProfile(userId) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return data ? { fullName: data.full_name, avatarUrl: data.avatar_url } : null;
  } catch (err) {
    console.error('❌ AdminContext: profile fetch failed', err);
    return null;
  }
}

async function fetchBranding(tenantId) {
  if (!tenantId) return null;
  try {
    const { data, error } = await supabase
      .from('tenant_branding')
      .select('display_name, logo_url, primary_color, secondary_color')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      name: data.display_name,
      logoUrl: data.logo_url,
      primaryColor: data.primary_color,
      secondaryColor: data.secondary_color,
    };
  } catch (err) {
    console.error('❌ AdminContext: branding fetch failed', err);
    return null;
  }
}

/**
 * modules JOIN tenant_modules, filtered to enabled=true for this tenant.
 * This is the ONLY place enabled-module state is read from — never cached
 * into localStorage/constants. Re-run this (or re-call loadAdminContext)
 * any time tenant_modules may have changed.
 */
async function fetchEnabledModules(tenantId) {
  if (!tenantId) return [];
  try {
    const { data, error } = await supabase
      .from('tenant_modules')
      .select('enabled, modules ( key, name, icon, path, display_order )')
      .eq('tenant_id', tenantId)
      .eq('enabled', true);
    if (error) throw error;
    return (data || [])
      .map((row) => row.modules)
      .filter(Boolean)
      .sort((a, b) => {
        if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
        if (a.display_order != null) return -1;
        if (b.display_order != null) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((m) => ({
        key: m.key,
        name: m.name,
        icon: m.icon || FALLBACK_ICON,
        path: m.path || null, // null = module not built yet; shell shows "coming soon"
      }));
  } catch (err) {
    console.error('❌ AdminContext: enabled modules fetch failed', err);
    return [];
  }
}

/**
 * Permission keys for the active tenant/role, via the existing
 * role_permissions join — NOT re-derived or duplicated logic, just read
 * for the shell to use for UI-level show/hide. The database functions
 * (user_has_permission) remain authoritative for actual authorization.
 */
async function fetchPermissionKeys(tenantId, userId) {
  if (!tenantId || !userId) return [];
  try {
    const { data, error } = await supabase
      .from('tenant_members')
      .select('role:roles ( role_permissions ( permissions ( key ) ) )')
      .eq('tenant_id', tenantId)
      .eq('profile_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw error;
    const rp = data?.role?.role_permissions || [];
    return rp.map((r) => r.permissions?.key).filter(Boolean);
  } catch (err) {
    console.error('❌ AdminContext: permissions fetch failed', err);
    return [];
  }
}

export { signOutUser };
