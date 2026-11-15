// app/admin/ServicesManager.tsx
"use client"

import { useState, useTransition, type FormEvent } from "react"
import { addService, updateService, toggleServiceActive, deleteService } from "./actions"
import { ConfirmDialog, NoticeModal, type Notice } from "./AdminModals"
import { SettingsCard, SettingsStatTile, Toggle, inputClass, primaryButtonClass, secondaryButtonClass } from "./settings/ui"
import type { AdminService } from "./types"

const money = (n: number) => `R${Number.isInteger(n) ? n : n.toFixed(2)}`

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-soft">{label}</span>
      {children}
    </label>
  )
}

function ServiceRow({ service }: { service: AdminService }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(service.name)
  const [price, setPrice] = useState(String(service.price))
  const [duration, setDuration] = useState(String(service.durationMinutes))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isSaving, startSave] = useTransition()
  const [isToggling, startToggle] = useTransition()
  const [isDeleting, startDelete] = useTransition()

  function save() {
    startSave(async () => {
      const result = await updateService(service.id, {
        name,
        price: Number(price),
        durationMinutes: Number(duration),
      })
      if (result.ok) setEditing(false)
      else setNotice({ title: "Couldn't save", message: result.error })
    })
  }

  function cancelEdit() {
    setName(service.name)
    setPrice(String(service.price))
    setDuration(String(service.durationMinutes))
    setEditing(false)
  }

  function toggleActive(next: boolean) {
    startToggle(async () => {
      const result = await toggleServiceActive(service.id, next)
      if (!result.ok) setNotice({ title: "Couldn't update", message: result.error })
    })
  }

  function confirmDelete() {
    startDelete(async () => {
      const result = await deleteService(service.id)
      setConfirmOpen(false)
      if (!result.ok) setNotice({ title: "Couldn't delete", message: result.error })
    })
  }

  const modals = (
    <>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete this service?"
        message={
          <>
            <span className="font-medium text-ink">{service.name}</span> will be removed for good. This
            can&apos;t be undone. If you only want to hide it from customers, switch it off instead.
          </>
        }
        confirmLabel="Delete service"
        busyLabel="Deleting…"
        isBusy={isDeleting}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </>
  )

  if (editing) {
    return (
      <li className="bg-tint/60 px-4 py-4 sm:px-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem]">
          <Field label="Service name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Price (R)">
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={`${inputClass} tabular-nums`} />
          </Field>
          <Field label="Minutes">
            <input value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" className={`${inputClass} tabular-nums`} />
          </Field>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={cancelEdit} disabled={isSaving} className={secondaryButtonClass}>
            Cancel
          </button>
          <button onClick={save} disabled={isSaving} className={`${primaryButtonClass} disabled:opacity-50`}>
            {isSaving ? "Saving…" : "Save changes"}
          </button>
        </div>
        {modals}
      </li>
    )
  }

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-[10rem] flex-1">
        <p className={`font-medium ${service.active ? "text-ink" : "text-ink-muted line-through decoration-ink-muted/40"}`}>
          {service.name}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted sm:hidden">
          {money(service.price)} · {service.durationMinutes} min
        </p>
      </div>
      <span className="hidden w-24 text-right font-[family-name:var(--font-admin-serif)] text-lg tabular-nums text-ink sm:block">
        {money(service.price)}
      </span>
      <span className="hidden w-24 sm:block">
        <span className="inline-flex items-center rounded-full border border-line-strong bg-canvas px-2.5 py-0.5 text-xs tabular-nums text-ink-soft">
          {service.durationMinutes} min
        </span>
      </span>
      <span className="flex items-center gap-2" title={service.active ? "Customers can pick this service" : "Hidden from customers"}>
        <Toggle checked={service.active} disabled={isToggling} onChange={toggleActive} label={`${service.name} visible to customers`} showState={false} />
        <span className={`w-14 text-xs font-medium ${service.active ? "text-success" : "text-ink-muted"}`}>
          {service.active ? "Active" : "Hidden"}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <button onClick={() => setEditing(true)} className={secondaryButtonClass}>
          Edit
        </button>
        <button
          onClick={() => setConfirmOpen(true)}
          className="rounded-md border border-transparent px-3 py-1.5 text-sm text-accent hover:bg-accent/10"
        >
          Delete
        </button>
      </span>
      {modals}
    </li>
  )
}

export function ServicesManager({ initialServices: services }: { initialServices: AdminService[] }) {
  const [name, setName] = useState("")
  const [price, setPrice] = useState("")
  const [duration, setDuration] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isPending, startTransition] = useTransition()

  const activeCount = services.filter((s) => s.active).length
  const avgPrice = services.length ? services.reduce((sum, s) => sum + Number(s.price), 0) / services.length : 0
  const canAdd = name.trim().length > 0 && price.trim() !== "" && duration.trim() !== ""

  function submit(e: FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await addService({ name, price: Number(price), durationMinutes: Number(duration) })
      if (result.ok) {
        setName("")
        setPrice("")
        setDuration("")
      } else {
        setNotice({ title: "Couldn't add that service", message: result.error })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SettingsStatTile label="Services" value={services.length} hint="In your catalogue" />
        <SettingsStatTile label="Active" value={activeCount} hint="Visible to customers" />
        <SettingsStatTile label="Average price" value={services.length ? money(Math.round(avgPrice * 100) / 100) : "—"} hint="Across all services" />
      </div>

      <SettingsCard title="Add a service" description="Customers pick from these on the kiosk, on WhatsApp and when booking.">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end">
          <Field label="Service name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Skin fade" className={inputClass} />
          </Field>
          <Field label="Price (R)">
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="150" className={`${inputClass} tabular-nums`} />
          </Field>
          <Field label="Minutes">
            <input value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" placeholder="30" className={`${inputClass} tabular-nums`} />
          </Field>
          <button type="submit" disabled={isPending || !canAdd} className={`${primaryButtonClass} disabled:opacity-50`}>
            {isPending ? "Adding…" : "Add service"}
          </button>
        </form>
      </SettingsCard>

      <section className="overflow-hidden rounded-lg border border-line bg-card shadow-sm">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <h3 className="flex items-center gap-2 font-[family-name:var(--font-admin-serif)] text-lg text-ink">
            <span className="h-4 w-[3px] rounded-full bg-accent" aria-hidden />
            Your services
          </h3>
          <span className="text-xs text-ink-muted">
            {services.length} total · {activeCount} active
          </span>
        </header>

        {services.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="font-[family-name:var(--font-admin-serif)] text-lg text-ink">No services yet</p>
            <p className="mt-1 text-sm text-ink-muted">Add your first service above and it will show up for customers straight away.</p>
          </div>
        ) : (
          <>
            <div className="hidden items-center gap-4 border-b border-line bg-canvas px-5 py-2 text-xs font-semibold uppercase tracking-wider text-ink-soft sm:flex">
              <span className="flex-1">Service</span>
              <span className="w-24 text-right">Price</span>
              <span className="w-24">Duration</span>
              <span className="w-[8.5rem]">Status</span>
              <span className="w-[8.5rem]" />
            </div>
            <ul className="divide-y divide-line">
              {services.map((s) => (
                <ServiceRow key={s.id} service={s} />
              ))}
            </ul>
          </>
        )}
      </section>

      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
