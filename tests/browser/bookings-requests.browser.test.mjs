// Website booking requests reach staff with their details (S110b + workspace).
// A web request has no seats until staff confirm it, and is usually for another
// day. Before the fix the notification opened TODAY, found nothing, and the held
// stool only said "Booked" — staff never saw the guest's name, time or contact.
//   * the notification opens the request's own day and its detail sheet;
//   * that day lists the request under "Requests waiting" with name, time,
//     party, phone and email; the held stool reads "Requested" and opens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, USERS, fixtureTime } from './harness.mjs';
import { bookingsWorld, kanelRoom } from './bookings-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const ENABLE = { BOOKING_NOTIFICATIONS_ENABLED: true };
const DAY = fixtureTime(3 * 86400000).slice(0, 10); // three days ahead
const START = `${DAY}T16:00:00.000Z`;
const END = `${DAY}T18:00:00.000Z`;

function world() {
  const room = kanelRoom();
  room.reservations.push({
    id: 'res-web', source: 'web', status: 'requested', start_at: START, end_at: END, party_size: 2,
    area_id: 'area-bar', guest_name: 'Web Test Guest', guest_phone: '+354 555 0123', guest_email: 'web.test@example.invalid',
    guest_requests: 'Birthday, window if possible', staff_notes: '', booking_reference: 'KA-WEB01', table_ids: []
  });
  room.holds = [
    { id: 'hold-1', table_id: 'bar-9', start_at: START, end_at: END },
    { id: 'hold-2', table_id: 'bar-10', start_at: START, end_at: END }
  ];
  return bookingsWorld({
    room,
    notifications: [{ id: 'note-web', reservation_id: 'res-web', kind: 'request', title: 'New booking request', body: 'Web Test Guest · party of 2', read: false }]
  });
}

async function boot() {
  const w = world();
  const app = await launchAtlas({ user: USERS.admin, fixtures: w.fixtures, configOverrides: ENABLE });
  await app.page.waitForFunction(() => window.AtlasBookingsNotifications?.loaded?.() === true, null, { timeout: 15000 });
  await settle(app.page);
  return { ...app, bookings: w.bookings };
}

test('a booking notification opens the request on its own day with the guest details', { skip }, async () => {
  const { page, record, close } = await boot();
  try {
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    await page.click('[data-notify-open="booking:note-web"]');
    await page.waitForFunction((day) => location.hash === `#bookings/res/res-web/${day}`, DAY);
    await page.waitForSelector('#bk-detail-title', { state: 'visible' });
    const sheet = await page.textContent('.bk-detail');
    for (const want of ['Web Test Guest', '+354 555 0123', 'web.test@example.invalid', 'Birthday, window if possible', 'KA-WEB01', 'Not yet confirmed']) {
      assert.ok(sheet.includes(want), `detail shows ${want}`);
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('the request is listed under Requests waiting and its held stools say Requested', { skip }, async () => {
  const { page, record, close } = await boot();
  try {
    await page.evaluate((day) => { location.hash = `#bookings/${day}`; }, DAY);
    await page.waitForSelector('[data-bookings-requests]', { state: 'visible' });
    const panel = await page.textContent('[data-bookings-requests]');
    for (const want of ['Requests waiting', 'Web Test Guest', '2 guests', '+354 555 0123', 'web.test@example.invalid', 'Website']) {
      assert.ok(panel.includes(want), `request row shows ${want}`);
    }
    const held = await page.textContent('[data-bookings-table="bar-9"]');
    assert.ok(held.includes('Requested') && held.includes('Web Test Guest'), `held stool names the request: ${held}`);
    assert.ok(!held.includes('Booked'), 'a held stool is not shown as an anonymous booking');

    await page.click('[data-bookings-table="bar-9"]');
    await page.waitForSelector('#bk-detail-title', { state: 'visible' });
    assert.equal((await page.textContent('#bk-detail-title')).trim(), 'Web Test Guest');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a deep link to a booking that is not on the open day says so', { skip }, async () => {
  const { page, close } = await boot();
  try {
    await page.evaluate(() => { location.hash = '#bookings/res/res-web'; });
    await page.waitForFunction(() => /isn’t on this day/.test(document.body.textContent || ''), null, { timeout: 15000 });
  } finally { await close(); }
});
