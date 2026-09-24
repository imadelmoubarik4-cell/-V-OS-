// S88 security fix: Brain recommendations are manager-only (atlas-phase3-brain),
// but `atlas-team-messages?action=targets&type=brain_recommendation` returned
// their titles, types and statuses to every active role, viewers included,
// and `send` let any writer link one. Both paths now require a manager or
// administrator before the manager-only snapshot is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';

const FUNCTION = 'supabase/functions/atlas-team-messages/index.ts';
const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const RECOMMENDATION = {
  id: '0f5b8a39-6a3f-4c1e-9d7a-6f1d6b3c2a11',
  title: 'Manager-only: renegotiate the Globus contract',
  summary: 'Private purchasing context',
  recommendation_type: 'purchase',
  subject_type: 'supplier',
  status: 'active',
};

function backend(role) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${url.origin}${url.pathname}`);
    if (url.href === 'https://auth.test/auth/v1/user') return json({ id: 'user-1', email: 'staff@example.test' });
    if (url.origin === 'https://auth.test' && url.pathname === '/rest/v1/profiles') {
      return json([{ id: 'user-1', email: 'staff@example.test', display_name: 'Staff', role, active: true }]);
    }
    if (url.href === 'https://branch.test/rest/v1/rpc/atlas_phase3_snapshot') {
      return json({ recommendations: [RECOMMENDATION] });
    }
    if (url.href === 'https://branch.test/rest/v1/rpc/atlas_team_messages_send') {
      return json({ duplicate: false, message_id: 'message-1', body: JSON.parse(init.body) });
    }
    throw new Error(`Unexpected request in test: ${url.href}`);
  };
  return { calls, fetchImpl };
}

const handlerPromise = loadEdgeFunction(FUNCTION, ENV);
const targets = () => new Request('https://fn.test/atlas-team-messages?action=targets&type=brain_recommendation', {
  headers: { authorization: 'Bearer user-jwt' },
});
const sendWithBrainLink = () => new Request('https://fn.test/atlas-team-messages?action=send', {
  method: 'POST',
  headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
  body: JSON.stringify({
    channel_key: 'general',
    body: 'See this',
    client_request_id: '7d1c1d8e-2b1f-4b7a-9d0e-3f5a2c1b4e66',
    link_type: 'brain_recommendation',
    link_key: RECOMMENDATION.id,
  }),
});

for (const role of ['viewer', 'bartender']) {
  test(`${role} cannot list Brain recommendation link targets`, async () => {
    const handler = await handlerPromise;
    const { calls, fetchImpl } = backend(role);
    const response = await handler(targets(), fetchImpl);
    const text = await response.text();
    assert.equal(response.status, 403);
    assert.doesNotMatch(text, /renegotiate|Globus|purchase/);
    assert.ok(!calls.some((call) => call.endsWith('/atlas_phase3_snapshot')), 'the manager-only snapshot is never read');
  });
}

test('bartender cannot link a Brain recommendation to a message', async () => {
  const handler = await handlerPromise;
  const { calls, fetchImpl } = backend('bartender');
  const response = await handler(sendWithBrainLink(), fetchImpl);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /renegotiate/);
  assert.ok(!calls.some((call) => call.endsWith('/atlas_phase3_snapshot')));
  assert.ok(!calls.some((call) => call.endsWith('/atlas_team_messages_send')), 'nothing is sent');
});

for (const role of ['manager', 'admin']) {
  test(`${role} still lists Brain recommendation link targets`, async () => {
    const handler = await handlerPromise;
    const { fetchImpl } = backend(role);
    const response = await handler(targets(), fetchImpl);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.targets.map((target) => target.label), [RECOMMENDATION.title]);
    assert.equal(body.staff.can_link_brain_recommendations, true);
  });
}

test('the composer only offers Atlas recommendations to managers', () => {
  const source = fs.readFileSync(new URL('../../apps/web/assets/js/team-messages.js', import.meta.url), 'utf8');
  assert.match(source, /state\.staff\?\.can_link_brain_recommendations \? `<option value="brain_recommendation"/);
});
