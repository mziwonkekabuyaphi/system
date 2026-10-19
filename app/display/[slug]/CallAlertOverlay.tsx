"use client"

// app/display/[slug]/CallAlertOverlay.tsx
/**
 * Full-screen takeover shown on the public display the moment an admin calls
 * a customer. DisplayScreen decides WHEN to show it (it spots a newly
 * "called" queue entry and times it using display_call_alert_seconds); this
 * component only draws it. It sits above both layouts (rotation + board).
 *
 * Colours come from the same resolved theme tokens as the rest of the TV, so
 * contrast stays safe on any admin-chosen background. Sizes are vh/vw so it
 * scales to any TV. A thin bar along the bottom drains over `seconds` so
 * people can see the alert is temporary.
 */

import type { CSSProperties } from "react"
import { hexToRgba } from "./displayTheme"

export type CallAlertEntry = {
  id: string
  ticketNumber: string | number | null
  customerName: string | null
  serviceName: string | null
}

export function CallAlertOverlay({
  entry,
  label,
  seconds,
  accent,
  bg,
  fg,
}: {
  entry: CallAlertEntry
  /** e.g. "Now serving" -- the admin's own wording. */
  label: string
  seconds: number
  accent: string
  /** Resolved CSS background (theme.bgCss) and text colour (theme.fg). */
  bg: string
  fg: string
}) {
  const hasTicket = entry.ticketNumber !== null && entry.ticketNumber !== undefined && `${entry.ticketNumber}` !== ""
  const name = entry.customerName?.trim() || "Guest"

  return (
    <div
      className="overlay"
      role="alert"
      aria-live="assertive"
      style={
        {
          "--accent": accent,
          "--accent-soft": hexToRgba(accent, 0.18),
          "--bg": bg,
          "--fg": fg,
          "--fg-70": hexToRgba(fg, 0.7),
          "--secs": `${seconds}s`,
        } as CSSProperties
      }
    >
      <div className="glow" aria-hidden="true" />

      <div className="content">
        <p className="label">{label}</p>
        {/* Ticket is the hero. No ticket (old rows / promoted bookings):
            the name takes its place so the screen is never empty. */}
        <div className="hero">{hasTicket ? entry.ticketNumber : name}</div>
        {hasTicket && <p className="name">{name}</p>}
        {entry.serviceName && <p className="service">{entry.serviceName}</p>}
      </div>

      <div className="bar" aria-hidden="true" />

      <style jsx>{`
        .overlay {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          background: var(--bg);
          color: var(--fg);
          font-family: "Inter", -apple-system, sans-serif;
          animation: overlayIn 0.5s ease-out both;
        }
        .glow {
          position: absolute;
          width: 90vmin;
          height: 90vmin;
          border-radius: 50%;
          background: radial-gradient(circle, var(--accent) 0%, transparent 70%);
          opacity: 0.2;
          animation: pulse 2.4s ease-in-out infinite;
        }
        .content {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2.5vh;
          padding: 0 6vw;
          max-width: 100%;
          box-sizing: border-box;
          animation: contentIn 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
        }
        .label {
          margin: 0;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.6rem, 3.6vw, 3.4rem);
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--fg-70);
        }
        .hero {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(6rem, 26vw, 24rem);
          line-height: 1;
          font-weight: 700;
          color: var(--accent);
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .name {
          margin: 0;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(2.4rem, 7vw, 6.5rem);
          font-weight: 600;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .service {
          margin: 0;
          font-size: clamp(1.3rem, 2.6vw, 2.4rem);
          color: var(--fg-70);
        }
        .bar {
          position: absolute;
          left: 0;
          bottom: 0;
          height: 1.2vh;
          width: 100%;
          background: var(--accent);
          transform-origin: left center;
          animation: drain var(--secs) linear forwards;
        }

        @keyframes overlayIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes contentIn {
          from {
            opacity: 0;
            transform: scale(0.85);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.16;
          }
          50% {
            transform: scale(1.1);
            opacity: 0.28;
          }
        }
        @keyframes drain {
          from {
            transform: scaleX(1);
          }
          to {
            transform: scaleX(0);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .overlay,
          .content,
          .glow {
            animation: none;
          }
        }
      `}</style>
    </div>
  )
}
