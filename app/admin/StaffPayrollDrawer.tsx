// app/admin/StaffPayrollDrawer.tsx
//
// Payroll as a right-hand overlay on the Staff tab (same pattern as Shisha's
// TV display). It simply hosts the existing PayrollManager, which loads its own
// data when the drawer opens. Permission gating stays where it was: the
// caller only renders this with payroll.view, and every action re-checks it.
"use client"

import { AdminDrawer } from "./AdminDrawer"
import { PayrollManager } from "./PayrollManager"
import type { AdminStaffPermissions } from "./types"

export function StaffPayrollDrawer({
  open,
  onClose,
  timezone,
  permissions,
}: {
  open: boolean
  onClose: () => void
  timezone: string
  permissions: AdminStaffPermissions
}) {
  return (
    <AdminDrawer
      open={open}
      onClose={onClose}
      width="xl"
      title="Payroll"
      subtitle="Calculate pay for a period, mark it paid and download payslips."
    >
      <PayrollManager timezone={timezone} permissions={permissions} />
    </AdminDrawer>
  )
}
