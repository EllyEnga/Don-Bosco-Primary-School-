/* Don Bosco School Portal — Service Worker v2 */
const CACHE_VERSION = 'donbosco-v2';
const STATIC_CACHE = CACHE_VERSION + '-static';

const PRECACHE_URLS = [
  './',
  './index.html',
  './admin.html',
  './teacher.html',
  './manifest.json'
];

/* ---------- INSTALL ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

/* ---------- ACTIVATE ---------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('donbosco-') && k !== CACHE_VERSION && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ---------- FETCH (network-first for API, cache-first for static) ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Firebase / external APIs
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') ||
      url.hostname.includes('gstatic') || url.hostname.includes('emailjs') ||
      url.hostname.includes('discord')) return;

  // Same-origin HTML: network-first, fallback to cache
  if (req.mode === 'navigate' || url.origin === location.origin) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Everything else: cache-first
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => new Response('', { status: 503 })))
  );
});

/* ---------- BACKGROUND SYNC (retries failed requests) ---------- */
self.addEventListener('sync', event => {
  if (event.tag === 'donbosco-sync') {
    event.waitUntil(retryQueuedRequests());
  }
});

async function retryQueuedRequests() {
  try {
    const cache = await caches.open('donbosco-outbox');
    const keys = await cache.keys();
    await Promise.all(keys.map(async req => {
      try {
        const res = await fetch(req.clone());
        if (res.ok) await cache.delete(req);
      } catch (e) { /* still offline, retry next time */ }
    }));
  } catch (e) { /* no outbox yet */ }
}

/* ---------- PUSH NOTIFICATIONS ---------- */
self.addEventListener('push', event => {
  let data = { title: 'Don Bosco School', body: 'You have a new update.', icon: 'icons/icon-192.png' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) {}

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.icon || 'icons/icon-192.png',
    badge: 'icons/icon-96.png',
    tag: data.tag || 'donbosco-generic',
    data: { url: data.url || './index.html' },
    vibrate: [80, 40, 80],
    requireInteraction: false
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(targetUrl) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

/* ---------- MESSAGE (for skipWaiting from page) ---------- */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
