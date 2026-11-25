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

export default async function PendingPage() {
  if (!(await getSessionUser())) redirect("/login")

  const member = await getCurrentTenantMember()
  if (!member) redirect("/onboarding")

  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/admin")

  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, status, industry, requested_modules")
    .eq("id", member.tenantId)
    .maybeSingle()

  if (!tenant || tenant.status === "active" || tenant.status === "suspended") redirect("/admin")

  const declined = tenant.status === "inactive"
  const requested = (tenant.requested_modules as string[] | null) ?? []

  // Names come from the database so new modules (events, orders, wallet, ...)
  // show up without touching this file.
  const [{ data: moduleRows }, { data: presetRow }] = await Promise.all([
    requested.length > 0
      ? supabase.from("modules").select("key, name").in("key", requested)
      : Promise.resolve({ data: [] as { key: string; name: string }[] }),
    tenant.industry
      ? supabase.from("industry_presets").select("name").eq("key", tenant.industry).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const nameByKey = new Map((moduleRows ?? []).map((m) => [m.key, m.name]))
  const asked = requested.map((k) => nameByKey.get(k) ?? k)

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
            Thanks for signing up <strong>{tenant.name}</strong>
            {presetRow?.name ? <> ({presetRow.name})</> : null}. Booking and Queue switch on straight away, but the modules you picked
            need a quick check first. Your settings are already prepared, so once you&apos;re approved you can start right away.
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
