// app/admin/actions.ts
"use server"

/**
 * Server Actions for the shop-owner admin view.
 * -----------------------------------------------
 * Access protection: every action below starts with requireTenantMember()
 * (same helper layout.tsx uses), so a Server Action reference sitting in
 * a signed-out browser tab can't be used to write data — it redirects
 * instead. tenantId then gets stamped onto every insert and used to
 * scope every update/delete, so one tenant's admin can't act on another
 * tenant's row even by guessing a UUID.
 */

import { revalidatePath } from "next/cache"
import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import type { AdminStaffInput } from "./types"

type ActionResult = { ok: true } | { ok: false; error: string }
type ServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>

async function getTenantScopedClient() {
  const { tenantId } = await requireTenantMember()
  const supabase = getSupabaseServerClient()
  if (!supabase) return { supabase: null as const, tenantId: null, error: "Supabase isn't configured." }
  return { supabase, tenantId, error: undefined as string | undefined }
}

// ============================================================================
// Bookings
// ============================================================================

export async function cancelBooking(bookingId: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("tenant_id", tenantId) // can't cancel another tenant's booking by ID-guessing

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
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateServiceInput(input)
  if (validationError) return { ok: false, error: validationError }

  const { error: insertError } = await supabase.from("services").insert([
    {
      tenant_id: tenantId,
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
  const { supabase, tenantId, error } = await getTenantScopedClient()
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
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

export async function toggleServiceActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("services")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}



// ============================================================================
// Queue
// ============================================================================

export async function callQueueEntry(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("queue_entries")
    .update({ status: "called", called_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

export async function markQueueEntryDone(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("queue_entries")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

export async function removeFromQueue(id: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: deleteError } = await supabase
    .from("queue_entries")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (deleteError) return { ok: false, error: deleteError.message }

  revalidatePath("/admin")
  return { ok: true }
}

// ============================================================================
// Staff
// ============================================================================

function validateStaffInput(input: AdminStaffInput): string | null {
  if (!input.name.trim()) return "Name is required."
  if (input.hourlyRate !== null && (!Number.isFinite(input.hourlyRate) || input.hourlyRate < 0)) {
    return "Hourly rate must be 0 or more."
  }
  if (input.clockInPin && !/^\d{4,6}$/.test(input.clockInPin)) {
    return "PIN must be 4-6 digits."
  }
  return null
}

// Pre-check for a friendly error message — the DB's partial unique index
// on (tenant_id, clock_in_pin) is the real guard (see the
// add_staff_hr_profile_and_shifts migration); this just avoids a raw
// constraint-violation message reaching the admin. Scoped to this tenant
// only, since the same PIN is fine across different shops.
async function assertPinAvailable(
  supabase: ServerClient,
  tenantId: string,
  pin: string,
  excludeStaffId?: string,
): Promise<string | null> {
  if (!pin) return null
  let query = supabase.from("staff").select("id, name").eq("tenant_id", tenantId).eq("clock_in_pin", pin)
  if (excludeStaffId) query = query.neq("id", excludeStaffId)
  const { data } = await query.maybeSingle()
  if (data) return `That PIN is already used by ${data.name}.`
  return null
}

export async function addStaff(input: AdminStaffInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateStaffInput(input)
  if (validationError) return { ok: false, error: validationError }

  if (input.clockInPin) {
    const pinError = await assertPinAvailable(supabase, tenantId!, input.clockInPin)
    if (pinError) return { ok: false, error: pinError }
  }

  const { error: insertError } = await supabase.from("staff").insert([
    {
      tenant_id: tenantId,
      name: input.name.trim(),
      job_title: input.jobTitle.trim() || null,
      hourly_rate: input.hourlyRate,
      phone: input.phone.trim() || null,
      email: input.email.trim() || null,
      clock_in_pin: input.clockInPin || null,
      active: true,
    },
  ])
  if (insertError) {
    if (insertError.message.includes("staff_tenant_clock_in_pin_unique")) {
      return { ok: false, error: "That PIN is already in use by another staff member." }
    }
    return { ok: false, error: insertError.message }
  }

  revalidatePath("/admin")
  return { ok: true }
}

export async function updateStaff(id: string, input: AdminStaffInput): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const validationError = validateStaffInput(input)
  if (validationError) return { ok: false, error: validationError }

  if (input.clockInPin) {
    const pinError = await assertPinAvailable(supabase, tenantId!, input.clockInPin, id)
    if (pinError) return { ok: false, error: pinError }
  }

  const { error: updateError } = await supabase
    .from("staff")
    .update({
      name: input.name.trim(),
      job_title: input.jobTitle.trim() || null,
      hourly_rate: input.hourlyRate,
      phone: input.phone.trim() || null,
      email: input.email.trim() || null,
      clock_in_pin: input.clockInPin || null,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (updateError) {
    if (updateError.message.includes("staff_tenant_clock_in_pin_unique")) {
      return { ok: false, error: "That PIN is already in use by another staff member." }
    }
    return { ok: false, error: updateError.message }
  }

  revalidatePath("/admin")
  return { ok: true }
}

export async function toggleStaffActive(id: string, active: boolean): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { error: updateError } = await supabase
    .from("staff")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}

// ----------------------------------------------------------------------------
// Shifts — the actual clock-in/clock-out writes happen at the public
// /clock/[slug] PIN pad (app/clock/[slug]/actions.ts), which re-resolves
// tenantId from the slug the same way /kiosk/[slug] does and doesn't go
// through requireTenantMember() at all (there's no admin session at a
// shared tablet). The only shift-related action admins get here is an
// emergency override for a shift someone forgot to clock out of.
// ----------------------------------------------------------------------------

export async function forceClockOutShift(shiftId: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const { data: shift, error: fetchError } = await supabase
    .from("staff_shifts")
    .select("id, login_time")
    .eq("id", shiftId)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle()

  if (fetchError) return { ok: false, error: fetchError.message }
  if (!shift) return { ok: false, error: "That shift is no longer active — try refreshing." }

  const now = new Date()
  const hoursWorked = (now.getTime() - new Date(shift.login_time).getTime()) / (1000 * 60 * 60)

  const { error: updateError } = await supabase
    .from("staff_shifts")
    .update({
      logout_time: now.toISOString(),
      status: "completed",
      hours_worked: Number(hoursWorked.toFixed(2)),
      force_logout: true,
    })
    .eq("id", shiftId)
    .eq("tenant_id", tenantId)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/admin")
  return { ok: true }
}
