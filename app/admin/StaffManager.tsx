// app/admin/StaffManager.tsx
"use client"

import { useState, useTransition, type FormEvent } from "react"
import { addStaff, toggleStaffActive } from "./actions"
import type { AdminStaff } from "./types"

export function StaffManager({ initialStaff: staff }: { initialStaff: AdminStaff[] }) {
  const [name, setName] = useState("")
  const [isAdding, startAdd] = useTransition()
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [isToggling, startToggle] = useTransition()

  function submit(e: FormEvent) {
    e.preventDefault()
    startAdd(async () => {
      const result = await addStaff(name)
      if (result.ok) setName("")
      else window.alert(`Couldn't add that staff member: ${result.error}`)
    })
  }

  function toggle(member: AdminStaff) {
    setTogglingId(member.id)
    startToggle(async () => {
      const result = await toggleStaffActive(member.id, !member.active)
      if (!result.ok) window.alert(`Couldn't update: ${result.error}`)
      setTogglingId(null)
    })
  }

  return (
    <div>
      {staff.length === 0 ? (
        <p className="text-[#8A8375]">No staff yet — add your first one below.</p>
      ) : (
        <ul className="divide-y divide-[#E6E1D4]">
          {staff.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-4 py-4">
              <p className={`text-[1.05rem] ${member.active ? "text-[#1C1A17]" : "text-[#8A8375]"}`}>
                {member.name}
              </p>
              <button
                onClick={() => toggle(member)}
                disabled={isToggling && togglingId === member.id}
                className="text-sm text-[#8A8375] disabled:opacity-50"
              >
                {member.active ? "Deactivate" : "Activate"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-8 flex items-end gap-3 border-t border-[#E6E1D4] pt-6">
        <div className="flex-1">
          <label className="block text-sm text-[#8A8375]">Staff name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Thabo"
            className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>
        <button
          type="submit"
          disabled={isAdding}
          className="bg-[#1C1A17] px-4 py-2 text-sm text-[#FAF6EE] disabled:opacity-50"
        >
          {isAdding ? "Adding…" : "Add staff"}
        </button>
      </form>
    </div>
  )
}
