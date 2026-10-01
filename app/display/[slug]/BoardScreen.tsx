"use client"

// app/display/[slug]/BoardScreen.tsx
/**
 * "Live board" layout for the Display TV -- an always-on board instead of
 * rotating slides. Ported from the old Smart Counter order board (paper
 * tickets with brass clips, red header, Live pill, clock, scrolling footer
 * ticker) and mapped onto a queue/booking business:
 *
 *   order board                      this board
 *   -----------------------------    ------------------------------------
 *   New orders                       Waiting          (queue, status waiting)
 *   Adding to ice bucket             Now serving      (queue, status called)
 *   Ready for collection             Upcoming bookings (confirmed, next 12h)
 *   Collected ticker (footer)        Menu ticker      (services + prices)
 *
 * It reads the same DisplayData as the slide layout, so every admin setting
 * still applies: screens on/off, headings, theme/background, and the six
 * queue-field toggles (ticket number, service, phone, wait estimate, time
 * waited, booking reference). Slide durations and the welcome slide don't
 * apply here -- everything is on screen at once.
 *
 * DisplayScreen owns data + polling and renders this when
 * settings.layout === "board". Paper tickets stay paper on every theme so
 * ticket text is always readable; only the chrome around them follows the
 * theme/background.
 */

import { useEffect, useRef, useState } from "react"
import type { CSSProperties, RefObject } from "react"
import type { DisplayBooking, DisplayData, DisplayQueueEntry } from "./actions"
import {
  DEFAULT_ACCENT,
  DEFAULT_SECONDARY,
  ensureContrast,
  formatMinutes,
  hexToRgba,
  luminance,
  resolveThemeTokens,
} from "./displayTheme"

const PAPER = "#F4ECDC"
const INK = "#241C15"

// Minutes before a ticket's timer turns amber / red (same idea as the order
// board's calm/warn/hot). Waiting is judged from joined_at, serving from
// called_at.
const WAITING_TONE = { warn: 15, hot: 30 }
const SERVING_TONE = { warn: 30, hot: 60 }

type Tone = "calm" | "warn" | "hot"

function toneFor(mins: number, t: { warn: number; hot: number }): Tone {
  if (mins >= t.hot) return "hot"
  if (mins >= t.warn) return "warn"
  return "calm"
}

function sourceLabel(source: string | null): string {
  if (source === "walk_in") return "Walk-in"
  if (source === "booking") return "Booking"
  if (!source) return "Walk-in"
  return source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, " ")
}

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** Slowly scrolls a rail when its tickets overflow the screen (a TV can't
 *  be scrolled by hand): pause, glide to the bottom, pause, jump back up. */
function useAutoScroll(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    let wait = 60
    let atEnd = false
    const id = setInterval(() => {
      if (el.scrollHeight <= el.clientHeight + 2) {
        el.scrollTop = 0
        return
      }
      if (wait > 0) {
        wait--
        return
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        if (!atEnd) {
          atEnd = true
          wait = 60
          return
        }
        el.scrollTop = 0
        atEnd = false
        wait = 60
        return
      }
      el.scrollTop += 1
    }, 40)
    return () => clearInterval(id)
  }, [ref])
}

function Rail({ children, empty }: { children: React.ReactNode; empty: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useAutoScroll(ref)
  const isEmpty = !children || (Array.isArray(children) && children.length === 0)
  return (
    <div className="bd-rail" ref={ref}>
      {isEmpty ? <div className="bd-empty">{empty}</div> : children}
    </div>
  )
}

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div className={`bd-timer ${tone}`}>{children}</div>
}

