// S90 (design acceptance P1-1, P1-3, P1-4, P1-5): loading, empty and failed
// are three different states on every page. A failed load says what failed,
// that nothing was changed, and offers Try again; it never reads as an empty
// venue ("0 items", "No recipes yet") and never shows server or JavaScript
// error text. Home and Recipes agree on what can't be served, and the
// Inventory table keeps Status and Unit cost on screen with long names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, USERS } from './harness.mjs';
import { compositeWorld, INV, TC, RAW_SERVER_TEXT, LONG_SUPPLIER } from './composite-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

const EMPTY_CLAIM = /No (items|recipes|orders|suppliers|movements|team members|articles) (yet|recorded)|No waste recorded|\b0 (items|active items|recipes|open orders|orders|records|suppliers|movements)\b|Loading…|Loading the team/;

async function viewText(page) {
  return page.evaluate(() => {
    const view = [...document.querySelectorAll('main [id$="-view"]')].find((node) => node.getClientRects().length);
    const dialogs = [...document.querySelectorAll('.atlas-modal:not([hidden]) [role="dialog"]')].map((node) => node.innerText).join(' ');
    return `${view ? view.innerText : ''} ${dialogs}`.replace(/\s+/g, ' ');
  });
}

async function open(group, options = {}) {
  const user = options.user || USERS.admin;
  const fixtures = options.fixtures || compositeWorld(user, { group, ...options.world });
  return launchAtlas({ user, fixtures, viewport: options.viewport });
}

