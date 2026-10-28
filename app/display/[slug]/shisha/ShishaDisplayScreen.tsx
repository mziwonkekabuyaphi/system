"use client"

// app/display/[slug]/shisha/ShishaDisplayScreen.tsx
/**
 * Ambient, non-interactive status board for a TV in the shisha lounge: one card
 * per device with a coal ring that drains as the session runs. Built the same
 * way as the queue display:
 *   - theme tokens + contrast helpers come from ../displayTheme, so any
 *     admin-chosen background stays readable (text colour is never picked by hand);
 *   - polls fetchShishaDisplayData() every POLL_MS, so settings, sessions and
 *     the flavour menu catch up without anyone touching the TV;
 *   - the "time's up" takeover reuses ../CallAlertOverlay.
 *
 * Timers are NOT polled: they tick locally each second from the stored anchor,
 * corrected by the server/TV clock difference.
 *
 * Status colours are fixed on purpose (blue = running, amber = refill, red =
 * overdue, violet = paused, green = free): they carry meaning at a glance, so
 * they're only nudged for contrast, never recoloured by the brand.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"

import {
  DISPLAY_TICKER_DEFAULT,
  DISPLAY_TITLE_DEFAULT,
  SHISHA_DISPLAY_LABEL_DEFAULTS,
  type ShishaDisplayLabelKey,
} from "@/app/admin/shisha/shisha-display-types"
import { deriveDisplayStatus, type ShishaDisplayStatus } from "@/app/admin/shisha/shisha-types"
import { CallAlertOverlay, type CallAlertEntry } from "../CallAlertOverlay"
import { DEFAULT_ACCENT, DEFAULT_SECONDARY, ensureContrast, hexToRgba, mixHex, resolveThemeTokens } from "../displayTheme"
import { ShishaLoungeView } from "./ShishaLoungeView"
import {
  STATUS_BASE,
  URGENCY_RANK,
  formatPrice,
  timerText,
  type CardState,
  type CardView,
} from "./shisha-display-shared"
import {
  fetchShishaDisplayData,
  type ShishaDisplayData,
  type ShishaDisplayDevice,
  type ShishaDisplayFailure,
} from "./actions"

const POLL_MS = 10_000

/** Picks columns/rows and ring size so every device fits on one screen with no
 *  scrolling (a TV can't be scrolled). Sizes assume a 16:9 screen; the ring is
 *  also capped by vh so wider/narrower screens never overflow. */
function pickLayout(count: number, hasStats: boolean, hasTicker: boolean) {
  const n = Math.max(count, 1)
  const availH = 72 - (hasStats ? 14 : 0) - (hasTicker ? 8 : 0) // vh left for the grid
  let best = { cols: 1, rows: n, horizontal: false, ringVw: 0 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cardW = 88 / cols - 1 // vw
    const cardH = (availH / rows - 1.2) * 0.5625 // vh -> vw
    if (cardW <= 0 || cardH <= 0) continue
    const stacked = Math.min(cardW * 0.66, cardH * 0.5)
    const sideBySide = Math.min(cardW * 0.42, cardH * 0.78)
    const ringVw = Math.min(Math.max(stacked, sideBySide), 15)
    if (ringVw > best.ringVw + 0.01) best = { cols, rows, horizontal: sideBySide > stacked, ringVw }
  }
  return best
}

