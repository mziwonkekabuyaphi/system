// lib/site/load-site.ts
//
// Everything a public tenant site needs, for ONE tenant, read with the service-role client
// (public visitors have no session; same trust model as /kiosk and /web). The slug is resolved to a
// tenant here and every query after that is filtered by that tenant's id.
//
// A site is only shown when: the tenant is active, the "web" module is on, and the owner has
// published. Otherwise this returns null and the page falls back to the old /web page.
// Only the PUBLISHED template's data is loaded (shisha: menu + areas; events: events + packages).

import { safeTimezone } from "@/app/admin/tz"
import { freeSiteHost } from "@/lib/domains/sites-domain"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isModuleEnabled } from "@/lib/tenant/modules"
import { DEFAULT_ACCENT, isTemplate, sanitizeContent, type SiteContent, type SiteTemplate } from "./types"

export interface SiteTicketType { id: string; name: string; price: number; soldOut: boolean }
export interface SiteEvent {
  id: string
  name: string
  description: string | null
  location: string | null
  startTime: string
  imageUrl: string | null
  tickets: SiteTicketType[]
}
export interface SitePackage {
  id: string
  name: string
  description: string | null
  price: number
  tabCredit: number
  seats: number | null
  benefits: string[]
  imageUrl: string | null
  eventName: string | null
}

export interface SiteCatalogueGroup {
  key: string
  label: string
  ageRestricted: boolean
  items: { id: string; name: string; description: string | null; price: number }[]
}
export interface SiteDeliveryArea { id: string; name: string; fee: number; freeOver: number | null }
export interface SiteOrderInfo {
  collection: boolean
  delivery: boolean
  dineIn: boolean
  collectionInstructions: string | null
  deliveryMinutes: number
  prepMinutes: number
  minOrder: number | null
}

export interface SiteService { id: string; name: string; price: number; durationMinutes: number }

