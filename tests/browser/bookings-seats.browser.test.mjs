// Alcedo Bookings (S110) — choosing and moving multi-stool seat groups in the
// staff workspace, against the KANEL Bar: 16 one-seat stools in sections A 1–8,
// B 9–12, C 13–16, with a party of 2 on Bar 3 + Bar 4 from 16:00 to 18:00.
//
// Asserts what the UI SENT (bookingsBackend calls) and what it SHOWED: the
// time-aware picker (Bar 3+4 taken for 18:00, free again at 18:15 — the
// 15-minute gap), parties 1–4, insufficient seats, crossing sections and gaps
// refused before any request, auto-assign still the default, a server refusal
// shown in the sheet, and keyboard + phone operation. The server stays
// authoritative (tests/sql/s110_booking_seat_integrity.sql).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { bookingsWorld, kanelRoom, TODAY } from './bookings-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ user = USERS.admin, viewport, hasTouch = false } = {}) {
  const world = bookingsWorld({ room: kanelRoom() });
  const app = await launchAtlas({
    user, fixtures: world.fixtures, viewport,
    timezoneId: 'Atlantic/Reykjavik',
    contextOptions: hasTouch ? { hasTouch: true } : {}
  });
  return { ...app, world, bookings: world.bookings };
}

async function openAdd(page, { party = 2, time = '18:15', date = TODAY, choose = true } = {}) {
  await navigateTo(page, '#bookings');
  await page.waitForSelector('[data-bookings-add]');
  await page.click('[data-bookings-add]');
  await page.waitForSelector('[data-bookings-create-form]');
  await page.fill('#bk-add-party', String(party));
  await page.fill('#bk-add-date', date);
  await page.fill('#bk-add-time', time);
  await page.fill('#bk-add-name', 'A4 TEST 2');
  if (choose) await page.check('#bk-seat-mode-choose');
  await settle(page);
}

const seat = (n) => `[data-bookings-seats] [data-bookings-seat="bar-${n}"]`;
const seatState = (page, n) => page.textContent(`[data-bookings-seats] label[for="bk-add-seat-bar-${n}"] .bk-seat__state`);
const seatError = (page) => page.textContent('[data-bookings-seats] [data-error-for="seats"]');

