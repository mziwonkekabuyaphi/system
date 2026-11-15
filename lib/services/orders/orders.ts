/**
 * lib/services/orders/orders.ts
 *
 * WhatsApp Concierge — Orders Service (facade, multi-tenant)
 * ------------------------------------------------------------------------
 * Thin entry point over the orders.* module family:
 *   - orders.types.ts          DB-aligned types, state shape, constants (leaf)
 *   - orders.helpers.ts        pure logic: cart, catalogue helpers, NL parsing, validation
 *   - orders.db.ts             all Supabase access
 *   - orders.flow-selection.ts product selection & cart-building step handlers
 *   - orders.flow-checkout.ts  payment/confirmation/checkout/fulfillment
 *   - orders.management.ts    track/cancel/repeat/history/active-orders handlers
 *   - orders.ts (this file)   fresh-request routing, state dispatch, public contract
 *
 * PUBLIC SURFACE (matches the shared service-object contract used by
 * action-router.ts — same shape as walletService/ticketsService/eventsService):
 *
 *   ordersService.intent === "order"
 *   ordersService.handleOrder(intent, message, tenant: TenantContext | null): Promise<ActionResult>
 *   ordersService.handleState(state, message, tenant: TenantContext | null): Promise<ActionResult | null>
 *
 * MULTI-TENANCY: the router resolves the tenant ONCE from the WhatsApp
 * phone_number_id (resolveTenantIdByPhoneNumberId + loadTenantContext) and
 * passes the TenantContext in. A null context (unknown/inactive tenant, or the
 * `orders` module switched off) yields ORDERING_NOT_AVAILABLE.
 *
 * This service is a leaf in the dependency graph — it never routes, never
 * calls other services' handlers, and never reads/writes conversation state
 * directly. Action Router owns dispatch; it owns state persistence via the
 * `nextState` field each method returns. `handleOrder` only ever runs for a
 * brand-new order request (no in-flight state); `handleState` only ever runs
 * to continue an `order_*` state Action Router has already loaded and handed
 * to us — it must never re-read conversation_states itself.
 *
 * This is also the ONLY file in the family that mediates between the
 * selection side (orders.flow-selection.ts) and the checkout side
 * (orders.flow-checkout.ts) — those two never import from each other, which
 * is what keeps this split free of the circular-import wrinkle tickets.ts's
 * flow-selection/flow-checkout split has (startPurchaseFlow /
 * proceedToTicketTypeSelection). Every cross-flow transition happens here,
 * in continueOrdersFlow / handleFreshOrderRequest, not inside either flow file.
 * ------------------------------------------------------------------------
 */

import { logger } from '@/lib/whatsapp/utils/logger';
import * as messages from '@/lib/services/messages/orders';
import type { RoutedIntent } from '@/lib/whatsapp/intent-router';
import type { IncomingMessage } from '@/lib/whatsapp/parse-webhook';
import type { ActionResult } from '@/lib/types/action';
import type { ConversationState } from '@/lib/services/state';

import type { CartItem, OrdersStateData, OrdersStateName, ProductRow } from './orders.types';
import { ORDERING_NOT_AVAILABLE, paymentButtons, type TenantContext } from './orders.tenant';
import {
  ORDER_STATE_AWAITING_CART_ACTION,
  ORDER_STATE_AWAITING_CATEGORY,
  ORDER_STATE_AWAITING_CONFIRMATION,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_QUANTITY,
  ORDER_STATE_AWAITING_REMOVE_ITEM,
  ORDER_STATE_AWAITING_SCHEDULE_CHOICE,
  ORDER_STATE_AWAITING_SCHEDULE_TIME,
  ORDER_STATE_AWAITING_SELECTION,
  ORDER_STATE_AWAITING_TOPUP_OR_CARD,
  ORDER_STATE_AWAITING_WELCOME,
  CONFIRM_YES_NO_BUTTONS,
  SCHEDULE_CHOICE_BUTTONS,
} from './orders.types';

