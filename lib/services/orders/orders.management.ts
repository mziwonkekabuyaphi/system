// File: lib/services/orders/orders.management.ts
import type { ActionResult } from '@/lib/types/action';
import * as messages from '@/lib/messages/orders';
import type { CartItem, OrderItemRow, OrderRow, OrdersStateData } from './orders.types';
import { CART_VIEW_BUTTONS, ORDER_STATE_AWAITING_CART_ACTION, TRACKING_BUTTONS } from './orders.types';
import type { TenantContext } from './orders.tenant';
import { actionResult, addItemToCart, cartToLineItems, validateProductAvailability } from './orders.helpers';
import {
  cancelOrder,
  getActiveOrdersForPhone,
  getLastCompletedOrderForPhone,
  getLatestOrderForPhone,
  getOrderHistoryForPhone,
  getOrderItems,
  getProductById,
} from './orders.db';

// ============================================================================
// TRACKING / CANCEL / REPEAT / HISTORY / ACTIVE ORDERS
// ============================================================================

function buildTrackingReply(order: OrderRow, items: OrderItemRow[]): string {
  return messages.trackingMessage(
    order.order_number,
    order.status,
    items.map((item) => ({ quantity: item.quantity, productName: item.product_name })),
    order.total_amount,
    order.payment_status,
    // The collection point now comes from the order's own vendor (order_vendors),
    // not from guessing off the first item's product type.
    order.collection_point,
  );
}

export async function handleTrackOrder(ctx: TenantContext, phone: string): Promise<ActionResult> {
  const order = await getLatestOrderForPhone(ctx, phone);
  if (!order) {
    return actionResult(messages.NO_ORDERS_YET);
  }

  const items = await getOrderItems(ctx, order.id);
  return actionResult(buildTrackingReply(order, items), null, TRACKING_BUTTONS);
}

export async function handleCancelOrder(ctx: TenantContext, phone: string): Promise<ActionResult> {
  const order = await getLatestOrderForPhone(ctx, phone);
  if (!order) {
    return actionResult(messages.NO_ORDER_TO_CANCEL);
  }

  // Status check, wallet refund (via wallet_ledger), and stock restore all
  // happen atomically inside the cancel_order function.
  const result = await cancelOrder(ctx, order.id);

  switch (result.outcome) {
    case 'ok':
      return actionResult(messages.orderCancelledMessage(result.orderNumber, result.wasPaid));
    case 'not_cancellable':
      return actionResult(messages.cancelNotAllowed(result.orderNumber, result.status));
    default:
      return actionResult(messages.CANCEL_GENERIC_FAILURE);
  }
}

export async function handleActiveOrders(ctx: TenantContext, phone: string): Promise<ActionResult> {
  const orders = await getActiveOrdersForPhone(ctx, phone);
  if (orders.length === 0) {
    return actionResult(messages.NO_ACTIVE_ORDERS);
  }

  return actionResult(
    messages.activeOrdersMessage(
      orders.map((order) => ({ orderNumber: order.order_number, status: order.status, totalAmount: order.total_amount })),
    ),
  );
}

export async function handleOrderHistory(ctx: TenantContext, phone: string): Promise<ActionResult> {
  const orders = await getOrderHistoryForPhone(ctx, phone);
  if (orders.length === 0) {
    return actionResult(messages.NO_ORDER_HISTORY);
  }

  return actionResult(
    messages.orderHistoryMessage(
      orders.map((order) => ({
        orderNumber: order.order_number,
        orderDate: order.order_date,
        totalAmount: order.total_amount,
        status: order.status,
      })),
    ),
  );
}

/**
 * Repeats the customer's last completed order into the CART (never straight to
 * payment). Every line is re-fetched, so current prices/availability always
 * apply; lines that are no longer available are skipped. place_order
 * re-validates everything again at checkout.
 *
 * Scope note: a checkout that spanned several vendors creates one order per
 * vendor, and "last completed" is a single vendor order — so this repeats that
 * vendor's items.
 */
export async function handleRepeatOrder(
  ctx: TenantContext,
  phone: string,
  existingCart: CartItem[],
): Promise<ActionResult> {
  const lastCompleted = await getLastCompletedOrderForPhone(ctx, phone);
  if (!lastCompleted) {
    return actionResult(messages.NO_COMPLETED_ORDER_TO_REPEAT);
  }

  const previousItems = await getOrderItems(ctx, lastCompleted.id);
  if (previousItems.length === 0) {
    return actionResult(messages.REPEAT_ITEMS_NOT_FOUND);
  }

  let cart = existingCart;
  let added = 0;
  let firstError: string | undefined;

  for (const item of previousItems) {
    if (!item.product_id) {
      firstError ??= messages.REPEAT_PRODUCT_NOT_MATCHED;
      continue;
    }
    const product = await getProductById(ctx, item.product_id);
    const availability = validateProductAvailability(product, item.quantity);
    if (!availability.valid || !product) {
      firstError ??= availability.errorReply;
      continue;
    }
    cart = addItemToCart(cart, {
      productId: product.id,
      name: product.name,
      unitPrice: Number(product.price),
      quantity: item.quantity,
      category: product.category,
    });
    added += 1;
  }

  if (added === 0) {
    return actionResult(firstError ?? messages.REPEAT_ITEMS_NOT_FOUND);
  }

  const nextData: OrdersStateData = { cart, tableLabel: null };
  return actionResult(
    messages.cartSummaryMessage(cartToLineItems(cart)),
    { state: ORDER_STATE_AWAITING_CART_ACTION, data: nextData },
    CART_VIEW_BUTTONS,
  );
}
