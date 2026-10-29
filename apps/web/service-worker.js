'use strict';

// Alcedo PWA service worker.
//   * App-shell cache so the installed app opens instantly and works offline.
//   * Push + notification click handling.
// Bump CACHE whenever the precache list below or the caching rules change.
const CACHE = 'alcedo-shell-v5';
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

// The app shell's own paths inside the scope ('/' and '/index.html'). Only a
// navigation to one of these may replace the cached shell (L21): other pages
// in scope (recovery.html, invitation.html, menu.html, a 404) never do.
const SCOPE_PATH = new URL('./', self.location.href).pathname;
const isShellPath = (pathname) => pathname === SCOPE_PATH || pathname === `${SCOPE_PATH}index.html`;
// Only a complete, same-origin 200 is stored (never an error, a redirect, a
// partial 206 or an opaque response).
const storable = (response) => Boolean(response && response.status === 200 && response.type === 'basic' && !response.redirected);

// Stores a response and drops every other entry for the same file under an
// older ?v= key, so the cache keeps one copy per file instead of growing with
// each release (L27).
async function store(cache, request, response) {
  const url = new URL(typeof request === 'string' ? request : request.url, self.location.href);
  const keys = await cache.keys();
  await Promise.all(keys
    .filter((key) => { const old = new URL(key.url); return old.pathname === url.pathname && old.href !== url.href; })
    .map((key) => cache.delete(key)));
  await cache.put(request, response);
}

// App-shell navigations: network-first, so an online open always gets the
// latest HTML, with the cached shell as the offline fallback.
async function navigation(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (isShellPath(new URL(request.url).pathname) && storable(fresh)) {
      event.waitUntil(cache.put('./index.html', fresh.clone()));
    }
    return fresh;
  } catch {
    // Offline: the latest shell (only the shell is ever stored for navigations).
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

// Versioned assets (?v=): the key changes whenever the file does, so a cached
// copy is final. Served from cache with no background re-download; a miss is
// fetched once and stored (L27).
async function cacheFirst(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (storable(response)) event.waitUntil(store(cache, request, response.clone()));
  return response;
}

// Unversioned scripts and styles, config.js above all (endpoints, kill
// switches, module keys): network-first, so an online open never runs an old
// copy; the cached copy is the offline fallback (M10).
async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (storable(response)) event.waitUntil(store(cache, request, response.clone()));
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

// Other unversioned files (fonts, icons, images): stale-while-revalidate,
// served from cache and refreshed in the background for next time.
async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (storable(response)) event.waitUntil(store(cache, request, response.clone()));
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => null));
    return cached;
  }
  return network;
}

const SCRIPT_OR_STYLE = /\.(?:m?js|css)$/i;

// Same-origin GET only. Cross-origin requests (the Supabase API, which needs a
// live authenticated response) pass straight through and are never cached.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(event));
    return;
  }
  // A request that bypasses the HTTP cache (cache: 'no-store' or 'reload')
  // bypasses this one too: it goes straight to the network (M10).
  if (request.cache === 'no-store' || request.cache === 'reload') return;
  if (url.searchParams.has('v')) {
    event.respondWith(cacheFirst(event));
    return;
  }
  if (SCRIPT_OR_STYLE.test(url.pathname) || request.destination === 'script' || request.destination === 'style') {
    event.respondWith(networkFirst(event));
    return;
  }
  event.respondWith(staleWhileRevalidate(event));
});

// Known notification routes. 'bookings' (S109) opens the Bookings workspace, and
// deep-links the exact reservation when the payload carries its id.
// 'marketing' (S108 route allow-list) opens Marketing.
const ROUTES = new Set(['shifts', 'bookings', 'team', 'marketing']);
const routeOf = (value) => (ROUTES.has(value) ? value : 'team');

// Optional deep-link details a payload may carry in `params` (L19). Each is
// validated; anything else is ignored and the plain route opens.
//   visit_date   the booking's venue-local day (YYYY-MM-DD, a real date)
//   channel_key  the Messages channel
function visitDateOf(value) {
  const text = typeof value === 'string' ? value : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}
function channelKeyOf(value) {
  const text = typeof value === 'string' ? value : '';
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(text) ? text : null;
}
function paramsOf(value) {
  const source = value && typeof value === 'object' ? value : {};
  const params = {};
  const visitDate = visitDateOf(source.visit_date);
  const channelKey = channelKeyOf(source.channel_key);
  if (visitDate) params.visit_date = visitDate;
  if (channelKey) params.channel_key = channelKey;
  return params;
}
const objectIdOf = (value) => (typeof value === 'string' || typeof value === 'number') && String(value).length && String(value).length <= 128 ? String(value) : null;

// The in-app destination for a route (+ optional object id and params),
// relative to scope.
function routeHash(route, objectId, params = {}) {
  if (route === 'shifts') return '#shifts';
  if (route === 'marketing') return '#marketing';
  if (route === 'bookings') {
    if (!objectId) return '#bookings';
    // The booking's own day, like the in-app bell (a booking on another day is
    // not in today's snapshot).
    const date = visitDateOf(params.visit_date);
    return date ? `#bookings/res/${encodeURIComponent(objectId)}/${date}` : `#bookings/res/${encodeURIComponent(objectId)}`;
  }
  // S88 route table: Messages opens at #messages (#team is now the Team directory).
  const channel = channelKeyOf(params.channel_key);
  return channel ? `#messages/${encodeURIComponent(channel)}` : '#messages';
}

// One notification per booking and per Messages channel (L18): a second
// booking no longer silently replaces the first. A notification that does
// replace one with the same tag alerts again (renotify).
function tagFor(route, objectId, params) {
  if (route === 'bookings' && objectId) return `atlas-bookings-${objectId}`;
  if (route === 'team' && params.channel_key) return `atlas-team-${params.channel_key}`;
  return `atlas-${route}`;
}

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch { payload = { body: event.data?.text?.() || '' }; }
  const route = routeOf(payload.route);
  const objectId = objectIdOf(payload.object_id);
  const params = paramsOf(payload.params);
  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title || 'Alcedo update', {
      body: payload.body || 'Open Alcedo to review the update.',
      tag: (typeof payload.tag === 'string' && payload.tag) || tagFor(route, objectId, params),
      renotify: payload.renotify === undefined ? true : Boolean(payload.renotify),
      // Brand v1.0 platform icon (supplied kit file, docs/brand/README.md).
      icon: 'assets/brand/favicon-192x192.png',
      data: { route, object_id: objectId, params }
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
  const objectId = objectIdOf(event.notification.data?.object_id);
  const params = paramsOf(event.notification.data?.params);
  const target = new URL(`./${routeHash(route, objectId, params)}`, self.registration.scope).href;
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
