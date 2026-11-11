"use client"

// app/admin/events/EventFormDialog.tsx
//
// Create / edit an event. Same fields as the Rands "Create New Event" modal
// (name, start, end, location, banner, ticket tiers), except tiers are a list
// you can add to and remove from instead of three fixed ones; Early bird,
// General admission and VIP are one-tap presets that fill a row.

import { useEffect, useMemo, useState } from "react"
import { saveEvent, uploadEventBanner } from "./actions"
import { isoToLocalInput, localInputToIso } from "./format"
import type { EventSummary } from "./types"
import { BTN_GHOST, BTN_PRIMARY, FOCUS, INPUT, LABEL, Icon, Modal, WELL } from "./ui"

interface TierRow {
  key: string
  id?: string
  name: string
  price: string
  capacity: string
  entries: string
  active: boolean
  sold: number
}

const PRESETS = [
  { name: "Early bird", icon: "clock" },
  { name: "General admission", icon: "users" },
  { name: "VIP", icon: "crown" },
] as const

let rowCounter = 0
const newRow = (over: Partial<TierRow> = {}): TierRow => ({
  key: `row-${(rowCounter += 1)}`,
  name: "",
  price: "",
  capacity: "",
  entries: "1",
  active: true,
  sold: 0,
  ...over,
})

