// app/platform/actions.ts — sign-out for the platform-admin area.
"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"

export async function signOutAction() {
  const jar = await cookies()
  // Supabase auth cookies are named sb-<project>-auth-token (possibly chunked as .0, .1, ...).
  for (const c of jar.getAll()) {
    if (c.name.startsWith("sb-")) jar.delete(c.name)
  }
  redirect("/login")
}
