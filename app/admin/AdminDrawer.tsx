// app/admin/AdminDrawer.tsx
//
// Reusable right-hand overlay shell, same look and behaviour as
// shisha/ShishaDisplayDrawer.tsx: slides in from the right, dim backdrop,
// Escape / backdrop click / × closes, page behind doesn't scroll.
//
// It only provides the frame (header + scrolling body). The content decides
// how it saves. Children are unmounted when the drawer closes, so whatever you
// put inside loads fresh every time it opens.
"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

const WIDTHS = {
  md: "max-w-[460px]", // simple settings forms
  xl: "max-w-[1040px]", // tables (payroll)
} as const

export function AdminDrawer({
  open,
  onClose,
  title,
  subtitle,
  width = "md",
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  width?: keyof typeof WIDTHS
  children: ReactNode
}) {
  // Mount first, slide in a frame later, so the transition actually plays.
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useRef(`admin-drawer-${Math.random().toString(36).slice(2, 8)}`).current

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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // A confirm dialog inside the drawer can call preventDefault() on Escape
      // to say "I handled this", so the drawer doesn't close underneath it.
      if (e.key === "Escape" && !e.defaultPrevented) onClose()
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    panelRef.current?.focus()
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`absolute right-0 top-0 flex h-full w-full ${WIDTHS[width]} flex-col bg-[#FBF9F3] shadow-2xl outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E6E1D4] px-5 py-4">
          <div>
            <h2 id={titleId} className="font-[family-name:var(--font-admin-serif)] text-lg text-[#1C1A17]">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-[#8A8375]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-lg leading-none text-[#8A8375] hover:bg-[#F3EEE2]"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  )
}
