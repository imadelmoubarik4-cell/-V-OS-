// S88: the server domain layer (supabase/functions/_shared/atlas-domain.mjs)
// must give exactly the answers the shipped browser modules give. The browser
// files run unmodified in node:vm with the same rows; the server module runs
// natively. Fixtures cover unknown stock, zero par, at-par, unit mismatch,
// missing package size, inactive references, archived recipes, owner and
// staff-catalogue owner evidence, expired counts, movements, open purchase
// order lines and case rounding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  belowPar,
  belowParItems,
  inventoryValue,
  isStockKnown,
  openPurchaseOrderItemIds,
  orderGroups,
  orderSuggestions,
  projectStock,
  recipeAvailability,
  recipeBlockers,
  recipeCost,
  recipeStatus,
} from '../../supabase/functions/_shared/atlas-domain.mjs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString();

// Browser values live in another realm and NaN does not survive JSON, so
// compare plain data with non-finite numbers spelled out.
const plain = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (
  typeof entry === 'number' && !Number.isFinite(entry) ? `number:${entry}` : entry
)));

function browser({ items, recipes = [], purchaseOrders = [] }) {
  const noop = () => {};
  const context = {
    Date, Number, Math, Map, Set, String, Array, Object, JSON, RegExp, console,
    items, recipes,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      readyState: 'loading',
      addEventListener: noop,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    addEventListener: noop,
    setTimeout: noop,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of [
    'apps/web/assets/js/atlas-stock-truth.js',
    'apps/web/assets/js/atlas-calculations.js',
    'apps/web/assets/js/recipes.js',
    'apps/web/assets/js/operations.js',
    'apps/web/assets/js/reports-overview.js',
  ]) vm.runInContext(read(file), context, { filename: file });

  // atlas-purchasing.js needs the shell before it registers, so run its
  // shipped openItemIds expression against the same orders.
  const source = read('apps/web/assets/js/atlas-purchasing.js');
  const expression = source.match(/openItemIds: \(\) => (.+)\n/)?.[1];
  assert.ok(expression, 'atlas-purchasing.js still exposes openItemIds');
  context.state = { orders: purchaseOrders };
  context.AtlasPurchaseOrders = vm.runInContext(`({ openItemIds: () => ${expression} })`, context);
  return context;
}

const balance = (itemId, quantity, verifiedDaysAgo = 1, expiresInDays = 6, state = 'current') => ({
  inventory_item_id: itemId,
  verified_quantity: quantity,
  freshness_state: state,
  verified_at: iso(-verifiedDaysAgo),
  expires_at: iso(expiresInDays),
});

