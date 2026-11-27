// lib/whatsapp/booking-ticket-render.ts
/**
 * Booking Ticket Card — PURE renderer
 * -----------------------------------
 * Turns an already-resolved ticket (colours, labels, toggles) into a PNG.
 * No database, no Storage, no network: everything it needs is passed in, so it
 * can be unit-tested and used for a live preview in the tenant's settings page.
 * booking-ticket-image.ts is what loads a tenant's branding/config, formats the
 * dates and uploads the result.
 *
 * LAYOUT: "appointment pass". The TIME is the hero (huge, on the brand colour), the service sits on a card that
 * overlaps the hero, and below it the details sit beside the QR code. Event tickets and table passes use a different layout.
 *
 * This is the multi-tenant, white-label successor to the old ticket-image-
 * generator.ts / vvip-image-generator.ts. Same engine (satori -> resvg, no
 * native canvas bindings, so it works on Vercel), same layout language and the
 * same fonts, but NOTHING is hardcoded to one brand: colours, logo, wording and
 * which rows appear all come from `ResolvedTicketStyle`.
 *
 * SETUP:  npm install satori @resvg/resvg-js qrcode && npm i -D @types/qrcode
 * FONTS:  copy the four .woff files to lib/whatsapp/fonts/ (they must ship with
 *         the deployment; satori cannot fetch fonts at request time):
 *           Inter-Regular.woff, Inter-Bold.woff, Inter-ExtraBold.woff,
 *           PlayfairDisplay-ExtraBold.woff
 */

import satori from "satori"
import { Resvg } from "@resvg/resvg-js"
import QRCode from "qrcode"
import fs from "fs"
import path from "path"

import { renderBookingTicketPngClassic } from "@/lib/whatsapp/booking-ticket-render-classic"

const FONT_DIR = path.join(process.cwd(), "lib/whatsapp/fonts")

export type HeaderStyle = "gradient" | "solid" | "light"

/** Which of the two designs a ticket is drawn in. Anything but "modern" is the classic (original) design. */
export type TicketLayout = "classic" | "modern"

/** Everything about HOW the ticket looks and which rows it shows. */
export interface ResolvedTicketStyle {
  /** Design of the ticket. Missing = classic. */
  layout?: TicketLayout
  /** Shop name shown next to the logo. */
  shopName: string
  /** Small uppercase line above the service name, e.g. "Yap Your Booking". */
  eyebrow: string
  /** Optional line under the QR code, e.g. the tenant's tagline. */
  footerText: string | null
  headerStyle: HeaderStyle
  /** Main brand colour (#rrggbb). Header background / light-header text. */
  headerColor: string
  /** Second brand colour (#rrggbb). Stripe under the header + footer pill. */
  accentColor: string
  /** PNG/JPEG/GIF/SVG data URI, or null for no logo (satori can't draw WebP). */
  logoDataUri: string | null
  showLogo: boolean
  showPrice: boolean
  showDuration: boolean
  showReference: boolean
  showPhone: boolean
  showAddress: boolean
  showQr: boolean
  /** Show a small "Powered by ZozoApp" line (false for tenants who removed it). */
  showPoweredBy: boolean
}

/** The booking itself, with every label already formatted for display. */
export interface RenderableTicket {
  /** Service name(s), already joined, e.g. "Hair Cut + Beard Combo". */
  serviceName: string
  /** Already formatted, e.g. "R250" or "R250.50". null hides the price. */
  priceLabel: string | null
  /** Deposit bookings: what is still owed at the appointment, already formatted, e.g. "R150". Shown under the
   *  price; null (the usual case) shows nothing. */
  balanceLabel: string | null
  /** e.g. "Sat, 17 Oct 2026" (tenant's timezone). */
  dateLabel: string
  /** e.g. "12:30 - 13:15" (tenant's timezone). */
  timeLabel: string
  /** e.g. "45 min". */
  durationLabel: string | null
  address: string | null
  phone: string | null
  customerName: string | null
  reference: string
  /** The value encoded in the QR code. */
  qrValue: string
}

