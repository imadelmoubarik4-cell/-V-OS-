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
      // Modules that fill a registered root later (innerHTML after register)
      // get their panel labelled here: role="dialog", aria-modal and a name.
      labelDialog(root);
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
    },

    // A one-off layer: an .atlas-modal root (replacing any element with the same
    // id) around `panel` markup, opened now and removed from the page when it
    // closes. onClose(reason) runs after removal.
    layer({ id = '', panel = '', className = '', onClose = null, initialFocus = null, closeOnBackdrop = true } = {}) {
      if (id) document.getElementById(id)?.remove();
      const root = document.createElement('div');
      if (id) root.id = id;
      root.className = ['atlas-modal', className].filter(Boolean).join(' ');
      root.setAttribute('data-atlas-modal', '');
      root.hidden = true;
      root.innerHTML = panel;
      document.body.appendChild(root);
      window.lucide?.createIcons?.();
      AtlasModal.register(root, { initialFocus, closeOnBackdrop, onClose: (reason) => { root.remove(); if (typeof onClose === 'function') onClose(reason); } });
      AtlasModal.open(root);
      return root;
    },

    // Closes a layer (or removes it when it never opened).
    dismiss(modalOrId, reason = 'dismiss') {
      const root = resolveModal(modalOrId);
      if (!root) return;
      if (AtlasModal.isOpen(root)) AtlasModal.close(root, reason);
      else root.remove();
    },

    // Shared dialogs (design system §6.18). Each returns a promise and is a
    // labelled modal .atlas-dialog: focus moves in (first field, else the
    // title), Tab is trapped, Esc and Cancel dismiss, focus returns to the
    // trigger. Text is escaped; `bodyHtml` / `body` of form() is trusted markup.
    //   confirm({ title, body, confirmLabel, cancelLabel, danger, id }) → Promise<boolean>
    //   prompt({ title, body, label, value, placeholder, required, multiline, rows, maxLength, type, confirmLabel, danger, id }) → Promise<string | null>
    //   form({ title, body, submitLabel, danger, wide, id, onSubmit(form) → error text | null }) → Promise<boolean> with { root, form, close }
    confirm(options = {}) {
      return openDialog({ ...options, field: null }).then((value) => value !== null);
    },

    prompt(options = {}) {
      return openDialog({ ...options, field: { label: options.label || 'Note', value: options.value, placeholder: options.placeholder, required: Boolean(options.required), multiline: options.multiline !== false, rows: options.rows, maxLength: options.maxLength, type: options.type } });
    },

    form(options = {}) {
      return openFormDialog(options);
    }
  };

  let dialogSequence = 0;
  const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function dialogShell({ id, title, bodyHtml, submitLabel, cancelLabel, danger, wide }) {
    return `<form class="atlas-dialog${wide ? ' atlas-dialog--form' : ''}" data-modal-panel aria-labelledby="${id}-title" novalidate>
      <h2 class="atlas-dialog__title" id="${id}-title">${escapeText(title)}</h2>
      <div class="atlas-dialog__body">${bodyHtml}</div>
      <p class="atlas-field__error atlas-dialog__error" data-atlas-dialog-error role="alert" hidden></p>
      <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>${escapeText(cancelLabel || 'Cancel')}</button><button type="submit" class="atlas-btn ${danger ? 'atlas-btn--danger-solid' : 'atlas-btn--primary'}">${escapeText(submitLabel)}</button></div>
    </form>`;
  }

  // confirm() and prompt(): resolves the field value ('' without a field), or
  // null when dismissed.
  function openDialog({ id, title = '', body = '', bodyHtml = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, field = null } = {}) {
    const key = id || `atlas-dialog-${dialogSequence += 1}`;
    const input = field
      ? (field.multiline
        ? `<textarea class="atlas-input atlas-textarea" id="${key}-input" name="value" rows="${Number(field.rows) || 3}"${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ''} placeholder="${escapeText(field.placeholder || '')}"${field.required ? ' aria-required="true"' : ''}>${escapeText(field.value || '')}</textarea>`
        : `<input class="atlas-input" id="${key}-input" name="value" type="${escapeText(field.type || 'text')}" value="${escapeText(field.value || '')}"${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ''} placeholder="${escapeText(field.placeholder || '')}"${field.required ? ' aria-required="true"' : ''}>`)
      : '';
    const bodyMarkup = `${bodyHtml || (body ? `<p>${escapeText(body)}</p>` : '')}${field ? `<div class="atlas-field"><label for="${key}-input">${escapeText(field.label)}${field.required ? '' : ' <span class="optional">Optional</span>'}</label>${input}</div>` : ''}`;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const root = AtlasModal.layer({
        id: key,
        panel: dialogShell({ id: key, title, bodyHtml: bodyMarkup, submitLabel: confirmLabel, cancelLabel, danger, wide: Boolean(field) }),
        onClose: () => finish(null)
      });
      const form = root.querySelector('form');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const control = form.querySelector(`#${CSS.escape(key)}-input`);
        const value = control ? control.value.trim() : '';
        if (field?.required && !value) {
          control.setAttribute('aria-invalid', 'true');
          const error = form.querySelector('[data-atlas-dialog-error]');
          error.textContent = `${field.label} is required.`;
          error.hidden = false;
          control.setAttribute('aria-describedby', error.id || (error.id = `${key}-error`));
          control.focus();
          return;
        }
        finish(value);
        AtlasModal.dismiss(root, 'submit');
      });
    });
  }

  // form(): onSubmit(form) may be async; a returned string is shown as the
  // error and keeps the dialog open; a throw shows a generic error.
  function openFormDialog({ id, title = '', body = '', submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, wide = false, onSubmit = null, className = '' } = {}) {
    const key = id || `atlas-dialog-${dialogSequence += 1}`;
    let settle;
    const result = new Promise((resolve) => { settle = resolve; });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; settle(value); } };
    const root = AtlasModal.layer({ id: key, className, panel: dialogShell({ id: key, title, bodyHtml: body, submitLabel, cancelLabel, danger, wide }), onClose: () => finish(false) });
    const form = root.querySelector('form');
    const error = form.querySelector('[data-atlas-dialog-error]');
    const close = () => AtlasModal.dismiss(root, 'submit');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      error.hidden = true;
      submit.disabled = true;
      submit.classList.add('is-loading');
      submit.setAttribute('aria-busy', 'true');
      try {
        let problem = null;
        try { problem = typeof onSubmit === 'function' ? await onSubmit(form) : null; } catch { problem = 'That couldn’t be saved. Nothing was changed. Try again.'; }
        if (problem) {
          error.textContent = String(problem);
          error.hidden = false;
          return;
        }
        finish(true);
        close();
      } finally {
        submit.disabled = false;
        submit.classList.remove('is-loading');
        submit.removeAttribute('aria-busy');
      }
    });
    return Object.assign(result, { root, form, close });
  }

  document.addEventListener('keydown', closeTopModal);
  document.addEventListener('keydown', trapFocus);
  document.addEventListener('click', closeLegacyOverlayFromClick);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-atlas-modal]').forEach((root) => AtlasModal.register(root));
  });

  window.AtlasModal = AtlasModal;
})();
