"use client"

// app/display/[slug]/DisplayScreen.tsx
/**
 * Ambient, non-interactive rotation for a TV in the waiting area. Design
 * notes (see conversation for the full brief):
 *   - Background is admin-selectable (dark / light / custom hex) but text
 *     color is NEVER admin-picked: it's derived from the background by
 *     contrast, and primary/secondary accents are nudged toward the text
 *     color until they clear a minimum contrast ratio against the chosen
 *     background. So any background + any brand color stays readable at
 *     TV distance. Accents are used for the wordmark glow, prices, times,
 *     ticket numbers and dots.
 *   - Bricolage Grotesque for anything large, Inter for everything small.
 *   - Pricing slide uses menu-board convention (name — leader dots — price).
 *   - TWO PHASES, not one flat rotation:
 *       1. "welcome" -- shown once, for data.settings.welcomeSeconds, when
 *          this tab first mounts. Never reappears afterwards this session.
 *       2. "rotation" -- cycles through whichever of services/bookings/
 *          queue are both admin-enabled (data.settings.show*) and have
 *          data. Services and bookings share one duration
 *          (menuBookingsSeconds); queue gets its own, typically longer,
 *          duration (queueSeconds) since there's more to read there.
 *     If nothing ever ends up eligible for rotation, the welcome slide
 *     just stays up indefinitely rather than cycling to a blank screen.
 *   - Slide headings and the queue's "now serving" label pull from
 *     data.settings' wording overrides, falling back to the same
 *     defaults this screen always used.
 *   - One motion idea: slow crossfade between slides, a quiet glow behind
 *     the wordmark on the welcome slide. Nothing else moves.
 *
 * This tab is expected to stay open for days/weeks on a physical TV, so
 * it polls fetchDisplayData() every POLL_MS to pick up branding/service/
 * booking/queue/settings edits made elsewhere, without ever needing a
 * manual reload. An admin toggling a screen off, or changing a duration,
 * takes effect on the next poll -- no need to touch the TV.
 */

import { useEffect, useMemo, useState } from "react"
import type { CSSProperties } from "react"
import { fetchDisplayData, type DisplayData, type DisplayTheme } from "./actions"

const POLL_MS = 5 * 60 * 1000

const DEFAULT_ACCENT = "#E2B33C"
const DEFAULT_SECONDARY = "#3E7C74"

type SlideKey = "welcome" | "services" | "bookings" | "queue"

const DARK_BG_SOLID = "#15110d"
const DARK_BG = "radial-gradient(120% 100% at 50% -10%, #221a12 0%, #15110d 55%, #100c09 100%)"
const LIGHT_BG_SOLID = "#FAF8F5"
const LIGHT_BG = "radial-gradient(120% 100% at 50% -10%, #FFFFFF 0%, #FAF8F5 55%, #F1EDE6 100%)"
const INK = "#171412"
const PAPER = "#F5F1E8"

