// Alcedo Bookings — staff workspace reliability (platform audit M4, M6, M7, M12):
//   * M4  "Add booking" sends one idempotency key per sheet, so a retry after a
//         lost response (504) replays the saved booking instead of a duplicate;
//   * M6  only the latest day snapshot lands when responses arrive out of order;
//   * M7  the entered time is venue (Reykjavik) time on a device set elsewhere;
//   * M12 a booking-notification deep link to today's date refetches the day
//         once before saying the booking isn't there, and the day reloads
//         quietly when returned to after a minute.
// Frozen clock, no fixed sleeps (tests/browser/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, fixtureTime, USERS } from './harness.mjs';
import { bookingsWorld, kanelRoom, TODAY } from './bookings-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

// Wraps the stateful mock. A create with an already-used idempotency key
// replays the saved booking like the production RPC (S110, replayed:true).
// hooks[action](ctx, run) may answer instead; run() is the default answer.
async function launch({ room, timezoneId = 'Atlantic/Reykjavik', hooks = {} } = {}) {
  const world = bookingsWorld(room ? { room } : {});
  const { bookings } = world;
  const byKey = new Map();
  const answer = (ctx) => {
    const key = ctx.method === 'POST' && ctx.action === 'create' ? ctx.body?.idempotency_key : null;
    if (key && byKey.has(key)) {
      bookings.calls.push({ method: ctx.method, action: ctx.action, body: ctx.body, search: ctx.search });
      return { reservation: bookings.reservationView(byKey.get(key)), replayed: true };
    }
    const result = bookings.handler(ctx);
    if (key && result?.reservation?.id) byKey.set(key, result.reservation.id);
    return result;
  };
  world.fixtures.functions['atlas-bookings'] = (ctx) => {
    const hook = hooks[ctx.action || ''];
    return hook ? hook(ctx, () => answer(ctx)) : answer(ctx);
  };
  const app = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures, timezoneId });
  // Record toasts in the page (they dismiss themselves).
  await app.page.evaluate(() => {
    window.__toasts = [];
    const shell = window.AtlasShell;
    const original = shell.toast;
    shell.toast = (message, options) => { window.__toasts.push(String(message)); return original.call(shell, message, options); };
  });
  return { ...app, world, bookings };
}

const toasts = (page) => page.evaluate(() => window.__toasts.slice());
const snapshotCalls = (bookings) => bookings.callsFor('snapshot');

async function openAdd(page, { party = 2, date = TODAY, time = '17:00', name = 'Retry Guest', choose = false } = {}) {
  await page.click('[data-bookings-add]');
  await page.waitForSelector('[data-bookings-create-form]');
  await page.fill('#bk-add-party', String(party));
  await page.fill('#bk-add-date', date);
  await page.fill('#bk-add-time', time);
  await page.fill('#bk-add-name', name);
  if (choose) await page.check('#bk-seat-mode-choose');
  await settle(page);
}

async function submitAndWaitForAnswer(page, bookings, count) {
  await page.click('[data-bookings-create-submit]');
  await until(() => bookings.callsFor('create').length === count, { message: `create #${count}` });
  await settle(page);
}

// ---------- M4: idempotent staff create ----------

