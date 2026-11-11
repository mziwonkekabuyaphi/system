"use client"

// app/admin/vvip/PackagesView.tsx
//
// Section "tables": the package cards (image, price, event, booked/total tables, tab credit, revenue,
// table chips, benefits) plus the Archive / Delete dialog. Tables are derived data: a table is booked
// while it has a live booking, and the table count is simply the number of table rows.

import { useMemo, useState } from "react"
import { formatEventDate, formatMoney } from "../events/format"
import { ACCENT_TEXT, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SUCCESS, EmptyState, Icon, Modal, WELL } from "../events/ui"
import { deletePackage, setPackageStatus } from "./actions"
import { PACKAGE_STATUS_LABEL, type PackageStatus, type VvipData, type VvipPackage } from "./types"

const STATUS_DOT: Record<PackageStatus, string> = {
  active: "bg-emerald-500",
  inactive: "bg-amber-400",
  archived: "bg-stone-400",
}

/** Sits on the package image, so it carries its own dark backing (same idea as the Events status pill). */
function PackagePill({ pkg }: { pkg: VvipPackage }) {
  const soldOut = pkg.status === "active" && pkg.tables.length > 0 && pkg.bookedCount >= pkg.tables.length
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1 text-[0.68rem] font-semibold text-white backdrop-blur">
      <span className={`h-1.5 w-1.5 rounded-full ${soldOut ? "bg-red-500" : STATUS_DOT[pkg.status]}`} />
      {soldOut ? "Sold out" : PACKAGE_STATUS_LABEL[pkg.status]}
    </span>
  )
}

