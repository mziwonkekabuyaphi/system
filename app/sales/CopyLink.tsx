// app/sales/CopyLink.tsx
"use client"

import { useEffect, useState } from "react"

export function CopyLink({ code }: { code: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const link = origin ? `${origin}/refer/${code}` : null

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable; the link is selectable in the input.
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          readOnly
          value={link ?? "Loading…"}
          onFocus={(e) => e.target.select()}
          className="w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-800"
        />
        <button
          type="button"
          onClick={copy}
          disabled={!link}
          className="shrink-0 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      {link && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(link)}`}
          alt="QR code for your referral link"
          width={140}
          height={140}
          className="rounded-lg border border-stone-200 bg-white p-1"
        />
      )}
    </div>
  )
}
