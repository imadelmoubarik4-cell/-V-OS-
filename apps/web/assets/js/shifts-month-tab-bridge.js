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

  // S88: this bridge no longer intercepts clicks. shifts-month-calendar.js owns
  // the Month tab in the capture phase and the weekly planner opens Month itself
  // only as a fallback (shifts-workspace.js), so there is nothing to arbitrate.
  // It still installs the Month interaction styles until they move into
  // shifts-month CSS.

  function init() {
    if (state.initialized) return true;
    const host = shiftsHost();
    if (!host) return false;

    state.initialized = true;
    state.host = host;
    installInteractionStyles();

    window.addEventListener('pagehide', () => {
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
