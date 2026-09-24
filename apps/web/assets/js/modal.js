(function () {
  'use strict';

  const modalState = new WeakMap();
  // Design system §6.18: dialogs and sheets are labelled modal dialogs; the
  // page behind them is inert while one is open.
  const inertState = new Map();
  const fieldSelector = [
    '[data-autofocus]',
    'input:not([type="hidden"]):not([disabled]):not([readonly])',
    'select:not([disabled])',
    'textarea:not([disabled]):not([readonly])'
  ].join(',');
  let titleSequence = 0;
  const legacyOverlaySelector = '.overlay:not([data-atlas-modal])';
  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function getPanel(root) {
    return root.querySelector('[data-modal-panel]') || root.querySelector('.modal');
  }

  function getFocusable(root) {
    return Array.from(root.querySelectorAll(focusableSelector)).filter((element) => {
      return !element.hasAttribute('hidden') && element.offsetParent !== null;
    });
  }

  function labelDialog(root) {
    const panel = getPanel(root);
    if (!panel) return;
    if (!panel.getAttribute('role')) panel.setAttribute('role', 'dialog');
    if (!panel.hasAttribute('aria-modal')) panel.setAttribute('aria-modal', 'true');
    if (!panel.hasAttribute('aria-labelledby') && !panel.hasAttribute('aria-label')) {
      const title = panel.querySelector('[data-modal-title], h1, h2, h3');
      if (title) {
        if (!title.id) title.id = `atlas-modal-title-${titleSequence += 1}`;
        panel.setAttribute('aria-labelledby', title.id);
      }
    }
  }

  function setBackgroundInert(root) {
    inertState.forEach((wasInert, element) => { element.inert = wasInert; });
    inertState.clear();
    if (!root) return;
    Array.from(document.body.children).forEach((element) => {
      if (element === root || element.contains(root)) return;
      if (element.matches('script, style, link, template, [aria-live], [role="status"], [role="alert"]')) return;
      inertState.set(element, Boolean(element.inert));
      element.inert = true;
    });
  }

  // First field, else the title (read-only dialogs), else the first control.
  function initialFocusTarget(root, state) {
    if (state.options.initialFocus) return root.querySelector(state.options.initialFocus);
    const visible = (element) => element && !element.hasAttribute('hidden') && element.offsetParent !== null;
    const field = Array.from(root.querySelectorAll(fieldSelector)).find(visible);
    if (field) return field;
    const panel = getPanel(root);
    const titleId = panel?.getAttribute('aria-labelledby');
    const title = titleId ? document.getElementById(titleId) : null;
    if (visible(title)) {
      if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
      return title;
    }
    return getFocusable(root)[0] || panel;
  }

  function closeTopModal(event) {
    if (event.key !== 'Escape') return;
    const openModals = Array.from(document.querySelectorAll('[data-atlas-modal].is-open'));
    const topModal = openModals.at(-1);
    if (topModal) {
      AtlasModal.close(topModal, 'escape');
      return;
    }

    const legacyModal = visibleLegacyOverlays().at(-1);
    if (legacyModal) closeLegacyOverlay(legacyModal, 'escape');
  }

  function visibleLegacyOverlays() {
    return Array.from(document.querySelectorAll(legacyOverlaySelector)).filter((root) => {
      const style = window.getComputedStyle(root);
      return !root.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  function closeLegacyOverlay(root, reason = 'dismiss') {
    if (!(root instanceof HTMLElement)) return;
    root.style.display = 'none';
    if (root.hasAttribute('aria-hidden')) root.setAttribute('aria-hidden', 'true');
    root.querySelectorAll('form').forEach((form) => form.reset());
    root.dispatchEvent(new CustomEvent('atlas:modal-close', { detail: { reason } }));
  }

  function closeLegacyOverlayFromClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest(legacyOverlaySelector);
    if (!root) return;

    const closeControl = target.closest([
      '.modal-close',
      '[data-modal-close]',
      '[id^="cancel-"][id$="-btn"]'
    ].join(','));
    if (!closeControl && event.target !== root) return;

    event.preventDefault();
    closeLegacyOverlay(root, closeControl ? 'control' : 'backdrop');
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const openModals = Array.from(document.querySelectorAll('[data-atlas-modal].is-open'));
    const root = openModals.at(-1);
    if (!root) return;

    const focusable = getFocusable(root);
    if (!focusable.length) {
      event.preventDefault();
      getPanel(root)?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function resolveModal(modalOrId) {
    if (modalOrId instanceof HTMLElement) return modalOrId;
    return document.getElementById(String(modalOrId));
  }

  const AtlasModal = {
    register(modalOrId, options = {}) {
      const root = resolveModal(modalOrId);
      if (!root || modalState.has(root)) return root;

      const panel = getPanel(root);
      if (panel && !panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      labelDialog(root);

      const state = {
        options: {
          closeOnBackdrop: options.closeOnBackdrop !== false,
          initialFocus: options.initialFocus || null,
          onOpen: options.onOpen || null,
          onClose: options.onClose || null
        },
        previouslyFocused: null
      };
      modalState.set(root, state);

      root.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-modal-close]');
        if (closeButton) {
          event.preventDefault();
          AtlasModal.close(root);
          return;
        }
        if (state.options.closeOnBackdrop && event.target === root) AtlasModal.close(root);
      });

      return root;
    },

    open(modalOrId, payload) {
      const root = resolveModal(modalOrId);
      if (!root) throw new Error('AtlasModal: modal not found');
      if (!modalState.has(root)) AtlasModal.register(root);

      const state = modalState.get(root);
      state.previouslyFocused = document.activeElement;
      root.hidden = false;
      root.style.display = 'flex';
      root.setAttribute('aria-hidden', 'false');
      root.classList.add('is-open');
      document.body.classList.add('atlas-modal-open');
      setBackgroundInert(root);

      if (typeof state.options.onOpen === 'function') state.options.onOpen(payload, root);
      root.dispatchEvent(new CustomEvent('atlas:modal-open', { detail: payload }));

      requestAnimationFrame(() => {
        initialFocusTarget(root, state)?.focus();
      });
    },

    close(modalOrId, reason = 'dismiss') {
      const root = resolveModal(modalOrId);
      if (!root || !modalState.has(root) || !root.classList.contains('is-open')) return;

      const state = modalState.get(root);
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      root.hidden = true;
      root.style.display = 'none';

      const stillOpen = Array.from(document.querySelectorAll('[data-atlas-modal].is-open')).at(-1);
      if (!stillOpen) document.body.classList.remove('atlas-modal-open');
      setBackgroundInert(stillOpen || null);

      if (typeof state.options.onClose === 'function') state.options.onClose(reason, root);
      root.dispatchEvent(new CustomEvent('atlas:modal-close', { detail: { reason } }));
      if (state.previouslyFocused instanceof HTMLElement) state.previouslyFocused.focus();
    },

    isOpen(modalOrId) {
      const root = resolveModal(modalOrId);
      return Boolean(root?.classList.contains('is-open'));
    }
  };

  document.addEventListener('keydown', closeTopModal);
  document.addEventListener('keydown', trapFocus);
  document.addEventListener('click', closeLegacyOverlayFromClick);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-atlas-modal]').forEach((root) => AtlasModal.register(root));
  });

  window.AtlasModal = AtlasModal;
})();
