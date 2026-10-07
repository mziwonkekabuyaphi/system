"use client"

// components/admin/BillingPanel.tsx
/**
 * Plans & Billing panel for the admin dashboard.
 *
 * Redesigned for ZozoQ's real pricing model (Free / Growth / Business --
 * see lib/services/plans.ts and lib/services/billing-calculator.ts), but
 * the plumbing is unchanged from the original: still fetches its own
 * data client-side via billing-actions.ts (no props needed), still no
 * payment UI -- "Request upgrade" still just files a plan_upgrade_requests
 * row for a platform admin to action by hand.
 *
 * Every number on this page comes from getBillingSummary() -- nothing
 * here is hardcoded. calculateBilling() (the same pure function the
 * monthly invoicing cron uses) drives every "what would this cost"
 * figure, including the live upgrade-preview modal, so the dashboard and
 * the actual invoice can never show different math for the same usage.
 *
 * Design tokens are the ones this app already uses (see TodayBookings.tsx):
 * #1C1A17 ink, #8A8375 muted, #E6E1D4 line, #7A2E2E accent, #2B6F5C success.
 * Two additions, both because usage now has a third state Growth can be
 * in ("near the included limit" -- not yet billing overage, but close):
 * #A66A1E amber, and #FAF8F3 canvas for section backgrounds.
 */

import { useEffect, useMemo, useState } from "react"
import {
  getBillingSummary,
  requestPlanUpgrade,
  type BillingSummary,
  type BillingStatus,
  type TenantInvoice,
  type PlanModuleInfo,
} from "@/app/admin/billing-actions"
import { calculateBilling, formatCents, formatCentsCompact, type BillingCalculation } from "@/lib/services/billing-calculator"
import type { Plan, PlanUsage } from "@/lib/services/plans"

const INK = "#1C1A17"
const MUTED = "#8A8375"
const LINE = "#E6E1D4"
const ACCENT = "#7A2E2E"
const SUCCESS = "#2B6F5C"
const AMBER = "#A66A1E"

type UsageState = "normal" | "near" | "overage" | "blocked"

function getUsageState(usage: PlanUsage): UsageState {
  if (usage.atLimit) return "blocked"
  const { includedVisits, actualVisits } = usage.currentBilling
  if (includedVisits === null) return "normal" // Business: nothing to "approach", usage just accrues
  if (actualVisits > includedVisits) return "overage"
  if (includedVisits > 0 && actualVisits / includedVisits >= 0.8) return "near"
  return "normal"
}

const USAGE_STATE_COLOR: Record<UsageState, string> = {
  normal: SUCCESS,
  near: AMBER,
  overage: ACCENT,
  blocked: ACCENT,
}

const BILLING_STATUS_LABEL: Record<BillingStatus, string> = {
  active: "Active",
  trial_free: "Free plan",
  payment_due: "Payment due",
  overdue: "Overdue",
  cancelled: "Cancelled",
}

const BILLING_STATUS_COLOR: Record<BillingStatus, string> = {
  active: SUCCESS,
  trial_free: MUTED,
  payment_due: AMBER,
  overdue: ACCENT,
  cancelled: MUTED,
}