export interface PublishedSite {
  template: SiteTemplate
  tenantId: string
  slug: string
  name: string
  logoUrl: string | null
  accent: string
  currency: string
  timezone: string
  content: SiteContent
  /** shisha: live from shisha_products (available, not archived). */
  menu: { id: string; name: string; price: number }[]
  /** shisha: live from shisha_locations (active, not archived). */
  areas: { id: string; name: string }[]
  /** events: upcoming, on sale, soonest first. */
  events: SiteEvent[]
  /** events + vvip: active table packages for those events. */
  packages: SitePackage[]
  /** booking: live from services (active). */
  services: SiteService[]
  /** booking: live from business_hours, consecutive days with the same hours merged. */
  businessHours: { label: string; value: string }[]
  /** booking: which buttons to show (a product must be on for its button). */
  canBook: boolean
  canQueue: boolean
  /** The one address search engines should index: the shop's own domain if it has one, else its free address. */
  canonicalHost: string | null
  /** orders: live catalogue grouped by category (active, available, in stock). */
  catalogue: SiteCatalogueGroup[]
  /** orders: active delivery areas with fees, only when delivery is on. */
  deliveryAreas: SiteDeliveryArea[]
  orderInfo: SiteOrderInfo | null
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const SIX_HOURS = 6 * 3_600_000
type Db = NonNullable<ReturnType<typeof getSupabaseServerClient>>
type Row = Record<string, unknown>

async function loadShisha(db: Db, tenantId: string) {
  const [products, locations] = await Promise.all([
    db.from("shisha_products").select("id, name, price").eq("tenant_id", tenantId).eq("is_available", true).is("archived_at", null).order("name", { ascending: true }),
    db.from("shisha_locations").select("id, name").eq("tenant_id", tenantId).eq("is_active", true).is("archived_at", null).order("name", { ascending: true }),
  ])
  return {
    menu: (products.data ?? []).map((p) => ({ id: p.id as string, name: p.name as string, price: Number(p.price) || 0 })),
    areas: (locations.data ?? []).map((l) => ({ id: l.id as string, name: l.name as string })),
  }
}

async function loadEvents(db: Db, tenantId: string, withPackages: boolean) {
  const { data } = await db
    .from("events")
    .select("id, name, description, location, start_time, end_time, image_url, event_ticket_types(id, name, price, capacity, sold, is_active, sort_order)")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("start_time", { ascending: true })
    .limit(30)

  const now = Date.now()
  const upcoming = ((data ?? []) as Row[])
    .filter((e) => {
      const start = Date.parse(String(e.start_time))
      const end = e.end_time ? Date.parse(String(e.end_time)) : start + SIX_HOURS
      return Number.isFinite(end) && end >= now
    })
    .slice(0, 12)

  const events: SiteEvent[] = upcoming.map((e) => ({
    id: String(e.id),
    name: String(e.name),
    description: (e.description as string | null) ?? null,
    location: (e.location as string | null) ?? null,
    startTime: String(e.start_time),
    imageUrl: typeof e.image_url === "string" && e.image_url.startsWith("https://") ? e.image_url : null,
    tickets: ((e.event_ticket_types as Row[] | null) ?? [])
      .filter((t) => t.is_active)
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.price) - Number(b.price))
      .map((t) => ({
        id: String(t.id),
        name: String(t.name),
        price: Number(t.price) || 0,
        soldOut: Number(t.capacity) > 0 && Number(t.sold) >= Number(t.capacity),
      })),
  }))

  let packages: SitePackage[] = []
  if (withPackages && events.length > 0) {
    const names = new Map(events.map((e) => [e.id, e.name]))
    const { data: pk } = await db
      .from("vvip_packages")
      .select("id, event_id, name, description, price, tab_credit, seats_per_table, benefits, image_url")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .in("event_id", [...names.keys()])
      .order("price", { ascending: true })
    packages = ((pk ?? []) as Row[]).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      description: (p.description as string | null) ?? null,
      price: Number(p.price) || 0,
      tabCredit: Number(p.tab_credit) || 0,
      seats: p.seats_per_table == null ? null : Number(p.seats_per_table),
      benefits: Array.isArray(p.benefits) ? (p.benefits as unknown[]).filter((b): b is string => typeof b === "string").slice(0, 6) : [],
      imageUrl: typeof p.image_url === "string" && p.image_url.startsWith("https://") ? p.image_url : null,
      eventName: names.get(String(p.event_id)) ?? null,
    }))
  }
  return { events, packages }
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const hm = (t: unknown) => String(t ?? "").slice(0, 5)

/** Mon..Sun, merging neighbours with identical hours: "Mon – Fri 09:00 – 18:00". */
function groupHours(rows: Row[]): { label: string; value: string }[] {
  const byDay = new Map(rows.map((r) => [Number(r.day_of_week), r]))
  const order = [1, 2, 3, 4, 5, 6, 0]
  const text = (d: number) => {
    const r = byDay.get(d)
    return !r || r.is_closed || !r.open_time || !r.close_time ? "Closed" : `${hm(r.open_time)} – ${hm(r.close_time)}`
  }
  const out: { label: string; value: string }[] = []
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && text(order[j + 1]) === text(order[i])) j++
    out.push({ label: i === j ? DAY[order[i]] : `${DAY[order[i]]} – ${DAY[order[j]]}`, value: text(order[i]) })
    i = j + 1
  }
  return out
}

