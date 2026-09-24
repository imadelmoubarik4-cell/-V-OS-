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

function resolveLibraries() {
  const roots = [process.env.ATLAS_BROWSER_LIBS, path.join(ROOT, 'node_modules'), path.join(here, 'node_modules')]
    .filter(Boolean);
  for (const base of roots) {
    const supabase = path.join(base, '@supabase/supabase-js/dist/umd/supabase.js');
    const lucide = path.join(base, 'lucide/dist/umd/lucide.min.js');
    if (existsSync(supabase) && existsSync(lucide)) {
      const xlsx = path.join(base, 'xlsx/dist/xlsx.full.min.js');
      return { supabase, lucide, xlsx: existsSync(xlsx) ? xlsx : null };
    }
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
  const now = Math.floor(Date.now() / 1000);
  const token = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: user.id, email: user.email, role: 'authenticated', exp: now + 3600 })}.harness`;
  return {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'harness-refresh',
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
export async function launchAtlas({ user = USERS.admin, fixtures = {}, viewport = { width: 1440, height: 900 }, signedIn = true, initScript = null, storage = null, hash = '', waitReady = true, promptAnswer = '', contextOptions = {}, timezoneId = undefined, fixedTime = undefined } = {}) {
  const playwright = loadPlaywright();
  const libs = resolveLibraries();
  if (!playwright || !libs) throw new Error('Browser harness dependencies are unavailable.');
  const browser = await playwright.chromium.launch({ executablePath: process.env.ATLAS_CHROMIUM || undefined });
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(timezoneId ? { timezoneId } : {}), ...contextOptions });
  const page = await context.newPage();
  // Date.now()/new Date() frozen at fixedTime; timers keep running.
  if (fixedTime !== undefined) await page.clock.setFixedTime(fixedTime);
  page.setDefaultTimeout(10000);
  const record = { requests: [], consoleErrors: [], pageErrors: [], dialogs: [] };

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
    if (url.includes('xlsx') && libs.xlsx) return route.fulfill({ contentType: MIME['.js'], body: readFileSync(libs.xlsx) });
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
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = request.postData(); }
    const entry = { method, path: url.pathname, search: url.search, action: url.searchParams.get('action'), body, at: Date.now() };
    record.requests.push(entry);

    if (url.pathname === '/auth/v1/user') return json(route, sessionFor(user).user);
    if (url.pathname.startsWith('/auth/v1/token')) return json(route, sessionFor(user));
    if (url.pathname.startsWith('/auth/v1/logout')) return route.fulfill({ status: 204, body: '' });

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

    if (url.pathname.startsWith('/storage/v1/')) return json(route, {});
    return json(route, { error: 'unmocked' }, 404);
  });

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
  if (signedIn && waitReady) await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
  else if (signedIn) await page.waitForFunction(() => document.getElementById('app-screen')?.style.display === 'block', null, { timeout: 15000 });
  return { browser, context, page, record, close: () => browser.close() };
}

export function requestsTo(record, fn, action) {
  return record.requests.filter((entry) => entry.path.endsWith(`/functions/v1/${fn}`) && (!action || entry.action === action));
}

export async function openView(page, view) {
  await page.evaluate((target) => {
    const button = document.querySelector(`.atlas-nav .nav-item[data-view="${target}"]`);
    if (button) button.click(); else window.setActiveView?.(target);
  }, view);
  await page.waitForTimeout(250);
}
