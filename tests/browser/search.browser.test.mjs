// S87 Global Search / Ask Atlas, S88 command palette: records, questions,
// keyboard and honesty when source data is missing. Runs the shipped
// atlas-search.js (provider) and atlas-palette.js (UI) in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

function venueDate(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Reykjavik', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const date = new Date(`${parts}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const inventory = [
  { id: 'pinot', name: 'Angelo Pinot Grigio 750ml', category: 'Wine', unit: 'bottles', par_level: 6, supplier: 'Vínbúðin Heildsala', active: true, cost_price: 2100, units_per_case: 6 },
  { id: 'tequila', name: 'Olmeca Blanco Tequila 1L', category: 'Tequila & Mezcal', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 5200 },
  { id: 'lime', name: 'Lime juice', category: 'Juices', unit: 'l', par_level: 2, supplier: 'Mata', active: true, cost_price: 900 },
  { id: 'triple', name: 'Triple Sec', category: 'Liqueurs', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 3000 },
  { id: 'agave', name: 'Agave syrup', category: 'Syrups', unit: 'bottles', par_level: 1, supplier: 'Mata', active: true, cost_price: 1500 }
];
const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: new Date(Date.now() - 86400000).toISOString(), expires_at: new Date(Date.now() + 10 * 86400000).toISOString() });
const recipes = [
  { id: 'margarita', name: 'Margarita', active: true, yield_quantity: 1, menu_price: 2990, recipe_ingredients: [
    { id: 'r1', item_id: 'tequila', item_name: 'Olmeca Blanco Tequila 1L', quantity: 50, unit: 'ml' },
    { id: 'r2', item_id: 'lime', item_name: 'Lime juice', quantity: 25, unit: 'ml' },
    { id: 'r3', item_id: 'triple', item_name: 'Triple Sec', quantity: 20, unit: 'ml' }
  ] },
  { id: 'lime-soda', name: 'Lime Soda', active: true, yield_quantity: 1, recipe_ingredients: [{ id: 'l1', item_id: 'lime', item_name: 'Lime juice', quantity: 25, unit: 'ml' }] },
  { id: 'paloma', name: 'Paloma', active: true, yield_quantity: 1, recipe_ingredients: [{ id: 'p1', item_id: 'agave', item_name: 'Agave syrup', quantity: 10, unit: 'ml' }] }
];

function fixtures({ balances, shifts = null } = {}) {
  return {
    tables: { inventory_items: inventory, recipes, suppliers: [{ id: 's1', name: 'Globus', email: 'orders@globus.example' }] },
    functions: {
      ...emptyFunctions(),
      'atlas-stock-counts': { counts: { verified_balances: balances ?? [balance('pinot', 4), balance('tequila', 3), balance('lime', 5), balance('triple', 2)] } },
      'atlas-knowledge': { workspace: { articles: [{ id: 'k1', title: 'Opening checklist', category_name: 'Checklists', summary: 'Before doors open' }] } },
      'atlas-shifts': shifts ?? { workspace: {
        week: { status: 'published', week_start: venueDate(-((new Date().getUTCDay() + 6) % 7)) },
        people: [{ id: 'p-sara', display_name: 'Sara Jónsdóttir', active: true }],
        shifts: [{ id: 'sh1', person_id: 'p-sara', starts_local: `${venueDate(1)}T17:00:00`, ends_local: `${venueDate(1)}T23:30:00`, role_name: 'Bartender' }]
      } }
    }
  };
}

// Opens the palette from the top-bar field (or the phone search button) and types.
async function ask(page, text, { wait = 350 } = {}) {
  if (!(await page.evaluate(() => window.AtlasPalette.isOpen()))) {
    const phone = await page.evaluate(() => window.matchMedia('(max-width: 767px)').matches);
    await page.click(phone ? '#atlas-phone-search' : '#atlas-omni');
  }
  await page.fill('#atlas-palette-input', text);
  await page.waitForTimeout(wait);
  return page.evaluate(() => ({
    answer: document.querySelector('.atlas-palette__answer')?.innerText.replace(/\s+/g, ' ').trim() || null,
    options: [...document.querySelectorAll('.atlas-palette__item')].map((node) => node.innerText.replace(/\s+/g, ' ').trim()),
    view: document.body.dataset.atlasView
  }));
}

test('typing never navigates away from the current page', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    const result = await ask(page, 'recipe team shift settings report stock');
    assert.equal(result.view, 'dashboard');
  } finally { await close(); }
});

test('inventory, recipe, supplier, knowledge and page records are searchable', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    assert.ok((await ask(page, 'pinot')).options.some((option) => /Angelo Pinot Grigio.*4 bottles · below par/.test(option)));
    assert.ok((await ask(page, 'marg')).options.some((option) => /Margarita/.test(option)));
    assert.ok((await ask(page, 'globus')).options.some((option) => /Globus.*orders@globus/.test(option)));
    assert.ok((await ask(page, 'reports')).options.some((option) => /^Reports/.test(option)));
    assert.ok((await ask(page, 'notifications')).options.some((option) => /Notification settings/.test(option)));
  } finally { await close(); }
});

