// app/admin/staff/StaffManager.tsx
"use client"

import { useCallback, useEffect, useMemo, useState, useTransition, type FormEvent, type ReactNode } from "react"
import { addStaff, deleteStaff, forceClockOutShift, getStaffPayProfiles, resetStaffClockInPin, toggleStaffActive, updateStaff } from "../actions"
import { ConfirmDialog, NoticeModal, type Notice } from "../AdminModals"
import { StaffClockInDrawer } from "./StaffClockInDrawer"
import { StaffPayrollDrawer } from "./StaffPayrollDrawer"
import { StaffShiftsDrawer } from "../shifts/StaffShiftsDrawer"
import type { AdminClockSettings, AdminStaff, AdminStaffInput, AdminStaffPermissions, AdminStaffShift } from "../types"
import type {
  AdminBankAccountType,
  AdminHybridMode,
  AdminPayType,
  AdminStaffPayProfile,
  AdminStaffPayProfileInput,
  AdminStaffPayrollDetails,
  AdminStaffPayrollDetailsInput,
} from "../payroll-types"

// Local form shape always carries hourlyRate as a field (simplest for a
// controlled <input>), but it's only ever rendered, or sent to the
// server, when permissions.payrollManage is true — see submit() below,
// which omits the key from the AdminStaffInput payload entirely
// otherwise. AdminStaffInput.hourlyRate's own doc comment explains why
// omission (not null) is what "no permission to touch this" means.
type StaffFormState = {
  name: string
  jobTitle: string
  phone: string
  email: string
  loginPassword: string
  hourlyRate: number | null
  // How they are paid (payroll.manage only, like hourlyRate). commissionRate is
  // kept as text so a half-typed number isn't fought by the input; it's
  // validated in submit(). The server re-validates everything.
  payType: AdminPayType
  commissionRate: string
  hybridMode: AdminHybridMode
  // Non-sensitive HR fields: shown to every staff.manage user.
  employeeNumber: string
  startDate: string
  // Payroll-only fields: rendered, and sent, only when permissions.payrollManage
  // is true (same rule as hourlyRate). idNumber and bankAccountNumber are NEVER
  // prefilled: the server only ever sends their last 4 characters, so blank
  // means "leave the stored value unchanged" and typing replaces it.
  idNumber: string
  taxNumber: string
  bankName: string
  bankAccountNumber: string
  bankBranchCode: string
  bankAccountType: AdminBankAccountType | ""
}

const EMPTY_FORM: StaffFormState = {
  name: "",
  jobTitle: "",
  hourlyRate: null,
  payType: "hourly",
  commissionRate: "",
  hybridMode: "base_plus_commission",
  phone: "",
  email: "",
  loginPassword: "",
  employeeNumber: "",
  startDate: "",
  idNumber: "",
  taxNumber: "",
  bankName: "",
  bankAccountNumber: "",
  bankBranchCode: "",
  bankAccountType: "",
}

function formFromStaff(member: AdminStaff, profile?: AdminStaffPayProfile): StaffFormState {
  return {
    name: member.name,
    jobTitle: member.jobTitle ?? "",
    // "hourlyRate" in member is false entirely (key absent) for a
    // payroll.view-less caller — see AdminStaff's doc comment. Defaulting
    // to null here is fine either way: the field simply won't render for
    // someone without payrollManage, so this value is never shown or sent.
    hourlyRate: "hourlyRate" in member ? (member.hourlyRate ?? null) : null,
    payType: profile?.payType ?? "hourly",
    commissionRate: profile?.commissionRatePercent != null ? String(profile.commissionRatePercent) : "",
    hybridMode: profile?.hybridMode ?? "base_plus_commission",
    phone: member.phone ?? "",
    email: member.email ?? "",
    loginPassword: "",
    employeeNumber: member.employeeNumber ?? "",
    startDate: member.startDate ?? "",
    // "payrollDetails" in member is false (key absent) for a payroll.view-less
    // caller — see AdminStaff's doc comment — and idNumber/bankAccountNumber
    // are never prefilled (only their last 4 are ever sent to the browser).
    idNumber: "",
    taxNumber: member.payrollDetails?.taxNumber ?? "",
    bankName: member.payrollDetails?.bankName ?? "",
    bankAccountNumber: "",
    bankBranchCode: member.payrollDetails?.bankBranchCode ?? "",
    bankAccountType: member.payrollDetails?.bankAccountType ?? "",
  }
}

const PAY_TYPE_OPTIONS: Array<{ value: AdminPayType; label: string; help: string }> = [
  { value: "hourly", label: "Hourly", help: "Paid for the hours they clock in." },
  { value: "commission", label: "Commission", help: "Paid a percentage of the price of the services they do." },
  { value: "hybrid", label: "Hybrid", help: "Paid by the hour and by commission." },
]

/** The pay profile to send, or null when it hasn't changed (so an unrelated edit
 *  doesn't rewrite it or add a log line). A staff member with no saved profile is
 *  hourly, so choosing hourly for them needs no write at all. */
