// lib/services/customer.ts
/**
 * Customer Identity Service — the single source of truth for customer identity.
 *
 * Architecture rules:
 * - ensureCustomer() may only be called from reply.ts (orchestration layer).
 * - Downstream services (wallet, tickets, orders, vvip, support, events) must
 *   only call getCustomer(), updateCustomer(), isRegistrationComplete().
 * - No downstream service may create, delete, or directly mutate a profile row.
 *
 * Registration is incremental and conversational:
 * - Minimal profile is created on first message (phone only).
 * - Registration begins only when a guarded action is attempted (buy ticket, etc.).
 * - Fields are collected one at a time; the service returns the next missing field.
 *
 * CHANGED (Passport Key rework):
 * WhatsApp registration no longer collects or requires a password. A wallet
 * is now provisioned as soon as name + surname + email are known —
 * `registration_complete` means "has a working wallet," full stop. It no
 * longer implies an auth user exists.
 *
 * `auth_user_id` is the thing that now independently tracks web access:
 *   - null      → customer has a wallet, but no web login yet ("no Passport Key")
 *   - not null  → customer can log in on the web app
 *
 * A customer sets their Passport Key later, from the web app, once they
 * prove ownership of their email via a WhatsApp OTP. That whole flow (OTP
 * storage, verification, and creating the Supabase Auth user) lives in the
 * WEB APP REPO's own lib/services/passport-key.ts — not here, since this
 * repo has no access to that OTP table or the customer's web session. This
 * repo's only job in that story is completeWhatsAppRegistration() below:
 * getting the wallet provisioned in the first place. The internal API route
 * at app/api/internal/send-whatsapp-message (this repo) is what the web
 * repo calls to actually deliver the OTP over WhatsApp.
 *
 * completeRegistration(phone, password) is kept, unchanged in behaviour,
 * for the *separate* full web signup flow (register.html web-only path,
 * where a brand-new customer supplies email + password together with no
 * prior WhatsApp profile). Do not call it from the WhatsApp registration
 * flow anymore — use completeWhatsAppRegistration() instead.
 *
 * INVARIANT: `registration_complete` must only ever be set to `true` after
 * the wallet exists (name/surname/email are set). It says nothing about
 * whether an auth user exists — check `auth_user_id` for that separately.
 *
 * NOTE on wallet_id: `profiles.wallet_id` has a DB-level default
 * (generate_wallet_id()) and a CHECK constraint requiring a 16-digit
 * numeric string. It is assigned automatically by Postgres the moment
 * ensureCustomer() inserts the row — this service must never generate or
 * overwrite it itself.
 */

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js';
import type { SupabaseClient, User } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface Customer {
  id: string;
  phone: string;
  name: string | null;
  surname: string | null;
  email: string | null;
  auth_user_id: string | null;
  wallet_id: string | null;
  registration_complete: boolean;
  created_at: string;
  updated_at: string;
}

/** Raw shape of a `profiles` row as returned by Supabase, before mapping. */
interface ProfileRow {
  id: string;
  phone: string;
  name: string | null;
  surname: string | null;
  email: string | null;
  auth_user_id: string | null;
  wallet_id: string | null;
  registration_complete: boolean | null;
  created_at: string;
  updated_at: string;
}

// 'password' removed — WhatsApp registration never asks for one anymore.
// completeRegistration() (legacy full web signup) still takes a password as
// a plain function argument, not as a CustomerField, same as before.
export type CustomerField = 'name' | 'surname' | 'email';

export interface RegistrationProgress {
  complete: boolean;
  nextField?: CustomerField; // the next field to ask, if not complete
  missingFields: CustomerField[]; // all missing fields
}

/** Narrows an unknown catch value down to a readable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Detects Supabase Auth's "email already registered" error (422 / error_code
 * "email_exists"). Used by completeRegistration() and
 * linkAuthUserWithPassword() to recognise the specific, recoverable case
 * where an auth user for this email already exists — almost always an
 * orphan left behind by an earlier attempt that created the auth user but
 * failed (and failed to roll back) before finishing.
 */
