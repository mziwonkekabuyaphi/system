// lib/services/tenant-customer.ts
/**
 * Tenant Customer Identity Service — tenant_customers is the single
 * source of truth for a per-shop walk-in customer record on the QLess
 * multi-tenant platform.
 *
 * DELIBERATELY A SEPARATE FILE FROM lib/services/customer.ts, not a
 * rewrite of it. customer.ts still owns the Rands profiles/wallet/
 * Passport Key identity system, and orders.ts/vvip.ts/wallet.ts still
 * depend on it exactly as before — this file must not replace that one.
 * See reply.ts's file header for the pipeline-level explanation of why
 * these two identity systems are kept apart: reply.ts (the tenant-scoped
 * entry point) only ever imports from THIS file, never from customer.ts.
 *
 * REBUILT for the multi-tenant salon/barbershop pivot (see registration.ts
 * and app/admin/page.tsx's schema notes). Unlike customer.ts, this file:
 *
 *   - touches `tenant_customers`, never `profiles`, wallets, Supabase
 *     Auth users, or passwords
 *   - requires nothing but a full_name to consider a customer
 *     "registered" — no surname, no email, no wallet
 *   - has no `registration_complete` column to set — tenant_customers has
 *     no such column; "registered" is just tenant_customers.full_name
 *     being set (see getRegistrationProgress())
 *
 * IDENTITY KEY: (tenant_id, phone) — not phone alone. This mirrors
 * conversation_states, which is deliberately keyed the same way (see its
 * DB comment: "phone numbers repeat across tenants"). A customer can be a
 * walk-in at more than one shop on the platform, so a bare phone lookup
 * would silently mix up two different shops' records for the same number.
 * Every exported function here therefore takes `tenantId` as its first
 * argument.
 *
 * Architecture rules (mirrors customer.ts's, scoped to tenant_customers):
 * - ensureCustomer() may only be called from reply.ts (orchestration layer).
 * - Downstream services (booking, queue, and this platform's registration
 *   flow) should only call getCustomer(), updateCustomer(),
 *   isRegistrationComplete(), checkRegistrationGate(),
 *   continueRegistration(), completeWhatsAppRegistration().
 * - No downstream service may create, delete, or directly mutate a
 *   tenant_customers row outside these functions.
 */

import { getSupabaseServerClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface Customer {
  id: string;
  tenant_id: string;
  phone: string;
  name: string | null; // maps to tenant_customers.full_name
  email: string | null;
  profile_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Raw shape of a `tenant_customers` row as returned by Supabase. */
interface TenantCustomerRow {
  id: string;
  tenant_id: string;
  phone: string | null;
  full_name: string | null;
  email: string | null;
  profile_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// Only field left to collect: phone is already known from WhatsApp, and
// there's no more surname/email/age-gate — see registration.ts's own
// SIMPLIFIED note.
export type CustomerField = 'name';

export interface RegistrationProgress {
  complete: boolean;
  nextField?: CustomerField; // the next field to ask, if not complete
  missingFields: CustomerField[]; // all missing fields
}

/**
 * Result of a pre-action registration check. `progress` is always
 * populated (even when `allowed` is true) so a caller that wants to show
 * "you're missing X" copy doesn't need a second lookup.
 */
export interface RegistrationGate {
  allowed: boolean;
  progress: RegistrationProgress;
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

/** Map a database tenant_customers row to a Customer object. */
function mapRowToCustomer(row: TenantCustomerRow): Customer {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    phone: row.phone ?? '',
    name: row.full_name ?? null,
    email: row.email ?? null,
    profile_id: row.profile_id ?? null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Fetch a tenant_customers row by (tenant_id, phone). */
async function findCustomerRow(
  supabase: SupabaseClient,
  tenantId: string,
  phone: string,
): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('tenant_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to find tenant customer (tenant=${tenantId}, phone=${phone}): ${error.message}`,
    );
  }
  return data ? mapRowToCustomer(data as TenantCustomerRow) : null;
}

// -----------------------------------------------------------------------------
// Core Lookup & Provisioning
// -----------------------------------------------------------------------------

/** Check if a phone number is already registered for this tenant. */
export async function phoneExists(tenantId: string, phone: string): Promise<boolean> {
  const supabase = getClientOrThrow();
  const { count, error } = await supabase
    .from('tenant_customers')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('phone', phone);
  if (error) throw new Error(`phoneExists error: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * Retrieve a full customer by (tenant, phone).
 * Returns null if not found.
 * Downstream services may call this.
 */
export async function getCustomer(tenantId: string, phone: string): Promise<Customer | null> {
  const supabase = getClientOrThrow();
  return findCustomerRow(supabase, tenantId, phone);
}

/** Retrieve a customer by internal ID. Still tenant-scoped, to be safe. */
export async function getCustomerById(tenantId: string, id: string): Promise<Customer | null> {
  const supabase = getClientOrThrow();
  const { data, error } = await supabase
    .from('tenant_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getCustomerById error: ${error.message}`);
  return data ? mapRowToCustomer(data as TenantCustomerRow) : null;
}

/**
 * THE single provisioning entry point.
 * Called ONLY from reply.ts (orchestration layer).
 * Creates a minimal tenant_customers row (tenant_id + phone only) if none
 * exists yet for this tenant. Returns the customer (existing or new).
 */
export async function ensureCustomer(tenantId: string, phone: string): Promise<Customer> {
  const supabase = getClientOrThrow();

  const existing = await findCustomerRow(supabase, tenantId, phone);
  if (existing) return existing;

  const { data, error } = await supabase
    .from('tenant_customers')
    .insert({ tenant_id: tenantId, phone })
    .select('*')
    .single();

  if (error) {
    // Unique violation – race condition, re-fetch.
    if (error.code === '23505') {
      const afterRace = await findCustomerRow(supabase, tenantId, phone);
      if (afterRace) return afterRace;
    }
    throw new Error(`ensureCustomer: failed to create tenant customer: ${error.message}`);
  }

  return mapRowToCustomer(data as TenantCustomerRow);
}

/**
 * Update customer fields. Only `name` (-> full_name) is written by the
 * current registration flow; `email` is accepted too since the column
 * still exists on tenant_customers, but nothing in this file requires,
 * validates, or gates on it.
 */
export async function updateCustomer(
  tenantId: string,
  phone: string,
  data: Partial<{ name: string; email: string }>,
): Promise<void> {
  const supabase = getClientOrThrow();

  const patch: Record<string, string> = {};
  if (data.name !== undefined) patch.full_name = data.name;
  if (data.email !== undefined) patch.email = data.email.trim().toLowerCase();

  const { error } = await supabase
    .from('tenant_customers')
    .update(patch)
    .eq('tenant_id', tenantId)
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
 *
 * CHANGED: tenant_customers has no registration_complete column — unlike
 * the old `profiles`-backed version, there's no separate flag to keep in
 * sync. "Registered" just means full_name is set.
 */
export function getRegistrationProgress(customer: Customer): RegistrationProgress {
  const missing: CustomerField[] = [];
  if (!customer.name) missing.push('name');

  return {
    complete: missing.length === 0,
    nextField: missing.length > 0 ? missing[0] : undefined,
    missingFields: missing,
  };
}

/** Check if a customer has fully registered (has a full_name on file). */
export async function isRegistrationComplete(tenantId: string, phone: string): Promise<boolean> {
  const customer = await getCustomer(tenantId, phone);
  if (!customer) return false;
  return !!customer.name;
}

/**
 * THE single check every guarded action (booking, queue join, order,
 * top-up, etc.) must call before proceeding.
 *
 * Gates on having a full_name on file. There's no wallet and no
 * Passport Key concept anymore — every walk-in customer is allowed to
 * book/queue/order once their name is known.
 */
export async function checkRegistrationGate(tenantId: string, phone: string): Promise<RegistrationGate> {
  const customer = await getCustomer(tenantId, phone);
  if (!customer) {
    return {
      allowed: false,
      progress: { complete: false, nextField: 'name', missingFields: ['name'] },
    };
  }
  const progress = getRegistrationProgress(customer);
  return { allowed: progress.complete, progress };
}

/**
 * Begin or continue registration by storing the one remaining field.
 *
 * ASSUMPTION (matches registration.ts's own file-header note): `field` is
 * always `"name"` and writes to tenant_customers.full_name.
 */
export async function continueRegistration(
  tenantId: string,
  phone: string,
  field: CustomerField,
  value: string,
): Promise<RegistrationProgress> {
  const customer = await getCustomer(tenantId, phone);
  if (!customer) {
    throw new Error(`Customer not found for tenant=${tenantId}, phone=${phone}`);
  }

  const sanitised = value.trim();
  if (!sanitised) {
    throw new Error(`${field} cannot be empty.`);
  }

  await updateCustomer(tenantId, phone, { name: sanitised });

  const updated = await getCustomer(tenantId, phone);
  if (!updated) throw new Error('Customer disappeared during update.');
  return getRegistrationProgress(updated);
}

/**
 * Finalises WhatsApp registration.
 *
 * CHANGED: there's no wallet to provision anymore and no separate
 * "complete" flag to flip — full_name being set already IS completion
 * (see getRegistrationProgress()). This function is kept mainly so
 * registration.ts's call site doesn't need to change shape, and as one
 * place to hang tenant_customers-side completion side-effects later
 * (e.g. a welcome-message log) if that's ever needed. Idempotent: calling
 * it again on an already-named customer just re-validates and returns.
 */
export async function completeWhatsAppRegistration(tenantId: string, phone: string): Promise<Customer> {
  const customer = await getCustomer(tenantId, phone);
  if (!customer) {
    throw new Error(`Customer not found for tenant=${tenantId}, phone=${phone}`);
  }
  if (!customer.name) {
    throw new Error('Missing required field: name must be set before completion.');
  }
  return customer;
}

// -----------------------------------------------------------------------------
// Exported Service Object (for backward compatibility)
// -----------------------------------------------------------------------------

export const customerService = {
  getCustomer,
  getCustomerById,
  ensureCustomer,
  updateCustomer,
  phoneExists,
  getRegistrationProgress,
  isRegistrationComplete,
  checkRegistrationGate,
  continueRegistration,
  completeWhatsAppRegistration,
};
