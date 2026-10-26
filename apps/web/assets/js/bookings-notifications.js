// Booking notifications worker (S109). Surfaces the KANEL online-booking inbox —
// new requests, approvals, rejections ('declined'), changes and cancellations —
// to managers/administrators through the app-wide notification bell
// (AtlasShell.notify), with read/unread state and one-tap navigation to the exact
// reservation (#bookings/res/<id>).
//
// It reads the server-side inbox (atlas-bookings ?action=notifications), which is
// written by the booking lifecycle trigger and is INDEPENDENT of web-push: it
// works whether or not ATLAS_PUSH_DELIVERY_ENABLED is set. Event refreshes are
// throttled. An independently opt-in, bounded refresh runs only for a visible,
// online manager/admin; it stops on sign-out, denial and page cleanup.
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
    initialized: false,
    userId: null,
    request: null,
    pollTimer: null,
    pollFailures: 0,
    pollSuspended: false,
    disposed: false,
    cleanups: [],
    readyCleanup: null
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

  function refreshMilliseconds() {
    const seconds = (window.VABAR_CONFIG || cfg).BOOKING_NOTIFICATIONS_REFRESH_SECONDS;
    return Number.isInteger(seconds) && seconds >= 30 && seconds <= 300 ? seconds * 1000 : 0;
  }

  function canPoll() {
    const profile = window.atlasCurrentProfile;
    return enabled() && refreshMilliseconds() > 0 && !state.disposed && !state.forbidden &&
      !state.pollSuspended && appIsSignedIn() && document.visibilityState === 'visible' &&
      navigator.onLine !== false && Boolean(state.userId) && profile?.id === state.userId &&
      profile.active !== false && MANAGER_ROLES.has(profile.role);
  }

  function stopPoll() {
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll() {
    stopPoll();
    if (!canPoll() || state.inFlight) return;
    const base = refreshMilliseconds();
    const backoff = Math.min(300000, base * (2 ** Math.min(state.pollFailures, 4)));
    const delay = state.pollFailures ? Math.min(300000, backoff * (0.9 + Math.random() * 0.2)) : base;
    state.pollTimer = window.setTimeout(async function pollTick() {
      state.pollTimer = null;
      if (!canPoll()) return;
      await refresh({ silent: true, timed: true });
      schedulePoll();
    }, delay);
  }

  // Run once the app screen is actually shown. The boot/auth triggers can fire
  // before the shell reveals the app, when a fetch would no-op; this waits for
  // the shell's own readiness events (profile ready / first view shown), which
  // are mirrored on window. Event-driven — never a MutationObserver or a poll.
  function whenSignedIn(run) {
    state.readyCleanup?.();
    if (state.disposed) return;
    if (appIsSignedIn()) { run(); return; }
    let done = false;
    let timer;
    const cleanup = () => {
      done = true;
      window.removeEventListener('atlas:profile-ready', go);
      window.removeEventListener('atlas:view-change', go);
      window.clearTimeout(timer);
      state.readyCleanup = null;
    };
    function go() { if (done || !appIsSignedIn()) return; done = true; cleanup(); run(); }
    window.addEventListener('atlas:profile-ready', go);
    window.addEventListener('atlas:view-change', go);
    state.readyCleanup = cleanup;
    timer = window.setTimeout(cleanup, 20000);  // never leak the listeners
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
  // The inbox returns the visit's venue-local date (S110b) so the app opens the
  // booking's own day — a request for another day is not in today's snapshot.
  function visitDate(row) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(row?.visit_date || '')) ? row.visit_date : null;
  }

  function reservationRoute(reservationId, date) {
    if (!reservationId) return '#bookings';
    return date ? `#bookings/res/${reservationId}/${date}` : `#bookings/res/${reservationId}`;
  }

  // One plain glyph per inbox kind. Only a request needs a decision, so only a
  // request carries the warning severity (the bell's one full colour).
  const KIND_ICON = { request: 'calendar-clock', approved: 'calendar-check', changed: 'calendar-clock', declined: 'x', cancelled: 'x', no_show: 'user-x' };

  // "Web Test Guest · party of 2 · Thu 27 Sep, 16:00": the visit time is what
  // a manager needs to judge a request, so it rides with the server's text.
  function detailFor(row) {
    const when = row?.start_at ? window.AtlasVenueClock?.formatDateTime?.(row.start_at) : '';
    return [row.body, when].filter(Boolean).join(' · ');
  }

  function toNotifyItem(row) {
    const isRequest = row.kind === 'request';
    return {
      id: `booking:${row.id}`,
      type: 'booking',
      severity: isRequest ? 'warning' : 'info',
      icon: KIND_ICON[row.kind] || 'calendar-check',
      title: row.title,
      detail: detailFor(row),
      time: row.created_at || null,
      needsAction: isRequest,
      // actionId lets activation mark the row read server-side before navigating.
      action: { actionId: OPEN_ACTION, reservationId: row.reservation_id || null, visitDate: visitDate(row), notificationId: row.id, route: reservationRoute(row.reservation_id, visitDate(row)) }
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
  async function fetchInbox(session, controller) {
    const api = endpoint();
    if (!api) throw new Error('Bookings are not set up.');
    const url = new URL(api);
    url.searchParams.set('action', 'notifications');
    url.searchParams.set('limit', '30');
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' }
      });
      if (response.status === 403) return { items: [], unread: 0, forbidden: true };
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`Booking notifications unavailable (${response.status}).`);
        error.status = response.status;
        throw error;
      }
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
    if (state.disposed) return;
    if (!options.force && Date.now() - state.lastFetchAt < THROTTLE_MS) return;
    stopPoll();
    const request = { controller: new AbortController() };
    state.request = request;
    state.inFlight = true;
    try {
      const session = await activeSession();
      if (state.request !== request || state.disposed) return;
      if (!session?.access_token) { state.pollSuspended = true; return; }
      if (state.userId && state.userId !== session.user?.id) return;
      state.userId = session.user?.id || null;
      const result = await fetchInbox(session, request.controller);
      if (state.request !== request || state.disposed) return;
      if (result.forbidden) state.forbidden = true;
      state.items = result.items;
      state.unread = result.unread;
      state.loaded = true;
      state.lastFetchAt = Date.now();
      state.pollFailures = 0;
      state.pollSuspended = false;
      announce();
    } catch (error) {
      if (state.request !== request || state.disposed) return;
      if (error.status === 401) state.pollSuspended = true;
      else if (options.timed) state.pollFailures += 1;
      if (!options.silent) console.warn('Booking notifications could not refresh.');
    } finally {
      if (state.request === request) {
        state.request = null;
        state.inFlight = false;
        schedulePoll();
      }
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
    stopPoll();
    state.request?.controller.abort();
    state.request = null;
    state.inFlight = false;
    state.pollFailures = 0;
    state.pollSuspended = false;
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
          const route = reservationRoute(act.reservationId, act.visitDate);
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
      if (state.disposed) return;
      if (!session) { userId = null; state.userId = null; state.readyCleanup?.(); clear(); return; }
      const changed = session.user?.id !== userId;
      userId = session.user?.id || null;
      if (changed) clear();
      state.userId = userId;
      if (changed || event === 'SIGNED_IN' || (event === 'TOKEN_REFRESHED' && state.pollSuspended)) {
        state.forbidden = false;
        state.pollSuspended = false;
        whenSignedIn(() => refresh({ force: true, silent: true }));
      }
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

    function listen(target, event, handler) {
      target.addEventListener(event, handler);
      state.cleanups.push(() => target.removeEventListener(event, handler));
    }
    listen(document, 'visibilitychange', () => {
      if (document.hidden) stopPoll();
      else { refresh({ silent: true }); schedulePoll(); }
    });
    listen(window, 'focus', () => refresh({ silent: true }));
    listen(window, 'online', () => { refresh({ force: true, silent: true }); schedulePoll(); });
    listen(window, 'offline', stopPoll);
    listen(window, 'atlas:profile-ready', () => schedulePoll());
    // A staff booking change (assign / approve / cancel) may create rows for me.
    listen(window, 'atlas:bookings-changed', () => refresh({ force: true, silent: true }));
    // The service worker relays a push so an open manager updates immediately.
    if (navigator.serviceWorker?.addEventListener) listen(navigator.serviceWorker, 'message', (event) => {
      if (event.data?.type === 'atlas:push' && event.data?.route === 'bookings') refresh({ force: true, silent: true });
    });
    // When the bell is cleared with "mark all read", persist it for bookings too.
    const removeNotify = window.AtlasShell?.on?.('notify:changed', (detail) => {
      if (detail?.all && state.items.some((row) => !row.read)) persistRead(null, true);
    });
    if (typeof removeNotify === 'function') state.cleanups.push(removeNotify);

    listen(window, 'pagehide', () => {
      state.disposed = true;
      state.readyCleanup?.();
      state.authSubscription?.unsubscribe?.();
      state.cleanups.splice(0).forEach((cleanup) => cleanup());
      clear();
    });
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
