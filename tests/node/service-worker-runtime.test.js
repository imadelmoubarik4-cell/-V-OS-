// The PWA service worker, run for real (vm) against a fake `self`, `caches`
// and `fetch` (platform audit M10, L18, L19, L21, L27):
//   * config.js and other unversioned scripts and styles are network-first,
//     with the cached copy only as the offline fallback (M10);
//   * a request with cache: 'no-store' or 'reload' never comes from the cache (M10);
//   * ?v= assets are cache-first with no background re-download, and the cache
//     keeps one entry per file across key generations (L27);
//   * only a good navigation to the shell itself replaces the cached shell (L21);
//   * pushes get one tag per booking / channel and re-alert (L18);
//   * notification clicks open Marketing, the booking's own day and the
//     Messages channel, ignoring invalid details (L19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync('apps/web/service-worker.js', 'utf8');
const ORIGIN = 'https://alcedo.test';
const SW_URL = `${ORIGIN}/service-worker.js`;
const abs = (url) => { const parsed = new URL(url, SW_URL); parsed.hash = ''; return parsed.href; };

function response(body, { status = 200, type = 'basic', redirected = false } = {}) {
  return { body, status, ok: status >= 200 && status < 300, type, redirected, clone() { return response(body, { status, type, redirected }); } };
}

function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async match(request) { return entries.get(abs(typeof request === 'string' ? request : request.url)) || undefined; },
    async put(request, value) { entries.set(abs(typeof request === 'string' ? request : request.url), value); },
    async add(request) { const value = await this.fetcher(request); if (value.ok) await this.put(request, value); },
    async keys() { return [...entries.keys()].map((url) => ({ url })); },
    async delete(request) { return entries.delete(abs(typeof request === 'string' ? request : request.url)); }
  };
}

// Loads the worker. `network` maps an absolute URL to a response, or to
// 'offline' (the fetch rejects). Every fetch is recorded.
function loadWorker() {
  const handlers = {};
  const fetches = [];
  const network = new Map();
  const shown = [];
  const opened = [];
  const stores = new Map();
  const fetcher = async (request) => {
    const url = abs(typeof request === 'string' ? request : request.url);
    fetches.push(url);
    const value = network.get(url);
    if (!value || value === 'offline') throw new TypeError('Failed to fetch');
    return value.clone();
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) { const cache = fakeCache(); cache.fetcher = fetcher; stores.set(name, cache); }
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  const clients = {
    windows: [],
    async matchAll() { return this.windows; },
    async openWindow(url) { opened.push(url); return null; },
    async claim() {}
  };
  const self = {
    location: new URL(SW_URL),
    registration: { scope: `${ORIGIN}/`, async showNotification(title, options) { shown.push({ title, ...options }); } },
    clients,
    skipWaiting: async () => {},
    addEventListener(type, handler) { handlers[type] = handler; }
  };
  class Request { constructor(url, init = {}) { this.url = abs(url); this.cache = init.cache || 'default'; this.method = 'GET'; } }
  const context = vm.createContext({ self, caches, clients, fetch: fetcher, URL, Request, Response: { error: () => ({ error: true }) }, console, encodeURIComponent });
  vm.runInContext(SOURCE, context, { filename: 'service-worker.js' });
  const cacheName = SOURCE.match(/const CACHE = '([^']+)';/)[1];

  async function dispatch(type, event) {
    const pending = [];
    let responded = null;
    const full = { ...event, waitUntil(promise) { pending.push(promise); }, respondWith(promise) { responded = promise; } };
    handlers[type](full);
    const result = responded ? await responded : undefined;
    // waitUntil may be called while the response settles; drain until quiet.
    for (let index = 0; index < pending.length; index += 1) await pending[index];
    return { responded: Boolean(responded), result };
  }
  const request = (url, init = {}) => ({ url: abs(url), method: 'GET', mode: init.mode || 'cors', cache: init.cache || 'default', destination: init.destination || '' });
  return {
    network, fetches, shown, opened, clients, caches,
    cache: () => caches.open(cacheName),
    fetch: (url, init) => dispatch('fetch', { request: request(url, init) }),
    install: () => dispatch('install', {}),
    activate: () => dispatch('activate', {}),
    push: (payload) => dispatch('push', { data: { json: () => payload } }),
    click: (data) => dispatch('notificationclick', { notification: { data, close() {} } })
  };
}

test('M10: config.js is network-first; the cached copy is only the offline fallback', async () => {
  const sw = loadWorker();
  sw.network.set(abs('./config.js'), response('flags v1'));
  await sw.install();
  assert.equal((await (await sw.cache()).match('./config.js')).body, 'flags v1', 'precached');

  // The owner flips a kill switch: the next online open runs the new config.
  sw.network.set(abs('./config.js'), response('flags v2'));
  sw.fetches.length = 0;
  const online = await sw.fetch('./config.js', { destination: 'script' });
  assert.equal(online.result.body, 'flags v2', 'online: the network copy, not the precached one');
  assert.deepEqual(sw.fetches, [abs('./config.js')]);
  assert.equal((await (await sw.cache()).match('./config.js')).body, 'flags v2', 'the fallback copy is refreshed');

  // Offline: the last good copy.
  sw.network.set(abs('./config.js'), 'offline');
  const offline = await sw.fetch('./config.js', { destination: 'script' });
  assert.equal(offline.result.body, 'flags v2');
});

