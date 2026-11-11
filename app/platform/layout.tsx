// app/platform/layout.tsx — shared shell for the whole platform-admin area.
// The gate lives here AND in each page/action (actions are public endpoints,
// so a layout check alone would never be enough).
import type { ReactNode } from "react"

import { requirePlatformAdmin } from "@/lib/sales/auth"
import { getSupabaseServerClient } from "@/lib/supabase/admin"

import { signOutAction } from "./actions"
import { PlatformShell, type NavBadges } from "./PlatformNav"

export const dynamic = "force-dynamic"

/** "Needs attention" counts for the sidebar. A failed count just shows no badge. */
async function loadBadges(): Promise<NavBadges> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return {}
  const head = { count: "exact", head: true } as const
  const [tenants, upgrades, leads, signups] = await Promise.all([
    supabase.from("tenants").select("id", head).eq("status", "pending"),
    supabase.from("plan_upgrade_requests").select("id", head).eq("status", "pending"),
    supabase.from("contact_requests").select("id", head).eq("status", "new"),
    supabase.from("referral_signups").select("id", head).eq("status", "pending"),
  ])
  return {
    tenants: tenants.count ?? 0,
    upgrades: upgrades.count ?? 0,
    leads: leads.count ?? 0,
    sales: signups.count ?? 0,
  }
}

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  await requirePlatformAdmin()
  const badges = await loadBadges()
  return (
    <PlatformShell
      badges={badges}
      footer={
        <form action={signOutAction}>
          <button
            type="submit"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-left text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-900"
          >
            Log out
          </button>
        </form>
      }
    >
      {children}
    </PlatformShell>
  )
}