function isEmailAlreadyRegisteredError(error: unknown): boolean {
  const anyError = error as { code?: string; status?: number } | null;
  if (anyError?.code === 'email_exists') return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes('already been registered') || message.includes('already registered') || message.includes('email_exists');
}

/**
 * Supabase's admin API has no direct "get user by email" call, so this
 * pages through listUsers() and matches client-side. Fine at current scale
 * (this only runs on the rare recovery path above); switch to a dedicated
 * Postgres lookup against auth.users if the user base grows large enough
 * for this to matter.
 */
async function findAuthUserByEmail(adminClient: SupabaseClient, email: string): Promise<User | null> {
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Failed to look up existing auth user by email: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match;
    if (data.users.length < perPage) break; // reached the last page
  }
  return null;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Get the standard server client (must be available). */
function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new Error('Supabase server client is unavailable');
  }
  return supabase;
}

/**
 * Get the admin client (service role) for auth operations. Created fresh
 * per call rather than cached at module scope — this file may be imported
 * before env vars are available in some deployment/build contexts, and the
 * admin client is only needed for the relatively rare auth-linking paths,
 * so the extra client construction cost is negligible.
 */
function getAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing Supabase admin credentials');
  }
  return createSupabaseAdmin(url, key);
}

/** Map a database profile row to a Customer object. */
function mapProfileToCustomer(row: ProfileRow): Customer {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name ?? null,
    surname: row.surname ?? null,
    email: row.email ?? null,
    auth_user_id: row.auth_user_id ?? null,
    wallet_id: row.wallet_id ?? null,
    registration_complete: row.registration_complete ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Fetch a profile by a unique column (phone, id, email). */
async function findProfileBy(
  supabase: SupabaseClient,
  column: 'phone' | 'id' | 'email',
  value: string,
): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq(column, value)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to find profile by ${column}=${value}: ${error.message}`);
  }
  return data ? mapProfileToCustomer(data as ProfileRow) : null;
}

/** Check if a phone number is already used. */
export async function phoneExists(phone: string): Promise<boolean> {
  const supabase = getClientOrThrow();
  const { count, error } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('phone', phone);
  if (error) throw new Error(`phoneExists error: ${error.message}`);
  return (count ?? 0) > 0;
}

/** Check if an email is already used (case‑insensitive). */
export async function emailExists(email: string): Promise<boolean> {
  const supabase = getClientOrThrow();
  const { count, error } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .ilike('email', email);
  if (error) throw new Error(`emailExists error: ${error.message}`);
  return (count ?? 0) > 0;
}

// -----------------------------------------------------------------------------
// Core Lookup & Provisioning (compatible with existing architecture)
// -----------------------------------------------------------------------------

/**
 * Retrieve a full customer by phone number.
 * Returns null if not found.
 * Downstream services may call this.
 */
export async function getCustomer(phone: string): Promise<Customer | null> {
  const supabase = getClientOrThrow();
  return findProfileBy(supabase, 'phone', phone);
}

/**
 * Retrieve a customer by internal ID.
 */
export async function getCustomerById(id: string): Promise<Customer | null> {
  const supabase = getClientOrThrow();
  return findProfileBy(supabase, 'id', id);
}

/**
 * Retrieve a customer by email (case‑insensitive).
 */
export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  const supabase = getClientOrThrow();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('email', email)
    .maybeSingle();
  if (error) throw new Error(`getCustomerByEmail error: ${error.message}`);
  return data ? mapProfileToCustomer(data as ProfileRow) : null;
}

/**
 * THE single provisioning entry point.
 * Called ONLY from reply.ts (orchestration layer).
 * Creates a minimal profile (phone only) if none exists.
 * Returns the customer (existing or new).
 */
export async function ensureCustomer(phone: string): Promise<Customer> {
  const supabase = getClientOrThrow();

  // Try to find existing
  const existing = await findProfileBy(supabase, 'phone', phone);
  if (existing) return existing;

  // Attempt to create minimal profile
  const { data, error } = await supabase
    .from('profiles')
    .insert({ phone })
    .select('*')
    .single();

  if (error) {
    // Unique violation – race condition, re-fetch
    if (error.code === '23505') {
      const afterRace = await findProfileBy(supabase, 'phone', phone);
      if (afterRace) return afterRace;
    }
    throw new Error(`ensureCustomer: failed to create profile: ${error.message}`);
  }

  return mapProfileToCustomer(data as ProfileRow);
}

/**
 * Update customer fields (name, surname, email).
 * Throws if email is already taken (if updating email).
 * Does NOT update auth_user_id, wallet_id, registration_complete, etc.
 */
export async function updateCustomer(
  phone: string,
  data: Partial<Pick<Customer, 'name' | 'surname' | 'email'>>,
): Promise<void> {
  const supabase = getClientOrThrow();

  // Work on a copy rather than mutating the caller's object in place.
  const patch = { ...data };

  // If email is being updated, check uniqueness
  if (patch.email !== undefined && patch.email !== null) {
    const email = patch.email.trim().toLowerCase();
    if (email) {
      const existing = await getCustomerByEmail(email);
      if (existing && existing.phone !== phone) {
        throw new Error(`Email "${email}" is already in use by another customer.`);
      }
    }
    patch.email = email;
  }

  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('phone', phone);

  if (error) {
    throw new Error(`updateCustomer failed: ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// Registration Flow
// -----------------------------------------------------------------------------

/**
 * Determine the registration progress for a customer.
 * Returns which fields are missing and whether registration is complete.
 *
 * CHANGED: password/auth_user_id is no longer part of this. Registration is
 * "complete" as soon as name + surname + email are known — that's the
 * trigger for provisioning a wallet. Whether the customer has also set up a
 * Passport Key (auth_user_id) is a completely separate, later, optional step.
 */
export function getRegistrationProgress(customer: Customer): RegistrationProgress {
  const missing: CustomerField[] = [];

  if (!customer.name) missing.push('name');
  if (!customer.surname) missing.push('surname');
  if (!customer.email) missing.push('email');

  // If registration_complete flag is true, it's complete regardless of missing fields
  // (should not happen, but ensures consistency)
  const complete = customer.registration_complete === true;

  return {
    complete: complete || missing.length === 0,
    nextField: missing.length > 0 ? missing[0] : undefined,
    missingFields: missing,
  };
}

/**
 * Check if a customer has fully registered (has a wallet).
 * Downstream services call this to decide whether to allow guarded actions.
 * NOTE: this does NOT require a Passport Key (auth_user_id) — a WhatsApp-only
 * customer with a wallet and no web login is allowed to buy tickets, top up,
 * etc. through WhatsApp.
 */
export async function isRegistrationComplete(phone: string): Promise<boolean> {
  const customer = await getCustomer(phone);
  if (!customer) return false;
  return customer.registration_complete === true;
}

/**
 * Result of a pre-purchase registration check. `progress` is always
 * populated (even when `allowed` is true) so a caller that wants to show
 * "you're missing X" copy doesn't need a second lookup.
 */
export interface RegistrationGate {
  allowed: boolean;
  progress: RegistrationProgress;
}

/**
 * THE single check every guarded, money-moving action must call — wallet
 * top-ups/spends, kiosk orders, VVIP/ticket bookings, anything that debits
 * a wallet or creates a paid booking — immediately before it moves money.
 *
 * Gates on `registration_complete` (i.e. "has a wallet"), NOT on having a
 * Passport Key. A customer who only ever uses WhatsApp is fully allowed to
 * transact — the Passport Key is purely for web access.
 */
export async function checkRegistrationGate(phone: string): Promise<RegistrationGate> {
  const customer = await getCustomer(phone);
  if (!customer) {
    return {
      allowed: false,
      progress: {
        complete: false,
        nextField: 'name',
        missingFields: ['name', 'surname', 'email'],
      },
    };
  }
  return {
    allowed: customer.registration_complete === true,
    progress: getRegistrationProgress(customer),
  };
}

/**
 * Begin or continue incremental registration by storing one field.
 * Validates email uniqueness and basic format.
 * Returns the updated registration progress.
 */
export async function continueRegistration(
  phone: string,
  field: CustomerField,
  value: string,
): Promise<RegistrationProgress> {
  const customer = await getCustomer(phone);
  if (!customer) {
    throw new Error(`Customer not found for phone ${phone}`);
  }

  // Prevent updates if already fully registered
  if (customer.registration_complete) {
    throw new Error('Customer is already fully registered.');
  }

  // Validate and sanitise
  const sanitised = value.trim();
  if (!sanitised) {
    throw new Error(`${field} cannot be empty.`);
  }

  // Special handling for email
  if (field === 'email') {
    const email = sanitised.toLowerCase();
    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new Error('Invalid email format.');
    }
    // Check uniqueness
    if (await emailExists(email)) {
      throw new Error(`Email "${email}" is already registered.`);
    }
    await updateCustomer(phone, { email });
  } else if (field === 'name') {
    await updateCustomer(phone, { name: sanitised });
  } else if (field === 'surname') {
    await updateCustomer(phone, { surname: sanitised });
  }

  // Re-fetch updated customer and return progress
  const updated = await getCustomer(phone);
  if (!updated) throw new Error('Customer disappeared during update.');
  return getRegistrationProgress(updated);
}

