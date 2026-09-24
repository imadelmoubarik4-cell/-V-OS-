import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(path, 'utf8');
const stockSource = read('apps/web/assets/js/atlas-stock-truth.js');
const calcSource = read('apps/web/assets/js/atlas-calculations.js');
const recipesSource = read('apps/web/assets/js/recipes.js');
const appSource = read('apps/web/index.html');

const NOW = Date.parse('2026-09-24T09:00:00Z');
const ANGELO = {
  id: 'angelo',
  name: 'Angelo Pinot Grigio',
  quantity: 10,
  unit: 'bottles',
  size_ml: 750,
  cost_price: 1874,
  source_type: 'owner_confirmed',
  source_confidence: 100,
  updated_at: '2026-09-23T22:14:07Z',
  par_level: null,
  active: true,
};
const OLD_ZERO = {
  inventory_item_id: 'angelo',
  verified_quantity: 0,
  freshness_state: 'current',
  verified_at: '2026-09-21T19:36:22Z',
  expires_at: '2026-09-28T19:36:22Z',
};
const RECIPE = {
  id: 'angelo-glass',
  name: 'Angelo Pinot Grigio',
  active: true,
  yield_quantity: 1,
  menu_price: 2390,
  recipe_ingredients: [
    { item_id: 'angelo', item_name: 'Angelo Pinot Grigio', quantity: 150, unit: 'ml' },
  ],
};

function loadCore() {
  const scope = { window: {} };
  vm.createContext(scope);
  vm.runInContext(stockSource, scope);
  vm.runInContext(calcSource, scope);
  return scope.window;
}

function loadRecipes(projectedItems) {
  const scope = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { readyState: 'loading', addEventListener: () => {} },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(scope);
  vm.runInContext(
    `let items = ${JSON.stringify(projectedItems)}; let recipes = ${JSON.stringify([RECIPE])}; let currentUser = null; let activeView = 'recipes'; let sb = {};`,
    scope,
  );
  vm.runInContext(calcSource, scope);
  vm.runInContext(recipesSource, scope);
  return scope.window;
}

function gitBlobSha(source) {
  const payload = Buffer.from(source, 'utf8');
  return createHash('sha1')
    .update(Buffer.from(`blob ${payload.length}\0`))
    .update(payload)
    .digest('hex');
}

test('newer owner-confirmed Angelo count wins over older verified zero without mutating evidence', () => {
  const core = loadCore();
  const itemBefore = structuredClone(ANGELO);
  const balanceBefore = structuredClone(OLD_ZERO);
  const projected = core.AtlasStockTruth.project([ANGELO], [OLD_ZERO], [], NOW)[0];

  assert.equal(projected.quantity, 10);
  assert.equal(projected.verified_quantity, 10);
  assert.equal(projected.freshness_state, 'current');
  assert.equal(projected.stock_source, 'owner_confirmed');
  assert.deepEqual(ANGELO, itemBefore);
  assert.deepEqual(OLD_ZERO, balanceBefore);
});

test('Angelo package size resolves to 750 ml', () => {
  const core = loadCore();
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.AtlasCalculations.parsePackSize(ANGELO))),
    { quantity: 750, unit: 'ml' },
  );
});

test('Angelo reconciles to 50 servings through shared calculations and Recipes', () => {
  const core = loadCore();
  const projected = core.AtlasStockTruth.project([ANGELO], [OLD_ZERO], [], NOW);
  const metrics = core.AtlasCalculations.recipeMetrics(RECIPE, projected);
  assert.equal(metrics.availability.servings, 50);

  const recipes = loadRecipes(projected);
  const availability = recipes.AtlasRecipes.recipeAvailability(RECIPE);
  assert.equal(availability.servings, 50);
});

test('Angelo is never unavailable after reconciliation', () => {
  const core = loadCore();
  const projected = core.AtlasStockTruth.project([ANGELO], [OLD_ZERO], [], NOW);
  const recipes = loadRecipes(projected);
  const availability = recipes.AtlasRecipes.recipeAvailability(RECIPE);

  assert.ok(['ready', 'attention'].includes(availability.status));
  assert.notEqual(availability.status, 'unavailable');
});

test('Atlas Intelligence home alert no longer says Angelo cannot currently be served', () => {
  const core = loadCore();
  const projected = core.AtlasStockTruth.project([ANGELO], [OLD_ZERO], [], NOW);
  const recipes = loadRecipes(projected);
  const alert = recipes.AtlasRecipes.getHomeAlert();

  assert.doesNotMatch(alert?.text || '', /cannot currently be served/i);
});

test('a newer manager-verified count still wins over an older owner-confirmed count', () => {
  const core = loadCore();
  const olderOwner = { ...ANGELO, updated_at: '2026-09-20T20:00:00Z' };
  const newerManager = {
    ...OLD_ZERO,
    verified_quantity: 4,
    verified_at: '2026-09-22T12:00:00Z',
    expires_at: '2026-09-29T12:00:00Z',
  };
  const projected = core.AtlasStockTruth.project([olderOwner], [newerManager], [], NOW);
  assert.equal(projected[0].quantity, 4);
  assert.equal(core.AtlasCalculations.recipeMetrics(RECIPE, projected).availability.servings, 20);
});

test('stock runtime cache keys are pinned to the exact reviewed module blobs', () => {
  assert.match(appSource, /atlas-stock-truth\.js\?v=20260924-s84/);
  assert.match(appSource, /atlas-calculations\.js\?v=20260924-s84/);
  assert.equal(gitBlobSha(stockSource), '8164c68a28333a5174958f3ea99527101a55c23c');
  assert.equal(gitBlobSha(calcSource), 'ce1c3547d5b5641b4b9ee8031e40b059ba7b2781');
});
