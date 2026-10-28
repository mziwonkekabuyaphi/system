// app/admin/shisha/ShishaDisplayDrawer.tsx
//
// Right-hand overlay panel for the Shisha TV display settings. Opened from the
// "TV display" button in ShishaManager. It loads its own data when it opens
// (settings, tenant slug, branding entitlement), so ShishaManager needs no new
// props. One Save button for the whole panel; closing with unsaved changes asks first.
"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { loadShishaDisplaySettings, updateShishaDisplaySettings } from "./display-actions"
import {
  DISPLAY_LABEL_MAX,
  DISPLAY_TICKER_DEFAULT,
  DISPLAY_TICKER_MAX,
  DISPLAY_TITLE_DEFAULT,
  DISPLAY_TITLE_MAX,
  SHISHA_DISPLAY_LABELS,
  isHex6,
  normalizeShishaDisplaySettings,
  type ShishaDisplayLayout,
  type ShishaDisplaySettings,
  type ShishaDisplaySort,
  type ShishaDisplayTheme,
} from "./shisha-display-types"

type Tab = "look" | "show" | "wording" | "alerts"
type Message = { kind: "success" | "error"; text: string }
type Loaded = { tenantSlug: string; canCustomizeBranding: boolean }

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "look", label: "Look" },
  { id: "show", label: "What shows" },
  { id: "wording", label: "Wording" },
  { id: "alerts", label: "Alerts" },
]

const LAYOUTS: Array<{ value: ShishaDisplayLayout; title: string; description: string }> = [
  {
    value: "board",
    title: "Board",
    description: "Every device as a card with its own coal ring. Best when you want the whole floor on screen at once.",
  },
  {
    value: "lounge",
    title: "Lounge",
    description:
      "The session closest to finishing gets a big glowing ring, with every device in a live burn-down list beside it. Uses your brand colours.",
  },
  {
    value: "rotate",
    title: "Rotate",
    description: "The screen alternates between Board and Lounge, so people see both. You choose how long each stays up.",
  },
]

const THEMES: Array<{ value: ShishaDisplayTheme; title: string; description: string; swatch: string }> = [
  { value: "dark", title: "Dark", description: "Near-black with light text. Easy on the eyes in a dim lounge.", swatch: "#15110D" },
  { value: "light", title: "Light", description: "Off-white with dark text. Suits bright spaces.", swatch: "#FAF8F5" },
  { value: "custom", title: "Custom colour", description: "Pick your own background. Text colour adjusts itself.", swatch: "" },
]

const SORTS: Array<{ value: ShishaDisplaySort; title: string; description: string }> = [
  { value: "code", title: "By device code", description: "Every device stays in the same spot. Best when the screen mirrors your floor." },
  { value: "urgency", title: "Most urgent first", description: "Overdue and refill-due devices move to the top." },
]

const FIELD =
  "w-full rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] outline-none focus:border-[#7A2E2E] disabled:bg-[#F3EEE2]"
const BTN =
  "rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2] disabled:cursor-not-allowed disabled:opacity-50"
const BTN_PRIMARY =
  "rounded-md bg-[#7A2E3A] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#651F2A] disabled:cursor-not-allowed disabled:opacity-50"

// ---- small building blocks --------------------------------------------------

