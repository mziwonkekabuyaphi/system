// components/site/SiteBeacon.tsx
"use client"

import { useEffect } from "react"

/**
 * Counts visits and WhatsApp taps for the shop's stats. No cookies and nothing about the visitor:
 * the server just adds 1 to a daily counter. A "visit" is once per browser session (sessionStorage), not
 * once per page load. Does nothing on our own hostnames' preview paths (/site/{slug}, /site-preview), and
 * the server ignores those hostnames anyway.
 */
export function SiteBeacon() {
  useEffect(() => {
    const path = window.location.pathname
    if (path === "/site-preview" || path.startsWith("/site/")) return

    const send = (kind: "view" | "whatsapp") => {
      try {
        const body = new Blob([JSON.stringify({ kind })], { type: "application/json" })
        if (!navigator.sendBeacon?.("/api/site/event", body)) {
          void fetch("/api/site/event", { method: "POST", body, keepalive: true })
        }
      } catch {
        /* stats must never break the page */
      }
    }

    let counted = false
    try {
      counted = sessionStorage.getItem("zw_visit") === "1"
      if (!counted) sessionStorage.setItem("zw_visit", "1")
    } catch {
      /* storage blocked: count this load */
    }
    if (!counted) send("view")

    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]")
      const href = a?.getAttribute("href") ?? ""
      if (href.startsWith("https://wa.me/")) send("whatsapp")
    }
    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [])

  return null
}
