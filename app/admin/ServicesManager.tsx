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
            <span className="font-medium text-[#1C1A17]">{service.name}</span> will be removed for good. This
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
            className="min-w-[10rem] flex-1 border-b border-[#D9D3C3] bg-transparent pb-1 text-[1.05rem] text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            aria-label="Price"
            className="w-20 border-b border-[#D9D3C3] bg-transparent pb-1 text-right tabular-nums outline-none focus:border-[#7A2E2E]"
          />
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
            aria-label="Duration in minutes"
            className="w-16 border-b border-[#D9D3C3] bg-transparent pb-1 text-right tabular-nums outline-none focus:border-[#7A2E2E]"
          />
          <button onClick={save} disabled={isSaving} className="text-sm text-[#7A2E2E] disabled:opacity-50">
            {isSaving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} className="text-sm text-[#8A8375]">
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
          <p className={`text-[1.05rem] ${service.active ? "text-[#1C1A17]" : "text-[#8A8375]"}`}>{service.name}</p>
          <p className="mt-0.5 text-sm text-[#8A8375]">
            R{service.price} · {service.durationMinutes} min
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-sm">
          <button onClick={() => setEditing(true)} className="text-[#1C1A17] underline underline-offset-4">
            Edit
          </button>
          <button onClick={toggleActive} disabled={isToggling} className="text-[#8A8375] disabled:opacity-50">
            {service.active ? "Deactivate" : "Activate"}
          </button>
          <button onClick={() => setConfirmOpen(true)} className="text-[#7A2E2E]">
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
        <p className="text-[#8A8375]">No services yet — add your first one below.</p>
      ) : (
        <ul className="divide-y divide-[#E6E1D4]">
          {services.map((s) => (
            <ServiceRow key={s.id} service={s} />
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-8 flex flex-wrap items-end gap-3 border-t border-[#E6E1D4] pt-6">
        <div className="min-w-[10rem] flex-1">
          <label className="block text-sm text-[#8A8375]">Service name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Skin fade"
            className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>
        <div>
          <label className="block text-sm text-[#8A8375]">Price (R)</label>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            className="mt-1 w-20 border-b border-[#D9D3C3] bg-transparent pb-1 text-right tabular-nums text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>
        <div>
          <label className="block text-sm text-[#8A8375]">Minutes</label>
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
            className="mt-1 w-16 border-b border-[#D9D3C3] bg-transparent pb-1 text-right tabular-nums text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="ml-auto bg-[#1C1A17] px-4 py-2 text-sm text-[#FAF6EE] disabled:opacity-50"
        >
          {isPending ? "Adding…" : "Add service"}
        </button>
      </form>

      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
