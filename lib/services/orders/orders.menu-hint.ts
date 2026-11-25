// File: lib/services/orders/orders.menu-hint.ts
// ============================================================================
// The one-line description under "🛒 Order Now" on the main menu, worded for what THIS shop offers
// (collection, delivery, dine-in), so a shop without delivery never mentions it and one with it says so.
//
// Lives in the orders module (not in utils/services-list.ts) so the menu file stays free of orders types:
// the router asks for the text here and hands it to the menu as a plain string.
// Never throws: any problem returns undefined and the menu falls back to its neutral wording.
// ============================================================================

import { getSupabaseServerClient } from '@/lib/supabase/admin';
import { loadTenantContext } from './orders';
import { enabledFulfilments } from './orders.tenant';
import type { OrderFulfilment } from './orders.types';

const WORD: Record<OrderFulfilment, string> = {
  collection: 'collect',
  delivery: 'delivery',
  dine_in: 'dine in',
};

/** "Browse the menu and order for collection" / "Browse the menu: collect, delivery or dine in" ... (always under 72 chars). */
export function orderMenuDescription(methods: OrderFulfilment[]): string | undefined {
  if (methods.length === 0) return undefined;
  if (methods.length === 1) {
    if (methods[0] === 'collection') return 'Browse the menu and order for collection';
    if (methods[0] === 'delivery') return 'Browse the menu and order for delivery';
    return 'Browse the menu and order to your table';
  }
  const words = methods.map((m) => WORD[m]);
  const last = words.pop();
  return `Browse the menu: ${words.join(', ')} or ${last}`;
}

export async function getOrdersMenuDescription(tenantId: string): Promise<string | undefined> {
  try {
    const supabase = getSupabaseServerClient();
    if (!supabase) return undefined;
    const ctx = await loadTenantContext(supabase, tenantId); // briefly cached inside; null when ordering isn't set up
    return ctx ? orderMenuDescription(enabledFulfilments(ctx.config, ctx.catalog)) : undefined;
  } catch {
    return undefined;
  }
}
