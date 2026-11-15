// app/admin/events/EventSettingsDrawer.tsx
//
// Event settings as a right-hand overlay on the Events page, same pattern as Booking rules.
// Tabs: Sales rules (limits and when selling stops) and Ticket (the WhatsApp ticket image, with a
// live preview). Events have no public page, so the ticket image on WhatsApp is what customers see.
// Each tab saves on its own; the children unmount when the drawer closes so it always loads fresh.
"use client"

import { useEffect, useRef, useState, useTransition } from "react"

import { AdminDrawer, DRAWER_FIELD, DrawerField, DrawerGroup, DrawerTabs } from "@/components/admin/AdminDrawer"
import { BRAND_SELECTED, BRAND_TEXT } from "@/components/admin/brand"
import { ColorField, FieldRow, SaveRow, Toggle, inputClass, secondaryButtonClass } from "../settings/ui"
import {
  getEventSettings,
  previewEventTicket,
  updateEventSalesRules,
  updateEventTicketSettings,
  type EventSettingsConfig,
} from "./event-settings-actions"
import type { EventSalesRules, EventTicketHeaderStyle, EventTicketSettings } from "@/lib/services/event-settings"

type TabId = "sales" | "ticket"
type Message = { ok: boolean; text: string } | null

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "sales", label: "Sales rules" },
  { id: "ticket", label: "Ticket" },
]

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

export function EventSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AdminDrawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Event settings"
      subtitle="How many tickets customers can buy on WhatsApp, when selling stops, and what the ticket image looks like."
    >
      <DrawerBody />
    </AdminDrawer>
  )
}

function DrawerBody() {
  const [tab, setTab] = useState<TabId>("sales")
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
    <div className="space-y-5">
      <DrawerTabs tabs={TABS} value={tab} onChange={setTab} label="Event settings" />
      {/* Both tabs stay mounted so switching doesn't lose unsaved edits. */}
      <div hidden={tab !== "sales"}>
        <SalesRulesTab initial={config.rules} />
      </div>
      <div hidden={tab !== "ticket"}>
        <TicketTab config={config} visible={tab === "ticket"} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sales rules
// ---------------------------------------------------------------------------

const toNum = (v: string): number | null => (v.trim() === "" ? null : Number(v))

function SalesRulesTab({ initial }: { initial: EventSalesRules }) {
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
    <div className="space-y-6">
      <DrawerGroup title="Ticket limits" hint="Checked on every WhatsApp purchase, so they can't be bypassed from the chat.">
        <DrawerField label="Tickets per purchase (1-10)" hint="The most a customer can buy in one go.">
          <input type="number" min={1} max={10} className={DRAWER_FIELD} value={maxPerPurchase} onChange={(e) => setMaxPerPurchase(e.target.value)} />
        </DrawerField>
        <DrawerField
          label="Tickets per customer, per event (optional)"
          hint="Counts tickets the customer already holds for the event (cancelled and refunded ones don't count). Leave empty for no limit. Box office sales aren't limited."
        >
          <input
            type="number"
            min={1}
            max={100}
            className={DRAWER_FIELD}
            placeholder="No limit"
            value={maxPerCustomer}
            onChange={(e) => setMaxPerCustomer(e.target.value)}
          />
        </DrawerField>
      </DrawerGroup>

      <DrawerGroup title="When selling stops">
        <DrawerField
          label="Stop WhatsApp sales this many minutes before the event starts"
          hint="0 keeps selling until the event ends. For example 60 closes sales an hour before the start. Tickets can still be sold at the box office."
        >
          <input type="number" min={0} max={10080} className={DRAWER_FIELD} value={stopMinutes} onChange={(e) => setStopMinutes(e.target.value)} />
        </DrawerField>
      </DrawerGroup>

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <button type="button" onClick={save} disabled={isPending || !dirty} className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {isPending ? "Saving…" : "Save changes"}
        </button>
        {message ? (
          <span className={`text-sm ${message.ok ? "text-success" : "text-red-700"}`}>{message.text}</span>
        ) : (
          <span className="text-xs text-ink-muted">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ticket (live preview)
// ---------------------------------------------------------------------------

function TicketTab({ config, visible }: { config: EventSettingsConfig; visible: boolean }) {
  const [form, setForm] = useState<EventTicketSettings>(config.ticket)
  const [baseline, setBaseline] = useState<EventTicketSettings>(config.ticket)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<Message>(null)

  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewSeq = useRef(0)

  // Debounced live preview with the UNSAVED values. Only runs while the tab is showing.
  useEffect(() => {
    if (!visible) return
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
  }, [form, visible])

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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Event ticket</p>
          <p className="text-sm text-stone-500">
            After a customer buys on WhatsApp they get a branded ticket image with a QR code, on top of the text confirmation. Turn it
            off to send the text and plain QR code only.
          </p>
        </div>
        <Toggle checked={form.enabled} disabled={isPending} onChange={(next) => set("enabled", next)} />
      </div>

      <div className={`grid gap-4 ${form.enabled ? "" : "opacity-60"}`}>
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
                <p className="text-sm text-stone-500">Off uses your brand colours from Private Label.</p>
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

        <div className="max-w-[280px] space-y-2">
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

      <button type="button" className={secondaryButtonClass} onClick={() => setForm(baseline)} disabled={isPending || !dirty}>
        Discard changes
      </button>
      <SaveRow isPending={isPending} onSave={save} message={message} />
    </div>
  )
}