/**
 * Provisions a wallet for a customer profile via the ensure_customer_wallet
 * RPC — confirmed against the actual DB function definition:
 *
 *   - requires profiles.role = 'customer' for the given id (true by default
 *     for every WhatsApp-registered customer, so this always passes here)
 *   - inserts into public.wallets (user_id, balance=0, currency='ZAR',
 *     status='active') only if a row doesn't already exist — idempotent,
 *     safe to call again on retry
 *
 * Called directly here (rather than through lib/services/wallet.ts, which
 * this file previously delegated to via a dynamic import) so this behavior
 * doesn't depend on an unverified abstraction — this RPC's contract is
 * confirmed directly against the database.
 */
async function provisionWallet(profileId: string): Promise<void> {
  const supabase = getClientOrThrow();
  const { error } = await supabase.rpc('ensure_customer_wallet', { p_profile_id: profileId });
  if (error) {
    throw new Error(`Failed to provision wallet: ${error.message}`);
  }
}

/**
 * NEW — replaces the WhatsApp side of the old completeRegistration() call.
 *
 * Creates the wallet (no auth user, no password) and marks
 * registration_complete = true. This is the ONLY thing that happens at the
 * end of the WhatsApp registration conversation now. Setting up web access
 * (a Passport Key) is a fully separate, later step, handled entirely in the
 * WEB APP REPO's lib/services/passport-key.ts after a WhatsApp OTP confirms
 * the customer's identity — this repo has no part in that beyond sending
 * the OTP text (see app/api/internal/send-whatsapp-message).
 *
 * Idempotent: safe to call again if it's ever retried after a transient
 * failure — provisionWallet() is idempotent (ensure_customer_wallet is a
 * plain existence check + insert), and re-setting registration_complete =
 * true on an already-complete row is a no-op.
 */
