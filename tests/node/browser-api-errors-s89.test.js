// S89 (review P2-9): browser API failures read as fixed, friendly copy. The one
// helper (apps/web/assets/js/atlas-api.js, AtlasApi.request) maps status and
// error_code to text and never shows the server's words; modules either use it
// or route their own mapping through AtlasApi.friendlyMessage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(file, 'utf8');
const API = read('apps/web/assets/js/atlas-api.js');
const JS_DIR = 'apps/web/assets/js';

function loadApi({ respond, session = { access_token: 'token-1' } } = {}) {
  const events = [];
  const calls = [];
  const context = {
    console, JSON, Promise, Object, String, Number, Error, URL, AbortController, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    FormData: class {},
    location: { href: 'https://atlas.test/' },
    atlasSupabase: { auth: { getSession: async () => ({ data: { session } }) } },
    dispatchEvent: (event) => { events.push(event.type); return true; },
    fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(API, context);
  return { api: context.AtlasApi, identity: context.AtlasIdentity, events, calls };
}

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('server and database text never reaches the caller', async () => {
  const leaks = [
    [400, { error: 'column inventory_items.brand does not exist', code: '42703' }, 'invalid'],
    [403, { error: 'permission denied for table profiles' }, 'forbidden'],
    [404, { error: 'relation "atlas_private.x" does not exist' }, 'not_found'],
    [409, { error: 'duplicate key value violates unique constraint "x_pkey"' }, 'conflict'],
    [500, { error: 'JWT expired at 12:00' }, 'failed'],
    [503, { error: 'SUPABASE_URL is not configured.' }, 'unavailable'],
  ];
  for (const [status, body, kind] of leaks) {
    const { api } = loadApi({ respond: () => json(body, status) });
    const error = await api.request('https://fn.test/x', { params: { action: 'snapshot' } }).catch((caught) => caught);
    assert.equal(error.kind, kind, `${status}`);
    assert.equal(error.status, status);
    assert.equal(error.message, api.MESSAGES[kind]);
    assert.ok(!error.message.includes(body.error), `${status} leaked "${body.error}"`);
  }
});

test('module copy by kind or error_code; session, network and timeout have their own text', async () => {
  let { api, events, calls } = loadApi({ respond: () => json({ error: 'raw', error_code: 'stale_item' }, 409) });
  let error = await api.request('https://fn.test/x', { messages: { stale_item: 'This item changed. Refresh it.' } }).catch((caught) => caught);
  assert.equal(error.message, 'This item changed. Refresh it.');
  assert.equal(calls[0].init.headers.authorization, 'Bearer token-1');
  assert.equal(new URL(calls[0].url).origin, 'https://fn.test');

  ({ api, events } = loadApi({ respond: () => json({ error: 'JWT expired' }, 401) }));
  error = await api.request('https://fn.test/x', { messages: { auth: 'Sign in to see shifts.' } }).catch((caught) => caught);
  assert.deepEqual([error.kind, error.message], ['auth', 'Sign in to see shifts.']);
  assert.deepEqual(events, ['atlas:auth-required']);

  ({ api, events } = loadApi({ respond: () => json({}, 200), session: null }));
  error = await api.request('https://fn.test/x').catch((caught) => caught);
  assert.equal(error.kind, 'auth');
  assert.deepEqual(events, ['atlas:auth-required']);

  ({ api } = loadApi({ respond: () => { throw new TypeError('Failed to fetch'); } }));
  error = await api.request('https://fn.test/x').catch((caught) => caught);
  assert.deepEqual([error.kind, error.message], ['network', api.MESSAGES.network]);

  ({ api } = loadApi({ respond: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }));
  error = await api.request('https://fn.test/x', { timeoutMs: 20 }).catch((caught) => caught);
  assert.deepEqual([error.kind, error.message], ['timeout', api.MESSAGES.timeout]);

  ({ api } = loadApi({ respond: () => json({ ok: true }, 200) }));
  assert.equal(await api.request('').catch((caught) => caught.kind), 'not_configured');
  assert.deepEqual({ ...(await api.request('https://fn.test/x', { body: { a: 1 } })) }, { ok: true });
});

test('AtlasIdentity labels a person by display name, never by email', () => {
  const { identity } = loadApi({ respond: () => json({}, 200) });
  assert.equal(identity.label({ display_name: 'Sara Jónsdóttir', email: 'sara@example.test' }), 'Sara Jónsdóttir');
  assert.equal(identity.label({ display_name: null, email: 'sara.bartender@example.test' }), 'Team member');
  assert.equal(identity.label({ display_name: 'sara@example.test' }), 'Team member');
  assert.equal(identity.firstName({ display_name: 'Sara Jónsdóttir' }), 'Sara');
  assert.equal(identity.firstName({ email: 'imad@example.test' }), '');
});

test('the sign-in screen no longer derives a name from the email address', () => {
  const index = read('apps/web/index.html');
  assert.doesNotMatch(index, /\/\^imad\/i/);
  assert.doesNotMatch(index, /currentUser\.email\.split\('@'\)/);
  assert.doesNotMatch(index, /userEmailEl\.textContent = currentUser\.email/);
  assert.match(index, /const displayName = identity\.label\(profile\);/);
  assert.match(index, /email: '', role: profile\.role/);
  assert.ok(index.indexOf('assets/js/atlas-api.js') > 0 && index.indexOf('assets/js/atlas-api.js') < index.indexOf('assets/js/shifts-workspace.js'),
    'atlas-api.js loads before the modules that use it');
  assert.doesNotMatch(read(`${JS_DIR}/atlas-chrome.js`), /atlas-account-menu__email/);
});

test('no browser module turns server error text into a visible message', () => {
  for (const file of fs.readdirSync(JS_DIR).filter((name) => name.endsWith('.js'))) {
    const source = read(`${JS_DIR}/${file}`);
    assert.doesNotMatch(source, /payload\??\.error\s*\|\|/, `${file} shows payload.error`);
    assert.doesNotMatch(source, /new Error\(payload/, `${file} throws server text`);
  }
  for (const file of ['notifications.js', 'team-profile-photos.js']) {
    const source = read(`${JS_DIR}/${file}`);
    assert.match(source, /window\.AtlasApi\.request\(endpoint\(\), \{/, `${file} uses AtlasApi.request`);
    assert.doesNotMatch(source, /await fetch\(/, `${file} has its own fetch wrapper`);
  }
  // These modules keep their fetch plumbing but take their copy from AtlasApi.
  for (const file of ['shifts-workspace.js', 'team-messages.js', 'knowledge-workspace.js']) {
    const source = read(`${JS_DIR}/${file}`);
    const start = source.indexOf('function friendlyError(');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    assert.match(body, /api\.friendlyMessage\(api\.kindFor\(status, null\), null, API_MESSAGES\)/, file);
    assert.doesNotMatch(body, /\btext\b|return message/, `${file} passes server text through`);
  }
});
