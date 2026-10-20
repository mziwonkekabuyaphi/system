const CACHE = "zozoqueue-v1"

self.addEventListener("install", () => self.skipWaiting())

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Never touch non-GET, cross-origin (Supabase), API or auth requests
  if (req.method !== "GET" || url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth")) return

  // Static assets: cache first
  if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/icons")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy))
            return res
          })
      )
    )
    return
  }

  // Pages: network first, fall back to cache when offline
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy))
          return res
        })
        .catch(() => caches.match(req))
    )
  }
})
