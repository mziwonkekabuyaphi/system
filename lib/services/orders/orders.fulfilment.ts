// File: lib/services/orders/orders.fulfilment.ts
// ============================================================================
// FULFILMENT STEPS — how the customer gets the order: collection, delivery or dine-in.
//
// Sits between "checkout" and the pay-and-time list:
//
//   cart -> checkout -> [tap: collection | delivery | dine-in]
//                          collection -> pay list (with "Collect later")
//                          delivery   -> [tap: area] -> address (typed) -> pay list (with "Deliver later")
//                          dine-in    -> table (typed) -> pay list
//
// A shop that only offers collection never sees any of this (beginCheckoutStep goes straight to the pay list).
// What the customer picked is only ever a request: place_order re-checks the method, the area, the address, the
// minimum order and works out the fee itself.
//
// Every step takes `customer` (or null) only so the pay list can show the wallet balance. Steps that used to
// return an ActionResult now return a Promise of one.
// ============================================================================

import type { ActionResult } from '@/lib/types/action';
import * as messages from '@/lib/services/messages/orders';
import { listReply, pageRows } from '@/lib/services/shared/tap-lists';
import { actionResult, cartTotal } from './orders.helpers';
import { beginCartPaymentStep, beginScheduleChoiceStep } from './orders.flow-selection';
import type { OrderingCustomer } from './orders.db';
import {
  deliveryFeeFor,
  enabledFulfilments,
  fulfilmentLabel,
  ORDERING_NOT_AVAILABLE,
  type DeliveryAreaRow,
  type TenantContext,
} from './orders.tenant';
import {
  CART_ACTION_BUTTONS,
  ORDER_STATE_AWAITING_CART_ACTION,
  ORDER_STATE_AWAITING_DELIVERY_ADDRESS,
  ORDER_STATE_AWAITING_DELIVERY_AREA,
  ORDER_STATE_AWAITING_FULFILMENT,
  ORDER_STATE_AWAITING_TABLE,
  TAP_AREA,
  TAP_FULFIL,
  TAP_MORE,
  type CartItem,
  type FulfilmentSelection,
  type OrderFulfilment,
  type OrdersStateData,
  type OrdersStateName,
} from './orders.types';

const MIN_ADDRESS = 5;
const MAX_ADDRESS = 300;
const MAX_TABLE = 20;

/** "Table 7", "table7" and "7" are all table 7. */
export function normalizeTable(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '').replace(/^\s*table\s*/i, '').trim();
  return cleaned.length >= 1 && cleaned.length <= MAX_TABLE ? cleaned : null;
}

const FULFILMENT_HINT: Record<OrderFulfilment, string> = {
  collection: 'Pick it up in person',
  delivery: 'We bring it to you',
  dine_in: 'Eat in: we bring it to your table',
};

/** The "how would you like your order?" tap list. */
function fulfilmentListReply(methods: OrderFulfilment[], cart: CartItem[], tableLabel: string | null): ActionResult {
  return listReply(
    messages.FULFILMENT_LIST_BODY,
    'Choose option',
    [
      {
        title: 'Your order',
        rows: methods.map((m) => ({ id: `${TAP_FULFIL}${m}`, title: fulfilmentLabel(m), description: FULFILMENT_HINT[m] })),
      },
    ],
    { state: ORDER_STATE_AWAITING_FULFILMENT, data: { cart, tableLabel } },
  );
}

/** First step of checkout. Plain collection-only shops skip straight to the pay list. */
export async function beginCheckoutStep(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  cart: CartItem[],
  prior?: Pick<OrdersStateData, 'tableLabel'>,
): Promise<ActionResult> {
  const methods = enabledFulfilments(ctx.config, ctx.catalog);
  if (methods.length === 0) return actionResult(ORDERING_NOT_AVAILABLE);

  if (methods.length === 1) {
    return methods[0] === 'collection' ? beginScheduleChoiceStep(ctx, cart, null, customer) : chooseMethod(ctx, customer, cart, methods[0], prior);
  }
  return fulfilmentListReply(methods, cart, prior?.tableLabel ?? null);
}

/** True when checkout has to ask something before payment (anything beyond plain collection). */
export function needsFulfilmentStep(ctx: TenantContext): boolean {
  const methods = enabledFulfilments(ctx.config, ctx.catalog);
  return !(methods.length === 1 && methods[0] === 'collection');
}

