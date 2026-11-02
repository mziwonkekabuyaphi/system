// Unit tests for the pure billing calculation. Run: node test/staff-billing.test.mjs
import { build } from "esbuild"
import assert from "node:assert/strict"
await build({ entryPoints: ["lib/services/staff-billing.ts"], bundle: true, outfile: "/tmp/sb-test.mjs", format: "esm", platform: "node", external: ["@supabase/supabase-js"], logLevel: "error" })
const m = await import("/tmp/sb-test.mjs")
const { computeStaffInvoice, pickRates, isStaffOnly } = m
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok -", name) }

t("R30 x 8 staff = R240", () => {
  const r = computeStaffInvoice({ headcount: 8, ratesCents: { staff: 3000, payroll: 3000, shifts: 2000 }, chargeAddon: { payroll: false, shifts: false } })
  assert.equal(r.totalCents, 24000); assert.equal(r.lines.length, 1)
})
t("payroll + shifts add-ons: 8 x (30+30+20) = R640", () => {
  const r = computeStaffInvoice({ headcount: 8, ratesCents: { staff: 3000, payroll: 3000, shifts: 2000 }, chargeAddon: { payroll: true, shifts: true } })
  assert.equal(r.totalCents, 64000); assert.deepEqual(r.lines.map((l) => l.key), ["staff", "payroll", "shifts"])
})
t("add-on not charged when the plan already includes it", () => {
  const r = computeStaffInvoice({ headcount: 5, ratesCents: { staff: 3000, payroll: 3000, shifts: 2000 }, chargeAddon: { payroll: false, shifts: true } })
  assert.equal(r.totalCents, 5 * 3000 + 5 * 2000)
})
t("no Staff rate => null (never invoice at a guessed price)", () => {
  assert.equal(computeStaffInvoice({ headcount: 3, ratesCents: { payroll: 3000 }, chargeAddon: { payroll: true, shifts: false } }), null)
})
t("add-on without a rate is left off, not guessed", () => {
  const r = computeStaffInvoice({ headcount: 3, ratesCents: { staff: 3000 }, chargeAddon: { payroll: true, shifts: false } })
  assert.equal(r.totalCents, 9000); assert.equal(r.lines.length, 1)
})
t("zero headcount => R0", () => {
  assert.equal(computeStaffInvoice({ headcount: 0, ratesCents: { staff: 3000 }, chargeAddon: { payroll: false, shifts: false } }).totalCents, 0)
})
t("no fractional cents: R29.99 x 3", () => {
  const rows = [{ tenant_id: null, module_key: "staff", fee_per_staff: "29.99", currency: "ZAR" }]
  const { ratesCents } = pickRates(rows, "x")
  assert.equal(ratesCents.staff, 2999)
  assert.equal(computeStaffInvoice({ headcount: 3, ratesCents, chargeAddon: { payroll: false, shifts: false } }).totalCents, 8997)
})
t("shop-specific rate beats the platform default", () => {
  const rows = [
    { tenant_id: null, module_key: "staff", fee_per_staff: 30, currency: "ZAR" },
    { tenant_id: "shopA", module_key: "staff", fee_per_staff: 25, currency: "ZAR" },
    { tenant_id: null, module_key: "payroll", fee_per_staff: 30, currency: "ZAR" },
  ]
  const a = pickRates(rows, "shopA"), b = pickRates(rows, "shopB")
  assert.equal(a.ratesCents.staff, 2500); assert.equal(b.ratesCents.staff, 3000); assert.equal(a.ratesCents.payroll, 3000)
})
t("who is billed: Staff-only yes; any other product => included, no charge", () => {
  const s = (o) => ({ staff: true, booking: false, queue: false, shisha: false, payroll: false, shifts: false, ...o })
  assert.equal(isStaffOnly(s({})), true)
  assert.equal(isStaffOnly(s({ booking: true })), false)
  assert.equal(isStaffOnly(s({ queue: true })), false)
  assert.equal(isStaffOnly(s({ shisha: true })), false)
  assert.equal(isStaffOnly(s({ staff: false })), false)
  assert.equal(isStaffOnly(undefined), false)
  assert.equal(isStaffOnly(s({ payroll: true, shifts: true })), true) // add-ons alone don't make it "another product"
})
console.log(`\n${n} passed`)
