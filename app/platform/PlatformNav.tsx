// app/platform/PlatformNav.tsx — grouped sidebar for the platform admin.
// Desktop: fixed left column. Mobile: a top bar with a slide-down menu.
// `badges` are "needs your attention" counts, loaded once in layout.tsx.
"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"

export type NavBadges = Partial<Record<"tenants" | "upgrades" | "leads" | "sales", number>>

type Item = { href: string; label: string; icon: ReactNode; badge?: keyof NavBadges }
type Group = { title: string | null; items: Item[] }

const ico = (d: string) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)

const GROUPS: Group[] = [
  {
    title: null,
    items: [{ href: "/platform", label: "Overview", icon: ico("M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-3H4z") }],
  },
  {
    title: "Customers",
    items: [
      { href: "/platform/tenants", label: "Shops", icon: ico("M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"), badge: "tenants" },
      { href: "/platform/upgrades", label: "Upgrade requests", icon: ico("M12 20V5M6 11l6-6 6 6"), badge: "upgrades" },
    ],
  },
  {
    title: "Products",
    items: [
      { href: "/platform/modules", label: "Modules & add-ons", icon: ico("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM17 13v7M13.5 16.5h7") },
      { href: "/platform/shisha", label: "Shisha", icon: ico("M12 3c2 3-2 4-2 7a2 2 0 004 0M8 21h8M10 21v-4h4v4") },
      { href: "/platform/ads", label: "Kiosk ads", icon: ico("M3 5h18v11H3zM8 20h8M12 16v4") },
    ],
  },
  {
    title: "Growth",
    items: [
      { href: "/platform/sales", label: "Sales & commissions", icon: ico("M4 19V9M10 19V5M16 19v-7M22 19H2"), badge: "sales" },
      { href: "/platform/leads", label: "Enquiries", icon: ico("M4 5h16v11H8l-4 4z"), badge: "leads" },
    ],
  },
]

function isActive(pathname: string, href: string) {
  return href === "/platform" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
}

function NavList({ badges, onNavigate }: { badges: NavBadges; onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Platform admin" className="space-y-6">
      {GROUPS.map((g, i) => (
        <div key={g.title ?? i} className="space-y-1">
          {g.title && <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-stone-400">{g.title}</p>}
          {g.items.map((it) => {
            const active = isActive(pathname, it.href)
            const n = it.badge ? badges[it.badge] ?? 0 : 0
            return (
              <Link
                key={it.href}
                href={it.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? "bg-stone-900 font-medium text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                }`}
              >
                <span className={active ? "text-white" : "text-stone-400 group-hover:text-stone-700"}>{it.icon}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {n > 0 && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
                      active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {n > 99 ? "99+" : n}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function PlatformShell({ badges, footer, children }: { badges: NavBadges; footer: ReactNode; children: ReactNode }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [pathname])

  const brand = (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-900 text-sm font-bold text-white">Z</span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-stone-900">Platform admin</p>
        <p className="text-[11px] text-stone-400">Super admin</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-stone-50 lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-stone-200 bg-white lg:flex">
        <div className="border-b border-stone-100 px-5 py-4">{brand}</div>
        <div className="flex-1 overflow-y-auto px-3 py-5">
          <NavList badges={badges} />
        </div>
        <div className="border-t border-stone-100 p-3">{footer}</div>
      </aside>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 border-b border-stone-200 bg-white lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          {brand}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle menu"
            className="rounded-lg border border-stone-200 p-2 text-stone-700 hover:bg-stone-100"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
              <path d={open ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
            </svg>
          </button>
        </div>
        {open && (
          <div className="max-h-[calc(100vh-4rem)] space-y-4 overflow-y-auto border-t border-stone-100 px-3 py-4">
            <NavList badges={badges} onNavigate={() => setOpen(false)} />
            <div className="border-t border-stone-100 pt-3">{footer}</div>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">{children}</div>
      </div>
    </div>
  )
}
