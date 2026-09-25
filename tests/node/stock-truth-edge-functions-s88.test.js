// S88: Checkpoint K intelligence and Item Master read stock through the shared
// canonical module (supabase/functions/_shared). Before this, Checkpoint K
// called raw imported quantities "below par" (so unverified stock raised
// shortage and purchase recommendations) and used a 2026-07-26 historical
// cutoff while Reports used 2026-07-31; Item Master ignored owner-confirmed
// counts and ranked raw quantities as below par. These tests run the shipped
// Edge Functions against a stubbed backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';
import { HISTORICAL_OPENING_CUTOFF } from '../../supabase/functions/_shared/atlas-domain.mjs';

const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;

const ITEMS = [
  // Raw imported zero, never counted: unknown stock, not below par.
  { id: id(1), name: 'Vodka', category: 'Spirits', quantity: 0, unit: 'bottles', par_level: 6, supplier: 'Globus', cost_price: 5000, units_per_case: 6, size_ml: 700, active: true, source_updated_at: '2026-08-10', updated_at: at(-3) },
  // Raw 10 but a current manager count of 2: below par.
  { id: id(2), name: 'Gin', category: 'Spirits', quantity: 10, unit: 'bottles', par_level: 6, supplier: 'Globus', cost_price: 6000, units_per_case: 6, size_ml: 700, active: true, source_updated_at: '2026-08-10', updated_at: at(-3) },
  // Owner-confirmed 1 (no manager count): below par.
  { id: id(3), name: 'Rum', category: 'Spirits', quantity: 9, unit: 'bottles', par_level: 4, supplier: 'Globus', cost_price: 4000, size_ml: 700, active: true, source_updated_at: '2026-08-10', source_confirmed_at: at(-2), source_confirmed_quantity: 1, updated_at: at(-2) },
  // July 28 opening snapshot: historical under the canonical 07-31 cutoff.
  { id: id(4), name: 'Tonic', category: 'Mixers', quantity: 0, unit: 'cans', par_level: 5, supplier: 'Vífilfell', cost_price: 200, active: true, source_updated_at: '2026-07-28', updated_at: at(-40) },
  // Expired manager count superseded by a newer owner confirmation of 3.
  { id: id(5), name: 'Syrup', category: 'Mixers', quantity: 0, unit: 'bottles', par_level: 2, supplier: 'Globus', cost_price: 900, size_ml: 750, active: true, source_updated_at: '2026-08-10', source_confirmed_at: at(-1), source_confirmed_quantity: 3, updated_at: at(-1) },
];
const BALANCES = [
  { inventory_item_id: id(2), verified_quantity: 2, freshness_state: 'current', verification_status: 'current', verified_at: at(-1), expires_at: at(6) },
  { inventory_item_id: id(5), verified_quantity: 0, freshness_state: 'stale', verification_status: 'current', verified_at: at(-20), expires_at: at(-13) },
];

function backend(extraRpc = {}) {
  const captured = {};
  const tables = {
    inventory_items: ITEMS,
    inventory_movements: [],
    recipes: [],
    recipe_ingredients: [],
    suppliers: [{ id: id(9), name: 'Globus', active: true }],
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === 'https://auth.test/auth/v1/user') return json({ id: 'manager-1', email: 'manager@example.test' });
    if (url.origin === 'https://auth.test' && url.pathname === '/rest/v1/profiles') {
      return json([{ id: 'manager-1', email: 'manager@example.test', display_name: 'Manager', role: 'manager', active: true }]);
    }
    const table = url.origin === 'https://auth.test' && url.pathname.startsWith('/rest/v1/') ? url.pathname.slice(9) : null;
    if (table && tables[table]) return json(tables[table]);
    if (url.origin === 'https://branch.test' && url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      captured[name] = init.body ? JSON.parse(init.body) : {};
      if (name in extraRpc) return json(extraRpc[name]);
    }
    throw new Error(`Unexpected request in test: ${url.href}`);
  };
  return { captured, fetchImpl };
}

const request = (fn) => new Request(`https://fn.test/${fn}`, { headers: { authorization: 'Bearer manager-jwt' } });

test('the canonical historical cutoff is Reports’ 2026-07-31', () => {
  assert.equal(HISTORICAL_OPENING_CUTOFF, '2026-07-31');
  for (const file of ['supabase/functions/atlas-phase3-intelligence/index.ts', 'supabase/functions/atlas-item-master/index.ts']) {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /const HISTORICAL_OPENING_CUTOFF/, `${file} must use the shared cutoff`);
    assert.match(source, /from "\.\.\/_shared\/atlas-domain\.mjs"/, `${file} imports the shared domain module`);
    assert.doesNotMatch(source, /numberValue\(item\.quantity\)\s*<\s*numberValue\((item|effective)\.par_level\)/, `${file} must not compare raw quantities with par`);
  }
});

