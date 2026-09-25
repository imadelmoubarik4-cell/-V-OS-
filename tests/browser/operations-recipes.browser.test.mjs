// Home glance navigation (S88 Team A; formerly the Operations summary cards)
// and safe recipe removal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, openView } from './harness.mjs';
import { emptyFunctions, venueClockBackend, weekHours } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: new Date(Date.now() - 86400000).toISOString(), expires_at: new Date(Date.now() + 864000000).toISOString() });
const inventory = [
  { id: 'pinot', name: 'Angelo Pinot Grigio', category: 'Wine', unit: 'bottles', par_level: 6, supplier: 'Globus', active: true, cost_price: 2100 },
  { id: 'lime', name: 'Lime juice', category: 'Juices', unit: 'l', par_level: 2, supplier: 'Mata', active: true, cost_price: 900 },
  { id: 'gin', name: 'Gin', category: 'Gin', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 5000 }
];
const recipes = [
  { id: 'soda', name: 'Lime Soda', active: true, yield_quantity: 1, menu_price: 1500, recipe_ingredients: [{ id: 'a', item_id: 'lime', item_name: 'Lime juice', quantity: 25, unit: 'ml' }] },
  { id: 'gt', name: 'Gin Tonic', active: true, yield_quantity: 1, menu_price: 2500, recipe_ingredients: [{ id: 'b', item_id: 'gin', item_name: 'Gin', quantity: 50, unit: 'ml' }] },
  { id: 'old', name: 'Old Special', active: false, yield_quantity: 1, recipe_ingredients: [] }
];

function launch(options = {}) {
  return launchAtlas({
    ...options,
    fixtures: {
      tables: { inventory_items: inventory, recipes, suppliers: [], recipe_categories: [] },
      functions: { ...emptyFunctions(), 'atlas-settings': (options.settings || venueClockBackend()).handler, 'atlas-stock-counts': { counts: { verified_balances: [balance('pinot', 4), balance('lime', 5), balance('gin', 2)] } }, ...(options.functions || {}) }
    }
  });
}

// S88 Team B: Inventory rows (assets/js/atlas-inventory.js).
const inventoryRows = (page) => page.$$eval('#inventory-view tbody tr[data-inv-row] .cell-primary', (cells) => cells.map((cell) => cell.textContent));

test('Home Stock opens Inventory filtered to items below par', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.waitForSelector('.home-glance__item[href="#inventory?filter=below-par"]');
    assert.match(await page.textContent('.home-glance__item[href="#inventory?filter=below-par"]'), /1\s*below par/);
    await page.click('.home-glance__item[href="#inventory?filter=below-par"]');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'inventory');
    assert.deepEqual(await inventoryRows(page), ['Angelo Pinot Grigio'], 'Gin is exactly at par and is not listed');
    // The filter is a chip; clearing it shows every item.
    await page.click('[data-inv-clear="status"]');
    await page.waitForTimeout(150);
    assert.equal((await inventoryRows(page)).length, 3, 'clearing the chip shows every item');
  } finally { await close(); }
});

test('Recipes needing attention opens Recipes on the Attention filter', { skip }, async () => {
  const { page, close } = await launch();
  try {
    // S88: Operations has no summary cards; Recipes' own entry point opens the preset.
    await page.evaluate(() => window.AtlasRecipes.openWithStatus('attention'));
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'recipes');
    // S88 Recipes: the attention preset shows as a clearable chip next to the segments.
    await page.waitForSelector('#recipes-view .atlas-chip.is-active[data-recipe-status="all"]');
    const names = await page.$$eval('#recipes-view .recipe-tile__name', (nodes) => nodes.map((node) => node.textContent));
    assert.ok(!names.includes('Old Special'), 'archived recipes are not in the attention list');
  } finally { await close(); }
});

async function openRecipe(page, id) {
  await page.evaluate((recipeId) => window.AtlasRecipes.openRecipe(recipeId), id);
  await page.waitForTimeout(400);
}

test('an active recipe can be archived but not deleted', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await openRecipe(page, 'soda');
    assert.equal(await page.$('[data-delete-recipe]'), null);
    await page.click('[data-archive-recipe]');
    // Archive asks first (atlas dialog), then writes active=false.
    await page.click('#recipe-confirm-modal [data-recipe-confirm]');
    await page.waitForTimeout(400);
    const write = record.requests.find((entry) => entry.path.endsWith('/rest/v1/recipes') && entry.method === 'PATCH');
    assert.deepEqual(write?.body, { active: false });
    assert.ok(!record.requests.some((entry) => entry.path.endsWith('/rest/v1/recipes') && entry.method === 'DELETE'));
  } finally { await close(); }
});

