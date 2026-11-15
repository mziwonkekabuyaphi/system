"use client"

// app/admin/events/EventsManager.tsx
//
// The Events area of the shop admin, ported from the Rands "Event Manager" page:
// event cards on the left, the selected event's management panel on the right
// (edit / gate / delete, ticket inventory, recent purchases), plus an analytics
// panel. One component serves all three sidebar entries (Events, Box office,
// Gate) so the event list stays loaded when you move between them, the same way
// ShishaManager serves its six pages.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cancelTicket, deleteEvent, loadEventOrders, loadEvents, setEventStatus } from "./actions"
import { AnalyticsPanel } from "./AnalyticsPanel"
import { BoxOffice } from "./BoxOffice"
import { EventFormDialog } from "./EventFormDialog"
import { GatePanel } from "./GatePanel"
import { formatEventDate, formatMoney, safeTimezone } from "./format"
import type { EventOrder, EventSummary, EventsPermissions, EventsSection } from "./types"
import {
  ACCENT_RING,
  ACCENT_TEXT,
  BTN_DANGER,
  BTN_GHOST,
  BTN_PRIMARY,
  Chip,
  EmptyState,
  FOCUS,
  INPUT,
  Icon,
  LABEL,
  Modal,
  Notice,
  PANEL,
  ProgressBar,
  StatusPill,
  WELL,
} from "./ui"

export interface EventsManagerProps {
  section: EventsSection
  onSectionChange: (next: EventsSection) => void
  permissions: EventsPermissions
  /** tenant_settings.timezone */
  timezone: string
  /** tenant_settings.currency (ISO code); falls back to ZAR. */
  currency?: string
  /** Passport (the customer wallet) is on AND the caller can charge it (wallet.operate or
   *  wallet.manage), so Box office offers Passport as a way to pay. */
  canChargePassport: boolean
}

type Flash = { tone: "good" | "bad"; text: string } | null

const STATUS_ORDER = { active: 0, draft: 1, ended: 2, cancelled: 3 } as const

function sortEvents(list: EventSummary[]): EventSummary[] {
  return [...list].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    if (byStatus !== 0) return byStatus
    const diff = Date.parse(a.startTime) - Date.parse(b.startTime)
    // Upcoming first (soonest), past ones most-recent first.
    return a.status === "active" || a.status === "draft" ? diff : -diff
  })
}

function totals(event: EventSummary) {
  const capacity = event.ticketTypes.reduce((n, t) => n + t.capacity, 0)
  const sold = event.ticketTypes.reduce((n, t) => n + t.sold, 0)
  return { capacity, sold, soldOut: capacity > 0 && sold >= capacity }
}

