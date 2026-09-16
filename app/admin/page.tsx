// app/admin/page.tsx
//
// Access protection lives in layout.tsx (requireTenantMember) — every
// query below additionally filters by .eq("tenant_id", tenantId) as a
// second, independent guard: even if a bug ever let this Server
// Component render without the layout's check, it still couldn't return
// another shop's data. Belt and suspenders on purpose, since this reads
// through the service-role client and bypasses RLS entirely.
//
// Schema fix vs the previous version: bookings.customer_id and
// queue_entries.customer_id point at tenant_customers, not profiles —
// profiles is the platform-wide identity (1:1 with auth.users);
// tenant_customers is the per-shop customer record (name/phone/email as
// given to *this* shop). The two can diverge, and a booking may not even
// have a linked profiles row. This now joins tenant_customers, which
// also means no more splitting a nonexistent name/surname pair — it's
// one full_name column.
//
// Settings tab: plan lives on tenants (manually flipped in Supabase until
// billing is wired up), general info on tenant_settings, and branding
// (incl. remove_powered_by, gated to plan = 'business', plus the kiosk
// config fields — tagline / idle+confirmation refresh / registration
// type) on tenant_branding. The kiosk toggle reads/writes tenant_modules
// for the 'kiosk' module row. Booking / Queue / Messages tabs read
// booking_settings / queue_settings / message_settings — one row per
// tenant, same shape as tenant_settings. booking_settings.unify_with_queue
// is what the promote_bookings_to_queue() pg_cron job (runs every minute
// in Postgres) checks per tenant before promoting a confirmed booking
// into queue_entries.
//
// business_hours (Settings > Business Info) is one row per day_of_week
// (0=Sunday..6=Saturday). These aren't just displayed — DB triggers on
// bookings and queue_entries enforce them (see the business_hours_
// enforcement migration), so this is the actual gate on what the kiosk and
// WhatsApp bot are allowed to accept, not only a label shown to customers.
//
// tenants.slug is now also fetched here (alongside plan) purely so the
// Settings > Kiosk tab can render the public Kiosk URL and its QR code —
// it's the exact same slug app/kiosk/[slug]/page.tsx resolves tenants by.

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { getTenantPermissions } from "@/lib/tenant/require-tenant-permission"

import { AdminView } from "./AdminView"
import type {
  AdminBooking,
  AdminBookingSettings,
  AdminBranding,
  AdminBusinessHours,
  AdminConversationSummary,
  AdminInboxStats,
  AdminKioskSettings,
  AdminMessageSettings,
  AdminPlan,
  AdminQueueEntry,
  AdminQueueSettings,
  AdminService,
  AdminStaff,
  AdminStaffPermissions,
  AdminStaffShift,
  AdminTenantSettings,
} from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

function todayUtcRange(): { start: string; end: string } {
  const dateISO = new Date().toISOString().slice(0, 10)
  return {
    start: new Date(`${dateISO}T00:00:00.000Z`).toISOString(),
    end: new Date(`${dateISO}T23:59:59.999Z`).toISOString(),
  }
}

async function getTodaysBookings(supabase: ServerClient, tenantId: string): Promise<AdminBooking[]> {
  const { start, end } = todayUtcRange()

  const { data, error } = await supabase
    .from("bookings")
    .select(
      `id, start_time, end_time, status, booking_reference,
       services ( name ),
       staff ( name ),
       tenant_customers ( full_name, phone )`,
    )
    .eq("tenant_id", tenantId)
    .gte("start_time", start)
    .lte("start_time", end)
    .order("start_time", { ascending: true })

  if (error) throw new Error(`Failed to load today's bookings: ${error.message}`)

  return (data ?? []).map((b: any) => ({
    id: b.id,
    startTime: b.start_time,
    endTime: b.end_time,
    status: b.status,
    bookingReference: b.booking_reference,
    serviceName: b.services?.name ?? "Unknown service",
    staffName: b.staff?.name ?? "Unassigned",
    customerName: b.tenant_customers?.full_name ?? null,
    customerPhone: b.tenant_customers?.phone ?? "",
  }))
}

