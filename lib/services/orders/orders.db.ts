// File: lib/services/orders/orders.db.ts
// ============================================================================
// ALL Supabase access for the orders service. Every function takes a
// TenantContext and every query is filtered by ctx.tenantId — the service-role
// client bypasses RLS, so this is the isolation boundary. Money movement
// (wallet debit/refund, order creation) happens inside Postgres functions
// (see sql/001_orders_multitenant.sql) so it is atomic and idempotent.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/whatsapp/utils/logger';
import * as messages from '@/lib/messages/orders';
import type {
  CartItem,
  CustomerPaymentChoice,
  OrderItemRow,
  OrderRow,
  OrderStatus,
  ProductRow,
  ProductStatus,
} from './orders.types';
import type { TenantContext } from './orders.tenant';
import { resolveSearchTerm, validateProductAvailability, vendorById } from './orders.helpers';

// ============================================================================
// CUSTOMER RESOLUTION (phone -> tenant_customers)
// ============================================================================

export interface OrderingCustomer {
  id: string;
  name: string | null;
  phone: string;
}

/** WhatsApp numbers arrive as digits (country code included). Store/compare that form only. */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Finds this tenant's customer for a phone number, creating the row on first
 * contact. The same human texting two tenants is two independent customers.
 * Returns null only on a DB failure.
 */
export async function ensureCustomerForPhone(ctx: TenantContext, phone: string): Promise<OrderingCustomer | null> {
  const select = () =>
    ctx.db
      .from('tenant_customers')
      .select('id, full_name')
      .eq('tenant_id', ctx.tenantId)
      .eq('phone', phone)
      .maybeSingle<{ id: string; full_name: string | null }>();

  const existing = await select();
  if (existing.error) {
    logger.error('[orders] customer lookup failed', { tenantId: ctx.tenantId, error: existing.error.message });
    return null;
  }
  if (existing.data) return { id: existing.data.id, name: existing.data.full_name, phone };

  const { error: insertError } = await ctx.db
    .from('tenant_customers')
    .upsert({ tenant_id: ctx.tenantId, phone, status: 'active' }, { onConflict: 'tenant_id,phone', ignoreDuplicates: true });
  if (insertError) {
    logger.error('[orders] customer create failed', { tenantId: ctx.tenantId, error: insertError.message });
    return null;
  }

  const created = await select();
  if (created.error || !created.data) {
    logger.error('[orders] customer re-read failed', { tenantId: ctx.tenantId, error: created.error?.message });
    return null;
  }
  return { id: created.data.id, name: created.data.full_name, phone };
}

// ============================================================================
// WALLET (read-only here — debits/refunds happen inside place_order/cancel_order)
// ============================================================================

export interface WalletSnapshot {
  id: string;
  balance: number;
  status: string;
}

export async function getWalletForCustomer(ctx: TenantContext, customerId: string): Promise<WalletSnapshot | null> {
  const { data, error } = await ctx.db
    .from('wallets')
    .select('id, balance, status')
    .eq('tenant_id', ctx.tenantId)
    .eq('customer_id', customerId)
    .maybeSingle<{ id: string; balance: number; status: string }>();

  if (error) {
    logger.error('[orders] wallet lookup failed', { tenantId: ctx.tenantId, error: error.message });
    return null;
  }
  return data ? { id: data.id, balance: Number(data.balance), status: data.status } : null;
}

/**
 * Courtesy balance check used to decide, BEFORE creating anything, whether to
 * route to top-up-or-card. Returns null when there is no usable wallet.
 * place_order re-verifies under a row lock when money actually moves.
 */
export async function getWalletBalanceForOrder(ctx: TenantContext, customerId: string): Promise<number | null> {
  const wallet = await getWalletForCustomer(ctx, customerId);
  if (!wallet || wallet.status !== 'active') return null;
  return wallet.balance;
}

// ============================================================================
// PRODUCT QUERIES
// ============================================================================

const PRODUCT_COLUMNS =
  'id, name, description, short_description, price, stock_quantity, is_available, status, category_id, vendor_id, brand, track_inventory';

interface ProductDbRow {
  id: string;
  name: string;
  description: string | null;
  short_description: string | null;
  price: number;
  stock_quantity: number | null;
  is_available: boolean;
  status: ProductStatus;
  category_id: string | null;
  vendor_id: string | null;
  brand: string | null;
  track_inventory: boolean;
}

