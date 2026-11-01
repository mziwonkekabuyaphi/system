// app/admin/queue/QueueRulesDrawer.tsx
//
// Queue rules as a right-hand overlay on the Live Queue tab (same pattern as
// Shisha's TV display): tabs, one Save for the whole panel, and closing with
// unsaved changes asks first. Replaces the "Queue rules" page under Settings.
//
// Settings come from AdminView (lifted state) so Kiosk > Services, which edits
// the same row, always shows what was last saved here and vice versa.
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  AdminDrawer,
  DRAWER_BTN,
  DRAWER_BTN_PRIMARY,
  DRAWER_FIELD,
  DrawerField,
  DrawerGroup,
  DrawerSwitch,
  DrawerTabs,
} from "@/components/admin/AdminDrawer"
import { updateQueueSettings } from "../settings-actions"
import type { AdminQueueSettings } from "../types"

type Tab = "line" | "services" | "tickets"
type Message = { kind: "success" | "error"; text: string }

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "line", label: "The line" },
  { id: "services", label: "Services" },
  { id: "tickets", label: "Tickets" },
]

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max

/** One message per problem, keyed by tab so the tab can show a dot. The server re-validates. */
function validate(s: AdminQueueSettings): { line?: string; services?: string; tickets?: string } {
  const errors: { line?: string; services?: string; tickets?: string } = {}
  if (s.maxQueueSize !== null && !isInt(s.maxQueueSize, 1)) errors.line = "Maximum queue size must be a whole number of 1 or more, or blank for no limit."
  else if (!isInt(s.notifyBeforeTurnPosition, 0)) errors.line = "“Notify before turn” must be a whole number, 0 or more."
  if (s.requireServiceSelection) {
    if (!isInt(s.maxServicesPerQueueEntry, 1, 5)) errors.services = "Services per ticket must be a whole number from 1 to 5."
  } else if (!isInt(s.defaultServiceDurationMinutes, 1)) {
    errors.services = "Estimated minutes must be a whole number of 1 or more."
  }
  const prefix = s.ticketNumberPrefix.trim()
  if (prefix.length < 1 || prefix.length > 4) errors.tickets = "Use 1 to 4 characters for the ticket prefix."
  return errors
}

const normalize = (s: AdminQueueSettings): AdminQueueSettings => ({ ...s, ticketNumberPrefix: s.ticketNumberPrefix.trim().toUpperCase() })

