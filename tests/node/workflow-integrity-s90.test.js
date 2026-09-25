// S90 workflow integrity (engineering acceptance P2-2, P2-6, P2-8 and P3
// inputs): pure helpers and contracts. The browser flows are covered by
// tests/browser/workflow-integrity.browser.test.mjs and the database by
// scripts/verify_s90_workflow_integrity_preview.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as nodeModule from 'node:module';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const canStrip = typeof nodeModule.stripTypeScriptTypes === 'function';

function loadCounts() {
  const window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const context = vm.createContext({ window, document: { addEventListener() {} }, console });
  vm.runInContext(read('apps/web/assets/js/stock-count-workspace.js'), context, { filename: 'stock-count-workspace.js' });
  return window.AtlasStockCounts;
}

function block(source, name) {
  const start = source.indexOf(`// ${name}:start`);
  const end = source.indexOf(`// ${name}:end`);
  assert.ok(start >= 0 && end > start, `missing ${name} block`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// P3: count quantities are plain decimals
// ---------------------------------------------------------------------------
test('count quantities accept plain decimals only (no hex, exponent, sign or Infinity)', () => {
  const { parseQuantity } = loadCounts();
  for (const [raw, value] of [['0', 0], ['2', 2], ['1,5', 1.5], ['1.5', 1.5], ['.5', 0.5], ['3.', 3], [' 12 ', 12], ['1.234', 1.234], ['1.2340', 1.234]]) {
    assert.equal(parseQuantity(raw).value, value, raw);
  }
  for (const raw of ['0x10', '0X1f', '1e3', '1E-2', '-1', '+2', 'Infinity', 'NaN', '1 2', '1..2', '0b11', '0o7', '½', '2 bottles']) {
    assert.equal(parseQuantity(raw).value, undefined, raw);
    assert.match(parseQuantity(raw).error, /0 or more/, raw);
  }
  assert.match(parseQuantity('1.2345').error, /three decimal/);
  assert.match(parseQuantity('').error, /Use 0 if there are none/);
  assert.match(parseQuantity('2000000').error, /up to 1,000,000/);
});

// ---------------------------------------------------------------------------
// P2-8: "Verify anyway" names what changed after each line was counted
// ---------------------------------------------------------------------------
test('changedAfterCount lists only non-count movements recorded after each counted line', () => {
  const { changedAfterCount, changedAfterCountText } = loadCounts();
  const lines = [
    { inventory_item_id: 'campari', item_name: 'Campari', inventory_unit: 'bottles', line_status: 'counted', counted_at: '2026-09-24T12:00:00Z' },
    { inventory_item_id: 'aperol', item_name: 'Aperol', inventory_unit: 'bottles', line_status: 'counted', counted_at: '2026-09-24T12:00:00Z' },
    { inventory_item_id: 'limes', item_name: 'Limes', inventory_unit: 'each', line_status: 'skipped', counted_at: null },
  ];
  const movements = [
    { item_id: 'campari', movement_type: 'restock', quantity_change: 6, created_at: '2026-09-24T13:00:00Z' },
    { item_id: 'campari', movement_type: 'waste', quantity_change: -1, created_at: '2026-09-24T13:30:00Z' },
    { item_id: 'campari', movement_type: 'restock', quantity_change: 12, created_at: '2026-09-24T11:00:00Z' },
    { item_id: 'campari', movement_type: 'count', quantity_change: 3, created_at: '2026-09-24T13:10:00Z' },
    { item_id: 'aperol', movement_type: 'restock', quantity_change: 4, created_at: '2026-09-24T11:59:59Z' },
    { item_id: 'limes', movement_type: 'restock', quantity_change: 40, created_at: '2026-09-24T13:00:00Z' },
  ];
  const changed = changedAfterCount(lines, movements);
  assert.equal(changed.length, 1);
  assert.deepEqual({ ...changed[0] }, { itemId: 'campari', name: 'Campari', unit: 'bottles', delta: 5, count: 2 });
  assert.equal(changedAfterCountText(changed[0]), 'Campari: +5 bottles recorded after it was counted');
  assert.deepEqual([...changedAfterCount(null, null)], []);
});

test('the Verify anyway dialog explains that later changes are added on top, and the server stamps counted_at', () => {
  const workspace = read('apps/web/assets/js/stock-count-workspace.js');
  assert.doesNotMatch(workspace, /Verify anyway and keep the counted quantities\?/);
  assert.match(workspace, /anything recorded after that is added on top, so nothing is erased/);
  assert.match(workspace, /list: changed\.map\(changedAfterCountText\)/);
  const sql = read('supabase/migrations/20260929090000_s90_stock_adjust_idempotency.sql');
  assert.match(sql, /'current',least\(coalesce\(line\.counted_at,now\(\)\),now\(\)\),now\(\)\+make_interval/);
  assert.match(sql, /where atlas_private\.inventory_verified_balances\.verification_status<>'current'\s+or atlas_private\.inventory_verified_balances\.verified_at<=excluded\.verified_at;/);
});

test('with the balance stamped at counted_at, the canonical projection keeps a delivery made before verification', async () => {
  const { projectStock } = await import('../../supabase/functions/_shared/atlas-domain.mjs');
  const counted = '2026-09-24T12:00:00.000Z';
  const verified = '2026-09-24T14:00:00.000Z';
  const item = { id: 'cynar', name: 'Cynar', active: true, par_level: 2, quantity: 9 };
  const movements = [
    { item_id: 'cynar', movement_type: 'waste', quantity_change: -1, created_at: '2026-09-24T11:00:00.000Z' },
    { item_id: 'cynar', movement_type: 'restock', quantity_change: 6, created_at: '2026-09-24T13:00:00.000Z' },
  ];
  const now = Date.parse('2026-09-24T15:00:00.000Z');
  const project = (verifiedAt) => projectStock([item],
    [{ inventory_item_id: 'cynar', verified_quantity: 2, freshness_state: 'current', verified_at: verifiedAt, expires_at: '2026-10-01T14:00:00.000Z' }],
    movements, now)[0].quantity;
  assert.equal(project(counted), 8, 'counted 2 + delivered 6');
  assert.equal(project(verified), 2, 'the pre-S90 stamp (verification time) erased the delivery');
});

// ---------------------------------------------------------------------------
// P2-2: waste and deliveries without an order are idempotent
// ---------------------------------------------------------------------------
test('waste and deliveries without an order use adjust_inventory_v2 with one request id per dialog', () => {
  const inventory = read('apps/web/assets/js/atlas-inventory.js');
  const purchasing = read('apps/web/assets/js/atlas-purchasing.js');
  assert.match(inventory, /rpc\('adjust_inventory_v2', \{\s*p_request_id: requestId,/);
  const waste = inventory.slice(inventory.indexOf('function openWasteDialog'), inventory.indexOf('// Visual Inventory flows'));
  assert.ok(waste.indexOf('const requestId = uuid();') < waste.indexOf("addEventListener('submit'"), 'the waste request id is chosen once per dialog');
  assert.match(waste, /adjustStock\(\{\s*requestId, itemId: item\.id, change: -quantity, type: 'waste'/);
  const receive = purchasing.slice(purchasing.indexOf('function openReceiveAny'), purchasing.indexOf('// Suppliers'));
  assert.ok(receive.indexOf('const requestId = uuid();') < receive.indexOf("addEventListener('submit'"), 'the delivery request id is chosen once per form');
  assert.match(receive, /requestId, itemId: chosen\.id, change: quantity, type: 'restock'/);
  for (const source of [inventory, purchasing]) {
    assert.doesNotMatch(source, /rpc\('adjust_inventory',/);
    assert.doesNotMatch(source, /Stock is unchanged\. Check your connection/);
  }
  assert.match(inventory, /We couldn’t confirm the save\. Check Movements before trying again\./);
});

test('adjust_inventory_v2 is an invoker wrapper over a manager-gated definer with a per-actor request ledger', () => {
  const sql = read('supabase/migrations/20260929090000_s90_stock_adjust_idempotency.sql');
  assert.match(sql, /primary key \(actor_id, request_id\)/);
  assert.match(sql, /revoke all on table atlas_private\.stock_adjustment_requests from public, anon, authenticated;/);
  assert.match(sql, /create or replace function private\.adjust_inventory_request\([\s\S]+?security definer\s+set search_path = ''/);
  assert.match(sql, /create or replace function public\.adjust_inventory_v2\([\s\S]+?security invoker\s+set search_path = ''[\s\S]+?return private\.adjust_inventory_request\(/);
  assert.match(sql, /revoke all on function public\.adjust_inventory_v2\(text, uuid, numeric, text, numeric, uuid, text\) from public, anon;/);
  assert.match(sql, /revoke all on function private\.adjust_inventory_request\(text, uuid, numeric, text, numeric, uuid, text\) from public, anon;/);
  assert.match(sql, /select \* into movement_row from public\.inventory_movements m where m\.id = existing\.movement_id;/);
  const gate = read('scripts/verify_phase1_security_gate.sql');
  assert.match(gate, /'public\.adjust_inventory_v2\(text,uuid,numeric,text,numeric,uuid,text\)',\s*'private\.adjust_inventory_request\(text,uuid,numeric,text,numeric,uuid,text\)'/);
  const workflow = read('.github/workflows/migration-replay.yml');
  assert.match(workflow, /run: bash scripts\/verify_s90_workflow_integrity_previews\.sh/);
  assert.match(read('scripts/verify_s90_workflow_integrity_previews.sh'), /verify_s90_workflow_integrity_preview\.sql/);
});

// ---------------------------------------------------------------------------
// P3: opening hours conflicts (browser and server share the rule)
// ---------------------------------------------------------------------------
const week = (overrides = {}) => [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
  weekday, is_open: true, open_time: '16:00', close_time: '23:00', close_next_day: false, ...(overrides[weekday] || {}),
}));
const HOURS_CASES = [
  [week(), null],
  [week({ 1: { close_time: '16:00' } }), /Monday opens and closes at the same time/],
  [week({ 2: { close_time: '02:00' } }), /Tuesday closes before it opens\. Tick Next day/],
  [week({ 2: { close_time: '02:00', close_next_day: true } }), null],
  [week({ 5: { close_time: '18:00', close_next_day: true } }), /Friday would be open for more than 24 hours/],
  [week({ 5: { close_time: '16:00', close_next_day: true } }), null],
  [week({ 5: { close_time: '16:00', close_next_day: true }, 6: { open_time: '15:00' } }), /Friday closes at 16:00 after midnight, but Saturday opens at 15:00/],
  [week({ 6: { close_time: '03:00', close_next_day: true }, 0: { open_time: '02:00' } }), /Saturday closes at 03:00 after midnight, but Sunday opens at 02:00/],
  [week({ 0: { close_time: '03:00', close_next_day: true }, 1: { open_time: '03:00' } }), null],
  [week({ 6: { close_time: '03:00', close_next_day: true }, 0: { is_open: false, open_time: null, close_time: null } }), null],
];

test('the Settings hours editor refuses zero-length, backwards, over-24h and overlapping days', () => {
  const source = read('apps/web/assets/js/settings-workspace.js');
  const fn = source.match(/\n {2}function hoursProblem\(rows\) \{[\s\S]+?\n {2}\}\n\n {2}function hhmm/)?.[0]?.replace(/function hhmm$/, '');
  assert.ok(fn, 'settings-workspace.js defines hoursProblem');
  const context = vm.createContext({});
  vm.runInContext(`${fn}\nthis.hoursProblem = hoursProblem;`, context);
  for (const [rows, expected] of HOURS_CASES) {
    const problem = context.hoursProblem(rows);
    if (expected === null) assert.equal(problem, null, JSON.stringify(rows));
    else assert.match(problem?.text || '', expected);
  }
  // A missing time or a conflict: the submit checks both before saving.
  assert.match(source, /const problem = missing[\s\S]{0,400}: hoursProblem\(/);
  assert.match(source, /data-settings-hours-conflict/);
});

test('atlas-settings save-hours refuses the same conflicts server-side', { skip: !canStrip }, () => {
  const edge = read('supabase/functions/atlas-settings/index.ts');
  const code = nodeModule.stripTypeScriptTypes(block(edge, 's90-hours-helpers'));
  const context = vm.createContext({});
  vm.runInContext(`${code}\nthis.businessHoursProblem = businessHoursProblem;`, context);
  for (const [rows, expected] of HOURS_CASES) {
    const serverRows = rows.map((row) => ({ ...row, open_time: row.open_time ? `${row.open_time}:00` : null, close_time: row.close_time ? `${row.close_time}:00` : null }));
    const problem = context.businessHoursProblem(serverRows);
    if (expected === null) assert.equal(problem, null, JSON.stringify(rows));
    else assert.match(problem?.text || '', expected);
  }
  const validate = edge.slice(edge.indexOf('function validateHours'), edge.indexOf('Deno.serve('));
  assert.match(validate, /const conflict = businessHoursProblem\(validated\);\s+if \(conflict\) throw new ApiError\(400, conflict\.text\);/);
});

// ---------------------------------------------------------------------------
// P2-6: invitations carry the name the trigger reads and land on invitation.html
// ---------------------------------------------------------------------------
test('invites send full_name (read by handle_new_user) and redirect to invitation.html on an https app origin', { skip: !canStrip }, () => {
  const edge = read('supabase/functions/atlas-team-profiles/index.ts');
  const code = nodeModule.stripTypeScriptTypes(block(edge, 's90-invite-helpers'));
  const context = vm.createContext({ URL });
  vm.runInContext(`${code}\nthis.helpers = { invitationRedirect, invitationMetadata };`, context);
  const { invitationRedirect, invitationMetadata } = context.helpers;
  assert.deepEqual({ ...invitationMetadata('Þórdís Ævarsdóttir') }, { full_name: 'Þórdís Ævarsdóttir', display_name: 'Þórdís Ævarsdóttir' });
  assert.deepEqual({ ...invitationMetadata(null) }, {});
  assert.equal(invitationRedirect(undefined, undefined), 'https://os-vabar.netlify.app/invitation.html');
  assert.equal(invitationRedirect('https://atlas.example.is', undefined), 'https://atlas.example.is/invitation.html');
  assert.equal(invitationRedirect('https://atlas.example.is/', undefined), 'https://atlas.example.is/invitation.html');
  assert.equal(invitationRedirect(undefined, 'https://staging.example.is, https://other.example.is'), 'https://staging.example.is/invitation.html');
  for (const unsafe of ['http://atlas.example.is', 'https://user:pw@atlas.example.is', 'https://atlas.example.is/app', 'https://atlas.example.is?x=1', 'javascript:alert(1)', 'not a url']) {
    assert.equal(invitationRedirect(unsafe, undefined), 'https://os-vabar.netlify.app/invitation.html', unsafe);
  }
  assert.match(edge, /data: invitationMetadata\(displayName\),/);
  assert.match(edge, /searchParams\.set\("redirect_to", invitationRedirect\(Deno\.env\.get\("ATLAS_APP_ORIGIN"\), Deno\.env\.get\("ATLAS_INTEGRATIONS_APP_ORIGINS"\)\)\)/);
  const trigger = read('supabase/migrations/20260910094217_atlas_phase1_production_adoption.sql');
  assert.match(trigger, /new\.raw_user_meta_data ->> 'full_name'/);
  assert.match(read('apps/web/assets/js/account-invitation.js'), /verifyOtp\(\{ token_hash: token, type: 'invite' \}\)/);
});
