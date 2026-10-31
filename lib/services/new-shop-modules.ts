// lib/services/new-shop-modules.ts
//
// Which modules a brand-new shop starts with. Plain constants and types only (no
// server imports), so the platform "Create a shop" form (a client component) can
// use the same list the server validates against. The write itself is
// enableModulesForNewShop() in ./tenant-modules.ts.
//
// A missing tenant_modules row means OFF (see isProductEnabled in plans.ts), so a
// shop created with no rows sees an empty dashboard and WhatsApp has nothing to
// offer. Every place that creates a shop passes an explicit list.
//
// Self-signup does NOT switch anything on: the shop starts "pending", the owner says
// what they need (SIGNUP_CHOICES), and a platform admin approves the shop and picks
// the modules on /platform/tenants. Requesting a module never turns it on.

import type { AddonKey, ProductKey } from "@/lib/services/plans"

export type NewShopModule = ProductKey | AddonKey

/** Everything a platform admin may tick when creating a shop. */
export const CREATABLE_MODULES: Array<{ key: NewShopModule; label: string; defaultOn: boolean }> = [
  { key: "booking", label: "Booking", defaultOn: true },
  { key: "queue", label: "Queue", defaultOn: true },
  { key: "shisha", label: "Shisha", defaultOn: false },
  { key: "shifts", label: "Shifts", defaultOn: false },
  { key: "payroll", label: "Payroll", defaultOn: false },
]

const CREATABLE_KEYS = new Set<string>(CREATABLE_MODULES.map((m) => m.key))

/** Drops anything that isn't a creatable module, and repeats. */
export function cleanModuleKeys(keys: unknown): NewShopModule[] {
  if (!Array.isArray(keys)) return []
  return [...new Set(keys.filter((k): k is NewShopModule => typeof k === "string" && CREATABLE_KEYS.has(k)))]
}

/** What a self-signup owner says they need. Stored as tenants.requested_modules. */
export type SignupChoice = "booking_queue" | "shisha" | "all"

export const SIGNUP_CHOICES: Array<{ value: SignupChoice; label: string; modules: NewShopModule[] }> = [
  { value: "booking_queue", label: "Bookings and a queue", modules: ["booking", "queue"] },
  { value: "shisha", label: "Shisha lounge", modules: ["shisha"] },
  { value: "all", label: "All of them", modules: ["booking", "queue", "shisha"] },
]

/** The modules an owner asked for; anything unrecognised means Booking + Queue. */
export function modulesForChoice(choice: unknown): NewShopModule[] {
  return (SIGNUP_CHOICES.find((c) => c.value === choice) ?? SIGNUP_CHOICES[0]).modules
}
