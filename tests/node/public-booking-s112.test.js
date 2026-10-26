// S112 direct website booking (supabase/functions/atlas-public-booking): ?action=book
// asks the database for a direct booking and ?action=request for a request; the
// guest's chosen stools are validated before any RPC (not even the rate budget is
// spent on bad input) and forwarded unchanged; a stool taken meanwhile is a 409
// seat_taken; the database decides whether a booking is confirmed (owner switch).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublicBookingHandler, FUNCTION_VERSION } from '../../supabase/functions/atlas-public-booking/handler.mjs';

const baseEnv = {
  PUBLIC_BOOKING_ENABLED: 'true', SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-key-value', PUBLIC_BOOKING_SALT: 'test-salt-0123456789abcdef',
};

function fakeServices(requestResult = { reference: 'KA-ABC123', public_token: 'a'.repeat(32), status: 'confirmed', seats: [7, 8], confirmation_email: false }) {
  const calls = { rpc: [] };
  return {
    calls,
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name === 'atlas_public_booking_rate') return { ok: true };
      if (name === 'atlas_public_booking_request') {
        if (typeof requestResult === 'function') return requestResult(args);
        return requestResult;
      }
      return {};
    },
  };
}

const post = (action, body) => new Request(`https://edge.test/?action=${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' }, body: JSON.stringify(body),
});
const booking = (extra = {}) => ({ party_size: 2, start_at: '2027-02-03T18:00:00+00:00', guest_name: 'Guest', ...extra });

test('?action=book asks for a direct booking, ?action=request for a request', async () => {
  for (const [action, mode] of [['book', 'direct'], ['request', 'request']]) {
    const services = fakeServices();
    const handle = createPublicBookingHandler({ env: baseEnv, services });
    const res = await handle(post(action, booking()));
    assert.equal(res.status, 200, action);
    const call = services.calls.rpc.find((c) => c.name === 'atlas_public_booking_request');
    assert.equal(call.args.p_payload.booking_mode, mode, action);
    assert.equal('seats' in call.args.p_payload, false, 'no seats key when the guest chose none');
  }
});

test('chosen stools are forwarded unchanged and the database answer is returned as is', async () => {
  const services = fakeServices();
  const handle = createPublicBookingHandler({ env: baseEnv, services });
  const res = await handle(post('book', booking({ seats: [7, 8] })));
  assert.equal(res.status, 200);
  const call = services.calls.rpc.find((c) => c.name === 'atlas_public_booking_request');
  assert.deepEqual(call.args.p_payload.seats, [7, 8]);
  const body = await res.json();
  assert.equal(body.status, 'confirmed');
  assert.deepEqual(body.seats, [7, 8]);
  assert.equal(body.confirmation_email, false);
  assert.equal(res.headers.get('x-atlas-public-booking-version'), FUNCTION_VERSION);
});

test('bad stool choices are refused before any RPC, including the rate budget', async () => {
  const bad = [[], [0], [17], [1.5], ['3'], [3, 3], [1, 2, 3, 4, 5], 'all', { 0: 1 }];
  for (const seats of bad) {
    const services = fakeServices();
    const handle = createPublicBookingHandler({ env: baseEnv, services });
    const res = await handle(post('book', booking({ seats })));
    assert.equal(res.status, 400, JSON.stringify(seats));
    assert.equal((await res.json()).error_code, 'invalid_request');
    assert.equal(services.calls.rpc.length, 0, `no RPC for ${JSON.stringify(seats)}`);
  }
});

test('a stool taken meanwhile is a 409 seat_taken with no database detail', async () => {
  const services = {
    calls: { rpc: [] },
    async rpc(name) {
      if (name === 'atlas_public_booking_rate') return { ok: true };
      const { mapRpcError } = await import('../../supabase/functions/atlas-public-booking/handler.mjs');
      throw mapRpcError(409, { code: '23505', hint: 'atlas:seat_taken', message: 'A chosen stool was just booked.' });
    },
  };
  const handle = createPublicBookingHandler({ env: baseEnv, services });
  const res = await handle(post('book', booking({ seats: [8, 9] })));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error_code, 'seat_taken');
  assert.doesNotMatch(JSON.stringify(body), /23505|chosen stool/);
});

test('a plain conflict stays error_code conflict', async () => {
  const services = {
    async rpc(name) {
      if (name === 'atlas_public_booking_rate') return { ok: true };
      const { mapRpcError } = await import('../../supabase/functions/atlas-public-booking/handler.mjs');
      throw mapRpcError(409, { code: '23505', hint: 'atlas:conflict' });
    },
  };
  const handle = createPublicBookingHandler({ env: baseEnv, services });
  const res = await handle(post('book', booking()));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error_code, 'conflict');
});
