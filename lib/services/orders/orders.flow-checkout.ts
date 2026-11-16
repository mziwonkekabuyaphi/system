// File: lib/services/orders/orders.flow-checkout.ts
// ============================================================================
// Payment / confirmation / fulfilment. Every path now goes through ONE atomic
// Postgres function (place_order) that validates against live rows, splits by
// vendor, inserts orders + items and (for wallet) debits the ledger in a single
// transaction. That removes the old debit-then-create-then-refund choreography:
// if anything fails, nothing was charged.
//
//   wallet : balance pre-check -> place_order (debit inside) | top-up/card screen
//   cash   : place_order (pay at counter; payment_status stays 'pending')
//   card   : place_order (orders 'pending') -> payment link from the shop's own card
//            provider (lib/payments/order-checkout.ts, same pipeline as tickets and
//            shisha) -> signed webhook -> settle.ts -> confirmOrderPaymentByAttempt
// ============================================================================

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/whatsapp/utils/logger';
import * as messages from '@/lib/services/messages/orders';
import type { ActionResult } from '@/lib/types/action';
import { PASSPORT_STATE_TOPUP_AMOUNT as WALLET_STATE_TOPUP_AMOUNT } from '@/lib/services/passport';
import type { CartItem, CustomerPaymentChoice, FulfilmentSelection, OrdersStateData } from './orders.types';
import { beginCheckoutStep, needsFulfilmentStep } from './orders.fulfilment';
import { deliveryFeeForSelection, fulfilmentSummary } from './orders.flow-selection';
import {
  CONFIRM_YES_NO_BUTTONS,
  ORDER_CONFIRMED_BUTTONS,
  ORDER_STATE_AWAITING_CONFIRMATION,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_TOPUP_OR_CARD,
} from './orders.types';
import {
  enabledFulfilments,
  loadTenantContext,
  paymentButtons,
  paymentChoiceLabel,
  topupOrCardButtons,
  type TenantContext,
} from './orders.tenant';
import { actionResult, cartTotal, getCart } from './orders.helpers';
import {
  confirmCardPaymentByAttempt,
  ensureCustomerForPhone,
  failCardPaymentByAttempt,
  getWalletBalanceForOrder,
  placeOrder,
  resolveCartItems,
  resolvedCartTotal,
  type OrderingCustomer,
  type PlaceOrderFailure,
  type PlacedOrder,
} from './orders.db';
import { notifyButtons, notifyText } from './orders.integrations';
import { getOrderCardOption, startOrderCardCheckout } from '@/lib/payments/order-checkout';

// ============================================================================
// SHARED REPLY BUILDERS
// ============================================================================

function placeFailureReply(failure: PlaceOrderFailure): string {
  switch (failure.outcome) {
    case 'product_unavailable':
      return messages.productUnavailable(failure.productName);
    case 'out_of_stock':
      return messages.productOutOfStock(failure.productName);
    case 'low_stock':
      return messages.productLowStock(failure.productName, failure.stock);
    case 'product_not_found':
      return messages.PRODUCT_NOT_FOUND;
    case 'wallet_not_found':
      return messages.WALLET_NOT_LINKED;
    case 'wallet_inactive':
      return messages.walletFailureMessage(undefined);
    case 'insufficient_funds':
      return messages.walletFailureMessage('insufficient_funds');
    case 'empty_cart':
      return messages.EMPTY_CART;
    case 'below_minimum_order':
      return messages.belowMinimumOrder(failure.minOrder, failure.subtotal, 'your area');
    case 'invalid_fulfilment':
    case 'fulfilment_not_allowed':
    case 'delivery_area_unavailable':
      return messages.FULFILMENT_NOT_AVAILABLE;
    case 'delivery_address_required':
      return messages.DELIVERY_ADDRESS_INVALID;
    case 'table_required':
      return messages.TABLE_REQUEST;
    default:
      return messages.ORDER_CREATION_FAILED;
  }
}

