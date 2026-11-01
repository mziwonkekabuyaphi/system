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
 * Styling uses the named admin theme colours (app/theme-admin.css), so it works in both the
 * cream and the dark look, and the same building blocks as Staff / Shisha / Queue: stat tiles
 * with a red left edge, card sections, and a red glow on buttons in the dark theme.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  getBillingSummary,
  requestPlanUpgrade,
  type BillingSummary,
  type BillingStatus,
  type TenantInvoice,
  type PlanModuleInfo,
  type ShishaBillingInfo,
} from "@/app/admin/billing-actions"
import { calculateBilling, formatCents, formatCentsCompact, type BillingCalculation } from "@/lib/services/billing-calculator"
import type { Plan, PlanUsage } from "@/lib/services/plans"

const INK = "var(--color-ink)"
const MUTED = "var(--color-ink-muted)"
const LINE = "var(--color-line)"
const ACCENT = "var(--color-accent)"
const SUCCESS = "var(--color-success-alt)"
const AMBER = "var(--color-warn-alt)"

// Same look as Staff / Shisha / Queue: cards, stat tiles with a red left edge, and (dark theme only)
// a red glow on buttons and on hover.
const CARD = "rounded-lg border border-line bg-card shadow-sm"
const BTN =
  "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink transition-shadow hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
const BTN_PRIMARY =
  "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-on-primary transition-shadow hover:bg-primary-hover-strong disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:shadow-[0_4px_16px_rgba(227,6,19,0.35)]"
const NOTICE = "rounded-lg border border-line border-l-[3px] border-l-accent bg-card px-4 py-3 text-sm shadow-sm"

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const
const IconCard = () => (<svg {...iconProps}><rect x="2" y="5" width="20" height="14" rx="2.5" /><path d="M2 10h20M6 15h4" /></svg>)
const IconTag = () => (<svg {...iconProps}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>)
const IconPulse = () => (<svg {...iconProps}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>)
const IconWallet = () => (<svg {...iconProps}><path d="M4 7a2 2 0 0 1 2-2h12v4" /><path d="M4 7v10a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2Z" /><circle cx="16.5" cy="14" r="1.1" /></svg>)

