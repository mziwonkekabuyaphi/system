// File: lib/services/orders/orders.drivers.ts
// ============================================================================
// DELIVERY DRIVERS — the server side of "drivers take delivery jobs on WhatsApp".
//
// Two ways a job reaches a driver (order_settings.driver_dispatch_mode):
//   first_come  when a delivery order becomes READY it is offered to every on-duty driver; the first to tap
//               "Take job" gets it (driver_claim_order decides, atomically).
//   dispatcher  nothing is offered; staff pick a driver on the board (assign_order_driver).
// In both modes a driver who is already assigned (pre-assigned on the board) is messaged directly when the order is ready.
//
// Drivers are matched by the WhatsApp number the shop typed in (order_drivers.phone); the inbound sender number is
// authenticated by Meta, so no verification step is needed. Full address / customer details only ever go to the driver
// who holds the job; an offer shows area, fee, total and cash due.
//
// Everything here is best-effort: a failed WhatsApp send is logged and never blocks the staff action that caused it.
// Free-form WhatsApp messages only reach a driver who has messaged the shop in the last 24 hours, which is why the
// driver replies "on duty" at the start of a shift (see lib/services/driver-bot.ts).
// ============================================================================

import { getSupabaseServerClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/whatsapp/utils/logger';
import { sendWhatsAppListMessage, sendWhatsAppTextMessage } from '@/lib/whatsapp/send-message';
import { formatCurrency } from '@/lib/services/messages/orders';

/** Every driver tap id starts with this (the router and the intent classifier key off it). */
export const DRIVER_ID_PREFIX = 'drv_';
export const DRV_TAKE = 'drv_take:'; // + order id
export const DRV_JOB = 'drv_job:'; // + order id
export const DRV_OUT = 'drv_out:'; // + order id
export const DRV_DONE = 'drv_done:'; // + order id
export const DRV_DROP = 'drv_drop:'; // + order id
export const DRV_DUTY = 'drv_duty:'; // + on | off
export const DRV_EARN = 'drv_earn'; // the driver's own earnings

export type DriverDispatchMode = 'first_come' | 'dispatcher';

export interface DriverJob {
  id: string;
  order_number: string;
  status: string;
  area: string | null;
  address: string | null;
  fee: number;
  total: number;
  cash_due: number;
  payment_method: string;
  customer_name: string | null;
  customer_phone: string;
  pickup: string | null;
  items: string | null;
}

export interface OpenJob {
  id: string;
  order_number: string;
  area: string | null;
  fee: number;
  total: number;
  cash_due: number;
  pickup: string | null;
}

/** "082 123 4567", "+27 82 123 4567", "0027821234567" -> "+27821234567" (a leading 0 is read as South African). */
export function normalizeDriverPhone(raw: string): string | null {
  let s = (raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = `27${s.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(s) ? `+${s}` : null;
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function jobDetailText(job: DriverJob): string {
  const lines = [
    `🚚 *Order #${job.order_number}*`,
    job.pickup ? `📍 Pick up: ${job.pickup}` : null,
    `🏠 Deliver to: ${job.address ?? '—'}${job.area ? ` (${job.area})` : ''}`,
    `👤 ${job.customer_name?.trim() || 'Customer'} · ${job.customer_phone.startsWith('+') ? job.customer_phone : `+${job.customer_phone}`}`,
    job.items ? `🧾 ${job.items}` : null,
    job.cash_due > 0 ? `💵 Collect ${formatCurrency(job.cash_due)} cash at the door` : '✅ Already paid, nothing to collect',
  ];
  return lines.filter(Boolean).join('\n');
}

/** The tap list under a job the driver holds. Row ids carry the order id, so an old message still works. */
export function jobActionRows(job: Pick<DriverJob, 'id' | 'status'>): Array<{ id: string; title: string; description?: string }> {
  if (job.status === 'out_for_delivery') {
    return [{ id: `${DRV_DONE}${job.id}`, title: 'Delivered', description: 'Order handed over' }];
  }
  return [
    { id: `${DRV_OUT}${job.id}`, title: 'Picked up', description: "I have the order, I'm on my way" },
    { id: `${DRV_DROP}${job.id}`, title: "Can't take it", description: 'Give the job back to the shop' },
  ];
}

export function offerText(job: OpenJob): string {
  return [
    '🛵 *New delivery job*',
    `Order #${job.order_number}${job.area ? ` · ${job.area}` : ''}`,
    job.pickup ? `📍 Pick up: ${job.pickup}` : null,
    `Delivery fee ${formatCurrency(job.fee)} · order total ${formatCurrency(job.total)}`,
    job.cash_due > 0 ? `💵 Cash to collect: ${formatCurrency(job.cash_due)}` : '✅ Already paid',
    '',
    'First to tap *Take job* gets it 👇',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Sending (never throws)
// ---------------------------------------------------------------------------

async function safeText(tenantId: string, phone: string, text: string): Promise<boolean> {
  try {
    await sendWhatsAppTextMessage(tenantId, phone, text);
    return true;
  } catch (error) {
    logger.error('[orders][drivers] text send failed', { tenantId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function safeList(
  tenantId: string,
  phone: string,
  body: string,
  buttonText: string,
  title: string,
  rows: Array<{ id: string; title: string; description?: string }>,
): Promise<boolean> {
  try {
    await sendWhatsAppListMessage(tenantId, phone, body, buttonText, [{ title, rows }]);
    return true;
  } catch (error) {
    logger.error('[orders][drivers] list send failed', { tenantId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** A job given to this driver (by staff, or because they were pre-assigned): details + the next-step list. */
export async function notifyDriverAssigned(tenantId: string, phone: string, job: DriverJob): Promise<void> {
  const ok = await safeList(
    tenantId,
    phone,
    `📦 You've been given a delivery.\n\n${jobDetailText(job)}`,
    'Update job',
    'This job',
    jobActionRows(job),
  );
  if (!ok) logger.error('[orders][drivers] could not tell driver about assigned job', { tenantId, order: job.order_number });
}

/** The job was taken away from this driver (re-assigned / un-assigned / cancelled). */
export async function notifyDriverRemoved(
  tenantId: string,
  driverId: string,
  orderNumber: string,
  reason: 'reassigned' | 'cancelled',
): Promise<void> {
  try {
    const db = getSupabaseServerClient();
    if (!db) return;
    const { data } = await db.from('order_drivers').select('phone').eq('tenant_id', tenantId).eq('id', driverId).maybeSingle();
    const phone = data?.phone as string | undefined;
    if (!phone) return;
    await safeText(
      tenantId,
      phone,
      reason === 'cancelled'
        ? `❌ Order #${orderNumber} has been cancelled. You don't need to deliver it.`
        : `Order #${orderNumber} has been given to someone else. You don't need to deliver it.`,
    );
  } catch (error) {
    logger.error('[orders][drivers] notifyDriverRemoved failed', { tenantId, error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// Dispatch: call when a delivery order has just become READY (and again if a driver hands a job back)
// ---------------------------------------------------------------------------

export async function dispatchReadyDelivery(
  tenantId: string,
  orderId: string,
  opts: { excludeDriverId?: string } = {},
): Promise<{ mode: DriverDispatchMode | null; messaged: number; failed: number }> {
  const none = { mode: null, messaged: 0, failed: 0 };
  try {
    const db = getSupabaseServerClient();
    if (!db) return none;

    const { data: o } = await db
      .from('orders')
      .select('id, order_number, status, fulfilment, driver_id, delivery_area_name, delivery_fee, total_amount, payment_method, payment_status, vendor_id')
      .eq('tenant_id', tenantId)
      .eq('id', orderId)
      .maybeSingle();
    if (!o || o.fulfilment !== 'delivery' || o.status !== 'ready') return none;

    // Already assigned (pre-assigned on the board): tell that driver, whatever the mode.
    if (o.driver_id) {
      const [{ data: driver }, { data: jobs }] = await Promise.all([
        db.from('order_drivers').select('phone').eq('tenant_id', tenantId).eq('id', o.driver_id).maybeSingle(),
        db.rpc('driver_my_jobs', { p_tenant: tenantId, p_driver: o.driver_id }),
      ]);
      const job = (Array.isArray(jobs) ? (jobs as DriverJob[]) : []).find((j) => j.id === o.id);
      if (driver?.phone && job) {
        await notifyDriverAssigned(tenantId, driver.phone as string, job);
        return { mode: null, messaged: 1, failed: 0 };
      }
      return none;
    }

    const { data: settings } = await db.from('order_settings').select('driver_dispatch_mode').eq('tenant_id', tenantId).maybeSingle();
    const mode = ((settings?.driver_dispatch_mode as DriverDispatchMode | undefined) ?? 'first_come') as DriverDispatchMode;
    if (mode !== 'first_come') return { mode, messaged: 0, failed: 0 };

    const [{ data: drivers }, { data: vendor }] = await Promise.all([
      db.from('order_drivers').select('id, phone').eq('tenant_id', tenantId).eq('is_active', true).eq('on_duty', true),
      o.vendor_id
        ? db.from('order_vendors').select('name, collection_point').eq('tenant_id', tenantId).eq('id', o.vendor_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const offer: OpenJob = {
      id: o.id as string,
      order_number: o.order_number as string,
      area: (o.delivery_area_name as string | null) ?? null,
      fee: Number(o.delivery_fee ?? 0),
      total: Number(o.total_amount ?? 0),
      cash_due: o.payment_method === 'cash' && o.payment_status === 'pending' ? Number(o.total_amount ?? 0) : 0,
      pickup: ((vendor?.collection_point as string | undefined)?.trim() || (vendor?.name as string | undefined)) ?? null,
    };

    let messaged = 0;
    let failed = 0;
    for (const d of (drivers ?? []).filter((x) => x.id !== opts.excludeDriverId)) {
      const ok = await safeList(tenantId, d.phone as string, offerText(offer), 'View job', 'Delivery job', [
        { id: `${DRV_TAKE}${offer.id}`, title: 'Take job', description: clip(`#${offer.order_number}${offer.area ? ` · ${offer.area}` : ''}`, 72) },
      ]);
      if (ok) messaged += 1;
      else failed += 1;
    }
    if (messaged === 0) {
      logger.warn('[orders][drivers] ready delivery was offered to nobody', { tenantId, order: offer.order_number, onDuty: (drivers ?? []).length, failed });
    }
    return { mode, messaged, failed };
  } catch (error) {
    logger.error('[orders][drivers] dispatchReadyDelivery failed', { tenantId, error: error instanceof Error ? error.message : String(error) });
    return none;
  }
}
