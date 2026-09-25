import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as nodeModule from 'node:module';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const EDGE = read('supabase/functions/atlas-item-master/index.ts');
const MIGRATION = read('supabase/migrations/20260926092000_s88_inventory_item_activation.sql');
const canStrip = typeof nodeModule.stripTypeScriptTypes === 'function';
const ITEM = '00000000-0000-4000-8000-000000088501';

function loadHelpers() {
  const start = EDGE.indexOf('// s88-activation-helpers:start');
  const end = EDGE.indexOf('// s88-activation-helpers:end');
  assert.ok(start >= 0 && end > start, 'missing helper block');
  const context = { Array, Object, String, Number, Date };
  vm.createContext(context);
  const code = nodeModule.stripTypeScriptTypes(EDGE.slice(start, end));
  vm.runInContext(`class ApiError extends Error { constructor(status, message, code = null) { super(message); this.status = status; this.code = code; } }
${code}
this.helpers = { activationRequest, activationErrorStatus, rpcErrorCode, ApiError };`, context);
  return context.helpers;
}

function refusal(fn) {
  try {
    fn();
  } catch (error) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return null;
}

test('activation request is normalised for the service-role RPC', { skip: !canStrip }, () => {
  const { activationRequest } = loadHelpers();
  assert.deepEqual({ ...activationRequest({ item_id: ITEM.toUpperCase(), active: false, reason: '  Seasonal  ' }) }, {
    p_item_id: ITEM,
    p_active: false,
    p_reason: 'Seasonal',
    p_expected_updated_at: null,
  });
  const stamp = '2026-09-24T12:00:00.123456+00:00';
  assert.equal(activationRequest({ item_id: ITEM, active: true, expected_updated_at: stamp }).p_expected_updated_at, stamp);
  assert.equal(activationRequest({ item_id: ITEM, active: true, reason: '   ' }).p_reason, null);
});

test('invalid activation requests are refused before the database', { skip: !canStrip }, () => {
  const { activationRequest } = loadHelpers();
  for (const body of [
    { item_id: 'not-a-uuid', active: true },
    { item_id: ITEM },
    { item_id: ITEM, active: 'false' },
    { item_id: ITEM, active: true, reason: 7 },
    { item_id: ITEM, active: true, reason: 'x'.repeat(501) },
    { item_id: ITEM, active: true, expected_updated_at: 'yesterday' },
    null,
  ]) {
    const error = refusal(() => activationRequest(body));
    assert.ok(error, JSON.stringify(body));
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_request');
  }
});

test('database refusals map to HTTP statuses the dialog can act on', { skip: !canStrip }, () => {
  const { activationErrorStatus, rpcErrorCode } = loadHelpers();
  assert.equal(rpcErrorCode('atlas:open_purchase_order'), 'open_purchase_order');
  assert.equal(activationErrorStatus(400, 'open_purchase_order'), 409);
  assert.equal(activationErrorStatus(400, 'active_duplicate_name'), 409);
  assert.equal(activationErrorStatus(400, 'stale_item'), 409);
  assert.equal(activationErrorStatus(403, 'forbidden'), 403);
  assert.equal(activationErrorStatus(404, 'not_found'), 404);
  assert.equal(activationErrorStatus(400, null), 400);
  assert.equal(activationErrorStatus(502, null), 500);
});

test('atlas-item-master exposes manager-only dependency and activation actions', () => {
  assert.match(EDGE, /const FUNCTION_VERSION = "0\.2\.0";/);
  assert.match(EDGE, /const MANAGER_ROLES = new Set\(\["admin", "manager"\]\);/);
  // Shared gateway check (_shared/auth.mjs): an inactive profile is refused, then the manager role.
  assert.match(EDGE, /const actor = await resolveActor\(request, Deno\.env, fetch\);\s*requireRole\(actor, MANAGER_ROLES, "Checkpoint L2 is available only to managers and administrators\."\);/);
  const serve = EDGE.slice(EDGE.indexOf('Deno.serve('));
  assert.ok(serve.indexOf('await requireManager(request)') < serve.indexOf('item_dependencies'));
  assert.match(serve, /branchRpc\("atlas_inventory_item_dependencies", \{\s*p_item_id: activationItemId\(url\.searchParams\.get\("item_id"\)\),\s*p_actor_id: context\.user\.id,/);
  assert.match(serve, /branchRpc\("atlas_set_inventory_item_active", \{\s*\.\.\.activationRequest\(body\),\s*p_actor_id: context\.user\.id,\s*p_actor_label: labelFor\(context\),/);
  assert.match(serve, /error\.code \? \{ error: error\.message, code: error\.code \}/);
});

test('migration audits every active flip and guards the two traps', () => {
  assert.match(MIGRATION, /after update of active on public\.inventory_items/);
  assert.match(MIGRATION, /create or replace function private\.inventory_item_active_audit\(\)\s*returns trigger\s*language plpgsql\s*security definer\s*set search_path = ''/);
  assert.match(MIGRATION, /revoke all on function private\.inventory_item_active_audit\(\) from public, anon, authenticated;/);
  assert.match(MIGRATION, /'item_deactivated','item_reactivated','par_levels_updated'/);
  assert.match(MIGRATION, /hint = 'atlas:open_purchase_order'/);
  assert.match(MIGRATION, /hint = 'atlas:active_duplicate_name'/);
  assert.match(MIGRATION, /hint = 'atlas:stale_item'/);
  assert.match(MIGRATION, /profile\.role::text in \('admin', 'manager'\)/);
  assert.match(MIGRATION, /grant execute on function %s to service_role/);
  assert.doesNotMatch(MIGRATION, /to authenticated/i);
  // Recipe links, pars, supplier and quantity are never written by the command.
  const command = MIGRATION.slice(MIGRATION.indexOf('create or replace function atlas_private.set_inventory_item_active'));
  const update = command.slice(command.indexOf('update public.inventory_items'), command.indexOf('returning * into item_row'));
  assert.match(update, /set active = p_active,\s*updated_by = p_actor_id::text\s*where id = p_item_id/);
  assert.doesNotMatch(command, /recipe_ingredients\s+set|delete from/i);
});
