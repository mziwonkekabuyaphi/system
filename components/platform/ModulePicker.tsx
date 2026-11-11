// components/platform/ModulePicker.tsx — the module chooser used when approving or creating a shop.
// Same Products / Add-ons sections and switches as /platform/modules, so the two screens read alike.
"use client"

import { CREATABLE_MODULES, type NewShopModule } from "@/lib/services/new-shop-modules"

const GROUPS: Array<{ title: string; blurb: string; keys: NewShopModule[] }> = [
  { title: "Products", blurb: "What the shop runs", keys: ["booking", "queue", "shisha", "staff"] },
  { title: "Add-ons", blurb: "Extras that build on a product", keys: ["shifts", "payroll"] },
]

/** "Staff Management (R30 per staff…)" → label + hint, so the hint sits under the name. */
function split(label: string): { name: string; hint?: string } {
  const m = label.match(/^(.*?)\s*\((.*)\)$/)
  return m ? { name: m[1], hint: m[2] } : { name: label }
}

export function ModulePicker({
  value,
  onChange,
  requested,
  disabled,
}: {
  value: NewShopModule[]
  onChange: (next: NewShopModule[]) => void
  /** Modules the owner asked for; marked with a small "Asked for" tag. */
  requested?: string[]
  disabled?: boolean
}) {
  return (
    <div className="grid divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white md:grid-cols-2 md:divide-x md:divide-y-0">
      {GROUPS.map((g) => (
        <div key={g.title} className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">{g.title}</p>
          <p className="mb-3 text-xs text-stone-400">{g.blurb}</p>
          <ul className="space-y-3">
            {CREATABLE_MODULES.filter((m) => g.keys.includes(m.key)).map((m) => {
              const on = value.includes(m.key)
              const { name, hint } = split(m.label)
              return (
                <li key={m.key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-sm ${on ? "font-medium text-stone-900" : "text-stone-700"}`}>
                      {name}
                      {requested?.includes(m.key) && (
                        <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Asked for</span>
                      )}
                    </p>
                    {hint && <p className="text-xs text-stone-400">{hint}</p>}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${on ? "Switch off" : "Switch on"} ${name}`}
                    disabled={disabled}
                    onClick={() => onChange(on ? value.filter((k) => k !== m.key) : [...value, m.key])}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 disabled:opacity-50 ${on ? "bg-emerald-600" : "bg-stone-300"}`}
                  >
                    <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
