"use client"

// app/admin/voice-notes/VoiceNotePlayer.tsx — drop this next to a voice message's transcript in the inbox.
//   <VoiceNotePlayer audioId={info.audioId} durationSeconds={info.durationSeconds} keptUntil={info.keptUntil} />
// (info comes from loadVoiceAudioForMessages in lib/whatsapp/voice-audio-queries.ts.)
// Nothing is fetched until staff press play, so a private link is only created when someone actually listens.
import { useState } from "react"

type Status = "idle" | "loading" | "ready" | "gone" | "error"

function clock(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

export function VoiceNotePlayer({
  audioId,
  durationSeconds,
  keptUntil,
}: {
  audioId: string
  durationSeconds?: number | null
  keptUntil?: string | null
}) {
  const [status, setStatus] = useState<Status>("idle")
  const [url, setUrl] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function load() {
    setStatus("loading")
    setMessage(null)
    try {
      const response = await fetch(`/api/admin/voice-notes/${audioId}`, { cache: "no-store" })
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
      if (response.status === 410) {
        setStatus("gone")
        setMessage(body?.error ?? "This recording has been deleted.")
        return
      }
      if (!response.ok || !body?.url) {
        setStatus("error")
        setMessage(body?.error ?? "Couldn't load this recording.")
        return
      }
      setUrl(body.url)
      setStatus("ready")
    } catch {
      setStatus("error")
      setMessage("Couldn't load this recording.")
    }
  }

  const length = clock(durationSeconds ?? null)
  const until = keptUntil ? new Date(keptUntil).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }) : null

  if (status === "gone") return <p className="text-xs text-admin-text/60">🎙️ {message}</p>

  return (
    <div className="space-y-1">
      {status === "ready" && url ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- the transcript is shown next to it in the inbox
        <audio controls autoPlay preload="auto" src={url} className="h-9 w-full max-w-xs" />
      ) : (
        <button
          type="button"
          onClick={load}
          disabled={status === "loading"}
          className="inline-flex items-center gap-2 rounded-full border border-admin-text/20 px-3 py-1 text-sm text-admin-text hover:bg-admin-text/5 disabled:opacity-60"
        >
          <span aria-hidden>▶</span>
          {status === "loading" ? "Loading…" : `Play voice note${length ? ` (${length})` : ""}`}
        </button>
      )}
      {status === "error" && message && <p className="text-xs text-red-600">{message}</p>}
      {until && status !== "error" && <p className="text-[11px] text-admin-text/50">Kept until {until}</p>}
    </div>
  )
}
