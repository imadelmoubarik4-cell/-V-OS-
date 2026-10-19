// Lazy views: a workspace module registered via AtlasShell.registerLazyView
// (config.js) must NOT load at boot, and must load on first navigation to its view,
// after which the destination renders normally. Bookings is the first such view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { bookingsWorld } from './bookings-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

const globalDefined = (page, name) => page.evaluate((n) => typeof window[n] !== 'undefined', name);

test('a lazy view does not load at boot and loads on first navigation', { skip }, async () => {
  const world = bookingsWorld();
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: world.fixtures });
  const { page } = app;
  try {
    await settle(page);
    // Booted on Home: the bookings module has not been fetched, and the shell knows
    // 'bookings' as a lazy view rather than a registered one.
    assert.equal(await globalDefined(page, 'AtlasBookings'), false, 'AtlasBookings is not loaded at boot');
    assert.equal(await page.evaluate(() => Boolean(window.AtlasShell.view('bookings'))), false, 'bookings is not registered at boot');

    // Navigating to #bookings downloads the module; it registers and the view opens.
    await navigateTo(page, '#bookings');
    await until(() => globalDefined(page, 'AtlasBookings'), { message: 'AtlasBookings loads on navigation' });
    await page.waitForFunction(() => document.body.dataset.atlasView === 'bookings', null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => Boolean(window.AtlasShell.view('bookings'))), true, 'bookings registered after navigation');
  } finally { await app.close(); }
});

test('a lazy view loads on a direct deep-link boot to its route', { skip }, async () => {
  const world = bookingsWorld();
  const app = await launchAtlas({ user: USERS.admin, hash: '#bookings', fixtures: world.fixtures });
  const { page } = app;
  try {
    // Deep-linking straight to #bookings still resolves to the bookings view once
    // its lazily-loaded module registers (the pending navigation replays).
    await page.waitForFunction(() => document.body.dataset.atlasView === 'bookings', null, { timeout: 12000 });
    assert.equal(await globalDefined(page, 'AtlasBookings'), true, 'AtlasBookings loaded for the deep link');
  } finally { await app.close(); }
});
