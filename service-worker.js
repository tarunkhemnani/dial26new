
// service-worker.js
// Offline-first, iOS-friendly service worker for the Phone Keypad PWA.
// - Navigations: cache-first (serve cached index.html immediately) + background revalidate.
// - Same-origin static assets: cache-first.
// - Cross-origin: network pass-through.
// - Versioned cache with cleanup; works at root or subdirectory via BASE.

const CACHE_VERSION = 'v4';
const CACHE_NAME = `phone-keypad-${CACHE_VERSION}`;

// Compute base path from SW scope so it works under subdirectories too.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');

// List assets relative to BASE; no leading slash needed.
const ASSET_PATHS = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'apple-touch-icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'favicon-32x32.png',
  'numpad.png',
  'screenshot.png',
  'service-worker.js'
];

// Build absolute URLs scoped to BASE.
function urlFromBase(p) {
  const clean = String(p || '').replace(/^\/+/, '');
  return `${BASE}/${clean}`;
}
const ASSETS_TO_CACHE = ASSET_PATHS.map(urlFromBase);

// Small helper to detect images.
function isImageRequest(request) {
  if (request.destination && request.destination === 'image') return true;
  try {
    const url = new URL(request.url);
    return /\.(png|jpg|jpeg|gif|webp|svg|ico|avif)$/i.test(url.pathname);
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        await cache.addAll(ASSETS_TO_CACHE);
      } catch (err) {
        // Fallback: add individually so one failure doesn't abort install
        await Promise.all(
          ASSETS_TO_CACHE.map(async (asset) => {
            try { await cache.add(asset); } catch (e) { /* ignore */ }
          })
        );
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  const accept = req.headers.get('accept') || '';
  const isHTMLNavigation = req.mode === 'navigate' || accept.includes('text/html');

  if (isHTMLNavigation) {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (isSameOrigin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(fetch(req).catch(() => new Response(null, { status: 503, statusText: 'Service Unavailable' })));
});

// Cache-first for navigations with background revalidate (stale-while-revalidate)
async function handleNavigation(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = urlFromBase('index.html');

  // 1) Serve cached shell immediately if present
  const cached = await cache.match(indexUrl);
  if (cached) {
    // Revalidate in background without blocking the response
    event.waitUntil((async () => {
      try {
        const res = await fetch(indexUrl, { cache: 'no-cache' });
        if (res && res.ok) {
          await cache.put(indexUrl, res.clone());
        }
      } catch (e) { /* offline or network error */ }
    })());
    return cached;
  }

  // 2) No cache yet: try network, then graceful offline fallback
  try {
    const res = await fetch(request);
    if (res && res.ok && new URL(request.url).origin === self.location.origin) {
      try { await cache.put(indexUrl, res.clone()); } catch (e) {}
    }
    return res;
  } catch (e) {
    const fallback = await cache.match(indexUrl);
    if (fallback) return fallback;
    return new Response('<!doctype html><title>Offline</title><h1>Offline</h1>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      status: 503, statusText: 'Service Unavailable'
    });
  }
}

// Cache-first for static same-origin assets with graceful fallbacks
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    if (res && res.ok) {
      try { await cache.put(request, res.clone()); } catch (e) { /* ignore */ }
    }
    return res;
  } catch (e) {
    if (isImageRequest(request)) {
      const iconFallback = await cache.match(urlFromBase('apple-touch-icon-180.png'));
      if (iconFallback) return iconFallback;
    }
    return new Response(null, { status: 503, statusText: 'Service Unavailable' });
  }
}

// Support messages from the page (e.g., trigger SKIP_WAITING on update)
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