import {
  actionResult,
  addItemToCart,
  extractQuantity,
  getCart,
  type ParsedOrderMessage,
  parseOrderMessage,
  parseScheduleTime,
  readStateData,
  validateProductAvailability,
  validateQuantity,
} from './orders.helpers';

import {
  activateDueScheduledOrders,
  ensureCustomerForPhone,
  getFullMenu,
  getProductById,
  getProductsByCategoryIds,
  normalizePhone,
  searchProducts,
  type OrderingCustomer,
} from './orders.db';

import {
  addToCartAndReview,
  beginCartPaymentStep,
  beginProductSelectionReply,
  beginQuantityStep,
  beginScheduleChoiceStep,
  beginScheduleTimeStep,
  beginCategoryReply,
  beginRemoveItemStep,
  beginWelcomeReply,
  buildFullMenuView,
  viewCartReply,
} from './orders.flow-selection';

import {
  beginOrderConfirmation,
  finalizeOrderFromState,
  handleTopupOrCardSelection,
} from './orders.flow-checkout';

import {
  handleActiveOrders,
  handleCancelOrder,
  handleOrderHistory,
  handleRepeatOrder,
  handleTrackOrder,
} from './orders.management';

import { trySmartOrderEntry } from './orders.smart-entry';

// Re-export the two functions payment-router.ts calls as webhook callbacks,
// plus the state-payload type other services (wallet.ts's resume handoff)
// need to reference — same public shape the monolithic orders.ts exposed.
export { fulfillOrderAfterPayment, fulfillOrderPurchaseAfterTopup } from './orders.flow-checkout';
export type { OrdersStateData } from './orders.types';
export { invalidateTenantCache, loadTenantContext, resolveTenantIdByPhoneNumberId } from './orders.tenant';
export type { TenantContext } from './orders.tenant';

// ============================================================================
// FRESH-REQUEST HANDLING (no in-flight state — shared by handleOrder and by
// handleState's "browse something else mid-selection" escape hatch below)
// ============================================================================

/** Category list first — the customer opens one category (or asks for "all") instead of facing every product. */
async function showCategories(ctx: TenantContext, cart: CartItem[]): Promise<ActionResult> {
  const products = await getFullMenu(ctx);
  if (products.length === 0) {
    return actionResult(messages.EMPTY_MENU);
  }
  return beginCategoryReply(ctx, products, cart);
}

/** Every product on one numbered list (reply "all" on the category screen). */
async function showFullMenu(ctx: TenantContext, cart: CartItem[]): Promise<ActionResult> {
  const products = await getFullMenu(ctx);
  if (products.length === 0) {
    return actionResult(messages.EMPTY_MENU);
  }
  const { text, pendingSelection } = buildFullMenuView(ctx, products);
  return actionResult(text, { state: ORDER_STATE_AWAITING_SELECTION, data: { pendingSelection, cart } });
}