function mapProduct(ctx: TenantContext, row: ProductDbRow): ProductRow {
  const category = ctx.catalog.categories.find((c) => c.id === row.category_id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    short_description: row.short_description,
    price: Number(row.price),
    stock_quantity: row.stock_quantity,
    is_available: row.is_available,
    status: row.status,
    category: category?.key ?? null,
    brand: row.brand,
    vendor_id: row.vendor_id,
    track_inventory: row.track_inventory,
  };
}

function availableProducts(ctx: TenantContext) {
  return ctx.db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active' satisfies ProductStatus)
    .eq('is_available', true);
}

export async function getProductsByCategoryIds(ctx: TenantContext, categoryIds: string[]): Promise<ProductRow[]> {
  if (categoryIds.length === 0) return [];
  const { data, error } = await availableProducts(ctx)
    .in('category_id', categoryIds)
    .order('name', { ascending: true })
    .returns<ProductDbRow[]>();

  if (error) {
    logger.error('[orders] getProductsByCategoryIds failed', { tenantId: ctx.tenantId, error: error.message });
    return [];
  }
  return (data ?? []).map((row) => mapProduct(ctx, row));
}

/** Strips characters that have meaning inside a PostgREST filter string or a LIKE pattern. */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()%*_\\"'`;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function searchProducts(ctx: TenantContext, rawTerm: string): Promise<ProductRow[]> {
  const term = sanitizeSearchTerm(resolveSearchTerm(ctx, rawTerm));
  if (!term) return [];
  const likeTerm = `%${term}%`;

  const { data, error } = await availableProducts(ctx)
    .or(`name.ilike.${likeTerm},brand.ilike.${likeTerm},short_description.ilike.${likeTerm}`)
    .order('name', { ascending: true })
    .limit(10)
    .returns<ProductDbRow[]>();

  if (error) {
    logger.error('[orders] searchProducts failed', { tenantId: ctx.tenantId, term, error: error.message });
    return [];
  }
  return (data ?? []).map((row) => mapProduct(ctx, row));
}

/** Whole available menu, ordered by the tenant's category sort order then name. */
export async function getFullMenu(ctx: TenantContext): Promise<ProductRow[]> {
  const { data, error } = await availableProducts(ctx).order('name', { ascending: true }).returns<ProductDbRow[]>();

  if (error) {
    logger.error('[orders] getFullMenu failed', { tenantId: ctx.tenantId, error: error.message });
    return [];
  }

  const sortOf = (key: string | null) => ctx.catalog.categories.find((c) => c.key === key)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return (data ?? [])
    .map((row) => mapProduct(ctx, row))
    .sort((a, b) => sortOf(a.category) - sortOf(b.category) || a.name.localeCompare(b.name));
}

export async function getProductById(ctx: TenantContext, productId: string): Promise<ProductRow | null> {
  const { data, error } = await ctx.db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .eq('id', productId)
    .maybeSingle<ProductDbRow>();

  if (error) {
    logger.error('[orders] getProductById failed', { tenantId: ctx.tenantId, productId, error: error.message });
    return null;
  }
  return data ? mapProduct(ctx, data) : null;
}

async function getProductsByIds(ctx: TenantContext, ids: string[]): Promise<Map<string, ProductRow>> {
  const { data, error } = await ctx.db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .in('id', ids)
    .returns<ProductDbRow[]>();

  if (error) {
    logger.error('[orders] getProductsByIds failed', { tenantId: ctx.tenantId, error: error.message });
    return new Map();
  }
  return new Map((data ?? []).map((row) => [row.id, mapProduct(ctx, row)] as const));
}

// ============================================================================
// CART RESOLUTION — re-price/re-validate against live rows (display + totals only;
// place_order re-validates inside the transaction and is the real authority)
// ============================================================================

