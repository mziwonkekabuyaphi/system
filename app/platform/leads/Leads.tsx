"use client"
// app/platform/leads/Leads.tsx — list of website enquiries with status + private notes.

import { useState, useTransition } from "react"

import { updateContactRequest, type LeadStatus } from "./actions"

export interface LeadRow {
  id: string
  kind: "demo" | "contact"
  name: string
  business_name: string | null
  email: string | null
  phone: string | null
  message: string | null
  status: LeadStatus
  admin_notes: string | null
  created_at: string
}

const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
const FILTERS: Array<{ key: LeadStatus | "all"; label: string }> = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
]

function when(iso: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  }).format(new Date(iso))
}

/** wa.me needs digits only, with the country code: assume South Africa for a leading 0. */
function whatsappHref(phone: string): string | null {
  const digits = phone.replace(/\D/g, "")
  if (digits.length < 7) return null
  const full = digits.startsWith("0") ? `27${digits.slice(1)}` : digits
  return `https://wa.me/${full}`
}

function LeadCard({ lead }: { lead: LeadRow }) {
  const [status, setStatus] = useState<LeadStatus>(lead.status)
  const [notes, setNotes] = useState(lead.admin_notes ?? "")
  const [savedNotes, setSavedNotes] = useState(lead.admin_notes ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function setStatusTo(next: LeadStatus) {
    const previous = status
    setStatus(next)
    setError(null)
    startTransition(async () => {
      const result = await updateContactRequest(lead.id, { status: next })
      if (!result.ok) {
        setStatus(previous)
        setError(result.error ?? "Could not save")
      }
    })
  }

  function saveNotes() {
    setError(null)
    startTransition(async () => {
      const result = await updateContactRequest(lead.id, { adminNotes: notes })
      if (result.ok) setSavedNotes(notes)
      else setError(result.error ?? "Could not save")
    })
  }

  const wa = lead.phone ? whatsappHref(lead.phone) : null

  return (
    <article className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-stone-900">
            {lead.name}
            {lead.business_name ? <span className="font-normal text-stone-500"> · {lead.business_name}</span> : null}
          </p>
          <p className="text-xs text-stone-400">{when(lead.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              lead.kind === "demo" ? "bg-amber-100 text-amber-800" : "bg-stone-100 text-stone-700"
            }`}
          >
            {lead.kind === "demo" ? "Demo request" : "Question"}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              status === "new"
                ? "bg-emerald-100 text-emerald-800"
                : status === "contacted"
                  ? "bg-sky-100 text-sky-800"
                  : "bg-stone-100 text-stone-500"
            }`}
          >
            {status}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {lead.email && (
          <a className="text-stone-800 underline" href={`mailto:${lead.email}`}>
            {lead.email}
          </a>
        )}
        {lead.phone && (
          <a className="text-stone-800 underline" href={`tel:${lead.phone}`}>
            {lead.phone}
          </a>
        )}
        {wa && (
          <a className="text-emerald-700 underline" href={wa} target="_blank" rel="noopener noreferrer">
            Open in WhatsApp
          </a>
        )}
      </div>

      {lead.message && <p className="mt-3 whitespace-pre-line rounded-xl bg-stone-50 p-3 text-sm text-stone-700">{lead.message}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(["new", "contacted", "closed"] as LeadStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            disabled={pending || status === s}
            onClick={() => setStatusTo(s)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold capitalize ${
              status === s ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 text-stone-700 hover:bg-stone-50"
            } disabled:opacity-60`}
          >
            {s === "new" ? "Mark new" : s === "contacted" ? "Mark contacted" : "Close"}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <label className="text-xs uppercase text-stone-400" htmlFor={`notes-${lead.id}`}>
          Private notes
        </label>
        <textarea
          id={`notes-${lead.id}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-stone-200 p-2 text-sm text-stone-800"
          placeholder="e.g. Called 19 Oct, wants a Friday demo"
        />
        {notes !== savedNotes && (
          <button
            type="button"
            disabled={pending}
            onClick={saveNotes}
            className="mt-1 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            Save notes
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </article>
  )
}

export function Leads({ rows, loadFailed }: { rows: LeadRow[]; loadFailed: boolean }) {
  const [filter, setFilter] = useState<LeadStatus | "all">("new")
  const counts = {
    new: rows.filter((r) => r.status === "new").length,
    contacted: rows.filter((r) => r.status === "contacted").length,
    closed: rows.filter((r) => r.status === "closed").length,
    all: rows.length,
  }
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter)

  return (
    <main className="mx-auto max-w-4xl space-y-5 px-6 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Enquiries</h1>
        <p className="mt-1 text-sm text-stone-500">Everyone who used “Book a demo” or “Ask a question” on the website.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
              filter === f.key ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {f.label} <span className="tabular-nums opacity-70">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {loadFailed && <p className={`${card} text-sm text-red-600`}>Could not load enquiries. Check the server logs.</p>}
      {!loadFailed && shown.length === 0 && <p className={`${card} text-sm text-stone-500`}>Nothing here.</p>}
      <div className="space-y-3">
        {shown.map((lead) => (
          <LeadCard key={lead.id} lead={lead} />
        ))}
      </div>
    </main>
  )
}
