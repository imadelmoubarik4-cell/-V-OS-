// Audit L13, L15, L17, L24 (frontend): how the shell loads its data, and the
// stock-count start retry, in a real browser against the mocked backend.
//
// L17: movements, items and the stock-count snapshot are read at the same
//      time; stock is projected once all three are in.
// L24: the stock-count snapshot is read once at sign-in (the shell's read is
//      adopted by the stock-count workspace); opening Counts still refreshes.
// L13: shell reloads are single-flight: a reload asked for while one runs is
//      a trailing load, so an older load can never commit its movements last.
// L15: a "Start count" retried after a lost answer reuses its request id, so
//      the server replays it instead of opening a second count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, requestsTo, settle, until, USERS } from './harness.mjs';
import { teamAFixtures } from './team-a-fixtures.mjs';
import { inventoryWorld, countBackend } from './inventory-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const NOW = '2026-09-24T16:32:00Z'; // team A fixture time

// Team A fixtures with counted reads of the three stock inputs.
function stockWorld(user) {
  const fixtures = teamAFixtures({ user });
  const reads = { movements: 0, items: 0, snapshot: 0, overlap: [] };
  const backend = { movements: [], gate: null, reads };
  const itemRelation = ['admin', 'manager'].includes(user.role) ? 'inventory_items' : 'inventory_catalog';
  const itemRows = fixtures.tables[itemRelation];
  fixtures.tables[itemRelation] = () => { reads.items += 1; return itemRows; };
  const snapshot = fixtures.functions['atlas-stock-counts'];
  fixtures.functions['atlas-stock-counts'] = (entry) => {
    if (entry.action === 'snapshot') reads.snapshot += 1;
    return snapshot;
  };
  fixtures.tables.inventory_movements = async () => {
    reads.movements += 1;
    const rows = backend.movements; // what the database holds when the read arrives
    const gate = backend.gate;
    if (gate) { backend.gate = null; gate.arrived = true; await gate.released; }
    if (backend.waitForOthers) {
      // L17: are the item rows and the snapshot requested while movements are still loading?
      const concurrent = await until(() => reads.items > 0 && reads.snapshot > 0, { timeout: 3000, message: 'items and snapshot reads' }).then(() => true, () => false);
      reads.overlap.push(concurrent);
    }
    return rows;
  };
  fixtures.tables.inventory_movement_catalog = fixtures.tables.inventory_movements;
  return { fixtures, backend, reads };
}

function deferred() {
  let release;
  const gate = { arrived: false };
  gate.released = new Promise((resolve) => { release = resolve; });
  gate.release = release;
  return gate;
}

for (const user of [USERS.admin, USERS.bartender]) {
  test(`${user.role}: sign-in reads movements, items and verified stock together, and the count snapshot once`, { skip }, async () => {
    const world = stockWorld(user);
    world.backend.waitForOthers = true;
    const { page, record, close } = await launchAtlas({ user, fixtures: world.fixtures, fixedTime: NOW });
    try {
      await settle(page);
      // L17: the first movements read saw the item and snapshot reads start.
      assert.deepEqual(world.reads.overlap.slice(0, 1), [true], 'items and verified stock load while movements load');
      const health = await page.evaluate(() => window.AtlasData.health());
      assert.deepEqual([health.inventory, health.balances, health.movements, health.stock], ['ok', 'ok', 'ok', 'ok']);
      const tanq = await page.evaluate(() => window.AtlasData.items().find((item) => item.id === 'tanq')?.quantity);
      assert.equal(tanq, 3);

      // L24: one snapshot read at sign-in; the workspace has it without a read of its own.
      assert.equal(requestsTo(record, 'atlas-stock-counts', 'snapshot').length, 1);
      assert.equal(world.reads.snapshot, 1);
      const adopted = await page.evaluate(() => Boolean(window.AtlasStockCounts.snapshot()?.verified_balances));
      assert.equal(adopted, true, 'the stock-count workspace adopted the shell read');

      // Opening Counts still refreshes the snapshot (explicit refreshes stay forced).
      await navigateTo(page, '#inventory/counts');
      await until(() => requestsTo(record, 'atlas-stock-counts', 'snapshot').length === 2, { message: 'the Counts refresh' });
      assert.deepEqual(record.pageErrors, []);
    } finally {
      await close();
    }
  });
}

