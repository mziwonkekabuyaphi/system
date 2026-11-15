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
//   card   : place_order (orders 'pending') -> tenant gateway checkout ->
//            webhook -> fulfillOrderAfterPayment(attemptId) -> confirm_card_payment
// ============================================================================

import { randomUUID } from 'crypto';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/whatsapp/utils/logger';
import * as messages from '@/lib/messages/orders';
import type { ActionResult } from '@/lib/types/action';
import { WALLET_STATE_TOPUP_AMOUNT } from '@/lib/services/wallet';
import type { CartItem, CustomerPaymentChoice, OrdersStateData } from './orders.types';
import {
  CONFIRM_YES_NO_BUTTONS,
  ORDER_CONFIRMED_BUTTONS,
  ORDER_STATE_AWAITING_CONFIRMATION,
  ORDER_STATE_AWAITING_PAYMENT_METHOD,
  ORDER_STATE_AWAITING_TOPUP_OR_CARD,
} from './orders.types';
import {
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
import { getAppBaseUrl, getCardPaymentGateway, notifyButtons, notifyText } from './orders.integrations';

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
    );
  }
  const order = orders[0];
  return messages.cartOrderCreatedMessage(order.orderNumber, order.items, total, choice, [order.collectionPoint], scheduledLabel);
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
): ActionResult {
  // A payment method this tenant doesn't offer falls back to the normal picker.
  if (!ctx.config.paymentMethods.includes(paymentChoice)) {
    return actionResult(
      messages.PAYMENT_METHOD_REQUEST,
      { state: ORDER_STATE_AWAITING_PAYMENT_METHOD, data: { cart, tableLabel, scheduledFor: scheduledFor ?? null } },
      paymentButtons(ctx.config),
    );
  }

  const scheduledLabel = scheduledFor ? ctx.formatTime(new Date(scheduledFor)) : null;
  const reply = [
    ...summaryLines(ctx, cart),
    `Total: ${ctx.formatMoney(cartTotal(cart))}`,
    `Payment: ${paymentChoiceLabel(ctx.config, paymentChoice)}`,
    tableLabel ? `Table: ${tableLabel}` : undefined,
    scheduledLabel ? messages.scheduleConfirmedLabel(scheduledLabel) : undefined,
    '',
    'Reply *yes* to confirm or *no* to cancel.',
  ]
    .filter(Boolean)
    .join('\n');

  return actionResult(
    reply,
    { state: ORDER_STATE_AWAITING_CONFIRMATION, data: { cart, paymentChoice, tableLabel, scheduledFor: scheduledFor ?? null } },
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
    return beginCardOrderCheckout(ctx, phone, customer, cart, state.tableLabel ?? null, state.scheduledFor ?? null);
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
): Promise<ActionResult> {
  const backToPaymentMethod = (reply: string): ActionResult =>
    actionResult(
      reply,
      { state: ORDER_STATE_AWAITING_PAYMENT_METHOD, data: { cart, tableLabel, scheduledFor } },
      paymentButtons(ctx.config),
    );

  if (!ctx.config.paymentMethods.includes('card')) {
    return backToPaymentMethod(messages.PAYMENT_METHOD_REQUEST);
  }
  if (cart.length === 0) {
    return actionResult(messages.EMPTY_CART);
  }

  // Never trust stock/availability/prices captured earlier in the conversation.
  const resolved = await resolveCartItems(ctx, cart);
  if ('errorReply' in resolved) {
    return actionResult(resolved.errorReply);
  }
  const total = resolvedCartTotal(resolved);
  const paymentAttemptId = randomUUID();

  // Orders are created up front as 'pending' (card stock is applied on confirmation).
  const placed = await placeOrder(ctx, {
    customer,
    items: cart,
    paymentChoice: 'card',
    paymentAttemptId,
    tableLabel,
    scheduledFor,
  });
  if (placed.outcome !== 'ok' && placed.outcome !== 'already_placed') {
    return actionResult(placeFailureReply(placed));
  }

  try {
    const baseUrl = getAppBaseUrl();
    const checkout = await getCardPaymentGateway().createCheckout({
      tenantId: ctx.tenantId,
      customerId: customer.id,
      phone,
      amount: total,
      currency: ctx.config.currency,
      paymentAttemptId,
      orderIds: placed.orders.map((o) => o.id),
      description: `${ctx.config.brandName} order ${placed.orders.map((o) => o.orderNumber).join(', ')}`,
      successUrl: `${baseUrl}/orders/purchase/success`,
      cancelUrl: `${baseUrl}/orders/purchase/cancelled`,
      failureUrl: `${baseUrl}/orders/purchase/failed`,
    });

    logger.info('[orders] card checkout created', {
      tenantId: ctx.tenantId,
      paymentAttemptId,
      paymentSessionId: checkout.paymentSessionId,
    });

    return actionResult(
      messages.cartCheckoutLink(
        resolved.map((item) => ({ productName: item.product.name, quantity: item.quantity, unitPrice: item.unitPrice })),
        total,
        checkout.checkoutUrl,
      ),
    );
  } catch (error) {
    logger.error('[orders] beginCardOrderCheckout failed', {
      tenantId: ctx.tenantId,
      paymentAttemptId,
      error: error instanceof Error ? error.message : String(error),
    });
    // No checkout exists for these pending orders — cancel them so they never linger.
    await failCardPaymentByAttempt(ctx.db, paymentAttemptId);
    return backToPaymentMethod(messages.CARD_CHECKOUT_FAILED);
  }
}

/**
 * CARD WEBHOOK CALLBACK — called by the (tenant-verified) payment webhook once
 * the gateway confirms payment. Keyed on paymentAttemptId; the tenant is derived
 * from the order rows, never from the webhook caller.
 *
 * CONTRACT: never throws; idempotent (confirm_card_payment only flips orders
 * that are still pending/pending, so a redelivered webhook is a no-op).
 */
export async function fulfillOrderAfterPayment(paymentAttemptId: string): Promise<void> {
  const db = getSupabaseServerClient();
  if (!db) {
    logger.error('[orders] fulfillOrderAfterPayment: no Supabase client', { paymentAttemptId });
    return;
  }

  try {
    const result = await confirmCardPaymentByAttempt(db, paymentAttemptId);

    if (result.outcome === 'error') return; // already logged
    if (result.outcome === 'not_found') {
      logger.error('[orders] CRITICAL: card payment confirmed but no orders found for attempt — needs manual follow-up', {
        paymentAttemptId,
      });
      return;
    }
    if (result.outcome === 'already_confirmed') {
      logger.info('[orders] fulfillOrderAfterPayment: already fulfilled — skipping', { paymentAttemptId });
      return;
    }

    const ctx = await loadTenantContext(db, result.tenantId);
    if (!ctx) {
      // Money is captured and orders are placed; the tenant has since been disabled. Still tell the customer.
      await notifyText(
        result.tenantId,
        result.phone,
        `Your payment was received. Order${result.orders.length > 1 ? 's' : ''} ${result.orders.map((o) => `#${o.orderNumber}`).join(', ')} confirmed.`,
      );
      return;
    }

    await notifyButtons(
      result.tenantId,
      result.phone,
      buildPlacedReply(ctx, result.orders, result.total, 'card', result.scheduledFor),
      ORDER_CONFIRMED_BUTTONS,
    );
    logger.info('[orders] fulfillOrderAfterPayment: orders confirmed', {
      tenantId: result.tenantId,
      orderIds: result.orders.map((o) => o.id),
    });
  } catch (unexpectedError) {
    logger.error('[orders] fulfillOrderAfterPayment: unexpected error', {
      paymentAttemptId,
      error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
    });
  }
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

  const total = resolvedCartTotal(resolved);
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
  const db = getSupabaseServerClient();
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
    return beginCardOrderCheckout(ctx, phone, customer, getCart(stateData), stateData.tableLabel ?? null, stateData.scheduledFor ?? null);
  }

  return actionResult(
    messages.PAYMENT_METHOD_REQUEST,
    { state: ORDER_STATE_AWAITING_TOPUP_OR_CARD, data: stateData },
    topupOrCardButtons(ctx.config),
  );
}
