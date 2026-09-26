// Atlas browser harness.
//
// Runs the real apps/web shell and every runtime module in Chromium against a
// mocked Supabase project. Nothing here talks to production: REST, RPC, Auth,
// Storage and Edge Function traffic is intercepted and answered from fixtures,
// and every request is recorded so tests can assert what the UI actually sent.
//
// Third-party browser libraries are served from local npm installs because the
// CDN hosts are not reachable from CI sandboxes. The npm supabase-js build is
// not byte-identical to the CDN build, so the harness copy of index.html drops
// the pinned SRI attribute; the repository file keeps it.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
const WEB = path.join(ROOT, 'apps/web');
// localhost is a secure context, like production HTTPS (crypto.randomUUID,
// service workers and PushManager behave as they do in production).
export const ORIGIN = 'http://localhost:4173';
export const SUPABASE = 'https://dnefgcmjcgxlynycxkts.supabase.co';
export const PROJECT_REF = 'dnefgcmjcgxlynycxkts';
// Every page runs on a frozen clock so no test depends on the wall clock
// (greetings, business dates, freshness windows). A test file passes its own
// fixture time as fixedTime; the default is this Thursday afternoon in
// Reykjavik. Fixtures build their dates from the same anchor (fixtureTime).
export const HARNESS_NOW = '2026-09-24T14:00:00.000Z';
export const HARNESS_NOW_MS = Date.parse(HARNESS_NOW);
/** ISO time `offsetMs` from the harness anchor (never the wall clock). */
export function fixtureTime(offsetMs = 0) {
  return new Date(HARNESS_NOW_MS + offsetMs).toISOString();
}
// Far-future token expiry, so a frozen page clock never sees the session expire.
const SESSION_EXPIRES_AT = 4102444800; // 2100-01-01

function resolveLibraries() {
  const roots = [process.env.ATLAS_BROWSER_LIBS, path.join(ROOT, 'node_modules'), path.join(here, 'node_modules')]
    .filter(Boolean);
  for (const base of roots) {
    const supabase = path.join(base, '@supabase/supabase-js/dist/umd/supabase.js');
    const lucide = path.join(base, 'lucide/dist/umd/lucide.min.js');
    if (existsSync(supabase) && existsSync(lucide)) return { supabase, lucide };
  }
  return null;
}

export function loadPlaywright() {
  const candidates = [process.env.ATLAS_PLAYWRIGHT, path.join(ROOT, 'node_modules/playwright'), 'playwright']
    .filter(Boolean);
  for (const candidate of candidates) {
    try { return createRequire(import.meta.url)(candidate); } catch { /* try the next location */ }
  }
  try {
    const globalRoot = path.join(path.dirname(process.execPath), '../lib/node_modules/playwright');
    return createRequire(import.meta.url)(globalRoot);
  } catch { return null; }
}

export function harnessAvailable() {
  return Boolean(loadPlaywright() && resolveLibraries());
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.gz': 'application/gzip', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.webm': 'video/webm', '.mp4': 'video/mp4'
};

