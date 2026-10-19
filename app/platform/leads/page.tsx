// app/platform/leads/page.tsx — enquiries from the website's "Book a demo / Get in touch" form.
import { redirect } from "next/navigation"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { requirePlatformAdmin } from "@/lib/sales/auth"

import { Leads, type LeadRow } from "./Leads"

export const dynamic = "force-dynamic"

export default async function LeadsPage() {
  await requirePlatformAdmin() // the real gate: the read below uses the service-role client
  const supabase = getSupabaseServerClient()
  if (!supabase) redirect("/login")

  const { data, error } = await supabase
    .from("contact_requests")
    .select("id, kind, name, business_name, email, phone, message, status, admin_notes, created_at")
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) console.error("[platform/leads] could not load enquiries", error)

  return <Leads rows={(data ?? []) as LeadRow[]} loadFailed={Boolean(error)} />
}
