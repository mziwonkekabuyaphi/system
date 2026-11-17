// File: lib/services/orders/orders.address.ts
// ============================================================================
// "Same address as last time" for delivery.
//
// No new table or column: every delivery order already stores its address and area on the order itself
// (orders.delivery_address / delivery_area_id), so the most recent one IS the saved address. It is only ever read
// for the SAME customer of the SAME shop (tenant_id + customer_id), never across customers.
//
// It is a convenience, never a gate: any failure just means "no saved address" and the customer types one.
// ============================================================================

import { getSupabaseServerClient } from '@/lib/supabase/admin';
import type { TenantContext } from './orders.tenant';

/**
 * The address this customer last had an order delivered to IN THIS AREA, or null. Matching the area means a
 * customer who switches area is asked for a fresh address instead of being offered one in the wrong place.
 */
export async function getLastDeliveryAddress(ctx: TenantContext, customerId: string, areaId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseServerClient();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('orders')
      .select('delivery_address')
      .eq('tenant_id', ctx.tenantId)
      .eq('customer_id', customerId)
      .eq('fulfilment', 'delivery')
      .eq('delivery_area_id', areaId)
      .not('delivery_address', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return null;
    const address = (data?.delivery_address as string | null | undefined)?.trim();
    return address ? address : null;
  } catch {
    return null;
  }
}