test('Enter on a record opens it in its module', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    await ask(page, 'angelo');
    // The first row (the item) is selected by default.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'inventory');
    // S88 §7.5: an item opens its detail (#inventory/item/<id>).
    await page.waitForSelector('.inv-detail');
    assert.equal(await page.evaluate(() => location.hash), '#inventory/item/pinot');
    assert.equal(await page.textContent('#inv-detail-title'), 'Angelo Pinot Grigio 750ml');
  } finally { await close(); }
});

test('"What is low in stock?" lists only verified items below par', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    const { answer } = await ask(page, 'What is low in stock?');
    assert.match(answer, /1 item is below par/);
    assert.match(answer, /Angelo Pinot Grigio 750ml: 4 of 6 bottles/);
    assert.match(answer, /1 item has no verified count/, 'the uncounted item is disclosed, not guessed');
    assert.doesNotMatch(answer, /Triple Sec/, 'exactly at par is not below par');
  } finally { await close(); }
});

test('"How many Angelo Pinot Grigio bottles remain?" answers from verified stock', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    assert.match((await ask(page, 'How many Angelo Pinot Grigio bottles remain?')).answer, /Angelo Pinot Grigio 750ml: 4 bottles · below par/);
    assert.match((await ask(page, 'How many agave syrup do we have?')).answer, /no verified count, so Atlas does not know/);
  } finally { await close(); }
});

test('"Can we make Margarita?" uses the Recipes readiness', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    const { answer } = await ask(page, 'Can we make Margarita?');
    assert.match(answer, /Atlas cannot confirm Margarita: Olmeca Blanco Tequila 1L — inventory unit does not match recipe unit/, 'names the real blocker, not the smallest known ingredient');
    const status = await page.evaluate(() => window.AtlasRecipes.recipeStatus(window.AtlasData.recipes().find((r) => r.id === 'margarita')).key);
    assert.equal(status, 'incomplete', 'the answer matches the Recipes page');
    assert.match((await ask(page, 'Can we make Mojito?')).answer, /no recipe matching/);
    assert.match((await ask(page, 'Can we make Paloma?')).answer, /cannot confirm Paloma: Agave syrup — inventory unit does not match recipe unit/);
    assert.match((await ask(page, 'Can we make lime soda?')).answer, /Yes\. About 200 servings from verified stock; Lime juice runs out first/);
    assert.match((await ask(page, 'Can we make a Negroni?')).answer, /no recipe matching/);
  } finally { await close(); }
});

test('"What needs ordering?" uses the shared order suggestions', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    const { answer } = await ask(page, 'What needs ordering?');
    assert.match(answer, /1 item needs ordering/);
    assert.match(answer, /Angelo Pinot Grigio 750ml: 12 bottles · Vínbúðin Heildsala/);
  } finally { await close(); }
});

test('"Who works tomorrow?" reads the published schedule', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    const { answer } = await ask(page, 'Who works tomorrow?', { wait: 900 });
    assert.match(answer, /1 person works tomorrow/);
    assert.match(answer, /Sara Jónsdóttir: 17:00–23:30 · Bartender/);
  } finally { await close(); }
});

test('questions without source data say so instead of answering', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures({ balances: [], shifts: { __status: 503, body: { error: 'down' } } }) });
  try {
    assert.match((await ask(page, 'What is low in stock?')).answer, /No item has a verified count yet/);
    assert.match((await ask(page, 'What needs ordering?')).answer, /Nothing needs ordering based on verified stock\. Items without a verified count \(5\)/);
    assert.match((await ask(page, 'Who works today?', { wait: 1500 })).answer, /could not load the schedule/);
  } finally { await close(); }
});

test('Escape closes the palette, returns focus and the next search starts empty', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures() });
  try {
    await ask(page, 'pinot');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#atlas-palette', (node) => node.hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-omni');
    await page.click('#atlas-omni');
    assert.equal(await page.inputValue('#atlas-palette-input'), '');
  } finally { await close(); }
});

test('search is reachable on a phone', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: fixtures(), viewport: { width: 390, height: 844 } });
  try {
    const box = await page.$eval('#atlas-phone-search', (node) => { const rect = node.getBoundingClientRect(); return { w: rect.width, h: rect.height, visible: rect.width > 0 && getComputedStyle(node).visibility !== 'hidden' }; });
    assert.ok(box.visible && box.w >= 40 && box.h >= 40, JSON.stringify(box));
    const result = await ask(page, 'pinot');
    assert.ok(result.options.some((option) => /Angelo Pinot Grigio/.test(option)));
  } finally { await close(); }
});

test('staff never see supplier results', { skip }, async () => {
  const { page, close } = await launchAtlas({ user: USERS.bartender, fixtures: fixtures() });
  try {
    const result = await ask(page, 'globus');
    assert.ok(!result.options.some((option) => /orders@globus/.test(option)));
    assert.ok(!result.options.some((option) => /^Purchasing/.test(option)), 'no manager-only destination either');
  } finally { await close(); }
});
