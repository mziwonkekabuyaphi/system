import { getSupabaseServerClient } from "@/lib/supabase/server"

/**
 * Free-form payload attached to a conversation state.
 * Kept as a named type (instead of inlining Record<string, unknown>)
 * so call sites get a stable, self-documenting type to import.
 */
export type ConversationData = Record<string, unknown>

// ✅ KEEP THIS ONE - Object version with state field
export type ConversationState = {
  readonly state: string
  readonly data?: ConversationData
  readonly updatedAt?: string
}

// ❌ DELETE THIS ENTIRE BLOCK - The string union version:
/*
export type ConversationState = 
  | "idle"
  | "selecting_service"
  | "entering_amount"
  | "confirming_payment"
  | "payment_processing"
  | "payment_complete"
  | "payment_failed"
*/

// ✅ Add ServiceType here
export type ServiceType =
  | "wallet"
  | "ticket"
  | "order"
  | "vvip"
  

export interface ActionResult {
  reply: string
  buttons: string[]
  nextState: ConversationState | null
}

/**
 * Internal cache record. We store an explicit expiry timestamp rather than
 * relying on insertion order, since Map does not evict on its own and we
 * need O(1) expiry checks without scanning on every read.
 */
type CacheEntry = {
  readonly state: ConversationState
  readonly expiresAt: number
}

// ---------------------------------------------------------------------------
// Why this cache exists
// ---------------------------------------------------------------------------
// Vercel serverless functions reuse "warm" instances between invocations.
// When an instance is warm, this in-memory Map lets us skip a network round
// trip to Supabase for state we already fetched recently. This is a pure
// performance optimization:
//   - It is NOT guaranteed to be present (cold starts, new instances,
//     multiple concurrent instances, and deploys all reset it to empty).
//   - It is NEVER treated as the source of truth.
// Supabase remains authoritative so that:
//   - Conversation state survives server restarts / cold starts / redeploys.
//   - State is consistent across concurrent serverless instances.
// The code below must behave correctly even if the cache is empty on every
// single call (i.e. as if this were a no-op cache), since that's exactly
// what happens on a cold start.
const stateStore = new Map<string, CacheEntry>()

/** How long a cached entry is considered fresh before we re-check Supabase. */
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Upper bound on how many stale cache entries we tolerate before forcing a
 * cleanup pass. This exists purely so a single long-lived warm instance
 * (handling many distinct users over hours/days) can't let the Map grow
 * without bound - expired entries are otherwise only removed lazily, on
 * their own next read.
 */
const MAX_CACHE_ENTRIES_BEFORE_SWEEP = 500

// ---------------------------------------------------------------------------
// Per-user write serialization
// ---------------------------------------------------------------------------
// If two updates for the same user race (e.g. two webhook deliveries firing
// close together), we want the *last-issued* write to win, and we want each
// write to be based on the freshest possible read - not on a read that
// started before a previous write finished. We do this by chaining all
// mutating operations for a given userId onto a single promise queue, so
// they execute strictly in call order instead of resolution order.
const writeQueues = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(userId) ?? Promise.resolve()
  // Swallow the previous task's own rejection here so one failed write
  // doesn't permanently jam the queue for that user; the failure itself
  // was already logged where it happened.
  const next = previous.catch(() => undefined).then(task)
  writeQueues.set(
    userId,
    next.catch(() => undefined),
  )
  return next
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const LOG_PREFIX = "[state]"

function logInfo(message: string, context?: Record<string, unknown>): void {
  console.log(`${LOG_PREFIX} ${message}`, context ?? "")
}

function logError(message: string, error: unknown, context?: Record<string, unknown>): void {
  console.error(`${LOG_PREFIX} ${message}`, { error, ...context })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function assertValidUserId(userId: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("[state] Invalid userId: expected a non-empty string")
  }
}

