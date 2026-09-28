// S96 (edgea): Edge Functions must not echo raw PostgREST/SQL text (schema
// names, relation/column names, constraint text) to the browser. Authored
// Atlas messages (P0001 etc.) still pass, as in atlas-shifts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';

const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const USER = '00000000-0000-4000-8000-0000000000aa';
const ID = '00000000-0000-4000-8000-0000000000bb';
const LEAK = 'relation "atlas_private.inventory_count_sessions" does not exist';

function backend(rpcError, { restError = null } = {}) {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return json({ id: USER });
    if (url.includes('/rest/v1/profiles?') && url.includes(`id=eq.${USER}`) && url.includes('limit=1') && !restError) {
      return json([{ id: USER, role: 'manager', active: true, display_name: 'Tester' }]);
    }
    if (url.includes('/rest/v1/profiles?') && url.includes(`id=eq.${USER}`) && url.includes('select=id%2Cemail%2Cdisplay_name%2Crole%2Cactive') && url.includes('limit=1')) {
      return json([{ id: USER, role: 'manager', active: true, display_name: 'Tester' }]);
    }
    if (restError && url.includes('/rest/v1/') && !url.includes('/rpc/')) return json(restError, 400);
    if (url.includes('/rest/v1/rpc/')) return json(rpcError, 400);
    if (url.includes('/rest/v1/')) return json([]);
    return json({ message: 'unexpected' }, 500);
  };
}

const call = async (fn, path, params, init, fetchImpl) => {
  const handler = await loadEdgeFunction(path, ENV);
  const response = await handler(new Request(`https://fn.test/${fn}?${new URLSearchParams(params)}`, {
    ...init, headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  }), fetchImpl);
  return { status: response.status, text: await response.text() };
};

const CASES = [
  ['atlas-stock-counts', 'supabase/functions/atlas-stock-counts/entrypoint.ts', { action: 'detail', id: ID }, {}],
  ['atlas-team-profile-photos', 'supabase/functions/atlas-team-profile-photos/index.ts', { action: 'snapshot' }, {}],
  ['atlas-inventory-scanner', 'supabase/functions/atlas-inventory-scanner/index.ts', { action: 'lookup', code: '5000000000001' }, {}],
];

for (const [fn, path, params, init] of CASES) {
  test(`${fn}: schema text from a failed RPC is not returned`, async () => {
    const { status, text } = await call(fn, path, params, init, backend({ code: '42P01', message: LEAK }));
    assert.equal(status, 400, text);
    assert.doesNotMatch(text, /atlas_private|relation|does not exist/);
  });
}

test('atlas-stock-counts: an authored Atlas message still reaches the browser', async () => {
  const { text } = await call('atlas-stock-counts', CASES[0][1], CASES[0][2], {}, backend({ code: 'P0001', message: 'Stock-count session not found' }));
  assert.match(text, /Stock-count session not found/);
});

test('atlas-stock-counts: production PostgREST text is not returned', async () => {
  const { text } = await call('atlas-stock-counts', CASES[0][1], { action: 'snapshot' }, {}, backend({ code: 'P0001', message: 'x' }, { restError: { code: '42501', message: 'permission denied for table inventory_items' } }));
  assert.doesNotMatch(text, /permission denied|inventory_items/);
});

test('atlas-team-profile-photos: an oversized upload is refused before parsing', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-team-profile-photos/index.ts', ENV);
  const response = await handler(new Request('https://fn.test/atlas-team-profile-photos?action=upload', {
    method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(50 * 1024 * 1024) }, body: '--x--',
  }), backend({ code: 'P0001', message: 'x' }));
  assert.equal(response.status, 413);
});

// atlas-team-profiles imports npm:@supabase/supabase-js, which the Node
// harness cannot load, so its two request helpers are checked in source.
test('atlas-team-profiles: RPC and production errors go through the safe-message rule', () => {
  const source = readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const message = safeDbMessage\(parsed, "The private Team Profiles request failed\."\);/);
  assert.match(source, /"Connected Atlas staff data could not be updated\."\);/);
  const branch = source.slice(source.indexOf('async function branchRpc('), source.indexOf('async function productionJson('));
  const production = source.slice(source.indexOf('async function productionJson('), source.indexOf('async function profiles('));
  for (const body of [branch, production]) assert.doesNotMatch(body, /String\(parsed\.message\)|\? parsed\n/);
});
