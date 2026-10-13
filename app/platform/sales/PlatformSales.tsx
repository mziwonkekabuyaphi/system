// app/platform/sales/PlatformSales.tsx
"use client"

import { useState, useTransition } from "react"

import {
  addAdjustment, approveSignup, createSalespersonAccount, markPayoutPaid, reassignTenant,
  rejectSignup, runMonthlyPayouts, setSalespersonStatus, updateRule,
} from "./actions"

type Salesperson = { id: string; name: string; code: string; status: string; pending: number; approved: number; paid: number }
type Signup = { id: string; salespersonName: string; business_name: string; contact_name: string; contact_phone: string; contact_email: string | null; notes: string | null; status: string; created_at: string }
type Payout = { id: string; salespersonName: string; period: string; total_cents: number; status: string; payment_reference: string | null; paid_at: string | null }
type Rule = { id: string; plan_key: string; bounty_cents: number; recurring_rate_bps: number; effective_from: string; effective_to: string | null }
type Client = { tenantId: string; tenantName: string; salespersonId: string; salespersonName: string; status: string }

const rand = (c: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(c / 100)
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-ZA") : "—")
const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
const input = "rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
const btn = "rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
const btn2 = "rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 disabled:opacity-50"

type Tab = "signups" | "salespeople" | "clients" | "payouts" | "rules"
const TABS: Array<[Tab, string]> = [["signups", "Sign-up requests"], ["salespeople", "Salespeople"], ["clients", "Clients"], ["payouts", "Payouts"], ["rules", "Commission rules"]]

export function PlatformSales(props: { salespeople: Salesperson[]; signups: Signup[]; payouts: Payout[]; rules: Rule[]; clients: Client[] }) {
  const [tab, setTab] = useState<Tab>("signups")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()

  function run(fn: () => Promise<{ success: boolean; error?: string; message?: string }>, okText = "Saved.") {
    setMsg(null)
    start(async () => {
      const r = await fn()
      setMsg(r.success ? { ok: true, text: r.message ?? okText } : { ok: false, text: r.error ?? "Failed" })
    })
  }

  const pendingCount = props.signups.filter((s) => s.status === "pending").length

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Sales &amp; commissions</h1>
      <nav className="flex flex-wrap gap-2">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded-full px-4 py-1.5 text-sm ${tab === id ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700"}`}>
            {label}{id === "signups" && pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
        ))}
      </nav>
      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}

      {tab === "signups" && (
        <section className="space-y-3">
          {props.signups.length === 0 && <p className="text-sm text-stone-500">No requests yet.</p>}
          {props.signups.map((s) => <SignupRow key={s.id} s={s} busy={busy} run={run} />)}
        </section>
      )}

      {tab === "salespeople" && (
        <section className="space-y-4">
          <NewSalesperson busy={busy} run={run} />
          <div className={card}>
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-stone-400"><tr><th className="py-2">Name</th><th>Code</th><th>Status</th><th className="text-right">Waiting</th><th className="text-right">Payable</th><th className="text-right">Paid</th><th /></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {props.salespeople.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2">{p.name}</td><td className="font-mono">{p.code}</td><td>{p.status}</td>
                    <td className="text-right">{rand(p.pending)}</td><td className="text-right">{rand(p.approved)}</td><td className="text-right">{rand(p.paid)}</td>
                    <td className="text-right">
                      <select disabled={busy} value={p.status} className={input} onChange={(e) => run(() => setSalespersonStatus({ salespersonId: p.id, status: e.target.value as "active" | "suspended" | "terminated" }))}>
                        <option value="active">active</option><option value="suspended">suspended</option><option value="terminated">terminated</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Adjustment salespeople={props.salespeople} busy={busy} run={run} />
        </section>
      )}

      {tab === "clients" && (
        <section className={card}>
          <p className="mb-3 text-sm text-stone-500">Attribution is permanent. Only an admin can reassign, and a reason is recorded in the audit trail.</p>
          <div className="divide-y divide-stone-100">
            {props.clients.map((c) => <ClientRow key={c.tenantId} c={c} people={props.salespeople} busy={busy} run={run} />)}
            {props.clients.length === 0 && <p className="text-sm text-stone-500">No referred clients yet.</p>}
          </div>
        </section>
      )}

      {tab === "payouts" && (
        <section className="space-y-4">
          <RunPayouts busy={busy} run={run} />
          <div className={card}>
            {props.payouts.length === 0 && <p className="text-sm text-stone-500">No payouts yet.</p>}
            <div className="divide-y divide-stone-100">
              {props.payouts.map((p) => <PayoutRow key={p.id} p={p} busy={busy} run={run} />)}
            </div>
          </div>
        </section>
      )}

      {tab === "rules" && (
        <section className="space-y-4">
          <div className={card}>
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-stone-400"><tr><th className="py-2">Plan</th><th>Bounty</th><th>Recurring</th><th>From</th><th>To</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {props.rules.map((r) => (
                  <tr key={r.id} className={r.effective_to ? "text-stone-400" : ""}>
                    <td className="py-2">{r.plan_key}</td><td>{rand(r.bounty_cents)}</td><td>{r.recurring_rate_bps / 100}%</td><td>{date(r.effective_from)}</td><td>{r.effective_to ? date(r.effective_to) : "current"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <RuleForm busy={busy} run={run} />
        </section>
      )}
    </main>
  )
}

