"use client"

// app/display/[slug]/shisha/ShishaLoungeView.tsx
/**
 * "Lounge" layout for the Shisha TV (settings.layout === "lounge"). Same data,
 * polling, timers and time-up alert as the board layout: ShishaDisplayScreen
 * owns all of that and hands this component ready-made views. This file only
 * draws.
 *
 * The idea: one device gets the stage, everything else is a quiet list.
 *   - Left, the hero: whichever session is closest to running out (an overdue
 *     one always wins). A big coal ring in the tenant's PRIMARY colour sweeping
 *     into the SECONDARY colour as it drains, a dashed orbit with a slow-moving
 *     dot, embers drifting up behind it. When nothing is running, the hero
 *     becomes a "free devices" welcome instead.
 *   - Right, the burn-down list: every device as a row with a thin coal bar
 *     that shortens in real time, so the whole lounge can be read at a glance.
 *   - Behind it all, two slow auras: primary top-left, secondary bottom-right.
 *
 * Colour rules: a running session uses the brand's primary colour (secondary is
 * the gradient end, aura and orbit dot). Refill / overdue / paused / free keep
 * their fixed status colours, because those carry meaning. Every colour is
 * nudged for contrast by the parent against the chosen background.
 *
 * Motion is the point of this layout, so it is all slow and ambient; it is
 * switched off under prefers-reduced-motion.
 */

import type { CSSProperties } from "react"

import type { ShishaDisplayLabelKey } from "@/app/admin/shisha/shisha-display-types"
import { hexToRgba, mixHex, type ThemeTokens } from "../displayTheme"
import type { ShishaDisplayData, ShishaDisplayFailure } from "./actions"
import { timerText, type CardState, type CardView } from "./shisha-display-shared"

// Fixed, computed positions: no Math.random(), so server and client render the same markup.
const EMBERS = Array.from({ length: 18 }, (_, i) => ({
  x: (i * 37 + 11) % 96,
  size: 0.45 + ((i * 13) % 7) / 7,
  delay: -((i * 53) % 160) / 10,
  dur: 11 + ((i * 7) % 9),
  dx: ((i * 29) % 21) - 10,
}))

const STAT_ORDER: CardState[] = ["active", "refill", "expired", "paused", "available"]

