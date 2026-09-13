"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { SVGProps } from "react"
import { createClient } from "@/lib/supabase/client"

function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M15 4.5H7.8A1.8 1.8 0 0 0 6 6.3v11.4a1.8 1.8 0 0 0 1.8 1.8H15" />
      <path d="M11 12h9.5" />
      <path d="m17 8 4 4-4 4" />
    </svg>
  )
}

export function LogoutButton({ expanded }: { expanded: boolean }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleLogout() {
    setLoading(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push("/login")
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      title="Sign out"
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-[#C9B9BC] transition-colors hover:bg-white/[0.07] hover:text-[#FAF7F2] disabled:opacity-60"
    >
      <LogoutIcon className="h-5 w-5 shrink-0" />
      <span
        className={`whitespace-nowrap transition-opacity duration-150 ${
          expanded ? "opacity-100 delay-100" : "opacity-0"
        }`}
      >
        {loading ? "Signing out…" : "Sign out"}
      </span>
    </button>
  )
}