const ITEMS = [
  { id: 'vodka', name: 'Vodka', quantity: 40, par_level: 6, unit: 'bottles', size_ml: 700, cost_price: 5000, supplier: 'Globus', supplier_id: 's-globus', units_per_case: 6, active: true, category: 'Spirits' },
  { id: 'gin', name: 'Gin (at par after a sale)', quantity: 0, par_level: 3, unit: 'bottles', size_ml: 700, cost_price: 6000, supplier: 'Globus', supplier_id: 's-globus', units_per_case: 6, active: true, category: 'Spirits' },
  { id: 'rum', name: 'Rum (never counted)', quantity: 0, par_level: 6, unit: 'bottles', size_ml: 700, cost_price: 4000, supplier: 'Globus', active: true, category: 'Spirits' },
  { id: 'syrup', name: 'Syrup (zero par)', quantity: 3, par_level: 0, unit: 'bottles', size_ml: 750, cost_price: 900, supplier: 'Globus', active: true, category: 'Mixers' },
  { id: 'lime', name: 'Lime', quantity: 3, par_level: 5, unit: 'kg', cost_price: 800, supplier: 'Bananar', units_per_case: 1, active: true, category: 'Produce' },
  { id: 'tonic', name: 'Tonic', quantity: 24, par_level: 12, unit: 'cans', cost_price: 150, supplier: 'Vífilfell', active: true, category: 'Mixers' },
  { id: 'foam', name: 'Mystery foam', quantity: 2, par_level: 1, unit: 'box', cost_price: 3000, active: true, category: 'Other' },
  { id: 'ice', name: 'Ice', quantity: 0, par_level: 0, unit: 'each', active: false, category: 'Reference' },
  { id: 'bitters', name: 'Bitters', quantity: 9, par_level: 3, unit: 'bottles', size_ml: 200, cost_price: 3500, supplier: 'Globus', active: true, source_confirmed_at: iso(-3), source_confirmed_quantity: 1, category: 'Spirits' },
  { id: 'cream', name: 'Cream', quantity: 5, par_level: 2, unit: 'each', cost_price: 400, supplier: 'MS', active: true, owner_confirmed_at: iso(-1), owner_confirmed_quantity: 0, category: 'Dairy' },
  { id: 'beer', name: 'Beer (count expired)', quantity: 50, par_level: 24, unit: 'bottles', cost_price: 300, supplier: 'Ölgerðin', active: true, category: 'Beer' },
  { id: 'wine', name: 'Wine', quantity: 0, par_level: 12, unit: 'bottles', size_ml: 750, cost_price: 2500, supplier: 'Vínkaup', supplier_id: 's-vin', units_per_case: 12, active: true, category: 'Wine' },
  { id: 'retired', name: 'Retired liqueur', quantity: 0, par_level: 5, unit: 'bottles', cost_price: 1000, active: false, category: 'Spirits' },
  { id: 'nocost', name: 'Salt (no cost)', quantity: 1, par_level: 0, unit: 'kg', cost_price: null, active: true, category: 'Dry' },
  { id: 'atpar', name: 'Olives (at par)', quantity: 0, par_level: 4, unit: 'jars', cost_price: 700, active: true, category: 'Dry' },
];
const BALANCES = [
  balance('vodka', 2),
  balance('gin', 4),
  balance('syrup', 1),
  balance('lime', 3),
  balance('tonic', 30),
  balance('foam', 2),
  balance('bitters', 7, 10, -3, 'stale'),
  balance('beer', 30, 20, -13, 'stale'),
  balance('wine', 5),
  balance('retired', 1),
  balance('nocost', 1),
  balance('atpar', 4),
];
const MOVEMENTS = [
  { item_id: 'bitters', movement_type: 'restock', quantity_change: 1, created_at: iso(-2) },
  { item_id: 'gin', movement_type: 'sale', quantity_change: -1, created_at: iso(-0.5) },
  { item_id: 'gin', movement_type: 'count', quantity_change: 10, created_at: iso(-0.4) },
  { item_id: 'lime', movement_type: 'waste', quantity_change: -0.5, created_at: iso(-0.5) },
  { item_id: 'lime', movement_type: 'restock', quantity_change: 10, created_at: iso(-3) },
];
const PURCHASE_ORDERS = [
  { id: 'po-1', status: 'ordered', lines: [{ item_id: 'wine', quantity: 12 }] },
  { id: 'po-2', status: 'draft', lines: [{ item_id: 'vodka', quantity: 6 }] },
  { id: 'po-3', status: 'received', lines: [{ item_id: 'gin', quantity: 6 }] },
  { id: 'po-4', status: 'cancelled', lines: [{ item_id: 'lime', quantity: 6 }] },
  { id: 'po-5', status: 'partially_received', lines: [{ item_id: 'tonic', quantity: 24 }] },
];

const ingredient = (itemId, quantity, unit, itemName = itemId) => ({ item_id: itemId, item_name: itemName, quantity, unit });
const RECIPES = [
  { id: 'r-ready', name: 'Gin shot', active: true, yield_quantity: 1, menu_price: 2000, recipe_ingredients: [ingredient('gin', 40, 'ml')] },
  { id: 'r-attention', name: 'Vodka lime', active: true, yield_quantity: 1, menu_price: 2500, recipe_ingredients: [ingredient('vodka', 50, 'ml'), ingredient('lime', 30, 'g'), ingredient('ice', 1, 'each')] },
  { id: 'r-unknown', name: 'Daiquiri', active: true, yield_quantity: 1, menu_price: 2600, recipe_ingredients: [ingredient('rum', 50, 'ml'), ingredient('lime', 25, 'g')] },
  { id: 'r-mismatch', name: 'Gin tonic', active: true, yield_quantity: 1, menu_price: 2900, recipe_ingredients: [ingredient('gin', 40, 'ml'), ingredient('tonic', 150, 'ml')] },
  { id: 'r-package', name: 'Foam sour', active: true, yield_quantity: 1, menu_price: 3000, recipe_ingredients: [ingredient('foam', 30, 'ml'), ingredient(null, 1, 'each', 'House garnish')] },
  { id: 'r-out', name: 'Cream shot', active: true, yield_quantity: 1, menu_price: 900, recipe_ingredients: [ingredient('cream', 1, 'each')] },
  { id: 'r-archived', name: 'Old punch', active: false, yield_quantity: 10, menu_price: 1500, recipe_ingredients: [ingredient('gin', 40, 'ml')] },
  { id: 'r-batch', name: 'Bitters batch', active: true, yield_quantity: 4, menu_price: null, recipe_ingredients: [ingredient('bitters', 10, 'ml'), ingredient('tonic', 2, 'cans')] },
  { id: 'r-empty', name: 'Empty draft', active: true, yield_quantity: 1, menu_price: 1000, recipe_ingredients: [] },
  { id: 'r-reference-only', name: 'Ice water', active: true, yield_quantity: 1, menu_price: 0, recipe_ingredients: [ingredient('ice', 2, 'each')] },
];

