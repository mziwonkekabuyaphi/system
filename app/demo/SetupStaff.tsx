"use client"

// app/demo/SetupStaff.tsx
//
// A playable copy of the Staff tab (StaffManager.tsx): who is clocked in right now, the
// staff list with Edit / Deactivate / Delete, and the add-or-edit form with the payroll
// details. As in the real admin, only the last 4 characters of an ID or bank account are
// kept, and a blank ID / account box means "leave what is saved". Staff added here can
// clock in on the pad in the next tab.

import { useState, type FormEvent } from "react"
import admin from "./adminDemo.module.css"
import s from "./setupDemo.module.css"
import { Field } from "./SetupBits"
import { useSetup } from "./SetupContext"
import { fmtDuration, fmtTime, type BankAccountType, type StaffInput, type StaffMember } from "./setupData"

type Form = Omit<StaffInput, "hourlyRate"> & { hourlyRate: string }

const EMPTY: Form = {
  name: "",
  jobTitle: "",
  employeeNumber: "",
  startDate: "",
  hourlyRate: "",
  pin: "",
  phone: "",
  email: "",
  idNumber: "",
  taxNumber: "",
  bankName: "",
  bankAccountType: "",
  bankAccountNumber: "",
  bankBranchCode: "",
}

function formFrom(m: StaffMember): Form {
  return {
    ...EMPTY,
    name: m.name,
    jobTitle: m.jobTitle,
    employeeNumber: m.employeeNumber,
    startDate: m.startDate,
    hourlyRate: m.hourlyRate === null ? "" : String(m.hourlyRate),
    pin: m.pin,
    phone: m.phone,
    email: m.email,
    taxNumber: m.taxNumber,
    bankName: m.bankName,
    bankAccountType: m.bankAccountType,
    bankBranchCode: m.bankBranchCode,
  }
}

