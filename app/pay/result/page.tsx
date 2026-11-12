// app/pay/result/page.tsx
//
// Where Yoco's hosted checkout sends the customer afterwards. Deliberately dumb and shop-neutral:
// it never trusts the query string for anything that matters. The Passport is credited only by the
// signed webhook, and the customer gets a WhatsApp message when that happens.

const COPY: Record<string, { title: string; body: string }> = {
  success: {
    title: "Payment received",
    body: "Thank you! Your Passport updates in a few seconds, and you'll get a WhatsApp message when it's done. You can go back to WhatsApp now.",
  },
  cancelled: {
    title: "Payment cancelled",
    body: "No money was taken. You can go back to WhatsApp and try again whenever you like.",
  },
  failed: {
    title: "Payment didn't go through",
    body: "No money was taken. You can go back to WhatsApp and try again.",
  },
}

export default async function PayResultPage({ searchParams }: { searchParams: Promise<{ status?: string }> | { status?: string } }) {
  const { status } = await searchParams
  const copy = COPY[status ?? ""] ?? COPY.failed
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>{copy.title}</h1>
        <p style={{ lineHeight: 1.5, opacity: 0.8 }}>{copy.body}</p>
      </div>
    </main>
  )
}
