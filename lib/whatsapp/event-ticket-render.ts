// lib/whatsapp/event-ticket-render.ts
/**
 * Event Ticket Card — PURE renderer
 * ---------------------------------
 * Layout: compact branded header, a calendar-style DATE block next to the event name and ticket type,
 * info tiles (time / where), chips (price, admits), a perforated tear line, then the QR code with the
 * guest and ticket number. Same engine, fonts and canvas (880px, rasterised at 1320px) as the other tickets.
 * Like them it does no database / Storage / network work: everything is passed in, already formatted.
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

// satori nodes are plain { type, props } objects, so this file needs no JSX/.tsx.
type Node = { type: string; props: Record<string, unknown> }

const div = (style: Record<string, unknown>, children?: unknown): Node => ({
  type: "div",
  props: { style: { display: "flex", ...style }, ...(children === undefined ? {} : { children }) },
})

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
// Layout
// ----------------------------------------------------------------------------

/** Under the QR code when the shop hasn't set its own footer line. */
const DEFAULT_FOOTER = "Show this QR code at the gate"

function tile(label: string, value: string, flex = 1): Node {
  return div(
    { flexDirection: "column", flex, background: "#f8fafc", border: "1px solid #e8edf4", borderRadius: 22, padding: "18px 24px" },
    [
      div({ fontSize: 20, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 2.5 }, label),
      div({ fontSize: 32, fontWeight: 700, color: "#1e293b", marginTop: 6 }, value),
    ],
  )
}

function chip(label: string, value: string, bg: string, fg: string): Node {
  return div({ alignItems: "center", gap: 12, background: bg, borderRadius: 999, padding: "12px 26px" }, [
    div({ fontSize: 22, fontWeight: 700, color: fg, opacity: 0.8, textTransform: "uppercase", letterSpacing: 1.5 }, label),
    div({ fontSize: 30, fontWeight: 800, color: fg }, value),
  ])
}

/** "Sat, 17 Oct 2026" -> { dow: "SAT", day: "17", month: "OCT" }; null when the label has another shape. */
function dateParts(label: string): { dow: string; day: string; month: string } | null {
  const m = /^([A-Za-z]{3,9}),?\s+(\d{1,2})\s+([A-Za-z]{3,9})/.exec(label.trim())
  return m ? { dow: m[1].slice(0, 3).toUpperCase(), day: m[2], month: m[3].slice(0, 3).toUpperCase() } : null
}