export function SetupStaff() {
  const { staff, shifts, saveStaff, removeStaff, toggleStaff, forceClockOut, now } = useSetup()
  const [form, setForm] = useState<Form>(EMPTY)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const editing = editingId ? staff.find((m) => m.id === editingId) : undefined
  const clockedIn = shifts.filter((sh) => sh.end === null)
  const nameOf = (id: string) => staff.find((m) => m.id === id)?.name ?? "Staff"

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function startEdit(m: StaffMember) {
    setEditingId(m.id)
    setForm(formFrom(m))
    setError(null)
    setMessage(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY)
    setError(null)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    const rate = form.hourlyRate.trim() === "" ? null : Number(form.hourlyRate)
    const result = saveStaff({ ...form, hourlyRate: rate }, editingId)
    if (result.ok) {
      setMessage(editingId ? `Saved changes to ${result.name}.` : `Added ${result.name}. Try their PIN on the Clock-in tab.`)
      setEditingId(null)
      setForm(EMPTY)
    } else {
      setError(result.error)
    }
  }

  function confirmDelete(m: StaffMember) {
    removeStaff(m.id)
    setConfirmId(null)
    if (editingId === m.id) cancelEdit()
    setMessage(`Deleted ${m.name}.`)
  }

  return (
    <div className={s.stack}>
      <div className={admin.aCard}>
        <span className={admin.aCardTitle}>Currently clocked in</span>
        {clockedIn.length === 0 ? (
          <span className={admin.aCardSub}>No one’s clocked in right now. Use the Clock-in tab to clock someone in.</span>
        ) : (
          <div className={s.list}>
            {clockedIn.map((sh) => (
              <div key={sh.id} className={s.row}>
                <span className={s.rowMain}>
                  <span className={s.rowName}>{nameOf(sh.staffId)}</span>
                  <span className={s.rowSub}>
                    Since {fmtTime(sh.start)} · {fmtDuration(now() - sh.start)}
                  </span>
                </span>
                <button type="button" className={s.linkBad} onClick={() => forceClockOut(sh.id)}>
                  Force clock out
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={admin.aCard}>
        <span className={admin.aCardTitle}>Staff</span>
        <span className={admin.aCardSub}>Edit anyone, switch them off without losing their history, or delete them.</span>
        {staff.length === 0 && <span className={admin.aNote}>No staff yet. Add your first one below.</span>}
        <div className={s.list}>
          {staff.map((m) => {
            const details = [
              m.jobTitle,
              m.employeeNumber ? `Emp. no. ${m.employeeNumber}` : null,
              m.hourlyRate !== null ? `R${m.hourlyRate.toFixed(2)}/hr` : null,
              m.pin ? `PIN ${m.pin}` : "No PIN yet",
            ]
              .filter(Boolean)
              .join(" · ")
            const masked = [m.idNumberLast4 ? `ID ****${m.idNumberLast4}` : null, m.bankAccountLast4 ? `Account ****${m.bankAccountLast4}` : null]
              .filter(Boolean)
              .join(" · ")
            return (
              <div key={m.id} className={s.row}>
                <span className={s.rowMain}>
                  <span className={m.active ? s.rowName : `${s.rowName} ${s.rowOff}`}>
                    {m.name}
                    {!m.active && <span className={s.offTag}>Inactive</span>}
                  </span>
                  <span className={s.rowSub}>{details}</span>
                  {masked && <span className={s.rowMask}>{masked}</span>}
                  {confirmId === m.id && (
                    <span className={`${admin.aNote} ${admin.aNoteWarn}`}>
                      Delete {m.name} for good? This can’t be undone. To stop them working, use Deactivate instead.
                      <span className={s.confirmBtns}>
                        <button type="button" className={s.linkBad} onClick={() => confirmDelete(m)}>
                          Yes, delete
                        </button>
                        <button type="button" className={s.link} onClick={() => setConfirmId(null)}>
                          Keep
                        </button>
                      </span>
                    </span>
                  )}
                </span>
                <span className={s.rowActions}>
                  <button type="button" className={s.link} onClick={() => startEdit(m)}>
                    Edit
                  </button>
                  <button type="button" className={s.link} onClick={() => toggleStaff(m.id)}>
                    {m.active ? "Deactivate" : "Activate"}
                  </button>
                  <button type="button" className={s.linkBad} onClick={() => setConfirmId(m.id)}>
                    Delete
                  </button>
                </span>
              </div>
            )
          })}
        </div>
        {message && <span className={`${admin.aMsg} ${s.msgGap}`}>{message}</span>}
      </div>

      <form className={admin.aCard} onSubmit={submit} noValidate>
        <div className={admin.aToggle}>
          <span className={admin.aCardTitle}>{editing ? `Editing ${editing.name}` : "Add staff"}</span>
          {editing && (
            <button type="button" className={s.link} onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </div>

        <div className={`${admin.aFields} ${admin.aPair} ${s.formGap}`}>
          <Field label="Name">{(id) => <input id={id} className={admin.aInput} value={form.name} placeholder="Thabo" onChange={(e) => set("name", e.target.value)} />}</Field>
          <Field label="Job title">{(id) => <input id={id} className={admin.aInput} value={form.jobTitle} placeholder="Stylist" onChange={(e) => set("jobTitle", e.target.value)} />}</Field>
          <Field label="Employee number">
            {(id) => <input id={id} className={admin.aInput} value={form.employeeNumber} placeholder="004" maxLength={30} onChange={(e) => set("employeeNumber", e.target.value)} />}
          </Field>
          <Field label="Start date">{(id) => <input id={id} type="date" className={admin.aInput} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />}</Field>
          <Field label="Hourly rate (ZAR)">
            {(id) => <input id={id} type="number" min="0" step="0.5" className={admin.aInput} value={form.hourlyRate} placeholder="120" onChange={(e) => set("hourlyRate", e.target.value)} />}
          </Field>
          <Field label="Clock-in PIN (4-6 digits)" hint="Staff use this on the clock-in pad.">
            {(id) => (
              <input id={id} className={admin.aInput} inputMode="numeric" maxLength={6} value={form.pin} placeholder="1234" onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))} />
            )}
          </Field>
          <Field label="Phone">{(id) => <input id={id} className={admin.aInput} value={form.phone} placeholder="082 123 4567" onChange={(e) => set("phone", e.target.value)} />}</Field>
          <Field label="Email">{(id) => <input id={id} type="email" className={admin.aInput} value={form.email} placeholder="thabo@example.com" onChange={(e) => set("email", e.target.value)} />}</Field>
        </div>

        <div className={s.fieldset}>
          <span className={s.legend}>Payroll details</span>
          <div className={`${admin.aFields} ${admin.aPair}`}>
            <Field label="ID or passport number">
              {(id) => (
                <input
                  id={id}
                  className={admin.aInput}
                  autoComplete="off"
                  value={form.idNumber}
                  placeholder={editing?.idNumberLast4 ? `Saved: ****${editing.idNumberLast4} (type to replace)` : "13-digit ID or passport"}
                  onChange={(e) => set("idNumber", e.target.value)}
                />
              )}
            </Field>
            <Field label="SARS income tax number">
              {(id) => (
                <input id={id} className={admin.aInput} inputMode="numeric" autoComplete="off" value={form.taxNumber} placeholder="10 digits" onChange={(e) => set("taxNumber", e.target.value.replace(/[^\d\s]/g, ""))} />
              )}
            </Field>
            <Field label="Bank">{(id) => <input id={id} className={admin.aInput} value={form.bankName} placeholder="e.g. Capitec" maxLength={60} onChange={(e) => set("bankName", e.target.value)} />}</Field>
            <Field label="Account type">
              {(id) => (
                <select id={id} className={admin.aInput} value={form.bankAccountType} onChange={(e) => set("bankAccountType", e.target.value as BankAccountType)}>
                  <option value="">Not set</option>
                  <option value="cheque">Cheque / current</option>
                  <option value="savings">Savings</option>
                  <option value="transmission">Transmission</option>
                </select>
              )}
            </Field>
            <Field label="Account number">
              {(id) => (
                <input
                  id={id}
                  className={admin.aInput}
                  inputMode="numeric"
                  autoComplete="off"
                  value={form.bankAccountNumber}
                  placeholder={editing?.bankAccountLast4 ? `Saved: ****${editing.bankAccountLast4} (type to replace)` : "Digits only"}
                  onChange={(e) => set("bankAccountNumber", e.target.value.replace(/[^\d\s-]/g, ""))}
                />
              )}
            </Field>
            <Field label="Branch code">
              {(id) => <input id={id} className={admin.aInput} inputMode="numeric" maxLength={7} value={form.bankBranchCode} placeholder="6 digits" onChange={(e) => set("bankBranchCode", e.target.value.replace(/[^\d\s]/g, ""))} />}
            </Field>
          </div>
          <span className={admin.aHint}>Demo only: just the last 4 characters of the ID and account number are kept, and nothing leaves this page.</span>
        </div>

        {error && <span className={`${admin.aNote} ${admin.aNoteWarn}`} role="alert">{error}</span>}
        <div className={admin.aBtns}>
          <button type="submit" className={admin.aBtn}>
            {editing ? "Save changes" : "Add staff"}
          </button>
        </div>
      </form>
    </div>
  )
}
