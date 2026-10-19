"use server"
// app/demo/actions.ts — the landing page's "Book a demo / Get in touch" form.
// Writes to public.contact_requests with the service-role client. The table has no
// insert policy, so nothing in the browser can write to it directly: it all goes
// through the checks here.

import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type ContactResult = { ok: true } | { ok: false; error: string }

const GENERIC_ERROR = "We couldn't send that just now. Please try again, or email hello@ndithini.com."

function clean(value: FormDataEntryValue | null, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : ""
}

export async function submitContactRequest(formData: FormData): Promise<ContactResult> {
  // Honeypot: real people never see or fill this field. Pretend it worked.
  if (clean(formData.get("website"), 200)) return { ok: true }

  const kind = clean(formData.get("kind"), 20) === "contact" ? "contact" : "demo"
  const name = clean(formData.get("name"), 120)
  const business = clean(formData.get("business"), 160)
  const email = clean(formData.get("email"), 254).toLowerCase()
  const phone = clean(formData.get("phone"), 40)
  // Keep line breaks in the message, but collapse runaway whitespace.
  const rawMessage = formData.get("message")
  const message = (typeof rawMessage === "string" ? rawMessage : "").replace(/[ \t]+/g, " ").trim().slice(0, 2000)

  if (!name) return { ok: false, error: "Please tell us your name." }
  if (!email && !phone) return { ok: false, error: "Please give us an email address or a phone number so we can reach you." }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "That email address doesn't look right." }
  const phoneDigits = phone.replace(/\D/g, "")
  if (phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) return { ok: false, error: "That phone number doesn't look right." }

  try {
    const supabase = getSupabaseServerClient()
    if (!supabase) throw new Error("Supabase server client is unavailable")

    // Cheap abuse limits, no extra tables: 3 per person per hour, 30 in total per 10 minutes.
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    const countSince = (column: "email" | "phone", value: string) =>
      supabase.from("contact_requests").select("id", { count: "exact", head: true }).eq(column, value).gte("created_at", hourAgo)
    const [byEmail, byPhone, all] = await Promise.all([
      email ? countSince("email", email) : Promise.resolve({ count: 0, error: null }),
      phone ? countSince("phone", phone) : Promise.resolve({ count: 0, error: null }),
      supabase.from("contact_requests").select("id", { count: "exact", head: true }).gte("created_at", tenMinAgo),
    ])
    if (byEmail.error || byPhone.error || all.error) {
      throw new Error((byEmail.error ?? byPhone.error ?? all.error)?.message)
    }
    if ((byEmail.count ?? 0) >= 3 || (byPhone.count ?? 0) >= 3 || (all.count ?? 0) >= 30) {
      return { ok: false, error: "We already have your request. We'll be in touch soon." }
    }

    const { error } = await supabase.from("contact_requests").insert({
      kind,
      name,
      business_name: business || null,
      email: email || null,
      phone: phone || null,
      message: message || null,
    })
    if (error) throw new Error(error.message)
    return { ok: true }
  } catch (error) {
    console.error("[contact] Could not save a contact request", error)
    return { ok: false, error: GENERIC_ERROR }
  }
}
