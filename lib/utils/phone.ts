// lib/utils/phone.ts
/**
 * Canonical phone-number normalization, shared by every code path that
 * reads or writes a phone number against `tenant_customers` (and, via
 * send-message.ts, against the WhatsApp Cloud API).
 *
 * `tenant_customers` has a real UNIQUE (tenant_id, phone) constraint.
 * WhatsApp already hands us digits-only E.164 (e.g. "27821234567"). A
 * kiosk text input won't — "082 123 4567", "+27 82 123 4567", and
 * "0821234567" are all the same human. Without normalizing at the
 * boundary, the same customer becomes two separate rows depending on
 * which channel they used, and their booking/queue history silently
 * splits in two between WhatsApp and kiosk.
 *
 * This was previously a private function inside send-message.ts
 * (`normalizeWhatsAppNumber`). Pulled out here so tenant-customer.ts can
 * use the exact same rule for storage as send-message.ts uses for
 * sending — one definition, not two copies that could drift.
 *
 * SOUTH-AFRICA-SPECIFIC, same assumption the original send-message.ts
 * version made: a leading "0" is a local trunk prefix -> country code
 * 27. If this platform ever serves shops outside South Africa, this
 * needs a real libphonenumber-based implementation instead of a regex.
 */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "")

  if (digits.startsWith("27")) return digits
  if (digits.startsWith("0")) return `27${digits.slice(1)}`

  return digits
}

/**
 * Loose validity check for kiosk input specifically — not a full
 * phone-number validator, just enough to catch an obvious mistype (too
 * few digits, a landline-shaped number, someone typing their booking
 * reference into the phone field) before it becomes a junk
 * `tenant_customers` row. A normalized SA mobile number is 11 digits:
 * "27" + 9 digits.
 */
export function isPlausiblePhoneNumber(raw: string): boolean {
  const normalized = normalizePhoneNumber(raw)
  return normalized.length === 11 && normalized.startsWith("27")
}
