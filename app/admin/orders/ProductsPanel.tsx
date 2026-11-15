"use client"

// app/admin/orders/ProductsPanel.tsx
//
// The old single-shop "Product Manager", rebuilt for a multi-tenant shop.
//
// What carried over: search + category filter, stat strip, inline editing of
// name / price / stock / availability (saved on blur or change), image upload,
// and the "Manage product" editor (now a drawer) with Duplicate and Archive.
//
// What changed with the new schema:
//  - Category is a real per-shop table (product_categories), not a hardcoded
//    list. "Alcohol" is now the category's age_restricted flag.
//  - Each product can have a vendor (= where it's collected from).
//  - Gone because the tables have no column for them: SKU, barcode, cost price,
//    featured, variants/options/gallery/related, per-channel visibility, the
//    analytics placeholders and the Chart.js overlay. Say if you want any back.
//  - Nothing here sends a tenant id; the server actions take it from the session.

import { useMemo, useState } from "react"

import { createProduct, deleteProduct, duplicateProduct, updateProduct, uploadProductImage } from "./actions"
import { Drawer, EmptyState, Field, Pill, Stat, ToggleRow, Toggle, btn, cardCls, cx, inputCls, money, useNotice } from "./ui"
import { PRODUCT_STATUSES, type AdminOrderVendor, type AdminProduct, type AdminProductCategory, type ProductInput, type ProductStatus } from "./types"

type SetProducts = (next: AdminProduct[] | ((prev: AdminProduct[]) => AdminProduct[])) => void

const STATUS_LABEL: Record<ProductStatus, string> = { draft: "Draft", active: "Active", hidden: "Hidden", archived: "Archived" }
const STATUS_TONE: Record<ProductStatus, "neutral" | "good" | "warn"> = { draft: "warn", active: "good", hidden: "neutral", archived: "neutral" }

const emptyDraft = (categoryId: string | null): ProductInput => ({
  categoryId,
  vendorId: null,
  name: "",
  brand: null,
  description: null,
  shortDescription: null,
  price: 0,
  status: "active",
  isAvailable: true,
  trackInventory: false,
  stockQuantity: null,
  imageUrl: null,
})