function toRgb(hex: string | null | undefined): [number, number, number] | null {
  const clean = (hex ?? "").replace("#", "")
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const int = Number.parseInt(full, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

/** Plain rgba conversion instead of CSS color-mix() -- some smart TV
 *  browsers (older Tizen/webOS/Android TV WebView builds) don't support
 *  color-mix() yet, and this only needs to run once per render anyway. */
function hexToRgba(hex: string, alpha: number): string {
  const rgb = toRgb(hex) ?? [226, 179, 60] // DEFAULT_ACCENT fallback
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const rgb = toRgb(hex) ?? [0, 0, 0]
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function mixHex(from: string, to: string, amount: number): string {
  const a = toRgb(from)
  const b = toRgb(to)
  if (!a || !b) return from
  return toHex([0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * amount)) as [number, number, number])
}

/** Moves `color` toward `target` (the readable text color) in small steps
 *  until it clears `min` contrast against `bg`. Colors that already pass
 *  are returned unchanged, so a good brand color is never altered. */
function ensureContrast(color: string, bg: string, target: string, min: number): string {
  if (!toRgb(color)) return color
  let out = color
  for (let i = 1; i <= 10 && contrastRatio(out, bg) < min; i++) out = mixHex(color, target, i / 10)
  return out
}

interface ThemeTokens {
  bgCss: string
  bgSolid: string
  fg: string
}

function resolveThemeTokens(theme: DisplayTheme, custom: string | null): ThemeTokens {
  if (theme === "light") return { bgCss: LIGHT_BG, bgSolid: LIGHT_BG_SOLID, fg: INK }
  if (theme === "custom" && toRgb(custom)) {
    const bg = toHex(toRgb(custom) as [number, number, number])
    return { bgCss: bg, bgSolid: bg, fg: contrastRatio(bg, INK) >= contrastRatio(bg, PAPER) ? INK : PAPER }
  }
  return { bgCss: DARK_BG, bgSolid: DARK_BG_SOLID, fg: PAPER }
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min`
}

/** "14:30" for a booking's start_time. Rendered in the TV's local time,
 *  same as the browser clock on the wall -- no server-side tenant
 *  timezone conversion needed for something displayed on-site. */
function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export function DisplayScreen({ slug, initialData }: { slug: string; initialData: DisplayData }) {
  const [data, setData] = useState<DisplayData>(initialData)
  // "welcome" is a one-time phase for this tab's lifetime -- once it flips
  // to "rotation" it never goes back, even if the poll below brings in
  // fresh data. That's the whole point: a TV left open for days shouldn't
  // re-show the branding slide every rotation, only when the tab is first
  // opened (or reloaded).
  const [phase, setPhase] = useState<"welcome" | "rotation">("welcome")
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(async () => {
      const result = await fetchDisplayData(slug)
      // On failure, keep showing the last known-good data rather than
      // blanking an unattended screen over a transient network hiccup.
      if (result.ok) setData(result.data)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [slug])

  const settings = data.settings

  // "Time waited so far" needs a clock that ticks between the 5-minute data
  // polls. Only runs when that field is switched on. Starts null so server
  // and client first render match (no hydration mismatch on the minute).
  const [nowMs, setNowMs] = useState<number | null>(null)
  useEffect(() => {
    if (!settings.showQueueDuration) return
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 30 * 1000)
    return () => clearInterval(id)
  }, [settings.showQueueDuration])

  // Rotation content only -- welcome is handled as its own phase, not a
  // member of this array, so it's never cycled back into once left.
  const slides = useMemo<SlideKey[]>(() => {
    const s: SlideKey[] = []
    if (settings.showServices && data.services.length > 0) s.push("services")
    if (settings.showBookings && data.bookings.length > 0) s.push("bookings")
    if (settings.showQueue && data.queue.length > 0) s.push("queue")
    return s
  }, [data, settings])

  // Phase 1 -> 2: leave the welcome slide after welcomeSeconds, but only
  // once there's actually something to rotate to -- otherwise stay on
  // welcome rather than cut to a blank stage. Re-evaluates if slides
  // arrives late (e.g. the first queue entry joins after this tab has
  // already been sitting on "welcome").
  useEffect(() => {
    if (phase !== "welcome" || slides.length === 0) return
    const id = setTimeout(() => setPhase("rotation"), settings.welcomeSeconds * 1000)
    return () => clearTimeout(id)
  }, [phase, slides.length, settings.welcomeSeconds])

  // Keep index in range if the rotation set shrinks (e.g. the queue
  // empties out mid-rotation).
  useEffect(() => {
    setIndex((i) => (slides.length === 0 ? 0 : i % slides.length))
  }, [slides.length])

  // Phase 2: advance to the next rotation slide after that slide's own
  // duration -- services/bookings share menuBookingsSeconds, queue uses
  // its own (usually longer) queueSeconds. Self-rescheduling setTimeout
  // rather than one fixed setInterval, since the duration can differ
  // slide-to-slide.
  useEffect(() => {
    if (phase !== "rotation" || slides.length === 0) return
    const currentKey = slides[index % slides.length]
    const durationMs = (currentKey === "queue" ? settings.queueSeconds : settings.menuBookingsSeconds) * 1000
    const id = setTimeout(() => setIndex((i) => (i + 1) % slides.length), durationMs)
    return () => clearTimeout(id)
  }, [phase, index, slides, settings.queueSeconds, settings.menuBookingsSeconds])

  // "Now serving" (called) surfaces separately from the numbered "up
  // next" (waiting) list -- they read as different things on a TV.
  const calledEntries = useMemo(() => data.queue.filter((q) => q.status === "called"), [data.queue])
  const waitingEntries = useMemo(() => data.queue.filter((q) => q.status === "waiting"), [data.queue])

  const brandName = data.branding.displayName?.trim() || "Welcome"
  const theme = resolveThemeTokens(settings.theme, settings.backgroundColor)
  // 3:1 is WCAG's floor for large text; everything accented here is large.
  const accent = ensureContrast(data.branding.primaryColor || DEFAULT_ACCENT, theme.bgSolid, theme.fg, 3)
  const secondary = ensureContrast(data.branding.secondaryColor || DEFAULT_SECONDARY, theme.bgSolid, theme.fg, 3)
  const accentSoft = hexToRgba(accent, 0.22)

  const activeKey: SlideKey = phase === "welcome" ? "welcome" : slides[index] ?? "welcome"
  const menuTitle = settings.menuTitle?.trim() || "On the menu"
  const bookingsTitle = settings.bookingsTitle?.trim() || "Upcoming bookings"
  const queueTitle = settings.queueTitle?.trim() || "Live queue"
  const nowServingLabel = settings.nowServingLabel?.trim() || "Now serving"

  // Queue slide is a table: one labelled column per field the admin turned
  // on. A column is also dropped when NOBODY in the queue has a value for
  // it right now (e.g. "Booking ref" when everyone is a walk-in), so the
  // table never shows a heading above a wall of dashes.
  const cols = {
    service: settings.showQueueService && data.queue.some((q) => q.serviceName),
    phone: settings.showQueuePhone && data.queue.some((q) => q.phoneMasked),
    reference: settings.showQueueReference && data.queue.some((q) => q.bookingReference),
    wait: settings.showQueueWaitEstimate && waitingEntries.some((q) => q.estimatedWaitMinutes !== null),
    waited: settings.showQueueDuration,
  }
  const colCount = 2 + Object.values(cols).filter(Boolean).length

  function renderQueueRow(q: DisplayData["queue"][number]) {
    const isCalled = q.status === "called"
    // First column: the ticket when that field is on, else the position.
    // Entries with no ticket (old rows, promoted bookings) show a dash
    // rather than a position, so one column never mixes two meanings.
    const lead = settings.showQueueTicketNumber ? (q.ticketNumber ?? "—") : isCalled ? "Now" : String(q.position)
    const waitedMin =
      nowMs !== null && !isCalled ? Math.max(0, Math.floor((nowMs - new Date(q.joinedAt).getTime()) / 60000)) : null
    return (
      <tr key={q.id} className={isCalled ? "row called" : "row"}>
        <td className="c-lead">{lead}</td>
        <td className="c-name">{q.customerName ?? "Guest"}</td>
        {cols.service && <td className="c-muted">{q.serviceName ?? "—"}</td>}
        {cols.phone && <td className="c-muted">{q.phoneMasked ?? "—"}</td>}
        {cols.reference && <td className="c-muted">{q.bookingReference ?? "—"}</td>}
        {cols.wait && (
          <td className="c-num">
            {isCalled || q.estimatedWaitMinutes === null
              ? "—"
              : q.estimatedWaitMinutes === 0
                ? "Next up"
                : `~${formatMinutes(q.estimatedWaitMinutes)}`}
          </td>
        )}
        {cols.waited && (
          <td className="c-num">{waitedMin === null ? "—" : waitedMin < 1 ? "Just now" : formatMinutes(waitedMin)}</td>
        )}
      </tr>
    )
  }

  return (
    <div
      className="stage"
      style={
        {
          "--accent": accent,
          "--secondary": secondary,
          "--accent-soft": accentSoft,
          "--bg": theme.bgCss,
          "--fg": theme.fg,
          "--fg-70": hexToRgba(theme.fg, 0.7),
          "--fg-55": hexToRgba(theme.fg, 0.55),
          "--fg-28": hexToRgba(theme.fg, 0.28),
        } as CSSProperties
      }
    >
      <section className={`slide welcome ${activeKey === "welcome" ? "active" : ""}`}>
        <div className="glow" aria-hidden="true" />
        {data.branding.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external Storage URL
          <img src={data.branding.logoUrl} alt={brandName} className="logo" />
        ) : (
          <div className="monogram">{brandName.charAt(0).toUpperCase()}</div>
        )}
        <h1 className="brand-name">{brandName}</h1>
        {data.branding.tagline && <p className="tagline">{data.branding.tagline}</p>}
      </section>

      {slides.map((key) => (
        <section key={key} className={`slide ${key} ${activeKey === key ? "active" : ""}`}>
          {key === "services" && (
            <>
              <p className="corner-mark">{brandName}</p>
              <h2 className="slide-title">{menuTitle}</h2>
              <ul className="menu-list">
                {data.services.map((svc) => (
                  <li key={svc.id} className="menu-row">
                    <span className="menu-name">{svc.name}</span>
                    <span className="leader" aria-hidden="true" />
                    <span className="menu-price">R{svc.price.toFixed(0)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {key === "bookings" && (
            <>
              <p className="corner-mark">{brandName}</p>
              <h2 className="slide-title">{bookingsTitle}</h2>
              <ul className="bookings-list">
                {data.bookings.map((b) => (
                  <li key={b.id} className="booking-row">
                    <span className="booking-time">{formatClockTime(b.startTime)}</span>
                    <span className="booking-name">{b.customerName ?? "Guest"}</span>
                    <span className="booking-leader" aria-hidden="true" />
                    <span className="booking-service">{b.serviceName ?? ""}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {key === "queue" && (
            <>
              <p className="corner-mark">{brandName}</p>
              <h2 className="slide-title">{queueTitle}</h2>

              <div className="queue-table-wrap">
                <table className="queue-table">
                  <thead>
                    <tr>
                      <th>{settings.showQueueTicketNumber ? "Ticket" : "#"}</th>
                      <th>Name</th>
                      {cols.service && <th>Service</th>}
                      {cols.phone && <th>Phone</th>}
                      {cols.reference && <th>Booking ref</th>}
                      {cols.wait && <th className="c-num">Est. wait</th>}
                      {cols.waited && <th className="c-num">Waited</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {calledEntries.length > 0 && (
                      <tr className="group-row serving">
                        <td colSpan={colCount}>{nowServingLabel}</td>
                      </tr>
                    )}
                    {calledEntries.map(renderQueueRow)}
                    {calledEntries.length > 0 && waitingEntries.length > 0 && (
                      <tr className="group-row">
                        <td colSpan={colCount}>Up next</td>
                      </tr>
                    )}
                    {waitingEntries.map(renderQueueRow)}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ))}

      {phase === "rotation" && slides.length > 1 && (
        <div className="dots" role="presentation">
          {slides.map((key, i) => (
            <span key={key} className={`dot ${i === index ? "on" : ""}`} />
          ))}
        </div>
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
          overflow: hidden;
          background: var(--bg);
          color: var(--fg);
          font-family: "Inter", -apple-system, sans-serif;
          padding: 6vh 6vw;
          box-sizing: border-box;
        }

        .slide {
          position: absolute;
          inset: 6vh 6vw;
          display: flex;
          flex-direction: column;
          opacity: 0;
          pointer-events: none;
          transition: opacity 1.2s ease;
        }
        .slide.active {
          opacity: 1;
          pointer-events: auto;
        }

        .corner-mark {
          margin: 0 0 4vh 0;
          font-size: 1.1rem;
          letter-spacing: 0.02em;
          color: var(--fg-55);
          font-weight: 500;
        }

        /* ---- Welcome slide ---- */
        .welcome {
          align-items: center;
          justify-content: center;
          text-align: center;
          position: relative;
        }
        .glow {
          position: absolute;
          width: 60vw;
          height: 60vw;
          border-radius: 50%;
          background: radial-gradient(circle, var(--accent) 0%, transparent 70%);
          opacity: 0.16;
          filter: blur(10px);
          animation: pulse 6s ease-in-out infinite;
        }
        @keyframes pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.14;
          }
          50% {
            transform: scale(1.08);
            opacity: 0.22;
          }
        }
        .logo {
          max-height: 18vh;
          max-width: 60vw;
          object-fit: contain;
          margin-bottom: 4vh;
          position: relative;
        }
        .monogram {
          width: 14vh;
          height: 14vh;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: 6vh;
          font-weight: 700;
          background: var(--accent-soft);
          border: 2px solid var(--accent);
          color: var(--accent);
          margin-bottom: 4vh;
          position: relative;
        }
        .brand-name {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(3rem, 7vw, 6.5rem);
          font-weight: 700;
          letter-spacing: -0.01em;
          margin: 0;
          position: relative;
        }
        .tagline {
          margin: 2vh 0 0 0;
          font-size: clamp(1.2rem, 2.2vw, 2rem);
          color: var(--fg-70);
          font-weight: 400;
          position: relative;
        }

        /* ---- Shared slide title ---- */
        .slide-title {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(2.2rem, 4.5vw, 4rem);
          font-weight: 600;
          margin: 0 0 4vh 0;
        }

        /* ---- Services / menu slide ---- */
        .menu-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 2.4vh;
          overflow: hidden;
        }
        .menu-row {
          display: flex;
          align-items: baseline;
          gap: 1.2vw;
        }
        .menu-name {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.6rem, 3vw, 2.6rem);
          font-weight: 500;
          white-space: nowrap;
        }
        .leader {
          flex: 1;
          border-bottom: 0.3vh dotted var(--fg-28);
          margin-bottom: 0.8vh;
        }
        .menu-price {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.6rem, 3vw, 2.6rem);
          font-weight: 600;
          color: var(--accent);
          white-space: nowrap;
        }

        /* ---- Bookings slide ---- */
        .bookings-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 2.2vh;
          overflow: hidden;
        }
        .booking-row {
          display: flex;
          align-items: baseline;
          gap: 1.4vw;
        }
        .booking-time {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.5rem, 2.8vw, 2.3rem);
          font-weight: 600;
          color: var(--accent);
          white-space: nowrap;
          min-width: 4.5ch;
        }
        .booking-name {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.5rem, 2.8vw, 2.3rem);
          font-weight: 500;
          white-space: nowrap;
        }
        .booking-leader {
          flex: 1;
          border-bottom: 0.3vh dotted var(--fg-28);
          margin-bottom: 0.7vh;
        }
        .booking-service {
          font-size: clamp(1.1rem, 1.8vw, 1.6rem);
          color: var(--fg-70);
          white-space: nowrap;
        }

        /* ---- Live queue slide: a labelled table ---- */
        .queue-table-wrap {
          overflow: hidden;
        }
        .queue-table {
          width: 100%;
          border-collapse: collapse;
          font-size: clamp(1rem, 1.9vw, 1.7rem);
          color: var(--fg);
        }
        .queue-table th {
          text-align: left;
          font-size: clamp(0.85rem, 1.2vw, 1.1rem);
          font-weight: 600;
          letter-spacing: 0.04em;
          color: var(--fg-55);
          padding: 0 1.2vw 1.2vh 1.2vw;
          border-bottom: 2px solid var(--fg-28);
          white-space: nowrap;
        }
        .queue-table td {
          padding: 1.1vh 1.2vw;
          border-bottom: 1px solid var(--fg-28);
          white-space: nowrap;
          max-width: 28vw;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .queue-table .c-num {
          text-align: right;
        }
        .queue-table .c-lead {
          font-family: "Bricolage Grotesque", sans-serif;
          font-weight: 700;
          color: var(--accent);
          width: 1%;
        }
        .queue-table .c-name {
          font-family: "Bricolage Grotesque", sans-serif;
          font-weight: 600;
        }
        .queue-table .c-muted {
          color: var(--fg-70);
        }
        .queue-table .c-num {
          color: var(--fg-70);
          font-variant-numeric: tabular-nums;
        }
        .queue-table .group-row td {
          padding: 1.6vh 1.2vw 0.6vh 1.2vw;
          border-bottom: none;
          font-size: clamp(0.85rem, 1.2vw, 1.1rem);
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--fg-55);
        }
        .queue-table .group-row.serving td {
          color: var(--accent);
        }
        .queue-table .row.called td {
          background: var(--accent-soft);
          border-bottom-color: var(--accent);
        }
        .queue-table .row.called .c-name {
          font-weight: 700;
        }

        /* ---- Progress dots ---- */
        .dots {
          position: absolute;
          top: 4vh;
          right: 6vw;
          display: flex;
          gap: 1vh;
          z-index: 2;
        }
        .dot {
          width: 1.1vh;
          height: 1.1vh;
          border-radius: 50%;
          background: var(--fg-28);
          transition: background 0.4s ease;
        }
        .dot.on {
          background: var(--secondary);
        }

        @media (prefers-reduced-motion: reduce) {
          .glow {
            animation: none;
          }
          .slide {
            transition: none;
          }
        }
      `}</style>
    </div>
  )
}