async function getTodaysQueue(supabase: ServerClient, tenantId: string): Promise<AdminQueueEntry[]> {
  const { data, error } = await supabase
    .from("queue_entries")
    .select(
      `id, status, joined_at,
       services ( name ),
       tenant_customers ( full_name, phone )`,
    )
    .eq("tenant_id", tenantId)
    .in("status", ["waiting", "called"])
    .order("joined_at", { ascending: true })

  if (error) throw new Error(`Failed to load today's queue: ${error.message}`)

  return (data ?? []).map((q: any) => ({
    id: q.id,
    status: q.status,
    joinedAt: q.joined_at,
    serviceName: q.services?.name ?? "Unknown service",
    customerName: q.tenant_customers?.full_name ?? null,
    customerPhone: q.tenant_customers?.phone ?? "",
  }))
}

async function getAllServices(supabase: ServerClient, tenantId: string): Promise<AdminService[]> {
  const { data, error } = await supabase
    .from("services")
    .select("id, name, price, duration_minutes, active")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true })

  if (error) throw new Error(`Failed to load services: ${error.message}`)

  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    price: Number(s.price),
    durationMinutes: s.duration_minutes,
    active: s.active,
  }))
}

// AdminStaff requires jobTitle/phone/email/clockInPin always, and
// hourlyRate ONLY as a present-or-absent key gated on payroll.view (see
// that field's doc comment in types.ts) — never sent as `null` to signal
// "no permission", since a real rate can legitimately be null too.
async function getAllStaff(supabase: ServerClient, tenantId: string, includeHourlyRate: boolean): Promise<AdminStaff[]> {
  const columns = includeHourlyRate
    ? "id, name, active, job_title, phone, email, clock_in_pin, hourly_rate"
    : "id, name, active, job_title, phone, email, clock_in_pin"

  const { data, error } = await supabase.from("staff").select(columns).eq("tenant_id", tenantId).order("name", { ascending: true })

  if (error) throw new Error(`Failed to load staff: ${error.message}`)

  return (data ?? []).map((s: any) => {
    const base = {
      id: s.id,
      name: s.name,
      active: s.active,
      jobTitle: s.job_title,
      phone: s.phone,
      email: s.email,
      clockInPin: s.clock_in_pin,
    }
    // Spreading conditionally, rather than always setting hourlyRate (even
    // to null), is what keeps the key itself absent for a non-payroll.view
    // caller — StaffManager.tsx checks `"hourlyRate" in member`, not
    // `!= null`, specifically because of this.
    return includeHourlyRate ? { ...base, hourlyRate: s.hourly_rate } : base
  })
}

// staff_shifts rows with status='active' -- the same set forceClockOutShift()
// in actions.ts operates on, joined with the staff member's name for
// display in StaffManager's "Currently clocked in" panel.
async function getActiveShifts(supabase: ServerClient, tenantId: string): Promise<AdminStaffShift[]> {
  const { data, error } = await supabase
    .from("staff_shifts")
    .select("id, staff_id, login_time, staff ( name )")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("login_time", { ascending: true })

  if (error) throw new Error(`Failed to load active shifts: ${error.message}`)

  return (data ?? []).map((row: any) => ({
    id: row.id,
    staffId: row.staff_id,
    staffName: row.staff?.name ?? "Unknown staff",
    loginTime: row.login_time,
  }))
}

// ============================================================================
// SETTINGS
// ============================================================================

const DEFAULT_IDLE_REFRESH_SECONDS = 75
const DEFAULT_CONFIRMATION_REFRESH_SECONDS = 12
const DEFAULT_REGISTRATION_TYPE: AdminKioskSettings["registrationType"] = "both"