export function ShishaDisplayScreen({ slug, initialData }: { slug: string; initialData: ShishaDisplayData }) {
  const [data, setData] = useState<ShishaDisplayData>(initialData)
  const [online, setOnline] = useState(true)
  const [blocked, setBlocked] = useState<ShishaDisplayFailure | null>(null)
  // Starts at the server's clock so the first client render matches the server render.
  const [nowMs, setNowMs] = useState(initialData.serverNow)
  const [mounted, setMounted] = useState(false)
  const offsetRef = useRef(0) // serverNow - TV clock

  useEffect(() => {
    offsetRef.current = data.serverNow - Date.now()
  }, [data.serverNow])

  useEffect(() => {
    setMounted(true)
    const id = setInterval(() => setNowMs(Date.now() + offsetRef.current), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const result = await fetchShishaDisplayData(slug)
        if (result.ok) {
          setData(result.data)
          setBlocked(null)
          setOnline(true)
        } else if (result.reason === "error") {
          // Keep the last good data rather than blank an unattended screen over a blip.
          setOnline(false)
        } else {
          setBlocked(result.reason)
        }
      } catch {
        setOnline(false)
      }
    }, POLL_MS)
    return () => clearInterval(id)
  }, [slug])

  const { settings, timing } = data

  // ---- Rotate layout: alternate Board / Lounge, each for its own number of seconds ----
  const [rotIndex, setRotIndex] = useState(0)
  const rotating = settings.layout === "rotate"
  const effectiveLayout: "board" | "lounge" = rotating ? (rotIndex === 0 ? "board" : "lounge") : settings.layout === "lounge" ? "lounge" : "board"
  const rotateSeconds = rotIndex === 0 ? settings.rotateBoardSeconds : settings.rotateLoungeSeconds
  useEffect(() => {
    if (!rotating) return
    const id = setTimeout(() => setRotIndex((i) => (i + 1) % 2), rotateSeconds * 1000)
    return () => clearTimeout(id)
  }, [rotating, rotIndex, rotateSeconds])
  const label = (key: ShishaDisplayLabelKey) => settings.labels[key]?.trim() || SHISHA_DISPLAY_LABEL_DEFAULTS[key]
  const coalSeconds = timing.coalDurationMinutes * 60

  const allViews = useMemo<CardView[]>(() => {
    return data.devices.map((device) => {
      const s = device.session
      if (!s) return { device, state: device.state === "maintenance" ? "maintenance" : "available", raw: null, pct: 0 }
      const elapsed = s.paused ? 0 : Math.max(Math.floor((nowMs - new Date(s.lastRefillTime).getTime()) / 1000), 0)
      const raw = s.remainingSeconds - elapsed
      const state = deriveDisplayStatus(Math.max(raw, 0), s.paused, timing.refillThresholdMinutes)
      const pct = state === "expired" ? 100 : Math.min(100, Math.max(0, (raw / coalSeconds) * 100))
      return { device, state, raw, pct }
    })
  }, [data.devices, nowMs, timing.refillThresholdMinutes, coalSeconds])

  const counts = useMemo(() => {
    const c: Record<CardState, number> = { active: 0, refill: 0, expired: 0, paused: 0, available: 0, maintenance: 0 }
    for (const v of allViews) c[v.state] += 1
    return c
  }, [allViews])

  const views = useMemo(() => {
    const shown = settings.showFreeDevices ? allViews : allViews.filter((v) => v.state !== "available")
    return [...shown].sort((a, b) => {
      if (settings.sort === "urgency" && a.state !== b.state) return URGENCY_RANK[a.state] - URGENCY_RANK[b.state]
      if (settings.sort === "urgency" && a.raw !== null && b.raw !== null && a.raw !== b.raw) return a.raw - b.raw
      return a.device.code.localeCompare(b.device.code, undefined, { numeric: true })
    })
  }, [allViews, settings.showFreeDevices, settings.sort])

  // ---- "Time's up" full-screen alert (same idea as the queue call alert) ----
  // A session counts as new when it turns overdue and we haven't seen it overdue
  // before. The first data this tab sees is recorded, never alerted, so a reload
  // doesn't replay old ones. Several at once show one after another.
  const viewsRef = useRef(allViews)
  viewsRef.current = allViews
  const expiredKey = allViews
    .filter((v) => v.state === "expired")
    .map((v) => v.device.id)
    .sort()
    .join(",")
  const seenRef = useRef<Set<string> | null>(null)
  const [alertQueue, setAlertQueue] = useState<CallAlertEntry[]>([])
  const alertEnabled = settings.timeUpAlertEnabled
  const alertSeconds = settings.timeUpAlertSeconds

  useEffect(() => {
    const ids = new Set(expiredKey ? expiredKey.split(",") : [])
    const seen = seenRef.current
    seenRef.current = ids
    if (seen === null) return
    const fresh = alertEnabled ? [...ids].filter((id) => !seen.has(id)) : []
    setAlertQueue((q) => {
      if (!alertEnabled) return q.length === 0 ? q : []
      const added: CallAlertEntry[] = fresh.flatMap((id) => {
        const v = viewsRef.current.find((x) => x.device.id === id)
        if (!v) return []
        const s = v.device.session
        return [
          {
            id,
            ticketNumber: v.device.code,
            customerName: s?.flavour ?? s?.firstName ?? v.device.name ?? v.device.code,
            serviceName: v.device.station,
          },
        ]
      })
      // Drop alerts whose session was refilled or ended before its turn came up.
      return [...q, ...added].filter((a) => ids.has(a.id))
    })
  }, [expiredKey, alertEnabled])

  const activeAlert = alertQueue[0] ?? null
  const activeAlertId = activeAlert?.id ?? null
  useEffect(() => {
    if (!activeAlertId) return
    const id = setTimeout(() => setAlertQueue((q) => q.slice(1)), alertSeconds * 1000)
    return () => clearTimeout(id)
  }, [activeAlertId, alertSeconds])

  // ---- Theme ----
  const theme = resolveThemeTokens(settings.theme, settings.backgroundColor)
  const accent = ensureContrast(data.branding.primaryColor || DEFAULT_ACCENT, theme.bgSolid, theme.fg, 3)
  const secondary = ensureContrast(data.branding.secondaryColor || DEFAULT_SECONDARY, theme.bgSolid, theme.fg, 3)
  const statusColor = (s: CardState) => ensureContrast(STATUS_BASE[s], theme.bgSolid, theme.fg, 3)
  const cardBg = mixHex(theme.bgSolid, theme.fg, 0.07)
  const brandName = data.branding.displayName?.trim() || "Welcome"
  const title = settings.title?.trim() || DISPLAY_TITLE_DEFAULT

  const alertOverlay = activeAlert ? (
    <CallAlertOverlay
      key={activeAlert.id}
      entry={activeAlert}
      label={label("timeUp")}
      seconds={alertSeconds}
      accent={accent}
      bg={theme.bgCss}
      fg={theme.fg}
    />
  ) : null

  const layout = pickLayout(views.length, settings.showStats, settings.showTicker)
  const ringCss = `min(${layout.ringVw.toFixed(2)}vw, ${(layout.ringVw / 0.5625).toFixed(2)}vh)`

  const tickerItems = useMemo(() => {
    const items: string[] = [settings.tickerText?.trim() || DISPLAY_TICKER_DEFAULT]
    for (const m of data.menu) items.push(`${m.name}  ${formatPrice(m.price, data.currency)}`)
    return items
  }, [settings.tickerText, data.menu, data.currency])

  const clock = mounted ? new Date(nowMs) : null

  const stage = {
    "--bg": theme.bgCss,
    "--fg": theme.fg,
    "--fg-70": hexToRgba(theme.fg, 0.7),
    "--fg-55": hexToRgba(theme.fg, 0.55),
    "--fg-28": hexToRgba(theme.fg, 0.28),
    "--accent": accent,
    "--card": cardBg,
    "--track": hexToRgba(theme.fg, 0.12),
    "--c-active": statusColor("active"),
    "--c-refill": statusColor("refill"),
    "--c-expired": statusColor("expired"),
    "--c-paused": statusColor("paused"),
    "--c-available": statusColor("available"),
    "--c-maintenance": statusColor("maintenance"),
    "--cols": layout.cols,
    "--rows": layout.rows,
    "--ring": ringCss,
    "--ticker-s": `${Math.max(24, tickerItems.length * 7)}s`,
  } as CSSProperties

  if (effectiveLayout === "lounge") {
    return (
      <>
        {alertOverlay}
        <Fade key="lounge">
        <ShishaLoungeView
          data={data}
          views={views}
          allViews={allViews}
          counts={counts}
          online={online}
          blocked={blocked}
          nowMs={nowMs}
          mounted={mounted}
          label={label}
          theme={theme}
          accent={accent}
          secondary={secondary}
          statusColor={statusColor}
          tickerItems={tickerItems}
        />
        </Fade>
      </>
    )
  }

  const statItems: Array<{ state: CardState; key: ShishaDisplayLabelKey }> = [
    { state: "active", key: "active" },
    { state: "refill", key: "refill" },
    { state: "expired", key: "expired" },
    { state: "paused", key: "paused" },
    { state: "available", key: "available" },
  ]

  return (
    <>
      {alertOverlay}

      <Fade key="board">
      <div className="stage" style={stage}>
        {blocked ? (
          <p className="blocked">
            {blocked === "screen_off"
              ? "The shisha display is switched off."
              : blocked === "shisha_off"
                ? "Shisha isn't switched on."
                : "This screen is no longer available."}
          </p>
        ) : (
          <>
        <header className="head">
          <div className="brand">
            {data.branding.logoUrl ? (
              <span className="logo">
                {/* eslint-disable-next-line @next/next/no-img-element -- external Storage URL */}
                <img src={data.branding.logoUrl} alt="" />
              </span>
            ) : (
              <span className="monogram" aria-hidden="true">
                {brandName.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="brand-text">
              <h1>{brandName}</h1>
              <p>{title}</p>
            </div>
          </div>

          <div className="head-right">
            <span className={`pill ${online ? "on" : "off"}`}>
              <span className="pill-dot" aria-hidden="true" />
              {online ? label("live") : label("offline")}
            </span>
            {settings.showClock && (
              <div className="clock">
                <span className="clock-time">
                  {clock ? clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--"}
                </span>
                <span className="clock-date">
                  {clock ? clock.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) : ""}
                </span>
              </div>
            )}
          </div>
        </header>

        {settings.showStats && (
          <section className="stats" aria-label="Summary">
            {statItems.map((s) => (
              <div key={s.state} className="stat" style={{ "--sc": `var(--c-${s.state})` } as CSSProperties}>
                <span className="stat-num">{counts[s.state]}</span>
                <span className="stat-label">{label(s.key)}</span>
              </div>
            ))}
          </section>
        )}

        {views.length === 0 ? (
          <p className="empty">{label("empty")}</p>
        ) : (
          <section className="grid">
            {views.map(({ device, state, raw, pct }) => {
              const s = device.session
              const timer = timerText(raw)
              const meta = [s?.flavour, s?.firstName, device.station, device.name].filter(
                (m): m is string => Boolean(m && m.trim()),
              )
              return (
                <article
                  key={device.id}
                  className={`card ${state}${layout.horizontal ? " side" : ""}`}
                  style={{ "--sc": `var(--c-${state})`, "--pct": pct } as CSSProperties}
                >
                  <div className="ring">
                    {timer !== null ? (
                      <span className="timer">{timer}</span>
                    ) : state === "available" ? (
                      <span className="flame" aria-hidden="true" />
                    ) : (
                      <span className="dash" aria-hidden="true" />
                    )}
                  </div>
                  <div className="info">
                    <p className="code">{device.code}</p>
                    <p className="chip">{label(state)}</p>
                    {meta.slice(0, 2).map((m, i) => (
                      <p key={i} className={i === 0 && s?.flavour ? "meta strong" : "meta"}>
                        {m}
                      </p>
                    ))}
                  </div>
                </article>
              )
            })}
          </section>
        )}

        {settings.showTicker && (
          <footer className="ticker" aria-hidden="true">
            <div className="track">
              {[0, 1].map((copy) => (
                <div key={copy} className="run">
                  {tickerItems.map((t, i) => (
                    <span key={`${copy}-${i}`} className={i === 0 ? "t-msg" : "t-item"}>
                      {t}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </footer>
        )}

          </>
        )}

      <style jsx global>{`
        @import url("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600&display=swap");
        html,
        body {
          margin: 0;
          padding: 0;
          background: ${theme.bgSolid};
        }
      `}</style>

      <style jsx>{`
        .stage {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          gap: 2vh;
          padding: 4vh 4vw;
          box-sizing: border-box;
          overflow: hidden;
          background: var(--bg);
          color: var(--fg);
          font-family: "Inter", -apple-system, sans-serif;
        }
        .blocked {
          margin: auto;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.6rem, 3vw, 2.6rem);
          color: var(--fg-70);
        }

        /* ---- header ---- */
        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 2vw;
          flex: none;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 1.4vw;
          min-width: 0;
        }
        .logo,
        .monogram {
          flex: none;
          width: 8vh;
          height: 8vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .logo {
          padding: 0.8vh;
          box-sizing: border-box;
          background: #ffffff; /* keeps transparent / dark logos readable */
          border-radius: 2vh;
        }
        .logo img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .monogram {
          border-radius: 50%;
          border: 2px solid var(--accent);
          color: var(--accent);
          font-family: "Bricolage Grotesque", sans-serif;
          font-weight: 700;
          font-size: 3.6vh;
        }
        .brand-text {
          min-width: 0;
        }
        .brand-text h1 {
          margin: 0;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.8rem, 3.4vw, 3.2rem);
          font-weight: 700;
          letter-spacing: -0.01em;
          line-height: 1.05;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .brand-text p {
          margin: 0.4vh 0 0;
          font-size: clamp(0.95rem, 1.5vw, 1.4rem);
          color: var(--fg-70);
        }
        .head-right {
          display: flex;
          align-items: center;
          gap: 2vw;
          flex: none;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 0.6vw;
          padding: 0.7vh 1.2vw;
          border-radius: 999px;
          border: 1px solid var(--fg-28);
          font-size: clamp(0.8rem, 1.2vw, 1.1rem);
          font-weight: 500;
          color: var(--fg-70);
        }
        .pill-dot {
          width: 0.9vh;
          height: 0.9vh;
          border-radius: 50%;
          background: var(--c-available);
        }
        .pill.on .pill-dot {
          animation: blink 1.6s ease-in-out infinite;
        }
        .pill.off .pill-dot {
          background: var(--c-refill);
        }
        .clock {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
        }
        .clock-time {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.6rem, 3vw, 2.8rem);
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .clock-date {
          margin-top: 0.4vh;
          font-size: clamp(0.8rem, 1.2vw, 1.1rem);
          color: var(--fg-55);
        }

        /* ---- stats strip ---- */
        .stats {
          display: flex;
          flex: none;
          border-top: 1px solid var(--fg-28);
          border-bottom: 1px solid var(--fg-28);
        }
        .stat {
          flex: 1;
          display: flex;
          align-items: baseline;
          justify-content: center;
          gap: 0.8vw;
          padding: 1.4vh 0.5vw;
        }
        .stat + .stat {
          border-left: 1px solid var(--fg-28);
        }
        .stat-num {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.8rem, 3.2vw, 3rem);
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--sc);
        }
        .stat-label {
          font-size: clamp(0.85rem, 1.3vw, 1.2rem);
          color: var(--fg-70);
        }

        /* ---- device grid ---- */
        .grid {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
          grid-template-rows: repeat(var(--rows), minmax(0, 1fr));
          gap: 1.2vh 1vw;
        }
        .empty {
          margin: auto;
          font-size: clamp(1.2rem, 2vw, 1.8rem);
          color: var(--fg-70);
        }
        .card {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: calc(var(--ring) * 0.07);
          min-height: 0;
          min-width: 0;
          padding: calc(var(--ring) * 0.1);
          box-sizing: border-box;
          overflow: hidden;
          text-align: center;
          background: var(--card);
          border: 1px solid var(--fg-28);
          border-radius: calc(var(--ring) * 0.18);
        }
        .card.side {
          flex-direction: row;
          justify-content: flex-start;
          gap: calc(var(--ring) * 0.16);
          padding-left: calc(var(--ring) * 0.14);
          text-align: left;
        }
        .card.refill,
        .card.expired {
          border-color: var(--sc);
        }
        .card.refill {
          animation: cardPulse 2s ease-in-out infinite;
        }
        .info {
          display: flex;
          flex-direction: column;
          align-items: inherit;
          min-width: 0;
          max-width: 100%;
          gap: calc(var(--ring) * 0.03);
        }
        .card.side .info {
          align-items: flex-start;
        }
        .code {
          margin: 0;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: max(13px, calc(var(--ring) * 0.17));
          font-weight: 600;
          line-height: 1.1;
          white-space: nowrap;
        }
        .chip {
          margin: 0;
          font-size: max(11px, calc(var(--ring) * 0.115));
          font-weight: 600;
          color: var(--sc);
          white-space: nowrap;
        }
        .meta {
          margin: 0;
          max-width: 100%;
          font-size: max(11px, calc(var(--ring) * 0.115));
          color: var(--fg-70);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .meta.strong {
          color: var(--fg);
          font-weight: 600;
        }

        /* The coal ring: fills with the share of the session still left. */
        .ring {
          position: relative;
          flex: none;
          display: flex;
          align-items: center;
          justify-content: center;
          width: var(--ring);
          height: var(--ring);
          border-radius: 50%;
          background: conic-gradient(var(--sc) calc(var(--pct) * 1%), var(--track) 0);
        }
        .ring::before {
          content: "";
          position: absolute;
          inset: 9%;
          border-radius: 50%;
          background: var(--card);
        }
        .card.expired .ring {
          animation: emberPulse 1.4s ease-in-out infinite;
        }
        .card.available .ring,
        .card.maintenance .ring {
          background: none;
          box-sizing: border-box;
          border: calc(var(--ring) * 0.03) solid var(--sc);
          opacity: 0.8;
        }
        .card.maintenance .ring {
          border-style: dashed;
        }
        .card.available .ring::before,
        .card.maintenance .ring::before {
          display: none;
        }
        .timer {
          position: relative;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: max(12px, calc(var(--ring) * 0.2));
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--sc);
        }
        .flame {
          width: 26%;
          height: 30%;
          background: var(--sc);
          clip-path: polygon(50% 0%, 78% 35%, 68% 100%, 32% 100%, 22% 35%);
          animation: flicker 2.6s ease-in-out infinite;
        }
        .dash {
          width: 26%;
          height: 3px;
          background: var(--sc);
          border-radius: 2px;
        }

        /* ---- ticker ---- */
        .ticker {
          flex: none;
          overflow: hidden;
          white-space: nowrap;
          border-top: 1px solid var(--fg-28);
          padding-top: 1.6vh;
          mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent);
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent);
        }
        .track {
          display: inline-flex;
          animation: scroll var(--ticker-s) linear infinite;
        }
        .run {
          display: inline-flex;
          flex: none;
          gap: 4vw;
          padding-right: 4vw;
          font-size: clamp(1rem, 1.6vw, 1.5rem);
        }
        .t-msg {
          color: var(--fg);
          font-weight: 600;
        }
        .t-item {
          color: var(--fg-70);
        }

        @keyframes blink {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.35;
          }
        }
        @keyframes cardPulse {
          0%,
          100% {
            box-shadow: 0 0 0 transparent;
          }
          50% {
            box-shadow: 0 0 2.2vh var(--sc);
          }
        }
        @keyframes emberPulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.55;
          }
        }
        @keyframes flicker {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.75;
            transform: scale(0.94);
          }
        }
        @keyframes scroll {
          to {
            transform: translateX(-50%);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .track,
          .card.refill,
          .card.expired .ring,
          .flame,
          .pill.on .pill-dot {
            animation: none;
          }
        }
      `}</style>
    
      </div>
      </Fade>
    </>
  )
}

/** Fades a screen in when the rotation swaps it (the key changes, so it remounts). */
function Fade({ children }: { children: ReactNode }) {
  return (
    <div className="fade">
      {children}
      <style jsx>{`
        .fade {
          animation: fadeIn 1.1s ease both;
        }
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fade {
            animation: none;
          }
        }
      `}</style>
    </div>
  )
}
