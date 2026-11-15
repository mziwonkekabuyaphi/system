// app/admin/settings/DomainPanel.tsx
"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { checkDomain, claimDomain, listDomains, removeDomain, setPrimaryDomain } from "../domains/actions"
import type { DnsRecord, DomainView } from "../domains/types"
import { SettingsCard, inputClass, primaryButtonClass, secondaryButtonClass } from "./ui"

// ---------------------------------------------------------------------------
// Settings > Custom domain. The owner types a domain, adds one or two DNS records where they
// bought it, and we take it from there. Every step is plain-worded, because most owners have
// never touched DNS. Visible only when the module is on and the person has settings.manage;
// every action re-checks both on the server.
// ---------------------------------------------------------------------------

const POLL_EVERY_MS = 15_000
/** Stop re-checking by ourselves after this long, so a forgotten tab doesn't poll forever. */
const POLL_WINDOW_MS = 10 * 60_000

type Note = { text: string; ok: boolean } | null

const CHIP: Record<DomainView["step"], { label: string; className: string }> = {
  prove_ownership: { label: "Waiting for proof", className: "bg-amber-100 text-amber-800" },
  connect: { label: "Connecting", className: "bg-amber-100 text-amber-800" },
  active: { label: "Live", className: "bg-emerald-100 text-emerald-800" },
  disabled: { label: "Switched off", className: "bg-stone-100 text-stone-600" },
}

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "long" }).format(new Date(iso))
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const el = document.createElement("textarea")
      el.value = value
      el.style.position = "fixed"
      el.style.opacity = "0"
      document.body.appendChild(el)
      el.select()
      document.execCommand("copy")
      document.body.removeChild(el)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button type="button" onClick={copy} className={`${secondaryButtonClass} shrink-0 !px-2 !py-1 text-xs`} aria-label={`Copy ${label}`}>
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  )
}

function RecordTable({ records }: { records: DnsRecord[] }) {
  return (
    <ul className="space-y-2">
      {records.map((r) => (
        <li key={`${r.type}-${r.host}-${r.value}`} className="rounded-md border border-line bg-canvas p-3">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[4.5rem_1fr]">
            <dt className="text-ink-muted">Type</dt>
            <dd className="font-medium text-ink">{r.type}</dd>
            <dt className="text-ink-muted">Name</dt>
            <dd className="flex items-center gap-2">
              <code className="min-w-0 break-all rounded bg-tint px-1.5 py-0.5 text-ink">{r.host}</code>
              <CopyButton value={r.host} label="the record name" />
            </dd>
            <dt className="text-ink-muted">Value</dt>
            <dd className="flex items-center gap-2">
              <code className="min-w-0 break-all rounded bg-tint px-1.5 py-0.5 text-ink">{r.value}</code>
              <CopyButton value={r.value} label="the record value" />
            </dd>
          </dl>
        </li>
      ))}
    </ul>
  )
}

const PAGES_SERVED: Array<[string, string]> = [
  ["/", "Your customer page"],
  ["/kiosk", "The self-service kiosk"],
  ["/display", "The public display (and /display/shisha)"],
  ["/clock", "Staff clock-in"],
  ["/scan", "The ticket scanner"],
]

