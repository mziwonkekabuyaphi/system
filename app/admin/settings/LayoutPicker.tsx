// app/admin/settings/LayoutPicker.tsx
"use client"

import { BRAND_SELECTED, BRAND_TEXT } from "@/components/admin/brand"

export type PickableLayout = "classic" | "modern"
export type LayoutKind = "event" | "table" | "booking"

const COPY: Record<LayoutKind, Record<PickableLayout, string>> = {
  event: {
    classic: "Header with the event name, a details list and the QR code below.",
    modern: "Calendar date block, info tiles and a tear-off QR section.",
  },
  table: {
    classic: "Header, a details list and the QR code below (the event ticket design).",
    modern: "Big table badge, info tiles, bar tab chip and a tear-off QR section.",
  },
  booking: {
    classic: "Brand header with the service, a details list and the QR code below.",
    modern: "Huge appointment time, a service card and the details beside the QR code.",
  },
}

/** A tiny wireframe of each design so the choice is visible, not just described. */
function Wire({ layout, active }: { layout: PickableLayout; active: boolean }) {
  const strong = active ? "bg-stone-700" : "bg-stone-400"
  const soft = "bg-stone-200"
  if (layout === "classic") {
    return (
      <div className="flex h-24 w-16 shrink-0 flex-col overflow-hidden rounded-md border border-stone-300 bg-white">
        <div className={`h-6 ${strong}`} />
        <div className="flex flex-1 flex-col gap-1 p-1.5">
          <div className={`h-1 w-10 rounded ${soft}`} />
          <div className={`h-1 w-8 rounded ${soft}`} />
          <div className={`h-1 w-9 rounded ${soft}`} />
          <div className={`mx-auto mt-auto h-6 w-6 rounded-sm ${strong}`} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-24 w-16 shrink-0 flex-col overflow-hidden rounded-md border border-stone-300 bg-white">
      <div className={`flex h-9 items-end p-1.5 ${strong}`}>
        <div className="h-3 w-7 rounded-sm bg-white/80" />
      </div>
      <div className="-mt-2 mx-1 h-4 rounded-sm border border-stone-200 bg-white shadow-sm" />
      <div className="flex flex-1 gap-1 p-1.5">
        <div className="flex flex-1 flex-col gap-1">
          <div className={`h-1 rounded ${soft}`} />
          <div className={`h-1 w-3/4 rounded ${soft}`} />
        </div>
        <div className={`h-6 w-6 rounded-sm ${strong}`} />
      </div>
    </div>
  )
}

/** Choose between the classic (original) and the modern design. Everything else on the card edits whichever is chosen. */
export function LayoutPicker({
  kind,
  value,
  onChange,
  disabled,
}: {
  kind: LayoutKind
  value: PickableLayout
  onChange: (next: PickableLayout) => void
  disabled?: boolean
}) {
  const options: Array<{ value: PickableLayout; title: string }> = [
    { value: "classic", title: "Classic" },
    { value: "modern", title: "Modern" },
  ]
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
              selected ? `${BRAND_SELECTED} bg-card` : "border-stone-300 bg-stone-50 hover:bg-stone-100"
            }`}
          >
            <Wire layout={option.value} active={selected} />
            <span className="flex flex-col gap-1">
              <span className={`text-sm font-semibold ${selected ? BRAND_TEXT : "text-stone-800"}`}>{option.title}</span>
              <span className="text-xs text-stone-500">{COPY[kind][option.value]}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
