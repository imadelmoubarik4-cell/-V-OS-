// S96 (webstore): Atlas runs under the production Content-Security-Policy
// (netlify.toml) with no script-src violation, and markup injected into the
// page cannot run script: an inline handler is refused by the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS, ORIGIN } from './harness.mjs';
import { compositeWorld } from './composite-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const watchViolations = () => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => window.__cspViolations.push(`${event.effectiveDirective} ${event.blockedURI}`));
};

test('the app boots and every main view renders under the production CSP', { skip }, async () => {
  for (const [group, routes] of [['A', ['#home', '#operations', '#settings', '#ai']], ['INV', ['#inventory', '#purchasing']], ['C', ['#recipes', '#reports/overview', '#marketing', '#data']], ['P', ['#messages', '#shifts', '#team', '#knowledge']]]) {
    // waitReady: 'none' — the harness's readiness wait uses page.waitForFunction,
    // whose in-page polling needs 'unsafe-eval', which the production CSP forbids.
    // Wait via waitForSelector/until instead (CDP DOM + page.evaluate, no eval).
    const { page, record, close } = await launchAtlas({ fixtures: compositeWorld(USERS.admin, { group }), enforceCsp: true, waitReady: 'none', initScript: watchViolations });
    try {
      await page.waitForSelector('body[data-atlas-ready="true"]', { timeout: 15000 });
      assert.ok(await page.evaluate(() => Boolean(window.atlasSupabase && window.AtlasShell)), 'start-up script ran');
      for (const route of routes) {
        await navigateTo(page, route);
        assert.equal(await page.evaluate(() => document.body.dataset.atlasView === 'not-found'), false, route);
      }
      if (routes.includes('#team')) await until(() => page.evaluate(() => Boolean(window.AtlasTeamProfiles)), { timeout: 10000, message: 'team profiles' });
      const violations = await page.evaluate(() => window.__cspViolations.filter((entry) => entry.startsWith('script-src')));
      assert.deepEqual(violations, [], `${group}: script-src violations`);
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('injected inline handlers do not run under the production CSP', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: compositeWorld(USERS.admin, { group: 'A' }), enforceCsp: true, waitReady: 'none', initScript: watchViolations });
  try {
    await page.waitForSelector('body[data-atlas-ready="true"]', { timeout: 15000 });
    await page.evaluate(() => {
      window.__ran = false;
      const host = document.createElement('div');
      host.innerHTML = '<img src="data:," onerror="window.__ran = true"><svg onload="window.__ran = true"></svg>';
      document.body.appendChild(host);
    });
    await settle(page);
    assert.equal(await page.evaluate(() => window.__ran), false, 'an injected inline handler ran');
    assert.ok((await page.evaluate(() => window.__cspViolations)).some((entry) => entry.startsWith('script-src')), 'the browser reported the refused handler');
  } finally { await close(); }
});

test('the public menu renders under the production CSP', { skip }, async () => {
  const { page, context, close } = await launchAtlas({ signedIn: false, waitReady: false, enforceCsp: true, initScript: watchViolations, fixtures: { tables: { public_menu: [{ id: 1, name: 'Negroni', type: 'cocktail', menu_price: 2500 }] } } });
  try {
    await page.goto(`${ORIGIN}/menu.html`, { waitUntil: 'load' });
    await page.waitForSelector('.menu-item');
    assert.match(await page.textContent('.menu-item .name'), /Negroni/);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations.filter((entry) => entry.startsWith('script-src'))), []);
  } finally { await close(); }
});
