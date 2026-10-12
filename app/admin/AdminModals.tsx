// app/admin/AdminModals.tsx
"use client"

// Shared pop-up windows for the admin (replace the browser's own
// window.alert / window.confirm boxes). Used by ServicesManager and
// StaffManager.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

// Closes with Escape or a click on the dark backdrop, unless `locked`
// (used while an action is running so it can't be dismissed half-way).
export function Modal({
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

/** "Are you sure?" pop-up with a red confirm button (used for deletes). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busyLabel,
  isBusy,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel: string
  busyLabel: string
  isBusy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal open={open} onClose={onCancel} locked={isBusy}>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F3E3E0] text-[#7A2E2E]">
        <TrashIcon />
      </div>
      <h2 className="mt-4 text-xl text-[#1C1A17]">{title}</h2>
      <p className="mt-2 text-[0.95rem] leading-relaxed text-[#8A8375]">{message}</p>
      <div className="mt-6 flex gap-3">
        <button
          onClick={onCancel}
          disabled={isBusy}
          autoFocus
          className="flex-1 rounded-lg border border-[#D9D3C3] px-4 py-2.5 text-sm text-[#1C1A17] transition-colors hover:bg-[#F1ECDF] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={isBusy}
          className="flex-1 rounded-lg bg-[#7A2E2E] px-4 py-2.5 text-sm text-[#FAF6EE] transition-colors hover:bg-[#662525] disabled:opacity-60"
        >
          {isBusy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export type Notice = { title: string; message: string }

/** Error / info pop-up with a single "Got it" button. */
export function NoticeModal({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
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
