(function () {
  'use strict';

  const SELECTOR = '[data-team-profile-photo-input]';
  const state = { observer: null, frame: null, initialized: false };

  function makeGalleryFriendly(input) {
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;

    // `capture="user"` can force the camera on mobile browsers. Removing it
    // restores the normal system image picker, which offers the photo gallery
    // and, where supported, a camera option as well.
    input.removeAttribute('capture');
    input.accept = 'image/jpeg,image/png,image/webp';
    input.dataset.teamProfileGalleryEnabled = 'true';
  }

  function updateButtonLabel(input) {
    const controls = input.closest('[data-team-profile-photo-controls]');
    const button = controls?.querySelector('[data-team-profile-photo-upload]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;

    const hasRemove = Boolean(controls.querySelector('[data-team-profile-photo-remove]'));
    const icon = button.querySelector('[data-lucide],svg');
    const label = hasRemove ? 'Change photo' : 'Choose photo';

    [...button.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });
    if (icon) icon.insertAdjacentText('afterend', label);
    else button.textContent = label;
    button.setAttribute('aria-label', `${label} from camera or gallery`);
  }

  function apply() {
    document.querySelectorAll(SELECTOR).forEach((input) => {
      makeGalleryFriendly(input);
      updateButtonLabel(input);
    });
  }

  function scheduleApply() {
    if (state.frame) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = null;
      apply();
    });
  }

  function handlePointer(event) {
    const button = event.target instanceof Element
      ? event.target.closest('[data-team-profile-photo-upload]')
      : null;
    if (!button) return;
    const input = button.closest('[data-team-profile-photo-controls]')?.querySelector(SELECTOR);
    makeGalleryFriendly(input);
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    document.addEventListener('pointerdown', handlePointer, true);
    document.addEventListener('click', handlePointer, true);
    apply();

    state.observer = new MutationObserver((records) => {
      if (records.some((record) => record.addedNodes.length > 0)) scheduleApply();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('pagehide', () => {
      state.observer?.disconnect();
      if (state.frame) window.cancelAnimationFrame(state.frame);
    }, { once: true });
  }

  window.AtlasTeamProfileGallery = { apply: scheduleApply };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