function assertValidConversationState(state: ConversationState | undefined): asserts state is ConversationState {
  if (state === undefined || state === null) {
    throw new Error("[state] Invalid state: state object must be defined")
  }
  if (typeof state.state !== "string" || state.state.trim().length === 0) {
    throw new Error("[state] Invalid state: 'state' field must be a non-empty string")
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function readFromCache(userId: string): ConversationState | null {
  const entry = stateStore.get(userId)
  if (!entry) return null

  if (Date.now() >= entry.expiresAt) {
    // Lazily evict expired entries as soon as we notice them.
    stateStore.delete(userId)
    return null
  }

  return entry.state
}

function writeToCache(userId: string, state: ConversationState): void {
  try {
    stateStore.set(userId, {
      state,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    if (stateStore.size > MAX_CACHE_ENTRIES_BEFORE_SWEEP) {
      sweepExpiredCacheEntries()
    }
  } catch (error) {
    // Memory cache is a convenience layer only. If, for any reason, writing
    // to it fails, that must never prevent database persistence from
    // happening - the caller continues on to Supabase regardless.
    logError("Failed to write to memory cache (continuing without cache)", error, { userId })
  }
}

/** Removes all expired entries. Bounds memory usage on long-lived warm instances. */
function sweepExpiredCacheEntries(): void {
  const now = Date.now()
  let removed = 0
  for (const [userId, entry] of stateStore) {
    if (now >= entry.expiresAt) {
      stateStore.delete(userId)
      removed++
    }
  }
  if (removed > 0) {
    logInfo("Swept expired cache entries", { removed, remaining: stateStore.size })
  }
}

// Periodically sweep expired entries so idle warm instances don't hold onto
// stale data indefinitely between reads. Guarded so repeated module
// evaluation (hot reload / multiple imports) never stacks up intervals, and
// `unref()`'d so it can't keep a serverless process alive on its own.
const globalForCleanup = globalThis as typeof globalThis & {
  __stateServiceCleanupTimer?: ReturnType<typeof setInterval>
}

if (!globalForCleanup.__stateServiceCleanupTimer) {
  const timer = setInterval(sweepExpiredCacheEntries, CACHE_TTL_MS)
  timer.unref?.()
  globalForCleanup.__stateServiceCleanupTimer = timer
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------
function mapRowToState(row: {
  state: string
  data: ConversationData | null
  updated_at: string
}): ConversationState {
  return {
    state: row.state,
    data: row.data ?? {},
    updatedAt: row.updated_at,
  }
}

async function loadFromDatabase(userId: string): Promise<ConversationState | null> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping database load", { userId })
    return null
  }

  try {
    const { data, error } = await supabase
      .from("conversation_states")
      .select("*")
      .eq("phone", userId)
      .single()

    if (error) {
      // PGRST116 = no rows found for .single() - this is an expected "no
      // state yet" case, not a failure, so we don't log it as an error.
      if (error.code !== "PGRST116") {
        logError("Database error while loading state", error, { userId })
      }
      return null
    }

    if (!data) return null

    logInfo("Loaded from database", { userId })
    return mapRowToState(data)
  } catch (error) {
    // Database is not reachable, malformed response, etc. This must never
    // crash the caller (e.g. a webhook handler) - degrade to "no state".
    logError("Unexpected error while loading state from database", error, { userId })
    return null
  }
}

async function persistToDatabase(userId: string, state: ConversationState): Promise<void> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping database persist", { userId })
    return
  }

  try {
    const { error } = await supabase
      .from("conversation_states")
      .upsert(
        {
          phone: userId,
          state: state.state,
          data: state.data ?? {},
          updated_at: state.updatedAt ?? new Date().toISOString(),
        },
        {
          onConflict: "phone",
        }
      )

    if (error) {
      logError("Database error while saving state", error, { userId })
      return
    }

    logInfo("Saved to database", { userId })
  } catch (error) {
    // Database failures must never crash the caller. The memory cache has
    // already been updated by this point, so the current instance stays
    // consistent even though persistence failed; we just make sure the
    // failure is visible in logs instead of being swallowed silently.
    logError("Unexpected error while saving state to database", error, { userId })
  }
}

async function deleteFromDatabase(userId: string): Promise<void> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping database delete", { userId })
    return
  }

  try {
    const { error } = await supabase
      .from("conversation_states")
      .delete()
      .eq("phone", userId)

    if (error) {
      logError("Database error while clearing state", error, { userId })
      return
    }

    logInfo("Cleared", { userId })
  } catch (error) {
    logError("Unexpected error while clearing state from database", error, { userId })
  }
}

/**
 * Finds every conversation whose state hasn't been touched in over
 * `olderThanMs`. Used exclusively by the inactivity-sweep cron
 * (see app/api/cron/inactivity-sweep) to find candidates for the
 * "you've gone quiet" nudge + auto-close.
 *
 * Deliberately bypasses the in-memory cache and goes straight to Supabase:
 * this only ever runs from a cron invocation (a cold, one-off request), so
 * there's no warm-instance cache to benefit from, and correctness here
 * matters more than shaving one round trip.
 *
 * Returns `[]` (never throws) if Supabase is unreachable or misconfigured,
 * consistent with every other read in this file — a failed sweep should
 * skip this run quietly and try again next tick, not crash the cron route.
 */
