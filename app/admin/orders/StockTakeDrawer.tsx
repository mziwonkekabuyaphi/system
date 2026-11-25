"use client"

// app/admin/orders/StockTakeDrawer.tsx
//
// "Stock take" overlay opened from the Products screen, same AdminDrawer shell as the Shifts drawer.
// Children unmount on close, so everything reloads fresh each time it opens.
//
// Flow: start a count (snapshots what the system thinks you have) -> type in what is really on the shelf
// (save as often as you like, nothing changes yet) -> Finish & apply (stock is corrected in one go).
// Products you didn't count are left alone. Finished counts stay in the history.

import { useCallback, useEffect, useMemo, useState } from "react"

import { AdminDrawer } from "@/components/admin/AdminDrawer"

import { cancelStockTake, completeStockTake, getStockTake, listStockTakes, saveStockTakeCounts, startStockTake } from "./actions"
import { EmptyState, Pill, Stat, btn, cardCls, cx, inputCls, useNotice } from "./ui"
import type { StockTakeDetail, StockTakeResult, StockTakeStatus, StockTakeSummary } from "./types"

type View = { kind: "home" } | { kind: "count"; id: string } | { kind: "detail"; id: string }

const STATUS_LABEL: Record<StockTakeStatus, string> = { in_progress: "In progress", completed: "Finished", cancelled: "Cancelled" }
const STATUS_TONE: Record<StockTakeStatus, "info" | "good" | "neutral"> = { in_progress: "info", completed: "good", cancelled: "neutral" }

function fmtDate(iso: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-ZA", { timeZone: timezone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
  } catch {
    return new Date(iso).toLocaleString()
  }
}