export interface ResolvedCartLine {
  product: ProductRow;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export async function resolveCartItems(
  ctx: TenantContext,
  items: CartItem[],
): Promise<ResolvedCartLine[] | { errorReply: string }> {
  const products = await getProductsByIds(ctx, items.map((i) => i.productId));
  const resolved: ResolvedCartLine[] = [];

  for (const cartItem of items) {
    const product = products.get(cartItem.productId) ?? null;
    const availability = validateProductAvailability(product, cartItem.quantity);
    if (!availability.valid || !product) {
      return { errorReply: availability.errorReply ?? messages.PRODUCT_NOT_FOUND };
    }
    const unitPrice = Number(product.price);
    resolved.push({
      product,
      quantity: cartItem.quantity,
      unitPrice,
      subtotal: Number((unitPrice * cartItem.quantity).toFixed(2)),
    });
  }
  return resolved;
}

export function resolvedCartTotal(items: ResolvedCartLine[]): number {
  return Number(items.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2));
}

// ============================================================================
// ORDER PLACEMENT — one atomic RPC (validate -> split by vendor -> insert ->
// wallet debit). Idempotent on (tenant, paymentAttemptId).
// ============================================================================

export interface PlaceOrderParams {
  customer: OrderingCustomer;
  items: CartItem[];
  paymentChoice: CustomerPaymentChoice;
  /** Generated once per purchase attempt and reused across retries / top-up resume. */
  paymentAttemptId: string;
  tableLabel: string | null;
  scheduledFor?: string | null;
}

export interface PlacedOrderItem {
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface PlacedOrder {
  id: string;
  orderNumber: string;
  vendorId: string;
  vendorName: string;
  collectionPoint: string;
  total: number;
  items: PlacedOrderItem[];
}

export type PlaceOrderFailure =
  | { outcome: 'insufficient_funds'; balance: number; total: number }
  | { outcome: 'product_unavailable' | 'out_of_stock'; productName: string }
  | { outcome: 'low_stock'; productName: string; stock: number }
  | {
      outcome:
        | 'wallet_not_found'
        | 'wallet_inactive'
        | 'product_not_found'
        | 'invalid_quantity'
        | 'empty_cart'
        | 'no_vendor_configured'
        | 'payment_method_not_allowed'
        | 'scheduling_not_allowed'
        | 'customer_not_found'
        | 'ordering_not_configured'
        | 'error';
    };

export type PlaceOrderResult =
  | { outcome: 'ok'; total: number; orders: PlacedOrder[] }
  | { outcome: 'already_placed'; total: number; orders: PlacedOrder[] }
  | PlaceOrderFailure;

interface RpcOrderJson {
  id: string;
  order_number: string;
  vendor_id: string;
  vendor_name: string;
  collection_point: string;
  total: number;
  items: Array<{ product_name: string; quantity: number; unit_price: number }>;
}

export function parseOrdersJson(raw: unknown): PlacedOrder[] {
  return ((raw as RpcOrderJson[] | null) ?? []).map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    vendorId: o.vendor_id,
    vendorName: o.vendor_name,
    collectionPoint: o.collection_point,
    total: Number(o.total),
    items: (o.items ?? []).map((i) => ({
      productName: i.product_name,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unit_price),
    })),
  }));
}

export async function placeOrder(ctx: TenantContext, params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { data, error } = await ctx.db.rpc('place_order', {
    p_tenant: ctx.tenantId,
    p_customer: params.customer.id,
    p_phone: params.customer.phone,
    p_customer_name: params.customer.name,
    p_payment_method: params.paymentChoice,
    p_attempt: params.paymentAttemptId,
    p_scheduled_for: params.scheduledFor ?? null,
    p_table_label: params.tableLabel,
    // Only ids and quantities cross the boundary — prices are always read from the DB.
    p_lines: params.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
  });

  if (error || !data) {
    logger.error('[orders] place_order RPC failed', {
      tenantId: ctx.tenantId,
      paymentAttemptId: params.paymentAttemptId,
      error: error?.message,
    });
    return { outcome: 'error' };
  }

  const result = data as Record<string, unknown> & { outcome: string };

  switch (result.outcome) {
    case 'ok':
    case 'already_placed':
      return {
        outcome: result.outcome as 'ok' | 'already_placed',
        total: Number(result.total),
        orders: parseOrdersJson(result.orders),
      } as PlaceOrderResult;
    case 'insufficient_funds':
      return { outcome: 'insufficient_funds', balance: Number(result.balance), total: Number(result.total) };
    case 'product_unavailable':
    case 'out_of_stock':
      return { outcome: result.outcome, productName: String(result.product_name ?? '') };
    case 'low_stock':
      return { outcome: 'low_stock', productName: String(result.product_name ?? ''), stock: Number(result.stock ?? 0) };
    default:
      return { outcome: result.outcome } as PlaceOrderFailure;
  }
}