async function findStaleConversations(
  olderThanMs: number,
): Promise<{ phone: string; state: ConversationState }[]> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping stale-conversation lookup")
    return []
  }

  const cutoffIso = new Date(Date.now() - olderThanMs).toISOString()

  try {
    const { data, error } = await supabase
      .from("conversation_states")
      .select("*")
      .lt("updated_at", cutoffIso)

    if (error) {
      logError("Database error while finding stale conversations", error, { cutoffIso })
      return []
    }

    return (data ?? []).map((row) => ({
      phone: row.phone as string,
      state: mapRowToState(row),
    }))
  } catch (error) {
    logError("Unexpected error while finding stale conversations", error, { cutoffIso })
    return []
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const stateService = {
  /**
   * Gets the current state for a user.
   * Priority: fresh memory cache → Supabase → null.
   *
   * Memory misses (including expired entries) always fall through to
   * Supabase, which is the source of truth. This keeps behavior correct
   * even on a cold start where the cache is guaranteed to be empty.
   */
  async getState(userId: string): Promise<ConversationState | null> {
    assertValidUserId(userId)

    const cached = readFromCache(userId)
    if (cached) {
      logInfo("Cache hit", { userId })
      return cached
    }

    logInfo("Cache miss", { userId })

    const fromDb = await loadFromDatabase(userId)
    if (fromDb) {
      writeToCache(userId, fromDb)
    }
    return fromDb
  },

  /**
   * Sets the full state for a user.
   * Updates both memory cache and Supabase. Writes for the same userId are
   * serialized so a slower, earlier-issued call can't clobber the result of
   * a faster, later-issued one.
   */
  async setState(userId: string, state: ConversationState): Promise<void> {
    assertValidUserId(userId)
    assertValidConversationState(state)

    await enqueueWrite(userId, async () => {
      const next: ConversationState = {
        state: state.state,
        data: state.data ?? {},
        updatedAt: state.updatedAt ?? new Date().toISOString(),
      }

      // Memory first for fast subsequent reads on this warm instance...
      writeToCache(userId, next)
      // ...but the database write always happens regardless of cache outcome.
      await persistToDatabase(userId, next)
    })
  },

  /**
   * Updates specific fields of the state for a user.
   * Reads the latest known state, then shallow-merges `data` without
   * mutating the previous state object, and never drops existing keys that
   * the caller didn't explicitly overwrite.
   *
   * Serialized per-user (see enqueueWrite) so that concurrent updates for
   * the same user apply in call order and the most recently issued update
   * wins, instead of racing on stale reads.
   */
  async updateState(userId: string, updates: Partial<ConversationState>): Promise<void> {
    assertValidUserId(userId)
    if (updates === undefined || updates === null) {
      throw new Error("[state] Invalid updates: updates object must be defined")
    }
    if (updates.state !== undefined && (typeof updates.state !== "string" || updates.state.trim().length === 0)) {
      throw new Error("[state] Invalid updates: 'state' field must be a non-empty string when provided")
    }

    await enqueueWrite(userId, async () => {
      // Read inside the queued task (not before enqueueing) so this read
      // reflects any writes for this user that were queued earlier.
      const current = await this.getState(userId)

      const next: ConversationState = {
        state: updates.state ?? current?.state ?? "default",
        data: {
          ...current?.data,
          ...updates.data,
        },
        updatedAt: new Date().toISOString(),
      }

      writeToCache(userId, next)
      await persistToDatabase(userId, next)
    })
  },

  /**
   * Clears the state for a user.
   * Removes from both memory cache and Supabase, serialized behind any
   * pending writes for that user so a clear can't be immediately
   * resurrected by an in-flight update.
   */
  async clearState(userId: string): Promise<void> {
    assertValidUserId(userId)

    await enqueueWrite(userId, async () => {
      stateStore.delete(userId)
      await deleteFromDatabase(userId)
    })
  },

  /**
   * Gets the current state without hitting the DB.
   * Useful for when you only want to check memory. Respects TTL: an expired
   * entry is treated the same as a miss and is evicted on read.
   */
  getCachedState(userId: string): ConversationState | null {
    assertValidUserId(userId)
    return readFromCache(userId)
  },

  /**
   * Finds conversations idle longer than `olderThanMs`. See
   * {@link findStaleConversations} above for details.
   */
  findStaleConversations,
}
