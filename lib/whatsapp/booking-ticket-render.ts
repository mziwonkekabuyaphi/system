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

const FONT_DIR = path.join(process.cwd(), "lib/whatsapp/fonts")

export type HeaderStyle = "gradient" | "solid" | "light"

/** Everything about HOW the ticket looks and which rows it shows. */
export interface ResolvedTicketStyle {
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
  /** Show a small "Powered by QLess" line (false for tenants who removed it). */
  showPoweredBy: boolean
}

/** The booking itself, with every label already formatted for display. */
export interface RenderableTicket {
  /** Service name(s), already joined, e.g. "Hair Cut + Beard Combo". */
  serviceName: string
  /** Already formatted, e.g. "R250" or "R250.50". null hides the price. */
  priceLabel: string | null
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

// ----------------------------------------------------------------------------
// Icons (satori can't load icon fonts, so these are plain SVG paths)
// ----------------------------------------------------------------------------

const ICON_PATHS = {
  calendar: "M3 4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4zM3 9h18M8 2v4M16 2v4",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  pin: "M12 22s7-7.58 7-12A7 7 0 0 0 5 10c0 4.42 7 12 7 12zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  phone:
    "M6.6 10.8a13 13 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 9 9 0 0 0 2.8.45 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 9 9 0 0 0 .45 2.8 1 1 0 0 1-.24 1z",
  ticket: "M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  timer: "M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
} as const

type IconKind = keyof typeof ICON_PATHS

// satori nodes are plain { type, props } objects, so this file needs no JSX/.tsx.
type Node = { type: string; props: Record<string, unknown> }

function icon(kind: IconKind, color: string, size = 30): Node {
  return {
    type: "svg",
    props: {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      style: { display: "flex" },
      children: {
        type: "path",
        props: {
          d: ICON_PATHS[kind],
          fill: "none",
          stroke: color,
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
      },
    },
  }
}

function detailRow(kind: IconKind, label: string, color: string): Node {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 18,
        fontSize: 30,
        fontWeight: 700,
        color: "#475569",
        padding: "14px 0",
        borderBottom: "1px dashed #e5e9f0",
        width: "100%",
      },
      children: [
        { type: "div", props: { style: { display: "flex", width: 34 }, children: icon(kind, color, 30) } },
        { type: "div", props: { style: { display: "flex", flex: 1 }, children: label } },
      ],
    },
  }
}

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

