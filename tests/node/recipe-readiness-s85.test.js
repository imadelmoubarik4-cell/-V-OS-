import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// Loads the same modules index.html loads for live readiness: stock truth,
// shared calculations, Recipes, Operations and Atlas Intelligence (Brain).
function loadAtlas({ inventory = [], balances = [], recipes = [] } = {}) {
  const context = {
    Date, Number, Math, Map, Set, String, Array, Object, JSON, console, Intl,
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('apps/web/assets/js/atlas-stock-truth.js'), context);
  vm.runInContext(read('apps/web/assets/js/atlas-calculations.js'), context);
  context.items = context.AtlasStockTruth.project(inventory, balances, [], Date.parse('2026-09-24T12:00:00Z'));
  context.recipes = recipes;
  for (const file of ['recipes.js', 'operations.js', 'brain.js']) vm.runInContext(read(`apps/web/assets/js/${file}`), context);
  return context;
}

// Production-shaped rows (owner evidence as S84.1 left it).
const owner = (id, name, quantity, unit, extra = {}) => ({
  id, name, quantity, unit, active: true, cost_price: 1000, source_type: 'owner_confirmed', source_confidence: 100,
  updated_at: '2026-09-23T22:00:00Z', source_confirmed_at: '2026-09-23T22:00:00Z', source_confirmed_quantity: quantity, ...extra
});
const ITEMS = {
  angelo: owner('angelo', 'Angelo Pinot Grigio', 10, 'bottles', { size_ml: 750 }),
  carlsberg: owner('carlsberg', 'Carlsberg 0.0%', 42, 'cans', { size_ml: 330 }),
  veuve: owner('veuve', 'Veuve Clicquot Brut Champagne', 1, 'bottles', { size_ml: 750 }),
  espresso: owner('espresso', "L'OR Harmonieux Espresso Beans", 5, 'kg', { package_size: '6 x 1 kg (1 kg per bag)' }),
  milk: owner('milk', 'G mjólk', 12, 'units', { size_ml: 1000 }),
  coconut: owner('coconut', 'Kókosrjómi 20/22% 400ml', 0.8, 'liters', { size_ml: 400 }),
  syrup: owner('syrup', 'Simple Syrup', 0, 'liters', { size_ml: 2000, source_type: 'owner_confirmed_prep' }),
  orangeJuice: owner('oj', 'Fresh Orange Juice', 0, 'liters', { size_ml: 1000, source_type: 'owner_confirmed_prep' }),
  infused: owner('infused', 'Chupa Chups Infused Patrón', 1, 'ml', { size_ml: 1000, source_type: 'owner_confirmed_prep' }),
  tequila: owner('tequila', 'Olmeca Blanco Tequila', 0, 'bottles', { size_ml: 700 }),
  agave: owner('agave', 'Ljóst Agave síróp Jakobsens', 0.3, 'units', { package_size: '2.5 kg' }),
  lime: owner('lime-juice', 'Lime Juice', 4, 'liters', { size_ml: 1000 }),
  bitters: owner('bitters', 'Angostura Bitters', 1, 'bottles', { size_ml: 150 }),
  pie: owner('pie', 'Pecan Pie', 3, 'pies'),
  ice: { id: 'ice', name: 'Ice (recipe reference)', quantity: 0, unit: 'untracked', active: false, source_type: 'owner_confirmed_addition', source_confidence: 100, source_confirmed_at: null, source_confirmed_quantity: null },
  water: { id: 'water', name: 'Water (recipe reference)', quantity: 0, unit: 'untracked', active: false, source_type: 'owner_confirmed_addition', source_confidence: 100, source_confirmed_at: null, source_confirmed_quantity: null },
  teaChoice: { id: 'tea-choice', name: 'Selected Tea Bag (recipe choice)', quantity: 0, unit: 'untracked', active: false, source_confirmed_at: null, source_confirmed_quantity: null }
};
const INVENTORY = Object.values(ITEMS);
const recipe = (name, ingredients, extra = {}) => ({
  id: name, name, active: true, yield_quantity: 1, menu_price: 2500,
  recipe_ingredients: ingredients.map(([item_id, quantity, unit]) => ({ item_id, item_name: item_id, quantity, unit })), ...extra
});
const availability = (recipes, name) => {
  const atlas = loadAtlas({ inventory: INVENTORY, recipes });
  return atlas.AtlasRecipes.recipeAvailability(recipes.find((entry) => entry.name === name));
};

