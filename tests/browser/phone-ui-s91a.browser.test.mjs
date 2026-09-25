// S91a production UI defects, in the real shell at 390 px touch and desktop:
// the Recipes category menu opens visibly and filters; recipe tiles show their
// category on phones; Team Messages puts the viewer's own messages on the
// right and everyone else's on the left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchAtlas, harnessAvailable, settle, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';
import { messagesBackend, peopleFunctions, NOW } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { width: 390, height: 844 };
const TOUCH = { hasTouch: true, isMobile: true };

// No recipe_categories rows: the library uses its built-in categories.
const recipes = [
  { id: 'negroni', name: 'Negroni', type: 'classic-cocktail', glassware: 'Rocks', active: true, yield_quantity: 1, recipe_ingredients: [] },
  { id: 'spritz', name: 'Aperol spritz', type: 'spritz', glassware: 'Wine glass', active: true, yield_quantity: 1, recipe_ingredients: [] },
  { id: 'long', name: 'Jólaglögg með appelsínuberki og kanilstöngum frá Reykjavík', type: 'hot-cocktail', glassware: 'Heatproof mug with a very long description', active: true, yield_quantity: 1, recipe_ingredients: [] }
];

function launchRecipes({ viewport = PHONE, contextOptions = TOUCH, user = USERS.admin } = {}) {
  return launchAtlas({
    user, viewport, contextOptions, hash: '#recipes',
    fixtures: { tables: { inventory_items: [], inventory_catalog: [], recipes, recipe_catalog: recipes, suppliers: [], recipe_categories: [] }, functions: emptyFunctions() }
  });
}

const tileNames = (page) => page.$$eval('#recipes-view .recipe-tile__name', (nodes) => nodes.map((node) => node.textContent));

// Every menu item is on screen and is the element actually hit at its centre.
async function menuState(page) {
  return page.evaluate(() => {
    const menu = document.getElementById('recipe-category-menu');
    const rect = menu.getBoundingClientRect();
    const items = [...menu.querySelectorAll('.atlas-menu__item')].map((item) => {
      const box = item.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: item.textContent.trim(), height: box.height, onTop: Boolean(hit && item.contains(hit)) };
    });
    return {
      hidden: menu.hidden,
      inViewport: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      items,
      expanded: document.getElementById('recipe-category-trigger').getAttribute('aria-expanded')
    };
  });
}

