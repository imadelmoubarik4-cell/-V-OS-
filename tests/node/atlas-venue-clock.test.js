// S88 AtlasVenueClock (apps/web/assets/js/atlas-venue-clock.js): operational
// time in the VENUE zone, never the browser's.
//
// This file forces the process ("browser") zone to America/New_York, and one
// test re-runs a probe under two more zones in child processes, so any use of
// the local zone inside the clock shows up as a wrong answer.
process.env.TZ = 'America/New_York';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../apps/web/assets/js/atlas-venue-clock.js', import.meta.url), 'utf8');

function frozenDate(iso) {
  const fixed = Date.parse(iso);
  return class FrozenDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(fixed); }
    static now() { return fixed; }
  };
}

/** Load the shipped file in a fresh browser-like context. */
function load({ now, fetch, config, session = 'token', shell } = {}) {
  const context = {
    Date: now ? frozenDate(now) : Date,
    Intl, Number, Math, Map, Set, String, Array, Object, JSON, Promise, RegExp, Error, URL, AbortController,
    setTimeout, clearTimeout, console,
    fetch,
    VABAR_CONFIG: config,
    AtlasShell: shell,
    atlasSupabase: session === null ? undefined : { auth: { getSession: async () => ({ data: { session: session ? { access_token: session } : null } }) } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context.AtlasVenueClock;
}

const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Test data: Sun–Thu 15:00–00:00 (last orders 23:30), Fri/Sat 15:00–03:00 (last orders 02:30).
function hours({ closed = [] } = {}) {
  return labels.map((day_label, weekday) => {
    const late = weekday === 5 || weekday === 6;
    const open = !closed.includes(weekday);
    return {
      weekday, day_label, is_open: open,
      open_time: open ? '15:00:00' : null, close_time: open ? (late ? '03:00:00' : '00:00:00') : null, close_next_day: open,
      kitchen_close_time: open ? '21:00:00' : null, kitchen_close_next_day: false,
      last_order_time: open ? (late ? '02:30:00' : '23:30:00') : null, last_order_next_day: open && late
    };
  });
}
const HAPPY_HOUR = { offer_key: 'daily-happy-hour', name: 'Happy Hour', days: [0, 1, 2, 3, 4, 5, 6], start_time: '15:00:00', end_time: '18:00:00', end_next_day: false };
const clockPayload = (overrides = {}) => ({
  clock: { timezone: 'Atlantic/Reykjavik', timezone_source: 'settings', hours_configured: true, business_hours: hours(), offers: [HAPPY_HOUR], ...overrides },
  staff: { role: 'manager', can_manage_hours: true }
});

test('the test process really runs in a zone other than the venue zone', () => {
  const at = new Date('2026-09-18T18:10:00Z');
  assert.equal(at.getHours(), 14, 'browser zone is New York');
  const clock = load();
  clock.apply(clockPayload());
  assert.equal(clock.parts(at).hour, 18, 'venue hour is Reykjavik');
  assert.equal(clock.formatTime(at), '18:10');
  // 02:00 in Reykjavik is still the previous evening in New York.
  assert.equal(clock.venueDate('2026-09-19T02:00:00Z'), '2026-09-19');
  assert.equal(new Date('2026-09-19T02:00:00Z').getDate(), 18);
});

test('frozen clock: state(), today() and tomorrow() follow the venue business day', () => {
  const clock = load({ now: '2026-09-19T01:30:00Z' });
  assert.equal(clock.state().status, 'loading');
  assert.equal(clock.state().today, null);
  clock.apply(clockPayload());
  const state = clock.state();
  assert.equal(state.status, 'ready');
  assert.equal(state.timezone, 'Atlantic/Reykjavik');
  assert.equal(state.timezoneIsDefault, false);
  assert.equal(state.venueDate, '2026-09-19', 'Saturday calendar date');
  assert.equal(state.businessDate, '2026-09-18', 'still Friday’s business day');
  assert.equal(clock.today(), '2026-09-18');
  assert.equal(clock.tomorrow(), '2026-09-19');
  assert.deepEqual({ ...state.today }, { isOpen: true, open: '15:00', close: '03:00', closeNextDay: true, lastOrder: '02:30', kitchenClose: '21:00' });
  assert.equal(state.offers.length, 1);
  assert.equal(state.canManageHours, true);
});

test('business date after midnight: previous day until its after-midnight close', () => {
  const clock = load();
  clock.apply(clockPayload());
  // Friday 15:00–03:00: Saturday 01:30 and 02:59 are Friday; 03:00 and later are Saturday.
  assert.equal(clock.businessDate('2026-09-19T01:30:00Z'), '2026-09-18');
  assert.equal(clock.businessDate('2026-09-19T02:59:00Z'), '2026-09-18');
  assert.equal(clock.businessDate('2026-09-19T03:00:00Z'), '2026-09-19');
  assert.equal(clock.businessDate('2026-09-19T12:00:00Z'), '2026-09-19');
  // Sunday closes at 00:00 (next day): Monday 00:30 is Monday.
  assert.equal(clock.businessDate('2026-09-21T00:30:00Z'), '2026-09-21');
  // A closed Friday does not pull Saturday morning back.
  clock.apply(clockPayload({ business_hours: hours({ closed: [5] }) }));
  assert.equal(clock.businessDate('2026-09-19T01:30:00Z'), '2026-09-19');
  // Without saved hours it is the plain venue calendar date.
  clock.apply(clockPayload({ hours_configured: false, business_hours: [] }));
  assert.equal(clock.businessDate('2026-09-19T01:30:00Z'), '2026-09-19');
});

test('DST-free Reykjavik vs a DST zone configured in Settings', () => {
  const clock = load();
  clock.apply(clockPayload());
  assert.equal(clock.zonedToInstant('2026-07-01', '15:00').toISOString(), '2026-07-01T15:00:00.000Z');
  assert.equal(clock.zonedToInstant('2026-01-15', '15:00').toISOString(), '2026-01-15T15:00:00.000Z');
  assert.equal(clock.venueDate('2026-07-01T23:30:00Z'), '2026-07-01');

  clock.apply(clockPayload({ timezone: 'Europe/London' }));
  assert.equal(clock.state().timezone, 'Europe/London');
  assert.equal(clock.zonedToInstant('2026-07-01', '15:00').toISOString(), '2026-07-01T14:00:00.000Z', 'BST');
  assert.equal(clock.zonedToInstant('2026-01-15', '15:00').toISOString(), '2026-01-15T15:00:00.000Z', 'GMT');
  // Clocks go forward on 29 March 2026: noon that day is 11:00Z, the day before 12:00Z.
  assert.equal(clock.zonedToInstant('2026-03-28', '12:00').toISOString(), '2026-03-28T12:00:00.000Z');
  assert.equal(clock.zonedToInstant('2026-03-29', '12:00').toISOString(), '2026-03-29T11:00:00.000Z');
  assert.equal(clock.venueDate('2026-07-01T23:30:00Z'), '2026-07-02', '00:30 BST is the next day');
  assert.equal(clock.formatTime('2026-07-01T23:30:00Z'), '00:30');
  // Opening windows follow the zone across the change: Saturday 28 March opens 15:00 GMT, Sunday 29 March 15:00 BST.
  assert.equal(clock.dayWindow('2026-03-28').open.toISOString(), '2026-03-28T15:00:00.000Z');
  assert.equal(clock.dayWindow('2026-03-29').open.toISOString(), '2026-03-29T14:00:00.000Z');
  // Saturday's 03:00 close falls after the change (03:00 BST = 02:00Z).
  assert.equal(clock.dayWindow('2026-03-28').close.toISOString(), '2026-03-29T02:00:00.000Z');
});

test('datetime-local and date inputs round-trip in the venue zone', () => {
  for (const zone of ['Atlantic/Reykjavik', 'Europe/London', 'Pacific/Auckland', 'America/Los_Angeles']) {
    const clock = load();
    clock.apply(clockPayload({ timezone: zone }));
    for (let at = Date.parse('2026-01-01T00:07:00Z'); at < Date.parse('2027-01-01T00:00:00Z'); at += 7 * 3600000 + 13 * 60000) {
      const value = clock.localInputValue(new Date(at));
      assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      const iso = clock.fromLocalInput(value);
      assert.equal(clock.localInputValue(iso), value, `${zone} ${value}`);
      const drift = Math.abs(Date.parse(iso) - at);
      // Exact except in the repeated hour when clocks go back (either reading is that wall time).
      assert.ok(drift === 0 || drift === 3600000, `${zone} ${value} drift ${drift}`);
    }
  }
  const clock = load();
  clock.apply(clockPayload({ timezone: 'Europe/London' }));
  // The Marketing / Brain defer bug: 17:00 typed in a New York browser must mean 17:00 at the venue.
  assert.equal(clock.fromLocalInput('2026-09-24T17:00'), '2026-09-24T16:00:00.000Z');
  assert.equal(clock.localInputValue('2026-09-24T16:00:00Z'), '2026-09-24T17:00');
  assert.equal(clock.localInputValue('2026-09-24T23:30:00Z', 'date'), '2026-09-25');
  assert.equal(clock.fromLocalInput('2026-09-25'), '2026-09-25', 'date inputs stay date keys');
  assert.equal(clock.fromLocalInput('2026-02-30T10:00'), null);
  assert.equal(clock.fromLocalInput('not a date'), null);
  assert.equal(clock.localInputValue(null), '');
});

test('compareRange: equal-length previous period, previous month for a whole month', () => {
  const clock = load();
  const range = (start, end) => { const r = clock.compareRange({ start, end }); return r && [r.start, r.end, r.days, r.rule]; };
  // Spec example spanning two months (the old code used the start's day-of-month on the end's month).
  assert.deepEqual(range('2026-08-25', '2026-09-23'), ['2026-07-26', '2026-08-24', 30, 'previous_period']);
  assert.deepEqual(range('2026-03-01', '2026-03-07'), ['2026-02-22', '2026-02-28', 7, 'previous_period']);
  assert.deepEqual(range('2026-01-01', '2026-01-15'), ['2025-12-17', '2025-12-31', 15, 'previous_period']);
  assert.deepEqual(range('2026-03-31', '2026-03-31'), ['2026-03-30', '2026-03-30', 1, 'previous_period']);
  // Whole calendar months compare with the whole previous month, whatever its length.
  assert.deepEqual(range('2026-09-01', '2026-09-30'), ['2026-08-01', '2026-08-31', 31, 'previous_month']);
  assert.deepEqual(range('2026-03-01', '2026-03-31'), ['2026-02-01', '2026-02-28', 28, 'previous_month']);
  assert.deepEqual(range('2028-03-01', '2028-03-31'), ['2028-02-01', '2028-02-29', 29, 'previous_month']);
  assert.deepEqual(range('2026-01-01', '2026-01-31'), ['2025-12-01', '2025-12-31', 31, 'previous_month']);
  assert.equal(clock.compareRange({ start: '2026-09-10', end: '2026-09-01' }), null);
  assert.equal(clock.compareRange({}), null);
});

test('calendar helpers: addDays, weekday, startOfWeek (Monday), monthRange', () => {
  const clock = load();
  clock.apply(clockPayload());
  assert.equal(clock.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(clock.addDays('2026-03-29', -1), '2026-03-28');
  assert.equal(clock.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(clock.weekday('2026-09-20'), 0, 'Sunday');
  assert.equal(clock.weekday('2026-09-18'), 5, 'Friday');
  assert.equal(clock.startOfWeek('2026-09-27'), '2026-09-21', 'Sunday belongs to the week starting Monday');
  assert.equal(clock.startOfWeek('2026-09-21'), '2026-09-21');
  // Monday 00:30 in Reykjavik is Sunday evening in New York: still Monday's week at the venue.
  assert.equal(clock.startOfWeek(new Date('2026-09-28T00:30:00Z')), '2026-09-28');
  assert.deepEqual({ ...clock.monthRange('2026-02-14') }, { month: '2026-02', start: '2026-02-01', end: '2026-02-28', days: 28 });
  assert.deepEqual({ ...clock.monthRange('2028-02') }, { month: '2028-02', start: '2028-02-01', end: '2028-02-29', days: 29 });
  assert.equal(clock.monthKey(new Date('2026-09-30T23:30:00Z')), '2026-09');
});

test('hours not set: no events, no timeline, no open/closed answer', () => {
  const clock = load({ now: '2026-09-18T18:10:00Z' });
  clock.apply({ clock: { timezone: 'Atlantic/Reykjavik', timezone_source: 'settings', hours_configured: false, business_hours: [], offers: [] } });
  const state = clock.state();
  assert.equal(state.status, 'not_set');
  assert.equal(state.hoursConfigured, false);
  assert.equal(state.today, null);
  assert.deepEqual([...state.offers], []);
  assert.equal(clock.isOpenAt(), null);
  assert.equal(clock.nextEvent(), null);
  assert.deepEqual([...clock.timeline()], []);
  assert.equal(clock.dayWindow('2026-09-18').state, 'not_set');
  // Partial rows (not all seven days saved) are "not set" too.
  clock.apply(clockPayload({ hours_configured: false, business_hours: hours().slice(0, 3) }));
  assert.equal(clock.state().status, 'not_set');
  assert.equal(clock.nextEvent('2026-09-18T18:10:00Z'), null);
});

test('saved hours: isOpenAt, nextEvent and timeline come only from the rows', () => {
  const clock = load();
  clock.apply(clockPayload());
  assert.equal(clock.isOpenAt('2026-09-18T14:59:00Z'), false);
  assert.equal(clock.isOpenAt('2026-09-18T15:00:00Z'), true);
  assert.equal(clock.isOpenAt('2026-09-19T02:59:00Z'), true, 'Friday after midnight');
  assert.equal(clock.isOpenAt('2026-09-19T03:00:00Z'), false);

  const next = (at, options) => { const event = clock.nextEvent(at, options); return event && [event.type, event.at.toISOString(), event.time, event.businessDate]; };
  assert.deepEqual(next('2026-09-18T10:00:00Z'), ['opens', '2026-09-18T15:00:00.000Z', '15:00', '2026-09-18']);
  assert.deepEqual(next('2026-09-18T18:10:00Z'), ['kitchen_closes', '2026-09-18T21:00:00.000Z', '21:00', '2026-09-18']);
  assert.deepEqual(next('2026-09-18T21:30:00Z'), ['last_orders', '2026-09-19T02:30:00.000Z', '02:30', '2026-09-18']);
  assert.deepEqual(next('2026-09-19T02:45:00Z'), ['closes', '2026-09-19T03:00:00.000Z', '03:00', '2026-09-18']);
  assert.deepEqual(next('2026-09-18T18:10:00Z', { types: ['closes'] }), ['closes', '2026-09-19T03:00:00.000Z', '03:00', '2026-09-18']);

  // A closed Monday is skipped: after Sunday's close the next opening is Tuesday.
  clock.apply(clockPayload({ business_hours: hours({ closed: [1] }) }));
  assert.deepEqual(next('2026-09-21T01:00:00Z', { types: ['opens'] }), ['opens', '2026-09-22T15:00:00.000Z', '15:00', '2026-09-22']);
  assert.deepEqual([...clock.timeline('2026-09-21')], [], 'closed day: empty timeline');
  assert.deepEqual({ ...clock.dayWindow('2026-09-21') }.state, 'closed');
  // Closed all week: no event at all, never an invented opening.
  clock.apply(clockPayload({ business_hours: hours({ closed: [0, 1, 2, 3, 4, 5, 6] }) }));
  assert.equal(clock.nextEvent('2026-09-18T10:00:00Z'), null);

  clock.apply(clockPayload());
  const rows = [...clock.timeline('2026-09-18', '2026-09-18T18:10:00Z')].map((entry) => `${entry.time} ${entry.title} ${entry.status}`);
  assert.deepEqual(rows, ['15:00 Open past', '15:00 Happy Hour past', '21:00 Kitchen closes current', '02:30 Last orders future', '03:00 Close future']);
  // The offer appears only on its weekdays.
  clock.apply(clockPayload({ offers: [{ ...HAPPY_HOUR, days: [4] }] }));
  assert.ok(!clock.timeline('2026-09-18').some((entry) => entry.title === 'Happy Hour'));
  assert.ok(clock.timeline('2026-09-17').some((entry) => entry.title === 'Happy Hour'));
});

test('time zone fallback is Atlantic/Reykjavik only when the setting is missing, and is flagged', () => {
  const clock = load();
  assert.equal(clock.timeZone(), 'Atlantic/Reykjavik');
  assert.equal(clock.state().timezoneIsDefault, true);
  clock.apply(clockPayload({ timezone: 'Mars/Base', timezone_source: 'settings' }));
  assert.equal(clock.timeZone(), 'Atlantic/Reykjavik');
  assert.equal(clock.state().timezoneIsDefault, true);
  assert.equal(clock.state().timezoneSource, 'default');
  clock.apply(clockPayload({ timezone: 'Atlantic/Reykjavik', timezone_source: 'default' }));
  assert.equal(clock.state().timezoneIsDefault, true);
  clock.apply(clockPayload({ timezone: 'Europe/Oslo' }));
  assert.equal(clock.state().timezoneIsDefault, false);
  assert.equal(clock.state().timezoneSource, 'settings');
});

test('formatting: 24 h venue times, "Thu 24 Sep" dates, relative under 24 h, krónur', () => {
  const clock = load();
  clock.apply(clockPayload());
  assert.equal(clock.formatTime('2026-09-24T17:05:00Z'), '17:05');
  assert.equal(clock.formatTime('17:05:00'), '17:05');
  assert.equal(clock.formatTime('nonsense', '—'), '—');
  assert.equal(clock.formatDate('2026-09-24'), 'Thu 24 Sep');
  assert.equal(clock.formatDate('2026-09-24', { long: true }), 'Thursday 24 September');
  assert.equal(clock.formatDate('2026-09-24', { long: true, year: true }), 'Thursday 24 September 2026');
  assert.equal(clock.formatDate(new Date('2026-09-25T02:00:00Z')), 'Fri 25 Sep', 'instant → venue date');
  assert.equal(clock.formatDateTime('2026-09-24T17:05:00Z'), 'Thu 24 Sep, 17:05');
  const now = '2026-09-24T12:00:00Z';
  assert.equal(clock.formatRelative('2026-09-24T11:59:40Z', now), 'just now');
  assert.equal(clock.formatRelative('2026-09-24T11:48:00Z', now), '12 min ago');
  assert.equal(clock.formatRelative('2026-09-24T15:30:00Z', now), 'in 3 h');
  assert.equal(clock.formatRelative('2026-09-22T09:00:00Z', now), 'Tue 22 Sep, 09:00');
  assert.equal(clock.formatKr(3900), '3.900 kr');
  assert.equal(clock.formatKr(0), '0 kr');
  assert.equal(clock.formatKr(999), '999 kr');
  assert.equal(clock.formatKr(1234567.6), '1.234.568 kr');
  assert.equal(clock.formatKr(-23400), '-23.400 kr');
  assert.equal(clock.formatKr('58200'), '58.200 kr');
  assert.equal(clock.formatKr(null), '—');
  assert.equal(clock.formatKr(''), '—');
  assert.equal(clock.formatKr(Number.NaN, 'n/a'), 'n/a');
});

test('load(): one request, cached; 0 rows → not_set; 404 → unavailable; Settings saves refresh', async () => {
  const calls = [];
  let response = { status: 200, body: clockPayload({ hours_configured: false, business_hours: [], offers: [] }) };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: response.status < 400, status: response.status, json: async () => response.body };
  };
  const handlers = new Map();
  const shell = { on: (type, fn) => handlers.set(type, fn), profile: () => null, emit: () => {} };
  const clock = load({ fetch, shell, config: { SETTINGS_API: 'https://example.test/functions/v1/atlas-settings' } });

  handlers.get('profile:ready')({ role: 'manager' });
  await clock.load();
  await clock.load();
  assert.equal(calls.length, 1, 'cached after the first request');
  assert.equal(new URL(calls[0].url).searchParams.get('action'), 'venue-clock');
  assert.equal(calls[0].init.headers.authorization, 'Bearer token');
  assert.equal(clock.state().status, 'not_set');

  response = { status: 200, body: clockPayload() };
  handlers.get('settings:saved')({ action: 'save-role' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1, 'unrelated saves do not refetch');
  handlers.get('settings:saved')({ action: 'save-hours' });
  await clock.load();
  assert.equal(calls.length, 2);
  assert.equal(clock.state().status, 'ready');
  handlers.get('settings:saved')({ action: 'save-section', section_key: 'venue' });
  await clock.load();
  assert.equal(calls.length, 3);

  response = { status: 404, body: { error: 'Not found' } };
  await clock.refresh();
  assert.equal(clock.state().status, 'unavailable');
  assert.equal(clock.nextEvent(), null);
  assert.deepEqual([...clock.timeline()], []);

  response = { status: 200, body: {} };
  await clock.refresh();
  assert.equal(clock.state().status, 'unavailable', 'a response without a clock is not hours');
});

test('the same answers under other process zones (child processes)', () => {
  const probe = `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const context = { Date, Intl, Number, Math, Map, Set, String, Array, Object, JSON, Promise, RegExp, Error, URL, setTimeout, clearTimeout };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(${JSON.stringify(new URL('../../apps/web/assets/js/atlas-venue-clock.js', import.meta.url).pathname)}, 'utf8'), context);
    const clock = context.AtlasVenueClock;
    clock.apply(${JSON.stringify(clockPayload({ timezone: 'Europe/London' }))});
    const at = '2026-10-24T23:40:00Z';
    process.stdout.write(JSON.stringify([
      clock.venueDate(at), clock.businessDate(at), clock.formatTime(at), clock.localInputValue(at),
      clock.fromLocalInput('2026-10-25T12:00'), clock.startOfWeek(at), clock.isOpenAt(at),
      clock.nextEvent(at).at.toISOString(), clock.timeline('2026-10-24', at).map((e) => e.time + e.status)
    ]));`;
  const run = (TZ) => execFileSync(process.execPath, ['-e', probe], { env: { ...process.env, TZ }, encoding: 'utf8' });
  const reference = run('UTC');
  assert.equal(run('Asia/Tokyo'), reference);
  assert.equal(run('America/Los_Angeles'), reference);
  const [venueDate, businessDate, time] = JSON.parse(reference);
  assert.deepEqual([venueDate, businessDate, time], ['2026-10-25', '2026-10-24', '00:40']);
});