test('Angelo still resolves to 10 x 750 ml / 150 ml = 50 servings (ready)', () => {
  const recipes = [recipe('Angelo Pinot Grigio', [['angelo', 150, 'ml']])];
  const result = availability(recipes, 'Angelo Pinot Grigio');
  assert.equal(result.servings, 50);
  assert.equal(result.status, 'ready');
});

test('whole-unit recipes (1 can / 1 bottle) count units even when a bottle size is known', () => {
  const recipes = [recipe('Carlsberg 0.0%', [['carlsberg', 1, 'can']]), recipe('Veuve', [['veuve', 1, 'bottle']]), recipe('Somersby', [['carlsberg', 1, 'unit']])];
  assert.equal(availability(recipes, 'Carlsberg 0.0%').servings, 42);
  assert.equal(availability(recipes, 'Carlsberg 0.0%').status, 'ready');
  assert.equal(availability(recipes, 'Veuve').servings, 1);
  assert.equal(availability(recipes, 'Veuve').status, 'attention');
  assert.equal(availability(recipes, 'Somersby').servings, 42);
});

test('stock counted in kg converts to grams for recipes and costing', () => {
  const recipes = [recipe('Espresso', [['espresso', 9.5, 'g']]), recipe('Latte', [['espresso', 19, 'g'], ['milk', 180, 'ml']])];
  assert.equal(availability(recipes, 'Espresso').servings, 526);
  assert.equal(availability(recipes, 'Latte').servings, 66);
  const atlas = loadAtlas({ inventory: INVENTORY, recipes });
  const metrics = atlas.AtlasCalculations.recipeMetrics(recipes[0], atlas.items);
  assert.equal(Math.round(metrics.financials.total * 100) / 100, 9.5, '1 000 ISK per kg x 9.5 g');
  assert.deepEqual(JSON.parse(JSON.stringify(atlas.AtlasCalculations.parsePackSize(ITEMS.espresso))), { quantity: 1000, unit: 'g' });
});

test('stock counted in liters or ml stays in that unit; a costing size never multiplies it', () => {
  const recipes = [recipe('Piña', [['coconut', 45, 'ml']]), recipe('Chupa Chups', [['infused', 30, 'ml']])];
  assert.equal(availability(recipes, 'Piña').servings, 17, '0.8 L / 45 ml, not 0.8 x 400 ml');
  const infused = availability(recipes, 'Chupa Chups');
  assert.equal(infused.status, 'unavailable', '1 ml of infusion is less than one 30 ml serving');
  assert.equal(infused.limiting.item.name, 'Chupa Chups Infused Patrón');
});

test('tsp and tbsp convert to millilitres', () => {
  const atlas = loadAtlas();
  assert.equal(atlas.AtlasCalculations.normalizeUnit('tbsp'), 'tbsp');
  const recipes = [recipe('Tropical', [['coconut', 2, 'tsp']]), recipe('Lime tbsp', [['lime-juice', 1, 'tbsp']])];
  assert.equal(availability(recipes, 'Tropical').servings, 80);
  assert.equal(availability(recipes, 'Lime tbsp').servings, 266);
});

test('matching discrete units (pie / pies) count directly', () => {
  const recipes = [recipe('Pecan Pie', [['pie', 1 / 12, 'pie']])];
  assert.equal(availability(recipes, 'Pecan Pie').servings, 36);
});

test('inactive or untracked recipe references (Ice, Water) never block service readiness', () => {
  const recipes = [
    recipe('Iced Americano', [['espresso', 9.5, 'g'], ['ice', 1, 'glass-fill'], ['water', 180, 'ml']]),
    recipe('Tea Selection', [['tea-choice', 1, 'tea bag']])
  ];
  const americano = availability(recipes, 'Iced Americano');
  assert.equal(americano.status, 'ready');
  assert.equal(americano.servings, 526);
  assert.equal(americano.references, 2);
  assert.equal(americano.unknown, 0);
  const atlas = loadAtlas({ inventory: INVENTORY, recipes });
  const row = atlas.AtlasCalculations.ingredientMetrics(recipes[0].recipe_ingredients[1], atlas.items);
  assert.equal(row.reference, true);
  assert.equal(row.belowPar, false);
  // A recipe made only of references has no stocked ingredient to evaluate.
  assert.equal(availability(recipes, 'Tea Selection').status, 'incomplete');
});

