/**
 * Shared result type for server actions and service functions.
 *
 * Pattern: every action returns either `{ ok: true, data? }` on success
 * or `{ ok: false, error: string }` on failure. Callers narrow on `.ok`
 * before touching `.data` or `.error`, so the failure branch can't be
 * accidentally read.
 */

export type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string }

/** Convenience aliases used across the codebase. */
export type ActionSuccess<T = void> = { ok: true; data?: T }
export type ActionFailure = { ok: false; error: string }

/** Helper: build a success result. */
export function ok<T = void>(data?: T): ActionResult<T> {
  return { ok: true, data }
}

/** Helper: build a failure result. */
export function fail(error: string): ActionResult<never> {
  return { ok: false, error }
}
