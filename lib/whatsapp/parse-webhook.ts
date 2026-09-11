/**
 * Rands WhatsApp Concierge — Webhook payload parser.
 * --------------------------------------------------
 * Meta's WhatsApp Cloud API delivers inbound events in a deeply nested
 * structure:
 *
 *   { entry: [ { changes: [ { value: { messages, contacts, ... } } ] } ] }
 *
 * This module flattens that structure into a simple list of typed
 * `IncomingMessage` objects that the rest of the app can work with, without
 * every caller needing to know Meta's payload shape.
 *
 * It is deliberately defensive: any missing/oddly-shaped field is skipped
 * rather than throwing, because we never want a malformed payload to break
 * the webhook's "always return 200" contract.
 *
 * Every message TYPE is handled — text, image, video, audio, document,
 * sticker, location, contacts, reaction, order, button, interactive, and
 * system events all normalize into the same shape so downstream code (intent
 * routing, persistence, etc.) never has to special-case Meta's payload.
 *
 * This file has zero knowledge of databases, AI, intents, routing, or any
 * other business concern — it is a pure, framework-independent parser.
 */

/** A single inbound WhatsApp message, normalized for our own use. */
export interface IncomingMessage {
  /** Meta's unique id for this message (used for de-duplication). */
  waMessageId: string
  /** Sender phone number in E.164 (no "+"), e.g. "27831234567". */
  from: string
  /** WhatsApp profile/display name of the sender, if Meta provided one. */
  profileName: string | null
  /** Message type as reported by Meta: "text", "image", "audio", etc. */
  type: string
  /** The plain-text body for text messages; null for non-text types. */
  text: string | null
  /**
   * Best-effort, human-readable summary of this message's content,
   * regardless of type — text body, media caption, button/list reply title,
   * location name, etc. This is what intent classification should read.
   * Can be null when the message type carries no inherent text (e.g. a
   * voice note or sticker with no caption); callers needing a guaranteed
   * non-empty string should fall back to something like `type: ${type}`.
   */
  contentSummary: string | null
  /**
   * The stable `id` of a tapped button or list row (e.g. "row_4",
   * "btn_1"), if this message is an interactive reply. Unlike
   * `contentSummary` (the human-readable title, which can vary — emoji,
   * copy tweaks, AI misreads), this id is exactly what the menu/button was
   * built with, so callers that already know their own menu structure can
   * route on it directly instead of re-inferring intent from title text.
   * Null for every non-interactive message type.
   */
  interactiveId: string | null
  /** When Meta says the message was sent (parsed from the unix timestamp). */
  timestamp: Date | null
  /**
   * Meta's identifier for the WhatsApp Business number this message was
   * sent TO (from `value.metadata.phone_number_id`), not the sender's own
   * number. In a multi-tenant deployment this is the join key back to
   * `tenant_whatsapp_integrations.phone_number_id`, used to resolve which
   * tenant owns this conversation before anything else runs. Null if Meta's
   * payload didn't include a `metadata` object (shouldn't happen for a real
   * message, but this parser never assumes well-formed input).
   */
  phoneNumberId: string | null
  /** The original, unmodified message object exactly as Meta sent it. */
  raw: Record<string, unknown>
}

/* ============================================================================
 * Meta payload shapes
 * ----------------------------------------------------------------------------
 * These interfaces describe what Meta's webhook payload SHOULD look like.
 * They exist purely to give this file (and its readers) stronger typing
 * than `Record<string, unknown>` everywhere. They do NOT replace runtime
 * validation — the payload is untrusted network input, so every access
 * still goes through a guard (`isObject`, `Array.isArray`, `typeof`, or
 * optional chaining) before it influences behavior.
 *
 * Every interface carries an index signature so unrecognized/future fields
 * from Meta are preserved on `raw` without narrowing the type away.
 * ========================================================================= */

interface MetaTextMessage {
  body?: string
  [key: string]: unknown
}

interface MetaMediaMessage {
  caption?: string
  [key: string]: unknown
}

interface MetaDocumentMessage {
  caption?: string
  filename?: string
  [key: string]: unknown
}

