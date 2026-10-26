// S107 public booking gateway (supabase/functions/atlas-public-booking): the guest
// endpoint is inert unless the independent server flag PUBLIC_BOOKING_ENABLED is
// "true"; input is validated before the DB; the service-role RPCs receive a
// privacy-preserving fingerprint + idempotency key; RPC errors are redacted to a
// hint-mapped status; the service-role key never appears in a response.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublicBookingHandler } from '../../supabase/functions/atlas-public-booking/handler.mjs';

const SERVICE_KEY = 'super-secret-service-role-key-value';
// A strong fingerprint salt is now MANDATORY (>=16 chars); the function fails safe
// without it (see the dedicated salt tests below).
const STRONG_SALT = 'test-salt-0123456789abcdef';
const baseEnv = { PUBLIC_BOOKING_ENABLED: 'true', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, PUBLIC_BOOKING_SALT: STRONG_SALT };

function fakeServices(overrides = {}) {
  const calls = { rpc: [] };
  return {
    calls,
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (overrides.rpc) { const v = await overrides.rpc(name, args); if (v !== undefined) return v; }
      switch (name) {
        case 'atlas_public_booking_rate': return { ok: true };
        case 'atlas_public_booking_availability': return { date: args.p_date, party_size: args.p_party_size, duration_minutes: 120, slots: ['2027-02-03T18:00:00Z'] };
        case 'atlas_public_booking_request': return { reference: 'VA-ABCDEF', public_token: 'a'.repeat(32), status: 'requested' };
        case 'atlas_public_booking_status': return { reference: 'VA-ABCDEF', status: 'requested', start_at: '2027-02-03T18:00:00Z', party_size: 2 };
        default: return {};
      }
    },
  };
}

const makeHandler = (env = baseEnv, services = fakeServices()) =>
  ({ handle: createPublicBookingHandler({ env, services }), services });

const req = (method, path, { body, headers } = {}) =>
  new Request(`https://edge.test${path}`, { method, headers: headers || {}, body: body ? JSON.stringify(body) : undefined });

test('while the server flag is off the endpoint behaves as absent (404), no RPC', async () => {
  const { handle, services } = makeHandler({ ...baseEnv, PUBLIC_BOOKING_ENABLED: 'false' });
  const res = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2'));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error_code, 'disabled');
  assert.equal(services.calls.rpc.length, 0, 'no RPC when disabled');
});