export function DomainPanel() {
  const [domains, setDomains] = useState<DomainView[] | null>(null)
  const [serverReady, setServerReady] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState<string | null>(null) // domain id, or "claim"
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [pollPaused, setPollPaused] = useState(false)
  const busyRef = useRef<string | null>(null)
  busyRef.current = busy

  const reload = useCallback(async () => {
    const res = await listDomains()
    if (res.ok) {
      setDomains(res.data.domains)
      setServerReady(res.data.serverReady)
      setLoadError(null)
    } else {
      setLoadError(res.error)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  function replace(view: DomainView) {
    setDomains((prev) => (prev ? prev.map((d) => (d.id === view.id ? view : d)) : prev))
  }

  // While anything is still waiting, check again on a timer: only while this tab is visible,
  // and only for a limited window. The server also rate-limits, so this can't hammer DNS.
  const waiting = (domains ?? []).filter((d) => d.step === "prove_ownership" || d.step === "connect").map((d) => d.id)
  const waitingKey = waiting.join(",")
  useEffect(() => {
    if (!waitingKey) return
    setPollPaused(false)
    const startedAt = Date.now()
    let stopped = false
    const timer = setInterval(async () => {
      if (stopped || document.hidden || busyRef.current) return
      if (Date.now() - startedAt > POLL_WINDOW_MS) {
        stopped = true
        clearInterval(timer)
        setPollPaused(true)
        return
      }
      for (const id of waitingKey.split(",")) {
        const res = await checkDomain(id)
        if (stopped) return
        if (res.ok) {
          replace(res.data.view)
          if (res.data.view.step === "active") setNote({ text: `${res.data.view.domain} is live.`, ok: true })
        }
      }
    }, POLL_EVERY_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [waitingKey])

  async function connect() {
    setNote(null)
    setBusy("claim")
    const res = await claimDomain(input)
    setBusy(null)
    if (!res.ok) return setNote({ text: res.error, ok: false })
    setInput("")
    setNote({ text: "Added. Follow the steps below to prove the domain is yours.", ok: true })
    await reload()
  }

  async function check(id: string) {
    setNote(null)
    setBusy(id)
    const res = await checkDomain(id)
    setBusy(null)
    if (!res.ok) return setNote({ text: res.error, ok: false })
    replace(res.data.view)
    setNote({ text: res.data.message, ok: res.data.view.step === "active" || !res.data.view.problem })
  }

  async function makePrimary(id: string) {
    setNote(null)
    setBusy(id)
    const res = await setPrimaryDomain(id)
    setBusy(null)
    if (!res.ok) return setNote({ text: res.error, ok: false })
    setNote({ text: `${res.data.domain} is now your main address.`, ok: true })
    await reload()
  }

  async function remove(id: string) {
    setNote(null)
    setBusy(id)
    const res = await removeDomain(id)
    setBusy(null)
    setConfirmRemove(null)
    if (!res.ok) return setNote({ text: res.error, ok: false })
    setNote({ text: "Domain removed.", ok: true })
    await reload()
  }

  if (loadError) return <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">{loadError}</p>
  if (!domains) return <p className="text-sm text-ink-muted">Loading…</p>

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Connect your own domain"
        description="Show your booking page, kiosk and display on your own address, like book.yourshop.com. A subdomain (book., queue. or tickets. in front of your domain) is the easiest way to start."
      >
        {!serverReady && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
            Connecting domains isn&apos;t fully set up on this platform yet, so it may not finish. Please contact support.
          </p>
        )}
        <form
          className="flex max-w-xl flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (input.trim() && busy === null) void connect()
          }}
        >
          <label className="sr-only" htmlFor="domain-input">
            Your domain
          </label>
          <input
            id="domain-input"
            className={inputClass}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="book.yourshop.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            disabled={busy !== null}
          />
          <button type="submit" className={primaryButtonClass} disabled={busy !== null || !input.trim()}>
            {busy === "claim" ? "Adding…" : "Connect"}
          </button>
        </form>
        <p className="text-xs text-ink-muted">You can connect up to 3 domains. Your team still signs in on the main site as usual.</p>
        <div aria-live="polite" role="status">
          {note && <p className={`text-sm ${note.ok ? "text-success" : "text-accent"}`}>{note.text}</p>}
        </div>
      </SettingsCard>

      {domains.map((d) => {
        const chip = d.step === "active" && d.problem ? { label: "Needs attention", className: "bg-red-100 text-red-800" } : CHIP[d.step]
        const working = busy === d.id
        return (
          <SettingsCard key={d.id} title={d.domain}>
            <div className="-mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${chip.className}`}>{chip.label}</span>
              {d.isPrimary && <span className="rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-ink">Main address</span>}
            </div>

            {d.step === "prove_ownership" && (
              <div className="space-y-3">
                <p className="text-sm text-ink">
                  <strong>Step 1 of 2: prove this domain is yours.</strong> Sign in where you manage the domain (usually the company you bought it
                  from), open its DNS settings and add this record:
                </p>
                <RecordTable records={d.records} />
                <p className="text-xs text-ink-muted">
                  DNS changes usually take a few minutes, sometimes longer. Some providers want only the first part of the name (shown above),
                  others the whole name.
                  {d.expiresAt ? ` This request lapses on ${formatDay(d.expiresAt)} if the record isn't added.` : ""}
                </p>
              </div>
            )}

            {d.step === "connect" && (
              <div className="space-y-3">
                <p className="text-sm text-ink">
                  <strong>Step 2 of 2: point it at us.</strong> Ownership confirmed. Now add this record in the same place:
                </p>
                {d.records.length > 0 ? (
                  <RecordTable records={d.records} />
                ) : (
                  <p className="text-sm text-ink-muted">We&apos;re loading the records for this domain. Press Check now in a moment.</p>
                )}
                {d.vercelChallenge && (
                  <div className="space-y-2">
                    <p className="text-sm text-ink">
                      This domain is also registered with another hosting account, so our hosting needs one more record to confirm it&apos;s really
                      yours:
                    </p>
                    <RecordTable records={[d.vercelChallenge]} />
                  </div>
                )}
                {d.problem && (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
                    {d.problem}
                  </p>
                )}
              </div>
            )}

            {d.step === "active" && (
              <div className="space-y-3">
                <p className="text-sm text-ink">
                  Live at{" "}
                  <a href={d.liveUrl ?? "#"} target="_blank" rel="noreferrer" className="font-medium underline">
                    {d.liveUrl}
                  </a>
                </p>
                <ul className="space-y-1 text-sm text-ink-muted">
                  {PAGES_SERVED.map(([path, what]) => (
                    <li key={path}>
                      <code className="rounded bg-tint px-1.5 py-0.5 text-ink">{d.domain}{path === "/" ? "" : path}</code> {what}
                    </li>
                  ))}
                </ul>
                {d.problem && (
                  <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                    {d.problem}
                  </p>
                )}
              </div>
            )}

            {d.step === "disabled" && <p className="text-sm text-ink-muted">This domain has been switched off. Please contact support.</p>}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {(d.step === "prove_ownership" || d.step === "connect" || (d.step === "active" && d.problem)) && (
                <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => void check(d.id)}>
                  {working ? "Checking…" : "Check now"}
                </button>
              )}
              {d.step === "active" && !d.isPrimary && (
                <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => void makePrimary(d.id)}>
                  Make main address
                </button>
              )}
              {confirmRemove === d.id ? (
                <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  Remove this domain? It will stop working.
                  <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => void remove(d.id)}>
                    {working ? "Removing…" : "Yes, remove"}
                  </button>
                  <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => setConfirmRemove(null)}>
                    Keep it
                  </button>
                </span>
              ) : (
                <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => setConfirmRemove(d.id)}>
                  Remove
                </button>
              )}
            </div>
          </SettingsCard>
        )
      })}

      {pollPaused && waiting.length > 0 && (
        <p className="text-xs text-ink-muted">Automatic checking has paused. Press Check now when you&apos;ve added the record.</p>
      )}
    </div>
  )
}
