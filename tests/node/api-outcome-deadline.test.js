// Audit M5 and L12 (frontend): AtlasApi.request words a write whose result is
// unknown honestly, and every request path in atlas-api.js has a deadline.
//
// M5: a write (POST/PUT/PATCH/DELETE) that timed out after it was sent, or got
// a 502/503/504, may have been saved. It must never read "Nothing was
// changed"; it reads "couldn't confirm whether this was saved" and carries
// outcomeUnknown: true. Reads and refusals keep their copy.
// L12: the session lookup and the response body share the request deadline,
// and the Supabase client's fetch (AtlasApi.restReadFetch) gives PostgREST
// reads a deadline without touching writes, Auth or Storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const API = fs.readFileSync('apps/web/assets/js/atlas-api.js', 'utf8');
const APP = fs.readFileSync('apps/web/assets/js/atlas-app.js', 'utf8');

function loadApi({ respond, getSession = async () => ({ data: { session: { access_token: 'token-1' } } }) } = {}) {
  const calls = [];
  const context = {
    console, JSON, Promise, Object, String, Number, Error, URL, AbortController, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    FormData: class {},
    location: { href: 'https://atlas.test/' },
    atlasSupabase: { auth: { getSession } },
    dispatchEvent: () => true,
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return respond(url, init); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(API, context);
  return { api: context.AtlasApi, calls };
}

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A request that never answers until it is aborted.
const hang = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});
const NOTHING_CHANGED = /Nothing was changed/;

test('M5: a write that times out after it was sent is an unknown outcome, never "Nothing was changed"', { timeout: 5000 }, async () => {
  const { api } = loadApi({ respond: hang });
  const error = await api.request('https://fn.test/x', { method: 'POST', body: { a: 1 }, timeoutMs: 20 }).catch((caught) => caught);
  assert.equal(error.kind, 'timeout');
  assert.equal(error.outcomeUnknown, true);
  assert.equal(error.message, api.MESSAGES.outcome_unknown);
  assert.doesNotMatch(error.message, NOTHING_CHANGED);
  assert.match(error.message, /couldn’t confirm whether this was saved\. Check before trying again\./);

  // The same timeout on a read keeps the read copy.
  const read = await loadApi({ respond: hang }).api.request('https://fn.test/x', { timeoutMs: 20 }).catch((caught) => caught);
  assert.deepEqual([read.kind, read.message, read.outcomeUnknown], ['timeout', api.MESSAGES.timeout, undefined]);
});

test('M5: 502/503/504 on a write is an unknown outcome; refusals and reads keep their copy', async () => {
  for (const status of [502, 503, 504]) {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const { api } = loadApi({ respond: () => json({ error: 'upstream' }, status) });
      const error = await api.request('https://fn.test/x', { method, body: {} }).catch((caught) => caught);
      assert.deepEqual([error.kind, error.status, error.outcomeUnknown], ['unavailable', status, true], `${method} ${status}`);
      assert.doesNotMatch(error.message, NOTHING_CHANGED, `${method} ${status}`);
    }
    const { api } = loadApi({ respond: () => json({ error: 'upstream' }, status) });
    const read = await api.request('https://fn.test/x').catch((caught) => caught);
    assert.deepEqual([read.kind, read.message, read.outcomeUnknown], ['unavailable', api.MESSAGES.unavailable, undefined], `GET ${status}`);
  }
  // A known refusal of a write still says nothing changed.
  for (const [status, kind] of [[400, 'invalid'], [409, 'conflict'], [500, 'failed']]) {
    const { api } = loadApi({ respond: () => json({ error: 'x' }, status) });
    const error = await api.request('https://fn.test/x', { method: 'POST', body: {} }).catch((caught) => caught);
    assert.deepEqual([error.kind, error.message, error.outcomeUnknown], [kind, api.MESSAGES[kind], undefined], `${status}`);
  }
  // A 503 the server names as "not configured" is a refusal, not an unknown outcome.
  let { api } = loadApi({ respond: () => json({ error_code: 'not_configured' }, 503) });
  let error = await api.request('https://fn.test/x', { method: 'POST', body: {} }).catch((caught) => caught);
  assert.deepEqual([error.kind, error.outcomeUnknown], ['not_configured', undefined]);
  // A module words the unknown outcome itself: by error code, then outcome_unknown.
  ({ api } = loadApi({ respond: () => json({}, 504) }));
  error = await api.request('https://fn.test/x', { method: 'POST', body: {}, messages: { unavailable: 'Bookings is down. Nothing was changed.', outcome_unknown: 'Check the bookings list before saving again.' } }).catch((caught) => caught);
  assert.equal(error.message, 'Check the bookings list before saving again.');
  ({ api } = loadApi({ respond: () => json({ error_code: 'gateway_lost' }, 502) }));
  error = await api.request('https://fn.test/x', { method: 'POST', body: {}, messages: { gateway_lost: 'The answer was lost. Check before trying again.' } }).catch((caught) => caught);
  assert.equal(error.message, 'The answer was lost. Check before trying again.');
});

