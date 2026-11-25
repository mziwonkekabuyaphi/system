// File: lib/services/orders/orders.status-notify.ts
// ============================================================================
// WhatsApp updates sent to the customer when STAFF move an order along the board
// (preparing / ready / out for delivery / collected-served-delivered / cancelled).
//
// Each update can be switched off per shop (order_settings.status_notifications).
// A failed or disabled message never blocks the staff action: notifyText swallows send errors.
// Accept / decline already have their own messages in actions.ts and are not affected.
// ============================================================================

import { getSupabaseServerClient } from '@/lib/supabase/admin';
import { notifyText } from './orders.integrations';

export type StatusNotifyKey = 'preparing' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled';
export type StatusNotifications = Record<StatusNotifyKey, boolean>;

export const STATUS_NOTIFY_KEYS: StatusNotifyKey[] = ['preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];

export const DEFAULT_STATUS_NOTIFICATIONS: StatusNotifications = {
  preparing: true,
  ready: true,
  out_for_delivery: true,
  completed: true,
  cancelled: true,
};

/** Labels for the admin switches. */
export const STATUS_NOTIFY_LABELS: Record<StatusNotifyKey, { title: string; hint: string }> = {
  preparing: { title: 'Being prepared', hint: '"Your order is being prepared"' },
  ready: { title: 'Ready', hint: 'Ready for collection / on its way to the table / packed for delivery' },
  out_for_delivery: { title: 'Out for delivery', hint: 'Delivery orders only: the driver has left' },
  completed: { title: 'Collected / served / delivered', hint: 'Final "enjoy" message when the order is handed over' },
  cancelled: { title: 'Cancelled by staff', hint: 'Includes a refund note when it was paid' },
};

/** Safe read of the jsonb column: anything missing or malformed falls back to ON. */
export function parseStatusNotifications(raw: unknown): StatusNotifications {
  const out = { ...DEFAULT_STATUS_NOTIFICATIONS };
  if (raw && typeof raw === 'object') {
    for (const k of STATUS_NOTIFY_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

/** Which switch governs a move to this status (null = no customer message for it). */
export function notifyKeyForStatus(status: string): StatusNotifyKey | null {
  switch (status) {
    case 'preparing': return 'preparing';
    case 'ready': return 'ready';
    case 'out_for_delivery': return 'out_for_delivery';
    case 'collected':
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    default: return null;
  }
}

interface MessageArgs {
  orderNumber: string;
  fulfilment: 'collection' | 'delivery' | 'dine_in';
  prepMinutes: number;
  deliveryMinutes: number;
  collectionInstructions: string | null;
  wasPaid?: boolean;
}

export function statusUpdateMessage(key: StatusNotifyKey, a: MessageArgs): string {
  const n = `*#${a.orderNumber}*`;
  switch (key) {
    case 'preparing': {
      const eta = a.fulfilment === 'delivery' ? a.deliveryMinutes : a.prepMinutes;
      const etaLine = eta > 0 ? ` It should ${a.fulfilment === 'delivery' ? 'reach you' : 'be ready'} in about ${eta} min.` : '';
      return `👨‍🍳 Order ${n} is now being prepared.${etaLine}`;
    }
    case 'ready':
      if (a.fulfilment === 'delivery') return `🎉 Order ${n} is packed and about to go out for delivery.`;
      if (a.fulfilment === 'dine_in') return `🎉 Order ${n} is ready and on its way to your table.`;
      return `🎉 Order ${n} is ready for collection!${a.collectionInstructions ? `\n\n${a.collectionInstructions}` : ''}`;
    case 'out_for_delivery':
      return `🚚 Order ${n} is on its way to you.`;
    case 'completed':
      if (a.fulfilment === 'delivery') return `✅ Order ${n} has been delivered. Enjoy! 🥂`;
      if (a.fulfilment === 'dine_in') return `✅ Order ${n} has been served. Enjoy! 🥂`;
      return `✅ Order ${n} has been collected. Enjoy! 🥂`;
    case 'cancelled':
      return `Order ${n} has been cancelled by the shop.${a.wasPaid ? ' Your payment will be refunded.' : ''} Reply *menu* to order again.`;
  }
}

/**
 * Call AFTER the status change has been saved. Reads the shop's switches and, if the update is on,
 * messages the customer from the shop's own WhatsApp number.
 */
export async function notifyOrderStatusChange(args: {
  tenantId: string;
  phone: string | null | undefined;
  orderNumber: string;
  fulfilment: string | null | undefined;
  toStatus: string;
  wasPaid?: boolean;
}): Promise<void> {
  try {
    const key = notifyKeyForStatus(args.toStatus);
    if (!key || !args.phone) return;

    const supabase = getSupabaseServerClient();
    if (!supabase) return;

    const { data } = await supabase
      .from('order_settings')
      .select('status_notifications, collection_instructions, prep_time_minutes, delivery_time_minutes')
      .eq('tenant_id', args.tenantId)
      .maybeSingle();

    if (!parseStatusNotifications(data?.status_notifications)[key]) return;

    const fulfilment = (['collection', 'delivery', 'dine_in'].includes(args.fulfilment ?? '') ? args.fulfilment : 'collection') as MessageArgs['fulfilment'];
    await notifyText(
      args.tenantId,
      args.phone,
      statusUpdateMessage(key, {
        orderNumber: args.orderNumber,
        fulfilment,
        prepMinutes: Number(data?.prep_time_minutes ?? 0),
        deliveryMinutes: Number(data?.delivery_time_minutes ?? 0),
        collectionInstructions: (data?.collection_instructions as string | null) ?? null,
        wasPaid: args.wasPaid,
      }),
    );
  } catch (e) {
    console.error('[orders] status notification failed', e instanceof Error ? e.message : e);
  }
}
