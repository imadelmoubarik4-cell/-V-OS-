// Audit M11: the Messages unread badge (team-unread-badge.js) polls the
// lightweight snapshot every 8 s while healthy, backs off exponentially (capped)
// while the gateway fails, throttles focus refreshes, never polls a hidden tab,
// and refreshes at once on a relayed Messages push or when the network returns.
// Runs on fake timers (controlTimers): the page records the fake-clock time of
// every badge request, so the cadence is measured without sleeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTimers, harnessAvailable, launchAtlas, settle, until } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

function messagesGateway() {
  const gateway = { down: false };
  gateway.handler = () => (gateway.down
    ? { __status: 503, body: { error: 'Service unavailable' } }
    : { snapshot: { channels: [{ key: 'general', name: 'General', unread_count: 1, last_message: null }], messages: [], selected_channel_key: 'general', summary: { total_unread: 1, active_members: 4 } }, members: [], staff: {} });
  return gateway;
}

// Page-clock time of each badge request (its lightweight limit=1 snapshot).
function recordBadgeFetches() {
  window.__badgeFetches = [];
  // Page-clock time of every event that refreshes the badge at once, so a
  // short gap in a cadence check can name what caused it.
  window.__badgeTriggers = [];
  for (const type of ['focus', 'online', 'pageshow']) window.addEventListener(type, () => window.__badgeTriggers.push(`${type}@${Date.now()}`));
  document.addEventListener('visibilitychange', () => window.__badgeTriggers.push(`visibilitychange@${Date.now()}`));
  const original = window.fetch;
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('atlas-team-messages') && url.includes('limit=1')) window.__badgeFetches.push(Date.now());
    return original.call(this, input, init);
  };
}

const fetches = (page) => page.evaluate(() => window.__badgeFetches.slice());
const pageNow = (page) => page.evaluate(() => Date.now());
const gaps = (times) => times.slice(1).map((time, index) => time - times[index]);

async function boot(gateway) {
  const app = await launchAtlas({ controlTimers: true, initScript: recordBadgeFetches, fixtures: { functions: { ...emptyFunctions(), 'atlas-team-messages': gateway.handler } } });
  await app.page.waitForFunction(() => Boolean(window.AtlasTeamUnreadBadge));
  await advanceTimers(app.page, 1000);
  return app;
}

// The delay of every poll team-unread-badge.js schedules from now on (its
// schedulePoll; request deadlines are separate timers). The page's fake
// setTimeout is wrapped once the clock is installed.
const recordBadgeTimers = (page) => page.evaluate(() => {
  window.__badgeTimers = [];
  const schedule = window.setTimeout;
  window.setTimeout = function (callback, delay, ...rest) {
    const stack = new Error().stack || '';
    if (/team-unread-badge\.js/.test(stack) && !/fetchUnread/.test(stack)) window.__badgeTimers.push(Number(delay) || 0);
    return schedule.call(this, callback, delay, ...rest);
  };
});

test('healthy: one badge poll every 8 s', { skip }, async () => {
  const { page, close } = await boot(messagesGateway());
  try {
    await advanceTimers(page, 10000, { step: 1000 });
    assert.equal(await page.evaluate(() => window.AtlasTeamUnreadBadge.count()), 1);
    await recordBadgeTimers(page);
    const from = await pageNow(page);
    await advanceTimers(page, 40000, { step: 1000 });
    const times = (await fetches(page)).filter((time) => time >= from);
    assert.ok(times.length >= 4 && times.length <= 6, `expected about 5 polls in 40 s, got ${times.length}`);
    // The cadence is the delay the badge schedules, not when each request
    // starts (that also includes reading the session, which varies on a
    // loaded runner): every poll is set exactly 8 s out while healthy.
    const delays = await page.evaluate(() => window.__badgeTimers.slice());
    assert.ok(delays.length >= 4, `the badge scheduled ${delays.length} polls`);
    assert.deepEqual([...new Set(delays)], [8000], `poll delays while healthy: ${delays.join(', ')}`);
  } finally { await close(); }
});

