// app/admin/actions.ts
"use server"

/**
 * Server Actions for the shop-owner admin view.
 * -----------------------------------------------
 * Deliberately thin — one write each, basic input validation, then
 * revalidate so page.tsx's Server Component re-fetches fresh data on the
 * next render. No business logic beyond validation lives here, mirroring
 * the "pure dispatcher" discipline the WhatsApp action-router follows.
 *
 * ⚠️ This route has NO ACCESS PROTECTION yet (see layout.tsx's TODO).
 * These actions are reachable by anyone who can load /admin — don't link
 * this route anywhere customer-facing, and add auth before production.
 */

import { revalidatePath } from "next/cache"
import { getSupabaseServerClient } from "@/lib/supabase/server"

type ActionResult = { ok: true } | { ok: false; error: string }

function getClientOrError() {
  const supabase = getSupabaseServerClient()
  if (!supabase) return { supabase: null as const, error: "Supabase isn't configured." }
  return { supabase, error: undefined as string | undefined }
}

// ============================================================================
// Bookings
// ============================================================================

export async function cancelBooking(bookingId: string): Promise<ActionResult> {
  const { supabase, error } = getClientOrError()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Services
// ============================================================================

interface ServiceInput {
  name: string
  price: number
  durationMinutes: number
}

function validateServiceInput(input: ServiceInput): string | null {
  if (!input.name.trim()) return "Name is required."
  if (!Number.isFinite(input.price) || input.price < 0) return "Price must be 0 or more."
  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
    return "Duration must be greater than 0."
  }
  return null
}

export async function addService(input: ServiceInput): Promise<ActionResult> {
  const { supabase, error } = getClientOrError()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateServiceInput(input)
  if (validationError) return { ok: false, error: validationError }

  const { error: insertError } = await supabase.from("services").insert([
    {
      name: input.name.trim(),
      price: input.price,
      duration_minutes: input.durationMinutes,
      active: true,
    },
  ])

  if (insertError) return { ok: false, error: insertError.message }

  revalidatePath("/admin")
  return { ok: true }
}

export async function updateService(id: string, input: ServiceInput): Promise<ActionResult> {
  const { supabase, error } = getClientOrError()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateServiceInput(input)
  if (validationError) return { ok: false, error: validationError }

  const { error: updateError } = await supabase
    .from("services")
    .update({
      name: input.name.trim(),
      price: input.price,
      duration_minutes: input.durationMinutes,
    })
    .eq("id", id)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

/**
 * Soft delete only — see booking_schema.sql's comment on why services are
 * never hard-deleted (a service with existing bookings would orphan the
 * booking's `services(name)` join). Deactivating just hides it from the
 * WhatsApp bot's `getBookableServices()` listing (`.eq("active", true)`).
 */
export async function toggleServiceActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, error } = getClientOrError()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase.from("services").update({ active }).eq("id", id)
  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Staff
// ============================================================================

export async function addStaff(name: string): Promise<ActionResult> {
  const { supabase, error } = getClientOrError()
  if (!supabase) return { ok: false, error: error! }

  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: "Name is required." }

  const { error: insertError } = await supabase.from("staff").insert([{ name: trimmed, active: true }])
  if (insertError) return { ok: false, error: insertError.message }

  revalidatePath("/admin")
  return { ok: true }
}

/**
 * Soft delete only, same reasoning as toggleServiceActive — deactivating
 * removes this staff member from booking.ts's getActiveStaff() pool
 * (`.eq("active", true)`) without breaking existing bookings' staff_id
 * foreign key.
 */
export async function toggleStaffActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, error } = getClientOrError()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase.from("staff").update({ active }).eq("id", id)
  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}