export const USERS = {
  admin: { id: 'b9a22f65-e180-429b-8531-008fd08d31aa', email: 'owner@example.test', display_name: 'Imad El Moubarik', role: 'admin', active: true },
  bartender: { id: '7d3c1f10-0000-4000-8000-000000000002', email: 'sara.bartender@example.test', display_name: 'Sara Jónsdóttir', role: 'bartender', active: true }
};

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function sessionFor(user) {
  const token = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: user.id, email: user.email, role: 'authenticated', exp: SESSION_EXPIRES_AT })}.harness`;
  return {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: SESSION_EXPIRES_AT, refresh_token: 'harness-refresh',
    user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', user_metadata: {}, app_metadata: {} }
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
}

/**
 * Launch the app. `fixtures` shapes the mocked backend:
 *   tables:    { tableName: rows[] }            (PostgREST GET)
 *   rpc:       { name: result | (body) => result }
 *   functions: { 'atlas-x': (ctx) => ({ status, body }) | body | { __raw: { status, contentType, body } } }
 * `contextOptions` is passed to browser.newContext (for example { hasTouch: true }).
 */
export async function launchAtlas({ user = USERS.admin, fixtures = {}, viewport = { width: 1440, height: 900 }, signedIn = true, initScript = null, storage = null, hash = '', waitReady = true, promptAnswer = '', contextOptions = {}, timezoneId = undefined, fixedTime = HARNESS_NOW, controlTimers = false } = {}) {
  const playwright = loadPlaywright();
  const libs = resolveLibraries();
  if (!playwright || !libs) throw new Error('Browser harness dependencies are unavailable.');
  const browser = await playwright.chromium.launch({ executablePath: process.env.ATLAS_CHROMIUM || undefined });
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(timezoneId ? { timezoneId } : {}), ...contextOptions });
  const page = await context.newPage();
  // Date.now()/new Date() frozen at fixedTime (HARNESS_NOW unless the test
  // passes its own fixture time); timers keep running. null opts out.
  // controlTimers installs Playwright's fake timers instead (time starts at
  // fixedTime and flows naturally), so a test can advance timers with
  // advanceTimers() rather than sleeping through a retry or backoff window.
  if (controlTimers) await page.clock.install({ time: fixedTime ?? HARNESS_NOW });
  else if (fixedTime !== null && fixedTime !== undefined) await page.clock.setFixedTime(fixedTime);
  page.setDefaultTimeout(10000);
  // inflight/lastActivity let settle() wait for the mocked backend to go quiet.
  const record = { requests: [], consoleErrors: [], pageErrors: [], dialogs: [], inflight: 0, lastActivity: Date.now() };
  RECORDS.set(page, record);

  page.on('console', (message) => { if (message.type() === 'error') record.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => record.pageErrors.push(String(error?.stack || error?.message || error)));
  page.on('dialog', async (dialog) => {
    record.dialogs.push({ type: dialog.type(), message: dialog.message() });
    const answer = typeof promptAnswer === 'function' ? promptAnswer(dialog.message()) : promptAnswer;
    await (dialog.type() === 'prompt' ? dialog.accept(answer) : dialog.accept()).catch(() => {});
  });

  await context.route('https://cdn.jsdelivr.net/**', (route) => {
    const url = route.request().url();
    if (url.includes('supabase-js')) return route.fulfill({ contentType: MIME['.js'], body: readFileSync(libs.supabase) });
    return route.fulfill({ status: 404, body: '' });
  });
  await context.route('https://unpkg.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('lucide')) return route.fulfill({ contentType: MIME['.js'], body: readFileSync(libs.lucide) });
    if (url.includes('supabase-js')) return route.fulfill({ contentType: MIME['.js'], body: readFileSync(libs.supabase) });
    return route.fulfill({ status: 404, body: '' });
  });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: MIME['.css'], body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 404, body: '' }));
  await context.route('https://api.qrserver.com/**', (route) => route.fulfill({ status: 404, body: '' }));

  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    let file = decodeURIComponent(url.pathname);
    if (file === '/' || file === '') file = '/index.html';
    const target = path.join(WEB, file);
    if (!target.startsWith(WEB) || !existsSync(target)) return route.fulfill({ status: 404, body: 'not found' });
    let body = readFileSync(target);
    if (file === '/index.html') {
      body = Buffer.from(body.toString('utf8')
        .replace(/\s+integrity="[^"]*"/g, '')
        .replace(/script\.integrity = SUPABASE_SRI;/, ''));
    }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body });
  });

  const profiles = fixtures.profiles || Object.values(USERS);
  await context.route(`${SUPABASE}/**`, async (route) => {
    record.inflight += 1;
    try { return await answerSupabase(route); } finally { record.inflight -= 1; record.lastActivity = Date.now(); }
  });
  async function answerSupabase(route) {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = request.postData(); }
    const entry = { method, path: url.pathname, search: url.search, action: url.searchParams.get('action'), body, at: Date.now() };
    record.requests.push(entry);

    if (url.pathname === '/auth/v1/user') {
      // fixtures.auth.user may refuse the session (revoked elsewhere): { __status, body }.
      const handler = fixtures.auth?.user;
      const result = typeof handler === 'function' ? await handler(entry) : handler;
      if (result && result.__status) return json(route, result.body ?? {}, result.__status);
      return json(route, sessionFor(user).user);
    }
    if (url.pathname.startsWith('/auth/v1/token')) {
      // fixtures.auth.token may fail a token grant (for example a refresh after
      // the session was revoked elsewhere): { __status, body }.
      const handler = fixtures.auth?.token;
      const result = typeof handler === 'function' ? await handler(entry) : handler;
      if (result && result.__status) return json(route, result.body ?? {}, result.__status);
      return json(route, sessionFor(user));
    }
    if (url.pathname.startsWith('/auth/v1/logout')) {
      const handler = fixtures.auth?.logout;
      const result = typeof handler === 'function' ? await handler(entry) : handler;
      if (result && result.__status) return json(route, result.body ?? {}, result.__status);
      return route.fulfill({ status: 204, body: '' });
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const handler = fixtures.rpc?.[name];
      const result = typeof handler === 'function' ? await handler(body, entry) : handler;
      if (result && result.__status) return json(route, result.body ?? {}, result.__status);
      return json(route, result ?? []);
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      if (method !== 'GET' && method !== 'HEAD') {
        const handler = fixtures.writes?.[table];
        const result = typeof handler === 'function' ? await handler(body, entry) : handler;
        if (result && result.__status) return json(route, result.body ?? {}, result.__status);
        return json(route, result ?? (Array.isArray(body) ? body : [body || {}]), method === 'POST' ? 201 : 200);
      }
      let rows = table === 'profiles' ? profiles : (fixtures.tables?.[table] ?? []);
      if (typeof rows === 'function') rows = await rows(entry);
      // A table handler may fail the read: { __status, body } (PostgREST error).
      if (rows && !Array.isArray(rows) && rows.__status) return json(route, rows.body ?? { message: 'Harness read failure' }, rows.__status);
      const idFilter = url.searchParams.get('id');
      if (idFilter?.startsWith('eq.')) rows = rows.filter((row) => row.id === idFilter.slice(3));
      const single = (request.headers().accept || '').includes('application/vnd.pgrst.object');
      if (single) return json(route, rows[0] ?? null, rows[0] ? 200 : 406);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}`, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, body: JSON.stringify(rows) });
    }

    if (url.pathname.startsWith('/functions/v1/')) {
      const fn = url.pathname.slice('/functions/v1/'.length).split('/')[0];
      const handler = fixtures.functions?.[fn];
      if (!handler) return json(route, { error: `No harness fixture for ${fn}.` }, 503);
      const result = typeof handler === 'function' ? await handler({ ...entry, fn, user }) : handler;
      // { __raw: { status, contentType, body } } answers with a non-JSON body (for example an SSE stream).
      if (result && result.__raw) return route.fulfill({ status: result.__raw.status ?? 200, contentType: result.__raw.contentType || 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: result.__raw.body ?? '' });
      if (result && result.__status) return json(route, result.body ?? {}, result.__status);
      return json(route, result ?? {});
    }

    if (url.pathname.startsWith('/storage/v1/')) {
      // fixtures.storage(entry, request) may answer Storage (S94A uploads):
      // a body, { __status, body, headers }, { __raw: { status, contentType,
      // body } } or null for the default 200 {}.
      const result = typeof fixtures.storage === 'function' ? await fixtures.storage(entry, request) : null;
      if (result && result.__raw) return route.fulfill({ status: result.__raw.status ?? 200, contentType: result.__raw.contentType || 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: result.__raw.body ?? '' });
      if (result && result.__status) return route.fulfill({ status: result.__status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', ...(result.headers || {}) }, body: result.body === undefined ? '' : JSON.stringify(result.body) });
      return json(route, result ?? {});
    }
    return json(route, { error: 'unmocked' }, 404);
  }

  if (signedIn) {
    const session = sessionFor(user);
    await context.addInitScript(([key, value]) => {
      try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
    }, [`sb-${PROJECT_REF}-auth-token`, JSON.stringify(session)]);
  }

  if (initScript) await context.addInitScript(initScript);
  if (storage) {
    await context.addInitScript((entries) => {
      try { Object.entries(entries).forEach(([key, value]) => window.localStorage.setItem(key, value)); } catch { /* storage unavailable */ }
    }, storage);
  }

  await page.goto(`${ORIGIN}/index.html${hash}`, { waitUntil: 'load' });
  // waitReady: true waits for atlasReady, false for the app screen, 'none' for nothing
  // (a saved session that never reaches the app, for example a deactivated profile).
  if (waitReady === 'none') { /* the test waits on its own condition */ } else if (signedIn && waitReady) await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
  else if (signedIn) await page.waitForFunction(() => document.getElementById('app-screen')?.style.display === 'block', null, { timeout: 15000 });
  return { browser, context, page, record, close: () => browser.close() };
}

