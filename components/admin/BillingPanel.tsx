"use client"

// components/admin/BillingPanel.tsx
/**
 * Drop-in Plans & Billing panel for the admin dashboard. Fetches its own
 * data client-side via billing-actions.ts (no props needed) so it can be
 * dropped into Settings, or its own /admin/billing route, without
 * threading data down from a parent server component.
 *
 * No payment UI — "Request upgrade" just files a plan_upgrade_requests
 * row for the platform admin to action by hand. Once Yoco is connected,
 * swap the button's handler for a real checkout redirect; the rest of
 * this panel (plan cards, usage bar) stays the same.
 *
 * Colors reuse the same palette TodayBookings.tsx already uses
 * (#1C1A17 ink, #8A8375 muted, #E6E1D4 line, #7A2E2E accent) so this
 * doesn't introduce a second design language.
 */

import { useEffect, useState } from "react"
import { getBillingSummary, requestPlanUpgrade, type BillingSummary } from "@/app/admin/billing-actions"

export function BillingPanel() {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requesting, setRequesting] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const result = await getBillingSummary()
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setSummary(result.data)
  }

  useEffect(() => {
    load()
  }, [])

  async function handleRequestUpgrade(planKey: string) {
    setRequesting(planKey)
    const result = await requestPlanUpgrade(planKey)
    setRequesting(null)
    if (!result.ok) {
      window.alert(result.error)
      return
    }
    await load()
  }

  if (loading) return <p className="text-[#8A8375]">Loading billing information…</p>
  if (error || !summary) return <p className="text-[#7A2E2E]">{error ?? "Couldn't load billing information."}</p>

  const { currentPlan, usage, allPlans, pendingRequest, invoices } = summary
  const isMetered = currentPlan.pricePerVisitCents !== null

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-[1.05rem] font-semibold text-[#1C1A17]">Current plan</h3>
        <div className="mt-3 rounded-xl border border-[#E6E1D4] p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-lg font-semibold text-[#1C1A17]">{currentPlan.name}</span>
            <span className="text-sm text-[#8A8375]">
              {isMetered
                ? `R${(currentPlan.pricePerVisitCents! / 100).toFixed(2)} / visit`
                : currentPlan.priceCents === 0
                  ? "Free"
                  : `R${(currentPlan.priceCents / 100).toFixed(0)}/mo`}
            </span>
          </div>

          <div className="mt-3">
            <UsageBar
              visitsThisMonth={usage.visitsThisMonth}
              visitLimit={currentPlan.visitLimit}
              atLimit={usage.atLimit}
              estimatedAmountCents={usage.estimatedAmountCentsThisMonth}
            />
          </div>

          {usage.atLimit && (
            <p className="mt-2 text-sm text-[#7A2E2E]">
              You've reached this month's booking limit. New bookings and queue joins are paused until next month or
              you upgrade.
            </p>
          )}

          {isMetered && (
            <p className="mt-2 text-xs text-[#8A8375]">
              Billed monthly for the previous month's visits. This total is a running estimate, not a final invoice.
            </p>
          )}
        </div>
      </div>

      {pendingRequest && (
        <p className="text-sm text-[#8A8375]">
          Upgrade to {pendingRequest.requestedPlanKey} requested — we'll be in touch shortly.
        </p>
      )}

      {invoices.length > 0 && (
        <div>
          <h3 className="text-[1.05rem] font-semibold text-[#1C1A17]">Invoice history</h3>
          <ul className="mt-3 divide-y divide-[#E6E1D4] rounded-xl border border-[#E6E1D4]">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-[#1C1A17]">
                    {inv.periodStart} – {inv.periodEnd}
                  </p>
                  <p className="text-xs text-[#8A8375]">
                    {inv.visitCount} visits · R{(inv.rateCents / 100).toFixed(2)} each
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-[#1C1A17]">R{(inv.amountCents / 100).toFixed(2)}</p>
                  <p
                    className={`text-xs font-medium ${
                      inv.status === "paid" ? "text-[#2B6F5C]" : inv.status === "overdue" ? "text-[#7A2E2E]" : "text-[#8A8375]"
                    }`}
                  >
                    {inv.status}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="text-[1.05rem] font-semibold text-[#1C1A17]">All plans</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {allPlans.map((plan) => {
            const isCurrent = plan.key === currentPlan.key
            const planIsMetered = plan.pricePerVisitCents !== null
            return (
              <div
                key={plan.key}
                className={`rounded-xl border p-4 ${isCurrent ? "border-[#7A2E2E]" : "border-[#E6E1D4]"}`}
              >
                <p className="text-lg font-semibold text-[#1C1A17]">{plan.name}</p>
                <p className="mt-1 text-sm text-[#8A8375]">
                  {planIsMetered
                    ? `R${(plan.pricePerVisitCents! / 100).toFixed(2)} / visit`
                    : plan.priceCents === 0
                      ? "Free"
                      : `R${(plan.priceCents / 100).toFixed(0)}/mo`}
                </p>
                <ul className="mt-3 space-y-1 text-sm text-[#1C1A17]">
                  <li>
                    {plan.visitLimit === null
                      ? "Unlimited bookings/queue joins"
                      : `${plan.visitLimit} free bookings/queue joins per month`}
                  </li>
                  <li>{plan.staffLimit === null ? "Unlimited staff" : `Up to ${plan.staffLimit} staff`}</li>
                </ul>

                {isCurrent ? (
                  <p className="mt-4 text-sm font-semibold text-[#7A2E2E]">Current plan</p>
                ) : (
                  <button
                    onClick={() => handleRequestUpgrade(plan.key)}
                    disabled={requesting === plan.key || Boolean(pendingRequest)}
                    className="mt-4 w-full rounded-lg border border-[#7A2E2E] py-2 text-sm font-semibold text-[#7A2E2E] hover:bg-[#7A2E2E]/5 disabled:opacity-40"
                    type="button"
                  >
                    {requesting === plan.key ? "Requesting…" : "Request this plan"}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function UsageBar({
  visitsThisMonth,
  visitLimit,
  atLimit,
  estimatedAmountCents,
}: {
  visitsThisMonth: number
  visitLimit: number | null
  atLimit: boolean
  estimatedAmountCents: number | null
}) {
  if (visitLimit === null) {
    return (
      <p className="text-sm text-[#8A8375]">
        {visitsThisMonth} visits this month
        {estimatedAmountCents !== null && <> · ~R{(estimatedAmountCents / 100).toFixed(2)} so far</>}
      </p>
    )
  }

  const pct = Math.min((visitsThisMonth / visitLimit) * 100, 100)

  return (
    <div>
      <div className="flex justify-between text-sm text-[#8A8375]">
        <span>
          {visitsThisMonth} / {visitLimit} this month
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[#E6E1D4]">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: atLimit ? "#7A2E2E" : "#2B6F5C" }}
        />
      </div>
    </div>
  )
}
