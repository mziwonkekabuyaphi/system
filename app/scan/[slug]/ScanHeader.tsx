"use client"

// app/scan/[slug]/ScanHeader.tsx
//
// The branded top band: the tenant's logo (or just its name) and a connection pill.

import { useState } from "react"

export type SyncState = "live" | "reconnecting" | "offline" | null

const PILL: Record<Exclude<SyncState, null>, { icon: string; label: string; offline: boolean }> = {
  live: { icon: "cloud", label: "Live", offline: false },
  reconnecting: { icon: "arrows-rotate", label: "Reconnecting", offline: true },
  offline: { icon: "database", label: "Offline", offline: true },
}

export function ScanHeader({ name, logoUrl, sync }: { name: string; logoUrl: string | null; sync: SyncState }) {
  const [logoFailed, setLogoFailed] = useState(false)
  const showLogo = logoUrl !== null && !logoFailed
  const pill = sync ? PILL[sync] : null

  return (
    <header className="site-header">
      <div className="brand">
        {showLogo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="brand-logo" onError={() => setLogoFailed(true)} />
        )}
        <div className="brand-text">
          <h1>{name}</h1>
          <p>Gate scanner</p>
        </div>
      </div>
      <div className="header-right">
        {pill && (
          <div className={`sync-status${pill.offline ? " offline" : ""}`} role="status">
            <i className={`fa-solid fa-${pill.icon}`} aria-hidden="true" />
            <span>{pill.label}</span>
          </div>
        )}
      </div>
    </header>
  )
}
