/**
 * config/auth.js — QLess Systems V2 Auth
 *
 * TENANT CONTEXT: resolved from the current hostname via `tenant_domains`
 * (rands.co.za → Rands, venueb.co.za → Venue B, etc). There is no venue
 * picker and no client-supplied tenant_id — the browser only ever tells
 * Postgres its hostname; `get_tenant_by_domain` / `get_my_context` /
 * `register_as_tenant_customer` resolve that to a tenant_id server-side.
 * RLS is still the real security boundary regardless of what any of these
 * functions return — this module only decides *where to route the user*,
 * it never grants access itself.
 *
 * ROLES: there is no single `profiles.role` column. A person's role is
 * contextual:
 *   - platform_admins            → platform superadmin (not tenant-scoped)
 *   - tenant_members.role_id     → 'tenant_owner' | 'tenant_staff' for THIS tenant
 *   - tenant_customers           → a customer of THIS tenant (no elevated access)
 * A single person can be several of these at once, for different tenants.
 * `get_my_context(domain)` returns all of it in one call, already scoped to
 * the tenant that owns the current domain.
 */

import { supabase } from './supabase.js';

/* =========================
   ROLE ROUTES
   platform_superadmin → /superadmin/dashboard.html (platform-level, not tenant-scoped)
   tenant_owner         → /tenant/dashboard.html
   tenant_staff         → /staff/console.html
   customer             → /passport/home.html
   (mobile_scanner and other future roles are added when their module ships)
========================= */
export const ROLE_ROUTES = {
  platform_superadmin: '/superadmin/dashboard.html',
  tenant_owner:        '/tenant/dashboard.html',
  tenant_staff:        '/staff/console.html',
  customer:            '/passport/home.html',
};

/* =========================
   TENANT CONTEXT (domain → tenant)
========================= */

// Pre-auth: resolve the current hostname to a tenant + its branding.
// Safe to call from an anonymous visitor (same trust level as public tenant_branding).
export async function resolveTenantByDomain(hostname = window.location.hostname) {
  try {
    const { data, error } = await supabase.rpc('get_tenant_by_domain', { p_domain: hostname });
    if (error) {
      console.error('❌ Tenant domain resolution error:', error.message);
      return { tenant: null, error };
    }
    const tenant = Array.isArray(data) ? data[0] : data;
    if (!tenant) return { tenant: null, error: 'UNKNOWN_DOMAIN' };
    return { tenant, error: null };
  } catch (err) {
    console.error('❌ Tenant domain resolution crash:', err);
    return { tenant: null, error: err };
  }
}

// Post-auth: everything needed to route the signed-in user, already scoped
// to the tenant that owns the current hostname.
// Returns null if there is no active session at all.
export async function getMyContext(hostname = window.location.hostname) {
  try {
    const { data, error } = await supabase.rpc('get_my_context', { p_domain: hostname });
    if (error) {
      console.error('❌ get_my_context error:', error.message);
      return { context: null, error };
    }
    const context = Array.isArray(data) ? data[0] : data;
    return { context: context ?? null, error: null };
  } catch (err) {
    console.error('❌ get_my_context crash:', err);
    return { context: null, error: err };
  }
}

// Priority: platform admin > tenant staff/admin (for THIS domain's tenant) > customer (for THIS domain's tenant).
// Returns null if the signed-in user has no relationship to this domain's tenant at all.
export function resolveRoleFromContext(context) {
  if (!context) return null;
  if (context.is_platform_admin) return 'platform_superadmin';
  if (context.member_role_key === 'tenant_owner' && context.member_status === 'active') return 'tenant_owner';
  if (context.member_role_key === 'tenant_staff' && context.member_status === 'active') return 'tenant_staff';
  if (context.customer_id && context.customer_status === 'active') return 'customer';
  return null;
}

/* =========================
   CUSTOMER SELF-REGISTRATION
   Creates/updates the CURRENT user's tenant_customers row for whichever
   tenant owns the current hostname. Never touches tenant_members/roles —
   this can only ever produce a customer relationship, never staff/admin access.
========================= */
export async function registerAsTenantCustomer({ fullName, phone, email } = {}, hostname = window.location.hostname) {
  try {
    const { data, error } = await supabase.rpc('register_as_tenant_customer', {
      p_domain: hostname,
      p_full_name: fullName ?? null,
      p_phone: phone ?? null,
      p_email: email ?? null,
    });
    if (error) {
      console.error('❌ Customer registration error:', error.message);
      return { customer: null, error };
    }
    return { customer: data, error: null };
  } catch (err) {
    console.error('❌ Customer registration crash:', err);
    return { customer: null, error: err };
  }
}

/* =========================
   SIGN IN — PASSPORT (unified email OR phone + password)
   NOTE: phone+password sign-in requires Supabase's phone auth provider to be
   configured, which Phase 1 does not set up yet (email/password is the only
   mechanism wired up so far). The identity layer supports adding it later
   without a schema change — this wrapper is kept so the UI doesn't need to
   change when that happens.
========================= */
export async function signInWithPassport(identifierType, identifierValue, password) {
  try {
    const payload =
      identifierType === 'email'
        ? { email: identifierValue, password }
        : { phone: identifierValue, password };
    const { data, error } = await supabase.auth.signInWithPassword(payload);
    if (error) return { user: null, error: formatAuthError(error) };
    return { user: data.user, error: null };
  } catch (err) {
    console.error('❌ Passport sign in crash:', err);
    return { user: null, error: 'Network error. Please check your connection and try again.' };
  }
}

export async function signIn(email, password) {
  return signInWithPassport('email', email, password);
}

export async function signInWithPhone(phone, pin) {
  return signInWithPassport('phone', phone, pin);
}