export async function completeWhatsAppRegistration(phone: string): Promise<Customer> {
  const customer = await getCustomer(phone);
  if (!customer) {
    throw new Error(`Customer not found for phone ${phone}`);
  }

  if (!customer.name || !customer.surname || !customer.email) {
    throw new Error('Missing required fields: name, surname, and email must be set before completion.');
  }

  if (customer.registration_complete) {
    return customer;
  }

  await provisionWallet(customer.id);

  const supabase = getClientOrThrow();
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ registration_complete: true })
    .eq('id', customer.id);

  if (updateError) {
    throw new Error(`Failed to mark registration complete: ${updateError.message}`);
  }

  const updated = await getCustomer(phone);
  if (!updated) throw new Error('Customer disappeared after profile update.');
  return updated;
}

/**
 * Complete registration: create Supabase Auth user, create the wallet,
 * THEN link everything and mark the profile complete.
 *
 * LEGACY — kept only for the standalone full web signup flow
 * (register.html's own email+password form, for a customer with no prior
 * WhatsApp profile at all). The WhatsApp registration flow no longer calls
 * this — see completeWhatsAppRegistration() and linkAuthUserWithPassword().
 *
 * Ordering matters here: registration_complete is only ever written as
 * the very last step, once the wallet is confirmed to exist. If wallet
 * creation fails, we roll back the auth user and the profile is left
 * exactly as it was before this call — never complete without a wallet.
 */