// ----------------------------------------------------------------------------
// Colour helpers — so ANY tenant colour pair stays readable.
// ----------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Returns a clean #rrggbb, or `fallback` when the value isn't a valid hex colour. */
export function cleanHex(value: string | null | undefined, fallback: string): string {
  const v = (value ?? "").trim()
  if (!HEX_RE.test(v)) return fallback
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase()
  return v.toLowerCase()
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** White or near-black, whichever reads better on `bg`. */
export function readableOn(bg: string): string {
  return luminance(bg) > 0.45 ? "#111827" : "#ffffff"
}

/** amount < 0 darkens, > 0 lightens (towards white). */
function shade(hex: string, amount: number): string {
  const target = amount < 0 ? 0 : 255
  const t = Math.abs(amount)
  const out = rgb(hex).map((c) => Math.round(c + (target - c) * t))
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

// satori nodes are plain { type, props } objects, so this file needs no JSX/.tsx.
type Node = { type: string; props: Record<string, unknown> }

const div = (style: Record<string, unknown>, children?: unknown): Node => ({
  type: "div",
  props: { style: { display: "flex", ...style }, ...(children === undefined ? {} : { children }) },
})

// ----------------------------------------------------------------------------
// Fonts (read once per warm instance)
// ----------------------------------------------------------------------------

let fontCache: Parameters<typeof satori>[1]["fonts"] | null = null

function loadFonts(): Parameters<typeof satori>[1]["fonts"] {
  if (fontCache) return fontCache
  const read = (file: string) => fs.readFileSync(path.join(FONT_DIR, file))
  fontCache = [
    { name: "Inter", data: read("Inter-Regular.woff"), weight: 400, style: "normal" },
    { name: "Inter", data: read("Inter-Bold.woff"), weight: 700, style: "normal" },
    { name: "Inter", data: read("Inter-ExtraBold.woff"), weight: 800, style: "normal" },
    { name: "Playfair", data: read("PlayfairDisplay-ExtraBold.woff"), weight: 800, style: "normal" },
  ]
  return fontCache
}

// ----------------------------------------------------------------------------
// Layout
// ----------------------------------------------------------------------------

/** "12:30 - 13:15" -> { start: "12:30", end: "13:15" }; a single time or another shape -> end null / null. */
function timeParts(label: string): { start: string; end: string | null } | null {
  const m = /^(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?$/.exec(label.trim())
  return m ? { start: m[1], end: m[2] ?? null } : null
}

function field(label: string, value: string): Node {
  return div({ flexDirection: "column", paddingBottom: 18 }, [
    div({ fontSize: 19, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 2.5 }, label),
    div({ fontSize: 31, fontWeight: 700, color: "#1e293b", marginTop: 4, lineHeight: 1.15 }, value),
  ])
}

function buildTree(style: ResolvedTicketStyle, t: RenderableTicket, qrDataUrl: string | null): Node {
  const light = style.headerStyle === "light"
  const heroBg =
    style.headerStyle === "gradient"
      ? `linear-gradient(160deg, ${shade(style.headerColor, 0.08)} 0%, ${style.headerColor} 45%, ${shade(style.headerColor, -0.45)} 100%)`
      : light
        ? "#ffffff"
        : style.headerColor
  const onHero = light ? style.headerColor : readableOn(style.headerColor)
  const accentText = readableOn(style.accentColor)
  const ring = light ? style.headerColor : onHero

  const time = timeParts(t.timeLabel)
  const bigTime = time?.start ?? t.timeLabel
  const timeFont = time ? 190 : t.timeLabel.length > 14 ? 60 : 84

  // Soft decorative rings (depth, not content).
  const deco: Node[] = [
    div({ position: "absolute", right: -120, top: -120, width: 360, height: 360, borderRadius: 180, border: `36px solid ${ring}`, opacity: 0.07 }),
    div({ position: "absolute", right: 40, top: 150, width: 150, height: 150, borderRadius: 75, background: style.accentColor, opacity: 0.2 }),
    div({ position: "absolute", left: -90, bottom: -110, width: 260, height: 260, borderRadius: 130, border: `28px solid ${ring}`, opacity: 0.06 }),
  ]

  const brandRow = div({ alignItems: "center", gap: 20 }, [
    style.showLogo && style.logoDataUri
      ? { type: "img", props: { src: style.logoDataUri, width: 84, height: 84, style: { display: "flex", borderRadius: 16, objectFit: "contain" } } }
      : null,
    div({ flex: 1, fontSize: 38, fontWeight: 800, color: onHero }, style.shopName),
  ].filter(Boolean))

  const eyebrowPill = div(
    { alignSelf: "flex-start", marginTop: 30, padding: "8px 24px", borderRadius: 999, border: `2px solid ${ring}`, fontSize: 22, fontWeight: 700, color: onHero, textTransform: "uppercase", letterSpacing: 3 },
    style.eyebrow,
  )

  const untilLine = [time?.end ? `until ${time.end}` : null, style.showDuration && t.durationLabel ? t.durationLabel : null].filter(Boolean).join("  ·  ")

  const hero = div(
    { position: "relative", flexDirection: "column", padding: "40px 44px 100px", background: heroBg, overflow: "hidden" },
    [
      ...deco,
      brandRow,
      eyebrowPill,
      div({ fontFamily: "Playfair", fontSize: timeFont, fontWeight: 800, color: onHero, lineHeight: 1, marginTop: 26, letterSpacing: -2 }, bigTime),
      untilLine ? div({ fontSize: 30, fontWeight: 700, color: onHero, opacity: 0.85, marginTop: 40 }, untilLine) : null,
      div(
        { alignSelf: "flex-start", marginTop: 26, padding: "12px 30px", borderRadius: 999, background: style.accentColor, color: accentText, fontSize: 30, fontWeight: 800 },
        t.dateLabel,
      ),
    ].filter(Boolean),
  )

  // Service card overlapping the hero.
  const serviceFont = t.serviceName.length > 44 ? 32 : t.serviceName.length > 28 ? 38 : 46
  const price = style.showPrice && t.priceLabel
  const serviceCard = div(
    { margin: "-64px 36px 0", background: "#ffffff", borderRadius: 30, boxShadow: "0 18px 40px -12px rgba(15,23,42,0.35)", overflow: "hidden" },
    [
      div({ width: 14, background: style.accentColor }),
      div({ flex: 1, alignItems: "center", gap: 24, padding: "26px 30px" }, [
        div({ flexDirection: "column", flex: 1 }, [
          div({ fontSize: 19, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 2.5 }, "Service"),
          div({ fontFamily: "Playfair", fontSize: serviceFont, fontWeight: 800, color: "#0f172a", marginTop: 6, lineHeight: 1.1 }, t.serviceName),
        ]),
        price
          ? div({ flexDirection: "column", alignItems: "flex-end" }, [
              div({ fontSize: 44, fontWeight: 800, color: "#0f172a" }, t.priceLabel),
              t.balanceLabel ? div({ fontSize: 20, fontWeight: 700, color: "#64748b", marginTop: 4 }, `Balance due: ${t.balanceLabel}`) : null,
            ].filter(Boolean))
          : null,
      ].filter(Boolean)),
    ],
  )

  // Details beside the QR.
  const fields: Node[] = []
  if (t.customerName) fields.push(field("Guest", t.customerName))
  if (style.showAddress && t.address) fields.push(field("Where", t.address))
  if (style.showPhone && t.phone) fields.push(field("Phone", t.phone))
  if (style.showReference) fields.push(field("Reference", t.reference))

  const qrBox: Node | null =
    style.showQr && qrDataUrl
      ? div(
          { flexDirection: "column", alignItems: "center", alignSelf: "flex-start", padding: 14, borderRadius: 28, background: "#ffffff", border: `4px solid ${style.accentColor}` },
          { type: "img", props: { src: qrDataUrl, width: 290, height: 290 } },
        )
      : null

  const body = div({ gap: 36, padding: "34px 44px 8px", alignItems: "flex-start" }, [
    fields.length > 0 ? div({ flexDirection: "column", flex: 1, paddingTop: 4 }, fields) : div({ flex: 1 }),
    qrBox,
  ].filter(Boolean))

  const footer = style.footerText
    ? div({ margin: "6px 44px 0", padding: "16px 30px", borderRadius: 22, background: style.accentColor, color: accentText, fontSize: 26, fontWeight: 700, justifyContent: "center", textAlign: "center" }, style.footerText)
    : null

  const poweredBy = style.showPoweredBy
    ? div({ justifyContent: "center", padding: "22px 0 22px", fontSize: 20, color: "#64748b", fontWeight: 600 }, [
        { type: "span", props: { style: { display: "flex", marginRight: 8 }, children: "Powered by" } },
        { type: "span", props: { style: { display: "flex", color: "#111827", fontWeight: 700 }, children: "ZozoApp" } },
      ])
    : div({ height: 24 })

  const card = div(
    { width: 800, flexDirection: "column", background: "#ffffff", fontFamily: "Inter", borderRadius: 36, overflow: "hidden", boxShadow: "0 30px 60px -20px rgba(0,0,0,0.28)" },
    [hero, serviceCard, body, footer, poweredBy].filter(Boolean),
  )

  return div({ width: 880, flexDirection: "column", background: "#f4f6fa", padding: 40 }, card)
}

/**
 * Renders the ticket card to a PNG buffer (880px layout, rasterised at 1320px
 * wide so it stays sharp when WhatsApp compresses it).
 */
export async function renderBookingTicketPng(style: ResolvedTicketStyle, ticket: RenderableTicket): Promise<Buffer> {
  if (style.layout !== "modern") return renderBookingTicketPngClassic(style, ticket)
  const qrDataUrl = style.showQr
    ? await QRCode.toDataURL(ticket.qrValue, { errorCorrectionLevel: "M", margin: 1, width: 800 })
    : null

  const tree = buildTree(style, ticket, qrDataUrl)

  // satori's types expect React elements; the plain-object tree has the same
  // runtime shape, so we tell TS to trust it (same approach as the old generators).
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: 880,
    fonts: loadFonts(),
  })

  return new Resvg(svg, { fitTo: { mode: "width", value: 1320 } }).render().asPng()
}
