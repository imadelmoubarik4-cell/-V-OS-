import test from 'node:test';
import assert from 'node:assert/strict';

// S96 (aioauth): Atlas Brain Phase 3 and Checkpoint K no longer echo raw
// PostgREST/database text (table, column, constraint and function names)
// to the browser. Fails before the fix: both functions returned
// parsed.message verbatim.
import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';

const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const LEAK = 'relation "atlas_private.brain_recommendations" does not exist';

function backend(rpcBody, status = 400) {
  return async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === 'https://auth.test/auth/v1/user') return json({ id: '00000000-0000-4000-8000-0000000000a1', email: 'm@example.test' });
    if (url.pathname === '/rest/v1/profiles') return json([{ id: '00000000-0000-4000-8000-0000000000a1', display_name: 'Manager', role: 'manager', active: true }]);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(rpcBody, status);
    if (url.pathname.startsWith('/rest/v1/')) return json(rpcBody, status);
    throw new Error(`unexpected ${url.href}`);
  };
}
const get = (fn, query = '') => new Request(`https://fn.test/${fn}${query}`, { headers: { authorization: 'Bearer manager-jwt' } });

test('Phase 3 Brain replaces schema-revealing database errors with fixed text', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-phase3-brain/index.ts', ENV);
  const response = await handler(get('atlas-phase3-brain', '?action=snapshot'), backend({ code: '42P01', message: LEAK }));
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(text, /atlas_private|relation|does not exist/);
  assert.match(text, /The Atlas Brain database request failed\./);
});

test('Phase 3 Brain still passes Atlas-authored messages', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-phase3-brain/index.ts', ENV);
  const response = await handler(get('atlas-phase3-brain', '?action=snapshot'), backend({ code: 'P0001', message: 'This recommendation was already decided.' }));
  assert.match(await response.text(), /already decided/);
});

test('Checkpoint K does not echo database text for failed RPCs or source reads', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-phase3-intelligence/index.ts', ENV);
  const response = await handler(get('atlas-phase3-intelligence'), backend({ code: '42703', message: 'column inventory_items.secret_col does not exist' }));
  const text = await response.text();
  assert.doesNotMatch(text, /secret_col|does not exist/);
});
