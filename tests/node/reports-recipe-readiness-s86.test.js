import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  applyStockTrustToWorkspace,
  buildRecipeReport,
  buildStockReport,
  classifyQuantityText,
  sanitizeSnapshotInventory,
  sanitizeSnapshotRecipes,
} from '../../supabase/functions/atlas-reports/stock-provenance.mjs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');
const REPORT_STATE = { ready: 'ready', attention: 'needs_attention', unavailable: 'unavailable', incomplete: 'incomplete_setup' };

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const owner = (name, quantity, unit, extra = {}) => ({
  id: uuid(), name, quantity, unit, active: true, cost_price: 1000, par_level: null, source_type: 'owner_confirmed',
  source_confidence: 100, updated_at: '2026-09-23T22:00:00Z', source_confirmed_at: '2026-09-23T22:00:00Z',
  source_confirmed_quantity: quantity, ...extra
});
const reference = (name) => ({ id: uuid(), name, quantity: 0, unit: 'untracked', active: false, source_type: 'owner_confirmed_addition', source_confidence: 100, source_confirmed_at: null, source_confirmed_quantity: null });

// Production-shaped inventory (values from the live S85/S86 audits).
const I = {
  angelo: owner('Angelo Pinot Grigio', 10, 'bottles', { size_ml: 750 }),
  carlsberg: owner('Carlsberg 0.0%', 42, 'cans', { size_ml: 330, package_size: '24 x 330 ml' }),
  veuve: owner('Veuve Clicquot Brut Champagne', 1, 'bottles', { size_ml: 750 }),
  espresso: owner("L'OR Harmonieux Espresso Beans", 5, 'kg', { package_size: '6 x 1 kg (1 kg per bag)' }),
  coconut: owner('Kókosrjómi 20/22% 400ml', 0.8, 'liters', { size_ml: 400, package_size: '400ml can' }),
  lime: owner('Lime Juice', 4, 'liters', { size_ml: 1000, package_size: '1L' }),
  orangeJuice: owner('Fresh Orange Juice', 0, 'liters', { size_ml: 1000, source_type: 'owner_confirmed_prep' }),
  infused: owner('Chupa Chups Infused Patrón', 1, 'ml', { size_ml: 1000, source_type: 'owner_confirmed_prep' }),
  tequila: owner('Olmeca Blanco Tequila', 0, 'bottles', { size_ml: 700 }),
  aquafaba: owner('BOTANICA Very Aquafaba Vloeba', 2, 'units', { package_size: '1 kg / 1 unit' }),
  bitters: owner('Angostura Bitters', 1, 'bottles', { size_ml: 150 }),
  pie: owner('Pecan Pie', 3, 'pies', { package_size: '1 x 1.2 kg' }),
  lowWine: owner('Stemmari Rosé', 1, 'bottles', { size_ml: 750, par_level: 2 }),
  ice: reference('Ice (recipe reference)'),
  water: reference('Water (recipe reference)'),
  retired: owner('Retired Gin', 0, 'bottles', { size_ml: 700, active: false, par_level: 3 })
};
const INVENTORY = Object.values(I);
const recipe = (name, lines, extra = {}) => {
  const id = uuid();
  return {
    recipe: { id, name, type: 'cocktail', active: true, yield_quantity: 1, menu_price: 2500, show_on_menu: true, updated_at: '2026-09-20T10:00:00Z', ...extra },
    ingredients: lines.map(([item, quantity, unit]) => ({ id: uuid(), recipe_id: id, item_id: item.id, item_name: item.name, quantity, unit }))
  };
};
const RECIPES = [
  recipe('Angelo Pinot Grigio', [[I.angelo, 150, 'ml']]),
  recipe('Carlsberg 0.0%', [[I.carlsberg, 1, 'can']]),
  recipe('Veuve by the bottle', [[I.veuve, 1, 'bottle']]),
  recipe('Espresso', [[I.espresso, 9.5, 'g']]),
  recipe('Piña cream', [[I.coconut, 45, 'ml']]),
  recipe('Lime tsp', [[I.lime, 1, 'tsp']]),
  recipe('Lime tbsp', [[I.lime, 1, 'tbsp']]),
  recipe('Pecan Pie', [[I.pie, 1 / 12, 'pie']]),
  recipe('Iced Americano', [[I.espresso, 9.5, 'g'], [I.ice, 1, 'glass-fill'], [I.water, 180, 'ml']]),
  recipe('Margarita', [[I.tequila, 45, 'ml'], [I.aquafaba, 15, 'ml'], [I.lime, 30, 'ml']]),
  recipe('Manhattan', [[I.bitters, 2, 'dashes'], [I.lime, 30, 'ml']]),
  recipe('Orange Juice', [[I.orangeJuice, 300, 'ml'], [I.ice, 1, 'glass-fill']]),
  recipe('Chupa Chups', [[I.infused, 30, 'ml']]),
  recipe('House Rosé', [[I.lowWine, 150, 'ml']]),
  recipe('Retired drink', [[I.retired, 45, 'ml']], { active: false })
];
const recipes = RECIPES.map((entry) => entry.recipe);
const ingredients = RECIPES.flatMap((entry) => entry.ingredients);