test('M4: a retry after a lost create response reuses the sheet key and makes no second booking', { skip }, async () => {
  let lose = 1;
  const { page, record, bookings, close } = await launch({ hooks: {
    // The create commits, then its response is lost (gateway 504).
    create: (ctx, run) => {
      const result = run();
      if (lose > 0) { lose -= 1; return { __status: 504, body: { error_code: 'unavailable', message: 'Gateway timeout' } }; }
      return result;
    }
  } });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-add]');
    const before = bookings.reservations.size;

    await openAdd(page);
    await submitAndWaitForAnswer(page, bookings, 1);
    assert.ok(await page.isVisible('[data-bookings-create-form]'), 'the sheet stays open after the lost response');
    assert.equal(await page.isDisabled('[data-bookings-create-submit]'), false, 'Save is offered again');
    assert.equal(bookings.reservations.size, before + 1, 'the first attempt committed');

    await submitAndWaitForAnswer(page, bookings, 2);
    await page.waitForSelector('[data-bookings-create-form]', { state: 'detached' });
    const [first, retry] = bookings.callsFor('create').map((c) => c.body);
    assert.match(first.idempotency_key, /^staff:[0-9a-f-]{32,36}$/);
    assert.equal(retry.idempotency_key, first.idempotency_key, 'the retry carries the same key');
    assert.equal(bookings.reservations.size, before + 1, 'no duplicate booking');
    const said = (await toasts(page)).find((t) => /already saved/.test(t));
    assert.ok(said, 'staff are told the booking was already saved');
    assert.match(said, /17:00 · 2 guests/);
    assert.match(said, /No second booking was made/);

    // A new sheet gets a new key.
    await openAdd(page, { time: '21:00', name: 'Second Guest' });
    await submitAndWaitForAnswer(page, bookings, 3);
    assert.notEqual(bookings.callsFor('create')[2].body.idempotency_key, first.idempotency_key, 'a new sheet, a new key');
    assert.equal(bookings.reservations.size, before + 2);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('M4: changing the time after a failed save sends a fresh key (replay never returns a different booking)', { skip }, async () => {
  let lose = 1;
  const { page, bookings, close } = await launch({ hooks: {
    create: (ctx, run) => {
      const result = run();
      if (lose > 0) { lose -= 1; return { __status: 504, body: {} }; }
      return result;
    }
  } });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-add]');
    const before = bookings.reservations.size;
    await openAdd(page, { time: '17:00' });
    await submitAndWaitForAnswer(page, bookings, 1);
    await page.fill('#bk-add-time', '17:30');
    await submitAndWaitForAnswer(page, bookings, 2);
    const [first, second] = bookings.callsFor('create').map((c) => c.body);
    assert.notEqual(second.idempotency_key, first.idempotency_key);
    assert.equal(second.start_at, `${TODAY}T17:30:00.000Z`);
    assert.equal(bookings.reservations.size, before + 2, 'the edited booking is its own booking');
  } finally { await close(); }
});