async function getSettingsData(
  supabase: ServerClient,
  tenantId: string,
): Promise<{
  plan: AdminPlan
  slug: string
  settings: AdminTenantSettings
  branding: AdminBranding
  kioskEnabled: boolean
  kioskSettings: AdminKioskSettings
  bookingSettings: AdminBookingSettings
  queueSettings: AdminQueueSettings
  messageSettings: AdminMessageSettings
  businessHours: AdminBusinessHours
}> {
  const [
    tenantResult,
    settingsResult,
    brandingResult,
    kioskResult,
    bookingSettingsResult,
    queueSettingsResult,
    messageSettingsResult,
    businessHoursResult,
  ] = await Promise.all([
    supabase.from("tenants").select("plan, slug").eq("id", tenantId).single(),
    supabase
      .from("tenant_settings")
      .select("timezone, currency, contact_email, contact_phone, address")
      .eq("tenant_id", tenantId)
      .single(),
    supabase
      .from("tenant_branding")
      .select(
        "display_name, logo_url, primary_color, secondary_color, remove_powered_by, tagline, idle_refresh_seconds, confirmation_refresh_seconds, registration_type",
      )
      .eq("tenant_id", tenantId)
      .single(),
    // tenant_modules has no direct tenant_id -> modules.key path, so this
    // joins through modules and filters both sides — same "don't trust a
    // single filter" posture as everything else on this service-role client.
    supabase
      .from("tenant_modules")
      .select("enabled, modules!inner(key)")
      .eq("tenant_id", tenantId)
      .eq("modules.key", "kiosk")
      .maybeSingle(),
    supabase
      .from("booking_settings")
      .select(
        "unify_with_queue, queue_lead_time_minutes, min_notice_minutes, max_advance_days, cancellation_window_minutes",
      )
      .eq("tenant_id", tenantId)
      .single(),
    supabase
      .from("queue_settings")
      .select("auto_call_next, max_queue_size, notify_before_turn_position, allow_walkin_whatsapp, allow_walkin_kiosk")
      .eq("tenant_id", tenantId)
      .single(),
    supabase
      .from("message_settings")
      .select(
        "ai_enabled_default, booking_confirmation_template, booking_reminder_template, queue_joined_template, queue_almost_turn_template, queue_called_template",
      )
      .eq("tenant_id", tenantId)
      .single(),
    supabase
      .from("business_hours")
      .select("day_of_week, is_closed, open_time, close_time")
      .eq("tenant_id", tenantId)
      .order("day_of_week", { ascending: true }),
  ])

  if (tenantResult.error) throw new Error(`Failed to load plan: ${tenantResult.error.message}`)
  if (settingsResult.error) throw new Error(`Failed to load tenant settings: ${settingsResult.error.message}`)
  if (brandingResult.error) throw new Error(`Failed to load branding: ${brandingResult.error.message}`)
  if (kioskResult.error) throw new Error(`Failed to load kiosk module: ${kioskResult.error.message}`)
  if (bookingSettingsResult.error)
    throw new Error(`Failed to load booking settings: ${bookingSettingsResult.error.message}`)
  if (queueSettingsResult.error) throw new Error(`Failed to load queue settings: ${queueSettingsResult.error.message}`)
  if (messageSettingsResult.error)
    throw new Error(`Failed to load message settings: ${messageSettingsResult.error.message}`)
  if (businessHoursResult.error)
    throw new Error(`Failed to load business hours: ${businessHoursResult.error.message}`)

  const registrationType = ["booking", "queue", "both"].includes(brandingResult.data.registration_type)
    ? (brandingResult.data.registration_type as AdminKioskSettings["registrationType"])
    : DEFAULT_REGISTRATION_TYPE

  return {
    plan: tenantResult.data.plan as AdminPlan,
    slug: tenantResult.data.slug as string,
    settings: {
      timezone: settingsResult.data.timezone,
      currency: settingsResult.data.currency,
      contactEmail: settingsResult.data.contact_email,
      contactPhone: settingsResult.data.contact_phone,
      address: settingsResult.data.address,
    },
    branding: {
      displayName: brandingResult.data.display_name,
      logoUrl: brandingResult.data.logo_url,
      primaryColor: brandingResult.data.primary_color,
      secondaryColor: brandingResult.data.secondary_color,
      removePoweredBy: brandingResult.data.remove_powered_by,
    },
    kioskEnabled: kioskResult.data?.enabled ?? false,
    kioskSettings: {
      tagline: brandingResult.data.tagline,
      idleRefreshSeconds: brandingResult.data.idle_refresh_seconds ?? DEFAULT_IDLE_REFRESH_SECONDS,
      confirmationRefreshSeconds:
        brandingResult.data.confirmation_refresh_seconds ?? DEFAULT_CONFIRMATION_REFRESH_SECONDS,
      registrationType,
    },
    bookingSettings: {
      unifyWithQueue: bookingSettingsResult.data.unify_with_queue,
      queueLeadTimeMinutes: bookingSettingsResult.data.queue_lead_time_minutes,
      minNoticeMinutes: bookingSettingsResult.data.min_notice_minutes,
      maxAdvanceDays: bookingSettingsResult.data.max_advance_days,
      cancellationWindowMinutes: bookingSettingsResult.data.cancellation_window_minutes,
    },
    queueSettings: {
      autoCallNext: queueSettingsResult.data.auto_call_next,
      maxQueueSize: queueSettingsResult.data.max_queue_size,
      notifyBeforeTurnPosition: queueSettingsResult.data.notify_before_turn_position,
      allowWalkinWhatsapp: queueSettingsResult.data.allow_walkin_whatsapp,
      allowWalkinKiosk: queueSettingsResult.data.allow_walkin_kiosk,
    },
    messageSettings: {
      aiEnabledDefault: messageSettingsResult.data.ai_enabled_default,
      bookingConfirmationTemplate: messageSettingsResult.data.booking_confirmation_template,
      bookingReminderTemplate: messageSettingsResult.data.booking_reminder_template,
      queueJoinedTemplate: messageSettingsResult.data.queue_joined_template,
      queueAlmostTurnTemplate: messageSettingsResult.data.queue_almost_turn_template,
      queueCalledTemplate: messageSettingsResult.data.queue_called_template,
    },
    businessHours: (businessHoursResult.data ?? []).map((d) => ({
      dayOfWeek: d.day_of_week,
      isClosed: d.is_closed,
      openTime: d.open_time,
      closeTime: d.close_time,
    })),
  }
}