interface MetaButtonReply {
  text?: string
  [key: string]: unknown
}

interface MetaInteractiveTitledReply {
  title?: string
  [key: string]: unknown
}

interface MetaInteractiveFlowReply {
  name?: string
  body?: string
  [key: string]: unknown
}

interface MetaInteractiveMessage {
  button_reply?: MetaInteractiveTitledReply
  list_reply?: MetaInteractiveTitledReply
  nfm_reply?: MetaInteractiveFlowReply
  [key: string]: unknown
}

interface MetaLocationMessage {
  name?: string
  address?: string
  latitude?: number
  longitude?: number
  [key: string]: unknown
}

/** An entry in a "share a contact" (`type: "contacts"`) message. */
interface MetaSharedContact {
  name?: { formatted_name?: string; [key: string]: unknown }
  [key: string]: unknown
}

interface MetaReaction {
  emoji?: string
  [key: string]: unknown
}

interface MetaOrder {
  product_items?: unknown[]
  [key: string]: unknown
}

interface MetaSystemMessage {
  body?: string
  [key: string]: unknown
}

/** A single message object as it appears in `value.messages[]`. */
interface MetaMessage {
  id?: string
  from?: string
  type?: string
  timestamp?: string | number
  text?: MetaTextMessage
  image?: MetaMediaMessage
  video?: MetaMediaMessage
  document?: MetaDocumentMessage
  button?: MetaButtonReply
  interactive?: MetaInteractiveMessage
  location?: MetaLocationMessage
  contacts?: MetaSharedContact[]
  reaction?: MetaReaction
  order?: MetaOrder
  system?: MetaSystemMessage
  [key: string]: unknown
}

/** A sender's WhatsApp profile, as it appears in `value.contacts[]`. */
interface MetaProfileContact {
  wa_id?: string
  profile?: { name?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** `value.metadata` — describes the WhatsApp Business number a message
 * arrived on, not the sender. Present on every real message event. */
interface MetaMetadata {
  phone_number_id?: string
  display_phone_number?: string
  [key: string]: unknown
}

interface MetaChangeValue {
  messages?: MetaMessage[]
  contacts?: MetaProfileContact[]
  metadata?: MetaMetadata
  [key: string]: unknown
}

interface MetaChange {
  value?: MetaChangeValue
  [key: string]: unknown
}

interface MetaEntry {
  changes?: MetaChange[]
  [key: string]: unknown
}

/* ============================================================================
 * Known message types
 * ========================================================================= */

/** Every WhatsApp message type this parser knows how to summarize. */
const MessageType = {
  Text: "text",
  Image: "image",
  Video: "video",
  Document: "document",
  Audio: "audio",
  Voice: "voice",
  Sticker: "sticker",
  Button: "button",
  Interactive: "interactive",
  Location: "location",
  Contacts: "contacts",
  Reaction: "reaction",
  Order: "order",
  System: "system",
  Unknown: "unknown",
} as const

/* ============================================================================
 * Generic guards & primitives
 * ========================================================================= */

/** Narrow an unknown value to a plain object so property access is safe. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Narrows an unknown value to an array of plain objects, dropping any
 * non-object entries and returning `[]` for anything that isn't an array.
 * This is the single place that decides "how do we safely turn an unknown
 * value into a list of Meta objects" — every array field in the payload
 * (entries, changes, messages, contacts) is read through this function.
 */
function toObjectArray<T extends Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isObject) as T[]) : []
}

/** Returns the first argument that is a non-empty (trimmed) string. */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

/**
 * Convert Meta's string unix-seconds timestamp into a Date.
 * Returns null if the value is missing or not a valid number.
 */
function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

/* ============================================================================
 * Content summary extraction
 * ----------------------------------------------------------------------------
 * Each WhatsApp message type has its own place for "the text a human would
 * read". Extraction is centralized in `CONTENT_SUMMARY_EXTRACTORS`, a
 * lookup table keyed by message type. Supporting a new Meta message type
 * never requires touching `extractContentSummary` itself — just register a
 * new entry in the table (Open/Closed Principle).
 * ========================================================================= */

