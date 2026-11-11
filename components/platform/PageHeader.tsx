// components/platform/PageHeader.tsx — the one page header every /platform page uses,
// so titles, descriptions and action buttons sit in the same place everywhere.
// No hooks and no "use server", so it works from server and client pages alike.
import type { ReactNode } from "react"

export function PageHeader({
  title,
  description,
  count,
  actions,
}: {
  title: string
  description?: ReactNode
  /** Small number chip next to the title, e.g. how many shops. */
  count?: number
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-5">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{title}</h1>
          {typeof count === "number" && (
            <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-stone-600">{count}</span>
          )}
        </div>
        {description && <p className="max-w-3xl text-sm leading-relaxed text-stone-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Shared surface for every section on a platform page. */
export const PLATFORM_CARD = "rounded-2xl border border-stone-200 bg-white shadow-sm"