function Switch({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#1C1A17]">{title}</p>
        {description && <p className="mt-0.5 text-xs text-[#8A8375]">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          checked ? "bg-[#7A2E3A]" : "bg-[#D9D3C3]"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-[#1C1A17]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[#8A8375]">{hint}</span>}
    </label>
  )
}

function OptionCard({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected ? "border-[#7A2E3A] bg-[#7A2E3A]/5 ring-1 ring-[#7A2E3A]" : "border-[#D9D3C3] bg-white hover:bg-[#F3EEE2]"
      }`}
    >
      {children}
    </button>
  )
}

const Group = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="space-y-3">
    <div>
      <h3 className="text-sm font-semibold text-[#1C1A17]">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-[#8A8375]">{hint}</p>}
    </div>
    {children}
  </section>
)

// ---- the drawer -------------------------------------------------------------

export function ShishaDisplayDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mount first, then slide in a frame later, so the transition actually plays.
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [baseline, setBaseline] = useState<ShishaDisplaySettings | null>(null)
  const [draft, setDraft] = useState<ShishaDisplaySettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [tab, setTab] = useState<Tab>("look")
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), 220)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => setOrigin(window.location.origin), [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await loadShishaDisplaySettings()
      if (res.ok) {
        const settings = normalizeShishaDisplaySettings(res.settings)
        setLoaded({ tenantSlug: res.tenantSlug, canCustomizeBranding: res.canCustomizeBranding })
        setBaseline(settings)
        setDraft(settings)
      } else {
        setLoadError(res.error)
      }
    } catch {
      setLoadError("Couldn't reach the server.")
    } finally {
      setLoading(false)
    }
  }, [])

  // Load each time the panel opens (settings may have changed in another tab).
  useEffect(() => {
    if (!open) return
    setMessage(null)
    setTab("look")
    void load()
  }, [open, load])

  const dirty = useMemo(
    () => (draft && baseline ? JSON.stringify(normalizeShishaDisplaySettings(draft)) !== JSON.stringify(baseline) : false),
    [draft, baseline],
  )

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty && !window.confirm("Discard your unsaved changes?")) return
    onClose()
  }, [dirty, saving, onClose])

  // Escape closes; the page behind doesn't scroll while the panel is up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose()
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    panelRef.current?.focus()
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, requestClose])

  function set<K extends keyof ShishaDisplaySettings>(key: K, value: ShishaDisplaySettings[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    setMessage(null)
  }

  function setLabel(key: keyof ShishaDisplaySettings["labels"], value: string) {
    setDraft((d) => (d ? { ...d, labels: { ...d.labels, [key]: value } } : d))
    setMessage(null)
  }

  const customColourInvalid = draft?.theme === "custom" && !isHex6(draft.backgroundColor)
  const alertSecondsInvalid =
    draft !== null &&
    draft.timeUpAlertEnabled &&
    !(Number.isInteger(draft.timeUpAlertSeconds) && draft.timeUpAlertSeconds >= 3 && draft.timeUpAlertSeconds <= 60)
  const validSeconds = (n: number) => Number.isInteger(n) && n >= 5 && n <= 300
  const rotateInvalid = draft?.layout === "rotate" && !(validSeconds(draft.rotateBoardSeconds) && validSeconds(draft.rotateLoungeSeconds))
  const canSave = dirty && !saving && !customColourInvalid && !alertSecondsInvalid && !rotateInvalid

  async function save() {
    if (!draft || !canSave) return
    setSaving(true)
    setMessage(null)
    const value = normalizeShishaDisplaySettings(draft)
    try {
      const res = await updateShishaDisplaySettings(value)
      if (res.ok) {
        setBaseline(value)
        setDraft(value)
        setMessage({ kind: "success", text: "Saved. The TV picks it up within about 10 seconds." })
      } else {
        setMessage({ kind: "error", text: res.error })
      }
    } catch {
      setMessage({ kind: "error", text: "Something went wrong reaching the server. Please try again." })
    } finally {
      setSaving(false)
    }
  }

  const displayUrl = origin && loaded ? `${origin}/display/${loaded.tenantSlug}/shisha` : null

  async function copyUrl() {
    if (!displayUrl) return
    try {
      await navigator.clipboard.writeText(displayUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable on insecure origins; the URL is selectable in the field.
    }
  }

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        onClick={requestClose}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shisha-display-title"
        className={`absolute right-0 top-0 flex h-full w-full max-w-[460px] flex-col bg-[#FBF9F3] shadow-2xl outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#E6E1D4] px-5 py-4">
          <div>
            <h2 id="shisha-display-title" className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
              TV display
            </h2>
            <p className="mt-0.5 text-sm text-[#8A8375]">The status board for a screen in your lounge.</p>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" className="rounded-md px-2 py-1 text-lg leading-none text-[#8A8375] hover:bg-[#F3EEE2]">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {!draft ? (
            loadError ? (
              <div className="space-y-3 rounded-lg border border-[#E6E1D4] bg-white px-4 py-6 text-center">
                <p className="text-sm text-[#7A2E2E]">{loadError}</p>
                <button type="button" onClick={() => void load()} className={BTN}>
                  Try again
                </button>
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-[#8A8375]">{loading ? "Loading settings…" : ""}</p>
            )
          ) : (
            <>
              <div className="rounded-lg border border-[#E6E1D4] bg-white px-4">
                <Switch
                  title="Screen switched on"
                  description={
                    draft.isEnabled
                      ? "The TV address below shows your live board."
                      : "The TV address shows a “switched off” message. Everything else here still saves."
                  }
                  checked={draft.isEnabled}
                  disabled={saving}
                  onChange={(v) => set("isEnabled", v)}
                />
              </div>

              {/* Address + QR */}
              <div className="space-y-2 rounded-lg border border-[#E6E1D4] bg-white p-4">
                <p className="text-sm font-medium text-[#1C1A17]">Screen address</p>
                <p className="text-xs text-[#8A8375]">Open this in the TV's browser and leave the tab open. No login needed.</p>
                <div className="flex gap-2">
                  <input className={FIELD} readOnly value={displayUrl ?? "Loading…"} onFocus={(e) => e.target.select()} />
                  <button type="button" className={BTN} onClick={() => void copyUrl()} disabled={!displayUrl}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  {displayUrl && (
                    <a href={displayUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-[#7A2E3A] hover:underline">
                      Open the screen
                    </a>
                  )}
                  {displayUrl && (
                    // Third-party QR generator: the URL isn't sensitive (same as the queue display).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(displayUrl)}`}
                      alt="QR code linking to the shisha display"
                      width={96}
                      height={96}
                      className="rounded border border-[#E6E1D4]"
                    />
                  )}
                </div>
              </div>

              {/* Tabs */}
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Display settings">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={tab === t.id ? BTN_PRIMARY : BTN}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === "look" && (
                <div className="space-y-6">
                  <Group title="Layout" hint="Every layout uses the settings below and the same alerts.">
                    <div className="space-y-2">
                      {LAYOUTS.map((o) => (
                        <OptionCard key={o.value} selected={draft.layout === o.value} disabled={saving} onClick={() => set("layout", o.value)}>
                          <span className="text-sm font-semibold text-[#1C1A17]">{o.title}</span>
                          <span className="text-xs text-[#8A8375]">{o.description}</span>
                        </OptionCard>
                      ))}
                    </div>
                  </Group>

                  {draft.layout === "rotate" && (
                    <Group title="Rotation timing" hint="How long each screen stays up before fading to the other. Between 5 and 300 seconds.">
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Board (seconds)" hint={rotateInvalid ? "Whole number, 5 to 300." : undefined}>
                          <input
                            type="number"
                            min={5}
                            max={300}
                            className={FIELD}
                            value={Number.isNaN(draft.rotateBoardSeconds) ? "" : draft.rotateBoardSeconds}
                            onChange={(e) => set("rotateBoardSeconds", e.target.value === "" ? Number.NaN : Number(e.target.value))}
                          />
                        </Field>
                        <Field label="Lounge (seconds)">
                          <input
                            type="number"
                            min={5}
                            max={300}
                            className={FIELD}
                            value={Number.isNaN(draft.rotateLoungeSeconds) ? "" : draft.rotateLoungeSeconds}
                            onChange={(e) => set("rotateLoungeSeconds", e.target.value === "" ? Number.NaN : Number(e.target.value))}
                          />
                        </Field>
                      </div>
                    </Group>
                  )}

                  <Group title="Colour theme" hint="Text colour is chosen for you so it stays readable on any background.">
                    <div className="space-y-2">
                      {THEMES.map((o) => {
                        const locked = o.value === "custom" && !loaded?.canCustomizeBranding
                        const swatch = o.value === "custom" ? (isHex6(draft.backgroundColor) ? draft.backgroundColor : "#15110D") : o.swatch
                        return (
                          <OptionCard
                            key={o.value}
                            selected={draft.theme === o.value}
                            disabled={saving || locked}
                            onClick={() => set("theme", o.value)}
                          >
                            <span className="flex items-center gap-2 text-sm font-semibold text-[#1C1A17]">
                              <span className="h-4 w-4 rounded-full border border-[#D9D3C3]" style={{ background: swatch }} />
                              {o.title}
                            </span>
                            <span className="text-xs text-[#8A8375]">
                              {locked ? "Custom background colours are a Business plan feature." : o.description}
                            </span>
                          </OptionCard>
                        )
                      })}
                    </div>
                    {draft.theme === "custom" && loaded?.canCustomizeBranding && (
                      <Field
                        label="Background colour"
                        hint={customColourInvalid ? "Use a 6-digit colour like #15110D." : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            aria-label="Pick background colour"
                            value={isHex6(draft.backgroundColor) ? draft.backgroundColor : "#15110D"}
                            onChange={(e) => set("backgroundColor", e.target.value.toUpperCase())}
                            className="h-9 w-12 cursor-pointer rounded border border-[#D9D3C3] bg-white p-0.5"
                          />
                          <input
                            className={FIELD}
                            value={draft.backgroundColor ?? ""}
                            onChange={(e) => set("backgroundColor", e.target.value)}
                            placeholder="#15110D"
                            maxLength={7}
                          />
                        </div>
                      </Field>
                    )}
                  </Group>

                  <Group title="Heading">
                    <Field label="Line under your business name" hint={`Defaults to “${DISPLAY_TITLE_DEFAULT}”.`}>
                      <input
                        className={FIELD}
                        value={draft.title ?? ""}
                        onChange={(e) => set("title", e.target.value)}
                        placeholder={DISPLAY_TITLE_DEFAULT}
                        maxLength={DISPLAY_TITLE_MAX}
                      />
                    </Field>
                  </Group>

                  <Group title="Order of devices" hint={draft.layout === "lounge" ? "Applies to the list. The big device is always the one finishing soonest." : undefined}>
                    <div className="space-y-2">
                      {SORTS.map((o) => (
                        <OptionCard key={o.value} selected={draft.sort === o.value} disabled={saving} onClick={() => set("sort", o.value)}>
                          <span className="text-sm font-semibold text-[#1C1A17]">{o.title}</span>
                          <span className="text-xs text-[#8A8375]">{o.description}</span>
                        </OptionCard>
                      ))}
                    </div>
                  </Group>
                </div>
              )}

              {tab === "show" && (
                <div className="space-y-6">
                  <Group title="On each device card" hint="This is a public screen, so only turn on what you're happy for the whole lounge to read.">
                    <div className="divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4] bg-white px-4">
                      <Switch title="Flavour" description="The flavour being smoked." checked={draft.showFlavour} disabled={saving} onChange={(v) => set("showFlavour", v)} />
                      <Switch title="Station" description="The area the device is in, e.g. Terrace." checked={draft.showStation} disabled={saving} onChange={(v) => set("showStation", v)} />
                      <Switch
                        title="Customer first name"
                        description="First name only, and only for sessions linked to a customer. Off by default."
                        checked={draft.showCustomerName}
                        disabled={saving}
                        onChange={(v) => set("showCustomerName", v)}
                      />
                    </div>
                  </Group>

                  <Group title="On the screen">
                    <div className="divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4] bg-white px-4">
                      <Switch title="Summary strip" description="Counts of running, refill-due, overdue, paused and free devices." checked={draft.showStats} disabled={saving} onChange={(v) => set("showStats", v)} />
                      <Switch title="Free devices" description="Turn off to show only devices in use." checked={draft.showFreeDevices} disabled={saving} onChange={(v) => set("showFreeDevices", v)} />
                      <Switch title="Clock" checked={draft.showClock} disabled={saving} onChange={(v) => set("showClock", v)} />
                      <Switch title="Scrolling ticker" description="A message along the bottom of the screen." checked={draft.showTicker} disabled={saving} onChange={(v) => set("showTicker", v)} />
                    </div>
                    {draft.showTicker && (
                      <div className="space-y-3">
                        <Field label="Ticker message" hint={`Defaults to “${DISPLAY_TICKER_DEFAULT}”.`}>
                          <input
                            className={FIELD}
                            value={draft.tickerText ?? ""}
                            onChange={(e) => set("tickerText", e.target.value)}
                            placeholder={DISPLAY_TICKER_DEFAULT}
                            maxLength={DISPLAY_TICKER_MAX}
                          />
                        </Field>
                        <div className="rounded-lg border border-[#E6E1D4] bg-white px-4">
                          <Switch
                            title="Flavours and prices in the ticker"
                            description="Your available flavours scroll after the message. Out-of-stock flavours are left out."
                            checked={draft.showMenu}
                            disabled={saving}
                            onChange={(v) => set("showMenu", v)}
                          />
                        </div>
                      </div>
                    )}
                  </Group>
                </div>
              )}

              {tab === "wording" && (
                <Group title="Local terms" hint="Every piece of text on the TV is yours to change. Leave a field empty to use the default shown in it.">
                  <div className="space-y-3">
                    {SHISHA_DISPLAY_LABELS.map((l) => (
                      <Field key={l.key} label={l.title} hint={l.hint}>
                        <input
                          className={FIELD}
                          value={draft.labels[l.key] ?? ""}
                          onChange={(e) => setLabel(l.key, e.target.value)}
                          placeholder={l.fallback}
                          maxLength={DISPLAY_LABEL_MAX}
                        />
                      </Field>
                    ))}
                  </div>
                </Group>
              )}

              {tab === "alerts" && (
                <Group
                  title="Time-up alert"
                  hint="When a session runs out, the TV takes over the whole screen with that device's code, then goes back to the board."
                >
                  <div className="rounded-lg border border-[#E6E1D4] bg-white px-4">
                    <Switch
                      title="Full-screen alert"
                      description="If several sessions run out close together, they show one after another."
                      checked={draft.timeUpAlertEnabled}
                      disabled={saving}
                      onChange={(v) => set("timeUpAlertEnabled", v)}
                    />
                  </div>
                  {draft.timeUpAlertEnabled && (
                    <Field
                      label="Alert duration (seconds)"
                      hint={alertSecondsInvalid ? "Use a whole number between 3 and 60." : "How long each alert stays up. Between 3 and 60."}
                    >
                      <input
                        type="number"
                        min={3}
                        max={60}
                        className={FIELD}
                        value={Number.isNaN(draft.timeUpAlertSeconds) ? "" : draft.timeUpAlertSeconds}
                        onChange={(e) => set("timeUpAlertSeconds", e.target.value === "" ? Number.NaN : Number(e.target.value))}
                      />
                    </Field>
                  )}
                </Group>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {draft && (
          <div className="space-y-2 border-t border-[#E6E1D4] bg-white px-5 py-3">
            {message && (
              <p
                role={message.kind === "error" ? "alert" : "status"}
                className={`text-sm ${message.kind === "error" ? "text-[#7A2E2E]" : "text-[#4B6B54]"}`}
              >
                {message.text}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-[#8A8375]">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={BTN}
                  disabled={!dirty || saving}
                  onClick={() => {
                    setDraft(baseline)
                    setMessage(null)
                  }}
                >
                  Discard
                </button>
                <button type="button" className={BTN_PRIMARY} disabled={!canSave} onClick={() => void save()}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
