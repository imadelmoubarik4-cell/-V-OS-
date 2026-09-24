// Brand v1.0 sign-in logo intro (docs/brand/README.md, "Sign-in motion";
// assets/js/atlas-signin-intro.js): plays once per browser session, muted and
// decorative, then settles on the kit's static stacked lockup. Never plays with
// reduced motion, Save-Data or refused autoplay, never inside the app, never
// holds the form back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { harnessAvailable, launchAtlas, ROOT } from './harness.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const KIT_LOCKUP = readFileSync(path.join(ROOT, 'docs/brand/Atlas_Brand_Identity_Kit_v1.0/02_Vector_Logos/Atlas_Primary_Stacked_Midnight.svg'), 'utf8');

const signIn = (options = {}) => launchAtlas({ signedIn: false, waitReady: false, ...options });
const intro = (page) => page.evaluate(() => {
  const root = document.querySelector('[data-atlas-signin-intro]');
  const video = root.querySelector('video');
  const lockup = root.querySelector('.atlas-auth__lockup');
  return {
    state: root.dataset.introState,
    hidden: video.hidden,
    played: video.played.length,
    currentTime: video.currentTime,
    muted: video.muted && video.hasAttribute('muted'),
    loop: video.loop,
    controls: video.controls,
    ariaHidden: video.getAttribute('aria-hidden'),
    lockupOpacity: Number(getComputedStyle(lockup).opacity),
    lockupSrc: lockup.getAttribute('src'),
    lockupAlt: lockup.alt,
    flag: (() => { try { return sessionStorage.getItem('atlas.signinIntro.played.v1'); } catch { return 'unavailable'; } })()
  };
});
const waitForSignIn = (page) => page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown', null, { timeout: 10000 });

test('sign-in intro plays once, muted, never loops, then settles on the kit lockup; a second visit is static', { skip }, async () => {
  const { page, record, close } = await signIn();
  try {
    await waitForSignIn(page);
    // The form is usable at once, whatever the intro is doing.
    await page.focus('#email');
    await page.keyboard.type('owner@example.test');
    assert.equal(await page.inputValue('#email'), 'owner@example.test');
    await page.waitForFunction(() => document.querySelector('[data-atlas-signin-intro]').dataset.introState === 'playing', null, { timeout: 10000 });
    const playing = await intro(page);
    assert.equal(playing.muted, true);
    assert.equal(playing.loop, false);
    assert.equal(playing.controls, false);
    assert.equal(playing.ariaHidden, 'true');
    assert.equal(playing.flag, '1');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'email', 'the intro never steals focus');
    // Plays through once and settles on the static lockup.
    await page.waitForFunction(() => document.querySelector('[data-atlas-signin-intro]').dataset.introState === 'static', null, { timeout: 20000 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-auth__brand--intro .atlas-auth__lockup')).opacity === '1', null, { timeout: 2000 });
    const settled = await intro(page);
    assert.equal(settled.hidden, true);
    assert.equal(settled.lockupOpacity, 1);
    assert.equal(settled.lockupAlt, 'Atlas');
    assert.equal(settled.lockupSrc, 'assets/brand/Atlas_Primary_Stacked_Midnight.svg');
    assert.equal(await page.evaluate(async (src) => (await fetch(src)).text(), settled.lockupSrc), KIT_LOCKUP, 'the static logo is the kit file, byte for byte');
    // Same browser session: static immediately, the clip never starts.
    await page.reload({ waitUntil: 'load' });
    await waitForSignIn(page);
    await page.waitForTimeout(600);
    const again = await intro(page);
    assert.deepEqual([again.state, again.hidden, again.played, again.lockupOpacity], ['static', true, 0, 1]);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('reduced motion shows the static lockup and never plays the clip', { skip }, async () => {
  const { page, close } = await signIn({ contextOptions: { reducedMotion: 'reduce' } });
  try {
    await waitForSignIn(page);
    await page.waitForTimeout(800);
    const state = await intro(page);
    assert.deepEqual([state.state, state.hidden, state.played, state.currentTime, state.lockupOpacity, state.flag], ['static', true, 0, 0, 1, null]);
  } finally { await close(); }
});

test('refused autoplay and Save-Data fall back to the static lockup', { skip }, async () => {
  for (const initScript of [
    () => { HTMLMediaElement.prototype.play = function play() { return Promise.reject(new DOMException('Autoplay refused', 'NotAllowedError')); }; },
    () => { Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true }) }); }
  ]) {
    const { page, record, close } = await signIn({ initScript });
    try {
      await waitForSignIn(page);
      await page.waitForTimeout(800);
      const state = await intro(page);
      assert.deepEqual([state.state, state.hidden, state.lockupOpacity, state.flag], ['static', true, 1, null]);
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('at 390 the intro stays compact, the form stays above the fold and nothing scrolls sideways', { skip }, async () => {
  const { page, close } = await signIn({ viewport: { width: 390, height: 844 } });
  try {
    await waitForSignIn(page);
    await page.waitForFunction(() => document.querySelector('[data-atlas-signin-intro]').dataset.introState === 'playing', null, { timeout: 10000 });
    const layout = await page.evaluate(() => ({
      stage: document.querySelector('[data-atlas-signin-intro]').getBoundingClientRect().width,
      submit: document.getElementById('login-btn').getBoundingClientRect().bottom,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    assert.ok(layout.stage >= 240 && layout.stage <= 280, `stage ${layout.stage}px`);
    assert.ok(layout.submit <= 844, `Sign in button bottom ${layout.submit}px is below the fold`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, 'no horizontal page scroll');
  } finally { await close(); }
});

test('the intro never plays inside the signed-in app', { skip }, async () => {
  const { page, close } = await launchAtlas();
  try {
    await page.waitForTimeout(500);
    const state = await intro(page);
    assert.deepEqual([state.state, state.hidden, state.played, state.flag], ['static', true, 0, null]);
    assert.equal(await page.evaluate(() => document.querySelector('[data-atlas-signin-intro] video').preload), 'none');
  } finally { await close(); }
});