test('an archived recipe is deleted only after its name is typed', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ fixtures: { tables: { inventory_items: inventory, recipes }, functions: emptyFunctions() } });
  try {
    await openRecipe(page, 'old');
    await page.click('[data-delete-recipe]');
    await page.waitForSelector('#recipe-confirm-name');
    await page.fill('#recipe-confirm-name', 'yes');
    assert.equal(await page.$eval('#recipe-confirm-modal [data-recipe-confirm]', (button) => button.disabled), true, 'a wrong name cannot confirm');
    assert.ok(!record.requests.some((entry) => entry.method === 'DELETE'), 'a wrong name deletes nothing');
    await page.fill('#recipe-confirm-name', 'Old Special');
    await page.click('#recipe-confirm-modal [data-recipe-confirm]');
    await page.waitForTimeout(400);
    assert.ok(record.requests.some((entry) => entry.path.endsWith('/rest/v1/recipes') && entry.method === 'DELETE'));
  } finally { await close(); }
});

test('an item on a placed purchase order is suggested as ordered and not counted to order on Home', { skip }, async () => {
  const { page, close } = await launchAtlas({
    fixtures: {
      tables: {
        inventory_items: inventory, recipes, suppliers: [{ id: 's1', name: 'Globus' }],
        purchase_orders: [{ id: 'po1', supplier_id: 's1', status: 'ordered', version: 1, lines: [{ item_id: 'pinot', item_name: 'Angelo Pinot Grigio', quantity: 12, unit: 'bottles', unit_cost: 2100 }] }]
      },
      functions: { ...emptyFunctions(), 'atlas-stock-counts': { counts: { verified_balances: [balance('pinot', 4), balance('lime', 5), balance('gin', 2)] } } }
    }
  });
  try {
    await page.waitForSelector('.home-glance__item[href="#purchasing"]');
    await page.waitForTimeout(300);
    const suggestion = await page.evaluate(() => window.AtlasOperations.orderSuggestions().find((entry) => entry.id === 'pinot'));
    assert.equal(suggestion?.ordered, true);
    assert.match(await page.textContent('.home-glance__item[href="#purchasing"]'), /0\s*to order/, 'no item still needs an order');
  } finally { await close(); }
});

test('Inventory deactivates an item instead of deleting its history', { skip }, async () => {
  // S88: deactivation goes through atlas-item-master set_item_active after the
  // dependency check (tests/browser/inventory.browser.test.mjs covers the dialog).
  const calls = [];
  const itemMaster = (entry) => {
    calls.push(entry);
    if (entry.action === 'item_dependencies') return { dependencies: { item: { id: 'pinot', updated_at: '2026-09-20T10:00:00Z' }, blockers: [], warnings: [], can_deactivate: true } };
    return { result: { item_id: 'pinot', active: false, changed: true } };
  };
  const { page, record, close } = await launch({ functions: { 'atlas-item-master': itemMaster } });
  try {
    await openView(page, 'inventory');
    await page.click('[data-inv-row-menu="pinot"]');
    await page.click('[data-row-action="deactivate"]');
    await page.waitForSelector('[data-activation-confirm]:not([disabled])');
    await page.click('[data-activation-confirm]');
    await page.waitForTimeout(300);
    const write = calls.find((entry) => entry.action === 'set_item_active');
    assert.equal(write?.body?.item_id, 'pinot');
    assert.equal(write?.body?.active, false);
    assert.equal(record.requests.filter((entry) => entry.path.endsWith('/rest/v1/inventory_items') && entry.method !== 'GET').length, 0, 'no delete or direct update');
    assert.equal(await page.getAttribute('[data-inv-select="lime"]', 'aria-label'), 'Select Lime juice');
  } finally { await close(); }
});

test('Home timeline text is not squeezed into the marker column', { skip }, async () => {
  // The timeline exists only when business hours are saved (AtlasVenueClock).
  const { page, close } = await launch({ settings: venueClockBackend({ hours: weekHours() }) });
  try {
    await page.waitForSelector('#home-timeline .home-timeline__label');
    const width = await page.$eval('#home-timeline .home-timeline__label', (node) => node.getBoundingClientRect().width);
    assert.ok(width > 80, `timeline text column is ${width}px wide`);
  } finally { await close(); }
});
