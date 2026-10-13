// app/refer/[code]/page.tsx — public page a salesperson's link opens.
import { ReferralForm } from "./ReferralForm"

export const dynamic = "force-dynamic"

export default async function ReferPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">
        Get your shop on the queue
      </h1>
      <p className="mt-2 text-sm text-stone-500">
        Tell us about your business and we&apos;ll set up your account after a quick review.
      </p>
      <ReferralForm code={code.toUpperCase()} />
    </main>
  )
}
