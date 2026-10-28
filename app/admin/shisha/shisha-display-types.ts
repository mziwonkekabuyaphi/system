// app/admin/shisha/shisha-display-types.ts
//
// Types, defaults and pure helpers for the Shisha TV display settings. Shared
// by the admin drawer, the admin server actions and the public display loader.
// No "use server" and no server-only imports, so client components can use it.

export type ShishaDisplayTheme = "dark" | "light" | "custom"
export type ShishaDisplaySort = "code" | "urgency"
/** "board" = grid of device cards; "lounge" = featured device + burn-down list. */
export type ShishaDisplayLayout = "board" | "lounge"

/** Every piece of wording on the TV. null = use `fallback`. */
export const SHISHA_DISPLAY_LABELS = [
  { key: "active", column: "label_active", title: "Session running", fallback: "In session", hint: "Status of a device with time left." },
  { key: "refill", column: "label_refill", title: "Refill due", fallback: "Refill due", hint: "Shown when the refill warning time is reached." },
  { key: "expired", column: "label_expired", title: "Time is up", fallback: "Overdue", hint: "Shown once the session has run out." },
  { key: "paused", column: "label_paused", title: "Paused", fallback: "On hold", hint: "A session that is paused." },
  { key: "available", column: "label_available", title: "Free device", fallback: "Available", hint: "A device with no session." },
  { key: "maintenance", column: "label_maintenance", title: "Under maintenance", fallback: "Out of service", hint: "A device set to maintenance." },
  { key: "live", column: "label_live", title: "Connected pill", fallback: "Live", hint: "Header pill while the screen is connected." },
  { key: "offline", column: "label_offline", title: "Offline pill", fallback: "Reconnecting…", hint: "Header pill when the connection drops." },
  { key: "timeUp", column: "label_time_up", title: "Time-up alert heading", fallback: "Time's up", hint: "Heading on the full-screen alert." },
  { key: "soonest", column: "label_soonest", title: "Lounge layout: featured heading", fallback: "Finishing soonest", hint: "Heading above the big device in the Lounge layout." },
  { key: "empty", column: "label_empty", title: "No devices message", fallback: "No devices set up yet.", hint: "Shown when you haven't added any devices." },
] as const

export type ShishaDisplayLabelKey = (typeof SHISHA_DISPLAY_LABELS)[number]["key"]

export const SHISHA_DISPLAY_LABEL_DEFAULTS = Object.fromEntries(
  SHISHA_DISPLAY_LABELS.map((l) => [l.key, l.fallback]),
) as Record<ShishaDisplayLabelKey, string>

export const DISPLAY_TITLE_DEFAULT = "Shisha status"
export const DISPLAY_TICKER_DEFAULT = "Ask our staff to start your session"

export const DISPLAY_TITLE_MAX = 60
export const DISPLAY_TICKER_MAX = 140
export const DISPLAY_LABEL_MAX = 24

export interface ShishaDisplaySettings {
  /** Owner's on/off switch for the TV address. */
  isEnabled: boolean
  layout: ShishaDisplayLayout
  theme: ShishaDisplayTheme
  /** #RRGGBB. Only used when theme === "custom". */
  backgroundColor: string | null
  /** Line under the business name. null = DISPLAY_TITLE_DEFAULT. */
  title: string | null
  sort: ShishaDisplaySort
  showStats: boolean
  showFlavour: boolean
  showStation: boolean
  /** First name only, and only for sessions linked to a customer. Off: it's a public screen. */
  showCustomerName: boolean
  showFreeDevices: boolean
  showClock: boolean
  showTicker: boolean
  /** Flavours + prices scrolling in the ticker. */
  showMenu: boolean
  /** null = DISPLAY_TICKER_DEFAULT. */
  tickerText: string | null
  timeUpAlertEnabled: boolean
  /** 3-60 */
  timeUpAlertSeconds: number
  labels: Record<ShishaDisplayLabelKey, string | null>
}

export const DEFAULT_SHISHA_DISPLAY_SETTINGS: ShishaDisplaySettings = {
  isEnabled: true,
  layout: "board",
  theme: "dark",
  backgroundColor: null,
  title: null,
  sort: "code",
  showStats: true,
  showFlavour: true,
  showStation: true,
  showCustomerName: false,
  showFreeDevices: true,
  showClock: true,
  showTicker: true,
  showMenu: true,
  tickerText: null,
  timeUpAlertEnabled: false,
  timeUpAlertSeconds: 8,
  labels: Object.fromEntries(SHISHA_DISPLAY_LABELS.map((l) => [l.key, null])) as Record<ShishaDisplayLabelKey, null>,
}

