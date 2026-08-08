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
    return Array.from(root.querySelectorAll(focusableSelector)).filter((element) => (
      !element.hasAttribute('hidden') && element.offsetParent !== null
    ));
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

      modalState.set(root, {
        options: {
          closeOnBackdrop: options.closeOnBackdrop !== false,
          initialFocus: options.initialFocus || null,
          onOpen: options.onOpen || null,
          onClose: options.onClose || null
        },
        previouslyFocused: null
      });

      root.addEventListener('click', (event) => {
        const state = modalState.get(root);
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
      if (!document.querySelector('[data-atlas-modal].is-open')) document.body.classList.remove('atlas-modal-open');

      if (typeof state.options.onClose === 'function') state.options.onClose(reason, root);
      root.dispatchEvent(new CustomEvent('atlas:modal-close', { detail: { reason } }));
      if (state.previouslyFocused instanceof HTMLElement) state.previouslyFocused.focus();
    },

    isOpen(modalOrId) {
      return Boolean(resolveModal(modalOrId)?.classList.contains('is-open'));
    }
  };

  document.addEventListener('keydown', closeTopModal);
  document.addEventListener('keydown', trapFocus);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-atlas-modal]').forEach((root) => AtlasModal.register(root));
  });
  window.AtlasModal = AtlasModal;
})();

(function installStablePhase4Entry() {
  'use strict';

  const SHELL_SRC = 'assets/js/phase4-shell.js';
  const STYLE_HREF = 'assets/css/phase4-claude.css';
  const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  let shellRequested = false;

  function storedTheme() {
    try {
      return localStorage.getItem('atlas.phase4.theme');
    } catch (_) {
      return null;
    }
  }

  function installVisualFoundation() {
    if (!document.body) return;
    document.body.classList.add('atlas-phase4');
    const theme = storedTheme() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.atlasTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.style.colorScheme = document.documentElement.dataset.atlasTheme;

    if (!document.querySelector('link[data-atlas-phase4-font]')) {
      const font = document.createElement('link');
      font.rel = 'stylesheet';
      font.href = FONT_HREF;
      font.dataset.atlasPhase4Font = 'true';
      document.head.appendChild(font);
    }
    if (!document.querySelector(`link[href="${STYLE_HREF}"]`)) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = STYLE_HREF;
      stylesheet.dataset.atlasPhase4 = 'true';
      document.head.appendChild(stylesheet);
    }
  }

  function appIsAuthenticated() {
    return Boolean(window.atlasCurrentProfile?.active);
  }

  function loadShell() {
    if (shellRequested || window.AtlasPhase4Shell || !appIsAuthenticated()) return;
    shellRequested = true;
    const script = document.createElement('script');
    script.src = SHELL_SRC;
    script.async = false;
    script.dataset.atlasPhase4Shell = 'true';
    script.addEventListener('error', () => {
      shellRequested = false;
      console.error('Atlas Phase 4 shell could not be loaded.');
    }, { once: true });
    document.body.appendChild(script);
  }

  const start = () => {
    installVisualFoundation();
    if (appIsAuthenticated()) requestAnimationFrame(loadShell);
  };

  window.addEventListener('atlas:profile-ready', (event) => {
    if (!event.detail?.active) return;
    installVisualFoundation();
    requestAnimationFrame(loadShell);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
