// lib/services/tenant-customer.ts
/**
 * Tenant Customer Identity Service — QLess multi-tenant equivalent of
 * lib/services/customer.ts, scoped to `tenant_customers` instead of
 * `profiles`.
 *
 * DO NOT confuse this with lib/services/customer.ts. That file is Rands'
 * original single-tenant identity/wallet service, built against a
 * `profiles` table that has a hard foreign key to `auth.users` and no
 * default on `id` — it cannot create a row for an anonymous WhatsApp
 * customer at all, and was written against a different (single-tenant)
 * Supabase project than this one. It is left untouched; nothing here
 * modifies it or the `profiles` table.
 *
 * `tenant_customers` has no such requirement: `profile_id` is nullable,
 * used only if/when a customer later gets a real platform login (e.g. via
 * a future customer-facing web account). Every WhatsApp-originated
 * customer starts with profile_id = null and stays that way indefinitely.
 *
 * Unlike customer.ts's ensureCustomer() (deliberately restricted to being
 * called only from reply.ts, because it provisions a wallet), this
 * ensureCustomer() carries no such weight — any service is free to call it
 * directly. booking.ts and queue.ts both do, exactly as before.
 */

import { getSupabaseServerClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface TenantCustomer {
  id: string
  tenantId: string
  phone: string
  /** Maps to tenant_customers.full_name — kept as `name` here so booking.ts/
   * queue.ts's existing `customer.name` usage doesn't need to change. */
  name: string | null
  email: string | null
  status: string
}

interface TenantCustomerRow {
  id: string
  tenant_id: string
  phone: string
  full_name: string | null
  email: string | null
  status: string
}

function getClientOrThrow(): SupabaseClient {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")
  return supabase
}

function mapRow(row: TenantCustomerRow): TenantCustomer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    phone: row.phone,
    name: row.full_name,
    email: row.email,
    status: row.status,
  }
}

/** Retrieve a tenant's customer by phone. Returns null if not found. */
export async function getCustomer(tenantId: string, phone: string): Promise<TenantCustomer | null> {
  const supabase = getClientOrThrow()
  const { data, error } = await supabase
    .from("tenant_customers")
    .select("id, tenant_id, phone, full_name, email, status")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .maybeSingle()

  if (error) throw new Error(`getCustomer failed: ${error.message}`)
  return data ? mapRow(data as TenantCustomerRow) : null
}

/**
 * Finds-or-creates a minimal (phone-only) tenant_customers row, scoped to
 * this tenant. The same phone number can have separate rows under
 * different tenants — a person texting both "Rands Cape Town" and a salon
 * tenant is two unrelated tenant_customers rows, which is correct: their
 * booking history, name-on-file, etc. shouldn't leak between shops.
 */
export async function ensureCustomer(tenantId: string, phone: string): Promise<TenantCustomer> {
  const supabase = getClientOrThrow()

  const existing = await getCustomer(tenantId, phone)
  if (existing) return existing

  const { data, error } = await supabase
    .from("tenant_customers")
    .insert({ tenant_id: tenantId, phone, status: "active" })
    .select("id, tenant_id, phone, full_name, email, status")
    .single()

  if (error) {
    // Race: two near-simultaneous messages from the same brand-new
    // customer both miss the getCustomer check above and both try to
    // insert. The unique (tenant_id, phone) constraint on tenant_customers
    // turns the loser into a clean 23505 instead of a duplicate row —
    // re-fetch and return the row the winner created.
    if (error.code === "23505") {
      const afterRace = await getCustomer(tenantId, phone)
      if (afterRace) return afterRace
    }
    throw new Error(`ensureCustomer failed: ${error.message}`)
  }

  return mapRow(data as TenantCustomerRow)
}

/** Updates a tenant customer's name and/or email. No-ops if patch is empty. */
export async function updateCustomer(
  tenantId: string,
  phone: string,
  patch: { name?: string; email?: string },
): Promise<void> {
  const supabase = getClientOrThrow()

  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.full_name = patch.name
  if (patch.email !== undefined) row.email = patch.email
  if (Object.keys(row).length === 0) return

  const { error } = await supabase
    .from("tenant_customers")
    .update(row)
    .eq("tenant_id", tenantId)
    .eq("phone", phone)

  if (error) throw new Error(`updateCustomer failed: ${error.message}`)
}