/* =========================
   SIGN OUT
========================= */
export async function signOutUser() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('❌ Sign out error:', error.message);
      return { error };
    }
    window.location.href = '/login.html';
    return { error: null };
  } catch (err) {
    console.error('❌ Sign out crash:', err);
    return { error: { message: 'Failed to sign out.' } };
  }
}

/* =========================
   CURRENT SESSION / USER
========================= */
export async function getCurrentSession() {
  try {
    const { data, error } = await supabase.auth.getSession();
    return { session: data.session, error };
  } catch (err) {
    console.error('❌ Session fetch crash:', err);
    return { session: null, error: err };
  }
}

export async function getCurrentUser() {
  try {
    const { data, error } = await supabase.auth.getUser();
    return { user: data?.user ?? null, error };
  } catch (err) {
    console.error('❌ Current user crash:', err);
    return { user: null, error: err };
  }
}

/* =========================
   GET SESSION WITH CONTEXT
   Returns { user: {id, email}, context, role } or null if there's no session.
   `role` is one of ROLE_ROUTES' keys, or null if this user has no
   relationship to the current domain's tenant at all.
========================= */
export async function getSessionWithContext(hostname = window.location.hostname) {
  try {
    const { session } = await getCurrentSession();
    if (!session) return null;

    const { context, error } = await getMyContext(hostname);
    if (error) return null;

    return {
      user: { id: session.user.id, email: session.user.email },
      context,
      role: resolveRoleFromContext(context),
    };
  } catch (err) {
    console.error('❌ getSessionWithContext crash:', err);
    return null;
  }
}

/* =========================
   ROLE REDIRECT HELPERS
========================= */
export function getRoleRedirectUrl(role) {
  if (!role) return null;
  return ROLE_ROUTES[role] ?? null;
}

export function redirectByRole(role) {
  const url = getRoleRedirectUrl(role);
  if (!url) {
    console.error('❌ Cannot redirect: invalid, missing, or unrecognized role for this venue →', role);
    return false;
  }
  console.log('➡️  Redirecting to:', url);
  window.location.href = url;
  return true;
}

/* =========================
   REQUIRE AUTH  (route guard)

   Usage:
     const { user, context, role } = await requireAuth(['tenant_owner', 'tenant_staff']) ?? {};
     if (!user) return; // already redirected

   allowedRoles: [] → any authenticated user with SOME relationship to this
                       tenant (staff, admin, customer, or platform admin) may proceed
   allowedRoles: ['tenant_owner'] → only tenant admins; others are redirected
                       to their own dashboard (or to register, if they're
                       authenticated but have no relationship to this tenant at all)

   Redirects to /login.html when:
     • no session
     • unexpected error resolving context

   Redirects to /register.html when:
     • authenticated, but no platform/staff/customer relationship to THIS
       tenant exists yet (e.g. signed up on a different venue's domain, or
       signed up but never completed registerAsTenantCustomer())

   Redirects to role dashboard when:
     • user is authenticated with a role, but it isn't in allowedRoles
========================= */
export async function requireAuth(allowedRoles = []) {
  try {
    const { session } = await getCurrentSession();
    if (!session) {
      console.warn('⚠️ No session — redirecting to login');
      window.location.href = '/login.html';
      return null;
    }

    const { context, error } = await getMyContext();
    if (error) {
      console.error('❌ Auth guard — context fetch failed:', error);
      window.location.href = '/login.html?error=auth_error';
      return null;
    }

    if (!context || !context.tenant_id) {
      console.warn('⚠️ This domain is not a recognized venue');
      window.location.href = '/login.html?error=unknown_venue';
      return null;
    }

    const role = resolveRoleFromContext(context);

    if (!role) {
      console.warn('⚠️ Authenticated but no relationship to this venue — sending to register');
      window.location.href = '/register.html';
      return null;
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
      console.warn('⛔ Access denied for role:', role, '| allowed:', allowedRoles);
      redirectByRole(role);
      return null;
    }

    return { user: session.user, context, role };
  } catch (err) {
    console.error('❌ Auth guard crash:', err);
    window.location.href = '/login.html';
    return null;
  }
}

/* =========================
   GOOGLE OAUTH
========================= */
export async function signInWithGoogle() {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/login.html' },
    });
    if (error) return { error: formatAuthError(error) };
    return { error: null };
  } catch (err) {
    console.error('❌ Google OAuth crash:', err);
    return { error: 'Network error. Please check your connection and try again.' };
  }
}

/* =========================
   PASSKEY (WebAuthn)
========================= */
export async function isPasskeySupported() {
  try {
    return (
      window.PublicKeyCredential !== undefined &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function' &&
      (await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

export async function signInWithPasskey() {
  try {
    const { data, error } = await supabase.auth.signInWithPasskey();
    if (error) return { user: null, error: formatAuthError(error) };
    return { user: data?.user ?? null, error: null };
  } catch (err) {
    console.error('❌ Passkey sign-in crash:', err);
    return { user: null, error: 'Passkey sign-in failed. Please try another method.' };
  }
}

/* =========================
   AUTH ERROR FORMATTER
========================= */
function formatAuthError(error) {
  const msg    = error.message?.toLowerCase() ?? '';
  const status = error.status;

  if (msg.includes('invalid login credentials'))  return 'Incorrect email or password.';
  if (msg.includes('email not confirmed'))         return 'Please verify your email before signing in.';
  if (status === 429 || msg.includes('too many')) return 'Too many attempts. Please wait and try again.';
  if (msg.includes('network') || msg.includes('fetch')) return 'Network error. Check your connection.';
  return error.message || 'Authentication failed.';
}
