"use client"

// app/display/[slug]/SplitScreen.tsx
/**
 * "Split screen" layout for the Display TV: NOW SERVING big on the left, the
 * people still to come (the back of the line) on the right. Same data, same
 * polling and same call-alert takeover as the other layouts -- DisplayScreen
 * picks this one when settings.layout === "split" and keeps rendering the
 * CallAlertOverlay on top.
 *
 * Everything is driven by the existing Display settings, nothing new is
 * stored:
 *   - header: solid tenant primary colour (text black/white by contrast),
 *     tagline or queue heading as the eyebrow, Live / Reconnecting pill
 *     (wording: liveLabel / offlineLabel).
 *   - left heading = nowServingLabel, right heading = waitingLabel
 *     (default "Still to come"), empty messages = servingEmptyText /
 *     waitingEmptyText.
 *   - other wording: nextUpLabel, guestLabel, servingTimerLabel,
 *     waitingTimerLabel (all null = built-in English default).
 *   - per-entry fields follow the showQueue* toggles (ticket, service, phone,
 *     wait estimate, time waited, booking reference, email, custom answer).
 *   - showQueue off = brand-only screen; showServices = menu ticker along the
 *     bottom (same as the live board). Bookings are not shown in this layout.
 *
 * "Ticket" is DisplayQueueEntry.displayTicket: the queue ticket number, or the
 * booking reference for appointments that have no ticket number.
 */

import { useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import type { DisplayData, DisplayQueueEntry } from "./actions"
import { useAutoScroll } from "./BoardScreen"
import {
  DEFAULT_ACCENT,
  DEFAULT_SECONDARY,
  contrastRatio,
  ensureContrast,
  formatMinutes,
  formatWaitEstimate,
  hexToRgba,
  resolveThemeTokens,
  toRgb,
} from "./displayTheme"

const HEADER_DARK_TEXT = "#171412"

/** Scrolls itself when its content overflows (a TV can't be scrolled by hand). */
function Scroller({ children, className }: { children: ReactNode; className: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useAutoScroll(ref)
  return (
    <div className={className} ref={ref}>
      {children}
    </div>
  )
}

function formatClockTime(date: Date | null): string {
  return date?.toLocaleTimeString([], { hour12: false }) ?? "--:--:--"
}

export function SplitScreen({ data, online }: { data: DisplayData; online: boolean }) {
  const { settings, branding } = data

  // Clock + timers. Start null so server and client first render match.
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const nowMs = now?.getTime() ?? null
  const minsSince = (iso: string) => (nowMs === null ? 0 : Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 60000)))

  const serving = data.queue.filter((q) => q.status === "called")
  const waiting = data.queue.filter((q) => q.status === "waiting")

  const brandName = branding.displayName?.trim() || "Welcome"
  const theme = resolveThemeTokens(settings.theme, settings.backgroundColor)
  const accent = ensureContrast(branding.primaryColor || DEFAULT_ACCENT, theme.bgSolid, theme.fg, 3)
  const secondary = ensureContrast(branding.secondaryColor || DEFAULT_SECONDARY, theme.bgSolid, theme.fg, 3)

  // Header: raw primary colour as a surface, black/white text by contrast.
  // No valid primary colour = a subtle translucent bar instead.
  const headerBg = toRgb(branding.primaryColor) ? (branding.primaryColor as string) : null
  const headerFg = headerBg
    ? contrastRatio(headerBg, "#FFFFFF") >= contrastRatio(headerBg, HEADER_DARK_TEXT)
      ? "#FFFFFF"
      : HEADER_DARK_TEXT
    : null

  const queueTitle = settings.queueTitle?.trim() || "Live queue"
  const nowServingLabel = settings.nowServingLabel?.trim() || "Now serving"
  const waitingLabel = settings.waitingLabel?.trim() || "Still to come"
  const servingEmpty = settings.servingEmptyText?.trim() || "No one is being served right now."
  const waitingEmpty = settings.waitingEmptyText?.trim() || "Nobody waiting right now."
  const menuTitle = settings.menuTitle?.trim() || "On the menu"
  const nextUpLabel = settings.nextUpLabel?.trim() || "Next up"
  const guestLabel = settings.guestLabel?.trim() || "Guest"
  const liveLabel = settings.liveLabel?.trim() || "Live"
  const offlineLabel = settings.offlineLabel?.trim() || "Reconnecting…"
  const servingTimerLabel = settings.servingTimerLabel?.trim() || "Serving"
  const waitingTimerLabel = settings.waitingTimerLabel?.trim() || "Waiting"

  const showMenu = settings.showServices && data.services.length > 0
  const tickerSeconds = Math.max(30, data.services.length * 5)

  /** Small secondary details shown under a name, per the admin's toggles.
   *  `skip` drops a value already shown elsewhere (e.g. the reference when it
   *  is the ticket itself). */
  function detailsOf(q: DisplayQueueEntry, skip?: string): string[] {
    const out: string[] = []
    if (settings.showQueueService && q.serviceName) out.push(q.serviceName)
    if (q.phoneMasked) out.push(q.phoneMasked)
    if (q.emailMasked) out.push(q.emailMasked)
    if (q.customAnswer) out.push(q.customLabel ? `${q.customLabel}: ${q.customAnswer}` : q.customAnswer)
    if (q.bookingReference && q.bookingReference !== skip) out.push(`Ref ${q.bookingReference}`)
    return out
  }

  function servingTile(q: DisplayQueueEntry) {
    const ticket = settings.showQueueTicketNumber && q.displayTicket ? q.displayTicket : null
    const name = q.customerName?.trim() || guestLabel
    const hero = ticket ?? name
    const details = detailsOf(q, ticket ?? undefined)
    const mins = minsSince(q.calledAt ?? q.joinedAt)
    return (
      <div key={q.id} className="sp-tile">
        <div className={`sp-hero ${hero.length > 8 ? "long" : ""}`}>{hero}</div>
        {ticket && <div className="sp-tile-name">{name}</div>}
        {details.length > 0 && <div className="sp-tile-sub">{details.join(" · ")}</div>}
        {settings.showQueueDuration && nowMs !== null && (
          <div className="sp-tile-time">{mins < 1 ? "Just called" : `${servingTimerLabel} ${formatMinutes(mins)}`}</div>
        )}
      </div>
    )
  }

  function waitingRow(q: DisplayQueueEntry, index: number) {
    const ticket = settings.showQueueTicketNumber && q.displayTicket ? q.displayTicket : null
    const lead = ticket ?? `#${q.position}`
    const details = detailsOf(q, ticket ?? undefined)
    const mins = minsSince(q.joinedAt)
    const showEst = settings.showQueueWaitEstimate && q.estimatedWaitMinutes !== null
    const showTimer = settings.showQueueDuration && nowMs !== null
    return (
      <div key={q.id} className={`sp-row ${index === 0 ? "next" : ""}`}>
        <div className="sp-lead">{lead}</div>
        <div className="sp-main">
          <div className="sp-name">{q.customerName?.trim() || guestLabel}</div>
          {details.length > 0 && <div className="sp-sub">{details.join(" · ")}</div>}
        </div>
        {(showEst || showTimer) && (
          <div className="sp-side">
            {showEst && (
              <div className="sp-est">
                {q.estimatedWaitMinutes === 0 ? nextUpLabel : formatWaitEstimate(q.estimatedWaitMinutes as number, settings.waitRangeMinutes ?? 0)}
              </div>
            )}
            {showTimer && <div className="sp-waited">{mins < 1 ? "Just joined" : `${waitingTimerLabel} ${formatMinutes(mins)}`}</div>}
          </div>
        )}
      </div>
    )
  }

  const rootStyle = {
    "--sp-bg": theme.bgCss,
    "--sp-solid": theme.bgSolid,
    "--sp-fg": theme.fg,
    "--sp-fg-70": hexToRgba(theme.fg, 0.7),
    "--sp-fg-55": hexToRgba(theme.fg, 0.55),
    "--sp-card": hexToRgba(theme.fg, 0.06),
    "--sp-line": hexToRgba(theme.fg, 0.14),
    "--sp-accent": accent,
    "--sp-accent-glow": hexToRgba(accent, 0.25),
    "--sp-accent-tint": hexToRgba(accent, 0.14),
    "--sp-secondary": secondary,
    ...(headerBg && headerFg
      ? {
          "--sp-hdr-bg": headerBg,
          "--sp-hdr-fg": headerFg,
          "--sp-hdr-fg-80": hexToRgba(headerFg, 0.8),
          "--sp-hdr-fg-16": hexToRgba(headerFg, 0.16),
          "--sp-hdr-fg-40": hexToRgba(headerFg, 0.4),
        }
      : {}),
  } as CSSProperties

  const servingCount = serving.length
  const tileClass = servingCount <= 1 ? "n1" : servingCount === 2 ? "n2" : "n3"

  return (
    <div className="sp-stage" style={rootStyle}>
      <style>{CSS}</style>

      <header className={`sp-header ${headerBg ? "brand" : ""}`}>
        <div className="sp-brand">
          <div className="sp-logo">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external Storage URL
              <img src={branding.logoUrl} alt={brandName} />
            ) : (
              <span>{brandName.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className="sp-brand-text">
            <div className="sp-eyebrow">{branding.tagline || queueTitle}</div>
            <h1 className="sp-title">{brandName}</h1>
          </div>
        </div>
        <div className="sp-header-right">
          <div className={`sp-pill ${online ? "" : "offline"}`}>
            <span className="sp-dot" />
            {online ? liveLabel : offlineLabel}
          </div>
          <div className="sp-clock">{formatClockTime(now)}</div>
        </div>
      </header>

      {!settings.showQueue ? (
        <div className="sp-blank">
          <div>
            <div className="sp-blank-name">{brandName}</div>
            {branding.tagline && <div className="sp-blank-tag">{branding.tagline}</div>}
          </div>
        </div>
      ) : (
        <div className="sp-body">
          <section className="sp-left">
            <div className="sp-section-label">{nowServingLabel}</div>
            {servingCount === 0 ? (
              <div className="sp-card sp-empty">{servingEmpty}</div>
            ) : (
              <Scroller className={`sp-tiles ${tileClass}`}>{serving.map(servingTile)}</Scroller>
            )}
          </section>

          <section className="sp-right">
            <div className="sp-section-head">
              <div className="sp-section-label">{waitingLabel}</div>
              <span className="sp-count">{waiting.length}</span>
            </div>
            {waiting.length === 0 ? (
              <div className="sp-empty-plain">{waitingEmpty}</div>
            ) : (
              <Scroller className="sp-rows">{waiting.map(waitingRow)}</Scroller>
            )}
          </section>
        </div>
      )}

      {showMenu && (
        <footer className="sp-footer">
          <div className="sp-footer-label">{menuTitle}</div>
          <div className="sp-ticker-wrap">
            <div className="sp-ticker" style={{ animationDuration: `${tickerSeconds}s` }}>
              {data.services.map((svc) => (
                <div key={svc.id}>
                  {svc.name} <b>R{svc.price.toFixed(0)}</b>
                </div>
              ))}
            </div>
          </div>
        </footer>
      )}
    </div>
  )
}

// rem is scaled with the viewport (16px at 1920 wide) so the screen fills a
// 1080p, 1440p or 4K TV alike -- same approach as BoardScreen.
const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600;700&display=swap");
html { font-size: clamp(9px, 0.8333vw, 24px); }
html, body { margin: 0; padding: 0; background: var(--sp-solid, #15110d); }
.sp-stage {
  position: fixed; inset: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--sp-bg); color: var(--sp-fg); font-family: "Inter", -apple-system, sans-serif;
}

/* header */
.sp-header {
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 1.5rem;
  padding: 1rem 2.25rem; background: var(--sp-card); border-bottom: 3px solid var(--sp-accent);
  box-shadow: 0 0.5rem 1.75rem var(--sp-accent-glow);
}
.sp-header.brand { background: var(--sp-hdr-bg); color: var(--sp-hdr-fg); border-bottom-color: var(--sp-secondary); }
.sp-brand { display: flex; align-items: center; gap: 1.1rem; min-width: 0; }
.sp-brand-text { min-width: 0; }
.sp-logo {
  width: 3.5rem; height: 3.5rem; border-radius: 0.6rem; background: #fff; flex-shrink: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center; color: #171412;
  font-family: "Bricolage Grotesque", sans-serif; font-weight: 700; font-size: 1.8rem;
  box-shadow: 0 0 0 2px var(--sp-secondary), 0 0.5rem 1.1rem rgba(0,0,0,.35);
}
.sp-header.brand .sp-logo { box-shadow: 0 0 0 2px var(--sp-hdr-fg-40), 0 0.5rem 1.1rem rgba(0,0,0,.35); }
.sp-logo img { width: 100%; height: 100%; object-fit: contain; }
.sp-eyebrow {
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--sp-fg-70); margin-bottom: 0.15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sp-header.brand .sp-eyebrow { color: var(--sp-hdr-fg-80); }
.sp-title {
  margin: 0; font-family: "Bricolage Grotesque", sans-serif; font-weight: 700; font-size: 2rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sp-header-right { display: flex; align-items: center; gap: 1.75rem; flex-shrink: 0; }
.sp-clock { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; }
.sp-pill {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 1rem; border-radius: 999px;
  font-size: 0.8rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  background: var(--sp-accent-tint); border: 1px solid var(--sp-accent); color: var(--sp-fg);
}
.sp-header.brand .sp-pill, .sp-header.brand .sp-pill.offline {
  background: var(--sp-hdr-fg-16); border-color: var(--sp-hdr-fg-40); color: var(--sp-hdr-fg);
}
.sp-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; box-shadow: 0 0 0.7rem currentColor; animation: sp-pulse 1.8s infinite; }
@keyframes sp-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }

/* body: left = now serving, right = still to come */
.sp-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1.15fr 1fr; gap: 2rem; padding: 2rem 2.25rem; }
.sp-left, .sp-right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.sp-section-label {
  font-size: 0.95rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--sp-fg-70); margin-bottom: 0.9rem;
}
.sp-section-head { display: flex; align-items: baseline; gap: 0.75rem; }
.sp-count {
  font-size: 0.85rem; font-weight: 700; padding: 0.15rem 0.7rem; border-radius: 999px;
  background: var(--sp-accent-tint); color: var(--sp-accent); margin-bottom: 0.9rem;
}