function reportsFor(inventory = INVENTORY, recipeRows = recipes, ingredientRows = ingredients) {
  const stock = buildStockReport(inventory, [], {}, NOW, []);
  return { stock, report: buildRecipeReport(recipeRows, ingredientRows, inventory, stock) };
}
const byName = (report, name) => report.rows.find((row) => row.name === name);

// The browser path: AtlasStockTruth → AtlasCalculations (S85).
function browserStatuses(inventory = INVENTORY) {
  const context = { Date, Number, Math, Map, Set, String, Array, Object, JSON };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('apps/web/assets/js/atlas-stock-truth.js'), context);
  vm.runInContext(read('apps/web/assets/js/atlas-calculations.js'), context);
  const items = context.AtlasStockTruth.project(inventory, [], [], NOW);
  return new Map(recipes.filter((entry) => entry.active !== false).map((entry) => {
    const lines = ingredients.filter((line) => line.recipe_id === entry.id);
    return [entry.name, context.AtlasCalculations.recipeMetrics({ ...entry, recipe_ingredients: lines }, items).availability];
  }));
}

test('1. "1 / 1 unit" is classified, never cast, and cannot reach the private SQL', () => {
  assert.deepEqual(classifyQuantityText('1 / 1 unit').kind, 'ambiguous');
  assert.deepEqual(classifyQuantityText('1 kg / 1 unit').kind, 'ambiguous');
  const { rows, issues } = sanitizeSnapshotInventory(buildStockReport(INVENTORY, [], {}, NOW, []).rpc_inventory);
  const aquafaba = rows.find((row) => row.name === I.aquafaba.name);
  assert.equal(aquafaba.package_size, '');
  assert.ok(issues.some((issue) => issue.name === I.aquafaba.name && issue.field === 'package_size' && issue.classification === 'ambiguous'));
  // Every package size the SQL can see is empty or a bare "<n> ml|g", which its cast parses cleanly.
  for (const row of rows) assert.match(row.package_size, /^(?:\d+(?:\.\d+)? (?:ml|g))?$/, row.name);
});

test('2. malformed numeric text is treated as missing instead of crashing', () => {
  const broken = [{ ...owner('Broken', '1 / 1 unit', 'units'), size_ml: '750ml', par_level: 'two', cost_price: '1,5 kr', source_confirmed_quantity: 'n/a' }];
  const stock = buildStockReport(broken, [], {}, NOW, []);
  assert.equal(stock.rows[0].quantity_status, 'unverified');
  assert.equal(stock.rows[0].quantity, null);
  const { rows, issues } = sanitizeSnapshotInventory(broken);
  for (const field of ['size_ml', 'par_level', 'cost_price']) assert.equal(rows[0][field], null, field);
  assert.deepEqual(issues.filter((issue) => issue.field !== 'package_size').map((issue) => issue.field).sort(), ['cost_price', 'par_level', 'quantity', 'size_ml']);
  for (const text of ['250gr', '15 kg case / sold by kg', '6 x 1 kg (1 kg per bag)', '25 x 2g tea bags', '4.5 kg box', '1,000 ml', '']) {
    assert.doesNotThrow(() => classifyQuantityText(text), text);
  }
});

