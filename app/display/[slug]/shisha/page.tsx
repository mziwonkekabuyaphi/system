// app/display/[slug]/shisha/page.tsx
//
// Public, unauthenticated route for the lounge's Shisha status TV. Same
// posture as app/display/[slug]/page.tsx: the tenant is resolved from
// (slug, status = 'active') on the server on every request. Two switches
// apply, both checked inside fetchShishaDisplayData():
//   - the Shisha module must be on for the tenant (opt-in, tenant_modules);
//   - the owner's "Screen switched on" toggle (Shisha > TV display).

import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { fetchShishaDisplayData } from "./actions"
import { ShishaDisplayScreen } from "./ShishaDisplayScreen"

// Always render fresh: the TV must never be served cached sessions.
export const dynamic = "force-dynamic"
export const revalidate = 0

type PageProps = { params: Promise<{ slug: string }> }

export const metadata: Metadata = {
  title: "Shisha display",
  robots: { index: false, follow: false },
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

export default async function ShishaDisplayPage({ params }: PageProps) {
  const { slug } = await params
  const result = await fetchShishaDisplayData(slug)

  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        notFound()
      case "shisha_off":
        return <Message title="Shisha isn't switched on" body="Switch the Shisha module on for your business, then reload this screen." />
      case "screen_off":
        return <Message title="The shisha display is switched off" body="Turn it on in Shisha > TV display, then reload this screen." />
      default:
        return <Message title="Couldn't load the display" body="Please check the connection and reload this screen." />
    }
  }

  return <ShishaDisplayScreen slug={slug} initialData={result.data} />
}