test('L12: a session lookup that never returns fails within the deadline, before anything is sent', { timeout: 5000 }, async () => {
  const { api, calls } = loadApi({ respond: () => json({}, 200), getSession: () => new Promise(() => {}) });
  const error = await api.request('https://fn.test/x', { method: 'POST', body: { a: 1 }, timeoutMs: 20 }).catch((caught) => caught);
  assert.equal(error.kind, 'timeout');
  // Nothing was sent, so "Nothing was changed" is true here.
  assert.equal(error.message, api.MESSAGES.timeout);
  assert.equal(error.outcomeUnknown, undefined);
  assert.equal(calls.length, 0);
});

test('L12: a body that stalls after the headers fails within the deadline instead of hanging', { timeout: 5000 }, async () => {
  const stalled = (url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      init.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  let { api } = loadApi({ respond: stalled });
  let error = await api.request('https://fn.test/x', { timeoutMs: 30 }).catch((caught) => caught);
  assert.deepEqual([error.kind, error.message], ['timeout', api.MESSAGES.timeout]);
  ({ api } = loadApi({ respond: stalled }));
  error = await api.request('https://fn.test/x', { method: 'POST', body: {}, timeoutMs: 30 }).catch((caught) => caught);
  assert.deepEqual([error.kind, error.outcomeUnknown], ['timeout', true]);
  // An answer that arrives in time is unchanged.
  ({ api } = loadApi({ respond: () => json({ ok: true }, 200) }));
  assert.deepEqual({ ...(await api.request('https://fn.test/x', { method: 'POST', body: {} })) }, { ok: true });
});

test('L12: the Supabase client fetch gives PostgREST reads a deadline and leaves everything else alone', { timeout: 5000 }, async () => {
  const BASE = 'https://proj.supabase.co';
  const { api, calls } = loadApi({ respond: hang });
  const restFetch = api.restReadFetch(`${BASE}/`, { timeoutMs: 20 });

  // A read that never answers is aborted at the deadline.
  const started = Date.now();
  const error = await restFetch(`${BASE}/rest/v1/inventory_items?select=*`, { method: 'GET', headers: {} }).catch((caught) => caught);
  assert.equal(error.name, 'AbortError');
  assert.ok(Date.now() - started < 2000);
  assert.ok(calls[0].init.signal, 'the read carries a deadline signal');

  // Writes and RPCs, Auth and Storage are passed through exactly as given.
  const passthrough = [
    [`${BASE}/rest/v1/inventory_items`, { method: 'POST', body: '{}' }],
    [`${BASE}/rest/v1/rpc/adjust_inventory_v2`, { method: 'POST', body: '{}' }],
    [`${BASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' }],
    [`${BASE}/auth/v1/user`, { method: 'GET' }],
    [`${BASE}/storage/v1/object/list/media`, { method: 'GET' }],
  ];
  const seen = [];
  const { api: api2 } = loadApi({ respond: (url, init) => { seen.push({ url: String(url), init }); return json({}, 200); } });
  const pass = api2.restReadFetch(BASE, { timeoutMs: 20 });
  for (const [url, init] of passthrough) await pass(url, init);
  assert.deepEqual(seen.map((entry) => entry.url), passthrough.map(([url]) => url));
  seen.forEach((entry, index) => assert.equal(entry.init, passthrough[index][1], `${entry.url} init untouched`));

  // A caller's own abort still cancels the read.
  const { api: api3 } = loadApi({ respond: hang });
  const caller = new AbortController();
  const pending = api3.restReadFetch(BASE, { timeoutMs: 3000 })(`${BASE}/rest/v1/recipes`, { method: 'GET', signal: caller.signal });
  caller.abort();
  assert.equal((await pending.catch((caught) => caught)).name, 'AbortError');
});

test('L12: the shell creates its Supabase client with the PostgREST read deadline', () => {
  const start = APP.indexOf('library.createClient(');
  const options = APP.slice(APP.indexOf('const restFetch'), start + 400);
  assert.match(options, /const restFetch = window\.AtlasApi\?\.restReadFetch\?\.\(cfg\.SUPABASE_URL\) \|\| null;/);
  assert.match(options, /\.\.\.\(restFetch \? \{ global: \{ fetch: restFetch \} \} : \{\}\)/);
});

// Review finding (M5 headline case): atlas-bookings, atlas-accounting and
// atlas-ai answer a lost RPC with 503 { error_code: 'unavailable' }. That code
// only names the generic kind, so it must not pick the module's 'unavailable'
// copy — written for refusals and reads, it says "Nothing was changed".
test('M5: a write answered 503 { error_code: "unavailable" } never shows the module\'s "Nothing was changed" copy', async () => {
  const BOOKINGS = fs.readFileSync('apps/web/assets/js/bookings-workspace.js', 'utf8');
  const literal = BOOKINGS.slice(BOOKINGS.indexOf('const API_MESSAGES = {') + 'const API_MESSAGES = '.length);
  const bookingsMessages = vm.runInNewContext(`(${literal.slice(0, literal.indexOf('};') + 1)})`);
  assert.match(bookingsMessages.unavailable, NOTHING_CHANGED, 'the read copy is unchanged');

  for (const [status, code] of [[503, 'unavailable'], [504, 'timeout'], [502, 'failed'], [503, 'UNAVAILABLE']]) {
    // A module without outcome_unknown copy: the generic honest copy.
    let { api } = loadApi({ respond: () => json({ error_code: code }, status) });
    let error = await api.request('https://fn.test/x', { method: 'POST', body: {}, messages: { unavailable: 'Down. Nothing was changed.', timeout: 'Slow. Nothing was changed.', failed: 'Broke. Nothing was changed.' } }).catch((caught) => caught);
    assert.equal(error.outcomeUnknown, true, `${status} ${code}`);
    assert.equal(error.message, api.MESSAGES.outcome_unknown, `${status} ${code}`);
    // Bookings words it itself.
    ({ api } = loadApi({ respond: () => json({ error_code: code }, status) }));
    error = await api.request('https://fn.test/x', { method: 'POST', body: {}, messages: bookingsMessages }).catch((caught) => caught);
    assert.equal(error.message, bookingsMessages.outcome_unknown, `bookings ${status} ${code}`);
    assert.doesNotMatch(error.message, NOTHING_CHANGED);
    assert.match(error.message, /couldn’t confirm whether this was saved/);
  }
  // A read with the same answer keeps the module's read copy.
  const { api } = loadApi({ respond: () => json({ error_code: 'unavailable' }, 503) });
  const read = await api.request('https://fn.test/x', { messages: bookingsMessages }).catch((caught) => caught);
  assert.deepEqual([read.message, read.outcomeUnknown], [bookingsMessages.unavailable, undefined]);
});