test('M10: other unversioned scripts and styles are network-first too', async () => {
  const sw = loadWorker();
  const cache = await sw.cache();
  await cache.put('./assets/js/notifications.js', response('old notifications'));
  await cache.put('./assets/css/team-profile-photos.css', response('old photos css'));
  sw.network.set(abs('./assets/js/notifications.js'), response('new notifications'));
  sw.network.set(abs('./assets/css/team-profile-photos.css'), response('new photos css'));
  assert.equal((await sw.fetch('./assets/js/notifications.js')).result.body, 'new notifications');
  assert.equal((await sw.fetch('./assets/css/team-profile-photos.css', { destination: 'style' })).result.body, 'new photos css');
});

test('M10: a no-store or reload request is never answered from the cache', async () => {
  const sw = loadWorker();
  const cache = await sw.cache();
  await cache.put('./assets/js/team-profiles.bundle.gz', response('stale bundle'));
  await cache.put('./assets/js/home.js?v=1', response('stale home'));
  for (const mode of ['no-store', 'reload']) {
    assert.equal((await sw.fetch('./assets/js/team-profiles.bundle.gz', { cache: mode })).responded, false, `${mode}: straight to the network`);
    assert.equal((await sw.fetch('./assets/js/home.js?v=1', { cache: mode })).responded, false, `${mode}: versioned too`);
  }
});

test('L27: ?v= assets are cache-first with no re-download, and one entry per file remains', async () => {
  const sw = loadWorker();
  sw.network.set(abs('./assets/js/home.js?v=1'), response('home 1'));
  assert.equal((await sw.fetch('./assets/js/home.js?v=1')).result.body, 'home 1', 'a miss is fetched');
  sw.fetches.length = 0;
  sw.network.set(abs('./assets/js/home.js?v=1'), response('home 1 rebuilt'));
  assert.equal((await sw.fetch('./assets/js/home.js?v=1')).result.body, 'home 1', 'a hit is final');
  assert.deepEqual(sw.fetches, [], 'no background re-download of an immutable key');

  // Two newer key generations: the cache keeps only the current one.
  for (const key of ['2', '3']) {
    sw.network.set(abs(`./assets/js/home.js?v=${key}`), response(`home ${key}`));
    assert.equal((await sw.fetch(`./assets/js/home.js?v=${key}`)).result.body, `home ${key}`);
  }
  const homes = [...(await sw.cache()).entries.keys()].filter((url) => new URL(url).pathname === '/assets/js/home.js');
  assert.deepEqual(homes, [abs('./assets/js/home.js?v=3')]);

  // Offline with nothing cached: the request fails, as without the worker.
  sw.network.set(abs('./assets/js/home.js?v=4'), 'offline');
  await assert.rejects(sw.fetch('./assets/js/home.js?v=4'));
});

test('L27: an error, a redirect or a partial response is never stored', async () => {
  const sw = loadWorker();
  sw.network.set(abs('./assets/js/a.js?v=1'), response('missing', { status: 404 }));
  sw.network.set(abs('./assets/js/b.js?v=1'), response('moved', { redirected: true }));
  sw.network.set(abs('./assets/video.mp4'), response('part', { status: 206 }));
  await sw.fetch('./assets/js/a.js?v=1');
  await sw.fetch('./assets/js/b.js?v=1');
  await sw.fetch('./assets/video.mp4');
  assert.deepEqual([...(await sw.cache()).entries.keys()], []);
});

test('L21: only a good navigation to the shell replaces the cached shell', async () => {
  const sw = loadWorker();
  sw.network.set(abs('./'), response('shell v1'));
  sw.network.set(abs('./index.html'), response('shell v1'));
  await sw.install();
  const shell = async () => (await (await sw.cache()).match('./index.html')).body;
  assert.equal(await shell(), 'shell v1');

  // Recovery, invitation and the public menu are in scope but are not the shell.
  for (const page of ['./recovery.html', './invitation.html', './menu.html']) {
    sw.network.set(abs(page), response(`${page} page`));
    assert.equal((await sw.fetch(page, { mode: 'navigate' })).result.body, `${page} page`);
  }
  // A Netlify 404, a 500 for the shell and a redirected shell are not stored either.
  sw.network.set(abs('./missing'), response('not found', { status: 404 }));
  await sw.fetch('./missing', { mode: 'navigate' });
  sw.network.set(abs('./'), response('server error', { status: 500 }));
  assert.equal((await sw.fetch('./', { mode: 'navigate' })).result.body, 'server error', 'the error page still shows online');
  sw.network.set(abs('./'), response('elsewhere', { redirected: true }));
  await sw.fetch('./', { mode: 'navigate' });
  assert.equal(await shell(), 'shell v1', 'the shell survives');

  // A good shell navigation (either path) updates it.
  sw.network.set(abs('./index.html'), response('shell v2'));
  await sw.fetch('./index.html#home', { mode: 'navigate' });
  assert.equal(await shell(), 'shell v2');
  sw.network.set(abs('./'), response('shell v3'));
  await sw.fetch('./', { mode: 'navigate' });
  assert.equal(await shell(), 'shell v3');

  // Offline: every navigation opens the latest shell, never another page.
  sw.network.clear();
  assert.equal((await sw.fetch('./recovery.html', { mode: 'navigate' })).result.body, 'shell v3', 'never the recovery page as the app');
  assert.equal((await sw.fetch('./', { mode: 'navigate' })).result.body, 'shell v3');
  assert.equal((await sw.fetch('./index.html#inventory', { mode: 'navigate' })).result.body, 'shell v3');
});

