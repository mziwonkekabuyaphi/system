// lib/services/shared/services-catalog.ts
/**
 * Tenant-scoped service catalog — "what can a customer book or queue
 * for at this shop" — used by booking.ts and queue.ts (WhatsApp) and by
 * the kiosk's Server Actions. There was no existing implementation of
 * this file; booking.ts/queue.ts already called `getBookableServices
 * (tenantId)` expecting this shape, so it's built directly to match that
 * call site rather than introducing a different one.
 *
 * Backed directly by the `services` table: id, tenant_id, name, price,
 * duration_minutes, active.
 */

import { getSupabaseServerClient } from "@/lib/supabase/server"

export interface CatalogService {
  id: string
  name: string
  durationMinutes: number
  /** Rands. Not used by the WhatsApp copy today, but the kiosk's service
   *  tiles want a price on the tile, and it's free to expose here. */
  price: number
}

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  price: number | string // numeric columns can come back as strings via PostgREST
}

/**
 * Returns this tenant's active, bookable/queueable services. Ordered by
 * name (not price) so the list reads the same and predictably whether
 * it's rendered as a WhatsApp numbered list or a kiosk grid.
 */
export async function getBookableServices(tenantId: string): Promise<CatalogService[]> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data, error } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("name", { ascending: true })

  if (error) throw new Error(`Failed to load services for tenant ${tenantId}: ${error.message}`)

  return (data ?? []).map((row: ServiceRow) => ({
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    price: typeof row.price === "string" ? parseFloat(row.price) : row.price,
  }))
}