async function handleFreshOrderRequest(
  ctx: TenantContext,
  phone: string,
  parsed: ParsedOrderMessage,
  existingCart: CartItem[] = [],
): Promise<ActionResult> {
  // --- always-available commands -------------------------------------------------------
  if (parsed.intent === 'track_order') return handleTrackOrder(ctx, phone);
  if (parsed.intent === 'cancel_order') return handleCancelOrder(ctx, phone);
  if (parsed.intent === 'active_orders') return handleActiveOrders(ctx, phone);
  if (parsed.intent === 'order_history') return handleOrderHistory(ctx, phone);
  if (parsed.intent === 'repeat_order') return handleRepeatOrder(ctx, phone, existingCart);

  if (parsed.intent === 'price_check' && parsed.searchTerm) {
    const results = await searchProducts(ctx, parsed.searchTerm);
    if (results.length === 0) {
      return actionResult(messages.priceCheckNotFound(parsed.searchTerm));
    }
    return actionResult(messages.priceCheckResults(results.slice(0, 5)));
  }

  // --- fresh conversation entry points -------------------------------------------------------
  if (parsed.intent === 'show_menu') {
    return showCategories(ctx, existingCart);
  }

  if (parsed.intent === 'show_category' && parsed.category) {
    // parsed.category is the whole group the customer's word resolved to (e.g.
    // "cider" and "beer" both resolve to the same Beer & Cider group), taken
    // from this tenant's product_categories.
    const { label, categories } = parsed.category;
    const products = await getProductsByCategoryIds(ctx, categories.map((c) => c.id));
    return beginProductSelectionReply(label, categories[0].key, products, existingCart);
  }

  if (parsed.intent === 'search' && parsed.searchTerm) {
    const products = await searchProducts(ctx, parsed.searchTerm);
    return beginProductSelectionReply(`Results for "${parsed.searchTerm}"`, undefined, products, existingCart);
  }

  if (parsed.intent === 'order_shortcut' && parsed.productPhrase) {
    const products = await searchProducts(ctx, parsed.productPhrase);

    if (products.length === 0) {
      return actionResult(messages.searchNotFound(parsed.productPhrase));
    }

    if (products.length > 1) {
      return beginProductSelectionReply(messages.DID_YOU_MEAN, undefined, products, existingCart);
    }

    const product = products[0];
    const quantity = parsed.quantity ?? 1;
    const quantityCheck = validateQuantity(quantity);
    if (!quantityCheck.valid) {
      return actionResult(quantityCheck.errorReply!);
    }

    const availability = validateProductAvailability(product, quantity);
    if (!availability.valid) {
      return actionResult(availability.errorReply!);
    }

    const stateForNextStep: OrdersStateData = {
      selectedProductId: product.id,
      selectedProductName: product.name,
      selectedUnitPrice: Number(product.price),
      selectedProductCategory: product.category,
      quantity,
      tableLabel: parsed.tableLabel ?? null,
      cart: existingCart,
      paymentChoice: parsed.paymentChoice,
    };

    // Age verification used to detour through here for alcohol — now
    // handled once at registration instead (see registration.ts), so this
    // just carries straight on to the smart one-shot / ordinary add-to-cart
    // path below.

    // Smart one-shot: "place two beers of Castle pay with card" already
    // named a payment method in the same message — skip the usual "add
    // another item, or checkout?" prompt and go straight to ONE
    // confirmation for the whole order. Nothing is charged here —
    // finalizeOrderFromState only runs once the customer replies to
    // confirm, exactly like every other payment path in this file.
    if (parsed.paymentChoice) {
      const cart = addItemToCart(existingCart, {
        productId: product.id,
        name: product.name,
        unitPrice: Number(product.price),
        quantity,
        category: product.category,
      });
      return beginOrderConfirmation(ctx, cart, parsed.paymentChoice, parsed.tableLabel ?? null);
    }

    // NOTE: this now adds straight to the cart and shows the "add another
    // item, or checkout?" prompt, rather than jumping to
    // ORDER_STATE_AWAITING_PAYMENT_METHOD for just this one item — a
    // shortcut order ("order two Hunters") is just a faster way to add an
    // item, not a commitment to check out immediately.
    return addToCartAndReview(product.id, product.name, Number(product.price), product.category, quantity, stateForNextStep);
  }

  return actionResult(messages.UNRECOGNIZED);
}

// ============================================================================
// STATE MACHINE CONTINUATION
// ============================================================================

/**
 * Intents that must always be honoured immediately, no matter what step of
 * the order flow the customer is currently on. Without this, a customer who
 * types "track my order" while an order_awaiting_confirmation (or any other)
 * state is still lingering — e.g. right after finishing a purchase — gets
 * dragged back into that stale step instead of getting their tracking info.
 * Worse, if they then reply "yes" (a perfectly normal thing to say), the
 * state machine was replaying it as a *confirmation of the old pending
 * order*, silently creating a second, duplicate order with a new order
 * number. Routing these intents through handleFreshOrderRequest first fixes
 * both problems: the customer gets the right reply, and the stale state is
 * discarded rather than reused. The customer's in-progress cart (if any) is
 * carried through rather than discarded, since none of these intents are a
 * reason to lose items they've already added.
 */
