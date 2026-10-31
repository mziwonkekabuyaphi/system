// app/admin/staff/StaffManager.tsx
"use client"

import { useCallback, useEffect, useState, useTransition, type FormEvent } from "react"
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
    <section className="rounded-lg border border-[#E6E1D4] p-4">
      <h3 className="text-sm font-semibold text-[#1C1A17]">Staff clock-in URL</h3>
      <p className="mt-1 text-sm text-[#8A8375]">Where staff clock in and out for a shift, PIN-protected on that page.</p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={clockInUrl ?? "Loading…"}
              onFocus={(e) => e.target.select()}
              className="w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none"
            />
            <button
              type="button"
              onClick={copyUrl}
              disabled={!clockInUrl}
              className="shrink-0 border border-[#D9D3C3] px-3 py-1.5 text-sm text-[#1C1A17] disabled:opacity-50"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-[#8A8375]">Print this by the staff entrance, or bookmark it on a shared tablet.</p>
        </div>

        <div className="flex flex-col items-center gap-2 border border-[#E6E1D4] p-3">
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
            <div className="flex h-40 w-40 items-center justify-center text-xs text-[#8A8375]">Loading…</div>
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
      <div className="w-full max-w-sm rounded-lg bg-[#FAF6EE] p-6 shadow-xl">
        <h3 className="text-base font-semibold text-[#1C1A17]">New PIN for {reveal.name}</h3>
        <p className="mt-4 text-center font-mono text-4xl tracking-[0.3em] text-[#1C1A17]">{reveal.pin}</p>
        <p className="mt-4 text-sm text-[#7A2E2E]">
          This is the only time you will see it. It isn&apos;t stored anywhere readable. If it&apos;s lost, reset it again.
        </p>
        <div className="mt-6 flex items-center justify-between">
          <button type="button" onClick={copyPin} className="border border-[#D9D3C3] px-3 py-1.5 text-sm text-[#1C1A17]">
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCopied(false)
              onClose()
            }}
            className="bg-[#1C1A17] px-4 py-2 text-sm text-[#FAF6EE]"
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

  function startEdit(member: AdminStaff) {
    setEditingId(member.id)
    setForm(formFromStaff(member, payProfiles[member.id]))
    setFormError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError(null)
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

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-admin-serif)] text-xl text-[#1C1A17]">Staff</h2>
          <p className="mt-0.5 text-sm text-[#8A8375]">Your team, who&apos;s clocked in, shifts, pay and clock-in settings.</p>
        </div>
        {(canSeePayroll || canSeeClockSettings || canSeeShifts) && (
          <div className="flex flex-wrap items-center gap-3">
            {canSeeClockSettings && (
              <button type="button" onClick={() => setClockOpen(true)} className="rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2]">
                Clock-in settings
              </button>
            )}
            {canSeeShifts && (
              <button type="button" onClick={() => setShiftsOpen(true)} className="rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2]">
                Shifts
              </button>
            )}
            {canSeePayroll && (
              <button type="button" onClick={() => setPayrollOpen(true)} className="rounded-md border border-[#D9D3C3] bg-white px-3 py-1.5 text-sm text-[#1C1A17] hover:bg-[#F3EEE2]">
                Payroll
              </button>
            )}
          </div>
        )}
      </div>

      <StaffClockInUrlPanel tenantSlug={tenantSlug} />

      {/* ================= Currently clocked in =================
          staff.manage only — matches page.tsx, which doesn't even fetch
          active shifts for anyone else. */}
      {permissions.staffManage && (
      <section>
        <h3 className="text-sm font-semibold text-[#1C1A17]">Currently clocked in</h3>
        {activeShifts.length === 0 ? (
          <p className="mt-2 text-sm text-[#8A8375]">No one's clocked in right now.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[#E6E1D4] rounded-lg border border-[#E6E1D4]">
            {activeShifts.map((shift) => (
              <li key={shift.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-[#1C1A17]">{shift.staffName}</p>
                  <p className="text-xs text-[#8A8375]">
                    Since {formatClockTime(shift.loginTime)} · {elapsedSince(shift.loginTime)}
                  </p>
                </div>
                {permissions.staffManage && (
                  <button
                    onClick={() => clockOut(shift)}
                    disabled={isClockingOut && clockingOutId === shift.id}
                    className="text-sm text-[#7A2E2E] disabled:opacity-50"
                  >
                    {isClockingOut && clockingOutId === shift.id ? "Clocking out…" : "Force clock out"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {/* ================= Staff list ================= */}
      <section>
        <h3 className="text-sm font-semibold text-[#1C1A17]">Staff</h3>
        {staff.length === 0 ? (
          <p className="mt-2 text-[#8A8375]">No staff yet — add your first one below.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[#E6E1D4]">
            {staff.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-4 py-4">
                <div>
                  <p className={`text-[1.05rem] ${member.active ? "text-[#1C1A17]" : "text-[#8A8375]"}`}>
                    {member.name}
                    {member.hasLogin && <span className="ml-2 text-xs text-[#8A8375]">· can sign in</span>}
                  </p>
                  <p className="text-sm text-[#8A8375]">
                    {[
                      member.jobTitle,
                      member.employeeNumber ? `Emp. no. ${member.employeeNumber}` : null,
                      // "hourlyRate" in member: the key is only present at
                      // all when this render's payrollView was true (see
                      // AdminStaff's doc comment) — a staff.view-only
                      // caller's member objects never carry it, so there's
                      // nothing to accidentally leak here.
                      paySummary(member, payProfiles[member.id]),
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No job title or rate set"}
                  </p>
                  {/* Masked on purpose: only the last 4 characters of the ID and
                      bank account ever reach the browser. The key is absent
                      unless the caller has payroll.view. */}
                  {"payrollDetails" in member && (member.payrollDetails?.idNumberLast4 || member.payrollDetails?.bankAccountLast4) && (
                    <p className="text-xs text-[#8A8375]">
                      {[
                        member.payrollDetails?.idNumberLast4 ? `ID ****${member.payrollDetails.idNumberLast4}` : null,
                        member.payrollDetails?.bankAccountLast4 ? `Account ****${member.payrollDetails.bankAccountLast4}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                {permissions.staffManage && (
                  <div className="flex shrink-0 items-center gap-4">
                    <button onClick={() => startEdit(member)} className="text-sm text-[#8A8375]">
                      Edit
                    </button>
                    <button onClick={() => setResetTarget(member)} className="text-sm text-[#8A8375]">
                      {member.clockInPin != null ? "Reset PIN" : "Create PIN"}
                    </button>
                    <button
                      onClick={() => toggle(member)}
                      disabled={isToggling && togglingId === member.id}
                      className="text-sm text-[#8A8375] disabled:opacity-50"
                    >
                      {member.active ? "Deactivate" : "Activate"}
                    </button>
                    <button onClick={() => setDeleteTarget(member)} className="text-sm text-[#7A2E2E]">
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ================= Add / edit form =================
          staff.view-only viewers (Tenant Staff, by default) never see
          this at all — they get the read-only directory above and
          nothing else, matching "must not modify staff records". */}
      {permissions.staffManage && (
      <section className="border-t border-[#E6E1D4] pt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#1C1A17]">{isEditing ? `Editing ${form.name}` : "Add staff"}</h3>
          {isEditing && (
            <button type="button" onClick={cancelEdit} className="text-sm text-[#8A8375]">
              Cancel
            </button>
          )}
        </div>

        <form onSubmit={submit} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm text-[#8A8375]">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Thabo"
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#8A8375]">Job title</label>
            <input
              value={form.jobTitle}
              onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
              placeholder="Stylist"
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#8A8375]">Employee number</label>
            <input
              value={form.employeeNumber}
              onChange={(e) => setForm((f) => ({ ...f, employeeNumber: e.target.value }))}
              placeholder="001"
              maxLength={30}
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#8A8375]">Start date</label>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          {permissions.payrollManage && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-[#8A8375]">How are they paid?</label>
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
                          ? "border-[#1C1A17] bg-[#1C1A17] text-[#FAF6EE]"
                          : "border-[#D9D3C3] text-[#1C1A17] hover:bg-[#F1ECDF]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-[#8A8375]">{PAY_TYPE_OPTIONS.find((o) => o.value === form.payType)?.help}</p>
              </div>

              {form.payType !== "commission" && (
                <div>
                  <label className="block text-sm text-[#8A8375]">
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
                    className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                  />
                </div>
              )}

              {form.payType !== "hourly" && (
                <div>
                  <label className="block text-sm text-[#8A8375]">Commission (% of the service price)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="100"
                    value={form.commissionRate}
                    onChange={(e) => setForm((f) => ({ ...f, commissionRate: e.target.value }))}
                    placeholder="40"
                    className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                  />
                  <p className="mt-1 text-xs text-[#8A8375]">
                    Worked out on the price you list for each service, when the customer is marked as served. Tips and
                    discounts aren&apos;t included. Walk-ins only count once a staff member is recorded as serving them.
                  </p>
                </div>
              )}

              {form.payType === "hybrid" && (
                <fieldset>
                  <legend className="text-sm text-[#8A8375]">How do hourly and commission combine?</legend>
                  {(
                    [
                      ["base_plus_commission", "Both: hourly pay, plus commission on top"],
                      ["higher_of", "Whichever is higher: hourly pay works as a guaranteed minimum"],
                    ] as Array<[AdminHybridMode, string]>
                  ).map(([value, label]) => (
                    <label key={value} className="mt-1 flex items-start gap-2 text-sm text-[#1C1A17]">
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
                <p className="rounded-lg bg-[#FBF3DC] px-3 py-2 text-xs text-[#5C4A12]">
                  Employees paid only on commission must still receive at least the national minimum wage. To guarantee
                  a floor, choose Hybrid with &ldquo;whichever is higher&rdquo; and set the hourly rate. Check the rules
                  with your accountant.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm text-[#8A8375]">Clock-in PIN</label>
            {editingMember ? (
              <div className="mt-1 flex items-center gap-3">
                <span className="text-sm text-[#1C1A17]">{editingMember.clockInPin != null ? "6 digits, hidden" : "No PIN yet"}</span>
                <button type="button" onClick={() => setResetTarget(editingMember)} className="text-sm text-[#7A2E2E]">
                  {editingMember.clockInPin != null ? "Reset PIN" : "Create PIN"}
                </button>
              </div>
            ) : (
              <p className="mt-1 text-sm text-[#8A8375]">Add the person first, then create their PIN. You&apos;ll see it once.</p>
            )}
          </div>

          <div>
            <label className="block text-sm text-[#8A8375]">Phone</label>
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="082 123 4567"
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#8A8375]">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="thabo@example.com"
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          {/* Sensitive payroll details: payroll.manage only, and the
              server re-checks it. Nothing here renders for anyone else. */}
          {permissions.payrollManage && (
            <fieldset className="sm:col-span-2 grid grid-cols-1 gap-4 rounded-lg border border-[#E6E1D4] p-4 sm:grid-cols-2">
              <legend className="px-1 text-sm font-semibold text-[#1C1A17]">Payroll details</legend>

              <div>
                <label className="block text-sm text-[#8A8375]">ID or passport number</label>
                <input
                  value={form.idNumber}
                  onChange={(e) => setForm((f) => ({ ...f, idNumber: e.target.value }))}
                  placeholder={
                    editingId && staff.find((m) => m.id === editingId)?.payrollDetails?.idNumberLast4
                      ? `Saved: ****${staff.find((m) => m.id === editingId)?.payrollDetails?.idNumberLast4} (type to replace)`
                      : "13-digit ID or passport"
                  }
                  autoComplete="off"
                  className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                />
              </div>

              <div>
                <label className="block text-sm text-[#8A8375]">SARS income tax number</label>
                <input
                  value={form.taxNumber}
                  onChange={(e) => setForm((f) => ({ ...f, taxNumber: e.target.value.replace(/[^\d\s]/g, "") }))}
                  placeholder="10 digits"
                  inputMode="numeric"
                  autoComplete="off"
                  className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                />
              </div>

              <div>
                <label className="block text-sm text-[#8A8375]">Bank</label>
                <input
                  value={form.bankName}
                  onChange={(e) => setForm((f) => ({ ...f, bankName: e.target.value }))}
                  placeholder="e.g. Capitec"
                  maxLength={60}
                  className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                />
              </div>

              <div>
                <label className="block text-sm text-[#8A8375]">Account type</label>
                <select
                  value={form.bankAccountType}
                  onChange={(e) => setForm((f) => ({ ...f, bankAccountType: e.target.value as AdminBankAccountType | "" }))}
                  className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                >
                  <option value="">Not set</option>
                  <option value="cheque">Cheque / current</option>
                  <option value="savings">Savings</option>
                  <option value="transmission">Transmission</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-[#8A8375]">Account number</label>
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
                  className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                />
              </div>

              <div>
                <label className="block text-sm text-[#8A8375]">Branch code</label>
                <input
                  value={form.bankBranchCode}
                  onChange={(e) => setForm((f) => ({ ...f, bankBranchCode: e.target.value.replace(/[^\d\s]/g, "") }))}
                  placeholder="6 digits"
                  inputMode="numeric"
                  maxLength={7}
                  autoComplete="off"
                  className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
                />
              </div>
            </fieldset>
          )}

          <div className="sm:col-span-2">
            <label className="block text-sm text-[#8A8375]">
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
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
          </div>

          {formError && <p className="sm:col-span-2 text-sm text-[#7A2E2E]">{formError}</p>}

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={isSaving}
              className="bg-[#1C1A17] px-4 py-2 text-sm text-[#FAF6EE] disabled:opacity-50"
            >
              {isSaving ? "Saving…" : isEditing ? "Save changes" : "Add staff"}
            </button>
          </div>
        </form>
      </section>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this staff member?"
        message={
          <>
            <span className="font-medium text-[#1C1A17]">{deleteTarget?.name}</span> will be removed for good, and
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
            A new 6-digit PIN will be made for <span className="font-medium text-[#1C1A17]">{resetTarget?.name}</span>
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
