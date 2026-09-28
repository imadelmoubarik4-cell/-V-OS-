// S96 (edgea): public posting must stay off unless an operator turns the
// worker on explicitly. The kill switch fails closed: unset, "", "1", "yes",
// or the runbook's ATLAS_PUBLISHER_ENABLED=false (docs/marketing/research/
// 07-scheduler-design.md) keep the worker from claiming anything even with a
// valid secret.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublisherHandler, SECRET_HEADER, publisherEnabled } from '../../supabase/functions/atlas-marketing-publisher/handler.mjs';

const SECRET = 'publisher-secret-s96-0123456789abcdef-0123456789';
const BASE = { SUPABASE_URL: 'https://branch.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', ATLAS_MARKETING_PUBLISHER_SECRET: SECRET };

function run(extraEnv) {
  const rpcCalls = [];
  const handle = createPublisherHandler({
    env: { ...BASE, ...extraEnv },
    fetchImpl: async () => { throw new Error('no network expected'); },
    rpc: async (name) => { rpcCalls.push(name); return []; },
    credentials: { openPublishingCredential: async () => { throw new Error('no credential expected'); } },
  });
  return handle(new Request('https://fn.test/atlas-marketing-publisher?action=tick', { method: 'POST', headers: { [SECRET_HEADER]: SECRET } }))
    .then(async (response) => ({ status: response.status, body: await response.json(), rpcCalls }));
}

for (const env of [{}, { ATLAS_MARKETING_PUBLISHER_ENABLED: '' }, { ATLAS_MARKETING_PUBLISHER_ENABLED: '1' }, { ATLAS_MARKETING_PUBLISHER_ENABLED: 'yes' },
  { ATLAS_MARKETING_PUBLISHER_ENABLED: 'false' }, { ATLAS_MARKETING_PUBLISHER_ENABLED: 'true', ATLAS_PUBLISHER_ENABLED: 'false' }]) {
  test(`publisher stays off with ${JSON.stringify(env)}: no claim RPC`, async () => {
    const { status, body, rpcCalls } = await run(env);
    assert.equal(status, 200);
    assert.equal(body.disabled, true);
    assert.deepEqual(rpcCalls, []);
  });
}

test('publisher runs only with ATLAS_MARKETING_PUBLISHER_ENABLED=true', async () => {
  assert.equal(publisherEnabled((name) => ({ ATLAS_MARKETING_PUBLISHER_ENABLED: 'true' })[name]), true);
  const { body, rpcCalls } = await run({ ATLAS_MARKETING_PUBLISHER_ENABLED: 'true' });
  assert.equal(body.ok, true);
  assert.equal(body.disabled, undefined);
  assert.deepEqual(rpcCalls, ['atlas_marketing_delivery_claim']);
});

test('a wrong secret is refused before the kill switch is even read', async () => {
  const handle = createPublisherHandler({ env: { ...BASE, ATLAS_MARKETING_PUBLISHER_ENABLED: 'true' }, rpc: async () => { throw new Error('no rpc'); }, credentials: { openPublishingCredential() {} } });
  const response = await handle(new Request('https://fn.test/atlas-marketing-publisher?action=tick', { method: 'POST', headers: { [SECRET_HEADER]: `${SECRET}x` } }));
  assert.equal(response.status, 401);
});