export function BoardScreen({ data, online }: { data: DisplayData; online: boolean }) {
  const { settings, branding } = data

  // Clock + timer tick. Both start null so server and client first render
  // match (no hydration mismatch on the second/minute).
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const nowMs = now?.getTime() ?? null
  const minsSince = (iso: string) => (nowMs === null ? 0 : Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 60000)))
  const minsUntil = (iso: string) => (nowMs === null ? 0 : Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 60000)))

  const waiting = data.queue.filter((q) => q.status === "waiting")
  const serving = data.queue.filter((q) => q.status === "called")

  const brandName = branding.displayName?.trim() || "Welcome"
  const theme = resolveThemeTokens(settings.theme, settings.backgroundColor)
  const accent = ensureContrast(branding.primaryColor || DEFAULT_ACCENT, theme.bgSolid, theme.fg, 3)
  const secondary = ensureContrast(branding.secondaryColor || DEFAULT_SECONDARY, theme.bgSolid, theme.fg, 3)
  // Accents drawn ON the paper tickets are checked against paper, not the
  // screen background.
  const ticketAccent = ensureContrast(branding.primaryColor || DEFAULT_ACCENT, PAPER, INK, 3.5)
  const ticketSecondary = ensureContrast(branding.secondaryColor || DEFAULT_SECONDARY, PAPER, INK, 3.5)

  const queueTitle = settings.queueTitle?.trim() || "Live queue"
  const bookingsTitle = settings.bookingsTitle?.trim() || "Upcoming bookings"
  const nowServingLabel = settings.nowServingLabel?.trim() || "Now serving"
  const menuTitle = settings.menuTitle?.trim() || "On the menu"

  const showMenu = settings.showServices && data.services.length > 0
  const columnCount = (settings.showQueue ? 2 : 0) + (settings.showBookings ? 1 : 0)

  function queueTicket(q: DisplayQueueEntry) {
    const isServing = q.status === "called"
    const lead = settings.showQueueTicketNumber && q.ticketNumber ? q.ticketNumber : isServing ? "Now" : `#${q.position}`
    const mins = minsSince(isServing ? (q.calledAt ?? q.joinedAt) : q.joinedAt)
    const tone = toneFor(mins, isServing ? SERVING_TONE : WAITING_TONE)
    const showEst = !isServing && settings.showQueueWaitEstimate && q.estimatedWaitMinutes !== null
    const showTimer = settings.showQueueDuration && nowMs !== null
    const hasFoot = showEst || showTimer

    return (
      <div key={q.id} className={`bd-ticket ${isServing ? "serving" : ""}`}>
        <div className="bd-clip" />
        <div className="bd-ticket-top">
          <div className="bd-num">{lead}</div>
          <div className="bd-badge">{sourceLabel(q.source)}</div>
        </div>
        <div className="bd-customer">
          {q.customerName ?? "Guest"}
          {q.phoneMasked && <span className="bd-sub"> · {q.phoneMasked}</span>}
        </div>
        {((settings.showQueueService && q.serviceName) || q.bookingReference) && (
          <ul className="bd-items">
            {settings.showQueueService && q.serviceName && <li>{q.serviceName}</li>}
            {q.bookingReference && <li className="bd-ref">Ref {q.bookingReference}</li>}
          </ul>
        )}
        {hasFoot && (
          <div className="bd-foot">
            {showTimer ? (
              <Chip tone={tone}>{isServing ? `Serving ${formatMinutes(mins)}` : mins < 1 ? "Just joined" : `Waiting ${formatMinutes(mins)}`}</Chip>
            ) : (
              <span />
            )}
            {showEst && (
              <span className="bd-action">
                {q.estimatedWaitMinutes === 0 ? "Next up" : `Est. ~${formatMinutes(q.estimatedWaitMinutes as number)}`}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }

  function bookingTicket(b: DisplayBooking) {
    const mins = minsUntil(b.startTime)
    const tone: Tone = mins <= 15 ? "warn" : "calm"
    return (
      <div key={b.id} className="bd-ticket booking">
        <div className="bd-clip" />
        <div className="bd-ticket-top">
          <div className="bd-num">{formatClockTime(b.startTime)}</div>
          <div className="bd-badge">Booking</div>
        </div>
        <div className="bd-customer">{b.customerName ?? "Guest"}</div>
        {(b.serviceName || b.staffName) && (
          <ul className="bd-items">
            {b.serviceName && <li>{b.serviceName}</li>}
            {b.staffName && <li className="bd-ref">with {b.staffName}</li>}
          </ul>
        )}
        {nowMs !== null && (
          <div className="bd-foot">
            <Chip tone={tone}>{mins < 1 ? "Starting now" : `In ${formatMinutes(mins)}`}</Chip>
            <span />
          </div>
        )}
      </div>
    )
  }

  const lightBg = luminance(theme.bgSolid) > 0.4
  const rootStyle = {
    "--bd-live": lightBg ? "#2f6a1f" : "#7fb866",
    "--bd-offline": lightBg ? "#a3182a" : "#e0606c",
    "--bd-bg": theme.bgCss,
    "--bd-fg": theme.fg,
    "--bd-fg-70": hexToRgba(theme.fg, 0.7),
    "--bd-fg-55": hexToRgba(theme.fg, 0.55),
    "--bd-fg-06": hexToRgba(theme.fg, 0.06),
    "--bd-fg-02": hexToRgba(theme.fg, 0.025),
    "--bd-accent": accent,
    "--bd-accent-glow": hexToRgba(accent, 0.25),
    "--bd-accent-tint": hexToRgba(accent, 0.12),
    "--bd-accent-line": hexToRgba(accent, 0.3),
    "--bd-secondary": secondary,
    "--bd-ticket-accent": ticketAccent,
    "--bd-ticket-secondary": ticketSecondary,
    "--bd-paper": PAPER,
    "--bd-ink": INK,
    "--bd-solid": theme.bgSolid,
    "--bd-cols": columnCount || 1,
  } as CSSProperties

  const clockTime = now?.toLocaleTimeString([], { hour12: false }) ?? "--:--:--"
  const clockDate = now?.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) ?? ""
  const tickerSeconds = Math.max(30, data.services.length * 5)

  return (
    <div className="bd-stage" style={rootStyle}>
      <style>{CSS}</style>

      <header className="bd-header">
        <div className="bd-brand">
          <div className="bd-logo">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external Storage URL
              <img src={branding.logoUrl} alt={brandName} />
            ) : (
              <span>{brandName.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div>
            <div className="bd-eyebrow">{branding.tagline || queueTitle}</div>
            <h1 className="bd-title">{brandName}</h1>
          </div>
        </div>
        <div className="bd-header-right">
          <div className={`bd-pill ${online ? "" : "offline"}`}>
            <span className="bd-dot" />
            {online ? "Live" : "Reconnecting…"}
          </div>
          <div className="bd-clock">
            <div className="bd-time">{clockTime}</div>
            <div className="bd-date">{clockDate}</div>
          </div>
        </div>
      </header>

      {columnCount === 0 ? (
        <div className="bd-board bd-blank">
          <div>
            <div className="bd-blank-name">{brandName}</div>
            {branding.tagline && <div className="bd-blank-tag">{branding.tagline}</div>}
          </div>
        </div>
      ) : (
        <div className="bd-board">
          {settings.showQueue && (
            <>
              <section className="bd-col">
                <div className="bd-col-head">
                  <h2>Waiting</h2>
                  <span className="bd-count">{waiting.length}</span>
                </div>
                <Rail empty="Nobody waiting right now.">{waiting.map(queueTicket)}</Rail>
              </section>
              <section className="bd-col serving">
                <div className="bd-col-head">
                  <h2>{nowServingLabel}</h2>
                  <span className="bd-count">{serving.length}</span>
                </div>
                <Rail empty="No one is being served right now.">{serving.map(queueTicket)}</Rail>
              </section>
            </>
          )}
          {settings.showBookings && (
            <section className="bd-col">
              <div className="bd-col-head">
                <h2>{bookingsTitle}</h2>
                <span className="bd-count">{data.bookings.length}</span>
              </div>
              <Rail empty="No upcoming bookings.">{data.bookings.map(bookingTicket)}</Rail>
            </section>
          )}
        </div>
      )}

      {showMenu && (
        <footer className="bd-footer">
          <div className="bd-footer-label">{menuTitle}</div>
          <div className="bd-ticker-wrap">
            <div className="bd-ticker" style={{ animationDuration: `${tickerSeconds}s` }}>
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

// Sizes are in rem; the root font-size below scales with screen width
// (16px at 1920 wide) so the board fills a 1080p, 1440p or 4K TV alike.
const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap");
html { font-size: clamp(9px, 0.8333vw, 24px); }
html, body { margin: 0; padding: 0; background: var(--bd-solid, #0c0907); }
.bd-stage {
  position: fixed; inset: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--bd-bg); color: var(--bd-fg);
  font-family: "Inter", -apple-system, sans-serif;
}
.bd-stage *, .bd-stage *::before, .bd-stage *::after { box-sizing: border-box; }
.bd-stage::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(ellipse at 50% -10%, var(--bd-accent-tint), transparent 50%),
    repeating-linear-gradient(0deg, var(--bd-fg-02) 0, var(--bd-fg-02) 1px, transparent 1px, transparent 3px);
}
.bd-stage > * { position: relative; z-index: 1; }

/* header */
.bd-header {
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
  padding: 1rem 2.25rem; background: var(--bd-fg-06);
  border-bottom: 3px solid var(--bd-accent); box-shadow: 0 0.5rem 1.75rem var(--bd-accent-glow);
}
.bd-brand { display: flex; align-items: center; gap: 1.1rem; min-width: 0; }
.bd-logo {
  width: 3.5rem; height: 3.5rem; border-radius: 0.6rem; background: var(--bd-paper); flex-shrink: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center; color: var(--bd-ink);
  font-family: "Oswald", sans-serif; font-weight: 700; font-size: 1.8rem;
  box-shadow: 0 0 0 2px var(--bd-secondary), 0 0.5rem 1.1rem rgba(0,0,0,.45);
}
.bd-logo img { width: 100%; height: 100%; object-fit: contain; }
.bd-eyebrow {
  font-family: "IBM Plex Mono", monospace; font-size: 0.7rem; letter-spacing: 0.18em;
  color: var(--bd-secondary); text-transform: uppercase; margin-bottom: 0.15rem;
}
.bd-title {
  margin: 0; font-family: "Oswald", sans-serif; font-weight: 700; font-size: 1.9rem;
  letter-spacing: 0.02em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bd-header-right { display: flex; align-items: center; gap: 1.75rem; flex-shrink: 0; }
.bd-clock { text-align: right; font-family: "IBM Plex Mono", monospace; }
.bd-time { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; }
.bd-date { font-size: 0.75rem; color: var(--bd-fg-55); letter-spacing: 0.05em; text-transform: uppercase; }
.bd-pill {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 1rem; border-radius: 999px;
  font-family: "IBM Plex Mono", monospace; font-size: 0.75rem; letter-spacing: 0.05em; text-transform: uppercase;
  background: rgba(111,158,90,.14); border: 1px solid rgba(111,158,90,.4); color: var(--bd-live);
}
.bd-pill.offline { background: rgba(179,27,47,.16); border-color: rgba(179,27,47,.5); color: var(--bd-offline); }
.bd-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; box-shadow: 0 0 0.7rem currentColor; animation: bd-pulse 1.8s infinite; }
@keyframes bd-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }

/* board */
.bd-board { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(var(--bd-cols), 1fr); }
.bd-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--bd-accent-line); }
.bd-col:last-child { border-right: none; }
.bd-col-head {
  display: flex; align-items: baseline; justify-content: space-between; flex-shrink: 0;
  padding: 1.1rem 1.5rem 0.75rem; border-bottom: 2px solid var(--bd-accent-line);
  background: linear-gradient(180deg, var(--bd-accent-tint), transparent);
}
.bd-col.serving .bd-col-head { border-bottom-color: var(--bd-secondary); }
.bd-col-head h2 {
  margin: 0; font-family: "Oswald", sans-serif; font-weight: 600; font-size: 1.3rem;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.bd-count {
  font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 0.95rem; min-width: 2rem; text-align: center;
  padding: 0.2rem 0.75rem; border-radius: 999px; background: var(--bd-accent-tint); color: var(--bd-accent);
}
.bd-col.serving .bd-count { color: var(--bd-secondary); }
.bd-rail {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none;
  padding: 1.5rem 1.25rem 2rem; display: flex; flex-direction: column; gap: 1.5rem;
}
.bd-rail::-webkit-scrollbar { display: none; }
.bd-empty { margin-top: 2.5rem; text-align: center; color: var(--bd-fg-55); font-size: 0.95rem; padding: 0 1.25rem; }

/* ticket */
.bd-ticket {
  position: relative; flex-shrink: 0; background: var(--bd-paper); color: var(--bd-ink);
  border-radius: 3px 3px 0 0; padding: 1rem 1.15rem 1.35rem; border-left: 4px solid var(--bd-ticket-accent);
  box-shadow: 0 0.75rem 1.75rem rgba(0,0,0,.45), 0 2px 0 rgba(0,0,0,.2);
  transform: rotate(var(--tilt, -0.3deg)); animation: bd-drop 0.4s cubic-bezier(.2,.8,.3,1);
}
.bd-ticket:nth-child(3n+1) { --tilt: -0.7deg; border-left-width: 5px; }
.bd-ticket:nth-child(3n+2) { --tilt: 0.4deg; }
.bd-ticket:nth-child(3n) { --tilt: -0.2deg; }
.bd-ticket.serving { border-left-color: var(--bd-ticket-secondary); box-shadow: 0 0.6rem 1.9rem var(--bd-accent-glow), 0 2px 0 rgba(0,0,0,.2); }
@keyframes bd-drop {
  from { opacity: 0; transform: translateY(-1rem) rotate(var(--tilt, 0)); }
  to { opacity: 1; transform: translateY(0) rotate(var(--tilt, 0)); }
}
.bd-ticket::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -10px; height: 14px;
  background:
    linear-gradient(135deg, var(--bd-paper) 50%, transparent 50%) 0 0/10px 10px repeat-x,
    linear-gradient(-135deg, var(--bd-paper) 50%, transparent 50%) 0 0/10px 10px repeat-x;
  filter: drop-shadow(0 4px 6px rgba(0,0,0,.25));
}
.bd-clip {
  position: absolute; top: -0.7rem; left: 50%; transform: translateX(-50%); width: 2.25rem; height: 1rem; border-radius: 3px;
  background: linear-gradient(180deg, #e3c073, #8a6c33); box-shadow: 0 3px 10px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.4);
}
.bd-ticket-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.4rem; }
.bd-num { font-family: "Oswald", sans-serif; font-weight: 700; font-size: 1.6rem; color: var(--bd-ticket-accent); line-height: 1.1; }
.bd-ticket.serving .bd-num { color: var(--bd-ticket-secondary); }
.bd-badge {
  font-family: "IBM Plex Mono", monospace; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap;
  padding: 0.25rem 0.6rem; border-radius: 4px; border: 1.5px solid var(--bd-ink); color: var(--bd-ink); transform: rotate(2deg); background: rgba(255,255,255,.15);
}
.bd-customer { font-weight: 600; font-size: 1.1rem; margin-bottom: 0.6rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-sub { font-weight: 400; font-size: 0.8rem; color: rgba(36,28,21,.62); }
.bd-items { list-style: none; margin: 0 0 0.8rem; padding: 0.5rem 0 0; border-top: 1px dashed rgba(36,28,21,.25); }
.bd-items li { font-size: 0.95rem; padding: 0.15rem 0; }
.bd-items li.bd-ref { font-family: "IBM Plex Mono", monospace; font-size: 0.78rem; color: rgba(36,28,21,.62); }
.bd-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.bd-timer {
  font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 0.82rem; padding: 0.25rem 0.75rem; border-radius: 6px; font-variant-numeric: tabular-nums;
}
.bd-timer.calm { background: rgba(111,158,90,.14); color: #3d6b2c; }
.bd-timer.warn { background: rgba(217,142,43,.16); color: #8f5f12; }
.bd-timer.hot { background: rgba(179,27,47,.18); color: #a3182a; animation: bd-hot 1.2s infinite; }
@keyframes bd-hot { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
.bd-action { font-family: "Oswald", sans-serif; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(36,28,21,.7); }

/* blank (both screens switched off) */
.bd-blank { display: flex; align-items: center; justify-content: center; text-align: center; }
.bd-blank-name { font-family: "Oswald", sans-serif; font-weight: 700; font-size: 4.5rem; text-transform: uppercase; }
.bd-blank-tag { margin-top: 0.75rem; font-size: 1.6rem; color: var(--bd-fg-70); }

/* footer ticker */
.bd-footer {
  height: 3.5rem; flex-shrink: 0; display: flex; align-items: center; overflow: hidden;
  background: var(--bd-fg-06); border-top: 2px solid var(--bd-accent-line);
}
.bd-footer-label {
  height: 100%; display: flex; align-items: center; padding: 0 1.25rem; flex-shrink: 0; z-index: 2;
  font-family: "Oswald", sans-serif; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--bd-secondary); background: var(--bd-accent-tint); border-right: 2px solid var(--bd-accent-line);
}
.bd-ticker-wrap { flex: 1; overflow: hidden; }
.bd-ticker {
  display: flex; gap: 2.75rem; white-space: nowrap; align-items: center; padding-left: 100%;
  font-family: "IBM Plex Mono", monospace; font-size: 0.85rem; color: var(--bd-fg-70);
  animation: bd-scroll 40s linear infinite;
}
.bd-ticker b { color: var(--bd-accent); font-weight: 600; margin-left: 0.35rem; }
@keyframes bd-scroll { from { transform: translateX(0) } to { transform: translateX(-100%) } }

@media (prefers-reduced-motion: reduce) {
  .bd-ticket, .bd-dot, .bd-timer.hot { animation: none; }
  .bd-ticker { animation: none; padding-left: 1.25rem; }
}
`
