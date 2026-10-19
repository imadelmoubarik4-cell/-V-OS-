// Focused regressions for the Messages unread-badge worker's polling cadence
// (apps/web/assets/js/team-unread-badge.js): it must populate promptly after
// sign-in on a healthy API, and it must back off — never poll in a tight loop —
// when the API is failing. The badge polls app-wide, so on a non-Messages view
// (here #dashboard) every atlas-team-messages snapshot request is the badge's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTimers, harnessAvailable, launchAtlas, requestsTo, settle, until } from './harness.mjs';
import { messagesBackend, peopleFunctions } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

test('the unread badge populates promptly after sign-in on a healthy API', { skip }, async () => {
  const backend = messagesBackend();
  const { page, record, close } = await launchAtlas({
    hash: '#dashboard',
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': backend.handler }) }
  });
  try {
    // The count reaches 2 well inside the warm-up window, not only on a 30s tick.
    await page.waitForFunction(() => window.AtlasTeamUnreadBadge?.count?.() === 2, null, { timeout: 8000 });
    // Getting there costs only a few requests — the fast cadence is not a storm.
    assert.ok(requestsTo(record, 'atlas-team-messages', 'snapshot').length <= 3, 'healthy populate is not a storm');
  } finally { await close(); }
});

test('the unread badge backs off and does not storm while its API is failing', { skip }, async () => {
  const backend = messagesBackend({ status: 503 });
  const { page, record, close } = await launchAtlas({
    hash: '#dashboard', controlTimers: true,
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': backend.handler }) }
  });
  try {
    // Five seconds of timer time: the same window the shared request-storm test uses.
    await advanceTimers(page, 5000);
    const atFive = requestsTo(record, 'atlas-team-messages', 'snapshot').length;
    assert.ok(atFive <= 3, `badge sent ${atFive} snapshot requests in 5 s while failing`);
    // Keep advancing: exponential backoff (8s, 16s, 30s cap) keeps the total small
    // over a long failing stretch rather than one request every WARMUP_MS.
    await advanceTimers(page, 30000);
    const atThirtyFive = requestsTo(record, 'atlas-team-messages', 'snapshot').length;
    assert.ok(atThirtyFive <= 5, `badge sent ${atThirtyFive} snapshot requests in 35 s while failing`);
    // The explicit control path still works at once: a manual refresh is not wedged.
    await page.evaluate(() => window.AtlasTeamUnreadBadge.refresh());
    await until(() => requestsTo(record, 'atlas-team-messages', 'snapshot').length > atThirtyFive, { message: 'manual refresh sends a new request' });
  } finally { await close(); }
});

test('a recovered API repopulates the badge after a failing start', { skip }, async () => {
  const backend = messagesBackend({ status: 503 }); // the handler reads backend.status per call
  const { page, close } = await launchAtlas({
    hash: '#dashboard', controlTimers: true,
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': backend.handler }) }
  });
  try {
    // While the API is down the badge stays empty (never shows a false count).
    await advanceTimers(page, 5000);
    assert.equal(await page.evaluate(() => window.AtlasTeamUnreadBadge.count()), 0);
    // Heal the API; a manual refresh then lands a real snapshot and populates.
    backend.status = 200;
    await page.evaluate(() => window.AtlasTeamUnreadBadge.refresh());
    await page.waitForFunction(() => window.AtlasTeamUnreadBadge?.count?.() === 2, null, { timeout: 8000 });
  } finally { await close(); }
});
