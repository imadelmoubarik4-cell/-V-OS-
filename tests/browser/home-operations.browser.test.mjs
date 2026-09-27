// S88 Team A: Home (command centre) and Operations (server checklists) in the
// real app for admin, bartender and viewer, including empty, error and phone
// states. Fixtures: tests/browser/team-a-fixtures.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, requestsTo, settle, until, USERS } from './harness.mjs';
import { teamAFixtures, VIEWER } from './team-a-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const NOW = '2026-09-24T16:32:00Z'; // Thursday, 16:32 in Reykjavik; opens 17:00.
const viewer = { ...USERS.bartender, ...VIEWER };

function launch(user = USERS.admin, options = {}) {
  const fixtures = teamAFixtures({ user });
  if (options.functions) Object.assign(fixtures.functions, options.functions);
  return launchAtlas({ user, fixtures, fixedTime: NOW, ...options.launch });
}

const text = (page, selector) => page.$eval(selector, (node) => node.textContent.replace(/\s+/g, ' ').trim());
const go = (page, hash) => navigateTo(page, hash);

// ---------- Home ----------

test('Home for an administrator: venue clock, attention rows, briefing, glance, tonight, timeline', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.waitForSelector('.home-attention [data-home-rows] .home-row');
    assert.match(await text(page, '.home-greeting'), /^Good afternoon/);
    assert.match(await text(page, '.home-context'), /Opens at 17:00 · opening checks in progress/);
    assert.match(await text(page, '.home-context'), /3 on shift tonight/);
    // Needs attention: at most five rows and a count; Campari and Limes are out.
    const rows = await page.$$eval('.home-attention .home-row .home-row__open', (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.ok(rows.length >= 3 && rows.length <= 5, `${rows.length} rows`);
    assert.ok(rows.includes('Campari: out of stock'));
    assert.ok(rows.includes('Limes: out of stock'));
    assert.ok(await page.$('.home-attention [data-home-view-all]'));
    // At a glance: real counts, no KPI dump.
    const glance = await page.$$eval('.home-glance__item', (nodes) => nodes.map((node) => node.querySelector('.home-glance__label').textContent.trim()));
    assert.deepEqual(glance, ['Stock', 'Recipes', 'Purchasing']);
    assert.match(await text(page, '.home-glance__item[href="#inventory?filter=below-par"]'), /3\s*below par 2 out · 1 not counted/);
    // Tonight lists who works, from the published week.
    assert.equal(await page.$$eval('.home-staff__row', (nodes) => nodes.length), 3);
    // The timeline links the server checklists.
    assert.match(await text(page, '#home-timeline'), /Opening checklist 4 of 9 done/);
    // No bookings, events, weather or invented sales.
    assert.doesNotMatch(await text(page, '#dashboard-view'), /booking|weather|revenue|covers/i);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Home briefing hands the question to Atlas AI with the briefing as context', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.waitForSelector('.home-briefing [data-home-ask]');
    // The daily briefing is Atlas speaking: its header carries the Atlas AI robot.
    assert.equal(await page.locator('.home-briefing__head .atlas-bot').count(), 1);
    assert.equal(await page.locator('.home-briefing__head [data-lucide="sparkles"]').count(), 0);
    await page.evaluate(() => {
      window.__asked = [];
      window.AtlasAI = { ...(window.AtlasAI || {}), askAbout: (record) => { window.__asked.push(record); } };
    });
    await page.click('.home-briefing [data-home-ask]');
    const asked = await page.evaluate(() => window.__asked);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].type, 'briefing');
    assert.equal(asked[0].id, '2026-09-24');
  } finally { await close(); }
});

