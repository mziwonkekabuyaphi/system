//
// QLESS V2 — SERVICE WORKER
// Built from scratch for QLess V2. Nothing here is derived from, or
// compatible with, the old Rands service worker (old cache name
// 'rands-wallet-v1.1.0', old precache list, old push-notification config).
//
// SCOPE — deliberately conservative for this first version:
//   - Caches ONLY a small, verified list of static shell files.
//   - Uses network-first (not cache-first) for those files, so a stale
//     cached copy never traps a user on an outdated version indefinitely.
//   - Does NOT intercept any request that isn't in that verified list —
//     everything else (Supabase RPCs, auth, other pages, other modules)
//     passes straight through to the network untouched.
//   - Does NOT resolve tenants, store a tenant_id, or create any
//     tenant-specific cache. Tenant resolution stays entirely in
//     assets/js/index.js via get_tenant_by_domain(window.location.hostname).
//

const CACHE_NAME = 'qless-v2-static-v1';
const CACHE_PREFIX = 'qless-v2-static-'; // used to identify/clean old V2 versions only

// Only paths verified to exist in this project. Do not add paths here
// without confirming they exist — a failed cache.add() for one URL
// would otherwise abort the whole install step.
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/assets/css/index.css',
  '/assets/js/index.js'
];

// --------------------
// INSTALL — precache the verified static shell only
// --------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Skipped caching (not available):', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
    // skipWaiting is safe here because fetch handling below is
    // network-first for the shell, so a newly-activated worker can't
    // serve a stale app version over a fresh network response.
  );
});

// --------------------
// ACTIVATE — drop any previous QLess V2 cache versions only.
// Never touches caches outside the qless-v2-static- namespace.
// --------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// --------------------
// FETCH — network-first, cache-fallback, and ONLY for the verified
// static shell list above. Everything else is left completely alone.
// --------------------
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Same-origin only. This already excludes every Supabase RPC/auth call,
  // which is served from a different origin (*.supabase.co).
  if (url.origin !== self.location.origin) return;

  // Only intercept the small, known static shell — never business pages,
  // never Admin Shell, never Wallet/Kiosk/WhatsApp routes, never anything
  // carrying tenant, session, or customer data.
  const isKnownStaticAsset = STATIC_ASSETS.includes(url.pathname);
  if (!isKnownStaticAsset) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || Response.error())
      )
  );
});