function StatTile({ label, value, hint, icon }: { label: string; value: string | number; hint?: string; icon: ReactNode }) {
  return (
    <div className="relative rounded-lg border border-line border-l-[3px] border-l-accent bg-card px-4 py-3 shadow-sm">
      <span className="absolute right-3 top-3 text-ink-muted/60">{icon}</span>
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-3xl tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  )
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 font-[family-name:var(--font-admin-serif)] text-lg text-ink">
        <span className="h-4 w-[3px] rounded-full bg-accent" aria-hidden />
        {children}
      </h3>
      {aside}
    </div>
  )
}

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
      style={{ borderColor: color, color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
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

  if (loading) return <p className="text-ink-muted">Loading billing information…</p>
  if (error || !summary) return <p className="text-accent">{error ?? "Couldn't load billing information."}</p>

  const {
    currentPlan,
    usage,
    visitBreakdown,
    allPlans,
    planModules,
    pendingRequest,
    invoices,
    billingStatus,
    outstandingCents,
    products,
    shisha,
  } = summary

  // Each module is billed on its own. The plan (Free / Growth / Business) only prices Booking & Queue,
  // so a shop that runs neither (e.g. a shisha-only venue) never sees plan billing at all.
  const runsBookingQueue = products.booking || products.queue

  return (
    <div className="space-y-6">
      {runsBookingQueue ? (
        <PanelHeader currentPlan={currentPlan} billingStatus={billingStatus} usage={usage} outstandingCents={outstandingCents} />
      ) : (
        <ModulesOnlyHeader
          billingStatus={billingStatus}
          outstandingCents={outstandingCents}
          currency={shisha?.currency ?? "ZAR"}
          shisha={shisha}
        />
      )}

      {runsBookingQueue && pendingRequest && (
        <div className={`${NOTICE} text-ink`}>
          Upgrade to <span className="font-semibold capitalize">{pendingRequest.requestedPlanKey}</span> requested — we'll be
          in touch shortly.
        </div>
      )}

      {runsBookingQueue && (
        <>
          <UsageSection currentPlan={currentPlan} usage={usage} />

          <VisitBreakdownSection breakdown={visitBreakdown} />
        </>
      )}

      {shisha && <ShishaSection shisha={shisha} switchedOn={products.shisha} />}

      {runsBookingQueue && (
        <PlanComparisonSection
          allPlans={allPlans}
          planModules={planModules}
          currentPlan={currentPlan}
          pendingRequest={pendingRequest}
          onSelectUpgrade={setUpgradeTarget}
        />
      )}

      {!runsBookingQueue && !shisha && (
        <p className={`${NOTICE} text-ink-muted`}>
          No billable modules are switched on for your shop yet.
        </p>
      )}

      {invoices.length > 0 && (
        <InvoiceHistorySection
          invoices={invoices}
          expandedInvoiceId={expandedInvoiceId}
          onToggle={(id) => setExpandedInvoiceId((cur) => (cur === id ? null : id))}
        />
      )}

      {runsBookingQueue && upgradeTarget && (
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

function PageHeader({ billingStatus, subtitle }: { billingStatus: BillingStatus; subtitle: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-[family-name:var(--font-admin-serif)] text-xl text-ink">
          <span className="text-accent">
            <IconCard />
          </span>
          Billing &amp; Plans
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>
      </div>
      <StatusBadge status={billingStatus} />
    </div>
  )
}

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
  const calc = usage.currentBilling

  return (
    <div className="space-y-5">
      <PageHeader billingStatus={billingStatus} subtitle="Your plan, this month's usage, upgrades and invoices." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Current plan" value={currentPlan.name} hint={billingLine} icon={<IconTag />} />
        <StatTile
          label="Estimated bill"
          value={formatCents(calc.totalCents, currentPlan.currency)}
          hint="This month so far"
          icon={<IconCard />}
        />
        <StatTile
          label="Visits"
          value={calc.actualVisits.toLocaleString("en-ZA")}
          hint={calc.includedVisits === null ? "No visit limit" : `of ${calc.includedVisits.toLocaleString("en-ZA")} included`}
          icon={<IconPulse />}
        />
        <StatTile
          label="Outstanding"
          value={formatCents(outstandingCents, currentPlan.currency)}
          hint={outstandingCents > 0 ? "Please settle this balance" : "Nothing owing"}
          icon={<IconWallet />}
        />
      </div>
    </div>
  )
}

// ============================================================================
// Header for a shop with no Booking/Queue: no plan to show, just what it owes
// ============================================================================

function ModulesOnlyHeader({
  billingStatus,
  outstandingCents,
  currency,
  shisha,
}: {
  billingStatus: BillingStatus
  outstandingCents: number
  currency: string
  shisha: ShishaBillingInfo | null
}) {
  return (
    <div className="space-y-5">
      <PageHeader billingStatus={billingStatus} subtitle="Your modules are billed on usage, with no monthly plan fee." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Billing" value={BILLING_STATUS_LABEL[billingStatus]} hint="Usage based" icon={<IconTag />} />
        <StatTile
          label="This month"
          value={shisha ? formatCents(shisha.thisMonth.amountCents, currency) : "—"}
          hint="So far"
          icon={<IconPulse />}
        />
        <StatTile
          label="Last month"
          value={shisha ? formatCents(shisha.lastMonth.amountCents, currency) : "—"}
          icon={<IconCard />}
        />
        <StatTile
          label="Outstanding"
          value={formatCents(outstandingCents, currency)}
          hint={outstandingCents > 0 ? "Please settle this balance" : "Nothing owing"}
          icon={<IconWallet />}
        />
      </div>
    </div>
  )
}

// ============================================================================
// Shisha — billed per session and per refill, separately from the plan
// ============================================================================

function ShishaSection({ shisha, switchedOn }: { shisha: ShishaBillingInfo; switchedOn: boolean }) {
  const { currency, sessionFeeCents, refillFeeCents, thisMonth, lastMonth } = shisha
  return (
    <section className={`${CARD} p-5`}>
      <div className="flex items-baseline justify-between">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">Shisha</h3>
        <span className="text-sm text-ink-muted">Billed monthly on usage</span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        {formatCents(sessionFeeCents, currency)} per session · {formatCents(refillFeeCents, currency)} per refill
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-canvas p-4 sm:grid-cols-4">
        <UsageStat label="Sessions this month" value={thisMonth.sessions.toLocaleString("en-ZA")} />
        <UsageStat label="Refills this month" value={thisMonth.refills.toLocaleString("en-ZA")} />
        <UsageStat label="Last month" value={formatCents(lastMonth.amountCents, currency)} />
        <div className="border-t border-line pt-3 sm:border-t-0 sm:pt-0">
          <UsageStat label="This month so far" value={formatCents(thisMonth.amountCents, currency)} emphasize />
        </div>
      </dl>

      {!switchedOn && (
        <p className="mt-3 text-sm text-ink-muted">Shisha is switched off for your shop. Earlier usage is still billed.</p>
      )}
    </section>
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
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-tint-3">
      <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: USAGE_STATE_COLOR[state] }} />
    </div>
  )
}

function FreeUsage({ currentPlan, usage }: { currentPlan: Plan; usage: PlanUsage }) {
  const total = currentPlan.visitLimit ?? 0
  const state = getUsageState(usage)
  const remaining = usage.visitsRemaining ?? 0

  return (
    <section className={`${CARD} p-5`}>
      <div className="flex items-baseline justify-between">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">Free — {total} visits, once off</h3>
        <span className="text-sm text-ink-muted">R0 / month</span>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm text-ink-muted">
          <span>Visits used</span>
          <span className="font-medium text-ink">
            {usage.visitsUsed} / {total}
          </span>
        </div>
        <UsageProgressBar used={usage.visitsUsed} total={total} state={state} />
      </div>

      {state === "blocked" ? (
        <div className="mt-4 rounded-lg border border-accent/30 border-l-[3px] border-l-accent bg-accent/5 p-3">
          <p className="text-sm font-semibold text-accent">Your free visits have been used.</p>
          <p className="mt-0.5 text-sm text-accent">Upgrade to continue serving customers.</p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">
          You have <span className="font-medium text-ink">{remaining}</span> free visit{remaining === 1 ? "" : "s"}{" "}
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
    <section className={`${CARD} p-5`}>
      <div className="flex items-baseline justify-between">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">{currentPlan.name}</h3>
        <span className="text-sm text-ink-muted">{formatCentsCompact(currentPlan.priceCents, currentPlan.currency)} / month</span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{growthSummary(currentPlan, calc.perVisitRateCents, included)}</p>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm text-ink-muted">
          <span>Visits used</span>
          <span className="font-medium text-ink">
            {calc.actualVisits.toLocaleString("en-ZA")} / {included.toLocaleString("en-ZA")}
          </span>
        </div>
        <UsageProgressBar used={calc.actualVisits} total={included} state={state} />
      </div>

      {state === "overage" || calc.extraStaff > 0 ? (
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-canvas p-4 sm:grid-cols-4">
          <UsageStat label="Visits used" value={calc.actualVisits.toLocaleString("en-ZA")} />
          <UsageStat label="Included" value={included.toLocaleString("en-ZA")} />
          <UsageStat label="Additional" value={calc.overageVisits.toLocaleString("en-ZA")} />
          <UsageStat label="Overage" value={formatCents(calc.usageChargeCents, currentPlan.currency)} />
          <UsageStat
            label={`Extra staff (${calc.extraStaff})`}
            value={formatCents(calc.extraStaffFeeCents, currentPlan.currency)}
          />
          <div className="col-span-2 border-t border-line pt-3 sm:col-span-4">
            <UsageStat label="Current estimated bill" value={formatCents(calc.totalCents, currentPlan.currency)} emphasize />
          </div>
        </dl>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">
          {state === "near" ? "Getting close to your included visits. " : ""}
          Current estimated bill:{" "}
          <span className="font-medium text-ink">{formatCents(calc.totalCents, currentPlan.currency)}</span>
        </p>
      )}

      <StaffUsageRow usage={usage} />
    </section>
  )
}

function BusinessUsage({ currentPlan, usage }: { currentPlan: Plan; usage: PlanUsage }) {
  const calc = usage.currentBilling

  return (
    <section className={`${CARD} p-5`}>
      <div className="flex items-baseline justify-between">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">{currentPlan.name}</h3>
        <span className="text-sm text-ink-muted">{formatCentsCompact(currentPlan.priceCents, currentPlan.currency)} / month</span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        No visit limit · {formatCents(calc.perVisitRateCents ?? 0, currentPlan.currency)} per completed visit
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-canvas p-4 sm:grid-cols-4">
        <UsageStat label="Visits this period" value={calc.actualVisits.toLocaleString("en-ZA")} />
        <UsageStat label="Usage cost" value={formatCents(calc.usageChargeCents, currentPlan.currency)} />
        <UsageStat label="Platform fee" value={formatCents(calc.baseFeeCents, currentPlan.currency)} />
        <div className="border-t border-line pt-3 sm:border-t-0 sm:pt-0">
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
      <div className="flex items-baseline justify-between text-sm text-ink-muted">
        <span>Active staff</span>
        <span className="font-medium text-ink">
          {staffCount}
          {staffLimit !== null ? ` / ${staffLimit}` : ""}
        </span>
      </div>
      {staffLimit !== null && <UsageProgressBar used={staffCount} total={staffLimit} state={state} />}
      {state === "blocked" ? (
        <p className="mt-2 text-sm text-accent">
          You have more active staff than this plan allows. Deactivate some, or upgrade to add more.
        </p>
      ) : state === "near" ? (
        <p className="mt-2 text-sm" style={{ color: AMBER }}>
          Staff limit reached — upgrade to add more staff.
        </p>
      ) : null}
      {plan.extraStaffPriceCents !== null && extra > 0 && (
        <p className="mt-2 text-sm text-ink-muted">
          {extra} extra staff × {formatCents(plan.extraStaffPriceCents, plan.currency)} ={" "}
          <span className="font-medium text-ink">{formatCents(extra * plan.extraStaffPriceCents, plan.currency)}</span> / month
        </p>
      )}
    </div>
  )
}

function UsageStat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={emphasize ? "mt-0.5 text-lg font-semibold text-ink" : "mt-0.5 text-sm font-medium text-ink"}>
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
      <SectionTitle>Visit usage</SectionTitle>
      <div className={`mt-3 ${CARD}`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3 text-sm">
          <span className="text-ink">Completed queue visits</span>
          <span className="font-medium text-ink">{breakdown.queueVisits.toLocaleString("en-ZA")}</span>
        </div>
        <div className="flex items-center justify-between border-b border-line px-4 py-3 text-sm">
          <span className="text-ink">Completed bookings</span>
          <span className="font-medium text-ink">{breakdown.bookingVisits.toLocaleString("en-ZA")}</span>
        </div>
        <div className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="font-semibold text-ink">Total billable visits</span>
          <span className="font-semibold text-ink">{breakdown.total.toLocaleString("en-ZA")}</span>
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
      <SectionTitle>Plans</SectionTitle>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {allPlans.map((plan) => {
          const isCurrent = plan.key === currentPlan.key
          const isUpgrade = plan.priceCents > currentPlan.priceCents
          const modules = planModules[plan.key] ?? []

          return (
            <div
              key={plan.key}
              className={`${CARD} flex flex-col p-4 transition-shadow ${
                isCurrent
                  ? "border-accent border-l-[3px] [[data-admin-theme=dark]_&]:shadow-[0_0_24px_rgba(227,6,19,0.18)]"
                  : "[[data-admin-theme=dark]_&]:hover:border-accent/40 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_18px_rgba(227,6,19,0.12)]"
              }`}
            >
              <p className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">{plan.name}</p>
              <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-2xl tabular-nums text-ink">
                {plan.priceCents === 0 ? "Free" : `${formatCentsCompact(plan.priceCents, plan.currency)}/month`}
              </p>

              <ul className="mt-3 space-y-1 text-sm text-ink">
                {planStaffLines(plan).map((line) => (
                  <li key={line}>{line}</li>
                ))}
                <li>{planVisitLine(plan)}</li>
                {planRateLine(plan) && <li>{planRateLine(plan)}</li>}
              </ul>

              {modules.length > 0 && (
                <ul className="mt-4 flex-1 space-y-1.5 border-t border-line pt-3 text-sm text-ink-muted">
                  {modules.map((m) => (
                    <li key={m.key}>{m.name}</li>
                  ))}
                </ul>
              )}

              {isCurrent ? (
                <p className="mt-4 w-fit rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">Current plan</p>
              ) : isUpgrade ? (
                <button
                  onClick={() => onSelectUpgrade(plan)}
                  disabled={Boolean(pendingRequest)}
                  className={`mt-4 w-full py-2 ${BTN_PRIMARY}`}
                  type="button"
                >
                  Upgrade to {plan.name}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className={`mt-4 ${NOTICE} text-ink`}>
        <p className="font-semibold">Using your own WhatsApp number?</p>
        <p className="mt-0.5 text-ink-muted">
          You can connect your own WhatsApp number from WhatsApp settings in your admin. Meta charges its own WhatsApp
          messaging fees for that number, and you pay Meta directly. Those fees are separate from your plan and never
          appear on your ZozoQueue invoices.
        </p>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-xl [[data-admin-theme=dark]_&]:shadow-[0_0_40px_rgba(227,6,19,0.15)]">
        <h3 className="font-[family-name:var(--font-admin-serif)] text-xl text-ink">Upgrade to {targetPlan.name}</h3>
        <p className="mt-1 text-sm text-ink-muted">From {currentPlanName}. This files a request — a platform admin confirms it.</p>

        <dl className="mt-4 space-y-2 rounded-lg border border-line bg-canvas p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-muted">Base fee</dt>
            <dd className="font-medium text-ink">{formatCentsCompact(targetPlan.priceCents, targetPlan.currency)}/mo</dd>
          </div>
          {preview.extraStaff > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-muted">
                Extra staff ({preview.extraStaff} × {formatCents(targetPlan.extraStaffPriceCents ?? 0, targetPlan.currency)})
              </dt>
              <dd className="font-medium text-ink">{formatCents(preview.extraStaffFeeCents, targetPlan.currency)}/mo</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-ink-muted">Included visits</dt>
            <dd className="font-medium text-ink">
              {preview.includedVisits === null ? "No limit" : preview.includedVisits.toLocaleString("en-ZA")}
            </dd>
          </div>
          {targetPlan.pricePerVisitCents !== null && (
            <div className="flex justify-between">
              <dt className="text-ink-muted">{targetPlan.visitLimit === null ? "Per visit" : "Per additional visit"}</dt>
              <dd className="font-medium text-ink">{formatCents(targetPlan.pricePerVisitCents, targetPlan.currency)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-line pt-2">
            <dt className="text-ink-muted">At this month's usage ({visitsThisMonth.toLocaleString("en-ZA")} visits)</dt>
            <dd className="font-semibold text-ink">{formatCents(preview.totalCents, targetPlan.currency)}</dd>
          </div>
        </dl>

        {targetPlan.staffLimit !== null && staffCount > targetPlan.staffLimit && (
          <p className="mt-3 text-sm text-accent">
            You have {staffCount} active staff, but {targetPlan.name} allows {targetPlan.staffLimit}. Deactivate some before
            switching.
          </p>
        )}

        <label className="mt-4 block text-sm text-ink-muted">
          Note for the platform team (optional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-line-strong bg-card p-2 text-sm text-ink outline-none focus:border-accent"
          />
        </label>

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={BTN}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note)}
            disabled={submitting}
            className={BTN_PRIMARY}
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
      <SectionTitle>Invoice history</SectionTitle>
      <div className={`mt-3 divide-y divide-line overflow-hidden ${CARD}`}>
        {invoices.map((inv) => {
          const expanded = expandedInvoiceId === inv.id
          const color = INVOICE_STATUS_COLOR[inv.status] ?? MUTED
          return (
            <div key={inv.id}>
              <button
                type="button"
                onClick={() => onToggle(inv.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-tint"
              >
                <div>
                  <p className="text-sm font-medium text-ink">
                    {periodLabel(inv.periodStart)}
                    <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-[11px] font-normal text-ink-muted">
                      {inv.product === "shisha" ? "Shisha" : "Booking & Queue"}
                    </span>
                  </p>
                  <p className="text-xs text-ink-muted">
                    {inv.visitCount.toLocaleString("en-ZA")} {inv.product === "shisha" ? "sessions & refills" : "visits"}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-ink">{formatCents(inv.amountCents, inv.currency)}</p>
                    <p className="text-xs font-medium capitalize" style={{ color }}>
                      {inv.status}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-accent">{expanded ? "Hide" : "View"}</span>
                </div>
              </button>

              {expanded && inv.product === "shisha" && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line bg-canvas px-4 py-3 text-sm sm:grid-cols-4">
                  <UsageStat label="Sessions" value={(inv.detail?.sessions ?? 0).toLocaleString("en-ZA")} />
                  <UsageStat label="Session fees" value={formatCents(inv.detail?.session_fee_cents ?? 0, inv.currency)} />
                  <UsageStat label="Refills" value={(inv.detail?.refills ?? 0).toLocaleString("en-ZA")} />
                  <UsageStat label="Refill fees" value={formatCents(inv.detail?.refill_fee_cents ?? 0, inv.currency)} />
                  <div className="col-span-2 border-t border-line pt-2 sm:col-span-4">
                    <UsageStat label="Total" value={formatCents(inv.amountCents, inv.currency)} emphasize />
                  </div>
                </dl>
              )}

              {expanded && inv.product !== "shisha" && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line bg-canvas px-4 py-3 text-sm sm:grid-cols-4">
                  <UsageStat label="Base subscription" value={formatCents(inv.baseFeeCents, inv.currency)} />
                  <UsageStat label="Included visits" value={inv.includedVisits === null ? "No limit" : inv.includedVisits.toLocaleString("en-ZA")} />
                  <UsageStat label="Additional visits" value={inv.overageVisits.toLocaleString("en-ZA")} />
                  <UsageStat label="Rate" value={formatCents(inv.rateCents, inv.currency)} />
                  <UsageStat label="Staff billed" value={`${inv.staffCount} (${inv.includedStaff} included)`} />
                  <UsageStat label="Extra staff" value={formatCents(inv.extraStaffFeeCents, inv.currency)} />
                  <div className="col-span-2 border-t border-line pt-2 sm:col-span-4">
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
