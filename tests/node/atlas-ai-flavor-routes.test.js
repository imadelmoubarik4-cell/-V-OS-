// atlas-ai Flavor Intelligence routes: flavor-map, flavor-search,
// flavor-candidates and flavor-compose run the REAL Tool Gateway (role
// checks, strict arguments, redaction, audit) against the VÁ evaluation
// world, without an OpenAI key; flavor-compose stores a recipe.draft
// proposal that the unchanged execute-action route approves.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as realGateway from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { clearFlavorSnapshotCache } from '../../supabase/functions/_shared/ai-tools/services.mjs';
import { FLAVOR_RATE_LIMIT } from '../../supabase/functions/atlas-ai/handler.mjs';
import { createHandler, request, USERS } from './helpers/atlas-ai-harness.mjs';
import { createWorld, IDS, NOW } from '../ai-evals/fixtures/world.mjs';

const COST_KEYS = ['cost', 'cost_per_serve', 'margin_at_price', 'costing', 'line_costs', 'cost_price', 'estimated_total'];

function setup({ aiEnabled = true } = {}) {
  clearFlavorSnapshotCache();
  const world = createWorld();
  const harness = createHandler({ gateway: realGateway, env: { OPENAI_API_KEY: undefined }, fetchOptions: { fallback: world.fetch }, now: () => NOW });
  harness.db.settings.enabled = aiEnabled;
  return { world, ...harness };
}

const json = async (response) => ({ status: response.status, body: await response.json() });
const get = (action, query, user = USERS.manager) => request(action, { method: 'GET', query, user });

function keysOf(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((entry) => keysOf(entry, keys));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { keys.add(key); keysOf(entry, keys); }
  return keys;
}

async function ideas(handle, body, user = USERS.manager) {
  return json(await handle(request('flavor-candidates', { user, body })));
}

test('flavor-map works without an OpenAI key or the AI switch and returns the map contract', async () => {
  const { handle, db } = setup({ aiEnabled: false });
  const { status, body } = await json(await handle(get('flavor-map', '&ingredient=gin&limit=6', USERS.bartender)));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.center.slug, 'london-dry-gin');
  assert.equal(body.center.stock_status, 'available');
  assert.equal(body.nodes[0].center, true);
  assert.equal(body.nodes.length, body.edges.length + 1);
  for (const edge of body.edges) {
    assert.equal(edge.source, 'london-dry-gin');
    assert.ok(body.nodes.some((node) => node.slug === edge.target));
    for (const key of ['relation', 'strength', 'aroma', 'taste', 'texture', 'evidence_type', 'confidence', 'explanation', 'provider']) assert.ok(key in edge, key);
    assert.notEqual(edge.evidence_type, 'scientific');
  }
  assert.equal(body.stock['london-dry-gin'].status, 'available');
  assert.deepEqual(Object.keys(body.filters_available).sort(), ['evidence', 'existing_recipes', 'high_margin', 'in_stock_only', 'low_complexity', 'relations', 'use_soon', 'uses']);
  assert.equal(body.filters_available.high_margin, false, 'bartenders get no margin filter');
  assert.equal(body.filters_available.use_soon, false, 'no verified overstock in the world');
  assert.equal(body.filters_available.existing_recipes, true, 'Negroni and G&T give Atlas-recipe pairings');
  assert.ok(Array.isArray(body.evidence) && body.summary);
  const audit = db.toolCalls.at(-1);
  assert.equal(audit.p_tool_name, 'flavor.pairings');
  assert.equal(audit.p_actor_role, 'bartender');
  assert.equal(audit.p_run_id, null);
  assert.equal(audit.p_status, 'ok');
  assert.ok(!db.calls.some((call) => call.name === 'atlas_ai_rate_check' || call.name === 'atlas_ai_run_start'), 'no model turn is used');
});

test('flavor-map filters, default centre and errors', async () => {
  const { handle } = setup();
  const stocked = await json(await handle(get('flavor-map', '&ingredient=gin&in_stock_only=true&evidence=culinary')));
  assert.equal(stocked.status, 200);
  assert.ok(stocked.body.nodes.slice(1).every((node) => node.in_stock));
  assert.ok(stocked.body.edges.every((edge) => edge.evidence.every((entry) => entry.evidence_type === 'culinary')));
  const centre = await json(await handle(get('flavor-map', '')));
  assert.equal(centre.status, 200);
  assert.equal(centre.body.center.in_stock, true, 'default centre is an in-stock ingredient');
  const missing = await json(await handle(get('flavor-map', '&ingredient=unobtainium')));
  assert.equal(missing.status, 404);
  const badLimit = await json(await handle(get('flavor-map', '&ingredient=gin&limit=abc')));
  assert.equal(badLimit.status, 400);
  const wrongMethod = await json(await handle(request('flavor-map', { body: {} })));
  assert.equal(wrongMethod.status, 405);
  const anonymous = await handle(new Request('https://branch.example.test/functions/v1/atlas-ai?action=flavor-map', { method: 'GET' }));
  assert.equal(anonymous.status, 401);
});

