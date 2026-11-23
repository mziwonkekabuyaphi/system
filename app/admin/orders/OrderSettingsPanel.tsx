"use client"

// app/admin/orders/OrderSettingsPanel.tsx
//
// One order_settings row per shop. Until it's saved once, place_order() answers
// "ordering_not_configured", so the banner below is not decoration.
//
// Built from the same Settings pieces as the rest of Settings (SettingsCard, ToggleRow, FieldRow in
// app/admin/settings/ui), so its cards and toggles look like "AI configuration" and the others.

import { useState } from "react"

import {
  FieldRow,
  SettingsCard,
  SubSection,
  ToggleRow,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/app/admin/settings/ui"

import { saveOrderSettings } from "./actions"
import type { AdminOrderSettings, AdminOrderVendor, DeliveryAreaInput, OrderSettingsInput, PaymentMethod } from "./types"

const METHODS: Array<{ id: PaymentMethod; hint: string }> = [
  { id: "wallet", hint: "Paid from the customer's balance, instantly." },
  { id: "card", hint: "Customer pays on a payment link. The order starts once the payment is confirmed." },
  { id: "cash", hint: "Paid when the order is collected." },
]

const errorClass = "text-sm text-red-700"
const narrowInput = `${inputClass} max-w-32 tabular-nums`

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
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const set = <K extends keyof OrderSettingsInput>(k: K, v: OrderSettingsInput[K]) => setD((p) => ({ ...p, [k]: v }))

  const noFulfilment = !d.collectionEnabled && !d.deliveryEnabled && !d.dineInEnabled
  const setArea = (i: number, patch: Partial<DeliveryAreaInput>) =>
    set("deliveryAreas", d.deliveryAreas.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const num = (v: string) => (v === "" ? 0 : Math.max(0, Number(v) || 0))
  const deliveryNeedsArea = d.deliveryEnabled && !d.deliveryAreas.some((a) => a.isActive && a.name.trim())

  const toggleMethod = (m: PaymentMethod, on: boolean) => set("allowedPaymentMethods", on ? [...d.allowedPaymentMethods, m] : d.allowedPaymentMethods.filter((x) => x !== m))

  // "Payment before ordering" means nothing is left to pay at the counter, so cash can't be an option.
  const setRequirePayment = (on: boolean) =>
    setD((p) => ({ ...p, requirePayment: on, allowedPaymentMethods: on ? p.allowedPaymentMethods.filter((m) => m !== "cash") : p.allowedPaymentMethods }))
  const offeredMethods = d.requirePayment ? d.allowedPaymentMethods.filter((m) => m !== "cash") : d.allowedPaymentMethods

  // Order value limits are typed as text so the owner can clear a box; empty = no limit.
  const [minText, setMinText] = useState(settings.minOrderValue > 0 ? String(settings.minOrderValue) : "")
  const [maxText, setMaxText] = useState(settings.maxOrderValue !== null ? String(settings.maxOrderValue) : "")
  const minValue = minText.trim() === "" ? 0 : Number(minText)
  const maxValue = maxText.trim() === "" ? null : Number(maxText)
  const limitsError =
    !Number.isFinite(minValue) || minValue < 0
      ? "Minimum order value must be 0 or more."
      : maxValue !== null && (!Number.isFinite(maxValue) || maxValue <= 0)
        ? "Maximum order value must be more than 0, or left empty."
        : maxValue !== null && maxValue < minValue
          ? "Maximum order value can't be lower than the minimum."
          : null

  async function save() {
    if (limitsError) return setMessage({ ok: false, text: limitsError })
    const searchAliases: Record<string, string> = {}
    for (const a of aliases) if (a.from.trim() && a.to.trim()) searchAliases[a.from] = a.to
    setMessage(null)
    setSaving(true)
    const res = await saveOrderSettings({
      ...d,
      allowedPaymentMethods: offeredMethods,
      minOrderValue: minValue,
      maxOrderValue: maxValue,
      minAge: ageOn ? (d.minAge ?? 18) : null,
      searchAliases,
    })
    setSaving(false)
    if (!res.ok) return setMessage({ ok: false, text: res.error })
    setD((p) => ({ ...p, deliveryAreas: res.data.deliveryAreas })) // pick up ids of areas just created
    onSaved(res.data)
    setMessage({ ok: true, text: "Order settings saved." })
  }

  return (
    <div className="space-y-4">
      {!settings.configured && (
        <p role="status" className="rounded-md border border-line-strong bg-tint p-3 text-sm text-ink">
          Ordering isn&apos;t switched on for customers yet. Review these settings and save once to turn it on.
        </p>
      )}

      {/* A disabled fieldset switches off every control inside it for a caller who can't manage orders. */}
      <fieldset disabled={!canManage} className="min-w-0 space-y-4">
        <SettingsCard title="How customers get their order" description="When more than one is on, customers are asked to choose at checkout.">
          <div className="space-y-4">
            <ToggleRow title="Collection" description="Customer collects from the vendor's collection point." checked={d.collectionEnabled} onChange={(v) => set("collectionEnabled", v)} />
            {d.collectionEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldRow label="Ready in about (minutes)" hint="Shown in the confirmation, e.g. ready in about 15 minutes.">
                  <input type="number" min={0} max={240} step={5} className={narrowInput} value={d.prepTimeMinutes} onChange={(e) => set("prepTimeMinutes", Math.min(240, Math.trunc(num(e.target.value))))} />
                </FieldRow>
                <FieldRow label="Collection instructions (optional)" hint="e.g. Show your order number at the bar.">
                  <input className={inputClass} maxLength={200} value={d.collectionInstructions ?? ""} onChange={(e) => set("collectionInstructions", e.target.value || null)} />
                </FieldRow>
              </div>
            )}

            <ToggleRow title="Dine-in" description="Customer orders to a table. They're asked for the table number." checked={d.dineInEnabled} onChange={(v) => set("dineInEnabled", v)} />

            <ToggleRow title="Delivery" description="Customer shares their address. Fee and minimum order come from the area they pick." checked={d.deliveryEnabled} onChange={(v) => set("deliveryEnabled", v)} />
            {d.deliveryEnabled && (
              <div className="space-y-3">
                <FieldRow label="Delivery takes about (minutes)" hint="Shown in the confirmation.">
                  <input type="number" min={5} max={240} step={5} className={narrowInput} value={d.deliveryTimeMinutes} onChange={(e) => set("deliveryTimeMinutes", Math.min(240, Math.trunc(num(e.target.value))))} />
                </FieldRow>
                <SubSection
                  title="Delivery areas"
                  hint="Where you deliver. The fee is charged once per checkout. Leave Free over empty to always charge the fee. The minimum order is set under Order rules."
                >
                  <div className="space-y-3">
                    {d.deliveryAreas.map((a, i) => (
                      <div key={a.id ?? `new-${i}`} className="space-y-2 rounded-lg border border-line bg-card p-3">
                        <div className="flex items-center gap-2">
                          <input className={inputClass} aria-label="Area name" placeholder="Area or suburb name" maxLength={60} value={a.name} onChange={(e) => setArea(i, { name: e.target.value })} />
                          <button type="button" className={secondaryButtonClass} aria-label="Remove area" onClick={() => set("deliveryAreas", d.deliveryAreas.filter((_, j) => j !== i))}>
                            Remove
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <FieldRow label="Fee">
                            <input type="number" min={0} step={1} className={`${inputClass} tabular-nums`} value={a.fee} onChange={(e) => setArea(i, { fee: num(e.target.value) })} />
                          </FieldRow>
                          <FieldRow label="Free over">
                            <input type="number" min={0} step={1} placeholder="Never" className={`${inputClass} tabular-nums`} value={a.freeOver ?? ""} onChange={(e) => setArea(i, { freeOver: e.target.value === "" || Number(e.target.value) <= 0 ? null : Number(e.target.value) })} />
                          </FieldRow>
                        </div>
                        <ToggleRow title="Delivering here" description="Turn off to pause deliveries to this area." checked={a.isActive} onChange={(v) => setArea(i, { isActive: v })} />
                      </div>
                    ))}
                    <button type="button" className={secondaryButtonClass} onClick={() => set("deliveryAreas", [...d.deliveryAreas, { name: "", fee: 0, freeOver: null, isActive: true }])}>
                      Add delivery area
                    </button>
                  </div>
                </SubSection>
                {deliveryNeedsArea && <p className={errorClass}>Add at least one active area, or turn delivery off.</p>}
              </div>
            )}
            {noFulfilment && <p className={errorClass}>Turn on at least one: collection, dine-in or delivery.</p>}
          </div>
        </SettingsCard>

        <SettingsCard title="Order rules" description="How strictly orders are handled before they reach your team.">
          <div className="space-y-4">
            <ToggleRow
              title="Automatically accept orders"
              description="On: orders go straight to your board. Off: each new order waits for your team to accept or decline it, and the customer is told once you decide."
              checked={d.autoAcceptOrders}
              onChange={(v) => set("autoAcceptOrders", v)}
            />
            <ToggleRow
              title="Require payment before ordering"
              description="On: customers must pay with their wallet or by card to place an order. Pay with cash is switched off."
              checked={d.requirePayment}
              onChange={setRequirePayment}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow label="Minimum order value" hint="Customers can't check out with less than this. Delivery fee not counted. Leave empty for no minimum.">
                <input type="number" min={0} step={1} inputMode="decimal" className={`${inputClass} tabular-nums`} placeholder="No minimum" value={minText} onChange={(e) => setMinText(e.target.value)} />
              </FieldRow>
              <FieldRow label="Maximum order value" hint="Customers can't check out with more than this. Leave empty for no maximum.">
                <input type="number" min={0} step={1} inputMode="decimal" className={`${inputClass} tabular-nums`} placeholder="No maximum" value={maxText} onChange={(e) => setMaxText(e.target.value)} />
              </FieldRow>
            </div>
            {limitsError && <p className={errorClass}>{limitsError}</p>}
          </div>
        </SettingsCard>

        <SettingsCard title="Payment">
          <div className="space-y-4">
            {METHODS.filter((m) => !(d.requirePayment && m.id === "cash")).map((m) => (
              <ToggleRow
                key={m.id}
                title={m.id === "wallet" ? `Pay with ${d.walletLabel || "wallet"}` : m.id === "card" ? "Pay by card" : "Pay with cash"}
                description={m.hint}
                checked={offeredMethods.includes(m.id)}
                onChange={(on) => toggleMethod(m.id, on)}
              />
            ))}
            {d.requirePayment && <p className="text-xs text-ink-muted">Pay with cash is hidden because customers must pay before ordering.</p>}
            {offeredMethods.length === 0 && <p className={errorClass}>Allow at least one payment method.</p>}
            <FieldRow label="What you call the wallet" hint="Shown to customers, e.g. Passport or Tab.">
              <input className={`${inputClass} max-w-xs`} value={d.walletLabel} onChange={(e) => set("walletLabel", e.target.value)} />
            </FieldRow>
          </div>
        </SettingsCard>

        <SettingsCard title="Orders">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow label="Order number prefix" hint="1 to 4 characters. O gives O-000001. Only affects new orders.">
                <input className={`${inputClass} max-w-32 uppercase`} maxLength={4} value={d.orderNumberPrefix} onChange={(e) => set("orderNumberPrefix", e.target.value.toUpperCase())} />
              </FieldRow>
              <FieldRow label="Default vendor" hint="Used for products that don't have a vendor of their own.">
                <select className={inputClass} value={d.defaultVendorId ?? ""} onChange={(e) => set("defaultVendorId", e.target.value || null)}>
                  <option value="">None</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </FieldRow>
            </div>
            <ToggleRow title="Let customers schedule an order" description="They pick a collection time; it appears on the board when that time arrives." checked={d.allowScheduling} onChange={(v) => set("allowScheduling", v)} />
            {d.allowScheduling && (
              <FieldRow label="Earliest a customer can schedule, in minutes from now">
                <input type="number" min={0} step={5} className={narrowInput} value={d.scheduleMinLeadMinutes} onChange={(e) => set("scheduleMinLeadMinutes", Math.max(0, Math.trunc(Number(e.target.value)) || 0))} />
              </FieldRow>
            )}
            <ToggleRow title="Check customer age" description="Applies to categories marked age restricted." checked={ageOn} onChange={setAgeOn} />
            {ageOn && (
              <FieldRow label="Minimum age">
                <input type="number" min={1} max={99} step={1} className={narrowInput} value={d.minAge ?? 18} onChange={(e) => set("minAge", Math.trunc(Number(e.target.value)) || 18)} />
              </FieldRow>
            )}
          </div>
        </SettingsCard>

        <SettingsCard title="Search shortcuts" description="Nicknames customers type, and what they should find. For example henny finds hennessy.">
          <div className="space-y-3">
            {aliases.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className={inputClass} aria-label="Customer types" placeholder="Customer types" value={a.from} onChange={(e) => setAliases((l) => l.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                <span aria-hidden="true" className="text-ink-muted">
                  →
                </span>
                <input className={inputClass} aria-label="Search for" placeholder="Search for" value={a.to} onChange={(e) => setAliases((l) => l.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                <button type="button" className={secondaryButtonClass} aria-label="Remove shortcut" onClick={() => setAliases((l) => l.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className={secondaryButtonClass} onClick={() => setAliases((l) => [...l, { from: "", to: "" }])}>
              Add shortcut
            </button>
          </div>
        </SettingsCard>
      </fieldset>

      {canManage && (
        <div className="flex items-center justify-end gap-3">
          {message && <span className={`text-sm ${message.ok ? "text-success" : "text-red-700"}`}>{message.text}</span>}
          <button
            type="button"
            className={primaryButtonClass}
            disabled={saving || offeredMethods.length === 0 || noFulfilment || deliveryNeedsArea || limitsError !== null}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      )}
    </div>
  )
}
