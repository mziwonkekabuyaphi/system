// app/display/[slug]/page.tsx
//
// Public, unauthenticated route for the waiting-area TV. It does the first
// data load on the server (so the TV paints with real content straight away)
// and hands it to DisplayScreen, which then polls fetchDisplayData() by itself.
//
// Access rules, same posture as app/kiosk/[slug] and app/clock/[slug]:
//   - the tenant is resolved from (slug, status = 'active') on every request,
//     never from anything the client sends;
//   - the owner's "Public display module" switch (Settings > Display, stored
//     in tenant_modules under the 'display' module key) is respected. No row
//     means "never switched" = ON, so existing shops keep working.

import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { isProductEnabled } from "@/lib/services/plans"

import { fetchDisplayData } from "./actions"
import { DisplayScreen } from "./DisplayScreen"

// Always render fresh: the TV must never be served a cached queue.
export const dynamic = "force-dynamic"
export const revalidate = 0

type PageProps = { params: Promise<{ slug: string }> }

export const metadata: Metadata = {
  title: "Display",
  // Public TV screen, not something to index.
  robots: { index: false, follow: false },
}

/** Resolves the tenant and reads the owner's on/off switch for the display. */
async function isDisplayEnabled(slug: string): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return false

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle()

  if (tenantError || !tenant) return false

  const { data: moduleRow } = await supabase.from("modules").select("id").eq("key", "display").maybeSingle()
  // Module not registered yet -> nobody has ever switched it off.
  if (!moduleRow) return true

  const { data: row, error } = await supabase
    .from("tenant_modules")
    .select("enabled")
    .eq("tenant_id", tenant.id as string)
    .eq("module_id", moduleRow.id as string)
    .maybeSingle()

  // On a lookup error, keep the screen up rather than blank a TV over a blip.
  if (error) return true
  // No row = never touched = ON.
  return row ? row.enabled === true : true
}

/** The board shows the live queue, so it needs the Queue product switched on for the
 *  shop (tenant_modules, via isProductEnabled; fails closed). */
async function isQueueOn(slug: string): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  if (!supabase) return false
  const { data: tenant } = await supabase.from("tenants").select("id").eq("slug", slug).eq("status", "active").maybeSingle()
  if (!tenant) return false
  return isProductEnabled(supabase, tenant.id as string, "queue")
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: "1.5vh",
        background: "#15110D",
        color: "#FAF8F5",
        fontFamily: "Inter, -apple-system, sans-serif",
        padding: "6vh 6vw",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "clamp(2rem, 4vw, 3.5rem)", fontWeight: 600 }}>{title}</h1>
      <p style={{ margin: 0, fontSize: "clamp(1.1rem, 2vw, 1.8rem)", opacity: 0.7 }}>{body}</p>
    </main>
  )
}

export default async function DisplayPage({ params }: PageProps) {
  const { slug } = await params

  const enabled = await isDisplayEnabled(slug)
  if (!enabled) {
    // Distinguish "no such shop" (404) from "shop switched its display off".
    const supabase = getSupabaseServerClient()
    const { data: tenant } = supabase
      ? await supabase.from("tenants").select("id").eq("slug", slug).eq("status", "active").maybeSingle()
      : { data: null }
    if (!tenant) notFound()
    return <Message title="Display is switched off" body="Turn it on in Settings > Display, then reload this screen." />
  }

  // Queue off for this shop: say so, and don't load any queue data.
  if (!(await isQueueOn(slug))) {
    return <Message title="This display isn't available" body="This screen isn't set up for this shop." />
  }

  const result = await fetchDisplayData(slug)

  if (!result.ok) {
    return <Message title="Couldn't load the display" body="Please check the connection and reload this screen." />
  }

  return <DisplayScreen slug={slug} initialData={result.data} />
}
