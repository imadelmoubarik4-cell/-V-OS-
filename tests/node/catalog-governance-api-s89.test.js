// S89 atlas-item-master catalogue actions: request shaping is pure and runs
// before the database; the database re-checks everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as nodeModule from 'node:module';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const EDGE = read('supabase/functions/atlas-item-master/index.ts');
const COUNTS = read('supabase/functions/atlas-stock-counts/entrypoint.ts');
const canStrip = typeof nodeModule.stripTypeScriptTypes === 'function';
const ID = '00000000-0000-4000-8000-000000089d01';

function load(source, marker, names) {
  const start = source.indexOf(`// ${marker}:start`);
  const end = source.indexOf(`// ${marker}:end`);
  assert.ok(start >= 0 && end > start, `missing ${marker} block`);
  const context = { Array, Object, String, Number, JSON, Math, Set };
  vm.createContext(context);
  const code = nodeModule.stripTypeScriptTypes(source.slice(start, end));
  vm.runInContext(`class ApiError extends Error { constructor(status, message, code = null) { super(message); this.status = status; this.code = code; } }
${code}
this.helpers = { ${names.join(', ')} };`, context);
  return context.helpers;
}

const catalog = () => load(EDGE, 's89-catalog-helpers', ['createItemRequest', 'findDuplicatesRequest', 'catalogDecideRequest',
  'catalogCreateRequest', 'catalogQueueQuery', 'catalogErrorDetails']);
const counts = () => load(COUNTS, 's89-count-helpers', ['quantityValue', 'countEvidence']);

function refusal(fn) {
  try { fn(); } catch (error) { return { status: error.status, code: error.code, message: error.message }; }
  return null;
}

