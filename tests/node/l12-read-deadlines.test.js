// Audit L12 (home.js part): the Home shifts card reads with a deadline that
// covers the request and its body, so a stalled socket fails the card (its
// in-flight guard clears) instead of leaving it loading for minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const HOME = fs.readFileSync('apps/web/assets/js/home.js', 'utf8');

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, endMarker);
  return source.slice(start, end + endMarker.length);
}

function loadGetJson(respond) {
  const code = [
    slice(HOME, '  async function accessToken() {', '\n  }\n'),
    slice(HOME, '  const READ_TIMEOUT_MS = 20000;', '\n  }\n').replace('READ_TIMEOUT_MS = 20000', 'READ_TIMEOUT_MS = 30'),
    'this.getJson = getJson;'
  ].join('\n');
  const context = {
    URL, AbortController, Promise, Object, String, Error,
    fetch: (url, init) => respond(url, init),
    atlasSupabase: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
    setTimeout, clearTimeout
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.getJson;
}

test('L12: Home getJson fails at its deadline when the server never answers or the body stalls', { timeout: 5000 }, async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const error = await loadGetJson(hang)('https://fn.test/shifts', { action: 'snapshot' }).catch((caught) => caught);
  assert.equal(error.name, 'AbortError');

  const stalledBody = (url, init) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); })
  });
  const bodyError = await loadGetJson(stalledBody)('https://fn.test/shifts', { action: 'snapshot' }).catch((caught) => caught);
  assert.equal(bodyError.timeout, true, 'a stalled body is a timeout, not an empty answer');

  const ok = await loadGetJson(async () => ({ ok: true, status: 200, json: async () => ({ workspace: 1 }) }))('https://fn.test/shifts', { action: 'snapshot' });
  assert.deepEqual({ ...ok }, { workspace: 1 });
});
