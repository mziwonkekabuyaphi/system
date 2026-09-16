// app/admin/StaffManager.tsx
"use client"

import { useState, useTransition, type FormEvent } from "react"
import { addStaff, forceClockOutShift, toggleStaffActive, updateStaff } from "./actions"
import type { AdminStaff, AdminStaffInput, AdminStaffPermissions, AdminStaffShift } from "./types"

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
  hourlyRate: number | null
}

const EMPTY_FORM: StaffFormState = {
  name: "",
  jobTitle: "",
  hourlyRate: null,
  phone: "",
  email: "",
  clockInPin: "",
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
  }
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

export function StaffManager({
  initialStaff: staff,
  initialActiveShifts: activeShifts,
  permissions,
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
}) {
  const [form, setForm] = useState<StaffFormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, startSave] = useTransition()

  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [isToggling, startToggle] = useTransition()

  const [clockingOutId, setClockingOutId] = useState<string | null>(null)
  const [isClockingOut, startClockOut] = useTransition()

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
    const payload: AdminStaffInput = permissions.payrollManage
      ? { name: form.name, jobTitle: form.jobTitle, phone: form.phone, email: form.email, clockInPin: form.clockInPin, hourlyRate: form.hourlyRate }
      : { name: form.name, jobTitle: form.jobTitle, phone: form.phone, email: form.email, clockInPin: form.clockInPin }

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
      if (!result.ok) window.alert(`Couldn't update: ${result.error}`)
      setTogglingId(null)
    })
  }

  function clockOut(shift: AdminStaffShift) {
    if (!permissions.staffManage) return
    setClockingOutId(shift.id)
    startClockOut(async () => {
      const result = await forceClockOutShift(shift.id)
      if (!result.ok) window.alert(`Couldn't clock out: ${result.error}`)
      setClockingOutId(null)
    })
  }

  return (
    <div className="space-y-10">
      {/* ================= Currently clocked in ================= */}
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
                  </p>
                  <p className="text-sm text-[#8A8375]">
                    {[
                      member.jobTitle,
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
    </div>
  )
}
