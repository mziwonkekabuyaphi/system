"use client"

// app/demo/SetupPayroll.tsx
//
// A playable copy of the payroll side of the dashboard: the "Employer details" card
// (EmployerPanels.tsx), the hours-to-pay table, and a payslip. Hours come from the
// shifts clocked on the Clock-in tab, rates from the Staff tab, and the payslip uses the
// name, logo and colours from the Branding tab. PAYE and UIF are ESTIMATES (see the note
// in setupData.ts for the tax year and what is left out).

import { useState } from "react"
import admin from "./adminDemo.module.css"
import s from "./setupDemo.module.css"
import { Field } from "./SetupBits"
import { useSetup } from "./SetupContext"
import {
  PAY_PERIOD_DAYS,
  PRIMARY_REBATE,
  TAX_YEAR_LABEL,
  fmtDay,
  money,
  payFigures,
  readableTextOn,
  round2,
  type Employer,
  type StaffMember,
} from "./setupData"

const EMPLOYER_FIELDS: Array<{ key: keyof Employer; label: string; placeholder: string }> = [
  { key: "legalName", label: "Legal name", placeholder: "e.g. Mzansi Cuts (Pty) Ltd" },
  { key: "tradingName", label: "Trading name", placeholder: "Only if different from the legal name" },
  { key: "registrationNumber", label: "Registration number", placeholder: "e.g. 2019/123456/07" },
  { key: "payeReference", label: "PAYE reference number", placeholder: "Your SARS employer PAYE reference" },
  { key: "uifReference", label: "UIF reference number", placeholder: "e.g. U12345678" },
  { key: "sdlReference", label: "SDL reference number", placeholder: "e.g. L123456789" },
]

const BANK_TYPES: Record<string, string> = { cheque: "Cheque / current", savings: "Savings", transmission: "Transmission" }