// ============================================================================
// INBOX
// ============================================================================

type ConversationRow = {
  id: string
  phone: string
  customer_name: string | null
  last_message_at: string | null
}

function bucketAiState(state: string | null | undefined): AdminConversationSummary["aiState"] {
  const s = (state ?? "").toLowerCase()
  if (s === "resolved" || s === "closed") return "resolved"
  if (s === "paused") return "paused"
  if (s === "handoff" || s === "human" || s === "manual") return "handoff"
  return "active"
}

async function getInboxData(
  supabase: ServerClient,
  tenantId: string,
): Promise<{ conversations: AdminConversationSummary[]; stats: AdminInboxStats }> {
  const [conversationsResult, statesResult, messagesResult] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, phone, customer_name, last_message_at")
      .eq("tenant_id", tenantId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(100),
    // conversation_states is keyed on (tenant_id, phone) precisely because
    // phone numbers repeat across tenants — this filter isn't optional.
    supabase.from("conversation_states").select("phone, state").eq("tenant_id", tenantId),
    supabase
      .from("messages")
      .select("id, conversation_id, direction, message_text, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1000),
  ])

  if (conversationsResult.error) throw new Error(`Failed to load conversations: ${conversationsResult.error.message}`)
  if (statesResult.error) throw new Error(`Failed to load conversation states: ${statesResult.error.message}`)
  if (messagesResult.error) throw new Error(`Failed to load messages: ${messagesResult.error.message}`)

  const conversationRows = (conversationsResult.data ?? []) as ConversationRow[]
  const stateByPhone = new Map((statesResult.data ?? []).map((s) => [s.phone, s.state as string | null]))
  const messages = messagesResult.data ?? []

  const previewByConversation = new Map<string, { text: string | null; at: string }>()
  const countByConversation = new Map<string, number>()
  for (const m of messages) {
    countByConversation.set(m.conversation_id, (countByConversation.get(m.conversation_id) ?? 0) + 1)
    if (!previewByConversation.has(m.conversation_id)) {
      previewByConversation.set(m.conversation_id, { text: m.message_text, at: m.created_at })
    }
  }

  const conversations: AdminConversationSummary[] = conversationRows.map((c) => ({
    id: c.id,
    phone: c.phone,
    customerName: c.customer_name,
    lastMessagePreview: previewByConversation.get(c.id)?.text ?? null,
    lastMessageAt: c.last_message_at ?? previewByConversation.get(c.id)?.at ?? null,
    aiState: bucketAiState(stateByPhone.get(c.phone)),
    messageCount: countByConversation.get(c.id) ?? 0,
  }))

  const dayBuckets = new Map<string, { incoming: number; outgoing: number }>()
  const days: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const key = d.toISOString().slice(0, 10)
    days.push(key)
    dayBuckets.set(key, { incoming: 0, outgoing: 0 })
  }
  for (const m of messages) {
    const key = m.created_at.slice(0, 10)
    const bucket = dayBuckets.get(key)
    if (!bucket) continue
    if (m.direction === "incoming") bucket.incoming += 1
    else bucket.outgoing += 1
  }
  const volumeByDay = days.map((date) => ({ date, ...dayBuckets.get(date)! }))

  const topCustomers = [...conversations]
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 5)
    .filter((c) => c.messageCount > 0)
    .map((c) => ({ name: c.customerName ?? c.phone, phone: c.phone, messageCount: c.messageCount }))

  const stats: AdminInboxStats = {
    totalConversations: conversations.length,
    aiActiveCount: conversations.filter((c) => c.aiState === "active").length,
    needsHumanCount: conversations.filter((c) => c.aiState === "handoff").length,
    volumeByDay,
    topCustomers,
  }

  return { conversations, stats }
}

