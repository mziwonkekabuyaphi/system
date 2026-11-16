// File: lib/services/orders/orders.fulfilment.ts
// ============================================================================
// FULFILMENT STEPS — how the customer gets the order: collection, delivery or dine-in.
//
// Sits between "checkout" and scheduling:
//
//   cart -> checkout -> [choose: collection | delivery | dine-in]
//                          collection -> schedule -> payment
//                          delivery   -> area -> address -> schedule -> payment
//                          dine-in    -> table -> payment
//
// A shop that only offers collection never sees any of this (beginCheckoutStep goes straight on to
// scheduling, exactly as before). What the customer typed is only ever a request: place_order
// re-checks the method, the area, the address, the minimum order and works out the fee itself.
// ============================================================================

import type { ActionResult } from '@/lib/types/action';
import * as messages from '@/lib/services/messages/orders';
import { actionResult, cartTotal } from './orders.helpers';
import { beginCartPaymentStep, beginScheduleChoiceStep } from './orders.flow-selection';
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
  type CartItem,
  type FulfilmentSelection,
  type OrderFulfilment,
  type OrdersStateData,
} from './orders.types';

const MIN_ADDRESS = 5;
const MAX_ADDRESS = 300;
const MAX_TABLE = 20;

/** "Table 7", "table7" and "7" are all table 7. */
export function normalizeTable(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '').replace(/^\s*table\s*/i, '').trim();
  return cleaned.length >= 1 && cleaned.length <= MAX_TABLE ? cleaned : null;
}

/** First step of checkout. Plain collection-only shops skip straight to scheduling. */
export function beginCheckoutStep(ctx: TenantContext, cart: CartItem[], prior?: Pick<OrdersStateData, 'tableLabel'>): ActionResult {
  const methods = enabledFulfilments(ctx.config, ctx.catalog);
  if (methods.length === 0) return actionResult(ORDERING_NOT_AVAILABLE);

  if (methods.length === 1) {
    return methods[0] === 'collection' ? beginScheduleChoiceStep(ctx, cart, null) : chooseMethod(ctx, cart, methods[0], prior);
  }
  return actionResult(
    messages.FULFILMENT_PROMPT,
    { state: ORDER_STATE_AWAITING_FULFILMENT, data: { cart, tableLabel: prior?.tableLabel ?? null } },
    methods.map(fulfilmentLabel),
  );
}

/** True when checkout has to ask something before payment (anything beyond plain collection). */
export function needsFulfilmentStep(ctx: TenantContext): boolean {
  const methods = enabledFulfilments(ctx.config, ctx.catalog);
  return !(methods.length === 1 && methods[0] === 'collection');
}

function chooseMethod(
  ctx: TenantContext,
  cart: CartItem[],
  method: OrderFulfilment,
  prior?: Pick<OrdersStateData, 'tableLabel'>,
): ActionResult {
  if (method === 'delivery') return beginAreaStep(ctx, cart);
  if (method === 'dine_in') {
    // "order 2 beers to table 7" already told us the table.
    const known = normalizeTable(prior?.tableLabel);
    if (known) return beginCartPaymentStep(ctx, cart, null, { method: 'dine_in', table: known });
    return actionResult(messages.TABLE_REQUEST, { state: ORDER_STATE_AWAITING_TABLE, data: { cart, fulfilment: { method: 'dine_in' } } });
  }
  return beginScheduleChoiceStep(ctx, cart, { method: 'collection' });
}

export function handleFulfilmentChoice(ctx: TenantContext, rawMessage: string, stateData: OrdersStateData): ActionResult {
  const cart = stateData.cart ?? [];
  const methods = enabledFulfilments(ctx.config, ctx.catalog);
  const text = rawMessage.trim().toLowerCase();

  let picked: OrderFulfilment | null = null;
  if (/\bdeliver/.test(text)) picked = 'delivery';
  else if (/\b(dine|dine-in|table|eat in|sit)\b/.test(text)) picked = 'dine_in';
  else if (/\b(collect|pick ?up|pickup)\b/.test(text)) picked = 'collection';

  if (!picked || !methods.includes(picked)) {
    return actionResult(
      messages.FULFILMENT_PROMPT,
      { state: ORDER_STATE_AWAITING_FULFILMENT, data: stateData },
      methods.map(fulfilmentLabel),
    );
  }
  return chooseMethod(ctx, cart, picked, stateData);
}

// ----------------------------------------------------------------------------
// Delivery: area -> address
// ----------------------------------------------------------------------------

function areaLine(ctx: TenantContext, index: number, area: DeliveryAreaRow): string {
  const parts = [area.fee > 0 ? `fee ${ctx.formatMoney(area.fee)}` : 'free delivery'];
  if (area.minOrder > 0) parts.push(`min order ${ctx.formatMoney(area.minOrder)}`);
  if (area.freeOver !== null && area.fee > 0) parts.push(`free over ${ctx.formatMoney(area.freeOver)}`);
  return `${messages.keycapNumber(index)} *${area.name}* — ${parts.join(', ')}`;
}

function areaList(ctx: TenantContext, areas: DeliveryAreaRow[]): string {
  return ['Which area should we deliver to? Reply with the number.', '', ...areas.map((a, i) => areaLine(ctx, i + 1, a))].join('\n');
}

function beginAreaStep(ctx: TenantContext, cart: CartItem[]): ActionResult {
  const areas = ctx.catalog.deliveryAreas;
  if (areas.length === 0) return actionResult(messages.FULFILMENT_NOT_AVAILABLE);
  if (areas.length === 1) return selectArea(ctx, cart, areas[0]);
  return actionResult(areaList(ctx, areas), {
    state: ORDER_STATE_AWAITING_DELIVERY_AREA,
    data: { cart, pendingAreaIds: areas.map((a) => a.id) },
  });
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

  if (!area) {
    return actionResult(`${messages.DELIVERY_AREA_INVALID}\n\n${areaList(ctx, areas)}`, {
      state: ORDER_STATE_AWAITING_DELIVERY_AREA,
      data: { ...stateData, pendingAreaIds: areas.map((a) => a.id) },
    });
  }
  return selectArea(ctx, cart, area);
}

export function handleDeliveryAddress(ctx: TenantContext, rawMessage: string, stateData: OrdersStateData): ActionResult {
  const cart = stateData.cart ?? [];
  const address = rawMessage.trim().replace(/\s+/g, ' ');

  if (address.length < MIN_ADDRESS || address.length > MAX_ADDRESS || !stateData.fulfilment?.areaId) {
    return actionResult(messages.DELIVERY_ADDRESS_INVALID, { state: ORDER_STATE_AWAITING_DELIVERY_ADDRESS, data: stateData });
  }
  const fulfilment: FulfilmentSelection = { ...stateData.fulfilment, method: 'delivery', address };
  return beginScheduleChoiceStep(ctx, cart, fulfilment);
}

// ----------------------------------------------------------------------------
// Dine-in: table
// ----------------------------------------------------------------------------

export function handleTableEntry(ctx: TenantContext, rawMessage: string, stateData: OrdersStateData): ActionResult {
  const cart = stateData.cart ?? [];
  const table = normalizeTable(rawMessage);
  if (!table) {
    return actionResult(messages.TABLE_INVALID, { state: ORDER_STATE_AWAITING_TABLE, data: stateData });
  }
  return beginCartPaymentStep(ctx, cart, null, { method: 'dine_in', table });
}