// Review (M4): the key leaves the seats out, so a retry with other seats
// replays the booking with its first seats. Staff are told, not misled.
test('M4: a retry with a different seat choice says the saved seats were kept', { skip }, async () => {
  let lose = 1;
  const { page, record, bookings, close } = await launch({ room: kanelRoom(), hooks: {
    create: (ctx, run) => {
      const result = run();
      if (lose > 0) { lose -= 1; return { __status: 504, body: { error_code: 'unavailable' } }; }
      return result;
    }
  } });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-add]');
    const before = bookings.reservations.size;
    await openAdd(page, { time: '18:15', choose: true });
    const seat = (n) => `[data-bookings-seats] [data-bookings-seat="bar-${n}"]`;
    await page.check(seat(3));
    await page.check(seat(4));
    await submitAndWaitForAnswer(page, bookings, 1);
    const lost = (await toasts(page)).at(-1);
    assert.match(lost, /couldn’t confirm whether this was saved/, 'the lost answer is an unknown outcome (M5)');
    assert.doesNotMatch(lost, /Nothing was changed/);

    await page.uncheck(seat(3));
    await page.uncheck(seat(4));
    await page.check(seat(5));
    await page.check(seat(6));
    await submitAndWaitForAnswer(page, bookings, 2);
    await page.waitForSelector('[data-bookings-create-form]', { state: 'detached' });
    const [first, retry] = bookings.callsFor('create').map((c) => c.body);
    assert.equal(retry.idempotency_key, first.idempotency_key);
    assert.deepEqual(retry.table_ids, ['bar-5', 'bar-6']);
    assert.equal(bookings.reservations.size, before + 1, 'still one booking');
    const said = (await toasts(page)).find((t) => /already saved/.test(t));
    assert.match(said, /No second booking was made\. It is seated at Bar 3 \+ Bar 4; the new seat choice wasn’t applied\./);

    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- M6: out-of-order day snapshots ----------

test('M6: stepping days quickly shows the latest day even when an older answer arrives last', { skip }, async () => {
  const held = new Map();  // date -> release()
  let holding = false;
  const { page, record, bookings, close } = await launch({ hooks: {
    snapshot: (ctx, run) => {
      const date = new URLSearchParams(ctx.search || '').get('date');
      if (!holding) return run();
      return new Promise((resolve) => held.set(date, () => resolve(run())));
    }
  } });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-day-step="1"]');
    holding = true;
    const next = fixtureTime(86400000).slice(0, 10);
    const after = fixtureTime(2 * 86400000).slice(0, 10);
    await page.click('[data-bookings-day-step="1"]');
    await until(() => held.has(next), { message: `snapshot ${next} requested` });
    await page.click('[data-bookings-day-step="1"]');
    await until(() => held.has(after), { message: `snapshot ${after} requested` });

    held.get(after)();      // the newer day answers first…
    await page.waitForFunction((d) => window.AtlasBookings.snapshot()?.date === d, after);
    held.get(next)();       // …then the older one arrives late.
    await until(() => snapshotCalls(bookings).length >= 3, { message: 'both answers' });
    holding = false;
    await settle(page);

    assert.equal(await page.evaluate(() => window.AtlasBookings.snapshot().date), after, 'the late older answer is dropped');
    assert.equal(await page.locator('.bk [aria-busy="true"]').count(), 0, 'not left loading');
    assert.equal(await page.isVisible('[data-bookings-map]'), true);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- M7: venue time on a device in another zone ----------

test('M7: on a device set to Copenhagen, 20:00 is booked as 20:00 venue time', { skip }, async () => {
  const { page, record, bookings, close } = await launch({ timezoneId: 'Europe/Copenhagen' });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-add]');
    await openAdd(page, { date: '2026-11-05', time: '20:00' });
    await submitAndWaitForAnswer(page, bookings, 1);
    assert.equal(bookings.callsFor('create')[0].body.start_at, '2026-11-05T20:00:00.000Z');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('M7: the seat picker checks venue time too (Bar 3+4 free at 18:15 on a Copenhagen device)', { skip }, async () => {
  const { page, record, bookings, close } = await launch({ room: kanelRoom(), timezoneId: 'Europe/Copenhagen' });
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-add]');
    await openAdd(page, { time: '18:15', choose: true });
    const seat = (n) => `[data-bookings-seats] [data-bookings-seat="bar-${n}"]`;
    assert.equal(await page.isDisabled(seat(3)), false, 'Bar 3 is free from 18:15 venue time');
    await page.check(seat(3));
    await page.check(seat(4));
    await submitAndWaitForAnswer(page, bookings, 1);
    const created = bookings.callsFor('create')[0].body;
    assert.deepEqual(created.table_ids, ['bar-3', 'bar-4']);
    assert.equal(created.start_at, `${TODAY}T18:15:00.000Z`);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- M12: notification deep link to a cached day ----------

function addWebRequest(bookings, id) {
  bookings.reservations.set(id, {
    id, source: 'web', status: 'requested', start_at: `${TODAY}T20:00:00.000Z`, end_at: `${TODAY}T22:00:00.000Z`,
    party_size: 2, guest_name: 'Late Request', guest_phone: '', guest_email: '', guest_requests: '', staff_notes: '',
    booking_reference: 'ALC-2001'
  });
  bookings.allocations.set(id, []);
}

test('M12: opening a new request for the cached day refetches once and opens it, with no false toast', { skip }, async () => {
  const { page, record, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-map]');
    const loads = snapshotCalls(bookings).length;
    addWebRequest(bookings, 'res-late');   // arrives after the day was loaded

    await navigateTo(page, `#bookings/res/res-late/${TODAY}`);
    await page.waitForSelector('#bk-detail-layer');
    assert.equal(snapshotCalls(bookings).length, loads + 1, 'one quiet refetch');
    assert.match(await page.textContent('#bk-detail-layer'), /Late Request/);
    assert.ok(!(await toasts(page)).some((t) => /isn’t on this day/.test(t)), 'no false toast');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('M12: a booking that really is not on the day is still reported, after one refetch', { skip }, async () => {
  const { page, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-map]');
    const loads = snapshotCalls(bookings).length;
    await navigateTo(page, `#bookings/res/res-missing/${TODAY}`);
    await until(async () => (await toasts(page)).some((t) => /isn’t on this day/.test(t)), { message: 'not-on-this-day toast' });
    assert.equal(snapshotCalls(bookings).length, loads + 1);
    assert.equal(await page.locator('#bk-detail-layer').count(), 0);
  } finally { await close(); }
});

test('M12: returning to Bookings after a minute reloads the day quietly; sooner does not', { skip }, async () => {
  const { page, bookings, close } = await launch();
  try {
    await navigateTo(page, '#bookings');
    await page.waitForSelector('[data-bookings-map]');
    const loads = snapshotCalls(bookings).length;

    await navigateTo(page, '#home');
    await navigateTo(page, '#bookings');
    assert.equal(snapshotCalls(bookings).length, loads, 'a quick return uses the loaded day');

    addWebRequest(bookings, 'res-later');
    await navigateTo(page, '#home');
    await page.clock.setFixedTime(fixtureTime(61000));
    await navigateTo(page, '#bookings');
    await until(() => snapshotCalls(bookings).length === loads + 1, { message: 'stale reload' });
    await settle(page);
    assert.ok(await page.evaluate(() => window.AtlasBookings.snapshot().reservations.some((r) => r.id === 'res-later')));
  } finally { await close(); }
});
