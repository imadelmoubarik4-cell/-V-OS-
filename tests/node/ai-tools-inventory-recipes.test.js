// Atlas AI inventory and recipe tools: numbers from the canonical _shared
// rules, evidence kinds and sources, and unknown disclosure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { recipeStatus, projectStock } from '../../supabase/functions/_shared/atlas-domain.mjs';
import { balanceRows, createBackend, IDS, inventoryRows, makeCtx, movementRows, NOW, recipeRows } from './helpers/ai-tools-fixtures.js';

const run = async (role, name, args, options) => runTool(name, args, makeCtx(role, options).ctx);

test('current stock is the verified count, never the raw imported quantity', async () => {
  const result = await run('manager', 'inventory.current_stock', { item_ids: [IDS.angelo, IDS.pinotNoir], query: null, category: null, limit: null });
  assert.equal(result.ok, true);
  const angelo = result.data.items.find((item) => item.id === IDS.angelo);
  const pinot = result.data.items.find((item) => item.id === IDS.pinotNoir);
  assert.equal(angelo.quantity, 10, 'verified 10, not the imported 40');
  assert.equal(angelo.quantity_status, 'current');
  assert.equal(pinot.quantity, null, 'unknown is null, never zero');
  assert.equal(pinot.quantity_status, 'unverified');
  assert.deepEqual(result.unknown, { count: 1, reason: 'No current verified count, so stock is unknown (not zero)' });
  const angeloEvidence = result.evidence.find((entry) => entry.label === 'Current stock of Angelo Pinot Grigio');
  assert.equal(angeloEvidence.kind, 'fact');
  assert.match(angeloEvidence.value, /^10 bottle \(manager-verified count\)/);
  assert.deepEqual(angeloEvidence.source, { type: 'inventory_item', id: IDS.angelo, label: 'Angelo Pinot Grigio', route: `#inventory/item/${IDS.angelo}` });
  assert.equal(result.evidence.find((entry) => entry.label === 'Current stock of House Pinot Noir').kind, 'missing');
  assert.equal(angelo.cost_price, 3000, 'managers receive cost');
  const staff = await run('bartender', 'inventory.current_stock', { item_ids: [IDS.angelo], query: null, category: null, limit: null });
  assert.equal(staff.data.items[0].quantity, 10);
  assert.ok(!('cost_price' in staff.data.items[0]) && !('supplier' in staff.data.items[0]));
});

test('below par: strict rule on verified stock and full disclosure of what cannot be judged', async () => {
  const result = await run('viewer', 'inventory.below_par', { category: null, limit: null });
  assert.deepEqual(result.data.counts, { active_items: 7, current_items: 4, below_par: 1, out_of_stock: 1, missing_par: 3, par_but_unknown_stock: 2, undeterminable: 5 });
  assert.deepEqual(result.data.below_par.map((item) => item.name), ['Angelo Pinot Grigio']);
  assert.deepEqual(result.data.out_of_stock.map((item) => item.name), ['Aperol']);
  assert.ok(!result.data.below_par.some((item) => item.name === 'Tequila Blanco'), 'stale stock is never below par');
  assert.equal(result.unknown.count, 5);
  assert.deepEqual(result.unknown.breakdown, { missing_par: 3, par_but_unknown_stock: 2 });
  assert.match(result.summary, /3 have no par level/);
  const calculation = result.evidence.find((entry) => entry.label === 'Angelo Pinot Grigio is below par');
  assert.equal(calculation.kind, 'calculation');
  assert.equal(calculation.value, '10 bottle verified < par 12');
  assert.equal(result.evidence.find((entry) => entry.label === 'Items with no par level').kind, 'missing');
  const wine = await run('viewer', 'inventory.below_par', { category: 'wine', limit: null });
  assert.equal(wine.data.counts.active_items, 2);
});

