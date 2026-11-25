"use client"

// app/admin/orders/DriversPanel.tsx
//
// The people who can take delivery jobs on WhatsApp. A driver is just a name and the WhatsApp number they message from:
// there is no login. They reply "on duty" to the shop's WhatsApp number to start getting job offers.
// How jobs are given out (first come / staff assign) is a setting under Settings > Order settings.

import { useState } from "react"

import { deleteDriver, saveDriver } from "./actions"
import { EmptyState, Field, Pill, btn, cardCls, cx, inputCls, useNotice } from "./ui"
import type { AdminDriver, DriverDispatchMode } from "./types"

type Setter<T> = (next: T[] | ((prev: T[]) => T[])) => void

export function DriversPanel({
  drivers,
  onChange,
  canManage,
  dispatchMode,
}: {
  drivers: AdminDriver[]
  onChange: Setter<AdminDriver>
  canManage: boolean
  dispatchMode: DriverDispatchMode
}) {
  const { show, node } = useNotice()
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [busy, setBusy] = useState<string | null>(null)

  async function add() {
    setBusy("new")
    const res = await saveDriver({ name, phone, isActive: true })
    setBusy(null)
    if (!res.ok) return show(res.error, true)
    onChange((prev) => [...prev, res.data].sort((a, b) => a.name.localeCompare(b.name)))
    setName("")
    setPhone("")
    show(`${res.data.name} added.`)
  }

  async function toggle(d: AdminDriver) {
    setBusy(d.id)
    const res = await saveDriver({ id: d.id, name: d.name, phone: d.phone, isActive: !d.isActive })
    setBusy(null)
    if (!res.ok) return show(res.error, true)
    onChange((prev) => prev.map((x) => (x.id === d.id ? { ...x, isActive: res.data.isActive } : x)))
  }

  async function remove(d: AdminDriver) {
    if (!window.confirm(`Remove ${d.name}? They will no longer be able to take deliveries.`)) return
    setBusy(d.id)
    const res = await deleteDriver(d.id)
    setBusy(null)
    if (!res.ok) return show(res.error, true)
    onChange((prev) => prev.filter((x) => x.id !== d.id))
    show(`${d.name} removed.`)
  }

  return (
    <section className={cx(cardCls, "space-y-4 p-5")}>
      <header className="space-y-1">
        <h2 className="text-base font-medium text-admin-text">Delivery drivers</h2>
        <p className="text-sm text-admin-text/60">
          {dispatchMode === "first_come"
            ? "Ready deliveries are offered to every driver who is on duty. The first to tap Take job gets it."
            : "You give each delivery to a driver from the Orders board. The driver is messaged on WhatsApp."}{" "}
          Drivers reply <span className="font-medium">on duty</span> to your WhatsApp number to start a shift and <span className="font-medium">jobs</span> to see what's open.
        </p>
      </header>

      {drivers.length === 0 ? (
        <EmptyState title="No drivers yet">Add a driver below. They don't need a login, only the WhatsApp number they'll message from.</EmptyState>
      ) : (
        <ul className="divide-y divide-admin-text/10 rounded-lg border border-admin-text/10">
          {drivers.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className={cx("text-sm font-medium text-admin-text", !d.isActive && "opacity-60")}>{d.name}</p>
                <p className="text-xs text-admin-text/60">{d.phone}</p>
              </div>
              {!d.isActive ? <Pill tone="neutral">Switched off</Pill> : d.onDuty ? <Pill tone="good">On duty</Pill> : <Pill>Off duty</Pill>}
              {canManage && (
                <div className="flex gap-2">
                  <button type="button" className={btn.ghost} disabled={busy === d.id} onClick={() => toggle(d)}>
                    {d.isActive ? "Switch off" : "Switch on"}
                  </button>
                  <button type="button" className={btn.danger} disabled={busy === d.id} onClick={() => remove(d)}>
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Driver name">
            <input className={inputCls} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sipho" />
          </Field>
          <Field label="WhatsApp number" hint="With country code, e.g. +27 82 123 4567. A number starting with 0 is read as South African.">
            <input className={inputCls} value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} placeholder="+27 82 123 4567" />
          </Field>
          <button type="button" className={btn.primary} disabled={busy === "new" || !name.trim() || !phone.trim()} onClick={add}>
            {busy === "new" ? "Adding…" : "Add driver"}
          </button>
        </div>
      )}
      {node}
    </section>
  )
}