test('3. valid numeric strings and plain measures still calculate', () => {
  assert.deepEqual(classifyQuantityText('10'), { kind: 'number', quantity: 10, unit: null, reason: null });
  assert.equal(classifyQuantityText('0,5').quantity, 0.5);
  assert.deepEqual(classifyQuantityText('750 ml'), { kind: 'measure', quantity: 750, unit: 'ml', reason: null });
  assert.equal(classifyQuantityText('1.5L').quantity, 1500);
  assert.equal(classifyQuantityText('250gr').quantity, 250);
  assert.equal(classifyQuantityText('6 x 350 g').kind, 'package');
  const stock = buildStockReport([owner('String stock', '10', 'bottles', { size_ml: '750', source_confirmed_quantity: '10' })], [], {}, NOW, []);
  assert.equal(stock.rows[0].quantity, 10);
});

test('4. bottle / can / unit recipe quantities match S85', () => {
  const { report } = reportsFor();
  assert.equal(byName(report, 'Carlsberg 0.0%').estimated_servings_available, 42);
  assert.equal(byName(report, 'Carlsberg 0.0%').availability_state, 'ready');
  assert.equal(byName(report, 'Veuve by the bottle').estimated_servings_available, 1);
  assert.equal(byName(report, 'Veuve by the bottle').availability_state, 'needs_attention');
});

test('5. kg ↔ g conversion matches S85', () => {
  const row = byName(reportsFor().report, 'Espresso');
  assert.equal(row.estimated_servings_available, 526);
  assert.equal(Math.round(row.estimated_cost_per_serving * 100) / 100, 9.5);
});

test('6. l ↔ ml conversion matches S85 (a costing size never multiplies liters)', () => {
  const { report } = reportsFor();
  assert.equal(byName(report, 'Piña cream').estimated_servings_available, 17);
  assert.equal(byName(report, 'Angelo Pinot Grigio').estimated_servings_available, 50);
});

test('7. tsp / tbsp match S85', () => {
  const { report } = reportsFor();
  assert.equal(byName(report, 'Lime tsp').estimated_servings_available, 800);
  assert.equal(byName(report, 'Lime tbsp').estimated_servings_available, 266);
});

test('8. discrete plurals (pie / pies) match', () => {
  assert.equal(byName(reportsFor().report, 'Pecan Pie').estimated_servings_available, 36);
});

test('9. Ice / Water / untracked references do not make availability incomplete', () => {
  const row = byName(reportsFor().report, 'Iced Americano');
  assert.equal(row.availability_state, 'ready');
  assert.equal(row.reference_ingredients, 2);
  assert.equal(row.missing_links, 0);
  assert.equal(row.untrusted_stock_items, 0);
});

test('10. a known zero is unavailable even when another ingredient is unmeasurable', () => {
  const row = byName(reportsFor().report, 'Margarita');
  assert.equal(row.availability_state, 'unavailable');
  assert.equal(row.limiting_ingredient, 'Olmeca Blanco Tequila');
  assert.equal(row.estimated_servings_available, 0);
});

test('11. genuinely unmeasurable recipe units remain incomplete', () => {
  const row = byName(reportsFor().report, 'Manhattan');
  assert.equal(row.availability_state, 'incomplete_setup');
  assert.equal(row.incompatible_units, 1);
  assert.equal(row.readiness_reason, 'Inventory unit does not match recipe unit');
});

test('12. inactive recipes and items never contaminate live report counts', () => {
  const { stock, report } = reportsFor();
  assert.ok(!report.rows.some((row) => row.name === 'Retired drink'));
  assert.equal(report.summary.active_recipes, recipes.filter((entry) => entry.active !== false).length);
  assert.ok(!stock.rows.some((row) => row.name === 'Retired Gin' || row.name.includes('recipe reference')));
  assert.equal(stock.summary.active_items, INVENTORY.filter((item) => item.active !== false).length);
  const workspace = applyStockTrustToWorkspace({ kpis: [{ key: 'recipes_attention', value: 99 }], data_sources: [{ key: 'recipes', status: 'connected' }] }, stock, report);
  assert.equal(workspace.kpis[0].value, report.summary.unavailable + report.summary.incomplete_setup + report.summary.needs_attention);
  assert.equal(workspace.data_sources[0].status, 'partial');
});

