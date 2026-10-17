"use client"

// app/demo/IndustryContext.tsx
//
// One "which kind of shop are we showing?" choice shared by the landing-page demos.
// Wrap the demo sections in <IndustryProvider>, drop an <IndustryPicker /> where you want
// the buttons, and any demo can read the choice with useIndustry(). Outside a provider the
// hook falls back to the first industry, so a demo still renders on its own.
//
// Auto-rotate: a demo calls advance() when it finishes a full run, and the next industry
// comes up. As soon as the visitor picks one themselves, rotation stops.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import styles from "./demo.module.css"
import { INDUSTRIES, type Industry, type IndustryId } from "./industries"

type Ctx = {
  industry: Industry
  /** True while industries rotate on their own. */
  rotating: boolean
  /** A visitor's own pick: shows that industry and stops the rotation. */
  choose: (id: IndustryId) => void
  /** Called by a demo at the end of a run. Does nothing once the visitor has chosen. */
  advance: () => void
  resume: () => void
}

const FALLBACK: Ctx = { industry: INDUSTRIES[0], rotating: false, choose: () => {}, advance: () => {}, resume: () => {} }
const IndustryCtx = createContext<Ctx>(FALLBACK)

export const useIndustry = () => useContext(IndustryCtx)

export function IndustryProvider({ children, initialId = "barber" }: { children: ReactNode; initialId?: IndustryId }) {
  const [index, setIndex] = useState(Math.max(0, INDUSTRIES.findIndex((i) => i.id === initialId)))
  const [rotating, setRotating] = useState(true)

  const choose = useCallback((id: IndustryId) => {
    const i = INDUSTRIES.findIndex((x) => x.id === id)
    if (i >= 0) setIndex(i)
    setRotating(false)
  }, [])
  const advance = useCallback(() => {
    if (rotating) setIndex((n) => (n + 1) % INDUSTRIES.length)
  }, [rotating])
  const resume = useCallback(() => setRotating(true), [])

  const value = useMemo(
    () => ({ industry: INDUSTRIES[index], rotating, choose, advance, resume }),
    [index, rotating, choose, advance, resume],
  )
  return <IndustryCtx.Provider value={value}>{children}</IndustryCtx.Provider>
}

export function IndustryPicker() {
  const { industry, rotating, choose, resume } = useIndustry()
  return (
    <div className={styles.industryPicker}>
      <span className={styles.industryLabel}>See it for</span>
      <div className={styles.industryChips} role="group" aria-label="Choose a type of business">
        {INDUSTRIES.map((i) => (
          <button
            key={i.id}
            type="button"
            aria-pressed={i.id === industry.id}
            className={i.id === industry.id ? `${styles.demoTab} ${styles.demoTabActive}` : styles.demoTab}
            onClick={() => choose(i.id)}
          >
            {i.label}
          </button>
        ))}
      </div>
      {!rotating && (
        <button type="button" className={styles.kioskResume} onClick={resume}>
          Rotate industries
        </button>
      )}
    </div>
  )
}