test('a reload asked for during a reload never ends on the older movements (single flight)', { skip }, async () => {
  const world = stockWorld(USERS.admin);
  const { page, record, close } = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures, fixedTime: NOW });
  try {
    await settle(page);
    assert.equal(await page.evaluate(() => window.AtlasData.items().find((item) => item.id === 'tanq').quantity), 3);

    // Reload 1 reads the movements before a delivery is booked and is held there.
    const gate = deferred();
    world.backend.gate = gate;
    const itemReadsBefore = world.reads.items;
    await page.evaluate(() => { window.__reload1 = window.atlasReloadPurchasingData(); });
    await until(() => gate.arrived, { message: 'reload 1 movements read' });

    // A delivery of 6 Tanqueray is saved, and the page asks for fresh data.
    world.backend.movements = [{ id: 'mv-delivery', item_id: 'tanq', item_name: 'Tanqueray London Dry', movement_type: 'restock', quantity_change: 6, created_at: '2026-09-24T16:00:00Z' }];
    await page.evaluate(() => { window.__reload2 = window.atlasReloadPurchasingData(); });
    // With overlapping loads, reload 2 reads past its movements at once; a
    // single-flight shell holds it until reload 1 ends, so this wait ends at its bound.
    await until(() => world.reads.items > itemReadsBefore + 1, { timeout: 1500, message: 'reload 2 item read' }).catch(() => null);

    gate.release();
    await page.evaluate(() => Promise.all([window.__reload1, window.__reload2]));
    await settle(page);
    const after = await page.evaluate(() => ({
      movements: window.AtlasData.movements().map((entry) => entry.id),
      tanq: window.AtlasData.items().find((item) => item.id === 'tanq').quantity,
      stock: window.AtlasData.health().stock
    }));
    assert.deepEqual(after, { movements: ['mv-delivery'], tanq: 9, stock: 'ok' });
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

test('Start count: a retry after a lost answer sends the same request id; a new sheet gets a new one', { skip }, async () => {
  const counts = countBackend({ empty: true });
  let lostAnswers = 1;
  const handler = (entry) => {
    // The first start commits on the server but its answer is lost at the gateway.
    if (entry.action === 'start' && lostAnswers > 0) { lostAnswers -= 1; return { __status: 504, body: { error: 'upstream timed out' } }; }
    return counts.handler(entry);
  };
  const world = inventoryWorld({ counts, functions: { 'atlas-stock-counts': handler } });
  const { page, record, close } = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures });
  try {
    await navigateTo(page, '#inventory');
    await page.click('[data-inv-count]');
    await page.waitForSelector('#sc-start-form');
    await page.click('[data-sc-start-submit]');
    await page.waitForSelector('[data-sc-start-alert] .atlas-alert');
    await page.click('[data-sc-start-submit]');
    await page.waitForFunction(() => /#inventory\/counts\//.test(location.hash));
    await settle(page);
    const starts = requestsTo(record, 'atlas-stock-counts', 'start');
    assert.equal(starts.length, 2);
    assert.ok(starts[0].body.client_request_id);
    assert.equal(starts[1].body.client_request_id, starts[0].body.client_request_id, 'the retry replays the same start');

    // A new sheet is a new request.
    await navigateTo(page, '#inventory');
    await page.click('[data-inv-count]');
    await page.waitForSelector('#sc-start-form');
    await page.click('[data-sc-start-submit]');
    await until(() => requestsTo(record, 'atlas-stock-counts', 'start').length === 3, { message: 'the third start' });
    const third = requestsTo(record, 'atlas-stock-counts', 'start')[2];
    assert.notEqual(third.body.client_request_id, starts[0].body.client_request_id);
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

test('Start count: changing what is started after a failure is a new request', { skip }, async () => {
  const counts = countBackend({ empty: true });
  let lostAnswers = 1;
  const handler = (entry) => {
    if (entry.action === 'start' && lostAnswers > 0) { lostAnswers -= 1; return { __status: 504, body: { error: 'upstream timed out' } }; }
    return counts.handler(entry);
  };
  const world = inventoryWorld({ counts, functions: { 'atlas-stock-counts': handler } });
  const { page, record, close } = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures });
  try {
    await navigateTo(page, '#inventory');
    await page.click('[data-inv-count]');
    await page.waitForSelector('#sc-start-form');
    await page.click('[data-sc-start-submit]');
    await page.waitForSelector('[data-sc-start-alert] .atlas-alert');
    await page.click('label.sc-area:has(input[value^="category::"]) input');
    await page.click('[data-sc-start-submit]');
    await until(() => requestsTo(record, 'atlas-stock-counts', 'start').length === 2, { message: 'the second start' });
    const [first, second] = requestsTo(record, 'atlas-stock-counts', 'start');
    assert.equal(first.body.scope_type, 'all');
    assert.equal(second.body.scope_type, 'category');
    assert.notEqual(second.body.client_request_id, first.body.client_request_id);
  } finally {
    await close();
  }
});