async function chooseMethod(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  cart: CartItem[],
  method: OrderFulfilment,
  prior?: Pick<OrdersStateData, 'tableLabel'>,
): Promise<ActionResult> {
  if (method === 'delivery') return beginAreaStep(ctx, customer, cart);
  if (method === 'dine_in') {
    // "order 2 beers to table 7" already told us the table.
    const known = normalizeTable(prior?.tableLabel);
    if (known) return beginCartPaymentStep(ctx, cart, null, { method: 'dine_in', table: known }, customer);
    return actionResult(messages.TABLE_REQUEST, { state: ORDER_STATE_AWAITING_TABLE, data: { cart, fulfilment: { method: 'dine_in' } } });
  }
  return beginScheduleChoiceStep(ctx, cart, { method: 'collection' }, customer);
}

/** Typed fallback for the fulfilment step ("delivery", "i'll collect"). Taps go through handleFulfilmentTap. */
export async function handleFulfilmentChoice(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  rawMessage: string,
  stateData: OrdersStateData,
): Promise<ActionResult> {
  const cart = stateData.cart ?? [];
  const methods = enabledFulfilments(ctx.config, ctx.catalog);
  const text = rawMessage.trim().toLowerCase();

  let picked: OrderFulfilment | null = null;
  if (/\bdeliver/.test(text)) picked = 'delivery';
  else if (/\b(dine|dine-in|table|eat in|sit)\b/.test(text)) picked = 'dine_in';
  else if (/\b(collect|pick ?up|pickup)\b/.test(text)) picked = 'collection';

  if (!picked || !methods.includes(picked)) {
    return fulfilmentListReply(methods, cart, stateData.tableLabel ?? null);
  }
  return chooseMethod(ctx, customer, cart, picked, stateData);
}

// ----------------------------------------------------------------------------
// Delivery: area (tap) -> address (typed)
// ----------------------------------------------------------------------------

function areaHint(ctx: TenantContext, area: DeliveryAreaRow): string {
  const parts = [area.fee > 0 ? `fee ${ctx.formatMoney(area.fee)}` : 'free delivery'];
  if (area.minOrder > 0) parts.push(`min ${ctx.formatMoney(area.minOrder)}`);
  if (area.freeOver !== null && area.fee > 0) parts.push(`free over ${ctx.formatMoney(area.freeOver)}`);
  return parts.join(' · ');
}

/** The delivery-area tap list. Row ids carry the INDEX into pendingAreaIds, which is kept in state. */
function areaListReply(ctx: TenantContext, areas: DeliveryAreaRow[], cart: CartItem[], page: number): ActionResult {
  const rows = pageRows(
    areas,
    page,
    0,
    (a, i) => ({ id: `${TAP_AREA}${i}`, title: a.name, description: areaHint(ctx, a) }),
    TAP_MORE,
  );
  return listReply(messages.DELIVERY_AREA_LIST_BODY, 'Choose area', [{ title: 'Delivery areas', rows }], {
    state: ORDER_STATE_AWAITING_DELIVERY_AREA,
    data: { cart, pendingAreaIds: areas.map((a) => a.id) },
  });
}

async function beginAreaStep(ctx: TenantContext, customer: OrderingCustomer | null, cart: CartItem[]): Promise<ActionResult> {
  const areas = ctx.catalog.deliveryAreas;
  if (areas.length === 0) return actionResult(messages.FULFILMENT_NOT_AVAILABLE);
  if (areas.length === 1) return selectArea(ctx, cart, areas[0]);
  return areaListReply(ctx, areas, cart, 0);
}

function selectArea(ctx: TenantContext, cart: CartItem[], area: DeliveryAreaRow): ActionResult {
  const subtotal = cartTotal(cart);
  if (area.minOrder > 0 && subtotal < area.minOrder) {
    return actionResult(
      messages.belowMinimumOrder(area.minOrder, subtotal, area.name),
      { state: ORDER_STATE_AWAITING_CART_ACTION, data: { cart } },
      CART_ACTION_BUTTONS,
    );
  }
  const fee = deliveryFeeFor(area, subtotal);
  const feeLine = fee > 0 ? `Delivery to ${area.name} costs ${ctx.formatMoney(fee)}.` : `Delivery to ${area.name} is free.`;
  return actionResult(`${feeLine}\n\n${messages.DELIVERY_ADDRESS_REQUEST}`, {
    state: ORDER_STATE_AWAITING_DELIVERY_ADDRESS,
    data: { cart, fulfilment: { method: 'delivery', areaId: area.id, areaName: area.name } },
  });
}

