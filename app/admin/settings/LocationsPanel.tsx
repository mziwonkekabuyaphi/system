// app/admin/settings/LocationsPanel.tsx
"use client"

/**
 * Settings > Locations. Owners add and manage their own branches here, so nobody
 * has to touch the database.
 *
 * Self-loading (like EmployerDetailsPanel / PaymentsPanel): it fetches its own data
 * with getLocationsData() on mount, so no parent has to pass anything but the shop's
 * slug. Every action in ../locations-actions returns the refreshed list, which simply
 * replaces `data` here.
 *
 * What an owner can do:
 *   - add a branch (Business plan), edit its name / address / phone / timezone
 *   - choose which staff work there (only they can take that branch's bookings)
 *   - give the branch its own opening hours, or let it follow the shop's hours
 *   - copy that branch's kiosk and TV links (?loc=<slug>)
 *   - make a branch the default, archive it, or restore an archived one
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  archiveLocation,
  createLocation,
  getLocationsData,
  restoreLocation,
  saveLocationHours,
  setDefaultLocation,
  setLocationStaff,
  updateLocation,
  type LocationsData,
  type LocationsResult,
} from "../locations-actions"
import type { AdminBusinessHours, AdminLocation, AdminLocationStaff } from "../types"
import { FieldRow, SettingsCard, Toggle, inputClass, primaryButtonClass, secondaryButtonClass } from "./ui"

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

type Notice = { ok: boolean; text: string } | null
type Section = "details" | "staff" | "hours" | "links"

/** Seven rows, Sunday to Saturday, starting from `source` (a branch's own hours, else the shop's). */
function fullWeek(source: AdminBusinessHours | null | undefined): AdminBusinessHours {
  return DAY_LABELS.map((_, dayOfWeek) => {
    const found = source?.find((d) => d.dayOfWeek === dayOfWeek)
    return found
      ? { ...found }
      : { dayOfWeek, isClosed: false, openTime: "09:00", closeTime: "17:00" }
  })
}

