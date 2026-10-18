"use client"

// app/demo/SetupClock.tsx
//
// A playable copy of Settings > Staff clock-in (ClockPanels.tsx) next to a working PIN pad
// (the real one is components/clock/ClockApp.tsx). Pick a theme, add a tagline, reword the
// messages, then type a staff PIN: the first tap of "Enter" clocks them in, the next clocks
// them out. The pad uses the brand colours from the Branding tab. "Skip ahead" moves the
// demo's clock forward so a visitor can see hours turn into pay without waiting.

import { useEffect, useRef, useState, type CSSProperties } from "react"
import admin from "./adminDemo.module.css"
import s from "./setupDemo.module.css"
import { ColorField, Field, PlanTag } from "./SetupBits"
import { useSetup } from "./SetupContext"
import { CLOCK_DEFAULTS, fmtDuration, fmtTime, readableTextOn, visibleOn, type ClockTheme, type PunchResult } from "./setupData"

const THEMES: Array<{ value: ClockTheme; title: string; text: string; swatch: string }> = [
  { value: "dark", title: "Dark", text: "Near-black with light text. Easy on the eyes on a shared tablet.", swatch: "#15110d" },
  { value: "light", title: "Light", text: "Off-white with dark text. Suits bright spaces.", swatch: "#faf8f5" },
  { value: "custom", title: "Custom colour", text: "Pick your own background. Text colour adjusts automatically.", swatch: "" },
]

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const

