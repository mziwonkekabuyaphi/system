// File: lib/services/orders/orders.helpers.ts
import type { ActionResult } from '@/lib/types/action';
import type { ConversationState } from '@/lib/services/state';
import * as messages from '@/lib/messages/orders';
import { logger } from '@/lib/whatsapp/utils/logger';
import type {
  CartItem,
  CustomerPaymentChoice,
  OrdersStateData,
  OrdersStateName,
  ProductRow,
} from './orders.types';
import { localParts, paymentChoiceLabel, zonedTimeToUtc } from './orders.tenant';
import type { CategoryRow, TenantContext, VendorRow } from './orders.tenant';

// ============================================================================
// CART HELPERS
// ============================================================================

export function getCart(state: OrdersStateData): CartItem[] {
  return state.cart ?? [];
}

export function cartTotal(cart: CartItem[]): number {
  return Number(cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0).toFixed(2));
}

export function cartToLineItems(cart: CartItem[]): messages.CartLineItem[] {
  return cart.map((item) => ({ productName: item.name, quantity: item.quantity, unitPrice: item.unitPrice }));
}

/** Adds an item to the cart, merging quantities if the same product is already in it rather than creating a duplicate line. */
export function addItemToCart(cart: CartItem[], item: CartItem): CartItem[] {
  const existingIndex = cart.findIndex((line) => line.productId === item.productId);
  if (existingIndex === -1) {
    return [...cart, item];
  }
  const next = [...cart];
  next[existingIndex] = { ...next[existingIndex], quantity: next[existingIndex].quantity + item.quantity };
  return next;
}

// ============================================================================
// CATEGORY / VENDOR HELPERS — all driven by the tenant's own catalogue
// (product_categories / order_vendors), loaded once into TenantContext.
// ============================================================================

