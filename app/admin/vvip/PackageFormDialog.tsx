"use client"

// app/admin/vvip/PackageFormDialog.tsx
//
// Create / edit a VVIP package. Same fields as the Rands "Create VVIP Package" modal, plus a seats
// per table field and a status. The tables are a list of names (default "Table 1".."Table N").
// vvip_save_package syncs the tables to that list IN ORDER, so renaming a row keeps that table's
// identity (and its booking), and a swap of two names is safe. Saving is one call; the image is
// uploaded afterwards, and a failed upload never undoes a saved package.

import { useEffect, useMemo, useState } from "react"
import { formatEventDate } from "../events/format"
import { BTN_GHOST, BTN_PRIMARY, FOCUS, INPUT, LABEL, Icon, Modal, WELL } from "../events/ui"
import { savePackage, uploadPackageImage } from "./actions"
import type { PackageStatus, VvipEventOption, VvipPackage } from "./types"

const MAX_TABLES = 200

/** The first "Table N" that no other row already uses, so growing the list never creates a duplicate name. */
function nextLabel(taken: string[]): string {
  const used = new Set(taken.map((l) => l.trim().toLowerCase()))
  for (let n = taken.length + 1; n < taken.length + MAX_TABLES + 2; n += 1) {
    if (!used.has(`table ${n}`)) return `Table ${n}`
  }
  return `Table ${taken.length + 1}`
}

