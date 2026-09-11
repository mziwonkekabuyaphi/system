// app/admin/page.tsx
//
// TODO(security): this route has NO access protection — anyone with the
// URL can see customer names/phone numbers and edit services/staff.
// This is deliberate for this prototype pass (see project constraints),
// but this page MUST NOT go to production without at least an env-var
// shared-password gate before this TODO is removed.
//
// Shop-owner-facing admin view for the WhatsApp booking bot.
// Read path: this Server Component uses the service-role Supabase client
// directly (same pattern as booking.ts) since Server Components never
// ship to the browser. Write path: every mutation goes through the
// Server Actions in ./actions.ts instead, so the service-role key stays
// server-only even as the UI adds more interactive editing later.

import { getSupabaseServerClient } from "@/lib/supabase/server"

import { AdminView } from "./AdminView"
import type {
  AdminBooking,
  AdminConversationSummary,
  AdminInboxStats,
  AdminQueueEntry,
  AdminService,
  AdminStaff,
} from "./types"

type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

// ASSUMPTIONS
// "Today" is computed as a UTC calendar day — the same day-boundary
// convention booking.ts's getBookingsForDate() already uses for slot
// generation, so a booking that's "today" here is "today" from the bot's
// perspective too. If the shop's local timezone is far from UTC this can
// clip an hour or two off either end of the *real* local day. Swap for a
// shop-local timezone constant (the same way SHOP_OPEN_HOUR is a flat
// constant in booking.ts) before production.
function todayUtcRange(): { start: string; end: string } {
  const dateISO = new Date().toISOString().slice(0, 10)
  return {
    start: new Date(`${dateISO}T00:00:00.000Z`).toISOString(),
    end: new Date(`${dateISO}T23:59:59.999Z`).toISOString(),
  }
}

async function getTodaysBookings(supabase: ServerClient): Promise<AdminBooking[]> {
  const { start, end } = todayUtcRange()

  // Embeds services/staff/profiles in one round trip via their FK
  // relationships (bookings.service_id, bookings.staff_id,
  // bookings.customer_id -> profiles.id) rather than N+1 queries.
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `id, start_time, end_time, status, booking_reference,
       services ( name ),
       staff ( name ),
       profiles ( name, surname, phone )`,
    )
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
    customerName: b.profiles ? [b.profiles.name, b.profiles.surname].filter(Boolean).join(" ") || null : null,
    customerPhone: b.profiles?.phone ?? "",
  }))
}

// Only "waiting" and "called" — this is the actionable, in-progress
// queue. Entries that are "done" or "cancelled" have nothing left for the
// owner to do, so they're left out rather than adding a filter toggle for
// a prototype's single admin view.
async function getTodaysQueue(supabase: ServerClient): Promise<AdminQueueEntry[]> {
  const { data, error } = await supabase
    .from("queue_entries")
    .select(
      `id, status, joined_at,
       services ( name ),
       profiles ( name, surname, phone )`,
    )
    .in("status", ["waiting", "called"])
    .order("joined_at", { ascending: true })

  if (error) throw new Error(`Failed to load today's queue: ${error.message}`)

  return (data ?? []).map((q: any) => ({
    id: q.id,
    status: q.status,
    joinedAt: q.joined_at,
    serviceName: q.services?.name ?? "Unknown service",
    customerName: q.profiles ? [q.profiles.name, q.profiles.surname].filter(Boolean).join(" ") || null : null,
    customerPhone: q.profiles?.phone ?? "",
  }))
}

async function getAllServices(supabase: ServerClient): Promise<AdminService[]> {
  const { data, error } = await supabase
    .from("services")
    .select("id, name, price, duration_minutes, active")
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

async function getAllStaff(supabase: ServerClient): Promise<AdminStaff[]> {
  const { data, error } = await supabase.from("staff").select("id, name, active").order("name", { ascending: true })

  if (error) throw new Error(`Failed to load staff: ${error.message}`)

  return (data ?? []).map((s) => ({ id: s.id, name: s.name, active: s.active }))
}

// ============================================================================
// INBOX — ported from the old whatsapp-admin.html/admin.js panel (see
// InboxManager.tsx's file header for the full kept-vs-cut list).
// ============================================================================

type ConversationRow = {
  id: string
  phone: string
  customer_name: string | null
  last_message_at: string | null
}

/**
 * Buckets a raw conversation_states.state value the same way admin.js's
 * AI_OFF_STATES/CLOSED_STATES did, collapsed to the 4 states this UI acts
 * on. A missing row (customer has never triggered a handover) means the
 * bot is still handling things normally, i.e. "active".
 */
function bucketAiState(state: string | null | undefined): AdminConversationSummary["aiState"] {
  const s = (state ?? "").toLowerCase()
  if (s === "resolved" || s === "closed") return "resolved"
  if (s === "paused") return "paused"
  if (s === "handoff" || s === "human" || s === "manual") return "handoff"
  return "active"
}

/**
 * Both the inbox list and the analytics dashboard are built from one
 * shared fetch: conversations + conversation_states + a bounded recent-
 * message sample. The sample (last 1000 messages across ALL
 * conversations, not per-conversation) replaces admin.js's original
 * approach of fetching every message for every conversation individually
 * (a real N+1) — this is one query instead of N, at the cost of preview/
 * count/volume numbers being a floor rather than an exact lifetime total
 * for any conversation with more history than the sample covers. Good
 * enough for a prototype's "what needs my attention today" view.
 */
async function getInboxData(
  supabase: ServerClient,
): Promise<{ conversations: AdminConversationSummary[]; stats: AdminInboxStats }> {
  const [conversationsResult, statesResult, messagesResult] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, phone, customer_name, last_message_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(100),
    supabase.from("conversation_states").select("phone, state"),
    supabase
      .from("messages")
      .select("id, conversation_id, direction, message_text, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
  ])

  if (conversationsResult.error) throw new Error(`Failed to load conversations: ${conversationsResult.error.message}`)
  if (statesResult.error) throw new Error(`Failed to load conversation states: ${statesResult.error.message}`)
  if (messagesResult.error) throw new Error(`Failed to load messages: ${messagesResult.error.message}`)

  const conversationRows = (conversationsResult.data ?? []) as ConversationRow[]
  const stateByPhone = new Map((statesResult.data ?? []).map((s) => [s.phone, s.state as string | null]))
  const messages = messagesResult.data ?? []

  // messages are fetched newest-first, so the first one seen per
  // conversation is the latest — matches admin.js's lastMsg() without
  // needing a second sort pass.
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

  // ── Volume by day (last 7 days, from the same message sample) ──
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
    if (!bucket) continue // outside the 7-day window
    if (m.direction === "incoming") bucket.incoming += 1
    else bucket.outgoing += 1
  }
  const volumeByDay = days.map((date) => ({ date, ...dayBuckets.get(date)! }))

  // ── Top customers by message count within the sample ──
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

  const [bookings, queue, services, staff, inbox] = await Promise.all([
    getTodaysBookings(supabase),
    getTodaysQueue(supabase),
    getAllServices(supabase),
    getAllStaff(supabase),
    getInboxData(supabase),
  ])

  return (
    <AdminView
      initialBookings={bookings}
      initialQueue={queue}
      initialServices={services}
      initialStaff={staff}
      initialConversations={inbox.conversations}
      initialInboxStats={inbox.stats}
    />
  )
}
