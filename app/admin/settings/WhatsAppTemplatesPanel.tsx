// app/admin/settings/WhatsAppTemplatesPanel.tsx
"use client"

import { useEffect, useState, useTransition } from "react"

import {
  loadWhatsAppTemplates,
  saveWhatsAppTemplateBody,
  seedWhatsAppTemplates,
  setWhatsAppTemplateEnabled,
  submitWhatsAppTemplate,
  syncWhatsAppTemplateStatuses,
  type WhatsAppTemplateDto,
  type WhatsAppTemplateStatus,
} from "../whatsapp-template-actions"
import { SettingsCard, inputClass, primaryButtonClass, secondaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// WhatsApp message templates — what customers get when they have NOT messaged
// you in the last 24 hours (e.g. kiosk customers). Meta must approve each one.
// Rendered on the "WhatsApp messages" settings page, under the existing panel.
// ---------------------------------------------------------------------------

const TEMPLATE_INFO: Record<string, { label: string; when: string }> = {
  queue_joined: { label: "Joined the queue", when: "Sent when someone joins the queue." },
  queue_almost_turn: { label: "Nearly their turn", when: "Sent once, when they reach the “notify before turn” position in Queue rules." },
  queue_called: { label: "It's their turn", when: "Sent when you call them from the queue." },
  waitlist_slot_open: {
    label: "A time opened up (waitlist)",
    when: "Sent when a booked time is freed up and this customer is next on the waitlist for that day.",
  },
}

const VARIABLE_LABELS: Record<string, string> = {
  customer_name: "customer's first name",
  business_name: "your business name",
  service_name: "service",
  ticket: "ticket number",
  people_ahead: "people ahead",
  wait_minutes: "estimated wait (minutes)",
  booking_date: "the day they're waiting for",
}

const STATUS_STYLE: Record<WhatsAppTemplateStatus, { label: string; className: string }> = {
  draft: { label: "Not submitted", className: "bg-stone-100 text-stone-600" },
  pending: { label: "In review at Meta", className: "bg-amber-100 text-amber-800" },
  approved: { label: "Approved", className: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800" },
  paused: { label: "Paused by Meta", className: "bg-red-100 text-red-800" },
  disabled: { label: "Disabled", className: "bg-stone-200 text-stone-600" },
}

function preview(t: WhatsAppTemplateDto, body: string): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => t.exampleValues[Number(n) - 1] ?? "…")
}

