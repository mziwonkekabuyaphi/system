// app/admin/types.ts
// Shared shapes between the Server Component (page.tsx) that fetches data
// and the client components that render it. Deliberately flat/display-ready
// (durationMinutes not duration_minutes, price already Number()'d) so no
// client component has to know about the raw Supabase row shape.

export interface AdminService {
  id: string
  name: string
  price: number
  durationMinutes: number
  active: boolean
}

export interface AdminStaff {
  id: string
  name: string
  active: boolean
}

export interface AdminBooking {
  id: string
  serviceName: string
  staffName: string
  /** Null when the customer hasn't given a name yet (see booking.ts's
   * post-booking name-collection step) — falls back to phone in the UI. */
  customerName: string | null
  customerPhone: string
  /** ISO timestamps — formatted for display in the client components. */
  startTime: string
  endTime: string
  status: "confirmed" | "cancelled"
  bookingReference: string
}
