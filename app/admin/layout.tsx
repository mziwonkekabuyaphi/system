// app/admin/layout.tsx
import type { ReactNode } from "react"
import { Fraunces, Inter } from "next/font/google"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"

/**
 * Fonts scoped to /admin only, not added to the root layout — the
 * customer-facing side of this repo is WhatsApp-only and has no web UI to
 * theme. Fraunces carries the "shop signage / ledger" character for
 * headings; Inter stays quiet underneath for the actual operational data
 * (times, prices, lists) where legibility matters more than personality.
 */
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-admin-serif",
  display: "swap",
})

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

// Access protection: every /admin page and Server Action now requires a
// signed-in user with an active tenant_members row (see
// lib/tenant/current-tenant-member.ts). requireTenantMember() redirects
// to /login when either condition fails — nothing under /admin renders
// for a signed-out or tenant-less visitor.
//
// This only covers /admin's own React tree. If middleware.ts exists at
// the repo root, add "/admin/:path*" to its matcher too, so a signed-out
// request never even reaches this layout — see the auth module's README.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireTenantMember()

  return (
    <div
      className={`${fraunces.variable} ${inter.variable} min-h-screen bg-admin-body [font-family:var(--font-inter)] antialiased`}
    >
      {children}
    </div>
  )
}
