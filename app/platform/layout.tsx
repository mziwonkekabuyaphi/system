// app/platform/layout.tsx — shared shell for the whole platform-admin area.
// The gate lives here AND in each page/action (actions are public endpoints,
// so a layout check alone would never be enough).
import type { ReactNode } from "react"

import { requirePlatformAdmin } from "@/lib/sales/auth"

import { PlatformNav } from "./PlatformNav"

export const dynamic = "force-dynamic"

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  await requirePlatformAdmin()
  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <span className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Platform admin</span>
          <PlatformNav />
        </div>
      </header>
      {children}
    </div>
  )
}
