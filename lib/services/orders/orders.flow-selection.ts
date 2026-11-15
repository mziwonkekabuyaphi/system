// File: lib/services/orders/orders.flow-selection.ts
import type { ActionResult } from '@/lib/types/action';
import * as messages from '@/lib/messages/orders';
import type { CartItem, OrdersStateData, PendingSelectionItem, ProductCategory, ProductRow } from './orders.types';
import { paymentButtons, type TenantContext } from './orders.tenant';
import {
  CART_ACTION_BUTTONS,
  SCHEDULE_CHOICE_BUTTONS,
  ORDER_STATE_AWAITING_CART_ACTION,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_QUANTITY,
  ORDER_STATE_AWAITING_SCHEDULE_CHOICE,
  ORDER_STATE_AWAITING_SCHEDULE_TIME,
  ORDER_STATE_AWAITING_SELECTION,
} from './orders.types';
import { actionResult, addItemToCart, cartToLineItems, categoryByKey, getCart } from './orders.helpers';

// ============================================================================
// PRODUCT SELECTION & CART BUILDING — STEP HANDLERS
// ============================================================================

export function beginProductSelectionReply(
  title: string,
  category: ProductCategory | undefined,
  products: ProductRow[],
  cart: CartItem[],
): ActionResult {
  if (products.length === 0) {
    return actionResult(messages.noProductsInCategory(title));
  }

  const pendingSelection: PendingSelectionItem[] = products.slice(0, 9).map((p) => ({
    productId: p.id,
    name: p.name,
    price: Number(p.price),
    category: p.category,
  }));

  return actionResult(
    messages.productListMessage(title, products.slice(0, 9)),
    {
      state: ORDER_STATE_AWAITING_SELECTION,
      data: { pendingSelection, category, cart },
    },
  );
}

/**
 * Full-menu equivalent of beginProductSelectionReply/formatFullMenu: numbers
 * every product globally (not reset per category, nothing truncated) so a
 * customer can reply with any number and add that item straight to the
 * cart — without ever opening its category. The grouping here must match
 * messages.fullMenuMessage's own grouping exactly, since the numbers shown
 * in the text have to line up with this pendingSelection array position-for-position.
 */
export function buildFullMenuView(
  ctx: TenantContext,
  products: ProductRow[],
): { text: string; pendingSelection: PendingSelectionItem[] } {
  // `products` arrives sorted by the tenant's category sort order (see getFullMenu),
  // so insertion order of this Map is already the display order.
  const byCategory = new Map<string, ProductRow[]>();
  for (const product of products) {
    const key = categoryByKey(ctx, product.category)?.label ?? 'Other';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(product);
  }
  const grouped = Array.from(byCategory.entries()).map(([category, items]) => ({ category, products: items }));

  const text = messages.fullMenuMessage(grouped);
  const pendingSelection: PendingSelectionItem[] = grouped.flatMap(({ products: items }) =>
    items.map((p) => ({ productId: p.id, name: p.name, price: Number(p.price), category: p.category })),
  );

  return { text, pendingSelection };
}

export function beginQuantityStep(
  productId: string,
  productName: string,
  unitPrice: number,
  productCategory: ProductCategory | null,
  tableLabel: string | null,
  cart: CartItem[],
  pendingSelection?: PendingSelectionItem[],
): ActionResult {
  return actionResult(
    messages.quantityPrompt(productName, unitPrice),
    {
      state: ORDER_STATE_AWAITING_QUANTITY,
      data: {
        selectedProductId: productId,
        selectedProductName: productName,
        selectedUnitPrice: unitPrice,
        selectedProductCategory: productCategory,
        tableLabel,
        cart,
        pendingSelection,
      },
    },
  );
}

/**
 * Adds the item currently being configured (product + quantity) to the
 * cart, and hands back an "add another item, or checkout?" prompt. This is the step that replaces
 * going straight to payment — it's what lets a customer keep shopping across
 * multiple products in one session instead of being locked into buying just
 * the one thing they picked first.
 *
 * `priorState` supplies the cart-so-far and the pendingSelection list (if
 * any) so numbered replies keep working after this add without the customer
 * having to reopen a category or re-request the menu.
 */
export function addToCartAndReview(
  productId: string,
  productName: string,
  unitPrice: number,
  category: ProductCategory | null,
  quantity: number,
  priorState: OrdersStateData,
): ActionResult {
  const cart = addItemToCart(getCart(priorState), { productId, name: productName, unitPrice, quantity, category });
  const justAdded: messages.CartLineItem = { productName, quantity, unitPrice };

  return actionResult(
    messages.addedToCartMessage(justAdded, cartToLineItems(cart)),
    {
      state: ORDER_STATE_AWAITING_CART_ACTION,
      data: {
        cart,
        pendingSelection: priorState.pendingSelection,
        tableLabel: priorState.tableLabel ?? null,
      },
    },
    CART_ACTION_BUTTONS,
  );
}

/**
 * Cart equivalent of the old single-item payment prompt — totals the whole
 * cart, same wallet/card/cash choice (per tenant), no separate confirmation step.
 * `scheduledFor` (a UTC ISO string) is carried straight through into
 * ORDER_STATE_AWAITING_PAYMENT_METHOD's state data — undefined/null for the
 * ordinary "collect now" path — so it survives whichever payment path the
 * customer takes next (finalizeOrderFromState reads it back out).
 */
export function beginCartPaymentStep(ctx: TenantContext, cart: CartItem[], scheduledFor?: string | null): ActionResult {
  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;

  return actionResult(
    messages.cartPaymentMethodPrompt(cartToLineItems(cart), scheduledLabel),
    {
      state: ORDER_STATE_AWAITING_PAYMENT_METHOD,
      data: { cart, scheduledFor: scheduledFor ?? null },
    },
    paymentButtons(ctx.config),
  );
}

// ============================================================================
// SCHEDULING — WhatsApp equivalent of order-now.js's collect modal
// ("Collect Now" vs pick a time slot). Sits between "checkout" and payment
// method: order-now.js also decides now-vs-later before charging, not after.
// ============================================================================

/**
 * First step of checkout — "collect now, or schedule for later?". Tenants that
 * have scheduling switched off (order_settings.allow_scheduling) skip straight
 * to payment.
 */
export function beginScheduleChoiceStep(ctx: TenantContext, cart: CartItem[]): ActionResult {
  if (!ctx.config.allowScheduling) {
    return beginCartPaymentStep(ctx, cart, null);
  }
  return actionResult(
    messages.SCHEDULE_CHOICE_PROMPT,
    { state: ORDER_STATE_AWAITING_SCHEDULE_CHOICE, data: { cart } },
    SCHEDULE_CHOICE_BUTTONS,
  );
}

/** "Schedule Later" was picked — ask for a concrete time before moving on to payment. */
export function beginScheduleTimeStep(cart: CartItem[]): ActionResult {
  return actionResult(messages.SCHEDULE_TIME_REQUEST, { state: ORDER_STATE_AWAITING_SCHEDULE_TIME, data: { cart } });
}