function buildPlacedReply(
  ctx: TenantContext,
  orders: PlacedOrder[],
  total: number,
  choice: CustomerPaymentChoice,
  scheduledFor: string | null,
): string {
  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;
  const first = orders[0];

  // Delivery and dine-in are read from the orders themselves (so the card webhook, which has no
  // conversation state, produces the same message).
  if (first.fulfilment === 'delivery') {
    return messages.deliveryOrderCreatedMessage({
      orders: orders.map((o) => ({ orderNumber: o.orderNumber, items: o.items, subtotal: o.total })),
      address: first.deliveryAddress ?? '',
      areaName: first.deliveryArea ?? '',
      deliveryFee: orders.reduce((sum, o) => sum + o.deliveryFee, 0),
      total,
      paymentChoice: choice,
      etaMinutes: ctx.config.deliveryTimeMinutes,
      scheduledLabel,
    });
  }
  if (first.fulfilment === 'dine_in') {
    return messages.dineInOrderCreatedMessage({
      orders: orders.map((o) => ({ orderNumber: o.orderNumber, items: o.items })),
      table: first.tableLabel ?? '',
      total,
      paymentChoice: choice,
      prepMinutes: ctx.config.prepTimeMinutes,
    });
  }

  const extraLines = [
    !scheduledLabel && ctx.config.prepTimeMinutes > 0 ? `⏱️ Ready in about ${ctx.config.prepTimeMinutes} minutes.` : undefined,
    ctx.config.collectionInstructions ? `ℹ️ ${ctx.config.collectionInstructions}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const offersDelivery = enabledFulfilments(ctx.config, ctx.catalog).includes('delivery');

  if (orders.length > 1) {
    return messages.multiOrderCreatedMessage(
      orders.map((o) => ({
        orderNumber: o.orderNumber,
        items: o.items,
        subtotal: o.total,
        collectionPoint: o.collectionPoint,
      })),
      total,
      choice,
      scheduledLabel,
      { extraLines },
    );
  }
  const order = orders[0];
  return messages.cartOrderCreatedMessage(order.orderNumber, order.items, total, choice, [order.collectionPoint], scheduledLabel, {
    offersDelivery,
    extraLines,
  });
}

function summaryLines(ctx: TenantContext, cart: CartItem[]): string[] {
  return cart.map(
    (item) => `${messages.pluralize(item.quantity, 'x')} ${item.name} — ${ctx.formatMoney(item.unitPrice * item.quantity)}`,
  );
}

// ============================================================================
// ORDER CONFIRMATION (smart one-shot path — customer named payment upfront)
// ============================================================================

/** One summary + explicit "yes" before anything is charged. Never charges itself. */
export function beginOrderConfirmation(
  ctx: TenantContext,
  cart: CartItem[],
  paymentChoice: CustomerPaymentChoice,
  tableLabel: string | null,
  scheduledFor?: string | null,
  fulfilment?: FulfilmentSelection | null,
): ActionResult {
  // Shops that offer delivery or dine-in need that answered before anything is charged.
  if (!fulfilment && needsFulfilmentStep(ctx)) {
    return beginCheckoutStep(ctx, cart, { tableLabel });
  }

  // A payment method this tenant doesn't offer falls back to the normal picker.
  if (!ctx.config.paymentMethods.includes(paymentChoice)) {
    return actionResult(
      messages.PAYMENT_METHOD_REQUEST,
      { state: ORDER_STATE_AWAITING_PAYMENT_METHOD, data: { cart, tableLabel, scheduledFor: scheduledFor ?? null, fulfilment: fulfilment ?? null } },
      paymentButtons(ctx.config),
    );
  }

  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;
  const summary = fulfilmentSummary(ctx, cart, fulfilment);
  const reply = [
    ...summaryLines(ctx, cart),
    ...(summary?.lines ?? []),
    `Total: ${ctx.formatMoney(summary ? summary.total : cartTotal(cart))}`,
    `Payment: ${paymentChoiceLabel(ctx.config, paymentChoice)}`,
    tableLabel && !fulfilment ? `Table: ${tableLabel}` : undefined,
    scheduledLabel ? messages.scheduleConfirmedLabel(scheduledLabel) : undefined,
    '',
    'Reply *yes* to confirm or *no* to cancel.',
  ]
    .filter(Boolean)
    .join('\n');

  return actionResult(
    reply,
    { state: ORDER_STATE_AWAITING_CONFIRMATION, data: { cart, paymentChoice, tableLabel, scheduledFor: scheduledFor ?? null, fulfilment: fulfilment ?? null } },
    CONFIRM_YES_NO_BUTTONS,
  );
}

export async function finalizeOrderFromState(
  ctx: TenantContext,
  phone: string,
  customer: OrderingCustomer,
  state: OrdersStateData,
): Promise<ActionResult> {
  const cart = getCart(state);
  if (cart.length === 0 || !state.paymentChoice) {
    return actionResult(messages.MISSING_ORDER_DETAILS);
  }

  if (!ctx.config.paymentMethods.includes(state.paymentChoice)) {
    return actionResult(
      messages.PAYMENT_METHOD_REQUEST,
      { state: ORDER_STATE_AWAITING_PAYMENT_METHOD, data: { ...state, paymentChoice: undefined } },
      paymentButtons(ctx.config),
    );
  }

  if (state.paymentChoice === 'card') {
    return beginCardOrderCheckout(ctx, phone, customer, cart, state.tableLabel ?? null, state.scheduledFor ?? null, state.fulfilment ?? null);
  }
  if (state.paymentChoice === 'wallet') {
    return beginWalletOrderPayment(ctx, customer, cart, state);
  }
  return placeAndReply(ctx, customer, cart, state, 'cash');
}

/** Cash (pay at counter): the order is placed immediately, payment stays pending until collection. */
async function placeAndReply(
  ctx: TenantContext,
  customer: OrderingCustomer,
  cart: CartItem[],
  state: OrdersStateData,
  choice: CustomerPaymentChoice,
): Promise<ActionResult> {
  const paymentAttemptId = state.paymentAttemptId ?? randomUUID();
  const result = await placeOrder(ctx, {
    customer,
    items: cart,
    paymentChoice: choice,
    paymentAttemptId,
    tableLabel: state.tableLabel ?? null,
    scheduledFor: state.scheduledFor ?? null,
    fulfilment: state.fulfilment ?? null,
  });

  if (result.outcome === 'ok' || result.outcome === 'already_placed') {
    return actionResult(
      buildPlacedReply(ctx, result.orders, result.total, choice, state.scheduledFor ?? null),
      null,
      ORDER_CONFIRMED_BUTTONS,
    );
  }
  return actionResult(placeFailureReply(result));
}

// ============================================================================
// CARD PATH
// ============================================================================

export async function beginCardOrderCheckout(
  ctx: TenantContext,
  phone: string,
  customer: OrderingCustomer,
  cart: CartItem[],
  tableLabel: string | null,
  scheduledFor: string | null = null,
  fulfilment: FulfilmentSelection | null = null,
): Promise<ActionResult> {
  const backToPaymentMethod = (reply: string): ActionResult =>
    actionResult(
      reply,
      { state: ORDER_STATE_AWAITING_PAYMENT_METHOD, data: { cart, tableLabel, scheduledFor, fulfilment } },
      paymentButtons(ctx.config),
    );

  if (!ctx.config.paymentMethods.includes('card')) {
    return backToPaymentMethod(messages.PAYMENT_METHOD_REQUEST);
  }
  if (cart.length === 0) {
    return actionResult(messages.EMPTY_CART);
  }

  // Can this shop take a card at all? Asked BEFORE any order exists, so a shop without a card provider never
  // ends up with pending orders that nobody can pay.
  const cardOption = await getOrderCardOption(ctx.db, ctx.tenantId);
  if (!cardOption.ok) {
    return backToPaymentMethod(`${cardOption.message}\n\n${messages.PAYMENT_METHOD_REQUEST}`);
  }

  // Never trust stock/availability/prices captured earlier in the conversation.
  const resolved = await resolveCartItems(ctx, cart);
  if ('errorReply' in resolved) {
    return actionResult(resolved.errorReply);
  }
  const total = resolvedCartTotal(resolved);
  if (total < cardOption.option.minAmount) {
    return backToPaymentMethod(
      `Card payments start at ${ctx.formatMoney(cardOption.option.minAmount)}. Please choose another payment option.`,
    );
  }
  const paymentAttemptId = randomUUID();

  // Orders are created up front as 'pending' (card stock is applied on confirmation, by the webhook).
  const placed = await placeOrder(ctx, {
    customer,
    items: cart,
    paymentChoice: 'card',
    paymentAttemptId,
    tableLabel,
    scheduledFor,
    fulfilment,
  });
  if (placed.outcome !== 'ok' && placed.outcome !== 'already_placed') {
    return actionResult(placeFailureReply(placed));
  }

  // The link comes from the shop's own card provider, through the same pipeline as tickets and shisha.
  // The amount is what place_order actually created (placed.total), which is what the webhook checks.
  const checkout = await startOrderCardCheckout({
    supabase: ctx.db,
    tenantId: ctx.tenantId,
    option: cardOption.option,
    paymentAttemptId,
    customerId: customer.id,
    amount: placed.total,
    orderIds: placed.orders.map((o) => o.id),
    orderNumbers: placed.orders.map((o) => o.orderNumber),
    brandName: ctx.config.brandName,
  });

  if (!checkout.ok) {
    logger.error('[orders] beginCardOrderCheckout failed', { tenantId: ctx.tenantId, paymentAttemptId, message: checkout.message });
    // No link exists for these pending orders: cancel them so they never linger.
    await failCardPaymentByAttempt(ctx.db, paymentAttemptId);
    return backToPaymentMethod(checkout.message || messages.CARD_CHECKOUT_FAILED);
  }

  logger.info('[orders] card checkout created', { tenantId: ctx.tenantId, paymentAttemptId, mode: checkout.mode });

  return actionResult(
    messages.cartCheckoutLink(
      resolved.map((item) => ({ productName: item.product.name, quantity: item.quantity, unitPrice: item.unitPrice })),
      placed.total,
      checkout.url,
      placed.orders.reduce((sum, o) => sum + o.deliveryFee, 0),
    ),
  );
}

/**
 * CARD WEBHOOK CALLBACK, called by lib/payments/settle.ts once the shop's card provider has confirmed payment
 * (signature, amount and currency already verified there). Keyed on the orders' payment attempt id; the tenant is
 * derived from the order rows. Moves the pending orders to placed/scheduled and tells the customer.
 *
 * Returns what happened so the caller can refund when the orders are no longer payable (cancelled meanwhile).
 * CONTRACT: idempotent (confirm_card_payment only flips orders that are still pending/pending, so a
 * redelivered webhook is a no-op). Throws nothing for "not payable"; throws only on OUR failures so the provider retries.
 */
export type OrderPaymentOutcome = 'confirmed' | 'already_confirmed' | 'not_payable';

export async function confirmOrderPaymentByAttempt(db: SupabaseClient, paymentAttemptId: string): Promise<OrderPaymentOutcome> {
  const result = await confirmCardPaymentByAttempt(db, paymentAttemptId);
  if (result.outcome === 'error') throw new Error('confirm_card_payment failed');
  if (result.outcome === 'not_found') {
    logger.error('[orders] card payment confirmed but no orders found for attempt', { paymentAttemptId });
    return 'not_payable';
  }

  // 'already_confirmed' also covers orders that were CANCELLED (expiry, customer cancel) before the money arrived:
  // only a 'paid' order counts as fulfilled, anything else must be refunded by the caller.
  if (result.outcome === 'already_confirmed') {
    const { data, error } = await db.from('orders').select('payment_status').eq('payment_attempt_id', paymentAttemptId);
    if (error) throw new Error(`order lookup failed: ${error.message}`);
    const allPaid = (data ?? []).length > 0 && (data ?? []).every((o: { payment_status: string }) => o.payment_status === 'paid');
    return allPaid ? 'already_confirmed' : 'not_payable';
  }

  // Best effort from here: the orders are already paid whether or not the message goes.
  try {
    const ctx = await loadTenantContext(db, result.tenantId);
    if (!ctx) {
      await notifyText(
        result.tenantId,
        result.phone,
        `Your payment was received. Order${result.orders.length > 1 ? 's' : ''} ${result.orders.map((o) => `#${o.orderNumber}`).join(', ')} confirmed.`,
      );
    } else {
      await notifyButtons(
        result.tenantId,
        result.phone,
        buildPlacedReply(ctx, result.orders, result.total, 'card', result.scheduledFor),
        ORDER_CONFIRMED_BUTTONS,
      );
    }
    logger.info('[orders] orders confirmed after card payment', {
      tenantId: result.tenantId,
      orderIds: result.orders.map((o) => o.id),
    });
  } catch (error) {
    logger.error('[orders] confirmation message failed (orders are already paid)', {
      paymentAttemptId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return 'confirmed';
}

// ============================================================================
// WALLET PATH
// ============================================================================

/**
 * In-chat wallet payment. Balance is pre-checked (read-only) against the whole
 * cart; if it looks sufficient, place_order debits under a row lock — if the
 * balance moved in between, it returns insufficient_funds and nothing happens.
 * Insufficient balance routes to top-up-or-card with the cart preserved.
 */
async function beginWalletOrderPayment(
  ctx: TenantContext,
  customer: OrderingCustomer,
  cart: CartItem[],
  state: OrdersStateData,
): Promise<ActionResult> {
  if (cart.length === 0) {
    return actionResult(messages.EMPTY_CART);
  }

  const resolved = await resolveCartItems(ctx, cart);
  if ('errorReply' in resolved) {
    return actionResult(resolved.errorReply);
  }

  const itemsTotal = resolvedCartTotal(resolved);
  // Items plus any delivery fee: what place_order will debit.
  const total = Number((itemsTotal + deliveryFeeForSelection(ctx, state.fulfilment, itemsTotal)).toFixed(2));
  const paymentAttemptId = state.paymentAttemptId ?? randomUUID();
  const stateWithAttempt: OrdersStateData = { ...state, cart, paymentAttemptId };

  const topupScreen = (shortfall: number | undefined): ActionResult =>
    actionResult(
      `${messages.walletFailureMessage('insufficient_funds')}\n\nTotal due: ${ctx.formatMoney(total)}`,
      { state: ORDER_STATE_AWAITING_TOPUP_OR_CARD, data: { ...stateWithAttempt, walletShortfall: shortfall } },
      topupOrCardButtons(ctx.config),
    );

  const balance = await getWalletBalanceForOrder(ctx, customer.id);
  if (balance === null || balance < total) {
    // Unresolvable balance fails toward the safe "can't confirm it covers this" path.
    return topupScreen(balance !== null ? Math.round((total - balance) * 100) / 100 : undefined);
  }

  const result = await placeOrder(ctx, {
    customer,
    items: cart,
    paymentChoice: 'wallet',
    paymentAttemptId,
    tableLabel: state.tableLabel ?? null,
    scheduledFor: state.scheduledFor ?? null,
    fulfilment: state.fulfilment ?? null,
  });

  switch (result.outcome) {
    case 'ok':
    case 'already_placed':
      return actionResult(
        buildPlacedReply(ctx, result.orders, result.total, 'wallet', state.scheduledFor ?? null),
        null,
        ORDER_CONFIRMED_BUTTONS,
      );
    case 'insufficient_funds':
      return topupScreen(Math.round((result.total - result.balance) * 100) / 100);
    case 'wallet_not_found':
    case 'wallet_inactive':
      return actionResult(placeFailureReply(result), null, paymentButtons(ctx.config));
    default:
      return actionResult(placeFailureReply(result));
  }
}

/**
 * WALLET TOP-UP RESUME — called by the payment router once a top-up whose
 * `resume` payload belongs to this service has credited the wallet. There is no
 * live chat turn, so the outcome is sent as a WhatsApp message from the tenant's
 * number. Idempotent on paymentAttemptId (place_order returns already_placed).
 * Nothing is ever charged on a failed attempt, so no refund branch is needed.
 */
export async function fulfillOrderPurchaseAfterTopup(resume: OrdersStateData, topupId: string): Promise<void> {
  const db = await getSupabaseServerClient();
  const tenantId = resume.tenantId;
  const phone = resume.senderPhone;
  const paymentAttemptId = resume.paymentAttemptId;
  const cart = resume.cart ?? [];

  if (!db) {
    logger.error('[orders] fulfillOrderPurchaseAfterTopup: no Supabase client', { topupId });
    return;
  }
  if (!tenantId || !phone || !paymentAttemptId || cart.length === 0) {
    logger.error('[orders] fulfillOrderPurchaseAfterTopup: incomplete resume payload', { topupId, tenantId });
    return;
  }

  try {
    const ctx = await loadTenantContext(db, tenantId);
    if (!ctx) {
      await notifyText(tenantId, phone, 'Your top-up went through, but ordering is unavailable right now. Your balance is safe.');
      return;
    }

    const wallet = ctx.config.walletLabel;
    const customer = await ensureCustomerForPhone(ctx, phone);
    if (!customer) {
      await notifyText(tenantId, phone, `Your ${wallet} top-up went through, but we hit a snag resuming your order. Please try ordering again.`);
      return;
    }

    const result = await placeOrder(ctx, {
      customer,
      items: cart,
      paymentChoice: 'wallet',
      paymentAttemptId,
      tableLabel: resume.tableLabel ?? null,
      scheduledFor: resume.scheduledFor ?? null,
      fulfilment: resume.fulfilment ?? null,
    });

    switch (result.outcome) {
      case 'ok':
        await notifyButtons(
          tenantId,
          phone,
          buildPlacedReply(ctx, result.orders, result.total, 'wallet', resume.scheduledFor ?? null),
          ORDER_CONFIRMED_BUTTONS,
        );
        logger.info('[orders] fulfillOrderPurchaseAfterTopup: success', { tenantId, orderIds: result.orders.map((o) => o.id) });
        return;
      case 'already_placed':
        logger.info('[orders] fulfillOrderPurchaseAfterTopup: already fulfilled — skipping', { tenantId, topupId });
        return;
      case 'insufficient_funds':
        await notifyText(tenantId, phone, `Your ${wallet} was topped up, but the balance still doesn't cover this order. Please top up again or restart your order.`);
        return;
      default:
        await notifyText(tenantId, phone, `Your ${wallet} was topped up, but we couldn't place your order: ${placeFailureReply(result)}\n\nYour balance is safe.`);
        return;
    }
  } catch (unexpectedError) {
    logger.error('[orders] fulfillOrderPurchaseAfterTopup: unexpected error', {
      tenantId,
      topupId,
      error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
    });
  }
}