export function EventFormDialog({
  event,
  timezone,
  onClose,
  onSaved,
}: {
  event: EventSummary | null
  timezone: string
  onClose: () => void
  onSaved: (eventId: string, message: string) => void
}) {
  const editing = event !== null
  const locked = editing && (event.status === "cancelled" || event.status === "ended")

  const [name, setName] = useState(event?.name ?? "")
  const [description, setDescription] = useState(event?.description ?? "")
  const [location, setLocation] = useState(event?.location ?? "")
  const [start, setStart] = useState(isoToLocalInput(event?.startTime ?? null, timezone))
  const [end, setEnd] = useState(isoToLocalInput(event?.endTime ?? null, timezone))
  const [onSale, setOnSale] = useState(event ? event.status === "active" : false)
  const [tiers, setTiers] = useState<TierRow[]>(() =>
    event && event.ticketTypes.length > 0
      ? event.ticketTypes.map((t) =>
          newRow({
            id: t.id,
            name: t.name,
            price: String(t.price),
            capacity: String(t.capacity),
            entries: String(t.entriesAllowed),
            active: t.isActive,
            sold: t.sold,
          }),
        )
      : [newRow()],
  )
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  function patchTier(key: string, patch: Partial<TierRow>) {
    setTiers((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function addPreset(presetName: string) {
    setTiers((rows) => {
      if (rows.some((r) => r.name.trim().toLowerCase() === presetName.toLowerCase())) return rows
      const blank = rows.find((r) => !r.id && !r.name && !r.price && !r.capacity)
      if (blank) return rows.map((r) => (r === blank ? { ...r, name: presetName } : r))
      return [...rows, newRow({ name: presetName })]
    })
  }

  async function submit() {
    setError(null)
    const startIso = localInputToIso(start, timezone)
    if (!startIso) return setError("Choose a start date and time.")
    const endIso = end ? localInputToIso(end, timezone) : null
    if (end && !endIso) return setError("The end time isn't a valid date.")

    const ticketTypes = tiers.map((t) => ({
      id: t.id,
      name: t.name,
      price: t.price.trim() === "" ? 0 : Number(t.price),
      capacity: t.capacity.trim() === "" ? 0 : Number(t.capacity),
      entriesAllowed: t.entries.trim() === "" ? 1 : Number(t.entries),
      isActive: t.active,
    }))

    setBusy(true)
    const res = await saveEvent({
      id: event?.id,
      name,
      description,
      location,
      startTime: startIso,
      endTime: endIso,
      status: onSale ? "active" : "draft",
      ticketTypes,
    })
    if (!res.ok) {
      setBusy(false)
      return setError(res.error)
    }

    let message = editing ? "Event updated." : "Event created."
    if (file) {
      const body = new FormData()
      body.set("file", file)
      const up = await uploadEventBanner(res.data.id, body)
      // The event itself is saved; a failed banner shouldn't undo that.
      if (!up.ok) message = `${message} The banner didn't upload: ${up.error}`
    }
    setBusy(false)
    onSaved(res.data.id, message)
  }

  const banner = preview ?? event?.imageUrl ?? null

  return (
    <Modal
      title={editing ? "Edit event" : "Create event"}
      size="lg"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create event"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={LABEL} htmlFor="ev-name">Event name</label>
          <input id="ev-name" className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="ev-start">Starts</label>
            <input id="ev-start" type="datetime-local" className={INPUT} value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className={LABEL} htmlFor="ev-end">Ends (optional)</label>
            <input id="ev-end" type="datetime-local" className={INPUT} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="ev-loc">Location</label>
          <input id="ev-loc" className={INPUT} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Venue or address" />
        </div>

        <div>
          <label className={LABEL} htmlFor="ev-desc">Description (optional)</label>
          <textarea id="ev-desc" rows={2} className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <span className={LABEL}>Banner</span>
          <label className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-stone-300 px-4 py-3 text-sm text-stone-600 hover:bg-stone-500/5 ${FOCUS} focus-within:ring-2`}>
            <Icon name="cloud-arrow-up" className="text-stone-400" />
            <span className="flex-1 truncate">{file ? file.name : banner ? "Replace banner" : "Upload a banner (PNG, JPG or WebP, up to 3 MB)"}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {banner && (
            // eslint-disable-next-line @next/next/no-img-element -- Storage URL or local preview, not a static asset
            <img src={banner} alt="Banner preview" className="mt-2 h-32 w-full rounded-xl border border-stone-200 object-cover" />
          )}
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-stone-800">Ticket tiers</span>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.name} type="button" onClick={() => addPreset(p.name)} className={`${BTN_GHOST} !px-3 !py-1`}>
                  <Icon name={p.icon} /> {p.name}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {tiers.map((t, i) => (
              <fieldset key={t.key} className={`${WELL} p-3`}>
                <legend className="sr-only">Tier {i + 1}</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.6fr_1fr_1fr_0.8fr]">
                  <div className="col-span-2 sm:col-span-1">
                    <label className={LABEL} htmlFor={`${t.key}-n`}>Name</label>
                    <input id={`${t.key}-n`} className={INPUT} value={t.name} onChange={(e) => patchTier(t.key, { name: e.target.value })} />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`${t.key}-p`}>Price (R)</label>
                    <input id={`${t.key}-p`} type="number" min={0} step="0.01" inputMode="decimal" className={INPUT} value={t.price} onChange={(e) => patchTier(t.key, { price: e.target.value })} />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`${t.key}-c`}>Capacity</label>
                    <input id={`${t.key}-c`} type="number" min={t.sold} step={1} inputMode="numeric" className={INPUT} value={t.capacity} onChange={(e) => patchTier(t.key, { capacity: e.target.value })} />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`${t.key}-e`} title="How many times one ticket can be scanned in">Entries</label>
                    <input id={`${t.key}-e`} type="number" min={1} step={1} inputMode="numeric" className={INPUT} value={t.entries} onChange={(e) => patchTier(t.key, { entries: e.target.value })} />
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-stone-500">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={t.active} onChange={(e) => patchTier(t.key, { active: e.target.checked })} />
                    On sale{t.sold > 0 ? ` · ${t.sold} sold` : ""}
                  </label>
                  <button
                    type="button"
                    disabled={t.sold > 0 || tiers.length === 1}
                    title={t.sold > 0 ? "This tier has sold tickets. Switch it off instead." : undefined}
                    onClick={() => setTiers((rows) => rows.filter((r) => r.key !== t.key))}
                    className={`rounded-full px-2 py-1 text-red-600 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
                  >
                    <Icon name="trash" /> Remove
                  </button>
                </div>
              </fieldset>
            ))}
          </div>
          <button type="button" onClick={() => setTiers((rows) => [...rows, newRow()])} className={`${BTN_GHOST} mt-2`}>
            <Icon name="plus" /> Add a tier
          </button>
        </div>

        {!locked && (
          <label className={`${WELL} flex cursor-pointer items-start gap-3 p-3 text-sm`}>
            <input type="checkbox" className="mt-0.5" checked={onSale} onChange={(e) => setOnSale(e.target.checked)} />
            <span>
              <span className="font-medium text-stone-800">Put on sale</span>
              <span className="block text-xs text-stone-500">
                On sale events show on the public page and can be sold at the box office. Leave it off to keep this a draft.
              </span>
            </span>
          </label>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
