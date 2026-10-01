// S99 client-side login abuse hardening (sign-in + password recovery).
//   * Double-submit stays blocked while a sign-in request is in flight
//     (the submit button is disabled; a second click cannot land).
//   * After 5 consecutive bad-credential failures a cooldown engages: the
//     button is disabled and a calm, polite countdown is shown.
//   * A successful sign-in clears the failed-attempt counter.
//   * A 503 (connectivity blip) never counts toward the lockout.
//   * CAPTCHA is OWNER-GATED: with the flag off the sign-in / reset request
//     shape is unchanged (no captchaToken); with it on a token is threaded.
// Real apps/web shell + real supabase-js, mocked backend, no sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, until, ORIGIN, USERS } from './harness.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

const BAD_CREDS = { __status: 400, body: { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' } };
const UPSTREAM_DOWN = { __status: 503, body: { message: 'upstream unavailable' } };

const passwordGrants = (record) => record.requests.filter((entry) => entry.path.startsWith('/auth/v1/token') && (entry.search || '').includes('grant_type=password'));
const recoverRequests = (record) => record.requests.filter((entry) => entry.path.endsWith('/auth/v1/recover'));
const throttleState = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('atlas:login-throttle.v1') || 'null'); } catch { return null; } });

async function awaitSigninReady(page) {
  await page.waitForFunction(() => {
    const button = document.getElementById('login-btn');
    return Boolean(button) && !button.disabled && button.textContent.trim() === 'Sign in';
  }, null, { timeout: 15000 });
}

// Turns the captcha feature on from the owner's config and stubs the provider
// widget so no real CDN/iframe is needed. The config object is augmented as it
// is assigned, before atlas-app.js / account-recovery.js read it.
const enableCaptchaInitScript = () => {
  let value;
  Object.defineProperty(window, 'VABAR_CONFIG', {
    configurable: true,
    get() { return value; },
    set(next) {
      if (next && typeof next === 'object') { next.AUTH_CAPTCHA_PROVIDER = 'hcaptcha'; next.AUTH_CAPTCHA_SITE_KEY = 'test-site-key'; }
      value = next;
    }
  });
  window.hcaptcha = { render: (element, options) => { options.callback('test-token-123'); return 1; }, reset() {}, remove() {} };
};

test('a sign-in in flight disables the button, blocking a double-submit', { skip }, async () => {
  let releaseToken = () => {};
  const tokenGate = new Promise((resolve) => { releaseToken = resolve; });
  const { page, record, close } = await launchAtlas({
    signedIn: false,
    fixtures: { auth: { token: async (entry) => { if ((entry.search || '').includes('grant_type=password')) { await tokenGate; return BAD_CREDS; } return null; } } }
  });
  try {
    await awaitSigninReady(page);
    await page.fill('#email', 'owner@example.test');
    await page.fill('#password', 'whatever-123');
    await page.click('#login-btn');
    await page.waitForFunction(() => {
      const button = document.getElementById('login-btn');
      return button.disabled && button.getAttribute('aria-busy') === 'true';
    }, null, { timeout: 5000 });
    // A second click cannot land on the disabled button (actionability times out).
    const second = await page.click('#login-btn', { timeout: 800 }).then(() => 'clicked').catch(() => 'blocked');
    assert.equal(second, 'blocked', 'the disabled button blocks the second submit');
    releaseToken();
    await settle(page);
    assert.equal(passwordGrants(record).length, 1, 'exactly one sign-in request was sent');
  } finally { await close(); }
});

test('five bad-credential attempts engage a cooldown and disable the button', { skip }, async () => {
  const { page, record, close } = await launchAtlas({
    signedIn: false,
    fixtures: { auth: { token: (entry) => ((entry.search || '').includes('grant_type=password') ? BAD_CREDS : null) } }
  });
  try {
    await awaitSigninReady(page);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await page.waitForFunction(() => !document.getElementById('login-btn').disabled, null, { timeout: 5000 });
      await page.fill('#email', 'owner@example.test');
      await page.fill('#password', `wrong-${attempt}`);
      await page.click('#login-btn');
      await until(async () => passwordGrants(record).length === attempt, { message: `grant ${attempt}` });
      await settle(page);
    }
    // The 5th failure crosses the threshold: button disabled, calm countdown shown.
    await page.waitForFunction(() => {
      const button = document.getElementById('login-btn');
      const cooldown = document.getElementById('login-cooldown');
      return button.disabled && !cooldown.hidden && /try again in \d+s/i.test(cooldown.textContent || '');
    }, null, { timeout: 5000 });
    const cooldown = await page.getAttribute('#login-cooldown', 'aria-live');
    assert.equal(cooldown, 'polite', 'the countdown is a polite live region');
    const state = await throttleState(page);
    assert.ok(state && state.fails >= 5, `throttle persisted (${JSON.stringify(state)})`);
    assert.ok(state.until > 0, 'a cooldown deadline is persisted');
    assert.equal(passwordGrants(record).length, 5, 'no attempt slipped through the cooldown');
  } finally { await close(); }
});

