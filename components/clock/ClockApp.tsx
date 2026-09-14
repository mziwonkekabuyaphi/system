"use client"

// components/clock/ClockApp.tsx
/**
 * The staff clock-in pad itself: enter PIN -> Enter -> confirmation
 * (clocked in / clocked out) -> auto-resets back to a blank pad.
 *
 * Talks to the tenant only via submitClockPin() in ../../app/clock/[slug]/
 * actions.ts, which re-resolves tenantId from `slug` on every call — this
 * component never holds or sends a tenantId itself.
 *
 * No idle timer needed the way the customer kiosk has one: this screen
 * has nothing to reset except its own PIN buffer, which it already clears
 * after every submit (success or error) and on the confirmation
 * auto-return below.
 */

import { useState } from "react"
import { submitClockPin, type ClockAction } from "@/app/clock/[slug]/actions"

const MAX_PIN_LENGTH = 6
const CONFIRMATION_DISPLAY_MS = 3500

interface ClockAppProps {
  slug: string
  displayName: string
  logoUrl: string | null
  primaryColor: string
}

interface Confirmation {
  staffName: string
  action: ClockAction
  time: string
  hoursWorked?: number
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatHours(hours: number): string {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} hr`
  return `${h} hr ${m} min`
}

export function ClockApp({ slug, displayName, logoUrl, primaryColor }: ClockAppProps) {
  const [pin, setPin] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  const cssVars = { "--accent": primaryColor } as React.CSSProperties

  function pressDigit(digit: string) {
    if (busy || confirmation) return
    setError(null)
    setPin((p) => (p.length >= MAX_PIN_LENGTH ? p : p + digit))
  }

  function backspace() {
    if (busy || confirmation) return
    setError(null)
    setPin((p) => p.slice(0, -1))
  }

  function clear() {
    if (busy || confirmation) return
    setError(null)
    setPin("")
  }

  async function submit() {
    if (pin.length < 4 || busy) return
    setBusy(true)
    setError(null)

    const result = await submitClockPin(slug, pin)
    setBusy(false)
    setPin("")

    if (!result.ok) {
      setError(result.error)
      return
    }

    setConfirmation(result.data)
    setTimeout(() => setConfirmation(null), CONFIRMATION_DISPLAY_MS)
  }

  return (
    <div className="clock" style={cssVars}>
      {confirmation ? (
        <div className="confirm">
          <p className="confirmAction">{confirmation.action === "in" ? "Clocked in" : "Clocked out"}</p>
          <h1 className="confirmName">{confirmation.staffName}</h1>
          <p className="confirmTime">at {formatTime(confirmation.time)}</p>
          {confirmation.action === "out" && confirmation.hoursWorked != null && (
            <p className="confirmHours">Worked {formatHours(confirmation.hoursWorked)}</p>
          )}
        </div>
      ) : (
        <div className="pad">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="logo" />
          )}
          <h1 className="shopName">{displayName}</h1>
          <p className="prompt">Enter your PIN to clock in or out</p>

          <div className="dots" aria-hidden="true">
            {Array.from({ length: MAX_PIN_LENGTH }).map((_, i) => (
              <span key={i} className={`dot ${i < pin.length ? "filled" : ""}`} />
            ))}
          </div>

          {error && <p className="error">{error}</p>}
          {busy && <p className="status">Checking…</p>}

          <div className="keys">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" className="key" onClick={() => pressDigit(d)} disabled={busy}>
                {d}
              </button>
            ))}
            <button type="button" className="key keyMuted" onClick={clear} disabled={busy}>
              Clear
            </button>
            <button type="button" className="key" onClick={() => pressDigit("0")} disabled={busy}>
              0
            </button>
            <button type="button" className="key keyMuted" onClick={backspace} disabled={busy}>
              ⌫
            </button>
          </div>

          <button
            type="button"
            className="enter"
            onClick={submit}
            disabled={pin.length < 4 || busy}
          >
            Enter
          </button>
        </div>
      )}

      <style jsx global>{`
        html,
        body {
          margin: 0;
          padding: 0;
          height: 100%;
          background: #17140f;
          -webkit-tap-highlight-color: transparent;
          overscroll-behavior: none;
        }
      `}</style>

      <style jsx>{`
        .clock {
          min-height: 100vh;
          width: 100%;
          background: #17140f;
          color: #f4f1ea;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px;
        }

        .pad {
          width: 100%;
          max-width: 380px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 6px;
        }

        .logo {
          max-height: 64px;
          max-width: 220px;
          object-fit: contain;
          margin-bottom: 8px;
          border-radius: 12px;
        }

        .shopName {
          font-size: 28px;
          font-weight: 700;
          margin: 0;
        }

        .prompt {
          font-size: 15px;
          color: #b8b0a0;
          margin: 0 0 16px;
        }

        .dots {
          display: flex;
          gap: 12px;
          margin-bottom: 12px;
        }

        .dot {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 2px solid #4a443a;
          background: transparent;
        }

        .dot.filled {
          background: var(--accent);
          border-color: var(--accent);
        }

        .error {
          color: #e3968a;
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 8px;
          min-height: 18px;
        }

        .status {
          color: #b8b0a0;
          font-size: 14px;
          margin: 0 0 8px;
        }

        .keys {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
          width: 100%;
          margin-top: 8px;
        }

        .key {
          min-height: 76px;
          border-radius: 16px;
          border: 1px solid #322d24;
          background: #221e17;
          color: #f4f1ea;
          font-size: 26px;
          font-weight: 600;
          cursor: pointer;
        }

        .key:active {
          background: #2c271e;
        }

        .key:disabled {
          opacity: 0.5;
        }

        .keyMuted {
          font-size: 15px;
          font-weight: 600;
          color: #b8b0a0;
        }

        .enter {
          margin-top: 20px;
          width: 100%;
          min-height: 68px;
          border: none;
          border-radius: 16px;
          background: var(--accent);
          color: #fff;
          font-size: 20px;
          font-weight: 700;
          cursor: pointer;
        }

        .enter:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .confirm {
          text-align: center;
        }

        .confirmAction {
          font-size: 18px;
          font-weight: 700;
          color: var(--accent);
          margin: 0 0 8px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .confirmName {
          font-size: 42px;
          font-weight: 800;
          margin: 0 0 8px;
        }

        .confirmTime {
          font-size: 17px;
          color: #b8b0a0;
          margin: 0;
        }

        .confirmHours {
          font-size: 17px;
          color: #b8b0a0;
          margin: 8px 0 0;
        }
      `}</style>
    </div>
  )
}
