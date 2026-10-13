// app/sales/page.tsx
//
// Salesperson dashboard: "how are my clients doing and what have I earned".
//
// Privacy by construction: everything here comes from the salesperson_my_*
// SQL functions (aggregates per shop: visits, billed, commission) and from
// the commissions/payouts tables under RLS. There is deliberately NO query
// against customers, phone numbers, bookings or messages: a salesperson sees
// business numbers only.

import { requireSalesperson } from "@/lib/sales/auth"
import type { SalesClient, SalesCommission, SalesPayout, SalesSummary } from "@/lib/sales/types"

import { CopyLink } from "./CopyLink"

export const dynamic = "force-dynamic"

const rand = (cents: number) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(cents / 100)

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }) : "—"

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

function clientAlert(c: SalesClient): { text: string; tone: "warn" | "good" } | null {
  if (c.referral_status === "pending") return null
  if (c.tenant_status !== "active") return { text: "Account not active", tone: "warn" }
  const idle = daysSince(c.last_visit_at)
  if (idle === null) return { text: "No visits yet — help them get set up", tone: "warn" }
  if (idle >= 14) return { text: `No visits in ${idle} days — check in`, tone: "warn" }
  if (c.visit_limit && c.visits_this_month >= c.visit_limit * 0.9) {
    return { text: "Near their visit limit — upgrade chance", tone: "good" }
  }
  return null
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-800",
  approved: "bg-sky-50 text-sky-800",
  paid: "bg-emerald-50 text-emerald-800",
  void: "bg-stone-100 text-stone-500",
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-2xl text-stone-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  )
}

