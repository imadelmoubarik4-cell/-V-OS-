// Booking notifications worker (S109). Surfaces the KANEL online-booking inbox —
// new requests, approvals, rejections ('declined'), changes and cancellations —
// to managers/administrators through the app-wide notification bell
// (AtlasShell.notify), with read/unread state and one-tap navigation to the exact
// reservation (#bookings/res/<id>).
//
// It reads the server-side inbox (atlas-bookings ?action=notifications), which is
// written by the booking lifecycle trigger and is INDEPENDENT of web-push: it
// works whether or not ATLAS_PUSH_DELIVERY_ENABLED is set. There is NO polling
// loop — the inbox refreshes only on real events (sign-in, the tab becoming
// visible or focused, coming back online, a staff booking change, or a push the
// service worker relays), each throttled so a burst collapses to one request.
//
// Read API: window.AtlasBookingsNotifications
//   count() · items() · loaded() · refresh({force}) · markAllRead() · clear()
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const MANAGER_ROLES = new Set(['admin', 'manager']);
  const THROTTLE_MS = 15000;      // collapse bursts of events into one request
  const REQUEST_TIMEOUT_MS = 12000;
  const OPEN_ACTION = 'bookings.open-notification';

  const state = {
    items: [],
    unread: 0,
    loaded: false,
    inFlight: false,
    lastFetchAt: 0,
    forbidden: false,            // a non-manager profile: stay silent, stop fetching
    authSubscription: null,
    initialized: false
  };

  function endpoint() {
    return String(cfg.BOOKINGS_API || '').trim();
  }

  // Independent, OFF-by-default staff feature flag. Read live from VABAR_CONFIG so
  // a deliberately configured environment can set it; while false the worker is
  // completely inert — it never fetches atlas-bookings, so no page (Accounting,
  // Home, Team, …) makes an unexpected booking request or logs a console error.
  function enabled() {
    return (window.VABAR_CONFIG || cfg).BOOKING_NOTIFICATIONS_ENABLED === true;
  }

  function appIsSignedIn() {
    const app = document.getElementById('app-screen');
    const login = document.getElementById('login-screen');
    if (!app) return false;
    const appVisible = window.getComputedStyle(app).display !== 'none';
    const loginVisible = Boolean(login) && window.getComputedStyle(login).display !== 'none';
    return appVisible && !loginVisible;
  }

  // Run once the app screen is actually shown. The boot/auth triggers can fire
  // before the shell reveals the app, when a fetch would no-op; this waits for
  // the shell's own readiness events (profile ready / first view shown), which
  // are mirrored on window. Event-driven — never a MutationObserver or a poll.
  function whenSignedIn(run) {
    if (appIsSignedIn()) { run(); return; }
    let done = false;
    const cleanup = () => {
      window.removeEventListener('atlas:profile-ready', go);
      window.removeEventListener('atlas:view-change', go);
    };
    function go() { if (done || !appIsSignedIn()) return; done = true; cleanup(); run(); }
    window.addEventListener('atlas:profile-ready', go);
    window.addEventListener('atlas:view-change', go);
    window.setTimeout(cleanup, 20000);  // never leak the listeners
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  // ---- notify-bell contributor ------------------------------------------------
  // Each inbox row becomes a bell item. Only managers/admins ever see them (the
  // context role gates it, and the server only returns rows for this manager).
  function toNotifyItem(row) {
    const isRequest = row.kind === 'request';
    return {
      id: `booking:${row.id}`,
      type: 'booking',
      severity: isRequest ? 'warning' : 'info',
      icon: isRequest ? 'calendar-clock' : 'calendar-check',
      title: row.title,
      detail: row.body,
      time: row.created_at || null,
      needsAction: isRequest,
      // actionId lets activation mark the row read server-side before navigating.
      action: { actionId: OPEN_ACTION, reservationId: row.reservation_id || null, notificationId: row.id, route: row.reservation_id ? `#bookings/res/${row.reservation_id}` : '#bookings' }
    };
  }

  function contributor(context) {
    if (context && context.role && !MANAGER_ROLES.has(context.role)) return [];
    return state.items.map(toNotifyItem);
  }

  function announce() {
    // Re-register so the shell recomputes the bell with the latest rows, and the
    // DB read-state is mirrored into the bell's local read set.
    const shell = window.AtlasShell;
    if (!shell?.notify) return;
    try { shell.notify.contribute('bookings', contributor); } catch { /* shell not ready */ }
    state.items.forEach((row) => { if (row.read) try { shell.notify.markRead(`booking:${row.id}`); } catch { /* ignore */ } });
  }

  // ---- fetch (event-driven, throttled; never a polling interval) --------------
  async function fetchInbox(session) {
    const api = endpoint();
    if (!api) throw new Error('Bookings are not set up.');
    const url = new URL(api);
    url.searchParams.set('action', 'notifications');
    url.searchParams.set('limit', '30');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' }
      });
      if (response.status === 403) { state.forbidden = true; return { items: [], unread: 0 }; }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Booking notifications unavailable (${response.status}).`);
      return {
        items: Array.isArray(payload?.items) ? payload.items : [],
        unread: Number(payload?.unread) || 0
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function refresh(options = {}) {
    if (!enabled() || state.inFlight || state.forbidden || !appIsSignedIn()) return;
    if (!options.force && Date.now() - state.lastFetchAt < THROTTLE_MS) return;
    let session;
    try { session = await activeSession(); } catch { return; }
    if (!session?.access_token) return;
    state.inFlight = true;
    try {
      const result = await fetchInbox(session);
      state.items = result.items;
      state.unread = result.unread;
      state.loaded = true;
      state.lastFetchAt = Date.now();
      announce();
    } catch (error) {
      if (!options.silent) console.warn('Booking notifications could not refresh.');
    } finally {
      state.inFlight = false;
    }
  }

  async function persistRead(ids, all) {
    const api = endpoint();
    if (!api) return;
    let session;
    try { session = await activeSession(); } catch { return; }
    if (!session?.access_token) return;
    try {
      await fetch(`${api}?action=notifications-read`, {
        method: 'POST', cache: 'no-store',
        headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(all ? { all: true } : { ids })
      });
    } catch { /* read-state is best-effort; the bell already reflects it locally */ }
    // Reflect locally so the count is right without waiting for a refresh.
    if (all) state.items.forEach((row) => { row.read = true; });
    else state.items.forEach((row) => { if (ids.includes(row.id)) row.read = true; });
    state.unread = state.items.filter((row) => !row.read).length;
  }

  function clear() {
    state.items = [];
    state.unread = 0;
    state.loaded = false;
    state.forbidden = false;
    announce();
  }

  // ---- wiring -----------------------------------------------------------------
  function registerOpenAction() {
    const shell = window.AtlasShell;
    if (!shell?.actions?.register) return;
    try {
      shell.actions.register({
        id: OPEN_ACTION,
        label: 'Open booking',
        roles: ['admin', 'manager'],
        run: async (ctx) => {
          const act = ctx?.notification?.action || {};
          if (act.notificationId) persistRead([act.notificationId], false);
          const route = act.reservationId ? `#bookings/res/${act.reservationId}` : '#bookings';
          shell.navigate(route, { source: 'notification' });
          return { ok: true };
        }
      });
    } catch { /* already registered */ }
  }

  function subscribeToAuth() {
    const client = window.atlasSupabase;
    if (!client?.auth?.onAuthStateChange || state.authSubscription) return false;
    let userId = null;
    const subscription = client.auth.onAuthStateChange((event, session) => {
      if (!session) { userId = null; clear(); return; }
      const changed = session.user?.id !== userId;
      userId = session.user?.id || null;
      if (changed || event === 'SIGNED_IN') { state.forbidden = false; whenSignedIn(() => refresh({ force: true, silent: true })); }
    });
    state.authSubscription = subscription?.data?.subscription || subscription?.subscription || null;
    return true;
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Feature OFF (default): stay completely inert. No contributor, no action, no
    // listeners, no fetch — other pages never see a booking request or error.
    if (!enabled()) return;

    registerOpenAction();
    announce();               // register the (empty) contributor up front
    subscribeToAuth();        // subscribe now if the client is ready…
    whenSignedIn(() => { subscribeToAuth(); refresh({ force: true, silent: true }); });  // …else once the app is shown (the client exists by then)

    // Event-driven refreshes only — no setInterval anywhere.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ silent: true }); });
    window.addEventListener('focus', () => refresh({ silent: true }));
    window.addEventListener('online', () => refresh({ force: true, silent: true }));
    // A staff booking change (assign / approve / cancel) may create rows for me.
    window.addEventListener('atlas:bookings-changed', () => refresh({ force: true, silent: true }));
    // The service worker relays a push so an open manager updates immediately.
    navigator.serviceWorker?.addEventListener?.('message', (event) => {
      if (event.data?.type === 'atlas:push' && event.data?.route === 'bookings') refresh({ force: true, silent: true });
    });
    // When the bell is cleared with "mark all read", persist it for bookings too.
    window.AtlasShell?.on?.('notify:changed', (detail) => {
      if (detail?.all && state.items.some((row) => !row.read)) persistRead(null, true);
    });

    window.addEventListener('pagehide', () => { state.authSubscription?.unsubscribe?.(); }, { once: true });
  }

  window.AtlasBookingsNotifications = {
    refresh: (options) => refresh(options || { force: true }),
    count: () => state.unread,
    items: () => state.items.map((row) => ({ ...row })),
    loaded: () => state.loaded,
    markAllRead: () => persistRead(null, true),
    clear
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