export function SetupClock() {
  const { brand, staff, clock, setClock, punch, now, skewMinutes, skipAhead } = useSetup()
  const [pin, setPin] = useState("")
  const [result, setResult] = useState<PunchResult | null>(null)
  const [shake, setShake] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const bg = clock.theme === "dark" ? "#15110d" : clock.theme === "light" ? "#faf8f5" : clock.backgroundColor
  const text = readableTextOn(bg)
  // The brand colour is nudged to something readable on this background, like the real pad.
  const accent = visibleOn(bg, brand.primary, brand.secondary)
  const padStyle = {
    "--pad-bg": bg,
    "--pad-text": text,
    "--pad-accent": accent,
    "--pad-on-accent": readableTextOn(accent),
  } as CSSProperties

  const words = {
    title: clock.title.trim() || CLOCK_DEFAULTS.title,
    prompt: clock.prompt.trim() || CLOCK_DEFAULTS.prompt,
    inLabel: clock.clockedInLabel.trim() || CLOCK_DEFAULTS.clockedInLabel,
    outLabel: clock.clockedOutLabel.trim() || CLOCK_DEFAULTS.clockedOutLabel,
    wrong: clock.invalidPinText.trim() || CLOCK_DEFAULTS.invalidPinText,
  }

  function press(key: (typeof KEYS)[number]) {
    if (result?.ok) return
    if (key === "clear") return setPin("")
    if (key === "back") return setPin((p) => p.slice(0, -1))
    setResult(null)
    setPin((p) => (p.length < 6 ? p + key : p))
  }

  function enter() {
    if (result?.ok || pin.length === 0) return
    const r = punch(pin)
    setResult(r)
    setPin("")
    if (!r.ok) {
      setShake(true)
      setTimeout(() => setShake(false), 400)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setResult(null), 3200)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (/^\d$/.test(e.key)) press(e.key as (typeof KEYS)[number])
    else if (e.key === "Backspace") press("back")
    else if (e.key === "Enter") enter()
    else return
    e.preventDefault()
  }

  const active = staff.filter((m) => m.active && m.pin)

  return (
    <div className={s.twoCol}>
      <div className={s.stack}>
        <div className={admin.aCard}>
          <span className={admin.aCardTitle}>Look</span>
          <span className={admin.aCardSub}>What the clock-in pad looks like on your shared tablet. Your brand colour from the Branding tab is used for the PIN dots and the Enter button.</span>

          <span className={admin.aGroup}>Colour theme</span>
          <div className={s.themeGrid}>
            {THEMES.map((t) => {
              const swatch = t.value === "custom" ? clock.backgroundColor : t.swatch
              return (
                <button key={t.value} type="button" aria-pressed={clock.theme === t.value} className={admin.aOpt} onClick={() => setClock({ theme: t.value })}>
                  <span className={s.themeHead}>
                    <span className={s.themeDot} style={{ background: swatch }} />
                    <span className={admin.aOptTitle}>{t.title}</span>
                    {t.value === "custom" && <PlanTag />}
                  </span>
                  <span className={admin.aOptText}>{t.text}</span>
                </button>
              )
            })}
          </div>
          {clock.theme === "custom" && (
            <div className={s.colorOne}>
              <ColorField label="Background colour" value={clock.backgroundColor} onChange={(hex) => setClock({ backgroundColor: hex })} />
            </div>
          )}

          <span className={admin.aGroup}>Tagline</span>
          <Field label="Tagline under your name" hint="Leave empty for none.">
            {(id) => <input id={id} className={admin.aInput} value={clock.tagline} maxLength={80} placeholder="e.g. Have a great shift" onChange={(e) => setClock({ tagline: e.target.value })} />}
          </Field>
        </div>

        <div className={admin.aCard}>
          <span className={admin.aCardTitle}>Local terms</span>
          <span className={admin.aCardSub}>Rename what staff see on the pad. Leave a field empty to use the default.</span>
          <div className={admin.aFields}>
            <Field label="Heading" hint={`Defaults to "${CLOCK_DEFAULTS.title}".`}>
              {(id) => <input id={id} className={admin.aInput} value={clock.title} maxLength={60} placeholder={CLOCK_DEFAULTS.title} onChange={(e) => setClock({ title: e.target.value })} />}
            </Field>
            <Field label="PIN prompt" hint={`Defaults to "${CLOCK_DEFAULTS.prompt}".`}>
              {(id) => <input id={id} className={admin.aInput} value={clock.prompt} maxLength={80} placeholder={CLOCK_DEFAULTS.prompt} onChange={(e) => setClock({ prompt: e.target.value })} />}
            </Field>
            <Field label="Clock-in confirmation" hint={`Shown above the staff member's name. Defaults to "${CLOCK_DEFAULTS.clockedInLabel}".`}>
              {(id) => <input id={id} className={admin.aInput} value={clock.clockedInLabel} maxLength={40} placeholder={CLOCK_DEFAULTS.clockedInLabel} onChange={(e) => setClock({ clockedInLabel: e.target.value })} />}
            </Field>
            <Field label="Clock-out confirmation" hint={`Defaults to "${CLOCK_DEFAULTS.clockedOutLabel}".`}>
              {(id) => <input id={id} className={admin.aInput} value={clock.clockedOutLabel} maxLength={40} placeholder={CLOCK_DEFAULTS.clockedOutLabel} onChange={(e) => setClock({ clockedOutLabel: e.target.value })} />}
            </Field>
            <Field label="Wrong PIN message" hint={`Defaults to "${CLOCK_DEFAULTS.invalidPinText}".`}>
              {(id) => <input id={id} className={admin.aInput} value={clock.invalidPinText} maxLength={100} placeholder={CLOCK_DEFAULTS.invalidPinText} onChange={(e) => setClock({ invalidPinText: e.target.value })} />}
            </Field>
          </div>
        </div>
      </div>

      <div className={s.previewWrap}>
        <span className={s.previewLabel}>The staff clock-in pad</span>
        <div className={s.pad} style={padStyle}>
          <div className={s.padScreen} tabIndex={0} onKeyDown={onKeyDown} aria-label="Staff clock-in pad. Type a PIN, then press Enter.">
            <span className={s.padBrand}>
              {brand.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local data: URL from the visitor's own file
                <img src={brand.logo} alt="" className={s.padLogo} />
              ) : null}
              <span className={s.padShop}>{brand.name.trim() || "Your shop"}</span>
            </span>
            {clock.tagline.trim() && <span className={s.padTagline}>{clock.tagline.trim()}</span>}

            {result?.ok ? (
              <div className={s.padResult} role="status">
                <span className={s.padCheck}>✓</span>
                <span className={s.padResultLabel}>{result.action === "in" ? words.inLabel : words.outLabel}</span>
                <span className={s.padResultName}>{result.name}</span>
                <span className={s.padResultSub}>
                  {result.action === "in" ? `at ${fmtTime(result.at)}` : `at ${fmtTime(result.at)} · worked ${fmtDuration(result.workedMs ?? 0)}`}
                </span>
              </div>
            ) : (
              <>
                <span className={s.padTitle}>{words.title}</span>
                <span className={s.padPrompt}>{words.prompt}</span>
                <span className={shake ? `${s.dots} ${s.shake}` : s.dots} aria-label={`${pin.length} digits entered`}>
                  {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
                    <span key={i} className={i < pin.length ? `${s.dot} ${s.dotOn}` : s.dot} />
                  ))}
                </span>
                <span className={s.padError} role="alert">
                  {result && !result.ok ? words.wrong : "\u00a0"}
                </span>
                <div className={s.keys}>
                  {KEYS.map((k) => (
                    <button key={k} type="button" className={s.key} onClick={() => press(k)} aria-label={k === "clear" ? "Clear" : k === "back" ? "Backspace" : k}>
                      {k === "clear" ? "Clear" : k === "back" ? "⌫" : k}
                    </button>
                  ))}
                </div>
                <button type="button" className={s.keyEnter} onClick={enter} disabled={pin.length === 0}>
                  Enter
                </button>
              </>
            )}
            {!brand.removePoweredBy && <span className={s.padFoot}>Powered by ZozoQueue</span>}
          </div>
        </div>

        <div className={s.tryBox}>
          <span className={s.tryLabel}>Try a PIN</span>
          <span className={s.chips}>
            {active.length === 0 && <span className={s.tryNote}>No active staff with a PIN. Add one on the Staff tab.</span>}
            {active.map((m) => (
              <button key={m.id} type="button" className={s.chip} onClick={() => { setResult(null); setPin(m.pin) }}>
                {m.name.split(" ")[0]} · {m.pin}
              </button>
            ))}
          </span>
          <span className={s.tryLabel}>Demo clock · {fmtTime(now())}</span>
          <span className={s.chips}>
            <button type="button" className={s.chip} onClick={() => skipAhead(60)}>
              Skip ahead 1 hour
            </button>
            <button type="button" className={s.chip} onClick={() => skipAhead(240)}>
              Skip ahead 4 hours
            </button>
          </span>
          <span className={s.tryNote}>
            {skewMinutes > 0 ? `Skipped ${fmtDuration(skewMinutes * 60000)} so far. ` : ""}
            Clock in, skip ahead, clock out, then open the Payroll tab to see the hours turn into pay.
          </span>
        </div>
      </div>
    </div>
  )
}