function sameHours(a: AdminBusinessHours, b: AdminBusinessHours): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function LocationsPanel({ tenantSlug }: { tenantSlug: string }) {
  const [data, setData] = useState<LocationsData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    const result = await getLocationsData()
    if (result.success) setData(result.data)
    else setLoadError(result.error)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Runs one action, shows its outcome, and swaps in the refreshed list. Returns whether it worked. */
  const run = useCallback(async (key: string, action: () => Promise<LocationsResult>, successText: string): Promise<boolean> => {
    setBusy(key)
    setNotice(null)
    try {
      const result = await action()
      if (result.success) {
        setData(result.data)
        setNotice({ ok: true, text: successText })
        return true
      }
      setNotice({ ok: false, text: result.error })
      return false
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Something went wrong." })
      return false
    } finally {
      setBusy(null)
    }
  }, [])

  const live = useMemo(() => (data?.locations ?? []).filter((l) => !l.archived), [data])
  const archived = useMemo(() => (data?.locations ?? []).filter((l) => l.archived), [data])

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        Couldn&rsquo;t load your locations: {loadError}{" "}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  }
  if (!data) return <p className="text-sm text-ink-muted">Loading locations…</p>

  const canAdd = data.allowed

  return (
    <div className="space-y-4">
      {notice && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-2.5 text-sm ${
            notice.ok ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {notice.text}
        </div>
      )}

      <SettingsCard
        title="Your locations"
        description="Each location has its own queue, bookings, staff and opening hours. Customers pick a branch by using that branch's kiosk or TV link."
      >
        {!canAdd && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-medium">Multiple locations are part of the Business plan.</p>
            <p className="mt-0.5">
              Your shop runs on one location for now. Upgrade to add more branches, each with its own queue and bookings.
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {live.map((location) => (
            <li key={location.id}>
              <LocationCard
                location={location}
                staff={data.staff}
                shopHours={data.shopHours}
                tenantSlug={tenantSlug}
                onlyOne={live.length === 1}
                busy={busy}
                run={run}
              />
            </li>
          ))}
        </ul>

        {canAdd && !adding && (
          <div>
            <button type="button" className={primaryButtonClass} onClick={() => setAdding(true)}>
              + Add a location
            </button>
          </div>
        )}
        {canAdd && adding && (
          <AddLocationForm
            staff={data.staff}
            busy={busy === "create"}
            onCancel={() => setAdding(false)}
            onCreate={async (input) => {
              const done = await run("create", () => createLocation(input), `Added ${input.name.trim()}.`)
              if (done) setAdding(false)
            }}
          />
        )}
      </SettingsCard>

      {archived.length > 0 && (
        <SettingsCard title="Archived" description="Hidden from customers and staff. Their history is kept, and you can restore them.">
          <button type="button" className={secondaryButtonClass} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived locations" : `Show ${archived.length} archived`}
          </button>
          {showArchived && (
            <ul className="space-y-2">
              {archived.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
                  <span className="text-sm text-ink">
                    {l.name} <span className="text-ink-muted">· {l.slug}</span>
                  </span>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={busy !== null || !canAdd}
                    title={canAdd ? undefined : "Restoring needs the Business plan"}
                    onClick={() => void run(`restore-${l.id}`, () => restoreLocation(l.id), `Restored ${l.name}.`)}
                  >
                    {busy === `restore-${l.id}` ? "Restoring…" : "Restore"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------
function AddLocationForm({
  staff,
  busy,
  onCancel,
  onCreate,
}: {
  staff: AdminLocationStaff[]
  busy: boolean
  onCancel: () => void
  onCreate: (input: { name: string; address: string | null; phone: string | null; timezone: string | null; staffIds: string[] }) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [address, setAddress] = useState("")
  const [phone, setPhone] = useState("")
  const [timezone, setTimezone] = useState("")
  const [staffIds, setStaffIds] = useState<string[]>([])

  return (
    <div className="space-y-4 rounded-lg border border-line-strong bg-canvas p-4">
      <h4 className="text-sm font-semibold text-ink">New location</h4>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow label="Name" hint="For example: Sandton branch">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </FieldRow>
        <FieldRow label="Phone (optional)">
          <input className={inputClass} value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        </FieldRow>
        <div className="sm:col-span-2">
          <FieldRow label="Address (optional)">
            <textarea className={inputClass} rows={2} value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />
          </FieldRow>
        </div>
        <div className="sm:col-span-2">
          <FieldRow label="Timezone (optional)" hint="Leave empty to use the shop's timezone. Only needed if this branch is in a different timezone.">
            <input className={inputClass} value={timezone} placeholder="Africa/Johannesburg" onChange={(e) => setTimezone(e.target.value)} />
          </FieldRow>
        </div>
      </div>

      <StaffPicker staff={staff} selected={staffIds} onChange={setStaffIds} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy || name.trim() === ""}
          onClick={() =>
            void onCreate({
              name,
              address: address.trim() || null,
              phone: phone.trim() || null,
              timezone: timezone.trim() || null,
              staffIds,
            })
          }
        >
          {busy ? "Adding…" : "Add location"}
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="text-xs text-ink-muted">Until you set its own hours, this branch follows the shop&rsquo;s opening hours.</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Staff picker (shared by the add form and the Staff tab)
// ---------------------------------------------------------------------------
function StaffPicker({
  staff,
  selected,
  onChange,
}: {
  staff: AdminLocationStaff[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const active = staff.filter((s) => s.active)
  if (active.length === 0) {
    return <p className="text-sm text-ink-muted">You have no active staff yet. Add staff first, then choose who works at this branch.</p>
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">Who works here</p>
      <p className="text-xs text-ink-muted">Only these people can take appointments at this branch.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {active.map((s) => {
          const checked = selected.includes(s.id)
          return (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={checked}
                onChange={(e) => onChange(e.target.checked ? [...selected, s.id] : selected.filter((id) => id !== s.id))}
              />
              {s.name}
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One branch
// ---------------------------------------------------------------------------
function LocationCard({
  location,
  staff,
  shopHours,
  tenantSlug,
  onlyOne,
  busy,
  run,
}: {
  location: AdminLocation
  staff: AdminLocationStaff[]
  shopHours: AdminBusinessHours
  tenantSlug: string
  onlyOne: boolean
  busy: string | null
  run: (key: string, action: () => Promise<LocationsResult>, successText: string) => Promise<boolean>
}) {
  const [section, setSection] = useState<Section | null>(null)
  const id = location.id
  const noStaff = staff.some((s) => s.active) && location.staffIds.filter((sid) => staff.find((s) => s.id === sid)?.active).length === 0

  return (
    <div className="rounded-lg border border-line bg-canvas">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            {location.name}
            {location.isDefault && (
              <span className="rounded-full bg-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Default</span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-muted">
            {[location.address, location.phone].filter(Boolean).join(" · ") || "No address yet"}
          </p>
          {noStaff && <p className="mt-1 text-xs text-amber-700">No staff assigned: customers can&rsquo;t book appointments here yet.</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["details", "staff", "hours", "links"] as Section[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSection(section === s ? null : s)}
              aria-pressed={section === s}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                section === s ? "border-selected bg-selected text-on-color" : "border-line-strong bg-card text-ink hover:bg-tint"
              }`}
            >
              {s === "details" ? "Details" : s === "staff" ? "Staff" : s === "hours" ? "Opening hours" : "Links"}
            </button>
          ))}
        </div>
      </div>

      {section && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          {section === "details" && <DetailsSection location={location} busy={busy} run={run} />}
          {section === "staff" && <StaffSection location={location} staff={staff} busy={busy} run={run} />}
          {section === "hours" && <HoursSection location={location} shopHours={shopHours} busy={busy} run={run} />}
          {section === "links" && <LinksSection location={location} tenantSlug={tenantSlug} onlyOne={onlyOne} />}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {!location.isDefault && (
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy !== null}
                onClick={() => void run(`default-${id}`, () => setDefaultLocation(id), `${location.name} is now the default location.`)}
              >
                {busy === `default-${id}` ? "Saving…" : "Make default"}
              </button>
            )}
            {!location.isDefault && (
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`Archive ${location.name}? It will be hidden from customers and staff. Its history is kept and you can restore it later.`)) {
                    void run(`archive-${id}`, () => archiveLocation(id), `Archived ${location.name}.`)
                  }
                }}
              >
                {busy === `archive-${id}` ? "Archiving…" : "Archive"}
              </button>
            )}
            {location.isDefault && (
              <span className="text-xs text-ink-muted">
                The default location is used when a customer doesn&rsquo;t pick a branch. To archive it, make another location the default first.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

type CardProps = {
  location: AdminLocation
  busy: string | null
  run: (key: string, action: () => Promise<LocationsResult>, successText: string) => Promise<boolean>
}

function DetailsSection({ location, busy, run }: CardProps) {
  const [name, setName] = useState(location.name)
  const [address, setAddress] = useState(location.address ?? "")
  const [phone, setPhone] = useState(location.phone ?? "")
  const [timezone, setTimezone] = useState(location.timezone ?? "")
  const dirty =
    name !== location.name ||
    address !== (location.address ?? "") ||
    phone !== (location.phone ?? "") ||
    timezone !== (location.timezone ?? "")
  const key = `details-${location.id}`

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow label="Name">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </FieldRow>
        <FieldRow label="Phone">
          <input className={inputClass} value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        </FieldRow>
        <div className="sm:col-span-2">
          <FieldRow label="Address">
            <textarea className={inputClass} rows={2} value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />
          </FieldRow>
        </div>
        <div className="sm:col-span-2">
          <FieldRow label="Timezone" hint="Leave empty to use the shop's timezone.">
            <input className={inputClass} value={timezone} placeholder="Africa/Johannesburg" onChange={(e) => setTimezone(e.target.value)} />
          </FieldRow>
        </div>
      </div>
      <p className="text-xs text-ink-muted">
        Web address name: <code className="rounded bg-tint px-1">{location.slug}</code> (fixed, so printed links and QR codes keep working).
      </p>
      <button
        type="button"
        className={primaryButtonClass}
        disabled={!dirty || busy !== null || name.trim() === ""}
        onClick={() =>
          void run(
            key,
            () => updateLocation(location.id, { name, address: address.trim() || null, phone: phone.trim() || null, timezone: timezone.trim() || null }),
            "Saved.",
          )
        }
      >
        {busy === key ? "Saving…" : "Save changes"}
      </button>
    </div>
  )
}

function StaffSection({ location, staff, busy, run }: CardProps & { staff: AdminLocationStaff[] }) {
  const [selected, setSelected] = useState<string[]>(location.staffIds)
  const key = `staff-${location.id}`
  const dirty = useMemo(() => {
    const a = [...selected].sort().join(",")
    const b = [...location.staffIds].sort().join(",")
    return a !== b
  }, [selected, location.staffIds])

  return (
    <div className="space-y-4">
      <StaffPicker staff={staff} selected={selected} onChange={setSelected} />
      {staff.some((s) => s.active) && (
        <button
          type="button"
          className={primaryButtonClass}
          disabled={!dirty || busy !== null}
          onClick={() => void run(key, () => setLocationStaff(location.id, selected), "Saved.")}
        >
          {busy === key ? "Saving…" : "Save staff"}
        </button>
      )}
    </div>
  )
}

function HoursSection({ location, shopHours, busy, run }: CardProps & { shopHours: AdminBusinessHours }) {
  const hasOwn = location.hours !== null
  const [useOwn, setUseOwn] = useState(hasOwn)
  const [days, setDays] = useState<AdminBusinessHours>(() => fullWeek(location.hours ?? shopHours))
  const key = `hours-${location.id}`

  const dirty = useOwn !== hasOwn || (useOwn && !sameHours(days, fullWeek(location.hours ?? shopHours)))

  function update(dayOfWeek: number, patch: Partial<AdminBusinessHours[number]>) {
    setDays((prev) => prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-card p-3">
        <div>
          <p className="text-sm font-medium text-ink">This branch has its own opening hours</p>
          <p className="text-xs text-ink-muted">
            {useOwn ? "Walk-ins and bookings here follow the hours below." : "Off: this branch follows the shop's opening hours (Shop details)."}
          </p>
        </div>
        <Toggle checked={useOwn} onChange={setUseOwn} label="Own opening hours" />
      </div>

      {useOwn && (
        <div className="space-y-2">
          {days.map((day) => (
            <div key={day.dayOfWeek} className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-line bg-card px-3 py-2">
              <span className="w-24 shrink-0 text-sm font-medium text-ink">{DAY_LABELS[day.dayOfWeek]}</span>
              <label className="flex w-[4.5rem] cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={day.isClosed}
                  onChange={(e) =>
                    update(day.dayOfWeek, {
                      isClosed: e.target.checked,
                      openTime: e.target.checked ? null : (day.openTime ?? "09:00"),
                      closeTime: e.target.checked ? null : (day.closeTime ?? "17:00"),
                    })
                  }
                />
                Closed
              </label>
              {!day.isClosed && (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    className={`${inputClass} !w-[7.25rem] !px-2`}
                    value={day.openTime ?? ""}
                    onChange={(e) => update(day.dayOfWeek, { openTime: e.target.value })}
                  />
                  <span className="text-sm text-ink-muted">to</span>
                  <input
                    type="time"
                    className={`${inputClass} !w-[7.25rem] !px-2`}
                    value={day.closeTime ?? ""}
                    onChange={(e) => update(day.dayOfWeek, { closeTime: e.target.value })}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className={primaryButtonClass}
        disabled={!dirty || busy !== null}
        onClick={() => void run(key, () => saveLocationHours(location.id, useOwn ? days : null), "Saved.")}
      >
        {busy === key ? "Saving…" : "Save opening hours"}
      </button>
    </div>
  )
}

function LinksSection({ location, tenantSlug, onlyOne }: { location: AdminLocation; tenantSlug: string; onlyOne: boolean }) {
  const [origin, setOrigin] = useState("")
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => setOrigin(window.location.origin), [])

  const links = [
    { label: "Kiosk", url: `${origin}/kiosk/${tenantSlug}?loc=${location.slug}` },
    { label: "Waiting-area TV", url: `${origin}/display/${tenantSlug}?loc=${location.slug}` },
  ]

  async function copy(url: string, label: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(label)
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000)
    } catch {
      window.prompt("Copy this link:", url)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        Open these on this branch&rsquo;s own kiosk and TV. They show only {location.name}&rsquo;s queue and bookings.
        {onlyOne ? " With one location, the plain kiosk and TV links keep working too." : ""}
      </p>
      {links.map((l) => (
        <div key={l.label} className="flex flex-wrap items-center gap-2">
          <span className="w-32 shrink-0 text-sm font-medium text-ink">{l.label}</span>
          <input readOnly className={`${inputClass} min-w-0 flex-1`} value={l.url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={secondaryButtonClass} onClick={() => void copy(l.url, l.label)} disabled={!origin}>
            {copied === l.label ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
    </div>
  )
}
