// app/display/[slug]/page.tsx
/**
 * Public, unauthenticated route: a big-screen ambient branding display
 * meant to run on a TV in the waiting area, on its own tab, indefinitely.
 * No interaction, no auth — same public-URL posture as /kiosk/[slug] and
 * /clock/[slug]. fetchDisplayData() re-resolves the tenant from the slug
 * itself, so this 404s cleanly for a bad/suspended-tenant slug rather
 * than rendering a broken or wrong-tenant screen.
 *
 * NEXT.JS 15/16: `params` is a Promise here, not a plain object — same
 * fix app/kiosk/[slug]/page.tsx already needed (see that file's header
 * for why: the old sync shape silently resolved slug to undefined,
 * which 404'd a real tenant with nothing logged). Both this page
 * component and generateMetadata below await it independently, same as
 * the kiosk page does.
 */

import { notFound } from "next/navigation"
import { fetchDisplayData } from "./actions"
import { DisplayScreen } from "./DisplayScreen"

// A TV display should never serve a stale branding/menu/hours snapshot
// just because Next cached the RSC render -- same reasoning as the
// kiosk page's `dynamic = "force-dynamic"`. DisplayScreen's own client-
// side polling (every 5 min) is a second, separate freshness mechanism
// for the tab that's already open; this covers the initial render.
export const dynamic = "force-dynamic"

export default async function DisplayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const result = await fetchDisplayData(slug)
  if (!result.ok) notFound()

  return <DisplayScreen slug={slug} initialData={result.data} />
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const result = await fetchDisplayData(slug)
  if (!result.ok) return { title: "Display" }

  return { title: `${result.data.branding.displayName ?? "Shop"} — Display` }
}