export interface CategoryMatch {
  /** Display label for the browsed section (group label if grouped, else the category label). */
  label: string;
  categories: CategoryRow[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Maps loose customer phrasing ("whisky", "softdrink", "beers") onto this
 * tenant's categories using product_categories.key / label / aliases. A match
 * returns the WHOLE group (all categories sharing a group_key) so a customer
 * typing "cider" sees the same combined section they would by typing "beer".
 * Longest matching phrase wins, so "sparkling wine" beats "wine".
 */
export function resolveCategoryFromText(ctx: TenantContext, text: string): CategoryMatch | null {
  const normalized = text.toLowerCase().trim();
  let best: { category: CategoryRow; length: number } | null = null;

  for (const category of ctx.catalog.categories) {
    const phrases = new Set([category.key.replace(/_/g, ' '), category.label.toLowerCase(), ...category.aliases]);
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (new RegExp(`(^|[^a-z0-9])${escapeRegex(phrase)}s?([^a-z0-9]|$)`, 'i').test(normalized)) {
        if (!best || phrase.length > best.length) best = { category, length: phrase.length };
      }
    }
  }
  if (!best) return null;
  return categoryGroupFor(ctx, best.category);
}

export function categoryGroupFor(ctx: TenantContext, category: CategoryRow): CategoryMatch {
  if (!category.groupKey) return { label: category.label, categories: [category] };
  const members = ctx.catalog.categories.filter((c) => c.groupKey === category.groupKey);
  return { label: category.groupLabel ?? category.label, categories: members };
}

export function categoryByKey(ctx: TenantContext, key: string | null | undefined): CategoryRow | null {
  if (!key) return null;
  return ctx.catalog.categories.find((c) => c.key === key) ?? null;
}

export function vendorById(ctx: TenantContext, vendorId: string | null | undefined): VendorRow | null {
  if (!vendorId) return null;
  return ctx.catalog.vendors.find((v) => v.id === vendorId) ?? null;
}

export function isAgeRestrictedCategory(ctx: TenantContext, categoryKey: string | null | undefined): boolean {
  return categoryByKey(ctx, categoryKey)?.ageRestricted ?? false;
}

/** Known brand/slang aliases ("henny" -> "hennessy") come from order_settings.search_aliases. */
export function resolveSearchTerm(ctx: Pick<TenantContext, 'config'>, text: string): string {
  const normalized = text.toLowerCase().trim();
  return ctx.config.searchAliases[normalized] ?? normalized;
}

/**
 * Greetings/small-talk/acknowledgements that should fall through to
 * UNRECOGNIZED (with its "reply *menu*" hint) instead of being treated as an
 * implicit product search term.
 */
const SMALL_TALK =
  /^(hi|hi+|hello|hey+|yo|sup|good (morning|afternoon|evening)|thanks?|thank you|thx|cheers|ok|okay|cool|nice|great|sure|no worries|please|help|sorry|bye|goodbye)[.!? ]*$/i;

// formatCurrency, pluralize, formatProductList/formatFullMenu equivalents,
// and the order-status display maps now live in lib/messages/orders.ts
// (messages.productListMessage, messages.fullMenuMessage,
// messages.orderStatusLabel, messages.orderStatusProgress).

// ============================================================================
// NATURAL LANGUAGE PARSING (lightweight, deterministic — orders.ts owns this
// logic rather than trusting AI memory, per architecture rules)
// ============================================================================

export interface ParsedOrderMessage {
  intent:
    | 'show_menu'
    | 'show_category'
    | 'search'
    | 'select_number'
    | 'quantity'
    | 'payment_method'
    | 'confirm_yes'
    | 'confirm_no'
    | 'track_order'
    | 'cancel_order'
    | 'repeat_order'
    | 'active_orders'
    | 'order_history'
    | 'price_check'
    | 'order_shortcut' // e.g. "Order two Hunters" in one message
    | 'unrecognized';
  category?: CategoryMatch;
  searchTerm?: string;
  selectionNumber?: number;
  quantity?: number;
  paymentChoice?: CustomerPaymentChoice;
  productPhrase?: string;
  tableLabel?: string | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function extractQuantity(text: string): number | null {
  const digitMatch = text.match(/\b(\d{1,2})\b/);
  if (digitMatch) {
    const value = parseInt(digitMatch[1], 10);
    if (value > 0 && value <= 50) return value;
  }
  const lower = text.toLowerCase();
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return value;
  }
  return null;
}

export function extractTableLabel(text: string): string | null {
  const match = text.match(/table\s*(\d+|[a-zA-Z]\d*)/i);
  return match ? `Table ${match[1]}` : null;
}

// ============================================================================
// SCHEDULING — free-text time entry for ORDER_STATE_AWAITING_SCHEDULE_TIME.
// order-now.js offers a <select> of pre-built time slots; WhatsApp has no
// dropdown, so this parses whatever the customer types instead. Deliberately
// narrow (12h or 24h clock time only, "today" implied) rather than a full NL
// date parser — same scope as the web app's picker, which also only ever
// offers times, never dates.
// ============================================================================

export type ScheduleTimeResult = { valid: true; iso: string; label: string } | { valid: false; errorReply: string };

/**
 * Parses "6pm", "6:30pm", "18:00", "6.30 pm" etc into a concrete UTC ISO
 * timestamp, TODAY ONLY, in the TENANT's time zone. A time that has already
 * passed is rejected rather than rolled to tomorrow. Opening hours come from
 * the tenant's business_hours row for today; minimum lead time from
 * order_settings.schedule_min_lead_minutes.
 */
export function parseScheduleTime(rawMessage: string, ctx: TenantContext, now: Date = new Date()): ScheduleTimeResult {
  const text = rawMessage.trim().toLowerCase();
  const { timeZone, scheduleMinLeadMinutes, businessHours } = ctx.config;

  const match = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i);
  if (!match) {
    return { valid: false, errorReply: messages.SCHEDULE_TIME_INVALID };
  }

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  if (minute > 59) {
    return { valid: false, errorReply: messages.SCHEDULE_TIME_INVALID };
  }

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  // No am/pm: 1-7 is read as PM (evening trading), otherwise a literal 24h hour.
  if (!meridiem && hour >= 1 && hour <= 7) hour += 12;