test('a bartender with no verified count sees "Not counted", never "0 below par" or healthy', { skip }, async () => {
  const { page, close } = await launch(USERS.bartender, { functions: { 'atlas-stock-counts': { counts: { verified_balances: [] } } } });
  try {
    await page.waitForSelector('.home-glance__item');
    const stock = await text(page, '.home-glance__item[href="#inventory"]');
    assert.match(stock, /Not counted/);
    assert.doesNotMatch(stock, /below par|healthy/i);
    assert.match(await text(page, '.home-attention'), /Stock isn’t counted yet/);
    // Staff see their next shift instead of Purchasing.
    const labels = await page.$$eval('.home-glance__label', (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(labels, ['Stock', 'Recipes', 'My next shift']);
  } finally { await close(); }
});

test('a bartender gets "View item", not "Add to order", on an out-of-stock row', { skip }, async () => {
  const { page, close } = await launch(USERS.bartender);
  try {
    await page.waitForSelector('.home-attention .home-row');
    const actions = await page.$$eval('.home-attention .home-row .atlas-btn', (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.ok(actions.includes('View item'));
    assert.ok(!actions.includes('Add to order'));
  } finally { await close(); }
});

test('one intelligence producer: Home refreshes Atlas AI signals once per manager session, never Checkpoint K', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.waitForSelector('.home-attention .home-row');
    const signals = () => requestsTo(record, 'atlas-ai', 'refresh-signals');
    await until(() => signals().length > 0);
    assert.equal(signals().length, 1);
    assert.equal(signals()[0].method, 'POST');
    assert.equal(requestsTo(record, 'atlas-phase3-intelligence', 'refresh').length, 0, 'Checkpoint K no longer writes a second set of recommendations');
    // Leaving and coming back to Home does not refresh again this session.
    await go(page, '#inventory');
    await go(page, '#');
    assert.equal(signals().length, 1);
  } finally { await close(); }
  const staff = await launch(USERS.bartender);
  try {
    await staff.page.waitForSelector('.home-attention');
    await until(() => requestsTo(staff.record, 'atlas-shifts').length > 0);
    assert.equal(staff.record.requests.filter((entry) => entry.action === 'refresh-signals').length, 0, 'staff never trigger the manager refresh');
  } finally { await staff.close(); }
});

test('a viewer sees only the attention rows on Home', { skip }, async () => {
  const { page, record, close } = await launch(viewer);
  try {
    await page.waitForSelector('.home-attention');
    await settle(page);
    for (const selector of ['.home-glance', '.home-briefing', '#home-timeline', '.home-staff', '.home-grid']) {
      assert.equal(await page.$(`#dashboard-view ${selector}`), null, `${selector} is hidden from viewers`);
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('an inventory load failure becomes an attention row with a retry', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.waitForSelector('.home-attention .home-row');
    await page.evaluate(() => window.AtlasShell.emit('data:error', { source: 'Inventory' }));
    await page.waitForFunction(() => window.AtlasShell.home.rows({ role: 'admin' }).some((row) => row.id === 'load-errors:error:Inventory'));
    const rows = await page.evaluate(() => window.AtlasShell.home.rows({ role: 'admin' }).filter((row) => row.id === 'load-errors:error:Inventory'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Inventory couldn’t be loaded');
    assert.match(rows[0].detail, /may be incomplete/);
    assert.equal(rows[0].action.actionId, 'home.reload');
  } finally { await close(); }
});

test('with everything in order Home says so and shows when it last checked', { skip }, async () => {
  const fixtures = teamAFixtures({ user: USERS.admin });
  fixtures.tables.inventory_items = fixtures.tables.inventory_items.slice(0, 1).map((item) => ({ ...item, par_level: 1 }));
  fixtures.functions['atlas-stock-counts'] = { counts: { verified_balances: [{ inventory_item_id: 'campari', verified_quantity: 5, freshness_state: 'current', verified_at: '2026-09-22T11:00:00Z', expires_at: '2026-10-22T11:00:00Z' }] } };
  fixtures.functions['atlas-operations-checkpoint-a'] = () => ({ operations: { routines: [], temperature: { summary: { required_points: 0 }, points: [] }, business_date: '2026-09-24' }, checklists: { business_date: '2026-09-24', configured: false }, staff: { can_write: true, can_manage: true } });
  fixtures.tables.recipes = [];
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures, fixedTime: NOW });
  try {
    await page.waitForFunction(() => /Nothing needs you right now/.test(document.querySelector('.home-attention')?.textContent || ''));
    await settle(page);
    assert.match(await text(page, '.home-attention'), /Nothing needs you right now/);
    assert.match(await text(page, '.home-attention'), /Last checked \d{2}:\d{2}/);
  } finally { await close(); }
});

test('the notifications feed lists each conversation with unread messages', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.waitForSelector('.home-attention .home-row');
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    await page.waitForSelector('.atlas-notify__item-title');
    await settle(page);
    const titles = await page.$$eval('.atlas-notify__item-title', (nodes) => nodes.map((node) => node.textContent));
    assert.ok(titles.some((title) => /General/.test(title)), titles.join(' | '));
    assert.ok(titles.some((title) => /Managers/.test(title)), titles.join(' | '));
    assert.ok(!titles.some((title) => /\d+ unread messages/.test(title)), 'no interim "N unread messages" item');
  } finally { await close(); }
});

// ---------- Operations ----------

test('Operations lists today’s server checklists and a tick is a server write with who and when', { skip }, async () => {
  const { page, record, close } = await launch(USERS.bartender);
  try {
    await go(page, '#operations');
    await page.waitForSelector('#operations-view .ops-list');
    assert.match(await text(page, '#operations-view'), /Opening checklist/);
    await go(page, '#operations/00000000-0000-4000-8000-000000000001');
    await page.waitForSelector('[data-ops-tick="00000000-0000-4000-8000-000000000015"]');
    // Done items say who ticked them.
    assert.match(await text(page, '#operations-view'), /Sara Jónsdóttir/);
    await page.click('[data-ops-tick="00000000-0000-4000-8000-000000000015"]');
    await page.waitForFunction(() => document.querySelector('[data-ops-tick="00000000-0000-4000-8000-000000000015"]')?.getAttribute('aria-checked') === 'true');
    const write = requestsTo(record, 'atlas-operations-checkpoint-a', 'set-item')[0];
    assert.equal(write.method, 'POST');
    assert.equal(write.body.instance_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(write.body.template_item_id, '00000000-0000-4000-8000-000000000015');
    assert.equal(write.body.completed, true);
    // Nothing is stored on the device.
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('atlas.checklist')).length), 0);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a viewer can read a checklist but not tick it', { skip }, async () => {
  const { page, record, close } = await launch(viewer);
  try {
    await go(page, '#operations/00000000-0000-4000-8000-000000000001');
    await page.waitForSelector('[data-ops-tick]');
    assert.equal(await page.$$eval('[data-ops-tick]', (nodes) => nodes.every((node) => node.disabled)), true);
    assert.equal(requestsTo(record, 'atlas-operations-checkpoint-a', 'set-item').length, 0);
  } finally { await close(); }
});

test('old device ticks are imported only when the person chooses "Tick them as me"', { skip }, async () => {
  const seed = () => { try { localStorage.setItem('atlas.checklist.2026-09-24.opening', JSON.stringify({ glassware: true, 'bar-stock': true, 'cash-pos': true })); } catch { /* storage unavailable */ } };
  const { page, record, close } = await launch(USERS.bartender, { launch: { initScript: seed } });
  try {
    await go(page, '#operations');
    await page.waitForSelector('[data-ops-import]');
    assert.equal(requestsTo(record, 'atlas-operations-checkpoint-a', 'set-item').length, 0, 'nothing is imported silently');
    await page.click('[data-ops-import]');
    await page.waitForFunction(() => !document.querySelector('[data-ops-import]'));
    await settle(page);
    const writes = requestsTo(record, 'atlas-operations-checkpoint-a', 'set-item');
    // cash-pos was already done on the server; only the two open items are ticked.
    assert.equal(writes.length, 2);
    assert.ok(writes.every((entry) => entry.body.completed === true && entry.body.evidence?.source === 'device_checklist_import_s88'));
    assert.equal(await page.evaluate(() => localStorage.getItem('atlas.checklist.2026-09-24.opening')), null);
  } finally { await close(); }
});

// ---------- phone ----------

test('phone: Home, Operations and Settings fit 390 px with 44 px touch targets', { skip }, async () => {
  // A touch phone (pointer: coarse), where the design system sizes controls for fingers.
  const { page, record, close } = await launchAtlas({ user: USERS.admin, fixtures: teamAFixtures({ user: USERS.admin }), fixedTime: NOW, viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    for (const [route, selector] of [['#home', '.home-attention .home-row'], ['#operations/00000000-0000-4000-8000-000000000001', '[data-ops-tick]'], ['#settings/hours', '[data-settings-hours-form]']]) {
      await go(page, route);
      await page.waitForSelector(selector);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${route}: page scrolls sideways by ${overflow}px`);
      const small = await page.evaluate(() => [...document.querySelectorAll('.atlas-content main button, .atlas-content main a.atlas-btn, .atlas-content main input:not([type="hidden"]), .atlas-content main select')]
        .filter((node) => node.getClientRects().length > 0 && !node.closest('[hidden]'))
        // A row's title button stretches over the whole row (::after), and a
        // checkbox's target is its label, so those are measured instead.
        .map((node) => ({ what: `${node.tagName.toLowerCase()}.${node.className}`, h: Math.round((node.classList.contains('home-row__open') ? node.closest('.home-row') : node.closest('label') || node).getBoundingClientRect().height) }))
        .filter((box) => box.h < 44));
      assert.deepEqual(small, [], `${route}: controls under 44 px`);
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
