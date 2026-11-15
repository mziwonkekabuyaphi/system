/**
 * lib/services/messages/orders.ts
 *
 * WhatsApp Concierge — Orders Messages (multi-tenant)
 * ------------------------------------------------------------------------
 * Every customer-facing string used by the Orders service.
 * Text and text-formatting helpers ONLY: no Supabase, no state machine.
 *
 * Multi-tenant notes:
 *  - No shop name, wallet name or payment options are hardcoded here. The
 *    payment buttons come from the tenant's settings (orders.tenant.ts), so
 *    these messages stay generic ("Wallet", "Card", "Pay at counter").
 *  - Category headings arrive already resolved (the tenant's own category
 *    label), so fullMenuMessage does no grouping of its own. The numbers it
 *    prints MUST match the order of pendingSelection built in
 *    orders.flow-selection.ts (buildFullMenuView).
 *  - Collection points are plain strings (the vendor's collection_point).
 * ------------------------------------------------------------------------
 */

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

export function formatCurrency(amount: number): string {
  return `R${Number(amount).toFixed(2).replace(/\.00$/, '')}`;
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Renders a positive integer as WhatsApp keycap emoji digits (1️⃣2️⃣3️⃣…). */
export function keycapNumber(n: number): string {
  return String(Math.max(0, Math.trunc(n)))
    .split('')
    .map((digit) => `${digit}\uFE0F\u20E3`)
    .join('');
}

/** How a paid order is described to the customer. */
export type OrderPaymentChoice = 'wallet' | 'card' | 'cash';

function paidLine(choice: OrderPaymentChoice): string {
  switch (choice) {
    case 'wallet':
      return '✅ Paid from your wallet';
    case 'card':
      return '✅ Paid by card';
    case 'cash':
    default:
      return '💵 Pay at the counter when you collect';
  }
}

// ============================================================================
// ORDER STATUS DISPLAY
// ============================================================================

const ORDER_STATUS_DISPLAY: Record<string, string> = {
  pending: "We've received your order and are confirming your payment.",
  scheduled: 'Your order is booked for the time you chose.',
  placed: 'Your order has been confirmed and sent to our team.',
  preparing: 'Your order is being prepared. 👨‍🍳',
  ready: 'Your order is ready for collection. 🎉',
  collected: 'Your order has been collected. Enjoy! 🥂',
  completed: 'Thank you for your order. We hope to see you again soon.',
  cancelled: 'This order has been cancelled.',
};

const ORDER_STATUS_PROGRESS: Record<string, string> = {
  pending: '⬜⬜⬜⬜ Confirming',
  scheduled: '⏰⬜⬜⬜ Scheduled',
  placed: '🟩⬜⬜⬜ Placed',
  preparing: '🟩🟩⬜⬜ Preparing',
  ready: '🟩🟩🟩⬜ Ready',
  collected: '🟩🟩🟩🟩 Collected',
  completed: '🟩🟩🟩🟩 Completed',
  cancelled: '⬛⬛⬛⬛ Cancelled',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_DISPLAY[status] ?? status;
}

export function orderStatusProgress(status: string): string {
  return ORDER_STATUS_PROGRESS[status] ?? '';
}

// ============================================================================
// SYSTEM / GENERIC
// ============================================================================

export const TECHNICAL_DIFFICULTY =
  "Sorry, we're experiencing technical difficulties. Please try again in a moment.";

export const UNEXPECTED_ERROR = 'Sorry, something went wrong on our end. Please try again in a moment.';

export const UNRECOGNIZED =
  "I didn't quite catch that. Reply *menu* to see what's available, or tell me what you'd like, e.g. \"Order two Castle Lite\".";

// ============================================================================
// MENU / CATALOGUE
// ============================================================================

export interface DisplayProduct {
  name: string;
  price: number;
  category?: string | null;
}

export function welcomeMessage(brandName: string): string {
  return `👋 Welcome to *${brandName}*!\n\nWhat would you like to do?`;
}

export function categoryMenuMessage(categories: Array<{ label: string; count: number }>): string {
  const lines = categories.map(
    (category, index) => `${keycapNumber(index + 1)} ${category.label} (${category.count})`,
  );
  return ['📋 *Menu*', ...lines, '', 'Reply with a number to see what is in that category.'].join('\n');
}

export function noProductsInCategory(title: string): string {
  return `Sorry, we don't have anything in "${title}" available right now. 🙁\n\nReply *menu* to see everything we have.`;
}

export function productListMessage(title: string, products: DisplayProduct[], startIndex: number = 1): string {
  const lines = products.map(
    (product, index) => `${keycapNumber(startIndex + index)} ${product.name} — ${formatCurrency(product.price)}`,
  );

  return [
    `🛒 *${title}*`,
    ...lines,
    '',
    'Reply with a number to add it to your cart, or *menu* to see other categories.',
  ].join('\n');
}

export const EMPTY_MENU = 'Sorry, our menu is empty right now — please check back shortly. 🙁';

/**
 * `category` is the tenant's category label (already grouped by the caller).
 * Numbering runs across all sections, in the order given, and must line up
 * with pendingSelection from buildFullMenuView.
 */
export function fullMenuMessage(productsByCategory: Array<{ category: string | null; products: DisplayProduct[] }>): string {
  let counter = 0;
  const sections = productsByCategory.map(({ category, products }) => {
    const heading = `🛒 *${category ?? 'Other'}*`;
    const lines = products.map((p) => {
      counter += 1;
      return `${keycapNumber(counter)} ${p.name} — ${formatCurrency(p.price)}`;
    });
    return [heading, ...lines].join('\n');
  });

  return [
    '📋 *Our Menu*',
    '',
    sections.join('\n\n'),
    '',
    'Reply with a number to add it straight to your cart — from any category, no need to open it first. Or reply with a category name (e.g. "beers") to browse just that section.',
  ].join('\n');
}

// ============================================================================
// VALIDATION
// ============================================================================

export const INVALID_QUANTITY = 'Please give me a valid quantity, e.g. "2".';

export const QUANTITY_TOO_HIGH = 'That quantity looks too high — please order 50 or fewer at a time.';

export const PRODUCT_NOT_FOUND = "Sorry, I couldn't find that product. Reply *menu* to see what's available.";

export function productUnavailable(name: string): string {
  return `Sorry, *${name}* isn't available right now.`;
}

export function productOutOfStock(name: string): string {
  return `Sorry, *${name}* is out of stock right now. 🙁`;
}

export function productLowStock(name: string, available: number): string {
  return `We only have ${available} of *${name}* left. Reply with a smaller quantity.`;
}

// ============================================================================
// SEARCH / PRICE CHECK
// ============================================================================

export function searchNotFound(term: string): string {
  return `Sorry, I couldn't find "${term}". Reply *menu* to see what's available.`;
}

export function priceCheckNotFound(term: string): string {
  return `Sorry, I couldn't find a product matching "${term}".`;
}

export function priceCheckResults(items: DisplayProduct[]): string {
  return items.map((p) => `${p.name} — ${formatCurrency(p.price)}`).join('\n');
}

export const DID_YOU_MEAN = 'Did you mean one of these?';

// ============================================================================
// CART
// ============================================================================

export interface CartLineItem {
  productName: string;
  quantity: number;
  unitPrice: number;
}

function cartLineText(item: CartLineItem): string {
  return `• ${pluralize(item.quantity, 'x')} ${item.productName} — ${formatCurrency(item.unitPrice * item.quantity)}`;
}

export function cartTotal(items: CartLineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export const EMPTY_CART = 'Your cart is empty. Reply *menu* to start adding items.';

export function addedToCartMessage(justAdded: CartLineItem, cart: CartLineItem[]): string {
  return [
    `✅ Added ${pluralize(justAdded.quantity, 'x')} ${justAdded.productName} to your cart.`,
    '',
    '*Your Cart*',
    ...cart.map(cartLineText),
    '',
    `Cart Total: *${formatCurrency(cartTotal(cart))}*`,
    '',
    "Tap *Continue Shopping* to add more, or *Checkout* when you're ready to pay.",
  ].join('\n');
}

export function cartSummaryMessage(cart: CartLineItem[], notice?: string): string {
  if (cart.length === 0) {
    return notice ? `${notice}\n\n${EMPTY_CART}` : EMPTY_CART;
  }
  return [
    ...(notice ? [notice, ''] : []),
    '🛒 *Your Cart*',
    ...cart.map(cartLineText),
    '',
    `Total: *${formatCurrency(cartTotal(cart))}*`,
    '',
    'Tap *Checkout* to pay, or *Continue Shopping* to add more.',
  ].join('\n');
}

/** Numbered list of cart lines so the customer can pick one to remove. */
export function removeItemPrompt(cart: CartLineItem[]): string {
  return [
    '🗑️ *Remove an item*',
    ...cart.map((item, index) => `${keycapNumber(index + 1)} ${pluralize(item.quantity, 'x')} ${item.productName}`),
    '',
    'Reply with the number of the item you want to remove.',
  ].join('\n');
}

/**
 * Payment-method step. The options themselves are shown as buttons built from
 * the tenant's allowed payment methods, so the text does not name them.
 */
export function cartPaymentMethodPrompt(cart: CartLineItem[], scheduledLabel?: string | null): string {
  return [
    '*Checkout*',
    ...cart.map(cartLineText),
    '',
    `Total: *${formatCurrency(cartTotal(cart))}*`,
    scheduledLabel ? scheduleConfirmedLabel(scheduledLabel) : undefined,
    '',
    'How would you like to pay? Pick an option below.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export interface CartOrderItemSummary {
  productName: string;
  quantity: number;
  unitPrice: number;
}

/** One order (single vendor). `collectionPoints` are the vendor's collection_point strings. */
export function cartOrderCreatedMessage(
  orderNumber: string,
  items: CartOrderItemSummary[],
  totalAmount: number,
  paymentChoice: OrderPaymentChoice,
  collectionPoints: string[],
  scheduledLabel?: string | null,
): string {
  const itemLines = items.map(
    (item) => `• ${pluralize(item.quantity, 'x')} ${item.productName} — ${formatCurrency(item.unitPrice * item.quantity)}`,
  );

  const unique = Array.from(new Set(collectionPoints.filter(Boolean)));
  const collectionLines =
    unique.length <= 1
      ? [`📍 Collect at: *${unique[0] ?? 'the counter'}*`]
      : ['📍 Collect at:', ...unique.map((point) => `   • *${point}*`)];

  return [
    `🎉 Order confirmed! *#${orderNumber}*`,
    '',
    ...itemLines,
    `Total: *${formatCurrency(totalAmount)}*`,
    paidLine(paymentChoice),
    scheduledLabel ? scheduleConfirmedLabel(scheduledLabel) : undefined,
    '',
    ...collectionLines,
    "We don't offer delivery — all orders are collected in person.",
    '',
    scheduledLabel
      ? `We'll start preparing it closer to ${scheduledLabel}. Reply *track my order* anytime for updates.`
      : "We'll message you when it's ready. Reply *track my order* anytime for updates.",
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export interface CartOrderGroupSummary {
  orderNumber: string;
  items: CartOrderItemSummary[];
  subtotal: number;
  collectionPoint: string;
}

/** A cart that spans several vendors becomes several orders: one block per order. */
export function multiOrderCreatedMessage(
  groups: CartOrderGroupSummary[],
  totalAmount: number,
  paymentChoice: OrderPaymentChoice,
  scheduledLabel?: string | null,
): string {
  const orderBlocks = groups.map((group) => {
    const itemLines = group.items.map(
      (item) => `• ${pluralize(item.quantity, 'x')} ${item.productName} — ${formatCurrency(item.unitPrice * item.quantity)}`,
    );
    return [
      `*#${group.orderNumber}*`,
      ...itemLines,
      `Subtotal: ${formatCurrency(group.subtotal)}`,
      `📍 Collect at: *${group.collectionPoint || 'the counter'}*`,
    ].join('\n');
  });

  return [
    `🎉 Order confirmed! You have *${pluralize(groups.length, 'order')}* to collect:`,
    '',
    orderBlocks.join('\n\n'),
    '',
    `Grand Total: *${formatCurrency(totalAmount)}*`,
    paidLine(paymentChoice),
    scheduledLabel ? scheduleConfirmedLabel(scheduledLabel) : undefined,
    '',
    scheduledLabel
      ? `We'll start preparing it closer to ${scheduledLabel}. Reply *track my order* anytime for updates.`
      : "We'll message you when each is ready. Reply *track my order* anytime for updates.",
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

// ============================================================================
// QUANTITY / PAYMENT / CONFIRMATION PROMPTS
// ============================================================================

export function quantityPrompt(productName: string, unitPrice: number): string {
  return `How many *${productName}* would you like? (${formatCurrency(unitPrice)} each)`;
}

export const CONFIRM_YES_NO = 'Please tap *Yes* to confirm your order, or *No* to cancel it.';

export const ORDER_CONFIRMATION_DECLINED =
  "No problem, your order was not placed. Reply *menu* if you'd like to start again.";

// ============================================================================
// AGE VERIFICATION (legacy exports, kept in case registration code imports them;
// the live minimum age now comes from each shop's Order settings)
// ============================================================================

export const ALCOHOL_MINIMUM_AGE = 21;

export function ageVerificationPrompt(productName: string): string {
  return [
    `🔞 *${productName}* is an age-restricted product.`,
    `We only sell this to customers aged ${ALCOHOL_MINIMUM_AGE} and over.`,
    '',
    `Are you ${ALCOHOL_MINIMUM_AGE} years or older?`,
  ].join('\n');
}

export const AGE_VERIFICATION_REQUIRED = 'Please reply *Yes* if you are old enough, or *No* if you are not.';

export const AGE_RESTRICTION_DECLINED =
  "Sorry, we're unable to sell that product to you. Reply *menu* to see other options instead.";

// ============================================================================
// STATE-MACHINE VALIDATION PROMPTS
// ============================================================================

export function selectionOutOfRange(max: number): string {
  return `Please reply with a number between 1 and ${max}.`;
}

export const QUANTITY_REQUEST = 'Please reply with a quantity, e.g. "2".';

// ---- Tap-only screens (WhatsApp lists). The list IS the message: these are its body text. ----

/** Shown when the "3 or more" quantity button is tapped: the only time a customer types a number. */
export const QUANTITY_MORE_PROMPT = 'How many would you like? Type a number (3 to 50).';

/** Menu list body when the customer already has something in their cart. */
export function cartMenuBody(itemCount: number): string {
  return `🛒 You have ${itemCount} item${itemCount === 1 ? '' : 's'} in your cart.\n\nPick a category to add more, or open your cart 👇`;
}

export function productListBody(title: string): string {
  return `🛒 *${title}*\n\nTap an item to add it to your cart 👇`;
}

export const REMOVE_ITEM_LIST_BODY = '🗑️ *Remove an item*\n\nTap the item you want to remove 👇';

export const SCHEDULE_TIME_LIST_BODY = 'What time would you like to collect it? Pick a time below 👇';

export const PAYMENT_METHOD_REQUEST = 'Please choose how you would like to pay using one of the options below.';

// ============================================================================
// SCHEDULING
// ============================================================================

export const SCHEDULE_CHOICE_PROMPT = 'Would you like to collect this now, or schedule it for a later time today?';

export const SCHEDULE_TIME_REQUEST =
  'What time would you like to collect it? Reply with a time, e.g. "6pm" or "18:30".';

export const SCHEDULE_TIME_INVALID =
  'Sorry, I couldn\'t use that time. Please reply with something like "6pm" or "18:30" that falls within our opening hours today.';

export const SCHEDULE_TIME_ALREADY_PASSED =
  "That time's already passed for today — we can't schedule into tomorrow. Please pick a later time today, or reply *menu* to order for right now.";

export const SCHEDULE_TIME_TOO_SOON =
  "That time's too close to now — please pick a time a little further ahead.";

export const SCHEDULE_TIME_TOO_FAR =
  'We can only schedule a limited time ahead. Please pick an earlier time, or reply *menu* to order for right now.';

export const SCHEDULE_TIME_AFTER_CLOSING =
  "We're closed by then. Please pick an earlier time, or reply *menu* to order for right now.";

export function scheduleConfirmedLabel(label: string): string {
  return `⏰ Scheduled for *${label}*`;
}

export const MISSING_ORDER_DETAILS =
  "Something's missing from your order — let's start again. Reply *menu* to browse.";

// ============================================================================
// ORDER CREATION / PAYMENT OUTCOMES
// ============================================================================

export const ORDER_CREATION_FAILED = 'Sorry, something went wrong creating your order. Please try again in a moment.';

export function cartCheckoutLink(cart: CartLineItem[], total: number, checkoutUrl: string): string {
  return [
    ...cart.map(cartLineText),
    '',
    `Total: ${formatCurrency(total)}`,
    '',
    'Tap below to pay securely by card:',
    checkoutUrl,
    '',
    "We'll confirm your order the moment payment goes through.",
  ].join('\n');
}

export const CARD_CHECKOUT_FAILED =
  "Sorry, we couldn't start your card checkout. Please choose another payment option, or try *card* again.";

export const WALLET_NOT_LINKED =
  "We couldn't find a wallet linked to your account. Please choose another payment option.";

export function walletFailureMessage(reason?: string): string {
  switch (reason) {
    case 'insufficient_funds':
      return "Your wallet balance isn't enough to complete this purchase.";
    case 'wallet_not_found':
      return "We couldn't find a wallet for your account. Please choose another payment option.";
    case 'wallet_inactive':
      return 'Your wallet is currently inactive. Please contact staff for help, or choose another payment option.';
    default:
      return "We couldn't process your wallet payment right now. Please try another payment option.";
  }
}

// ============================================================================
// TRACKING / CANCEL / ACTIVE ORDERS / HISTORY / REPEAT
// ============================================================================

export const NO_ORDERS_YET = "You don't have any orders yet. Reply *menu* to get started!";

export const NO_ORDER_TO_CANCEL = "You don't have an order to cancel.";

export const CANCEL_GENERIC_FAILURE = 'Sorry, something went wrong cancelling your order. Please try again shortly.';

export const NO_ACTIVE_ORDERS = "You don't have any active orders right now.";

export const NO_ORDER_HISTORY = "You don't have any past orders yet.";

export const NO_COMPLETED_ORDER_TO_REPEAT = "You don't have a completed order to repeat yet.";

export const REPEAT_ITEMS_NOT_FOUND = "We couldn't find the items from your last order.";

export const REPEAT_PRODUCT_NOT_MATCHED = "We couldn't match your last order to a current product.";

export interface TrackingItem {
  quantity: number;
  productName: string | null;
}

export function trackingMessage(
  orderNumber: string,
  status: string,
  items: TrackingItem[],
  totalAmount: number,
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded' | 'refund_pending',
  collectionPoint: string,
): string {
  const itemLines = items.map((item) => `• ${pluralize(item.quantity, 'x')} ${item.productName ?? 'item'}`);
  const paymentText =
    paymentStatus === 'paid'
      ? '✅ Paid'
      : paymentStatus === 'failed'
        ? '❌ Failed'
        : paymentStatus === 'refunded'
          ? '↩️ Refunded'
          : paymentStatus === 'refund_pending'
            ? '↩️ Refund on its way'
            : '⏳ Pending';
  return [
    `📦 Order *#${orderNumber}*`,
    orderStatusProgress(status),
    '',
    orderStatusLabel(status),
    '',
    ...itemLines,
    '',
    `Total: ${formatCurrency(totalAmount)}`,
    `Payment: ${paymentText}`,
    `📍 Collect at: *${collectionPoint}*`,
  ].join('\n');
}

export function cancelNotAllowed(orderNumber: string, status: string): string {
  return `Order *#${orderNumber}* can no longer be cancelled (${orderStatusLabel(status).toLowerCase()}).`;
}

export function orderCancelledMessage(orderNumber: string, wasRefunded: boolean): string {
  return `Order *#${orderNumber}* has been cancelled.${wasRefunded ? ' Your payment will be refunded.' : ''}`;
}

export interface ActiveOrderSummary {
  orderNumber: string;
  status: string;
  totalAmount: number;
}

export function activeOrdersMessage(orders: ActiveOrderSummary[]): string {
  const lines = orders.map(
    (order) => `• *#${order.orderNumber}* — ${orderStatusLabel(order.status)} (${formatCurrency(order.totalAmount)})`,
  );
  return ['📋 *Your Active Orders*', '', ...lines].join('\n');
}

export interface OrderHistoryEntry {
  orderNumber: string;
  orderDate: string;
  totalAmount: number;
  status: string;
}

export function orderHistoryMessage(orders: OrderHistoryEntry[]): string {
  const lines = orders.map(
    (order) =>
      `• *#${order.orderNumber}* — ${new Date(order.orderDate).toLocaleDateString('en-ZA')} — ${formatCurrency(order.totalAmount)} (${order.status})`,
  );
  return ['🧾 *Your Recent Orders*', '', ...lines, '', 'Reply *repeat my last order* to reorder.'].join('\n');
}
