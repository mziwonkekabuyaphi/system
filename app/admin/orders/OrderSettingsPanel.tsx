"use client"

// app/admin/orders/OrderSettingsPanel.tsx
//
// One order_settings row per shop. Until it's saved once, place_order() answers
// "ordering_not_configured", so the banner below is not decoration.

import { useState } from "react"

import { saveOrderSettings } from "./actions"
import { Field, ToggleRow, btn, cardCls, cx, inputCls, useNotice } from "./ui"
import type { AdminOrderSettings, AdminOrderVendor, DeliveryAreaInput, OrderSettingsInput, PaymentMethod } from "./types"

const METHODS: Array<{ id: PaymentMethod; hint: string }> = [
  { id: "wallet", hint: "Paid from the customer's balance, instantly." },
  { id: "card", hint: "Customer pays on a payment link. The order starts once the payment is confirmed." },
  { id: "cash", hint: "Paid when the order is collected." },
]

export function OrderSettingsPanel({
  settings,
  onSaved,
  vendors,
  canManage,
}: {
  settings: AdminOrderSettings
  onSaved: (s: AdminOrderSettings) => void
  vendors: AdminOrderVendor[]
  canManage: boolean
}) {
  const [d, setD] = useState<OrderSettingsInput>(() => {
    const { configured: _c, ...rest } = settings
    return rest
  })
  const [aliases, setAliases] = useState<Array<{ from: string; to: string }>>(() => Object.entries(settings.searchAliases).map(([from, to]) => ({ from, to })))
  const [ageOn, setAgeOn] = useState(settings.minAge !== null)
  const [saving, setSaving] = useState(false)
  const { show, node } = useNotice()
  const set = <K extends keyof OrderSettingsInput>(k: K, v: OrderSettingsInput[K]) => setD((p) => ({ ...p, [k]: v }))

  const noFulfilment = !d.collectionEnabled && !d.deliveryEnabled && !d.dineInEnabled
  const setArea = (i: number, patch: Partial<DeliveryAreaInput>) =>
    set("deliveryAreas", d.deliveryAreas.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const num = (v: string) => (v === "" ? 0 : Math.max(0, Number(v) || 0))
  const deliveryNeedsArea = d.deliveryEnabled && !d.deliveryAreas.some((a) => a.isActive && a.name.trim())

  const toggleMethod = (m: PaymentMethod, on: boolean) => set("allowedPaymentMethods", on ? [...d.allowedPaymentMethods, m] : d.allowedPaymentMethods.filter((x) => x !== m))

  async function save() {
    const searchAliases: Record<string, string> = {}
    for (const a of aliases) if (a.from.trim() && a.to.trim()) searchAliases[a.from] = a.to
    setSaving(true)
    const res = await saveOrderSettings({ ...d, minAge: ageOn ? (d.minAge ?? 18) : null, searchAliases })
    setSaving(false)
    if (!res.ok) return show(res.error, true)
    setD((p) => ({ ...p, deliveryAreas: res.data.deliveryAreas })) // pick up ids of areas just created
    onSaved(res.data)
    show("Order settings saved.")
  }

  return (
    <div className="max-w-2xl space-y-6">
      {!settings.configured && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-admin-text">
          Ordering isn&apos;t switched on for customers yet. Review these settings and save once to turn it on.
        </p>
      )}

      <fieldset disabled={!canManage} className="space-y-6">
        <section className={cx(cardCls, "space-y-4 p-5")}>
          <div>
            <h2 className="text-base font-medium text-admin-text">How customers get their order</h2>
            <p className="text-xs text-admin-text/60">When more than one is on, customers are asked to choose at checkout.</p>
          </div>
          <ToggleRow label="Collection" hint="Customer collects from the vendor's collection point." checked={d.collectionEnabled} onChange={(v) => set("collectionEnabled", v)} />
          {d.collectionEnabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ready in about (minutes)" hint="Shown in the confirmation, e.g. ready in about 15 minutes.">
                <input type="number" min={0} max={240} step={5} className={cx(inputCls, "max-w-32 tabular-nums")} value={d.prepTimeMinutes} onChange={(e) => set("prepTimeMinutes", Math.min(240, Math.trunc(num(e.target.value))))} />
              </Field>
              <Field label="Collection instructions (optional)" hint="e.g. Show your order number at the bar.">
                <input className={inputCls} maxLength={200} value={d.collectionInstructions ?? ""} onChange={(e) => set("collectionInstructions", e.target.value || null)} />
              </Field>
            </div>
          )}

          <ToggleRow label="Dine-in" hint="Customer orders to a table. They're asked for the table number." checked={d.dineInEnabled} onChange={(v) => set("dineInEnabled", v)} />

          <ToggleRow label="Delivery" hint="Customer shares their address. Fee and minimum order come from the area they pick." checked={d.deliveryEnabled} onChange={(v) => set("deliveryEnabled", v)} />
          {d.deliveryEnabled && (
            <div className="space-y-3">
              <Field label="Delivery takes about (minutes)" hint="Shown in the confirmation.">
                <input type="number" min={5} max={240} step={5} className={cx(inputCls, "max-w-32 tabular-nums")} value={d.deliveryTimeMinutes} onChange={(e) => set("deliveryTimeMinutes", Math.min(240, Math.trunc(num(e.target.value))))} />
              </Field>
              <div>
                <p className="text-xs font-medium text-admin-text/70">Delivery areas</p>
                <p className="text-xs text-admin-text/50">Where you deliver. The fee is charged once per checkout. Leave Free over empty to always charge the fee.</p>
              </div>
              {d.deliveryAreas.map((a, i) => (
                <div key={a.id ?? `new-${i}`} className="space-y-2 rounded-lg border border-admin-text/10 p-3">
                  <div className="flex items-center gap-2">
                    <input className={inputCls} aria-label="Area name" placeholder="Area or suburb name" maxLength={60} value={a.name} onChange={(e) => setArea(i, { name: e.target.value })} />
                    <button type="button" className={btn.ghost} aria-label="Remove area" onClick={() => set("deliveryAreas", d.deliveryAreas.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Fee">
                      <input type="number" min={0} step={1} className={cx(inputCls, "tabular-nums")} value={a.fee} onChange={(e) => setArea(i, { fee: num(e.target.value) })} />
                    </Field>
                    <Field label="Minimum order">
                      <input type="number" min={0} step={1} className={cx(inputCls, "tabular-nums")} value={a.minOrder} onChange={(e) => setArea(i, { minOrder: num(e.target.value) })} />
                    </Field>
                    <Field label="Free over">
                      <input type="number" min={0} step={1} placeholder="Never" className={cx(inputCls, "tabular-nums")} value={a.freeOver ?? ""} onChange={(e) => setArea(i, { freeOver: e.target.value === "" || Number(e.target.value) <= 0 ? null : Number(e.target.value) })} />
                    </Field>
                  </div>
                  <ToggleRow label="Delivering here" checked={a.isActive} onChange={(v) => setArea(i, { isActive: v })} />
                </div>
              ))}
              <button type="button" className={btn.ghost} onClick={() => set("deliveryAreas", [...d.deliveryAreas, { name: "", fee: 0, minOrder: 0, freeOver: null, isActive: true }])}>
                Add delivery area
              </button>
              {deliveryNeedsArea && <p className="text-sm text-red-600 dark:text-red-400">Add at least one active area, or turn delivery off.</p>}
            </div>
          )}
          {noFulfilment && <p className="text-sm text-red-600 dark:text-red-400">Turn on at least one: collection, dine-in or delivery.</p>}
        </section>

        <section className={cx(cardCls, "space-y-4 p-5")}>
          <h2 className="text-base font-medium text-admin-text">Payment</h2>
          <div className="space-y-3">
            {METHODS.map((m) => (
              <ToggleRow key={m.id} label={m.id === "wallet" ? `Pay with ${d.walletLabel || "wallet"}` : m.id === "card" ? "Pay by card" : "Pay with cash"} hint={m.hint} checked={d.allowedPaymentMethods.includes(m.id)} onChange={(on) => toggleMethod(m.id, on)} />
            ))}
          </div>
          {d.allowedPaymentMethods.length === 0 && <p className="text-sm text-red-600 dark:text-red-400">Allow at least one payment method.</p>}
          <Field label="What you call the wallet" hint="Shown to customers, e.g. Passport or Tab.">
            <input className={cx(inputCls, "max-w-xs")} value={d.walletLabel} onChange={(e) => set("walletLabel", e.target.value)} />
          </Field>
        </section>

        <section className={cx(cardCls, "space-y-4 p-5")}>
          <h2 className="text-base font-medium text-admin-text">Orders</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Order number prefix" hint="1 to 4 characters. O gives O-000001. Only affects new orders.">
              <input className={cx(inputCls, "max-w-32 uppercase")} maxLength={4} value={d.orderNumberPrefix} onChange={(e) => set("orderNumberPrefix", e.target.value.toUpperCase())} />
            </Field>
            <Field label="Default vendor" hint="Used for products that don't have a vendor of their own.">
              <select className={inputCls} value={d.defaultVendorId ?? ""} onChange={(e) => set("defaultVendorId", e.target.value || null)}>
                <option value="">None</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <ToggleRow label="Let customers schedule an order" hint="They pick a collection time; it appears on the board when that time arrives." checked={d.allowScheduling} onChange={(v) => set("allowScheduling", v)} />
          {d.allowScheduling && (
            <Field label="Earliest a customer can schedule, in minutes from now">
              <input type="number" min={0} step={5} className={cx(inputCls, "max-w-32 tabular-nums")} value={d.scheduleMinLeadMinutes} onChange={(e) => set("scheduleMinLeadMinutes", Math.max(0, Math.trunc(Number(e.target.value)) || 0))} />
            </Field>
          )}
          <ToggleRow label="Check customer age" hint="Applies to categories marked age restricted." checked={ageOn} onChange={setAgeOn} />
          {ageOn && (
            <Field label="Minimum age">
              <input type="number" min={1} max={99} step={1} className={cx(inputCls, "max-w-32 tabular-nums")} value={d.minAge ?? 18} onChange={(e) => set("minAge", Math.trunc(Number(e.target.value)) || 18)} />
            </Field>
          )}
        </section>

        <section className={cx(cardCls, "space-y-3 p-5")}>
          <div>
            <h2 className="text-base font-medium text-admin-text">Search shortcuts</h2>
            <p className="text-xs text-admin-text/60">Nicknames customers type, and what they should find. For example henny finds hennessy.</p>
          </div>
          {aliases.map((a, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputCls} aria-label="Customer types" placeholder="Customer types" value={a.from} onChange={(e) => setAliases((l) => l.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              <span aria-hidden="true" className="text-admin-text/40">
                →
              </span>
              <input className={inputCls} aria-label="Search for" placeholder="Search for" value={a.to} onChange={(e) => setAliases((l) => l.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
              <button type="button" className={btn.ghost} aria-label="Remove shortcut" onClick={() => setAliases((l) => l.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className={btn.ghost} onClick={() => setAliases((l) => [...l, { from: "", to: "" }])}>
            Add shortcut
          </button>
        </section>
      </fieldset>

      {canManage && (
        <div className="flex justify-end">
          <button type="button" className={btn.primary} disabled={saving || d.allowedPaymentMethods.length === 0 || noFulfilment || deliveryNeedsArea} onClick={() => void save()}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      )}
      {node}
    </div>
  )
}
