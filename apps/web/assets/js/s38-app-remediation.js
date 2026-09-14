(() => {
  'use strict';

  const state = {
    initialized: false,
    observer: null,
    frame: null
  };

  function scheduleApply() {
    if (state.frame) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = null;
      applyRemediation();
    });
  }

  function setAttentionPulse(element, requiresAction) {
    if (!element) return;
    element.classList.toggle('s38-attention', requiresAction);
    if (!requiresAction) {
      element.classList.remove('s38-attention-pulse');
      delete element.dataset.s38AttentionSignature;
      return;
    }

    const signature = element.dataset.signature || (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (element.dataset.s38AttentionSignature === signature) return;
    element.dataset.s38AttentionSignature = signature;
    element.classList.remove('s38-attention-pulse');
    void element.offsetWidth;
    element.classList.add('s38-attention-pulse');
  }

  function installHomeMark() {
    const host = document.querySelector('#home-focus .atlas-home-brief-icon');
    if (!host) return;
    if (host.dataset.s38Mark !== 'ready') {
      host.innerHTML = '<i data-lucide="bot" aria-hidden="true"></i><span class="sr-only">Atlas</span>';
      host.dataset.s38Mark = 'ready';
    }

    const brief = document.getElementById('home-focus');
    if (brief) {
      brief.setAttribute('aria-live', 'polite');
      const lowCount = Number.parseFloat(document.getElementById('home-low')?.textContent || '0');
      const copy = `${document.getElementById('home-brief-headline')?.textContent || ''} ${document.getElementById('home-brief-detail')?.textContent || ''}`;
      const requiresAction = lowCount > 0 || /requires? (?:action|attention)|needs? attention|urgent|overdue|below par|cannot be served/i.test(copy);
      setAttentionPulse(brief, requiresAction);

      const focusList = document.getElementById('focus-list');
      const actions = brief.querySelector('.atlas-home-brief-actions');
      if (focusList && actions) {
        let toggle = brief.querySelector('[data-s38-priority-toggle]');
        if (!toggle) {
          toggle = document.createElement('button');
        }
        toggle.type = 'button';
        toggle.className = 'atlas-home-action secondary s38-priority-toggle';
        toggle.dataset.s38PriorityToggle = 'true';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '<i data-lucide="list-checks"></i><span>Routine priorities</span><i data-lucide="chevron-down"></i>';
        actions.append(toggle);
        focusList.hidden = true;
      }
    }
  }

  function polishOperations() {
    document.querySelectorAll('.checkpoint-a-home-prompt').forEach((prompt) => {
      const requiresAction = prompt.dataset.attentionRequired === 'true';
      setAttentionPulse(prompt, requiresAction);
    });
    document.querySelectorAll('.checkpoint-a-compact-card').forEach((card) => {
      card.dataset.s38Polished = 'true';
    });
  }

  function polishScanner() {
    const overlay = document.querySelector('.inventory-scanner-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('button').forEach((button) => {
      if (!button.type) button.type = 'button';
    });
    const quantity = overlay.querySelector('#inventory-scanner-quantity');
    if (quantity) {
      quantity.inputMode = 'decimal';
      quantity.setAttribute('aria-label', 'Observed inventory quantity');
    }
  }

  function enablePurchasingNavigation() {
    const orders = document.getElementById('purchase-orders-tab');
    const deliveries = document.getElementById('purchase-deliveries-tab');
    if (orders) {
      orders.disabled = false;
      orders.title = 'Open purchase orders';
      orders.setAttribute('aria-disabled', 'false');
    }
    if (deliveries) {
      deliveries.disabled = false;
      deliveries.title = 'Open ordered and received deliveries';
      deliveries.setAttribute('aria-disabled', 'false');
    }
  }

  function polishMessages() {
    const list = document.querySelector('[data-team-message-list]');
    if (list) {
      list.setAttribute('role', 'log');
      list.setAttribute('aria-live', 'polite');
      list.setAttribute('aria-relevant', 'additions text');
    }

    document.querySelectorAll('.team-channel-panel > footer span').forEach((copy) => {
      if (/notifications will be added/i.test(copy.textContent || '')) {
        copy.textContent = 'Browser and supported mobile notifications are controlled in Settings.';
      }
    });

    document.querySelectorAll('.team-messages-trust span').forEach((copy) => {
      copy.textContent = (copy.textContent || '').replace('Push notifications off', 'Notification delivery follows Settings');
    });

    const team = document.getElementById('team-view');
    const visible = team && window.getComputedStyle(team).display !== 'none';
    document.body.classList.toggle('s38-team-active', Boolean(visible));
  }

  function polishShiftsMonth() {
    const shifts = document.getElementById('shifts-view');
    const visible = shifts && window.getComputedStyle(shifts).display !== 'none';
    const monthOpen = Boolean(visible && shifts.classList.contains('shifts-month-active'));
    document.body.classList.toggle('s38-month-active', monthOpen);
  }

  function polishForms() {
    document.querySelectorAll(
      '.inventory-scanner-close, [data-checkpoint-context-close], [data-shifts-month-close], [data-team-close-attachment]'
    ).forEach((button) => {
      button.type = 'button';
      button.style.touchAction = 'manipulation';
    });
  }

  function constrainHomeTimeline() {
    const timeline = document.getElementById('home-timeline');
    if (!timeline) return;
    const isHome = (document.body.dataset.atlasView || 'dashboard') === 'dashboard';
    timeline.style.display = isHome ? 'block' : 'none';
    timeline.setAttribute('aria-hidden', String(!isHome));
  }

  function applyRemediation() {
    installHomeMark();
    polishOperations();
    polishScanner();
    enablePurchasingNavigation();
    polishMessages();
    polishShiftsMonth();
    polishForms();
    constrainHomeTimeline();
    window.lucide?.createIcons?.();
  }

  function handleScannerControl(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const close = target.closest('.inventory-scanner-overlay [data-scanner-close]');
    if (close) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.AtlasInventoryScanner?.close?.();
      return;
    }

    const step = target.closest('.inventory-scanner-overlay [data-scanner-step]');
    if (!step) return;
    const input = document.getElementById('inventory-scanner-quantity');
    if (!input) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = Number(input.value);
    const delta = Number(step.dataset.scannerStep);
    const next = Math.max(0, (Number.isFinite(current) ? current : 0) + (Number.isFinite(delta) ? delta : 0));
    input.value = String(Math.round(next * 10) / 10);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus({ preventScroll: true });
  }

  function handlePurchasingNavigation(event) {
    const target = event.target instanceof Element ? event.target : null;
    const nav = target?.closest('.nav-item[data-view="suppliers"][data-subview]');
    if (!nav) return;
    const section = String(nav.dataset.subview || '').toLowerCase();
    if (!['orders', 'deliveries'].includes(section)) return;

    window.setTimeout(() => {
      const tab = document.getElementById(section === 'orders' ? 'purchase-orders-tab' : 'purchase-deliveries-tab');
      if (tab) {
        tab.disabled = false;
        tab.click();
        tab.focus({ preventScroll: true });
      }
    }, 0);
  }

  function handleNotificationButton(event) {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('.atlas-topbar .top-icon[title="Notifications"]');
    if (!button) return;
    const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
    if (!settingsNav) return;
    event.preventDefault();
    settingsNav.click();
    window.setTimeout(() => window.AtlasSettings?.tab?.('notifications'), 0);
  }

  function handlePriorityToggle(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-s38-priority-toggle]') : null;
    if (!button) return;
    const list = document.getElementById('focus-list');
    if (!list) return;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    list.hidden = expanded;
    button.querySelector('span').textContent = expanded ? 'Routine priorities' : 'Hide routine priorities';
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    document.addEventListener('click', handleScannerControl, true);
    document.addEventListener('click', handlePurchasingNavigation);
    document.addEventListener('click', handleNotificationButton);
    document.addEventListener('click', handlePriorityToggle);

    state.observer = new MutationObserver(scheduleApply);
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('atlas:profile-ready', scheduleApply);
    window.addEventListener('atlas:view-change', scheduleApply);
    window.addEventListener('resize', scheduleApply, { passive: true });

    applyRemediation();
  }

  window.AtlasS38Remediation = {
    apply: scheduleApply,
    version: 's38-owner-remediation-v5'
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
