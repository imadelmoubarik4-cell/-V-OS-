// Data lazy-loading (Option C, client-only split-contributor pattern).
//
// The heavy Data workspace (data-workspace.js) is registered as a lazy view in
// config.js and must NOT load at boot. The small eager shard (data-home.js,
// window.AtlasDataHome) owns the review summary, the Home attention row and the
// nav badge, so those work for a manager before the workspace is ever fetched.
// When the workspace does load, it reuses the shard's summary — no second fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

const MANAGER = { id: 'c1a22f65-e180-429b-8531-008fd08d3200', email: 'mia.manager@example.test', display_name: 'Mia Manager', role: 'manager', active: true };
const VIEWER = { id: 'd2b33f76-f291-4300-9642-119fe19e4211', email: 'val.viewer@example.test', display_name: 'Val Viewer', role: 'viewer', active: true };

const globalDefined = (page, name) => page.evaluate((n) => typeof window[n] !== 'undefined', name);
const workspaceScriptCount = (page) => page.evaluate(() => document.querySelectorAll('script[src*="data-workspace"]').length);
const summaryFetches = (record) => record.requests.filter((entry) => entry.path.endsWith('/rest/v1/rpc/atlas_data_review_summary')).length;

// Three catalogue changes waiting — enough for the Home row and the nav badge.
const summaryFixture = () => ({ rpc: { atlas_data_review_summary: { issues: [{ code: 'catalog.pending_approval', count: 3 }] } } });

test('boot: the shard is eager, the workspace is lazy, and the Home row + badge work before it loads', { skip }, async () => {
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: summaryFixture() });
  const { page, record } = app;
  try {
    await settle(page);
    // The shard is present; the heavy workspace is not fetched and not registered.
    assert.equal(await globalDefined(page, 'AtlasDataHome'), true, 'AtlasDataHome (shard) is eager');
    assert.equal(await globalDefined(page, 'AtlasDataWorkspace'), false, 'AtlasDataWorkspace is not loaded at boot');
    assert.equal(await workspaceScriptCount(page), 0, 'no data-workspace script at boot');
    assert.equal(await page.evaluate(() => Boolean(window.AtlasShell.view('data'))), false, 'data view not registered at boot');

    // The shard fetched the summary once and rendered the Home attention row + badge.
    await until(() => Promise.resolve(summaryFetches(record) === 1), { message: 'shard fetches the summary once' });
    await page.waitForFunction(() => document.body.innerText.includes('waiting for your approval'), null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.querySelector('[data-nav-badge="data"]')?.textContent || ''), '3', 'nav badge shows the count');
  } finally { await app.close(); }
});

test('first navigation loads the workspace and reuses the shard summary (no second fetch)', { skip }, async () => {
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: summaryFixture() });
  const { page, record } = app;
  try {
    await settle(page);
    await until(() => Promise.resolve(summaryFetches(record) === 1), { message: 'eager summary fetch' });

    await navigateTo(page, '#data');
    await until(() => globalDefined(page, 'AtlasDataWorkspace'), { message: 'workspace loads on navigation' });
    await page.waitForFunction(() => document.body.dataset.atlasView === 'data', null, { timeout: 8000 });
    await settle(page);
    // The workspace read the summary from the shard; it did not fetch its own.
    assert.equal(summaryFetches(record), 1, 'no duplicate summary fetch after the workspace opens');
  } finally { await app.close(); }
});

test('direct deep-link to #data after a fresh login loads the lazy workspace', { skip }, async () => {
  const app = await launchAtlas({ user: USERS.admin, hash: '#data', fixtures: summaryFixture() });
  const { page } = app;
  try {
    await page.waitForFunction(() => document.body.dataset.atlasView === 'data', null, { timeout: 12000 });
    assert.equal(await globalDefined(page, 'AtlasDataWorkspace'), true, 'workspace loaded for the deep link');
  } finally { await app.close(); }
});

