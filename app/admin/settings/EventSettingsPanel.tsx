// app/admin/settings/EventSettingsPanel.tsx
//
// Settings > Event settings. Moved here from the Events page's right-hand drawer (EventSettingsDrawer,
// now removed) so it sits with the other settings pages. It is listed in SettingsManager's nav and
// only appears while the `events` module is effective for the shop.
//
// Two cards, each saved on its own:
//   Sales rules -> how many tickets customers can buy on WhatsApp, and when selling stops
//   Ticket      -> the WhatsApp ticket image (with a live preview of the unsaved values)
// Events have no public page, so the ticket image on WhatsApp is what customers see.
// Data and saving go through the same server actions as before (../events/event-settings-actions),
// which re-check events.manage and the module switch on every call.
"use client"

import { useEffect, useRef, useState, useTransition } from "react"

import { BRAND_SELECTED, BRAND_TEXT } from "@/components/admin/brand"
import type { EventSalesRules, EventTicketHeaderStyle, EventTicketSettings } from "@/lib/services/event-settings"

import {
  getEventSettings,
  previewEventTicket,
  updateEventSalesRules,
  updateEventTicketSettings,
  type EventSettingsConfig,
} from "../events/event-settings-actions"
import { CardSaveRow, ColorField, FieldRow, SettingsCard, Toggle, inputClass } from "./ui"

type Message = { ok: boolean; text: string } | null

const HEADER_STYLES: Array<{ value: EventTicketHeaderStyle; title: string; description: string }> = [
  { value: "gradient", title: "Gradient", description: "Header fades from your header colour into darker." },
  { value: "solid", title: "Solid", description: "Flat header in your header colour." },
  { value: "light", title: "Light", description: "White header with a coloured accent line." },
]

const FIELD_TOGGLES: Array<{ key: "showLogo" | "showPrice" | "showAddress" | "showReference" | "showPhone"; label: string; hint: string }> = [
  { key: "showLogo", label: "Logo", hint: "Your logo in the header (needs a PNG, JPEG or SVG logo)." },
  { key: "showPrice", label: "Price", hint: "The price of one ticket of this type." },
  { key: "showAddress", label: "Event location", hint: "The location you entered for the event." },
  { key: "showReference", label: "Ticket number", hint: "The number staff can use to look the ticket up." },
  { key: "showPhone", label: "Customer phone", hint: "The buyer's number. Off by default for privacy." },
]

