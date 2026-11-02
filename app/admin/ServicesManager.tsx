// app/admin/ServicesManager.tsx
"use client"

import { useState, useTransition, type FormEvent } from "react"
import { addService, updateService, toggleServiceActive, deleteService } from "./actions"
import { ConfirmDialog, NoticeModal, type Notice } from "./AdminModals"
import { SettingsCard, SettingsStatTile, inputClass, primaryButtonClass, secondaryButtonClass } from "./settings/ui"
import type { AdminService } from "./types"

// Small line icon for the summary tiles.
function TileIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

const SMALL_BTN =
  "rounded-md border border-line-strong bg-card px-2.5 py-1 text-xs text-ink transition-shadow hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
const SMALL_BTN_DANGER =
  "rounded-md border border-danger-line px-2.5 py-1 text-xs text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"

function ServiceRow({ service }: { service: AdminService }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(service.name)
  const [price, setPrice] = useState(String(service.price))
  const [duration, setDuration] = useState(String(service.durationMinutes))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isSaving, startSave] = useTransition()
  const [isToggling, startToggle] = useTransition()
  const [isDeleting, startDelete] = useTransition()

  function save() {
    startSave(async () => {
      const result = await updateService(service.id, {
        name,
        price: Number(price),
        durationMinutes: Number(duration),
      })
      if (result.ok) setEditing(false)
      else setNotice({ title: "Couldn't save", message: result.error })
    })
  }

  function toggleActive() {
    startToggle(async () => {
      const result = await toggleServiceActive(service.id, !service.active)
      if (!result.ok) setNotice({ title: "Couldn't update", message: result.error })
    })
  }

  function confirmDelete() {
    startDelete(async () => {
      const result = await deleteService(service.id)
      setConfirmOpen(false)
      if (!result.ok) setNotice({ title: "Couldn't delete", message: result.error })
    })
  }

  const modals = (
    <>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete this service?"
        message={
          <>
            <span className="font-medium text-ink">{service.name}</span> will be removed for good. This
            can&apos;t be undone. If you only want to hide it from customers, use Deactivate instead.
          </>
        }
        confirmLabel="Delete service"
        busyLabel="Deleting…"
        isBusy={isDeleting}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </>
  )

  if (editing) {
    return (
      <>
        <li className="flex flex-wrap items-end gap-3 bg-canvas px-4 py-3">
          <label className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-xs text-ink-muted">Service name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </label>
          <label>
            <span className="mb-1 block text-xs text-ink-muted">Price (R)</span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              aria-label="Price"
              className={`${inputClass} !w-24 text-right tabular-nums`}
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-ink-muted">Minutes</span>
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              inputMode="numeric"
              aria-label="Duration in minutes"
              className={`${inputClass} !w-20 text-right tabular-nums`}
            />
          </label>
          <div className="flex gap-2">
            <button onClick={save} disabled={isSaving} className={primaryButtonClass}>
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </li>
        {modals}
      </>
    )
  }

  return (
    <>
      <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-tint/60">
        <div className="min-w-0">
          <p className={`flex items-center gap-2 text-[1.05rem] ${service.active ? "text-ink" : "text-ink-muted"}`}>
            <span className="truncate">{service.name}</span>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                service.active
                  ? "border-success/40 bg-success-soft text-success-strong"
                  : "border-line-strong bg-tint text-ink-muted"
              }`}
            >
              {service.active ? "Active" : "Hidden"}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            R{service.price} · {service.durationMinutes} min
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => setEditing(true)} className={SMALL_BTN}>
            Edit
          </button>
          <button onClick={toggleActive} disabled={isToggling} className={SMALL_BTN}>
            {service.active ? "Deactivate" : "Activate"}
          </button>
          <button onClick={() => setConfirmOpen(true)} className={SMALL_BTN_DANGER}>
            Delete
          </button>
        </div>
      </li>
      {modals}
    </>
  )
}

export function ServicesManager({ initialServices: services }: { initialServices: AdminService[] }) {
  const [name, setName] = useState("")
  const [price, setPrice] = useState("")
  const [duration, setDuration] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isPending, startTransition] = useTransition()

  function submit(e: FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await addService({ name, price: Number(price), durationMinutes: Number(duration) })
      if (result.ok) {
        setName("")
        setPrice("")
        setDuration("")
      } else {
        setNotice({ title: "Couldn't add that service", message: result.error })
      }
    })
  }

  const activeCount = services.filter((x) => x.active).length
  const avgPrice = services.length ? Math.round(services.reduce((n, x) => n + x.price, 0) / services.length) : 0

  return (
    <div className="space-y-4">
      {/* ================= Summary ================= */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SettingsStatTile
          label="Services"
          value={services.length}
          hint="In your list"
          icon={<TileIcon><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></TileIcon>}
        />
        <SettingsStatTile
          label="Active"
          value={activeCount}
          hint="Customers can pick these"
          icon={<TileIcon><path d="m5 12.5 4.5 4.5L19 7.5" /></TileIcon>}
        />
        <SettingsStatTile
          label="Hidden"
          value={services.length - activeCount}
          hint="Deactivated, not shown"
          icon={<TileIcon><path d="M3 12s3.5-6 9-6 9 6 9 6-3.500 6-9 6-9-6-9-6z" /><path d="m4 4 16 16" /></TileIcon>}
        />
        <SettingsStatTile
          label="Average price"
          value={services.length ? `R${avgPrice}` : "—"}
          hint="Across all services"
          icon={<TileIcon><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5c-.5-.8-1.4-1.2-2.500-1.200-1.400 0-2.500.7-2.500 1.800s1 1.500 2.500 1.900 2.500.8 2.500 2-1.1 1.8-2.5 1.8c-1.1 0-2-.4-2.5-1.2M12 6.5v1.8M12 15.9v1.6" /></TileIcon>}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem] xl:items-start">
        <SettingsCard title="Your services" description="What customers can book or queue for. Deactivate a service to hide it without losing it.">
          {services.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-5 py-10 text-center text-ink-muted">
              No services yet — add your first one on the right.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-canvas">
              {services.map((s) => (
                <ServiceRow key={s.id} service={s} />
              ))}
            </ul>
          )}
        </SettingsCard>

        <SettingsCard title="Add a service" description="Name, price and how long it takes.">
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">Service name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Skin fade" className={inputClass} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Price (R)</span>
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  className={`${inputClass} tabular-nums`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Minutes</span>
                <input
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  inputMode="numeric"
                  className={`${inputClass} tabular-nums`}
                />
              </label>
            </div>
            <button type="submit" disabled={isPending} className={`${primaryButtonClass} w-full`}>
              {isPending ? "Adding…" : "Add service"}
            </button>
          </form>
        </SettingsCard>
      </div>

      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
