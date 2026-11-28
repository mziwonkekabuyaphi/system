// app/admin/settings/WebsitePanel.tsx
"use client"

import { useEffect, useState, useTransition } from "react"

import { generateWebsiteCopy, getWebsite, getWebsiteStats, publishWebsite, saveWebsiteDraft, unpublishWebsite, uploadSiteImage, type WebsiteState, type WebsiteStats } from "../website/actions"
import { freeSiteHost } from "@/lib/domains/sites-domain"
import { TEMPLATES, type SiteContent, type SiteTemplate } from "@/lib/site/types"
import { SettingsCard, inputClass, primaryButtonClass, secondaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// Settings > Website (Shisha template). Edit the words, choose the sections, Publish.
// The menu and seating areas are NOT typed here: they come live from Shisha > Flavours and
// Stations, so the site can't go stale. Every action re-checks permission + module on the server.
// ---------------------------------------------------------------------------

const SECTIONS: { key: keyof SiteContent["show"]; label: string; live?: boolean; only?: SiteTemplate[] }[] = [
  { key: "menu", label: "Menu (flavours and prices)", live: true, only: ["shisha"] },
  { key: "areas", label: "Where to sit (your areas)", live: true, only: ["shisha"] },
  { key: "menu", label: "Menu and prices", live: true, only: ["orders"] },
  { key: "areas", label: "Delivery areas and fees", live: true, only: ["orders"] },
  { key: "services", label: "Services and prices", live: true, only: ["booking"] },
  { key: "events", label: "Upcoming events and tickets", live: true, only: ["events"] },
  { key: "packages", label: "Tables and packages", live: true, only: ["events"] },
  { key: "hours", label: "Opening hours" },
  { key: "gallery", label: "Photo gallery" },
  { key: "contact", label: "Address and map link" },
]

export function WebsitePanel() {
  const [state, setState] = useState<WebsiteState | null>(null)
  const [c, setC] = useState<SiteContent | null>(null)
  const [template, setTemplate] = useState<SiteTemplate>("shisha")
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [uploading, setUploading] = useState(false)
  const [stats, setStats] = useState<WebsiteStats | null>(null)
  const [writing, setWriting] = useState(false)
  const [tone, setTone] = useState("friendly")
  const [language, setLanguage] = useState("English")
  const [notes, setNotes] = useState("")
  const [previous, setPrevious] = useState<Pick<SiteContent, "headline" | "subheadline" | "about"> | null>(null)

  useEffect(() => {
    void (async () => {
      const r = await getWebsite()
      if (!r.ok) return setError(r.error)
      setState(r.state)
      setC(r.state.draft)
      setTemplate(r.state.template)
      const st = await getWebsiteStats()
      if (st.ok) setStats(st.stats)
    })()
  }, [])

  if (error && !state) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (!state || !c) return <p className="text-sm text-stone-500">Loading…</p>
  if (state.availableTemplates.length === 0)
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Turn on Shisha, Events, Booking, Queue or Orders for your business first. Your website is built from that data.</p>

  async function addPhotos(files: FileList | null, target: "hero" | "gallery") {
    if (!files || files.length === 0 || !c) return
    setError(null)
    setNote(null)
    setUploading(true)
    const room = target === "hero" ? 1 : Math.max(0, 8 - c.gallery.length)
    const urls: string[] = []
    for (const file of Array.from(files).slice(0, room)) {
      const body = new FormData()
      body.set("file", file)
      const r = await uploadSiteImage(body)
      if (!r.ok) {
        setError(r.error)
        break
      }
      urls.push(r.url)
    }
    setUploading(false)
    if (urls.length === 0) return
    if (target === "hero") {
      set("heroImageUrl", urls[0])
    } else {
      set("gallery", [...c.gallery, ...urls])
    }
    setNote("Photo added. Save the draft or Publish to keep it.")
  }

  function removePhoto(target: "hero" | "gallery", url: string) {
    if (!c) return
    if (target === "hero") set("heroImageUrl", "")
    else set("gallery", c.gallery.filter((u) => u !== url))
  }

  /** Asks Claude for a suggestion and puts it in the three text boxes. Nothing is saved: the owner reads it, edits it, then saves. */
  async function writeForMe() {
    if (!c) return
    setError(null)
    setNote(null)
    setWriting(true)
    const r = await generateWebsiteCopy({ template, tone, language, notes })
    setWriting(false)
    if (!r.ok) return setError(r.error)
    setPrevious({ headline: c.headline, subheadline: c.subheadline, about: c.about })
    setC({ ...c, headline: r.copy.headline, subheadline: r.copy.subheadline, about: r.copy.about })
    setNote("Suggested text added below. Read it, change anything you like, then Preview or Save draft.")
  }

  function undoWrite() {
    if (!c || !previous) return
    setC({ ...c, ...previous })
    setPrevious(null)
    setNote("Your earlier text is back.")
  }

  /** Saves the draft, then opens the preview in a new tab. The tab is opened first, in the click, so pop-up blockers allow it. */
  function openPreview() {
    if (!c) return
    const tab = window.open("about:blank", "_blank")
    setError(null)
    setNote(null)
    start(async () => {
      const r = await saveWebsiteDraft(c, template)
      if (!r.ok) {
        tab?.close()
        return setError(r.error)
      }
      setState(r.state)
      setC(r.state.draft)
      setTemplate(r.state.template)
      if (tab) tab.location.href = "/site-preview"
      else setNote("Draft saved. Your browser blocked the new tab, so open /site-preview yourself.")
    })
  }

  const freeHost = freeSiteHost(state.slug)
  const liveHours = template === "booking" || template === "orders"
  const set = <K extends keyof SiteContent>(k: K, v: SiteContent[K]) => setC({ ...c, [k]: v })

  function run(fn: () => Promise<{ ok: true; state: WebsiteState } | { ok: false; error: string }>, done: string) {
    setError(null)
    setNote(null)
    start(async () => {
      const r = await fn()
      if (!r.ok) return setError(r.error)
      setState(r.state)
      setC(r.state.draft)
      setTemplate(r.state.template)
      setNote(done)
    })
  }

  const chip = state.isPublished
    ? state.hasUnpublishedChanges
      ? { text: "Live · unpublished changes", cls: "bg-amber-100 text-amber-800" }
      : { text: "Live", cls: "bg-emerald-100 text-emerald-800" }
    : { text: "Not published", cls: "bg-stone-100 text-stone-600" }

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Your website"
        description="Visitors see this once you publish. Until then your normal booking page is shown."
        footer={
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${chip.cls}`}>{chip.text}</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <button type="button" className={secondaryButtonClass} disabled={pending || uploading} onClick={openPreview}>
                Preview
              </button>
              <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => run(() => saveWebsiteDraft(c, template), "Draft saved.")}>
                Save draft
              </button>
              <button type="button" className={primaryButtonClass} disabled={pending} onClick={() => run(() => publishWebsite(c, template), "Published. Your site is live.")}>
                {pending ? "Working…" : "Publish"}
              </button>
              {state.isPublished && (
                <>
                  <a className={secondaryButtonClass} href={freeHost ? `https://${freeHost}` : `/site/${state.slug}`} target="_blank" rel="noreferrer">View site</a>
                  <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => run(unpublishWebsite, "Site switched off.")}>
                    Unpublish
                  </button>
                </>
              )}
            </div>
          </div>
        }
      >
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {note && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</p>}
        <div role="radiogroup" aria-label="Template" className="flex flex-wrap gap-2">
          {TEMPLATES.filter((t) => state.availableTemplates.includes(t.id)).map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={template === t.id}
              onClick={() => setTemplate(t.id)}
              className={`${secondaryButtonClass} ${template === t.id ? "ring-2 ring-accent" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-muted">Colours and logo come from Branding. Changing the template only goes live when you Publish.</p>
        {freeHost && <p className="text-sm text-ink">Your free address: <b>{freeHost}</b></p>}
      </SettingsCard>

      {state.isPublished && stats && (() => {
        const sum = (n: number, k: "views" | "whatsappTaps") => stats.days.slice(-n).reduce((a, d) => a + d[k], 0)
        const last14 = stats.days.slice(-14)
        const max = Math.max(1, ...last14.map((d) => d.views))
        return (
          <SettingsCard title="Visits" description="One visit is one person opening your site in a browser session. We don't use cookies or keep anything about visitors. Your own previews aren't counted.">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <p><b className="block text-2xl text-ink">{sum(7, "views")}</b>visits, last 7 days</p>
              <p><b className="block text-2xl text-ink">{sum(30, "views")}</b>visits, last 30 days</p>
              <p><b className="block text-2xl text-ink">{sum(7, "whatsappTaps")}</b>WhatsApp taps, last 7 days</p>
              <p><b className="block text-2xl text-ink">{sum(30, "whatsappTaps")}</b>WhatsApp taps, last 30 days</p>
            </div>
            <div role="img" aria-label={`Visits per day, last 14 days: ${last14.map((d) => d.views).join(", ")}`} className="flex h-16 items-end gap-1">
              {last14.map((d) => (
                <div key={d.day} title={`${d.day}: ${d.views} visits`} className="flex-1 rounded-t bg-emerald-600/70" style={{ height: `${Math.max(4, (d.views / max) * 100)}%` }} />
              ))}
            </div>
            <p className="text-xs text-ink-muted">Days are counted in UTC. Numbers are counts of visits, not of different people.</p>
          </SettingsCard>
        )
      })()}

      <SettingsCard title="Write it for me" description="Claude writes your headline, the line under it and the About text from what your business sells. You can change all of it.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tone">
            <select className={inputClass} value={tone} onChange={(e) => setTone(e.target.value)}>
              <option value="friendly">Friendly</option>
              <option value="premium">Premium</option>
              <option value="playful">Playful</option>
            </select>
          </Field>
          <Field label="Language">
            <select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option>English</option>
              <option>isiZulu</option>
              <option>isiXhosa</option>
              <option>Afrikaans</option>
            </select>
          </Field>
        </div>
        <Field label="Anything we should mention? (optional)"><textarea className={inputClass} rows={2} maxLength={300} placeholder="e.g. family run since we opened, live DJ on Fridays" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryButtonClass} disabled={writing || pending || uploading} onClick={() => void writeForMe()}>
            {writing ? "Writing…" : "Write my website for me"}
          </button>
          {previous && <button type="button" className={secondaryButtonClass} onClick={undoWrite}>Undo</button>}
        </div>
        <p className="text-xs text-ink-muted">Always read the text before you publish. In isiZulu, isiXhosa and Afrikaans, ask someone who speaks it to check the wording.</p>
      </SettingsCard>

      <SettingsCard title="Words and photos">
        <Field label="Headline"><input className={inputClass} maxLength={80} value={c.headline} onChange={(e) => set("headline", e.target.value)} /></Field>
        <Field label="Line under the headline"><input className={inputClass} maxLength={160} value={c.subheadline} onChange={(e) => set("subheadline", e.target.value)} /></Field>
        <Field label="About us (optional)"><textarea className={inputClass} rows={3} maxLength={600} value={c.about} onChange={(e) => set("about", e.target.value)} /></Field>
        <Field label="Main photo (optional)">
          {c.heroImageUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.heroImageUrl} alt="Main photo" className="h-20 w-32 rounded-lg object-cover" />
              <button type="button" className={secondaryButtonClass} onClick={() => removePhoto("hero", c.heroImageUrl)}>Remove</button>
            </div>
          ) : (
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(e) => { void addPhotos(e.target.files, "hero"); e.target.value = "" }} />
          )}
        </Field>
        <Field label={`Gallery photos (${c.gallery.length} of 8)`}>
          <div className="flex flex-wrap gap-3">
            {c.gallery.map((u) => (
              <div key={u} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="Gallery photo" className="h-20 w-20 rounded-lg object-cover" />
                <button type="button" aria-label="Remove photo" className="absolute -right-2 -top-2 rounded-full bg-white px-2 text-sm font-bold shadow" onClick={() => removePhoto("gallery", u)}>×</button>
              </div>
            ))}
          </div>
          {c.gallery.length < 8 && (
            <input className="mt-3 block" type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(e) => { void addPhotos(e.target.files, "gallery"); e.target.value = "" }} />
          )}
        </Field>
        {uploading && <p className="text-sm text-ink-muted">Uploading…</p>}
      </SettingsCard>

      <SettingsCard title="WhatsApp" description="Order, Buy tickets and Reserve buttons open a chat with this number. Booking pages use your booking link instead. Orders pages need this number.">
        <Field label="WhatsApp number"><input className={inputClass} inputMode="tel" placeholder="082 123 4567" value={c.whatsappNumber} onChange={(e) => set("whatsappNumber", e.target.value)} /></Field>
        <Field label="Message the customer starts with"><input className={inputClass} maxLength={200} value={c.whatsappMessage} onChange={(e) => set("whatsappMessage", e.target.value)} /></Field>
      </SettingsCard>

      <SettingsCard title={liveHours ? "Address" : "Opening hours and address"} description={liveHours ? "Opening hours come from Settings > Business hours, so they are always right." : undefined}>
        {!liveHours && c.hours.map((h, i) => (
          <div key={i} className="flex gap-2">
            <input aria-label="Days" className={inputClass} maxLength={40} value={h.label} onChange={(e) => set("hours", c.hours.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input aria-label="Hours" className={inputClass} maxLength={40} value={h.value} onChange={(e) => set("hours", c.hours.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button type="button" className={secondaryButtonClass} aria-label="Remove row" onClick={() => set("hours", c.hours.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {!liveHours && c.hours.length < 7 && <button type="button" className={secondaryButtonClass} onClick={() => set("hours", [...c.hours, { label: "", value: "" }])}>Add a row</button>}
        <Field label="Address"><input className={inputClass} maxLength={200} value={c.address} onChange={(e) => set("address", e.target.value)} /></Field>
      </SettingsCard>

      <SettingsCard title="Sections" description="Turn parts of the page on or off. “Live” ones update by themselves from your Shisha setup.">
        {SECTIONS.filter((s) => !s.only || s.only.includes(template)).map((s) => (
          <label key={s.key} className="flex items-center justify-between gap-3 border-t border-line pt-3 text-sm text-ink first:border-0 first:pt-0">
            <span>{s.label}{s.live && <span className="ml-2 text-xs font-semibold text-emerald-700">LIVE</span>}</span>
            <input type="checkbox" className="h-5 w-5" checked={c.show[s.key]} onChange={(e) => set("show", { ...c.show, [s.key]: e.target.checked })} />
          </label>
        ))}
      </SettingsCard>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
    </label>
  )
}