function fixture() {
  const { AtlasStockTruth } = browser({ items: [] });
  const browserProjected = AtlasStockTruth.project(ITEMS, BALANCES, MOVEMENTS, NOW);
  const serverProjected = projectStock(ITEMS, BALANCES, MOVEMENTS, NOW);
  const context = browser({ items: browserProjected, recipes: RECIPES, purchaseOrders: PURCHASE_ORDERS });
  return { context, browserProjected, serverProjected };
}

test('stock projection matches AtlasStockTruth.project item by item', () => {
  const { browserProjected, serverProjected } = fixture();
  assert.deepEqual(plain(serverProjected), plain(browserProjected));
  const states = Object.fromEntries(serverProjected.map((item) => [item.id, item.freshness_state === 'current' ? item.quantity : 'unknown']));
  assert.deepEqual(states, {
    vodka: 2, gin: 3, rum: 'unknown', syrup: 1, lime: 2.5, tonic: 30, foam: 2, ice: 'unknown',
    bitters: 2, cream: 0, beer: 'unknown', wine: 5, retired: 1, nocost: 1, atpar: 4,
  });
});

test('known and below par agree with the browser for every item', () => {
  const { context, serverProjected } = fixture();
  for (const item of serverProjected) {
    assert.equal(isStockKnown(item), context.AtlasStockTruth.known(item), `known ${item.id}`);
    assert.equal(belowPar(item), context.AtlasStockTruth.belowPar(item), `belowPar ${item.id}`);
  }
  assert.deepEqual(belowParItems(serverProjected).map((item) => item.id), ['vodka', 'lime', 'bitters', 'cream', 'wine']);
  // Unknown stock with a par, zero par, exactly-at-par and inactive items are never below par.
  for (const id of ['rum', 'beer', 'syrup', 'atpar', 'gin', 'retired', 'ice']) {
    assert.ok(!belowParItems(serverProjected).some((item) => item.id === id), id);
  }
});

test('recipe status, availability and blockers match recipes.js', () => {
  const { context, serverProjected } = fixture();
  const keys = {};
  for (const recipe of RECIPES) {
    const browserStatus = context.AtlasRecipes.recipeStatus(recipe);
    const serverStatus = recipeStatus(recipe, serverProjected);
    assert.deepEqual(plain(serverStatus), plain(browserStatus), `status ${recipe.id}`);
    assert.deepEqual(plain(recipeAvailability(recipe, serverProjected)), plain(context.AtlasRecipes.recipeAvailability(recipe)), `availability ${recipe.id}`);
    assert.deepEqual(plain(recipeBlockers(recipe, serverProjected)), plain(context.AtlasRecipes.recipeBlockers(recipe)), `blockers ${recipe.id}`);
    keys[recipe.id] = serverStatus.key;
  }
  assert.deepEqual(keys, {
    'r-ready': 'ready', 'r-attention': 'attention', 'r-unknown': 'incomplete', 'r-mismatch': 'incomplete',
    'r-package': 'incomplete', 'r-out': 'unavailable', 'r-archived': 'draft', 'r-batch': 'attention',
    'r-empty': 'incomplete', 'r-reference-only': 'incomplete',
  });
  assert.deepEqual(recipeBlockers(RECIPES[2], serverProjected), [{ name: 'Rum (never counted)', reason: 'no verified stock count' }]);
  assert.deepEqual(recipeBlockers(RECIPES[3], serverProjected), [{ name: 'Tonic', reason: 'inventory unit does not match recipe unit' }]);
  assert.deepEqual(recipeBlockers(RECIPES[0], serverProjected), []);
  assert.deepEqual(recipeBlockers(RECIPES[4], serverProjected), [
    { name: 'Mystery foam', reason: 'package size is missing' },
    { name: 'House garnish', reason: 'not linked to an inventory item' },
  ]);
});

