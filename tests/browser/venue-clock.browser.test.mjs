// S88 venue clock: Home shows only saved business hours, in the venue time
// zone, whatever zone the browser is set to. (The Brain page is retired; its
// countdown is Home's context line, S88 Team A.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, settle, USERS } from './harness.mjs';
import { emptyFunctions, venueClockBackend, weekHours } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
// Friday 18 September 2026, 18:10 in Reykjavik (14:10 in New York).
const FRIDAY_EVENING = '2026-09-18T18:10:00Z';
// Saturday 19 September 2026, 01:30 in Reykjavik: still Friday's business day.
const AFTER_MIDNIGHT = '2026-09-19T01:30:00Z';
const HAPPY_HOUR = { offer_key: 'daily-happy-hour', name: 'Happy Hour', days: [0, 1, 2, 3, 4, 5, 6], start_time: '15:00:00', end_time: '18:00:00', end_next_day: false };

function launch(backend, options = {}) {
  return launchAtlas({
    timezoneId: 'America/New_York',
    ...options,
    fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': backend.handler } }
  });
}

const timelineText = (page) => page.$eval('#home-timeline', (node) => node.textContent.replace(/\s+/g, ' ').trim());
const contextText = (page) => page.$eval('.home-context', (node) => node.textContent.replace(/\s+/g, ' ').trim());

test('with no saved hours Home says "Opening hours not set" and shows no timeline or countdown', { skip }, async () => {
  const backend = venueClockBackend({ hours: [] });
  const { page, record, close } = await launch(backend, { fixedTime: FRIDAY_EVENING });
  try {
    await page.waitForSelector('#home-timeline [data-venue-clock-state="not_set"]');
    const text = await timelineText(page);
    assert.match(text, /Opening hours not set/);
    assert.equal(await page.$('#home-timeline .home-timeline__row'), null, 'no invented timeline rows');
    assert.doesNotMatch(text, /\b(11:00|11:30|22:00)\b/);
    assert.ok(await page.$('#home-timeline [data-venue-hours-settings]'), 'managers get a Settings link');
    assert.equal(requestsTo(record, 'atlas-settings', 'venue-clock').length, 1, 'one venue-clock request after sign-in');

    const context = await contextText(page);
    assert.match(context, /Opening hours aren’t set/);
    assert.doesNotMatch(context, /closes|opens at/i, 'no countdown without hours');

    await page.click('#home-timeline [data-venue-hours-settings]');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'settings');
    await settle(page);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'settings');
    assert.equal(await page.evaluate(() => location.hash), '#settings/hours');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a bartender sees the not-set state without a Settings link', { skip }, async () => {
  const { page, close } = await launch(venueClockBackend({ hours: [] }), { user: USERS.bartender, fixedTime: FRIDAY_EVENING });
  try {
    await page.waitForSelector('#home-timeline [data-venue-clock-state="not_set"]');
    assert.equal(await page.$('#home-timeline [data-venue-hours-settings]'), null);
    assert.match(await timelineText(page), /A manager can add them in Settings/);
  } finally { await close(); }
});

test('saved hours give a real timeline and countdown in the venue zone, not the browser zone', { skip }, async () => {
  const backend = venueClockBackend({ hours: weekHours(), offers: [HAPPY_HOUR] });
  const { page, record, close } = await launch(backend, { fixedTime: FRIDAY_EVENING });
  try {
    await page.waitForSelector('#home-timeline .home-timeline__row');
    const rows = await page.$$eval('#home-timeline .home-timeline__row', (nodes) => nodes.map((node) => ({
      time: node.querySelector('time').textContent,
      title: node.querySelector('.home-timeline__label').firstChild.textContent,
      status: [...node.classList].find((name) => name.startsWith('is-')) || 'future'
    })));
    assert.deepEqual(rows, [
      { time: '15:00', title: 'Open', status: 'is-done' },
      { time: '15:00', title: 'Happy Hour', status: 'is-done' },
      { time: '02:30', title: 'Last orders', status: 'is-now' },
      { time: '03:00', title: 'Close', status: 'future' }
    ]);
    // The browser runs in New York; the venue is in Reykjavik.
    assert.equal(await page.evaluate(() => new Date().getHours()), 14);
    assert.equal(await page.evaluate(() => window.AtlasVenueClock.state().businessDate), '2026-09-18');

    assert.match(await contextText(page), /^Open · closes at 03:00 \(in /);
    assert.match(await page.textContent('.home-greeting'), /^Good evening/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('after midnight the timeline still belongs to the previous business day', { skip }, async () => {
  const backend = venueClockBackend({ hours: weekHours() });
  const { page, close } = await launch(backend, { fixedTime: AFTER_MIDNIGHT });
  try {
    await page.waitForSelector('#home-timeline .home-timeline__row');
    assert.equal(await page.evaluate(() => window.AtlasVenueClock.today()), '2026-09-18');
    assert.equal(await page.evaluate(() => window.AtlasVenueClock.venueDate()), '2026-09-19');
    const current = await page.$eval('#home-timeline .home-timeline__row.is-now .home-timeline__label', (node) => node.firstChild.textContent);
    assert.equal(current, 'Last orders');
  } finally { await close(); }
});

test('a missing venue-clock function shows "Opening hours unavailable", never hours', { skip }, async () => {
  const { page, close } = await launch(venueClockBackend({ status: 404 }), { fixedTime: FRIDAY_EVENING });
  try {
    await page.waitForSelector('#home-timeline [data-venue-clock-state="unavailable"]');
    assert.match(await timelineText(page), /Opening hours unavailable/);
    assert.match(await contextText(page), /Opening hours unavailable/);
    assert.doesNotMatch(await contextText(page), /closes at|opens at/i);
  } finally { await close(); }
});

test('saving hours in Settings updates Home without a reload', { skip }, async () => {
  const backend = venueClockBackend({ hours: [] });
  const { page, record, close } = await launch(backend, { fixedTime: FRIDAY_EVENING });
  try {
    await page.waitForSelector('#home-timeline [data-venue-clock-state="not_set"]');
    backend.hours = weekHours();
    // settings-workspace.js emits this after a successful save-hours.
    await page.evaluate(() => window.AtlasShell.emit('settings:saved', { action: 'save-hours' }));
    await page.waitForSelector('#home-timeline .home-timeline__row');
    assert.equal(requestsTo(record, 'atlas-settings', 'venue-clock').length, 2);
    // Unrelated saves do not re-fetch.
    await page.evaluate(() => window.AtlasShell.emit('settings:saved', { action: 'save-role' }));
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-settings', 'venue-clock').length, 2);
  } finally { await close(); }
});
