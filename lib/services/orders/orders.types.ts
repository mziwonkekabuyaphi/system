// File: lib/services/orders/orders.types.ts
// ============================================================================
// DB-ALIGNED TYPES (mirror the multi-tenant schema in sql/001_orders_multitenant.sql)
// ============================================================================

export type OrderStatus =
  | 'pending'
  | 'placed'
  | 'preparing'
  | 'ready'
  | 'collected'
  | 'completed'
  | 'cancelled'
  | 'scheduled';

export type OrderPaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'refund_pending';

/** orders.payment_method CHECK constraint. */
export type OrderPaymentMethod = 'wallet' | 'card' | 'cash';

/**
 * Customer-facing payment choice. Which of these a tenant offers comes from
 * order_settings.allowed_payment_methods (see TenantConfig.paymentMethods).
 * VVIP tab was removed in the multi-tenant version.
 */
export type CustomerPaymentChoice = OrderPaymentMethod;

export type ProductStatus = 'draft' | 'active' | 'hidden' | 'archived';

/** Tenant-defined category KEY (product_categories.key) — no longer a fixed union. */
export type ProductCategory = string;

export interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  short_description: string | null;
  price: number;
  stock_quantity: number | null;
  is_available: boolean;
  status: ProductStatus;
  /** product_categories.key, or null if uncategorised. */
  category: ProductCategory | null;
  brand: string | null;
  vendor_id: string | null;
  track_inventory: boolean;
}

export interface OrderRow {
  id: string;
  customer_id: string;
  customer_phone: string;
  /** orders.created_at — kept under the old name because lib/messages/orders reads it. */
  order_date: string;
  total_amount: number;
  payment_method: OrderPaymentMethod;
  payment_status: OrderPaymentStatus;
  status: OrderStatus;
  order_number: string;
  customer_name: string | null;
  vendor_id: string;
  /** order_vendors.collection_point for this order's vendor. */
  collection_point: string;
  scheduled_for: string | null;
  table_label: string | null;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  product_name: string | null;
}

// ============================================================================
// CONVERSATION STATE SHAPE
// ============================================================================
//
// Action Router owns the `conversation_states` row itself (read, TTL/expiry,
// persistence of whatever `nextState` we return). This service only defines
// the *shape* of the payload it puts in `ConversationState.data`, and the
// state-name strings it recognizes as its own. Every name is namespaced with
// an "order_" prefix — this is what lets action-router's `resolveOwningIntent`
// map a state back to the "order" intent without this file ever registering
// anything with the router directly.

export const ORDER_STATE_AWAITING_SELECTION = 'order_awaiting_selection'; // customer was shown a numbered list (menu/category/search)
export const ORDER_STATE_AWAITING_QUANTITY = 'order_awaiting_quantity'; // customer picked a product, we need quantity
export const ORDER_STATE_AWAITING_PAYMENT_METHOD = 'order_awaiting_payment_method'; // we need wallet/card/cash
export const ORDER_STATE_AWAITING_CONFIRMATION = 'order_awaiting_confirmation'; // final yes/no before we create the order
// Shown when the customer picked their wallet but its balance can't cover the
// order — mirrors tickets.ts's "awaiting_topup_or_card". See beginWalletOrderPayment.
export const ORDER_STATE_AWAITING_TOPUP_OR_CARD = 'order_awaiting_topup_or_card';

// Shown right after an item is added to the cart — "add another item or
// checkout?" This is what lets a customer buy more than one *type* of item
// in a session instead of being locked into a single product per order.
// See addToCartAndReview.
export const ORDER_STATE_AWAITING_CART_ACTION = 'order_awaiting_cart_action';

// Shown right after "checkout" is tapped, before payment method — WhatsApp
// equivalent of order-now.js's collect modal ("Collect Now" vs pick a time
// slot). This is what makes scheduling a first-class option on both
// channels instead of a web-only feature. See beginScheduleChoiceStep.
export const ORDER_STATE_AWAITING_SCHEDULE_CHOICE = 'order_awaiting_schedule_choice';

