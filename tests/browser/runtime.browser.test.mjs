// S87 cross-module runtime regressions: request storms, the Home render crash
// and navigation made while the first data load is still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTimers, harnessAvailable, launchAtlas, openView, requestsTo, settle, until } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const DOWN = { __status: 503, body: { error: 'Service unavailable' } };

for (const [view, fn] of [['knowledge', 'atlas-knowledge'], ['team', 'atlas-team-messages'], ['shifts', 'atlas-shifts']]) {
  test(`${view} does not retry in a loop while its API is failing`, { skip }, async () => {
    const { page, record, close } = await launchAtlas({ controlTimers: true, fixtures: { functions: { ...emptyFunctions(), [fn]: DOWN } } });
    try {
      await openView(page, view);
      // Five seconds of timer time (retries, backoff), without sleeping.
      await advanceTimers(page, 5000);
      const count = requestsTo(record, fn, 'snapshot').length;
      assert.ok(count <= 3, `${fn} sent ${count} snapshot requests in 5 s`);
      // The explicit retry control still works immediately.
      const retry = { knowledge: '[data-knowledge-refresh]', team: '[data-team-refresh]', shifts: '[data-shifts-retry]' }[view];
      await page.click(`#${view}-view ${retry}`);
      await until(() => requestsTo(record, fn, 'snapshot').length > count, { message: 'Try again sends a new request' });
    } finally { await close(); }
  });
}

test('Knowledge does not loop on a 200 response without a workspace', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ controlTimers: true, fixtures: { functions: { ...emptyFunctions(), 'atlas-knowledge': {} } } });
  try {
    await openView(page, 'knowledge');
    await advanceTimers(page, 4000);
    assert.ok(requestsTo(record, 'atlas-knowledge', 'snapshot').length <= 3);
  } finally { await close(); }
});

test('returning to Home renders without errors and keeps its glance links working', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ fixtures: { functions: emptyFunctions() } });
  try {
    await openView(page, 'operations');
    await openView(page, 'dashboard');
    assert.deepEqual(record.pageErrors, []);
    await page.click('.home-glance__item[href="#recipes"]');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'recipes');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'recipes');
  } finally { await close(); }
});

test('a destination opened while data loads is not replaced by Home', { skip }, async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve([]), 1500));
  const { page, close } = await launchAtlas({ waitReady: false, fixtures: { functions: emptyFunctions(), tables: { suppliers: slow } } });
  try {
    await page.click('.atlas-nav .nav-item[data-view="shifts"]');
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'shifts');
  } finally { await close(); }
});

test('an idle page does not churn the DOM every frame', { skip }, async () => {
  const functions = {
    ...emptyFunctions(),
    'atlas-team-messages': { snapshot: { channels: [{ key: 'general', name: 'General' }], messages: [], selected_channel_key: 'general', summary: {} }, members: [], staff: {} }
  };
  const { page, close } = await launchAtlas({ fixtures: { functions } });
  try {
    // Rendering Messages once used to start a self-sustaining observer loop.
    await openView(page, 'team');
    await openView(page, 'shifts');
    await settle(page);
    const mutations = await page.evaluate(() => new Promise((resolve) => {
      let count = 0;
      const observer = new MutationObserver((records) => { count += records.length; });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      setTimeout(() => { observer.disconnect(); resolve(count); }, 3000);
    }));
    assert.ok(mutations < 60, `${mutations} DOM mutations in 3 s while idle`);
  } finally { await close(); }
});