test('returning to Data and rapid repeat navigation never re-download the module', { skip }, async () => {
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: summaryFixture() });
  const { page } = app;
  try {
    await settle(page);
    await navigateTo(page, '#data');
    await until(() => globalDefined(page, 'AtlasDataWorkspace'), { message: 'workspace loads first time' });
    assert.equal(await workspaceScriptCount(page), 1, 'one script after first open');

    await navigateTo(page, '#dashboard');
    await navigateTo(page, '#data');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'data');
    assert.equal(await workspaceScriptCount(page), 1, 'no re-download on return');

    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.AtlasShell.navigate('#data'); });
    await settle(page);
    assert.equal(await workspaceScriptCount(page), 1, 'rapid repeats do not duplicate the download');
  } finally { await app.close(); }
});

test('navigating away while Data is loading does not reopen Data', { skip }, async () => {
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: summaryFixture() });
  const { page } = app;
  try {
    await settle(page);
    // Start loading Data, then immediately leave before the module finishes.
    await page.evaluate(() => { window.AtlasShell.navigate('#data'); window.AtlasShell.navigate('#dashboard'); });
    await until(() => globalDefined(page, 'AtlasDataWorkspace'), { message: 'module still finishes downloading' });
    await settle(page);
    // The late-arriving module must not yank the user back to Data.
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'dashboard', 'stayed on dashboard');
  } finally { await app.close(); }
});

test('a failed workspace download shows an error with a working retry', { skip }, async () => {
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: summaryFixture() });
  const { page } = app;
  try {
    await settle(page);
    // Fail the first fetch of the workspace module, then navigate.
    let fail = true;
    // fallback() (not continue()) defers a non-failing request to the harness's
    // own static-file route, which serves the module.
    await page.route('**/assets/js/data-workspace.js*', (route) => (fail ? route.abort() : route.fallback()));
    await navigateTo(page, '#data');
    // The lazy loader renders its error + retry into the view's placeholder.
    await page.waitForFunction(() => Boolean(document.querySelector('#data-view [data-lazy-retry]')), null, { timeout: 10000 });
    assert.match(await page.evaluate(() => document.querySelector('#data-view [data-lazy-error]')?.textContent || ''), /could not be loaded|try again/i, 'shows a load error');
    assert.equal(await globalDefined(page, 'AtlasDataWorkspace'), false, 'workspace not loaded after a failed download');

    // Allow the retry to succeed; pressing "Try again" loads the module and opens Data.
    fail = false;
    await page.evaluate(() => document.querySelector('#data-view [data-lazy-retry]')?.click());
    await until(() => globalDefined(page, 'AtlasDataWorkspace'), { message: 'retry loads the workspace' });
    await page.waitForFunction(() => document.body.dataset.atlasView === 'data', null, { timeout: 8000 });
  } finally { await app.close(); }
});

for (const [label, user, managerly] of [['admin', USERS.admin, true], ['manager', MANAGER, true], ['bartender', USERS.bartender, false], ['viewer', VIEWER, false]]) {
  test(`role matrix: ${label} ${managerly ? 'sees' : 'does not see'} the Data Home row and badge`, { skip }, async () => {
    const app = await launchAtlas({ user, hash: '', fixtures: { ...summaryFixture(), profiles: [USERS.admin, MANAGER, USERS.bartender, VIEWER] } });
    const { page, record } = app;
    try {
      await settle(page);
      if (managerly) {
        await until(() => Promise.resolve(summaryFetches(record) === 1), { message: `${label} fetches the summary` });
        await page.waitForFunction(() => document.body.innerText.includes('waiting for your approval'), null, { timeout: 8000 });
        assert.equal(await page.evaluate(() => document.querySelector('[data-nav-badge="data"]')?.textContent || ''), '3', `${label} sees the badge`);
      } else {
        // Non-managers: the shard never fetches the manager-only summary, shows no row, no badge.
        await settle(page);
        assert.equal(summaryFetches(record), 0, `${label} does not fetch the manager-only summary`);
        assert.equal(await page.evaluate(() => document.body.innerText.includes('waiting for your approval')), false, `${label} sees no Data row`);
        assert.equal(await page.evaluate(() => document.querySelector('[data-nav-badge="data"]')?.textContent || ''), '', `${label} sees no badge`);
      }
    } finally { await app.close(); }
  });
}
