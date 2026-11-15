// lib/whatsapp/event-ticket-render.ts
/**
 * Event Ticket Card — PURE renderer
 * ---------------------------------
 * Same engine, fonts, canvas (880px, rasterised at 1320px), card width, QR size and look as the
 * booking ticket (booking-ticket-render.ts). Only the rows are event specific. Like that file it
 * does no database / Storage / network work: everything is passed in, already formatted.
 * ticket-image.ts loads the tenant's branding, formats the event and uploads the result.
 *
 * Fonts: reuses the SAME .woff files the booking ticket already ships in lib/whatsapp/fonts/
 * (Inter-Regular, Inter-Bold, Inter-ExtraBold, PlayfairDisplay-ExtraBold). Nothing new to install.
 *
 * Why the helpers below are copies and not imports: booking-ticket-render.ts only exports
 * cleanHex / readableOn / the types. Copying the rest keeps that working file untouched.
 */

import satori from "satori"
import { Resvg } from "@resvg/resvg-js"
import QRCode from "qrcode"
import fs from "fs"
import path from "path"

import { readableOn, type ResolvedTicketStyle } from "@/lib/whatsapp/booking-ticket-render"

const FONT_DIR = path.join(process.cwd(), "lib/whatsapp/fonts")

/** One issued ticket, with every label already formatted for display. */
export interface RenderableEventTicket {
  eventName: string
  /** e.g. "R250" / "Free". null hides the price. */
  priceLabel: string | null
  /** e.g. "Sat, 17 Oct 2026" (tenant's timezone). */
  dateLabel: string
  /** e.g. "19:00 - 23:00" or "19:00". */
  timeLabel: string
  location: string | null
  /** Ticket type, e.g. "VIP" or "General Admission". */
  tierName: string
  /** e.g. "Admits 2". null when it is a single entry. */
  entriesLabel: string | null
  customerName: string | null
  phone: string | null
  /** e.g. "#B0001" or "#B0001 · 1 of 3". */
  ticketLabel: string
  /** The value encoded in the QR code (the ticket's qr_token). */
  qrValue: string
}

// ----------------------------------------------------------------------------
// Colour helpers (same as the booking ticket)
// ----------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** amount < 0 darkens, > 0 lightens (towards white). */
function shade(hex: string, amount: number): string {
  const target = amount < 0 ? 0 : 255
  const t = Math.abs(amount)
  const out = rgb(hex).map((c) => Math.round(c + (target - c) * t))
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

// ----------------------------------------------------------------------------
// Icons (plain SVG paths: satori can't load icon fonts)
// ----------------------------------------------------------------------------

const ICON_PATHS = {
  calendar: "M3 4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4zM3 9h18M8 2v4M16 2v4",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  pin: "M12 22s7-7.58 7-12A7 7 0 0 0 5 10c0 4.42 7 12 7 12zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  phone:
    "M6.6 10.8a13 13 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 9 9 0 0 0 2.8.45 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 9 9 0 0 0 .45 2.8 1 1 0 0 1-.24 1z",
  ticket: "M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users:
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  hash: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
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
// Fonts (read once per warm instance; the same files the booking ticket uses)
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
// Layout (mirrors booking-ticket-render.ts buildTree)
// ----------------------------------------------------------------------------

/** Under the QR code when the shop hasn't set its own footer line. */
const DEFAULT_FOOTER = "Show this QR code at the gate"

function buildTree(style: ResolvedTicketStyle, t: RenderableEventTicket, qrDataUrl: string): Node {
  const light = style.headerStyle === "light"
  const headerBg =
    style.headerStyle === "gradient"
      ? `linear-gradient(135deg, ${style.headerColor} 0%, ${shade(style.headerColor, -0.35)} 100%)`
      : light
        ? "#ffffff"
        : style.headerColor
  const onHeader = light ? style.headerColor : readableOn(style.headerColor)
  const onHeaderSoft = light ? "#64748b" : onHeader
  const accentText = readableOn(style.accentColor)
  const iconColor = style.headerColor

  const nameFont = t.eventName.length > 40 ? 34 : t.eventName.length > 26 ? 42 : 50

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
              fontSize: nameFont,
              fontWeight: 800,
              color: onHeader,
              marginTop: 10,
            },
            children: t.eventName,
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

  const rows: Node[] = [detailRow("calendar", t.dateLabel, iconColor)]
  if (t.timeLabel) rows.push(detailRow("clock", t.timeLabel, iconColor))
  if (style.showAddress && t.location) rows.push(detailRow("pin", t.location, iconColor))
  rows.push(detailRow("ticket", t.tierName, iconColor))
  if (t.entriesLabel) rows.push(detailRow("users", t.entriesLabel, iconColor))
  if (t.customerName) rows.push(detailRow("user", t.customerName, iconColor))
  if (style.showPhone && t.phone) rows.push(detailRow("phone", t.phone, iconColor))
  if (style.showReference) rows.push(detailRow("hash", t.ticketLabel, iconColor))

  // The QR is the entry pass, so unlike the booking ticket it is always drawn (style.showQr is ignored).
  const qrSection: Node = {
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
        {
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
            children: style.footerText || DEFAULT_FOOTER,
          },
        },
      ],
    },
  }

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
            background: "#fafbfd",
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
        poweredBy,
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
 * Renders the event ticket card to a PNG buffer (880px layout, rasterised at 1320px wide, exactly
 * like the booking ticket, so the two are the same size).
 */
export async function renderEventTicketPng(style: ResolvedTicketStyle, ticket: RenderableEventTicket): Promise<Buffer> {
  const qrDataUrl = await QRCode.toDataURL(ticket.qrValue, { errorCorrectionLevel: "M", margin: 1, width: 800 })
  const tree = buildTree(style, ticket, qrDataUrl)

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: 880,
    fonts: loadFonts(),
  })

  return new Resvg(svg, { fitTo: { mode: "width", value: 1320 } }).render().asPng()
}
