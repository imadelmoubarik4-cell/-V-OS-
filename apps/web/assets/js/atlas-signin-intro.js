// Brand v1.0 sign-in intro (docs/brand/README.md, "Sign-in motion").
//
// The owner's logo motion plays on the sign-in screen only, at most once per
// browser session, muted, never looped, then crossfades to the kit's static
// stacked lockup. It never plays with reduced motion (system setting or
// html.atlas-reduce-motion), with Save-Data, when session storage is
// unavailable (so "once" cannot be kept) or when autoplay is refused; the
// static lockup shows instead. The form never waits for it.
//
// index.html calls AtlasSignInIntro.start() once it knows there is no session
// (and marks <html data-atlas-signin="shown"> in case this file loads later).
(function () {
  'use strict';

  const KEY = 'atlas.signinIntro.played.v1';
  const SETTLE_MS = 400;
  const MAX_MS = 15000; // a stalled clip never holds the static logo back
  const root = document.querySelector('[data-atlas-signin-intro]');
  const video = root?.querySelector('video');
  let started = false;
  let finished = false;
  let guard = 0;

  const reducedMotion = () => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
        || document.documentElement.classList.contains('atlas-reduce-motion');
    } catch { return true; }
  };
  const saveData = () => Boolean(navigator.connection && navigator.connection.saveData);
  const alreadyPlayed = () => {
    try { return window.sessionStorage.getItem(KEY) === '1'; } catch { return true; }
  };
  const markPlayed = () => {
    try { window.sessionStorage.setItem(KEY, '1'); } catch { /* checked before playing */ }
  };
  const loginVisible = () => {
    const login = document.getElementById('login-screen');
    return Boolean(login) && window.getComputedStyle(login).display !== 'none';
  };

  function setState(state) {
    if (root) root.dataset.introState = state;
  }

  // The static kit lockup, now and for the rest of this page.
  function showStatic() {
    finished = true;
    window.clearTimeout(guard);
    setState('static');
    if (!video) return;
    try { video.pause(); } catch { /* not started */ }
    video.autoplay = false;
    video.hidden = true;
  }

  function settle() {
    if (finished) return;
    if (reducedMotion()) { showStatic(); return; }
    setState('settling');
    window.setTimeout(showStatic, SETTLE_MS);
  }

  function start() {
    if (started || !root) return;
    started = true;
    if (!video || typeof video.play !== 'function' || reducedMotion() || saveData() || alreadyPlayed() || !loginVisible()) {
      showStatic();
      return;
    }
    video.muted = true;
    video.defaultMuted = true;
    video.loop = false;
    video.preload = 'auto';
    video.autoplay = true;
    video.hidden = false;
    setState('loading');
    video.addEventListener('playing', () => { if (!finished) { markPlayed(); setState('playing'); } }, { once: true });
    video.addEventListener('ended', settle, { once: true });
    video.addEventListener('error', showStatic, { once: true });
    const sources = video.querySelectorAll('source');
    sources[sources.length - 1]?.addEventListener('error', showStatic, { once: true });
    guard = window.setTimeout(settle, MAX_MS);
    let attempt;
    try { attempt = video.play(); } catch { showStatic(); return; }
    if (attempt && typeof attempt.catch === 'function') attempt.catch(showStatic);
  }

  window.AtlasSignInIntro = { start, skip: showStatic, state: () => root?.dataset.introState || 'none' };
  if (document.documentElement.dataset.atlasSignin === 'shown') start();
})();
