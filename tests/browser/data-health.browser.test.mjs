// P1-4: a partly failed shell data load never shows stock numbers derived from
// partial inputs. When inventory movements or verified balances fail to load,
// index.html withholds the stock projection (every item unknown, reason
// stock_data_incomplete), AtlasData.health() names the failed input, and Home,
// Inventory and Reports say "Stock figures are incomplete" with a retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { teamAFixtures } from './team-a-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const NOW = '2026-09-24T16:32:00Z'; // Thursday, 16:32 in Reykjavik (team A fixture time).

const text = (page, selector) => page.$eval(selector, (node) => node.textContent.replace(/\s+/g, ' ').trim());

async function navigate(page, hash, selector) {
  await page.evaluate((target) => window.AtlasShell.navigate(target), hash);
  await page.waitForSelector(selector);
}

// Launches with one input failing until `backend.healthy = true`.
async function launchWithFailure(kind, user = USERS.admin) {
  const backend = { healthy: false, movementReads: 0, snapshotReads: 0 };
  const fixtures = teamAFixtures({ user });
  const movements = [{ id: 'mv1', item_id: 'tanq', item_name: 'Tanqueray London Dry', movement_type: 'waste', quantity_change: -1, created_at: '2026-09-23T20:00:00Z' }];
  const balances = fixtures.functions['atlas-stock-counts'];
  fixtures.tables.inventory_movements = () => {
    backend.movementReads += 1;
    if (kind === 'movements' && !backend.healthy) return { __status: 500, body: { message: 'upstream timeout' } };
    return movements;
  };
  fixtures.tables.inventory_movement_catalog = fixtures.tables.inventory_movements;
  fixtures.functions['atlas-stock-counts'] = (entry) => {
    if (entry.action === 'snapshot') backend.snapshotReads += 1;
    if (kind === 'balances' && !backend.healthy) return { __status: 503, body: { error: 'unavailable' } };
    return balances;
  };
  const app = await launchAtlas({ user, fixtures, fixedTime: NOW });
  return { ...app, backend };
}

