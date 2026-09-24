"use client"

// app/display/[slug]/DisplayScreen.tsx
/**
 * Ambient, non-interactive rotation for a TV in the waiting area. Design
 * notes (see conversation for the full brief):
 *   - Dark neutral canvas, not the tenant's raw primary_color as the
 *     background -- an admin-picked hex has no guaranteed contrast against
 *     text at TV viewing distance. primary_color/secondary_color are used
 *     as accents (wordmark glow, prices, position numbers, dots) instead.
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
import { fetchDisplayData, type DisplayData } from "./actions"

const POLL_MS = 5 * 60 * 1000

const DEFAULT_ACCENT = "#E2B33C"
const DEFAULT_SECONDARY = "#3E7C74"

type SlideKey = "welcome" | "services" | "bookings" | "queue"

/** Plain rgba conversion instead of CSS color-mix() -- some smart TV
 *  browsers (older Tizen/webOS/Android TV WebView builds) don't support
 *  color-mix() yet, and this only needs to run once per render anyway. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "")
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean
  const int = Number.parseInt(full, 16)
  if (full.length !== 6 || Number.isNaN(int)) return `rgba(226, 179, 60, ${alpha})` // DEFAULT_ACCENT fallback
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
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
  const accent = data.branding.primaryColor || DEFAULT_ACCENT
  const secondary = data.branding.secondaryColor || DEFAULT_SECONDARY
  const accentSoft = hexToRgba(accent, 0.22)

  const activeKey: SlideKey = phase === "welcome" ? "welcome" : slides[index] ?? "welcome"
  const menuTitle = settings.menuTitle?.trim() || "On the menu"
  const bookingsTitle = settings.bookingsTitle?.trim() || "Upcoming bookings"
  const queueTitle = settings.queueTitle?.trim() || "Live queue"
  const nowServingLabel = settings.nowServingLabel?.trim() || "Now serving"

  return (
    <div
      className="stage"
      style={{ "--accent": accent, "--secondary": secondary, "--accent-soft": accentSoft } as CSSProperties}
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

              {calledEntries.length > 0 && (
                <div className="now-serving">
                  <p className="now-serving-label">{nowServingLabel}</p>
                  <ul className="now-serving-list">
                    {calledEntries.map((q) => (
                      <li key={q.id} className="now-serving-row">
                        {q.ticketNumber && <span className="now-serving-ticket">{q.ticketNumber}</span>}
                        <span className="now-serving-name">{q.customerName ?? "Guest"}</span>
                        {q.serviceName && <span className="now-serving-service">{q.serviceName}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {waitingEntries.length > 0 && (
                <ul className="queue-list">
                  {waitingEntries.map((q) => (
                    <li key={q.id} className="queue-row">
                      <span className="queue-position">{q.position}</span>
                      <span className="queue-name">{q.customerName ?? "Guest"}</span>
                      {q.ticketNumber && <span className="queue-ticket">{q.ticketNumber}</span>}
                      <span className="queue-service">{q.serviceName ?? ""}</span>
                    </li>
                  ))}
                </ul>
              )}
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
          background: #15110d;
        }
      `}</style>

      <style jsx>{`
        .stage {
          position: fixed;
          inset: 0;
          overflow: hidden;
          background: radial-gradient(120% 100% at 50% -10%, #221a12 0%, #15110d 55%, #100c09 100%);
          color: #f5f1e8;
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
          color: rgba(245, 241, 232, 0.5);
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
          color: rgba(245, 241, 232, 0.72);
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
          border-bottom: 0.3vh dotted rgba(245, 241, 232, 0.28);
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
          border-bottom: 0.3vh dotted rgba(245, 241, 232, 0.28);
          margin-bottom: 0.7vh;
        }
        .booking-service {
          font-size: clamp(1.1rem, 1.8vw, 1.6rem);
          color: rgba(245, 241, 232, 0.65);
          white-space: nowrap;
        }

        /* ---- Live queue slide ---- */
        .now-serving {
          margin-bottom: 4vh;
          padding: 2.4vh 2.6vw;
          border-radius: 1.4vh;
          background: var(--accent-soft);
          border: 2px solid var(--accent);
          max-width: 60vw;
        }
        .now-serving-label {
          margin: 0 0 1.4vh 0;
          font-size: 1.1rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--accent);
        }
        .now-serving-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 1vh;
        }
        .now-serving-row {
          display: flex;
          align-items: baseline;
          gap: 1.2vw;
        }
        .now-serving-ticket {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.8rem, 3.4vw, 2.8rem);
          font-weight: 800;
          color: var(--accent);
          letter-spacing: 0.02em;
        }
        .now-serving-name {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.8rem, 3.4vw, 2.8rem);
          font-weight: 700;
        }
        .now-serving-service {
          font-size: clamp(1.1rem, 1.8vw, 1.5rem);
          color: rgba(245, 241, 232, 0.7);
        }
        .queue-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 1.8vh;
          overflow: hidden;
        }
        .queue-row {
          display: flex;
          align-items: center;
          gap: 1.4vw;
        }
        .queue-position {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.2rem, 2vw, 1.7rem);
          font-weight: 600;
          color: var(--secondary);
          min-width: 2.4ch;
        }
        .queue-name {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.4rem, 2.4vw, 2rem);
          font-weight: 500;
        }
        .queue-ticket {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1rem, 1.6vw, 1.3rem);
          font-weight: 600;
          color: rgba(245, 241, 232, 0.5);
        }
        .queue-service {
          font-size: clamp(1rem, 1.6vw, 1.4rem);
          color: rgba(245, 241, 232, 0.6);
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
          background: rgba(245, 241, 232, 0.25);
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
