// app/refer/[code]/actions.ts
"use server"

// Public sign-up request. Nothing here creates a tenant: it only records a
// PENDING request tied to the referral code. A platform admin must approve it
// before any shop (or commission) exists. Rate-limited per IP.

import { headers } from "next/headers"

import { getSupabaseServerClient } from "@/lib/supabase/admin"

export type ReferralResult = { success: true } | { success: false; error: string }

export async function submitReferralSignup(input: {
  code: string
  businessName: string
  contactName: string
  phone: string
  email: string
  notes: string
}): Promise<ReferralResult> {
  try {
    const businessName = input.businessName.trim()
    const contactName = input.contactName.trim()
    const phone = input.phone.trim()
    const email = input.email.trim()
    if (businessName.length < 2 || businessName.length > 120) return { success: false, error: "Enter your business name." }
    if (contactName.length < 2 || contactName.length > 120) return { success: false, error: "Enter your name." }
    if (phone.replace(/\D/g, "").length < 9) return { success: false, error: "Enter a valid phone number." }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { success: false, error: "Enter a valid email address." }
    if (input.notes.length > 500) return { success: false, error: "Notes must be 500 characters or fewer." }

    const supabase = getSupabaseServerClient()
    if (!supabase) return { success: false, error: "Sign-up isn't available right now." }

    const h = await headers()
    const ip = (h.get("x-forwarded-for") ?? "unknown").split(",")[0].trim()
    const { data: allowed } = await supabase.rpc("check_rate_limit", {
      p_key: `referral-signup:${ip}`,
      p_limit: 5,
      p_window_seconds: 3600,
    })
    if (allowed === false) return { success: false, error: "Too many requests. Please try again later." }

    const { error } = await supabase.rpc("submit_referral_signup", {
      p_code: input.code,
      p_business_name: businessName,
      p_contact_name: contactName,
      p_contact_phone: phone,
      p_contact_email: email || null,
      p_notes: input.notes.trim() || null,
    })
    if (error) {
      // Don't leak internals; an unknown code is the one expected failure.
      return { success: false, error: "This referral link isn't valid. Please ask your contact for a new one." }
    }
    return { success: true }
  } catch {
    return { success: false, error: "Something went wrong. Please try again." }
  }
}