function changedPayProfile(form: StaffFormState, original: AdminStaffPayProfile | undefined): AdminStaffPayProfileInput | null {
  const originalType = original?.payType ?? "hourly"
  if (form.payType === "hourly") return originalType === "hourly" ? null : { payType: "hourly" }

  const rate = Number(form.commissionRate)
  const same =
    originalType === form.payType &&
    original?.commissionRatePercent === rate &&
    (form.payType !== "hybrid" || original?.hybridMode === form.hybridMode)
  if (same) return null
  return {
    payType: form.payType,
    commissionRatePercent: rate,
    hybridMode: form.payType === "hybrid" ? form.hybridMode : undefined,
  }
}

/** "R120.00/hr", "40% commission", "R120.00/hr + 30% commission". Only for callers
 *  with payroll.view (the hourlyRate key is absent for everyone else). */
function paySummary(member: AdminStaff, profile: AdminStaffPayProfile | undefined): string | null {
  if (!("hourlyRate" in member)) return null
  const hourly = member.hourlyRate != null ? `R${member.hourlyRate.toFixed(2)}/hr` : null
  const pct = profile?.commissionRatePercent != null ? `${profile.commissionRatePercent}%` : null
  switch (profile?.payType ?? "hourly") {
    case "commission":
      return pct ? `${pct} commission` : "Commission (no rate set)"
    case "hybrid":
      return profile?.hybridMode === "higher_of"
        ? `Higher of ${hourly ?? "hourly"} or ${pct ?? "commission"}`
        : `${hourly ?? "No hourly rate"} + ${pct ?? "commission"}`
    default:
      return hourly
  }
}

/** Only the payroll fields that actually changed, so an unrelated edit doesn't
 *  rewrite (or log a change to) someone's bank details. undefined = untouched,
 *  null = cleared. Returns null when nothing changed, in which case the caller
 *  omits the `payrollDetails` key entirely. */
function changedPayrollDetails(
  form: StaffFormState,
  original: AdminStaffPayrollDetails | undefined,
): AdminStaffPayrollDetailsInput | null {
  const out: AdminStaffPayrollDetailsInput = {}
  const diff = (next: string, prev: string | null | undefined) => (next.trim() !== (prev ?? "") ? next.trim() || null : undefined)

  const taxNumber = diff(form.taxNumber, original?.taxNumber)
  const bankName = diff(form.bankName, original?.bankName)
  const bankBranchCode = diff(form.bankBranchCode, original?.bankBranchCode)
  if (taxNumber !== undefined) out.taxNumber = taxNumber
  if (bankName !== undefined) out.bankName = bankName
  if (bankBranchCode !== undefined) out.bankBranchCode = bankBranchCode
  if (form.bankAccountType !== (original?.bankAccountType ?? "")) out.bankAccountType = form.bankAccountType || null
  if (form.idNumber.trim()) out.idNumber = form.idNumber.trim()
  if (form.bankAccountNumber.trim()) out.bankAccountNumber = form.bankAccountNumber.trim()

  return Object.keys(out).length ? out : null
}

// "2h 14m" — deliberately coarse (minutes, not seconds) since this is a
// glance-at-the-dashboard display, not a stopwatch.
function elapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// ---- Page chrome (Rands-style layout) ---------------------------------------
// Dark theme only: hover gives a red edge + glow and primary buttons glow red.
const BTN =
  "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink transition-shadow hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
const BTN_PRIMARY =
  "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-on-primary transition-shadow hover:bg-primary-hover-strong disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:shadow-[0_4px_16px_rgba(227,6,19,0.35)]"
const FILTER =
  "rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-ink outline-none focus:border-accent"
const ROW_BTN =
  "rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-tint hover:text-ink disabled:opacity-50"

type StaffTab = "accounts" | "attendance"

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
const IconUsers = () => (
  <Icon>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19.5c0-3.2 2.4-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M16 14.2c2.6.3 4.5 2.3 4.5 5.3" />
  </Icon>
)
const IconUserCheck = () => (
  <Icon>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19.5c0-3.2 2.4-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
    <path d="m16 11 2 2 3.5-4" />
  </Icon>
)
const IconClock = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
)
const IconTag = () => (
  <Icon>
    <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7a1 1 0 0 1 .7.3l7.6 7.6a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0l-7.6-7.6a1 1 0 0 1-.3-.7Z" />
    <circle cx="8" cy="8" r="1.2" />
  </Icon>
)
const IconSearch = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4-4" />
  </Icon>
)

function StatTile({ label, value, icon }: { label: string; value: string | number; icon: ReactNode }) {
  return (
    <div className="relative rounded-lg border border-line border-l-[3px] border-l-accent bg-card px-4 py-3 shadow-sm">
      <span className="absolute right-3 top-3 text-ink-muted/60">{icon}</span>
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-admin-serif)] text-3xl tabular-nums text-ink">{value}</p>
    </div>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