test('flavor-search resolves aliases and requires a query', async () => {
  const { handle } = setup();
  const found = await json(await handle(get('flavor-search', `&q=${encodeURIComponent('sítróna')}`, USERS.viewer)));
  assert.equal(found.status, 200);
  assert.equal(found.body.results[0].slug, 'lemon');
  assert.equal(found.body.results[0].stock_status, 'available');
  const empty = await json(await handle(get('flavor-search', '&q=')));
  assert.equal(empty.status, 400);
});

test('flavor-substitutes lists recorded and calculated substitutes with stock status', async () => {
  const { handle, db } = setup({ aiEnabled: false });
  const found = await json(await handle(get('flavor-substitutes', '&ingredient=lemon&limit=5', USERS.bartender)));
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(found.body.original.slug, 'lemon');
  assert.ok(found.body.original.stock && typeof found.body.original.stock.status === 'string');
  assert.ok(Array.isArray(found.body.substitutes));
  for (const row of found.body.substitutes) {
    assert.ok(['recorded', 'profile'].includes(row.basis));
    if (row.basis === 'profile') assert.equal(row.evidence_type, null, 'a calculated match is never labelled as recorded evidence');
    assert.notEqual(row.evidence_type, 'scientific');
    assert.ok('stock_status' in row && Array.isArray(row.differences));
  }
  assert.equal(db.toolCalls.at(-1).p_tool_name, 'flavor.substitutes');
  const empty = await json(await handle(get('flavor-substitutes', '&ingredient=')));
  assert.equal(empty.status, 400);
  const missing = await json(await handle(get('flavor-substitutes', '&ingredient=unobtainium')));
  assert.equal(missing.status, 404);
});

test('flavor-candidates: verified stock only, every dimension, no cost for staff', async () => {
  const { handle, world } = setup();
  const manager = await ideas(handle, { type: 'cocktail', seed: ['gin'], exclude: { families: ['citrus'] }, no_new_purchases: true, limit: 3 });
  assert.equal(manager.status, 200, JSON.stringify(manager.body));
  assert.ok(manager.body.candidates.length > 0);
  const itemIds = new Set(Object.values(IDS.item));
  const neverStock = [IDS.item.kahlua, IDS.item.angostura, IDS.item.kristall, IDS.item.aperol, IDS.item.cranberry];
  for (const candidate of manager.body.candidates) {
    assert.ok(candidate.compose_request.candidate_key.startsWith('v1|'));
    assert.ok(Number.isFinite(candidate.scores.economics.cost_per_serve));
    assert.ok(!candidate.ingredients.some((part) => ['lemon', 'lime', 'orange-liqueur'].includes(part.slug)));
    for (const line of candidate.lines) {
      assert.ok(itemIds.has(line.item_id));
      assert.ok(!neverStock.includes(line.item_id), `${line.item_name} has no current verified count`);
    }
  }
  assert.equal(manager.body.request.no_new_purchases, true);
  assert.ok(Array.isArray(manager.body.unused_seeds) && Array.isArray(manager.body.unmeasurable), 'honest leftovers are returned');
  const staff = await ideas(handle, { type: 'cocktail', goal: 'high_margin', limit: 3 }, USERS.bartender);
  assert.equal(staff.status, 200);
  const keys = keysOf(staff.body);
  for (const key of COST_KEYS) assert.ok(!keys.has(key), key);
  assert.doesNotMatch(JSON.stringify(staff.body.evidence), /\d kr\b/);
  assert.equal(staff.body.goal, 'balanced');
  const invalid = await ideas(handle, { type: 'brunch' });
  assert.equal(invalid.status, 400);
  const unmet = await ideas(handle, { seed: ['rhubarb'] });
  assert.equal(unmet.status, 200);
  assert.deepEqual(unmet.body.candidates, []);
  assert.equal(unmet.body.unmet_seeds[0].slug, 'rhubarb');
  assert.match(unmet.body.summary, /not stocked in Atlas/);
  assert.deepEqual(world.writes, [], 'reading ideas writes nothing');
});

