// app/onboarding/pending/page.tsx
//
// Where a self-signed-up owner waits while a platform admin reviews the shop
// (tenants.status = 'pending'). Approval happens on /platform/tenants. Once the
// shop is active this page sends the owner on to /admin.

import Link from "next/link"
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getCurrentTenantMember, getSessionUser } from "@/lib/tenant/current-tenant-member"

export const metadata = { title: "We're reviewing your application · QLess" }
export const dynamic = "force-dynamic"

const LABELS: Record<string, string> = { booking: "Booking", queue: "Queue", shisha: "Shisha", shifts: "Shifts", payroll: "Payroll" }

export default async function PendingPage() {
  if (!(await getSessionUser())) redirect("/login")

  const member = await getCurrentTenantMember()
  if (!member) redirect("/onboarding")

  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/admin")

  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, status, requested_modules")
    .eq("id", member.tenantId)
    .maybeSingle()

  if (!tenant || tenant.status === "active" || tenant.status === "suspended") redirect("/admin")

  const declined = tenant.status === "inactive"
  const asked = ((tenant.requested_modules as string[] | null) ?? []).map((k) => LABELS[k] ?? k)

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl text-stone-900">{declined ? "We couldn't approve this business" : "We're reviewing your application"}</h1>
      <p className="mt-3 text-stone-600">
        {declined ? (
          <>
            <strong>{tenant.name}</strong> wasn&apos;t approved. If you think that&apos;s a mistake, contact us and we&apos;ll look again.
          </>
        ) : (
          <>
            Thanks for signing up <strong>{tenant.name}</strong>. We check every new business before it goes live, then switch on what
            you need. We&apos;ll be in touch soon.
          </>
        )}
      </p>
      {!declined && asked.length > 0 && (
        <p className="mt-3 text-sm text-stone-500">You asked for: {asked.join(", ")}.</p>
      )}
      <Link href="/admin" className="mt-6 inline-block w-full rounded bg-stone-900 py-2 text-center text-white">
        Check again
      </Link>
    </main>
  )
}
