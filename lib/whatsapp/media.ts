// lib/whatsapp/media.ts
/**
 * Downloads a customer's WhatsApp voice note (multi-tenant).
 * ----------------------------------------------------------------------------
 * Meta does not put the audio in the webhook. It sends a media ID. Getting the file is two calls, both
 * with the TENANT'S OWN access token (the same credentials send-message.ts uses):
 *
 *   1. GET graph.facebook.com/<version>/<media-id>   -> { url, mime_type, file_size }
 *   2. GET <that url>                                -> the audio bytes (the url is short-lived)
 *
 * SAFETY RULES (the media id comes from an incoming payload, so treat it as untrusted):
 *   - the id must look like a Meta id (digits only), so it can't smuggle a path or another host;
 *   - we only ever fetch the URL META RETURNS in step 1, never a URL that came from the payload;
 *   - that URL must be https and on a Meta/WhatsApp host (checked again on every redirect);
 *   - the type must be audio/*, and the file is read with a hard size cap, so a huge or fake file can't
 *     eat memory or money;
 *   - every call has a timeout.
 * Never throws: returns { ok: false, reason } instead.
 */

import { getTenantCredentials } from "@/lib/whatsapp/send-message"

const GRAPH_API_VERSION = "v21.0" // keep in step with send-message.ts
const META_MEDIA_ID = /^\d{5,40}$/
/** Hosts Meta serves media from. Anything else is refused, even if Meta's JSON named it. */
const ALLOWED_HOST_SUFFIXES = [".fbsbx.com", ".whatsapp.net", ".fbcdn.net", ".facebook.com"]
const MAX_REDIRECTS = 3
const STEP_TIMEOUT_MS = 10_000

/** A voice note is ~3 KB per second, so this is far more than a minute and a half needs. */
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024

export type MediaFailure = "bad_id" | "not_audio" | "too_large" | "download_failed" | "timeout"

export type AudioDownload =
  | { ok: true; bytes: Uint8Array; mimeType: string; durationSeconds: number }
  | { ok: false; reason: MediaFailure }

function isAllowedMetaUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:") return null
    const host = url.hostname.toLowerCase()
    const ok = ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
    return ok ? url : null
  } catch {
    return null
  }
}

/** Reads a response body but stops (and returns null) the moment it passes `max` bytes. */
async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > max) return null

  const reader = response.body?.getReader()
  if (!reader) {
    const whole = new Uint8Array(await response.arrayBuffer())
    return whole.length > max ? null : whole
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** GET with the tenant token, following at most a few redirects, each re-checked against the host allowlist. */
async function fetchFromMeta(startUrl: URL, accessToken: string): Promise<Response | null> {
  let url = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) {
      const next = isAllowedMetaUrl(new URL(response.headers.get("location") ?? "", url).toString())
      if (!next) return null
      url = next
      continue
    }
    return response
  }
  return null
}

/**
 * Ogg/Opus length from the LAST Ogg page: its "granule position" is the total sample count at 48 kHz.
 * Cheap (reads a few bytes) and lets us refuse a long clip BEFORE paying to transcribe it.
 * Returns null for anything that isn't Ogg or has no usable page.
 */
export function oggOpusDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 27 || bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const stop = Math.max(0, bytes.length - 65_536)
  for (let i = bytes.length - 27; i >= stop; i--) {
    if (bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53) {
      const granule = view.getBigUint64(i + 6, true)
      if (granule === 0xffffffffffffffffn) continue // page with no finished packet; look at an earlier one
      return Number(granule) / 48_000
    }
  }
  return null
}

/** Not Ogg (rare): assume a ~32 kbps voice stream, which over-estimates and so errs on the safe side. */
function estimateSeconds(byteLength: number): number {
  return byteLength / 4_000
}

export async function downloadWhatsAppAudio(tenantId: string, mediaId: unknown): Promise<AudioDownload> {
  if (typeof mediaId !== "string" || !META_MEDIA_ID.test(mediaId)) return { ok: false, reason: "bad_id" }

  try {
    const { accessToken } = await getTenantCredentials(tenantId)

    // Step 1: ask Meta where the file is.
    const metaResponse = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    })
    if (!metaResponse.ok) return { ok: false, reason: "download_failed" }
    const meta = (await metaResponse.json()) as { url?: unknown; mime_type?: unknown; file_size?: unknown }

    const declaredType = typeof meta.mime_type === "string" ? meta.mime_type.split(";")[0].trim().toLowerCase() : ""
    if (!declaredType.startsWith("audio/")) return { ok: false, reason: "not_audio" }
    if (typeof meta.file_size === "number" && meta.file_size > MAX_AUDIO_BYTES) return { ok: false, reason: "too_large" }

    const fileUrl = typeof meta.url === "string" ? isAllowedMetaUrl(meta.url) : null
    if (!fileUrl) return { ok: false, reason: "download_failed" }

    // Step 2: fetch the URL Meta gave us.
    const fileResponse = await fetchFromMeta(fileUrl, accessToken)
    if (!fileResponse || !fileResponse.ok) return { ok: false, reason: "download_failed" }

    const actualType = (fileResponse.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (actualType && !actualType.startsWith("audio/") && actualType !== "application/octet-stream" && actualType !== "application/ogg") {
      return { ok: false, reason: "not_audio" }
    }

    const bytes = await readCapped(fileResponse, MAX_AUDIO_BYTES)
    if (!bytes) return { ok: false, reason: "too_large" }
    if (bytes.length === 0) return { ok: false, reason: "download_failed" }

    return {
      ok: true,
      bytes,
      mimeType: declaredType,
      durationSeconds: oggOpusDurationSeconds(bytes) ?? estimateSeconds(bytes.length),
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    // Never log the token or the media URL: only the tenant and the kind of failure.
    console.error("[media] voice note download failed", { tenantId, timedOut, error: error instanceof Error ? error.message : "unknown" })
    return { ok: false, reason: timedOut ? "timeout" : "download_failed" }
  }
}