test('recipe cost uses the AtlasCalculations cost rules', () => {
  const { context, serverProjected } = fixture();
  for (const recipe of RECIPES) {
    const browserFinancials = context.AtlasCalculations.recipeMetrics(recipe, context.items).financials;
    assert.deepEqual(plain(recipeCost(recipe, serverProjected)), plain(browserFinancials), `cost ${recipe.id}`);
  }
  const ginShot = recipeCost(RECIPES[0], serverProjected);
  assert.ok(Math.abs(ginShot.perServing - (6000 / 700) * 40) < 1e-9);
  assert.equal(ginShot.complete, true);
  const batch = recipeCost(RECIPES[7], serverProjected);
  assert.equal(batch.complete, false, 'no menu price');
  assert.ok(Math.abs(batch.perServing - ((3500 / 200) * 10 + 150 * 2) / 4) < 1e-9, 'yield divides the batch cost');
});

test('order suggestions match operations.js, with ordered from open purchase orders', () => {
  const { context, serverProjected } = fixture();
  const browserSuggestions = context.AtlasOperations.orderSuggestions();
  const serverSuggestions = orderSuggestions(serverProjected, { purchaseOrders: PURCHASE_ORDERS });
  assert.deepEqual(plain(serverSuggestions.map(({ supplierId, ...rest }) => rest)), plain(browserSuggestions));
  const byId = Object.fromEntries(serverSuggestions.map((entry) => [entry.id, entry]));
  // Vodka: verified 2, par 6 → target 12, shortfall 10, 6-unit cases → 2 cases, 12 units.
  assert.deepEqual([byId.vodka.shortfall, byId.vodka.cases, byId.vodka.orderQuantity, byId.vodka.estimatedCost], [10, 2, 12, 60000]);
  // Lime: fractional stock rounds the shortfall up; one unit per case means no case rounding.
  assert.deepEqual([byId.lime.shortfall, byId.lime.cases, byId.lime.orderQuantity], [8, null, 8]);
  // Wine: only the 'ordered' PO counts; the draft PO for Vodka does not.
  assert.equal(byId.wine.ordered, true);
  assert.equal(byId.vodka.ordered, false);
  assert.deepEqual([byId.wine.shortfall, byId.wine.cases, byId.wine.orderQuantity], [19, 2, 24]);
  assert.equal(byId.wine.supplierId, 's-vin');
  assert.deepEqual([...openPurchaseOrderItemIds(PURCHASE_ORDERS)], [...context.AtlasPurchaseOrders.openItemIds()]);
  assert.deepEqual(plain(orderGroups(serverSuggestions).map((group) => [group.supplier, group.suggestions.length, group.estimatedCost])),
    plain([['Globus', 2, byId.vodka.estimatedCost + byId.bitters.estimatedCost], ['Bananar', 1, byId.lime.estimatedCost], ['MS', 1, byId.cream.estimatedCost], ['Vínkaup', 1, byId.wine.estimatedCost]]));
  assert.equal(orderSuggestions(serverProjected, { orderedItemIds: ['lime'] }).find((entry) => entry.id === 'lime').ordered, true);
});

test('inventory value matches reports-overview.js (Reports › Overview, formerly business.js) and stays unknown while anything is unknown', () => {
  const { context, serverProjected } = fixture();
  const incomplete = inventoryValue(serverProjected);
  assert.ok(Number.isNaN(context.AtlasReportsOverview.inventoryValue()));
  assert.equal(incomplete.value, null);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.unknown_items, 2, 'rum and beer (inactive Ice is not stock)');
  assert.equal(incomplete.missing_cost_items, 1, 'salt');
  assert.ok(incomplete.known_value > 0);

  const complete = serverProjected.filter((item) => item.active === false || (isStockKnown(item) && item.cost_price != null));
  const browserComplete = browser({ items: complete });
  const value = inventoryValue(complete);
  assert.equal(value.complete, true);
  assert.equal(value.value, browserComplete.AtlasReportsOverview.inventoryValue());
  assert.equal(value.value, value.known_value);
});

test('the domain module never mutates its inputs', () => {
  const snapshot = JSON.stringify({ ITEMS, BALANCES, MOVEMENTS, PURCHASE_ORDERS, RECIPES });
  const projected = projectStock(ITEMS, BALANCES, MOVEMENTS, NOW);
  for (const recipe of RECIPES) {
    recipeStatus(recipe, projected);
    recipeBlockers(recipe, projected);
    recipeCost(recipe, new Map(projected.map((item) => [item.id, item])));
  }
  orderSuggestions(projected, { purchaseOrders: PURCHASE_ORDERS });
  inventoryValue(projected);
  assert.equal(JSON.stringify({ ITEMS, BALANCES, MOVEMENTS, PURCHASE_ORDERS, RECIPES }), snapshot);
});
