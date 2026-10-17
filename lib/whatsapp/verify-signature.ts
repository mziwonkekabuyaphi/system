// lib/whatsapp/verify-signature.ts
/**
 * Checks that a webhook POST really came from Meta.
 *
 * Meta signs every webhook call: the X-Hub-Signature-256 header is
 * "sha256=" + HMAC-SHA256(app secret, the EXACT raw request bytes).
 * Anyone who knows your webhook URL could otherwise post fake customer
 * messages to it.
 *
 * Settings (environment variables):
 *   WHATSAPP_APP_SECRET      your Meta app's App Secret. May hold several
 *                            secrets separated by commas while you move from
 *                            one app to another; a signature that matches ANY
 *                            of them passes.
 *   WHATSAPP_SIGNATURE_MODE  "log" (default): a bad or missing signature is
 *                            only logged, the message is still processed.
 *                            "enforce": a bad or missing signature is rejected
 *                            with 401. Switch to this only after the logs show
 *                            every real Meta call passing.
 *
 * Deliberately NOT a "use server" file: internal code for the webhook route.
 * The secret never leaves the server and is never logged.
 */

import { createHmac, timingSafeEqual } from "crypto"

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: "no_secret_configured" | "missing_header" | "malformed_header" | "mismatch" }

export type SignatureMode = "log" | "enforce"

export function getSignatureMode(): SignatureMode {
  return process.env.WHATSAPP_SIGNATURE_MODE?.trim().toLowerCase() === "enforce" ? "enforce" : "log"
}

/** `rawBody` must be the exact bytes Meta sent (not re-serialised JSON). */
export function verifyMetaSignature(rawBody: Buffer, header: string | null): SignatureResult {
  const secrets = (process.env.WHATSAPP_APP_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (secrets.length === 0) return { ok: false, reason: "no_secret_configured" }
  if (!header) return { ok: false, reason: "missing_header" }

  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
  if (!match) return { ok: false, reason: "malformed_header" }
  const provided = Buffer.from(match[1], "hex")

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(rawBody).digest()
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { ok: true }
  }
  return { ok: false, reason: "mismatch" }
}