type Run = (fn: () => Promise<{ success: boolean; error?: string; message?: string }>, okText?: string) => void

function SignupRow({ s, busy, run }: { s: Signup; busy: boolean; run: Run }) {
  const [slug, setSlug] = useState(s.business_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40))
  const [plan, setPlan] = useState("free")
  const [reason, setReason] = useState("")
  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-stone-900">{s.business_name}</p>
          <p className="text-sm text-stone-600">{s.contact_name} · {s.contact_phone}{s.contact_email ? ` · ${s.contact_email}` : ""}</p>
          {s.notes && <p className="mt-1 text-sm text-stone-500">“{s.notes}”</p>}
          <p className="mt-1 text-xs text-stone-400">Referred by {s.salespersonName} · {date(s.created_at)}</p>
        </div>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs">{s.status}</span>
      </div>
      {s.status === "pending" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className={input} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="url-slug" />
          <select className={input} value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="free">Free</option><option value="growth">Growth</option><option value="business">Business</option>
          </select>
          <button className={btn} disabled={busy} onClick={() => run(() => approveSignup({ signupId: s.id, slug, plan }), "Approved: shop created.")}>Approve</button>
          <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to reject" />
          <button className={btn2} disabled={busy} onClick={() => run(() => rejectSignup({ signupId: s.id, reason }), "Rejected.")}>Reject</button>
        </div>
      )}
    </div>
  )
}

function NewSalesperson({ busy, run }: { busy: boolean; run: Run }) {
  const [f, setF] = useState({ fullName: "", email: "", password: "" })
  return (
    <div className={card}>
      <p className="mb-2 text-sm font-semibold text-stone-800">Add a salesperson</p>
      <div className="flex flex-wrap gap-2">
        <input className={input} placeholder="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <input className={input} placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input className={input} placeholder="Temporary password (8+)" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <button className={btn} disabled={busy} onClick={() => run(async () => { const r = await createSalespersonAccount(f); if (r.success) setF({ fullName: "", email: "", password: "" }); return r }, "Salesperson created.")}>Create</button>
      </div>
    </div>
  )
}