test('create-item moves legacy sku/barcode fields into codes and never accepts a quantity', { skip: !canStrip }, () => {
  const { createItemRequest } = catalog();
  const request = createItemRequest({
    request_id: 'add-1',
    values: { name: 'Þurrkaður Ananas', sku: ' AB-1 ', barcode: '5000299223017', quantity: 12, category: 'Bar Ingredients' },
    duplicate_ack: [{ item_id: ID, reason: 'Different size' }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    p_values: { name: 'Þurrkaður Ananas', category: 'Bar Ingredients' },
    p_codes: [{ kind: 'sku', code: 'AB-1' }, { code: '5000299223017' }],
    p_aliases: [],
    p_media_id: null,
    p_duplicate_ack: { acknowledged: [{ item_id: ID, reason: 'Different size' }] },
    p_change_request_id: null,
    p_request_id: 'add-1',
  });
});

test('invalid catalogue requests are refused before the database', { skip: !canStrip }, () => {
  const { createItemRequest, catalogDecideRequest, catalogCreateRequest, catalogQueueQuery, findDuplicatesRequest } = catalog();
  for (const fn of [
    () => createItemRequest({ values: { name: 'x' } }),
    () => createItemRequest({ request_id: 'r', values: [] }),
    () => createItemRequest({ request_id: 'r', values: {}, codes: 'x' }),
    () => createItemRequest({ request_id: 'r', values: {}, media_id: 'nope' }),
    () => catalogDecideRequest({ id: ID, decision: 'maybe' }),
    () => catalogDecideRequest({ id: 'x', decision: 'approve' }),
    () => catalogDecideRequest({ id: ID, decision: 'approve', expected_version: 0 }),
    () => catalogCreateRequest({ kind: 'merge_everything', request_id: 'r' }),
    () => catalogCreateRequest({ kind: 'alias', request_id: 'r', source: 'robot' }),
    () => catalogQueueQuery(new URLSearchParams('status=done')),
    () => catalogQueueQuery(new URLSearchParams('limit=500')),
    () => findDuplicatesRequest({ values: {}, limit: 99 }),
  ]) {
    const error = refusal(fn);
    assert.ok(error && error.status >= 400 && error.status < 500, String(fn));
  }
});

test('decisions, requests and queue queries are normalised', { skip: !canStrip }, () => {
  const { catalogDecideRequest, catalogCreateRequest, catalogQueueQuery } = catalog();
  assert.deepEqual(JSON.parse(JSON.stringify(catalogDecideRequest({ id: ID.toUpperCase(), decision: ' Approve ', note: ' ok ', expected_version: 2 }))),
    { p_id: ID, p_decision: 'approve', p_note: 'ok', p_expected_version: 2, p_resolution: {} });
  const created = catalogCreateRequest({ kind: 'code', request_id: 'r1', payload: { item_id: ID, code: '96385074' }, self_approve: true });
  assert.equal(created.p_source, 'manager');
  assert.equal(created.p_self_approve, true);
  assert.deepEqual(JSON.parse(JSON.stringify(catalogQueueQuery(new URLSearchParams('kind=new_item')))),
    { p_kind: 'new_item', p_status: 'pending', p_limit: 50, p_offset: 0 });
});

test('database duplicate checks in error details reach the client', { skip: !canStrip }, () => {
  const { catalogErrorDetails } = catalog();
  assert.deepEqual(JSON.parse(JSON.stringify(catalogErrorDetails('{"candidates":[{"item_id":"x","score":0.9}]}'))),
    { candidates: [{ item_id: 'x', score: 0.9 }] });
  assert.equal(catalogErrorDetails('00000000-0000-4000-8000-000000089d01'), null);
  assert.equal(catalogErrorDetails('{broken'), null);
});

test('item-master routes the S89 actions to service-role catalogue RPCs only', () => {
  for (const [action, rpc] of [
    ['create-item', 'atlas_catalog_create_item'], ['find-duplicates', 'atlas_catalog_find_duplicates'],
    ['catalog-request', 'atlas_catalog_request_create'], ['catalog-decide', 'atlas_catalog_request_decide'],
    ['catalog-withdraw', 'atlas_catalog_request_withdraw'], ['catalog-backfill', 'atlas_catalog_propose_backfill'],
    ['catalog-queue', 'atlas_catalog_queue'],
  ]) {
    assert.ok(EDGE.includes(`"${action}"`), action);
    assert.ok(EDGE.includes(`branchRpc("${rpc}"`), rpc);
  }
  assert.match(EDGE, /duplicate_suspected: 409/);
  assert.match(EDGE, /payload\.duplicate_check = error\.details/);
  assert.doesNotMatch(EDGE, /from\(["']inventory_items["']\)\.insert/);
});

test('count quantities accept up to three decimals', { skip: !canStrip }, () => {
  const { quantityValue } = counts();
  for (const value of [0, 0.2, 0.4, 1.7, 0.125, '2.5', 1000]) assert.equal(quantityValue(value, 'Observed quantity'), Number(value));
  assert.equal(quantityValue('', 'Observed quantity'), null);
  for (const value of [1.2345, -1, 'abc', 20_000_000]) assert.ok(refusal(() => quantityValue(value, 'Observed quantity')), String(value));
});

test('count recognition evidence keeps references only', { skip: !canStrip }, () => {
  const { countEvidence } = counts();
  const evidence = countEvidence({ scanned_code: '5000299223017', recognition: { outcome_id: ID.toUpperCase(), band: 'high', score: 0.99 } });
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), { scanned_code: '5000299223017', recognition: { outcome_id: ID } });
  for (const bad of [[], { recognition: 'x' }, { recognition: {} }, { recognition: { outcome_id: 'nope' } }]) {
    assert.ok(refusal(() => countEvidence(bad)), JSON.stringify(bad));
  }
});

test('stock counts expose add-line through the service-role RPC', () => {
  assert.match(COUNTS, /case "add-line": \{/);
  assert.match(COUNTS, /branchRpc\("atlas_stock_count_add_line"/);
  assert.match(COUNTS, /p_evidence: countEvidence\(body\.evidence\)/);
});