export async function completeRegistration(
  phone: string,
  password: string,
): Promise<Customer> {
  const customer = await getCustomer(phone);
  if (!customer) {
    throw new Error(`Customer not found for phone ${phone}`);
  }

  // Validate required fields
  if (!customer.name || !customer.surname || !customer.email) {
    throw new Error('Missing required fields: name, surname, and email must be set before completion.');
  }

  // Check if already complete
  if (customer.registration_complete) {
    return customer;
  }

  // Validate password strength (Supabase will enforce, but we can add basic check)
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  // 1. Create auth user.
  //
  // SELF-HEALING: if this fails specifically because the email is already
  // registered, that's almost certainly an orphaned auth user left behind
  // by a PREVIOUS completeRegistration() call that got this far, then
  // failed at step 2 or 3 below, and whose rollback (deleteUser) either
  // didn't run or itself failed. Previously this just threw, and the
  // customer would retype a password and hit the exact same "already
  // registered" error forever — every retry created a fresh mismatch
  // between "profile says incomplete" and "auth user already exists" with
  // no way out. Instead, look the existing user up by email and continue
  // the flow with it, updating its password to the one just entered so the
  // customer can actually use it.
  const adminClient = getAdminClient();
  let authUser: User;
  try {
    const { data, error } = await adminClient.auth.admin.createUser({
      email: customer.email,
      password,
      email_confirm: true, // auto-confirm (or send verification depending on your flow)
      user_metadata: {
        phone: customer.phone,
        name: customer.name,
        surname: customer.surname,
      },
    });
    if (error) throw error;
    if (!data.user) throw new Error('No user returned from auth creation.');
    authUser = data.user;
  } catch (error) {
    if (!isEmailAlreadyRegisteredError(error)) {
      throw new Error(`Failed to create auth user: ${errorMessage(error)}`);
    }

    const existing = await findAuthUserByEmail(adminClient, customer.email);
    if (!existing) {
      // Shouldn't happen (Supabase just told us this email exists), but
      // don't silently swallow it if it does.
      throw new Error(`Failed to create auth user: ${errorMessage(error)}`);
    }

    console.warn('completeRegistration: recovered orphaned auth user for email, reusing it', {
      customerId: customer.id,
      authUserId: existing.id,
    });

    // Bring its password in line with what the customer just typed, so
    // they can actually log in with it (the orphaned user's password is
    // whatever was set during the failed attempt, which the customer has
    // no way of knowing).
    try {
      await adminClient.auth.admin.updateUserById(existing.id, { password });
    } catch (updateError) {
      throw new Error(`Found existing auth user but failed to set its password: ${errorMessage(updateError)}`);
    }

    authUser = existing;
  }

  // 2. Create the wallet BEFORE touching registration_complete. If this
  //    fails, roll back the auth user we just created and bail out —
  //    the profile is untouched, so the customer can safely retry.
  try {
    await provisionWallet(customer.id);
  } catch (error) {
    console.error('Failed to create wallet for customer', customer.id, error);
    try {
      await adminClient.auth.admin.deleteUser(authUser.id);
    } catch (cleanupError) {
      console.error('Failed to roll back auth user after wallet creation failure', {
        customerId: customer.id,
        authUserId: authUser.id,
        cleanupError,
      });
    }
    throw new Error(`Failed to create wallet: ${errorMessage(error)}`);
  }

  // 3. Wallet exists — now, and only now, link the auth user and mark
  //    registration complete in a single update. wallet_id is NOT set here:
  //    it was already assigned by the DB default (generate_wallet_id())
  //    when ensureCustomer() first inserted the profile row.
  const supabase = getClientOrThrow();
  const { error: updateError } = await supabase
    .from('profiles')
    .update({
      auth_user_id: authUser.id,
      registration_complete: true,
    })
    .eq('id', customer.id);

  if (updateError) {
    // Auth user + wallet exist but the profile link failed. Roll back the
    // auth user so a retry doesn't hit "email already registered" on the
    // next attempt. The wallet is left in place — provisionWallet() is
    // idempotent, so a retry will simply find it and move on rather than
    // erroring or duplicating it.
    console.error('Failed to update profile after auth/wallet creation; rolling back auth user.', updateError);
    try {
      await adminClient.auth.admin.deleteUser(authUser.id);
    } catch (cleanupError) {
      console.error('Failed to roll back auth user after profile update failure', {
        customerId: customer.id,
        authUserId: authUser.id,
        cleanupError,
      });
    }
    throw new Error(`Failed to update profile: ${updateError.message}`);
  }

  // Return the updated customer
  const updatedCustomer = await getCustomer(phone);
  if (!updatedCustomer) {
    throw new Error('Customer disappeared after profile update.');
  }
  return updatedCustomer;
}