export function QueueRulesDrawer({
  open,
  onClose,
  settings,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  settings: AdminQueueSettings
  onSaved: (next: AdminQueueSettings) => void
}) {
  const [baseline, setBaseline] = useState(settings)
  const [draft, setDraft] = useState(settings)
  const [tab, setTab] = useState<Tab>("line")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  // Start from the latest saved copy every time the panel opens.
  useEffect(() => {
    if (!open) return
    setBaseline(settings)
    setDraft(settings)
    setTab("line")
    setMessage(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on open, never mid-edit
  }, [open])

  const dirty = useMemo(() => JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(baseline)), [draft, baseline])
  const errors = useMemo(() => validate(draft), [draft])
  const hasErrors = Boolean(errors.line || errors.services || errors.tickets)
  const canSave = dirty && !saving && !hasErrors

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty && !window.confirm("Discard your unsaved changes?")) return
    onClose()
  }, [dirty, saving, onClose])

  function set<K extends keyof AdminQueueSettings>(key: K, value: AdminQueueSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    setMessage(null)
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    setMessage(null)
    const value = normalize(draft)
    try {
      const res = await updateQueueSettings(value)
      if (res.success) {
        setBaseline(value)
        setDraft(value)
        onSaved(value)
        setMessage({ kind: "success", text: "Saved." })
      } else {
        setMessage({ kind: "error", text: res.error })
      }
    } catch {
      setMessage({ kind: "error", text: "Something went wrong reaching the server. Please try again." })
    } finally {
      setSaving(false)
    }
  }

  const num = (n: number | null) => (n === null || Number.isNaN(n) ? "" : n)
  const tabsWithFlags = TABS.map((t) => ({ ...t, label: errors[t.id] ? `${t.label} •` : t.label }))
  const previewPrefix = draft.ticketNumberPrefix.trim().toUpperCase() || "Q"

  return (
    <AdminDrawer
      open={open}
      onClose={requestClose}
      title="Queue rules"
      subtitle="How the walk-in line behaves for this location."
      footer={
        <>
          {message && (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={`text-sm ${message.kind === "error" ? "text-accent" : "text-success"}`}
            >
              {message.text}
            </p>
          )}
          {!message && hasErrors && (
            <p role="alert" className="text-sm text-accent">
              {errors.line ?? errors.services ?? errors.tickets}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className={DRAWER_BTN}
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(baseline)
                  setMessage(null)
                }}
              >
                Discard
              </button>
              <button type="button" className={DRAWER_BTN_PRIMARY} disabled={!canSave} onClick={() => void save()}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </>
      }
    >
      <div className="space-y-5">
        <DrawerTabs tabs={tabsWithFlags} value={tab} onChange={setTab} label="Queue rules" />

        {tab === "line" && (
          <div className="space-y-6">
            <DrawerGroup title="Calling">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Auto-call next"
                  description="Automatically call the next customer when a slot frees up."
                  checked={draft.autoCallNext}
                  disabled={saving}
                  onChange={(v) => set("autoCallNext", v)}
                />
              </div>
              <DrawerField
                label="Notify a customer this many people before their turn"
                hint="0 = only when they're called."
              >
                <input
                  type="number"
                  min={0}
                  className={DRAWER_FIELD}
                  value={num(draft.notifyBeforeTurnPosition)}
                  onChange={(e) => set("notifyBeforeTurnPosition", e.target.value === "" ? Number.NaN : Number(e.target.value))}
                />
              </DrawerField>
            </DrawerGroup>

            <DrawerGroup title="Limits">
              <DrawerField label="Maximum queue size" hint="Leave blank for no limit.">
                <input
                  type="number"
                  min={1}
                  className={DRAWER_FIELD}
                  placeholder="No limit"
                  value={num(draft.maxQueueSize)}
                  onChange={(e) => set("maxQueueSize", e.target.value === "" ? null : Number(e.target.value))}
                />
              </DrawerField>
            </DrawerGroup>

            <DrawerGroup title="Where walk-ins can join" hint="This only affects walk-ins. Bookings join the line from Settings → Booking rules.">
              <div className="divide-y divide-line rounded-lg border border-line bg-card px-4">
                <DrawerSwitch title="WhatsApp" description="Customers can join by messaging you." checked={draft.allowWalkinWhatsapp} disabled={saving} onChange={(v) => set("allowWalkinWhatsapp", v)} />
                <DrawerSwitch title="Kiosk" description="Customers can join on the touch screen." checked={draft.allowWalkinKiosk} disabled={saving} onChange={(v) => set("allowWalkinKiosk", v)} />
              </div>
            </DrawerGroup>
          </div>
        )}

        {tab === "services" && (
          <div className="space-y-6">
            <DrawerGroup title="Choosing a service">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Require a service to join the queue"
                  description="Turn this off if walk-ins don't choose between services. They'll skip straight to giving their name and number on the kiosk, WhatsApp and admin."
                  checked={draft.requireServiceSelection}
                  disabled={saving}
                  onChange={(v) => set("requireServiceSelection", v)}
                />
              </div>
            </DrawerGroup>

            {draft.requireServiceSelection ? (
              <DrawerGroup title="Per ticket">
                <DrawerField
                  label="Services per queue ticket (1-5)"
                  hint="1 = a single service. 2 or more lets walk-ins tick several on the kiosk. Separate from the booking setting. WhatsApp keeps offering one until it is updated."
                >
                  <input
                    type="number"
                    min={1}
                    max={5}
                    className={DRAWER_FIELD}
                    value={num(draft.maxServicesPerQueueEntry)}
                    onChange={(e) => set("maxServicesPerQueueEntry", e.target.value === "" ? Number.NaN : Number(e.target.value))}
                  />
                </DrawerField>
              </DrawerGroup>
            ) : (
              <DrawerGroup title="Wait estimates">
                <DrawerField
                  label="Estimated minutes to serve a walk-in with no service"
                  hint="Used for wait-time estimates, so a walk-in without a service isn't treated as taking 0 minutes."
                >
                  <input
                    type="number"
                    min={1}
                    className={DRAWER_FIELD}
                    value={num(draft.defaultServiceDurationMinutes)}
                    onChange={(e) => set("defaultServiceDurationMinutes", e.target.value === "" ? Number.NaN : Number(e.target.value))}
                  />
                </DrawerField>
              </DrawerGroup>
            )}
          </div>
        )}

        {tab === "tickets" && (
          <DrawerGroup title="Ticket numbers">
            <DrawerField
              label="Queue ticket number format"
              hint="Shown on printed kiosk tickets and WhatsApp confirmations. Use your own initials or a short word (1-4 characters)."
            >
              <input
                type="text"
                maxLength={4}
                placeholder="e.g. Q"
                className={DRAWER_FIELD}
                value={draft.ticketNumberPrefix}
                onChange={(e) => set("ticketNumberPrefix", e.target.value.toUpperCase())}
              />
            </DrawerField>
            <div className="rounded-lg border border-line bg-card px-4 py-3">
              <p className="text-xs text-ink-muted">Your tickets will look like</p>
              <p className="mt-1 font-mono text-lg text-ink">
                {previewPrefix}001 <span className="text-ink-muted">→ {previewPrefix}002</span>
              </p>
            </div>
          </DrawerGroup>
        )}
      </div>
    </AdminDrawer>
  )
}
