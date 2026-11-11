"use client"

// app/admin/vvip/VvipManager.tsx
//
// The VVIP area of the shop admin, ported from the Rands "VVIP Packages" page. One component serves
// both sidebar entries (VVIP tables, VVIP tabs) so the packages and bookings stay loaded when you
// move between them, the same way EventsManager serves Events / Box office / Gate.
//
// Everything is reloaded from the server after each action. The app never edits a balance itself.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { safeTimezone } from "../events/format"
import { ACCENT_TEXT, BTN_PRIMARY, FOCUS, Icon, Notice } from "../events/ui"
import { loadVvip, setPackageStatus } from "./actions"
import { BookTableDialog } from "./BookTableDialog"
import { BuyerPanel } from "./BuyerPanel"
import { BuyersView } from "./BuyersView"
import { DeletePackageDialog, PackagesView } from "./PackagesView"
import { PackageFormDialog } from "./PackageFormDialog"
import type { VvipData, VvipPackage, VvipPermissions, VvipSection } from "./types"
import { VvipAnalyticsPanel } from "./VvipAnalyticsPanel"

export interface VvipManagerProps {
  section: VvipSection
  onSectionChange: (next: VvipSection) => void
  permissions: VvipPermissions
  /** tenant_settings.timezone */
  timezone: string
  /** tenant_settings.currency (ISO code); falls back to ZAR. */
  currency?: string
  /** Passport is on AND the caller can charge it (wallet.operate or wallet.manage), so a table can be paid for with Passport. */
  canChargePassport: boolean
}

type Flash = { tone: "good" | "bad"; text: string } | null

export function VvipManager({ section, onSectionChange, permissions, timezone, currency = "ZAR", canChargePassport }: VvipManagerProps) {
  const tz = safeTimezone(timezone)
  const [data, setData] = useState<VvipData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [packageForm, setPackageForm] = useState<{ pkg: VvipPackage | null } | null>(null)
  const [deleting, setDeleting] = useState<VvipPackage | null>(null)
  const [booking, setBooking] = useState(false)
  const [openBookingId, setOpenBookingId] = useState<string | null>(null)
  const [busyPackageId, setBusyPackageId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Flash>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = useCallback((tone: "good" | "bad", text: string) => {
    setNotice({ tone, text })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNotice(null), 4500)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const res = await loadVvip()
    if (res.ok) {
      setData(res.data)
      setLoadError(null)
    } else {
      setLoadError(res.error)
    }
    setRefreshing(false)
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const openBooking = useMemo(() => data?.bookings.find((b) => b.id === openBookingId) ?? null, [data, openBookingId])

  async function changePackageStatus(pkg: VvipPackage, status: "active" | "archived", done: string) {
    setBusyPackageId(pkg.id)
    const res = await setPackageStatus(pkg.id, status)
    setBusyPackageId(null)
    if (!res.ok) return flash("bad", res.error)
    flash("good", done)
    await refresh()
  }

  const title = section === "tables" ? "VVIP tables" : "VVIP tabs"

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-stone-900">
          <Icon name={section === "tables" ? "crown" : "receipt"} className={ACCENT_TEXT} /> {title}
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
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
            className={`flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-500/10 disabled:opacity-50 ${FOCUS}`}
          >
            <Icon name="rotate" className={refreshing ? "fa-spin" : ""} />
          </button>
          {section === "tables" && permissions.manage && (
            <button type="button" className={BTN_PRIMARY} onClick={() => setPackageForm({ pkg: null })}>
              <Icon name="plus" /> Create package
            </button>
          )}
          {section === "tabs" && permissions.operate && (
            <button type="button" className={BTN_PRIMARY} onClick={() => setBooking(true)} disabled={!data}>
              <Icon name="plus" /> Book a table
            </button>
          )}
        </div>
      </div>

      {showAnalytics && data && <VvipAnalyticsPanel data={data} timezone={tz} currency={currency} onClose={() => setShowAnalytics(false)} />}

      {section === "tables" ? (
        <PackagesView
          data={data}
          loadError={loadError}
          onRetry={() => void refresh()}
          tz={tz}
          currency={currency}
          canManage={permissions.manage}
          busyPackageId={busyPackageId}
          onCreate={() => setPackageForm({ pkg: null })}
          onEdit={(pkg) => setPackageForm({ pkg })}
          onArchive={(pkg) => void changePackageStatus(pkg, "archived", "Package archived.")}
          onRestore={(pkg) => void changePackageStatus(pkg, "active", "Package restored.")}
          onDelete={setDeleting}
        />
      ) : (
        <BuyersView
          data={data}
          loadError={loadError}
          onRetry={() => void refresh()}
          tz={tz}
          currency={currency}
          onOpen={setOpenBookingId}
          onGoToTables={() => onSectionChange("tables")}
        />
      )}

      {packageForm && data && (
        <PackageFormDialog
          pkg={packageForm.pkg}
          events={data.events}
          timezone={tz}
          onClose={() => setPackageForm(null)}
          onSaved={(message) => {
            setPackageForm(null)
            flash(message.includes("didn't upload") ? "bad" : "good", message)
            void refresh()
          }}
        />
      )}

      {deleting && (
        <DeletePackageDialog
          pkg={deleting}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            setDeleting(null)
            flash("good", message)
            void refresh()
          }}
        />
      )}

      {booking && data && (
        <BookTableDialog
          packages={data.packages}
          currency={currency}
          canComplimentary={permissions.manage}
          canChargePassport={canChargePassport}
          onClose={() => setBooking(false)}
          onBooked={(receipt) => {
            setBooking(false)
            flash("good", `Table booked. Reference ${receipt.reference}.`)
            setOpenBookingId(receipt.bookingId)
            void refresh()
          }}
        />
      )}

      {openBooking && (
        <BuyerPanel
          booking={openBooking}
          tz={tz}
          currency={currency}
          permissions={permissions}
          onClose={() => setOpenBookingId(null)}
          onChanged={refresh}
          flash={flash}
        />
      )}

      <Notice notice={notice} />
    </div>
  )
}
