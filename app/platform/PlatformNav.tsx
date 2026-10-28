// app/platform/PlatformNav.tsx
"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const LINKS: Array<[string, string]> = [
  ["/platform", "Overview"],
  ["/platform/tenants", "Shops"],
  ["/platform/upgrades", "Upgrade requests"],
  ["/platform/shisha", "Shisha"],
  ["/platform/sales", "Sales & commissions"],
]

export function PlatformNav() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-wrap gap-2">
      {LINKS.map(([href, label]) => {
        const active = href === "/platform" ? pathname === href : pathname.startsWith(href)
        return (
          <Link key={href} href={href} className={`rounded-full px-4 py-1.5 text-sm ${active ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700"}`}>
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