// ============================================================================
// CARD PAYMENT WEBHOOK CALLBACKS (no tenant context available — the RPC derives
// the tenant from the order rows themselves)
// ============================================================================

export interface ConfirmedCardPayment {
  tenantId: string;
  phone: string;
  scheduledFor: string | null;
  total: number;
  orders: PlacedOrder[];
}

export type ConfirmCardResult =
  | ({ outcome: 'ok' } & ConfirmedCardPayment)
  | ({ outcome: 'already_confirmed' } & ConfirmedCardPayment)
  | { outcome: 'not_found' }
  | { outcome: 'error' };

export async function confirmCardPaymentByAttempt(db: SupabaseClient, paymentAttemptId: string): Promise<ConfirmCardResult> {
  const { data, error } = await db.rpc('confirm_card_payment', { p_attempt: paymentAttemptId });
  if (error || !data) {
    logger.error('[orders] confirm_card_payment RPC failed', { paymentAttemptId, error: error?.message });
    return { outcome: 'error' };
  }
  const r = data as Record<string, unknown> & { outcome: string };
  if (r.outcome === 'not_found') return { outcome: 'not_found' };
  const confirmed: ConfirmedCardPayment = {
    tenantId: String(r.tenant_id),
    phone: String(r.phone),
    scheduledFor: (r.scheduled_for as string | null) ?? null,
    total: Number(r.total),
    orders: parseOrdersJson(r.orders),
  };
  return r.outcome === 'ok' ? { outcome: 'ok', ...confirmed } : { outcome: 'already_confirmed', ...confirmed };
}

/** Cancels the still-pending orders of a card attempt whose checkout could not be created. */
export async function failCardPaymentByAttempt(db: SupabaseClient, paymentAttemptId: string): Promise<void> {
  const { error } = await db.rpc('fail_card_payment', { p_attempt: paymentAttemptId });
  if (error) {
    logger.error('[orders] fail_card_payment RPC failed', { paymentAttemptId, error: error.message });
  }
}

// ============================================================================
// SCHEDULED-ORDER ACTIVATION
// ============================================================================

/**
 * Opportunistic, per-customer activation of scheduled orders whose time has
 * come. A cron calling activate_due_scheduled_orders() with no arguments is
 * still required — a customer who never messages again would otherwise never
 * trigger this.
 */
export async function activateDueScheduledOrders(ctx: TenantContext, phone: string): Promise<void> {
  const { error } = await ctx.db.rpc('activate_due_scheduled_orders', { p_tenant: ctx.tenantId, p_phone: phone });
  if (error) {
    logger.error('[orders] activateDueScheduledOrders failed', { tenantId: ctx.tenantId, error: error.message });
  }
}

// ============================================================================
// TRACKING / CANCEL / REPEAT / HISTORY / ACTIVE ORDERS
// ============================================================================

const ORDER_COLUMNS =
  'id, customer_id, customer_phone, customer_name, order_number, status, payment_method, payment_status, total_amount, scheduled_for, table_label, vendor_id, created_at';

interface OrderDbRow {
  id: string;
  customer_id: string;
  customer_phone: string;
  customer_name: string | null;
  order_number: string;
  status: OrderStatus;
  payment_method: OrderRow['payment_method'];
  payment_status: OrderRow['payment_status'];
  total_amount: number;
  scheduled_for: string | null;
  table_label: string | null;
  vendor_id: string;
  created_at: string;
}

function mapOrder(ctx: TenantContext, row: OrderDbRow): OrderRow {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_phone: row.customer_phone,
    customer_name: row.customer_name,
    order_number: row.order_number,
    order_date: row.created_at,
    status: row.status,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    total_amount: Number(row.total_amount),
    scheduled_for: row.scheduled_for,
    table_label: row.table_label,
    vendor_id: row.vendor_id,
    collection_point: vendorById(ctx, row.vendor_id)?.collectionPoint ?? ctx.config.brandName,
  };
}

function ordersForPhone(ctx: TenantContext, phone: string) {
  return ctx.db.from('orders').select(ORDER_COLUMNS).eq('tenant_id', ctx.tenantId).eq('customer_phone', phone);
}

const ACTIVE_STATUSES: OrderStatus[] = ['pending', 'placed', 'preparing', 'ready'];

