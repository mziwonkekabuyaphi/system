// File: lib/services/orders/orders.flow-selection.ts
import type { ActionResult } from '@/lib/types/action';
import * as messages from '@/lib/services/messages/orders';
import type { CartItem, OrdersStateData, PendingCategory, PendingSelectionItem, ProductCategory, ProductRow } from './orders.types';
import { localParts, paymentButtons, paymentChoiceLabel, type TenantContext } from './orders.tenant';
import { listReply, pageRows } from '@/lib/services/shared/tap-lists';
import type { ChoiceRow, ChoiceSection } from '@/lib/whatsapp/utils/choice-list';
import { getWalletBalanceForOrder, type OrderingCustomer } from './orders.db';
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
import {
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
  QUANTITY_BUTTONS,
} from './orders.types';
import { actionResult, addItemToCart, cartToLineItems, cartTotal, categoryByKey, getCart, parseScheduleTime } from './orders.helpers';

// ============================================================================
// PRODUCT SELECTION & CART BUILDING — STEP HANDLERS
// ============================================================================

/** Most products kept in the saved state for one list (a menu list pages through them, nine at a time). */
const PRODUCT_LIST_MAX = 200;

function cartItemCount(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

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
        listTitle: priorState.listTitle,
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
    pendingCategories: shown.map((g) => ({ label: g.label, categoryIds: g.ids, key: g.key, count: g.count })),
  };
}

/**
 * The menu as ONE tap list: each category with how many items it has, then a "Quick" section: "Same as last time"
 * (a returning customer with an empty cart), "Full menu", and "View cart" (cart has items) or "Track my order".
 * This replaces both the welcome screen and the numbered category text. Pages with "More ▸" from state.
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

/** Shows the menu list (state: tap a category), carrying the cart through. `sameAgain` = the "Same as last time" summary, if any. */
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

// ============================================================================
// CHECKOUT — ONE list for "how do you want to pay?" and "collect now or later?"
// ============================================================================

/**
 * Replaces the old two-step "Collect Now / Schedule Later" then payment buttons. One list: each payment method the
 * shop offers (the wallet row shows the live balance, so nobody picks it and then hits a "top up" detour), plus
 * "🕒 Collect later" when scheduling is on. After a time is picked this shows again WITHOUT the "later" row and with
 * the pick-up time in the text. Nothing is charged here: a tap on a method goes through finalizeOrderFromState.
 */
export async function beginCheckoutStep(
  ctx: TenantContext,
  customer: OrderingCustomer | null,
  cart: CartItem[],
  scheduledFor?: string | null,
): Promise<ActionResult> {
  const total = cartTotal(cart);

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
    return method === 'card' ? 'Pay securely online' : 'Pay when you collect';
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
  if (!scheduledFor && ctx.config.allowScheduling) {
    sections.push({ title: 'Or', rows: [{ id: TAP_LATER, title: '🕒 Collect later', description: 'Pick a time today' }] });
  }

  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;
  return listReply(messages.cartPaymentMethodPrompt(cartToLineItems(cart), scheduledLabel), 'Choose payment', sections, {
    state: ORDER_STATE_AWAITING_PAYMENT_METHOD,
    data: { cart, scheduledFor: scheduledFor ?? null },
  });
}

/**
 * The next valid pick-up times today, every 30 minutes. Each candidate goes through parseScheduleTime, so opening
 * hours, the minimum lead time and "today only" are exactly the rules a typed time already follows.
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
 * "🕒 Collect later" tapped: the next valid times as a tap list, plus "⌨️ Type a time" for anything else. With no
 * valid time left today (closed, or past the last slot) it falls back to the typed prompt, which explains why.
 */
export function beginScheduleTimeList(ctx: TenantContext, cart: CartItem[]): ActionResult {
  const slots = nextScheduleSlots(ctx, 8);
  if (slots.length === 0) return beginScheduleTimeStep(cart);

  const rows: ChoiceRow[] = [
    ...slots.map((slot, i) => ({ id: `${TAP_TIME}${i}`, title: slot.label })),
    { id: TAP_TIME_TYPE, title: '⌨️ Type a time' },
  ];
  return listReply(messages.SCHEDULE_TIME_LIST_BODY, 'Choose time', [{ title: 'Today', rows }], {
    state: ORDER_STATE_AWAITING_SCHEDULE_TIME,
    data: { cart, pendingTimes: slots },
  });
}
