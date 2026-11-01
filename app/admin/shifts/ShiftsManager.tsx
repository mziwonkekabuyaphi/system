// app/admin/shifts/ShiftsManager.tsx
"use client"

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react"
import { createPortal } from "react-dom"

import {
  AdminDrawer,
  DRAWER_BTN,
  DRAWER_BTN_PRIMARY,
  DRAWER_FIELD,
  DrawerField,
  DrawerGroup,
  DrawerSwitch,
  DrawerTabs,
} from "@/components/admin/AdminDrawer"

import {
  applyWeeklyPattern,
  cancelSwap,
  createShiftSchedule,
  deleteScheduledShift,
  deleteShiftSchedule,
  getSwapCandidates,
  loadShiftsData,
  overrideAttendance,
  requestSwap,
  respondSwap,
  reviewSwap,
  saveScheduledShift,
  saveShiftSettings,
  saveShiftTemplate,
  setSchedulePublished,
  setShiftTemplateActive,
} from "./shifts-actions"
import type {
  ScheduledShift,
  ShiftAttendanceRow,
  ShiftSchedule,
  ShiftScheduleType,
  ShiftSettings,
  ShiftsData,
  ShiftSwap,
  ShiftTemplate,
  SwapCandidate,
} from "./shift-types"

/** AdminDrawer rendered in a portal. Needed because this screen lives inside the
 *  Staff tab's Shifts drawer: that panel is CSS-transformed, which would trap a
 *  nested position:fixed drawer inside it. Escape closes only the top-most one. */
function SubDrawer(props: ComponentProps<typeof AdminDrawer>) {
  const { open, onClose } = props
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault() // tells the parent Shifts drawer "handled"
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, onClose])
  if (typeof document === "undefined") return null
  return createPortal(<AdminDrawer {...props} />, document.body)
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const CARD = "rounded-lg border border-line bg-card"
const MUTED = "text-sm text-ink-muted"