  if (hour > 23) {
    return { valid: false, errorReply: messages.SCHEDULE_TIME_INVALID };
  }

  const today = localParts(now, timeZone);
  const scheduled = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);

  if (scheduled <= now) {
    return { valid: false, errorReply: messages.SCHEDULE_TIME_ALREADY_PASSED };
  }

  const leadMinutes = (scheduled.getTime() - now.getTime()) / 60000;
  if (leadMinutes < scheduleMinLeadMinutes) {
    return { valid: false, errorReply: messages.SCHEDULE_TIME_TOO_SOON };
  }

  const hours = businessHours[today.weekday];
  const requestedMinutes = hour * 60 + minute;
  if (hours) {
    if (hours.closed) {
      return { valid: false, errorReply: messages.SCHEDULE_TIME_AFTER_CLOSING };
    }
    if (hours.closeMinutes !== null && requestedMinutes >= hours.closeMinutes) {
      return { valid: false, errorReply: messages.SCHEDULE_TIME_AFTER_CLOSING };
    }
    if (hours.openMinutes !== null && requestedMinutes < hours.openMinutes) {
      return { valid: false, errorReply: messages.SCHEDULE_TIME_INVALID };
    }
  }

  return { valid: true, iso: scheduled.toISOString(), label: ctx.formatTime(scheduled) };
}

/** Regex alternation matching the tenant's wallet label (e.g. "passport") plus the generic "wallet". */
export function walletAlternation(ctx: Pick<TenantContext, 'config'>): string {
  const words = new Set(['wallet', paymentChoiceLabel(ctx.config, 'wallet').toLowerCase()]);
  return [...words].map(escapeRegex).join('|');
}