export function EventSettingsPanel() {
  const [config, setConfig] = useState<EventSettingsConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getEventSettings().then((res) => {
      if (cancelled) return
      if (res.success) setConfig(res.config)
      else setLoadError(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
  if (!config) return <p className="text-sm text-ink-muted">Loading event settings…</p>

  return (
    <div className="space-y-4">
      <SalesRulesCard initial={config.rules} />
      <TicketCard config={config} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sales rules
// ---------------------------------------------------------------------------

const toNum = (v: string): number | null => (v.trim() === "" ? null : Number(v))

function SalesRulesCard({ initial }: { initial: EventSalesRules }) {
  const [saved, setSaved] = useState(initial)
  const [maxPerPurchase, setMaxPerPurchase] = useState(String(initial.maxPerPurchase))
  const [maxPerCustomer, setMaxPerCustomer] = useState(initial.maxPerCustomer == null ? "" : String(initial.maxPerCustomer))
  const [stopMinutes, setStopMinutes] = useState(String(initial.stopSalesMinutesBefore))
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<Message>(null)

  const draft: EventSalesRules = {
    maxPerPurchase: Number(maxPerPurchase),
    maxPerCustomer: toNum(maxPerCustomer),
    stopSalesMinutesBefore: Number(stopMinutes === "" ? 0 : stopMinutes),
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  function discard() {
    setMaxPerPurchase(String(saved.maxPerPurchase))
    setMaxPerCustomer(saved.maxPerCustomer == null ? "" : String(saved.maxPerCustomer))
    setStopMinutes(String(saved.stopSalesMinutesBefore))
    setMessage(null)
  }

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await updateEventSalesRules(draft)
      if (res.success) {
        setSaved(draft)
        setMessage({ ok: true, text: "Saved." })
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })
  }

  return (
    <SettingsCard
      title="Sales rules"
      description="Checked on every WhatsApp purchase, so they can't be bypassed from the chat. Box office sales aren't limited."
      footer={<CardSaveRow dirty={dirty} isPending={isPending} onSave={save} onDiscard={discard} message={message} />}
    >
      <div className="space-y-4">
        <FieldRow label="Tickets per purchase (1-10)" hint="The most a customer can buy in one go.">
          <input type="number" min={1} max={10} className={inputClass} value={maxPerPurchase} onChange={(e) => setMaxPerPurchase(e.target.value)} />
        </FieldRow>
        <FieldRow
          label="Tickets per customer, per event (optional)"
          hint="Counts tickets the customer already holds for the event (cancelled and refunded ones don't count). Leave empty for no limit."
        >
          <input
            type="number"
            min={1}
            max={100}
            className={inputClass}
            placeholder="No limit"
            value={maxPerCustomer}
            onChange={(e) => setMaxPerCustomer(e.target.value)}
          />
        </FieldRow>
        <FieldRow
          label="Stop WhatsApp sales this many minutes before the event starts"
          hint="0 keeps selling until the event ends. For example 60 closes sales an hour before the start. Tickets can still be sold at the box office."
        >
          <input type="number" min={0} max={10080} className={inputClass} value={stopMinutes} onChange={(e) => setStopMinutes(e.target.value)} />
        </FieldRow>
      </div>
    </SettingsCard>
  )
}

// ---------------------------------------------------------------------------
// Ticket (live preview)
// ---------------------------------------------------------------------------

function TicketCard({ config }: { config: EventSettingsConfig }) {
  const [form, setForm] = useState<EventTicketSettings>(config.ticket)
  const [baseline, setBaseline] = useState<EventTicketSettings>(config.ticket)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<Message>(null)

  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewSeq = useRef(0)

  // Debounced live preview with the UNSAVED values.
  useEffect(() => {
    const seq = ++previewSeq.current
    const timer = setTimeout(async () => {
      setPreviewing(true)
      const res = await previewEventTicket(form)
      if (seq !== previewSeq.current) return
      setPreviewing(false)
      if (res.success) {
        setPreview(res.dataUri)
        setPreviewError(null)
      } else {
        setPreviewError(res.error)
      }
    }, 700)
    return () => clearTimeout(timer)
  }, [form])

  const set = <K extends keyof EventTicketSettings>(key: K, value: EventTicketSettings[K]) => setForm((f) => ({ ...f, [key]: value }))
  const customColours = form.headerColor != null || form.accentColor != null
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await updateEventTicketSettings(form)
      if (res.success) {
        setBaseline(form)
        setMessage({ ok: true, text: "Saved." })
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })
  }

  return (
    <SettingsCard
      title="Event ticket"
      description="After a customer buys on WhatsApp they get the text confirmation, plus a plain QR code and/or a branded ticket image. You choose which."
      footer={
        <CardSaveRow
          dirty={dirty}
          isPending={isPending}
          onSave={save}
          onDiscard={() => {
            setForm(baseline)
            setMessage(null)
          }}
          message={message}
        />
      }
    >
      <div className="space-y-4">
        <div className="space-y-3 rounded-lg border border-line bg-canvas p-3">
          <p className="text-sm font-medium text-ink">What customers receive</p>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">{form.enabled ? "Ticket image is on" : "Ticket image is off"}</p>
              <p className="text-xs text-ink-muted">The branded ticket image. It has the QR code on it, so it works at the gate by itself.</p>
            </div>
            <Toggle
              checked={form.enabled}
              disabled={isPending}
              // Never let both be off: turning one off while the other is off switches the other back on.
              onChange={(next) => setForm((f) => ({ ...f, enabled: next, sendQr: next ? f.sendQr : true }))}
            />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <div>
              <p className="text-sm font-medium text-ink">{form.sendQr ? "QR code is on" : "QR code is off"}</p>
              <p className="text-xs text-ink-muted">A separate plain QR code message for each ticket. Turn it off to send the ticket image only.</p>
            </div>
            <Toggle
              checked={form.sendQr}
              disabled={isPending}
              onChange={(next) => setForm((f) => ({ ...f, sendQr: next, enabled: next ? f.enabled : true }))}
            />
          </div>
          <p className="text-xs text-ink-muted">At least one stays on, so customers always get something to scan.</p>
        </div>

        <div className={`grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] ${form.enabled ? "" : "opacity-60"}`}>
          <div className="space-y-4">
            <FieldRow label="Header style">
              <div className="grid gap-2 sm:grid-cols-3">
                {HEADER_STYLES.map((option) => {
                  const selected = form.headerStyle === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => set("headerStyle", option.value)}
                      aria-pressed={selected}
                      className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
                        selected ? `${BRAND_SELECTED} bg-card` : "border-stone-300 bg-stone-50 hover:bg-stone-100"
                      }`}
                    >
                      <span className={`text-sm font-semibold ${selected ? BRAND_TEXT : "text-stone-800"}`}>{option.title}</span>
                      <span className="text-xs text-stone-500">{option.description}</span>
                    </button>
                  )
                })}
              </div>
            </FieldRow>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-stone-800">Custom ticket colours</p>
                  <p className="text-sm text-stone-500">Off uses your brand colours from Branding.</p>
                </div>
                <Toggle
                  checked={customColours}
                  onChange={(next) =>
                    setForm((f) => ({ ...f, headerColor: next ? config.brandHeader : null, accentColor: next ? config.brandAccent : null }))
                  }
                />
              </div>
              {customColours && (
                <div className="grid grid-cols-2 gap-3">
                  <ColorField label="Header" value={form.headerColor ?? config.brandHeader} onChange={(hex) => set("headerColor", hex)} />
                  <ColorField label="Accent" value={form.accentColor ?? config.brandAccent} onChange={(hex) => set("accentColor", hex)} />
                </div>
              )}
            </div>

            <FieldRow label="Ticket label">
              <input
                className={inputClass}
                maxLength={40}
                placeholder="Ticket Confirmed"
                value={form.eyebrow ?? ""}
                onChange={(e) => set("eyebrow", e.target.value || null)}
              />
            </FieldRow>

            <FieldRow label="Footer message" hint="Shown under the QR code.">
              <input
                className={inputClass}
                maxLength={120}
                placeholder="Show this QR code at the gate"
                value={form.footerText ?? ""}
                onChange={(e) => set("footerText", e.target.value || null)}
              />
            </FieldRow>

            <div className="space-y-2">
              <p className="text-sm font-medium text-stone-800">What the ticket shows</p>
              {FIELD_TOGGLES.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-stone-800">{f.label}</p>
                    <p className="text-xs text-stone-500">{f.hint}</p>
                  </div>
                  <Toggle checked={form[f.key]} onChange={(next) => set(f.key, next)} />
                </div>
              ))}
              <p className="text-xs text-stone-400">The event name, date, time, ticket type, buyer name and QR code are always shown. The QR code is the entry pass.</p>
            </div>
          </div>

          <div className="max-w-[280px] space-y-2 lg:sticky lg:top-4 lg:self-start">
            <p className="text-sm font-medium text-stone-800">Preview</p>
            <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-50">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- generated data URI
                <img src={preview} alt="Event ticket preview" className="w-full" />
              ) : (
                <span className="px-3 text-center text-xs text-stone-400">{previewing ? "Rendering…" : "Preview appears here"}</span>
              )}
            </div>
            {previewing && preview && <p className="text-xs text-stone-400">Updating…</p>}
            {previewError && <p className="text-xs text-red-600">{previewError}</p>}
            <p className="text-xs text-stone-400">Sample event. Shows your saved logo and name.</p>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