// -----------------------------------------------------------------------------
// Additional Utilities
// -----------------------------------------------------------------------------

/**
 * Create a wallet for a customer if it does not already exist.
 * Downstream services may call this if they need to ensure wallet existence,
 * but they should preferably call isRegistrationComplete first.
 *
 * Calls the ensure_customer_wallet RPC directly (see provisionWallet()
 * above) — no longer delegates to lib/services/wallet.ts.
 */
export async function createWalletIfMissing(customerId: string): Promise<void> {
  await provisionWallet(customerId);
}

/**
 * Reset password for a customer (send password reset email).
 * Only meaningful for customers who already have a Passport Key
 * (auth_user_id set) — a customer without one has nothing to reset, they
 * need requestPassportKeyOtp() from passport-key.ts instead.
 */
export async function resetPassword(email: string): Promise<void> {
  const supabase = getClientOrThrow();
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw new Error(`Password reset failed: ${error.message}`);
}

/**
 * Link an existing auth user to a customer profile (used if an auth user was created separately).
 */
export async function linkAuthUser(phone: string, authUserId: string): Promise<void> {
  const supabase = getClientOrThrow();
  const { error } = await supabase
    .from('profiles')
    .update({ auth_user_id: authUserId })
    .eq('phone', phone);
  if (error) throw new Error(`linkAuthUser failed: ${error.message}`);
}

// -----------------------------------------------------------------------------
// Exported Service Object (for backward compatibility)
// -----------------------------------------------------------------------------

export const customerService = {
  getCustomer,
  ensureCustomer,
  updateCustomer,
  // New functions
  getCustomerById,
  getCustomerByEmail,
  phoneExists,
  emailExists,
  getRegistrationProgress,
  isRegistrationComplete,
  checkRegistrationGate,
  continueRegistration,
  completeWhatsAppRegistration,
  completeRegistration,
  createWalletIfMissing,
  resetPassword,
  linkAuthUser,
};
