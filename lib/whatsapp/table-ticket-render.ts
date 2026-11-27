// lib/whatsapp/table-ticket-render.ts
/**
 * Table Pass Card: PURE renderer (satori + resvg), its own layout, not the event ticket's.
 * ---------------------------------------------------------------------------------------
 * A table pass is not an admission ticket, so it is drawn differently: a compact branded header, a big
 * TABLE badge (the table's label) next to the package, info tiles (date / time / place), money chips
 * (paid and bar tab), a perforated tear line, then the QR code with the guest and reference.
 *
 * Same engine, fonts (lib/whatsapp/fonts), canvas (880px layout, 1320px PNG) and ResolvedTicketStyle as the
 * other tickets. Like them it does no database / Storage / network work: everything arrives already formatted.
 */

import satori from "satori"
import { Resvg } from "@resvg/resvg-js"
import QRCode from "qrcode"
import fs from "fs"
import path from "path"

import { readableOn, type ResolvedTicketStyle } from "@/lib/whatsapp/booking-ticket-render"

const FONT_DIR = path.join(process.cwd(), "lib/whatsapp/fonts")

/** One booked table, every label already formatted for display. */
export interface RenderableTablePass {
  /** The tenant's word for a table, e.g. "Table" or "Booth". */
  tableWord: string
  /** e.g. "A3". null when the booking has no named table. */
  tableLabel: string | null
  packageName: string
  eventName: string
  dateLabel: string
  timeLabel: string
  location: string | null
  /** e.g. "6 seats". */
  seatsLabel: string | null
  customerName: string | null
  phone: string | null
  /** e.g. "VIP-4K7Q2M". */
  reference: string
  /** e.g. "R2 500" / "Free". null hides it. */
  paidLabel: string | null
  /** e.g. "R500". null hides it. */
  tabLabel: string | null
  /** The value in the QR code (vvip_bookings.qr_token). */
  qrValue: string
}

type Node = { type: string; props: Record<string, unknown> }

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

const DEFAULT_FOOTER = "Show this QR code at the venue"

const div = (style: Record<string, unknown>, children?: unknown): Node => ({
  type: "div",
  props: { style: { display: "flex", ...style }, ...(children === undefined ? {} : { children }) },
})

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

function buildTree(style: ResolvedTicketStyle, t: RenderableTablePass, qrDataUrl: string): Node {
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

  const label = t.tableLabel ?? "—"
  const labelFont = label.length <= 2 ? 120 : label.length <= 4 ? 88 : label.length <= 7 ? 60 : 42
  const badge = div(
    {
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      width: 230,
      height: 230,
      borderRadius: 40,
      background: `linear-gradient(145deg, ${style.accentColor} 0%, ${shade(style.accentColor, -0.22)} 100%)`,
      color: accentText,
    },
    [
      div({ fontSize: 24, fontWeight: 800, textTransform: "uppercase", letterSpacing: 5, opacity: 0.85 }, t.tableWord.slice(0, 12)),
      div({ fontFamily: "Playfair", fontSize: labelFont, fontWeight: 800, marginTop: 4 }, label),
    ],
  )

  const nameFont = t.packageName.length > 28 ? 34 : t.packageName.length > 16 ? 42 : 50
  const hero = div({ alignItems: "center", gap: 32, padding: "36px 44px 8px" }, [
    badge,
    div({ flexDirection: "column", flex: 1 }, [
      div({ fontFamily: "Playfair", fontSize: nameFont, fontWeight: 800, color: "#0f172a", lineHeight: 1.1 }, t.packageName),
      t.seatsLabel ? div({ fontSize: 28, fontWeight: 700, color: "#64748b", marginTop: 14 }, t.seatsLabel) : null,
      div({ fontSize: 30, fontWeight: 700, color: style.headerColor === "#ffffff" ? "#0f172a" : style.headerColor, marginTop: 14 }, t.eventName),
    ].filter(Boolean)),
  ])

  const info: Node[] = [div({ gap: 16 }, [tile("Date", t.dateLabel, 1.35), ...(t.timeLabel ? [tile("Time", t.timeLabel, 1)] : [])])]
  if (style.showAddress && t.location) info.push(div({ gap: 16 }, [tile("Where", t.location)]))

  const chips: Node[] = []
  if (style.showPrice && t.paidLabel) chips.push(chip("Paid", t.paidLabel, "#f1f5f9", "#0f172a"))
  if (t.tabLabel) chips.push(chip("Bar tab", t.tabLabel, style.accentColor, accentText))
  const money = chips.length > 0 ? div({ gap: 14, flexWrap: "wrap" }, chips) : null

  const body = div({ flexDirection: "column", gap: 16, padding: "20px 44px 8px" }, [...info, money].filter(Boolean))

  // Tear line with the two half-circle notches.
  const tear = div({ position: "relative", height: 44, alignItems: "center", marginTop: 14 }, [
    div({ position: "absolute", left: -22, top: 0, width: 44, height: 44, borderRadius: 22, background: canvasBg }),
    div({ position: "absolute", right: -22, top: 0, width: 44, height: 44, borderRadius: 22, background: canvasBg }),
    div({ flex: 1, margin: "0 40px", borderTop: "3px dashed #d7dee9" }),
  ])

  const who: Node[] = []
  if (t.customerName) who.push(div({ fontSize: 34, fontWeight: 800, color: "#0f172a" }, t.customerName))
  const sub = [style.showReference ? t.reference : null, style.showPhone ? t.phone : null].filter(Boolean).join("  ·  ")
  if (sub) who.push(div({ fontSize: 26, fontWeight: 700, color: "#64748b", letterSpacing: 1 }, sub))

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
    {
      width: 800,
      flexDirection: "column",
      background: "#ffffff",
      fontFamily: "Inter",
      borderRadius: 36,
      overflow: "hidden",
      boxShadow: "0 30px 60px -20px rgba(0,0,0,0.28)",
    },
    [header, div({ height: 10, background: style.accentColor }), hero, body, tear, qrSection, poweredBy].filter(Boolean),
  )

  return div({ width: 880, flexDirection: "column", background: canvasBg, padding: 40 }, card)
}

/** Renders the table pass to a PNG (880px layout, rasterised at 1320px wide like the other tickets). */
export async function renderTablePassPng(style: ResolvedTicketStyle, pass: RenderableTablePass): Promise<Buffer> {
  const qrDataUrl = await QRCode.toDataURL(pass.qrValue, { errorCorrectionLevel: "M", margin: 1, width: 800 })
  const tree = buildTree(style, pass, qrDataUrl)
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], { width: 880, fonts: loadFonts() })
  return new Resvg(svg, { fitTo: { mode: "width", value: 1320 } }).render().asPng()
}