function Adjustment({ salespeople, busy, run }: { salespeople: Salesperson[]; busy: boolean; run: Run }) {
  const [sp, setSp] = useState("")
  const [rands, setRands] = useState("")
  const [note, setNote] = useState("")
  return (
    <div className={card}>
      <p className="mb-2 text-sm font-semibold text-stone-800">Manual adjustment (use a negative amount to deduct)</p>
      <div className="flex flex-wrap gap-2">
        <select className={input} value={sp} onChange={(e) => setSp(e.target.value)}>
          <option value="">Choose salesperson</option>
          {salespeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className={input} placeholder="Rands" value={rands} onChange={(e) => setRands(e.target.value)} />
        <input className={input} placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className={btn} disabled={busy || !sp} onClick={() => run(() => addAdjustment({ salespersonId: sp, rands: Number(rands), note }))}>Add</button>
      </div>
    </div>
  )
}

function ClientRow({ c, people, busy, run }: { c: Client; people: Salesperson[]; busy: boolean; run: Run }) {
  const [sp, setSp] = useState("")
  const [reason, setReason] = useState("")
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
      <div><p className="font-medium text-stone-900">{c.tenantName}</p><p className="text-xs text-stone-500">{c.salespersonName} · {c.status}</p></div>
      <div className="flex flex-wrap gap-2">
        <select className={input} value={sp} onChange={(e) => setSp(e.target.value)}>
          <option value="">Reassign to…</option>
          {people.filter((p) => p.id !== c.salespersonId && p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className={input} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className={btn2} disabled={busy || !sp} onClick={() => run(() => reassignTenant({ tenantId: c.tenantId, salespersonId: sp, reason }), "Reassigned and logged.")}>Reassign</button>
      </div>
    </div>
  )
}

function RunPayouts({ busy, run }: { busy: boolean; run: Run }) {
  const d = new Date()
  const [period, setPeriod] = useState(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`)
  return (
    <div className={card}>
      <p className="mb-2 text-sm text-stone-600">Monthly run: makes commissions past their 30-day hold payable, then prepares one payout per salesperson. Pay by EFT, then record the reference below.</p>
      <div className="flex gap-2">
        <input className={input} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
        <button className={btn} disabled={busy} onClick={() => run(() => runMonthlyPayouts({ period }))}>Prepare payouts</button>
      </div>
    </div>
  )
}

function PayoutRow({ p, busy, run }: { p: Payout; busy: boolean; run: Run }) {
  const [ref, setRef] = useState("")
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
      <div><p className="font-medium text-stone-900">{p.salespersonName} · {p.period}</p><p className="text-xs text-stone-500">{p.status === "paid" ? `Paid ${date(p.paid_at)} · ref ${p.payment_reference}` : "Awaiting EFT"}</p></div>
      <div className="flex items-center gap-2">
        <span className="tabular-nums">{rand(p.total_cents)}</span>
        {p.status !== "paid" && (<>
          <input className={input} placeholder="EFT reference" value={ref} onChange={(e) => setRef(e.target.value)} />
          <button className={btn} disabled={busy} onClick={() => run(() => markPayoutPaid({ payoutId: p.id, reference: ref }), "Marked paid.")}>Mark paid</button>
        </>)}
      </div>
    </div>
  )
}

function RuleForm({ busy, run }: { busy: boolean; run: Run }) {
  const [plan, setPlan] = useState("growth")
  const [bounty, setBounty] = useState("300")
  const [rate, setRate] = useState("10")
  return (
    <div className={card}>
      <p className="mb-2 text-sm text-stone-600">A new rule applies from now on. Past invoices keep the rule that was in force when they were paid.</p>
      <div className="flex flex-wrap gap-2">
        <select className={input} value={plan} onChange={(e) => setPlan(e.target.value)}><option value="growth">growth</option><option value="business">business</option></select>
        <input className={input} value={bounty} onChange={(e) => setBounty(e.target.value)} placeholder="Bounty (R)" />
        <input className={input} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Recurring %" />
        <button className={btn} disabled={busy} onClick={() => run(() => updateRule({ planKey: plan, bountyRands: Number(bounty), ratePercent: Number(rate) }))}>Save new rule</button>
      </div>
    </div>
  )
}
