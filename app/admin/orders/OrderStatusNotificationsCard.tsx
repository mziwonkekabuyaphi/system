"use client"

// Standalone card for the customer WhatsApp update switches.
// OrderSettingsPanel.tsx already has this built in with your SettingsCard/ToggleRow, so this file is optional.
// Styling is plain Tailwind: swap the markup for your own Switch component if you prefer.

import { STATUS_NOTIFY_KEYS, STATUS_NOTIFY_LABELS, type StatusNotifications } from "@/lib/services/orders/orders.status-notify"

export function OrderStatusNotificationsCard({
  value,
  onChange,
  disabled,
}: {
  value: StatusNotifications
  onChange: (next: StatusNotifications) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Customer WhatsApp updates</h3>
        <p className="text-xs text-muted-foreground">Choose which updates customers get when staff move their order along.</p>
      </div>
      <ul className="divide-y rounded-md border">
        {STATUS_NOTIFY_KEYS.map((key) => (
          <li key={key} className="flex items-center justify-between gap-4 p-3">
            <div>
              <div className="text-sm">{STATUS_NOTIFY_LABELS[key].title}</div>
              <div className="text-xs text-muted-foreground">{STATUS_NOTIFY_LABELS[key].hint}</div>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-label={STATUS_NOTIFY_LABELS[key].title}
              className="h-4 w-4"
              checked={value[key]}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
