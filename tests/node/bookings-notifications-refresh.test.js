import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../apps/web/assets/js/bookings-notifications.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, detail) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, detail }); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

async function boot({ seconds = 60, enabled = true, role = 'manager', profile = true } = {}) {
  let now = 1000000, nextId = 0, session = { user: { id: 'manager-id' }, access_token: 'test-token' };
  let authListener, responder = async () => ({ status: 200, items: [], unread: 0 });
  const timers = new Map(), calls = [], warnings = [], bell = new Map();
  const window = new Events(), document = new Events(), serviceWorker = new Events();
  const navigator = { onLine: true, serviceWorker };
  document.visibilityState = 'visible'; document.hidden = false; document.readyState = 'complete';
  let signedIn = true, unsubscriptions = 0;
  document.getElementById = (id) => id === 'app-screen' ? { display: signedIn ? 'block' : 'none' } : { display: signedIn ? 'none' : 'block' };
  window.getComputedStyle = (el) => el;
  window.VABAR_CONFIG = { BOOKING_NOTIFICATIONS_ENABLED: enabled, BOOKING_NOTIFICATIONS_REFRESH_SECONDS: seconds, BOOKINGS_API: 'https://edge.test/bookings' };
  window.atlasCurrentProfile = profile ? { id: 'manager-id', role, active: true } : null;
  window.setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.AtlasShell = { actions: { register() {} }, notify: { contribute(key, fn) { bell.set(key, fn); }, markRead() {} }, on() { return () => {}; } };
  window.atlasSupabase = { auth: {
    async getSession() { return { data: { session } }; },
    onAuthStateChange(fn) { authListener = fn; return { data: { subscription: { unsubscribe() { unsubscriptions++; } } } }; }
  } };
  const fetch = async (url, options) => {
    const call = { at: now, url: String(url), signal: options.signal };
    calls.push(call);
    const result = await responder(call);
    return { status: result.status, ok: result.status >= 200 && result.status < 300, async json() { return { items: result.items, unread: result.unread }; } };
  };
  class ClockDate extends Date { static now() { return now; } }
  const math = Object.create(Math); math.random = () => 0.5;
  vm.runInNewContext(source, { window, document, navigator, fetch, URL, AbortController, Date: ClockDate, Math: math, console: { warn: (msg) => warnings.push(msg) } });
  await flush();
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = target; await flush();
  }
  return {
    window, document, navigator, calls, warnings, timers, advance,
    api: window.AtlasBookingsNotifications,
    respond(fn) { responder = fn; },
    auth(event, nextSession) { session = nextSession; signedIn = Boolean(session); authListener?.(event, session); },
    profile(role, id = 'manager-id') { window.atlasCurrentProfile = role ? { id, role, active: true } : null; window.emit('atlas:profile-ready'); },
    visibility(visible) { document.visibilityState = visible ? 'visible' : 'hidden'; document.hidden = !visible; document.emit('visibilitychange'); },
    online(value) { navigator.onLine = value; window.emit(value ? 'online' : 'offline'); },
    unsubscriptions: () => unsubscriptions,
    bell: () => [...bell.values()].flatMap((fn) => fn({ role: window.atlasCurrentProfile?.role }))
  };
}

test('inbox timed refresh is default-off and rejects invalid intervals', async () => {
  for (const seconds of [undefined, 0, -1, 29, 301, 60.5, '60', NaN]) {
    const app = await boot({ seconds: seconds === undefined ? 0 : seconds });
    if (seconds === undefined) delete app.window.VABAR_CONFIG.BOOKING_NOTIFICATIONS_REFRESH_SECONDS;
    await app.advance(600000);
    assert.equal(app.calls.length, 1, String(seconds));
    assert.equal(app.timers.size, 0);
  }
});

test('master flag off is completely inert even with an interval', async () => {
  const app = await boot({ enabled: false });
  await app.advance(600000);
  assert.equal(app.calls.length, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.window.count() + app.document.count(), 0);
});

test('visible managers receive a new inbox item and unread count without user action', async () => {
  const app = await boot();
  app.respond(async () => ({ status: 200, items: [{ id: 'new-request', reservation_id: 'res-1', title: 'New booking request', kind: 'request', read: false }], unread: 1 }));
  await app.advance(59999); assert.equal(app.calls.length, 1);
  await app.advance(1);
  assert.equal(app.calls.length, 2);
  assert.equal(app.api.count(), 1);
  assert.equal(app.bell()[0].action.reservationId, 'res-1');
  assert.match(app.calls[1].url, /limit=30/);
  await app.advance(60000); assert.equal(app.calls.length, 3);
});