test('Checkpoint K only watches verified stock below par', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-phase3-intelligence/index.ts', ENV);
  const { captured, fetchImpl } = backend({
    atlas_phase3_intelligence_settings: {},
    atlas_stock_count_verified_balances: BALANCES,
    atlas_phase3_sync_intelligence: { synced: true },
    atlas_phase3_snapshot: { recommendations: [] },
  });
  const response = await handler(request('atlas-phase3-intelligence'), fetchImpl);
  assert.equal(response.status, 200, await response.clone().text());
  const sync = captured.atlas_phase3_sync_intelligence;
  const shortage = sync.p_recommendations.filter((entry) => entry.recommendation_type === 'shortage' && entry.subject_type === 'inventory_item');
  assert.deepEqual(shortage.map((entry) => entry.subject_key).sort(), [id(2), id(3)], 'unverified Vodka and historical Tonic are not below par');
  const gin = shortage.find((entry) => entry.subject_key === id(2));
  assert.equal(gin.evidence_value.quantity, 2, 'the verified count, not the raw 10');
  assert.equal(gin.evidence_value.stock_source, 'manager_verified_count');
  assert.equal(shortage.find((entry) => entry.subject_key === id(3)).evidence_value.stock_source, 'owner_confirmed');

  const purchase = sync.p_recommendations.filter((entry) => entry.recommendation_type === 'purchase' && entry.subject_type === 'inventory_item');
  assert.deepEqual(purchase.map((entry) => entry.subject_key).sort(), [id(2), id(3)]);

  const domain = sync.p_domains.find((entry) => entry.key === 'shortage');
  assert.equal(domain.metrics.observed_below_par, 2);
  assert.equal(domain.metrics.historical_opening_rows, 1, 'Tonic (2026-07-28) is historical under the canonical cutoff');
  const currentStock = sync.p_connections.find((entry) => entry.connection_key === 'current_stock');
  assert.equal(currentStock.metadata.verified_current_rows, 3);
});

test('Checkpoint K trusts no count when verified balances cannot be read', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-phase3-intelligence/index.ts', ENV);
  const { captured, fetchImpl } = backend({
    atlas_phase3_intelligence_settings: {},
    atlas_phase3_sync_intelligence: { synced: true },
    atlas_phase3_snapshot: {},
  });
  const failing = async (input, init) => {
    if (String(input).endsWith('/rpc/atlas_stock_count_verified_balances')) return json({ message: 'boom' }, 500);
    return fetchImpl(input, init);
  };
  const response = await handler(request('atlas-phase3-intelligence'), failing);
  assert.equal(response.status, 200);
  const shortage = captured.atlas_phase3_sync_intelligence.p_recommendations
    .filter((entry) => entry.recommendation_type === 'shortage' && entry.subject_type === 'inventory_item');
  assert.deepEqual(shortage.map((entry) => entry.subject_key), [id(3)], 'only owner evidence remains');
});

test('Item Master honours owner-confirmed counts and ranks only verified stock below par', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-item-master/index.ts', ENV);
  const countActivity = BALANCES.map((balance) => ({
    inventory_item_id: balance.inventory_item_id,
    count_observations: 1,
    verified_quantity: balance.verified_quantity,
    verification_status: balance.inventory_item_id === id(5) ? 'current' : balance.verification_status,
    verified_at: balance.verified_at,
    expires_at: balance.expires_at,
    historical: false,
  }));
  // Count lines without a verified balance are activity, not evidence.
  countActivity.push({ inventory_item_id: id(1), count_observations: 1, verified_quantity: null, verification_status: null, verified_at: null, expires_at: null });
  const { fetchImpl } = backend({
    atlas_item_master_snapshot: { settings: {}, drafts: [], barcode_aliases: [], count_activity: countActivity },
  });
  const response = await handler(request('atlas-item-master'), fetchImpl);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const byName = new Map(body.queue.map((entry) => [entry.item.name, entry]));
  const states = Object.fromEntries([...byName].map(([name, entry]) => [name, entry.quantity_status]));
  assert.deepEqual(states, { Vodka: 'unverified', Gin: 'current', Rum: 'current', Tonic: 'historical', Syrup: 'current' });

  assert.equal(byName.get('Gin').verified_quantity, 2);
  assert.equal(byName.get('Rum').verified_quantity, 1);
  assert.equal(byName.get('Rum').quantity_source, 'owner_confirmed');
  assert.equal(byName.get('Syrup').verified_quantity, 3, 'the newer owner confirmation supersedes the expired count');
  assert.equal(byName.get('Vodka').verified_quantity, null);

  const belowPar = [...byName].filter(([, entry]) => entry.priority_reasons.includes('Verified current quantity is below configured par')).map(([name]) => name).sort();
  assert.deepEqual(belowPar, ['Gin', 'Rum']);
  assert.ok(!byName.get('Vodka').priority_reasons.some((reason) => /par/.test(reason)), 'unverified stock is never below par');
});
