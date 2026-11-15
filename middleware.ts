// middleware.ts
//
// Entry point Next.js runs. Two jobs, in this order:
//   1. A request on a shop's OWN domain (book.theirsalon.co.za) is routed to that shop's public
//      pages (lib/domains), or refused. It never reaches the session code.
//   2. Everything on our own hostnames goes through updateSession, as before.
//
// Before this change the hostname routing lived in an unused `middleware` export inside
// lib/supabase/middleware.ts. Next.js only runs this root file, so it never executed.

import { type NextRequest } from "next/server"

import { handleCustomDomain } from "@/lib/domains/handle-custom-domain"
import { isPlatformHostname, normalizeHost } from "@/lib/domains/custom-domain-routing"
import { updateSession } from "@/lib/supabase/middleware"

export async function middleware(request: NextRequest) {
  const host = normalizeHost(request.headers.get("host") ?? request.nextUrl.host)

  if (!host || isPlatformHostname(host)) {
    return await updateSession(request)
  }
  return await handleCustomDomain(request, host)
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
