// app/admin/booking/BookingRulesDrawer.tsx
//
// Booking rules as a right-hand overlay on the Appointments tab (same pattern
// as Shisha's TV display). Replaces the "Booking rules" page under Settings.
//
// Tabs: Timing, Services, Customers, Reminders, Queue link, Ticket. The first four edit
// one booking_settings row, so they share ONE Save footer (same action as
// before: updateBookingSettings). The Ticket tab hosts the existing
// BookingTicketCard, which has its own preview and Save, so the footer hides there.
//
// Settings come from AdminView (lifted state) so reopening always shows the
// last saved values.
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  AdminDrawer,
  DRAWER_BTN,
  DRAWER_BTN_PRIMARY,
  DRAWER_FIELD,
  DrawerField,
  DrawerGroup,
  DrawerOptionCard,
  DrawerSwitch,
  DrawerTabs,
} from "@/components/admin/AdminDrawer"
import { updateBookingSettings } from "../settings-actions"
import { BookingTicketCard } from "./BookingTicketCard"
import type { AdminBookingSettings, AdminQueuePriorityMode } from "../types"

type Tab = "timing" | "services" | "customers" | "reminders" | "queue" | "ticket"
type Message = { kind: "success" | "error"; text: string }

/** AdminBookingSettings plus the staff-choice flag the old panel already read and wrote. */
type BookingForm = AdminBookingSettings & { allowCustomerStaffChoice?: boolean }

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "timing", label: "Timing" },
  { id: "services", label: "Services" },
  { id: "customers", label: "Customers" },
  { id: "reminders", label: "Reminders" },
  { id: "queue", label: "Queue link" },
  { id: "ticket", label: "Ticket" },
]

const PRIORITY_OPTIONS: Array<{ value: AdminQueuePriorityMode; title: string; description: string }> = [
  {
    value: "fifo",
    title: "First come, first served",
    description: "A promoted booking is treated exactly like a walk-in, ordered by when it entered the queue.",
  },
  {
    value: "priority",
    title: "Honor appointment time",
    description:
      "A promoted booking is served at or before its actual appointment time wherever possible, even ahead of walk-ins who joined earlier.",
  },
  {
    value: "hybrid",
    title: "First come, but flag it",
    description:
      "Same order as “First come, first served”, but staff see a warning if a booking's wait would run past its appointment time.",
  },
]

/** Older loaders may not send some fields yet; fill the database defaults so compare/save are stable. */
function withDefaults(s: BookingForm): BookingForm {
  return {
    ...s,
    requireServiceSelection: s.requireServiceSelection ?? true,
    defaultDurationMinutes: s.defaultDurationMinutes ?? 30,
    maxDatesOffered: s.maxDatesOffered ?? 7,
    bookingRemindersEnabled: s.bookingRemindersEnabled ?? true,
    bookingReminderLeadMinutes: s.bookingReminderLeadMinutes ?? 120,
    allowCustomerStaffChoice: s.allowCustomerStaffChoice ?? false,
    bookingNumberPrefix: s.bookingNumberPrefix ?? "B",
    kioskPrintTicket: s.kioskPrintTicket ?? true,
    requirePayment: s.requirePayment ?? false,
    cardPaymentsConnected: s.cardPaymentsConnected ?? false,
    allowCustomerCancel: s.allowCustomerCancel ?? true,
    allowCustomerReschedule: s.allowCustomerReschedule ?? true,
    rescheduleDeadlineMinutes: s.rescheduleDeadlineMinutes ?? null,
    allowSameDayBookings: s.allowSameDayBookings ?? true,
    allowRecurringBookings: s.allowRecurringBookings ?? false,
    requireApproval: s.requireApproval ?? false,
    maxBookingsPerCustomerPerDay: s.maxBookingsPerCustomerPerDay ?? null,
    maxActiveBookingsPerCustomer: s.maxActiveBookingsPerCustomer ?? 1,
  }
}

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max

