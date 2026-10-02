'use strict';

// Alcedo PWA service worker.
//   * App-shell cache so the installed app opens instantly and works offline.
//   * Push + notification click handling (unchanged from the push build).
// Bump CACHE whenever the precache list below changes.
const CACHE = 'alcedo-shell-v1';
const SHELL = [
  './',
  './index.html',
  './site.webmanifest',
  './config.js',
  './assets/brand/favicon-192x192.png',
  './assets/brand/favicon-512x512.png',
  './assets/brand/favicon.svg',
  './assets/brand/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // Best-effort precache: one missing file must never abort the install.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Same-origin GET only. Cross-origin requests (the Supabase API, which needs a
// live authenticated response) pass straight through and are never cached.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App-shell navigations: network-first, so an online open always gets the
  // latest HTML, with the cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Static assets (versioned with ?v=): stale-while-revalidate — served instantly
  // from cache, refreshed in the background for next time.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    }).catch(() => cached);
    return cached || network;
  })());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch { payload = { body: event.data?.text?.() || '' }; }
  const route = payload.route === 'shifts' ? 'shifts' : 'team';
  event.waitUntil(self.registration.showNotification(payload.title || 'Alcedo update', {
    body: payload.body || 'Open Alcedo to review the update.',
    tag: payload.tag || `atlas-${route}`,
    renotify: Boolean(payload.renotify),
    // Brand v1.0 platform icon (supplied kit file, docs/brand/README.md).
    icon: 'assets/brand/favicon-192x192.png',
    data: { route, object_id: payload.object_id || null }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = event.notification.data?.route === 'shifts' ? 'shifts' : 'team';
  // S88 route table: Messages opens at #messages (#team is now the Team directory).
  const target = new URL(`./#${route === 'shifts' ? 'shifts' : 'messages'}`, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  })());
});
