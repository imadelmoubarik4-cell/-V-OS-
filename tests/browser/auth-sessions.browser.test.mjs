// One person, several devices (production smoke test, 25 Sep): nothing that
// happens on one device may end the session on another.
//   * Sign out (account menu, the "session ended" prompt, an inactive
//     profile) ends this device's session only: /auth/v1/logout?scope=local.
//     supabase-js defaults to scope=global, which revokes every session of
//     the account; that is what signed the owner's desktop out when the
//     phone was used.
//   * A staff profile that cannot be read (connection or server problem)
//     keeps the session and offers a retry; it never signs out.
//   * A 401 first renews this device's session; the sign-in prompt appears
//     only when the session is really gone.
// Mocked backend (real supabase-js), frozen harness clock, no sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, USERS, PROJECT_REF } from './harness.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const logouts = (record) => record.requests.filter((entry) => entry.path.startsWith('/auth/v1/logout'));
const scopeOf = (entry) => new URLSearchParams(entry.search || '').get('scope');
const storedSession = (page) => page.evaluate((key) => { try { return Boolean(localStorage.getItem(key)); } catch { return false; } }, `sb-${PROJECT_REF}-auth-token`);

test('signing out from the account menu ends this device only (scope=local)', { skip }, async () => {
  const { page, record, close } = await launchAtlas();
  try {
    await page.click('#atlas-account-btn');
    await Promise.all([page.waitForEvent('load'), page.click('[data-menu-action="sign-out"]')]);
    const calls = logouts(record);
    assert.equal(calls.length, 1, 'one logout request');
    assert.equal(scopeOf(calls[0]), 'local', 'never scope=global from the app');
  } finally { await close(); }
});

test('a staff profile that cannot be read keeps the session and offers a retry', { skip }, async () => {
  const { page, record, close } = await launchAtlas({
    waitReady: 'none',
    fixtures: { profiles: () => ({ __status: 503, body: { message: 'upstream unavailable' } }) }
  });
  try {
    await page.waitForFunction(() => document.getElementById('login-btn')?.textContent.trim() === 'Retry connection', null, { timeout: 15000 });
    await settle(page);
    assert.equal(logouts(record).length, 0, 'no logout request of any scope');
    assert.equal(await storedSession(page), true, 'the saved session is kept');
    assert.match(await page.textContent('#login-error'), /couldn.t connect/i);
    // Retry re-runs start-up; it does not submit an empty sign-in form.
    const tokenGrantsBefore = record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token')).length;
    await Promise.all([page.waitForEvent('load'), page.click('#login-btn')]);
    assert.equal(record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token') && entry.search.includes('grant_type=password')).length, 0, 'no password sign-in was attempted');
    assert.ok(record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token')).length >= tokenGrantsBefore);
  } finally { await close(); }
});

test('an inactive staff profile clears this device only', { skip }, async () => {
  const { page, record, close } = await launchAtlas({
    waitReady: 'none',
    fixtures: { profiles: [{ ...USERS.admin, active: false }] }
  });
  try {
    await page.waitForFunction(() => /not an active/i.test(document.getElementById('login-error')?.textContent || ''), null, { timeout: 15000 });
    const calls = logouts(record);
    assert.equal(calls.length, 1);
    assert.equal(scopeOf(calls[0]), 'local');
  } finally { await close(); }
});

test('a 401 first renews this device session; no sign-in prompt when renewal works', { skip }, async () => {
  const { page, record, close } = await launchAtlas();
  try {
    const before = record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token')).length;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status: 401 } })));
    await settle(page);
    const refreshes = record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token') && entry.search.includes('grant_type=refresh_token'));
    assert.ok(refreshes.length >= 1 && record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token')).length > before, 'the session was renewed');
    assert.equal(await page.$$eval('.atlas-toast', (nodes) => nodes.filter((n) => /session has ended/i.test(n.textContent)).length), 0, 'no sign-in prompt');
    assert.equal(logouts(record).length, 0);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasReady), 'true', 'still signed in');
  } finally { await close(); }
});

test('a session ended elsewhere: one sign-in screen, this device only, and everything reloads after signing in', { skip }, async () => {
  // Revocation is simulated from the moment the test flips `revoked`: token
  // refreshes are refused and Edge Functions answer 401 (session_not_found).
  const state = { revoked: false };
  const { page, record, close } = await launchAtlas({
    // The harness restores the saved session on every page load; once this
    // device has been signed out, keep it signed out (as a real browser would).
    initScript: () => { try { if (sessionStorage.getItem('atlas:harness-signed-out') === '1') localStorage.clear(); } catch { /* storage unavailable */ } },
    fixtures: {
      auth: { token: (entry) => (state.revoked && entry.search.includes('grant_type=refresh_token') ? { __status: 400, body: { error: 'invalid_grant', error_description: 'Refresh Token Not Found' } } : null) },
      functions: new Proxy({}, { get: () => (entry) => (state.revoked ? { __status: 401, body: { error: 'unauthorized' } } : {}) })
    }
  });
  try {
    for (const hash of ['#inventory', '#recipes']) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await settle(page);
    }
    state.revoked = true;
    await page.evaluate(() => { try { sessionStorage.setItem('atlas:harness-signed-out', '1'); } catch { /* storage unavailable */ } });
    // Any authenticated request now fails; the next one decides the state.
    await Promise.all([
      page.waitForEvent('load', { timeout: 15000 }),
      page.evaluate(() => { location.hash = '#reports'; })
    ]);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('login-screen')).display !== 'none'
      && /session ended/i.test(document.getElementById('login-error')?.textContent || ''), null, { timeout: 15000 });
    // One consistent state: the app shell is gone, not half signed in.
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('app-screen')).display), 'none');
    assert.equal(await page.evaluate(() => location.hash), '#reports', 'the page to return to is kept');
    assert.equal(await page.evaluate(() => document.getElementById('email').getAttribute('aria-invalid')), null, 'a notice, not a field error');
    const calls = logouts(record);
    assert.ok(calls.every((entry) => scopeOf(entry) === 'local'), `only this device: ${calls.map((c) => c.search).join(', ')}`);

    // Sign in again: the session is valid and every module loads fresh.
    state.revoked = false;
    await page.evaluate(() => { try { sessionStorage.removeItem('atlas:harness-signed-out'); } catch { /* storage unavailable */ } });
    await page.fill('#email', USERS.admin.email);
    await page.fill('#password', 'correct horse battery');
    await page.click('#login-btn');
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => location.hash), '#reports', 'back where the person was');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('app-screen')).display === 'none'), false);
  } finally { await close(); }
});

test('signing out on purpose shows no "session ended" notice', { skip }, async () => {
  const { page, close } = await launchAtlas({
    initScript: () => { try { if (sessionStorage.getItem('atlas:harness-signed-out') === '1') localStorage.clear(); } catch { /* storage unavailable */ } }
  });
  try {
    await page.evaluate(() => { try { sessionStorage.setItem('atlas:harness-signed-out', '1'); } catch { /* storage unavailable */ } });
    await page.click('#atlas-account-btn');
    await Promise.all([page.waitForEvent('load'), page.click('[data-menu-action="sign-out"]')]);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('login-screen')).display !== 'none', null, { timeout: 15000 });
    await settle(page);
    assert.doesNotMatch(await page.textContent('#login-error'), /session ended/i);
  } finally { await close(); }
});