export async function getLatestOrderForPhone(ctx: TenantContext, phone: string): Promise<OrderRow | null> {
  const { data, error } = await ordersForPhone(ctx, phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OrderDbRow>();

  if (error) {
    logger.error('[orders] getLatestOrderForPhone failed', { tenantId: ctx.tenantId, error: error.message });
    return null;
  }
  return data ? mapOrder(ctx, data) : null;
}

export async function getActiveOrdersForPhone(ctx: TenantContext, phone: string): Promise<OrderRow[]> {
  const { data, error } = await ordersForPhone(ctx, phone)
    .in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: false })
    .returns<OrderDbRow[]>();

  if (error) {
    logger.error('[orders] getActiveOrdersForPhone failed', { tenantId: ctx.tenantId, error: error.message });
    return [];
  }
  return (data ?? []).map((row) => mapOrder(ctx, row));
}

/**
 * COUNT-ONLY read for the wallet overview. Unlike getActiveOrdersForPhone it
 * THROWS on a DB error so callers can tell "0 orders" from "failed to count".
 */
export async function getActiveOrderCountForPhone(ctx: TenantContext, phone: string): Promise<number> {
  const { count, error } = await ctx.db
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('customer_phone', phone)
    .in('status', ACTIVE_STATUSES);

  if (error) {
    logger.error('[orders] getActiveOrderCountForPhone failed', { tenantId: ctx.tenantId, error: error.message });
    throw error;
  }
  return count ?? 0;
}

export async function getOrderHistoryForPhone(ctx: TenantContext, phone: string, limit = 5): Promise<OrderRow[]> {
  const { data, error } = await ordersForPhone(ctx, phone)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<OrderDbRow[]>();

  if (error) {
    logger.error('[orders] getOrderHistoryForPhone failed', { tenantId: ctx.tenantId, error: error.message });
    return [];
  }
  return (data ?? []).map((row) => mapOrder(ctx, row));
}

export async function getLastCompletedOrderForPhone(ctx: TenantContext, phone: string): Promise<OrderRow | null> {
  const { data, error } = await ordersForPhone(ctx, phone)
    .eq('status', 'completed' satisfies OrderStatus)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OrderDbRow>();

  if (error) {
    logger.error('[orders] getLastCompletedOrderForPhone failed', { tenantId: ctx.tenantId, error: error.message });
    return null;
  }
  return data ? mapOrder(ctx, data) : null;
}

export async function getOrderItems(ctx: TenantContext, orderId: string): Promise<OrderItemRow[]> {
  const { data, error } = await ctx.db
    .from('order_items')
    .select('id, order_id, product_id, quantity, unit_price, subtotal, product_name')
    .eq('tenant_id', ctx.tenantId)
    .eq('order_id', orderId)
    .returns<OrderItemRow[]>();

  if (error) {
    logger.error('[orders] getOrderItems failed', { tenantId: ctx.tenantId, orderId, error: error.message });
    return [];
  }
  return data ?? [];
}

export type CancelOrderResult =
  | { outcome: 'ok'; orderNumber: string; wasPaid: boolean; paymentStatus: string }
  | { outcome: 'not_cancellable'; orderNumber: string; status: OrderStatus }
  | { outcome: 'not_found' | 'error' };

/** Atomic cancel: status flip, wallet refund via ledger, stock restore. */
export async function cancelOrder(ctx: TenantContext, orderId: string): Promise<CancelOrderResult> {
  const { data, error } = await ctx.db.rpc('cancel_order', { p_tenant: ctx.tenantId, p_order: orderId });
  if (error || !data) {
    logger.error('[orders] cancel_order RPC failed', { tenantId: ctx.tenantId, orderId, error: error?.message });
    return { outcome: 'error' };
  }
  const r = data as Record<string, unknown> & { outcome: string };
  if (r.outcome === 'ok') {
    return {
      outcome: 'ok',
      orderNumber: String(r.order_number),
      wasPaid: Boolean(r.was_paid),
      paymentStatus: String(r.payment_status),
    };
  }
  if (r.outcome === 'not_cancellable') {
    return { outcome: 'not_cancellable', orderNumber: String(r.order_number), status: r.status as OrderStatus };
  }
  return { outcome: r.outcome === 'not_found' ? 'not_found' : 'error' };
}
