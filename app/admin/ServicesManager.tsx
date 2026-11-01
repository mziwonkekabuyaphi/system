// app/admin/ServicesManager.tsx
"use client"

import { useState, useTransition, type FormEvent } from "react"
import { addService, updateService, toggleServiceActive, deleteService } from "./actions"
import { ConfirmDialog, NoticeModal, type Notice } from "./AdminModals"
import type { AdminService } from "./types"

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
        <li className="flex flex-wrap items-center gap-3 py-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-[10rem] flex-1 border-b border-line-strong bg-transparent pb-1 text-[1.05rem] text-ink outline-none focus:border-accent"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            aria-label="Price"
            className="w-20 border-b border-line-strong bg-transparent pb-1 text-right tabular-nums outline-none focus:border-accent"
          />
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
            aria-label="Duration in minutes"
            className="w-16 border-b border-line-strong bg-transparent pb-1 text-right tabular-nums outline-none focus:border-accent"
          />
          <button onClick={save} disabled={isSaving} className="text-sm text-accent disabled:opacity-50">
            {isSaving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} className="text-sm text-ink-muted">
            Cancel
          </button>
        </li>
        {modals}
      </>
    )
  }

  return (
    <>
      <li className="flex items-center justify-between gap-4 py-4">
        <div>
          <p className={`text-[1.05rem] ${service.active ? "text-ink" : "text-ink-muted"}`}>{service.name}</p>
          <p className="mt-0.5 text-sm text-ink-muted">
            R{service.price} · {service.durationMinutes} min
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-sm">
          <button onClick={() => setEditing(true)} className="text-ink underline underline-offset-4">
            Edit
          </button>
          <button onClick={toggleActive} disabled={isToggling} className="text-ink-muted disabled:opacity-50">
            {service.active ? "Deactivate" : "Activate"}
          </button>
          <button onClick={() => setConfirmOpen(true)} className="text-accent">
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

  return (
    <div>
      {services.length === 0 ? (
        <p className="text-ink-muted">No services yet — add your first one below.</p>
      ) : (
        <ul className="divide-y divide-line">
          {services.map((s) => (
            <ServiceRow key={s.id} service={s} />
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-8 flex flex-wrap items-end gap-3 border-t border-line pt-6">
        <div className="min-w-[10rem] flex-1">
          <label className="block text-sm text-ink-muted">Service name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Skin fade"
            className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-sm text-ink-muted">Price (R)</label>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            className="mt-1 w-20 border-b border-line-strong bg-transparent pb-1 text-right tabular-nums text-ink outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-sm text-ink-muted">Minutes</label>
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
            className="mt-1 w-16 border-b border-line-strong bg-transparent pb-1 text-right tabular-nums text-ink outline-none focus:border-accent"
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="ml-auto bg-primary px-4 py-2 text-sm text-on-primary disabled:opacity-50"
        >
          {isPending ? "Adding…" : "Add service"}
        </button>
      </form>

      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