const GLOBAL_ORDER_INTENTS: ReadonlySet<ParsedOrderMessage['intent']> = new Set([
  'track_order',
  'cancel_order',
  'active_orders',
  'order_history',
  'repeat_order',
]);

async function continueOrdersFlow(
  ctx: TenantContext,
  phone: string,
  customer: OrderingCustomer,
  stateName: OrdersStateName,
  stateData: OrdersStateData,
  parsed: ParsedOrderMessage,
  rawMessage: string,
): Promise<ActionResult> {
  if (GLOBAL_ORDER_INTENTS.has(parsed.intent)) {
    return handleFreshOrderRequest(ctx, phone, parsed, getCart(stateData));
  }

  switch (stateName) {
    case ORDER_STATE_AWAITING_WELCOME: {
      const typed = rawMessage.trim().toLowerCase();
      if (/\b(order now|order|start|menu|browse|shop)\b/.test(typed) && !/\b(track|cancel|history)\b/.test(typed)) {
        return showCategories(ctx, getCart(stateData));
      }
      if (/\bcart\b/.test(typed)) {
        return viewCartReply(getCart(stateData), stateData);
      }
      return handleFreshOrderRequest(ctx, phone, parsed, getCart(stateData));
    }

    case ORDER_STATE_AWAITING_CATEGORY: {
      const cart = getCart(stateData);
      const typed = rawMessage.trim().toLowerCase();

      let categoryIndex: number | null = null;
      if (parsed.intent === 'select_number' && parsed.selectionNumber) {
        categoryIndex = parsed.selectionNumber - 1;
      } else if (/^\d{1,2}$/.test(typed)) {
        categoryIndex = parseInt(typed, 10) - 1;
      }

      if (categoryIndex !== null) {
        const category = stateData.pendingCategories?.[categoryIndex];
        if (!category) {
          return actionResult(
            messages.selectionOutOfRange(stateData.pendingCategories?.length ?? 0),
            { state: ORDER_STATE_AWAITING_CATEGORY, data: stateData },
          );
        }
        const products = await getProductsByCategoryIds(ctx, category.categoryIds);
        return beginProductSelectionReply(category.label, category.key, products, cart);
      }

      if (/^(all|show all|full menu|the full menu|everything|whole menu)[.!]*$/.test(typed)) {
        return showFullMenu(ctx, cart);
      }
      if (cart.length > 0 && /\b(checkout|pay now)\b/.test(typed)) {
        return beginScheduleChoiceStep(ctx, cart);
      }
      if (/\bcart\b/.test(typed)) {
        return viewCartReply(cart, stateData);
      }
      return handleFreshOrderRequest(ctx, phone, parsed, cart);
    }

    case ORDER_STATE_AWAITING_REMOVE_ITEM: {
      const cart = getCart(stateData);
      const typed = rawMessage.trim().toLowerCase();

      if (/^(back|cancel|keep|no|done|view cart)[.!]*$/.test(typed)) {
        return viewCartReply(cart, stateData);
      }
      if (/^(all|clear|everything|clear cart|empty|empty cart)[.!]*$/.test(typed)) {
        return viewCartReply([], stateData, '🗑️ Your cart has been emptied.');
      }
      if (/^\d{1,2}$/.test(typed)) {
        const index = parseInt(typed, 10) - 1;
        const removed = cart[index];
        if (removed) {
          return viewCartReply(cart.filter((_, i) => i !== index), stateData, `🗑️ Removed ${removed.name}.`);
        }
      }
      return beginRemoveItemStep(cart, stateData);
    }

    case ORDER_STATE_AWAITING_SELECTION: {
      let selectedIndex: number | null = null;

      if (parsed.intent === 'select_number' && parsed.selectionNumber) {
        selectedIndex = parsed.selectionNumber - 1;
      } else {
        const bareNumberMatch = rawMessage.trim().match(/^\d{1,2}$/);
        if (bareNumberMatch) selectedIndex = parseInt(bareNumberMatch[0], 10) - 1;
      }

      // Allow browsing a different category/menu/search mid-flow without getting stuck.
      if (selectedIndex === null) {
        return handleFreshOrderRequest(ctx, phone, parsed, getCart(stateData));
      }

      const selection = stateData.pendingSelection?.[selectedIndex];
      if (!selection) {
        return actionResult(
          messages.selectionOutOfRange(stateData.pendingSelection?.length ?? 0),
          { state: ORDER_STATE_AWAITING_SELECTION, data: stateData },
        );
      }

      return beginQuantityStep(
        selection.productId,
        selection.name,
        selection.price,
        selection.category,
        stateData.tableLabel ?? null,
        getCart(stateData),
        stateData.pendingSelection,
      );
    }

    case ORDER_STATE_AWAITING_QUANTITY: {
      const quantity = parsed.intent === 'quantity' ? parsed.quantity! : extractQuantity(rawMessage);
      if (quantity === null) {
        return actionResult(messages.QUANTITY_REQUEST, { state: ORDER_STATE_AWAITING_QUANTITY, data: stateData });
      }

      const quantityCheck = validateQuantity(quantity);
      if (!quantityCheck.valid) {
        return actionResult(quantityCheck.errorReply!, { state: ORDER_STATE_AWAITING_QUANTITY, data: stateData });
      }

      let selectedProduct: ProductRow | null = null;
      if (stateData.selectedProductId) {
        selectedProduct = await getProductById(ctx, stateData.selectedProductId);
        const availability = validateProductAvailability(selectedProduct, quantity);
        if (!availability.valid) {
          return actionResult(availability.errorReply!, { state: ORDER_STATE_AWAITING_QUANTITY, data: stateData });
        }
      }

      const stateWithQuantity: OrdersStateData = { ...stateData, quantity };

      if (!stateData.selectedProductId || !stateData.selectedProductName || stateData.selectedUnitPrice === undefined) {
        return actionResult(messages.MISSING_ORDER_DETAILS);
      }

      return addToCartAndReview(
        stateData.selectedProductId,
        stateData.selectedProductName,
        stateData.selectedUnitPrice,
        stateData.selectedProductCategory ?? selectedProduct?.category ?? null,
        quantity,
        stateWithQuantity,
      );
    }

    case ORDER_STATE_AWAITING_CART_ACTION: {
      const cart = getCart(stateData);
      const normalized = rawMessage.trim().toLowerCase();

      if (/\b(checkout|pay now|done|finish(ed)?)\b/i.test(normalized)) {
        if (cart.length === 0) {
          return actionResult(messages.EMPTY_CART);
        }
        return beginScheduleChoiceStep(ctx, cart);
      }

      if (/\bremove\b/i.test(normalized) && !/\d/.test(normalized)) {
        return beginRemoveItemStep(cart, stateData);
      }

      if (/\bcart\b/i.test(normalized)) {
        return viewCartReply(cart, stateData);
      }

      if (/\b(continue shopping|add (more|another)|keep shopping)\b/i.test(normalized)) {
        return showCategories(ctx, cart);
      }

      // A bare number against the list last shown to this customer — add
      // straight to the cart without reopening a category or re-requesting
      // the menu. This is what makes "any product, any number, any time"
      // possible instead of only right after a list is first shown.
      let selectedIndex: number | null = null;
      if (parsed.intent === 'select_number' && parsed.selectionNumber) {
        selectedIndex = parsed.selectionNumber - 1;
      }
      if (selectedIndex !== null && stateData.pendingSelection?.[selectedIndex]) {
        const selection = stateData.pendingSelection[selectedIndex];
        return beginQuantityStep(
          selection.productId,
          selection.name,
          selection.price,
          selection.category,
          stateData.tableLabel ?? null,
          cart,
          stateData.pendingSelection,
        );
      }

      // Anything else ("menu", a category name, a search term, a fresh
      // "order two X") — treat as a new browse/order request, cart carried through.
      return handleFreshOrderRequest(ctx, phone, parsed, cart);
    }

    case ORDER_STATE_AWAITING_SCHEDULE_CHOICE: {
      const cart = getCart(stateData);
      const normalized = rawMessage.trim().toLowerCase();

      if (/\b(collect now|now|asap)\b/i.test(normalized)) {
        return beginCartPaymentStep(ctx, cart, null);
      }
      if (/\b(schedule|later|book)\b/i.test(normalized)) {
        return beginScheduleTimeStep(cart);
      }

      return actionResult(
        messages.SCHEDULE_CHOICE_PROMPT,
        { state: ORDER_STATE_AWAITING_SCHEDULE_CHOICE, data: stateData },
        SCHEDULE_CHOICE_BUTTONS,
      );
    }

    case ORDER_STATE_AWAITING_SCHEDULE_TIME: {
      const cart = getCart(stateData);
      const parsedTime = parseScheduleTime(rawMessage, ctx);

      if (!parsedTime.valid) {
        return actionResult(
          parsedTime.errorReply,
          { state: ORDER_STATE_AWAITING_SCHEDULE_TIME, data: stateData },
        );
      }

      return beginCartPaymentStep(ctx, cart, parsedTime.iso);
    }

    case ORDER_STATE_AWAITING_PAYMENT_METHOD: {
      if (parsed.intent !== 'payment_method' || !parsed.paymentChoice) {
        return actionResult(
          messages.PAYMENT_METHOD_REQUEST,
          { state: ORDER_STATE_AWAITING_PAYMENT_METHOD, data: stateData },
          paymentButtons(ctx.config),
        );
      }

      return finalizeOrderFromState(ctx, phone, customer, {
        ...stateData,
        paymentChoice: parsed.paymentChoice,
      });
    }

    case ORDER_STATE_AWAITING_CONFIRMATION: {
      if (parsed.intent === 'confirm_yes') {
        return finalizeOrderFromState(ctx, phone, customer, stateData);
      }
      if (parsed.intent === 'confirm_no') {
        return actionResult(messages.ORDER_CONFIRMATION_DECLINED);
      }
      return actionResult(
        messages.CONFIRM_YES_NO,
        { state: ORDER_STATE_AWAITING_CONFIRMATION, data: stateData },
        CONFIRM_YES_NO_BUTTONS,
      );
    }

    case ORDER_STATE_AWAITING_TOPUP_OR_CARD: {
      return handleTopupOrCardSelection(ctx, phone, customer, rawMessage, stateData);
    }

    default: {
      return handleFreshOrderRequest(ctx, phone, parsed, getCart(stateData));
    }
  }
}

