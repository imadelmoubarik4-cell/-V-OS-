// Lazy views: a workspace module registered via AtlasShell.registerLazyView
// (config.js) must NOT load at boot, and must load on first navigation to its view,
// after which the destination renders normally. Bookings is the first such view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { bookingsWorld, TODAY } from './bookings-fixtures.mjs';
import { knowledgeBackend, peopleFunctions, NOW } from './people-fixtures.mjs';
import { trainingBackend } from './training-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

const globalDefined = (page, name) => page.evaluate((n) => typeof window[n] !== 'undefined', name);
const bookingScriptCount = (page) => page.evaluate(() => document.querySelectorAll('script[src*="bookings-workspace"]').length);

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

for (const [label, hash] of [['manager config', '#bookings/config'], ['a dated day', `#bookings/${TODAY}`]]) {
  test(`a direct deep-link to ${label} resolves to the lazily-loaded bookings view`, { skip }, async () => {
    const world = bookingsWorld();
    const app = await launchAtlas({ user: USERS.admin, hash, fixtures: world.fixtures });
    const { page } = app;
    try {
      await page.waitForFunction(() => document.body.dataset.atlasView === 'bookings', null, { timeout: 12000 });
      assert.equal(await globalDefined(page, 'AtlasBookings'), true, `AtlasBookings loaded for ${hash}`);
      assert.equal(await page.evaluate(() => (location.hash || '').startsWith('#bookings')), true, 'stays on a bookings route');
    } finally { await app.close(); }
  });
}

test('Training is lazy too: absent at boot, loads on a direct deep-link to #knowledge/training', { skip }, async () => {
  const kn = knowledgeBackend({ user: USERS.admin });
  const tr = trainingBackend({ lessons: [] });
  const fixtures = { functions: peopleFunctions({ 'atlas-knowledge': kn.handler, 'atlas-training': tr.handler }) };
  // Boot on Home: Training must not be fetched yet.
  const home = await launchAtlas({ user: USERS.admin, hash: '', fixedTime: new Date(NOW), fixtures });
  try {
    await settle(home.page);
    assert.equal(await globalDefined(home.page, 'AtlasTraining'), false, 'AtlasTraining not loaded at boot');
  } finally { await home.close(); }
  // Deep-link straight to #knowledge/training resolves to the lazily-loaded training view.
  const deep = await launchAtlas({ user: USERS.admin, hash: '#knowledge/training', fixedTime: new Date(NOW), fixtures });
  try {
    await deep.page.waitForFunction(() => document.body.dataset.atlasView === 'training', null, { timeout: 12000 });
    assert.equal(await globalDefined(deep.page, 'AtlasTraining'), true, 'AtlasTraining loaded for the deep link');
  } finally { await deep.close(); }
});

test('returning to Bookings and rapid repeat navigation never re-download the module', { skip }, async () => {
  const world = bookingsWorld();
  const app = await launchAtlas({ user: USERS.admin, hash: '', fixtures: world.fixtures });
  const { page } = app;
  try {
    await settle(page);
    await navigateTo(page, '#bookings');
    await until(() => globalDefined(page, 'AtlasBookings'), { message: 'bookings loads first time' });
    assert.equal(await bookingScriptCount(page), 1, 'one script after first open');

    // Leave and come back: already registered, so no second download or re-init.
    await navigateTo(page, '#dashboard');
    await navigateTo(page, '#bookings');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'bookings');
    assert.equal(await bookingScriptCount(page), 1, 'no re-download on return');

    // Rapid repeated navigations to the same view add no further script tags.
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.AtlasShell.navigate('#bookings'); });
    await settle(page);
    assert.equal(await bookingScriptCount(page), 1, 'rapid repeats do not duplicate the download');
  } finally { await app.close(); }
});