function buildTree(style: ResolvedTicketStyle, t: RenderableTicket, qrDataUrl: string | null): Node {
  const light = style.headerStyle === "light"
  const headerBg =
    style.headerStyle === "gradient"
      ? `linear-gradient(135deg, ${style.headerColor} 0%, ${shade(style.headerColor, -0.35)} 100%)`
      : light
        ? "#ffffff"
        : style.headerColor
  // Text on the header: brand colour on a light header, auto-contrast otherwise.
  const onHeader = light ? style.headerColor : readableOn(style.headerColor)
  const onHeaderSoft = light ? "#64748b" : onHeader
  const accentText = readableOn(style.accentColor)
  const iconColor = style.headerColor

  const serviceFont = t.serviceName.length > 40 ? 34 : t.serviceName.length > 26 ? 42 : 50

  const brandRow: Node = {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 20, marginBottom: 24 },
      children: [
        style.showLogo && style.logoDataUri
          ? {
              type: "img",
              props: {
                src: style.logoDataUri,
                width: 110,
                height: 110,
                style: { display: "flex", borderRadius: 18, objectFit: "contain" },
              },
            }
          : null,
        {
          type: "div",
          props: {
            style: { display: "flex", flex: 1, fontSize: 44, fontWeight: 800, color: onHeader, letterSpacing: 0.5 },
            children: style.shopName,
          },
        },
      ].filter(Boolean),
    },
  }

  const header: Node = {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", padding: "38px 44px 32px", background: headerBg },
      children: [
        brandRow,
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: 28,
              fontWeight: 700,
              color: onHeaderSoft,
              opacity: light ? 1 : 0.85,
              textTransform: "uppercase",
              letterSpacing: 3,
            },
            children: style.eyebrow,
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontFamily: "Playfair",
              fontSize: serviceFont,
              fontWeight: 800,
              color: onHeader,
              marginTop: 10,
            },
            children: t.serviceName,
          },
        },
        style.showPrice && t.priceLabel
          ? {
              type: "div",
              props: {
                style: { display: "flex", fontSize: 30, fontWeight: 700, color: onHeader, marginTop: 14, opacity: 0.95 },
                children: t.priceLabel,
              },
            }
          : null,
      ].filter(Boolean),
    },
  }

  const rows: Node[] = [detailRow("calendar", t.dateLabel, iconColor), detailRow("clock", t.timeLabel, iconColor)]
  if (style.showDuration && t.durationLabel) rows.push(detailRow("timer", t.durationLabel, iconColor))
  if (t.customerName) rows.push(detailRow("user", t.customerName, iconColor))
  if (style.showAddress && t.address) rows.push(detailRow("pin", t.address, iconColor))
  if (style.showPhone && t.phone) rows.push(detailRow("phone", t.phone, iconColor))
  if (style.showReference) rows.push(detailRow("ticket", `Ref ${t.reference}`, iconColor))

  const qrSection: Node | null =
    style.showQr && qrDataUrl
      ? {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "30px 44px 34px",
              background: "#fafbfd",
              borderTop: "1px solid #eef2f8",
              marginTop: 24,
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    background: "#ffffff",
                    padding: 16,
                    borderRadius: 28,
                    boxShadow: "0 12px 28px rgba(0,0,0,0.12)",
                  },
                  children: { type: "img", props: { src: qrDataUrl, width: 440, height: 440 } },
                },
              },
              style.footerText
                ? {
                    type: "div",
                    props: {
                      style: {
                        display: "flex",
                        marginTop: 26,
                        padding: "12px 30px",
                        borderRadius: 999,
                        background: style.accentColor,
                        color: accentText,
                        fontSize: 26,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                      },
                      children: style.footerText,
                    },
                  }
                : null,
            ].filter(Boolean),
          },
        }
      : null

  // Without a QR, the footer text still deserves a spot.
  const footerOnly: Node | null =
    !qrSection && style.footerText
      ? {
          type: "div",
          props: {
            style: { display: "flex", justifyContent: "center", padding: "26px 44px 34px" },
            children: {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  padding: "12px 30px",
                  borderRadius: 999,
                  background: style.accentColor,
                  color: accentText,
                  fontSize: 26,
                  fontWeight: 700,
                },
                children: style.footerText,
              },
            },
          },
        }
      : null

  const showQrBg = Boolean(qrSection)
  const poweredBy: Node | null = style.showPoweredBy
    ? {
        type: "div",
        props: {
          style: {
            display: "flex",
            justifyContent: "center",
            padding: "0 0 22px",
            fontSize: 20,
            color: "#94a3b8",
            fontWeight: 600,
            // Continue the QR section's background so there is no white strip.
            background: showQrBg ? "#fafbfd" : "#ffffff",
          },
          children: "Powered by QLess",
        },
      }
    : null

  const card: Node = {
    type: "div",
    props: {
      style: {
        width: 800,
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        fontFamily: "Inter",
        borderRadius: 36,
        overflow: "hidden",
        boxShadow: "0 30px 60px -20px rgba(0,0,0,0.28)",
      },
      children: [
        header,
        // Accent stripe between header and body.
        { type: "div", props: { style: { display: "flex", height: 10, background: style.accentColor } } },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", padding: "22px 44px 0", background: "#ffffff" },
            children: rows,
          },
        },
        qrSection,
        footerOnly,
        poweredBy ?? { type: "div", props: { style: { display: "flex", height: qrSection || footerOnly ? 0 : 24 } } },
      ].filter(Boolean),
    },
  }

  return {
    type: "div",
    props: {
      style: { width: 880, display: "flex", flexDirection: "column", background: "#f4f6fa", padding: 40 },
      children: card,
    },
  }
}

/**
 * Renders the ticket card to a PNG buffer (880px layout, rasterised at 1320px
 * wide so it stays sharp when WhatsApp compresses it).
 */
export async function renderBookingTicketPng(style: ResolvedTicketStyle, ticket: RenderableTicket): Promise<Buffer> {
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
