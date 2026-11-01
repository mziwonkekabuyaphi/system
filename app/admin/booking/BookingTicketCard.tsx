// app/admin/booking/BookingTicketCard.tsx
"use client"

import { useEffect, useRef, useState, useTransition } from "react"

import {
  getBookingTicketConfig,
  previewBookingTicket,
  updateBookingTicketSettings,
  type AdminBookingTicketSettings,
  type BookingTicketConfig,
  type TicketHeaderStyle,
} from "./booking-ticket-actions"
import { BRAND_SELECTED, BRAND_TEXT } from "@/components/admin/brand"
import { ColorField, FieldRow, SaveRow, Toggle, inputClass, secondaryButtonClass } from "../settings/ui"

const HEADER_STYLES: Array<{ value: TicketHeaderStyle; title: string; description: string }> = [
  { value: "gradient", title: "Gradient", description: "Header fades from your header colour into your accent." },
  { value: "solid", title: "Solid", description: "Flat header in your header colour." },
  { value: "light", title: "Light", description: "White header with a coloured accent line." },
]

const FIELD_TOGGLES: Array<{ key: keyof AdminBookingTicketSettings; label: string; hint: string }> = [
  { key: "showLogo", label: "Logo", hint: "Your logo in the header (needs a PNG, JPEG or SVG logo)." },
  { key: "showPrice", label: "Price", hint: "Total price of the booked services." },
  { key: "showDuration", label: "Duration", hint: "How long the appointment runs." },
  { key: "showAddress", label: "Address", hint: "Your shop address from General settings." },
  { key: "showReference", label: "Booking reference", hint: "The reference staff use to find the booking." },
  { key: "showQr", label: "QR code", hint: "Encodes the booking reference for quick check-in." },
  { key: "showPhone", label: "Customer phone", hint: "The customer's number. Off by default for privacy." },
]

/**
 * The "Ticket" tab of the Booking rules overlay (see BookingRulesDrawer).
 * It loads and saves on its own (own Save button), so it doesn't depend on the
 * booking-settings loader. Laid out in one column because it lives in a
 * narrow overlay, not a full-width settings page.
 */
export function BookingTicketCard() {
  const [config, setConfig] = useState<BookingTicketConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<AdminBookingTicketSettings | null>(null)

  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    getBookingTicketConfig().then((res) => {
      if (cancelled) return
      if (res.success) {
        setConfig(res.config)
        setForm(res.config.settings)
      } else {
        setLoadError(res.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced live preview using the UNSAVED form values.
  useEffect(() => {
    if (!form || !config?.allowed) return
    const seq = ++previewSeq.current
    const timer = setTimeout(async () => {
      setPreviewing(true)
      const res = await previewBookingTicket(form)
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
  }, [form, config?.allowed])

  if (loadError) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-card p-4 shadow-sm">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
      </div>
    )
  }
  if (!config || !form) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-card p-4 shadow-sm">
        <p className="text-sm text-stone-400">Loading booking ticket…</p>
      </div>
    )
  }

  const locked = !config.allowed
  const set = <K extends keyof AdminBookingTicketSettings>(key: K, value: AdminBookingTicketSettings[K]) =>
    setForm({ ...form, [key]: value })

  const customColours = form.headerColor != null || form.accentColor != null

  function save() {
    if (!form) return
    setMessage(null)
    startTransition(async () => {
      const result = await updateBookingTicketSettings(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Booking ticket</p>
          <p className="text-sm text-stone-500">
            After a customer books on WhatsApp they get a branded ticket image with a QR code, on top of the text
            confirmation.
          </p>
        </div>
        <Toggle checked={form.enabled && !locked} disabled={isPending || locked} onChange={(next) => set("enabled", next)} />
      </div>

      {locked && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Booking tickets are a Business plan feature. Customers on your current plan get the text confirmation only.
          Upgrade from Plans &amp; Billing to turn them on.
        </p>
      )}

      <div className={`mt-4 grid gap-4 ${locked || !form.enabled ? "pointer-events-none opacity-50" : ""}`}>
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
                      selected
                        ? `${BRAND_SELECTED} bg-card`
                        : "border-stone-300 bg-stone-50 hover:bg-stone-100"
                    }`}
                  >
                    <span className={`text-sm font-semibold ${selected ? BRAND_TEXT : "text-stone-800"}`}>
                      {option.title}
                    </span>
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
                  setForm({
                    ...form,
                    headerColor: next ? config.brandHeader : null,
                    accentColor: next ? config.brandAccent : null,
                  })
                }
              />
            </div>
            {customColours && (
              <div className="grid grid-cols-2 gap-3">
                <ColorField
                  label="Header"
                  value={form.headerColor ?? config.brandHeader}
                  onChange={(hex) => set("headerColor", hex)}
                />
                <ColorField
                  label="Accent"
                  value={form.accentColor ?? config.brandAccent}
                  onChange={(hex) => set("accentColor", hex)}
                />
              </div>
            )}
          </div>

          <FieldRow label="Ticket label">
            <input
              className={inputClass}
              maxLength={40}
              placeholder="Booking Confirmed"
              value={form.eyebrow ?? ""}
              onChange={(e) => set("eyebrow", e.target.value || null)}
            />
          </FieldRow>

          <FieldRow label="Footer message">
            <input
              className={inputClass}
              maxLength={120}
              placeholder="e.g. Please arrive 5 minutes early"
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
                <Toggle checked={form[f.key] as boolean} onChange={(next) => set(f.key, next as never)} />
              </div>
            ))}
          </div>
        </div>

        <div className="max-w-[280px] space-y-2">
          <p className="text-sm font-medium text-stone-800">Preview</p>
          <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-50">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- generated data URI
              <img src={preview} alt="Booking ticket preview" className="w-full" />
            ) : (
              <span className="px-3 text-center text-xs text-stone-400">
                {locked ? "Available on the Business plan" : previewing ? "Rendering…" : "Preview appears here"}
              </span>
            )}
          </div>
          {previewing && preview && <p className="text-xs text-stone-400">Updating…</p>}
          {previewError && <p className="text-xs text-red-600">{previewError}</p>}
          <p className="text-xs text-stone-400">Sample booking. Shows your saved logo, name and address.</p>
        </div>
      </div>

      {!locked && (
        <>
          <button
            type="button"
            className={`${secondaryButtonClass} mt-4`}
            onClick={() => config && setForm(config.settings)}
            disabled={isPending}
          >
            Discard changes
          </button>
          <SaveRow isPending={isPending} onSave={save} message={message} />
        </>
      )}
    </div>
  )
}