// ============================================================================
// SERVICE OBJECT — conforms to the shared service-object contract used by
// action-router.ts (same shape as walletService/ticketsService/eventsService).
// ============================================================================

/**
 * Entry point for a brand-new "order" intent. Action Router only calls this
 * when there is no in-flight conversation state for this phone, so this
 * never inspects or branches on state — that is `handleState`'s job.
 */
async function handleOrder(
  _intent: RoutedIntent,
  message: IncomingMessage,
  ctx: TenantContext | null,
): Promise<ActionResult> {
  if (!ctx) return actionResult(ORDERING_NOT_AVAILABLE);

  const phone = normalizePhone(message.from);
  const rawMessage = message.contentSummary ?? message.text ?? '';

  try {
    // Opportunistic activation of scheduled orders whose time has passed.
    // A cron calling activate_due_scheduled_orders() is still required for
    // customers who never message again around their scheduled time.
    await activateDueScheduledOrders(ctx, phone);

    // Try the one-shot fast path first — e.g. "buy 1 castle lager and use my
    // wallet to pay" — before the sequential regex classifier, which can't
    // represent a product and a payment method in one sentence (see
    // orders.smart-entry.ts). Returns null (never throws) if the message
    // doesn't say enough to safely skip ahead.
    if (!message.interactiveId) {
      const smartResult = await trySmartOrderEntry(ctx, message, rawMessage);
      if (smartResult) {
        logger.info('[orders] handling fresh intent', { tenantId: ctx.tenantId, parsedIntent: 'smart_entry' });
        return smartResult;
      }
    }

    // A tap on a services-menu row reaches this entry point as a fresh "order"
    // intent whose rawMessage is the row TITLE, not something a customer typed.
    // handleOrder only runs with no in-flight order_* state, so any interactive
    // tap here can only be "open the menu".
    const parsed: ParsedOrderMessage = message.interactiveId
      ? { intent: 'show_menu' }
      : parseOrderMessage(rawMessage, ctx);
    logger.info('[orders] handling fresh intent', {
      tenantId: ctx.tenantId,
      parsedIntent: parsed.intent,
      viaInteractive: Boolean(message.interactiveId),
    });
    // A plain "menu" / "order" / menu-row tap with nothing in progress opens the branded welcome screen.
    if (parsed.intent === 'show_menu' && !parsed.tableLabel) {
      return beginWelcomeReply(ctx);
    }
    return await handleFreshOrderRequest(ctx, phone, parsed);
  } catch (unexpectedError) {
    logger.error('[orders] unexpected error in handleOrder', {
      tenantId: ctx.tenantId,
      error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
    });
    return actionResult(messages.UNEXPECTED_ERROR);
  }
}

