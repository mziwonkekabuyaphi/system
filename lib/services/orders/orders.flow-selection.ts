// File: lib/services/orders/orders.flow-selection.ts
import type { ActionResult } from '@/lib/types/action';
import * as messages from '@/lib/services/messages/orders';
import type {
  CartItem,
  FulfilmentSelection,
  OrdersStateData,
  PendingCategory,
  PendingSelectionItem,
  ProductCategory,
  ProductRow,
} from './orders.types';
import { deliveryFeeFor, paymentButtons, type TenantContext } from './orders.tenant';
import {
  CART_ACTION_BUTTONS,
  CART_VIEW_BUTTONS,
  EMPTY_CART_BUTTONS,
  WELCOME_BUTTONS,
  SCHEDULE_CHOICE_BUTTONS,
  ORDER_STATE_AWAITING_CART_ACTION,
  ORDER_STATE_AWAITING_CATEGORY,
  ORDER_STATE_AWAITING_REMOVE_ITEM,
  ORDER_STATE_AWAITING_WELCOME,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_QUANTITY,
  ORDER_STATE_AWAITING_SCHEDULE_CHOICE,
  ORDER_STATE_AWAITING_SCHEDULE_TIME,
  ORDER_STATE_AWAITING_SELECTION,
} from './orders.types';
import { actionResult, addItemToCart, cartToLineItems, cartTotal, categoryByKey, getCart } from './orders.helpers';

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
export function beginCartPaymentStep(
  ctx: TenantContext,
  cart: CartItem[],
  scheduledFor?: string | null,
  fulfilment?: FulfilmentSelection | null,
): ActionResult {
  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;

  return actionResult(
    messages.cartPaymentMethodPrompt(cartToLineItems(cart), scheduledLabel, fulfilmentSummary(ctx, cart, fulfilment)),
    {
      state: ORDER_STATE_AWAITING_PAYMENT_METHOD,
      data: { cart, scheduledFor: scheduledFor ?? null, fulfilment: fulfilment ?? null },
    },
    paymentButtons(ctx.config),
  );
}

/**
 * The delivery / dine-in lines and the all-in total shown at checkout. null for plain collection, so
 * the prompt looks exactly as it always has. The fee shown here uses the same rule as place_order,
 * which stays the authority for what is actually charged.
 */
/** The delivery fee for this selection and items total (0 unless it is a delivery to a known area). */
export function deliveryFeeForSelection(ctx: TenantContext, fulfilment: FulfilmentSelection | null | undefined, itemsTotal: number): number {
  if (fulfilment?.method !== 'delivery') return 0;
  const area = ctx.catalog.deliveryAreas.find((a) => a.id === fulfilment.areaId);
  return area ? deliveryFeeFor(area, itemsTotal) : 0;
}

export function fulfilmentSummary(
  ctx: TenantContext,
  cart: CartItem[],
  fulfilment?: FulfilmentSelection | null,
): { lines: string[]; total: number } | null {
  const subtotal = cartTotal(cart);
  if (fulfilment?.method === 'delivery') {
    const fee = deliveryFeeForSelection(ctx, fulfilment, subtotal);
    return {
      lines: [
        `🚚 Delivery to: ${fulfilment.address ?? ''} (${fulfilment.areaName ?? ''})`,
        fee > 0 ? `Delivery fee: ${ctx.formatMoney(fee)}` : 'Delivery: free',
      ],
      total: Number((subtotal + fee).toFixed(2)),
    };
  }
  if (fulfilment?.method === 'dine_in') {
    return { lines: [`🍽️ Dine-in: table ${fulfilment.table ?? ''}`], total: subtotal };
  }
  return null;
}

