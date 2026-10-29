// app/admin/staff/StaffClockInDrawer.tsx
//
// Staff clock-in settings (link, colours, wording) as a right-hand overlay on
// the Staff tab. Hosts the existing ClockPanel, which keeps its own save
// button, so this drawer has no Save/Discard footer of its own.
"use client"

import { AdminDrawer } from "@/components/admin/AdminDrawer"
import { ClockPanel } from "../settings/ClockPanels"
import type { AdminClockSettings } from "../types"

export function StaffClockInDrawer({
  open,
  onClose,
  tenantSlug,
  initial,
  canCustomizeBranding,
}: {
  open: boolean
  onClose: () => void
  tenantSlug: string
  initial: AdminClockSettings
  canCustomizeBranding: boolean
}) {
  return (
    <AdminDrawer
      open={open}
      onClose={onClose}
      title="Clock-in settings"
      subtitle="The PIN pad your team uses to clock in and out: link, colours and wording."
    >
      <ClockPanel tenantSlug={tenantSlug} initial={initial} canCustomizeBranding={canCustomizeBranding} />
    </AdminDrawer>
  )
}