.sp-card, .sp-tile {
  background: var(--sp-card); border: 1px solid var(--sp-line); border-top: 0.4rem solid var(--sp-accent);
  border-radius: 1.25rem;
}
.sp-empty {
  flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  padding: 2rem; font-size: 1.5rem; color: var(--sp-fg-70);
}
.sp-empty-plain { padding: 1.5rem 0.25rem; font-size: 1.3rem; color: var(--sp-fg-55); }

.sp-tiles { flex: 1; min-height: 0; overflow: hidden; display: grid; gap: 1.25rem; align-content: stretch; }
.sp-tiles.n1 { grid-template-columns: 1fr; grid-auto-rows: 1fr; }
.sp-tiles.n2 { grid-template-columns: 1fr; grid-auto-rows: 1fr; }
.sp-tiles.n3 { grid-template-columns: 1fr 1fr; grid-auto-rows: minmax(14rem, 1fr); }
.sp-tile {
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  padding: 1.5rem; min-width: 0; min-height: 0;
}
.sp-hero {
  font-family: "Bricolage Grotesque", sans-serif; font-weight: 700; line-height: 1; color: var(--sp-accent);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.n1 .sp-hero { font-size: 13rem; }
.n2 .sp-hero { font-size: 8rem; }
.n3 .sp-hero { font-size: 5.5rem; }
.n1 .sp-hero.long { font-size: 7rem; }
.n2 .sp-hero.long { font-size: 5rem; }
.n3 .sp-hero.long { font-size: 3.5rem; }
.sp-tile-name { margin-top: 1rem; font-family: "Bricolage Grotesque", sans-serif; font-weight: 600; font-size: 2.2rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.n3 .sp-tile-name { font-size: 1.5rem; margin-top: 0.5rem; }
.sp-tile-sub { margin-top: 0.5rem; font-size: 1.2rem; color: var(--sp-fg-70); max-width: 100%; }
.n3 .sp-tile-sub { font-size: 0.95rem; }
.sp-tile-time { margin-top: 0.75rem; font-size: 0.95rem; font-weight: 600; color: var(--sp-fg-55); letter-spacing: 0.04em; text-transform: uppercase; }

.sp-rows { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 0.75rem; }
.sp-row {
  display: flex; align-items: center; gap: 1.25rem; padding: 1rem 1.4rem; flex-shrink: 0;
  background: var(--sp-card); border: 1px solid var(--sp-line); border-radius: 0.9rem;
}
.sp-row.next { border-color: var(--sp-accent); background: var(--sp-accent-tint); }
.sp-lead {
  font-family: "Bricolage Grotesque", sans-serif; font-weight: 700; font-size: 1.9rem; color: var(--sp-accent);
  min-width: 6.5rem; white-space: nowrap;
}
.sp-main { flex: 1; min-width: 0; }
.sp-name { font-size: 1.5rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-sub { font-size: 1.05rem; color: var(--sp-fg-70); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-side { text-align: right; flex-shrink: 0; }
.sp-est { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.sp-waited { font-size: 0.9rem; color: var(--sp-fg-55); }

.sp-blank { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; }
.sp-blank-name { font-family: "Bricolage Grotesque", sans-serif; font-weight: 700; font-size: 5rem; }
.sp-blank-tag { margin-top: 0.75rem; font-size: 1.6rem; color: var(--sp-fg-70); }

/* menu ticker */
.sp-footer { flex-shrink: 0; display: flex; align-items: stretch; background: var(--sp-card); border-top: 2px solid var(--sp-line); }
.sp-footer-label {
  display: flex; align-items: center; padding: 0.8rem 1.5rem; font-size: 0.85rem; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--sp-secondary); background: var(--sp-accent-tint);
}
.sp-ticker-wrap { flex: 1; overflow: hidden; display: flex; align-items: center; }
.sp-ticker { display: flex; gap: 3rem; white-space: nowrap; padding-left: 100%; font-size: 1.15rem; animation: sp-scroll linear infinite; }
.sp-ticker b { color: var(--sp-accent); font-weight: 700; margin-left: 0.35rem; }
@keyframes sp-scroll { from { transform: translateX(0) } to { transform: translateX(-100%) } }

@media (prefers-reduced-motion: reduce) { .sp-dot, .sp-ticker { animation: none; } }
`