test('flag absent is also off (never defaults on)', async () => {
  const { handle } = makeHandler({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
  const res = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2'));
  assert.equal(res.status, 404);
});

test('availability forwards a validated date + party to the RPC', async () => {
  const { handle, services } = makeHandler();
  const res = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2'));
  assert.equal(res.status, 200);
  const call = services.calls.rpc.at(-1);
  assert.equal(call.name, 'atlas_public_booking_availability');
  assert.deepEqual(call.args, { p_date: '2027-02-03', p_party_size: 2, p_tz: 'Atlantic/Reykjavik' });
});

test('availability rejects a bad date or party before the DB', async () => {
  const { handle, services } = makeHandler();
  assert.equal((await handle(req('GET', '/?action=availability&date=03-02-2027&party_size=2'))).status, 400);
  assert.equal((await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=0'))).status, 400);
  assert.equal((await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=abc'))).status, 400);
  assert.equal(services.calls.rpc.length, 0, 'no RPC on invalid input');
});

test('a request carries a fingerprint + idempotency key and truncated guest fields', async () => {
  const { handle, services } = makeHandler();
  const res = await handle(req('POST', '/?action=request', {
    headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-1', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    body: { party_size: 2, start_at: '2027-02-03T18:00:00Z', guest_name: 'G'.repeat(400), guest_phone: '555' },
  }));
  assert.equal(res.status, 200);
  const call = services.calls.rpc.at(-1);
  assert.equal(call.name, 'atlas_public_booking_request');
  assert.equal(call.args.p_payload.idempotency_key, 'idem-1');
  assert.ok(call.args.p_payload.fingerprint && call.args.p_payload.fingerprint.length >= 16, 'fingerprint present');
  assert.ok(!call.args.p_payload.fingerprint.includes('203.0.113.7'), 'raw IP is not the fingerprint');
  assert.equal(call.args.p_payload.guest_name.length, 120, 'guest_name is truncated');
  assert.equal(call.args.p_payload.tz, 'Atlantic/Reykjavik');
});

test('status requires a well-formed token', async () => {
  const { handle, services } = makeHandler();
  const bad = await handle(req('GET', '/?action=status&token=short'));
  assert.equal(bad.status, 404);
  assert.equal(services.calls.rpc.length, 0, 'no RPC for a malformed token');
  const ok = await handle(req('GET', `/?action=status&token=${'a'.repeat(32)}`));
  assert.equal(ok.status, 200);
  assert.equal(services.calls.rpc.at(-1).name, 'atlas_public_booking_status');
});

test('RPC hint errors are redacted to a mapped status', async () => {
  for (const [hint, status] of [['disabled', 503], ['conflict', 409], ['rate_limited', 429], ['invalid_request', 400]]) {
    const services = fakeServices({ rpc: () => { throw Object.assign(new Error('x'), {}); } });
    // Simulate the RPC layer throwing an ApiError-like via mapRpcError by overriding.
    const env = baseEnv;
    const handler = createPublicBookingHandler({ env, services: {
      async rpc() { const { mapRpcError } = await import('../../supabase/functions/atlas-public-booking/handler.mjs'); throw mapRpcError(400, { hint: `atlas:${hint}` }); },
    } });
    const res = await handler(req('GET', '/?action=availability&date=2027-02-03&party_size=2'));
    assert.equal(res.status, status, `${hint} -> ${status}`);
  }
});

test('no response ever contains the service-role key; OPTIONS is CORS-only', async () => {
  const { handle } = makeHandler();
  const opt = await handle(req('OPTIONS', '/?action=availability'));
  assert.equal(opt.status, 204);
  assert.ok(opt.headers.get('access-control-allow-methods').includes('POST'));
  for (const r of [
    await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2')),
    await handle(req('POST', '/?action=request', { headers: { 'content-type': 'application/json' }, body: { party_size: 2, start_at: '2027-02-03T18:00:00Z', guest_name: 'G' } })),
  ]) {
    const text = await r.text();
    assert.ok(!text.includes(SERVICE_KEY), 'service-role key must never appear in a response');
  }
});

test('CORS echoes only an allow-listed origin', async () => {
  const env = { ...baseEnv, PUBLIC_BOOKING_ORIGINS: 'https://kanel.is,https://www.kanel.is' };
  const { handle } = makeHandler(env);
  const good = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2', { headers: { origin: 'https://kanel.is' } }));
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://kanel.is');
  const bad = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2', { headers: { origin: 'https://evil.test' } }));
  assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.test');
});

test('CORS is restrictive by default (never "*"), echoing only the KANEL origins', async () => {
  const { handle } = makeHandler(); // no PUBLIC_BOOKING_ORIGINS set
  const wildcard = await handle(req('OPTIONS', '/?action=availability', { headers: { origin: 'https://evil.test' } }));
  assert.notEqual(wildcard.headers.get('access-control-allow-origin'), '*', 'default must not be a wildcard');
  assert.notEqual(wildcard.headers.get('access-control-allow-origin'), 'https://evil.test', 'a non-listed origin is not echoed');
  const kanel = await handle(req('OPTIONS', '/?action=availability', { headers: { origin: 'https://kanel.is' } }));
  assert.equal(kanel.headers.get('access-control-allow-origin'), 'https://kanel.is', 'kanel.is is allowed by default');
});

test('an unknown action or method is 404', async () => {
  const { handle } = makeHandler();
  assert.equal((await handle(req('GET', '/?action=nope'))).status, 404);
  assert.equal((await handle(req('DELETE', '/?action=request'))).status, 404);
});

// --- S109 edge hardening (owner review of PR #135, item 5) --------------------

test('every action consumes the edge-committed rate budget first (availability/status/request)', async () => {
  const { handle, services } = makeHandler();
  await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2'));
  await handle(req('GET', `/?action=status&token=${'a'.repeat(32)}`));
  await handle(req('POST', '/?action=request', { headers: { 'content-type': 'application/json' }, body: { party_size: 2, start_at: '2027-02-03T18:00:00Z', guest_name: 'G' } }));
  const rate = services.calls.rpc.filter((c) => c.name === 'atlas_public_booking_rate');
  assert.deepEqual(rate.map((c) => c.args.p_action).sort(), ['availability', 'request', 'status']);
  // The budget is consumed BEFORE the action it guards (its own committed txn).
  const idx = (n) => services.calls.rpc.findIndex((c) => c.name === n);
  assert.ok(idx('atlas_public_booking_rate') < idx('atlas_public_booking_availability'));
});

test('a refused rate budget is 429 and the action RPC never runs', async () => {
  for (const [action, make] of [
    ['availability', () => req('GET', '/?action=availability&date=2027-02-03&party_size=2')],
    ['status', () => req('GET', `/?action=status&token=${'a'.repeat(32)}`)],
    ['request', () => req('POST', '/?action=request', { headers: { 'content-type': 'application/json' }, body: { party_size: 2, start_at: '2027-02-03T18:00:00Z', guest_name: 'G' } })],
  ]) {
    const services = fakeServices({ rpc: (name) => (name === 'atlas_public_booking_rate' ? { ok: false } : undefined) });
    const handle = createPublicBookingHandler({ env: baseEnv, services });
    const res = await handle(make());
    assert.equal(res.status, 429, `${action} must be rate-limited`);
    assert.ok(!services.calls.rpc.some((c) => c.name === `atlas_public_booking_${action}`), `${action} RPC must not run when rate-limited`);
  }
});

test('the fingerprint is derived from the TRUSTED (rightmost) forwarded hop, not a spoofed leftmost entry', async () => {
  // A client prepends a fake XFF entry to try to rotate its fingerprint; our infra
  // appends the real connecting IP on the right. With one trusted hop the real IP
  // (10.0.0.9) is used — the spoofed 'evil' entry is ignored.
  const { handle, services } = makeHandler();
  await handle(req('POST', '/?action=request', {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1, 10.0.0.9' },
    body: { party_size: 2, start_at: '2027-02-03T18:00:00Z', guest_name: 'G' },
  }));
  const fpReal = services.calls.rpc.find((c) => c.name === 'atlas_public_booking_request').args.p_payload.fingerprint;

  const second = fakeServices();
  const handle2 = createPublicBookingHandler({ env: baseEnv, services: second });
  await handle2(req('POST', '/?action=request', {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9, 10.0.0.9' },
    body: { party_size: 2, start_at: '2027-02-03T18:00:00Z', guest_name: 'G' },
  }));
  const fpSpoofChanged = second.calls.rpc.find((c) => c.name === 'atlas_public_booking_request').args.p_payload.fingerprint;
  assert.equal(fpReal, fpSpoofChanged, 'changing only the spoofable leftmost entry must NOT change the fingerprint');
});

test('a missing or weak fingerprint salt fails safe (503) and never leaks a raw IP', async () => {
  for (const salt of [undefined, '', 'short']) {
    const env = { ...baseEnv }; if (salt === undefined) delete env.PUBLIC_BOOKING_SALT; else env.PUBLIC_BOOKING_SALT = salt;
    const services = fakeServices();
    const handle = createPublicBookingHandler({ env, services });
    const res = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2', { headers: { 'x-forwarded-for': '203.0.113.7' } }));
    assert.equal(res.status, 503, `salt=${JSON.stringify(salt)} must fail safe`);
    const text = await res.text();
    assert.ok(!text.includes('203.0.113.7'), 'a raw IP must never appear in the response');
    assert.ok(!services.calls.rpc.length, 'no RPC runs without a valid salt');
  }
});

test('the status token can travel off the URL — in a header or a POST body', async () => {
  const tok = 'a'.repeat(32);
  const viaHeader = makeHandler();
  const r1 = await viaHeader.handle(req('GET', '/?action=status', { headers: { 'x-booking-token': tok } }));
  assert.equal(r1.status, 200);
  assert.equal(viaHeader.services.calls.rpc.at(-1).name, 'atlas_public_booking_status');
  assert.equal(viaHeader.services.calls.rpc.at(-1).args.p_token, tok);

  const viaBody = makeHandler();
  const r2 = await viaBody.handle(req('POST', '/?action=status', { headers: { 'content-type': 'application/json' }, body: { token: tok } }));
  assert.equal(r2.status, 200);
  assert.equal(viaBody.services.calls.rpc.at(-1).args.p_token, tok);
});

test('CORS and the server flag fail safe together: a disabled endpoint still never wildcards CORS', async () => {
  const { handle } = makeHandler({ ...baseEnv, PUBLIC_BOOKING_ENABLED: 'false' });
  const res = await handle(req('GET', '/?action=availability&date=2027-02-03&party_size=2', { headers: { origin: 'https://evil.test' } }));
  assert.equal(res.status, 404);
  assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.test');
});
