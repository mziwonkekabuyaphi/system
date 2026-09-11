// app/admin/layout.tsx
import type { ReactNode } from "react"
import { Fraunces, Inter } from "next/font/google"

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

// ⚠️ TODO: this route has NO ACCESS PROTECTION yet — no login, no password
// gate, nothing. Every action in actions.ts is reachable by anyone who
// loads this URL. Do not link this route from anywhere customer-facing,
// and do not ship to production without adding auth first.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${fraunces.variable} ${inter.variable} min-h-screen bg-[#F0EEE6] [font-family:var(--font-inter)] antialiased`}
    >
      {children}
    </div>
  )
}
