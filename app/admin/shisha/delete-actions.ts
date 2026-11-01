// app/admin/shisha/delete-actions.ts
//
// Permanent delete for flavours, devices and stations. Archive (in ./actions)
// stays the safe default; this is for rows that were never used.
//
// A row that any session has ever used CANNOT be deleted: shisha_sessions
// points at it with a foreign key, and removing it would break past sessions
// and totals. Postgres rejects that with error 23503, and we turn it into a
// plain message telling the owner to archive instead.
//
// Same guards as the rest of the admin: tenant member, shisha module on,
// shisha.manage permission, and every query filtered by tenant_id (this runs
// on the service-role client, so RLS does not protect us here).
"use server"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requireTenantMember } from "@/lib/tenant/current-tenant-member"
import { getTenantPermissions } from "@/lib/tenant/require-tenant-permission"
import { getEnabledProducts } from "@/lib/services/plans"

import type { ShishaActionResult } from "./shisha-types"

type Kind = "flavour" | "device" | "station"

const TABLE: Record<Kind, "shisha_products" | "shisha_devices" | "shisha_locations"> = {
  flavour: "shisha_products",
  device: "shisha_devices",
  station: "shisha_locations",
}

const HAS_HISTORY: Record<Kind, string> = {
  flavour: "This flavour has been used in sessions, so it can't be deleted. Archive it instead to keep your history.",
  device: "This device has been used in sessions, so it can't be deleted. Archive it instead to keep your history.",
  station: "This station has been used in sessions, so it can't be deleted. Archive it instead to keep your history.",
}

async function deleteRow(kind: Kind, id: string): Promise<ShishaActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Missing item." } as ShishaActionResult

  const { tenantId } = await requireTenantMember()

  const supabase = getSupabaseServerClient()
  if (!supabase) return { ok: false, error: "Server isn't configured." } as ShishaActionResult

  const products = await getEnabledProducts(supabase, tenantId)
  if (!products.shisha) return { ok: false, error: "Shisha isn't enabled for this shop." } as ShishaActionResult

  const { granted } = await getTenantPermissions(["shisha.manage"])
  if (!granted.has("shisha.manage")) {
    return { ok: false, error: "You don't have permission to delete this." } as ShishaActionResult
  }

  // Devices: a device on a live session must never be removed.
  if (kind === "device") {
    const { count } = await supabase
      .from("shisha_sessions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("device_id", id)
      .neq("status", "completed")
    if ((count ?? 0) > 0) {
      return { ok: false, error: "This device is in use right now. End its session first." } as ShishaActionResult
    }
  }

  // Stations still holding devices: devices.location_id would block it too,
  // so say so clearly instead of showing a raw database error.
  if (kind === "station") {
    const { count } = await supabase
      .from("shisha_devices")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("location_id", id)
      .is("archived_at", null)
    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: "This station still has devices. Move or delete them first.",
      } as ShishaActionResult
    }
  }

  // .select("id") so we can tell "deleted" from "nothing matched" (wrong
  // tenant or already gone) — a plain delete returns no error either way.
  const { data, error } = await supabase
    .from(TABLE[kind])
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id")

  if (error) {
    if (error.code === "23503") return { ok: false, error: HAS_HISTORY[kind] } as ShishaActionResult
    console.error(`[shisha] delete ${kind} failed`, error)
    return { ok: false, error: "Couldn't delete it. Please try again." } as ShishaActionResult
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "It was already removed or doesn't exist." } as ShishaActionResult
  }

  return { ok: true } as ShishaActionResult
}

export async function deleteFlavour(id: string): Promise<ShishaActionResult> {
  return deleteRow("flavour", id)
}

export async function deleteDevice(id: string): Promise<ShishaActionResult> {
  return deleteRow("device", id)
}

export async function deleteStation(id: string): Promise<ShishaActionResult> {
  return deleteRow("station", id)
}