test('movements fail: no stock is projected from stale counts; Home, Inventory and Reports say the figures are incomplete', { skip }, async () => {
  const { page, record, close, backend } = await launchWithFailure('movements');
  try {
    const health = await page.evaluate(() => window.AtlasData.health());
    assert.equal(health.movements, 'failed');
    assert.equal(health.balances, 'ok');
    assert.equal(health.inventory, 'ok');
    assert.equal(health.stock, 'partial');
    assert.deepEqual(health.stockMissing, ['movements']);
    assert.equal(await page.evaluate(() => window.AtlasData.status().items), 'partial');
    // Every item is unknown with a reason — never its baseline count as if complete.
    const items = await page.evaluate(() => window.AtlasData.items().map((item) => ({ id: item.id, quantity: item.quantity, status: window.AtlasStockTruth.stockStatus(item), reason: window.AtlasStockTruth.unknownReason(item) })));
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.quantity === null && item.status === 'unknown' && item.reason === 'stock_data_incomplete'), JSON.stringify(items));

    // Home: one clear attention row with Try again; the glance shows no number.
    await page.waitForSelector('.home-glance__item');
    const row = await page.evaluate(() => window.AtlasShell.home.rows({ role: 'admin' }).find((entry) => entry.id === 'load-errors:error:stock-incomplete'));
    assert.equal(row.title, 'Stock figures are incomplete');
    assert.match(row.detail, /^Movements couldn’t load, so no stock numbers are shown\. Try again\./);
    assert.equal(row.action.actionId, 'home.reload');
    const glance = await text(page, '.home-glance__item:first-child');
    assert.match(glance, /Incomplete/);
    assert.match(glance, /Stock figures are incomplete — movements couldn’t load/);
    assert.doesNotMatch(glance, /below par|not counted/);
    assert.doesNotMatch(await text(page, '.home-briefing'), /is out|below par/);

    // Inventory: the warning alert, and no quantity or "Not counted" status.
    await navigate(page, '#inventory', '.inv .atlas-alert');
    assert.match(await text(page, '.inv .atlas-alert'), /Stock figures are incomplete — movements couldn’t load\. Try again\./);
    assert.match(await text(page, '.page-head__sub'), /stock figures incomplete/);
    const statuses = await page.$$eval('.inv__table tbody tr', (rows) => rows.map((tr) => tr.textContent.replace(/\s+/g, ' ')));
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every((line) => /Unknown/.test(line) && !/Not counted|Below par|\bOut\b/.test(line)), statuses.join(' | '));

    // Reports › Overview: the alert and no inventory value built from partial stock.
    await navigate(page, '#reports', '.reports-body .atlas-stats');
    assert.match(await text(page, '.reports-body'), /Stock figures are incomplete — movements couldn’t load\. Try again\./);
    const inventoryValue = await page.$eval('.reports-stats .atlas-stat', (node) => node.textContent.replace(/\s+/g, ' ').trim());
    assert.match(inventoryValue, /Inventory value\s*—\s*Stock figures are incomplete/);

    // Try again once movements load: numbers return and every alert clears.
    backend.healthy = true;
    const readsBefore = backend.movementReads;
    await page.click('[data-reports-stock-retry]');
    await page.waitForFunction(() => window.AtlasData.health().stock === 'ok');
    assert.ok(backend.movementReads > readsBefore);
    // Recovered stock is projected again; a never-counted item is 'not_counted', not incomplete.
    const recovered = await page.evaluate(() => window.AtlasData.items().map((item) => window.AtlasStockTruth.unknownReason(item)));
    assert.ok(recovered.includes(null) && !recovered.includes('stock_data_incomplete'), JSON.stringify(recovered));
    await page.waitForFunction(() => !/Stock figures are incomplete/.test(document.querySelector('.reports-body')?.textContent || ''));
    await navigate(page, '#', '.home-glance__item');
    await page.waitForFunction(() => /below par/.test(document.querySelector('.home-glance__item')?.textContent || ''));
    const cleared = await page.evaluate(() => window.AtlasShell.home.rows({ role: 'admin' }).some((entry) => entry.id === 'load-errors:error:stock-incomplete'));
    assert.equal(cleared, false);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('verified balances fail: items are not silently "Not counted"; Home and Inventory say the figures are incomplete', { skip }, async () => {
  const { page, record, close, backend } = await launchWithFailure('balances');
  try {
    const health = await page.evaluate(() => window.AtlasData.health());
    assert.equal(health.balances, 'failed');
    assert.equal(health.movements, 'ok');
    assert.equal(health.stock, 'partial');
    assert.deepEqual(health.stockMissing, ['balances']);

    await page.waitForSelector('.home-glance__item');
    const row = await page.evaluate(() => window.AtlasShell.home.rows({ role: 'admin' }).find((entry) => entry.id === 'load-errors:error:stock-incomplete'));
    assert.equal(row.title, 'Stock figures are incomplete');
    assert.match(row.detail, /^Verified counts couldn’t load/);
    const glance = await text(page, '.home-glance__item:first-child');
    assert.match(glance, /Incomplete/);
    assert.doesNotMatch(glance, /Not counted|No verified count/);

    await navigate(page, '#inventory', '.inv .atlas-alert');
    const alerts = await page.$$eval('.inv .atlas-alert', (nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(alerts.some((entry) => /Stock figures are incomplete — verified counts couldn’t load\. Try again\./.test(entry)), alerts.join(' | '));
    assert.ok(!alerts.some((entry) => /hasn’t been counted yet/.test(entry)), 'the never-counted notice is not shown for a failed load');
    const statuses = await page.$$eval('.inv__table tbody tr', (rows) => rows.map((tr) => tr.textContent.replace(/\s+/g, ' ')));
    assert.ok(statuses.every((line) => /Unknown/.test(line) && !/Not counted/.test(line)), statuses.join(' | '));

    // Inventory's own Try again reloads the shell data.
    backend.healthy = true;
    const readsBefore = backend.snapshotReads;
    await page.click('.inv .atlas-alert [data-inv-retry]');
    await page.waitForFunction(() => window.AtlasData.health().stock === 'ok');
    assert.ok(backend.snapshotReads > readsBefore);
    await page.waitForFunction(() => !/Stock figures are incomplete/.test(document.querySelector('.inv')?.textContent || ''));
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