export function ProductsPanel({
  products,
  onProductsChange,
  categories,
  vendors,
  defaultVendorId,
  canManage,
  currency,
}: {
  products: AdminProduct[]
  onProductsChange: SetProducts
  categories: AdminProductCategory[]
  vendors: AdminOrderVendor[]
  /** order_settings.default_vendor_id: used for products with no vendor of their own. */
  defaultVendorId: string | null
  canManage: boolean
  currency: string
}) {
  const [query, setQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState<"" | "all" | ProductStatus>("")
  const [drawer, setDrawer] = useState<{ mode: "add" } | { mode: "edit"; id: string } | null>(null)
  const { show, node } = useNotice()

  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.label])), [categories])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      if (statusFilter === "" ? p.status === "archived" : statusFilter !== "all" && p.status !== statusFilter) return false
      if (categoryFilter === "none" ? p.categoryId !== null : categoryFilter && p.categoryId !== categoryFilter) return false
      if (!q) return true
      return [p.name, p.brand, p.shortDescription, p.categoryId ? categoryName.get(p.categoryId) : ""].some((v) => (v ?? "").toLowerCase().includes(q))
    })
  }, [products, query, categoryFilter, statusFilter, categoryName])

  const live = products.filter((p) => p.status === "active" && p.isAvailable)
  const outOfStock = products.filter((p) => p.status === "active" && p.trackInventory && (p.stockQuantity ?? 0) <= 0)
  const notLive = products.filter((p) => p.status === "draft" || p.status === "hidden")
  const priced = products.filter((p) => p.status === "active")
  const avgPrice = priced.length ? priced.reduce((s, p) => s + p.price, 0) / priced.length : 0

  /** Optimistic save for the inline cells: shows the change at once, puts the old row back if the server says no. */
  async function save(id: string, patch: Partial<ProductInput>) {
    const before = products.find((p) => p.id === id)
    if (!before) return
    onProductsChange((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    const res = await updateProduct(id, patch)
    if (!res.ok) {
      onProductsChange((prev) => prev.map((p) => (p.id === id ? before : p)))
      show(res.error, true)
      return
    }
    onProductsChange((prev) => prev.map((p) => (p.id === id ? res.data : p)))
  }

  const editing = drawer?.mode === "edit" ? products.find((p) => p.id === drawer.id) ?? null : null

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Orderable now" value={live.length} />
        <Stat label="Out of stock" value={outOfStock.length} tone={outOfStock.length ? "warn" : undefined} />
        <Stat label="Draft or hidden" value={notLive.length} />
        <Stat label="Average price" value={money(avgPrice, currency)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className={cx(inputCls, "max-w-xs")} placeholder="Search products" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" />
        <select className={cx(inputCls, "max-w-[12rem]")} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
          <option value="none">No category</option>
        </select>
        <select className={cx(inputCls, "max-w-[11rem]")} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="Filter by status">
          <option value="">Not archived</option>
          <option value="all">Everything</option>
          {PRODUCT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]} only
            </option>
          ))}
        </select>
        {canManage && (
          <button type="button" className={cx(btn.primary, "ml-auto")} onClick={() => setDrawer({ mode: "add" })}>
            Add product
          </button>
        )}
      </div>

      {canManage && vendors.length === 0 && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-admin-text">
          No vendors yet. Orders need a collection point: add one under Categories &amp; vendors before customers can order.
        </p>
      )}

      <div className={cx(cardCls, "overflow-x-auto")}>
        {filtered.length === 0 ? (
          <EmptyState title={products.length === 0 ? "No products yet" : "No products match"}>
            {products.length === 0 ? (canManage ? "Add your first product to start taking orders on WhatsApp." : "Ask a manager to add products.") : "Try a different search or filter."}
          </EmptyState>
        ) : (
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="border-b border-admin-text/10 text-xs text-admin-text/60">
              <tr>
                <th className="w-14 px-3 py-2.5 font-medium">Photo</th>
                <th className="px-3 py-2.5 font-medium">Name</th>
                <th className="w-40 px-3 py-2.5 font-medium">Category</th>
                <th className="w-28 px-3 py-2.5 font-medium">Price</th>
                <th className="w-24 px-3 py-2.5 font-medium">Stock</th>
                <th className="w-24 px-3 py-2.5 font-medium">Orderable</th>
                <th className="w-24 px-3 py-2.5 font-medium">Status</th>
                <th className="w-24 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-text/10">
              {filtered.map((p) => {
                const noVendor = !p.vendorId && !defaultVendorId
                return (
                  <tr key={p.id} className="align-middle">
                    <td className="px-3 py-2">
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- external Storage URL
                        <img src={p.imageUrl} alt="" className="h-10 w-10 rounded-lg border border-admin-text/10 object-cover" />
                      ) : (
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-admin-text/10 text-xs text-admin-text/40" aria-hidden="true">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        key={`n-${p.name}`}
                        className={cx(inputCls, "border-transparent bg-transparent hover:border-admin-text/15")}
                        defaultValue={p.name}
                        disabled={!canManage}
                        aria-label={`Name of ${p.name}`}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim()
                          if (v === p.name) return
                          if (!v) {
                            e.currentTarget.value = p.name
                            show("Product name is required.", true)
                            return
                          }
                          void save(p.id, { name: v })
                        }}
                      />
                      {noVendor && (
                        <p className="px-3 pt-0.5 text-xs text-amber-700 dark:text-amber-400">No vendor: can&apos;t be ordered until one is set here or as the default in Order settings.</p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className={cx(inputCls, "border-transparent bg-transparent hover:border-admin-text/15")}
                        value={p.categoryId ?? ""}
                        disabled={!canManage}
                        aria-label={`Category of ${p.name}`}
                        onChange={(e) => void save(p.id, { categoryId: e.target.value || null })}
                      >
                        <option value="">None</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                            {c.isActive ? "" : " (off)"}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        key={`p-${p.price}`}
                        type="number"
                        min={0}
                        step="0.01"
                        className={cx(inputCls, "border-transparent bg-transparent tabular-nums hover:border-admin-text/15")}
                        defaultValue={p.price}
                        disabled={!canManage}
                        aria-label={`Price of ${p.name}`}
                        onBlur={(e) => {
                          const v = parseFloat(e.currentTarget.value)
                          if (!Number.isFinite(v) || v < 0) {
                            e.currentTarget.value = String(p.price)
                            show("Price must be 0 or more.", true)
                            return
                          }
                          if (v !== p.price) void save(p.id, { price: v })
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {p.trackInventory ? (
                        <input
                          key={`s-${p.stockQuantity}`}
                          type="number"
                          min={0}
                          step={1}
                          className={cx(inputCls, "tabular-nums", (p.stockQuantity ?? 0) <= 0 && "border-amber-500/50")}
                          defaultValue={p.stockQuantity ?? 0}
                          disabled={!canManage}
                          aria-label={`Stock of ${p.name}`}
                          onBlur={(e) => {
                            const v = Number(e.currentTarget.value)
                            if (!Number.isInteger(v) || v < 0) {
                              e.currentTarget.value = String(p.stockQuantity ?? 0)
                              show("Stock must be a whole number, 0 or more.", true)
                              return
                            }
                            if (v !== p.stockQuantity) void save(p.id, { stockQuantity: v })
                          }}
                        />
                      ) : (
                        <span className="px-3 text-xs text-admin-text/50">Not tracked</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Toggle checked={p.isAvailable} disabled={!canManage} label={`${p.name} can be ordered`} onChange={(v) => void save(p.id, { isAvailable: v })} />
                    </td>
                    <td className="px-3 py-2">
                      <Pill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Pill>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" className={btn.ghost} onClick={() => setDrawer({ mode: "edit", id: p.id })}>
                        {canManage ? "Manage" : "View"}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {drawer && (drawer.mode === "add" || editing) && (
        <ProductDrawer
          key={drawer.mode === "edit" ? drawer.id : "new"}
          product={editing}
          categories={categories}
          vendors={vendors}
          canManage={canManage}
          onClose={() => setDrawer(null)}
          onSaved={(p, isNew) => {
            onProductsChange((prev) => (isNew ? [...prev, p].sort((a, b) => a.name.localeCompare(b.name)) : prev.map((x) => (x.id === p.id ? p : x))))
            show(isNew ? "Product added." : "Product saved.")
            setDrawer(null)
          }}
          onDuplicated={(p) => {
            onProductsChange((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)))
            show("Duplicated as a draft. Check it, then set it to Active.")
            setDrawer({ mode: "edit", id: p.id })
          }}
          onDeleted={(id) => {
            onProductsChange((prev) => prev.filter((x) => x.id !== id))
            show("Product deleted.")
            setDrawer(null)
          }}
          onError={(m) => show(m, true)}
        />
      )}
      {node}
    </div>
  )
}

function ProductDrawer({
  product,
  categories,
  vendors,
  canManage,
  onClose,
  onSaved,
  onDuplicated,
  onDeleted,
  onError,
}: {
  product: AdminProduct | null
  categories: AdminProductCategory[]
  vendors: AdminOrderVendor[]
  canManage: boolean
  onClose: () => void
  onSaved: (p: AdminProduct, isNew: boolean) => void
  onDuplicated: (p: AdminProduct) => void
  onDeleted: (id: string) => void
  onError: (m: string) => void
}) {
  const [d, setD] = useState<ProductInput>(() => {
    if (product) {
      const { id: _id, ...rest } = product
      return rest
    }
    return emptyDraft(null)
  })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setD((prev) => ({ ...prev, [k]: v }))
  const ro = !canManage

  async function submit() {
    if (!d.name.trim()) return onError("Product name is required.")
    if (d.trackInventory && (d.stockQuantity === null || !Number.isInteger(d.stockQuantity) || d.stockQuantity < 0)) return onError("Enter the stock you have, as a whole number.")
    setSaving(true)
    const res = product ? await updateProduct(product.id, d) : await createProduct(d)
    setSaving(false)
    if (!res.ok) return onError(res.error)
    onSaved(res.data, !product)
  }

  async function onImage(file: File | undefined) {
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.set("file", file)
    const res = await uploadProductImage(fd)
    setUploading(false)
    if (!res.ok) return onError(res.error)
    set("imageUrl", res.data)
  }

  async function duplicate() {
    if (!product) return
    setSaving(true)
    const res = await duplicateProduct(product.id)
    setSaving(false)
    if (!res.ok) return onError(res.error)
    onDuplicated(res.data)
  }

  async function remove() {
    if (!product || !window.confirm(`Delete "${product.name}"? This can't be undone.`)) return
    setSaving(true)
    const res = await deleteProduct(product.id)
    setSaving(false)
    if (!res.ok) return onError(res.error)
    onDeleted(product.id)
  }

  return (
    <Drawer
      title={product ? (canManage ? "Manage product" : product.name) : "Add product"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn.ghost} onClick={onClose}>
            {canManage ? "Cancel" : "Close"}
          </button>
          {canManage && (
            <button type="button" className={btn.primary} disabled={saving || uploading} onClick={() => void submit()}>
              {saving ? "Saving…" : product ? "Save product" : "Add product"}
            </button>
          )}
        </>
      }
    >
      <fieldset disabled={ro} className="space-y-6">
        <section className="space-y-4">
          <h3 className="text-sm font-medium">Details</h3>
          <Field label="Name">
            <input className={inputCls} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Hennessy VS 750ml" />
          </Field>
          <Field label="Short description" hint="Shown in WhatsApp menus, so keep it brief.">
            <input className={inputCls} value={d.shortDescription ?? ""} onChange={(e) => set("shortDescription", e.target.value)} />
          </Field>
          <Field label="Full description">
            <textarea className={cx(inputCls, "min-h-20")} value={d.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand">
              <input className={inputCls} value={d.brand ?? ""} onChange={(e) => set("brand", e.target.value)} />
            </Field>
            <Field label="Status" hint="Only Active products can be ordered.">
              <select className={inputCls} value={d.status} onChange={(e) => set("status", e.target.value as ProductStatus)}>
                {PRODUCT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <select className={inputCls} value={d.categoryId ?? ""} onChange={(e) => set("categoryId", e.target.value || null)}>
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji ? `${c.emoji} ` : ""}
                    {c.label}
                    {c.ageRestricted ? " (18+)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Vendor" hint="Where customers collect this from.">
              <select className={inputCls} value={d.vendorId ?? ""} onChange={(e) => set("vendorId", e.target.value || null)}>
                <option value="">Use the default vendor</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.isActive ? "" : " (off)"}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-medium">Price and stock</h3>
          <Field label="Price">
            <input type="number" min={0} step="0.01" className={cx(inputCls, "max-w-40 tabular-nums")} value={Number.isFinite(d.price) ? d.price : ""} onChange={(e) => set("price", e.target.value === "" ? NaN : parseFloat(e.target.value))} />
          </Field>
          <ToggleRow label="Can be ordered" hint="Switch off to hide it from customers without changing its status." checked={d.isAvailable} onChange={(v) => set("isAvailable", v)} />
          <ToggleRow
            label="Track stock"
            hint="Orders reduce the count, and customers can't order more than you have."
            checked={d.trackInventory}
            onChange={(v) => setD((prev) => ({ ...prev, trackInventory: v, stockQuantity: v ? (prev.stockQuantity ?? 0) : prev.stockQuantity }))}
          />
          {d.trackInventory && (
            <Field label="In stock">
              <input
                type="number"
                min={0}
                step={1}
                className={cx(inputCls, "max-w-40 tabular-nums")}
                value={d.stockQuantity ?? ""}
                onChange={(e) => set("stockQuantity", e.target.value === "" ? null : Number(e.target.value))}
              />
            </Field>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Photo</h3>
          <div className="flex items-center gap-4">
            {d.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external Storage URL
              <img src={d.imageUrl} alt="" className="h-20 w-20 rounded-lg border border-admin-text/10 object-cover" />
            ) : (
              <span className="flex h-20 w-20 items-center justify-center rounded-lg bg-admin-text/10 text-xs text-admin-text/50">No photo</span>
            )}
            {canManage && (
              <div className="flex flex-col gap-2">
                <label className={cx(btn.ghost, "cursor-pointer", uploading && "pointer-events-none opacity-50")}>
                  {uploading ? "Uploading…" : d.imageUrl ? "Replace photo" : "Upload photo"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { void onImage(e.target.files?.[0]); e.target.value = "" }} />
                </label>
                {d.imageUrl && (
                  <button type="button" className="text-left text-xs text-admin-text/60 underline-offset-2 hover:underline" onClick={() => set("imageUrl", null)}>
                    Remove photo
                  </button>
                )}
                <span className="text-xs text-admin-text/50">PNG, JPG or WebP, up to 2 MB. Saved with the product.</span>
              </div>
            )}
          </div>
        </section>
      </fieldset>

      {product && canManage && (
        <section className="space-y-3 border-t border-admin-text/10 pt-5">
          <h3 className="text-sm font-medium">More</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn.ghost} disabled={saving} onClick={() => void duplicate()}>
              Duplicate
            </button>
            {d.status !== "archived" && (
              <button type="button" className={btn.ghost} onClick={() => set("status", "archived")}>
                Archive (then Save)
              </button>
            )}
            <button type="button" className={btn.danger} disabled={saving} onClick={() => void remove()}>
              Delete
            </button>
          </div>
          <p className="text-xs text-admin-text/50">Products on past orders can&apos;t be deleted: archive them to take them off the menu and keep your order history.</p>
        </section>
      )}
    </Drawer>
  )
}
