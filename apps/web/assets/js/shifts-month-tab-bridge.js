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

  function isMonthTabClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest?.('[data-shifts-tab="month"]');
    const host = shiftsHost();
    return Boolean(tab && host?.contains(tab));
  }

  function protectMonthClick(event) {
    if (!isMonthTabClick(event)) return;

    // The dedicated Month module handles this click from its document-level
    // capture listener. Stop the older weekly workspace listener from handling
    // the same button during bubbling, where it would synchronously rebuild the
    // tab bar and remove the Month surface before it can open.
    event.preventDefault();
    event.stopPropagation();

    // Defensive fallback for unusual script-loading order. The Month module's
    // own listener normally activates immediately. If it has not done so by the
    // next frame, ask its public API to open the view once it is available.
    window.requestAnimationFrame(() => {
      const host = shiftsHost();
      if (!host || host.classList.contains('shifts-month-active')) return;
      window.AtlasShiftsMonth?.open?.();
    });
  }

  function init() {
    if (state.initialized) return true;
    const host = shiftsHost();
    if (!host) return false;

    state.initialized = true;
    state.host = host;
    host.addEventListener('click', protectMonthClick, true);

    window.addEventListener('pagehide', () => {
      state.host?.removeEventListener('click', protectMonthClick, true);
      if (state.timer) window.clearInterval(state.timer);
    }, { once: true });

    return true;
  }

  window.AtlasShiftsMonthTabBridge = {
    ready: () => state.initialized,
    apply: init
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