test('the 234-of-236 reality: most items without par are reported, not inferred', async () => {
  const many = Array.from({ length: 236 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Item ${index}`, category: 'Spirits', unit: 'bottle',
    par_level: index < 2 ? 5 : null, cost_price: 1000, active: true, source_updated_at: '2026-09-01',
  }));
  const backend = createBackend({ inventory: many, balances: [], movements: [], purchaseOrders: [] });
  const result = await runTool('inventory.below_par', { category: null, limit: null }, makeCtx('manager', { backend }).ctx);
  assert.equal(result.data.counts.missing_par, 234);
  assert.equal(result.data.counts.below_par, 0);
  assert.equal(result.unknown.count, 236);
  assert.match(result.summary, /234 have no par level/);
});

test('stale counts: never verified, historical, expired and older than the window', async () => {
  const result = await run('manager', 'inventory.stale_counts', { category: null, days: 7, limit: null });
  const byName = Object.fromEntries(result.data.items.map((item) => [item.name, item.reason]));
  assert.deepEqual(byName, { 'House Pinot Noir': 'unverified', Campari: 'historical', 'Tequila Blanco': 'stale', 'Tanqueray Gin': 'older_than_window' });
  assert.equal(result.data.total, 4);
  const wide = await run('manager', 'inventory.stale_counts', { category: null, days: 30, limit: null });
  assert.equal(wide.data.total, 3);
});

test('search, get and barcode lookup return records with routes and stock evidence', async () => {
  const search = await run('bartender', 'inventory.search', { query: 'pinot', category: null, include_inactive: null, limit: null });
  assert.deepEqual(search.data.items.map((item) => item.name).sort(), ['Angelo Pinot Grigio', 'House Pinot Noir']);
  assert.ok(search.records.every((entry) => entry.route.startsWith('#inventory/item/')));
  const inactive = await run('manager', 'inventory.search', { query: 'ice', category: null, include_inactive: true, limit: null });
  assert.equal(inactive.data.items[0].quantity_status, 'inactive');
  const get = await run('manager', 'inventory.get', { item_id: IDS.angelo });
  assert.deepEqual(get.data.package_size, { quantity: 750, unit: 'ml' });
  assert.equal(get.data.recent_movements.length, 2);
  assert.equal(get.evidence.find((entry) => entry.label === 'Par level').value, '12 bottle');
  const barcode = await run('viewer', 'inventory.lookup_barcode', { code: '5000299223017' });
  assert.equal(barcode.data.item.name, 'Tanqueray Gin');
  assert.equal(barcode.data.item.quantity, 4);
  const unknown = await run('viewer', 'inventory.lookup_barcode', { code: '0000000' });
  assert.equal(unknown.data.matched, false);
  assert.equal(unknown.evidence[0].kind, 'missing');
});

test('can make: Angelo Pinot Grigio 10 bottles × 750 ml at 150 ml per serving = 50 servings', async () => {
  const yes = await run('bartender', 'recipes.can_make', { recipe_id: null, recipe_query: 'pinot spritz', servings: 50 });
  assert.equal(yes.data.answer, 'yes');
  assert.equal(yes.data.servings_possible, 50);
  assert.equal(yes.data.limiting_ingredient, 'Angelo Pinot Grigio');
  const labels = Object.fromEntries(yes.evidence.map((entry) => [entry.label, entry]));
  assert.equal(labels['Stock of Angelo Pinot Grigio'].value, '10 bottle');
  assert.equal(labels['Stock of Angelo Pinot Grigio'].kind, 'fact');
  assert.equal(labels['Package size of Angelo Pinot Grigio'].value, '750 ml per bottle');
  assert.equal(labels['Pinot Spritz uses'].value, '150 ml of Angelo Pinot Grigio per 1 serving(s)');
  assert.equal(labels['Servings from Angelo Pinot Grigio'].kind, 'calculation');
  assert.match(labels['Servings from Angelo Pinot Grigio'].value, /^50 \(10 bottle ÷ 0\.2 bottle per serving\)/);
  assert.equal(labels['Servings of Pinot Spritz possible'].value, '50 (limited by Angelo Pinot Grigio)');
  const no = await run('bartender', 'recipes.can_make', { recipe_id: IDS.spritz, recipe_query: null, servings: 51 });
  assert.equal(no.data.answer, 'no');
  assert.match(no.summary, /^No — 50 servings/);
});

test('can make: Margarita is blocked by an unlinked ingredient and unknown stock — never guessed', async () => {
  const result = await run('viewer', 'recipes.can_make', { recipe_id: null, recipe_query: 'margarita', servings: 10 });
  assert.equal(result.data.answer, 'unknown');
  assert.equal(result.data.servings_possible, null);
  assert.deepEqual(result.data.blockers, [
    { name: 'Tequila Blanco', reason: 'no verified stock count' },
    { name: 'Triple sec', reason: 'not linked to an inventory item' },
  ]);
  assert.equal(result.unknown.count, 2);
  assert.ok(result.evidence.some((entry) => entry.kind === 'missing' && entry.label === 'Triple sec in Margarita'));
  assert.ok(result.evidence.some((entry) => entry.kind === 'interpretation' && entry.label === 'Ice'), 'references are ignored, not blockers');
  assert.match(result.summary, /cannot confirm Margarita/);
});

test('can make agrees with the canonical recipeStatus for every recipe', async () => {
  const items = projectStock(inventoryRows(), balanceRows(), movementRows(), NOW);
  for (const recipe of recipeRows()) {
    const expected = recipeStatus(recipe, items);
    const result = await run('manager', 'recipes.can_make', { recipe_id: recipe.id, recipe_query: null, servings: null });
    assert.equal(result.data.readiness, expected.key, recipe.name);
    assert.equal(result.data.servings_possible, expected.availability.servings, recipe.name);
  }
  const aperol = await run('manager', 'recipes.can_make', { recipe_id: IDS.aperolSpritz, recipe_query: null, servings: 1 });
  assert.equal(aperol.data.answer, 'no', 'a verified zero makes the recipe unavailable');
  const gt = await run('manager', 'recipes.can_make', { recipe_id: IDS.gt, recipe_query: null, servings: null });
  assert.equal(gt.data.servings_possible, 56);
});

test('ambiguous recipe names return candidates instead of a guess', async () => {
  const result = await run('manager', 'recipes.can_make', { recipe_id: null, recipe_query: 'spritz', servings: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.data.needs_clarification[0].status, 'ambiguous');
  assert.deepEqual(result.data.needs_clarification[0].candidates.map((entry) => entry.name).sort(), ['Aperol Spritz', 'Pinot Spritz']);
  assert.equal((await run('manager', 'recipes.get', { recipe_id: null, recipe_query: 'negroni' })).error.code, 'not_found');
  assert.equal((await run('manager', 'recipes.get', { recipe_id: null, recipe_query: null })).error.code, 'invalid_arguments');
});

test('recipes search and get report readiness and blockers', async () => {
  const search = await run('bartender', 'recipes.search', { query: null, status: null, limit: null });
  assert.deepEqual(search.data.counts, { ready: 1, attention: 1, incomplete: 1, unavailable: 1 }, 'Pinot Spritz is low: Angelo is below par');
  const incomplete = await run('bartender', 'recipes.search', { query: null, status: 'incomplete', limit: null });
  assert.deepEqual(incomplete.data.recipes.map((recipe) => recipe.name), ['Margarita']);
  const get = await run('bartender', 'recipes.get', { recipe_id: IDS.margarita, recipe_query: null });
  assert.equal(get.data.recipe.ingredients.length, 4);
  assert.equal(get.data.blockers.length, 2);
  assert.ok(!JSON.stringify(get).includes('cost_price'));
});

test('recipe cost and margins are manager-only, theoretical and complete-or-unknown', async () => {
  const cost = await run('manager', 'recipes.cost', { recipe_id: IDS.spritz, recipe_query: null });
  assert.equal(cost.data.cost_per_serving, 600);
  assert.equal(cost.data.margin_percent, 76);
  assert.match(cost.data.basis, /sales data, which is not connected/);
  const margarita = await run('manager', 'recipes.cost', { recipe_id: IDS.margarita, recipe_query: null });
  assert.equal(margarita.data.cost_per_serving, null);
  assert.equal(margarita.unknown.reason, 'Ingredients without a usable cost');
  const best = await run('admin', 'recipes.best_margin', { limit: 3, ready_only: null, menu_only: null });
  assert.deepEqual(best.data.ranked.map((row) => row.name), ['Gin & Tonic', 'Pinot Spritz', 'Aperol Spritz']);
  assert.equal(best.unknown.count, 1);
  assert.ok(best.evidence.some((entry) => entry.kind === 'missing' && entry.label === 'Realised margin'));
  const readyOnly = await run('admin', 'recipes.best_margin', { limit: 3, ready_only: true, menu_only: null });
  assert.deepEqual(readyOnly.data.ranked.map((row) => row.name), ['Gin & Tonic']);
  for (const role of ['bartender', 'viewer']) {
    assert.equal((await run(role, 'recipes.cost', { recipe_id: IDS.spritz, recipe_query: null })).error.code, 'forbidden');
    assert.equal((await run(role, 'recipes.best_margin', { limit: null, ready_only: null, menu_only: null })).error.code, 'forbidden');
  }
});
