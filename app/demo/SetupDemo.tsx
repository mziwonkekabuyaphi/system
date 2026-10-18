"use client"

// app/demo/SetupDemo.tsx
//
// "Set it up yourself": a playable mini admin window where a visitor can do the whole
// setup in order: Branding -> Staff -> Clock-in -> Payroll. It is a demo, not the real
// admin: every name and number is made up, nothing is saved, and refreshing starts over.
// The tabs share one state (SetupContext.tsx), so they feed each other: the sidebar of
// this window takes the colours picked in Branding, staff created in Staff can clock in
// on the pad, and the hours they clock become pay in Payroll.
//
// The starting shop (name, colours, job titles) comes from the chosen industry, but only
// until the visitor changes something: after that, switching industry leaves their work
// alone. "Start over" puts the example shop back.
//
// Only <div>/<span> tags are used inside the window on purpose, so the landing page's
// global heading/paragraph styles can't leak into it.

import { useState, type CSSProperties } from "react"
import s from "./setupDemo.module.css"
import { useIndustry } from "./IndustryContext"
import { SetupBranding } from "./SetupBranding"
import { SetupClock } from "./SetupClock"
import { SetupProvider, useSetup } from "./SetupContext"
import { SetupPayroll } from "./SetupPayroll"
import { SetupStaff } from "./SetupStaff"
import { readableTextOn } from "./setupData"

type Tab = "branding" | "staff" | "clock" | "payroll"

const TABS: Array<{ id: Tab; nav: string; crumb: string; line: string }> = [
  { id: "branding", nav: "Branding", crumb: "Settings › Branding", line: "Your name, logo and colours, on everything customers and staff see." },
  { id: "staff", nav: "Staff", crumb: "Staff", line: "Add your team, set their rates and PINs, and keep their payroll details." },
  { id: "clock", nav: "Clock-in", crumb: "Settings › Staff clock-in", line: "The PIN pad staff use at the door. Hours are recorded for payroll." },
  { id: "payroll", nav: "Payroll", crumb: "Payroll", line: "Clocked hours become gross pay, with PAYE and UIF estimated for you." },
]

function Workspace() {
  const { brand, industry, reset } = useSetup()
  const [tab, setTab] = useState<Tab>("branding")
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]

  const sbBg = brand.customSidebar ? brand.sidebarColor : "var(--qless-navy-deep, #0b1628)"
  const sbText = brand.customSidebar ? brand.sidebarText : "#ffffff"
  const sbAccent = brand.customSidebar ? brand.accent : "var(--qless-amber, #f5a524)"
  const sbOnAccent = brand.customSidebar ? readableTextOn(brand.accent) : "#0b1628"
  const vars = {
    "--sb-bg": sbBg,
    "--sb-text": sbText,
    "--sb-text-muted": `color-mix(in srgb, ${sbText} 72%, transparent)`,
    "--sb-accent": sbAccent,
    "--sb-on-accent": sbOnAccent,
  } as CSSProperties
  const shopName = brand.name.trim() || industry.shop

  return (
    <div className={s.winWrap}>
      <div className={s.toolbar}>
        <span className={s.toolbarNote}>A playable copy of your dashboard: nothing here is saved or sent anywhere.</span>
        <button type="button" className={s.link} onClick={reset}>
          Start over
        </button>
      </div>

      <div className={s.win} style={vars}>
        <div className={s.side}>
          <span className={s.sideBrand}>
            <span className={s.sideLogo}>
              {brand.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local data: URL from the visitor's own file
                <img src={brand.logo} alt="" />
              ) : (
                shopName.charAt(0).toUpperCase()
              )}
            </span>
            <span className={s.sideName}>{shopName}</span>
          </span>
          <div className={s.sideNav} role="tablist" aria-label="Set up your shop">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                className={t.id === tab ? `${s.navItem} ${s.navItemOn}` : s.navItem}
                onClick={() => setTab(t.id)}
              >
                <span className={s.navNum}>{i + 1}</span>
                {t.nav}
              </button>
            ))}
          </div>
        </div>

        <div className={s.main} role="tabpanel">
          <div className={s.mainHead}>
            <span className={s.crumb}>{current.crumb}</span>
            <span className={s.mainLine}>{current.line}</span>
          </div>
          {tab === "branding" && <SetupBranding />}
          {tab === "staff" && <SetupStaff />}
          {tab === "clock" && <SetupClock />}
          {tab === "payroll" && <SetupPayroll />}
          <div className={s.next}>
            {TABS.findIndex((t) => t.id === tab) < TABS.length - 1 ? (
              <button type="button" className={s.nextBtn} onClick={() => setTab(TABS[TABS.findIndex((t) => t.id === tab) + 1].id)}>
                Next: {TABS[TABS.findIndex((t) => t.id === tab) + 1].nav} →
              </button>
            ) : (
              <span className={s.toolbarNote}>That’s the whole setup: brand, team, clock-in and pay.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function SetupDemo() {
  const { industry } = useIndustry()
  return (
    <SetupProvider industry={industry}>
      <Workspace />
    </SetupProvider>
  )
}
