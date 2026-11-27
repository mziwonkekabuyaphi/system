// lib/site/types.ts
//
// What a tenant's website says, and the ONE place that decides what is allowed in it.
// Everything that goes into tenant_sites (draft or published) passes through sanitizeContent,
// so the public page never renders anything this file wouldn't let in. Text is rendered by React
// (escaped); URLs must be https; the WhatsApp number is reduced to digits.

export type SiteTemplate = "shisha" | "events" | "booking" | "orders"
/** A template is offered when ANY of its modules is switched on. */
export const TEMPLATES: { id: SiteTemplate; label: string; modules: string[] }[] = [
  { id: "shisha", label: "Shisha Lounge", modules: ["shisha"] },
  { id: "events", label: "Events & Tables", modules: ["events"] },
  { id: "booking", label: "Booking & Queue", modules: ["booking", "queue"] },
  { id: "orders", label: "WhatsApp Orders", modules: ["orders"] },
]
export const isTemplate = (v: unknown): v is SiteTemplate => v === "shisha" || v === "events" || v === "booking" || v === "orders"

export interface SiteHour { label: string; value: string }

export interface SiteContent {
  headline: string
  subheadline: string
  about: string
  heroImageUrl: string
  address: string
  /** Digits only, with country code (27...). Empty = no WhatsApp button. */
  whatsappNumber: string
  /** Pre-filled message when a visitor taps Order on WhatsApp. */
  whatsappMessage: string
  hours: SiteHour[]
  gallery: string[]
  show: { menu: boolean; areas: boolean; hours: boolean; gallery: boolean; contact: boolean; events: boolean; packages: boolean; services: boolean }
}

export const DEFAULT_ACCENT = "#F59E0B"
const MAX_HOURS = 7
const MAX_GALLERY = 8

export function defaultContent(shopName: string, template: SiteTemplate = "shisha"): SiteContent {
  const events = template === "events"
  const booking = template === "booking"
  const orders = template === "orders"
  return {
    headline: events ? (shopName ? `What's on at ${shopName}` : "What's on") : orders ? (shopName ? `Order from ${shopName}` : "Order online") : shopName ? `Welcome to ${shopName}` : "Welcome",
    subheadline: events ? "Tickets and tables, sorted on WhatsApp." : booking ? "Book a time or join the queue from your phone." : orders ? "Browse the menu and order on WhatsApp." : "Relax, pick your flavour and enjoy.",
    about: "",
    heroImageUrl: "",
    address: "",
    whatsappNumber: "",
    whatsappMessage: orders ? "Hi, I'd like to place an order." : events || booking ? "Hi, I'd like to book." : "Hi, I'd like to order a shisha.",
    hours: [
      { label: "Mon – Thu", value: "16:00 – 23:00" },
      { label: "Fri – Sat", value: "16:00 – 01:00" },
      { label: "Sunday", value: "Closed" },
    ],
    gallery: [],
    show: { menu: true, areas: true, hours: true, gallery: false, contact: true, events: true, packages: true, services: true },
  }
}

/** wa.me link with a pre-filled message, or null when the shop has no WhatsApp number. */
export function waLink(number: string, message: string): string | null {
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(message.slice(0, 300))}` : null
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

/** https only, no spaces, bounded length. Anything else becomes "". */
export function cleanUrl(v: unknown): string {
  const s = text(v, 500)
  if (!s || /\s/.test(s)) return ""
  try {
    const u = new URL(s)
    return u.protocol === "https:" ? u.toString() : ""
  } catch {
    return ""
  }
}

/** wa.me needs digits with country code. A leading 0 is taken as South Africa. 8-15 digits or "". */
export function cleanWhatsApp(v: unknown): string {
  let d = text(v, 30).replace(/\D/g, "")
  if (d.startsWith("0")) d = `27${d.slice(1)}`
  return d.length >= 8 && d.length <= 15 ? d : ""
}

export function sanitizeContent(raw: unknown, shopName: string, template: SiteTemplate = "shisha"): SiteContent {
  const base = defaultContent(shopName, template)
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const show = (r.show && typeof r.show === "object" ? r.show : {}) as Record<string, unknown>
  const flag = (k: keyof SiteContent["show"]) => (typeof show[k] === "boolean" ? (show[k] as boolean) : base.show[k])

  const hours = Array.isArray(r.hours)
    ? r.hours
        .slice(0, MAX_HOURS)
        .map((h) => ({ label: text((h as SiteHour)?.label, 40), value: text((h as SiteHour)?.value, 40) }))
        .filter((h) => h.label || h.value)
    : base.hours

  const gallery = Array.isArray(r.gallery) ? r.gallery.map(cleanUrl).filter(Boolean).slice(0, MAX_GALLERY) : base.gallery

  return {
    headline: text(r.headline, 80) || base.headline,
    subheadline: text(r.subheadline, 160),
    about: text(r.about, 600),
    heroImageUrl: cleanUrl(r.heroImageUrl),
    address: text(r.address, 200),
    whatsappNumber: cleanWhatsApp(r.whatsappNumber),
    whatsappMessage: text(r.whatsappMessage, 200),
    hours,
    gallery,
    show: { menu: flag("menu"), areas: flag("areas"), hours: flag("hours"), gallery: flag("gallery"), contact: flag("contact"), events: flag("events"), packages: flag("packages"), services: flag("services") },
  }
}
