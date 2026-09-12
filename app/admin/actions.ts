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

type ActionResult = { ok: true } | { ok: false; error: string }

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

export async function addStaff(name: string): Promise<ActionResult> {
  const { supabase, tenantId, error } = await getTenantScopedClient()
  if (!supabase) return { ok: false, error: error! }

  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: "Name is required." }

  const { error: insertError } = await supabase
    .from("staff")
    .insert([{ tenant_id: tenantId, name: trimmed, active: true }])
  if (insertError) return { ok: false, error: insertError.message }

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
