// S87 Operations card navigation and safe recipe removal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, openView } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

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
      functions: { ...emptyFunctions(), 'atlas-stock-counts': { counts: { verified_balances: [balance('pinot', 4), balance('lime', 5), balance('gin', 2)] } } }
    }
  });
}

async function clickCard(page, target) {
  await openView(page, 'operations');
  await page.click(`button.operations-summary-card[data-operation-target="${target}"]`);
  await page.waitForTimeout(400);
}

test('Inventory alerts opens Inventory filtered to items below par', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await clickCard(page, 'inventory-low');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'inventory');
    const rows = await page.$$eval('#items-body tr td.name span:first-child', (cells) => cells.map((cell) => cell.textContent));
    assert.deepEqual(rows, ['Angelo Pinot Grigio'], 'Gin is exactly at par and is not listed');
    await page.click('[data-inventory-below-par-chip]');
    await page.waitForTimeout(150);
    assert.equal(await page.$$eval('#items-body tr', (list) => list.length), 3, 'clearing the chip shows every item');
  } finally { await close(); }
});

test('Home "Items below par" opens the same filter', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.click('#home-metrics .metric-card[data-target="inventory-low"]');
    await page.waitForTimeout(300);
    assert.equal(await page.$$eval('#items-body tr', (list) => list.length), 1);
    assert.ok(await page.$('[data-inventory-below-par-chip]'));
  } finally { await close(); }
});

test('Recipes needing attention opens Recipes on the Attention filter', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await clickCard(page, 'recipes-attention');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'recipes');
    assert.equal(await page.$eval('#recipe-status-filters .active', (node) => node.dataset.status), 'attention');
  } finally { await close(); }
});

test('Suppliers and Opening checks cards bring their section into view', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await clickCard(page, 'operations-orders');
    await page.waitForTimeout(600);
    assert.ok(await page.$eval('#operations-orders', (node) => { const rect = node.getBoundingClientRect(); return rect.top < window.innerHeight && rect.bottom > 0; }));
    await clickCard(page, 'operations-checklist');
    await page.waitForTimeout(600);
    assert.equal(await page.$eval('[data-checklist-tab].active', (node) => node.dataset.checklistTab), 'opening');
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
    await page.waitForTimeout(400);
    const write = record.requests.find((entry) => entry.path.endsWith('/rest/v1/recipes') && entry.method === 'PATCH');
    assert.deepEqual(write?.body, { active: false });
    assert.ok(!record.requests.some((entry) => entry.path.endsWith('/rest/v1/recipes') && entry.method === 'DELETE'));
  } finally { await close(); }
});

test('an archived recipe is deleted only after its name is typed', { skip }, async () => {
  const wrong = await launchAtlas({ promptAnswer: 'yes', fixtures: { tables: { inventory_items: inventory, recipes }, functions: emptyFunctions() } });
  try {
    await openRecipe(wrong.page, 'old');
    await wrong.page.click('[data-delete-recipe]');
    await wrong.page.waitForTimeout(300);
    assert.ok(!wrong.record.requests.some((entry) => entry.method === 'DELETE'), 'a wrong name deletes nothing');
  } finally { await wrong.close(); }

  const right = await launchAtlas({ promptAnswer: 'Old Special', fixtures: { tables: { inventory_items: inventory, recipes }, functions: emptyFunctions() } });
  try {
    await openRecipe(right.page, 'old');
    await right.page.click('[data-delete-recipe]');
    await right.page.waitForTimeout(300);
    assert.ok(right.record.requests.some((entry) => entry.path.endsWith('/rest/v1/recipes') && entry.method === 'DELETE'));
  } finally { await right.close(); }
});

test('Operations shows items on a placed purchase order as On order', { skip }, async () => {
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
    await openView(page, 'operations');
    await page.waitForTimeout(300);
    assert.match(await page.textContent('#operations-orders'), /On order/);
    assert.equal(await page.$('#operations-orders [data-order-toggle="pinot"]'), null);
    assert.match(await page.textContent('button.operations-summary-card[data-operation-target="operations-orders"]'), /^0/, 'no supplier still needs an order');
  } finally { await close(); }
});

test('Inventory ✕ deactivates the item instead of deleting its history', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await openView(page, 'inventory');
    await page.click('#items-body .delete-btn[data-id="pinot"]');
    await page.waitForTimeout(300);
    const write = record.requests.find((entry) => entry.path.endsWith('/rest/v1/inventory_items') && entry.method !== 'GET');
    assert.equal(write?.method, 'PATCH');
    assert.deepEqual(write?.body, { active: false });
    assert.equal(await page.getAttribute('#items-body .qty-input[data-id="lime"]', 'aria-label'), 'Quantity of Lime juice');
  } finally { await close(); }
});

test('Home timeline text is not squeezed into the marker column', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.waitForSelector('#home-timeline .brain-timeline-copy');
    const width = await page.$eval('#home-timeline .brain-timeline-copy', (node) => node.getBoundingClientRect().width);
    assert.ok(width > 80, `timeline text column is ${width}px wide`);
  } finally { await close(); }
});
