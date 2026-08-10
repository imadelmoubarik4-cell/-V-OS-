(() => {
  'use strict';

  let observer = null;

  function authScreen() {
    return document.getElementById('auth-screen');
  }

  function authVisible() {
    const auth = authScreen();
    return Boolean(auth && !auth.hidden);
  }

  function setBackgroundInert(inert) {
    for (const id of ['app-screen', 'command-palette', 'service-overlay', 'recipe-overlay']) {
      const element = document.getElementById(id);
      if (!element) continue;
      if (inert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
    }
  }

  function unlock() {
    const auth = authScreen();
    const visible = authVisible();
    document.body?.classList.toggle('atlas-auth-active', visible);
    setBackgroundInert(visible);
    if (!visible) return;

    auth.removeAttribute('inert');
    auth.setAttribute('aria-hidden', 'false');
    auth.style.pointerEvents = 'auto';

    for (const id of ['auth-email', 'auth-password', 'auth-submit']) {
      const control = document.getElementById(id);
      if (!(control instanceof HTMLElement)) continue;
      control.removeAttribute('inert');
      control.style.pointerEvents = 'auto';
      if ('disabled' in control && id !== 'auth-submit') control.disabled = false;
      if (control instanceof HTMLInputElement) control.readOnly = false;
    }
  }

  function protectCredentialEvent(event) {
    if (!authVisible()) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('#auth-form')) return;

    // This listener is registered before connected workspace handlers. Stopping
    // propagation without cancelling the event preserves native text entry,
    // paste, composition, Tab navigation and password-manager behaviour.
    event.stopImmediatePropagation();

    if (event.type === 'keydown' && event.key === 'Enter') {
      event.preventDefault();
      document.getElementById('auth-form')?.requestSubmit();
    }
  }

  function recoverCoveredPointer(event) {
    if (!authVisible()) return;
    const auth = authScreen();
    if (!auth || auth.contains(event.target)) return;

    const control = Array.from(auth.querySelectorAll('input, button')).find((element) => {
      const rect = element.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    if (!control) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    control.focus({ preventScroll: true });
    if (control instanceof HTMLInputElement) {
      const end = control.value.length;
      try { control.setSelectionRange(end, end); } catch (_) { /* input type may not support selection */ }
    }
  }

  function init() {
    unlock();
    const auth = authScreen();
    if (auth && !observer) {
      observer = new MutationObserver(unlock);
      observer.observe(auth, {
        attributes: true,
        attributeFilter: ['hidden', 'style', 'class', 'inert', 'aria-hidden'],
      });
    }

    window.addEventListener('keydown', protectCredentialEvent, true);
    window.addEventListener('beforeinput', protectCredentialEvent, true);
    window.addEventListener('compositionstart', protectCredentialEvent, true);
    window.addEventListener('compositionend', protectCredentialEvent, true);
    window.addEventListener('paste', protectCredentialEvent, true);
    window.addEventListener('cut', protectCredentialEvent, true);
    window.addEventListener('pointerdown', recoverCoveredPointer, true);
    window.addEventListener('pageshow', unlock);
    document.addEventListener('atlas:auth', unlock);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
