// app/scan/[slug]/page.tsx
//
// Mobile gate scanner for one tenant, e.g.  /scan/mziwonke-spa-salon
// Open it on a phone at the entrance (or "Add to Home Screen"). It wears the tenant's branding
// (logo, colours, name) from tenant_branding and checks people into that tenant's active events.
//
// NO LOGIN YET: the tenant comes from the URL, so anyone with the link can scan for that tenant.
// Keep the link private until login is added (see data.ts authorizeScan).

import type { CSSProperties } from "react"
import type { Metadata, Viewport } from "next"
import { notFound } from "next/navigation"
import { loadOpenEvents, resolveScanTenant } from "./data"
import { ScanHeader } from "./ScanHeader"
import { ScannerApp } from "./ScannerApp"
import { themeColor } from "./branding"
import "./scanner.css"

export const dynamic = "force-dynamic"

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const found = await resolveScanTenant(slug)
  const tenant = found.status === "ok" ? found.tenant : found.status === "unavailable" ? found.tenant : null
  return {
    title: `${tenant?.name ?? "Gate"} · Gate scanner`,
    robots: { index: false, follow: false },
    // Lets "Add to Home Screen" open it full screen on phones.
    appleWebApp: { capable: true, title: `${tenant?.name ?? "Gate"} Scanner`, statusBarStyle: "black-translucent" },
  }
}

export async function generateViewport({ params }: Props): Promise<Viewport> {
  const { slug } = await params
  const found = await resolveScanTenant(slug)
  const tenant = found.status === "ok" ? found.tenant : found.status === "unavailable" ? found.tenant : null
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: themeColor(tenant?.brandVars["--brand"]),
  }
}

/** Same fonts and icons as the original scanner. */
function Assets() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
      />
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
    </>
  )
}

export default async function ScanPage({ params }: Props) {
  const { slug } = await params
  const found = await resolveScanTenant(slug)
  if (found.status === "not_found") notFound()

  if (found.status === "unavailable") {
    const tenant = found.tenant
    return (
      <>
        <Assets />
        <div className="ndi-scan" style={(tenant?.brandVars ?? {}) as CSSProperties}>
          <ScanHeader name={tenant?.name ?? "Gate scanner"} logoUrl={tenant?.logoUrl ?? null} sync={null} />
          <div className="unavailable">
            <div className="unavailable-card">
              <i className="fa-solid fa-lock" aria-hidden="true" />
              <h2>Scanner unavailable</h2>
              <p>{found.message}</p>
            </div>
          </div>
        </div>
      </>
    )
  }

  const events = await loadOpenEvents(found.db, found.tenantId)
  return (
    <>
      <Assets />
      <ScannerApp tenant={found.tenant} initialEvents={events} />
    </>
  )
}
