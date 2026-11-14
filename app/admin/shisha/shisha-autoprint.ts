// app/admin/shisha/shisha-autoprint.ts
//
// "Print a slip when a customer requests a session" is a per-PC choice, so it lives in this
// browser's localStorage (not on the server). The switch is in Settings > Shisha settings;
// the printing itself is done by the Shisha page (ShishaManager), which has to be open on
// the PC that has the receipt printer.

export const AUTOPRINT_REQUESTS_KEY = "shishaAutoPrintRequests"
/** When auto-print was switched on. Requests created before this are never printed. */
export const AUTOPRINT_ENABLED_AT_KEY = "shishaAutoPrintEnabledAt"

export function readAutoPrintRequests(): boolean {
  try {
    return localStorage.getItem(AUTOPRINT_REQUESTS_KEY) === "true"
  } catch {
    return false
  }
}

export function readAutoPrintEnabledAt(): number {
  try {
    const n = Number(localStorage.getItem(AUTOPRINT_ENABLED_AT_KEY))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function writeAutoPrintRequests(on: boolean): void {
  try {
    localStorage.setItem(AUTOPRINT_REQUESTS_KEY, String(on))
    // Requests already waiting are not printed retroactively.
    if (on) localStorage.setItem(AUTOPRINT_ENABLED_AT_KEY, String(Date.now()))
  } catch {
    /* storage blocked: nothing to do */
  }
}