test('Recipes on a phone: tapping Category opens a visible sheet; choosing filters, closes and shows the chip', { skip }, async () => {
  const { page, record, close } = await launchRecipes();
  try {
    await page.waitForSelector('#recipes-view .recipe-tile');
    await settle(page);
    await page.tap('#recipe-category-trigger');
    await settle(page);
    const open = await menuState(page);
    assert.equal(open.hidden, false);
    assert.equal(open.expanded, 'true');
    assert.equal(open.inViewport, true, 'the menu is inside the viewport');
    assert.ok(open.items.length >= 4, 'All categories plus the three used');
    assert.deepEqual(open.items.filter((item) => !item.onTop).map((item) => item.text), [], 'no item is covered or clipped');
    assert.deepEqual(open.items.filter((item) => item.height < 44).map((item) => item.text), [], '44 px targets');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.ATLAS_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_SHOTS}/recipes-category-open-390.png` });

    await page.tap('#recipe-category-menu [data-recipe-category="spritz"]');
    await page.waitForFunction(() => document.getElementById('recipe-category-trigger')?.textContent.trim() === 'Spritzes');
    await settle(page);
    assert.deepEqual(await tileNames(page), ['Aperol spritz']);
    assert.equal(await page.$eval('#recipe-category-menu', (menu) => menu.hidden), true, 'the menu closed');
    assert.equal(await page.getAttribute('#recipe-category-trigger', 'aria-expanded'), 'false');
    const chip = await page.$eval('#recipe-category-trigger', (node) => {
      const box = node.getBoundingClientRect();
      return { active: node.classList.contains('is-active'), visible: box.left >= 0 && box.right <= innerWidth && box.width > 0 };
    });
    assert.deepEqual(chip, { active: true, visible: true }, 'the chosen category stays visible in the chip');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'recipe-category-trigger', 'focus returns to the chip');

    // Tapping outside closes the sheet without opening the recipe underneath.
    await page.tap('#recipe-category-trigger');
    await settle(page);
    assert.equal((await menuState(page)).hidden, false);
    await page.touchscreen.tap(195, 120);
    await settle(page);
    assert.equal((await menuState(page)).hidden, true);
    assert.equal(await page.evaluate(() => location.hash), '#recipes');

    // Escape closes it too.
    await page.tap('#recipe-category-trigger');
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);
    assert.equal((await menuState(page)).hidden, true);

    // All categories again.
    await page.tap('#recipe-category-trigger');
    await settle(page);
    await page.tap('#recipe-category-menu [data-recipe-category="all"]');
    await page.waitForFunction(() => document.querySelectorAll('#recipes-view .recipe-tile').length === 3);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Recipes on desktop: the category menu still opens under the chip and filters', { skip }, async () => {
  const { page, close } = await launchRecipes({ viewport: { width: 1440, height: 900 }, contextOptions: {} });
  try {
    await page.waitForSelector('#recipes-view .recipe-tile');
    await page.click('#recipe-category-trigger');
    await settle(page);
    const open = await menuState(page);
    assert.equal(open.inViewport, true);
    assert.deepEqual(open.items.filter((item) => !item.onTop).map((item) => item.text), []);
    const below = await page.evaluate(() => document.getElementById('recipe-category-menu').getBoundingClientRect().top >= document.getElementById('recipe-category-trigger').getBoundingClientRect().bottom);
    assert.equal(below, true, 'a popover under the chip');
    await page.click('#recipe-category-menu [data-recipe-category="classic-cocktail"]');
    await page.waitForFunction(() => document.getElementById('recipe-category-trigger')?.textContent.trim() === 'Classic Cocktails');
    assert.deepEqual(await tileNames(page), ['Negroni']);
    assert.equal(await page.$eval('#recipe-category-menu', (menu) => menu.hidden), true);
  } finally { await close(); }
});

test('Recipe tiles show the category (and glassware when it fits) under the name at 390 px', { skip }, async () => {
  const { page, close } = await launchRecipes({ user: USERS.bartender });
  try {
    await page.waitForSelector('#recipes-view .recipe-tile[data-recipe-id]');
    await settle(page);
    const tiles = await page.$$eval('#recipes-view .recipe-tile[data-recipe-id]', (nodes) => nodes.map((tile) => {
      const name = tile.querySelector('.recipe-tile__name').getBoundingClientRect();
      const category = tile.querySelector('.recipe-tile__category');
      const box = category.getBoundingClientRect();
      const tileBox = tile.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 20), box.top + box.height / 2);
      return {
        id: tile.dataset.recipeId,
        category: category.textContent,
        fullyShown: category.scrollWidth <= category.clientWidth + 1,
        visible: getComputedStyle(category).display !== 'none' && box.width > 0 && box.height > 0 && category.contains(hit),
        underName: box.top >= name.bottom - 1,
        insideTile: box.left >= tileBox.left && box.right <= tileBox.right + 0.5,
        fontSize: parseFloat(getComputedStyle(category).fontSize),
        height: tileBox.height,
        meta: tile.querySelector('.recipe-tile__meta').textContent
      };
    }));
    const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
    assert.equal(byId.negroni.category, 'Classic Cocktails');
    assert.equal(byId.negroni.meta, 'Classic Cocktails · Rocks');
    assert.equal(byId.spritz.category, 'Spritzes');
    for (const tile of tiles) {
      assert.equal(tile.visible, true, `${tile.id}: category visible`);
      assert.equal(tile.fullyShown, true, `${tile.id}: category not cut`);
      assert.equal(tile.underName, true, `${tile.id}: under the name`);
      assert.equal(tile.insideTile, true, `${tile.id}: inside the tile`);
      assert.ok(tile.fontSize >= 12, `${tile.id}: 12 px floor`);
      assert.ok(tile.height >= 44, `${tile.id}: 44 px target`);
    }
    assert.equal(await page.$eval('#recipes-view .recipe-grid', (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 1, 'one column');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
  } finally { await close(); }
});

async function openMessages(user, viewport) {
  const phone = viewport.width < 768;
  const app = await launchAtlas({
    user, hash: '#messages/general', viewport, contextOptions: phone ? TOUCH : {}, fixedTime: new Date(NOW),
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': messagesBackend({ user }).handler, 'atlas-team-profile-photos': { photos: [], staff: { id: user.id, can_manage_team: true } } }) }
  });
  await app.page.waitForSelector('[data-team-message]');
  await settle(app.page);
  return app;
}

for (const who of ['admin', 'bartender']) {
  for (const width of [390, 1440]) {
    test(`Messages (${who}, ${width} px): own messages on the right, others on the left`, { skip }, async () => {
      const user = USERS[who];
      const { page, record, close } = await openMessages(user, { width, height: width < 768 ? 844 : 900 });
      try {
        const rows = await page.$$eval('[data-team-message]', (nodes) => {
          const log = document.querySelector('[data-msg-log]');
          const style = getComputedStyle(log);
          const left = log.getBoundingClientRect().left + parseFloat(style.paddingLeft);
          const right = log.getBoundingClientRect().right - parseFloat(style.paddingRight);
          return nodes.map((node) => {
            const box = node.querySelector('.msg-item__body').getBoundingClientRect();
            return { id: node.dataset.teamMessage, own: node.classList.contains('is-own'), fromLeft: box.left - left, fromRight: right - box.right, width: right - left, avatar: Boolean(node.querySelector('.msg-avatar')), name: node.querySelector('.msg-item__name')?.textContent || null };
          });
        });
        const mine = who === 'admin' ? ['m2'] : ['m1'];
        assert.deepEqual(rows.filter((row) => row.own).map((row) => row.id), mine, 'own is the viewer profile id against sender_id');
        for (const row of rows) {
          if (row.own) {
            assert.ok(row.fromRight <= 2, `${row.id}: right edge at the list's right edge (${row.fromRight})`);
            assert.ok(row.fromLeft >= row.width * 0.14, `${row.id}: left edge well away from the left (${row.fromLeft})`);
            assert.equal(row.avatar, false, `${row.id}: no avatar on own messages`);
            assert.equal(row.name, 'You', `${row.id}: named for assistive tech`);
          } else {
            assert.ok(row.fromLeft <= 48, `${row.id}: next to the avatar gutter on the left (${row.fromLeft})`);
            assert.ok(row.fromRight >= 24, `${row.id}: right edge away from the right (${row.fromRight})`);
          }
        }
        // Others keep avatar, name and role; grouping still collapses them.
        const other = await page.$eval('[data-team-message="m3"]', (node) => ({ avatar: Boolean(node.querySelector('.msg-avatar')), name: node.querySelector('.msg-item__name')?.textContent, role: node.querySelector('.msg-item__role')?.textContent }));
        assert.deepEqual(other, { avatar: true, name: 'Gunnar Karlsson', role: 'Bartender' });
        assert.equal(await page.$eval('[data-team-message="m4"]', (node) => node.classList.contains('is-grouped')), true);
        // The own bubble is accent-tinted, others' neutral; own read receipts stay.
        const fills = await page.evaluate((id) => ({
          own: getComputedStyle(document.querySelector(`[data-team-message="${id}"] .msg-item__body`)).backgroundColor,
          other: getComputedStyle(document.querySelector('[data-team-message="m3"] .msg-item__body')).backgroundColor
        }), mine[0]);
        assert.notEqual(fills.own, fills.other);
        if (who === 'admin') assert.match(await page.textContent('[data-team-message="m2"] .msg-item__foot'), /Read by 1/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
        if (process.env.ATLAS_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_SHOTS}/messages-${who}-${width}.png` });
        assert.deepEqual(record.pageErrors, []);
      } finally { await close(); }
    });
  }
}

test('Purchasing Status and Supplier filters open a visible menu on a 390 px phone', { skip }, async () => {
  const { page, close } = await launchAtlas({ viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    await page.evaluate(() => { location.hash = '#purchasing'; });
    await page.waitForSelector('[data-po-menu-trigger="status"]');
    for (const which of ['status', 'supplier']) {
      await page.tap(`[data-po-menu-trigger="${which}"]`);
      await page.waitForSelector(`[data-po-menu="${which}"]:not([hidden])`);
      const visible = await page.evaluate((name) => {
        const menu = document.querySelector(`[data-po-menu="${name}"]`);
        const box = menu.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(20, box.height / 2));
        return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight + 1 && menu.contains(hit);
      }, which);
      assert.equal(visible, true, `${which} menu is on screen and on top`);
      await page.keyboard.press('Escape');
    }
  } finally { await close(); }
});
