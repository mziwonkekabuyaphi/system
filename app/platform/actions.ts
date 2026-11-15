// app/platform/actions.ts — STOP-GAP RECONSTRUCTION. Prefer restoring the original from git (see chat).
// layout.tsx only needs `signOutAction` from here. The import below is a GUESS: change it to the same
// session-based Supabase server client your /login page or app/admin/actions.ts uses.
"use server"

import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server" // <-- adjust to your real session client

export async function signOutAction(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}
