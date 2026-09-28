// S97: managed Storage Locations in Inventory — list column/filter, the item
// detail picker, the Manage Locations page, role gating, and stock-count
// scoping by PRIMARY location (single canonical count), in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, USERS } from './harness.mjs';
import { IDS, LOCATION_IDS, inventoryWorld, locationBackend, countBackend, itemMasterBackend } from './inventory-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ user = USERS.admin, viewport, hash = '', counts } = {}) {
  const locations = locationBackend();
  const world = inventoryWorld({ locations, ...(counts ? { counts } : {}), itemMaster: itemMasterBackend().handler });
  const app = await launchAtlas({ user, fixtures: world.fixtures, viewport, hash });
  return { ...app, world, locations };
}

const rowNames = (page) => page.$$eval('#inventory-view tbody tr[data-inv-row] .cell-primary', (cells) => cells.map((c) => c.textContent));

test('the list shows the primary location as a chip and filters by it', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await navigateTo(page, '#inventory');
    // Campari is stored in B03 (primary) and S03 → its row shows the primary code and a +1.
    const campariCell = await page.$eval(`tr[data-inv-row="${IDS.campari}"]`, (row) => row.textContent);
    assert.match(campariCell, /B03/);
    assert.match(campariCell, /\+1/);
    // Filter by Backbar display shelves (B03): only the two items stored there.
    await page.click('[data-inv-menu-trigger="location"]');
    await page.click(`[data-inv-menu="location"] [data-value="${LOCATION_IDS.B03}"]`);
    await settle(page);
    const inB03 = await rowNames(page);
    assert.ok(inB03.includes('Campari') && inB03.includes('Tanqueray London Dry'), 'B03 lists its items');
    assert.ok(!inB03.includes('Limes'), 'items not in B03 are hidden');
    // Clear, then the "No location assigned" filter shows only unassigned items.
    await page.click('[data-inv-clear="location"]');
    await settle(page);
    await page.click('[data-inv-menu-trigger="location"]');
    await page.click('[data-inv-menu="location"] [data-value="__none__"]');
    await settle(page);
    const none = await rowNames(page);
    assert.ok(none.includes('Limes') && !none.includes('Campari'), 'no-location filter excludes assigned items');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('the item detail shows storage chips and a manager saves through the RPC', { skip }, async () => {
  const { page, world, close } = await launch();
  try {
    await navigateTo(page, `#inventory/item/${IDS.campari}`);
    await page.waitForSelector('[data-inv-detail-locations]');
    const section = await page.$eval('[data-inv-detail-locations]', (el) => el.textContent);
    assert.match(section, /B03/);
    assert.match(section, /Primary/);
    assert.match(section, /S03/);
    // Open the picker, add F01 and make it primary, then save.
    await page.click('[data-inv-edit-locations]');
    await page.waitForSelector('#inv-location-picker');
    await page.click(`[data-loc-toggle="${LOCATION_IDS.F01}"]`);
    await page.click(`[data-loc-primary="${LOCATION_IDS.F01}"]`);
    await page.click('.atlas-sheet [data-inv-submit]');
    await page.waitForFunction(() => !document.querySelector('#inv-location-picker'));
    const call = world.locations.calls.find((c) => c.name === 'item_locations_set');
    assert.ok(call, 'the picker saved through atlas_inventory_item_locations_set');
    assert.equal(call.body.p_item_id, IDS.campari);
    assert.equal(call.body.p_primary_id, LOCATION_IDS.F01, 'the chosen primary is sent');
    assert.deepEqual([...call.body.p_location_ids].sort(), [LOCATION_IDS.B03, LOCATION_IDS.S03, LOCATION_IDS.F01].sort());
  } finally { await close(); }
});

test('the Manage Locations page creates a location through the RPC (manager)', { skip }, async () => {
  const { page, world, close } = await launch();
  try {
    await navigateTo(page, '#inventory/locations');
    await page.waitForSelector('[data-inv-location-row]');
    const rows = await page.$$eval('[data-inv-location-row]', (els) => els.length);
    assert.equal(rows, 16, 'the 16 seeded locations are listed');
    await page.click('[data-inv-location-new]');
    await page.waitForSelector('#inv-location-form');
    await page.fill('#inv-loc-code', 'X09');
    await page.fill('#inv-loc-name', 'Cellar overflow');
    await page.click('.atlas-sheet [data-inv-submit]');
    await page.waitForFunction(() => !document.querySelector('#inv-location-form'));
    const call = world.locations.calls.find((c) => c.name === 'location_save');
    assert.ok(call, 'create went through atlas_inventory_location_save');
    assert.equal(call.body.p_id, null, 'a create sends a null id');
    assert.equal(call.body.p_code, 'X09');
    assert.equal(call.body.p_name, 'Cellar overflow');
  } finally { await close(); }
});

test('archiving a location goes through set_active, never a table write', { skip }, async () => {
  const { page, world, record, close } = await launch();
  try {
    await navigateTo(page, '#inventory/locations');
    await page.waitForSelector('[data-inv-location-row]');
    await page.click(`[data-inv-location-row="${LOCATION_IDS.D04}"] [data-inv-location-archive]`);
    await page.waitForSelector('.atlas-dialog [data-confirm]');
    await page.click('.atlas-dialog [data-confirm]');
    await page.waitForFunction(() => !document.querySelector('.atlas-dialog [data-confirm]'));
    const call = world.locations.calls.find((c) => c.name === 'location_set_active');
    assert.ok(call && call.body.p_active === false, 'archive sets active=false');
    const directWrites = record.requests.filter((e) => /\/rest\/v1\/inventory_locations/.test(e.path) && e.method !== 'GET');
    assert.deepEqual(directWrites, [], 'no direct table writes');
  } finally { await close(); }
});

test('staff can read locations but cannot manage them', { skip }, async () => {
  const { page, close } = await launch({ user: USERS.bartender });
  try {
    await navigateTo(page, '#inventory');
    // The location column still reads for staff.
    const campariCell = await page.$eval(`tr[data-inv-row="${IDS.campari}"]`, (row) => row.textContent);
    assert.match(campariCell, /B03/);
    // The Locations tab is manager-only.
    assert.equal(await page.$('[data-inv-tab="locations"]'), null, 'no Locations tab for staff');
    // The detail has no edit-locations control for staff.
    await navigateTo(page, `#inventory/item/${IDS.campari}`);
    await page.waitForSelector('[data-inv-detail-locations]');
    assert.equal(await page.$('[data-inv-edit-locations]'), null, 'staff cannot edit locations');
    // The management route falls back to the manager-only message.
    await navigateTo(page, '#inventory/locations');
    await settle(page);
    assert.match(await page.$eval('#inventory-view', (el) => el.textContent), /for managers/);
    assert.equal(await page.$('[data-inv-location-new]'), null);
  } finally { await close(); }
});

test('a stock count scoped to a location counts each item once (primary only)', { skip }, async () => {
  const { page, close } = await launch({ counts: countBackend({ empty: true }) });
  try {
    await navigateTo(page, '#inventory');
    await page.click('[data-inv-count]');
    await page.waitForSelector('#sc-start-form');
    // Backbar display shelves is the primary location of exactly two items.
    const area = await page.$eval('label.sc-area:has-text("Backbar display shelves") .sc-area__meta', (el) => el.textContent);
    assert.match(area, /2 items/);
    await page.click('label.sc-area:has-text("Backbar display shelves") input');
    await page.click('[data-sc-start-submit]');
    await page.waitForFunction(() => /#inventory\/counts\//.test(location.hash));
    await settle(page);
    // The focus set is the two primary-location items — each appears once.
    assert.match(await page.$eval('#inventory-view', (el) => el.textContent), /2 selected items/);
  } finally { await close(); }
});