function StatusBadge({ status }: { status: BillingStatus }) {
  const color = BILLING_STATUS_COLOR[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
      style={{ borderColor: color, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {BILLING_STATUS_LABEL[status]}
    </span>
  )
}

function periodLabel(periodStart: string): string {
  const d = new Date(`${periodStart}T00:00:00Z`)
  return d.toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" })
}

export function BillingPanel() {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [upgradeTarget, setUpgradeTarget] = useState<Plan | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null)

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

  async function handleConfirmUpgrade(note: string) {
    if (!upgradeTarget) return
    setRequesting(true)
    const result = await requestPlanUpgrade(upgradeTarget.key, note)
    setRequesting(false)
    if (!result.ok) {
      window.alert(result.error)
      return
    }
    setUpgradeTarget(null)
    await load()
  }

  if (loading) return <p className="text-[#8A8375]">Loading billing information…</p>
  if (error || !summary) return <p className="text-[#7A2E2E]">{error ?? "Couldn't load billing information."}</p>

  const { currentPlan, usage, visitBreakdown, allPlans, planModules, pendingRequest, invoices, billingStatus, outstandingCents } =
    summary

  return (
    <div className="space-y-10">
      <PanelHeader currentPlan={currentPlan} billingStatus={billingStatus} usage={usage} outstandingCents={outstandingCents} />

      {pendingRequest && (
        <div className="rounded-xl border border-[#E6E1D4] bg-[#FAF8F3] px-4 py-3 text-sm text-[#1C1A17]">
          Upgrade to <span className="font-semibold capitalize">{pendingRequest.requestedPlanKey}</span> requested — we'll be
          in touch shortly.
        </div>
      )}

      <UsageSection currentPlan={currentPlan} usage={usage} />

      <VisitBreakdownSection breakdown={visitBreakdown} />

      <PlanComparisonSection
        allPlans={allPlans}
        planModules={planModules}
        currentPlan={currentPlan}
        pendingRequest={pendingRequest}
        onSelectUpgrade={setUpgradeTarget}
      />

      {invoices.length > 0 && (
        <InvoiceHistorySection
          invoices={invoices}
          expandedInvoiceId={expandedInvoiceId}
          onToggle={(id) => setExpandedInvoiceId((cur) => (cur === id ? null : id))}
        />
      )}

      {upgradeTarget && (
        <UpgradeConfirmModal
          targetPlan={upgradeTarget}
          currentPlanName={currentPlan.name}
          visitsThisMonth={usage.visitsThisMonth}
          staffCount={usage.staffCount}
          submitting={requesting}
          onCancel={() => setUpgradeTarget(null)}
          onConfirm={handleConfirmUpgrade}
        />
      )}
    </div>
  )
}

// ============================================================================
// Header: plan name, billing status, current billing, outstanding balance
// ============================================================================

function PanelHeader({
  currentPlan,
  billingStatus,
  usage,
  outstandingCents,
}: {
  currentPlan: Plan
  billingStatus: BillingStatus
  usage: PlanUsage
  outstandingCents: number
}) {
  const billingLine =
    currentPlan.priceCents === 0 ? "Free" : `${formatCentsCompact(currentPlan.priceCents, currentPlan.currency)} / month`

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-sm text-[#8A8375]">Current plan</p>
        <div className="mt-1 flex items-center gap-3">
          <h2 className="text-2xl font-semibold text-[#1C1A17]">{currentPlan.name}</h2>
          <StatusBadge status={billingStatus} />
        </div>
        <p className="mt-1 text-sm text-[#8A8375]">{billingLine}</p>
      </div>
      {outstandingCents > 0 && (
        <div className="rounded-xl border border-[#7A2E2E]/30 bg-[#7A2E2E]/5 px-4 py-3 text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-[#7A2E2E]">Outstanding balance</p>
          <p className="mt-0.5 text-lg font-semibold text-[#7A2E2E]">{formatCents(outstandingCents, currentPlan.currency)}</p>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Usage — three genuinely different layouts, one per plan shape
// ============================================================================

function UsageSection({ currentPlan, usage }: { currentPlan: Plan; usage: PlanUsage }) {
  if (currentPlan.visitLimitPeriod === "lifetime") return <FreeUsage currentPlan={currentPlan} usage={usage} />
  if (usage.currentBilling.includedVisits === null) return <BusinessUsage currentPlan={currentPlan} usage={usage} />
  return <GrowthUsage currentPlan={currentPlan} usage={usage} />
}

function UsageProgressBar({ used, total, state }: { used: number; total: number; state: UsageState }) {
  const pct = Math.min((used / total) * 100, 100)
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#E6E1D4]">
      <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: USAGE_STATE_COLOR[state] }} />
    </div>
  )
}

function FreeUsage({ currentPlan, usage }: { currentPlan: Plan; usage: PlanUsage }) {
  const total = currentPlan.visitLimit ?? 0
  const state = getUsageState(usage)
  const remaining = usage.visitsRemaining ?? 0

  return (
    <section className="rounded-xl border border-[#E6E1D4] p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-[#1C1A17]">Free — {total} visits, once off</h3>
        <span className="text-sm text-[#8A8375]">R0 / month</span>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm text-[#8A8375]">
          <span>Visits used</span>
          <span className="font-medium text-[#1C1A17]">
            {usage.visitsUsed} / {total}
          </span>
        </div>
        <UsageProgressBar used={usage.visitsUsed} total={total} state={state} />
      </div>

      {state === "blocked" ? (
        <div className="mt-4 rounded-lg border border-[#7A2E2E]/30 bg-[#7A2E2E]/5 p-3">
          <p className="text-sm font-semibold text-[#7A2E2E]">Your free visits have been used.</p>
          <p className="mt-0.5 text-sm text-[#7A2E2E]">Upgrade to continue serving customers.</p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-[#8A8375]">
          You have <span className="font-medium text-[#1C1A17]">{remaining}</span> free visit{remaining === 1 ? "" : "s"}{" "}
          remaining.
        </p>
      )}

      <StaffUsageRow usage={usage} />
    </section>
  )
}

function growthSummary(plan: Plan, perVisitRateCents: number | null, included: number): string {
  const parts = [`${plan.includedStaff} staff included`]
  if (plan.extraStaffPriceCents !== null) {
    parts.push(`${formatCents(plan.extraStaffPriceCents, plan.currency)} per extra staff`)
  }
  parts.push(
    plan.visitsPerStaff !== null
      ? `${plan.visitsPerStaff.toLocaleString("en-ZA")} visits per staff`
      : `${included.toLocaleString("en-ZA")} visits included`,
  )
  parts.push(`${formatCents(perVisitRateCents ?? 0, plan.currency)} per additional visit`)
  return parts.join(" · ")
}

function GrowthUsage({ currentPlan, usage }: { currentPlan: Plan; usage: PlanUsage }) {
  const calc = usage.currentBilling
  const state = getUsageState(usage)
  const included = calc.includedVisits ?? 0

  return (
    <section className="rounded-xl border border-[#E6E1D4] p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-[#1C1A17]">{currentPlan.name}</h3>
        <span className="text-sm text-[#8A8375]">{formatCentsCompact(currentPlan.priceCents, currentPlan.currency)} / month</span>
      </div>
      <p className="mt-1 text-sm text-[#8A8375]">{growthSummary(currentPlan, calc.perVisitRateCents, included)}</p>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm text-[#8A8375]">
          <span>Visits used</span>
          <span className="font-medium text-[#1C1A17]">
            {calc.actualVisits.toLocaleString("en-ZA")} / {included.toLocaleString("en-ZA")}
          </span>
        </div>
        <UsageProgressBar used={calc.actualVisits} total={included} state={state} />
      </div>

      {state === "overage" || calc.extraStaff > 0 ? (
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-[#FAF8F3] p-4 sm:grid-cols-4">
          <UsageStat label="Visits used" value={calc.actualVisits.toLocaleString("en-ZA")} />
          <UsageStat label="Included" value={included.toLocaleString("en-ZA")} />
          <UsageStat label="Additional" value={calc.overageVisits.toLocaleString("en-ZA")} />
          <UsageStat label="Overage" value={formatCents(calc.usageChargeCents, currentPlan.currency)} />
          <UsageStat
            label={`Extra staff (${calc.extraStaff})`}
            value={formatCents(calc.extraStaffFeeCents, currentPlan.currency)}
          />
          <div className="col-span-2 border-t border-[#E6E1D4] pt-3 sm:col-span-4">
            <UsageStat label="Current estimated bill" value={formatCents(calc.totalCents, currentPlan.currency)} emphasize />
          </div>
        </dl>
      ) : (
        <p className="mt-3 text-sm text-[#8A8375]">
          {state === "near" ? "Getting close to your included visits. " : ""}
          Current estimated bill:{" "}
          <span className="font-medium text-[#1C1A17]">{formatCents(calc.totalCents, currentPlan.currency)}</span>
        </p>
      )}

      <StaffUsageRow usage={usage} />
    </section>
  )
}

function BusinessUsage({ currentPlan, usage }: { currentPlan: Plan; usage: PlanUsage }) {
  const calc = usage.currentBilling

  return (
    <section className="rounded-xl border border-[#E6E1D4] p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-[#1C1A17]">{currentPlan.name}</h3>
        <span className="text-sm text-[#8A8375]">{formatCentsCompact(currentPlan.priceCents, currentPlan.currency)} / month</span>
      </div>
      <p className="mt-1 text-sm text-[#8A8375]">
        No visit limit · {formatCents(calc.perVisitRateCents ?? 0, currentPlan.currency)} per completed visit
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-[#FAF8F3] p-4 sm:grid-cols-4">
        <UsageStat label="Visits this period" value={calc.actualVisits.toLocaleString("en-ZA")} />
        <UsageStat label="Usage cost" value={formatCents(calc.usageChargeCents, currentPlan.currency)} />
        <UsageStat label="Platform fee" value={formatCents(calc.baseFeeCents, currentPlan.currency)} />
        <div className="border-t border-[#E6E1D4] pt-3 sm:border-t-0 sm:pt-0">
          <UsageStat label="Estimated total" value={formatCents(calc.totalCents, currentPlan.currency)} emphasize />
        </div>
      </dl>
    </section>
  )
}

function StaffUsageRow({ usage }: { usage: PlanUsage }) {
  const { staffCount, staffLimit, plan } = usage
  const state: UsageState =
    staffLimit === null ? "normal" : staffCount > staffLimit ? "blocked" : staffCount === staffLimit ? "near" : "normal"
  const extra = Math.max(staffCount - plan.includedStaff, 0)

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between text-sm text-[#8A8375]">
        <span>Active staff</span>
        <span className="font-medium text-[#1C1A17]">
          {staffCount}
          {staffLimit !== null ? ` / ${staffLimit}` : ""}
        </span>
      </div>
      {staffLimit !== null && <UsageProgressBar used={staffCount} total={staffLimit} state={state} />}
      {state === "blocked" ? (
        <p className="mt-2 text-sm text-[#7A2E2E]">
          You have more active staff than this plan allows. Deactivate some, or upgrade to add more.
        </p>
      ) : state === "near" ? (
        <p className="mt-2 text-sm" style={{ color: AMBER }}>
          Staff limit reached — upgrade to add more staff.
        </p>
      ) : null}
      {plan.extraStaffPriceCents !== null && extra > 0 && (
        <p className="mt-2 text-sm text-[#8A8375]">
          {extra} extra staff × {formatCents(plan.extraStaffPriceCents, plan.currency)} ={" "}
          <span className="font-medium text-[#1C1A17]">{formatCents(extra * plan.extraStaffPriceCents, plan.currency)}</span> / month
        </p>
      )}
    </div>
  )
}

function UsageStat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-[#8A8375]">{label}</dt>
      <dd className={emphasize ? "mt-0.5 text-lg font-semibold text-[#1C1A17]" : "mt-0.5 text-sm font-medium text-[#1C1A17]"}>
        {value}
      </dd>
    </div>
  )
}

// ============================================================================
// Visit usage breakdown — transparency: where these visits actually came from
// ============================================================================

function VisitBreakdownSection({ breakdown }: { breakdown: { queueVisits: number; bookingVisits: number; total: number } }) {
  if (breakdown.total === 0) return null
  return (
    <section>
      <h3 className="text-base font-semibold text-[#1C1A17]">Visit usage</h3>
      <div className="mt-3 rounded-xl border border-[#E6E1D4]">
        <div className="flex items-center justify-between border-b border-[#E6E1D4] px-4 py-3 text-sm">
          <span className="text-[#1C1A17]">Completed queue visits</span>
          <span className="font-medium text-[#1C1A17]">{breakdown.queueVisits.toLocaleString("en-ZA")}</span>
        </div>
        <div className="flex items-center justify-between border-b border-[#E6E1D4] px-4 py-3 text-sm">
          <span className="text-[#1C1A17]">Completed bookings</span>
          <span className="font-medium text-[#1C1A17]">{breakdown.bookingVisits.toLocaleString("en-ZA")}</span>
        </div>
        <div className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="font-semibold text-[#1C1A17]">Total billable visits</span>
          <span className="font-semibold text-[#1C1A17]">{breakdown.total.toLocaleString("en-ZA")}</span>
        </div>
      </div>
    </section>
  )
}

// ============================================================================
// Plan comparison — real modules only, from plan_modules/modules
// ============================================================================

function planVisitLine(plan: Plan): string {
  if (plan.visitLimitPeriod === "lifetime") return `${plan.visitLimit} visits, once off`
  if (plan.visitsPerStaff !== null) return `${plan.visitsPerStaff.toLocaleString("en-ZA")} visits per staff/month included`
  if (plan.visitLimit === null) return "No visit limit"
  return `${plan.visitLimit.toLocaleString("en-ZA")} visits/month included`
}

function planStaffLines(plan: Plan): string[] {
  if (plan.extraStaffPriceCents === null) {
    return [`${plan.includedStaff} staff member${plan.includedStaff === 1 ? "" : "s"}`]
  }
  const limit = plan.staffLimit === null ? "no limit" : `up to ${plan.staffLimit}`
  return [
    `${plan.includedStaff} staff included`,
    `${formatCents(plan.extraStaffPriceCents, plan.currency)} per extra staff (${limit})`,
  ]
}

function planRateLine(plan: Plan): string | null {
  if (plan.pricePerVisitCents === null) return null
  const label = plan.visitLimit === null ? "per visit" : "per additional visit"
  return `${formatCents(plan.pricePerVisitCents, plan.currency)} ${label}`
}

function PlanComparisonSection({
  allPlans,
  planModules,
  currentPlan,
  pendingRequest,
  onSelectUpgrade,
}: {
  allPlans: Plan[]
  planModules: Record<string, PlanModuleInfo[]>
  currentPlan: Plan
  pendingRequest: { requestedPlanKey: string; createdAt: string } | null
  onSelectUpgrade: (plan: Plan) => void
}) {
  return (
    <section>
      <h3 className="text-base font-semibold text-[#1C1A17]">Plans</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {allPlans.map((plan) => {
          const isCurrent = plan.key === currentPlan.key
          const isUpgrade = plan.priceCents > currentPlan.priceCents
          const modules = planModules[plan.key] ?? []

          return (
            <div key={plan.key} className={`flex flex-col rounded-xl border p-4 ${isCurrent ? "border-[#7A2E2E]" : "border-[#E6E1D4]"}`}>
              <p className="text-lg font-semibold text-[#1C1A17]">{plan.name}</p>
              <p className="mt-1 text-sm text-[#8A8375]">
                {plan.priceCents === 0 ? "Free" : `${formatCentsCompact(plan.priceCents, plan.currency)}/month`}
              </p>

              <ul className="mt-3 space-y-1 text-sm text-[#1C1A17]">
                {planStaffLines(plan).map((line) => (
                  <li key={line}>{line}</li>
                ))}
                <li>{planVisitLine(plan)}</li>
                {planRateLine(plan) && <li>{planRateLine(plan)}</li>}
              </ul>

              {modules.length > 0 && (
                <ul className="mt-4 flex-1 space-y-1.5 border-t border-[#E6E1D4] pt-3 text-sm text-[#8A8375]">
                  {modules.map((m) => (
                    <li key={m.key}>{m.name}</li>
                  ))}
                </ul>
              )}

              {isCurrent ? (
                <p className="mt-4 text-sm font-semibold text-[#7A2E2E]">Current plan</p>
              ) : isUpgrade ? (
                <button
                  onClick={() => onSelectUpgrade(plan)}
                  disabled={Boolean(pendingRequest)}
                  className="mt-4 w-full rounded-lg border border-[#7A2E2E] py-2 text-sm font-semibold text-[#7A2E2E] hover:bg-[#7A2E2E]/5 disabled:opacity-40"
                  type="button"
                >
                  Upgrade to {plan.name}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ============================================================================
// Upgrade confirmation — shows real pricing + a live preview against
// this tenant's actual current-month usage, via the same calculateBilling
// the invoicing cron uses. Requires an explicit confirm click.
// ============================================================================

function UpgradeConfirmModal({
  targetPlan,
  currentPlanName,
  visitsThisMonth,
  staffCount,
  submitting,
  onCancel,
  onConfirm,
}: {
  targetPlan: Plan
  currentPlanName: string
  visitsThisMonth: number
  staffCount: number
  submitting: boolean
  onCancel: () => void
  onConfirm: (note: string) => void
}) {
  const [note, setNote] = useState("")
  const preview: BillingCalculation = useMemo(() => calculateBilling(targetPlan, visitsThisMonth, staffCount), [targetPlan, visitsThisMonth, staffCount])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1A17]/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-[#E6E1D4] bg-white p-6">
        <h3 className="text-lg font-semibold text-[#1C1A17]">Upgrade to {targetPlan.name}</h3>
        <p className="mt-1 text-sm text-[#8A8375]">From {currentPlanName}. This files a request — a platform admin confirms it.</p>

        <dl className="mt-4 space-y-2 rounded-lg bg-[#FAF8F3] p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-[#8A8375]">Base fee</dt>
            <dd className="font-medium text-[#1C1A17]">{formatCentsCompact(targetPlan.priceCents, targetPlan.currency)}/mo</dd>
          </div>
          {preview.extraStaff > 0 && (
            <div className="flex justify-between">
              <dt className="text-[#8A8375]">
                Extra staff ({preview.extraStaff} × {formatCents(targetPlan.extraStaffPriceCents ?? 0, targetPlan.currency)})
              </dt>
              <dd className="font-medium text-[#1C1A17]">{formatCents(preview.extraStaffFeeCents, targetPlan.currency)}/mo</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-[#8A8375]">Included visits</dt>
            <dd className="font-medium text-[#1C1A17]">
              {preview.includedVisits === null ? "No limit" : preview.includedVisits.toLocaleString("en-ZA")}
            </dd>
          </div>
          {targetPlan.pricePerVisitCents !== null && (
            <div className="flex justify-between">
              <dt className="text-[#8A8375]">{targetPlan.visitLimit === null ? "Per visit" : "Per additional visit"}</dt>
              <dd className="font-medium text-[#1C1A17]">{formatCents(targetPlan.pricePerVisitCents, targetPlan.currency)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-[#E6E1D4] pt-2">
            <dt className="text-[#8A8375]">At this month's usage ({visitsThisMonth.toLocaleString("en-ZA")} visits)</dt>
            <dd className="font-semibold text-[#1C1A17]">{formatCents(preview.totalCents, targetPlan.currency)}</dd>
          </div>
        </dl>

        {targetPlan.staffLimit !== null && staffCount > targetPlan.staffLimit && (
          <p className="mt-3 text-sm text-[#7A2E2E]">
            You have {staffCount} active staff, but {targetPlan.name} allows {targetPlan.staffLimit}. Deactivate some before
            switching.
          </p>
        )}

        <label className="mt-4 block text-sm text-[#8A8375]">
          Note for the platform team (optional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-[#E6E1D4] p-2 text-sm text-[#1C1A17]"
          />
        </label>

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[#8A8375] hover:bg-[#FAF8F3] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note)}
            disabled={submitting}
            className="rounded-lg bg-[#7A2E2E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#7A2E2E]/90 disabled:opacity-40"
          >
            {submitting ? "Requesting…" : "Confirm request"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Invoice history — each row expands into its own base-fee/overage math
// ============================================================================

const INVOICE_STATUS_COLOR: Record<string, string> = {
  paid: SUCCESS,
  issued: AMBER,
  overdue: ACCENT,
  void: MUTED,
}

function InvoiceHistorySection({
  invoices,
  expandedInvoiceId,
  onToggle,
}: {
  invoices: TenantInvoice[]
  expandedInvoiceId: string | null
  onToggle: (id: string) => void
}) {
  return (
    <section>
      <h3 className="text-base font-semibold text-[#1C1A17]">Invoice history</h3>
      <div className="mt-3 divide-y divide-[#E6E1D4] rounded-xl border border-[#E6E1D4]">
        {invoices.map((inv) => {
          const expanded = expandedInvoiceId === inv.id
          const color = INVOICE_STATUS_COLOR[inv.status] ?? MUTED
          return (
            <div key={inv.id}>
              <button
                type="button"
                onClick={() => onToggle(inv.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[#FAF8F3]"
              >
                <div>
                  <p className="text-sm font-medium text-[#1C1A17]">{periodLabel(inv.periodStart)}</p>
                  <p className="text-xs text-[#8A8375]">{inv.visitCount.toLocaleString("en-ZA")} visits</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-[#1C1A17]">{formatCents(inv.amountCents, inv.currency)}</p>
                    <p className="text-xs font-medium" style={{ color }}>
                      {inv.status}
                    </p>
                  </div>
                  <span className="text-xs text-[#8A8375]">{expanded ? "Hide" : "View"}</span>
                </div>
              </button>

              {expanded && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-[#E6E1D4] bg-[#FAF8F3] px-4 py-3 text-sm sm:grid-cols-4">
                  <UsageStat label="Base subscription" value={formatCents(inv.baseFeeCents, inv.currency)} />
                  <UsageStat label="Included visits" value={inv.includedVisits === null ? "No limit" : inv.includedVisits.toLocaleString("en-ZA")} />
                  <UsageStat label="Additional visits" value={inv.overageVisits.toLocaleString("en-ZA")} />
                  <UsageStat label="Rate" value={formatCents(inv.rateCents, inv.currency)} />
                  <UsageStat label="Staff billed" value={`${inv.staffCount} (${inv.includedStaff} included)`} />
                  <UsageStat label="Extra staff" value={formatCents(inv.extraStaffFeeCents, inv.currency)} />
                  <div className="col-span-2 border-t border-[#E6E1D4] pt-2 sm:col-span-4">
                    <UsageStat label="Total" value={formatCents(inv.amountCents, inv.currency)} emphasize />
                  </div>
                </dl>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
