// app/pay/ozow-return/route.ts
/**
 * Where Ozow sends the customer after paying, cancelling or hitting an error.
 *
 * Ozow POSTS the customer back to these URLs (with the result in the body), and a normal Next page can only answer
 * a GET. This route accepts either and redirects to the ordinary result page (/pay/result).
 *
 * The posted body is deliberately never read: the redirect says nothing about whether money moved. A Passport or
 * ticket is only ever issued by the signed notification (/api/webhooks/ozow/<integrationId>). The ?status= in the
 * URL is our own, set when the payment link was made, and only a fixed set of values is passed on.
 */

import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ALLOWED = new Set(["success", "cancelled", "failed"])

function back(req: Request) {
  const url = new URL(req.url)
  const status = url.searchParams.get("status") ?? ""
  // 303: after a POST the browser must follow with a GET.
  return NextResponse.redirect(new URL(`/pay/result?status=${ALLOWED.has(status) ? status : "failed"}`, url.origin), 303)
}

export async function POST(req: Request) {
  return back(req)
}

export async function GET(req: Request) {
  return back(req)
}