test('13. Reports stock matches S84.1 reconciled stock (Angelo, Fresh Orange Juice, Chupa Chups Infused)', () => {
  const zero = { inventory_item_id: I.angelo.id, verified_quantity: 0, freshness_state: 'current', verified_at: '2026-09-21T19:36:22Z', expires_at: '2026-09-28T19:36:22Z' };
  const stock = buildStockReport(INVENTORY, [zero], {}, NOW, []);
  const row = (name) => stock.rows.find((entry) => entry.name === name);
  assert.equal(row('Angelo Pinot Grigio').quantity, 10);
  assert.equal(row('Angelo Pinot Grigio').quantity_source, 'owner_confirmed');
  assert.equal(row('Fresh Orange Juice').quantity, 0);
  assert.equal(row('Fresh Orange Juice').quantity_status, 'current');
  assert.equal(row('Chupa Chups Infused Patrón').quantity, 1);
  assert.equal(stock.rows.filter((entry) => entry.quantity_status !== 'current').length, 0);
  const report = buildRecipeReport(recipes, ingredients, INVENTORY, stock);
  assert.equal(byName(report, 'Orange Juice').availability_state, 'unavailable');
  assert.equal(byName(report, 'Chupa Chups').availability_state, 'unavailable', '1 ml is taken literally');
});

test('14. Reports and browser S85 readiness produce identical statuses and servings', () => {
  const browser = browserStatuses();
  const { report } = reportsFor();
  assert.equal(report.rows.length, browser.size);
  for (const row of report.rows) {
    const expected = browser.get(row.name);
    assert.equal(row.availability_state, REPORT_STATE[expected.status], row.name);
    assert.equal(row.estimated_servings_available, expected.servings ?? null, row.name);
  }
  const counts = Object.fromEntries(Object.values(REPORT_STATE).map((state) => [state, report.rows.filter((row) => row.availability_state === state).length]));
  assert.deepEqual(counts, { ready: 8, needs_attention: 2, unavailable: 3, incomplete_setup: 1 });
});

test('15. one malformed inventory item or recipe line cannot fail the report', () => {
  const garbage = { id: 'not-a-uuid', name: 42, quantity: {}, unit: null, active: 'yes', size_ml: [], source_confirmed_at: 'never' };
  const inventory = [...INVENTORY, garbage, null, 'text'];
  const badLine = { id: uuid(), recipe_id: recipes[0].id, item_id: 'not-a-uuid', quantity: '1 / 1 unit', unit: 7 };
  assert.doesNotThrow(() => {
    const stock = buildStockReport(inventory, [], {}, NOW, []);
    const report = buildRecipeReport([...recipes, null, { id: 'x', active: true }], [...ingredients, badLine, null], inventory, stock);
    assert.equal(byName(report, 'Angelo Pinot Grigio').availability_state, 'incomplete_setup', 'the broken line makes only its recipe incomplete');
    assert.equal(byName(report, 'Carlsberg 0.0%').availability_state, 'ready');
    const snapshot = sanitizeSnapshotInventory(stock.rpc_inventory);
    assert.ok(snapshot.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.id)));
    assert.ok(snapshot.issues.some((issue) => issue.field === 'id'));
    const snapshotRecipes = sanitizeSnapshotRecipes([...recipes, { id: 'x' }], [...ingredients, badLine]);
    assert.equal(snapshotRecipes.recipes.length, recipes.length);
    assert.equal(snapshotRecipes.ingredients.find((line) => line.id === badLine.id).quantity, null);
    assert.equal(snapshotRecipes.ingredients.find((line) => line.id === badLine.id).item_id, null);
  });
  // The Edge Function sends only sanitized rows and retries without inventory/recipes if the private SQL still fails.
  const edge = read('supabase/functions/atlas-reports/index.ts');
  assert.match(edge, /p_inventory: snapshotInventory\.rows/);
  assert.match(edge, /catch \(error\) \{[\s\S]*?p_inventory: \[\],[\s\S]*?p_recipes: \[\],[\s\S]*?p_recipe_ingredients: \[\],/);
  assert.match(edge, /buildRecipeReport\(\s*sources\.recipes,\s*sources\.recipeIngredients,\s*sources\.inventory,\s*stockReport,/);
  assert.doesNotMatch(edge, /reconcileRecipeStockEvidence/);
});
