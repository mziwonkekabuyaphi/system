// app/admin/voice-notes/retention.ts — the retention periods a shop can choose. Kept out of actions.ts because a
// "use server" file may only export async functions. The database allows 1-365; these are the sensible steps.
export const RETENTION_OPTIONS = [7, 14, 30, 60, 90, 180, 365] as const
export const DEFAULT_RETENTION_DAYS = 30

export function isRetentionDays(value: unknown): value is number {
  return typeof value === "number" && (RETENTION_OPTIONS as readonly number[]).includes(value)
}
