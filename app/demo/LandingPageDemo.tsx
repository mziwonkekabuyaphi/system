"use client"

// app/demo/LandingPageDemo.tsx
//
// An interactive mock of Settings > Website (ZozoWeb) with the "Booking & Queue" template: the owner edits
// the words, picks a colour, switches sections on or off, previews and publishes. Every name, price and time
// is made up, and nothing here is published anywhere.

import { useState } from "react"
import styles from "./liveExtras.module.css"

const ACCENTS = [
  { id: "#F59E0B", label: "Amber" },
  { id: "#0F766E", label: "Teal" },
  { id: "#C2410C", label: "Terracotta" },
  { id: "#1D4ED8", label: "Blue" },
]

const SERVICES: Array<[string, string, string]> = [
  ["Haircut", "30 min", "R150"],
  ["Beard trim", "20 min", "R80"],
  ["Haircut + beard", "45 min", "R200"],
]

const HOURS: Array<[string, string]> = [
  ["Mon – Fri", "08:00 – 18:00"],
  ["Saturday", "08:00 – 14:00"],
  ["Sunday", "Closed"],
]

type Section = "services" | "hours" | "whatsapp"

export function LandingPageDemo() {
  const [headline, setHeadline] = useState("Welcome to Mzido’s Barbershop")
  const [accent, setAccent] = useState(ACCENTS[0].id)
  const [show, setShow] = useState<Record<Section, boolean>>({ services: true, hours: true, whatsapp: true })
  const [published, setPublished] = useState(false)
  const [ownDomain, setOwnDomain] = useState(false)

  const toggle = (k: Section) => setShow((s) => ({ ...s, [k]: !s[k] }))
  const address = ownDomain ? "book.mzidos.co.za" : "mzidos-barbershop.zozoweb.co.za"

  return (
    <div className={styles.pair}>
      <div className={styles.card}>
        <span className={styles.cardTitle}>Settings · Website</span>
        <span className={styles.cardSub}>Template: Booking &amp; Queue. Clean and light, with your services, prices, Book now and Join the queue.</span>

        <span className={styles.group}>Headline</span>
        <input
          className={styles.input}
          value={headline}
          maxLength={80}
          onChange={(e) => {
            setHeadline(e.target.value)
            setPublished(false)
          }}
          aria-label="Headline"
        />

        <span className={styles.group}>Colour (from your branding)</span>
        <div className={styles.row}>
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles.pill}
              aria-pressed={accent === a.id}
              onClick={() => {
                setAccent(a.id)
                setPublished(false)
              }}
            >
              <span className={styles.swatch} style={{ background: a.id }} aria-hidden="true" />
              {a.label}
            </button>
          ))}
        </div>

        <span className={styles.group}>Sections</span>
        <div className={styles.row}>
          <button type="button" className={styles.pill} aria-pressed={show.services} onClick={() => { toggle("services"); setPublished(false) }}>Services &amp; prices</button>
          <button type="button" className={styles.pill} aria-pressed={show.hours} onClick={() => { toggle("hours"); setPublished(false) }}>Opening hours</button>
          <button type="button" className={styles.pill} aria-pressed={show.whatsapp} onClick={() => { toggle("whatsapp"); setPublished(false) }}>WhatsApp button</button>
        </div>
        <span className={styles.hint}>Services, prices and opening hours come live from your own setup, so the page can’t go out of date.</span>

        <span className={styles.group}>Where it lives</span>
        <div className={styles.row}>
          <button type="button" className={styles.pill} aria-pressed={!ownDomain} onClick={() => setOwnDomain(false)}>Free address</button>
          <button type="button" className={styles.pill} aria-pressed={ownDomain} onClick={() => setOwnDomain(true)}>Your own domain</button>
        </div>

        <div className={styles.row} style={{ marginTop: 16 }}>
          <button type="button" className={styles.primaryBtn} onClick={() => setPublished(true)} disabled={published}>
            {published ? "Published" : "Publish"}
          </button>
          {published && (
            <button type="button" className={styles.ghostBtn} onClick={() => setPublished(false)}>Switch it off</button>
          )}
        </div>
        <span className={styles.hint}>
          {published
            ? "Live. Visitors now see your landing page."
            : "Draft. Until you publish, visitors still see your normal booking page."}
        </span>
      </div>

      <div className={styles.phoneWrap}>
        <div className={styles.browser}>
          <div className={styles.browserBar}>
            <span className={styles.browserDots} aria-hidden="true"><i /><i /><i /></span>
            <span className={styles.browserUrl}>{published ? address : `Preview · ${address}`}</span>
            <span className={styles.browserState} data-live={published}>{published ? "Live" : "Draft"}</span>
          </div>
          <div className={styles.site}>
            <span className={styles.siteName}>Mzido&rsquo;s Barbershop</span>
            <span className={styles.siteKicker}>Book · Queue · Walk in</span>
            <span className={styles.siteHead}>{headline || "Welcome"}</span>
            <span className={styles.siteBtns}>
              <span className={styles.siteBtn} style={{ background: accent }}>Book now</span>
              <span className={`${styles.siteBtn} ${styles.siteBtnGhost}`} style={{ borderColor: accent }}>Join the queue</span>
            </span>
            {show.services && (
              <span className={styles.siteList}>
                {SERVICES.map(([n, d, p]) => (
                  <span key={n} className={styles.siteRow}><span>{n} <small>{d}</small></span><b>{p}</b></span>
                ))}
              </span>
            )}
            {show.hours && (
              <span className={styles.siteList}>
                {HOURS.map(([d, h]) => (
                  <span key={d} className={styles.siteRow}><span>{d}</span><b>{h}</b></span>
                ))}
              </span>
            )}
            {show.whatsapp && <span className={styles.siteWa}>Chat on WhatsApp</span>}
          </div>
        </div>
        <span className={styles.fine}>An example page. Names, prices and times are made up, and nothing is published.</span>
      </div>
    </div>
  )
}