async function loadOrders(db: Db, tenantId: string) {
  const [products, cats, settings, areas, hours] = await Promise.all([
    db.from("products").select("id, name, short_description, description, price, category, track_inventory, stock_quantity")
      .eq("tenant_id", tenantId).eq("status", "active").eq("is_available", true).order("name", { ascending: true }).limit(300),
    db.from("product_categories").select("key, label, age_restricted, sort_order").eq("tenant_id", tenantId).eq("is_active", true).order("sort_order", { ascending: true }),
    db.from("order_settings").select("collection_enabled, delivery_enabled, dine_in_enabled, collection_instructions, prep_time_minutes, delivery_time_minutes, min_order_value").eq("tenant_id", tenantId).maybeSingle(),
    db.from("order_delivery_areas").select("id, name, fee, free_over").eq("tenant_id", tenantId).eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }),
    db.from("business_hours").select("day_of_week, is_closed, open_time, close_time").eq("tenant_id", tenantId),
  ])

  const inStock = (p: Row) => !p.track_inventory || Number(p.stock_quantity) > 0
  const groups = new Map<string, SiteCatalogueGroup>()
  for (const c of (cats.data ?? []) as Row[]) {
    groups.set(String(c.key), { key: String(c.key), label: String(c.label), ageRestricted: Boolean(c.age_restricted), items: [] })
  }
  for (const p of ((products.data ?? []) as Row[]).filter(inStock)) {
    const key = p.category ? String(p.category) : "other"
    if (!groups.has(key)) groups.set(key, { key, label: key === "other" ? "Other" : key, ageRestricted: false, items: [] })
    groups.get(key)!.items.push({
      id: String(p.id),
      name: String(p.name),
      description: ((p.short_description ?? p.description) as string | null) || null,
      price: Number(p.price) || 0,
    })
  }

  const o = (settings.data ?? null) as Row | null
  const delivery = Boolean(o?.delivery_enabled)
  return {
    catalogue: [...groups.values()].filter((g) => g.items.length > 0),
    deliveryAreas: delivery
      ? ((areas.data ?? []) as Row[]).map((a) => ({ id: String(a.id), name: String(a.name), fee: Number(a.fee) || 0, freeOver: a.free_over == null ? null : Number(a.free_over) }))
      : [],
    orderInfo: o
      ? {
          collection: Boolean(o.collection_enabled),
          delivery,
          dineIn: Boolean(o.dine_in_enabled),
          collectionInstructions: (o.collection_instructions as string | null) || null,
          deliveryMinutes: Number(o.delivery_time_minutes) || 0,
          prepMinutes: Number(o.prep_time_minutes) || 0,
          minOrder: o.min_order_value == null ? null : Number(o.min_order_value),
        }
      : null,
    businessHours: groupHours((hours.data ?? []) as Row[]),
  }
}

async function loadBooking(db: Db, tenantId: string) {
  const [services, hours, canBook, canQueue] = await Promise.all([
    db.from("services").select("id, name, price, duration_minutes").eq("tenant_id", tenantId).eq("active", true).order("name", { ascending: true }),
    db.from("business_hours").select("day_of_week, is_closed, open_time, close_time").eq("tenant_id", tenantId),
    isModuleEnabled(tenantId, "booking"),
    isModuleEnabled(tenantId, "queue"),
  ])
  return {
    services: ((services.data ?? []) as Row[]).map((r) => ({ id: String(r.id), name: String(r.name), price: Number(r.price) || 0, durationMinutes: Number(r.duration_minutes) || 0 })),
    businessHours: groupHours((hours.data ?? []) as Row[]),
    canBook,
    canQueue,
  }
}

type TenantRef = { id: string; name: string; slug: string }

/** Everything a template needs, for a known tenant, template and content. Shared by the live page and the draft preview. */
async function buildSite(db: Db, tenant: TenantRef, template: SiteTemplate, rawContent: unknown): Promise<PublishedSite> {
  const tenantId = tenant.id
  const [brandingRes, settingsRes] = await Promise.all([
    db.from("tenant_branding").select("display_name, logo_url, primary_color").eq("tenant_id", tenantId).maybeSingle(),
    db.from("tenant_settings").select("currency, timezone").eq("tenant_id", tenantId).maybeSingle(),
  ])

  const name = (brandingRes.data?.display_name as string | null)?.trim() || tenant.name
  const primary = brandingRes.data?.primary_color as string | null
  const shisha = template === "shisha" ? await loadShisha(db, tenantId) : { menu: [], areas: [] }
  const ev =
    template === "events"
      ? await loadEvents(db, tenantId, await isModuleEnabled(tenantId, "vvip"))
      : { events: [] as SiteEvent[], packages: [] as SitePackage[] }

  const booking =
    template === "booking"
      ? await loadBooking(db, tenantId)
      : { services: [] as SiteService[], businessHours: [] as { label: string; value: string }[], canBook: false, canQueue: false }

  const orders =
    template === "orders"
      ? await loadOrders(db, tenantId)
      : { catalogue: [] as SiteCatalogueGroup[], deliveryAreas: [] as SiteDeliveryArea[], orderInfo: null as SiteOrderInfo | null }

  return {
    template,
    tenantId,
    slug: tenant.slug,
    name,
    logoUrl: (brandingRes.data?.logo_url as string | null) ?? null,
    accent: primary && HEX.test(primary) ? primary : DEFAULT_ACCENT,
    currency: (settingsRes.data?.currency as string | null) || "ZAR",
    timezone: safeTimezone(settingsRes.data?.timezone as string | null),
    content: sanitizeContent(rawContent, name, template),
    canonicalHost: null,
    ...shisha,
    ...ev,
    businessHours: [],
    ...booking,
    ...orders,
  }
}

