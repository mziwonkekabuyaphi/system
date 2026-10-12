// app/admin/ServicesManager.tsx
"use client"

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { addService, updateService, toggleServiceActive, deleteService } from "./actions"
import type { AdminService } from "./types"

// ---------------------------------------------------------------------------
// Modal — replaces the browser's window.alert / window.confirm pop-ups.
// Closes with Escape or a click on the dark backdrop (unless `locked`, which
// is used while an action is running so it can't be dismissed half-way).
// ---------------------------------------------------------------------------

function Modal({
  open,
  onClose,
  locked = false,
  children,
}: {
  open: boolean
  onClose: () => void
  locked?: boolean
  children: ReactNode
}) {
  const [visible, setVisible] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) {
      setVisible(false)
      return
    }
    // Next frame, so the fade/scale-in animation actually plays.
    const frame = requestAnimationFrame(() => setVisible(true))
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden" // stop the page scrolling behind the modal

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !locked) onCloseRef.current()
    }
    window.addEventListener("keydown", onKey)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, locked])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        onClick={locked ? undefined : onClose}
        className={`absolute inset-0 bg-[#1C1A17]/50 backdrop-blur-sm transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={`relative w-full max-w-sm rounded-2xl bg-[#FAF6EE] p-6 text-center shadow-2xl ring-1 ring-[#E6E1D4] transition-all duration-200 ${
          visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-95 opacity-0"
        }`}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </svg>
  )
}

function ConfirmDeleteModal({
  open,
  serviceName,
  isDeleting,
  onConfirm,
  onCancel,
}: {
  open: boolean
  serviceName: string
  isDeleting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal open={open} onClose={onCancel} locked={isDeleting}>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F3E3E0] text-[#7A2E2E]">
        <TrashIcon />
      </div>
      <h2 className="mt-4 text-xl text-[#1C1A17]">Delete this service?</h2>
      <p className="mt-2 text-[0.95rem] leading-relaxed text-[#8A8375]">
        <span className="font-medium text-[#1C1A17]">{serviceName}</span> will be removed for good. This can&apos;t be
        undone. If you only want to hide it from customers, use Deactivate instead.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          onClick={onCancel}
          disabled={isDeleting}
          autoFocus
          className="flex-1 rounded-lg border border-[#D9D3C3] px-4 py-2.5 text-sm text-[#1C1A17] transition-colors hover:bg-[#F1ECDF] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={isDeleting}
          className="flex-1 rounded-lg bg-[#7A2E2E] px-4 py-2.5 text-sm text-[#FAF6EE] transition-colors hover:bg-[#662525] disabled:opacity-60"
        >
          {isDeleting ? "Deleting…" : "Delete service"}
        </button>
      </div>
    </Modal>
  )
}

type Notice = { title: string; message: string }

function NoticeModal({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  // Keep the last notice around so the text doesn't vanish mid-animation.
  return (
    <Modal open={notice !== null} onClose={onClose}>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F3E3E0] text-[#7A2E2E]">
        <AlertIcon />
      </div>
      <h2 className="mt-4 text-xl text-[#1C1A17]">{notice?.title}</h2>
      <p className="mt-2 text-[0.95rem] leading-relaxed text-[#8A8375]">{notice?.message}</p>
      <button
        onClick={onClose}
        autoFocus
        className="mt-6 w-full rounded-lg bg-[#1C1A17] px-4 py-2.5 text-sm text-[#FAF6EE] transition-colors hover:bg-[#33302A]"
      >
        Got it
      </button>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

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
      <ConfirmDeleteModal
        open={confirmOpen}
        serviceName={service.name}
        isDeleting={isDeleting}
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