// Shown only after "Schedule Later" is picked — free-text time entry, since
// WhatsApp has no time-slot dropdown. See parseScheduleTime.
export const ORDER_STATE_AWAITING_SCHEDULE_TIME = 'order_awaiting_schedule_time';

// Welcome screen shown on a fresh "order" entry: Order Now / Track My Order.
export const ORDER_STATE_AWAITING_WELCOME = 'order_awaiting_welcome';

// Category list shown (numbered) before any products — the customer picks a category first.
export const ORDER_STATE_AWAITING_CATEGORY = 'order_awaiting_category';

// "Remove Items" was tapped in the cart: waiting for the number of the line to remove.
export const ORDER_STATE_AWAITING_REMOVE_ITEM = 'order_awaiting_remove_item';

export type OrdersStateName =
  | typeof ORDER_STATE_AWAITING_WELCOME
  | typeof ORDER_STATE_AWAITING_CATEGORY
  | typeof ORDER_STATE_AWAITING_REMOVE_ITEM
  | typeof ORDER_STATE_AWAITING_SELECTION
  | typeof ORDER_STATE_AWAITING_QUANTITY
  | typeof ORDER_STATE_AWAITING_PAYMENT_METHOD
  | typeof ORDER_STATE_AWAITING_CONFIRMATION
  | typeof ORDER_STATE_AWAITING_TOPUP_OR_CARD
  | typeof ORDER_STATE_AWAITING_CART_ACTION
  | typeof ORDER_STATE_AWAITING_SCHEDULE_CHOICE
  | typeof ORDER_STATE_AWAITING_SCHEDULE_TIME;

/** One row of the category list: a group of the tenant's categories shown as a single choice. */
export interface PendingCategory {
  label: string;
  /** product_categories.id values to fetch products for. */
  categoryIds: string[];
  /** First category key in the group (used as the list's category). */
  key: string;
}

export interface PendingSelectionItem {
  productId: string;
  name: string;
  price: number;
  category: ProductCategory | null;
}

/**
 * One line in the shopping cart. Unlike PendingSelectionItem (a numbered list
 * shown to the customer), a CartItem is something they've actually committed
 * to buying this session. Multiple CartItems of different products can
 * coexist — this is what lets a customer buy more than one *type* of item
 * before checking out, instead of being locked into a single product per order.
 */
export interface CartItem {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  category: ProductCategory | null;
}