function extractInteractiveSummary(message: MetaMessage): string | null {
  const interactive = message.interactive
  return firstNonEmptyString(
    interactive?.button_reply?.title,
    interactive?.list_reply?.title,
    interactive?.nfm_reply?.name,
    interactive?.nfm_reply?.body,
  )
}

/**
 * Extracts the stable `id` Meta returns alongside a tapped button/list
 * reply (e.g. `interactive.list_reply.id`). Only interactive messages
 * carry this — every other message type returns null. Kept separate from
 * `extractInteractiveSummary` (which reads `title`, not `id`) since callers
 * want either the human-readable label or the stable id, for different
 * reasons.
 */
function extractInteractiveId(message: MetaMessage): string | null {
  if (message.type !== MessageType.Interactive) return null
  const interactive = message.interactive
  return firstNonEmptyString(
    interactive?.button_reply?.id,
    interactive?.list_reply?.id,
  )
}

function extractLocationSummary(message: MetaMessage): string | null {
  const location = message.location
  if (!location) return null

  const named = firstNonEmptyString(location.name, location.address)
  if (named) return named

  const { latitude, longitude } = location
  return typeof latitude === "number" && typeof longitude === "number"
    ? `location: ${latitude}, ${longitude}`
    : null
}

/** Summarizes a "share a contact" message using the first shared contact. */
function extractSharedContactsSummary(message: MetaMessage): string | null {
  const [firstContact] = message.contacts ?? []
  return firstNonEmptyString(firstContact?.name?.formatted_name)
}

function extractReactionSummary(message: MetaMessage): string | null {
  const emoji = message.reaction?.emoji
  return typeof emoji === "string" && emoji ? `reacted: ${emoji}` : null
}

function extractOrderSummary(message: MetaMessage): string | null {
  const itemCount = message.order?.product_items?.length ?? 0
  return itemCount > 0 ? `order: ${itemCount} item(s)` : null
}

/** Voice notes, audio clips, and stickers never carry a caption in Meta's payload. */
function extractNoSummary(): null {
  return null
}

type ContentSummaryExtractor = (message: MetaMessage) => string | null

const CONTENT_SUMMARY_EXTRACTORS: Readonly<Record<string, ContentSummaryExtractor>> = {
  [MessageType.Text]: (message) => firstNonEmptyString(message.text?.body),
  [MessageType.Image]: (message) => firstNonEmptyString(message.image?.caption),
  [MessageType.Video]: (message) => firstNonEmptyString(message.video?.caption),
  [MessageType.Document]: (message) =>
    firstNonEmptyString(message.document?.caption, message.document?.filename),
  [MessageType.Audio]: extractNoSummary,
  [MessageType.Voice]: extractNoSummary,
  [MessageType.Sticker]: extractNoSummary,
  [MessageType.Button]: (message) => firstNonEmptyString(message.button?.text),
  [MessageType.Interactive]: extractInteractiveSummary,
  [MessageType.Location]: extractLocationSummary,
  [MessageType.Contacts]: extractSharedContactsSummary,
  [MessageType.Reaction]: extractReactionSummary,
  [MessageType.Order]: extractOrderSummary,
  [MessageType.System]: (message) => firstNonEmptyString(message.system?.body),
}

/**
 * Best-effort extraction of a human-readable summary for ANY WhatsApp
 * message type, dispatched via `CONTENT_SUMMARY_EXTRACTORS`. Returns null
 * when the type genuinely carries no text (e.g. a plain voice note or
 * sticker) or is unrecognized — the caller decides how to fall back.
 */
function extractContentSummary(message: MetaMessage, type: string): string | null {
  return CONTENT_SUMMARY_EXTRACTORS[type]?.(message) ?? null
}

/**
 * Text bodies live under `message.text.body` for text messages only. Kept
 * separate from `extractContentSummary` for callers that specifically want
 * "was this a text message, and if so what did it say".
 */