/** Total the customer will pay for this cart with the chosen fulfilment (items plus any delivery fee). */
export function cartGrandTotal(ctx: TenantContext, cart: CartItem[], fulfilment?: FulfilmentSelection | null): number {
  return fulfilmentSummary(ctx, cart, fulfilment)?.total ?? cartTotal(cart);
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
export function beginScheduleChoiceStep(ctx: TenantContext, cart: CartItem[], fulfilment?: FulfilmentSelection | null): ActionResult {
  const method = fulfilment?.method ?? 'collection';
  // Dine-in is served now; scheduling only applies to collection and delivery.
  if (!ctx.config.allowScheduling || method === 'dine_in') {
    return beginCartPaymentStep(ctx, cart, null, fulfilment);
  }
  const delivery = method === 'delivery';
  return actionResult(
    delivery ? messages.SCHEDULE_CHOICE_PROMPT_DELIVERY : messages.SCHEDULE_CHOICE_PROMPT,
    { state: ORDER_STATE_AWAITING_SCHEDULE_CHOICE, data: { cart, fulfilment: fulfilment ?? null } },
    delivery ? ['Deliver Now', 'Schedule Later'] : SCHEDULE_CHOICE_BUTTONS,
  );
}

/** "Schedule Later" was picked — ask for a concrete time before moving on to payment. */
export function beginScheduleTimeStep(cart: CartItem[], fulfilment?: FulfilmentSelection | null): ActionResult {
  return actionResult(messages.SCHEDULE_TIME_REQUEST, {
    state: ORDER_STATE_AWAITING_SCHEDULE_TIME,
    data: { cart, fulfilment: fulfilment ?? null },
  });
}

// ============================================================================
// WELCOME, CATEGORIES, CART VIEW — the "first impression" screens
// ============================================================================

/** Branded welcome shown on a fresh entry: Order Now / Track My Order. */
export function beginWelcomeReply(ctx: TenantContext): ActionResult {
  return actionResult(
    messages.welcomeMessage(ctx.config.brandName),
    { state: ORDER_STATE_AWAITING_WELCOME, data: { cart: [] } },
    WELCOME_BUTTONS,
  );
}

/**
 * Category list: the tenant's categories (grouped by group when they have one) that actually have
 * something available right now, each with its product count. Keeps the first message short instead of
 * dumping every product.
 */
export function buildCategoryView(
  ctx: TenantContext,
  products: ProductRow[],
): { text: string; pendingCategories: PendingCategory[] } {
  const groups = new Map<string, { key: string; label: string; ids: string[]; count: number }>();
  const groupIdOf = (c: { key: string; groupKey: string | null }) => (c.groupKey ? `g:${c.groupKey}` : `c:${c.key}`);

  for (const c of [...ctx.catalog.categories].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const id = groupIdOf(c);
    const existing = groups.get(id);
    if (existing) existing.ids.push(c.id);
    else groups.set(id, { key: c.key, label: c.groupLabel ?? c.label, ids: [c.id], count: 0 });
  }

  const byKey = new Map(ctx.catalog.categories.map((c) => [c.key, c]));
  for (const product of products) {
    const category = product.category ? byKey.get(product.category) : undefined;
    if (category) groups.get(groupIdOf(category))!.count += 1;
  }

  const shown = Array.from(groups.values()).filter((g) => g.count > 0);
  return {
    text: messages.categoryMenuMessage(shown.map((g) => ({ label: g.label, count: g.count }))),
    pendingCategories: shown.map((g) => ({ label: g.label, categoryIds: g.ids, key: g.key })),
  };
}

/** Shows the category list (state: pick a number), carrying the cart through. */
export function beginCategoryReply(ctx: TenantContext, products: ProductRow[], cart: CartItem[]): ActionResult {
  const { text, pendingCategories } = buildCategoryView(ctx, products);
  if (pendingCategories.length === 0) {
    return actionResult(messages.EMPTY_MENU);
  }
  return actionResult(text, { state: ORDER_STATE_AWAITING_CATEGORY, data: { pendingCategories, cart } });
}

/** The cart on screen, with an optional one-line notice above it ("Removed X."). */
export function viewCartReply(cart: CartItem[], priorState: OrdersStateData, notice?: string): ActionResult {
  return actionResult(
    messages.cartSummaryMessage(cartToLineItems(cart), notice),
    {
      state: ORDER_STATE_AWAITING_CART_ACTION,
      data: { cart, pendingSelection: priorState.pendingSelection, tableLabel: priorState.tableLabel ?? null },
    },
    cart.length > 0 ? CART_VIEW_BUTTONS : EMPTY_CART_BUTTONS,
  );
}

/** "Remove Items" tapped: list the cart lines with numbers. */
export function beginRemoveItemStep(cart: CartItem[], priorState: OrdersStateData): ActionResult {
  if (cart.length === 0) return viewCartReply(cart, priorState);
  return actionResult(messages.removeItemPrompt(cartToLineItems(cart)), {
    state: ORDER_STATE_AWAITING_REMOVE_ITEM,
    data: { cart, pendingSelection: priorState.pendingSelection, tableLabel: priorState.tableLabel ?? null },
  });
}