export interface OrdersStateData {
  /**
   * Index signature required so this shape structurally satisfies
   * `ConversationData` (`Record<string, unknown>` in lib/services/state.ts) —
   * every named field below is `unknown`-compatible, so this doesn't relax
   * their individual types, it just makes the object as a whole assignable
   * to `ConversationState.data` without a cast.
   */
  [key: string]: unknown;
  /**
   * Numbered list currently (or most recently) shown to the customer, so "3"
   * or "number 3" resolves — kept alive through the cart-review step too, so
   * a customer can keep adding items straight off a menu/category/search
   * list without having to reopen it after each add.
   */
  pendingSelection?: PendingSelectionItem[];
  /** Numbered category list currently shown (ORDER_STATE_AWAITING_CATEGORY). */
  pendingCategories?: PendingCategory[];
  category?: ProductCategory;
  /**
   * The shopping cart for this session — every item the customer has
   * committed to buying so far, added to over as many "add another item"
   * round trips as they like, and only ever cleared once checkout succeeds
   * (or the state expires). This is what makes multi-item orders possible.
   */
  cart?: CartItem[];
  selectedProductId?: string;
  selectedProductName?: string;
  selectedUnitPrice?: number;
  /** The real product category for the item currently being added — used for picking a collection point without a re-fetch. */
  selectedProductCategory?: ProductCategory | null;
  quantity?: number;
  paymentChoice?: CustomerPaymentChoice;
  tableLabel?: string | null;
  /**
   * Stable per-attempt reference used to make the wallet debit idempotent
   * (see debitWalletForOrder). Generated once, the first time we attempt a
   * wallet debit for this order, and carried forward through the top-up
   * resume round trip so a Yoco webhook retry can never double-charge or
   * double-create the order.
   */
  paymentAttemptId?: string;
  /**
   * Only ever set when handing off into WALLET_STATE_TOPUP_AMOUNT as part of
   * the `resume` payload — orders.ts otherwise always has `phone` available
   * as a handler parameter and never needs to persist it. fulfillOrderPurchaseAfterTopup
   * (a webhook callback, not a chat turn) has no such parameter, so this is
   * how it knows who to message/charge/create the order for.
   */
  senderPhone?: string;
  /**
   * Tenant that owns this order. Set only when handing off into the wallet
   * top-up `resume` payload: fulfillOrderPurchaseAfterTopup is a webhook
   * callback with no inbound WhatsApp message to resolve a tenant from.
   */
  tenantId?: string;
  /**
   * Set only when routing to ORDER_STATE_AWAITING_TOPUP_OR_CARD — how much
   * short the wallet balance was, so the top-up amount prompt can suggest a
   * sensible figure. Cosmetic only; settleWalletOrderPurchase re-checks the
   * real balance regardless.
   */
  walletShortfall?: number;
  /**
   * UTC ISO timestamp when the customer chose "Schedule Later" instead of
   * "Collect Now" (see ORDER_STATE_AWAITING_SCHEDULE_CHOICE /
   * ORDER_STATE_AWAITING_SCHEDULE_TIME). Undefined/null means "collect now"
   * — the pre-existing behaviour. Carried through payment method,
   * confirmation, the wallet top-up resume payload, and the card-checkout
   * snapshot exactly like paymentChoice, so it survives every branch of
   * checkout regardless of which payment path the customer takes.
   */
  scheduledFor?: string | null;
}

// ============================================================================
// BUTTON CONSTANTS
// ============================================================================
// Hoisted here (out of the step-handler functions that originally declared
// them inline) so every orders.* module can reach them without reaching into
// orders.flow-selection.ts / orders.flow-checkout.ts — several of these are
// used by handlers that now live in a different file than the one that used
// to declare them (e.g. ORDER_CONFIRMED_BUTTONS is used by the wallet-path
// fulfillment functions, which now live in orders.flow-checkout.ts, same as
// before, but also needs to be visible wherever else it's referenced).

// Payment-method and top-up buttons are tenant-specific: see paymentButtons() /
// topupOrCardButtons() in orders.tenant.ts.

// Shown right after an item lands in the cart — "add another item, or pay now?"
export const CART_ACTION_BUTTONS = ['Continue Shopping', 'View Cart', 'Checkout'];

// Shown when the cart itself is on screen.
export const CART_VIEW_BUTTONS = ['Continue Shopping', 'Remove Items', 'Checkout'];

// Shown with an empty cart.
export const EMPTY_CART_BUTTONS = ['Continue Shopping'];

// Welcome screen.
export const WELCOME_BUTTONS = ['Order Now', 'Track My Order'];

// Shown right after "checkout" — mirrors order-now.js's collect modal choice.
export const SCHEDULE_CHOICE_BUTTONS = ['Collect Now', 'Schedule Later'];

export const CONFIRM_YES_NO_BUTTONS = ['Yes', 'No'];

export const ORDER_CONFIRMED_BUTTONS = ['Track My Order', 'Main Menu'];

// Single button so tapping it always maps to the recognized "menu" intent
// (see parseOrderMessage) — a literal "Home" button would fall through to
// implicit-search parsing instead and search for a product called "home".
export const TRACKING_BUTTONS = ['Main Menu'];