function buildTree(style: ResolvedTicketStyle, t: RenderableEventTicket, qrDataUrl: string): Node {
  const light = style.headerStyle === "light"
  const headerBg =
    style.headerStyle === "gradient"
      ? `linear-gradient(135deg, ${style.headerColor} 0%, ${shade(style.headerColor, -0.35)} 100%)`
      : light
        ? "#ffffff"
        : style.headerColor
  const onHeader = light ? style.headerColor : readableOn(style.headerColor)
  const accentText = readableOn(style.accentColor)
  const canvasBg = "#f4f6fa"

  const header = div(
    { alignItems: "center", gap: 22, padding: "30px 44px", background: headerBg, borderBottom: light ? "1px solid #eef2f8" : "none" },
    [
      style.showLogo && style.logoDataUri
        ? { type: "img", props: { src: style.logoDataUri, width: 84, height: 84, style: { display: "flex", borderRadius: 16, objectFit: "contain" } } }
        : null,
      div({ flexDirection: "column", flex: 1 }, [
        div({ fontSize: 38, fontWeight: 800, color: onHeader }, style.shopName),
        div({ fontSize: 22, fontWeight: 700, color: onHeader, opacity: 0.85, textTransform: "uppercase", letterSpacing: 3, marginTop: 4 }, style.eyebrow),
      ]),
    ].filter(Boolean),
  )

  // Calendar-style date block (falls back to a big "ADMIT" mark when the date label has another shape).
  const parts = dateParts(t.dateLabel)
  const dateBlock = div(
    {
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      width: 210,
      height: 230,
      borderRadius: 40,
      background: `linear-gradient(145deg, ${style.accentColor} 0%, ${shade(style.accentColor, -0.22)} 100%)`,
      color: accentText,
    },
    parts
      ? [
          div({ fontSize: 26, fontWeight: 800, textTransform: "uppercase", letterSpacing: 5, opacity: 0.85 }, parts.dow),
          div({ fontFamily: "Playfair", fontSize: 112, fontWeight: 800, lineHeight: 1 }, parts.day),
          div({ fontSize: 30, fontWeight: 800, textTransform: "uppercase", letterSpacing: 6, opacity: 0.9 }, parts.month),
        ]
      : [div({ fontFamily: "Playfair", fontSize: 54, fontWeight: 800 }, "ADMIT")],
  )

  const nameFont = t.eventName.length > 40 ? 34 : t.eventName.length > 26 ? 42 : 50
  const tierPill = div(
    { alignSelf: "flex-start", marginTop: 16, padding: "8px 22px", borderRadius: 999, border: `3px solid ${style.accentColor}`, fontSize: 26, fontWeight: 800, color: "#0f172a", textTransform: "uppercase", letterSpacing: 2 },
    t.tierName,
  )
  const hero = div({ alignItems: "center", gap: 32, padding: "36px 44px 8px" }, [
    dateBlock,
    div({ flexDirection: "column", flex: 1 }, [
      div({ fontFamily: "Playfair", fontSize: nameFont, fontWeight: 800, color: "#0f172a", lineHeight: 1.1 }, t.eventName),
      tierPill,
    ]),
  ])

  const info: Node[] = []
  if (t.timeLabel) info.push(div({ gap: 16 }, [tile("Time", t.timeLabel), ...(parts ? [] : [tile("Date", t.dateLabel)])]))
  else if (!parts) info.push(div({ gap: 16 }, [tile("Date", t.dateLabel)]))
  if (style.showAddress && t.location) info.push(div({ gap: 16 }, [tile("Where", t.location)]))

  const chips: Node[] = []
  if (style.showPrice && t.priceLabel) chips.push(chip("Price", t.priceLabel, "#f1f5f9", "#0f172a"))
  if (t.entriesLabel) chips.push(chip("Entry", t.entriesLabel, style.accentColor, accentText))
  const body = div({ flexDirection: "column", gap: 16, padding: "20px 44px 8px" }, [...info, chips.length > 0 ? div({ gap: 14, flexWrap: "wrap" }, chips) : null].filter(Boolean))

  // Tear line with the two half-circle notches.
  const tear = div({ position: "relative", height: 44, alignItems: "center", marginTop: 14 }, [
    div({ position: "absolute", left: -22, top: 0, width: 44, height: 44, borderRadius: 22, background: canvasBg }),
    div({ position: "absolute", right: -22, top: 0, width: 44, height: 44, borderRadius: 22, background: canvasBg }),
    div({ flex: 1, margin: "0 40px", borderTop: "3px dashed #d7dee9" }),
  ])

  const who: Node[] = []
  if (t.customerName) who.push(div({ fontSize: 34, fontWeight: 800, color: "#0f172a" }, t.customerName))
  const sub = [style.showReference ? t.ticketLabel : null, style.showPhone ? t.phone : null].filter(Boolean).join("  ·  ")
  if (sub) who.push(div({ fontSize: 26, fontWeight: 700, color: "#64748b", letterSpacing: 1 }, sub))

  // The QR is the entry pass, so unlike the booking ticket it is always drawn (style.showQr is ignored).
  const qrSection = div({ flexDirection: "column", alignItems: "center", padding: "14px 44px 30px", background: "#ffffff" }, [
    div({ background: "#ffffff", padding: 14, borderRadius: 26, border: "2px solid #e8edf4" }, { type: "img", props: { src: qrDataUrl, width: 400, height: 400 } }),
    who.length > 0 ? div({ flexDirection: "column", alignItems: "center", gap: 6, marginTop: 24 }, who) : null,
    div(
      { marginTop: 22, padding: "12px 30px", borderRadius: 999, background: style.accentColor, color: accentText, fontSize: 25, fontWeight: 700, letterSpacing: 0.5 },
      style.footerText || DEFAULT_FOOTER,
    ),
  ].filter(Boolean))

  const poweredBy: Node | null = style.showPoweredBy
    ? div({ justifyContent: "center", padding: "0 0 22px", fontSize: 20, color: "#64748b", fontWeight: 600, background: "#ffffff" }, [
        { type: "span", props: { style: { display: "flex", marginRight: 8 }, children: "Powered by" } },
        { type: "span", props: { style: { display: "flex", color: "#111827", fontWeight: 700 }, children: "ZozoApp" } },
      ])
    : null

  const card = div(
    { width: 800, flexDirection: "column", background: "#ffffff", fontFamily: "Inter", borderRadius: 36, overflow: "hidden", boxShadow: "0 30px 60px -20px rgba(0,0,0,0.28)" },
    [header, div({ height: 10, background: style.accentColor }), hero, body, tear, qrSection, poweredBy].filter(Boolean),
  )

  return div({ width: 880, flexDirection: "column", background: canvasBg, padding: 40 }, card)
}

/**
 * Renders the event ticket card to a PNG buffer (880px layout, rasterised at 1320px wide, exactly
 * like the other tickets, so they are all the same size).
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