const ORDER_STATE_NAMES: ReadonlySet<string> = new Set([
  ORDER_STATE_AWAITING_WELCOME,
  ORDER_STATE_AWAITING_CATEGORY,
  ORDER_STATE_AWAITING_REMOVE_ITEM,
  ORDER_STATE_AWAITING_SELECTION,
  ORDER_STATE_AWAITING_QUANTITY,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_CONFIRMATION,
  ORDER_STATE_AWAITING_TOPUP_OR_CARD,
  ORDER_STATE_AWAITING_CART_ACTION,
  ORDER_STATE_AWAITING_SCHEDULE_CHOICE,
  ORDER_STATE_AWAITING_SCHEDULE_TIME,
]);

/**
 * Entry point for an in-progress "order_*" conversation. Action Router has
 * already loaded the persisted state and decided this service owns it — this
 * must never re-read conversation_states itself. Returns null for any state
 * name this service doesn't own, deferring to the next registered service.
 */
async function handleState(
  state: ConversationState,
  message: IncomingMessage,
  ctx: TenantContext | null,
): Promise<ActionResult | null> {
  if (!ORDER_STATE_NAMES.has(state.state)) {
    return null;
  }
  if (!ctx) return actionResult(ORDERING_NOT_AVAILABLE);

  // Defence in depth: the router keys conversation_states by (tenant_id, phone).
  // If a state row ever carries a different tenant than the one this message
  // arrived on, refuse to continue it rather than cross tenants.
  const stateTenantId = (state as unknown as { tenant_id?: string }).tenant_id;
  if (stateTenantId && stateTenantId !== ctx.tenantId) {
    logger.error('[orders] conversation state tenant mismatch — refusing to continue', {
      stateTenantId,
      messageTenantId: ctx.tenantId,
    });
    return actionResult(messages.UNEXPECTED_ERROR);
  }

  const phone = normalizePhone(message.from);
  const rawMessage = message.contentSummary ?? message.text ?? '';

  try {
    await activateDueScheduledOrders(ctx, phone);

    const customer = await ensureCustomerForPhone(ctx, phone);
    if (!customer) {
      return actionResult(messages.TECHNICAL_DIFFICULTY);
    }

    const parsed = parseOrderMessage(rawMessage, ctx);
    const stateData = readStateData(state);

    logger.info('[orders] continuing state', { tenantId: ctx.tenantId, state: state.state, parsedIntent: parsed.intent });

    return await continueOrdersFlow(ctx, phone, customer, state.state as OrdersStateName, stateData, parsed, rawMessage);
  } catch (unexpectedError) {
    logger.error('[orders] unexpected error in handleState', {
      tenantId: ctx.tenantId,
      error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
    });
    return actionResult(messages.UNEXPECTED_ERROR);
  }
}

export const ordersService = {
  /** Matches this service to the `order` intent in action-router.ts. */
  intent: 'order' as const,

  handleOrder,
  handleState,
};