test('failures back off exponentially up to a cap, and the network coming back resets it', { skip }, async () => {
  const gateway = messagesGateway();
  gateway.down = true;
  const { page, close } = await boot(gateway);
  try {
    const from = await pageNow(page);
    // A fixed 8 s cadence would send 75 requests in 10 minutes.
    await advanceTimers(page, 600000, { step: 2000 });
    const failing = (await fetches(page)).filter((time) => time >= from);
    assert.ok(failing.length >= 3 && failing.length <= 9, `failing gateway polled ${failing.length} times in 10 minutes`);
    const failingGaps = gaps(failing);
    for (let index = 1; index < failingGaps.length; index += 1) {
      assert.ok(failingGaps[index] >= failingGaps[index - 1] * 0.75, `backoff does not shrink: ${failingGaps.join(', ')}`);
    }
    // Capped at 3 minutes: the next failing poll still comes within it.
    const capFrom = await pageNow(page);
    await advanceTimers(page, 184000, { step: 2000 });
    const capped = (await fetches(page)).filter((time) => time > capFrom);
    assert.ok(capped.length >= 1, 'a poll within the 3-minute cap');
    const all = await fetches(page);
    assert.ok(Math.max(...gaps(all)) <= 182000, `largest gap ${Math.max(...gaps(all))} ms stays within the cap`);

    // Back online with a healthy gateway: an immediate refresh, then 8 s polls again.
    gateway.down = false;
    const onlineAt = await pageNow(page);
    const before = all.length;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await until(async () => (await fetches(page)).length > before, { message: 'online refresh' });
    const refreshed = (await fetches(page))[before];
    assert.ok(refreshed - onlineAt < 1000, 'online refreshes at once');
    await settle(page);
    await advanceTimers(page, 9000, { step: 500 });
    const next = (await fetches(page)).filter((time) => time > refreshed);
    assert.ok(next.length >= 1 && next[0] - refreshed <= 8600, `the normal cadence resumes after a success (${next[0] - refreshed} ms)`);
    assert.equal(await page.evaluate(() => window.AtlasTeamUnreadBadge.count()), 1);
  } finally { await close(); }
});

test('focus refreshes are throttled; a hidden tab does not poll; a Messages push refreshes at once', { skip }, async () => {
  const { page, record, close } = await boot(messagesGateway());
  try {
    await advanceTimers(page, 20000, { step: 1000 });
    // First focus: an immediate refresh, and the poll restarts 8 s from it.
    let count = (await fetches(page)).length;
    let at = await pageNow(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await fetches(page)).length > count, { message: 'focus refresh' });
    const focused = (await fetches(page))[count];
    assert.ok(focused - at < 1000, 'the first focus refreshes');
    await settle(page);
    // A second focus 2 s later does not fetch: nothing until the 8 s poll.
    await advanceTimers(page, 2000, { step: 500 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await settle(page);
    await advanceTimers(page, 4000, { step: 500 });
    const between = (await fetches(page)).filter((time) => time > focused && time < focused + 7500);
    assert.deepEqual(between, [], 'a second focus 2 s later does not fetch');

    // Hidden: no polls, however long; visible again: one immediate refresh.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(page);
    const hiddenFrom = await pageNow(page);
    await advanceTimers(page, 120000, { step: 4000 });
    assert.deepEqual((await fetches(page)).filter((time) => time > hiddenFrom), [], 'no badge poll while the tab is hidden');
    count = (await fetches(page)).length;
    at = await pageNow(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(async () => (await fetches(page)).length > count, { message: 'visible refresh' });
    assert.ok((await fetches(page))[count] - at < 1000, 'visible again refreshes at once');
    await settle(page);

    // A relayed push for Messages (route 'team') refreshes without waiting for the poll.
    count = (await fetches(page)).length;
    at = await pageNow(page);
    const relayed = await page.evaluate(() => {
      if (!navigator.serviceWorker) return false;
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'atlas:push', route: 'team' } }));
      return true;
    });
    if (relayed) {
      await until(async () => (await fetches(page)).length > count, { message: 'push refresh' });
      assert.ok((await fetches(page))[count] - at < 1000, 'a Messages push refreshes the badge');
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a Messages push during a refresh in flight is not lost: one more refresh follows it', { skip }, async () => {
  const { page, record, close } = await boot(messagesGateway());
  try {
    await advanceTimers(page, 10000, { step: 1000 });
    await settle(page);
    // Hold the next badge request so a refresh stays in flight.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let holding = true;
    await page.route('**/functions/v1/atlas-team-messages**', async (route) => {
      if (holding && route.request().url().includes('limit=1')) { holding = false; await held; }
      return route.fallback();
    });
    const count = (await fetches(page)).length;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await until(async () => (await fetches(page)).length === count + 1, { message: 'the first refresh in flight' });
    const relayed = await page.evaluate(() => {
      if (!navigator.serviceWorker) return false;
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'atlas:push', route: 'team' } }));
      return true;
    });
    assert.ok(relayed, 'the page relays service-worker messages');
    assert.equal((await fetches(page)).length, count + 1, 'still one request while it is in flight');
    // The request stays in flight for a second of page time.
    await page.clock.runFor(1000);
    release();
    await until(async () => (await fetches(page)).length === count + 2, { timeout: 4000, message: 'the push refresh after the one in flight' });
    await settle(page);
    assert.equal((await fetches(page)).length, count + 2, 'exactly one more, not a burst');
    // The 8 s poll counts from that last refresh, not from the dropped one.
    const trailing = (await fetches(page))[count + 1];
    await advanceTimers(page, 9000, { step: 500 });
    const next = (await fetches(page)).find((time) => time > trailing);
    assert.ok(next && next - trailing >= 7900 && next - trailing <= 9000, `the next poll ${next - trailing} ms after the last refresh`);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
