// S109 in-app booking notifications (bookings-notifications.js) in the real
// shell. Proves the ACTUAL end-to-end flow, not just that queue rows exist:
//   * a manager's server-side booking inbox (atlas-bookings ?action=notifications)
//     surfaces in the app-wide notification bell with an unread count, WITHOUT
//     web-push (nothing subscribes to push here);
//   * clicking the item navigates to the exact reservation (#bookings/res/<id>)
//     and marks it read server-side (?action=notifications-read);
//   * "mark all read" persists to the server too;
//   * a bartender gets nothing (the inbox is manager/admin only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, until, USERS } from './harness.mjs';
import { bookingsWorld, TODAY } from './bookings-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

function world(extra = {}) {
  // One unread request, linked to a reservation that exists on today's floor so
  // the click can open it.
  return bookingsWorld({
    notifications: [{ id: 'note-req-1', reservation_id: 'res-erla', kind: 'request', title: 'New booking request', body: 'Erla Guðrún · party of 2', read: false }],
    ...extra
  });
}

async function boot({ user = USERS.admin } = {}) {
  const w = world();
  const app = await launchAtlas({ user, fixtures: w.fixtures });
  // The notifications worker loads after window load, then fetches the inbox.
  await app.page.waitForFunction(() => window.AtlasBookingsNotifications?.loaded?.() === true, null, { timeout: 15000 });
  await settle(app.page);
  return { ...app, bookings: w.bookings };
}

test('a manager sees the booking inbox in the bell, with an unread count, without push', { skip }, async () => {
  const { page, bookings, record, close } = await boot();
  try {
    // The worker fetched the server inbox (not a push subscription).
    assert.ok(bookings.calls.some((c) => c.action === 'notifications'), 'the inbox was fetched from the edge');
    assert.equal(await page.evaluate(() => window.AtlasBookingsNotifications.count()), 1);

    // The bell shows the unread dot and the booking item.
    await page.waitForFunction(() => !document.querySelector('#atlas-notifications-btn .dot').hidden);
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    const titles = await page.$$eval('.atlas-notify__item-title', (nodes) => nodes.map((n) => n.textContent));
    assert.ok(titles.some((t) => t.includes('New booking request')), 'the booking request shows in the bell');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('clicking the booking notification opens the reservation and marks it read on the server', { skip }, async () => {
  const { page, bookings, close } = await boot();
  try {
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    await page.click('[data-notify-open="booking:note-req-1"]');
    // Deep link opens the Bookings day and focuses the reservation.
    await page.waitForFunction(() => location.hash.startsWith('#bookings/res/res-erla'));
    await until(() => bookings.callsFor('notifications-read').some((c) => Array.isArray(c.body?.ids) && c.body.ids.includes('note-req-1')),
      { message: 'server mark-read for the clicked notification' });
    assert.equal(bookings.inbox.find((n) => n.id === 'note-req-1').read, true, 'the row is read server-side');
  } finally { await close(); }
});

test('mark-all-read persists to the server for bookings too', { skip }, async () => {
  const { page, bookings, close } = await boot();
  try {
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    await page.click('[data-notify-more]');
    await page.click('[data-notify-action="read-all"]');
    await until(() => bookings.callsFor('notifications-read').some((c) => c.body?.all === true),
      { message: 'server mark-all-read' });
  } finally { await close(); }
});

test('a bartender never receives booking notifications (manager/admin only)', { skip }, async () => {
  const w = world();
  const app = await launchAtlas({ user: USERS.bartender, fixtures: w.fixtures });
  try {
    // The worker tries once, is refused (403), and stays silent.
    await until(() => app.page.evaluate(() => Boolean(window.AtlasBookingsNotifications)), { message: 'worker present' });
    await settle(app.page);
    assert.equal(await app.page.evaluate(() => window.AtlasBookingsNotifications.count()), 0);
    const bookingItems = await app.page.evaluate(() => window.AtlasShell.notify.items().filter((i) => i.type === 'booking').length);
    assert.equal(bookingItems, 0, 'no booking items for a bartender');
    assert.ok(w.bookings.calls.some((c) => c.action === 'notifications'), 'the worker attempted a fetch');
  } finally { await app.close(); }
});
