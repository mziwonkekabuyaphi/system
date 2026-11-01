// app/admin/settings/EmployerPanels.tsx
"use client"

// "Employer details" card (Settings > Shop details). Holds the legal / tax
// references printed on payslips. Styled with the same primitives as
// BusinessPanels.tsx. Loaded on demand through a settings.manage-gated server
// action (these are not part of the general settings payload: tenant_settings
// is readable by every tenant member, this table is not), and saved with
// updateEmployerDetails() in ../settings-actions.ts.
//
// Address, phone and email on the payslip come from the "Contact & defaults"
// card above, so they aren't repeated here.

import { useEffect, useState, useTransition } from "react"

import { getEmployerDetails, updateEmployerDetails } from "../settings-actions"
import type { AdminEmployerDetails } from "../payroll-types"
import { FieldRow, SaveRow, inputClass } from "./ui"

const EMPTY: AdminEmployerDetails = {
  legalName: null,
  tradingName: null,
  registrationNumber: null,
  payeReference: null,
  uifReference: null,
  sdlReference: null,
}

const FIELDS: Array<{ key: keyof AdminEmployerDetails; label: string; placeholder: string }> = [
  { key: "legalName", label: "Legal name", placeholder: "e.g. Mzansi Cuts (Pty) Ltd" },
  { key: "tradingName", label: "Trading name", placeholder: "Only if different from the legal name" },
  { key: "registrationNumber", label: "Registration number", placeholder: "e.g. 2019/123456/07" },
  { key: "payeReference", label: "PAYE reference number", placeholder: "Your SARS employer PAYE reference" },
  { key: "uifReference", label: "UIF reference number", placeholder: "e.g. U12345678" },
  { key: "sdlReference", label: "SDL reference number", placeholder: "e.g. L123456789" },
]

export function EmployerDetailsPanel() {
  const [form, setForm] = useState<AdminEmployerDetails>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void getEmployerDetails().then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.success) setForm(res.details)
      else setLoadError(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await updateEmployerDetails(form)
      setMessage(result.success ? { ok: true, text: "Saved." } : { ok: false, text: result.error })
    })
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-card p-4 shadow-sm">
      <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">Employer details</p>
      <p className="text-sm text-stone-500">
        Printed on staff payslips. Your address, phone and email come from the contact details above. Only people with
        payroll or settings access can see these.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-stone-500">Loading…</p>
      ) : loadError ? (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {loadError}
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            {FIELDS.map((f) => (
              <FieldRow key={f.key} label={f.label}>
                <input
                  className={inputClass}
                  value={form[f.key] ?? ""}
                  placeholder={f.placeholder}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value || null })}
                />
              </FieldRow>
            ))}
          </div>
          <SaveRow isPending={isPending} onSave={save} message={message} />
        </>
      )}
    </div>
  )
}
