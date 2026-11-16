// File: lib/services/orders/orders.flow-selection.ts
// ============================================================================
// PRODUCT SELECTION, CART AND CHECKOUT SCREENS — all tap lists.
//
// The customer taps through: menu list -> category list -> quantity buttons -> cart buttons ->
// [how do you want it? collection / delivery / dine-in] -> ONE pay-and-time list. Nothing is typed except
// "3 or more" quantities, a delivery address and a table number.
//
// Fulfilment (collection / delivery / dine-in) is carried as a FulfilmentSelection through the schedule and
// payment screens, and shown in the payment text with its fee. What the customer sees is only ever a preview:
// place_order re-checks the method, area, address, minimum order and works out the fee itself.
// ============================================================================

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
import { deliveryFeeFor, localParts, paymentChoiceLabel, type TenantContext } from './orders.tenant';
import { listReply, pageRows } from '@/lib/services/shared/tap-lists';
import type { ChoiceRow, ChoiceSection } from '@/lib/whatsapp/utils/choice-list';
import { getWalletBalanceForOrder, type OrderingCustomer } from './orders.db';
import {
  CART_ACTION_BUTTONS,
  CART_VIEW_BUTTONS,
  EMPTY_CART_BUTTONS,
  WELCOME_BUTTONS,
  ORDER_STATE_AWAITING_CART_ACTION,
  ORDER_STATE_AWAITING_CATEGORY,
  ORDER_STATE_AWAITING_REMOVE_ITEM,
  ORDER_STATE_AWAITING_WELCOME,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_QUANTITY,
  ORDER_STATE_AWAITING_SCHEDULE_TIME,
  ORDER_STATE_AWAITING_SELECTION,
  QUANTITY_BUTTONS,
  TAP_CART,
  TAP_CATEGORY,
  TAP_FULL_MENU,
  TAP_LATER,
  TAP_MENU,
  TAP_MORE,
  TAP_PAY,
  TAP_PRODUCT,
  TAP_REMOVE,
  TAP_REMOVE_ALL,
  TAP_REMOVE_BACK,
  TAP_SAME_AGAIN,
  TAP_TIME,
  TAP_TIME_TYPE,
  TAP_TRACK,
} from './orders.types';
import { actionResult, addItemToCart, cartToLineItems, cartTotal, categoryByKey, getCart, parseScheduleTime } from './orders.helpers';

/** Most products kept in the saved state for one list (a menu list pages through them, nine at a time). */
const PRODUCT_LIST_MAX = 200;