export function EventsManager({ section, onSectionChange, permissions, timezone, currency = "ZAR", canChargePassport }: EventsManagerProps) {
  const tz = safeTimezone(timezone)
  const [events, setEvents] = useState<EventSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<{ event: EventSummary | null } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<void> } | null>(null)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [notice, setNotice] = useState<Flash>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = useCallback((tone: "good" | "bad", text: string) => {
    setNotice({ tone, text })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNotice(null), 4500)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const refresh = useCallback(async () => {
    const res = await loadEvents()
    if (res.ok) {
      setEvents(sortEvents(res.data))
      setLoadError(null)
    } else {
      setLoadError(res.error)
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  // Land on something useful: the first event on sale, else the first event.
  useEffect(() => {
    if (!events || events.length === 0) return
    if (selectedId && events.some((e) => e.id === selectedId)) return
    setSelectedId(events[0].id)
  }, [events, selectedId])

  const selected = useMemo(() => events?.find((e) => e.id === selectedId) ?? null, [events, selectedId])

  async function changeStatus(event: EventSummary, status: "draft" | "active" | "ended" | "cancelled", done: string) {
    const res = await setEventStatus(event.id, status)
    if (!res.ok) return flash("bad", res.error)
    flash("good", done)
    await refresh()
  }

  function askRemove(event: EventSummary) {
    setConfirm({
      title: "Delete event",
      body: `"${event.name}" and its ticket tiers will be deleted for good. An event with ticket sales can't be deleted. Cancel it instead.`,
      label: "Delete event",
      run: async () => {
        const res = await deleteEvent(event.id)
        if (!res.ok) return flash("bad", res.error)
        flash("good", "Event deleted.")
        setSelectedId(null)
        await refresh()
      },
    })
  }

  if (section === "boxoffice") {
    return (
      <>
        <BoxOffice
          events={events}
          loadError={loadError}
          selectedId={selectedId}
          onSelect={setSelectedId}
          canComplimentary={permissions.eventsManage}
          canChargePassport={canChargePassport}
          timezone={tz}
          currency={currency}
          onSold={refresh}
          onGoToEvents={() => onSectionChange("events")}
        />
        <Notice notice={notice} />
      </>
    )
  }

  if (section === "gate") {
    return (
      <GatePanel
        events={events}
        loadError={loadError}
        selectedId={selectedId}
        onSelect={setSelectedId}
        timezone={tz}
        onScanned={refresh}
        onGoToEvents={() => onSectionChange("events")}
      />
    )
  }

  return (
    <div className="space-y-6">
      {showAnalytics && events && (
        <AnalyticsPanel events={events} timezone={tz} currency={currency} canSeeSales={permissions.ticketsView} onClose={() => setShowAnalytics(false)} />
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,1fr)]">
        <section aria-labelledby="events-heading">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="events-heading" className="flex items-center gap-2 text-sm font-bold text-stone-900">
              <Icon name="calendar-days" className={ACCENT_TEXT} /> All events
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAnalytics((v) => !v)}
                aria-pressed={showAnalytics}
                title="Analytics"
                aria-label="Analytics"
                className={`flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-500/10 ${FOCUS} ${showAnalytics ? ACCENT_TEXT : ""}`}
              >
                <Icon name="chart-pie" />
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                title="Refresh"
                aria-label="Refresh"
                className={`flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-500/10 ${FOCUS}`}
              >
                <Icon name="rotate" />
              </button>
              {permissions.eventsManage && (
                <button type="button" className={BTN_PRIMARY} onClick={() => setForm({ event: null })}>
                  <Icon name="plus" /> Add event
                </button>
              )}
            </div>
          </div>

          {loadError ? (
            <EmptyState icon="triangle-exclamation" title="Couldn't load events" action={<button type="button" className={BTN_GHOST} onClick={() => void refresh()}>Try again</button>}>
              {loadError}
            </EmptyState>
          ) : events === null ? (
            <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-80 animate-pulse rounded-3xl bg-stone-500/10" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              icon="ticket"
              title="No events yet"
              action={permissions.eventsManage ? <button type="button" className={BTN_PRIMARY} onClick={() => setForm({ event: null })}><Icon name="plus" /> Create your first event</button> : undefined}
            >
              Create an event, set up its ticket tiers and put it on sale. Tickets can then be sold at the box office and scanned at the gate.
            </EmptyState>
          ) : (
            <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
              {events.map((event) => (
                <EventCard key={event.id} event={event} tz={tz} selected={event.id === selectedId} onSelect={() => setSelectedId(event.id)} />
              ))}
            </div>
          )}
        </section>

        <aside aria-label="Selected event">
          {selected ? (
            <EventDetails
              key={selected.id}
              event={selected}
              tz={tz}
              currency={currency}
              permissions={permissions}
              onEdit={() => setForm({ event: selected })}
              onDelete={() => askRemove(selected)}
              onOpenGate={() => onSectionChange("gate")}
              onSell={() => onSectionChange("boxoffice")}
              onStatus={(status, done) => void changeStatus(selected, status, done)}
              onConfirm={setConfirm}
              flash={flash}
              onChanged={refresh}
            />
          ) : (
            events && events.length > 0 && <EmptyState icon="hand-pointer" title="Select an event">Pick an event to see its tickets and recent purchases.</EmptyState>
          )}
        </aside>
      </div>

      {form && (
        <EventFormDialog
          event={form.event}
          timezone={tz}
          onClose={() => setForm(null)}
          onSaved={(id, message) => {
            setForm(null)
            setSelectedId(id)
            flash(message.includes("didn't upload") ? "bad" : "good", message)
            void refresh()
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          label={confirm.label}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const run = confirm.run
            setConfirm(null)
            await run()
          }}
        />
      )}
      <Notice notice={notice} />
    </div>
  )
}

// ----------------------------------------------------------------------------

function EventCard({ event, tz, selected, onSelect }: { event: EventSummary; tz: string; selected: boolean; onSelect: () => void }) {
  const { capacity, sold, soldOut } = totals(event)
  const dim = event.status === "cancelled" || event.status === "ended"
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`overflow-hidden rounded-3xl border bg-card text-left transition ${FOCUS} ${
        selected ? `border-transparent ${ACCENT_RING}` : "border-stone-200 hover:-translate-y-0.5 hover:border-stone-300"
      } ${dim ? "opacity-75" : ""}`}
    >
      <div className="relative h-44 bg-stone-500/10">
        {event.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Storage URL, not a static asset
          <img src={event.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-stone-400/60">
            <Icon name="ticket" className="text-5xl" />
          </div>
        )}
        <div className="absolute bottom-3 right-3">
          <StatusPill status={event.status} soldOut={soldOut} />
        </div>
      </div>
      <div className="space-y-3 p-5">
        <h3 className="line-clamp-2 text-lg font-bold leading-snug text-stone-900">{event.name}</h3>
        <div className="space-y-1.5 text-sm text-stone-500">
          <p className="flex items-center gap-2">
            <Icon name="calendar-days" className={`w-4 ${ACCENT_TEXT}`} /> {formatEventDate(event.startTime, tz)}
          </p>
          {event.location && (
            <p className="flex items-center gap-2">
              <Icon name="location-dot" className={`w-4 ${ACCENT_TEXT}`} /> <span className="truncate">{event.location}</span>
            </p>
          )}
        </div>
        <div>
          <ProgressBar value={sold} max={capacity} label={`${event.name} tickets sold`} />
          <div className="mt-1.5 flex justify-between text-xs text-stone-500">
            <span>
              <Icon name="ticket" className={ACCENT_TEXT} /> {sold} of {capacity} sold
            </span>
            <span>{event.ticketTypes.length} {event.ticketTypes.length === 1 ? "tier" : "tiers"}</span>
          </div>
        </div>
      </div>
    </button>
  )
}

