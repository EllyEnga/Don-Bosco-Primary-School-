/* =========================================================
   Don Bosco Primary School Portal — Service Worker
   Version 2.0 — Full offline support + push notifications
========================================================= */

const CACHE_VERSION = 'donbosco-v2';
const STATIC_CACHE  = CACHE_VERSION + '-static';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';
const OUTBOX_CACHE  = CACHE_VERSION + '-outbox';

const PRECACHE_URLS = [
  './',
  './index.html',
  './admin.html',
  './teacher.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* =========================================================
   INSTALL — precache the essentials
========================================================= */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing v2...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        // Add URLs one at a time so a single failure doesn't block install
        return Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) => console.warn('[SW] Skipped precache:', url, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* =========================================================
   ACTIVATE — clean up old caches
========================================================= */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v2...');
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('donbosco-') && k !== STATIC_CACHE && k !== RUNTIME_CACHE && k !== OUTBOX_CACHE)
          .map((k) => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      ))
      .then(() => self.clients.claim())
  );
});

/* =========================================================
   FETCH — smart caching strategy
   - Firebase / external APIs: bypass (always network)
   - HTML navigations: network-first, fallback to cached index.html
   - Same-origin assets: cache-first with runtime caching
========================================================= */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Skip caching for Firebase, EmailJS, Discord, analytics, fonts CDN
  const host = url.hostname;
  if (
    host.includes('firebase') ||
    host.includes('firebaseio') ||
    host.includes('googleapis') ||
    host.includes('gstatic') ||
    host.includes('emailjs') ||
    host.includes('discord') ||
    host.includes('cloudflareinsights')
  ) {
    // Let the network handle it; do NOT cache
    return;
  }

  // Navigation requests (HTML pages): network-first with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) =>
            hit || caches.match('./index.html') || caches.match('./')
          )
        )
    );
    return;
  }

  // Same-origin assets (images, CSS, JS): cache-first, then network
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req)
          .then((res) => {
            // Cache only successful basic responses
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // Cross-origin: pass-through with graceful failure
  event.respondWith(
    fetch(req).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
  );
});

/* =========================================================
   BACKGROUND SYNC — retry failed requests when back online
   The page can queue failed writes to 'outbox' cache with
   the tag 'donbosco-sync'
========================================================= */
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync fired:', event.tag);
  if (event.tag === 'donbosco-sync' || event.tag === 'donbosco-outbox') {
    event.waitUntil(retryQueuedRequests());
  }
});

async function retryQueuedRequests() {
  try {
    const cache = await caches.open(OUTBOX_CACHE);
    const requests = await cache.keys();
    if (!requests.length) return;

    console.log('[SW] Retrying', requests.length, 'queued requests...');
    await Promise.all(
      requests.map(async (req) => {
        try {
          const res = await fetch(req.clone());
          if (res.ok) {
            await cache.delete(req);
            // Optionally notify open clients
            const clientsList = await self.clients.matchAll();
            clientsList.forEach((client) =>
              client.postMessage({ type: 'SYNC_SUCCESS', url: req.url })
            );
          }
        } catch (err) {
          // Still offline — leave in outbox for next sync
          console.log('[SW] Still offline, keeping queued:', req.url);
        }
      })
    );
  } catch (e) {
    console.warn('[SW] Sync error:', e);
  }
}

/* =========================================================
   PUSH NOTIFICATIONS — parent/teacher/admin alerts
========================================================= */
self.addEventListener('push', (event) => {
  let data = {
    title: 'Don Bosco School',
    body: 'You have a new update.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-96.png',
    tag: 'donbosco-generic',
    url: './index.html'
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = Object.assign(data, payload);
    } catch (e) {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || 'icons/icon-192.png',
      badge: data.badge || 'icons/icon-96.png',
      tag: data.tag || 'donbosco-generic',
      data: { url: data.url || './index.html' },
      vibrate: [80, 40, 80],
      requireInteraction: false,
      silent: false
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientsList) => {
        // Focus an existing window if possible
        for (const client of clientsList) {
          if (client.url.includes(targetUrl) && 'focus' in client) {
            return client.focus();
          }
        }
        // Otherwise open a new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification dismissed:', event.notification.tag);
});

/* =========================================================
   MESSAGE — allow the page to trigger skipWaiting
========================================================= */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CACHE_URLS' && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(RUNTIME_CACHE).then((cache) => cache.addAll(event.data.urls).catch(() => {}))
    );
  }
});

console.log('[SW] Don Bosco service worker v2 loaded');