async function expectFailedState(page, route) {
  await navigateTo(page, route);
  await settle(page);
  const text = await viewText(page);
  assert.match(text, /couldn[’']t be (loaded|opened|shown)/, `${route} says what failed: ${text.slice(0, 300)}`);
  assert.match(text, /Try again/, `${route} offers Try again`);
  assert.doesNotMatch(text, EMPTY_CLAIM, `${route} makes no empty-venue claim: ${text.slice(0, 400)}`);
  assert.doesNotMatch(text, RAW_SERVER_TEXT, `${route} shows no server or JavaScript text`);
}

test('every endpoint failing: Inventory and Purchasing show failed states, never an empty venue', { skip }, async () => {
  const { page, record, close } = await open('INV', { world: { fail: true } });
  try {
    for (const route of ['#inventory', '#inventory/movements', '#inventory/waste', '#purchasing', '#purchasing/deliveries', '#purchasing/suppliers', `#purchasing/order/${INV.po1}`]) await expectFailedState(page, route);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('every endpoint failing: Home, Recipes and Data show failed states with Try again', { skip }, async () => {
  const home = await open('A', { world: { fail: true } });
  try {
    await navigateTo(home.page, '#home');
    await settle(home.page);
    const glance = await home.page.$$eval('.home-glance__item', (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ')));
    for (const tile of glance.slice(0, 3)) {
      assert.doesNotMatch(tile, /No items yet|No recipes yet|Nothing below par|\b0\b/, tile);
      assert.match(tile, /couldn’t be loaded|Loading/, tile);
    }
    assert.ok(await home.page.$('.home-glance [data-home-reload]'), 'a failed tile offers Try again');
    assert.deepEqual(home.record.pageErrors, []);
  } finally { await home.close(); }
  const c = await open('C', { world: { fail: true } });
  try {
    for (const route of ['#recipes', `#recipes/${TC.negroni}`, '#data/import-review']) await expectFailedState(c.page, route);
    assert.doesNotMatch(await viewText(c.page), /may have been deleted/);
    assert.deepEqual(c.record.pageErrors, []);
  } finally { await c.close(); }
});

test('every endpoint failing: Messages, Team and Knowledge never keep "Loading…" beside the error', { skip }, async () => {
  const { page, record, close } = await open('P', { world: { fail: true } });
  try {
    for (const route of ['#messages', '#team', '#knowledge', '#knowledge/k-closing', '#shifts']) await expectFailedState(page, route);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('an empty venue still reads as empty, with one primary per page', { skip }, async () => {
  const { page, close } = await open('C', { world: { empty: true } });
  try {
    await navigateTo(page, '#recipes');
    await settle(page);
    assert.match(await viewText(page), /No recipes yet/);
    const primaries = await page.$$eval('#recipes-view .atlas-btn--primary', (nodes) => nodes.filter((node) => node.getClientRects().length).length);
    assert.equal(primaries, 1, 'the header holds the one primary; the empty state offers a secondary');
  } finally { await close(); }
});

test('Purchasing: a deleted order or stale link is "no longer exists", never a JavaScript error', { skip }, async () => {
  const fixtures = compositeWorld(USERS.admin, { group: 'INV' });
  fixtures.rpc.atlas_purchase_order_detail = () => null;
  const { page, record, close } = await open('INV', { fixtures });
  try {
    await navigateTo(page, '#purchasing/order/00000000-0000-4000-8000-0000000000aa');
    await page.waitForSelector('[role="dialog"] [data-po-back]');
    const dialog = await page.textContent('[role="dialog"]');
    assert.match(dialog, /This order no longer exists\./);
    assert.doesNotMatch(dialog, RAW_SERVER_TEXT);
    await page.click('[role="dialog"] [data-po-back]');
    await page.waitForFunction(() => location.hash === '#purchasing/orders' && !document.querySelector('.atlas-modal:not([hidden]) [role="dialog"]'));
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Recipes: Try again after a failed load shows the library', { skip }, async () => {
  const fixtures = compositeWorld(USERS.admin, { group: 'C' });
  const rows = fixtures.tables.recipes;
  let healthy = false;
  fixtures.tables.recipes = () => (healthy ? rows : { __status: 503, body: { message: 'upstream connect error' } });
  const { page, close } = await open('C', { fixtures });
  try {
    await navigateTo(page, '#recipes');
    await page.waitForSelector('#recipes-view [data-recipe-retry]');
    assert.match(await page.textContent('#recipes-view .page-head__sub'), /Recipes couldn’t be loaded/);
    healthy = true;
    await page.click('#recipes-view [data-recipe-retry]');
    await page.waitForSelector('#recipes-view .recipe-tile');
    assert.match(await page.textContent('#recipes-view .page-head__sub'), /\d+ recipes/);
  } finally { await close(); }
});

test('Home and Recipes agree: a recipe using an item counted out is unavailable, never "0 unavailable"', { skip }, async () => {
  const { page, close } = await open('A');
  try {
    await navigateTo(page, '#home');
    await page.waitForSelector('.home-glance__item');
    const tile = await page.$$eval('.home-glance__item', (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ')).find((text) => /Recipes/.test(text)));
    assert.match(tile, /\b1\s*unavailable/, tile);
    assert.match(tile, /Negroni/, tile);
    const summary = await page.evaluate(() => { const s = window.AtlasRecipes.summary(); return { unavailable: s.unavailable.map((r) => r.name), state: s.state }; });
    assert.deepEqual(summary, { unavailable: ['Negroni'], state: 'ok' });
    await navigateTo(page, '#recipes');
    await settle(page);
    assert.match(await page.textContent('#recipes-view .page-head__sub'), /1 unavailable tonight/);
  } finally { await close(); }
});

test('Inventory at 1440 with long Icelandic names keeps Status and Unit cost on screen', { skip }, async () => {
  for (const width of [1440, 1280, 1024]) {
    const { page, close } = await open('INV', { world: { long: true }, viewport: { width, height: 900 } });
    try {
      await navigateTo(page, '#inventory');
      await page.waitForSelector('.inv__table tbody tr');
      const layout = await page.$eval('.inv__table', (wrap) => {
        const box = wrap.getBoundingClientRect();
        const header = (label) => [...wrap.querySelectorAll('th')].find((th) => th.textContent.trim().startsWith(label));
        const right = (label) => { const th = header(label); return th && th.getClientRects().length ? th.getBoundingClientRect().right : null; };
        const pills = [...wrap.querySelectorAll('tbody .atlas-pill')].map((pill) => ({ text: pill.textContent.trim(), clipped: pill.scrollWidth > pill.clientWidth + 1 || pill.getBoundingClientRect().right > pill.closest('td').getBoundingClientRect().right + 1 }));
        return { wrapRight: box.right, scrolls: wrap.scrollWidth > wrap.clientWidth + 1, status: right('Status'), cost: right('Unit cost'), pills, titles: [...wrap.querySelectorAll('tbody [title]')].map((node) => node.getAttribute('title')) };
      });
      assert.equal(layout.scrolls, false, `${width}: the table fits its wrapper`);
      assert.ok(layout.status && layout.status <= layout.wrapRight, `${width}: Status is on screen`);
      if (layout.cost !== null) assert.ok(layout.cost <= layout.wrapRight, `${width}: Unit cost is on screen`);
      assert.ok(layout.pills.length && layout.pills.every((pill) => !pill.clipped), `${width}: status pills are whole ${JSON.stringify(layout.pills)}`);
      assert.ok(layout.titles.includes(LONG_SUPPLIER), `${width}: a truncated supplier keeps its full name as a title`);
    } finally { await close(); }
  }
});
