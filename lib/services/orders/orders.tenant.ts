// File: lib/services/orders/orders.tenant.ts
// ============================================================================
// TENANT CONTEXT — resolved ONCE at the webhook edge, then passed to every
// orders.* function in place of a bare SupabaseClient. Nothing in this service
// reads tenant identity from message content or conversation state: the
// WhatsApp phone_number_id the message arrived on is the only source of truth.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/whatsapp/utils/logger';
import type { CustomerPaymentChoice, OrderFulfilment } from './orders.types';

export interface CategoryRow {
  id: string;
  key: string;
  label: string;
  groupKey: string | null;
  groupLabel: string | null;
  aliases: string[];
  ageRestricted: boolean;
  sortOrder: number;
}

export interface VendorRow {
  id: string;
  name: string;
  collectionPoint: string;
}

export interface DeliveryAreaRow {
  id: string;
  name: string;
  fee: number;
  /** null = the fee is always charged. */
  freeOver: number | null;
}

export interface DayHours {
  closed: boolean;
  /** Minutes after local midnight; null when closed/unset. */
  openMinutes: number | null;
  closeMinutes: number | null;
}

export interface TenantConfig {
  tenantId: string;
  /** tenant_settings.brand_name ?? tenant_branding.display_name ?? tenants.name */
  brandName: string;
  currency: string;
  timeZone: string;
  walletLabel: string;
  paymentMethods: CustomerPaymentChoice[];
  allowScheduling: boolean;
  scheduleMinLeadMinutes: number;
  minAge: number | null;
  searchAliases: Record<string, string>;
  collectionEnabled: boolean;
  deliveryEnabled: boolean;
  dineInEnabled: boolean;
  collectionInstructions: string | null;
  prepTimeMinutes: number;
  deliveryTimeMinutes: number;
  /** false = staff must accept each order before it reaches the board. */
  autoAcceptOrders: boolean;
  /** true = customers must pay up front: cash ("pay at counter") is never offered. */
  requirePayment: boolean;
  /** Smallest items total a customer can check out with. 0 = no minimum. */
  minOrderValue: number;
  /** Largest items total a customer can check out with. null = no maximum. */
  maxOrderValue: number | null;
  /** Keyed by day_of_week (0–6, same convention as business_hours). */
  businessHours: Record<number, DayHours>;
}

export interface TenantCatalog {
  categories: CategoryRow[];
  vendors: VendorRow[];
  /** Active delivery areas in display order (empty unless delivery is on). */
  deliveryAreas: DeliveryAreaRow[];
}

export interface TenantContext {
  tenantId: string;
  db: SupabaseClient;
  config: TenantConfig;
  catalog: TenantCatalog;
  formatMoney(amount: number): string;
  /** HH:MM in the tenant's own time zone. */
  formatTime(date: Date): string;
}

export const ORDERING_NOT_AVAILABLE =
  'Ordering is not available right now. Please speak to a team member.';

// ----------------------------------------------------------------------------
// Presentation helpers that depend on tenant config
// ----------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { ZAR: 'R', USD: '$', EUR: '€', GBP: '£' };

export function formatMoneyFor(currency: string, amount: number): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const value = Number(amount).toFixed(2);
  return symbol ? `${symbol}${value}` : `${currency} ${value}`;
}

// ----------------------------------------------------------------------------
// Fulfilment (collection / delivery / dine-in)
// ----------------------------------------------------------------------------

/** Ways the shop currently offers, in the order shown to customers. Delivery only counts with an area to deliver to. */
export function enabledFulfilments(config: TenantConfig, catalog: TenantCatalog): OrderFulfilment[] {
  const out: OrderFulfilment[] = [];
  if (config.collectionEnabled) out.push('collection');
  if (config.deliveryEnabled && catalog.deliveryAreas.length > 0) out.push('delivery');
  if (config.dineInEnabled) out.push('dine_in');
  return out;
}

export function fulfilmentLabel(method: OrderFulfilment): string {
  return method === 'delivery' ? 'Delivery' : method === 'dine_in' ? 'Dine-in' : 'Collection';
}

/** Same rule place_order applies (it stays the authority): free once the items total reaches free_over. */
export function deliveryFeeFor(area: DeliveryAreaRow, itemsTotal: number): number {
  return area.freeOver !== null && itemsTotal >= area.freeOver ? 0 : area.fee;
}

/**
 * The shop's order value limits, checked on the ITEMS total (delivery fee not counted) — the same rule place_order
 * applies, which stays the authority. Returns which limit the cart breaks, or null when it is within both.
 */