const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
const dow = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay()
const prettyDate = (key: string) => {
  const d = new Date(`${key}T00:00:00Z`)
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString("en-ZA", { month: "short", timeZone: "UTC" })}`
}
const todayKey = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date())

type Tab = "rota" | "mine" | "swaps" | "setup"

export function ShiftsManager({ timezone, embedded = false }: { timezone: string; embedded?: boolean }) {
  const [data, setData] = useState<ShiftsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("rota")
  const [scheduleId, setScheduleId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await loadShiftsData()
    if (!res.ok) return setError(res.error)
    setError(null)
    setData(res.data)
    setScheduleId((cur) => cur ?? res.data.schedules[0]?.id ?? null)
    setTab((cur) => {
      if (res.data.canManage) return cur
      return cur === "rota" || cur === "setup" ? "mine" : cur
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (error) return <p className="py-10 text-center text-sm text-red-700">{error}</p>
  if (!data) return <p className={`py-10 text-center ${MUTED}`}>Loading shifts…</p>

  const tabs: Array<{ id: Tab; label: string }> = [
    ...(data.canManage ? [{ id: "rota" as const, label: "Rota" }] : []),
    ...(data.myStaffId ? [{ id: "mine" as const, label: "My shifts" }] : []),
    { id: "swaps", label: "Swaps" },
    ...(data.canManage ? [{ id: "setup" as const, label: "Shift types & rules" }] : []),
  ]
  const pendingForMe = data.swaps.filter(
    (s) =>
      (s.status === "pending_colleague" && s.targetStaffId === data.myStaffId) ||
      (s.status === "pending_admin" && data.canManage),
  ).length

  return (
    <div className={embedded ? "space-y-4" : "space-y-4 pt-4"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!embedded && <h1 className="font-[family-name:var(--font-admin-serif)] text-xl text-ink">Shifts</h1>}
        <DrawerTabs
          label="Shifts sections"
          value={tab}
          onChange={setTab}
          tabs={tabs.map((t) => (t.id === "swaps" && pendingForMe ? { ...t, label: `Swaps (${pendingForMe})` } : t))}
        />
      </div>

      {tab === "rota" && data.canManage && (
        <Rota data={data} scheduleId={scheduleId} setScheduleId={setScheduleId} timezone={timezone} onChange={refresh} />
      )}
      {tab === "mine" && data.myStaffId && <MyShifts data={data} timezone={timezone} onChange={refresh} />}
      {tab === "swaps" && <Swaps data={data} onChange={refresh} />}
      {tab === "setup" && data.canManage && <Setup data={data} onChange={refresh} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function useAction() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setBusy(true)
    setMsg(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) return setMsg(r.error ?? "Something went wrong.")
    after?.()
  }
  return { busy, msg, run, setMsg }
}

function Msg({ text }: { text: string | null }) {
  return text ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{text}</p> : null
}

function attendanceBadge(a?: ShiftAttendanceRow) {
  if (!a) return null
  const eff = a.overrideStatus ?? a.status
  const label =
    eff === "excused" ? "Excused" : eff === "no_show" ? "No-show" : eff === "late" ? `Late ${a.minutesLate ?? ""}m` : "On time"
  const tone =
    eff === "no_show" ? "bg-red-100 text-red-800" : eff === "late" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>{label}</span>
}

// ---------------------------------------------------------------------------
// Rota (manager)
// ---------------------------------------------------------------------------

function Rota({
  data,
  scheduleId,
  setScheduleId,
  timezone,
  onChange,
}: {
  data: ShiftsData
  scheduleId: string | null
  setScheduleId: (id: string | null) => void
  timezone: string
  onChange: () => Promise<void>
}) {
  const schedule = data.schedules.find((s) => s.id === scheduleId) ?? null
  const [creating, setCreating] = useState(false)
  const [pattern, setPattern] = useState(false)
  const [editing, setEditing] = useState<{ shift?: ScheduledShift; staffId: string; date: string } | null>(null)
  const act = useAction()

  const days = useMemo(() => {
    if (!schedule) return []
    return Array.from({ length: daysBetween(schedule.periodStart, schedule.periodEnd) + 1 }, (_, i) => addDays(schedule.periodStart, i))
  }, [schedule])
  const shifts = data.shifts.filter((s) => s.scheduleId === scheduleId && s.status !== "cancelled")
  const attByShift = new Map(data.attendance.map((a) => [a.scheduledShiftId, a]))
  const today = todayKey(timezone)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${DRAWER_FIELD} max-w-xs`}
          value={scheduleId ?? ""}
          onChange={(e) => setScheduleId(e.target.value || null)}
          aria-label="Schedule"
        >
          {data.schedules.length === 0 && <option value="">No schedules yet</option>}
          {data.schedules.map((s) => (
            <option key={s.id} value={s.id}>
              {(s.name ? `${s.name} · ` : "") + `${prettyDate(s.periodStart)} – ${prettyDate(s.periodEnd)}`} ({s.status})
            </option>
          ))}
        </select>
        <button className={DRAWER_BTN_PRIMARY} onClick={() => setCreating(true)}>
          New schedule
        </button>
        {schedule && (
          <>
            <button className={DRAWER_BTN} onClick={() => setPattern(true)}>
              Repeat a pattern
            </button>
            <button
              className={schedule.status === "draft" ? DRAWER_BTN_PRIMARY : DRAWER_BTN}
              disabled={act.busy}
              onClick={() => act.run(() => setSchedulePublished(schedule.id, schedule.status === "draft"), onChange)}
            >
              {schedule.status === "draft" ? "Publish to staff" : "Unpublish"}
            </button>
            <button
              className={DRAWER_BTN}
              disabled={act.busy}
              onClick={() => {
                if (confirm("Delete this schedule and all its shifts?")) {
                  void act.run(() => deleteShiftSchedule(schedule.id), async () => {
                    setScheduleId(null)
                    await onChange()
                  })
                }
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      <Msg text={act.msg} />

      {schedule?.status === "draft" && (
        <p className={MUTED}>Draft: staff can't see this schedule yet. Publish it when the rota is ready.</p>
      )}

      {!schedule ? (
        <p className={`${CARD} p-8 text-center ${MUTED}`}>Create a weekly, bi-weekly or monthly schedule to start.</p>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr className="bg-tint text-left text-ink">
                <th className="sticky left-0 z-10 min-w-[120px] bg-tint px-3 py-2">Staff</th>
                {days.map((d) => (
                  <th key={d} className={`min-w-[96px] px-2 py-2 font-medium ${d === today ? "text-ink underline" : ""}`}>
                    {prettyDate(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.staff.map((st) => (
                <tr key={st.id} className="border-t border-line align-top">
                  <td className="sticky left-0 bg-card px-3 py-2">
                    <div className="font-medium text-ink">{st.name}</div>
                    {st.jobTitle && <div className="text-ink-muted">{st.jobTitle}</div>}
                  </td>
                  {days.map((d) => {
                    const cell = shifts.filter((s) => s.staffId === st.id && s.date === d)
                    return (
                      <td
                        key={d}
                        className="cursor-pointer px-1.5 py-1.5 hover:bg-panel"
                        onClick={() => setEditing({ staffId: st.id, date: d })}
                      >
                        <div className="space-y-1">
                          {cell.map((s) => {
                            const tpl = data.templates.find((t) => t.id === s.templateId)
                            return (
                              <button
                                key={s.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditing({ shift: s, staffId: st.id, date: d })
                                }}
                                className="block w-full rounded border px-1.5 py-1 text-left"
                                style={{ borderColor: tpl?.color ?? "var(--color-line-strong)", background: tpl?.color ? `${tpl.color}22` : "var(--color-tint)" }}
                              >
                                <div className="font-medium">
                                  {s.startTime}–{s.endTime}
                                </div>
                                {tpl && <div className="text-ink-muted">{tpl.name}</div>}
                                {s.status === "swapped" && <div className="text-ink-muted">swapped</div>}
                                {attendanceBadge(attByShift.get(s.id))}
                              </button>
                            )
                          })}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewScheduleDrawer open={creating} onClose={() => setCreating(false)} onDone={async (id) => { setScheduleId(id); await onChange() }} />
      {schedule && (
        <PatternDrawer
          open={pattern}
          onClose={() => setPattern(false)}
          schedule={schedule}
          data={data}
          onDone={onChange}
        />
      )}
      {schedule && editing && (
        <ShiftDrawer
          key={editing.shift?.id ?? `${editing.staffId}-${editing.date}`}
          schedule={schedule}
          data={data}
          target={editing}
          attendance={editing.shift ? attByShift.get(editing.shift.id) : undefined}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null)
            await onChange()
          }}
        />
      )}
    </div>
  )
}

function NewScheduleDrawer({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const [type, setType] = useState<ShiftScheduleType>("weekly")
  const [start, setStart] = useState("")
  const [name, setName] = useState("")
  const act = useAction()
  return (
    <SubDrawer
      open={open}
      onClose={onClose}
      title="New schedule"
      subtitle="Created as a draft. Staff see it only after you publish."
      footer={
        <button
          className={DRAWER_BTN_PRIMARY}
          disabled={act.busy || !start}
          onClick={() =>
            act.run(
              async () => {
                const r = await createShiftSchedule({ type, periodStart: start, name })
                if (r.ok) await onDone(r.id)
                return r
              },
              onClose,
            )
          }
        >
          {act.busy ? "Creating…" : "Create schedule"}
        </button>
      }
    >
      <div className="space-y-4">
        <DrawerField label="Length">
          <select className={DRAWER_FIELD} value={type} onChange={(e) => setType(e.target.value as ShiftScheduleType)}>
            <option value="weekly">Weekly (7 days)</option>
            <option value="biweekly">Bi-weekly (14 days)</option>
            <option value="monthly">Monthly (to the same date next month)</option>
          </select>
        </DrawerField>
        <DrawerField label="Starts on" hint="Weekly rotas usually start on a Monday.">
          <input type="date" className={DRAWER_FIELD} value={start} onChange={(e) => setStart(e.target.value)} />
        </DrawerField>
        <DrawerField label="Name (optional)">
          <input className={DRAWER_FIELD} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </DrawerField>
        <Msg text={act.msg} />
      </div>
    </SubDrawer>
  )
}

function PatternDrawer({
  open,
  onClose,
  schedule,
  data,
  onDone,
}: {
  open: boolean
  onClose: () => void
  schedule: ShiftSchedule
  data: ShiftsData
  onDone: () => Promise<void>
}) {
  const templates = data.templates.filter((t) => t.active)
  const [staffId, setStaffId] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const act = useAction()
  const toggle = (d: number) => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d]))
  return (
    <SubDrawer
      open={open}
      onClose={onClose}
      title="Repeat a pattern"
      subtitle="Fills this schedule for one person. Days that already have a shift are skipped."
      footer={
        <button
          className={DRAWER_BTN_PRIMARY}
          disabled={act.busy || !staffId || !templateId}
          onClick={() =>
            act.run(
              async () => {
                const r = await applyWeeklyPattern({ scheduleId: schedule.id, staffId, templateId, weekdays })
                if (r.ok) await onDone()
                return r
              },
              onClose,
            )
          }
        >
          {act.busy ? "Applying…" : "Apply pattern"}
        </button>
      }
    >
      <div className="space-y-4">
        {templates.length === 0 && <p className={MUTED}>Add a shift type first (Shift types & rules tab).</p>}
        <DrawerField label="Staff member">
          <select className={DRAWER_FIELD} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Choose…</option>
            {data.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </DrawerField>
        <DrawerField label="Shift type">
          <select className={DRAWER_FIELD} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Choose…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.startTime}–{t.endTime})
              </option>
            ))}
          </select>
        </DrawerField>
        <DrawerGroup title="Weekdays">
          <div className="flex flex-wrap gap-2">
            {DAY_NAMES.map((n, d) => (
              <button key={n} type="button" aria-pressed={weekdays.includes(d)} onClick={() => toggle(d)} className={weekdays.includes(d) ? DRAWER_BTN_PRIMARY : DRAWER_BTN}>
                {n}
              </button>
            ))}
          </div>
        </DrawerGroup>
        <Msg text={act.msg} />
      </div>
    </SubDrawer>
  )
}

function ShiftDrawer({
  schedule,
  data,
  target,
  attendance,
  onClose,
  onDone,
}: {
  schedule: ShiftSchedule
  data: ShiftsData
  target: { shift?: ScheduledShift; staffId: string; date: string }
  attendance?: ShiftAttendanceRow
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const s = target.shift
  const templates = data.templates.filter((t) => t.active || t.id === s?.templateId)
  const [staffId, setStaffId] = useState(target.staffId)
  const [date, setDate] = useState(target.date)
  const [templateId, setTemplateId] = useState(s?.templateId ?? "")
  const [start, setStart] = useState(s?.startTime ?? "09:00")
  const [end, setEnd] = useState(s?.endTime ?? "17:00")
  const [note, setNote] = useState(s?.note ?? "")
  const act = useAction()
  const staffName = data.staff.find((x) => x.id === staffId)?.name ?? "Staff"

  return (
    <SubDrawer
      open
      onClose={onClose}
      title={s ? "Edit shift" : "Add shift"}
      subtitle={`${staffName} · ${prettyDate(date)}`}
      footer={
        <div className="flex gap-2">
          <button
            className={DRAWER_BTN_PRIMARY}
            disabled={act.busy}
            onClick={() =>
              act.run(
                () =>
                  saveScheduledShift({
                    id: s?.id,
                    scheduleId: schedule.id,
                    staffId,
                    date,
                    templateId: templateId || null,
                    startTime: start,
                    endTime: end,
                    note,
                  }),
                onDone,
              )
            }
          >
            {act.busy ? "Saving…" : "Save shift"}
          </button>
          {s && (
            <button className={DRAWER_BTN} disabled={act.busy} onClick={() => act.run(() => deleteScheduledShift(s.id), onDone)}>
              Delete
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <DrawerField label="Staff member">
          <select className={DRAWER_FIELD} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            {data.staff.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </DrawerField>
        <DrawerField label="Date" hint={`Must be inside ${prettyDate(schedule.periodStart)} – ${prettyDate(schedule.periodEnd)}.`}>
          <input type="date" className={DRAWER_FIELD} value={date} min={schedule.periodStart} max={schedule.periodEnd} onChange={(e) => setDate(e.target.value)} />
        </DrawerField>
        <DrawerField label="Shift type" hint="Pick a saved type, or choose Custom and set the times.">
          <select
            className={DRAWER_FIELD}
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value)
              const t = templates.find((x) => x.id === e.target.value)
              if (t) {
                setStart(t.startTime)
                setEnd(t.endTime)
              }
            }}
          >
            <option value="">Custom</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.startTime}–{t.endTime})
              </option>
            ))}
          </select>
        </DrawerField>
        <div className="grid grid-cols-2 gap-3">
          <DrawerField label="Start">
            <input type="time" className={DRAWER_FIELD} value={start} disabled={!!templateId} onChange={(e) => setStart(e.target.value)} />
          </DrawerField>
          <DrawerField label="End" hint="An end before the start means it finishes the next day.">
            <input type="time" className={DRAWER_FIELD} value={end} disabled={!!templateId} onChange={(e) => setEnd(e.target.value)} />
          </DrawerField>
        </div>
        <DrawerField label="Note (optional)">
          <input className={DRAWER_FIELD} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </DrawerField>

        {attendance && (
          <DrawerGroup title="Attendance" hint="From the clock-in pad. Excuse a late or no-show if there was a good reason.">
            <div className="flex items-center gap-2">
              {attendanceBadge(attendance)}
              {attendance.overrideStatus ? (
                <button className={DRAWER_BTN} disabled={act.busy} onClick={() => act.run(() => overrideAttendance(attendance.id, null), onDone)}>
                  Remove override
                </button>
              ) : attendance.status !== "on_time" ? (
                <button className={DRAWER_BTN} disabled={act.busy} onClick={() => act.run(() => overrideAttendance(attendance.id, "excused"), onDone)}>
                  Mark excused
                </button>
              ) : null}
            </div>
          </DrawerGroup>
        )}
        <Msg text={act.msg} />
      </div>
    </SubDrawer>
  )
}

// ---------------------------------------------------------------------------
// My shifts (any staff member with a linked profile)
// ---------------------------------------------------------------------------

function MyShifts({ data, timezone, onChange }: { data: ShiftsData; timezone: string; onChange: () => Promise<void> }) {
  const [swapFor, setSwapFor] = useState<ScheduledShift | null>(null)
  const today = todayKey(timezone)
  const publishedIds = new Set(data.schedules.filter((s) => s.status === "published").map((s) => s.id))
  const mine = data.shifts
    .filter((s) => s.staffId === data.myStaffId && s.status === "scheduled" && publishedIds.has(s.scheduleId) && s.date >= today)
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
  const attByShift = new Map(data.attendance.map((a) => [a.scheduledShiftId, a]))
  const hasOpenSwap = (id: string) => data.swaps.some((x) => x.shiftId === id && (x.status === "pending_colleague" || x.status === "pending_admin"))

  return (
    <div className="space-y-2">
      {mine.length === 0 && <p className={`${CARD} p-8 text-center ${MUTED}`}>No upcoming shifts published for you yet.</p>}
      {mine.map((s) => (
        <div key={s.id} className={`${CARD} flex items-center justify-between gap-3 px-4 py-3`}>
          <div>
            <p className="text-sm font-medium text-ink">{prettyDate(s.date)}</p>
            <p className={MUTED}>
              {s.startTime}–{s.endTime}
              {s.note ? ` · ${s.note}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {attendanceBadge(attByShift.get(s.id))}
            {hasOpenSwap(s.id) ? (
              <span className={MUTED}>Swap pending</span>
            ) : (
              <button className={DRAWER_BTN} onClick={() => setSwapFor(s)}>
                Request swap
              </button>
            )}
          </div>
        </div>
      ))}
      {swapFor && <SwapRequestDrawer shift={swapFor} onClose={() => setSwapFor(null)} onDone={async () => { setSwapFor(null); await onChange() }} />}
    </div>
  )
}

function SwapRequestDrawer({ shift, onClose, onDone }: { shift: ScheduledShift; onClose: () => void; onDone: () => Promise<void> }) {
  const [cands, setCands] = useState<SwapCandidate[] | null>(null)
  const [pick, setPick] = useState<SwapCandidate | null>(null)
  const [note, setNote] = useState("")
  const act = useAction()
  useEffect(() => {
    void getSwapCandidates(shift.id).then((r) => (r.ok ? setCands(r.candidates) : act.setMsg(r.error)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift.id])

  return (
    <SubDrawer
      open
      onClose={onClose}
      title="Request a swap"
      subtitle={`${prettyDate(shift.date)} · ${shift.startTime}–${shift.endTime}`}
      footer={
        <button
          className={DRAWER_BTN_PRIMARY}
          disabled={act.busy || !pick}
          onClick={() =>
            act.run(
              () => requestSwap({ shiftId: shift.id, targetStaffId: pick!.staffId, targetShiftId: pick!.shiftId, note }),
              onDone,
            )
          }
        >
          {act.busy ? "Sending…" : "Send request"}
        </button>
      }
    >
      <div className="space-y-3">
        <p className={MUTED}>Choose who could take your shift (or swap with one of theirs).</p>
        {cands === null && <p className={MUTED}>Loading…</p>}
        {cands?.length === 0 && <p className={MUTED}>Nobody is available to swap with for this shift.</p>}
        {cands?.map((c) => {
          const selected = pick?.staffId === c.staffId && pick?.shiftId === c.shiftId
          return (
            <button
              key={`${c.staffId}-${c.shiftId}`}
              type="button"
              aria-pressed={selected}
              onClick={() => setPick(c)}
              className={`w-full rounded-lg border p-3 text-left text-sm ${selected ? "border-ink bg-card" : "border-line-strong bg-card hover:bg-tint"}`}
            >
              <span className="font-medium">{c.staffName}</span>
              <span className="block text-xs text-ink-muted">
                {c.shiftId && c.date ? `Swap for their ${prettyDate(c.date)} ${c.startTime}–${c.endTime}` : "Just take my shift"}
              </span>
            </button>
          )
        })}
        <DrawerField label="Message (optional)">
          <input className={DRAWER_FIELD} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </DrawerField>
        <Msg text={act.msg} />
      </div>
    </SubDrawer>
  )
}

// ---------------------------------------------------------------------------
// Swaps (colleague responses, manager approvals)
// ---------------------------------------------------------------------------

const SWAP_LABEL: Record<ShiftSwap["status"], string> = {
  pending_colleague: "Waiting for colleague",
  pending_admin: "Waiting for manager",
  approved: "Approved",
  rejected: "Rejected",
  declined: "Declined",
  cancelled: "Cancelled",
}

function Swaps({ data, onChange }: { data: ShiftsData; onChange: () => Promise<void> }) {
  const act = useAction()
  const name = (id: string) => data.staff.find((s) => s.id === id)?.name ?? "Colleague"
  const shiftText = (id: string | null) => {
    const s = data.shifts.find((x) => x.id === id)
    return s ? `${prettyDate(s.date)} ${s.startTime}–${s.endTime}` : "a shift"
  }
  return (
    <div className="space-y-2">
      <Msg text={act.msg} />
      {data.swaps.length === 0 && <p className={`${CARD} p-8 text-center ${MUTED}`}>No swap requests.</p>}
      {data.swaps.map((s) => {
        const iAmTarget = s.targetStaffId === data.myStaffId
        const iAmRequester = s.requesterStaffId === data.myStaffId
        const open = s.status === "pending_colleague" || s.status === "pending_admin"
        return (
          <div key={s.id} className={`${CARD} space-y-2 px-4 py-3`}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-ink">
                <span className="font-medium">{name(s.requesterStaffId)}</span> wants <span className="font-medium">{name(s.targetStaffId)}</span> to take {shiftText(s.shiftId)}
                {s.targetShiftId ? ` in exchange for ${shiftText(s.targetShiftId)}` : ""}.
              </p>
              <span className="shrink-0 rounded bg-tint px-2 py-0.5 text-xs">{SWAP_LABEL[s.status]}</span>
            </div>
            {s.requesterNote && <p className={MUTED}>“{s.requesterNote}”</p>}
            {s.reviewNote && <p className={MUTED}>Manager: {s.reviewNote}</p>}
            <div className="flex flex-wrap gap-2">
              {s.status === "pending_colleague" && iAmTarget && (
                <>
                  <button className={DRAWER_BTN_PRIMARY} disabled={act.busy} onClick={() => act.run(() => respondSwap(s.id, true), onChange)}>
                    Accept
                  </button>
                  <button className={DRAWER_BTN} disabled={act.busy} onClick={() => act.run(() => respondSwap(s.id, false), onChange)}>
                    Decline
                  </button>
                </>
              )}
              {s.status === "pending_admin" && data.canManage && (
                <>
                  <button className={DRAWER_BTN_PRIMARY} disabled={act.busy} onClick={() => act.run(() => reviewSwap(s.id, true), onChange)}>
                    Approve
                  </button>
                  <button
                    className={DRAWER_BTN}
                    disabled={act.busy}
                    onClick={() => {
                      const note = prompt("Reason (optional)") ?? undefined
                      void act.run(() => reviewSwap(s.id, false, note), onChange)
                    }}
                  >
                    Reject
                  </button>
                </>
              )}
              {open && iAmRequester && (
                <button className={DRAWER_BTN} disabled={act.busy} onClick={() => act.run(() => cancelSwap(s.id), onChange)}>
                  Cancel request
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup (manager): shift types + rules
// ---------------------------------------------------------------------------

function Setup({ data, onChange }: { data: ShiftsData; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState<ShiftTemplate | "new" | null>(null)
  const act = useAction()
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Shift types</h2>
          <button className={DRAWER_BTN_PRIMARY} onClick={() => setEditing("new")}>
            Add shift type
          </button>
        </div>
        <Msg text={act.msg} />
        {data.templates.length === 0 && <p className={`${CARD} p-6 text-center ${MUTED}`}>Add types like Morning, Evening, Weekend.</p>}
        {data.templates.map((t) => (
          <div key={t.id} className={`${CARD} flex items-center justify-between gap-3 px-4 py-2.5 ${t.active ? "" : "opacity-60"}`}>
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full border border-line-strong" style={{ background: t.color ?? "var(--color-tint)" }} />
              <div>
                <p className="text-sm font-medium">{t.name}</p>
                <p className={MUTED}>
                  {t.startTime}–{t.endTime}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button className={DRAWER_BTN} onClick={() => setEditing(t)}>
                Edit
              </button>
              <button className={DRAWER_BTN} disabled={act.busy} onClick={() => act.run(() => setShiftTemplateActive(t.id, !t.active), onChange)}>
                {t.active ? "Archive" : "Restore"}
              </button>
            </div>
          </div>
        ))}
      </section>

      {data.settings && <SettingsCard settings={data.settings} onChange={onChange} />}

      {editing && <TemplateDrawer template={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await onChange() }} />}
    </div>
  )
}

function TemplateDrawer({ template, onClose, onDone }: { template: ShiftTemplate | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(template?.name ?? "")
  const [start, setStart] = useState(template?.startTime ?? "08:00")
  const [end, setEnd] = useState(template?.endTime ?? "16:00")
  const [color, setColor] = useState(template?.color ?? "#C9A24B")
  const act = useAction()
  return (
    <SubDrawer
      open
      onClose={onClose}
      title={template ? "Edit shift type" : "New shift type"}
      footer={
        <button className={DRAWER_BTN_PRIMARY} disabled={act.busy} onClick={() => act.run(() => saveShiftTemplate({ id: template?.id, name, startTime: start, endTime: end, color }), onDone)}>
          {act.busy ? "Saving…" : "Save"}
        </button>
      }
    >
      <div className="space-y-4">
        <DrawerField label="Name">
          <input className={DRAWER_FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning" />
        </DrawerField>
        <div className="grid grid-cols-2 gap-3">
          <DrawerField label="Start">
            <input type="time" className={DRAWER_FIELD} value={start} onChange={(e) => setStart(e.target.value)} />
          </DrawerField>
          <DrawerField label="End">
            <input type="time" className={DRAWER_FIELD} value={end} onChange={(e) => setEnd(e.target.value)} />
          </DrawerField>
        </div>
        <DrawerField label="Colour">
          <input type="color" className="h-9 w-16 rounded border border-line-strong" value={color} onChange={(e) => setColor(e.target.value)} />
        </DrawerField>
        <Msg text={act.msg} />
      </div>
    </SubDrawer>
  )
}

function SettingsCard({ settings, onChange }: { settings: ShiftSettings; onChange: () => Promise<void> }) {
  const [s, setS] = useState(settings)
  const act = useAction()
  const num = (k: keyof ShiftSettings, label: string, hint: string) => (
    <DrawerField label={label} hint={hint}>
      <input type="number" min={0} className={DRAWER_FIELD} value={s[k] as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
    </DrawerField>
  )
  return (
    <section className={`${CARD} space-y-3 p-4`}>
      <h2 className="text-sm font-semibold text-ink">Attendance & swap rules</h2>
      {num("lateGraceMinutes", "Late after (minutes)", "Clocking in later than this after the start counts as late.")}
      {num("noShowAfterMinutes", "No-show after (minutes)", "No clock-in by then marks the shift a no-show.")}
      {num("earlyClockInMinutes", "Early clock-in allowed (minutes)", "How early before the start someone can clock in for the shift.")}
      <DrawerSwitch
        title="Colleague must agree to swaps"
        description="Off: swap requests go straight to a manager."
        checked={s.swapRequiresColleague}
        onChange={(v) => setS({ ...s, swapRequiresColleague: v })}
      />
      {num("swapMinNoticeHours", "Swap notice (hours)", "Swaps can't be requested for shifts starting sooner than this.")}
      <Msg text={act.msg} />
      <button className={DRAWER_BTN_PRIMARY} disabled={act.busy} onClick={() => act.run(() => saveShiftSettings(s), onChange)}>
        {act.busy ? "Saving…" : "Save rules"}
      </button>
    </section>
  )
}