/** First problem per tab (so the tab can show a dot). The server re-validates everything. */
function validate(s: BookingForm, queueEnabled: boolean): Partial<Record<Tab, string>> {
  const e: Partial<Record<Tab, string>> = {}
  if (!isInt(s.minNoticeMinutes, 0)) e.timing = "Minimum notice must be a whole number of minutes, 0 or more."
  else if (!isInt(s.maxAdvanceDays, 0)) e.timing = "Advance booking window must be a whole number of days, 0 or more."
  else if (!isInt(s.maxDatesOffered, 1, 14)) e.timing = "Dates shown must be a whole number from 1 to 14."
  else if (!isInt(s.cancellationWindowMinutes, 0)) e.timing = "Cancellation window must be a whole number of minutes, 0 or more."
  else if ((s.bookingNumberPrefix ?? "").trim().length < 1 || (s.bookingNumberPrefix ?? "").trim().length > 4)
    e.timing = "Ticket prefix must be 1-4 characters."
  else if (s.allowSameDayBookings === false && s.maxAdvanceDays < 1)
    e.timing = "Same-day bookings are off, so customers need at least 1 day of advance booking."
  else if (
    s.allowCustomerReschedule !== false &&
    s.rescheduleDeadlineMinutes != null &&
    !isInt(s.rescheduleDeadlineMinutes, 0)
  )
    e.timing = "Rescheduling deadline must be a whole number of minutes, 0 or more (or empty to use the cancellation window)."

  if (!isInt(s.maxActiveBookingsPerCustomer, 1, 20)) e.customers = "Upcoming bookings per customer must be a whole number from 1 to 20."
  else if (s.maxBookingsPerCustomerPerDay != null && !isInt(s.maxBookingsPerCustomerPerDay, 1, 20))
    e.customers = "Bookings per customer per day must be a whole number from 1 to 20, or empty for no limit."

  if (!isInt(s.maxServicesPerBooking, 1, 5)) e.services = "Services per booking must be a whole number from 1 to 5."
  else if (s.requireServiceSelection === false && !isInt(s.defaultDurationMinutes, 5, 480))
    e.services = "Appointment length must be a whole number from 5 to 480 minutes."

  if (s.bookingRemindersEnabled && !isInt(s.bookingReminderLeadMinutes, 30, 1440))
    e.reminders = "Reminder time must be a whole number of minutes from 30 to 1440."

  // The Queue link tab is hidden when the shop doesn't run Queue, so its fields can't block a save.
  if (queueEnabled && !isInt(s.queueLeadTimeMinutes, 0)) e.queue = "Queue lead time must be a whole number of minutes, 0 or more."
  return e
}

