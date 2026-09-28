// S96 (edgea): atlas-stock-counts must never hand commercial count-line
// snapshots (unit/case cost, supplier, source file) to staff or viewers, and
// must store only the evidence keys Atlas writes. Production evidence: a
// bartender token read ?action=detail on a verified session and received 17
// non-null unit_cost_snapshot values before this change.
import test from 'node:test';
import assert from 'node:assert/strict';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';

const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const USER = '00000000-0000-4000-8000-0000000000aa';
const SESSION = '00000000-0000-4000-8000-0000000000bb';
const LINE = '00000000-0000-4000-8000-0000000000cc';
const COMMERCIAL = ['unit_cost_snapshot', 'case_cost_snapshot', 'supplier_snapshot', 'source_file_snapshot', 'cost_price', 'case_cost'];

const detailPayload = () => ({
  session: { id: SESSION, status: 'draft' },
  lines: [{ id: LINE, item_name: 'Gin', expected_quantity: 3, unit_cost_snapshot: 1234.5, case_cost_snapshot: 9999, supplier_snapshot: 'Supplier', source_file_snapshot: 'prices.xlsx' }],
});

function backend(role, captured = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return json({ id: USER });
    if (url.includes('/rest/v1/profiles')) return json([{ id: USER, role, active: true, display_name: 'Tester' }]);
    if (url.includes('/rest/v1/inventory_catalog') || url.includes('/rest/v1/inventory_items')) {
      return json([{ id: '00000000-0000-4000-8000-0000000000dd', name: 'Gin', cost_price: 99, supplier: 'Supplier' }]);
    }
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)/)?.[1];
    if (rpc) {
      captured[rpc] = init.body ? JSON.parse(init.body) : {};
      if (rpc === 'atlas_stock_count_snapshot') return json({ sessions: [{ id: SESSION, supplier_snapshot: 'Supplier' }] });
      return json(detailPayload());
    }
    return json({ message: `unexpected ${url}` }, 500);
  };
}

const request = (params, init = {}) => new Request(`https://fn.test/atlas-stock-counts?${new URLSearchParams(params)}`, {
  ...init,
  headers: { authorization: 'Bearer user-token', 'content-type': 'application/json', ...(init.headers || {}) },
});

function commercialKeysIn(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => commercialKeysIn(entry, found));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (COMMERCIAL.includes(key)) found.push(key);
      commercialKeysIn(entry, found);
    }
  }
  return found;
}

for (const role of ['bartender', 'viewer']) {
  test(`${role}: stock-count detail carries no commercial snapshot fields`, async () => {
    const handler = await loadEdgeFunction('supabase/functions/atlas-stock-counts/entrypoint.ts', ENV);
    const response = await handler(request({ action: 'detail', id: SESSION }), backend(role));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.deepEqual(commercialKeysIn(body), []);
    assert.equal(body.count.lines[0].item_name, 'Gin', 'operational fields stay');
  });
}

test('bartender: save-line result and refreshed detail are redacted too', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-stock-counts/entrypoint.ts', ENV);
  const response = await handler(request({ action: 'save-line' }, {
    method: 'POST',
    body: JSON.stringify({ session_id: SESSION, line_id: LINE, line_status: 'counted', observed_input_quantity: 2, expected_version: 1 }),
  }), backend('bartender'));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(commercialKeysIn(await response.json()), []);
});

test('manager: stock-count detail keeps the commercial snapshots', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-stock-counts/entrypoint.ts', ENV);
  const response = await handler(request({ action: 'detail', id: SESSION }), backend('manager'));
  const body = await response.json();
  assert.equal(body.count.lines[0].unit_cost_snapshot, 1234.5);
});

test('save-line stores only Atlas evidence keys (no mass assignment, no __proto__)', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-stock-counts/entrypoint.ts', ENV);
  const captured = {};
  const body = '{"session_id":"' + SESSION + '","line_id":"' + LINE + '","line_status":"counted","observed_input_quantity":2,"expected_version":1,'
    + '"evidence":{"capture_surface":"count_screen","client_recorded_at":"2026-09-28T10:00:00.000Z","verified_by_manager":true,"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}}';
  const response = await handler(request({ action: 'save-line' }, { method: 'POST', body }), backend('bartender', captured));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(captured.atlas_stock_count_save_line_v2.p_evidence, { capture_surface: 'count_screen', client_recorded_at: '2026-09-28T10:00:00.000Z' });
  assert.equal({}.polluted, undefined);
});