export function WhatsAppTemplatesPanel() {
  const [templates, setTemplates] = useState<WhatsAppTemplateDto[] | null>(null)
  const [connected, setConnected] = useState(true)
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<Record<string, { text: string; ok: boolean }>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function applyTemplates(list: WhatsAppTemplateDto[]) {
    setTemplates(list)
    setBodies(Object.fromEntries(list.map((t) => [t.key, t.body])))
  }

  async function load() {
    const result = await loadWhatsAppTemplates()
    if (!result.success) return setLoadError(result.error)
    setConnected(result.connected)
    applyTemplates(result.templates)
  }

  useEffect(() => {
    void load()
  }, [])

  function note(key: string, text: string, ok: boolean) {
    setMessages((m) => ({ ...m, [key]: { text, ok } }))
  }

  function setUp() {
    startTransition(async () => {
      const result = await seedWhatsAppTemplates()
      if (!result.success) return setLoadError(result.error)
      await load()
    })
  }

  function refresh() {
    setBusyKey("*")
    startTransition(async () => {
      const result = await syncWhatsAppTemplateStatuses()
      setBusyKey(null)
      if (!result.success) return setLoadError(result.error)
      setLoadError(null)
      setTemplates(result.templates)
    })
  }

  function save(t: WhatsAppTemplateDto) {
    setBusyKey(t.key)
    startTransition(async () => {
      const result = await saveWhatsAppTemplateBody(t.key, bodies[t.key] ?? t.body)
      setBusyKey(null)
      if (!result.success) return note(t.key, result.error, false)
      setTemplates((list) => list?.map((x) => (x.key === t.key ? result.template : x)) ?? null)
      note(t.key, "Saved. Submit it to Meta when you're happy with the wording.", true)
    })
  }

  function toggleEnabled(t: WhatsAppTemplateDto) {
    const next = !t.enabled
    setBusyKey(t.key)
    startTransition(async () => {
      const result = await setWhatsAppTemplateEnabled(t.key, next)
      setBusyKey(null)
      if (!result.success) return note(t.key, result.error, false)
      setTemplates((list) => list?.map((x) => (x.key === t.key ? { ...x, enabled: next } : x)) ?? null)
      note(t.key, next ? "Turned on." : "Turned off. Customers won't get this message.", true)
    })
  }

  function submit(t: WhatsAppTemplateDto) {
    setBusyKey(t.key)
    startTransition(async () => {
      // Save any unsaved edits first so Meta gets exactly what's on screen.
      if ((bodies[t.key] ?? t.body) !== t.body) {
        const saved = await saveWhatsAppTemplateBody(t.key, bodies[t.key])
        if (!saved.success) {
          setBusyKey(null)
          return note(t.key, saved.error, false)
        }
      }
      const result = await submitWhatsAppTemplate(t.key)
      setBusyKey(null)
      if (!result.success) return note(t.key, result.error, false)
      setTemplates((list) => list?.map((x) => (x.key === t.key ? result.template : x)) ?? null)
      note(t.key, "Sent to Meta. Reviews usually take a few minutes.", true)
    })
  }

  return (
    <SettingsCard
      title="Messages to customers who haven't messaged you"
      description="WhatsApp only lets you message someone first with a template Meta has approved. Customers who check in at the kiosk have no open chat, so these are what they receive."
    >
      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      {!connected && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          WhatsApp isn&apos;t connected for this shop yet, so templates can&apos;t be sent to Meta.
        </p>
      )}

      {templates === null ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : templates.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-stone-600">No templates set up yet.</p>
          <button type="button" className={primaryButtonClass} onClick={setUp} disabled={isPending}>
            Set up default templates
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-stone-500">
              Keep the wording factual. Promotional wording gets a template re-labelled &ldquo;Marketing&rdquo;, which costs more.
            </p>
            <button type="button" className={secondaryButtonClass} onClick={refresh} disabled={isPending || !connected}>
              {busyKey === "*" ? "Checking…" : "Refresh status"}
            </button>
          </div>

          {templates.map((t) => {
            const info = TEMPLATE_INFO[t.key] ?? { label: t.key, when: "" }
            const style = STATUS_STYLE[t.status]
            const body = bodies[t.key] ?? t.body
            const dirty = body !== t.body
            const locked = t.status === "pending"
            const msg = messages[t.key]
            const busy = busyKey === t.key
            return (
              <div key={t.key} className={`space-y-2 rounded-xl border border-stone-200 p-4 ${t.enabled ? "" : "bg-stone-50"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-stone-900">{info.label}</p>
                    <p className="text-xs text-stone-500">{info.when}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${style.className}`}>{style.label}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={t.enabled}
                      aria-label={`Send "${info.label}" message`}
                      onClick={() => toggleEnabled(t)}
                      disabled={isPending}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                        t.enabled ? "bg-emerald-600" : "bg-stone-300"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                          t.enabled ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {!t.enabled && (
                  <p className="text-xs text-stone-500">Off: customers won&apos;t receive this message.</p>
                )}
                {t.enabled && t.key === "queue_called" && (
                  <p className="text-xs text-stone-400">
                    This is how customers learn it&apos;s their turn. Only turn it off if you tell them another way.
                  </p>
                )}

                <textarea
                  className={`${inputClass} min-h-[96px]`}
                  value={body}
                  disabled={locked}
                  maxLength={1024}
                  onChange={(e) => setBodies((b) => ({ ...b, [t.key]: e.target.value }))}
                />

                <p className="text-xs text-stone-500">
                  {t.variables.map((v, i) => (
                    <span key={v} className="mr-3 inline-block">
                      <code className="rounded bg-stone-100 px-1">{`{{${i + 1}}}`}</code> {VARIABLE_LABELS[v] ?? v}
                    </span>
                  ))}
                </p>
                <p className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">
                  <span className="text-xs text-stone-400">Preview: </span>
                  {preview(t, body)}
                </p>

                {t.status === "rejected" && t.rejectionReason && (
                  <p className="text-sm text-red-700">Meta&apos;s reason: {t.rejectionReason}. Edit the wording and submit again.</p>
                )}
                {t.status === "approved" && dirty && (
                  <p className="text-xs text-amber-700">
                    Changing an approved template means Meta reviews it again. Until it&apos;s approved, customers outside the 24-hour
                    window won&apos;t get this message.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={secondaryButtonClass} onClick={() => save(t)} disabled={!dirty || locked || isPending}>
                    {busy && dirty ? "Saving…" : "Save wording"}
                  </button>
                  {(t.status === "draft" || t.status === "rejected" || dirty) && (
                    <button type="button" className={primaryButtonClass} onClick={() => submit(t)} disabled={locked || isPending || !connected}>
                      {busy ? "Sending…" : "Submit to Meta"}
                    </button>
                  )}
                  {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </SettingsCard>
  )
}
