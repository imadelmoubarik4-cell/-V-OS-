'use strict';

// Alcedo PWA service worker.
//   * App-shell cache so the installed app opens instantly and works offline.
//   * Push + notification click handling (unchanged from the push build).
// Bump CACHE whenever the precache list below changes.
const CACHE = 'alcedo-shell-v3';
const SHELL = [
  './',
  './index.html',
  './site.webmanifest',
  './config.js',
  './assets/js/alcedo-icons.js?v=20261026-redesign',
  './assets/fonts/IBMPlexSans-Latin-Variable.woff2',
  './assets/fonts/IBMPlexSans-LatinExt-Variable.woff2',
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

// Known notification routes. 'bookings' (S109) opens the Bookings workspace, and
// deep-links the exact reservation when the payload carries its id.
const ROUTES = new Set(['shifts', 'bookings', 'team']);
const routeOf = (value) => (ROUTES.has(value) ? value : 'team');

// The in-app destination for a route (+ optional object id), relative to scope.
function routeHash(route, objectId) {
  if (route === 'shifts') return '#shifts';
  if (route === 'bookings') return objectId ? `#bookings/res/${encodeURIComponent(objectId)}` : '#bookings';
  // S88 route table: Messages opens at #messages (#team is now the Team directory).
  return '#messages';
}

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch { payload = { body: event.data?.text?.() || '' }; }
  const route = routeOf(payload.route);
  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title || 'Alcedo update', {
      body: payload.body || 'Open Alcedo to review the update.',
      tag: payload.tag || `atlas-${route}`,
      renotify: Boolean(payload.renotify),
      // Brand v1.0 platform icon (supplied kit file, docs/brand/README.md).
      icon: 'assets/brand/favicon-192x192.png',
      data: { route, object_id: payload.object_id || null }
    });
    // Relay to any open client so its in-app notification bell refreshes without
    // polling (the booking inbox works whether or not push delivery is enabled).
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'atlas:push', route });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = routeOf(event.notification.data?.route);
  const objectId = event.notification.data?.object_id || null;
  const target = new URL(`./${routeHash(route, objectId)}`, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    // App was closed: open a fresh window straight at the reservation.
    return clients.openWindow(target);
  })());
});