export function SetupPayroll() {
  const { staff, shifts, employer, setEmployer, brand, now } = useSetup()
  const [pickedId, setPickedId] = useState<string | null>(null)

  const to = now()
  const from = to - PAY_PERIOD_DAYS * 86400000
  const rows = staff.map((m) => {
    const ms = shifts.filter((sh) => sh.staffId === m.id && sh.end !== null && sh.end >= from).reduce((sum, sh) => sum + ((sh.end as number) - sh.start), 0)
    const hours = round2(ms / 3600000)
    return { member: m, hours, ...payFigures(hours, m.hourlyRate) }
  })
  const totals = rows.reduce(
    (t, r) => ({ hours: t.hours + r.hours, gross: t.gross + r.gross, paye: t.paye + r.paye, uif: t.uif + r.uif, net: t.net + r.net, employerUif: t.employerUif + r.employerUif }),
    { hours: 0, gross: 0, paye: 0, uif: 0, net: 0, employerUif: 0 },
  )
  const stillOpen = shifts.filter((sh) => sh.end === null).length

  const picked: StaffMember | undefined = staff.find((m) => m.id === pickedId) ?? staff[0]
  const slip = picked ? rows.find((r) => r.member.id === picked.id) : undefined
  const headBg = brand.primary
  const headText = readableTextOn(headBg)
  const employerName = employer.legalName.trim() || brand.name.trim() || "Your business"

  return (
    <div className={s.stack}>
      <div className={admin.aCard}>
        <span className={admin.aCardTitle}>Employer details</span>
        <span className={admin.aCardSub}>Printed on staff payslips. Your address, phone and email come from your contact details.</span>
        <div className={`${admin.aFields} ${admin.aPair}`}>
          {EMPLOYER_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              {(id) => <input id={id} className={admin.aInput} value={employer[f.key]} placeholder={f.placeholder} maxLength={120} autoComplete="off" onChange={(e) => setEmployer({ [f.key]: e.target.value })} />}
            </Field>
          ))}
        </div>
      </div>

      <div className={admin.aCard}>
        <span className={admin.aCardTitle}>This week’s pay</span>
        <span className={admin.aCardSub}>
          {fmtDay(from)} to {fmtDay(to)}. Only finished shifts count: hours are added up when someone clocks out.
          {stillOpen > 0 ? ` ${stillOpen} ${stillOpen === 1 ? "person is" : "people are"} still clocked in.` : ""}
        </span>

        {staff.length === 0 ? (
          <span className={admin.aNote}>Add staff on the Staff tab and their pay shows up here.</span>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Hours</th>
                  <th>Rate</th>
                  <th>Gross</th>
                  <th>PAYE</th>
                  <th>UIF</th>
                  <th>Net pay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member.id} className={picked?.id === r.member.id ? s.trOn : undefined}>
                    <td>
                      {r.member.name}
                      {!r.member.active && <span className={s.offTag}>Inactive</span>}
                    </td>
                    <td>{r.hours.toFixed(2)}</td>
                    <td>{r.member.hourlyRate === null ? <span className={s.noRate}>Set a rate</span> : money(r.member.hourlyRate)}</td>
                    <td>{money(r.gross)}</td>
                    <td>{money(r.paye)}</td>
                    <td>{money(r.uif)}</td>
                    <td className={s.strong}>{money(r.net)}</td>
                    <td>
                      <button type="button" className={s.link} onClick={() => setPickedId(r.member.id)}>
                        Payslip
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td>{totals.hours.toFixed(2)}</td>
                  <td />
                  <td>{money(round2(totals.gross))}</td>
                  <td>{money(round2(totals.paye))}</td>
                  <td>{money(round2(totals.uif))}</td>
                  <td className={s.strong}>{money(round2(totals.net))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <span className={`${admin.aNote} ${s.msgGap}`}>
          Estimates only. PAYE uses the {TAX_YEAR_LABEL} SARS tax tables with the {money(PRIMARY_REBATE)} primary rebate, and weekly pay is worked out as a yearly equivalent. UIF is 1% of pay,
          up to the monthly ceiling. Medical credits, retirement fund contributions and age rebates aren’t included. Employer UIF for the week: {money(round2(totals.employerUif))}.
        </span>
      </div>

      {picked && slip && (
        <div className={s.slip}>
          <div className={s.slipHead} style={{ background: headBg, color: headText }}>
            {brand.logo && (
              // eslint-disable-next-line @next/next/no-img-element -- a local data: URL from the visitor's own file
              <img src={brand.logo} alt="" className={s.slipLogo} />
            )}
            <span className={s.slipHeadText}>
              <span className={s.slipBrand}>{employerName}</span>
              <span className={s.slipTitle}>
                Payslip · {fmtDay(from)} to {fmtDay(to)}
              </span>
            </span>
          </div>

          <div className={s.slipCols}>
            <div className={s.slipBlock}>
              <span className={s.slipLabel}>Employer</span>
              <span>{employerName}</span>
              {employer.tradingName.trim() && <span>Trading as {employer.tradingName.trim()}</span>}
              {employer.registrationNumber.trim() && <span>Reg. {employer.registrationNumber.trim()}</span>}
              {employer.payeReference.trim() && <span>PAYE ref. {employer.payeReference.trim()}</span>}
              {employer.uifReference.trim() && <span>UIF ref. {employer.uifReference.trim()}</span>}
              {employer.sdlReference.trim() && <span>SDL ref. {employer.sdlReference.trim()}</span>}
            </div>
            <div className={s.slipBlock}>
              <span className={s.slipLabel}>Employee</span>
              <span className={s.strong}>{picked.name}</span>
              {picked.jobTitle && <span>{picked.jobTitle}</span>}
              {picked.employeeNumber && <span>Emp. no. {picked.employeeNumber}</span>}
              {picked.idNumberLast4 && <span>ID ****{picked.idNumberLast4}</span>}
              {picked.taxNumber && <span>Tax no. {picked.taxNumber}</span>}
              {picked.bankName && (
                <span>
                  {picked.bankName}
                  {picked.bankAccountType ? ` ${BANK_TYPES[picked.bankAccountType]}` : ""}
                  {picked.bankAccountLast4 ? ` ****${picked.bankAccountLast4}` : ""}
                </span>
              )}
            </div>
          </div>

          <div className={s.slipLines}>
            <div className={s.slipLine}>
              <span>
                Hours worked ({slip.hours.toFixed(2)} × {picked.hourlyRate === null ? "no rate" : money(picked.hourlyRate)})
              </span>
              <span>{money(slip.gross)}</span>
            </div>
            <div className={s.slipLine}>
              <span className={s.slipMuted}>PAYE (estimate)</span>
              <span className={s.slipMuted}>− {money(slip.paye)}</span>
            </div>
            <div className={s.slipLine}>
              <span className={s.slipMuted}>UIF 1%</span>
              <span className={s.slipMuted}>− {money(slip.uif)}</span>
            </div>
            <div className={`${s.slipLine} ${s.slipNet}`}>
              <span>Net pay</span>
              <span>{money(slip.net)}</span>
            </div>
          </div>
          <span className={s.slipFoot}>
            Estimate for the demo. {!brand.removePoweredBy ? "Powered by ZozoQueue" : ""}
          </span>
        </div>
      )}
    </div>
  )
}