export function orderLimitProblem(config: Pick<TenantConfig, 'minOrderValue' | 'maxOrderValue'>, itemsTotal: number): 'below' | 'above' | null {
  if (config.minOrderValue > 0 && itemsTotal < config.minOrderValue) return 'below';
  if (config.maxOrderValue !== null && itemsTotal > config.maxOrderValue) return 'above';
  return null;
}

export function paymentChoiceLabel(config: Pick<TenantConfig, 'walletLabel'>, choice: CustomerPaymentChoice): string {
  switch (choice) {
    case 'wallet':
      return config.walletLabel;
    case 'card':
      return 'Card';
    case 'cash':
      return 'Pay at Counter';
  }
}

/** Quick-reply buttons for the payment-method step — only what this tenant allows. */
export function paymentButtons(config: TenantConfig): string[] {
  return config.paymentMethods.map((m) => paymentChoiceLabel(config, m));
}

export function topupOrCardButtons(config: TenantConfig): string[] {
  const buttons = [`Top up ${config.walletLabel}`];
  if (config.paymentMethods.includes('card')) buttons.push('Card');
  return buttons;
}

// ----------------------------------------------------------------------------
// Tenant-local time helpers (no external date library)
// ----------------------------------------------------------------------------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

/** Converts a wall-clock time in `timeZone` to the matching UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wall - asUtc;
  }
  return new Date(guess);
}

// ----------------------------------------------------------------------------
// Resolution + loading
// ----------------------------------------------------------------------------

/**
 * WhatsApp webhook entry: phone_number_id -> tenant_id. Returns null for an
 * unknown or inactive integration so the caller can drop the message.
 * NOTE: assumes the `whatsapp_integration_status` enum has an 'active' value —
 * adjust if your enum names it differently ('connected', 'verified', ...).
 */
export async function resolveTenantIdByPhoneNumberId(
  db: SupabaseClient,
  phoneNumberId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('tenant_whatsapp_integrations')
    .select('tenant_id, status')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle<{ tenant_id: string; status: string }>();

  if (error) {
    logger.error('[orders][tenant] integration lookup failed', { phoneNumberId, error: error.message });
    return null;
  }
  if (!data || data.status !== 'active') return null;
  return data.tenant_id;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; config: TenantConfig; catalog: TenantCatalog }>();

/** Drop the cached config/catalogue (call after an admin edits settings/menu). */
export function invalidateTenantCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