export function BookingRulesDrawer({
  open,
  onClose,
  settings,
  onSaved,
  queueEnabled = true,
}: {
  open: boolean
  onClose: () => void
  settings: AdminBookingSettings
  onSaved: (next: AdminBookingSettings) => void
  /** false = the shop doesn't run Queue, so the "Queue link" tab is hidden. */
  queueEnabled?: boolean
}) {
  const [baseline, setBaseline] = useState<BookingForm>(() => withDefaults(settings))
  const [draft, setDraft] = useState<BookingForm>(() => withDefaults(settings))
  const [tab, setTab] = useState<Tab>("timing")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  // Start from the latest saved copy every time the panel opens.
  useEffect(() => {
    if (!open) return
    const fresh = withDefaults(settings)
    setBaseline(fresh)
    setDraft(fresh)
    setTab("timing")
    setMessage(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on open, never mid-edit
  }, [open])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline])
  const errors = useMemo(() => validate(draft, queueEnabled), [draft, queueEnabled])
  const firstError = errors.timing ?? errors.services ?? errors.customers ?? errors.reminders ?? errors.queue
  const canSave = dirty && !saving && !firstError

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty && !window.confirm("Discard your unsaved changes?")) return
    onClose()
  }, [dirty, saving, onClose])

  function set<K extends keyof BookingForm>(key: K, value: BookingForm[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    setMessage(null)
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    setMessage(null)
    const value = draft
    try {
      const res = await updateBookingSettings(value)
      if (res.success) {
        setBaseline(value)
        onSaved(value)
        setMessage({ kind: "success", text: "Saved." })
      } else {
        setMessage({ kind: "error", text: res.error })
      }
    } catch {
      setMessage({ kind: "error", text: "Something went wrong reaching the server. Please try again." })
    } finally {
      setSaving(false)
    }
  }

  const num = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? "" : n)
  const onNum = (v: string) => (v === "" ? Number.NaN : Number(v))
  /** Empty box = null ("no limit" / "use the default"). */
  const onNullableNum = (v: string) => (v === "" ? null : Number(v))
  const tabsWithFlags = TABS.filter((t) => queueEnabled || t.id !== "queue").map((t) => ({ ...t, label: errors[t.id] ? `${t.label} •` : t.label }))
  const remindersOn = draft.bookingRemindersEnabled ?? true
  const reminderLead = draft.bookingReminderLeadMinutes ?? 120

  const footer =
    tab === "ticket" ? undefined : (
      <>
        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={`text-sm ${message.kind === "error" ? "text-accent" : "text-success"}`}
          >
            {message.text}
          </p>
        )}
        {!message && firstError && (
          <p role="alert" className="text-sm text-accent">
            {firstError}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink-muted">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={DRAWER_BTN}
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(baseline)
                setMessage(null)
              }}
            >
              Discard
            </button>
            <button type="button" className={DRAWER_BTN_PRIMARY} disabled={!canSave} onClick={() => void save()}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </>
    )

  return (
    <AdminDrawer
      open={open}
      onClose={requestClose}
      width="lg"
      title="Booking rules"
      subtitle="How far ahead customers can book, notice periods, reminders and cancellations."
      footer={footer}
    >
      <div className="space-y-5">
        <DrawerTabs tabs={tabsWithFlags} value={tab} onChange={setTab} label="Booking rules" />

        {tab === "timing" && (
          <div className="space-y-6">
            <DrawerGroup title="When customers can book" hint="Always also limited by your opening hours (Settings → Shop details).">
              <DrawerField
                label="Minimum notice to book (minutes)"
                hint="Customers can't book sooner than this from right now. Enforced on every booking attempt, not just hidden in the time list."
              >
                <input type="number" min={0} className={DRAWER_FIELD} value={num(draft.minNoticeMinutes)} onChange={(e) => set("minNoticeMinutes", onNum(e.target.value))} />
              </DrawerField>
              <DrawerField
                label="How far ahead customers can book (days)"
                hint="Up to and including this many days ahead, in your shop's timezone. Set to 0 for same-day booking only: the kiosk then skips the date picker and goes straight to today's times."
              >
                <input type="number" min={0} className={DRAWER_FIELD} value={num(draft.maxAdvanceDays)} onChange={(e) => set("maxAdvanceDays", onNum(e.target.value))} />
              </DrawerField>
              <DrawerField
                label="Dates shown to customers (1-14)"
                hint="How many date buttons the kiosk and WhatsApp list, starting today. The smaller of this and the limit above applies, so 7 dates with a 3-day limit still shows 4. Set to 1 for today only."
              >
                <input type="number" min={1} max={14} className={DRAWER_FIELD} value={num(draft.maxDatesOffered)} onChange={(e) => set("maxDatesOffered", onNum(e.target.value))} />
              </DrawerField>
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Allow same-day bookings"
                  description="Off = customers can only book from tomorrow onwards, on WhatsApp and the kiosk. You can still add same-day appointments yourself in the admin."
                  checked={draft.allowSameDayBookings ?? true}
                  disabled={saving}
                  onChange={(v) => set("allowSameDayBookings", v)}
                />
              </div>
            </DrawerGroup>

            <DrawerGroup title="Ticket numbers">
              <DrawerField
                label="Ticket prefix (1-4 characters)"
                hint={`Each booking gets the next number in your shop's own count, for example ${(draft.bookingNumberPrefix ?? "B").trim().toUpperCase() || "B"}0001, ${(draft.bookingNumberPrefix ?? "B").trim().toUpperCase() || "B"}0002. The count never restarts. Changing the prefix only affects how numbers look, so earlier bookings show the new prefix too. Customers also get a separate 5-character reference (for example H456R).`}
              >
                <input
                  type="text"
                  maxLength={4}
                  className={DRAWER_FIELD}
                  value={draft.bookingNumberPrefix ?? ""}
                  onChange={(e) => set("bookingNumberPrefix", e.target.value.toUpperCase())}
                />
              </DrawerField>
            </DrawerGroup>

            <DrawerGroup title="Kiosk printing">
              <DrawerSwitch
                title="Print a ticket at the kiosk"
                description="When a customer books on the kiosk, print a slip for them. Switch off if you don't use a ticket printer: they still see their ticket on screen."
                checked={draft.kioskPrintTicket ?? true}
                disabled={saving}
                onChange={(v) => set("kioskPrintTicket", v)}
              />
            </DrawerGroup>

            <DrawerGroup title="Cancellations">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Customers can cancel their own booking"
                  description="Off = customers can't cancel on WhatsApp (including the reminder's “Can't make it” button) and are asked to contact the shop. You can still cancel from the Appointments screen."
                  checked={draft.allowCustomerCancel ?? true}
                  disabled={saving}
                  onChange={(v) => set("allowCustomerCancel", v)}
                />
              </div>
              <DrawerField
                label="Free cancellation window (minutes before start)"
                hint="Once a booking is inside this window, it can no longer be cancelled by the customer or from the Appointments screen."
              >
                <input type="number" min={0} className={DRAWER_FIELD} value={num(draft.cancellationWindowMinutes)} onChange={(e) => set("cancellationWindowMinutes", onNum(e.target.value))} />
              </DrawerField>
            </DrawerGroup>

            <DrawerGroup title="Rescheduling">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Customers can reschedule their own booking"
                  description="Off = customers can't move a booking on WhatsApp (including the reminder's “Move it” button) and are asked to contact the shop."
                  checked={draft.allowCustomerReschedule ?? true}
                  disabled={saving}
                  onChange={(v) => set("allowCustomerReschedule", v)}
                />
              </div>
              {(draft.allowCustomerReschedule ?? true) && (
                <DrawerField
                  label="Rescheduling deadline (minutes before start)"
                  hint={`How close to the start a customer can still move their booking. Leave empty to use the cancellation window (${draft.cancellationWindowMinutes} min).`}
                >
                  <input
                    type="number"
                    min={0}
                    placeholder={`Same as cancellation window (${draft.cancellationWindowMinutes})`}
                    className={DRAWER_FIELD}
                    value={draft.rescheduleDeadlineMinutes ?? ""}
                    onChange={(e) => set("rescheduleDeadlineMinutes", onNullableNum(e.target.value))}
                  />
                </DrawerField>
              )}
            </DrawerGroup>
          </div>
        )}

        {tab === "services" && (
          <div className="space-y-6">
            <DrawerGroup title="Choosing a service">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Require a service to book"
                  description="Turn this off if customers don't choose between services. The kiosk and WhatsApp then skip the service step and go straight to the date. Separate from “Require a service to join the queue” in Queue rules."
                  checked={draft.requireServiceSelection ?? true}
                  disabled={saving}
                  onChange={(v) => set("requireServiceSelection", v)}
                />
              </div>
              {draft.requireServiceSelection === false ? (
                <DrawerField
                  label="Appointment length with no service (minutes)"
                  hint="Without a service there's no duration to look up, so every appointment uses this length when building available times (5-480). Bookings without a service show as “No service”."
                >
                  <input type="number" min={5} max={480} className={DRAWER_FIELD} value={num(draft.defaultDurationMinutes)} onChange={(e) => set("defaultDurationMinutes", onNum(e.target.value))} />
                </DrawerField>
              ) : (
                <DrawerField
                  label="Services per booking (1-5)"
                  hint="How many services a customer can pick for one booking. 1 = a single service. 2 or more lets them tick several on the kiosk. WhatsApp keeps offering one until it is updated."
                >
                  <input type="number" min={1} max={5} className={DRAWER_FIELD} value={num(draft.maxServicesPerBooking)} onChange={(e) => set("maxServicesPerBooking", onNum(e.target.value))} />
                </DrawerField>
              )}
            </DrawerGroup>

            <DrawerGroup
              title="Payment"
              hint="Applies to bookings customers make themselves on WhatsApp and at the kiosk. Bookings you add in the admin are never charged."
            >
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Customers pay when they book"
                  description="The customer gets a card payment link (a QR code on the kiosk) for the total of the services they picked. Their time is held for 15 minutes and the booking is confirmed once they have paid. If they don't pay, the time is released. Services with a price of 0 are booked without payment. When off, bookings are free and confirm straight away."
                  checked={draft.requirePayment ?? false}
                  disabled={saving || (!draft.cardPaymentsConnected && !(draft.requirePayment ?? false))}
                  onChange={(v) => set("requirePayment", v)}
                />
              </div>
              {!draft.cardPaymentsConnected && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {draft.requirePayment
                    ? "No card payment provider is connected right now, so customers can't book on WhatsApp or the kiosk until you reconnect one in Settings > Payments."
                    : "Connect a card payment provider in Settings > Payments to turn this on."}
                </p>
              )}
              <p className="text-xs text-ink-muted">
                Switching this changes new bookings only. Bookings already made, and ones waiting for payment, keep the rules they were made under.
              </p>
            </DrawerGroup>

            <DrawerGroup title="Staff">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Allow customers to choose staff"
                  description="Customers can ask for a specific person on WhatsApp, e.g. “book with Sipho”. They only see times that person is free. When off, every booking goes automatically to whoever is free. Customers are never given someone different from who they asked for."
                  checked={draft.allowCustomerStaffChoice ?? false}
                  disabled={saving}
                  onChange={(v) => set("allowCustomerStaffChoice", v)}
                />
              </div>
            </DrawerGroup>
          </div>
        )}

        {tab === "customers" && (
          <div className="space-y-6">
            <DrawerGroup
              title="Approval"
              hint="Applies to bookings customers make themselves on WhatsApp and at the kiosk. Bookings you add in the admin are always confirmed straight away."
            >
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Require approval before confirming"
                  description="New bookings are held as requests. The customer is told it's being reviewed, and you approve or decline each one on the Appointments screen. Their time stays held while they wait. If payment is required too, they pay first and you approve afterwards."
                  checked={draft.requireApproval ?? false}
                  disabled={saving}
                  onChange={(v) => set("requireApproval", v)}
                />
              </div>
              <p className="text-xs text-ink-muted">
                Switching this changes new bookings only. Requests already waiting stay in the list until you approve or decline them. Declining a booking the customer has already paid for does not refund the card: refund it from your payment provider.
              </p>
            </DrawerGroup>

            <DrawerGroup title="Limits per customer" hint="Apply to bookings customers make themselves. Bookings you add in the admin are not limited.">
              <DrawerField
                label="Upcoming bookings a customer can hold at once (1-20)"
                hint="1 means a customer must wait until their booking has passed, or cancel it, before booking again."
              >
                <input type="number" min={1} max={20} className={DRAWER_FIELD} value={num(draft.maxActiveBookingsPerCustomer)} onChange={(e) => set("maxActiveBookingsPerCustomer", onNum(e.target.value))} />
              </DrawerField>
              <DrawerField
                label="Bookings per customer per day (1-20)"
                hint="The most bookings one customer can have on the same day. Leave empty for no limit."
              >
                <input
                  type="number"
                  min={1}
                  max={20}
                  placeholder="No limit"
                  className={DRAWER_FIELD}
                  value={draft.maxBookingsPerCustomerPerDay ?? ""}
                  onChange={(e) => set("maxBookingsPerCustomerPerDay", onNullableNum(e.target.value))}
                />
              </DrawerField>
            </DrawerGroup>

            <DrawerGroup title="Recurring appointments">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Allow recurring appointments"
                  description="Adds a “Repeat” option when you create an appointment: every week or every 2 weeks, for up to 12 appointments at the same time. Dates that are closed or already full are skipped and listed for you. Customers can't set up repeats themselves."
                  checked={draft.allowRecurringBookings ?? false}
                  disabled={saving}
                  onChange={(v) => set("allowRecurringBookings", v)}
                />
              </div>
            </DrawerGroup>
          </div>
        )}

        {tab === "reminders" && (
          <div className="space-y-6">
            <DrawerGroup title="WhatsApp reminder" hint="Sent shortly before the appointment, with buttons to confirm or say they can't make it.">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch title="Booking reminders" checked={remindersOn} disabled={saving} onChange={(v) => set("bookingRemindersEnabled", v)} />
              </div>
              {remindersOn && (
                <>
                  <DrawerField
                    label="Send the reminder this many minutes before (30-1440)"
                    hint="120 = 2 hours before, 1440 = the day before. Bookings made inside this window don't get a reminder, because the customer has only just heard about them."
                  >
                    <input type="number" min={30} max={1440} className={DRAWER_FIELD} value={num(draft.bookingReminderLeadMinutes)} onChange={(e) => set("bookingReminderLeadMinutes", onNum(e.target.value))} />
                  </DrawerField>
                  {draft.cancellationWindowMinutes >= reminderLead && (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Your free cancellation window ({draft.cancellationWindowMinutes} min, on the Timing tab) is as long as, or longer than, this
                      reminder time. Customers who tap “Can&apos;t make it” will be told it&apos;s too late to cancel. Send the reminder earlier, or
                      shorten the cancellation window.
                    </p>
                  )}
                </>
              )}
              <p className="text-xs text-ink-muted">
                Reminders go out within about 5 minutes of the time above. Customers who messaged your WhatsApp in the last 24 hours get a normal
                message. Everyone else only gets it if they&apos;ve agreed to WhatsApp updates and your reminder template (Settings → WhatsApp Settings
                → Connection &amp; templates) is approved by WhatsApp.
              </p>
            </DrawerGroup>
          </div>
        )}

        {tab === "queue" && queueEnabled && (
          <div className="space-y-6">
            <DrawerGroup title="Link bookings to the queue">
              <div className="rounded-lg border border-line bg-card px-4">
                <DrawerSwitch
                  title="Add confirmed bookings to the queue"
                  description="Confirmed bookings automatically join the walk-in queue shortly before their start time, so front-of-house sees one line instead of two systems. This doesn't change who can join as a walk-in (see Live Queue → Queue rules)."
                  checked={draft.unifyWithQueue}
                  disabled={saving}
                  onChange={(v) => set("unifyWithQueue", v)}
                />
              </div>
              <p className="text-xs text-ink-muted">Checked about once a minute, so a booking appears within about a minute of becoming eligible.</p>
            </DrawerGroup>

            <div className={draft.unifyWithQueue ? "space-y-6" : "space-y-6 opacity-60"}>
              <DrawerGroup title="Timing">
                <DrawerField
                  label="Add to queue this many minutes before start time"
                  hint="Calculated from each booking's start time, in your shop's timezone, not from when the booking was made."
                >
                  <input type="number" min={0} disabled={!draft.unifyWithQueue || saving} className={DRAWER_FIELD} value={num(draft.queueLeadTimeMinutes)} onChange={(e) => set("queueLeadTimeMinutes", onNum(e.target.value))} />
                </DrawerField>
              </DrawerGroup>

              <DrawerGroup
                title="Queue priority"
                hint={`How a promoted booking is ordered against walk-ins once it's in the queue.${draft.unifyWithQueue ? "" : " Only applies while linking is on."}`}
              >
                <div className="space-y-2">
                  {PRIORITY_OPTIONS.map((o) => (
                    <DrawerOptionCard
                      key={o.value}
                      selected={draft.queuePriorityMode === o.value}
                      disabled={!draft.unifyWithQueue || saving}
                      onClick={() => set("queuePriorityMode", o.value)}
                    >
                      <span className="text-sm font-semibold text-ink">{o.title}</span>
                      <span className="text-xs text-ink-muted">{o.description}</span>
                    </DrawerOptionCard>
                  ))}
                </div>
              </DrawerGroup>
            </div>
          </div>
        )}

        {/* Has its own preview and Save button; mounts only while this tab is open. */}
        {tab === "ticket" && <BookingTicketCard />}
      </div>
    </AdminDrawer>
  )
}
