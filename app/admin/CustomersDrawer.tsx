// app/admin/CustomersDrawer.tsx
//
// Right-hand overlay panel for the customer list, opened from the Inbox page.
// Same pattern as WhatsAppSettingsDrawer: the Inbox stays underneath, and
// closing the panel (x button, Escape, or a click on the dark backdrop) puts
// you straight back where you were.
//
// The list inside is the original CustomersManager, unchanged. It is only
// mounted the first time the drawer opens, then kept mounted (just hidden when
// closed) so the search and sorting are still there next time and nothing
// reloads.
"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { CustomersManager } from "./CustomersManager"

export function CustomersDrawer({
  open,
  onClose,
  timezone,
}: {
  open: boolean
  onClose: () => void
  timezone: string
}) {
  // Mount first, then slide in a frame later, so the transition actually plays.
  const [visible, setVisible] = useState(open)
  const [shown, setShown] = useState(false)
  const [everOpened, setEverOpened] = useState(open)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open) {
      setEverOpened(true)
      setVisible(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setVisible(false), 220)
    return () => clearTimeout(t)
  }, [open])

  const requestClose = useCallback(() => onClose(), [onClose])

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

  if (!everOpened) return null

  return (
    <div className={visible ? "fixed inset-0 z-50" : "hidden"} role="presentation">
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
        aria-labelledby="customers-title"
        className={`absolute right-0 top-0 flex h-full w-full max-w-[760px] flex-col bg-[#FBF9F3] shadow-2xl outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E6E1D4] px-5 py-4">
          <div>
            <h2 id="customers-title" className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
              Customers
            </h2>
            <p className="mt-0.5 text-sm text-[#8A8375]">Everyone who has booked or joined your queue.</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-lg leading-none text-[#8A8375] hover:bg-[#F3EEE2]"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <CustomersManager timezone={timezone} />
        </div>
      </aside>
    </div>
  )
}