test('a 503 connectivity error never counts toward the lockout', { skip }, async () => {
  const { page, record, close } = await launchAtlas({
    signedIn: false,
    fixtures: { auth: { token: (entry) => ((entry.search || '').includes('grant_type=password') ? UPSTREAM_DOWN : null) } }
  });
  try {
    await awaitSigninReady(page);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await page.waitForFunction(() => !document.getElementById('login-btn').disabled, null, { timeout: 5000 });
      await page.fill('#email', 'owner@example.test');
      await page.fill('#password', `offline-${attempt}`);
      await page.click('#login-btn');
      await until(async () => passwordGrants(record).length === attempt, { message: `grant ${attempt}` });
      await settle(page);
    }
    assert.equal(await page.evaluate(() => document.getElementById('login-btn').disabled), false, 'the button is never disabled by a connectivity blip');
    assert.equal(await page.evaluate(() => document.getElementById('login-cooldown').hidden), true, 'no cooldown countdown');
    assert.equal(await throttleState(page), null, 'nothing is counted toward the lockout');
  } finally { await close(); }
});

test('a successful sign-in clears the failed-attempt counter', { skip }, async () => {
  const state = { mode: 'bad' };
  const { page, record, close } = await launchAtlas({
    signedIn: false,
    fixtures: { auth: { token: (entry) => ((entry.search || '').includes('grant_type=password') && state.mode === 'bad' ? BAD_CREDS : null) } }
  });
  try {
    await awaitSigninReady(page);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.waitForFunction(() => !document.getElementById('login-btn').disabled, null, { timeout: 5000 });
      await page.fill('#email', 'owner@example.test');
      await page.fill('#password', `wrong-${attempt}`);
      await page.click('#login-btn');
      await until(async () => passwordGrants(record).length === attempt, { message: `grant ${attempt}` });
      await settle(page);
    }
    assert.ok((await throttleState(page))?.fails === 3, 'three failures are counted');
    state.mode = 'ok';
    await page.fill('#email', USERS.admin.email);
    await page.fill('#password', 'correct horse battery');
    await page.click('#login-btn');
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
    assert.equal(await throttleState(page), null, 'the counter is cleared on success');
  } finally { await close(); }
});

test('CAPTCHA off (default): the sign-in request carries no captchaToken', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ signedIn: false });
  try {
    await awaitSigninReady(page);
    assert.equal(await page.evaluate(() => document.getElementById('login-captcha').hidden), true, 'no widget renders');
    await page.fill('#email', USERS.admin.email);
    await page.fill('#password', 'correct horse battery');
    await page.click('#login-btn');
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
    const grant = passwordGrants(record).at(-1);
    assert.ok(grant, 'a sign-in request was sent');
    assert.equal(grant.body?.gotrue_meta_security?.captcha_token, undefined, 'no captcha token is threaded');
  } finally { await close(); }
});

test('CAPTCHA on: the provider token is threaded into the sign-in request', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ signedIn: false, initScript: enableCaptchaInitScript });
  try {
    await awaitSigninReady(page);
    await page.waitForFunction(() => document.getElementById('login-captcha').hidden === false, null, { timeout: 5000 });
    await page.fill('#email', USERS.admin.email);
    await page.fill('#password', 'correct horse battery');
    await page.click('#login-btn');
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
    const grant = passwordGrants(record).at(-1);
    assert.equal(grant.body?.gotrue_meta_security?.captcha_token, 'test-token-123', 'the captcha token is threaded');
  } finally { await close(); }
});

test('password recovery: CAPTCHA off sends no token, on threads one', { skip }, async () => {
  // Off (default config).
  const off = await launchAtlas({ signedIn: false });
  try {
    await off.page.goto(`${ORIGIN}/recovery.html`, { waitUntil: 'load' });
    await off.page.waitForSelector('#request-recovery');
    await off.page.fill('#recovery-email', 'owner@example.test');
    await off.page.click('#request-recovery button[type="submit"]');
    await until(async () => recoverRequests(off.record).length === 1, { message: 'reset request (off)' });
    const body = recoverRequests(off.record).at(-1).body;
    assert.equal(body?.gotrue_meta_security?.captcha_token, undefined, 'no captcha token when off');
    assert.equal(await off.page.evaluate(() => document.getElementById('recovery-captcha').hidden), true, 'no widget when off');
  } finally { await off.close(); }

  // On (owner-enabled provider + stubbed widget).
  const on = await launchAtlas({ signedIn: false, initScript: enableCaptchaInitScript });
  try {
    await on.page.goto(`${ORIGIN}/recovery.html`, { waitUntil: 'load' });
    await on.page.waitForFunction(() => document.getElementById('recovery-captcha')?.hidden === false, null, { timeout: 5000 });
    await on.page.fill('#recovery-email', 'owner@example.test');
    await on.page.click('#request-recovery button[type="submit"]');
    await until(async () => recoverRequests(on.record).length === 1, { message: 'reset request (on)' });
    const body = recoverRequests(on.record).at(-1).body;
    assert.equal(body?.gotrue_meta_security?.captcha_token, 'test-token-123', 'captcha token threaded when on');
  } finally { await on.close(); }
});