/** Typed fallback for the area step ("2" or the area's name). Taps go through handleFulfilmentTap. */
export function handleDeliveryAreaChoice(ctx: TenantContext, rawMessage: string, stateData: OrdersStateData): ActionResult {
  const cart = stateData.cart ?? [];
  const areas = ctx.catalog.deliveryAreas;
  const typed = rawMessage.trim().toLowerCase();

  let area: DeliveryAreaRow | undefined;
  if (/^\d{1,2}$/.test(typed)) {
    const id = stateData.pendingAreaIds?.[parseInt(typed, 10) - 1];
    area = areas.find((a) => a.id === id);
  } else {
    area = areas.find((a) => a.name.toLowerCase() === typed);
  }

  if (!area) return areaListReply(ctx, areas, cart, 0);
  return selectArea(ctx, cart, area);
}

export async function handleDeliveryAddress(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  rawMessage: string,
  stateData: OrdersStateData,
): Promise<ActionResult> {
  const cart = stateData.cart ?? [];
  const address = rawMessage.trim().replace(/\s+/g, ' ');

  if (address.length < MIN_ADDRESS || address.length > MAX_ADDRESS || !stateData.fulfilment?.areaId) {
    return actionResult(messages.DELIVERY_ADDRESS_INVALID, { state: ORDER_STATE_AWAITING_DELIVERY_ADDRESS, data: stateData });
  }
  const fulfilment: FulfilmentSelection = { ...stateData.fulfilment, method: 'delivery', address };
  return beginScheduleChoiceStep(ctx, cart, fulfilment, customer);
}

// ----------------------------------------------------------------------------
// Dine-in: table (typed)
// ----------------------------------------------------------------------------

export async function handleTableEntry(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  rawMessage: string,
  stateData: OrdersStateData,
): Promise<ActionResult> {
  const cart = stateData.cart ?? [];
  const table = normalizeTable(rawMessage);
  if (!table) {
    return actionResult(messages.TABLE_INVALID, { state: ORDER_STATE_AWAITING_TABLE, data: stateData });
  }
  return beginCartPaymentStep(ctx, cart, null, { method: 'dine_in', table }, customer);
}

// ----------------------------------------------------------------------------
// Taps on this file's lists. Returns null for an id that isn't ours or doesn't fit the current step
// (a tap on an old list): the caller then carries on as before.
// ----------------------------------------------------------------------------

export async function handleFulfilmentTap(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  stateName: OrdersStateName,
  stateData: OrdersStateData,
  tapId: string,
): Promise<ActionResult | null> {
  const cart = stateData.cart ?? [];

  if (tapId.startsWith(TAP_FULFIL)) {
    if (stateName !== ORDER_STATE_AWAITING_FULFILMENT) return null;
    const method = tapId.slice(TAP_FULFIL.length) as OrderFulfilment;
    if (!enabledFulfilments(ctx.config, ctx.catalog).includes(method)) return null;
    return chooseMethod(ctx, customer, cart, method, stateData);
  }

  if (tapId.startsWith(TAP_AREA)) {
    if (stateName !== ORDER_STATE_AWAITING_DELIVERY_AREA) return null;
    const index = Number(tapId.slice(TAP_AREA.length));
    const id = Number.isInteger(index) ? stateData.pendingAreaIds?.[index] : undefined;
    const area = ctx.catalog.deliveryAreas.find((a) => a.id === id);
    return area ? selectArea(ctx, cart, area) : areaListReply(ctx, ctx.catalog.deliveryAreas, cart, 0);
  }

  if (tapId.startsWith(TAP_MORE) && stateName === ORDER_STATE_AWAITING_DELIVERY_AREA) {
    const page = Number(tapId.slice(TAP_MORE.length));
    return areaListReply(ctx, ctx.catalog.deliveryAreas, cart, Number.isInteger(page) && page >= 0 ? page : 0);
  }

  return null;
}
