// app/admin/StaffManager.tsx
"use client"

import { useEffect, useState, useTransition, type FormEvent } from "react"
import { addStaff, deleteStaff, forceClockOutShift, toggleStaffActive, updateStaff } from "./actions"
import { ConfirmDialog, NoticeModal, type Notice } from "./AdminModals"
import type { AdminStaff, AdminStaffInput, AdminStaffPermissions, AdminStaffShift } from "./types"
import type {
  AdminBankAccountType,
  AdminStaffPayrollDetails,
  AdminStaffPayrollDetailsInput,
} from "./payroll-types"

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
  clockInPin: string
  loginPassword: string
  hourlyRate: number | null
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
  phone: "",
  email: "",
  clockInPin: "",
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

function formFromStaff(member: AdminStaff): StaffFormState {
  return {
    name: member.name,
    jobTitle: member.jobTitle ?? "",
    // "hourlyRate" in member is false entirely (key absent) for a
    // payroll.view-less caller — see AdminStaff's doc comment. Defaulting
    // to null here is fine either way: the field simply won't render for
    // someone without payrollManage, so this value is never shown or sent.
    hourlyRate: "hourlyRate" in member ? (member.hourlyRate ?? null) : null,
    phone: member.phone ?? "",
    email: member.email ?? "",
    clockInPin: member.clockInPin ?? "",
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

export function StaffManager({
  initialStaff: staff,
  initialActiveShifts: activeShifts,
  permissions,
  tenantSlug,
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
}) {
  const [form, setForm] = useState<StaffFormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
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

  function startEdit(member: AdminStaff) {
    setEditingId(member.id)
    setForm(formFromStaff(member))
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
    const payload: AdminStaffInput = {
      name: form.name,
      jobTitle: form.jobTitle,
      phone: form.phone,
      email: form.email,
      clockInPin: form.clockInPin,
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
    }

    startSave(async () => {
      const result = isEditing ? await updateStaff(editingId!, payload) : await addStaff(payload)
      if (result.ok) {
        setForm(EMPTY_FORM)
        setEditingId(null)
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
                      "hourlyRate" in member && member.hourlyRate != null ? `R${member.hourlyRate.toFixed(2)}/hr` : null,
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
          <div>
            <label className="block text-sm text-[#8A8375]">Hourly rate (ZAR)</label>
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

          <div>
            <label className="block text-sm text-[#8A8375]">Clock-in PIN (4-6 digits)</label>
            <input
              value={form.clockInPin}
              onChange={(e) => setForm((f) => ({ ...f, clockInPin: e.target.value.replace(/\D/g, "") }))}
              placeholder="1234"
              inputMode="numeric"
              maxLength={6}
              className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
            />
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
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
