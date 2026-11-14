// app/pay/result/page.tsx
//
// Where the payment page sends the customer afterwards. Deliberately dumb and shop-neutral:
//   Yoco / Ozow: ?status=success|cancelled|failed  (the page only displays; the signed notice does the work)
//   Paystack:    ?reference=pay-...&trxref=...      (we additionally ask Paystack whether it was paid, see
//                                                    lib/payments/paystack-reconcile.ts. The URL itself is never
//                                                    trusted for anything that matters.)
// The Passport / tickets are credited only by the verified payment, and the customer gets a WhatsApp message.

import { reconcilePaystackReference } from "@/lib/payments/paystack-reconcile"

export const dynamic = "force-dynamic"

const COPY: Record<string, { title: string; body: string }> = {
  success: {
    title: "Payment received",
    body: "Thank you! Your Passport or tickets update in a few seconds, and you'll get a WhatsApp message when it's done. You can go back to WhatsApp now.",
  },
  pending: {
    title: "Confirming your payment",
    body: "We're confirming your payment. This usually takes a few seconds, and you'll get a WhatsApp message as soon as it's done. You can go back to WhatsApp now.",
  },
  problem: {
    title: "We received your payment",
    body: "We couldn't complete your order, so you'll be refunded in full. The shop has been told. Check WhatsApp for details.",
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

type Params = { status?: string; reference?: string; trxref?: string }

export default async function PayResultPage({ searchParams }: { searchParams: Promise<Params> | Params }) {
  const q = await searchParams

  let key = q.status ?? ""
  const reference = q.reference ?? q.trxref
  if (reference) {
    // Only references in our own Paystack format that match a payment we created are looked at; anything else is "unknown".
    const result = await reconcilePaystackReference(reference)
    if (result === "confirmed") key = "success"
    else if (result === "pending") key = "pending"
    else if (result === "problem") key = "problem"
    else if (result === "failed") key = "failed"
  }
  const copy = COPY[key] ?? COPY.failed

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>{copy.title}</h1>
        <p style={{ lineHeight: 1.5, opacity: 0.8 }}>{copy.body}</p>
      </div>
    </main>
  )
}
