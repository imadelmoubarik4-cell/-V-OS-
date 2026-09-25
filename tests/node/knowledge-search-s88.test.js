// S88 Knowledge search: atlas-knowledge?action=search calls
// public.atlas_knowledge_search as the verified actor (never a client-supplied
// id or role). Staff receive only published versions; draft rows that a
// misbehaving RPC might return are filtered out a second time in the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';

const FUNCTION = 'supabase/functions/atlas-knowledge/index.ts';
const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const PUBLISHED = { article_id: '0f5b8a39-6a3f-4c1e-9d7a-6f1d6b3c2a11', version_id: 'v1', version_number: 2, title: 'Closing the bar', category: 'Opening & closing', category_key: 'opening-closing', article_type: 'sop', required: true, status: 'published', version_state: 'published', rank: 0.5, snippet: 'Count the **till** and lock up' };
const DRAFT = { ...PUBLISHED, article_id: '1f5b8a39-6a3f-4c1e-9d7a-6f1d6b3c2a12', title: 'Private draft: wine pricing', status: 'draft', version_state: 'draft', snippet: 'Draft **till** text' };

function backend(role, { active = true } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === 'https://auth.test/auth/v1/user') return json({ id: 'user-1', email: 'staff@example.test' });
    if (url.origin === 'https://auth.test' && url.pathname === '/rest/v1/profiles') {
      return json([{ id: 'user-1', email: 'staff@example.test', display_name: 'Staff', role, active }]);
    }
    if (url.href === 'https://branch.test/rest/v1/rpc/atlas_knowledge_search') {
      const body = JSON.parse(init.body);
      calls.push(body);
      return json({ results: [PUBLISHED, DRAFT], count: 2, query: body.p_query });
    }
    throw new Error(`Unexpected request in test: ${url.href}`);
  };
  return { calls, fetchImpl };
}

const handlerPromise = loadEdgeFunction(FUNCTION, ENV);
const searchRequest = (query, extra = '') => new Request(`https://fn.test/atlas-knowledge?action=search&q=${encodeURIComponent(query)}${extra}`, {
  headers: { authorization: 'Bearer user-jwt' },
});

for (const role of ['bartender', 'viewer']) {
  test(`${role} search runs as the verified actor and never returns drafts`, async () => {
    const handler = await handlerPromise;
    const { calls, fetchImpl } = backend(role);
    const response = await handler(searchRequest('till', '&actor_id=someone-else&role=admin'), fetchImpl);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(calls.length, 1);
    assert.deepEqual({ id: calls[0].p_actor_id, role: calls[0].p_actor_role }, { id: 'user-1', role }, 'actor comes from the session, not the query string');
    assert.equal(calls[0].p_query, 'till');
    assert.deepEqual(body.results.map((row) => row.title), ['Closing the bar']);
    assert.doesNotMatch(JSON.stringify(body), /Private draft|wine pricing|source_url/);
  });
}

for (const role of ['manager', 'admin']) {
  test(`${role} search includes their drafts`, async () => {
    const handler = await handlerPromise;
    const { fetchImpl } = backend(role);
    const body = await (await handler(searchRequest('till'), fetchImpl)).json();
    assert.deepEqual(body.results.map((row) => row.version_state), ['published', 'draft']);
    assert.equal(body.staff.can_manage_knowledge, true);
  });
}

test('search limits are clamped and empty queries are refused', async () => {
  const handler = await handlerPromise;
  const { calls, fetchImpl } = backend('bartender');
  await handler(searchRequest('till', '&limit=500'), fetchImpl);
  assert.equal(calls[0].p_limit, 25);
  const empty = await handler(searchRequest('   '), fetchImpl);
  assert.equal(empty.status, 400);
  assert.equal(calls.length, 1, 'an empty query never reaches the database');
});

test('an inactive profile cannot search', async () => {
  const handler = await handlerPromise;
  const { calls, fetchImpl } = backend('bartender', { active: false });
  const response = await handler(searchRequest('till'), fetchImpl);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});
