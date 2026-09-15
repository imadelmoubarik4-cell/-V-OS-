(function () {
  'use strict';

  const state = {
    host: null,
    timer: null,
    initialized: false
  };

  function shiftsHost() {
    return document.getElementById('shifts-view');
  }

  function monthPanel() {
    return shiftsHost()?.querySelector('[data-shifts-month-panel]') || null;
  }

  function installInteractionStyles() {
    if (document.getElementById('shifts-month-interaction-fix')) return;
    const style = document.createElement('style');
    style.id = 'shifts-month-interaction-fix';
    style.textContent = `
      .shifts-month-active [data-shifts-month-panel]{position:relative;z-index:2;pointer-events:auto!important}
      .shifts-month-active [data-shifts-month-panel] button,
      .shifts-month-active [data-shifts-month-panel] input,
      .shifts-month-active [data-shifts-month-panel] select,
      .shifts-month-active [data-shifts-month-panel] textarea,
      .shifts-month-active [data-shifts-month-panel] label{
        pointer-events:auto!important;
        touch-action:manipulation;
      }
      .shifts-month-active [data-shifts-month-panel] button{position:relative;z-index:3}
    `;
    document.head.appendChild(style);
  }

  function isMonthTabClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest?.('[data-shifts-tab="month"]');
    return Boolean(tab && shiftsHost()?.contains(tab));
  }

  // The monthly calendar owns every Month action and form submission through
  // its document-capture handlers. This bridge has one job only: stop the older
  // weekly bubbling handler after the monthly handler receives the Month-tab
  // click. Intercepting Month actions here used to replace their DOM during the
  // click and made the visible + / Add shift controls appear unresponsive.
  function protectMonthTab(event) {
    if (!isMonthTabClick(event)) return;
    event.preventDefault();
    event.stopPropagation();
    window.requestAnimationFrame(() => {
      const host = shiftsHost();
      if (!host || (host.classList.contains('shifts-month-active') && monthPanel())) return;
      window.AtlasShiftsMonth?.open?.();
    });
  }

  function init() {
    if (state.initialized) return true;
    const host = shiftsHost();
    if (!host) return false;

    state.initialized = true;
    state.host = host;
    installInteractionStyles();
    host.addEventListener('click', protectMonthTab, true);

    window.addEventListener('pagehide', () => {
      state.host?.removeEventListener('click', protectMonthTab, true);
      if (state.timer) window.clearInterval(state.timer);
    }, { once: true });

    return true;
  }

  window.AtlasShiftsMonthTabBridge = {
    ready: () => state.initialized,
    apply: init,
    addShift: (date) => window.AtlasShiftsMonth?.addShift?.(date),
    refresh: () => window.AtlasShiftsMonth?.refresh?.()
  };

  if (!init()) {
    state.timer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.timer);
      state.timer = null;
    }, 100);
    window.setTimeout(() => {
      if (!state.timer) return;
      window.clearInterval(state.timer);
      state.timer = null;
    }, 12000);
  }
})();