test('activate keeps only the current cache', async () => {
  const sw = loadWorker();
  await sw.caches.open('alcedo-shell-v3');
  await sw.cache();
  await sw.activate();
  assert.deepEqual(await sw.caches.keys(), [SOURCE.match(/const CACHE = '([^']+)';/)[1]]);
  assert.notEqual(SOURCE.match(/const CACHE = '([^']+)';/)[1], 'alcedo-shell-v3', 'CACHE was bumped with the new rules');
});

test('L18: each booking and each Messages channel gets its own tag and re-alerts', async () => {
  const sw = loadWorker();
  await sw.push({ title: 'Booking request', route: 'bookings', object_id: 'res-1' });
  await sw.push({ title: 'Booking request', route: 'bookings', object_id: 'res-2' });
  await sw.push({ title: 'New message', route: 'team', object_id: 'msg-1', params: { channel_key: 'general' } });
  await sw.push({ title: 'New message', route: 'team', object_id: 'msg-2', params: { channel_key: 'announcements' } });
  await sw.push({ title: 'Shift', route: 'shifts' });
  const tags = sw.shown.map((item) => item.tag);
  assert.deepEqual(tags, ['atlas-bookings-res-1', 'atlas-bookings-res-2', 'atlas-team-general', 'atlas-team-announcements', 'atlas-shifts']);
  assert.ok(sw.shown.every((item) => item.renotify === true), 'a replaced notification alerts again');
  // An explicit server tag and renotify still win.
  await sw.push({ route: 'bookings', object_id: 'res-3', tag: 'server-tag', renotify: false });
  assert.equal(sw.shown.at(-1).tag, 'server-tag');
  assert.equal(sw.shown.at(-1).renotify, false);
});

test('L19: notification clicks open Marketing, the booking day and the channel; invalid details are ignored', async () => {
  const sw = loadWorker();
  const open = async (data) => { sw.opened.length = 0; await sw.click(data); return sw.opened[0].slice(ORIGIN.length); };
  assert.equal(await open({ route: 'marketing' }), '/#marketing');
  assert.equal(await open({ route: 'shifts' }), '/#shifts');
  assert.equal(await open({ route: 'bookings' }), '/#bookings');
  assert.equal(await open({ route: 'bookings', object_id: 'res-1' }), '/#bookings/res/res-1');
  assert.equal(await open({ route: 'bookings', object_id: 'res-1', params: { visit_date: '2026-10-28' } }), '/#bookings/res/res-1/2026-10-28');
  for (const bad of ['2026-02-30', '2026-13-01', '28-10-2026', '../2026-10-28', 20261028, null]) {
    assert.equal(await open({ route: 'bookings', object_id: 'res-1', params: { visit_date: bad } }), '/#bookings/res/res-1', `ignores ${bad}`);
  }
  assert.equal(await open({ route: 'team', params: { channel_key: 'general' } }), '/#messages/general');
  for (const bad of ['../settings', 'a b', '', '#x', 'x'.repeat(65)]) {
    assert.equal(await open({ route: 'team', params: { channel_key: bad } }), '/#messages', `ignores ${bad}`);
  }
  assert.equal(await open({ route: 'unknown' }), '/#messages', 'unknown routes fall back to Messages');

  // The push stores only validated details for the click.
  await sw.push({ route: 'bookings', object_id: 'res-9', params: { visit_date: '2026-10-29', extra: 'x' } });
  assert.deepEqual({ ...sw.shown.at(-1).data, params: { ...sw.shown.at(-1).data.params } }, { route: 'bookings', object_id: 'res-9', params: { visit_date: '2026-10-29' } });

  // An open window is navigated and focused instead of opening a new one.
  const navigated = [];
  sw.clients.windows = [{ url: `${ORIGIN}/index.html#home`, async navigate(url) { navigated.push(url); }, focus() { return this; } }];
  await sw.click({ route: 'marketing' });
  assert.deepEqual(navigated, [`${ORIGIN}/#marketing`]);
});
