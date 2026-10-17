import { test } from "node:test"
import assert from "node:assert/strict"
import { matchStaffRequest, pickStaffForSlot, type StaffCandidate } from "./staff-request"

const team: StaffCandidate[] = [
  { id: "1", name: "Sipho Mokoena", active: true },
  { id: "2", name: "Thandi", active: true },
  { id: "3", name: "Pieter van Wyk", active: true },
  { id: "4", name: "Lerato", active: false },
  { id: "5", name: "Zanele", active: true },
  { id: "6", name: "Zanele Dlamini", active: true },
]

test("matches a first name in English, Zulu, Afrikaans and Xhosa phrasing", () => {
  for (const text of ["Book with Sipho", "ndifuna ukubhukisha no-Sipho", "ek wil by Sipho bespreek", "book SIPHO tomorrow 3pm", "ngicela ukubhukha noSipho"]) {
    const result = matchStaffRequest(text, team)
    assert.deepEqual(result.kind === "match" && result.staff.id, "1", text)
  }
})
test("matches isiZulu/isiXhosa attached prefixes, but not unrelated words", () => {
  for (const text of ["ngicela ukubhukha kuSipho", "ndifuna ukubhukisha naThandi", "ngifuna ukubhukha nga Thandi"]) {
    assert.equal(matchStaffRequest(text, team).kind, "match", text)
  }
  assert.equal(matchStaffRequest("ngicela ukubhukha nothandiwe", team).kind, "none")
})
test("is accent/case insensitive and whole-word only", () => {
  assert.equal(matchStaffRequest("book with THÁNDI", team).kind, "match")
  assert.equal(matchStaffRequest("thandiwe is my friend", team).kind, "none")
  assert.equal(matchStaffRequest("book a haircut", team).kind, "none")
})
test("full name is preferred; shared first name is ambiguous, never guessed", () => {
  const full = matchStaffRequest("book with Zanele Dlamini", team)
  assert.equal(full.kind === "match" && full.staff.id, "6")
  const exact = matchStaffRequest("book with Zanele", team)
  assert.equal(exact.kind === "match" && exact.staff.id, "5") // exact full name "Zanele"
  const dup: StaffCandidate[] = [
    { id: "a", name: "Sam Smith", active: true },
    { id: "b", name: "Sam Jones", active: true },
  ]
  const amb = matchStaffRequest("book with Sam", dup)
  assert.equal(amb.kind, "ambiguous")
})
test("inactive staff are reported as inactive, not skipped to someone else", () => {
  const r = matchStaffRequest("book with Lerato", team)
  assert.equal(r.kind, "inactive")
})
test("an active match wins over an inactive namesake", () => {
  const t: StaffCandidate[] = [
    { id: "a", name: "Sipho", active: false },
    { id: "b", name: "Sipho M", active: true },
  ]
  const r = matchStaffRequest("book with sipho", t)
  assert.equal(r.kind === "match" && r.staff.id, "b")
})
test("pickStaffForSlot: required staff is never substituted", () => {
  const staff = [{ id: "1" }, { id: "2" }]
  const free = new Set(["2"])
  const isFree = (m: { id: string }) => free.has(m.id)
  assert.deepEqual(pickStaffForSlot({ staff, isFree, requireStaffId: "1" }), { ok: false, reason: "requested_unavailable" })
  assert.deepEqual(pickStaffForSlot({ staff, isFree, requireStaffId: "99" }), { ok: false, reason: "requested_unavailable" }) // not in tenant's active list
  assert.deepEqual(pickStaffForSlot({ staff, isFree, requireStaffId: "2" }), { ok: true, staff: { id: "2" } })
})
test("pickStaffForSlot: automatic and reschedule-prefer behaviour unchanged", () => {
  const staff = [{ id: "1" }, { id: "2" }, { id: "3" }]
  const isFree = (m: { id: string }) => m.id !== "1"
  assert.deepEqual(pickStaffForSlot({ staff, isFree }), { ok: true, staff: { id: "2" } })
  assert.deepEqual(pickStaffForSlot({ staff, isFree, preferStaffId: "3" }), { ok: true, staff: { id: "3" } })
  assert.deepEqual(pickStaffForSlot({ staff, isFree, preferStaffId: "1" }), { ok: true, staff: { id: "2" } })
  assert.deepEqual(pickStaffForSlot({ staff, isFree: () => false }), { ok: false, reason: "none_free" })
  // require wins over prefer
  assert.deepEqual(pickStaffForSlot({ staff, isFree, preferStaffId: "3", requireStaffId: "1" }), { ok: false, reason: "requested_unavailable" })
})