export function PackageFormDialog({
  pkg,
  events,
  timezone,
  onClose,
  onSaved,
}: {
  pkg: VvipPackage | null
  events: VvipEventOption[]
  timezone: string
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const editing = pkg !== null

  // Events a package can be attached to: this shop's draft/active ones, plus the one it already has.
  const eventOptions = useMemo(
    () => events.filter((e) => e.status === "draft" || e.status === "active" || e.id === pkg?.eventId),
    [events, pkg?.eventId],
  )

  // Tables with a live booking can be renamed but not removed: the list can't shrink past the last one.
  const minTables = useMemo(() => {
    if (!pkg) return 1
    let last = -1
    pkg.tables.forEach((t, i) => { if (t.booked) last = i })
    return Math.max(1, last + 1)
  }, [pkg])

  const [name, setName] = useState(pkg?.name ?? "")
  const [eventId, setEventId] = useState(pkg?.eventId ?? "")
  const [description, setDescription] = useState(pkg?.description ?? "")
  const [price, setPrice] = useState(pkg ? String(pkg.price) : "")
  const [tabCredit, setTabCredit] = useState(pkg ? String(pkg.tabCredit) : "0")
  const [seats, setSeats] = useState(pkg ? String(pkg.seatsPerTable) : "4")
  const [status, setStatus] = useState<PackageStatus>(pkg?.status ?? "active")
  const [countText, setCountText] = useState(pkg ? String(pkg.tables.length || 1) : "1")
  const [labels, setLabels] = useState<string[]>(() => (pkg && pkg.tables.length > 0 ? pkg.tables.map((t) => t.label) : ["Table 1"]))
  const [benefits, setBenefits] = useState<string[]>(pkg?.benefits ?? [])
  const [benefitDraft, setBenefitDraft] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  const image = preview ?? pkg?.imageUrl ?? null

  function changeCount(value: string) {
    setCountText(value)
    const n = Number.parseInt(value, 10)
    if (!Number.isInteger(n) || n < 1 || n > MAX_TABLES) return
    setLabels((rows) => {
      if (n === rows.length) return rows
      if (n < rows.length) return rows.slice(0, n)
      const next = [...rows]
      while (next.length < n) next.push(nextLabel(next))
      return next
    })
  }

  function addBenefit() {
    const value = benefitDraft.trim()
    if (!value) return
    if (benefits.length >= 20) return setError("A package can list up to 20 benefits.")
    if (!benefits.some((b) => b.toLowerCase() === value.toLowerCase())) setBenefits((list) => [...list, value])
    setBenefitDraft("")
    setError(null)
  }

  async function submit() {
    setError(null)
    if (!name.trim()) return setError("Give the package a name.")
    if (!eventId) return setError("Choose the event this package is for.")
    if (price.trim() === "") return setError("Set a price. Use 0 for a free table.")
    const count = Number.parseInt(countText, 10)
    if (!Number.isInteger(count) || count < 1 || count > MAX_TABLES || count !== labels.length) {
      return setError(`Enter a number of tables from 1 to ${MAX_TABLES}.`)
    }
    if (count < minTables) return setError(`A table at position ${minTables} is booked, so this package needs at least ${minTables} tables.`)
    // A half-typed benefit shouldn't be lost silently.
    const pendingBenefit = benefitDraft.trim()
    const allBenefits = pendingBenefit && !benefits.some((b) => b.toLowerCase() === pendingBenefit.toLowerCase()) ? [...benefits, pendingBenefit] : benefits

    setBusy(true)
    const res = await savePackage({
      id: pkg?.id,
      eventId,
      name,
      description,
      price: Number(price),
      tabCredit: tabCredit.trim() === "" ? 0 : Number(tabCredit),
      seatsPerTable: Number(seats),
      benefits: allBenefits,
      status,
      tableLabels: labels,
    })
    if (!res.ok) {
      setBusy(false)
      return setError(res.error)
    }

    let message = editing ? "Package updated." : "Package created."
    if (file) {
      const body = new FormData()
      body.set("file", file)
      const up = await uploadPackageImage(res.data.id, body)
      // The package itself is saved; a failed image shouldn't undo that.
      if (!up.ok) message = `${message} The image didn't upload: ${up.error}`
    }
    setBusy(false)
    onSaved(message)
  }

  return (
    <Modal
      title={editing ? "Edit package" : "Create package"}
      size="lg"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create package"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={LABEL} htmlFor="pk-name">Package name</label>
          <input id="pk-name" className={INPUT} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Paradise VVIP experience" autoFocus />
        </div>

        <div>
          <label className={LABEL} htmlFor="pk-event">Event</label>
          <select id="pk-event" className={INPUT} value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Select an event…</option>
            {eventOptions.map((e) => (
              <option key={e.id} value={e.id}>{e.name} · {formatEventDate(e.startTime, timezone)}</option>
            ))}
          </select>
          {eventOptions.length === 0 && <p className="mt-1 text-xs text-stone-500">Create an event first. Packages belong to one event.</p>}
        </div>

        <div>
          <label className={LABEL} htmlFor="pk-desc">Description (optional)</label>
          <textarea id="pk-desc" rows={2} className={INPUT} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="What this package includes" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="pk-price">Price per table (R)</label>
            <input id="pk-price" type="number" min={0} step="0.01" inputMode="decimal" className={INPUT} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className={LABEL} htmlFor="pk-credit">Tab credit (R)</label>
            <input id="pk-credit" type="number" min={0} step="0.01" inputMode="decimal" className={INPUT} value={tabCredit} onChange={(e) => setTabCredit(e.target.value)} />
          </div>
          <div>
            <label className={LABEL} htmlFor="pk-count">Number of tables</label>
            <input
              id="pk-count"
              type="number"
              min={minTables}
              max={MAX_TABLES}
              step={1}
              inputMode="numeric"
              className={INPUT}
              value={countText}
              onChange={(e) => changeCount(e.target.value)}
            />
            {minTables > 1 && <p className="mt-1 text-xs text-stone-500">At least {minTables}: a booked table can&apos;t be removed.</p>}
          </div>
          <div>
            <label className={LABEL} htmlFor="pk-seats">Seats per table</label>
            <input id="pk-seats" type="number" min={1} max={100} step={1} inputMode="numeric" className={INPUT} value={seats} onChange={(e) => setSeats(e.target.value)} />
          </div>
        </div>

        <fieldset className={`${WELL} p-3`}>
          <legend className="px-1 text-xs font-medium text-stone-500">Table names</legend>
          <p className="mb-2 text-xs text-stone-500">Leave the numbers or rename each table. A renamed table keeps its bookings.</p>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
            {labels.map((label, i) => {
              const booked = pkg?.tables[i]?.booked === true
              return (
                <div key={i}>
                  <label className="sr-only" htmlFor={`pk-t-${i}`}>Table {i + 1} name</label>
                  <div className="relative">
                    <input
                      id={`pk-t-${i}`}
                      className={`${INPUT} ${booked ? "pr-8" : ""}`}
                      value={label}
                      maxLength={40}
                      onChange={(e) => setLabels((rows) => rows.map((r, idx) => (idx === i ? e.target.value : r)))}
                    />
                    {booked && (
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400" title="Booked">
                        <Icon name="lock" />
                        <span className="sr-only">Booked</span>
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </fieldset>

        <div>
          <label className={LABEL} htmlFor="pk-status">Status</label>
          <select id="pk-status" className={INPUT} value={status} onChange={(e) => setStatus(e.target.value as PackageStatus)}>
            <option value="active">Active (on sale)</option>
            <option value="inactive">Inactive (not on sale)</option>
            {pkg?.status === "archived" && <option value="archived">Archived</option>}
          </select>
        </div>

        <div>
          <span className={LABEL}>Image</span>
          <label className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-stone-300 px-4 py-3 text-sm text-stone-600 hover:bg-stone-500/5 ${FOCUS} focus-within:ring-2`}>
            <Icon name="cloud-arrow-up" className="text-stone-400" />
            <span className="flex-1 truncate">{file ? file.name : image ? "Replace image" : "Upload an image (PNG, JPG or WebP, up to 3 MB)"}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {image && (
            // eslint-disable-next-line @next/next/no-img-element -- Storage URL or local preview, not a static asset
            <img src={image} alt="Package image preview" className="mt-2 h-32 w-full rounded-xl border border-stone-200 object-cover" />
          )}
        </div>

        <div>
          <label className={LABEL} htmlFor="pk-benefit">Benefits</label>
          <div className="flex gap-2">
            <input
              id="pk-benefit"
              className={INPUT}
              value={benefitDraft}
              maxLength={120}
              placeholder="e.g. Private lounge, bottle service"
              onChange={(e) => setBenefitDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addBenefit()
                }
              }}
            />
            <button type="button" className={BTN_GHOST} onClick={addBenefit} disabled={!benefitDraft.trim()}>
              Add
            </button>
          </div>
          {benefits.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Benefits added">
              {benefits.map((b, i) => (
                <li key={`${b}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-stone-500/10 py-0.5 pl-3 pr-1 text-xs text-stone-700">
                  {b}
                  <button
                    type="button"
                    aria-label={`Remove ${b}`}
                    onClick={() => setBenefits((list) => list.filter((_, idx) => idx !== i))}
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-stone-500 hover:bg-stone-500/20 ${FOCUS}`}
                  >
                    <Icon name="xmark" className="text-[0.65rem]" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