test('flavor-compose stores a conversation-less recipe.draft proposal that execute-action approves unchanged', async () => {
  const { handle, db, world } = setup();
  const found = await ideas(handle, { type: 'cocktail', seed: ['gin'], limit: 2 });
  const candidate = found.body.candidates[0].compose_request;
  const staff = await json(await handle(request('flavor-compose', { user: USERS.bartender, body: { candidate } })));
  assert.equal(staff.status, 403);
  assert.equal(db.toolCalls.at(-1).p_decision, 'denied');
  const composed = await json(await handle(request('flavor-compose', { body: { candidate } })));
  assert.equal(composed.status, 200, JSON.stringify(composed.body));
  const { proposal } = composed.body;
  assert.equal(proposal.kind, 'recipe.draft');
  assert.deepEqual(proposal.required_roles, ['admin', 'manager']);
  assert.equal(proposal.status, 'proposed');
  assert.match(proposal.preview.headline, /^Draft recipe "/);
  const stored = db.actions.get(proposal.id);
  assert.equal(stored.conversation_id, null);
  assert.equal(stored.command.recipe.active, false);
  assert.ok(stored.command.ingredients.every((line) => Object.values(IDS.item).includes(line.item_id)));
  assert.ok(db.proposalsRecorded.some((entry) => entry.p_action_id === proposal.id), 'recorded in the Brain like chat proposals');
  assert.equal(composed.body.draft.name, stored.command.recipe.name);
  assert.deepEqual(world.writes, [], 'nothing saved before approval');
  // A bartender cannot see, let alone approve, a manager's proposal.
  const denied = await json(await handle(request('execute-action', { user: USERS.bartender, body: { action_id: proposal.id } })));
  assert.equal(denied.status, 404);
  assert.deepEqual(world.writes, []);
  const approved = await json(await handle(request('execute-action', { body: { action_id: proposal.id } })));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.ok, true);
  assert.equal(approved.body.action.status, 'executed');
  const write = world.writes.find((entry) => entry.name === 'atlas_save_recipe');
  assert.equal(write.token, 'token-manager-on', 'saved with the approver JWT');
  assert.equal(write.args.p_recipe_id, null);
  assert.equal(write.args.p_recipe.active, false);
  assert.equal(write.args.p_recipe.show_on_menu, false);
  const recordRef = approved.body.result.records[0];
  assert.equal(recordRef.type, 'recipe');
  assert.match(recordRef.route, /^#recipes\/[0-9a-f-]{36}$/);
  const twice = await json(await handle(request('execute-action', { body: { action_id: proposal.id } })));
  assert.equal(twice.status, 409);
});

test('flavor-compose refuses stale ideas and a second draft with the same name fails clearly', async () => {
  const { handle, world } = setup();
  const found = await ideas(handle, { type: 'cocktail', seed: ['gin'], limit: 1 });
  const candidate = found.body.candidates[0].compose_request;
  const first = await json(await handle(request('flavor-compose', { body: { candidate } })));
  const second = await json(await handle(request('flavor-compose', { body: { candidate } })));
  assert.equal(first.body.draft.name, second.body.draft.name);
  const ok = await json(await handle(request('execute-action', { body: { action_id: first.body.proposal.id } })));
  assert.equal(ok.body.ok, true);
  const clash = await json(await handle(request('execute-action', { body: { action_id: second.body.proposal.id } })));
  assert.equal(clash.status, 200);
  assert.equal(clash.body.ok, false);
  assert.equal(clash.body.error.code, 'name_taken');
  assert.match(clash.body.error.message, /already exists/);
  // The idea's gin loses its verified count: composing it again is refused.
  const ginIds = new Set([IDS.item.tanqueray, IDS.item.beefeater]);
  world.data.balances = world.data.balances.filter((row) => !ginIds.has(row.inventory_item_id));
  const stale = await json(await handle(request('flavor-compose', { body: { candidate } })));
  assert.equal(stale.status, 409);
  assert.match(stale.body.message, /no longer available from verified stock/);
  const missingKey = await json(await handle(request('flavor-compose', { body: { candidate: {} } })));
  assert.equal(missingKey.status, 400);
});

test('flavour routes are rate limited per person', async () => {
  const { handle } = setup();
  let last;
  for (let call = 0; call <= FLAVOR_RATE_LIMIT.max; call += 1) last = await handle(get('flavor-search', '&q=gin', USERS.viewer));
  assert.equal(last.status, 429);
  const other = await handle(get('flavor-search', '&q=gin', USERS.bartender));
  assert.equal(other.status, 200, 'another person is not affected');
});
