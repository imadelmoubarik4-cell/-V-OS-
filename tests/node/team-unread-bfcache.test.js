// Audit L20 (team-unread-badge.js sibling): a page kept in the back-forward
// cache only pauses the Messages unread worker. pagehide with persisted:true
// stops the poll and keeps the auth subscription; pageshow with persisted:true
// refreshes at once and polls again. A real unload still unsubscribes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../apps/web/assets/js/team-unread-badge.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, extra = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...extra }); }
  size(type) { return this.listeners.get(type)?.size || 0; }
}

async function boot() {
  let now = 1000000, nextId = 0, unsubscriptions = 0, authListener = null;
  const timers = new Map(), fetches = [];
  const window = new Events(), document = new Events();
  document.hidden = false; document.readyState = 'complete';
  document.getElementById = (id) => (id === 'app-screen' ? { display: 'block' } : id === 'login-screen' ? { display: 'none' } : null);
  window.getComputedStyle = (el) => el;
  window.VABAR_CONFIG = { TEAM_MESSAGES_API: 'https://edge.test/team' };
  window.setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + (delay || 0) }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => 0; window.clearInterval = () => {};
  window.dispatchEvent = () => true;
  window.atlasSupabase = { auth: {
    async getSession() { return { data: { session: { access_token: 't', user: { id: 'u1' } } } }; },
    onAuthStateChange(fn) { authListener = fn; return { data: { subscription: { unsubscribe() { unsubscriptions++; } } } }; }
  } };
  const fetch = async (url) => {
    fetches.push(now);
    return { ok: true, status: 200, async json() { return { snapshot: { summary: { total_unread: 2 }, channels: [] } }; } };
  };
  class ClockDate extends Date { static now() { return now; } }
  vm.runInNewContext(source, { window, document, navigator: {}, fetch, URL, AbortController, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, Date: ClockDate, Math, JSON, console: { warn() {} } });
  await flush();
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); await due[1].fn(); await flush();
    }
    now = target; await flush();
  }
  return { window, document, timers, fetches, advance, unsubscriptions: () => unsubscriptions, authListener: () => authListener, now: () => now };
}

test('back-forward cache: pagehide persisted pauses the unread poll and pageshow resumes it', async () => {
  const app = await boot();
  assert.equal(app.fetches.length, 1, 'first refresh on start');
  await app.advance(8000);
  assert.equal(app.fetches.length, 2, 'polls every 8 s');

  app.window.emit('pagehide', { persisted: true });
  assert.equal(app.timers.size, 0, 'no poll is scheduled while the page sits in the cache');
  assert.equal(app.unsubscriptions(), 0, 'the auth subscription is kept');
  await app.advance(60000);
  assert.equal(app.fetches.length, 2, 'no fetch while paused');

  const restoredAt = app.now();
  app.window.emit('pageshow', { persisted: true });
  await app.advance(0);
  assert.equal(app.fetches.length, 3, 'restored: refreshes at once');
  assert.equal(app.fetches.at(-1), restoredAt);
  await app.advance(8000);
  assert.equal(app.fetches.length, 4, 'and polls again');
  // A normal first pageshow (persisted false) changes nothing.
  app.window.emit('pageshow', { persisted: false });
  await app.advance(0);
  assert.equal(app.fetches.length, 4);

  // A real unload still tears everything down.
  app.window.emit('pagehide', { persisted: false });
  assert.equal(app.unsubscriptions(), 1);
  assert.equal(app.timers.size, 0);
  assert.equal(app.window.size('pagehide') + app.window.size('pageshow'), 0, 'lifecycle listeners removed');
  await app.advance(60000);
  assert.equal(app.fetches.length, 4);
});