function timeToMinutes(value: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * Loads (and briefly caches) everything this service needs to know about a
 * tenant. Returns null when the tenant is missing, not active, or doesn't have
 * the `orders` module enabled — in which case the caller replies with
 * ORDERING_NOT_AVAILABLE.
 */
export async function loadTenantContext(db: SupabaseClient, tenantId: string): Promise<TenantContext | null> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return buildContext(db, hit.config, hit.catalog);
  }

  const [tenantRes, settingsRes, brandingRes, orderSettingsRes, hoursRes, catsRes, vendorsRes, areasRes, moduleRes] =
    await Promise.all([
      db.from('tenants').select('id, name, status').eq('id', tenantId).maybeSingle<{ id: string; name: string; status: string }>(),
      db.from('tenant_settings').select('timezone, currency, brand_name').eq('tenant_id', tenantId)
        .maybeSingle<{ timezone: string; currency: string; brand_name: string | null }>(),
      db.from('tenant_branding').select('display_name').eq('tenant_id', tenantId)
        .maybeSingle<{ display_name: string | null }>(),
      db.from('order_settings')
        .select('wallet_label, allowed_payment_methods, allow_scheduling, schedule_min_lead_minutes, min_age, search_aliases, collection_enabled, delivery_enabled, dine_in_enabled, collection_instructions, prep_time_minutes, delivery_time_minutes, auto_accept_orders, require_payment, min_order_value, max_order_value')
        .eq('tenant_id', tenantId)
        .maybeSingle<{
          wallet_label: string;
          allowed_payment_methods: CustomerPaymentChoice[];
          allow_scheduling: boolean;
          schedule_min_lead_minutes: number;
          min_age: number | null;
          search_aliases: Record<string, string> | null;
          collection_enabled: boolean;
          delivery_enabled: boolean;
          dine_in_enabled: boolean;
          collection_instructions: string | null;
          prep_time_minutes: number;
          delivery_time_minutes: number;
          auto_accept_orders: boolean | null;
          require_payment: boolean | null;
          min_order_value: number | null;
          max_order_value: number | null;
        }>(),
      db.from('business_hours').select('day_of_week, is_closed, open_time, close_time').eq('tenant_id', tenantId)
        .returns<Array<{ day_of_week: number; is_closed: boolean; open_time: string | null; close_time: string | null }>>(),
      db.from('product_categories')
        .select('id, key, label, group_key, group_label, aliases, age_restricted, sort_order')
        .eq('tenant_id', tenantId).eq('is_active', true).order('sort_order', { ascending: true })
        .returns<Array<{
          id: string; key: string; label: string; group_key: string | null; group_label: string | null;
          aliases: string[] | null; age_restricted: boolean; sort_order: number;
        }>>(),
      db.from('order_vendors').select('id, name, collection_point').eq('tenant_id', tenantId).eq('is_active', true)
        .returns<Array<{ id: string; name: string; collection_point: string }>>(),
      db.from('order_delivery_areas').select('id, name, fee, free_over')
        .eq('tenant_id', tenantId).eq('is_active', true)
        .order('sort_order', { ascending: true }).order('name', { ascending: true })
        .returns<Array<{ id: string; name: string; fee: number; free_over: number | null }>>(),
      db.from('tenant_modules').select('enabled, modules!inner(key)')
        .eq('tenant_id', tenantId).eq('modules.key', 'orders').maybeSingle<{ enabled: boolean }>(),
    ]);

  const tenant = tenantRes.data;
  const orderSettings = orderSettingsRes.data;
  if (!tenant || tenant.status !== 'active' || !orderSettings || !moduleRes.data?.enabled) {
    if (tenantRes.error || orderSettingsRes.error || moduleRes.error) {
      logger.error('[orders][tenant] context load failed', {
        tenantId,
        errors: [tenantRes.error?.message, orderSettingsRes.error?.message, moduleRes.error?.message].filter(Boolean),
      });
    }
    return null;
  }

  const businessHours: Record<number, DayHours> = {};
  for (const row of hoursRes.data ?? []) {
    businessHours[row.day_of_week] = {
      closed: row.is_closed,
      openMinutes: timeToMinutes(row.open_time),
      closeMinutes: timeToMinutes(row.close_time),
    };
  }

  const config: TenantConfig = {
    tenantId,
    brandName: settingsRes.data?.brand_name ?? brandingRes.data?.display_name ?? tenant.name,
    currency: settingsRes.data?.currency ?? 'ZAR',
    timeZone: settingsRes.data?.timezone && settingsRes.data.timezone !== 'UTC' ? settingsRes.data.timezone : 'Africa/Johannesburg',
    walletLabel: orderSettings.wallet_label,
    // With "payment before ordering" on, cash is never offered (place_order refuses it too).
    paymentMethods: orderSettings.require_payment
      ? orderSettings.allowed_payment_methods.filter((m) => m !== 'cash')
      : orderSettings.allowed_payment_methods,
    allowScheduling: orderSettings.allow_scheduling,
    scheduleMinLeadMinutes: orderSettings.schedule_min_lead_minutes,
    minAge: orderSettings.min_age,
    searchAliases: Object.fromEntries(
      Object.entries(orderSettings.search_aliases ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]),
    ),
    collectionEnabled: orderSettings.collection_enabled ?? true,
    deliveryEnabled: !!orderSettings.delivery_enabled,
    dineInEnabled: !!orderSettings.dine_in_enabled,
    collectionInstructions: orderSettings.collection_instructions ?? null,
    prepTimeMinutes: Number(orderSettings.prep_time_minutes ?? 15),
    deliveryTimeMinutes: Number(orderSettings.delivery_time_minutes ?? 45),
    autoAcceptOrders: orderSettings.auto_accept_orders ?? true,
    requirePayment: !!orderSettings.require_payment,
    minOrderValue: Number(orderSettings.min_order_value ?? 0),
    maxOrderValue: orderSettings.max_order_value == null ? null : Number(orderSettings.max_order_value),
    businessHours,
  };

  const catalog: TenantCatalog = {
    categories: (catsRes.data ?? []).map((c) => ({
      id: c.id,
      key: c.key,
      label: c.label,
      groupKey: c.group_key,
      groupLabel: c.group_label,
      aliases: (c.aliases ?? []).map((a) => a.toLowerCase()),
      ageRestricted: c.age_restricted,
      sortOrder: c.sort_order,
    })),
    vendors: (vendorsRes.data ?? []).map((v) => ({ id: v.id, name: v.name, collectionPoint: v.collection_point })),
    deliveryAreas: (areasRes.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      fee: Number(a.fee),
      freeOver: a.free_over == null ? null : Number(a.free_over),
    })),
  };

  cache.set(tenantId, { at: Date.now(), config, catalog });
  return buildContext(db, config, catalog);
}

function buildContext(db: SupabaseClient, config: TenantConfig, catalog: TenantCatalog): TenantContext {
  return {
    tenantId: config.tenantId,
    db,
    config,
    catalog,
    formatMoney: (amount) => formatMoneyFor(config.currency, amount),
    formatTime: (date) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: config.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(date),
  };
}