/**
 * Handles the "Top up / Card" screen shown when the wallet can't cover the order.
 *  - Top up: hand off to wallet.ts's top-up flow as plain state data, carrying
 *    the whole pending order (plus tenantId) as an opaque `resume` payload.
 *  - Card: total was already shown, so go straight to checkout.
 */
export async function handleTopupOrCardSelection(
  ctx: TenantContext,
  phone: string,
  customer: OrderingCustomer,
  rawMessage: string,
  stateData: OrdersStateData,
): Promise<ActionResult> {
  const normalized = rawMessage.trim().toLowerCase();
  const walletWord = ctx.config.walletLabel.toLowerCase();

  if (normalized.includes('top up') || normalized.includes('topup') || normalized.includes(walletWord)) {
    const paymentAttemptId = stateData.paymentAttemptId ?? randomUUID();
    const shortfallHint = stateData.walletShortfall
      ? ` You need at least ${ctx.formatMoney(stateData.walletShortfall)} more — how much would you like to top up?`
      : ' How much would you like to top up?';

    return {
      reply: `No problem — let's top up your ${ctx.config.walletLabel} first.${shortfallHint}`,
      buttons: [],
      nextState: {
        state: WALLET_STATE_TOPUP_AMOUNT,
        data: {
          resume: {
            ...stateData,
            tenantId: ctx.tenantId,
            senderPhone: phone,
            paymentChoice: 'wallet',
            paymentAttemptId,
          },
        },
      },
    };
  }

  if (normalized.includes('card') && ctx.config.paymentMethods.includes('card')) {
    return beginCardOrderCheckout(
      ctx,
      phone,
      customer,
      getCart(stateData),
      stateData.tableLabel ?? null,
      stateData.scheduledFor ?? null,
      stateData.fulfilment ?? null,
    );
  }

  return actionResult(
    messages.PAYMENT_METHOD_REQUEST,
    { state: ORDER_STATE_AWAITING_TOPUP_OR_CARD, data: stateData },
    topupOrCardButtons(ctx.config),
  );
}
