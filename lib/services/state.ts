import { getSupabaseServerClient } from "@/lib/supabase/admin"

/**
 * Free-form payload attached to a conversation state.
 * Kept as a named type (instead of inlining Record<string, unknown>)
 * so call sites get a stable, self-documenting type to import.
 */
export type ConversationData = Record<string, unknown>

export type ConversationState = {
  readonly state: string
  readonly data?: ConversationData
  readonly updatedAt?: string
}

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
// Same reasoning as the single-tenant version: a pure performance layer over
// warm Vercel instances, never the source of truth, and must behave
// correctly even if empty on every call (cold start).
//
// TENANCY NOTE: the cache/write-queue key is now a composite
// `${tenantId}::${phone}` string built by cacheKey() below, since the same
// phone number can legitimately have independent, simultaneous
// conversations under different tenants. Every public method below takes
// tenantId and phone as SEPARATE parameters (not a pre-joined string) so
// callers can't accidentally swap the delimiter or forget one half.
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

/**
 * Builds the composite cache/queue key for a (tenantId, phone) pair. "::"
 * is used as the delimiter since neither a UUID nor a phone number can
 * contain it, so this can't collide across different (tenantId, phone)
 * inputs the way naive concatenation could.
 */
function cacheKey(tenantId: string, phone: string): string {
  return `${tenantId}::${phone}`
}

