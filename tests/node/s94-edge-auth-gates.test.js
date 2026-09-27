// S94 pre-production gate: the four S94 Edge Functions refuse unauthenticated
// callers before any database or provider call, and the publisher worker only
// answers a correct publisher secret, exposes no CORS surface and never logs
// the secret. One place to re-check before each production rollout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createMarketingMediaHandler } from '../../supabase/functions/atlas-marketing-media/handler.mjs';
import { createMarketingHandler } from '../../supabase/functions/atlas-marketing-workspace/handler.mjs';
import { ApiError, createIntegrationsHandler } from '../../supabase/functions/atlas-integrations/handler.mjs';
import { createPublisherHandler, SECRET_HEADER } from '../../supabase/functions/atlas-marketing-publisher/handler.mjs';
import { AuthError, resolveActor } from '../../supabase/functions/_shared/auth.mjs';

const BASE = 'https://abcdefghijklmnop.supabase.co';
const SECRET = 'publisher-secret-gate-0123456789abcdef-0123456789';
const ENV = {
  SUPABASE_URL: BASE,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  ATLAS_AUTH_PROJECT_URL: BASE,
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  ATLAS_MARKETING_PUBLISHER_SECRET: SECRET,
};
const env = (name) => ENV[name];

// Any outbound call is a failure: an unauthenticated request must be refused
// before the gateway reaches Auth, PostgREST, Storage or a provider.
function recordingFetch() {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ message: 'unexpected call' }), { status: 500 });
  };
  return { calls, fetchImpl };
}

function captureConsole() {
  const lines = [];
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(levels.map((level) => [level, console[level]]));
  for (const level of levels) console[level] = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { for (const level of levels) console[level] = originals[level]; } };
}

// The same wiring as supabase/functions/atlas-integrations/index.ts.
async function integrationsAuthenticate(request, fetchImpl) {
  try {
    const actor = await resolveActor(request, env, fetchImpl, { inactiveMessage: 'This Atlas profile is inactive.' });
    return { user: { id: actor.userId }, profile: actor.profile };
  } catch (error) {
    if (error instanceof AuthError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

test('atlas-integrations index.ts authenticates every request through the shared resolveActor', () => {
  const source = readFileSync(new URL('../../supabase/functions/atlas-integrations/index.ts', import.meta.url), 'utf8');
  assert.match(source, /resolveActor\(request, Deno\.env, fetch/);
  assert.match(source, /if \(error instanceof AuthError\) throw new ApiError\(error\.status, error\.message\);/);
  assert.match(source, /authenticate/);
});

const GATEWAYS = [
  ['atlas-marketing-media', (fetchImpl) => createMarketingMediaHandler({ env, fetchImpl, now: () => Date.now() }),
    [['GET', 'list'], ['POST', 'reserve'], ['POST', 'complete'], ['POST', 'maintenance']]],
  ['atlas-marketing-workspace', (fetchImpl) => createMarketingHandler({ env, fetchImpl, now: () => Date.now() }),
    [['GET', 'snapshot'], ['POST', 'create-content'], ['POST', 'publish-now'], ['GET', 'publish-targets']]],
  ['atlas-integrations', (fetchImpl) => createIntegrationsHandler({
    env, fetchImpl, now: () => Date.now(),
    rpc: async () => { throw new Error('rpc must not be reached'); },
    authenticate: (request) => integrationsAuthenticate(request, fetchImpl),
  }), [['GET', 'status'], ['POST', 'start'], ['POST', 'select-resource'], ['POST', 'set-review-state']]],
];

for (const [name, build, actions] of GATEWAYS) {
  test(`${name}: requests without a session are refused with 401 before any backend call`, async () => {
    for (const [method, action] of actions) {
      for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }]) {
        const { calls, fetchImpl } = recordingFetch();
        const handle = build(fetchImpl);
        const init = { method, headers: { ...headers, 'content-type': 'application/json' } };
        if (method === 'POST') init.body = '{}';
        const response = await handle(new Request(`${BASE}/functions/v1/${name}?action=${action}`, init));
        assert.equal(response.status, 401, `${name} ${method} ${action} ${JSON.stringify(headers)}`);
        assert.deepEqual(calls, [], `${name} ${action} made no outbound call`);
        const body = await response.text();
        assert.doesNotMatch(body, /service-role-test-key|sb_publishable_test|supabase\.co/, 'no configuration in the refusal');
      }
    }
  });
}

test('atlas-marketing-publisher: missing or wrong secret → 401, no CORS, no backend call, secret never logged', async () => {
  const log = captureConsole();
  try {
    for (const headers of [{}, { [SECRET_HEADER]: '' }, { [SECRET_HEADER]: 'wrong' }, { [SECRET_HEADER]: `${SECRET}x` },
      { authorization: `Bearer ${SECRET}` }]) {
      const { calls, fetchImpl } = recordingFetch();
      let rpcCalls = 0;
      const handle = createPublisherHandler({
        env, fetchImpl, now: () => Date.now(), random: () => 0.5, sleep: async () => {},
        rpc: async () => { rpcCalls += 1; throw new Error('rpc must not be reached'); },
        credentials: { openPublishingCredential: async () => { throw new Error('credentials must not be read'); } },
      });
      const response = await handle(new Request(`${BASE}/functions/v1/atlas-marketing-publisher?action=tick`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
      }));
      assert.equal(response.status, 401, JSON.stringify(Object.keys(headers)));
      assert.equal(rpcCalls, 0);
      assert.deepEqual(calls, []);
      for (const [key] of response.headers) assert.doesNotMatch(key, /^access-control-/i, 'no CORS header on the worker');
      assert.doesNotMatch(await response.text(), new RegExp(SECRET));
    }
    const preflight = await createPublisherHandler({ env, fetchImpl: recordingFetch().fetchImpl, now: () => Date.now(), random: () => 0.5 })(
      new Request(`${BASE}/functions/v1/atlas-marketing-publisher?action=tick`, { method: 'OPTIONS', headers: { origin: 'https://example.org' } }));
    assert.notEqual(preflight.status, 200, 'a browser preflight is not answered');
    for (const [key] of preflight.headers) assert.doesNotMatch(key, /^access-control-/i);
  } finally {
    log.restore();
  }
  assert.ok(log.lines.every((line) => !line.includes(SECRET)), 'the secret is never logged');
});
