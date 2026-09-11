// app/admin/page.tsx
import { getSupabaseServerClient } from "@/lib/supabase/server"
import { AdminView } from "./AdminView"
import type { AdminBooking, AdminService, AdminStaff } from "./types"

type SupabaseServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

// This is a live operational view (today's actual bookings) — never serve
// a cached/stale render of it.
export const dynamic = "force-dynamic"

function startAndEndOfToday(): { startIso: string; endIso: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

async function loadTodayBookings(supabase: SupabaseServerClient): Promise<AdminBooking[]> {
  const { startIso, endIso } = startAndEndOfToday()

  const { data, error } = await supabase
    .from("bookings")
    .select(
      `id, start_time, end_time, status, booking_reference,
       services(name), staff(name), profiles(name, phone)`,
    )
    .gte("start_time", startIso)
    .lte("start_time", endIso)
    .order("start_time", { ascending: true })

  if (error) {
    console.error("[admin] Failed to load today's bookings", error)
    return []
  }

  // services/staff/profiles are joined singular relationships (one booking
  // has exactly one of each), but Supabase's generated types leave them
  // possibly-array depending on relationship inference — same defensive
  // unwrap pattern vvip.ts uses for its own joins.
  return (data ?? []).map((row): AdminBooking => {
    const service = Array.isArray(row.services) ? row.services[0] : row.services
    const staffMember = Array.isArray(row.staff) ? row.staff[0] : row.staff
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles

    return {
      id: row.id,
      serviceName: service?.name ?? "Unknown service",
      staffName: staffMember?.name ?? "Unassigned",
      customerName: profile?.name ?? null,
      customerPhone: profile?.phone ?? "",
      startTime: row.start_time,
      endTime: row.end_time,
      status: row.status,
      bookingReference: row.booking_reference,
    }
  })
}

async function loadServices(supabase: SupabaseServerClient): Promise<AdminService[]> {
  const { data, error } = await supabase.from("services").select("*").order("price", { ascending: true })
  if (error) {
    console.error("[admin] Failed to load services", error)
    return []
  }
  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    price: Number(s.price),
    durationMinutes: s.duration_minutes,
    active: s.active,
  }))
}

async function loadStaff(supabase: SupabaseServerClient): Promise<AdminStaff[]> {
  const { data, error } = await supabase.from("staff").select("*").order("name", { ascending: true })
  if (error) {
    console.error("[admin] Failed to load staff", error)
    return []
  }
  return (data ?? []).map((s) => ({ id: s.id, name: s.name, active: s.active }))
}

export default async function AdminPage() {
  const supabase = getSupabaseServerClient()

  if (!supabase) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-10 text-[#1C1A17]">
        Supabase isn't configured — check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
      </div>
    )
  }

  const [bookings, services, staff] = await Promise.all([
    loadTodayBookings(supabase),
    loadServices(supabase),
    loadStaff(supabase),
  ])

  return <AdminView initialBookings={bookings} initialServices={services} initialStaff={staff} />
}