test('seat picker is time-aware: Bar 3+4 are taken at 18:00 (15-minute gap) and free again at 18:15', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await openAdd(page, { time: '18:00' });
    assert.equal(await page.isDisabled(seat(3)), true, 'Bar 3 is not offered at 18:00');
    assert.equal(await page.isDisabled(seat(4)), true, 'Bar 4 is not offered at 18:00');
    assert.match(await seatState(page, 3), /Taken 16:00–18:00/);
    assert.equal(await page.isDisabled(seat(5)), false, 'Bar 5 is free');

    await page.fill('#bk-add-time', '18:15');
    await settle(page);
    assert.equal(await page.isDisabled(seat(3)), false, 'Bar 3 is free again at 18:15');
    assert.equal((await seatState(page, 3)).trim(), 'Free');
    await page.check(seat(3));
    await page.check(seat(4));
    await page.click('[data-bookings-create-submit]');
    await until(() => bookings.callsFor('create').length > 0, { message: 'create' });
    const created = bookings.callsFor('create')[0].body;
    assert.deepEqual(created.table_ids, ['bar-3', 'bar-4']);
    assert.equal(created.party_size, 2);
    assert.equal(created.start_at, `${TODAY}T18:15:00.000Z`);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('parties 1–4: the chosen adjacent group is sent; too few seats is refused before any request', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    // Each party at its own time (2 h visit + 15 min gap apart), Bar 9 upwards.
    const times = { 1: '10:00', 2: '12:30', 3: '15:00', 4: '20:30' };
    for (const party of [1, 2, 3, 4]) {
      await openAdd(page, { party, time: times[party] });
      // One seat too few first: refused in the sheet, nothing sent.
      for (let n = 9; n < 9 + party - 1; n += 1) await page.check(seat(n));
      const before = bookings.callsFor('create').length;
      await page.click('[data-bookings-create-submit]');
      await settle(page);
      if (party > 1) {
        assert.match(await seatError(page), new RegExp(`Choose seats for ${party} guests`), `party ${party}: too few seats`);
        assert.equal(bookings.callsFor('create').length, before, `party ${party}: nothing sent`);
      }
      if (party > 1) await page.check(seat(9 + party - 1));
      else await page.check(seat(9));
      await page.click('[data-bookings-create-submit]');
      await until(() => bookings.callsFor('create').length === before + 1, { message: `create party ${party}` });
      const sent = bookings.callsFor('create').at(-1).body;
      assert.deepEqual(sent.table_ids, Array.from({ length: party }, (_, i) => `bar-${9 + i}`), `party ${party} seats`);
      assert.equal(sent.party_size, party);
      await until(async () => (await page.$('[data-bookings-create-form]')) === null, { message: 'sheet closes' });
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('crossing sections (Bar 8 + Bar 9) and gaps (Bar 1 + Bar 3) are refused with a clear message; nothing is sent', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await openAdd(page, { time: '20:30' });
    await page.check(seat(8));
    await page.check(seat(9));
    await page.click('[data-bookings-create-submit]');
    await settle(page);
    assert.match(await seatError(page), /Bar 8 and Bar 9 are in different sections/);
    assert.equal(bookings.callsFor('create').length, 0);
    // Focus goes back to the seats so the choice can be corrected.
    assert.ok(await page.evaluate(() => document.activeElement?.hasAttribute('data-bookings-seat')), 'focus returns to the seats');

    await page.uncheck(seat(8));
    await page.uncheck(seat(9));
    await page.check(seat(1));
    await page.check(seat(3));
    await page.click('[data-bookings-create-submit]');
    await settle(page);
    assert.match(await seatError(page), /next to each other, with no gaps/);
    assert.equal(bookings.callsFor('create').length, 0);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('auto-assign stays the default and sends no seats; seats can only be chosen for the open day', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await openAdd(page, { time: '20:30', choose: false });
    assert.equal(await page.isChecked('#bk-seat-mode-auto'), true, 'auto-assign is the default');
    assert.equal(await page.isHidden('[data-bookings-seats] [data-bookings-seat-picker]'), true);
    await page.click('[data-bookings-create-submit]');
    await until(() => bookings.callsFor('create').length > 0, { message: 'create' });
    assert.equal(bookings.callsFor('create')[0].body.table_ids, undefined, 'auto-assign sends no seats');

    await page.click('[data-bookings-add]');
    await page.waitForSelector('[data-bookings-create-form]');
    await page.fill('#bk-add-date', '2026-12-31');
    await page.fill('#bk-add-time', '20:00');
    await page.fill('#bk-add-name', 'A4 TEST OTHER DAY');
    await page.check('#bk-seat-mode-choose');
    await settle(page);
    assert.match(await page.textContent('[data-bookings-seats] [data-bookings-seat-note]'), /Seats can be chosen for the day that’s open/);
    assert.equal(await page.isHidden('[data-bookings-seats] [data-bookings-seat-picker]'), true, 'no stale availability for another day');
    const before = bookings.callsFor('create').length;
    await page.click('[data-bookings-create-submit]');
    await settle(page);
    assert.equal(bookings.callsFor('create').length, before, 'manual seat selection on another day must never auto-assign');
    assert.match(await seatError(page), /Open 2026-12-31 in Bookings first/, 'show actionable date message');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('move: the current seats are pre-ticked; Bar 5 + Bar 6 is saved, Bar 8 + Bar 9 is refused before any request', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.click('[data-bookings-table="bar-3"]');
    await page.waitForSelector('[data-bookings-move-seats]');
    const move = (n) => `[data-bookings-move-seats] [data-bookings-seat="bar-${n}"]`;
    assert.equal(await page.isChecked(move(3)), true);
    assert.equal(await page.isChecked(move(4)), true);
    assert.equal(await page.isDisabled(move(3)), false, 'its own seats stay selectable');

    await page.uncheck(move(3));
    await page.uncheck(move(4));
    await page.check(move(8));
    await page.check(move(9));
    await page.click('[data-bookings-assign]');
    await settle(page);
    assert.match(await page.textContent('[data-bookings-move-seats] [data-bookings-seat-error]'), /different sections/);
    assert.equal(bookings.callsFor('assign').length, 0);

    await page.uncheck(move(8));
    await page.uncheck(move(9));
    await page.check(move(5));
    await page.check(move(6));
    await page.click('[data-bookings-assign]');
    await until(() => bookings.callsFor('assign').length > 0, { message: 'assign' });
    assert.deepEqual(bookings.callsFor('assign')[0].body, { reservation_id: 'res-b1', table_ids: ['bar-5', 'bar-6'] });
    assert.deepEqual(bookings.allocations.get('res-b1'), ['bar-5', 'bar-6']);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('move: a server refusal (seat taken meanwhile) is explained in the sheet, which stays open', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.click('[data-bookings-table="bar-3"]');
    await page.waitForSelector('[data-bookings-move-seats]');
    bookings.rejectNext.assign = { status: 409, error_code: 'conflict' };
    await page.uncheck('[data-bookings-move-seats] [data-bookings-seat="bar-3"]');
    await page.uncheck('[data-bookings-move-seats] [data-bookings-seat="bar-4"]');
    await page.check('[data-bookings-move-seats] [data-bookings-seat="bar-10"]');
    await page.check('[data-bookings-move-seats] [data-bookings-seat="bar-11"]');
    await page.click('[data-bookings-assign]');
    await until(async () => /15-minute gap/.test(await page.textContent('[data-bookings-move-seats] [data-bookings-seat-error]') || ''),
      { message: 'conflict message shown' });
    assert.ok(await page.$('[data-bookings-move-seats]'), 'the sheet stays open');
    assert.deepEqual(bookings.allocations.get('res-b1'), ['bar-3', 'bar-4'], 'nothing changed');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('keyboard: seats are reachable with Tab and toggled with Space; the bartender (authorised staff) can choose seats', { skip }, async () => {
  const { page, record, bookings, close } = await launch({ user: USERS.bartender });
  try {
    await openAdd(page, { time: '20:30' });
    await page.focus(seat(5));
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-bookings-seat')), 'bar-6');
    await page.keyboard.press('Space');
    assert.equal(await page.isChecked(seat(5)), true);
    assert.equal(await page.isChecked(seat(6)), true);
    await page.click('[data-bookings-create-submit]');
    await until(() => bookings.callsFor('create').length > 0, { message: 'create' });
    assert.deepEqual(bookings.callsFor('create')[0].body.table_ids, ['bar-5', 'bar-6']);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('phone 390: seat targets are at least 44 px and the sheet has no sideways scroll', { skip }, async () => {
  const { page, record, close } = await launch({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await openAdd(page, { time: '20:30' });
    const sizes = await page.$$eval('[data-bookings-seats] .bk-seat', (nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.equal(sizes.length, 16);
    assert.ok(sizes.every((height) => height >= 44), `seat targets ${Math.min(...sizes)}px >= 44`);
    const overflow = await page.evaluate(() => {
      const sheet = document.querySelector('[data-bookings-create-form]');
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, sheet.scrollWidth - sheet.clientWidth);
    });
    assert.ok(overflow <= 1, `no sideways scroll (${overflow}px)`);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
