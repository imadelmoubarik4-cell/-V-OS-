// S88 AtlasShell in the real app: sidebar navigation, deep links, Back/Forward,
// one render per navigation, Home composition order and no page errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: new Date(Date.now() - 86400000).toISOString(), expires_at: new Date(Date.now() + 864000000).toISOString() });
const inventory = [
  { id: 'pinot', name: 'Angelo Pinot Grigio', category: 'Wine', unit: 'bottles', par_level: 6, supplier: 'Globus', active: true, cost_price: 2100 },
  { id: 'gin', name: 'Gin', category: 'Gin', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 5000 }
];

// Counts window 'atlas:view-change' events from before any app script runs.
const recordViewChanges = () => {
  window.__viewChanges = [];
  window.addEventListener('atlas:view-change', (event) => window.__viewChanges.push(event.detail?.view));
};

function launch(options = {}) {
  return launchAtlas({
    initScript: recordViewChanges,
    ...options,
    fixtures: {
      tables: { inventory_items: inventory, recipes: [], suppliers: [], recipe_categories: [] },
      functions: { ...emptyFunctions(), 'atlas-stock-counts': { counts: { verified_balances: [balance('pinot', 4), balance('gin', 2)] } } },
      ...options.fixtures
    }
  });
}

// Clicks the sidebar link; retired destinations (Brain, Business, System)
// have no visible link since the S88 redesign and open through the shell.
async function clickNav(page, view) {
  const visible = await page.$eval(`.atlas-nav .nav-item[data-view="${view}"]`, (node) => node.getClientRects().length > 0).catch(() => false);
  if (visible) await page.click(`.atlas-nav .nav-item[data-view="${view}"]`);
  else await page.evaluate((target) => window.AtlasShell.show(target, {}, { source: 'nav' }), view);
  await page.waitForTimeout(150);
}

const state = (page) => page.evaluate(() => {
  const main = document.querySelector('.atlas-content.standard-view main');
  const visibleRoots = [...main.children]
    .filter((element) => element.id && element.id.endsWith('-view') && getComputedStyle(element).display !== 'none')
    .map((element) => element.id);
  return {
    view: document.body.dataset.atlasView,
    current: window.AtlasShell.current(),
    hash: location.hash,
    title: document.getElementById('atlas-page-title').textContent,
    active: [...document.querySelectorAll('.atlas-nav .nav-item.active')].map((button) => button.dataset.view),
    visibleRoots
  };
});

test('sidebar navigation shows exactly one workspace, updates the address bar and emits view changes', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    // Runtime modules register their views after window load.
    await page.waitForFunction(() => ['marketing', 'system', 'team-profiles', 'operations', 'brain', 'business'].every((view) => window.AtlasShell.views().includes(view)));
    // [view, root, address, page title (spec names), active sidebar item]
    const expectations = [
      ['inventory', 'inventory-view', '#inventory', 'Inventory', 'inventory'],
      ['recipes', 'recipes-view', '#recipes', 'Recipes', 'recipes'],
      ['suppliers', 'suppliers-view', '#purchasing', 'Purchasing', 'suppliers'],
      ['operations', 'operations-view', '#operations', 'Operations', 'operations'],
      ['team', 'team-view', '#messages', 'Messages', 'team'],
      ['shifts', 'shifts-view', '#shifts', 'Shifts', 'shifts'],
      ['knowledge', 'knowledge-view', '#knowledge', 'Knowledge', 'knowledge'],
      ['brain', 'brain-view', '#brain', 'Home', 'dashboard'],
      ['business', 'business-view', '#business', 'Reports', 'reports'],
      ['reports', 'reports-view', '#reports', 'Reports', 'reports'],
      ['marketing', 'marketing-view', '#marketing', 'Marketing', 'marketing'],
      ['system', 'system-view', '#settings/system', 'Settings', 'settings'],
      ['settings', 'settings-view', '#settings', 'Settings', 'settings'],
      ['dashboard', 'dashboard-view', '#home', 'Home', 'dashboard']
    ];
    for (const [view, root, hash, title, active] of expectations) {
      await clickNav(page, view);
      const now = await state(page);
      assert.equal(now.view, view, `${view}: body view`);
      assert.equal(now.current, view, `${view}: AtlasShell.current()`);
      assert.deepEqual(now.visibleRoots, [root], `${view}: only its workspace is visible`);
      assert.deepEqual(now.active, [active], `${view}: one active nav item`);
      assert.equal(now.title, title, `${view}: page title`);
      assert.ok(now.hash === hash || (view === 'reports' && now.hash.startsWith('#reports')), `${view}: address ${now.hash}`);
    }
    const changes = await page.evaluate(() => window.__viewChanges);
    assert.deepEqual(changes.slice(-expectations.length), expectations.map(([view]) => view), 'atlas:view-change fires once per navigation');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('deep links open their destination at sign-in: #reports/stock, #inventory, #purchasing/deliveries', { skip }, async () => {
  for (const [hash, view, check] of [
    ['#reports/stock', 'reports', async (page) => {
      // 'stock' is the spec name for the inventory report.
      await page.waitForFunction(() => window.AtlasReports?.section?.() === 'inventory');
    }],
    ['#inventory', 'inventory', async (page) => {
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('inventory-view')).display), 'grid');
    }],
    ['#purchasing/deliveries', 'suppliers', async (page) => {
      await page.waitForFunction(() => document.getElementById('purchase-deliveries-tab')?.classList.contains('active'));
    }],
    ['#suppliers', 'suppliers', async () => {}]
  ]) {
    const { page, record, close } = await launch({ hash });
    try {
      assert.equal(await page.evaluate(() => document.body.dataset.atlasView), view, hash);
      await check(page);
      assert.deepEqual(record.pageErrors, [], hash);
    } finally { await close(); }
  }
});