test('bartenders, viewers and unknown profiles never schedule timed requests', async () => {
  for (const options of [{ role: 'bartender' }, { role: 'viewer' }, { profile: false }]) {
    const app = await boot(options);
    await app.advance(600000);
    assert.equal(app.calls.length, 1);
    assert.equal(app.timers.size, 0);
  }
});

test('403 stops refresh for the session and clears the bell', async () => {
  const app = await boot();
  app.respond(async () => ({ status: 403 }));
  await app.advance(60000);
  await app.advance(600000);
  app.window.emit('focus'); await flush();
  assert.equal(app.calls.length, 2);
  assert.equal(app.api.count(), 0);
  assert.equal(app.timers.size, 0);
});

test('hidden and offline tabs stop; visibility and online resume with one request', async () => {
  const app = await boot();
  app.visibility(false); await app.advance(600000);
  assert.equal(app.calls.length, 1);
  app.visibility(true); await flush();
  assert.equal(app.calls.length, 2);
  await app.advance(60000); assert.equal(app.calls.length, 3);
  app.online(false); await app.advance(600000); assert.equal(app.calls.length, 3);
  app.online(true); await flush(); assert.equal(app.calls.length, 4);
  await app.advance(60000); assert.equal(app.calls.length, 5);
});

test('sign-out aborts a pending request and late data cannot repopulate another user inbox', async () => {
  const app = await boot();
  let resolve;
  app.respond(() => new Promise((done) => { resolve = done; }));
  const pending = app.api.refresh({ force: true }); await flush();
  const signal = app.calls.at(-1).signal;
  app.auth('SIGNED_OUT', null);
  assert.equal(signal.aborted, true);
  assert.equal(app.api.count(), 0);
  resolve({ status: 200, items: [{ id: 'old-user-row' }], unread: 1 });
  await pending; await app.advance(600000);
  assert.equal(app.calls.length, 2);
  assert.equal(app.api.items().length, 0);
  app.profile('bartender', 'bartender-id');
  app.respond(async () => ({ status: 403 }));
  app.auth('SIGNED_IN', { user: { id: 'bartender-id' }, access_token: 'other-token' });
  await flush(); const count = app.calls.length;
  await app.advance(600000); assert.equal(app.calls.length, count);
});

test('slow requests, concurrent auth lookups and focus events never overlap requests', async () => {
  const app = await boot();
  let finish;
  app.respond(() => new Promise((resolve) => { finish = resolve; }));
  const first = app.api.refresh({ force: true });
  const second = app.api.refresh({ force: true });
  app.window.emit('focus'); await flush();
  assert.equal(app.calls.length, 2);
  await app.advance(5000); assert.equal(app.calls.length, 2);
  finish({ status: 200, items: [], unread: 0 }); await first; await second;
  app.respond(async () => ({ status: 200, items: [], unread: 0 }));
  app.window.emit('focus'); await flush(); assert.equal(app.calls.length, 2);
  await app.advance(60000); assert.equal(app.calls.length, 3);
});

test('timed failures back off to 120, 240 and 300 seconds, then success resets to 60', async () => {
  const app = await boot();
  app.respond(async () => ({ status: 503 }));
  await app.advance(60000); assert.equal(app.calls.length, 2);
  await app.advance(119999); assert.equal(app.calls.length, 2);
  await app.advance(1); assert.equal(app.calls.length, 3);
  await app.advance(240000); assert.equal(app.calls.length, 4);
  app.respond(async () => ({ status: 200, items: [], unread: 0 }));
  await app.advance(300000); assert.equal(app.calls.length, 5);
  await app.advance(60000); assert.equal(app.calls.length, 6);
  assert.deepEqual(app.warnings, []);
});

test('401 suspends timed refreshes until auth renews; no renewal loop', async () => {
  const app = await boot();
  app.respond(async () => ({ status: 401 }));
  await app.advance(60000); await app.advance(600000);
  assert.equal(app.calls.length, 2);
  app.respond(async () => ({ status: 200, items: [], unread: 0 }));
  app.auth('TOKEN_REFRESHED', { user: { id: 'manager-id' }, access_token: 'renewed' });
  await flush(); assert.equal(app.calls.length, 3);
  await app.advance(60000); assert.equal(app.calls.length, 4);
});

test('role changes and pagehide clean up timers, listeners and auth subscription', async () => {
  const app = await boot();
  app.profile('viewer'); await app.advance(600000); assert.equal(app.calls.length, 1);
  app.profile('admin'); await app.advance(60000); assert.equal(app.calls.length, 2);
  app.window.emit('pagehide');
  assert.equal(app.unsubscriptions(), 1);
  assert.equal(app.timers.size, 0);
  assert.equal(app.window.count() + app.document.count() + app.navigator.serviceWorker.count(), 0);
  app.window.emit('focus'); await app.advance(600000);
  assert.equal(app.calls.length, 2);
  assert.equal(app.api.count(), 0);
});
