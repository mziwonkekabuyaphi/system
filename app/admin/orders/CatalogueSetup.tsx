"use client"

// app/admin/orders/CatalogueSetup.tsx
//
// Categories (replaces the old hardcoded VALID_CATEGORIES list) and vendors
// (collection points: where an order is picked up, e.g. "Main bar", "Kitchen").
// Both are per-shop rows now, so each business sets up its own.

import { useState } from "react"

import { createCategory, createVendor, deleteCategory, deleteVendor, updateCategory, updateVendor } from "./actions"
import { EmptyState, Field, Pill, ToggleRow, btn, cardCls, cx, inputCls, useNotice } from "./ui"
import type { AdminOrderVendor, AdminProduct, AdminProductCategory, CategoryInput, VendorInput } from "./types"

type Setter<T> = (next: T[] | ((prev: T[]) => T[])) => void

export function CatalogueSetup({
  categories,
  onCategoriesChange,
  vendors,
  onVendorsChange,
  products,
  canManage,
}: {
  categories: AdminProductCategory[]
  onCategoriesChange: Setter<AdminProductCategory>
  vendors: AdminOrderVendor[]
  onVendorsChange: Setter<AdminOrderVendor>
  products: AdminProduct[]
  canManage: boolean
}) {
  const { show, node } = useNotice()
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <CategoriesCard categories={categories} onChange={onCategoriesChange} products={products} canManage={canManage} show={show} />
      <VendorsCard vendors={vendors} onChange={onVendorsChange} products={products} canManage={canManage} show={show} />
      {node}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const blankCategory: CategoryInput = { label: "", emoji: null, groupKey: null, groupLabel: null, aliases: [], ageRestricted: false, sortOrder: 0, isActive: true }

function CategoriesCard({
  categories,
  onChange,
  products,
  canManage,
  show,
}: {
  categories: AdminProductCategory[]
  onChange: Setter<AdminProductCategory>
  products: AdminProduct[]
  canManage: boolean
  show: (t: string, e?: boolean) => void
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const counts = new Map<string, number>()
  for (const p of products) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1)

  return (
    <section className={cardCls}>
      <header className="flex items-center justify-between border-b border-admin-text/10 px-4 py-3">
        <div>
          <h2 className="text-base font-medium text-admin-text">Categories</h2>
          <p className="text-xs text-admin-text/60">How your menu is grouped in WhatsApp.</p>
        </div>
        {canManage && editing !== "new" && (
          <button type="button" className={btn.primary} onClick={() => setEditing("new")}>
            Add category
          </button>
        )}
      </header>

      {editing === "new" && (
        <div className="border-b border-admin-text/10 bg-admin-text/[0.03] p-4">
          <CategoryForm
            initial={blankCategory}
            submitLabel="Add category"
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              const res = await createCategory(v)
              if (!res.ok) return show(res.error, true)
              onChange((prev) => [...prev, res.data].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)))
              show("Category added.")
              setEditing(null)
            }}
          />
        </div>
      )}

      {categories.length === 0 && editing !== "new" ? (
        <EmptyState title="No categories yet">Add a few, like Beers or Spirits, so customers can browse by type.</EmptyState>
      ) : (
        <ul className="divide-y divide-admin-text/10">
          {categories.map((c) => (
            <li key={c.id} className="px-4 py-3">
              {editing === c.id ? (
                <CategoryForm
                  initial={c}
                  submitLabel="Save category"
                  onCancel={() => setEditing(null)}
                  onDelete={async () => {
                    if (!window.confirm(`Delete "${c.label}"?`)) return
                    const res = await deleteCategory(c.id)
                    if (!res.ok) return show(res.error, true)
                    onChange((prev) => prev.filter((x) => x.id !== c.id))
                    show("Category deleted.")
                    setEditing(null)
                  }}
                  onSubmit={async (v) => {
                    const res = await updateCategory(c.id, v)
                    if (!res.ok) return show(res.error, true)
                    onChange((prev) => prev.map((x) => (x.id === c.id ? res.data : x)).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)))
                    show("Category saved.")
                    setEditing(null)
                  }}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="w-6 text-center text-lg" aria-hidden="true">
                    {c.emoji ?? ""}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-admin-text">{c.label}</p>
                    <p className="truncate text-xs text-admin-text/60">
                      {counts.get(c.id) ?? 0} product{(counts.get(c.id) ?? 0) === 1 ? "" : "s"}
                      {c.groupLabel ? ` · in ${c.groupLabel}` : ""}
                      {c.aliases.length ? ` · also "${c.aliases.slice(0, 3).join('", "')}"` : ""}
                    </p>
                  </div>
                  {c.ageRestricted && <Pill tone="warn">Age restricted</Pill>}
                  {!c.isActive && <Pill>Off</Pill>}
                  {canManage && (
                    <button type="button" className={btn.ghost} onClick={() => setEditing(c.id)}>
                      Edit
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CategoryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initial: CategoryInput
  submitLabel: string
  onSubmit: (v: CategoryInput) => Promise<void>
  onCancel: () => void
  onDelete?: () => Promise<void>
}) {
  const [v, setV] = useState<CategoryInput>({ label: initial.label, emoji: initial.emoji, groupKey: initial.groupKey, groupLabel: initial.groupLabel, aliases: initial.aliases, ageRestricted: initial.ageRestricted, sortOrder: initial.sortOrder, isActive: initial.isActive })
  const [aliasText, setAliasText] = useState(initial.aliases.join(", "))
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof CategoryInput>(k: K, val: CategoryInput[K]) => setV((p) => ({ ...p, [k]: val }))

  async function submit() {
    setBusy(true)
    await onSubmit({ ...v, aliases: aliasText.split(",").map((a) => a.trim()).filter(Boolean) })
    setBusy(false)
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_5rem]">
        <Field label="Name">
          <input className={inputCls} value={v.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Whiskey" />
        </Field>
        <Field label="Emoji">
          <input className={inputCls} value={v.emoji ?? ""} maxLength={4} onChange={(e) => set("emoji", e.target.value)} />
        </Field>
      </div>
      <Field label="Other words customers use" hint="Comma separated, e.g. scotch, bourbon. Helps WhatsApp match loose requests.">
        <input className={inputCls} value={aliasText} onChange={(e) => setAliasText(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Browse together under" hint="Categories with the same group show in one menu, e.g. Drinks.">
          <input className={inputCls} value={v.groupLabel ?? ""} onChange={(e) => setV((p) => ({ ...p, groupLabel: e.target.value, groupKey: e.target.value })) } />
        </Field>
        <Field label="Order in menu" hint="Lower numbers first.">
          <input type="number" step={1} className={cx(inputCls, "tabular-nums")} value={v.sortOrder} onChange={(e) => set("sortOrder", Math.trunc(Number(e.target.value)) || 0)} />
        </Field>
      </div>
      <ToggleRow label="Age restricted" hint="Customers must meet the minimum age in Order settings." checked={v.ageRestricted} onChange={(x) => set("ageRestricted", x)} />
      <ToggleRow label="Show in menu" checked={v.isActive} onChange={(x) => set("isActive", x)} />
      <div className="flex items-center gap-2">
        {onDelete && (
          <button type="button" className={btn.danger} disabled={busy} onClick={() => void onDelete()}>
            Delete
          </button>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" className={btn.ghost} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={btn.primary} disabled={busy || !v.label.trim()} onClick={() => void submit()}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

const blankVendor: VendorInput = { name: "", collectionPoint: "", isActive: true }

function VendorsCard({
  vendors,
  onChange,
  products,
  canManage,
  show,
}: {
  vendors: AdminOrderVendor[]
  onChange: Setter<AdminOrderVendor>
  products: AdminProduct[]
  canManage: boolean
  show: (t: string, e?: boolean) => void
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const counts = new Map<string, number>()
  for (const p of products) if (p.vendorId) counts.set(p.vendorId, (counts.get(p.vendorId) ?? 0) + 1)
  const sort = (list: AdminOrderVendor[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <section className={cardCls}>
      <header className="flex items-center justify-between border-b border-admin-text/10 px-4 py-3">
        <div>
          <h2 className="text-base font-medium text-admin-text">Vendors</h2>
          <p className="text-xs text-admin-text/60">Who prepares an order and where the customer collects it. A cart with items from two vendors becomes two orders.</p>
        </div>
        {canManage && editing !== "new" && (
          <button type="button" className={btn.primary} onClick={() => setEditing("new")}>
            Add vendor
          </button>
        )}
      </header>

      {editing === "new" && (
        <div className="border-b border-admin-text/10 bg-admin-text/[0.03] p-4">
          <VendorForm
            initial={blankVendor}
            submitLabel="Add vendor"
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              const res = await createVendor(v)
              if (!res.ok) return show(res.error, true)
              onChange((prev) => sort([...prev, res.data]))
              show("Vendor added.")
              setEditing(null)
            }}
          />
        </div>
      )}

      {vendors.length === 0 && editing !== "new" ? (
        <EmptyState title="No vendors yet">Add at least one, such as the bar or kitchen, so orders know where to be collected.</EmptyState>
      ) : (
        <ul className="divide-y divide-admin-text/10">
          {vendors.map((v) => (
            <li key={v.id} className="px-4 py-3">
              {editing === v.id ? (
                <VendorForm
                  initial={v}
                  submitLabel="Save vendor"
                  onCancel={() => setEditing(null)}
                  onDelete={async () => {
                    if (!window.confirm(`Delete "${v.name}"?`)) return
                    const res = await deleteVendor(v.id)
                    if (!res.ok) return show(res.error, true)
                    onChange((prev) => prev.filter((x) => x.id !== v.id))
                    show("Vendor deleted.")
                    setEditing(null)
                  }}
                  onSubmit={async (val) => {
                    const res = await updateVendor(v.id, val)
                    if (!res.ok) return show(res.error, true)
                    onChange((prev) => sort(prev.map((x) => (x.id === v.id ? res.data : x))))
                    show("Vendor saved.")
                    setEditing(null)
                  }}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-admin-text">{v.name}</p>
                    <p className="truncate text-xs text-admin-text/60">
                      Collect from {v.collectionPoint} · {counts.get(v.id) ?? 0} product{(counts.get(v.id) ?? 0) === 1 ? "" : "s"}
                    </p>
                  </div>
                  {!v.isActive && <Pill>Off</Pill>}
                  {canManage && (
                    <button type="button" className={btn.ghost} onClick={() => setEditing(v.id)}>
                      Edit
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function VendorForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initial: VendorInput
  submitLabel: string
  onSubmit: (v: VendorInput) => Promise<void>
  onCancel: () => void
  onDelete?: () => Promise<void>
}) {
  const [v, setV] = useState<VendorInput>({ name: initial.name, collectionPoint: initial.collectionPoint, isActive: initial.isActive })
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-4">
      <Field label="Name">
        <input className={inputCls} value={v.name} onChange={(e) => setV((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Main bar" />
      </Field>
      <Field label="Where customers collect" hint="Sent to the customer in their order confirmation.">
        <input className={inputCls} value={v.collectionPoint} onChange={(e) => setV((p) => ({ ...p, collectionPoint: e.target.value }))} placeholder="e.g. Bar counter, ground floor" />
      </Field>
      <ToggleRow label="Taking orders" checked={v.isActive} onChange={(x) => setV((p) => ({ ...p, isActive: x }))} />
      <div className="flex items-center gap-2">
        {onDelete && (
          <button type="button" className={btn.danger} disabled={busy} onClick={() => void onDelete()}>
            Delete
          </button>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" className={btn.ghost} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={btn.primary}
            disabled={busy || !v.name.trim() || !v.collectionPoint.trim()}
            onClick={async () => {
              setBusy(true)
              await onSubmit(v)
              setBusy(false)
            }}
          >
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