test('a verified zero is unavailable even when another ingredient cannot be measured', () => {
  const recipes = [
    recipe('Margarita', [['tequila', 45, 'ml'], ['agave', 15, 'ml'], ['lime-juice', 30, 'ml']]),
    recipe('Whisky Sour', [['syrup', 20, 'ml'], ['bitters', 2, 'dashes'], ['lime-juice', 25, 'ml']])
  ];
  const margarita = availability(recipes, 'Margarita');
  assert.equal(margarita.status, 'unavailable');
  assert.equal(margarita.servings, 0);
  assert.equal(margarita.limiting.item.name, 'Olmeca Blanco Tequila');
  assert.equal(availability(recipes, 'Whisky Sour').limiting.item.name, 'Simple Syrup');
});

test('Fresh Orange Juice at a known 0 liters is unavailable, never Unknown', () => {
  const recipes = [recipe('Orange Juice', [['oj', 300, 'ml'], ['ice', 1, 'glass-fill']])];
  const atlas = loadAtlas({ inventory: INVENTORY, recipes });
  const juice = atlas.items.find((item) => item.id === 'oj');
  assert.equal(atlas.AtlasStockTruth.known(juice), true);
  assert.equal(juice.quantity, 0);
  const result = atlas.AtlasRecipes.recipeAvailability(recipes[0]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.limiting.item.name, 'Fresh Orange Juice');
});

test('genuinely unmeasurable ingredients stay incomplete instead of guessing', () => {
  const recipes = [
    recipe('Manhattan', [['bitters', 2, 'dashes'], ['lime-juice', 30, 'ml']]),
    recipe('Honey density', [['agave', 15, 'ml'], ['lime-juice', 30, 'ml']])
  ];
  assert.equal(availability(recipes, 'Manhattan').status, 'incomplete');
  assert.equal(availability(recipes, 'Honey density').status, 'incomplete');
});

test('Recipes, Operations, Atlas Intelligence and Home agree on the same readiness state', () => {
  const recipes = [
    recipe('Angelo Pinot Grigio', [['angelo', 150, 'ml']]),
    recipe('Carlsberg 0.0%', [['carlsberg', 1, 'can']]),
    recipe('Veuve', [['veuve', 1, 'bottle']]),
    recipe('Margarita', [['tequila', 45, 'ml'], ['agave', 15, 'ml']]),
    recipe('Manhattan', [['bitters', 2, 'dashes']]),
    recipe('Iced Americano', [['espresso', 9.5, 'g'], ['ice', 1, 'glass-fill']]),
    recipe('Retired drink', [['tequila', 45, 'ml']], { active: false })
  ];
  const atlas = loadAtlas({ inventory: INVENTORY, recipes });
  const recipeStates = recipes.filter((entry) => entry.active !== false).map((entry) => atlas.AtlasRecipes.recipeAvailability(entry).status);
  const needing = recipeStates.filter((status) => status !== 'ready').length;
  const operations = atlas.AtlasOperations.readinessData();
  assert.equal(needing, 3);
  assert.equal(operations.issues.length, needing, 'Operations counts the same recipes as Recipes');
  assert.ok(operations.issues.every((entry) => entry.recipe.active !== false), 'inactive recipes never count');
  assert.equal(operations.issues[0].recipe.name, 'Margarita');
  assert.equal(atlas.AtlasRecipes.getHomeAlert().text, "Margarita can't be served right now.");
  assert.equal(atlas.AtlasBrain.riskData().label, 'High');
  assert.match(atlas.AtlasBrain.assistantResponse('what needs attention'), /Margarita/);
  // Below-par and unknown signals come from active reconciled stock only.
  assert.ok(operations.low.every((item) => item.active !== false && atlas.AtlasStockTruth.known(item)));
  assert.ok(!operations.low.some((item) => item.name.includes('recipe reference')));
});
