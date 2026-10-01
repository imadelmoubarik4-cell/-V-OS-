// Alcedo Bookings (S99) in a real browser: the staff day view (floor plan +
// list with table labels and text status), adding a phone booking, assigning /
// moving a table, the status lifecycle, manager configuration, role gating for
// the configuration section, the phone layout and keyboard operability.
//
// Drives the frontend through its documented data-* hooks and asserts what the
// UI sent through the stateful atlas-bookings mock (bookingsBackend `calls`) and
// what the backend now holds. Every test keeps record.pageErrors empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { bookingsWorld, TODAY } from './bookings-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ user = USERS.admin, viewport, hash = '', hasTouch = false } = {}) {
  const world = bookingsWorld();
  const app = await launchAtlas({
    user, fixtures: world.fixtures, viewport, hash,
    timezoneId: 'Atlantic/Reykjavik',
    contextOptions: hasTouch ? { hasTouch: true } : {}
  });
  return { ...app, world, bookings: world.bookings };
}

// ---------- 1. staff day view: floor plan + list ----------

test('a staff member opens the day and sees the floor plan and the list with table labels and text status', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-map]');

    // Floor plan: areas grouped, unique table labels, text status labels.
    const areas = await page.$$eval('[data-bookings-area]', (nodes) => nodes.map((node) => node.getAttribute('data-bookings-area')));
    assert.deepEqual(areas, ['area-bar', 'area-ocean'], 'areas grouped on the floor plan');
    const bar1 = await page.textContent('[data-bookings-table="tbl-bar-1"] .bk-table__label');
    assert.equal(bar1.trim(), 'Bar 1');
    // Text status, not colour alone (design §10).
    assert.equal((await page.textContent('[data-bookings-table="tbl-bar-1"] [data-bookings-status]')).trim(), 'Booked', 'Bar 1 has a confirmed booking');
    assert.equal((await page.textContent('[data-bookings-table="tbl-bar-2"] [data-bookings-status]')).trim(), 'Seated', 'Bar 2 is seated');
    assert.equal((await page.textContent('[data-bookings-table="tbl-bar-3"] [data-bookings-status]')).trim(), 'Free', 'Bar 3 is free');

    // List alternative conveys the same info with a text status pill.
    await page.click('[data-bookings-view="list"]');
    await page.waitForSelector('[data-bookings-list]');
    const rows = await page.$$eval('[data-bookings-list] [data-bookings-row]', (nodes) => nodes.map((node) => node.getAttribute('data-bookings-row')));
    assert.ok(rows.includes('tbl-bar-1') && rows.includes('tbl-long'), 'every table has a list row');
    assert.match(await page.textContent('[data-bookings-row="tbl-bar-2"]'), /Bar 2/);
    assert.match(await page.textContent('[data-bookings-row="tbl-bar-2"] .bk-row__status'), /Seated/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 2. add a phone booking ----------

test('a staff member adds a phone booking and it appears on the floor', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-add]');
    await page.click('[data-bookings-add]');
    await page.waitForSelector('[data-bookings-create-form]');

    await page.fill('#bk-add-party', '2');
    await page.fill('#bk-add-date', TODAY);
    await page.fill('#bk-add-time', '19:30');
    await page.selectOption('#bk-add-table', 'tbl-bar-3');
    await page.fill('#bk-add-name', 'Katrín');
    await page.fill('#bk-add-phone', '+354 555 2222');
    await page.click('[data-bookings-create-submit]');

    await until(() => bookings.callsFor('create').length > 0, { message: 'create' });
    const created = bookings.callsFor('create')[0];
    assert.equal(created.body.party_size, 2);
    assert.equal(created.body.source, 'phone');
    assert.deepEqual(created.body.table_ids, ['tbl-bar-3']);
    assert.equal(created.body.guest_name, 'Katrín');

    // The new booking auto-confirms (small party) and Bar 3 now reads Booked.
    await until(async () => (await page.textContent('[data-bookings-table="tbl-bar-3"] [data-bookings-status]')).trim() === 'Booked',
      { message: 'Bar 3 becomes Booked' });
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 3. assign / move a table ----------

test('a staff member moves a reservation to another table', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.click('[data-bookings-table="tbl-bar-1"]'); // Erla, confirmed on Bar 1
    await page.waitForSelector('[data-bookings-assign-select]');

    await page.selectOption('[data-bookings-assign-select]', 'tbl-bar-4');
    await page.click('[data-bookings-assign]');
    await until(() => bookings.callsFor('assign').length > 0, { message: 'assign' });

    const assign = bookings.callsFor('assign')[0];
    assert.equal(assign.body.reservation_id, 'res-erla');
    assert.deepEqual(assign.body.table_ids, ['tbl-bar-4']);
    assert.deepEqual(bookings.allocations.get('res-erla'), ['tbl-bar-4'], 'the allocation moved');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 4. status lifecycle ----------

test('a staff member advances a reservation through the status lifecycle', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.click('[data-bookings-table="tbl-bar-1"]'); // Erla, confirmed
    await page.waitForSelector('[data-bookings-status-btn][data-to-status="arrived"]');

    await page.click('[data-bookings-status-btn][data-to-status="arrived"]');
    await until(() => bookings.reservation('res-erla').status === 'arrived', { message: 'arrived' });
    // The sheet refreshes with the next allowed transition.
    await page.waitForSelector('[data-bookings-status-btn][data-to-status="seated"]');
    await page.click('[data-bookings-status-btn][data-to-status="seated"]');
    await until(() => bookings.reservation('res-erla').status === 'seated', { message: 'seated' });

    assert.deepEqual(bookings.callsFor('set-status').map((call) => call.body.to_status), ['arrived', 'seated']);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 5. manager configuration ----------

test('a manager configures a table and the booking rules', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings/config');
    await page.waitForSelector('[data-bookings-settings-form]');

    // Edit a table's seat capacity.
    await page.click('[data-bookings-edit-table="tbl-bar-1"]');
    await page.waitForSelector('[data-bookings-table-form]');
    await page.fill('#bk-table-cap', '3');
    await page.click('[data-bookings-table-save]');
    await until(() => bookings.callsFor('save-table').length > 0, { message: 'save-table' });
    const savedTable = bookings.callsFor('save-table')[0];
    assert.equal(savedTable.body.id, 'tbl-bar-1');
    assert.equal(savedTable.body.label, 'Bar 1');
    assert.equal(savedTable.body.seat_capacity, 3);
    assert.equal(bookings.table('tbl-bar-1').seat_capacity, 3, 'the backend now holds 3 seats');

    // Save the availability rules (optimistic version travels with the save).
    await page.waitForSelector('[data-bookings-settings-form]');
    await page.fill('#bk-set-approval_party_threshold', '6');
    await page.click('[data-bookings-settings-save]');
    await until(() => bookings.callsFor('save-settings').length > 0, { message: 'save-settings' });
    const savedSettings = bookings.callsFor('save-settings')[0];
    assert.equal(savedSettings.body.approval_party_threshold, 6);
    assert.equal(savedSettings.body.expected_version, 3, 'the current version is sent for optimistic concurrency');
    assert.equal(bookings.settings.approval_party_threshold, 6);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 6. role gating for configuration ----------

test('a bartender is denied the configuration section and sees no controls', { skip }, async () => {
  const { page, record, bookings, close } = await launch({ user: USERS.bartender });
  try {
    await navigateTo(page, '#bookings/config');
    await page.waitForSelector('[data-bookings-config-denied]');
    assert.equal(await page.$('[data-bookings-settings-form]'), null, 'no rules form');
    assert.equal(await page.$('[data-bookings-add-table]'), null, 'no add-table control');
    // A bartender never fetches the manager-only config payload.
    assert.equal(bookings.callsFor('config').length, 0, 'config is never requested');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 7. phone layout ----------

test('the phone layout (390) has no horizontal scroll and 44px touch targets', { skip }, async () => {
  const { page, record, close } = await launch({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-map]');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal scroll (overflow ${overflow}px)`);
    const tableHeight = await page.$eval('[data-bookings-table="tbl-bar-1"]', (node) => node.getBoundingClientRect().height);
    assert.ok(tableHeight >= 44, `table target ${tableHeight}px >= 44`);
    const toggleHeight = await page.$eval('[data-bookings-view="list"]', (node) => node.getBoundingClientRect().height);
    assert.ok(toggleHeight >= 44, `toggle target ${toggleHeight}px >= 44`);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 8. keyboard ----------

test('the map/list toggle and a table are keyboard reachable and operable', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-map]');

    // The list toggle is a real button: focus it and operate it with Enter.
    await page.focus('[data-bookings-view="list"]');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-bookings-view')), 'list');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-bookings-list]');

    // Back to the floor plan; a table is focusable and Enter opens it.
    await page.focus('[data-bookings-view="map"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-bookings-map]');
    await page.focus('[data-bookings-table="tbl-bar-3"]'); // a free table
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-bookings-table')), 'tbl-bar-3');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-bookings-create-form]', { timeout: 10000 });
    // Escape closes the sheet.
    await page.keyboard.press('Escape');
    await settle(page);
    assert.equal(await page.$('[data-bookings-create-form]'), null, 'Escape closes the sheet');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
