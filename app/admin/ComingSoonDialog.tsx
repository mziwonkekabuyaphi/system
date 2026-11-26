// app/admin/ComingSoonDialog.tsx
"use client"

import type { ReactNode } from "react"

import { AdminDialog } from "./AdminDialog"

/**
 * Placeholder for an add-on that is switched on for the shop but not built yet
 * (Barcode / label printing, Shisha mobile POS). It tells the owner so, instead of a dead button.
 * Replace the button that opens it with the real screen when the feature ships.
 */
export function ComingSoonDialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <AdminDialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink hover:bg-tint">
          Close
        </button>
      }
    >
      <p className="inline-block rounded-full bg-tint px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-ink-soft">In development</p>
      <div className="mt-3 space-y-2">{children ?? <p>This add-on is switched on for your business, but it isn&rsquo;t ready yet. We&rsquo;ll let you know when it is.</p>}</div>
    </AdminDialog>
  )
}
