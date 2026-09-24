import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as nodeModule from 'node:module';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const EDGE = read('supabase/functions/atlas-operations-checkpoint-a/index.ts');
const MIGRATION = read('supabase/migrations/20260926091000_s88_shared_daily_checklists.sql');
const canStrip = typeof nodeModule.stripTypeScriptTypes === 'function';

const OPENING = ['cash-pos', 'coffee-machine', 'ice', 'garnish', 'glassware', 'bar-stock', 'music-lighting', 'toilets', 'tablet'];
const CLOSING = ['cash-close', 'dishwasher', 'waste', 'alcohol', 'bar-clean', 'equipment', 'lights', 'alarm', 'shift-report'];

function loadHelpers() {
  const start = EDGE.indexOf('// s88-operations-helpers:start');
  const end = EDGE.indexOf('// s88-operations-helpers:end');
  assert.ok(start >= 0 && end > start, 'missing helper block');
  const context = { Array, Object, String };
  vm.createContext(context);
  const code = nodeModule.stripTypeScriptTypes(EDGE.slice(start, end));
  vm.runInContext(`${code}\nthis.helpers = { rpcErrorCode, rpcErrorStatus, dailyChecklistSummary };`, context);
  return context.helpers;
}

test('database refusals map to stable HTTP statuses and codes', { skip: !canStrip }, () => {
  const { rpcErrorCode, rpcErrorStatus } = loadHelpers();
  assert.equal(rpcErrorCode('atlas:checklist_day_closed'), 'checklist_day_closed');
  assert.equal(rpcErrorCode('something else'), null);
  assert.equal(rpcErrorCode(null), null);
  assert.equal(rpcErrorStatus(400, 'checklist_day_closed'), 409);
  assert.equal(rpcErrorStatus(400, 'routine_closed'), 409);
  assert.equal(rpcErrorStatus(403, 'forbidden'), 403);
  assert.equal(rpcErrorStatus(400, 'not_found'), 404);
  assert.equal(rpcErrorStatus(400, null), 400);
  assert.equal(rpcErrorStatus(404, null), 400);
  assert.equal(rpcErrorStatus(503, null), 500);
});

test('checklist summary counts required ticks only', { skip: !canStrip }, () => {
  const { dailyChecklistSummary } = loadHelpers();
  assert.equal(dailyChecklistSummary(null), null);
  const summary = dailyChecklistSummary({
    id: 'i1',
    status: 'in_progress',
    items: [
      { required: true, completed: true },
      { required: true, completed: false },
      { required: false, completed: true },
    ],
  });
  assert.deepEqual({ ...summary }, { instance_id: 'i1', status: 'in_progress', required: 2, completed: 1 });
});

test('snapshot defaults to the server business date and daily-checklists is a read for every active role', () => {
  assert.match(EDGE, /const FUNCTION_VERSION = "0\.2\.0";/);
  assert.match(EDGE, /branchRpc\("atlas_operations_business_date"\)/);
  assert.match(EDGE, /const localDate = requestedDate \? requireDate\(requestedDate\) : await businessDate\(\);/);
  const daily = EDGE.slice(EDGE.indexOf('if (action === "daily-checklists")'), EDGE.indexOf('if (action === "settings")'));
  assert.match(daily, /branchRpc\("atlas_operations_daily_checklists", \{\s*p_business_date: requestedDate \? requireDate\(requestedDate\) : null,/);
  assert.doesNotMatch(daily, /requireWriter|requireManager/);
  assert.match(daily, /device_storage: false/);
});

test('ticks stay writer-only and reuse set-item', () => {
  const setItem = EDGE.slice(EDGE.indexOf('case "set-item"'), EDGE.indexOf('case "complete-routine"'));
  assert.match(setItem, /requireWriter\(context\);/);
  assert.match(setItem, /branchRpc\("atlas_operations_set_item"/);
  assert.match(EDGE, /const WRITE_ROLES = new Set\(\["admin", "manager", "bartender"\]\);/);
  assert.match(EDGE, /error\.code \? \{ error: error\.message, code: error\.code \}/);
});

test('migration seeds the nine opening and nine closing items without invented times', () => {
  for (const key of [...OPENING, ...CLOSING]) assert.match(MIGRATION, new RegExp(`\\('${key}','`), key);
  assert.match(MIGRATION, /'daily-opening-checklist','Opening checklist'[\s\S]*?'opening','daily',array\[0,1,2,3,4,5,6\]::smallint\[\],null,null,'any_active_staff'/);
  assert.match(MIGRATION, /'daily-closing-checklist','Closing checklist'[\s\S]*?'closing','daily',array\[0,1,2,3,4,5,6\]::smallint\[\],null,null,'any_active_staff'/);
  assert.match(MIGRATION, /on conflict \(template_key\) do nothing/);
  assert.match(MIGRATION, /template\.routine_type not in \('temperature','opening','closing'\)/);
  assert.match(MIGRATION, /at time zone atlas_private\.venue_timezone\(\)/);
  assert.doesNotMatch(MIGRATION, /at time zone 'Atlantic\/Reykjavik'/);
});

test('set_routine_item re-checks the writer and refuses closed days', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function atlas_private.set_routine_item'), MIGRATION.indexOf('create or replace function atlas_private.operations_business_date'));
  assert.match(fn, /profile\.role::text in \('admin','manager','bartender'\)/);
  assert.match(fn, /profile\.active is true/);
  assert.match(fn, /errcode='42501'/);
  assert.match(fn, /instance_row\.scheduled_date < atlas_private\.venue_business_date\(\) - 1/);
  assert.match(fn, /'routine_item_updated'/);
  assert.match(MIGRATION, /revoke all on function %s from public, anon, authenticated/);
  assert.doesNotMatch(MIGRATION, /to authenticated/i);
});
