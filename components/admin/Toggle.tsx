"use client"

export function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-admin-focus focus-visible:ring-offset-2 focus-visible:ring-offset-admin-body disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? "bg-admin-accent ring-admin-accent-dim hover:enabled:bg-admin-accent-dim"
          : "bg-admin-text-muted ring-admin-border hover:enabled:bg-admin-text"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full shadow-sm ring-1 transition-transform ${
          checked
            ? "translate-x-6 bg-admin-on-accent ring-admin-accent-dim/40"
            : "translate-x-1 bg-white ring-admin-border"
        }`}
      />
    </button>
  )
}