export function parseOrderMessage(rawMessage: string, ctx: TenantContext): ParsedOrderMessage {
  const text = rawMessage.trim();
  const lower = text.toLowerCase();

  // --- explicit commands -----------------------------------------------
  if (/\btrack\b|\bwhere is my (order|food)\b|\bstatus\??$/i.test(lower)) {
    return { intent: 'track_order' };
  }
  if (/\bcancel\b/i.test(lower)) {
    return { intent: 'cancel_order' };
  }
  if (/\brepeat\b|\bsame as last time\b|\breorder\b/i.test(lower)) {
    return { intent: 'repeat_order' };
  }
  if (/\bmy current orders?\b|\bactive orders?\b/i.test(lower)) {
    return { intent: 'active_orders' };
  }
  if (/\border history\b|\bpast orders?\b|\bprevious orders?\b/i.test(lower)) {
    return { intent: 'order_history' };
  }
  if (/\bhow much\b|\bprice of\b|\bwhat('?s| is) the price\b/i.test(lower)) {
    const term = lower
      .replace(/how much (is|for|does)?/g, '')
      .replace(/what('?s| is) the price( of)?/g, '')
      .replace(/\?/g, '')
      .trim();
    return { intent: 'price_check', searchTerm: term || undefined };
  }

  // --- confirmation -------------------------------------------------------
  if (/^(yes|yep|yeah|confirm|correct|sure|ok(ay)?)\b/i.test(lower)) {
    return { intent: 'confirm_yes' };
  }
  if (/^(no|nope|cancel that|wrong)\b/i.test(lower)) {
    return { intent: 'confirm_no' };
  }

  // --- payment method -------------------------------------------------------
  // Customer-facing options are the tenant's wallet (labelled by
  // order_settings.wallet_label, "wallet" always accepted as an alias), Card
  // and Pay-at-counter. Only fires for a message that is NOT also a leading
  // order phrase ("buy 1 castle lager and use my wallet to pay" must reach the
  // order_shortcut branch below, which extracts the payment clause itself).
  const walletWords = walletAlternation(ctx);
  const looksLikeOrderShortcut = /^(?:i want|i need|order|buy|place|order now for|get me)\s+\S/i.test(lower);
  if (!looksLikeOrderShortcut) {
    if (new RegExp(`\\b(?:${walletWords})\\b`, 'i').test(lower)) return { intent: 'payment_method', paymentChoice: 'wallet' };
    if (/\bcard\b/i.test(lower)) return { intent: 'payment_method', paymentChoice: 'card' };
    if (/\bcash\b|\bpay (?:at|on) (?:the )?(?:counter|collection)\b/i.test(lower))
      return { intent: 'payment_method', paymentChoice: 'cash' };
  }

  // --- menu / category -------------------------------------------------------
  if (/\bmenu\b|\bwhat('?s| is) available\??\b|\bwhat food\b|\bwhat drinks?\b/i.test(lower)) {
    return { intent: 'show_menu' };
  }
  // No longer requires a "show" prefix — a bare category word/phrase (e.g.
  // just "beers", "whisky", "soft drinks") is a common, natural way for
  // customers to type this on WhatsApp and should work on its own, not just
  // as "show beers". Explicit phrasings like "show beers" still match too,
  // since resolveCategoryFromText just looks for the alias anywhere in the text.
  {
    const match = resolveCategoryFromText(ctx, lower);
    if (match) {
      return { intent: 'show_category', category: match };
    }
  }

  // --- search -------------------------------------------------------
  const searchMatch = lower.match(/^search\s+(.+)$/i);
  if (searchMatch) {
    return { intent: 'search', searchTerm: searchMatch[1].trim() };
  }

  // --- pure numeric / "number 3" selection -------------------------------------------------------
  const selectionMatch = lower.match(/^(?:number|option|#)?\s*(\d{1,2})$/i);
  if (selectionMatch) {
    return { intent: 'select_number', selectionNumber: parseInt(selectionMatch[1], 10) };
  }

  // --- "order two Hunters" / "I want three burgers" / "Buy one Moet" / "I need 4 Black Label" / "place two beers pay with card" ---
  const orderShortcut = lower.match(
    /^(?:i want|i need|order|buy|place|order now for|get me)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(.+)$/i,
  );
  if (orderShortcut) {
    const quantityToken = orderShortcut[1];
    let productPhrase = orderShortcut[2]?.trim();
    if (productPhrase) {
      const quantity = quantityToken
        ? (NUMBER_WORDS[quantityToken.toLowerCase()] ?? parseInt(quantityToken, 10))
        : 1;

      // Strip an embedded payment method clause ("pay with card", "paying
      // via wallet", "using cash") off the end of the phrase, if
      // present, so it doesn't pollute the product search term — and
      // surface it as paymentChoice so a fully-specified one-shot message
      // ("place two beers of Castle pay with card") can resolve product +
      // quantity + payment method together, instead of the payment clause
      // causing searchProducts to come back empty.
      let paymentChoice: CustomerPaymentChoice | undefined;
      // Two accepted trailing shapes:
      //   1. "...pay with/via/using <method>"            (method last)
      //   2. "...use my <method> (balance) to pay [it]"  (method before "to pay")
      const methodWords = `${walletWords}|card|cash`;
      const paymentClauseMatch =
        productPhrase.match(new RegExp(`\\s+(?:pay(?:ing)?\\s+(?:with|via|using)|using|via)\\s+(${methodWords})\\s*$`, 'i')) ??
        productPhrase.match(
          new RegExp(`\\s+(?:use|using)\\s+(?:my\\s+)?(${methodWords})(?:\\s+balance)?\\s+to\\s+pay(?:\\s+\\w+)?\\s*$`, 'i'),
        );
      if (paymentClauseMatch && typeof paymentClauseMatch.index === 'number') {
        productPhrase = productPhrase.slice(0, paymentClauseMatch.index).trim();
        const rawChoice = paymentClauseMatch[1].toLowerCase();
        paymentChoice = rawChoice === 'card' ? 'card' : rawChoice === 'cash' ? 'cash' : 'wallet';
      }

      if (productPhrase) {
        return {
          intent: 'order_shortcut',
          productPhrase,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          tableLabel: extractTableLabel(lower),
          paymentChoice,
        };
      }
    }
  }

  // "I want Castle Lite" without a leading quantity word already covered above via orderShortcut.

  // --- table mention alone (e.g. "I want drinks for Table 7") -------------------------------------------------------
  const tableLabel = extractTableLabel(lower);
  if (tableLabel && /\bdrinks?\b|\border\b/i.test(lower)) {
    return { intent: 'show_menu', tableLabel };
  }

  // --- bare quantity while awaiting_quantity state -------------------------------------------------------
  const quantity = extractQuantity(lower);
  if (quantity !== null && lower.split(/\s+/).length <= 3) {
    return { intent: 'quantity', quantity };
  }

  // --- implicit search: bare product name with no "search"/"order"/"buy" prefix ---------------------
  // Typing "search castle lite" or "order castle lite" both work above, but on
  // WhatsApp people just type "castle lite". Rather than dead-ending on
  // UNRECOGNIZED, treat leftover text as a search term — unless it looks like
  // greeting/small-talk, in which case UNRECOGNIZED (with its *menu* hint) is
  // the more helpful reply.
  if (!SMALL_TALK.test(lower) && /[a-z]{2,}/i.test(lower)) {
    return { intent: 'search', searchTerm: text.trim() };
  }

  return { intent: 'unrecognized' };
}

// ============================================================================
// VALIDATION
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errorReply?: string;
}

export function validateQuantity(quantity: number): ValidationResult {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { valid: false, errorReply: messages.INVALID_QUANTITY };
  }
  if (quantity > 50) {
    return { valid: false, errorReply: messages.QUANTITY_TOO_HIGH };
  }
  return { valid: true };
}

/**
 * Safely coerces a DB-sourced value to a finite number, or null if it
 * isn't one. Needed because Supabase/Postgres can hand back numeric
 * columns as strings, and because `stock_quantity` may simply be NULL —
 * neither case should be silently treated as `0`.
 */
export function toSafeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function validateProductAvailability(product: ProductRow | null, quantity: number): ValidationResult {
  if (!product) {
    return { valid: false, errorReply: messages.PRODUCT_NOT_FOUND };
  }
  if (product.status !== 'active' || !product.is_available) {
    return { valid: false, errorReply: messages.productUnavailable(product.name) };
  }

  if (product.track_inventory) {
    const stock = toSafeNumber(product.stock_quantity);

    // IMPORTANT: a product with track_inventory=true but a NULL/non-numeric
    // stock_quantity is a *data* problem, not a "no stock" problem. The old
    // code did `product.stock_quantity < quantity`, and JS coerces
    // `null < quantity` to `0 < quantity` (true) — so every product with an
    // unset stock_quantity was silently reported as out of stock, even
    // though the DB had real stock recorded elsewhere. Log it loudly and
    // let the order proceed rather than lying to the customer.
    if (stock === null) {
      logger.warn(
        '[orders] track_inventory=true but stock_quantity is missing/invalid — skipping stock check',
        { productId: product.id, productName: product.name, rawStockQuantity: product.stock_quantity },
      );
    } else if (stock < quantity) {
      if (stock <= 0) {
        return { valid: false, errorReply: messages.productOutOfStock(product.name) };
      }
      return {
        valid: false,
        errorReply: messages.productLowStock(product.name, stock),
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// RESULT CONSTRUCTION
// ============================================================================

/** Reads this service's own payload back out of a router-provided ConversationState. */
export function readStateData(state: ConversationState): OrdersStateData {
  return (state.data ?? {}) as OrdersStateData;
}

/** Small helper so every handler below builds ActionResult the same way. */
export function actionResult(
  reply: string,
  nextState: { state: OrdersStateName; data?: OrdersStateData } | null = null,
  buttons: string[] = [],
): ActionResult {
  return { reply, buttons, nextState };
}