const RECORDS = new WeakMap();

/**
 * Waits until the page is quiet instead of sleeping: no mocked backend request
 * in flight for `quietMs`, two animation frames rendered, and every finite
 * animation or transition finished. Use it before asserting that something did
 * NOT happen; wait on the specific condition (selector, function, request)
 * whenever there is one.
 */
export async function settle(page, { quietMs = 50, timeout = 8000 } = {}) {
  const record = RECORDS.get(page);
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.race([
        Promise.all(document.getAnimations()
          .filter((animation) => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming?.().endTime))
          .map((animation) => animation.finished.catch(() => null))),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    });
    const idle = !record || (record.inflight === 0 && Date.now() - record.lastActivity >= quietMs);
    if (idle) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the page to settle');
    await new Promise((resolve) => setTimeout(resolve, Math.min(quietMs, 50)));
  }
}

/**
 * Advances a page launched with controlTimers by `ms` of timer time, in steps,
 * letting the mocked backend answer between steps so chained timers (retries,
 * backoff) behave as they would in real time.
 */
export async function advanceTimers(page, ms, { step = 250 } = {}) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await page.clock.runFor(Math.min(step, ms - elapsed));
    await settle(page, { quietMs: 20 });
  }
}

/**
 * Navigates through the shell (AtlasShell.navigate shows the view
 * synchronously, including role redirects) and waits for the page to settle.
 */
export async function navigateTo(page, hash) {
  await page.evaluate(async (target) => { await window.AtlasShell.navigate(target); }, hash);
  await settle(page);
}

export function requestsTo(record, fn, action) {
  return record.requests.filter((entry) => entry.path.endsWith(`/functions/v1/${fn}`) && (!action || entry.action === action));
}

export async function openView(page, view) {
  await page.evaluate((target) => {
    const button = document.querySelector(`.atlas-nav .nav-item[data-view="${target}"]`);
    if (button) button.click(); else window.setActiveView?.(target);
  }, view);
  await page.waitForFunction((target) => document.body.dataset.atlasView === target, view);
  await settle(page);
}

/**
 * Polls a test-side condition (for example a recorded request) until it holds.
 * Use it instead of a fixed sleep when the thing to wait for is not in the page.
 */
export async function until(check, { timeout = 8000, interval = 20, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