function extractTextBody(message: MetaMessage, type: string): string | null {
  if (type !== MessageType.Text) return null
  return typeof message.text?.body === "string" ? message.text.body : null
}

/* ============================================================================
 * Payload traversal
 * ----------------------------------------------------------------------------
 * Each function below extracts exactly one level of Meta's nested payload,
 * so `parseIncomingMessages` reads as a straightforward, flat traversal.
 * ========================================================================= */

/** Extracts the top-level `entry[]` array from a raw webhook payload. */
function extractEntries(payload: unknown): MetaEntry[] {
  return isObject(payload) ? toObjectArray<MetaEntry>(payload.entry) : []
}

/** Extracts the `changes[]` array from a single webhook entry. */
function extractChanges(entry: MetaEntry): MetaChange[] {
  return toObjectArray<MetaChange>(entry.changes)
}

/** Extracts the `value` object from a single change, if present. */
function extractChangeValue(change: MetaChange): MetaChangeValue | null {
  const value = change.value
  return isObject(value) ? (value as MetaChangeValue) : null
}

/** Extracts the `messages[]` array from a change's value. */
function extractMessages(value: MetaChangeValue): MetaMessage[] {
  return toObjectArray<MetaMessage>(value.messages)
}

/** Extracts the `contacts[]` (sender profile) array from a change's value. */
function parseContacts(value: MetaChangeValue): MetaProfileContact[] {
  return toObjectArray<MetaProfileContact>(value.contacts)
}

/**
 * Builds a `wa_id -> profile name` lookup from a change's `contacts[]`
 * array, so each message can be enriched with the sender's WhatsApp
 * display name. Entries missing either field are skipped.
 */
function buildProfileLookup(value: MetaChangeValue): ReadonlyMap<string, string> {
  const nameByWaId = new Map<string, string>()

  for (const contact of parseContacts(value)) {
    const waId = typeof contact.wa_id === "string" ? contact.wa_id : null
    const name = typeof contact.profile?.name === "string" ? contact.profile.name : null
    if (waId && name) nameByWaId.set(waId, name)
  }

  return nameByWaId
}

/**
 * Normalizes a single raw Meta message into our `IncomingMessage` shape.
 * Returns null only when the message is missing `id` or `from` — the two
 * fields we cannot function without, regardless of message type. Every
 * other message type (media, button, interactive, location, system, etc.)
 * is normalized and returned.
 */
function normalizeMessage(
  message: MetaMessage,
  profileByWaId: ReadonlyMap<string, string>,
  phoneNumberId: string | null,
): IncomingMessage | null {
  const waMessageId = typeof message.id === "string" ? message.id : null
  const from = typeof message.from === "string" ? message.from : null
  if (!waMessageId || !from) return null

  const type = typeof message.type === "string" ? message.type : MessageType.Unknown

  return {
    waMessageId,
    from,
    profileName: profileByWaId.get(from) ?? null,
    type,
    text: extractTextBody(message, type),
    contentSummary: extractContentSummary(message, type),
    interactiveId: extractInteractiveId(message),
    timestamp: parseTimestamp(message.timestamp),
    phoneNumberId,
    raw: message,
  }
}

/**
 * Extracts a flat list of inbound messages from a raw Meta webhook payload.
 *
 * Status-only callbacks (delivery/read receipts) contain no `messages`
 * array, so they naturally produce an empty list — the caller can simply
 * ignore them. Never throws: any missing or malformed field along the way
 * is treated as absent rather than an error.
 */
export function parseIncomingMessages(payload: unknown): IncomingMessage[] {
  const results: IncomingMessage[] = []

  for (const entry of extractEntries(payload)) {
    for (const change of extractChanges(entry)) {
      const value = extractChangeValue(change)
      if (!value) continue

      const profileByWaId = buildProfileLookup(value)
      const phoneNumberId = typeof value.metadata?.phone_number_id === "string" ? value.metadata.phone_number_id : null

      for (const message of extractMessages(value)) {
        const normalized = normalizeMessage(message, profileByWaId, phoneNumberId)
        if (normalized) results.push(normalized)
      }
    }
  }

  return results
}