export default async function SalesPage() {
  const { supabase, salesperson } = await requireSalesperson()

  const [summaryRes, clientsRes, commissionsRes, payoutsRes, signupsRes] = await Promise.all([
    supabase.rpc("salesperson_my_summary"),
    supabase.rpc("salesperson_my_clients"),
    supabase
      .from("commissions")
      .select("id, tenant_id, kind, amount_cents, status, payable_after, created_at, note")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("commission_payouts")
      .select("id, period, total_cents, status, payment_reference, paid_at, created_at")
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("referral_signups")
      .select("id, business_name, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
  ])

  const summary = ((summaryRes.data ?? [])[0] ?? null) as SalesSummary | null
  const clients = (clientsRes.data ?? []) as SalesClient[]
  const commissions = (commissionsRes.data ?? []) as SalesCommission[]
  const payouts = (payoutsRes.data ?? []) as SalesPayout[]
  const pendingSignups = (signupsRes.data ?? []) as Array<{ id: string; business_name: string; created_at: string }>

  const nameByTenant = new Map(clients.map((c) => [c.tenant_id, c.tenant_name]))

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
      <header>
        <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">
          My clients &amp; commission
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          Your referral code is <span className="font-mono font-semibold text-stone-800">{salesperson.referral_code}</span>
        </p>
      </header>

      {(summaryRes.error || clientsRes.error) && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          Some figures couldn&apos;t be loaded. Please refresh; if it keeps happening, tell the admin.
        </p>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active clients" value={String(summary?.clients_total ?? 0)} hint={`${(summary?.clients_pending_approval ?? 0)} awaiting approval`} />
        <Stat label="Earned this month" value={rand(summary?.earned_this_month_cents ?? 0)} />
        <Stat label="Waiting / approved" value={rand((summary?.pending_cents ?? 0) + (summary?.approved_cents ?? 0))} hint={`${rand(summary?.approved_cents ?? 0)} ready for the next payout`} />
        <Stat label="Paid to you" value={rand(summary?.paid_cents ?? 0)} />
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Your referral link</p>
        <p className="mb-3 text-sm text-stone-500">
          Send this to a business. When they sign up through it and the admin approves them, they&apos;re attributed to you
          permanently.
        </p>
        <CopyLink code={salesperson.referral_code} />
      </section>

      {pendingSignups.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Waiting for admin approval</p>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {pendingSignups.map((s) => (
              <li key={s.id}>
                {s.business_name} <span className="text-amber-700">· submitted {shortDate(s.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">My clients</p>
        {clients.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">No clients yet. Share your referral link to get started.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-stone-400">
                <tr>
                  <th className="py-2 pr-3">Business</th>
                  <th className="py-2 pr-3">Plan</th>
                  <th className="py-2 pr-3 text-right">Visits (this / last month)</th>
                  <th className="py-2 pr-3">Last visit</th>
                  <th className="py-2 pr-3 text-right">Billed / paid</th>
                  <th className="py-2 text-right">My commission</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {clients.map((c) => {
                  const alert = clientAlert(c)
                  const myTotal = c.commission_pending_cents + c.commission_approved_cents + c.commission_paid_cents
                  return (
                    <tr key={c.tenant_id} className="align-top">
                      <td className="py-3 pr-3">
                        <p className="font-medium text-stone-900">{c.tenant_name}</p>
                        <p className="text-xs text-stone-400">Joined {shortDate(c.signed_up_at)}</p>
                        {c.referral_status === "pending" && (
                          <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                            Pending approval
                          </span>
                        )}
                        {alert && (
                          <p className={`mt-1 text-xs ${alert.tone === "warn" ? "text-amber-700" : "text-emerald-700"}`}>
                            {alert.text}
                          </p>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-stone-700">{c.plan_name ?? c.plan_key}</td>
                      <td className="py-3 pr-3 text-right tabular-nums text-stone-700">
                        {c.visits_this_month} / {c.visits_last_month}
                      </td>
                      <td className="py-3 pr-3 text-stone-700">{shortDate(c.last_visit_at)}</td>
                      <td className="py-3 pr-3 text-right tabular-nums text-stone-700">
                        {rand(c.billed_cents)} / {rand(c.paid_cents)}
                      </td>
                      <td className="py-3 text-right tabular-nums">
                        <p className="font-medium text-stone-900">{rand(myTotal)}</p>
                        <p className="text-xs text-stone-400">
                          {rand(c.commission_pending_cents + c.commission_approved_cents)} unpaid
                        </p>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Commission history</p>
          {commissions.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">
              Nothing yet. Commission appears once a client&apos;s paid invoice is recorded.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-stone-100 text-sm">
              {commissions.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className="text-stone-800">
                      {c.kind === "bounty" ? "Sign-up bounty" : c.kind === "recurring" ? "Monthly commission" : c.kind === "clawback" ? "Reversal" : "Adjustment"}
                      {c.tenant_id && nameByTenant.get(c.tenant_id) ? ` · ${nameByTenant.get(c.tenant_id)}` : ""}
                    </p>
                    <p className="text-xs text-stone-400">
                      {shortDate(c.created_at)}
                      {c.status === "pending" ? ` · payable after ${shortDate(c.payable_after)}` : ""}
                      {c.note ? ` · ${c.note}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`tabular-nums ${c.amount_cents < 0 ? "text-red-700" : "text-stone-900"}`}>{rand(c.amount_cents)}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[c.status] ?? ""}`}>{c.status}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
          <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Payouts</p>
          {payouts.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">No payouts yet. Payouts are made monthly by EFT.</p>
          ) : (
            <ul className="mt-3 divide-y divide-stone-100 text-sm">
              {payouts.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className="text-stone-800">{p.period}</p>
                    <p className="text-xs text-stone-400">
                      {p.status === "paid" ? `Paid ${shortDate(p.paid_at)}${p.payment_reference ? ` · ref ${p.payment_reference}` : ""}` : "Being prepared"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular-nums text-stone-900">{rand(p.total_cents)}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "paid" ? STATUS_STYLE.paid : STATUS_STYLE.pending}`}>
                      {p.status === "paid" ? "paid" : "on its way"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="text-xs text-stone-400">
        Commission is earned on invoices your clients have actually paid, with a 30-day hold before it becomes payable.
        Free-plan clients don&apos;t earn commission until they upgrade.
      </p>
    </main>
  )
}