// ---------------------------------------------------------------------------
// Per-(tenant, phone) write serialization
// ---------------------------------------------------------------------------
// Same reasoning as the single-tenant version: chain mutating operations
// for a given (tenant, phone) pair onto a single promise queue so writes
// apply in call order, not resolution order. Queue key = cache key.
const writeQueues = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  writeQueues.set(
    key,
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
function assertValidId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[state] Invalid ${label}: expected a non-empty string`)
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
function readFromCache(key: string): ConversationState | null {
  const entry = stateStore.get(key)
  if (!entry) return null

  if (Date.now() >= entry.expiresAt) {
    stateStore.delete(key)
    return null
  }

  return entry.state
}

function writeToCache(key: string, state: ConversationState): void {
  try {
    stateStore.set(key, {
      state,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    if (stateStore.size > MAX_CACHE_ENTRIES_BEFORE_SWEEP) {
      sweepExpiredCacheEntries()
    }
  } catch (error) {
    logError("Failed to write to memory cache (continuing without cache)", error, { key })
  }
}

/** Removes all expired entries. Bounds memory usage on long-lived warm instances. */
function sweepExpiredCacheEntries(): void {
  const now = Date.now()
  let removed = 0
  for (const [key, entry] of stateStore) {
    if (now >= entry.expiresAt) {
      stateStore.delete(key)
      removed++
    }
  }
  if (removed > 0) {
    logInfo("Swept expired cache entries", { removed, remaining: stateStore.size })
  }
}

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

async function loadFromDatabase(tenantId: string, phone: string): Promise<ConversationState | null> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping database load", { tenantId, phone })
    return null
  }

  try {
    const { data, error } = await supabase
      .from("conversation_states")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .single()

    if (error) {
      // PGRST116 = no rows found for .single() - this is an expected "no
      // state yet" case, not a failure, so we don't log it as an error.
      if (error.code !== "PGRST116") {
        logError("Database error while loading state", error, { tenantId, phone })
      }
      return null
    }

    return mapRowToState(data)
  } catch (error) {
    logError("Unexpected error while loading state from database", error, { tenantId, phone })
    return null
  }
}

async function persistToDatabase(tenantId: string, phone: string, state: ConversationState): Promise<void> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping database persist", { tenantId, phone })
    return
  }

  try {
    const { error } = await supabase
      .from("conversation_states")
      .upsert(
        {
          tenant_id: tenantId,
          phone,
          state: state.state,
          data: state.data ?? {},
          updated_at: state.updatedAt ?? new Date().toISOString(),
        },
        {
          // Matches conversation_states' unique(tenant_id, phone)
          // constraint — NOT "phone" alone, which no longer uniquely
          // identifies a conversation on its own.
          onConflict: "tenant_id,phone",
        },
      )

    if (error) {
      logError("Database error while saving state", error, { tenantId, phone })
      return
    }

    logInfo("Saved to database", { tenantId, phone })
  } catch (error) {
    logError("Unexpected error while saving state to database", error, { tenantId, phone })
  }
}

async function deleteFromDatabase(tenantId: string, phone: string): Promise<void> {
  const supabase = getSupabaseServerClient()
  if (!supabase) {
    logInfo("Supabase client unavailable, skipping database delete", { tenantId, phone })
    return
  }

  try {
    const { error } = await supabase
      .from("conversation_states")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("phone", phone)

    if (error) {
      logError("Database error while clearing state", error, { tenantId, phone })
      return
    }

    logInfo("Cleared", { tenantId, phone })
  } catch (error) {
    logError("Unexpected error while clearing state from database", error, { tenantId, phone })
  }
}

/**
 * Finds every conversation whose state hasn't been touched in over
 * `olderThanMs`, across ALL tenants — the inactivity-sweep cron isn't
 * tenant-scoped itself, so each result now carries its own tenantId
 * alongside phone for the caller to act on correctly.
 */
async function findStaleConversations(
  olderThanMs: number,
): Promise<{ tenantId: string; phone: string; state: ConversationState }[]> {
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
      tenantId: row.tenant_id as string,
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
   * Gets the current state for a (tenant, phone) pair.
   * Priority: fresh memory cache → Supabase → null.
   */
  async getState(tenantId: string, phone: string): Promise<ConversationState | null> {
    assertValidId(tenantId, "tenantId")
    assertValidId(phone, "phone")
    const key = cacheKey(tenantId, phone)

    const cached = readFromCache(key)
    if (cached) {
      logInfo("Cache hit", { tenantId, phone })
      return cached
    }

    logInfo("Cache miss", { tenantId, phone })

    const fromDb = await loadFromDatabase(tenantId, phone)
    if (fromDb) {
      writeToCache(key, fromDb)
    }
    return fromDb
  },

  /**
   * Sets the full state for a (tenant, phone) pair. Updates both memory
   * cache and Supabase, serialized per (tenant, phone) so a slower,
   * earlier-issued call can't clobber a faster, later-issued one.
   */
  async setState(tenantId: string, phone: string, state: ConversationState): Promise<void> {
    assertValidId(tenantId, "tenantId")
    assertValidId(phone, "phone")
    assertValidConversationState(state)
    const key = cacheKey(tenantId, phone)

    await enqueueWrite(key, async () => {
      const next: ConversationState = {
        state: state.state,
        data: state.data ?? {},
        updatedAt: state.updatedAt ?? new Date().toISOString(),
      }

      writeToCache(key, next)
      await persistToDatabase(tenantId, phone, next)
    })
  },

  /**
   * Updates specific fields of the state for a (tenant, phone) pair.
   * Shallow-merges `data` without dropping existing keys the caller didn't
   * explicitly overwrite. Serialized per (tenant, phone).
   */
  async updateState(tenantId: string, phone: string, updates: Partial<ConversationState>): Promise<void> {
    assertValidId(tenantId, "tenantId")
    assertValidId(phone, "phone")
    if (updates === undefined || updates === null) {
      throw new Error("[state] Invalid updates: updates object must be defined")
    }
    if (updates.state !== undefined && (typeof updates.state !== "string" || updates.state.trim().length === 0)) {
      throw new Error("[state] Invalid updates: 'state' field must be a non-empty string when provided")
    }

    const key = cacheKey(tenantId, phone)

    await enqueueWrite(key, async () => {
      // Read inside the queued task (not before enqueueing) so this read
      // reflects any writes for this (tenant, phone) queued earlier.
      const current = await this.getState(tenantId, phone)

      const next: ConversationState = {
        state: updates.state ?? current?.state ?? "default",
        data: {
          ...current?.data,
          ...updates.data,
        },
        updatedAt: new Date().toISOString(),
      }

      writeToCache(key, next)
      await persistToDatabase(tenantId, phone, next)
    })
  },

  /**
   * Clears the state for a (tenant, phone) pair. Serialized behind any
   * pending writes so a clear can't be immediately resurrected by an
   * in-flight update.
   */
  async clearState(tenantId: string, phone: string): Promise<void> {
    assertValidId(tenantId, "tenantId")
    assertValidId(phone, "phone")
    const key = cacheKey(tenantId, phone)

    await enqueueWrite(key, async () => {
      stateStore.delete(key)
      await deleteFromDatabase(tenantId, phone)
    })
  },

  /**
   * Gets the current state without hitting the DB. Respects TTL: an
   * expired entry is treated the same as a miss and is evicted on read.
   */
  getCachedState(tenantId: string, phone: string): ConversationState | null {
    assertValidId(tenantId, "tenantId")
    assertValidId(phone, "phone")
    return readFromCache(cacheKey(tenantId, phone))
  },

  /**
   * Finds conversations idle longer than `olderThanMs`, across all
   * tenants. See {@link findStaleConversations} above for details.
   */
  findStaleConversations,
}
