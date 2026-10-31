// app/admin/shifts/StaffShiftsDrawer.tsx
//
// "Shifts" overlay opened from the Staff tab, next to Payroll and Clock-in
// settings. Same AdminDrawer shell as StaffPayrollDrawer. Children unmount on
// close, so the rota reloads fresh every time it opens.
"use client"

import { AdminDrawer } from "@/components/admin/AdminDrawer"

import { ShiftsManager } from "./ShiftsManager"

export function StaffShiftsDrawer({
  open,
  onClose,
  timezone,
}: {
  open: boolean
  onClose: () => void
  timezone: string
}) {
  return (
    <AdminDrawer open={open} onClose={onClose} title="Shifts" subtitle="Rota, swaps and attendance" width="xl">
      <ShiftsManager timezone={timezone} embedded />
    </AdminDrawer>
  )
}