export default async function AdminPage() {
  // Redirects to /login if there's no session or no active tenant
  // membership — see layout.tsx, which already calls this once per
  // request; React's cache() means this call is free.
  const { tenantId } = await requireTenantMember()

  const supabase = getSupabaseServerClient()

  if (!supabase) {
    return (
      <main className="mx-auto max-w-lg px-6 py-16 text-center">
        <h1 className="text-2xl text-stone-900">Admin isn&apos;t configured</h1>
        <p className="mt-3 text-stone-600">
          Set <code className="rounded bg-stone-100 px-1.5 py-0.5 text-sm">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="rounded bg-stone-100 px-1.5 py-0.5 text-sm">SUPABASE_SERVICE_ROLE_KEY</code> to use this
          page.
        </p>
      </main>
    )
  }

  // Resolved once per request, same cache() pattern as requireTenantMember
  // — see AdminStaffPermissions' doc comment in types.ts. Staff/payroll
  // data fetched below is shaped around this: hourlyRate is only
  // requested from the DB at all when payrollView is true.
  //
  // ASSUMPTION FLAGGED: this call site assumes getTenantPermissions()
  // takes no arguments and resolves tenantId/role from the session itself
  // (matching requireTenantMember()'s own signature) and returns at least
  // the 4 fields AdminStaffPermissions needs. I haven't seen
  // lib/tenant/require-tenant-permission.ts directly — if its real
  // signature differs (e.g. it takes tenantId, or returns a differently
  // shaped object), this line needs adjusting to match.
  const permissions = await getTenantPermissions()

  const [bookings, queue, services, staff, activeShifts, inbox, settingsData] = await Promise.all([
    getTodaysBookings(supabase, tenantId),
    getTodaysQueue(supabase, tenantId),
    getAllServices(supabase, tenantId),
    getAllStaff(supabase, tenantId, permissions.payrollView),
    getActiveShifts(supabase, tenantId),
    getInboxData(supabase, tenantId),
    getSettingsData(supabase, tenantId),
  ])

  return (
    <AdminView
      initialBookings={bookings}
      initialQueue={queue}
      initialServices={services}
      initialStaff={staff}
      initialActiveShifts={activeShifts}
      staffPermissions={permissions}
      initialConversations={inbox.conversations}
      initialInboxStats={inbox.stats}
      initialPlan={settingsData.plan}
      tenantSlug={settingsData.slug}
      initialTenantSettings={settingsData.settings}
      initialBranding={settingsData.branding}
      initialKioskEnabled={settingsData.kioskEnabled}
      initialKioskSettings={settingsData.kioskSettings}
      initialBookingSettings={settingsData.bookingSettings}
      initialQueueSettings={settingsData.queueSettings}
      initialMessageSettings={settingsData.messageSettings}
      initialBusinessHours={settingsData.businessHours}
    />
  )
}
