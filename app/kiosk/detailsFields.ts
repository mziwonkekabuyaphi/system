// lib/kiosk/detailsFields.ts
//
// Which fields the kiosk's details screen (the last screen before "Confirm") asks for.
// Shared by the kiosk (components/kiosk/KioskApp.tsx) and the admin panel
// (app/admin/settings/KioskPanels.tsx) so both agree on the shape, the defaults and
// what counts as "complete". The defaults match the old fixed screen (name + cellphone),
// so shops that never touch this setting see no change.

export type KioskDetailsFields = {
  showName: boolean
  showSurname: boolean
  showPhone: boolean
  showEmail: boolean
  emailRequired: boolean
  showCustom: boolean
  /** The question for the custom field, e.g. "Car registration". */
  customLabel: string
  customRequired: boolean
}

export const DEFAULT_DETAILS_FIELDS: KioskDetailsFields = {
  showName: true,
  showSurname: false,
  showPhone: true,
  showEmail: false,
  emailRequired: false,
  showCustom: false,
  customLabel: "",
  customRequired: false,
}

export const MIN_PHONE_DIGITS = 10

/** Fill any missing or null setting from the defaults (older rows won't have these). */
export function detailsFieldsFrom(src: Partial<Record<keyof KioskDetailsFields, unknown>> | null | undefined): KioskDetailsFields {
  const d = DEFAULT_DETAILS_FIELDS
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)
  return {
    showName: bool(src?.showName, d.showName),
    showSurname: bool(src?.showSurname, d.showSurname),
    showPhone: bool(src?.showPhone, d.showPhone),
    showEmail: bool(src?.showEmail, d.showEmail),
    emailRequired: bool(src?.emailRequired, d.emailRequired),
    showCustom: bool(src?.showCustom, d.showCustom),
    customLabel: typeof src?.customLabel === "string" ? src.customLabel : d.customLabel,
    customRequired: bool(src?.customRequired, d.customRequired),
  }
}

export const phoneDigitCount = (value: string) => value.replace(/\D/g, "").length

export const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())

/** Why these settings can't be saved, or null when they're fine. */
export function detailsFieldsProblem(f: KioskDetailsFields): string | null {
  if (!f.showName && !f.showPhone) return "Turn on Name or Cellphone number, so you know who is checking in."
  if (f.showSurname && !f.showName) return "Turn on Name as well if you want to ask for a surname."
  if (f.showCustom && !f.customLabel.trim()) return "Type the question for your custom field, or turn it off."
  return null
}

export type KioskDetailsValues = { name: string; surname: string; phone: string; email: string; custom: string }

/** True when every field that is switched on has been filled in properly. */
export function detailsComplete(f: KioskDetailsFields, v: KioskDetailsValues): boolean {
  if (f.showName && v.name.trim().length < 2) return false
  if (f.showSurname && v.surname.trim().length < 2) return false
  if (f.showPhone && phoneDigitCount(v.phone) < MIN_PHONE_DIGITS) return false
  if (f.showEmail) {
    const email = v.email.trim()
    if (email ? !isValidEmail(email) : f.emailRequired) return false
  }
  if (f.showCustom && f.customRequired && !v.custom.trim()) return false
  return true
}