// ----------------------------------------------------------------------------

function EventDetails({
  event,
  tz,
  currency,
  permissions,
  onEdit,
  onDelete,
  onOpenGate,
  onSell,
  onStatus,
  onConfirm,
  flash,
  onChanged,
}: {
  event: EventSummary
  tz: string
  currency: string
  permissions: EventsPermissions
  onEdit: () => void
  onDelete: () => void
  onOpenGate: () => void
  onSell: () => void
  onStatus: (status: "draft" | "active" | "ended" | "cancelled", done: string) => void
  onConfirm: (c: { title: string; body: string; label: string; run: () => Promise<void> }) => void
  flash: (tone: "good" | "bad", text: string) => void
  onChanged: () => Promise<void>
}) {
  const [orders, setOrders] = useState<EventOrder[] | null>(null)
  const [ordersError, setOrdersError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<{ order: EventOrder; ticketId: string; ticketNumber: string } | null>(null)

  const reloadOrders = useCallback(async () => {
    if (!permissions.ticketsView) return
    const res = await loadEventOrders(event.id)
    if (res.ok) {
      setOrders(res.data)
      setOrdersError(null)
    } else {
      setOrdersError(res.error)
    }
  }, [event.id, permissions.ticketsView])
  useEffect(() => { void reloadOrders() }, [reloadOrders])

  const { sold, capacity } = totals(event)
  const net = event.stats.gross - event.stats.refunded
  const live = event.status === "active"

  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-stone-900">
          <Icon name="crown" className={ACCENT_TEXT} /> Event management
        </h2>
        <div className="flex flex-wrap gap-2">
          {permissions.eventsManage && (
            <button type="button" className={BTN_GHOST} onClick={onEdit}>
              <Icon name="pencil" /> Edit
            </button>
          )}
          {live && permissions.ticketsIssue && (
            <button type="button" className={BTN_GHOST} onClick={onSell}>
              <Icon name="ticket" /> Sell
            </button>
          )}
          {live && permissions.ticketsScan && (
            <button type="button" className={BTN_GHOST} onClick={onOpenGate}>
              <Icon name="qrcode" /> Gate
            </button>
          )}
          {permissions.eventsManage && (
            <button type="button" className={BTN_DANGER} onClick={onDelete}>
              <Icon name="trash" /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="space-y-5 px-5 py-4">
        <div className={`${WELL} border-l-[3px] border-l-[var(--sb-accent,var(--color-admin-accent))] p-4`}>
          <p className="text-base font-bold text-stone-900">{event.name}</p>
          <p className="mt-2 flex items-center gap-2 text-xs text-stone-500">
            <Icon name="calendar-days" className={`w-4 ${ACCENT_TEXT}`} /> {formatEventDate(event.startTime, tz)}
            {event.endTime ? ` to ${formatEventDate(event.endTime, tz)}` : ""}
          </p>
          {event.location && (
            <p className="mt-1 flex items-center gap-2 text-xs text-stone-500">
              <Icon name="location-dot" className={`w-4 ${ACCENT_TEXT}`} /> {event.location}
            </p>
          )}
          {event.description && <p className="mt-3 text-sm text-stone-600">{event.description}</p>}
        </div>

        {permissions.eventsManage && (event.status === "draft" || event.status === "active") && (
          <div className="flex flex-wrap gap-2">
            {event.status === "draft" ? (
              <button type="button" className={BTN_PRIMARY} onClick={() => onStatus("active", "Event is on sale.")}>
                <Icon name="bolt" /> Put on sale
              </button>
            ) : (
              <>
                <button type="button" className={BTN_GHOST} onClick={() => onStatus("draft", "Event taken off sale.")}>
                  <Icon name="pause" /> Take off sale
                </button>
                <button
                  type="button"
                  className={BTN_GHOST}
                  onClick={() => onConfirm({ title: "End event", body: "This closes ticket sales and the gate. Tickets that weren't used stay as they are.", label: "End event", run: async () => onStatus("ended", "Event ended.") })}
                >
                  <Icon name="flag-checkered" /> End event
                </button>
              </>
            )}
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() => onConfirm({ title: "Cancel event", body: "Ticket sales and the gate close. Tickets already sold aren't refunded automatically. Refund them from Recent purchases.", label: "Cancel event", run: async () => onStatus("cancelled", "Event cancelled.") })}
            >
              <Icon name="ban" /> Cancel event
            </button>
          </div>
        )}

        {permissions.ticketsView && (
          <dl className="grid grid-cols-3 gap-2 text-center">
            <Metric label="Sales" value={formatMoney(net, currency)} />
            <Metric label="Tickets sold" value={`${sold}/${capacity}`} />
            <Metric label="Checked in" value={`${event.stats.ticketsAdmitted}`} />
          </dl>
        )}

        <section aria-labelledby="inv-h" className={`${WELL} p-1`}>
          <h3 id="inv-h" className={`flex items-center gap-2 px-3.5 pb-1 pt-3 text-xs font-bold ${ACCENT_TEXT}`}>
            <Icon name="chart-simple" /> Ticket inventory
          </h3>
          <ul className="space-y-2 px-3.5 pb-3.5">
            {event.ticketTypes.map((t) => (
              <li key={t.id} className="rounded-xl border border-stone-200 bg-card px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-bold text-stone-900">
                    {t.name}
                    {!t.isActive && <Chip>Off sale</Chip>}
                  </span>
                  <Chip tone="accent">{t.price === 0 ? "Free" : formatMoney(t.price, currency)}</Chip>
                </div>
                <div className="mt-2">
                  <ProgressBar value={t.sold} max={t.capacity} label={`${t.name} sold`} />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-stone-500">
                  <span><strong className="text-stone-800">{t.sold}</strong> sold</span>
                  <span><strong className="text-stone-800">{Math.max(t.capacity - t.sold, 0)}</strong> left</span>
                  <span>of {t.capacity}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {permissions.ticketsView && (
          <section aria-labelledby="buy-h">
            <h3 id="buy-h" className={`mb-3 flex items-center gap-2 px-1 text-xs font-bold ${ACCENT_TEXT}`}>
              <Icon name="users" /> Recent purchases
            </h3>
            {ordersError ? (
              <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{ordersError}</p>
            ) : orders === null ? (
              <div className="h-16 animate-pulse rounded-2xl bg-stone-500/10" aria-busy="true" />
            ) : orders.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
                No purchases yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {orders.map((o) => {
                  const expanded = open === o.id
                  return (
                    <li key={o.id} className="rounded-2xl border border-stone-200 bg-card">
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : o.id)}
                        aria-expanded={expanded}
                        className={`flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left ${FOCUS}`}
                      >
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--sb-accent,var(--color-admin-accent))_14%,transparent)] ${ACCENT_TEXT}`}>
                          <Icon name={o.channel === "online" ? "mobile-screen" : "cash-register"} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-stone-900">
                            {o.quantity} × {o.ticketTypeName}
                          </span>
                          <span className="block truncate text-xs text-stone-500">
                            {o.customerName ?? o.customerPhone ?? "Walk-in"} · {o.paymentMethod}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className={`block text-sm font-bold ${ACCENT_TEXT}`}>{o.total === 0 ? "Free" : formatMoney(o.total, currency)}</span>
                          {o.refundedTotal > 0 && <span className="block text-[0.68rem] text-red-600">−{formatMoney(o.refundedTotal, currency)}</span>}
                        </span>
                      </button>
                      {expanded && (
                        <ul className="space-y-1.5 border-t border-stone-200 px-3.5 py-3">
                          {o.tickets.map((t) => (
                            <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-mono text-stone-800">{t.ticketNumber}</span>
                              <span className="flex items-center gap-2">
                                <Chip tone={t.status === "issued" ? "good" : t.status === "used" ? "neutral" : "bad"}>
                                  {t.status === "used" ? "Checked in" : t.status === "issued" ? (t.entriesUsed > 0 ? `In ${t.entriesUsed}/${t.entriesAllowed}` : "Valid") : t.status === "refunded" ? "Refunded" : "Cancelled"}
                                </Chip>
                                {permissions.ticketsManage && t.status === "issued" && t.entriesUsed === 0 && (
                                  <button
                                    type="button"
                                    onClick={() => setCancelling({ order: o, ticketId: t.id, ticketNumber: t.ticketNumber })}
                                    className={`rounded-full px-2 py-0.5 font-semibold text-red-600 hover:bg-red-500/10 ${FOCUS}`}
                                  >
                                    Cancel
                                  </button>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
      </div>

      {cancelling && (
        <CancelTicketDialog
          order={cancelling.order}
          ticketNumber={cancelling.ticketNumber}
          onClose={() => setCancelling(null)}
          onConfirm={async (refund, reason) => {
            const res = await cancelTicket(cancelling.ticketId, refund, reason)
            if (!res.ok) return res.error
            setCancelling(null)
            flash("good", refund ? "Ticket cancelled and refunded." : "Ticket cancelled.")
            await Promise.all([reloadOrders(), onChanged()])
            return null
          }}
        />
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${WELL} px-2 py-2.5`}>
      <dd className="text-sm font-bold text-stone-900">{value}</dd>
      <dt className="mt-0.5 text-[0.68rem] text-stone-500">{label}</dt>
    </div>
  )
}

function CancelTicketDialog({
  order,
  ticketNumber,
  onClose,
  onConfirm,
}: {
  order: EventOrder
  ticketNumber: string
  onClose: () => void
  onConfirm: (refund: boolean, reason: string) => Promise<string | null>
}) {
  const paid = order.total > 0 && order.paymentMethod !== "complimentary" && order.paymentMethod !== "free"
  const toWallet = order.paymentMethod === "wallet"
  const [refund, setRefund] = useState(paid)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Modal
      title={`Cancel ${ticketNumber}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>Keep ticket</button>
          <button
            type="button"
            className={BTN_DANGER}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const err = await onConfirm(refund, reason)
              if (err) {
                setError(err)
                setBusy(false)
              }
            }}
          >
            {busy ? "Cancelling…" : "Cancel ticket"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          The ticket stops working and its place goes back on sale. Only tickets that haven&apos;t been scanned in can be cancelled.
        </p>
        {paid && (
          <label className={`${WELL} flex cursor-pointer items-start gap-3 p-3 text-sm`}>
            <input type="checkbox" className="mt-0.5" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
            <span>
              <span className="font-medium text-stone-800">Refund this ticket</span>
              <span className="block text-xs text-stone-500">
                {toWallet ? "The money goes back to the customer's Passport." : "This is recorded as refunded. Hand the money back yourself."}
              </span>
            </span>
          </label>
        )}
        <div>
          <label className={LABEL} htmlFor="cancel-reason">Reason (optional)</label>
          <input id="cancel-reason" className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}

function ConfirmDialog({
  title,
  body,
  label,
  onClose,
  onConfirm,
}: {
  title: string
  body: string
  label: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>Go back</button>
          <button
            type="button"
            className={BTN_DANGER}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onConfirm()
            }}
          >
            {label}
          </button>
        </>
      }
    >
      <p className="text-sm text-stone-600">{body}</p>
    </Modal>
  )
}
