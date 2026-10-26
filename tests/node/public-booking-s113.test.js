// S113 guest emails (supabase/functions/atlas-public-booking 0.4.0): the guest's site
// language is checked before any RPC (not even the rate budget is spent on bad input)
// and forwarded to the database, which writes the guest's emails in it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublicBookingHandler, FUNCTION_VERSION } from '../../supabase/functions/atlas-public-booking/handler.mjs';

const env = {
  PUBLIC_BOOKING_ENABLED: 'true', SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-key-value', PUBLIC_BOOKING_SALT: 'test-salt-0123456789abcdef',
};

function fakeServices() {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'atlas_public_booking_rate') return { ok: true };
      if (name === 'atlas_public_booking_request') return { reference: 'KA-ABC123', public_token: 'a'.repeat(32), status: 'requested', seats: [7, 8], confirmation_email: true };
      return {};
    },
  };
}

const post = (body) => new Request('https://edge.test/?action=request', {
  method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' }, body: JSON.stringify(body),
});
const booking = (extra = {}) => ({ party_size: 2, start_at: '2027-02-03T18:00:00+00:00', guest_name: 'Guest', guest_email: 'guest@example.com', ...extra });

test('the site language is forwarded as is (en / is), and left out when the site sends none', async () => {
  assert.equal(FUNCTION_VERSION, '0.4.0');
  for (const [language, expected] of [['is', 'is'], ['en', 'en'], [undefined, undefined]]) {
    const services = fakeServices();
    const res = await createPublicBookingHandler({ env, services })(post(booking(language ? { language } : {})));
    assert.equal(res.status, 200);
    const call = services.calls.find((c) => c.name === 'atlas_public_booking_request');
    assert.equal(call.args.p_payload.language, expected);
    assert.equal('language' in call.args.p_payload, expected !== undefined);
    assert.equal((await res.json()).confirmation_email, true, 'the database answer is passed through');
  }
});

test('any other language value is refused before the rate budget or the booking RPC', async () => {
  for (const language of ['de', 'IS', '', 3, ['is'], { is: true }]) {
    const services = fakeServices();
    const res = await createPublicBookingHandler({ env, services })(post(booking({ language })));
    assert.equal(res.status, 400, JSON.stringify(language));
    assert.equal(services.calls.length, 0);
  }
});