test('route table: #messages is Messages, #team is the Team directory, legacy hashes still work', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#messages' });
  try {
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'team');
    await page.waitForFunction(() => window.AtlasShell.views().includes('team-profiles'));
    for (const [hash, view] of [['#team', 'team-profiles'], ['#dashboard', 'dashboard'], ['#waste', 'waste'], ['#team-profiles', 'team-profiles'],
      ['#home', 'dashboard'], ['#sprint3-review', 'sprint3-review'], ['#business', 'business'], ['#system', 'system']]) {
      await page.evaluate((target) => { location.hash = target; }, hash);
      await page.waitForFunction((expected) => document.body.dataset.atlasView === expected, view);
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Back and Forward move between opened workspaces', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await clickNav(page, 'inventory');
    await clickNav(page, 'recipes');
    await clickNav(page, 'knowledge');
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.atlasView === 'recipes');
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.atlasView === 'inventory');
    assert.deepEqual((await state(page)).visibleRoots, ['inventory-view']);
    await page.goForward();
    await page.waitForFunction(() => document.body.dataset.atlasView === 'recipes');
    assert.equal((await state(page)).hash, '#recipes');
    // A typed link (or a link from Atlas AI) routes through the same parser.
    await page.evaluate(() => { location.hash = '#inventory/movements'; });
    await page.waitForFunction(() => document.body.dataset.atlasView === 'movements');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('each navigation renders its view once and Home composes its sections in order', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.waitForFunction(() => window.AtlasShell.homeSections().includes('checkpoint-a-prompt'));
    assert.deepEqual(await page.evaluate(() => window.AtlasShell.homeSections()),
      ['core', 'operations', 'brain', 'business', 'checkpoint-a', 'checkpoint-a-prompt']);
    for (const view of ['operations', 'brain', 'business', 'recipes', 'suppliers', 'dashboard']) {
      const before = await page.evaluate(() => window.AtlasShell.debug());
      await clickNav(page, view);
      const after = await page.evaluate(() => window.AtlasShell.debug());
      assert.equal((after.shows[view] || 0) - (before.shows[view] || 0), 1, `${view} shown once per click`);
      assert.equal((after.renders[view] || 0) - (before.renders[view] || 0), 1, `${view} rendered once per click`);
      const shows = after.events.slice(before.events.length).filter((event) => event.type === 'view:show');
      assert.deepEqual(shows.map((event) => event.view), [view], `${view}: one view:show`);
      if (view === 'dashboard') {
        assert.equal(after.homeRenders - before.homeRenders, 1, 'Home composed once');
        for (const section of ['core', 'operations', 'brain', 'business', 'checkpoint-a', 'checkpoint-a-prompt']) {
          assert.equal((after.home[section] || 0) - (before.home[section] || 0), 1, `${section} rendered once`);
        }
      }
    }
    // Home was composed in registration order: the base metrics first, then
    // Brain's timeline card placed right after them, visible only on Home.
    const composed = await page.evaluate(() => new Promise((resolve) => {
      window.AtlasShell.once('home:rendered', (detail) => resolve({
        sections: detail.sections,
        timelineAfterMetrics: document.getElementById('home-metrics')?.nextElementSibling?.id === 'home-timeline',
        timelineVisible: getComputedStyle(document.getElementById('home-timeline')).display !== 'none'
      }));
      window.renderAtlasHome();
    }));
    assert.deepEqual(composed.sections, ['core', 'operations', 'brain', 'business', 'checkpoint-a', 'checkpoint-a-prompt']);
    assert.ok(composed.timelineAfterMetrics, 'the Brain section places the timeline after the metrics');
    assert.ok(composed.timelineVisible);
    await clickNav(page, 'inventory');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('home-timeline')).display), 'none');
    assert.equal(await page.evaluate(() => document.getElementById('home-timeline').getAttribute('aria-hidden')), 'true');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('no module patches the shell in the running app and runtime modules load once', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.waitForFunction(() => Boolean(window.AtlasInventoryScanner && window.AtlasStockCounts && window.AtlasSettings));
    const report = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[src]')].map((script) => script.getAttribute('src').split('?')[0]).filter((src) => src.startsWith('assets/'));
      const duplicates = scripts.filter((src, index) => scripts.indexOf(src) !== index);
      return {
        duplicates,
        setActiveView: String(window.setActiveView).replace(/\s+/g, ' '),
        addEventListenerNative: String(document.addEventListener).includes('[native code]'),
        mutationObserverNative: String(window.MutationObserver).includes('[native code]'),
        stockCountOpenNative: !String(window.AtlasStockCounts.open).includes('nativeOpen')
      };
    });
    assert.deepEqual(report.duplicates, [], 'every runtime script is in the page once');
    assert.equal(report.setActiveView, 'function setActiveView(view) { return window.AtlasShell.show(view); }');
    assert.ok(report.addEventListenerNative, 'document.addEventListener is the browser original');
    assert.ok(report.mutationObserverNative, 'window.MutationObserver is the browser original');
    assert.ok(report.stockCountOpenNative, 'AtlasStockCounts.open is not wrapped');
    // The Stock count route opens the count workspace through the shell.
    await page.evaluate(() => window.AtlasShell.navigate('#inventory/counts'));
    await page.waitForFunction(() => document.body.classList.contains('stock-count-active'));
    assert.equal(await page.evaluate(() => location.hash), '#inventory/counts');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('the bell opens the notifications feed; canonical actions run the existing flows', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    const opened = await page.evaluate(() => {
      const events = [];
      window.AtlasShell.on('notify:open', () => events.push('open'));
      document.getElementById('atlas-notifications-btn').click();
      return events;
    });
    assert.deepEqual(opened, ['open']);
    // The bell opens the panel (spec §4.9), never Settings.
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'dashboard');
    await page.keyboard.press('Escape');
    const actions = await page.evaluate(() => window.AtlasShell.actions.list({ context: 'home', suggested: true }).map((action) => action.id));
    for (const id of ['inventory.item.add', 'inventory.count.start', 'purchasing.order.new', 'inventory.scan', 'operations.checklist.open']) {
      assert.ok(actions.includes(id), `${id} is suggested on Home for an admin`);
    }
    await page.evaluate(() => window.AtlasShell.actions.run('operations.checklist.open'));
    await page.waitForFunction(() => document.body.dataset.atlasView === 'operations');
    // The + button (quick actions) replaces the floating action button.
    await page.click('#atlas-quick-actions');
    await page.fill('#atlas-palette-input', 'add item');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('item-overlay')).display !== 'none');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a bartender sees staff actions only and the purchasing link explains its limit', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ user: USERS.bartender, initScript: recordViewChanges, fixtures: { functions: emptyFunctions() } });
  try {
    const actions = await page.evaluate(() => window.AtlasShell.actions.list().map((action) => action.id));
    assert.ok(actions.includes('inventory.count.start'));
    assert.ok(!actions.includes('purchasing.order.new'), 'manager-only actions are not listed for staff');
    await page.evaluate(() => window.AtlasShell.navigate('#purchasing'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'dashboard');
    // No alert() (spec §4.12): a toast says who can open it.
    assert.deepEqual(record.dialogs, []);
    assert.match(await page.textContent('#atlas-toast-region'), /That page is for managers/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