function cartItemCount(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

// ============================================================================
// PRODUCT LISTS
// ============================================================================

/**
 * One tap list of products, price under each name, with "◂ Other categories" (and "🛒 View cart" once there is
 * something in it) at the bottom. More than fits one list (WhatsApp allows 10 rows): "More ▸" pages through the
 * full list kept in state. A row carries the PRODUCT ID, so a tap on an old list can never add the wrong item.
 */
export function productListReply(
  title: string,
  category: ProductCategory | undefined,
  items: PendingSelectionItem[],
  cart: CartItem[],
  page: number,
): ActionResult {
  const more: ChoiceRow[] = [{ id: TAP_MENU, title: '◂ Other categories' }];
  if (cart.length > 0) more.push({ id: TAP_CART, title: `🛒 View cart (${cartItemCount(cart)})` });

  const rows = pageRows(
    items,
    page,
    more.length,
    (p) => ({ id: `${TAP_PRODUCT}${p.productId}`, title: p.name, description: messages.formatCurrency(p.price) }),
    TAP_MORE,
  );
  return listReply(messages.productListBody(title), 'Choose item', [{ title, rows }, { title: 'More', rows: more }], {
    state: ORDER_STATE_AWAITING_SELECTION,
    data: { pendingSelection: items, category, cart, listTitle: title },
  });
}

export function beginProductSelectionReply(
  title: string,
  category: ProductCategory | undefined,
  products: ProductRow[],
  cart: CartItem[],
): ActionResult {
  if (products.length === 0) {
    return actionResult(messages.noProductsInCategory(title));
  }

  const pendingSelection: PendingSelectionItem[] = products.slice(0, PRODUCT_LIST_MAX).map((p) => ({
    productId: p.id,
    name: p.name,
    price: Number(p.price),
    category: p.category,
  }));

  return productListReply(title, category, pendingSelection, cart, 0);
}

/**
 * Full-menu view: every product on one list, numbered globally. The grouping here must match
 * messages.fullMenuMessage's own grouping exactly, since the numbers shown in the text have to line up with
 * this pendingSelection array position-for-position.
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
  listTitle?: string,
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
        listTitle,
      },
    },
    // 1 / 2 are read as the number they say; "3 or more" is the only time a number is typed.
    QUANTITY_BUTTONS,
  );
}

/**
 * Adds the item being configured (product + quantity) to the cart and hands back "add another item, or
 * checkout?". `priorState` supplies the cart-so-far and the list last shown, so the customer can keep adding
 * straight off it.
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
        listTitle: priorState.listTitle,
        tableLabel: priorState.tableLabel ?? null,
      },
    },
    CART_ACTION_BUTTONS,
  );
}

// ============================================================================
// FULFILMENT PREVIEW (what the customer is shown; place_order recomputes all of it)
// ============================================================================

/** Delivery fee for the selection, 0 for anything else. Mirrors place_order's rule (area fee, free-over threshold). */
export function deliveryFeeForSelection(
  ctx: TenantContext,
  fulfilment: FulfilmentSelection | null | undefined,
  itemsTotal: number,
): number {
  if (!fulfilment || fulfilment.method !== 'delivery' || !fulfilment.areaId) return 0;
  const area = ctx.catalog.deliveryAreas.find((a) => a.id === fulfilment.areaId);
  return area ? deliveryFeeFor(area, itemsTotal) : 0;
}

/**
 * The extra lines and the grand total for the payment / confirmation text. null = plain collection, which
 * keeps the original look (items + total, nothing else).
 */
export function fulfilmentSummary(
  ctx: TenantContext,
  cart: CartItem[],
  fulfilment: FulfilmentSelection | null | undefined,
): { lines: string[]; total: number } | null {
  if (!fulfilment || fulfilment.method === 'collection') return null;
  const subtotal = cartTotal(cart);

  if (fulfilment.method === 'dine_in') {
    return { lines: [`🍽️ Dine-in · table ${fulfilment.table ?? '?'}`], total: subtotal };
  }

  const fee = deliveryFeeForSelection(ctx, fulfilment, subtotal);
  const lines = [
    `🚚 Delivery to *${fulfilment.areaName ?? 'your area'}*: ${fee > 0 ? ctx.formatMoney(fee) : 'free'}`,
    ...(fulfilment.address ? [`📍 ${fulfilment.address}`] : []),
  ];
  return { lines, total: Number((subtotal + fee).toFixed(2)) };
}

// ============================================================================
// CHECKOUT — ONE list for "how do you want to pay?" and "now or later?"
// ============================================================================

/**
 * One list: each payment method the shop offers (the wallet row shows the live balance, so nobody picks it and
 * then hits a "top up" detour), plus "🕒 Collect/Deliver later" when scheduling is on. After a time is picked this
 * shows again WITHOUT the "later" row and with the time in the text. Dine-in never offers "later".
 * Nothing is charged here: a tap on a method goes through finalizeOrderFromState.
 *
 * `customer` is only used to show the wallet balance; without it the wallet row just has no balance line.
 */
export async function beginCartPaymentStep(
  ctx: TenantContext,
  cart: CartItem[],
  scheduledFor?: string | null,
  fulfilment?: FulfilmentSelection | null,
  customer: OrderingCustomer | null = null,
): Promise<ActionResult> {
  const summary = fulfilmentSummary(ctx, cart, fulfilment);
  const total = summary ? summary.total : cartTotal(cart);

  let balance: number | null = null;
  if (customer && ctx.config.paymentMethods.includes('wallet')) {
    try {
      balance = await getWalletBalanceForOrder(ctx, customer.id);
    } catch {
      balance = null; // a courtesy figure only: place_order re-checks under a lock
    }
  }

  const describe = (method: 'wallet' | 'card' | 'cash'): string | undefined => {
    if (method === 'wallet') {
      if (balance === null) return undefined;
      return balance >= total ? `${ctx.formatMoney(balance)} available` : `${ctx.formatMoney(balance)} — top up needed`;
    }
    if (method === 'card') return 'Pay securely online';
    return fulfilment?.method === 'delivery' ? 'Pay the driver on delivery' : fulfilment?.method === 'dine_in' ? 'Pay at your table' : 'Pay when you collect';
  };

  const sections: ChoiceSection[] = [
    {
      title: 'Pay with',
      rows: ctx.config.paymentMethods.map((method) => {
        const description = describe(method);
        return {
          id: `${TAP_PAY}${method}`,
          title: paymentChoiceLabel(ctx.config, method),
          ...(description ? { description } : {}),
        };
      }),
    },
  ];

  const canSchedule = !scheduledFor && ctx.config.allowScheduling && fulfilment?.method !== 'dine_in';
  if (canSchedule) {
    sections.push({
      title: 'Or',
      rows: [
        {
          id: TAP_LATER,
          title: fulfilment?.method === 'delivery' ? '🕒 Deliver later' : '🕒 Collect later',
          description: 'Pick a time today',
        },
      ],
    });
  }

  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;
  return listReply(messages.cartPaymentMethodPrompt(cartToLineItems(cart), scheduledLabel, summary), 'Choose payment', sections, {
    state: ORDER_STATE_AWAITING_PAYMENT_METHOD,
    data: { cart, scheduledFor: scheduledFor ?? null, fulfilment: fulfilment ?? null },
  });
}

/**
 * Kept under its old name so existing callers keep working. With the list design "collect now or later?" IS the
 * payment list (its "later" row), so this simply shows it.
 */
export function beginScheduleChoiceStep(
  ctx: TenantContext,
  cart: CartItem[],
  fulfilment?: FulfilmentSelection | null,
  customer: OrderingCustomer | null = null,
): Promise<ActionResult> {
  return beginCartPaymentStep(ctx, cart, null, fulfilment ?? null, customer);
}

/** "Later" was chosen and typed input is needed (or no slot is left today): ask for a time in words. */
export function beginScheduleTimeStep(cart: CartItem[], fulfilment?: FulfilmentSelection | null): ActionResult {
  return actionResult(messages.SCHEDULE_TIME_REQUEST, {
    state: ORDER_STATE_AWAITING_SCHEDULE_TIME,
    data: { cart, fulfilment: fulfilment ?? null },
  });
}

/**
 * The next valid times today, every 30 minutes. Each candidate goes through parseScheduleTime, so opening hours,
 * the minimum lead time and "today only" are exactly the rules a typed time already follows.
 * (Candidates are written with an explicit am/pm: without one, parseScheduleTime reads hours 1-7 as PM.)
 */
function nextScheduleSlots(ctx: TenantContext, count: number, now: Date = new Date()): Array<{ iso: string; label: string }> {
  const local = localParts(now, ctx.config.timeZone);
  const first = Math.ceil((local.hour * 60 + local.minute + ctx.config.scheduleMinLeadMinutes) / 30) * 30;
  const slots: Array<{ iso: string; label: string }> = [];

  for (let minutes = first; minutes < 24 * 60 && slots.length < count; minutes += 30) {
    const hour = Math.floor(minutes / 60);
    const minute = String(minutes % 60).padStart(2, '0');
    const hour12 = ((hour + 11) % 12) + 1;
    const parsed = parseScheduleTime(`${hour12}:${minute} ${hour >= 12 ? 'pm' : 'am'}`, ctx, now);
    if (parsed.valid) slots.push({ iso: parsed.iso, label: parsed.label });
  }
  return slots;
}

/**
 * "🕒 later" tapped: the next valid times as a tap list, plus "⌨️ Type a time" for anything else. With no valid
 * time left today (closed, or past the last slot) it falls back to the typed prompt, which explains why.
 */
export function beginScheduleTimeList(
  ctx: TenantContext,
  cart: CartItem[],
  fulfilment?: FulfilmentSelection | null,
): ActionResult {
  const slots = nextScheduleSlots(ctx, 8);
  if (slots.length === 0) return beginScheduleTimeStep(cart, fulfilment);

  const rows: ChoiceRow[] = [
    ...slots.map((slot, i) => ({ id: `${TAP_TIME}${i}`, title: slot.label })),
    { id: TAP_TIME_TYPE, title: '⌨️ Type a time' },
  ];
  const body = fulfilment?.method === 'delivery' ? messages.SCHEDULE_TIME_LIST_BODY_DELIVERY : messages.SCHEDULE_TIME_LIST_BODY;
  return listReply(body, 'Choose time', [{ title: 'Today', rows }], {
    state: ORDER_STATE_AWAITING_SCHEDULE_TIME,
    data: { cart, pendingTimes: slots, fulfilment: fulfilment ?? null },
  });
}

// ============================================================================
// WELCOME, CATEGORIES, CART VIEW — the "first impression" screens
// ============================================================================

/** Branded welcome (older chats only: a fresh entry now opens the menu list directly). */
export function beginWelcomeReply(ctx: TenantContext): ActionResult {
  return actionResult(
    messages.welcomeMessage(ctx.config.brandName),
    { state: ORDER_STATE_AWAITING_WELCOME, data: { cart: [] } },
    WELCOME_BUTTONS,
  );
}

/**
 * Category list: the tenant's categories (grouped by group when they have one) that actually have something
 * available right now, each with its product count.
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
    pendingCategories: shown.map((g) => ({ label: g.label, categoryIds: g.ids, key: g.key, count: g.count })),
  };
}

/**
 * The menu as ONE tap list: each category with how many items it has, then a "Quick" section: "Same as last time"
 * (a returning customer with an empty cart), "Full menu", and "View cart" (cart has items) or "Track my order".
 * Pages with "More ▸" from state.
 */
export function categoryListReply(
  brandName: string,
  categories: PendingCategory[],
  cart: CartItem[],
  sameAgain: string | null,
  page: number,
): ActionResult {
  const itemCount = cartItemCount(cart);
  const quick: ChoiceRow[] = [];
  if (sameAgain && cart.length === 0) {
    quick.push({ id: TAP_SAME_AGAIN, title: '🔁 Same as last time', description: sameAgain });
  }
  quick.push({ id: TAP_FULL_MENU, title: '🍽️ Full menu', description: 'Every item on one list' });
  quick.push(cart.length > 0 ? { id: TAP_CART, title: `🛒 View cart (${itemCount})` } : { id: TAP_TRACK, title: '📦 Track my order' });

  const rows = pageRows(
    categories,
    page,
    quick.length,
    (c, i) => ({
      id: `${TAP_CATEGORY}${i}`,
      title: c.label,
      ...(c.count ? { description: `${c.count} item${c.count === 1 ? '' : 's'}` } : {}),
    }),
    TAP_MORE,
  );

  const body = cart.length > 0 ? messages.cartMenuBody(itemCount) : messages.welcomeMessage(brandName);
  return listReply(body, 'View menu', [{ title: 'Menu', rows }, { title: 'Quick', rows: quick }], {
    state: ORDER_STATE_AWAITING_CATEGORY,
    data: { pendingCategories: categories, cart, sameAgain },
  });
}

/** Shows the menu list, carrying the cart through. `sameAgain` = the "Same as last time" summary, if any. */
export function beginCategoryReply(
  ctx: TenantContext,
  products: ProductRow[],
  cart: CartItem[],
  opts: { sameAgain?: string | null } = {},
): ActionResult {
  const { pendingCategories } = buildCategoryView(ctx, products);
  if (pendingCategories.length === 0) {
    return actionResult(messages.EMPTY_MENU);
  }
  return categoryListReply(ctx.config.brandName, pendingCategories, cart, opts.sameAgain ?? null, 0);
}

/** The cart on screen, with an optional one-line notice above it ("Removed X."). */
export function viewCartReply(cart: CartItem[], priorState: OrdersStateData, notice?: string): ActionResult {
  return actionResult(
    messages.cartSummaryMessage(cartToLineItems(cart), notice),
    {
      state: ORDER_STATE_AWAITING_CART_ACTION,
      data: {
        cart,
        pendingSelection: priorState.pendingSelection,
        listTitle: priorState.listTitle,
        tableLabel: priorState.tableLabel ?? null,
      },
    },
    cart.length > 0 ? CART_VIEW_BUTTONS : EMPTY_CART_BUTTONS,
  );
}

/** "Remove Items" tapped: the cart lines as a tap list (a row carries the product id), plus "Empty cart" and "Back". */
export function beginRemoveItemStep(cart: CartItem[], priorState: OrdersStateData, page = 0): ActionResult {
  if (cart.length === 0) return viewCartReply(cart, priorState);

  const extra: ChoiceRow[] = [
    { id: TAP_REMOVE_ALL, title: '🗑️ Empty cart' },
    { id: TAP_REMOVE_BACK, title: '◂ Back to cart' },
  ];
  const rows = pageRows(
    cart,
    page,
    extra.length,
    (item) => ({ id: `${TAP_REMOVE}${item.productId}`, title: `${item.quantity}x ${item.name}` }),
    TAP_MORE,
  );
  return listReply(messages.REMOVE_ITEM_LIST_BODY, 'Choose item', [{ title: 'Your cart', rows }, { title: 'More', rows: extra }], {
    state: ORDER_STATE_AWAITING_REMOVE_ITEM,
    data: {
      cart,
      pendingSelection: priorState.pendingSelection,
      listTitle: priorState.listTitle,
      tableLabel: priorState.tableLabel ?? null,
    },
  });
}
