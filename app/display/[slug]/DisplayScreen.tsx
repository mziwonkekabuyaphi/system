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

import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { fetchDisplayData, type DisplayData } from "./actions"
import { BoardScreen } from "./BoardScreen"
import { CallAlertOverlay, type CallAlertEntry } from "./CallAlertOverlay"
import {
  DEFAULT_ACCENT,
  DEFAULT_SECONDARY,
  ensureContrast,
  formatMinutes,
  hexToRgba,
  resolveThemeTokens,
} from "./displayTheme"

// 20s: a live queue shouldn't take 5 minutes to show that someone was called.
const POLL_MS = 20 * 1000
// With the call alert on, a call should pop up within a few seconds, not 20.
const ALERT_POLL_MS = 5 * 1000

type SlideKey = "welcome" | "services" | "bookings" | "queue"

/** "14:30" for a booking's start_time. Rendered in the TV's local time,
 *  same as the browser clock on the wall -- no server-side tenant
 *  timezone conversion needed for something displayed on-site. */
function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// Tenant logo in a rounded white tile with a slowly rotating ring + orbiting
// dot (same look as the kiosk welcome screen). Ring, dot and glow use the
// tenant's primary colour (`accent`). Sizes are CSS lengths (e.g. "22vh") so
// it scales with the TV. Ring/glow colours are precomputed with hexToRgba
// instead of CSS color-mix(), which older smart-TV browsers don't support.
function BrandLogo({
  url,
  accent,
  size,
  ringWidth,
  dotSize,
}: {
  url: string
  accent: string
  size: string
  ringWidth: string
  dotSize: string
}) {
  return (
    <span
      className="logoWrap"
      aria-hidden="true"
      style={
        {
          "--s": size,
          "--bw": ringWidth,
          "--dot": dotSize,
          "--ring-color": hexToRgba(accent, 0.35),
          "--glow-lo": hexToRgba(accent, 0.22),
          "--glow-hi": hexToRgba(accent, 0.42),
          "--dot-color": accent,
        } as CSSProperties
      }
    >
      <span className="logoTile">
        {/* eslint-disable-next-line @next/next/no-img-element -- external Storage URL */}
        <img src={url} alt="" className="logoImg" />
      </span>
      <span className="ring" />

      <style jsx>{`
        .logoWrap {
          position: relative;
          display: block;
          flex: none;
          width: var(--s);
          height: var(--s);
        }
        .logoTile {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          padding: calc(var(--s) * 0.107);
          box-sizing: border-box;
          background: #ffffff; /* keeps transparent / dark logos readable */
          border-radius: calc(var(--s) * 0.238);
          overflow: hidden;
          box-shadow: 0 6px 24px rgba(23, 20, 18, 0.12);
          animation: logoPulse 2.4s ease-in-out infinite;
        }
        .logoImg {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .ring {
          position: absolute;
          inset: calc(var(--s) * -0.095);
          border-radius: calc(var(--s) * 0.333);
          border: var(--bw) solid var(--ring-color);
          animation: ringRotate 3s linear infinite;
        }
        .ring::before {
          content: "";
          position: absolute;
          top: calc(var(--bw) * -0.5 - var(--dot) * 0.5);
          left: 50%;
          width: var(--dot);
          height: var(--dot);
          margin-left: calc(var(--dot) * -0.5);
          border-radius: 50%;
          background: var(--dot-color);
          box-shadow: 0 0 var(--dot) var(--dot-color);
        }
        @keyframes ringRotate {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes logoPulse {
          0%,
          100% {
            box-shadow: 0 6px 24px rgba(23, 20, 18, 0.12), 0 0 calc(var(--s) * 0.17) var(--glow-lo);
          }
          50% {
            box-shadow: 0 6px 24px rgba(23, 20, 18, 0.12), 0 0 calc(var(--s) * 0.33) var(--glow-hi);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ring,
          .logoTile {
            animation: none;
          }
        }
      `}</style>
    </span>
  )
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
  // Drives the board layout's Live / Reconnecting pill.
  const [online, setOnline] = useState(true)

  const callAlertEnabled = data.settings.callAlertEnabled
  const pollMs = callAlertEnabled ? ALERT_POLL_MS : POLL_MS
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const result = await fetchDisplayData(slug)
        // On failure, keep showing the last known-good data rather than
        // blanking an unattended screen over a transient network hiccup.
        if (result.ok) setData(result.data)
        setOnline(result.ok)
      } catch {
        setOnline(false)
      }
    }, pollMs)
    return () => clearInterval(id)
  }, [slug, pollMs])

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
  // Stable key: only changes when the set of eligible slides actually
  // changes, not on every poll (each poll hands back a brand-new `data`
  // object, which used to rebuild `slides` and restart the slide timer
  // before it could ever fire).
  const slidesKey = [
    settings.showServices && data.services.length > 0 ? "services" : "",
    settings.showBookings && data.bookings.length > 0 ? "bookings" : "",
    settings.showQueue && data.queue.length > 0 ? "queue" : "",
  ]
    .filter(Boolean)
    .join(",")

  const slides = useMemo<SlideKey[]>(
    () => (slidesKey ? (slidesKey.split(",") as SlideKey[]) : []),
    [slidesKey],
  )

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

  // ---- Full-screen "customer called" alert --------------------------------
  // A call is detected by diffing which entries are "called" between polls:
  // anything called that we haven't seen before gets queued for the overlay.
  // The first data this tab sees is only recorded, never alerted -- so
  // reloading the TV doesn't replay customers who were called earlier.
  // Several calls close together show one after another, each for the full
  // configured time.
  const callAlertSeconds = settings.callAlertSeconds
  const seenCalledRef = useRef<Set<string> | null>(null)
  const [alertQueue, setAlertQueue] = useState<CallAlertEntry[]>([])

  useEffect(() => {
    const currentIds = new Set(calledEntries.map((e) => e.id))
    if (seenCalledRef.current === null) {
      seenCalledRef.current = currentIds
      return
    }
    const seen = seenCalledRef.current
    const fresh = calledEntries.filter((e) => !seen.has(e.id))
    seenCalledRef.current = currentIds
    if (callAlertEnabled && fresh.length > 0) {
      setAlertQueue((q) => [
        ...q,
        ...fresh.map((e) => ({
          id: e.id,
          ticketNumber: e.ticketNumber ?? null,
          customerName: e.customerName ?? null,
          serviceName: e.serviceName ?? null,
        })),
      ])
    }
  }, [calledEntries, callAlertEnabled])

  // Drop alerts that no longer apply: admin switched the feature off, or the
  // customer was marked done / removed before their alert came up.
  useEffect(() => {
    setAlertQueue((q) => {
      if (!callAlertEnabled) return q.length === 0 ? q : []
      const stillCalled = new Set(calledEntries.map((e) => e.id))
      const kept = q.filter((a) => stillCalled.has(a.id))
      return kept.length === q.length ? q : kept
    })
  }, [callAlertEnabled, calledEntries])

  // The head of the queue stays up for callAlertSeconds, then the next one.
  const activeAlert = alertQueue[0] ?? null
  const activeAlertId = activeAlert?.id ?? null
  useEffect(() => {
    if (!activeAlertId) return
    const id = setTimeout(() => setAlertQueue((q) => q.slice(1)), callAlertSeconds * 1000)
    return () => clearTimeout(id)
  }, [activeAlertId, callAlertSeconds])

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
    email: settings.showQueueEmail && data.queue.some((q) => q.emailMasked),
    custom: settings.showQueueCustom && data.queue.some((q) => q.customAnswer),
    reference: settings.showQueueReference && data.queue.some((q) => q.bookingReference),
    wait: settings.showQueueWaitEstimate && waitingEntries.some((q) => q.estimatedWaitMinutes !== null),
    waited: settings.showQueueDuration,
  }
  // The custom column is headed with the shop's own question (e.g. "Car registration").
  const customHeading = data.queue.find((q) => q.customLabel)?.customLabel ?? "Details"
  const colCount = 2 + Object.values(cols).filter(Boolean).length

  function renderQueueRow(q: DisplayData["queue"][number]) {
    const isCalled = q.status === "called"
    // First column: the ticket when that field is on, else the position.
    // Entries with no ticket (old rows, promoted bookings) show a dash
    // rather than a position, so one column never mixes two meanings.
    const lead = settings.showQueueTicketNumber ? (q.ticketNumber ?? "—") : isCalled ? "Now" : String(q.position)
    // Waiting: minutes since they joined. Called: minutes since they were
    // called (time at the counter), so the figure keeps counting up.
    const waitedFrom = isCalled ? (q.calledAt ?? q.joinedAt) : q.joinedAt
    const waitedMin = nowMs !== null ? Math.max(0, Math.floor((nowMs - new Date(waitedFrom).getTime()) / 60000)) : null
    return (
      <tr key={q.id} className={isCalled ? "row called" : "row"}>
        <td className="c-lead" style={{ color: accent }}>
          {lead}
        </td>
        <td className="c-name">{q.customerName ?? "Guest"}</td>
        {cols.service && <td className="c-muted">{q.serviceName ?? "—"}</td>}
        {cols.phone && <td className="c-muted">{q.phoneMasked ?? "—"}</td>}
        {cols.email && <td className="c-muted">{q.emailMasked ?? "—"}</td>}
        {cols.custom && <td className="c-muted">{q.customAnswer ?? "—"}</td>}
        {cols.reference && <td className="c-muted">{q.bookingReference ?? "—"}</td>}
        {cols.wait && (
          <td className="c-num">
            {isCalled
              ? "Now"
              : q.estimatedWaitMinutes === null
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

  // Live board: same data + polling, different presentation. All hooks above
  // have already run, so branching here is safe.
  const alertOverlay = activeAlert ? (
    <CallAlertOverlay
      key={activeAlert.id}
      entry={activeAlert}
      label={nowServingLabel}
      seconds={callAlertSeconds}
      accent={accent}
      bg={theme.bgCss}
      fg={theme.fg}
    />
  ) : null

  if (settings.layout === "board") {
    return (
      <>
        <BoardScreen data={data} online={online} />
        {alertOverlay}
      </>
    )
  }

  return (
    <>
    {alertOverlay}
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
          <span className="logoSlot">
            <BrandLogo url={data.branding.logoUrl} accent={accent} size="22vh" ringWidth="0.4vh" dotSize="1.6vh" />
          </span>
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
                      {cols.email && <th>Email</th>}
                      {cols.custom && <th>{customHeading}</th>}
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
                      <tr className="group-row up-next">
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
        .logoSlot {
          display: block;
          margin-bottom: 6vh; /* the ring sits outside the tile, give it room */
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
          table-layout: fixed;
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
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* Fixed column widths so every value sits directly under its heading.
           Ticket column is narrow, wait/waited are medium, the rest share the space. */
        .queue-table th:first-child {
          width: 14%;
        }
        .queue-table th.c-num {
          width: 17%;
        }
        .queue-table .c-num {
          text-align: left !important;
        }
        .queue-table .c-lead {
          font-family: "Bricolage Grotesque", sans-serif;
          font-weight: 700;
          color: var(--accent) !important;
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
        /* Divider between "Now serving" and "Up next", in the primary colour. */
        .queue-table .group-row.up-next td {
          border-top: 2px solid var(--accent);
          padding-top: 2.2vh;
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
    </>
  )
}
