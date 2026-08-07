(function () {
  'use strict';

  const modalState = new WeakMap();
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

  function closeTopModal(event) {
    if (event.key !== 'Escape') return;
    const openModals = Array.from(document.querySelectorAll('[data-atlas-modal].is-open'));
    const topModal = openModals.at(-1);
    if (topModal) AtlasModal.close(topModal);
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
    const last = focusable.at(-1);
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

      if (typeof state.options.onOpen === 'function') state.options.onOpen(payload, root);
      root.dispatchEvent(new CustomEvent('atlas:modal-open', { detail: payload }));

      requestAnimationFrame(() => {
        const target = state.options.initialFocus
          ? root.querySelector(state.options.initialFocus)
          : getFocusable(root)[0] || getPanel(root);
        target?.focus();
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

      const stillOpen = document.querySelector('[data-atlas-modal].is-open');
      if (!stillOpen) document.body.classList.remove('atlas-modal-open');

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
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-atlas-modal]').forEach((root) => AtlasModal.register(root));
  });

  window.AtlasModal = AtlasModal;
})();

(function loadAtlasPhase4Layers() {
  'use strict';

  const layers = [
    ['assets/js/phase4-shell.js', 'atlasPhase4Shell', 'Atlas Phase 4 shell'],
    ['assets/js/phase4-operations-bootstrap.js', 'atlasPhase4OperationsBootstrap', 'Atlas Phase 4 operational bootstrap'],
  ];

  layers.forEach(([src, marker, label]) => {
    if (document.querySelector(`script[src="${src}"]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.dataset[marker] = 'true';
    script.addEventListener('error', () => {
      console.error(`${label} could not be loaded.`);
    }, { once: true });
    document.body.appendChild(script);
  });
})();