/** Columns read from shisha_display_settings (one place, so reader and writer agree). */
export const SHISHA_DISPLAY_SELECT = [
  "is_enabled",
  "layout",
  "theme",
  "background_color",
  "title",
  "sort_mode",
  "show_stats",
  "show_flavour",
  "show_station",
  "show_customer_name",
  "show_free_devices",
  "show_clock",
  "show_ticker",
  "show_menu",
  "ticker_text",
  "time_up_alert_enabled",
  "time_up_alert_seconds",
  ...SHISHA_DISPLAY_LABELS.map((l) => l.column),
].join(", ")

const HEX6 = /^#[0-9a-f]{6}$/i
export const isHex6 = (v: unknown): v is string => typeof v === "string" && HEX6.test(v)

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback)

/** DB row -> settings. A missing row or a bad value falls back to the default. */
export function rowToShishaDisplaySettings(row: Record<string, unknown> | null | undefined): ShishaDisplaySettings {
  const d = DEFAULT_SHISHA_DISPLAY_SETTINGS
  const labels = { ...d.labels }
  if (!row) return { ...d, labels }
  for (const l of SHISHA_DISPLAY_LABELS) labels[l.key] = text(row[l.column])
  const seconds = Number(row.time_up_alert_seconds)
  return {
    isEnabled: flag(row.is_enabled, d.isEnabled),
    layout: row.layout === "lounge" ? "lounge" : "board",
    theme: row.theme === "light" || row.theme === "custom" ? row.theme : "dark",
    backgroundColor: isHex6(row.background_color) ? row.background_color.toUpperCase() : null,
    title: text(row.title),
    sort: row.sort_mode === "urgency" ? "urgency" : "code",
    showStats: flag(row.show_stats, d.showStats),
    showFlavour: flag(row.show_flavour, d.showFlavour),
    showStation: flag(row.show_station, d.showStation),
    showCustomerName: flag(row.show_customer_name, d.showCustomerName),
    showFreeDevices: flag(row.show_free_devices, d.showFreeDevices),
    showClock: flag(row.show_clock, d.showClock),
    showTicker: flag(row.show_ticker, d.showTicker),
    showMenu: flag(row.show_menu, d.showMenu),
    tickerText: text(row.ticker_text),
    timeUpAlertEnabled: flag(row.time_up_alert_enabled, d.timeUpAlertEnabled),
    timeUpAlertSeconds: Number.isInteger(seconds) && seconds >= 3 && seconds <= 60 ? seconds : d.timeUpAlertSeconds,
    labels,
  }
}

/** Settings -> DB columns (without tenant_id). */
export function shishaDisplaySettingsToRow(s: ShishaDisplaySettings): Record<string, unknown> {
  const row: Record<string, unknown> = {
    is_enabled: s.isEnabled,
    layout: s.layout,
    theme: s.theme,
    background_color: s.backgroundColor,
    title: s.title,
    sort_mode: s.sort,
    show_stats: s.showStats,
    show_flavour: s.showFlavour,
    show_station: s.showStation,
    show_customer_name: s.showCustomerName,
    show_free_devices: s.showFreeDevices,
    show_clock: s.showClock,
    show_ticker: s.showTicker,
    show_menu: s.showMenu,
    ticker_text: s.tickerText,
    time_up_alert_enabled: s.timeUpAlertEnabled,
    time_up_alert_seconds: s.timeUpAlertSeconds,
  }
  for (const l of SHISHA_DISPLAY_LABELS) row[l.column] = s.labels[l.key]
  return row
}

/** Trims text, turns empty strings into null, collapses spaces. The drawer keeps
 *  empty strings while typing; this is what gets compared and saved. */
export function normalizeShishaDisplaySettings(s: ShishaDisplaySettings): ShishaDisplaySettings {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim().replace(/\s+/g, " ")
    return t ? t : null
  }
  const labels = { ...s.labels }
  for (const l of SHISHA_DISPLAY_LABELS) labels[l.key] = clean(s.labels[l.key])
  return {
    ...s,
    backgroundColor: isHex6(s.backgroundColor) ? s.backgroundColor.toUpperCase() : null,
    title: clean(s.title),
    tickerText: clean(s.tickerText),
    labels,
  }
}