export function ShishaLoungeView({
  data,
  views,
  allViews,
  counts,
  online,
  blocked,
  nowMs,
  mounted,
  label,
  theme,
  accent,
  secondary,
  statusColor,
  tickerItems,
}: {
  data: ShishaDisplayData
  /** Sorted + filtered by the settings: what the list shows. */
  views: CardView[]
  /** Every device: used for the hero and the counts. */
  allViews: CardView[]
  counts: Record<CardState, number>
  online: boolean
  blocked: ShishaDisplayFailure | null
  nowMs: number
  mounted: boolean
  label: (key: ShishaDisplayLabelKey) => string
  theme: ThemeTokens
  accent: string
  secondary: string
  statusColor: (state: CardState) => string
  tickerItems: string[]
}) {
  const { settings } = data
  const brandName = data.branding.displayName?.trim() || "Welcome"
  const title = settings.title?.trim() || "Shisha status"
  const clock = mounted ? new Date(nowMs) : null

  /** Running sessions use the brand colour; every other state keeps its fixed one. */
  const colorOf = (state: CardState) => (state === "active" ? accent : statusColor(state))

  // The hero: overdue first (most overdue first), then the running session closest to
  // finishing, then paused ones. null = nothing live.
  const live = allViews.filter((v) => v.raw !== null)
  const hero =
    [...live].sort((a, b) => {
      const rank = (v: CardView) => (v.state === "paused" ? 2 : v.state === "expired" ? 0 : 1)
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      return (a.raw ?? 0) - (b.raw ?? 0)
    })[0] ?? null

  const heroState: CardState = hero?.state ?? "available"
  const heroColor = colorOf(heroState)
  const heroSession = hero?.device.session ?? null
  const heroMeta = [heroSession?.firstName, hero?.device.station, hero?.device.name].filter((m): m is string =>
    Boolean(m && m.trim()),
  )

  // List: two columns once there are many devices, row height scales to fit.
  const listCols = views.length > 10 ? 2 : 1
  const listRows = Math.max(1, Math.ceil(views.length / listCols))
  const rowHeightVh = Math.min(9, 58 / listRows)

  const stage = {
    "--bg": theme.bgCss,
    "--fg": theme.fg,
    "--fg-70": hexToRgba(theme.fg, 0.7),
    "--fg-55": hexToRgba(theme.fg, 0.55),
    "--fg-28": hexToRgba(theme.fg, 0.28),
    "--fg-10": hexToRgba(theme.fg, 0.1),
    "--accent": accent,
    "--secondary": secondary,
    "--accent-14": hexToRgba(accent, 0.14),
    "--accent-35": hexToRgba(accent, 0.35),
    "--secondary-10": hexToRgba(secondary, 0.1),
    "--card": mixHex(theme.bgSolid, theme.fg, 0.06),
    "--disc": mixHex(theme.bgSolid, theme.fg, 0.03),
    "--track": hexToRgba(theme.fg, 0.12),
    "--lcols": listCols,
    "--lrows": listRows,
    "--rh": `${rowHeightVh.toFixed(2)}vh`,
    "--ticker-s": `${Math.max(24, tickerItems.length * 7)}s`,
  } as CSSProperties

  const heroStyle = {
    "--sc": heroColor,
    "--glow": hexToRgba(heroColor, 0.38),
    "--pct": hero?.pct ?? 0,
  } as CSSProperties

  const heroTimer = timerText(hero?.raw ?? null)
  const kicker = hero && (heroState === "active" || heroState === "refill") ? label("soonest") : label(heroState)

  return (
    <div className="stage" style={stage}>
      <div className="aura a1" aria-hidden="true" />
      <div className="aura a2" aria-hidden="true" />

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

          <main className="body">
            {/* ---- Hero ---- */}
            <section className={`hero ${heroState}`} style={heroStyle}>
              <div className="embers" aria-hidden="true">
                <span className="smoke sm1" />
                <span className="smoke sm2" />
                {EMBERS.map((e, i) => (
                  <span
                    key={i}
                    className="ember"
                    style={
                      {
                        "--x": `${e.x}%`,
                        "--sz": `${e.size.toFixed(2)}vh`,
                        "--delay": `${e.delay.toFixed(1)}s`,
                        "--dur": `${e.dur}s`,
                        "--dx": `${e.dx}vw`,
                        "--ec": i % 2 === 0 ? accent : secondary,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>

              <div className="ring-wrap">
                {hero && heroState !== "paused" && <span className="orbit" aria-hidden="true" />}
                <div className="ring">
                  <div className="disc">
                    {allViews.length === 0 ? (
                      <span className="flame" aria-hidden="true" />
                    ) : hero ? (
                      <>
                        <span className="h-timer">{heroTimer}</span>
                        <span className="h-chip">{label(heroState)}</span>
                      </>
                    ) : (
                      <span className="flame" aria-hidden="true" />
                    )}
                  </div>
                </div>
              </div>

              <div className="h-info">
                {allViews.length === 0 ? (
                  <p className="h-empty">{label("empty")}</p>
                ) : hero ? (
                  <>
                    <p className="h-kicker">{kicker}</p>
                    <h2 className="h-code">{hero.device.code}</h2>
                    {heroSession?.flavour && <p className="h-flavour">{heroSession.flavour}</p>}
                    {heroMeta.slice(0, 2).map((m, i) => (
                      <p key={i} className="h-meta">
                        {m}
                      </p>
                    ))}
                  </>
                ) : (
                  <>
                    <p className="h-kicker">{label("available")}</p>
                    <h2 className="h-code">{counts.available}</h2>
                    <p className="h-flavour">{tickerItems[0]}</p>
                  </>
                )}
              </div>
            </section>

            {/* ---- Burn-down list ---- */}
            <section className="side">
              {settings.showStats && (
                <div className="stats" aria-label="Summary">
                  {STAT_ORDER.map((s) => (
                    <span
                      key={s}
                      className={`stat${counts[s] === 0 ? " zero" : ""}`}
                      style={{ "--sc": colorOf(s) } as CSSProperties}
                    >
                      <b>{counts[s]}</b>
                      {label(s)}
                    </span>
                  ))}
                </div>
              )}

              {views.length === 0 ? (
                <p className="list-empty">{label("empty")}</p>
              ) : (
                <ul className="list">
                  {views.map(({ device, state, raw, pct }) => {
                    const s = device.session
                    const timer = timerText(raw)
                    const sub = s?.flavour ?? device.name ?? device.station ?? ""
                    return (
                      <li
                        key={device.id}
                        className={`row ${state}${hero && hero.device.id === device.id ? " focus" : ""}`}
                        style={{ "--sc": colorOf(state), "--w": `${pct}%` } as CSSProperties}
                      >
                        <span className="r-code">{device.code}</span>
                        <span className="r-sub">{sub}</span>
                        <span className="r-time">{timer ?? label(state)}</span>
                        <span className="r-bar" aria-hidden="true">
                          <i />
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </main>

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
          gap: 2.4vh;
          padding: 4vh 4vw;
          box-sizing: border-box;
          overflow: hidden;
          background: var(--bg);
          color: var(--fg);
          font-family: "Inter", -apple-system, sans-serif;
        }
        .blocked {
          position: relative;
          margin: auto;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.6rem, 3vw, 2.6rem);
          color: var(--fg-70);
        }

        /* ---- ambient auras: primary top-left, secondary bottom-right ---- */
        .aura {
          position: absolute;
          border-radius: 50%;
          pointer-events: none;
          filter: blur(24px);
        }
        .a1 {
          top: -22vh;
          left: -14vw;
          width: 58vw;
          height: 58vw;
          background: radial-gradient(circle, var(--accent) 0%, transparent 68%);
          opacity: 0.2;
          animation: driftA 46s ease-in-out infinite alternate;
        }
        .a2 {
          right: -16vw;
          bottom: -30vh;
          width: 62vw;
          height: 62vw;
          background: radial-gradient(circle, var(--secondary) 0%, transparent 68%);
          opacity: 0.2;
          animation: driftB 58s ease-in-out infinite alternate;
        }

        /* ---- header ---- */
        .head {
          position: relative;
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 2vw;
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
          box-shadow: 0 0 3vh var(--accent-35);
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
          box-shadow: 0 0 3vh var(--accent-35);
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
          background: var(--secondary);
        }
        .pill.on .pill-dot {
          animation: blink 1.6s ease-in-out infinite;
        }
        .pill.off .pill-dot {
          background: #d9a441;
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

        /* ---- body: hero + list ---- */
        .body {
          position: relative;
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
          gap: 2.4vw;
        }

        /* ---- hero ---- */
        .hero {
          --ring: min(26vw, 50vh);
          position: relative;
          min-height: 0;
          display: flex;
          align-items: center;
          gap: 3vw;
          padding: 0 3vw;
          overflow: hidden;
          border-radius: 3vh;
          border: 1px solid var(--accent-35);
          background: linear-gradient(150deg, var(--accent-14) 0%, var(--secondary-10) 55%, transparent 100%), var(--card);
        }
        .embers {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
        .ember {
          position: absolute;
          bottom: -2vh;
          left: var(--x);
          width: var(--sz);
          height: var(--sz);
          border-radius: 50%;
          background: var(--ec);
          box-shadow: 0 0 1.4vh var(--ec);
          opacity: 0;
          animation: rise var(--dur) linear infinite;
          animation-delay: var(--delay);
        }
        .smoke {
          position: absolute;
          border-radius: 50%;
          background: var(--fg-10);
          filter: blur(5vh);
        }
        .sm1 {
          left: 6%;
          bottom: -22%;
          width: 38%;
          height: 60%;
          animation: smoke 19s ease-in-out infinite;
        }
        .sm2 {
          right: 4%;
          bottom: -30%;
          width: 30%;
          height: 56%;
          animation: smoke 26s ease-in-out infinite reverse;
        }

        .ring-wrap {
          position: relative;
          flex: none;
          width: var(--ring);
          height: var(--ring);
        }
        .orbit {
          position: absolute;
          inset: -6%;
          border-radius: 50%;
          border: 1px dashed var(--accent-35);
          animation: spin 18s linear infinite;
        }
        .orbit::before {
          content: "";
          position: absolute;
          top: -0.8vh;
          left: 50%;
          width: 1.6vh;
          height: 1.6vh;
          margin-left: -0.8vh;
          border-radius: 50%;
          background: var(--secondary);
          box-shadow: 0 0 2.4vh var(--secondary);
        }
        .ring {
          position: relative;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: conic-gradient(var(--sc) calc(var(--pct) * 1%), var(--track) 0);
          box-shadow: 0 0 7vh var(--glow);
        }
        /* A running session sweeps from the secondary into the primary colour. */
        .hero.active .ring {
          background: conic-gradient(var(--secondary) 0%, var(--accent) calc(var(--pct) * 1%), var(--track) 0);
        }
        .hero.expired .ring {
          animation: emberPulse 1.4s ease-in-out infinite;
        }
        .hero.available .ring {
          background: none;
          box-sizing: border-box;
          border: calc(var(--ring) * 0.025) solid var(--sc);
        }
        .disc {
          position: absolute;
          inset: 7%;
          border-radius: 50%;
          background: var(--disc);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: calc(var(--ring) * 0.02);
        }
        .h-timer {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: calc(var(--ring) * 0.2);
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.02em;
          color: var(--sc);
        }
        .h-chip {
          font-size: calc(var(--ring) * 0.07);
          font-weight: 600;
          color: var(--fg-70);
        }
        .flame {
          width: 24%;
          height: 28%;
          background: linear-gradient(160deg, var(--accent), var(--secondary));
          clip-path: polygon(50% 0%, 78% 35%, 68% 100%, 32% 100%, 22% 35%);
          animation: flicker 2.6s ease-in-out infinite;
        }

        .h-info {
          position: relative;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.8vh;
        }
        .h-kicker {
          margin: 0;
          font-size: clamp(1rem, 1.7vw, 1.6rem);
          font-weight: 500;
          color: var(--sc);
        }
        .h-code {
          margin: 0;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: calc(var(--ring) * 0.26);
          font-weight: 700;
          line-height: 1;
          letter-spacing: -0.02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .h-flavour {
          margin: 1vh 0 0;
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.3rem, 2.4vw, 2.4rem);
          font-weight: 600;
        }
        .h-meta {
          margin: 0;
          font-size: clamp(1rem, 1.6vw, 1.5rem);
          color: var(--fg-70);
        }
        .h-empty {
          margin: 0;
          font-size: clamp(1.2rem, 2vw, 1.8rem);
          color: var(--fg-70);
        }

        /* ---- side list ---- */
        .side {
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 1.6vh;
        }
        .stats {
          flex: none;
          display: flex;
          flex-wrap: wrap;
          gap: 0.8vh 1vw;
        }
        .stat {
          display: inline-flex;
          align-items: baseline;
          gap: 0.5vw;
          font-size: clamp(0.8rem, 1.2vw, 1.1rem);
          color: var(--fg-70);
        }
        .stat b {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: clamp(1.1rem, 1.8vw, 1.7rem);
          color: var(--sc);
          font-variant-numeric: tabular-nums;
        }
        .stat.zero {
          opacity: 0.45;
        }
        .list {
          flex: 1;
          min-height: 0;
          margin: 0;
          padding: 0;
          list-style: none;
          display: grid;
          grid-template-columns: repeat(var(--lcols), minmax(0, 1fr));
          grid-template-rows: repeat(var(--lrows), minmax(0, 1fr));
          gap: 0.8vh 1.4vw;
        }
        .list-empty {
          margin: auto;
          font-size: clamp(1.1rem, 1.8vw, 1.6rem);
          color: var(--fg-70);
        }
        .row {
          position: relative;
          min-height: 0;
          min-width: 0;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          grid-template-rows: 1fr auto;
          align-items: center;
          column-gap: 1vw;
          padding: 0 1vw 1vh;
          box-sizing: border-box;
          border-radius: 1.6vh;
          background: var(--card);
          border: 1px solid transparent;
        }
        .row.focus {
          border-color: var(--sc);
        }
        .row.expired {
          animation: emberPulse 1.4s ease-in-out infinite;
        }
        .r-code {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: max(13px, calc(var(--rh) * 0.34));
          font-weight: 600;
          white-space: nowrap;
        }
        .r-sub {
          font-size: max(11px, calc(var(--rh) * 0.26));
          color: var(--fg-70);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .r-time {
          font-family: "Bricolage Grotesque", sans-serif;
          font-size: max(13px, calc(var(--rh) * 0.34));
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--sc);
          white-space: nowrap;
        }
        .row.available .r-time,
        .row.maintenance .r-time {
          font-family: "Inter", sans-serif;
          font-size: max(11px, calc(var(--rh) * 0.26));
          font-weight: 500;
        }
        /* The coal bar: shrinks in real time as the session burns down. */
        .r-bar {
          grid-column: 1 / -1;
          height: max(3px, calc(var(--rh) * 0.06));
          border-radius: 999px;
          background: var(--track);
          overflow: hidden;
        }
        .r-bar i {
          display: block;
          height: 100%;
          width: var(--w);
          border-radius: inherit;
          background: var(--sc);
          transition: width 1s linear;
        }
        .row.active .r-bar i {
          background: linear-gradient(90deg, var(--secondary), var(--accent));
        }

        /* ---- ticker ---- */
        .ticker {
          position: relative;
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

        @keyframes driftA {
          to {
            transform: translate(10vw, 12vh) scale(1.12);
          }
        }
        @keyframes driftB {
          to {
            transform: translate(-12vw, -10vh) scale(1.08);
          }
        }
        @keyframes rise {
          0% {
            transform: translate3d(0, 0, 0) scale(1);
            opacity: 0;
          }
          12% {
            opacity: 0.9;
          }
          100% {
            transform: translate3d(var(--dx), -72vh, 0) scale(0.4);
            opacity: 0;
          }
        }
        @keyframes smoke {
          0%,
          100% {
            transform: translate3d(0, 0, 0) scale(1);
            opacity: 0.7;
          }
          50% {
            transform: translate3d(3vw, -6vh, 0) scale(1.18);
            opacity: 1;
          }
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
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
        @keyframes emberPulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.6;
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
          .aura,
          .ember,
          .smoke,
          .orbit,
          .track,
          .flame,
          .hero.expired .ring,
          .row.expired,
          .pill.on .pill-dot {
            animation: none;
          }
          .ember {
            display: none;
          }
          .r-bar i {
            transition: none;
          }
        }
      `}</style>
    </div>
  )
}
