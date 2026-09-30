// Sign-in brand lockup. The decorative sign-in <video> intro was removed (its
// clip still rendered the old Atlas logo rotation); the sign-in now shows the
// kit's static stacked lockup only. The wrapper keeps data-atlas-signin-intro
// so assets/js/atlas-signin-intro.js still runs and safely no-ops when no
// <video> is present, settling straight to the static lockup. These tests
// assert the static lockup renders (the kit file, byte for byte), that there is
// no <video> in the sign-in screen, and that layout/guards still hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { harnessAvailable, launchAtlas, ROOT, settle } from './harness.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
// The shipped sign-in lockup (the served brand asset). Compared byte for byte
// against what the <img> fetches, so the sign-in always shows the real file.
const LOCKUP_SVG = readFileSync(path.join(ROOT, 'apps/web/assets/brand/Atlas_Primary_Stacked_Midnight.svg'), 'utf8');

const signIn = (options = {}) => launchAtlas({ signedIn: false, waitReady: false, ...options });
const intro = (page) => page.evaluate(() => {
  const root = document.querySelector('[data-atlas-signin-intro]');
  const video = document.querySelector('#login-screen video');
  const lockup = root?.querySelector('.atlas-auth__lockup');
  return {
    present: Boolean(root),
    state: root?.dataset.introState,
    hasVideo: Boolean(video),
    lockupOpacity: lockup ? Number(getComputedStyle(lockup).opacity) : 0,
    lockupSrc: lockup?.getAttribute('src'),
    lockupAlt: lockup?.alt,
    flag: (() => { try { return sessionStorage.getItem('atlas.signinIntro.played.v1'); } catch { return 'unavailable'; } })()
  };
});
const waitForSignIn = (page) => page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown', null, { timeout: 10000 });
const waitStatic = (page) => page.waitForFunction(() => document.querySelector('[data-atlas-signin-intro]')?.dataset.introState === 'static', null, { timeout: 10000 });

test('sign-in shows the static kit lockup (the video intro was removed); no <video>, and it stays static on a second visit', { skip }, async () => {
  const { page, record, close } = await signIn();
  try {
    await waitForSignIn(page);
    // The form is usable at once and keeps focus.
    await page.focus('#email');
    await page.keyboard.type('owner@example.test');
    assert.equal(await page.inputValue('#email'), 'owner@example.test');
    await waitStatic(page);
    await settle(page);
    const state = await intro(page);
    assert.equal(state.present, true, 'the sign-in brand wrapper is present');
    assert.equal(state.hasVideo, false, 'there is no <video> in the sign-in screen');
    assert.equal(state.state, 'static', 'it settles straight to the static lockup');
    assert.equal(state.lockupOpacity, 1, 'the static lockup is visible');
    assert.equal(state.lockupAlt, 'Alcedo');
    assert.equal(state.lockupSrc, 'assets/brand/Atlas_Primary_Stacked_Midnight.svg');
    assert.equal(await page.evaluate(async (src) => (await fetch(src)).text(), state.lockupSrc), LOCKUP_SVG, 'the static logo is the shipped brand file, byte for byte');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'email', 'the sign-in never steals focus');
    // Same browser session, second visit: still static, still no video.
    await page.reload({ waitUntil: 'load' });
    await waitForSignIn(page);
    await waitStatic(page);
    await settle(page);
    const again = await intro(page);
    assert.deepEqual([again.state, again.hasVideo, again.lockupOpacity], ['static', false, 1]);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('reduced motion shows the static lockup and no video', { skip }, async () => {
  const { page, close } = await signIn({ contextOptions: { reducedMotion: 'reduce' } });
  try {
    await waitForSignIn(page);
    await waitStatic(page);
    await settle(page);
    const state = await intro(page);
    assert.deepEqual([state.state, state.hasVideo, state.lockupOpacity, state.flag], ['static', false, 1, null]);
  } finally { await close(); }
});

test('Save-Data and refused autoplay still show the static lockup and never break', { skip }, async () => {
  for (const initScript of [
    () => { HTMLMediaElement.prototype.play = function play() { return Promise.reject(new DOMException('Autoplay refused', 'NotAllowedError')); }; },
    () => { Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true }) }); }
  ]) {
    const { page, record, close } = await signIn({ initScript });
    try {
      await waitForSignIn(page);
      await waitStatic(page);
      await settle(page);
      const state = await intro(page);
      assert.deepEqual([state.state, state.hasVideo, state.lockupOpacity], ['static', false, 1]);
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('at 390 the sign-in stays compact, the form stays above the fold and nothing scrolls sideways', { skip }, async () => {
  const { page, close } = await signIn({ viewport: { width: 390, height: 844 } });
  try {
    await waitForSignIn(page);
    await waitStatic(page);
    const layout = await page.evaluate(() => ({
      stage: document.querySelector('[data-atlas-signin-intro]').getBoundingClientRect().width,
      submit: document.getElementById('login-btn').getBoundingClientRect().bottom,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    assert.ok(layout.stage >= 200 && layout.stage <= 300, `stage ${layout.stage}px`);
    assert.ok(layout.submit <= 844, `Sign in button bottom ${layout.submit}px is below the fold`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, 'no horizontal page scroll');
  } finally { await close(); }
});

test('no sign-in video inside the signed-in app', { skip }, async () => {
  const { page, close } = await launchAtlas();
  try {
    await settle(page);
    const state = await intro(page);
    assert.equal(state.hasVideo, false, 'no sign-in video inside the app');
    if (state.present) assert.equal(state.state, 'static', 'the sign-in wrapper, if present, stays static');
  } finally { await close(); }
});
