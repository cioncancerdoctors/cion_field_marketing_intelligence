// =========================================
// CION Connect — Service Worker v2.6
// =========================================
// Strategy:
//   - Navigation / HTML  → NETWORK-FIRST (always try fresh; fallback to cache only if offline)
//   - CDN assets         → CACHE-FIRST with background refresh
//   - On update          → skipWaiting + claim, client reloads once on controllerchange
// This keeps the app shell fresh and avoids stale HTML loops.

const SW_VERSION = 'cion-v2.6.0';
const RUNTIME_CACHE = `runtime-${SW_VERSION}`;
const ASSET_CACHE = `assets-${SW_VERSION}`;

// Known CDN origins we want to cache (static, versioned upstream)
const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'unpkg.com',
  'cdn.jsdelivr.net'
];

// ---- INSTALL ----
// Don't pre-cache HTML; we want it always fresh from network.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// ---- ACTIVATE ----
// Remove old caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== RUNTIME_CACHE && k !== ASSET_CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ---- FETCH ----
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Ignore non-GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept Supabase or API calls — always live
  if (url.hostname.includes('supabase.co')) return;

  // Navigation / HTML requests → NETWORK-FIRST
  const isNavigation = req.mode === 'navigate' ||
                       (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith(networkFirst(req));
    return;
  }

  // CDN static assets → CACHE-FIRST
  if (CDN_HOSTS.some(host => url.hostname.includes(host))) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // Same-origin assets (manifest, icons) → stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Default: just let it pass through
});

// ---- STRATEGIES ----

async function networkFirst(req) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    // Don't cache HTML shell — we want it always fresh
    return fresh;
  } catch (err) {
    // Offline fallback: serve cached HTML if we have any
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req) || await cache.match('/index.html') || await cache.match('./');
    if (cached) return cached;
    // Last resort: simple offline message
    return new Response(
      '<h1>Offline</h1><p>No network and no cached version available.</p>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Fire-and-forget refresh in background (stale-while-revalidate pattern)
    fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
    }).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await networkPromise) || new Response('Unavailable', { status: 503 });
}

// ---- MESSAGE HANDLER ----
// Allows page to trigger skipWaiting manually (for "New version" prompts if added later)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
