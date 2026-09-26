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
import { harnessAvailable, launchAtlas, settle, until, USERS, PROJECT_REF } from './harness.mjs';

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

test('a 401 while Auth still accepts the session renews nothing and prompts nothing', { skip }, async () => {
  const { page, record, close } = await launchAtlas();
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status: 401 } })));
    // The check with Auth is asynchronous: wait for it rather than for a settled page.
    await until(async () => record.requests.some((entry) => entry.path === '/auth/v1/user'), { message: 'the session was checked with Auth' });
    await settle(page);
    assert.equal(record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token') && entry.search.includes('grant_type=refresh_token')).length, 0, 'no renewal needed');
    assert.equal(await page.$$eval('.atlas-toast', (nodes) => nodes.filter((n) => /session/i.test(n.textContent)).length), 0, 'no prompt');
    assert.equal(logouts(record).length, 0);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasReady), 'true', 'still signed in');
  } finally { await close(); }
});

test('a 401 with a refused session check renews this device session and stays signed in when renewal works', { skip }, async () => {
  const state = { refused: false };
  const { page, record, close } = await launchAtlas({
    fixtures: { auth: { user: () => (state.refused ? { __status: 401, body: { code: 'bad_jwt', message: 'invalid JWT' } } : null) } }
  });
  try {
    state.refused = true;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status: 401 } })));
    await settle(page);
    assert.ok(record.requests.some((entry) => entry.path.startsWith('/auth/v1/token') && entry.search.includes('grant_type=refresh_token')), 'the session was renewed');
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
      auth: {
        token: (entry) => (state.revoked && entry.search.includes('grant_type=refresh_token') ? { __status: 400, body: { error: 'invalid_grant', error_description: 'Refresh Token Not Found' } } : null),
        user: () => (state.revoked ? { __status: 403, body: { code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' } } : null)
      },
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

// Independent review of S91 (P1-1, P1-2): no renewal storm, and an Auth
// outage never signs anyone out or reloads in a loop.
const keepSignedOut = () => { try { if (sessionStorage.getItem('atlas:harness-signed-out') === '1') localStorage.clear(); } catch { /* storage unavailable */ } };
const tokenRefreshes = (record) => record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token') && entry.search.includes('grant_type=refresh_token')).length;

test('an endpoint that keeps answering 401 after a renewal causes at most one renewal and no sign-out', { skip }, async () => {
  const { page, record, close } = await launchAtlas({
    fixtures: { functions: new Proxy({}, { get: () => () => ({ __status: 401, body: { error: 'unauthorized' } }) }) }
  });
  try {
    // Many modules hit the endpoint repeatedly (the unread badge polls too).
    for (let i = 0; i < 25; i += 1) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status: 401 } })));
    }
    for (const hash of ['#messages', '#reports', '#settings', '#inventory/counts']) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await settle(page);
    }
    assert.ok(tokenRefreshes(record) <= 1, `token refreshes: ${tokenRefreshes(record)}`);
    assert.equal(logouts(record).length, 0, 'nobody is signed out');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('app-screen')).display === 'none'), false, 'still in the app');
  } finally { await close(); }
});

test('when sign-in cannot be checked (Auth unavailable) the session is kept and nothing reloads', { skip, timeout: 120000 }, async () => {
  let loads = 0;
  // Auth becomes unavailable while Atlas is already open.
  const outage = { on: false };
  const { page, record, close } = await launchAtlas({
    // supabase-js retries a refresh that failed with a 5xx for about 30 s,
    // measured on the page clock: this test needs the real clock.
    fixedTime: null,
    fixtures: {
      auth: {
        token: (entry) => (outage.on && entry.search.includes('grant_type=refresh_token') ? { __status: 503, body: { message: 'upstream unavailable' } } : null),
        user: () => (outage.on ? { __status: 503, body: { message: 'upstream unavailable' } } : null)
      },
      functions: new Proxy({}, { get: () => () => (outage.on ? { __status: 401, body: { error: 'unauthorized' } } : {}) })
    }
  });
  page.on('load', () => { loads += 1; });
  outage.on = true;
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status: 401 } })));
    await page.waitForSelector('.atlas-toast:has-text("can’t check your sign-in")', { timeout: 60000 });
    await page.evaluate(() => { location.hash = '#reports'; });
    await settle(page);
    assert.equal(logouts(record).length, 0, 'no logout of any scope');
    assert.equal(loads, 0, 'no reload');
    assert.equal(await storedSession(page), true, 'the session is kept');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('app-screen')).display === 'none'), false);
  } finally { await close(); }
});

test('a deliberate sign-out still signs this device out when Auth cannot be reached', { skip }, async () => {
  const { page, close } = await launchAtlas({
    initScript: keepSignedOut,
    fixtures: { auth: { logout: { __status: 503, body: { message: 'upstream unavailable' } } } }
  });
  try {
    // Whether this device still held a session when the page went away is
    // recorded at pagehide (the harness would put one back on the next load).
    await page.evaluate((key) => {
      try { sessionStorage.setItem('atlas:harness-signed-out', '1'); } catch { /* storage unavailable */ }
      window.addEventListener('pagehide', () => {
        try { sessionStorage.setItem('atlas:harness-had-session', localStorage.getItem(key) ? 'yes' : 'no'); } catch { /* storage unavailable */ }
      });
    }, `sb-${PROJECT_REF}-auth-token`);
    await page.click('#atlas-account-btn');
    await Promise.all([page.waitForEvent('load'), page.click('[data-menu-action="sign-out"]')]);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('atlas:harness-had-session')), 'no', 'the stored session was removed before the reload');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('login-screen')).display !== 'none', null, { timeout: 15000 });
  } finally { await close(); }
});

test('signing out on purpose in one tab signs the other tab out without a "session ended" notice', { skip }, async () => {
  const { page, close } = await launchAtlas({ initScript: keepSignedOut });
  try {
    const other = await page.context().newPage();
    await other.goto(page.url());
    await other.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
    for (const tab of [page, other]) await tab.evaluate(() => { try { sessionStorage.setItem('atlas:harness-signed-out', '1'); } catch { /* storage unavailable */ } });
    const otherReload = other.waitForEvent('load', { timeout: 15000 });
    await page.click('#atlas-account-btn');
    await Promise.all([page.waitForEvent('load'), page.click('[data-menu-action="sign-out"]')]);
    await otherReload;
    // Right after its reload the other tab shows sign-in, without the notice
    // (later, the harness would restore its fixture session).
    const state = await other.evaluate(() => ({ login: getComputedStyle(document.getElementById('login-screen')).display, notice: document.getElementById('login-error')?.textContent || '' }));
    assert.notEqual(state.login, 'none', 'the other tab is at sign-in');
    assert.doesNotMatch(state.notice, /session ended/i, 'no "session ended" notice in the other tab');
  } finally { await close(); }
});
