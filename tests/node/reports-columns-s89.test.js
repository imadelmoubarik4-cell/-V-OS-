// S89: atlas-reports reads production rows with explicit column handling in
// index.ts. The former entrypoint replaced the global fetch and silently
// dropped brand/subcategory/needs_review from every select; now an optional
// column that the source lacks is retried without it and reported as missing
// data, and any other missing column fails the request loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadEdgeFunction, json } from './helpers/edge-function-harness.js';

const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const USER_ID = '11111111-1111-4111-8111-111111111111';

function backend({ missing = [] } = {}) {
  const selects = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/auth/v1/user') return json({ id: USER_ID });
    if (url.pathname === '/rest/v1/profiles' && (url.searchParams.get('id') || '').startsWith('eq.')) {
      return json([{ id: USER_ID, email: 'm@example.test', display_name: 'Mia', role: 'manager', active: true }]);
    }
    if (url.pathname === '/rest/v1/inventory_items') {
      const select = url.searchParams.get('select').split(',');
      selects.push(select);
      const absent = missing.find((column) => select.includes(column));
      if (absent) return json({ code: '42703', message: `column inventory_items.${absent} does not exist` }, 400);
      return json([{ id: 'i1', name: 'Gin', quantity: 1, unit: 'bottle', active: true }]);
    }
    if (url.pathname === '/rest/v1/rpc/atlas_reports_snapshot_v2') {
      return json({ data_sources: [{ key: 'inventory', name: 'Inventory', status: 'connected' }] });
    }
    return (init.method || 'GET').toUpperCase() === 'GET' ? json([]) : json({});
  };
  return { fetchImpl, selects };
}

const snapshot = (handler, fetchImpl) => handler(new Request('https://fn.test/atlas-reports?action=snapshot', {
  headers: { authorization: 'Bearer token' },
}), fetchImpl);

test('the entrypoint no longer replaces the global fetch', () => {
  const entry = fs.readFileSync(new URL('../../supabase/functions/atlas-reports/entrypoint.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /globalThis\.fetch/);
  assert.doesNotMatch(entry, /knownUnsupported/);
  assert.match(entry, /await import\("\.\/index\.ts"\);/);
});

test('all columns present: one read with brand, subcategory and needs_review, nothing missing', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-reports/index.ts', ENV);
  const { fetchImpl, selects } = backend();
  const response = await snapshot(handler, fetchImpl);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(selects.length, 1);
  for (const column of ['brand', 'subcategory', 'needs_review']) assert.ok(selects[0].includes(column), column);
  assert.deepEqual(body.workspace.missing_columns, []);
});

test('an optional column the source lacks is retried without it and reported as missing data', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-reports/index.ts', ENV);
  const { fetchImpl, selects } = backend({ missing: ['brand', 'needs_review'] });
  const response = await snapshot(handler, fetchImpl);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(selects.length, 3);
  assert.ok(!selects[2].includes('brand') && !selects[2].includes('needs_review') && selects[2].includes('subcategory'));
  assert.deepEqual(body.workspace.missing_columns.sort(), ['inventory_items.brand', 'inventory_items.needs_review']);
  const inventory = body.workspace.data_sources.find((source) => source.key === 'inventory');
  assert.equal(inventory.status, 'partial');
  assert.match(inventory.note, /Missing from the source: brand, needs_review\./);
});

test('a required column the source lacks fails loudly with fixed text (no PostgREST message)', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-reports/index.ts', ENV);
  const { fetchImpl } = backend({ missing: ['cost_price'] });
  const response = await snapshot(handler, fetchImpl);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'Reports source data is missing inventory_items.cost_price. Ask an administrator to apply the pending database migration.');
  assert.doesNotMatch(body.error, /does not exist/);
});
