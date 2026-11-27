// components/site/WebLink.tsx
"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

/**
 * Link to the booking / join-the-queue page (/web).
 * On a shop's own domain the path is just "/web" (middleware adds the slug). On our platform domain
 * (when the owner previews at /site/{slug}) it has to be "/web/{slug}". The server can't tell which
 * without reading headers (which would stop the page being cached), so the browser decides.
 * Without JavaScript it stays "/web", which is the right link on a shop's own domain.
 */
export function WebLink({ slug, className, style, children }: { slug: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  const [href, setHref] = useState("/web")
  useEffect(() => {
    if (window.location.pathname.startsWith("/site/")) setHref(`/web/${encodeURIComponent(slug)}`)
  }, [slug])
  return (
    <a href={href} className={className} style={style}>
      {children}
    </a>
  )
}
