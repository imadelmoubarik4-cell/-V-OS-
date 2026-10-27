// Sign-in boot (platform audit M15, L25), in the real shell.
//   * Before atlas-app.js binds the form, an Enter in the password field
//     cannot submit it natively: the button is disabled ("Connecting…") and
//     the form posts, so the credentials never reach the address bar.
//   * supabase-js is preloaded by index.html and the script atlas-app.js
//     inserts reuses that download (one request).
// Frozen clock, no fixed sleeps (tests/browser/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, ORIGIN } from './harness.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

test('M15: before atlas-app.js runs, Enter cannot submit the sign-in form natively', { skip }, async () => {
  const { page, close } = await launchAtlas({ signedIn: false, waitReady: false });
  try {
    // A slow first load: atlas-app.js has not arrived (here: never arrives).
    await page.route('**/assets/js/atlas-app.js*', (route) => route.abort());
    await page.reload({ waitUntil: 'load' });
    const documents = [];
    page.on('request', (request) => { if (request.isNavigationRequest()) documents.push(`${request.method()} ${request.url()}`); });

    const before = await page.evaluate(() => {
      const button = document.getElementById('login-btn');
      const form = document.getElementById('login-form');
      return { disabled: button.disabled, label: button.textContent.trim(), method: form.method, bound: document.documentElement.dataset.atlasSignin === 'shown' };
    });
    assert.deepEqual(before, { disabled: true, label: 'Connecting…', method: 'post', bound: false });

    // The password manager fills the form and the person presses Enter.
    await page.fill('#email', 'owner@example.test');
    await page.fill('#password', 'correct-horse-battery');
    await page.press('#password', 'Enter');
    await page.click('#login-btn', { force: true }).catch(() => {});
    await settle(page);

    assert.deepEqual(documents, [], 'no form navigation');
    const after = await page.evaluate(() => ({ search: location.search, href: location.href, email: document.getElementById('email').value }));
    assert.equal(after.search, '', 'nothing in the query string');
    assert.doesNotMatch(after.href, /password|correct-horse/);
    assert.equal(after.email, 'owner@example.test', 'the page did not reload: the typed details stay');
  } finally { await close(); }
});

test('M15: once atlas-app.js is ready with no session, the button reads Sign in and is enabled', { skip }, async () => {
  const { page, close } = await launchAtlas({ signedIn: false, waitReady: false });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown', null, { timeout: 15000 });
    await page.waitForFunction(() => { const button = document.getElementById('login-btn'); return !button.disabled && button.textContent.trim() === 'Sign in'; });
  } finally { await close(); }
});

test('M15: with a stored session, the button stays disabled until the app shows', { skip }, async () => {
  const { page, close } = await launchAtlas({ signedIn: true, waitReady: false });
  try {
    // A slow profile read after the session is found.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route(/\/rest\/v1\/profiles/, async (route) => { await gate; await route.fallback(); });
    const profileAsked = page.waitForRequest(/\/rest\/v1\/profiles/);
    await page.reload({ waitUntil: 'load' });
    await profileAsked;
    await settle(page);
    const during = await page.evaluate(() => {
      const button = document.getElementById('login-btn');
      return { disabled: button.disabled, label: button.textContent.trim(), app: getComputedStyle(document.getElementById('app-screen')).display };
    });
    assert.deepEqual(during, { disabled: true, label: 'Connecting…', app: 'none' }, 'no enabled sign-in form for a signed-in person');
    release();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('app-screen')).display !== 'none', null, { timeout: 15000 });
  } finally { await close(); }
});

test('L25: supabase-js is preloaded by index.html and downloaded once', { skip }, async () => {
  const { page, close } = await launchAtlas({ signedIn: false, waitReady: false });
  try {
    const downloads = [];
    page.on('request', (request) => { if (/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/.test(request.url())) downloads.push(request.resourceType()); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown', null, { timeout: 15000 });
    await settle(page);
    assert.equal(downloads.length, 1, `one supabase-js download (${downloads.join(', ')})`);
    assert.equal(await page.evaluate(() => typeof window.supabase?.createClient), 'function');
    const hints = await page.evaluate(() => [...document.querySelectorAll('link[rel="preconnect"], link[rel="preload"][as="script"]')].map((link) => `${link.rel} ${link.href}`));
    assert.ok(hints.some((hint) => hint.startsWith('preconnect https://dnefgcmjcgxlynycxkts.supabase.co')));
    assert.ok(hints.some((hint) => hint.startsWith('preload https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/')));
    assert.ok(ORIGIN.startsWith('http'));
  } finally { await close(); }
});