/** Own active primary domain (when the Custom domain module is on), else the free address, else null. */
async function canonicalHostFor(db: Db, tenantId: string, slug: string): Promise<string | null> {
  if (await isModuleEnabled(tenantId, "custom_domain")) {
    const { data } = await db.from("tenant_domains").select("domain").eq("tenant_id", tenantId).eq("status", "active").eq("is_primary", true).maybeSingle()
    if (data?.domain) return String(data.domain)
  }
  return freeSiteHost(slug)
}

export async function loadPublishedSite(slug: string): Promise<PublishedSite | null> {
  const db = getSupabaseServerClient()
  if (!db || !slug) return null

  const { data: tenant } = await db.from("tenants").select("id, name, slug").eq("slug", slug).eq("status", "active").maybeSingle()
  if (!tenant) return null
  const tenantId = tenant.id as string

  if (!(await isModuleEnabled(tenantId, "web"))) return null

  const { data: site } = await db
    .from("tenant_sites")
    .select("published, is_published, template, published_template")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (!site?.is_published || !site.published) return null
  const template: SiteTemplate = isTemplate(site.published_template) ? site.published_template : isTemplate(site.template) ? site.template : "shisha"

  const built = await buildSite(db, { id: tenantId, name: tenant.name as string, slug: tenant.slug as string }, template, site.published)
  return { ...built, canonicalHost: await canonicalHostFor(db, tenantId, built.slug) }
}

/**
 * The owner's saved DRAFT, built exactly like the live page (same template, same live data) so the
 * preview can't differ from what Publish will show. Called only from the permission-checked preview
 * page, with the tenant id taken from the signed-in membership. Null when no draft has been saved.
 */
export async function loadDraftSite(tenantId: string): Promise<PublishedSite | null> {
  const db = getSupabaseServerClient()
  if (!db || !tenantId) return null

  const { data: tenant } = await db.from("tenants").select("id, name, slug").eq("id", tenantId).maybeSingle()
  if (!tenant) return null
  if (!(await isModuleEnabled(tenantId, "web"))) return null

  const { data: site } = await db.from("tenant_sites").select("draft, template").eq("tenant_id", tenantId).maybeSingle()
  if (!site || !isTemplate(site.template)) return null

  return buildSite(db, { id: tenantId, name: tenant.name as string, slug: tenant.slug as string }, site.template, site.draft)
}

/**
 * The shop's live facts (name, menu / services / events / catalogue names) for a template, with default
 * text. Used to brief the "Write my website for me" button so the copy is about what the shop really sells.
 * Called only from the permission-checked action, with the tenant id from the signed-in membership.
 */
export async function loadSiteFacts(tenantId: string, template: SiteTemplate): Promise<PublishedSite | null> {
  const db = getSupabaseServerClient()
  if (!db || !tenantId) return null
  const { data: tenant } = await db.from("tenants").select("id, name, slug").eq("id", tenantId).maybeSingle()
  if (!tenant) return null
  return buildSite(db, { id: tenantId, name: tenant.name as string, slug: tenant.slug as string }, template, {})
}
