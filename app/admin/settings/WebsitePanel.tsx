// app/admin/settings/WebsitePanel.tsx
"use client"

import { useEffect, useRef, useState, useTransition } from "react"

import { getWebsite, publishWebsite, saveWebsiteDraft, unpublishWebsite, uploadSiteImage, type WebsiteState } from "../website/actions"
import { TEMPLATES, type SiteContent, type SiteTemplate } from "@/lib/site/types"
import { SettingsCard, inputClass, primaryButtonClass, secondaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// Settings > Website (ZozoWeb). Pick a template, edit the words and photos, choose the sections,
// Preview, then Publish. Menus, events, services and opening hours are NOT typed here: they come live
// from the business's own setup, so the site can't go stale. Every action re-checks permission + module
// on the server; this file only edits a draft.
// ---------------------------------------------------------------------------

const MAX_GALLERY = 8

const TEMPLATE_INFO: Record<SiteTemplate, string> = {
  shisha: "Dark and warm. Menu, seating areas, order on WhatsApp.",
  events: "Bold and neon. Upcoming events, tickets and tables.",
  booking: "Clean and light. Services, prices, Book now and Join the queue.",
  orders: "Fresh and simple. Your products by category, delivery areas, Order buttons.",
}

const SECTIONS: { key: keyof SiteContent["show"]; label: string; live?: boolean; only?: SiteTemplate[] }[] = [
  { key: "menu", label: "Menu (flavours and prices)", live: true, only: ["shisha"] },
  { key: "areas", label: "Where to sit (your areas)", live: true, only: ["shisha"] },
  { key: "menu", label: "Menu (your products by category)", live: true, only: ["orders"] },
  { key: "areas", label: "Delivery areas and fees", live: true, only: ["orders"] },
  { key: "services", label: "Services and prices", live: true, only: ["booking"] },
  { key: "events", label: "Upcoming events and tickets", live: true, only: ["events"] },
  { key: "packages", label: "Tables and packages", live: true, only: ["events"] },
  { key: "hours", label: "Opening hours" },
  { key: "gallery", label: "Photo gallery" },
  { key: "contact", label: "Address and map link" },
]

type Result = { ok: true; state: WebsiteState } | { ok: false; error: string }

export function WebsitePanel() {
  const [state, setState] = useState<WebsiteState | null>(null)
  const [c, setC] = useState<SiteContent | null>(null)
  const [template, setTemplate] = useState<SiteTemplate>("shisha")
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [uploading, setUploading] = useState<"hero" | "gallery" | null>(null)
  const [pending, start] = useTransition()
  const heroInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      const r = await getWebsite()
      if (!r.ok) return setError(r.error)
      setState(r.state)
      setC(r.state.draft)
      setTemplate(r.state.template)
    })()
  }, [])

  if (error && !state) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (!state || !c) return <p className="text-sm text-ink-muted">Loading…</p>
  if (state.availableTemplates.length === 0)
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Turn on Shisha, Events, Booking, Queue or Orders for your business first. Your website is built from that data.</p>

  const set = <K extends keyof SiteContent>(k: K, v: SiteContent[K]) => setC({ ...c, [k]: v })
  const busy = pending || uploading !== null
  const dirty = JSON.stringify(c) !== JSON.stringify(state.draft) || template !== state.template

  function apply(r: Result, done: string) {
    if (!r.ok) return setError(r.error)
    setState(r.state)
    setC(r.state.draft)
    setTemplate(r.state.template)
    setNote(done)
  }

  function run(fn: () => Promise<Result>, done: string) {
    setError(null)
    setNote(null)
    start(async () => apply(await fn(), done))
  }

  /** Saves the draft first (so the preview shows what's on screen), then opens it in a new tab. */
  function preview() {
    setError(null)
    setNote(null)
    // Opened right away from the click so the browser doesn't block it; pointed at the preview once saved.
    const tab = window.open("", "_blank")
    start(async () => {
      const r = await saveWebsiteDraft(c, template)
      if (!r.ok) {
        tab?.close()
        return setError(r.error)
      }
      apply(r, "Draft saved. Preview opened in a new tab.")
      if (tab) tab.location.href = `/site/${encodeURIComponent(r.state.slug)}/preview`
    })
  }

  async function upload(file: File | undefined, target: "hero" | "gallery") {
    if (!file || !c) return
    setError(null)
    setNote(null)
    setUploading(target)
    const fd = new FormData()
    fd.set("file", file)
    const r = await uploadSiteImage(fd)
    setUploading(null)
    if (!r.ok) return setError(r.error)
    if (target === "hero") setC({ ...c, heroImageUrl: r.url })
    else setC({ ...c, gallery: [...c.gallery, r.url].slice(0, MAX_GALLERY) })
    setNote("Photo added. Press Save draft or Publish to keep it.")
  }

  const chip = state.isPublished
    ? state.hasUnpublishedChanges || dirty
      ? { text: "Live · unpublished changes", cls: "bg-amber-100 text-amber-800" }
      : { text: "Live", cls: "bg-emerald-100 text-emerald-800" }
    : { text: "Not published", cls: "bg-stone-100 text-stone-600" }

  const liveHref = state.freeAddress ?? `/site/${state.slug}`

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Your website"
        description="Visitors see this once you publish. Until then your normal booking page is shown."
        footer={
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${chip.cls}`}>{chip.text}</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={preview}>
                Preview
              </button>
              <button type="button" className={secondaryButtonClass} disabled={busy || !dirty} onClick={() => run(() => saveWebsiteDraft(c, template), "Draft saved.")}>
                Save draft
              </button>
              <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => run(() => publishWebsite(c, template), "Published. Your site is live.")}>
                {pending ? "Working…" : "Publish"}
              </button>
            </div>
          </div>
        }
      >
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {note && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</p>}

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Look</p>
          <div role="radiogroup" aria-label="Template" className="grid gap-2 sm:grid-cols-2">
            {TEMPLATES.filter((t) => state.availableTemplates.includes(t.id)).map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={template === t.id}
                onClick={() => setTemplate(t.id)}
                className={`rounded-lg border bg-card p-3 text-left transition-colors hover:bg-tint ${template === t.id ? "border-accent ring-2 ring-accent" : "border-line-strong"}`}
              >
                <span className="block text-sm font-semibold text-ink">{t.label}</span>
                <span className="mt-0.5 block text-xs text-ink-muted">{TEMPLATE_INFO[t.id]}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-ink-muted">Colours and logo come from Branding. A new look only goes live when you Publish.</p>
        </div>

        <div className="rounded-lg border border-line bg-canvas p-3 text-sm">
          <p className="font-medium text-ink">Where your site lives</p>
          {state.isPublished ? (
            <p className="mt-1 text-ink-muted">
              <a className="font-medium text-ink underline underline-offset-4" href={liveHref} target="_blank" rel="noreferrer">
                {state.freeAddress ?? `/site/${state.slug}`}
              </a>
              {" · "}
              <button type="button" className="underline underline-offset-4" disabled={busy} onClick={() => run(unpublishWebsite, "Site switched off. Your normal booking page is shown again.")}>
                Switch it off
              </button>
            </p>
          ) : (
            <p className="mt-1 text-ink-muted">
              {state.freeAddress ? `Once published: ${state.freeAddress}` : "Your free address appears here once it is set up."} Want your own name (like yourbusiness.co.za)? Add it under Custom domain.
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="Words and photos">
        <Field label="Headline"><input className={inputClass} maxLength={80} value={c.headline} onChange={(e) => set("headline", e.target.value)} /></Field>
        <Field label="Line under the headline"><input className={inputClass} maxLength={160} value={c.subheadline} onChange={(e) => set("subheadline", e.target.value)} /></Field>
        <Field label="About us (optional)"><textarea className={inputClass} rows={3} maxLength={600} value={c.about} onChange={(e) => set("about", e.target.value)} /></Field>

        <div>
          <p className="mb-1 text-sm font-medium text-ink">Main photo</p>
          <div className="flex items-center gap-3">
            {c.heroImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.heroImageUrl} alt="" className="h-16 w-24 rounded-md object-cover" />
            ) : (
              <div className="grid h-16 w-24 place-items-center rounded-md border border-dashed border-line-strong text-xs text-ink-muted">None</div>
            )}
            <input ref={heroInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "hero"); e.target.value = "" }} />
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => heroInput.current?.click()}>
              {uploading === "hero" ? "Uploading…" : c.heroImageUrl ? "Change photo" : "Add photo"}
            </button>
            {c.heroImageUrl && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => set("heroImageUrl", "")}>Remove</button>}
          </div>
          <p className="mt-1 text-xs text-ink-muted">PNG, JPG or WEBP, up to 3 MB. A wide photo works best.</p>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium text-ink">Gallery ({c.gallery.length}/{MAX_GALLERY})</p>
          <div className="flex flex-wrap gap-2">
            {c.gallery.map((u, i) => (
              <div key={u} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="" className="h-16 w-16 rounded-md object-cover" />
                <button type="button" aria-label="Remove photo" disabled={busy} onClick={() => set("gallery", c.gallery.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black text-xs text-white">×</button>
              </div>
            ))}
            {c.gallery.length < MAX_GALLERY && (
              <>
                <input ref={galleryInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "gallery"); e.target.value = "" }} />
                <button type="button" className={`${secondaryButtonClass} h-16 w-16`} disabled={busy} onClick={() => galleryInput.current?.click()}>
                  {uploading === "gallery" ? "…" : "+ Add"}
                </button>
              </>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-muted">Shown only if “Photo gallery” is switched on below.</p>
        </div>
      </SettingsCard>

      <SettingsCard title="WhatsApp" description="Order, Buy tickets and Reserve buttons open a chat with this number. Booking sites use your booking page for Book now and Join the queue.">
        <Field label="WhatsApp number"><input className={inputClass} inputMode="tel" placeholder="082 123 4567" value={c.whatsappNumber} onChange={(e) => set("whatsappNumber", e.target.value)} /></Field>
        <Field label="Message the customer starts with"><input className={inputClass} maxLength={200} value={c.whatsappMessage} onChange={(e) => set("whatsappMessage", e.target.value)} /></Field>
      </SettingsCard>

      <SettingsCard title={template === "booking" || template === "orders" ? "Address" : "Opening hours and address"} description={template === "booking" || template === "orders" ? "Opening hours come from Settings > Business hours, so they are always right." : undefined}>
        {template !== "booking" && template !== "orders" && c.hours.map((h, i) => (
          <div key={i} className="flex gap-2">
            <input aria-label="Days" className={inputClass} maxLength={40} value={h.label} onChange={(e) => set("hours", c.hours.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input aria-label="Hours" className={inputClass} maxLength={40} value={h.value} onChange={(e) => set("hours", c.hours.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button type="button" className={secondaryButtonClass} aria-label="Remove row" onClick={() => set("hours", c.hours.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {template !== "booking" && template !== "orders" && c.hours.length < 7 && <button type="button" className={secondaryButtonClass} onClick={() => set("hours", [...c.hours, { label: "", value: "" }])}>Add a row</button>}
        <Field label="Address"><input className={inputClass} maxLength={200} value={c.address} onChange={(e) => set("address", e.target.value)} /></Field>
      </SettingsCard>

      <SettingsCard title="Sections" description="Turn parts of the page on or off. “Live” ones update by themselves from your own setup.">
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