function defaultName(timezone: string) {
  try {
    return `Stock take ${new Intl.DateTimeFormat("en-ZA", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(new Date())}`
  } catch {
    return "Stock take"
  }
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

export function StockTakeDrawer({
  open,
  onClose,
  timezone,
  canManage,
  onApplied,
}: {
  open: boolean
  onClose: () => void
  timezone: string
  canManage: boolean
  /** Called after a count is applied, with productId -> new stock, so the product list updates. */
  onApplied: (stock: Record<string, number>) => void
}) {
  const [view, setView] = useState<View>({ kind: "home" })
  const subtitle = view.kind === "home" ? "Count your shelves and correct the system" : view.kind === "count" ? "Counting" : "Past count"
  return (
    <AdminDrawer open={open} onClose={onClose} title="Stock take" subtitle={subtitle} width="xl">
      <StockTakeBody view={view} setView={setView} timezone={timezone} canManage={canManage} onApplied={onApplied} />
    </AdminDrawer>
  )
}

function StockTakeBody({
  view,
  setView,
  timezone,
  canManage,
  onApplied,
}: {
  view: View
  setView: (v: View) => void
  timezone: string
  canManage: boolean
  onApplied: (stock: Record<string, number>) => void
}) {
  const { show, node } = useNotice()
  const goHome = useCallback(() => setView({ kind: "home" }), [setView])
  return (
    <div className="space-y-5 text-admin-text">
      {view.kind === "home" && <Home setView={setView} timezone={timezone} canManage={canManage} show={show} />}
      {view.kind === "count" && (
        <Counting id={view.id} timezone={timezone} onBack={goHome} onApplied={onApplied} show={show} />
      )}
      {view.kind === "detail" && <Detail id={view.id} timezone={timezone} onBack={goHome} show={show} />}
      {node}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Home: start / continue / history
// ---------------------------------------------------------------------------

function Home({ setView, timezone, canManage, show }: { setView: (v: View) => void; timezone: string; canManage: boolean; show: (t: string, e?: boolean) => void }) {
  const [takes, setTakes] = useState<StockTakeSummary[] | null>(null)
  const [name, setName] = useState(() => defaultName(timezone))
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await listStockTakes()
    if (res.ok) setTakes(res.data)
    else {
      setTakes([])
      show(res.error, true)
    }
  }, [show])

  useEffect(() => {
    void load()
  }, [load])

  const open = takes?.find((t) => t.status === "in_progress") ?? null
  const history = (takes ?? []).filter((t) => t.status !== "in_progress")

  async function start() {
    setBusy(true)
    const res = await startStockTake(name)
    setBusy(false)
    if (!res.ok) return show(res.error, true)
    setView({ kind: "count", id: res.data.id })
  }

  if (takes === null) return <p className="text-sm text-admin-text/60">Loading…</p>

  return (
    <>
      <p className="text-sm text-admin-text/70">
        A stock take checks what is really on your shelves against what the system says. Nothing changes until you press <strong>Finish &amp; apply</strong>, and products you don&apos;t count are left alone.
        Only products with &quot;Track inventory&quot; switched on are included.
      </p>

      {open ? (
        <div className={cx(cardCls, "space-y-3 p-4")}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">{open.name}</p>
              <p className="text-xs text-admin-text/60">Started {fmtDate(open.createdAt, timezone)}</p>
            </div>
            <Pill tone="info">In progress</Pill>
          </div>
          <p className="text-sm text-admin-text/70">
            {open.countedCount} of {open.lineCount} products counted.
          </p>
          <button type="button" className={btn.primary} onClick={() => setView({ kind: "count", id: open.id })}>
            {canManage ? "Continue counting" : "View count"}
          </button>
        </div>
      ) : canManage ? (
        <div className={cx(cardCls, "space-y-3 p-4")}>
          <p className="font-medium">Start a new count</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-admin-text/70">Name</span>
            <input className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="button" className={btn.primary} disabled={busy || name.trim() === ""} onClick={start}>
            {busy ? "Starting…" : "Start stock take"}
          </button>
        </div>
      ) : (
        <p className="rounded-lg border border-admin-text/10 px-4 py-3 text-sm text-admin-text/70">Only people who can manage products can start a stock take.</p>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium">Previous counts</h3>
        {history.length === 0 ? (
          <div className={cardCls}>
            <EmptyState title="No finished counts yet">Finished counts are kept here so you can see what changed.</EmptyState>
          </div>
        ) : (
          <ul className="space-y-2">
            {history.map((t) => (
              <li key={t.id} className={cx(cardCls, "flex items-center justify-between gap-3 px-4 py-3")}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-admin-text/60">
                    {fmtDate(t.completedAt ?? t.createdAt, timezone)}
                    {t.status === "completed" && ` · ${t.countedCount} counted · ${t.adjustedCount} corrected`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Pill>
                  {t.status === "completed" && (
                    <button type="button" className={btn.ghost} onClick={() => setView({ kind: "detail", id: t.id })}>
                      View
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

type Filter = "all" | "uncounted" | "differences"

function csvEscape(v: string | number) {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function Counting({
  id,
  timezone,
  onBack,
  onApplied,
  show,
}: {
  id: string
  timezone: string
  onBack: () => void
  onApplied: (stock: Record<string, number>) => void
  show: (t: string, e?: boolean) => void
}) {
  const [detail, setDetail] = useState<StockTakeDetail | null>(null)
  /** What the screen shows per product: "" = not counted. */
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [busy, setBusy] = useState<null | "save" | "finish" | "cancel">(null)
  const [confirm, setConfirm] = useState<null | "finish" | "cancel">(null)
  const [result, setResult] = useState<StockTakeResult | null>(null)

  useEffect(() => {
    let alive = true
    void getStockTake(id).then((res) => {
      if (!alive) return
      if (!res.ok) {
        show(res.error, true)
        onBack()
        return
      }
      const init: Record<string, string> = {}
      for (const l of res.data.lines) init[l.productId] = l.counted === null ? "" : String(l.counted)
      setDetail(res.data)
      setValues(init)
      setSaved(init)
    })
    return () => {
      alive = false
    }
  }, [id, onBack, show])

  const lines = detail?.lines ?? []
  const readOnly = detail ? detail.summary.status !== "in_progress" : true

  const parse = (v: string): number | null | "bad" => {
    const t = v.trim()
    if (t === "") return null
    if (!/^\d{1,7}$/.test(t)) return "bad"
    return Number(t)
  }

  const stats = useMemo(() => {
    let counted = 0
    let diffs = 0
    let up = 0
    let down = 0
    let bad = 0
    for (const l of lines) {
      const n = parse(values[l.productId] ?? "")
      if (n === "bad") bad++
      else if (n !== null) {
        counted++
        const d = n - l.expected
        if (d !== 0) diffs++
        if (d > 0) up += d
        else down += -d
      }
    }
    return { counted, diffs, up, down, bad }
  }, [lines, values])

  const dirty = useMemo(() => Object.keys(values).filter((k) => values[k] !== saved[k]), [values, saved])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter((l) => {
      if (q && !l.name.toLowerCase().includes(q) && !(l.categoryLabel ?? "").toLowerCase().includes(q)) return false
      const n = parse(values[l.productId] ?? "")
      if (filter === "uncounted") return n === null
      if (filter === "differences") return n !== null && n !== "bad" && n !== l.expected
      return true
    })
  }, [lines, values, query, filter])

  async function persist(): Promise<boolean> {
    if (stats.bad > 0) {
      show("Counts must be whole numbers, like 12.", true)
      return false
    }
    if (dirty.length === 0) return true
    const payload = dirty.map((pid) => ({ productId: pid, counted: parse(values[pid]) as number | null }))
    const res = await saveStockTakeCounts(id, payload)
    if (!res.ok) {
      show(res.error, true)
      return false
    }
    setSaved({ ...values })
    return true
  }

  async function onSave() {
    setBusy("save")
    const ok = await persist()
    setBusy(null)
    if (ok) show("Progress saved.")
  }

  async function onFinish() {
    setBusy("finish")
    const ok = await persist()
    if (!ok) {
      setBusy(null)
      setConfirm(null)
      return
    }
    const res = await completeStockTake(id)
    setBusy(null)
    setConfirm(null)
    if (!res.ok) return show(res.error, true)
    onApplied(res.data.stock)
    setResult(res.data)
  }

  async function onCancel() {
    setBusy("cancel")
    const res = await cancelStockTake(id)
    setBusy(null)
    setConfirm(null)
    if (!res.ok) return show(res.error, true)
    show("Stock take cancelled. No stock was changed.")
    onBack()
  }

  function markUncountedCorrect() {
    setValues((prev) => {
      const next = { ...prev }
      for (const l of lines) if ((next[l.productId] ?? "") === "") next[l.productId] = String(l.expected)
      return next
    })
  }

  function downloadSheet() {
    const rows = [["Product", "Category", "System quantity", "Counted"], ...lines.map((l) => [l.name, l.categoryLabel ?? "", l.expected, values[l.productId] ?? ""])]
    const blob = new Blob([rows.map((r) => r.map(csvEscape).join(",")).join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${detail?.summary.name ?? "stock-take"}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!detail) return <p className="text-sm text-admin-text/60">Loading…</p>

  if (result) {
    return (
      <div className="space-y-4">
        <div className={cx(cardCls, "space-y-2 p-5")}>
          <p className="text-base font-medium">Stock take finished</p>
          <p className="text-sm text-admin-text/70">
            {result.counted} products counted, {result.adjusted} corrected
            {result.adjusted > 0 && ` (${result.unitsAdded} units added, ${result.unitsRemoved} units removed)`}. Your product list is up to date.
          </p>
        </div>
        <button type="button" className={btn.primary} onClick={onBack}>
          Done
        </button>
      </div>
    )
  }

  const { summary } = detail

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <button type="button" className="text-xs text-admin-text/60 underline" onClick={onBack}>
            ← Back
          </button>
          <p className="mt-1 text-base font-medium">{summary.name}</p>
          <p className="text-xs text-admin-text/60">Started {fmtDate(summary.createdAt, timezone)}</p>
        </div>
        <Pill tone={STATUS_TONE[summary.status]}>{STATUS_LABEL[summary.status]}</Pill>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Counted" value={`${stats.counted}/${lines.length}`} hint="products" />
        <Stat label="Differences" value={stats.diffs} hint="products off" tone={stats.diffs > 0 ? "warn" : undefined} />
        <Stat label="Net change" value={signed(stats.up - stats.down)} hint={`+${stats.up} / -${stats.down} units`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className={cx(inputCls, "max-w-[14rem]")} placeholder="Search products" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" />
        <select className={cx(inputCls, "max-w-[12rem]")} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter">
          <option value="all">All products</option>
          <option value="uncounted">Not counted yet</option>
          <option value="differences">Differences only</option>
        </select>
        <button type="button" className={cx(btn.ghost, "ml-auto")} onClick={downloadSheet}>
          Download count sheet
        </button>
        {!readOnly && (
          <button type="button" className={btn.ghost} onClick={markUncountedCorrect} title="Fills every empty row with the system quantity">
            Mark uncounted as correct
          </button>
        )}
      </div>

      <div className={cx(cardCls, "overflow-x-auto")}>
        {visible.length === 0 ? (
          <EmptyState title="Nothing to show">Try a different search or filter.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-admin-text/10 text-left text-xs uppercase tracking-wide text-admin-text/60">
                <th className="px-4 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">System</th>
                <th className="px-3 py-2 text-right font-medium">Counted</th>
                <th className="px-4 py-2 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => {
                const raw = values[l.productId] ?? ""
                const n = parse(raw)
                const diff = typeof n === "number" ? n - l.expected : null
                return (
                  <tr key={l.productId} className="border-b border-admin-text/5 last:border-0">
                    <td className="px-4 py-2">
                      <p className="font-medium">{l.name}</p>
                      {l.categoryLabel && <p className="text-xs text-admin-text/50">{l.categoryLabel}</p>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.expected}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        inputMode="numeric"
                        className={cx(inputCls, "ml-auto w-24 text-right tabular-nums", n === "bad" && "border-red-500")}
                        value={raw}
                        disabled={readOnly}
                        placeholder="–"
                        aria-label={`Counted: ${l.name}`}
                        onChange={(e) => setValues((p) => ({ ...p, [l.productId]: e.target.value }))}
                      />
                    </td>
                    <td
                      className={cx(
                        "px-4 py-2 text-right tabular-nums",
                        diff === null ? "text-admin-text/40" : diff === 0 ? "text-admin-text/60" : diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {diff === null ? "–" : diff === 0 ? "OK" : signed(diff)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {!readOnly && (
        <>
          {confirm === "finish" && (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              <p className="font-medium">Apply this count?</p>
              <p>
                {stats.counted} products counted, {stats.diffs} will be corrected ({stats.up} units added, {stats.down} removed).
                {lines.length - stats.counted > 0 && ` ${lines.length - stats.counted} products not counted will stay as they are.`} Sales made while you were counting are kept. This can&apos;t be undone.
              </p>
              <div className="flex gap-2">
                <button type="button" className={btn.primary} disabled={busy !== null} onClick={onFinish}>
                  {busy === "finish" ? "Applying…" : "Yes, apply"}
                </button>
                <button type="button" className={btn.ghost} disabled={busy !== null} onClick={() => setConfirm(null)}>
                  Keep counting
                </button>
              </div>
            </div>
          )}
          {confirm === "cancel" && (
            <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm">
              <p className="font-medium">Cancel this stock take?</p>
              <p>Your counts will be thrown away. No stock is changed.</p>
              <div className="flex gap-2">
                <button type="button" className={btn.danger} disabled={busy !== null} onClick={onCancel}>
                  {busy === "cancel" ? "Cancelling…" : "Yes, cancel it"}
                </button>
                <button type="button" className={btn.ghost} disabled={busy !== null} onClick={() => setConfirm(null)}>
                  Keep counting
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-admin-text/10 pt-4">
            <button type="button" className={btn.danger} disabled={busy !== null} onClick={() => setConfirm("cancel")}>
              Cancel count
            </button>
            <div className="flex gap-2">
              <button type="button" className={btn.ghost} disabled={busy !== null || dirty.length === 0} onClick={onSave}>
                {busy === "save" ? "Saving…" : "Save progress"}
              </button>
              <button type="button" className={btn.primary} disabled={busy !== null || stats.counted === 0} onClick={() => setConfirm("finish")}>
                Finish &amp; apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Past count (read-only)
// ---------------------------------------------------------------------------

function Detail({ id, timezone, onBack, show }: { id: string; timezone: string; onBack: () => void; show: (t: string, e?: boolean) => void }) {
  const [detail, setDetail] = useState<StockTakeDetail | null>(null)
  const [onlyChanged, setOnlyChanged] = useState(true)

  useEffect(() => {
    let alive = true
    void getStockTake(id).then((res) => {
      if (!alive) return
      if (!res.ok) {
        show(res.error, true)
        onBack()
        return
      }
      setDetail(res.data)
    })
    return () => {
      alive = false
    }
  }, [id, onBack, show])

  if (!detail) return <p className="text-sm text-admin-text/60">Loading…</p>
  const { summary, lines } = detail
  const rows = lines.filter((l) => l.counted !== null && (!onlyChanged || (l.appliedDelta ?? 0) !== 0))

  return (
    <div className="space-y-4">
      <div>
        <button type="button" className="text-xs text-admin-text/60 underline" onClick={onBack}>
          ← Back
        </button>
        <p className="mt-1 text-base font-medium">{summary.name}</p>
        <p className="text-xs text-admin-text/60">Finished {fmtDate(summary.completedAt ?? summary.createdAt, timezone)}</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Counted" value={summary.countedCount} hint={`of ${summary.lineCount}`} />
        <Stat label="Corrected" value={summary.adjustedCount} hint="products" />
        <Stat label="Units" value={signed(summary.unitsAdded - summary.unitsRemoved)} hint={`+${summary.unitsAdded} / -${summary.unitsRemoved}`} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
        Only show products that were corrected
      </label>
      <div className={cx(cardCls, "overflow-x-auto")}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing to show">No products were corrected in this count.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-admin-text/10 text-left text-xs uppercase tracking-wide text-admin-text/60">
                <th className="px-4 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">System</th>
                <th className="px-3 py-2 text-right font-medium">Counted</th>
                <th className="px-3 py-2 text-right font-medium">Change</th>
                <th className="px-4 py-2 text-right font-medium">Stock now</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.productId} className="border-b border-admin-text/5 last:border-0">
                  <td className="px-4 py-2 font-medium">{l.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.expected}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.counted}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.appliedDelta ? signed(l.appliedDelta) : "OK"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{l.stockAfter ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