export function PackagesView({
  data,
  loadError,
  onRetry,
  tz,
  currency,
  canManage,
  busyPackageId,
  onCreate,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  data: VvipData | null
  loadError: string | null
  onRetry: () => void
  tz: string
  currency: string
  canManage: boolean
  busyPackageId: string | null
  onCreate: () => void
  onEdit: (pkg: VvipPackage) => void
  onArchive: (pkg: VvipPackage) => void
  onRestore: (pkg: VvipPackage) => void
  onDelete: (pkg: VvipPackage) => void
}) {
  const [showArchived, setShowArchived] = useState(false)
  const archivedCount = useMemo(() => (data?.packages ?? []).filter((p) => p.status === "archived").length, [data])
  const visible = useMemo(
    () => (data?.packages ?? []).filter((p) => showArchived || p.status !== "archived"),
    [data, showArchived],
  )

  if (loadError && !data) {
    return (
      <EmptyState icon="triangle-exclamation" title="Couldn't load VVIP tables" action={<button type="button" className={BTN_GHOST} onClick={onRetry}>Try again</button>}>
        {loadError}
      </EmptyState>
    )
  }
  if (!data) {
    return (
      <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-96 animate-pulse rounded-3xl bg-stone-500/10" />
        ))}
      </div>
    )
  }

  if (data.packages.length === 0) {
    return (
      <EmptyState
        icon="crown"
        title="No VVIP packages yet"
        action={canManage ? <button type="button" className={BTN_PRIMARY} onClick={onCreate}><Icon name="plus" /> Create your first package</button> : undefined}
      >
        A package is a set of premium tables for one event. Each table comes with a prepaid bar tab that staff spend down during the night.
      </EmptyState>
    )
  }

  return (
    <section aria-label="VVIP packages" className="space-y-4">
      {loadError && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">{loadError}</p>}
      {archivedCount > 0 && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-stone-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived ({archivedCount})
        </label>
      )}
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">All of your packages are archived. Tick Show archived to see them.</p>
      ) : (
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {visible.map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              tz={tz}
              currency={currency}
              canManage={canManage}
              busy={busyPackageId === pkg.id}
              onEdit={() => onEdit(pkg)}
              onArchive={() => onArchive(pkg)}
              onRestore={() => onRestore(pkg)}
              onDelete={() => onDelete(pkg)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const CHIPS_SHOWN = 6
const BENEFITS_SHOWN = 3

function PackageCard({
  pkg,
  tz,
  currency,
  canManage,
  busy,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  pkg: VvipPackage
  tz: string
  currency: string
  canManage: boolean
  busy: boolean
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const total = pkg.tables.length
  const dim = pkg.status === "archived" || pkg.status === "inactive"
  return (
    <article className={`flex flex-col overflow-hidden rounded-3xl border border-stone-200 bg-card ${dim ? "opacity-80" : ""}`}>
      <div className="relative h-44 bg-stone-500/10">
        {pkg.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Storage URL, not a static asset
          <img src={pkg.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-stone-400/60">
            <Icon name="crown" className="text-5xl" />
          </div>
        )}
        <div className="absolute bottom-3 right-3">
          <PackagePill pkg={pkg} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-lg font-bold leading-snug text-stone-900">{pkg.name}</h3>
          <span className={`shrink-0 text-base font-bold ${ACCENT_TEXT}`}>{pkg.price === 0 ? "Free" : formatMoney(pkg.price, currency)}</span>
        </div>

        <ul className="space-y-1.5 text-sm text-stone-500">
          <li className="flex items-center gap-2">
            <Icon name="calendar-days" className={`w-4 ${ACCENT_TEXT}`} />
            <span className="truncate">{pkg.eventName ? `${pkg.eventName}${pkg.eventStart ? ` · ${formatEventDate(pkg.eventStart, tz)}` : ""}` : "No event set"}</span>
          </li>
          <li className="flex items-center gap-2">
            <Icon name="table-cells-large" className={`w-4 ${ACCENT_TEXT}`} />
            {total > 0 ? `${pkg.bookedCount}/${total} tables booked` : "No tables yet"}
            <span className="text-stone-400">· {pkg.seatsPerTable} {pkg.seatsPerTable === 1 ? "seat" : "seats"} each</span>
          </li>
          <li className="flex items-center gap-2">
            <Icon name="coins" className={`w-4 ${ACCENT_TEXT}`} /> Tab credit {formatMoney(pkg.tabCredit, currency)}
          </li>
          <li className="flex items-center gap-2">
            <Icon name="sack-dollar" className={`w-4 ${ACCENT_TEXT}`} /> Revenue {formatMoney(pkg.revenue, currency)}
          </li>
        </ul>

        <p className="line-clamp-3 text-sm text-stone-600">{pkg.description || "No description."}</p>

        {total > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tables">
            {pkg.tables.slice(0, CHIPS_SHOWN).map((t) => (
              <li
                key={t.id}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[0.68rem] font-semibold ${
                  t.booked ? "bg-stone-500/20 text-stone-700" : "bg-emerald-500/15 text-emerald-700"
                }`}
              >
                <Icon name={t.booked ? "lock" : "check"} className="text-[0.6rem]" />
                {t.label}
                {/* Booked vs free is also written out, so colour is never the only signal. */}
                <span className="sr-only">{t.booked ? " (booked)" : " (available)"}</span>
              </li>
            ))}
            {total > CHIPS_SHOWN && <li className="inline-flex items-center rounded-full bg-stone-500/10 px-2.5 py-0.5 text-[0.68rem] font-semibold text-stone-500">+{total - CHIPS_SHOWN} more</li>}
          </ul>
        )}

        {pkg.benefits.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Benefits">
            {pkg.benefits.slice(0, BENEFITS_SHOWN).map((b, i) => (
              <li key={`${b}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-stone-500/10 px-2.5 py-0.5 text-[0.68rem] text-stone-600">
                <Icon name="check" className={`text-[0.6rem] ${ACCENT_TEXT}`} /> {b}
              </li>
            ))}
            {pkg.benefits.length > BENEFITS_SHOWN && (
              <li className="inline-flex items-center rounded-full bg-stone-500/10 px-2.5 py-0.5 text-[0.68rem] text-stone-500">+{pkg.benefits.length - BENEFITS_SHOWN} more</li>
            )}
          </ul>
        )}

        {canManage && (
          <div className="mt-auto flex flex-wrap gap-2 border-t border-stone-200 pt-4">
            <button type="button" className={BTN_GHOST} onClick={onEdit} disabled={busy}>
              <Icon name="pencil" /> Edit
            </button>
            {pkg.status === "archived" ? (
              <button type="button" className={BTN_GHOST} onClick={onRestore} disabled={busy}>
                <Icon name="box-open" /> {busy ? "Restoring…" : "Restore"}
              </button>
            ) : (
              <button type="button" className={BTN_GHOST} onClick={onArchive} disabled={busy}>
                <Icon name="box-archive" /> {busy ? "Archiving…" : "Archive"}
              </button>
            )}
            <button type="button" className={`${BTN_DANGER} ml-auto`} onClick={onDelete} disabled={busy}>
              <Icon name="trash" /> Delete
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

/** The Rands choice: Archive (recommended) or Delete permanently. The database refuses a permanent
 *  delete once the package has ever had a booking, and its message is shown as it is. */
export function DeletePackageDialog({ pkg, onClose, onDone }: { pkg: VvipPackage; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState<"archive" | "delete" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function archive() {
    setBusy("archive")
    setError(null)
    const res = await setPackageStatus(pkg.id, "archived")
    if (!res.ok) {
      setBusy(null)
      return setError(res.error)
    }
    onDone("Package archived.")
  }

  async function remove() {
    setBusy("delete")
    setError(null)
    const res = await deletePackage(pkg.id)
    if (!res.ok) {
      setBusy(null)
      return setError(res.error)
    }
    onDone("Package deleted.")
  }

  const alreadyArchived = pkg.status === "archived"

  return (
    <Modal
      title="Remove package"
      onClose={busy ? () => {} : onClose}
      footer={
        <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy !== null}>
          Cancel
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-stone-700">
          How should <strong className="text-stone-900">{pkg.name}</strong> be removed?
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={`${WELL} flex flex-col gap-2 p-4`}>
            <p className="flex items-center gap-2 text-sm font-bold text-stone-900">
              <Icon name="box-archive" className={ACCENT_TEXT} /> Archive <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.65rem] font-semibold text-emerald-700">Recommended</span>
            </p>
            <p className="flex-1 text-xs text-stone-500">Takes the package off sale and hides it. Its bookings, tabs and history stay, and you can restore it any time.</p>
            <button type="button" className={BTN_SUCCESS} onClick={archive} disabled={busy !== null || alreadyArchived}>
              {busy === "archive" ? "Archiving…" : alreadyArchived ? "Already archived" : "Archive package"}
            </button>
          </div>
          <div className={`${WELL} flex flex-col gap-2 p-4`}>
            <p className="flex items-center gap-2 text-sm font-bold text-stone-900">
              <Icon name="trash" className="text-red-600" /> Delete permanently
            </p>
            <p className="flex-1 text-xs text-stone-500">Removes the package and its tables for good. Refused once the package has had any booking. Archive it instead.</p>
            <button type="button" className={BTN_DANGER} onClick={remove} disabled={busy !== null}>
              {busy === "delete" ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