// ---- Staff clock-in URL + QR code ------------------------------------------
// Same idea as SettingsManager.tsx's KioskUrlPanel: the public, unauthenticated
// URL staff hit to clock in/out (PIN-gated on that page itself), at
// /clock/{tenantSlug} — e.g. https://system-eta-azure.vercel.app/clock/test-venue.
// origin is resolved client-side (not baked in server-side) so this reads
// correctly whether the tenant is on a custom domain or the shared one.
function StaffClockInUrlPanel({ tenantSlug }: { tenantSlug: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const clockInUrl = origin ? `${origin}/clock/${tenantSlug}` : null

  async function copyUrl() {
    if (!clockInUrl) return
    try {
      await navigator.clipboard.writeText(clockInUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — the URL
      // is already selectable in the input, so this just skips the toast.
    }
  }

  return (
    <section className="rounded-lg border border-line p-4">
      <h3 className="text-sm font-semibold text-ink">Staff clock-in URL</h3>
      <p className="mt-1 text-sm text-ink-muted">Where staff clock in and out for a shift, PIN-protected on that page.</p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={clockInUrl ?? "Loading…"}
              onFocus={(e) => e.target.select()}
              className="w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none"
            />
            <button
              type="button"
              onClick={copyUrl}
              disabled={!clockInUrl}
              className="shrink-0 border border-line-strong px-3 py-1.5 text-sm text-ink disabled:opacity-50"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-ink-muted">Print this by the staff entrance, or bookmark it on a shared tablet.</p>
        </div>

        <div className="flex flex-col items-center gap-2 border border-line p-3">
          {clockInUrl ? (
            // Same third-party QR generator as the kiosk URL panel — the
            // clock-in URL isn't sensitive on its own (the PIN gate is on
            // the page itself), so a hosted generator is fine here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(clockInUrl)}`}
              alt="QR code linking to the staff clock-in page"
              width={160}
              height={160}
            />
          ) : (
            <div className="flex h-40 w-40 items-center justify-center text-xs text-ink-muted">Loading…</div>
          )}
        </div>
      </div>
    </section>
  )
}

// Shows a freshly generated PIN exactly once. Closing it discards the PIN from the browser.
function PinRevealModal({ reveal, onClose }: { reveal: { name: string; pin: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  if (!reveal) return null

  async function copyPin() {
    try {
      await navigator.clipboard.writeText(reveal!.pin)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable; the PIN is on screen to read out.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg bg-dialog p-6 shadow-xl">
        <h3 className="text-base font-semibold text-ink">New PIN for {reveal.name}</h3>
        <p className="mt-4 text-center font-mono text-4xl tracking-[0.3em] text-ink">{reveal.pin}</p>
        <p className="mt-4 text-sm text-accent">
          This is the only time you will see it. It isn&apos;t stored anywhere readable. If it&apos;s lost, reset it again.
        </p>
        <div className="mt-6 flex items-center justify-between">
          <button type="button" onClick={copyPin} className="border border-line-strong px-3 py-1.5 text-sm text-ink">
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCopied(false)
              onClose()
            }}
            className="bg-primary px-4 py-2 text-sm text-on-primary"
          >
            I&apos;ve noted it
          </button>
        </div>
      </div>
    </div>
  )
}

export function StaffManager({
  initialStaff: staff,
  initialActiveShifts: activeShifts,
  permissions,
  tenantSlug,
  timezone,
  clockSettings,
  canCustomizeBranding,
  shiftsEnabled,
}: {
  initialStaff: AdminStaff[]
  initialActiveShifts: AdminStaffShift[]
  /** Resolved once server-side in app/admin/page.tsx (see
   *  getTenantPermissions() in lib/tenant/require-tenant-permission.ts).
   *  Every gate below is a UI convenience — the real enforcement is
   *  staff.view/staff.manage/payroll.view/payroll.manage checks in
   *  actions.ts and matching RLS policies, so a stale/tampered client
   *  bypassing this prop still can't act past what the server allows. */
  permissions: AdminStaffPermissions
  tenantSlug: string
  /** Shop timezone, needed by the Payroll drawer for pay periods. */
  timezone: string
  /** null unless the caller has settings.manage (same invariant as page.tsx). */
  clockSettings: AdminClockSettings | null
  canCustomizeBranding: boolean
  /** Shifts module on the plan (page.tsx). Also needs permissions.shiftsView. */
  shiftsEnabled: boolean
}) {
  // Right-hand overlays, same pattern as Shisha's "TV display".
  const [payrollOpen, setPayrollOpen] = useState(false)
  const [clockOpen, setClockOpen] = useState(false)
  const [shiftsOpen, setShiftsOpen] = useState(false)
  const canSeeShifts = shiftsEnabled && permissions.shiftsView
  const canSeePayroll = permissions.payrollView
  const canSeeClockSettings = permissions.settingsManage && clockSettings !== null

  const [form, setForm] = useState<StaffFormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Pay profiles come from their own payroll.view action rather than the staff list
  // payload, so the staff loader doesn't need to change.
  const [payProfiles, setPayProfiles] = useState<Record<string, AdminStaffPayProfile>>({})
  const refreshPayProfiles = useCallback(async () => {
    if (!permissions.payrollView) return
    const res = await getStaffPayProfiles()
    if (res.ok) setPayProfiles(res.profiles)
  }, [permissions.payrollView])
  useEffect(() => {
    void refreshPayProfiles()
  }, [refreshPayProfiles])
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, startSave] = useTransition()

  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [isToggling, startToggle] = useTransition()

  const [clockingOutId, setClockingOutId] = useState<string | null>(null)
  const [isClockingOut, startClockOut] = useTransition()

  const [deleteTarget, setDeleteTarget] = useState<AdminStaff | null>(null)
  const [isDeleting, startDelete] = useTransition()
  const [notice, setNotice] = useState<Notice | null>(null)

  // Page chrome: tab, list filters and the add/edit pop-up.
  const [staffTab, setStaffTab] = useState<StaffTab>("accounts")
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("")
  const [formOpen, setFormOpen] = useState(false)

  const clockedInIds = useMemo(() => new Set(activeShifts.map((sh) => sh.staffId)), [activeShifts])
  const roleOptions = useMemo(
    () => Array.from(new Set(staff.map((m) => m.jobTitle?.trim()).filter((r): r is string => !!r))).sort((a, b) => a.localeCompare(b)),
    [staff],
  )
  const filteredStaff = useMemo(() => {
    const q = search.trim().toLowerCase()
    return staff.filter((m) => {
      if (roleFilter && (m.jobTitle?.trim() ?? "") !== roleFilter) return false
      if (statusFilter === "active" && !m.active) return false
      if (statusFilter === "inactive" && m.active) return false
      if (!q) return true
      return [m.name, m.email, m.phone, m.jobTitle, m.employeeNumber].some((v) => v?.toLowerCase().includes(q))
    })
  }, [staff, search, roleFilter, statusFilter])
  const filtersActive = search.trim() !== "" || roleFilter !== "" || statusFilter !== ""

  const isEditing = editingId !== null
  const editingMember = editingId ? (staff.find((m) => m.id === editingId) ?? null) : null

  const [resetTarget, setResetTarget] = useState<AdminStaff | null>(null)
  const [isResetting, startReset] = useTransition()
  // The new PIN, held only until the owner closes the dialog. Never stored anywhere else.
  const [revealed, setRevealed] = useState<{ name: string; pin: string } | null>(null)

  function confirmReset() {
    if (!permissions.staffManage || !resetTarget) return
    const target = resetTarget
    startReset(async () => {
      const result = await resetStaffClockInPin(target.id)
      setResetTarget(null)
      if (result.ok) setRevealed({ name: target.name, pin: result.pin })
      else setNotice({ title: "Couldn't reset PIN", message: result.error })
    })
  }

  useEffect(() => {
    if (!formOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isSaving) cancelEdit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // cancelEdit only sets state, so it is safe to leave out of the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, isSaving])

  function startEdit(member: AdminStaff) {
    setEditingId(member.id)
    setForm(formFromStaff(member, payProfiles[member.id]))
    setFormError(null)
    setFormOpen(true)
  }

  function openAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setFormOpen(true)
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setFormOpen(false)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)

    // hourlyRate is only ever included in the payload sent to the server
    // when the signed-in user has payrollManage — omitting the key
    // entirely (rather than sending null) is what tells addStaff/
    // updateStaff in actions.ts "don't touch compensation data", per
    // AdminStaffInput's doc comment. Sending it without the permission
    // would just get rejected server-side anyway, but there's no reason
    // to even try.
    // Commission and hybrid need a rate; say so here rather than after a round trip.
    if (permissions.payrollManage && form.payType !== "hourly") {
      const pct = Number(form.commissionRate)
      if (form.commissionRate.trim() === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        setFormError("Enter a commission rate between 0 and 100%.")
        return
      }
    }

    const payload: AdminStaffInput = {
      name: form.name,
      jobTitle: form.jobTitle,
      phone: form.phone,
      email: form.email,
      // Unused: PINs are never typed in. Owners use Reset PIN, which shows the new PIN once.
      clockInPin: "",
      loginPassword: form.loginPassword,
      employeeNumber: form.employeeNumber,
      startDate: form.startDate,
    }
    if (permissions.payrollManage) {
      payload.hourlyRate = form.hourlyRate
      // Same omit-the-key rule as hourlyRate: only when the caller has
      // payroll.manage AND something actually changed.
      const original = editingId ? staff.find((m) => m.id === editingId)?.payrollDetails : undefined
      const details = changedPayrollDetails(form, original)
      if (details) payload.payrollDetails = details
      const profile = changedPayProfile(form, editingId ? payProfiles[editingId] : undefined)
      if (profile) payload.payProfile = profile
    }

    startSave(async () => {
      const result = isEditing ? await updateStaff(editingId!, payload) : await addStaff(payload)
      if (result.ok) {
        setForm(EMPTY_FORM)
        setEditingId(null)
        setFormOpen(false)
        void refreshPayProfiles()
      } else {
        setFormError(result.error)
      }
    })
  }

  function toggle(member: AdminStaff) {
    if (!permissions.staffManage) return
    setTogglingId(member.id)
    startToggle(async () => {
      const result = await toggleStaffActive(member.id, !member.active)
      if (!result.ok) setNotice({ title: "Couldn't update", message: result.error })
      setTogglingId(null)
    })
  }

  function clockOut(shift: AdminStaffShift) {
    if (!permissions.staffManage) return
    setClockingOutId(shift.id)
    startClockOut(async () => {
      const result = await forceClockOutShift(shift.id)
      if (!result.ok) setNotice({ title: "Couldn't clock out", message: result.error })
      setClockingOutId(null)
    })
  }

  function confirmDelete() {
    if (!permissions.staffManage || !deleteTarget) return
    const target = deleteTarget
    startDelete(async () => {
      const result = await deleteStaff(target.id)
      setDeleteTarget(null)
      if (result.ok) {
        if (editingId === target.id) cancelEdit()
      } else {
        setNotice({ title: "Couldn't delete", message: result.error })
      }
    })
  }

  const tabBtn = (id: StaffTab, label: string, count?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={staffTab === id}
      onClick={() => setStaffTab(id)}
      className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
        staffTab === id
          ? "border-accent font-semibold text-ink"
          : "border-transparent font-medium text-ink-muted hover:text-ink"
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="ml-2 inline-block min-w-[1.25rem] rounded-full bg-accent px-1.5 text-center text-xs font-semibold text-on-color">
          {count}
        </span>
      )}
    </button>
  )

  return (
    <div className="space-y-5">
      {/* ================= Header ================= */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-[family-name:var(--font-admin-serif)] text-xl text-ink">
            <span className="text-accent">
              <IconUsers />
            </span>
            Staff Management
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Your team, who&apos;s clocked in, shifts, pay and clock-in settings.</p>
        </div>
        {(canSeePayroll || canSeeClockSettings || canSeeShifts) && (
          <div className="flex flex-wrap items-center gap-3">
            {canSeeClockSettings && (
              <button type="button" onClick={() => setClockOpen(true)} className={BTN}>
                Clock-in settings
              </button>
            )}
            {canSeeShifts && (
              <button type="button" onClick={() => setShiftsOpen(true)} className={BTN}>
                Shifts
              </button>
            )}
            {canSeePayroll && (
              <button type="button" onClick={() => setPayrollOpen(true)} className={BTN}>
                Payroll
              </button>
            )}
          </div>
        )}
      </div>

      {/* ================= Stats ================= */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total staff" value={staff.length} icon={<IconUsers />} />
        <StatTile label="Active" value={staff.filter((m) => m.active).length} icon={<IconUserCheck />} />
        {/* Active shifts are only loaded for staff.manage (see page.tsx). */}
        <StatTile label="Clocked in" value={permissions.staffManage ? activeShifts.length : "—"} icon={<IconClock />} />
        <StatTile label="Roles" value={roleOptions.length} icon={<IconTag />} />
      </div>

      {/* ================= Tabs ================= */}
      <div role="tablist" aria-label="Staff sections" className="flex flex-wrap border-b border-line">
        {tabBtn("accounts", "Staff Accounts")}
        {tabBtn("attendance", "Live Attendance", permissions.staffManage ? activeShifts.length : undefined)}
      </div>

      {/* ================= Staff accounts ================= */}
      {staffTab === "accounts" && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
                <IconSearch />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, phone…"
                aria-label="Search staff"
                className={`${FILTER} w-full pl-10`}
              />
            </div>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role" className={FILTER}>
              <option value="">All roles</option>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "inactive")}
              aria-label="Filter by status"
              className={FILTER}
            >
              <option value="">All status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            {filtersActive && (
              <button
                type="button"
                onClick={() => {
                  setSearch("")
                  setRoleFilter("")
                  setStatusFilter("")
                }}
                className="text-sm text-accent underline underline-offset-4"
              >
                Clear filters
              </button>
            )}
            {/* staff.view-only viewers get the read-only directory and nothing else. */}
            {permissions.staffManage && (
              <button type="button" onClick={openAdd} className={BTN_PRIMARY}>
                + Add staff
              </button>
            )}
          </div>

          {staff.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-5 py-10 text-center text-ink-muted">
              No staff yet{permissions.staffManage ? " — add your first one." : "."}
            </p>
          ) : filteredStaff.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-5 py-10 text-center text-ink-muted">
              No one matches these filters.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="bg-tint-2 text-xs uppercase tracking-wide text-ink-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Staff</th>
                    <th className="px-4 py-2.5 font-medium">Job title</th>
                    {canSeePayroll && <th className="px-4 py-2.5 font-medium">Pay</th>}
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    {permissions.staffManage && <th className="px-4 py-2.5 text-right font-medium">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredStaff.map((member) => {
                    const clockedIn = clockedInIds.has(member.id)
                    return (
                      <tr key={member.id} className="transition-colors hover:bg-tint-2">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span
                              aria-hidden="true"
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent ${
                                member.active ? "" : "opacity-50"
                              }`}
                            >
                              {initialsOf(member.name)}
                            </span>
                            <div className="min-w-0">
                              <p className={`truncate font-medium ${member.active ? "text-ink" : "text-ink-muted"}`}>
                                {member.name}
                                {member.hasLogin && <span className="ml-2 text-xs font-normal text-ink-muted">· can sign in</span>}
                              </p>
                              <p className="truncate text-xs text-ink-muted">
                                {[member.email, member.phone].filter(Boolean).join(" · ") || "No contact details"}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-ink">
                          {member.jobTitle || <span className="text-ink-muted">No job title</span>}
                          {member.employeeNumber && <p className="text-xs text-ink-muted">Emp. no. {member.employeeNumber}</p>}
                        </td>
                        {canSeePayroll && (
                          <td className="px-4 py-3 text-ink">
                            {/* "hourlyRate" in member: the key is only present at all when the caller has
                                payroll.view, so a staff.view-only caller's rows never carry it. */}
                            {paySummary(member, payProfiles[member.id]) ?? <span className="text-ink-muted">Not set</span>}
                            {/* Masked on purpose: only the last 4 characters of the ID and bank account ever
                                reach the browser. The key is absent unless the caller has payroll.view. */}
                            {"payrollDetails" in member &&
                              (member.payrollDetails?.idNumberLast4 || member.payrollDetails?.bankAccountLast4) && (
                                <p className="text-xs text-ink-muted">
                                  {[
                                    member.payrollDetails?.idNumberLast4 ? `ID ****${member.payrollDetails.idNumberLast4}` : null,
                                    member.payrollDetails?.bankAccountLast4 ? `Account ****${member.payrollDetails.bankAccountLast4}` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              )}
                          </td>
                        )}
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <span
                              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                member.active ? "bg-success/10 text-success" : "bg-ink/[0.07] text-ink-soft"
                              }`}
                            >
                              {member.active ? "Active" : "Inactive"}
                            </span>
                            {clockedIn && (
                              <span className="inline-block rounded-full bg-info/10 px-2.5 py-0.5 text-xs font-medium text-info">
                                Clocked in
                              </span>
                            )}
                          </div>
                        </td>
                        {permissions.staffManage && (
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              <button onClick={() => startEdit(member)} className={ROW_BTN}>
                                Edit
                              </button>
                              <button onClick={() => setResetTarget(member)} className={ROW_BTN}>
                                {member.clockInPin != null ? "Reset PIN" : "Create PIN"}
                              </button>
                              <button
                                onClick={() => toggle(member)}
                                disabled={isToggling && togglingId === member.id}
                                className={ROW_BTN}
                              >
                                {member.active ? "Deactivate" : "Activate"}
                              </button>
                              <button
                                onClick={() => setDeleteTarget(member)}
                                className="rounded-md border border-accent/30 px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/10"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ================= Live attendance ================= */}
      {staffTab === "attendance" && (
        <section className="space-y-4">
          <StaffClockInUrlPanel tenantSlug={tenantSlug} />

          {/* Currently clocked in: staff.manage only. It matches page.tsx, which doesn't even fetch
              active shifts for anyone else. */}
          {permissions.staffManage && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">
                Currently clocked in
                <span className="ml-2 font-normal text-ink-muted">{activeShifts.length}</span>
              </h3>
              {activeShifts.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong px-5 py-8 text-center text-ink-muted">
                  No one&apos;s clocked in right now.
                </p>
              ) : (
                <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {activeShifts.map((shift) => (
                    <li
                      key={shift.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line border-l-[3px] border-l-success bg-card px-4 py-3 shadow-sm"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-success" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{shift.staffName}</p>
                          <p className="text-xs text-ink-muted">
                            Since {formatClockTime(shift.loginTime)} · {elapsedSince(shift.loginTime)}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => clockOut(shift)}
                        disabled={isClockingOut && clockingOutId === shift.id}
                        className="shrink-0 rounded-md border border-accent/30 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                      >
                        {isClockingOut && clockingOutId === shift.id ? "Clocking out…" : "Force clock out"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* ================= Add / edit pop-up =================
          staff.manage only. The form itself is unchanged: same fields, same permission gates. */}
      {permissions.staffManage && formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm sm:items-center"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !isSaving) cancelEdit()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={isEditing ? `Editing ${form.name}` : "Add staff"}
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-line bg-dialog p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">
                {isEditing ? `Editing ${form.name}` : "Add new staff"}
              </h3>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={isSaving}
                aria-label="Close"
                className="rounded-md px-2 text-2xl leading-none text-ink-muted hover:text-ink disabled:opacity-50"
              >
                &times;
              </button>
            </div>
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm text-ink-muted">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Thabo"
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm text-ink-muted">Job title</label>
            <input
              value={form.jobTitle}
              onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
              placeholder="Stylist"
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm text-ink-muted">Employee number</label>
            <input
              value={form.employeeNumber}
              onChange={(e) => setForm((f) => ({ ...f, employeeNumber: e.target.value }))}
              placeholder="001"
              maxLength={30}
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm text-ink-muted">Start date</label>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          {permissions.payrollManage && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-ink-muted">How are they paid?</label>
                <div role="radiogroup" aria-label="How are they paid?" className="mt-1 flex flex-wrap gap-2">
                  {PAY_TYPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={form.payType === opt.value}
                      onClick={() => setForm((f) => ({ ...f, payType: opt.value }))}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        form.payType === opt.value
                          ? "border-ink bg-primary text-on-primary"
                          : "border-line-strong text-ink hover:bg-tint-2"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-ink-muted">{PAY_TYPE_OPTIONS.find((o) => o.value === form.payType)?.help}</p>
              </div>

              {form.payType !== "commission" && (
                <div>
                  <label className="block text-sm text-ink-muted">
                    {form.payType === "hybrid" ? "Hourly rate (ZAR), the base part" : "Hourly rate (ZAR)"}
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={form.hourlyRate ?? ""}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, hourlyRate: e.target.value === "" ? null : Number(e.target.value) }))
                    }
                    placeholder="120"
                    className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                  />
                </div>
              )}

              {form.payType !== "hourly" && (
                <div>
                  <label className="block text-sm text-ink-muted">Commission (% of the service price)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="100"
                    value={form.commissionRate}
                    onChange={(e) => setForm((f) => ({ ...f, commissionRate: e.target.value }))}
                    placeholder="40"
                    className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                  />
                  <p className="mt-1 text-xs text-ink-muted">
                    Worked out on the price you list for each service, when the customer is marked as served. Tips and
                    discounts aren&apos;t included. Walk-ins only count once a staff member is recorded as serving them.
                  </p>
                </div>
              )}

              {form.payType === "hybrid" && (
                <fieldset>
                  <legend className="text-sm text-ink-muted">How do hourly and commission combine?</legend>
                  {(
                    [
                      ["base_plus_commission", "Both: hourly pay, plus commission on top"],
                      ["higher_of", "Whichever is higher: hourly pay works as a guaranteed minimum"],
                    ] as Array<[AdminHybridMode, string]>
                  ).map(([value, label]) => (
                    <label key={value} className="mt-1 flex items-start gap-2 text-sm text-ink">
                      <input
                        type="radio"
                        name="hybridMode"
                        checked={form.hybridMode === value}
                        onChange={() => setForm((f) => ({ ...f, hybridMode: value }))}
                        className="mt-1"
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}

              {form.payType === "commission" && (
                <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-strong">
                  Employees paid only on commission must still receive at least the national minimum wage. To guarantee
                  a floor, choose Hybrid with &ldquo;whichever is higher&rdquo; and set the hourly rate. Check the rules
                  with your accountant.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm text-ink-muted">Clock-in PIN</label>
            {editingMember ? (
              <div className="mt-1 flex items-center gap-3">
                <span className="text-sm text-ink">{editingMember.clockInPin != null ? "6 digits, hidden" : "No PIN yet"}</span>
                <button type="button" onClick={() => setResetTarget(editingMember)} className="text-sm text-accent">
                  {editingMember.clockInPin != null ? "Reset PIN" : "Create PIN"}
                </button>
              </div>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">Add the person first, then create their PIN. You&apos;ll see it once.</p>
            )}
          </div>

          <div>
            <label className="block text-sm text-ink-muted">Phone</label>
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="082 123 4567"
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm text-ink-muted">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="thabo@example.com"
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          {/* Sensitive payroll details: payroll.manage only, and the
              server re-checks it. Nothing here renders for anyone else. */}
          {permissions.payrollManage && (
            <fieldset className="sm:col-span-2 grid grid-cols-1 gap-4 rounded-lg border border-line p-4 sm:grid-cols-2">
              <legend className="px-1 text-sm font-semibold text-ink">Payroll details</legend>

              <div>
                <label className="block text-sm text-ink-muted">ID or passport number</label>
                <input
                  value={form.idNumber}
                  onChange={(e) => setForm((f) => ({ ...f, idNumber: e.target.value }))}
                  placeholder={
                    editingId && staff.find((m) => m.id === editingId)?.payrollDetails?.idNumberLast4
                      ? `Saved: ****${staff.find((m) => m.id === editingId)?.payrollDetails?.idNumberLast4} (type to replace)`
                      : "13-digit ID or passport"
                  }
                  autoComplete="off"
                  className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-sm text-ink-muted">SARS income tax number</label>
                <input
                  value={form.taxNumber}
                  onChange={(e) => setForm((f) => ({ ...f, taxNumber: e.target.value.replace(/[^\d\s]/g, "") }))}
                  placeholder="10 digits"
                  inputMode="numeric"
                  autoComplete="off"
                  className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-sm text-ink-muted">Bank</label>
                <input
                  value={form.bankName}
                  onChange={(e) => setForm((f) => ({ ...f, bankName: e.target.value }))}
                  placeholder="e.g. Capitec"
                  maxLength={60}
                  className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-sm text-ink-muted">Account type</label>
                <select
                  value={form.bankAccountType}
                  onChange={(e) => setForm((f) => ({ ...f, bankAccountType: e.target.value as AdminBankAccountType | "" }))}
                  className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                >
                  <option value="">Not set</option>
                  <option value="cheque">Cheque / current</option>
                  <option value="savings">Savings</option>
                  <option value="transmission">Transmission</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-ink-muted">Account number</label>
                <input
                  value={form.bankAccountNumber}
                  onChange={(e) => setForm((f) => ({ ...f, bankAccountNumber: e.target.value.replace(/[^\d\s-]/g, "") }))}
                  placeholder={
                    editingId && staff.find((m) => m.id === editingId)?.payrollDetails?.bankAccountLast4
                      ? `Saved: ****${staff.find((m) => m.id === editingId)?.payrollDetails?.bankAccountLast4} (type to replace)`
                      : "Digits only"
                  }
                  inputMode="numeric"
                  autoComplete="off"
                  className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-sm text-ink-muted">Branch code</label>
                <input
                  value={form.bankBranchCode}
                  onChange={(e) => setForm((f) => ({ ...f, bankBranchCode: e.target.value.replace(/[^\d\s]/g, "") }))}
                  placeholder="6 digits"
                  inputMode="numeric"
                  maxLength={7}
                  autoComplete="off"
                  className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
                />
              </div>
            </fieldset>
          )}

          <div className="sm:col-span-2">
            <label className="block text-sm text-ink-muted">
              {editingId && staff.find((m) => m.id === editingId)?.hasLogin
                ? "New login password (leave blank to keep current)"
                : "Login password (optional: lets them sign in with the email above)"}
            </label>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={form.loginPassword}
              onChange={(e) => setForm((f) => ({ ...f, loginPassword: e.target.value }))}
              placeholder="At least 8 characters"
              className="mt-1 w-full border-b border-line-strong bg-transparent pb-1 text-ink outline-none focus:border-accent"
            />
          </div>

          {formError && <p className="sm:col-span-2 text-sm text-accent">{formError}</p>}

          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={cancelEdit} disabled={isSaving} className={BTN}>
              Cancel
            </button>
            <button type="submit" disabled={isSaving} className={BTN_PRIMARY}>
              {isSaving ? "Saving…" : isEditing ? "Save changes" : "Add staff"}
            </button>
          </div>
        </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this staff member?"
        message={
          <>
            <span className="font-medium text-ink">{deleteTarget?.name}</span> will be removed for good, and
            their sign-in (if they have one) will be removed too. This can&apos;t be undone. If you only want to stop
            them working, use Deactivate instead.
          </>
        }
        confirmLabel="Delete staff"
        busyLabel="Deleting…"
        isBusy={isDeleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={resetTarget !== null}
        title={resetTarget?.clockInPin != null ? "Reset this PIN?" : "Create a PIN?"}
        message={
          <>
            A new 6-digit PIN will be made for <span className="font-medium text-ink">{resetTarget?.name}</span>
            {resetTarget?.clockInPin != null ? ", and their old PIN stops working straight away" : ""}. You will see it once, so
            have a pen ready or tell them right away.
          </>
        }
        confirmLabel={resetTarget?.clockInPin != null ? "Reset PIN" : "Create PIN"}
        busyLabel="Working…"
        isBusy={isResetting}
        onConfirm={confirmReset}
        onCancel={() => setResetTarget(null)}
      />
      <PinRevealModal reveal={revealed} onClose={() => setRevealed(null)} />
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />

      {/* Payroll + clock-in settings: right-hand overlay panels */}
      {canSeePayroll && (
        <StaffPayrollDrawer open={payrollOpen} onClose={() => setPayrollOpen(false)} timezone={timezone} permissions={permissions} />
      )}
      {canSeeShifts && <StaffShiftsDrawer open={shiftsOpen} onClose={() => setShiftsOpen(false)} timezone={timezone} />}
      {canSeeClockSettings && (
        <StaffClockInDrawer
          open={clockOpen}
          onClose={() => setClockOpen(false)}
          tenantSlug={tenantSlug}
          initial={clockSettings!}
          canCustomizeBranding={canCustomizeBranding}
        />
      )}
    </div>
  )
}
