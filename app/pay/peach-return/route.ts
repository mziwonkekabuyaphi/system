// app/pay/peach-return/route.ts
/**
 * Where Peach Payments sends the customer after paying, cancelling or timing out.
 *
 * Peach POSTs the customer back to the shopperResultUrl (with the result in the body), and a normal Next page can only
 * answer a GET. This route accepts either and redirects to the ordinary result page (/pay/result).
 *
 * The posted body is NEVER trusted: it is only read for two harmless things, our own reference (so the result page can
 * look the payment up in OUR database) and whether the customer cancelled (to choose the words). Whether money moved is
 * decided only by the signed notification (/api/webhooks/peach/<integrationId>), so a forged POST here can change
 * nothing but the wording the person sees.
 */

import { NextResponse } from "next/server"

import { isPeachReference, peachReturnHint } from "@/lib/payments/providers/peach"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function back(req: Request) {
  const url = new URL(req.url)
  let reference = url.searchParams.get("reference") ?? ""
  let resultCode = ""
  if (req.method === "POST") {
    try {
      const form = await req.formData()
      const get = (name: string) => {
        const value = form.get(name)
        return typeof value === "string" ? value : ""
      }
      reference = get("merchantTransactionId") || reference
      resultCode = get("result.code") || get("result_code")
    } catch {
      /* not a form body: fall back to the query string */
    }
  }

  const target = new URL("/pay/result", url.origin)
  if (isPeachReference(reference)) {
    target.searchParams.set("reference", reference)
    if (peachReturnHint(resultCode) === "cancelled") target.searchParams.set("status", "cancelled")
  } else {
    target.searchParams.set("status", "failed")
  }
  // 303: after a POST the browser must follow with a GET.
  return NextResponse.redirect(target, 303)
}

export async function POST(req: Request) {
  return back(req)
}

export async function GET(req: Request) {
  return back(req)
}
