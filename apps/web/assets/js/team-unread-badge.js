// Messages unread worker. Polls the Messages snapshot while the app is signed
// in so the shell's Messages badge (atlas-chrome.js reads count()) and the
// notifications feed stay current outside Messages. While Messages is open it
// reuses that page's snapshot so this poll never races its read cursor.
//
// Read API: count() · conversations() → [{ id, name, unread, route, lastMessageAt,
// lastMessage: { id, sender, body, deleted } | null }]
// · activeMembers() · refresh() · clear(). Each change is announced on the
// shell as 'messages:unread' { total, conversations }.
//
// Cadence: one poll every POLL_MS while the tab is visible, as a setTimeout
// chain. Consecutive failures back off exponentially (with jitter, capped at
// BACKOFF_MAX_MS) so an outage is not hit every 8 s from every open tab; a
// success, the tab coming back, the network coming back or a focus resets it.
// Focus refreshes are throttled to one per FOCUS_MIN_GAP_MS. A relayed push
// for Messages ('atlas:push', route 'team') refreshes at once.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const POLL_MS = 8000;
  const BACKOFF_MAX_MS = 180000;
  const FOCUS_MIN_GAP_MS = 15000;
  const REQUEST_TIMEOUT_MS = 12000;
  const state = {
    inFlight: false,
    // An explicit refresh (push, focus, back online) asked for while one was
    // in flight: that response may predate the news, so one more follows.
    refreshAgain: false,
    timer: null,
    polling: false,
    failures: 0,
    lastFocusRefreshAt: 0,
    authSubscription: null,
    lastTotal: 0,
    conversations: [],
    loaded: false,
    activeMembers: null,
    initialized: false
  };

  function endpoint() {
    return String(cfg.TEAM_MESSAGES_API || '').trim();
  }

  function appIsSignedIn() {
    const app = document.getElementById('app-screen');
    const login = document.getElementById('login-screen');
    if (!app) return false;
    const appVisible = window.getComputedStyle(app).display !== 'none';
    const loginVisible = Boolean(login) && window.getComputedStyle(login).display !== 'none';
    return appVisible && !loginVisible;
  }

  function teamIsVisible() {
    const team = document.getElementById('team-view');
    return Boolean(team)
      && window.getComputedStyle(team).display !== 'none'
      && appIsSignedIn();
  }

  function normalizeTotal(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(9999, Math.floor(parsed));
  }

  // The sender is never an address (S87): email-shaped text is not a name.
  function safePersonLabel(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text && !text.includes('@') ? text.slice(0, 120) : '';
  }

  // S93: the gateway's live sender_name (sender_id → roster display name),
  // then the stored label, then the neutral label.
  function senderOf(message) {
    return safePersonLabel(message.sender_name) || safePersonLabel(message.sender_label) || 'Team member';
  }

  function lastMessageOf(message) {
    if (!message) return null;
    return {
      id: message.id || null,
      sender: message.message_type === 'system' ? 'Alcedo' : senderOf(message),
      body: message.deleted ? '' : String(message.body || '').slice(0, 140),
      deleted: Boolean(message.deleted)
    };
  }

  function conversationsFrom(channels) {
    return (Array.isArray(channels) ? channels : [])
      .map((channel) => ({
        id: String(channel.key || ''),
        name: String(channel.name || ''),
        unread: normalizeTotal(channel.unread_count),
        route: `#messages/${encodeURIComponent(String(channel.key || ''))}`,
        lastMessageAt: channel.last_message?.created_at || null,
        lastMessage: lastMessageOf(channel.last_message)
      }))
      .filter((entry) => entry.id && entry.unread > 0);
  }

  // The badge itself is rendered by the shell chrome from count(); this only
  // records the numbers and tells the shell they changed.
  // loaded() turns true once a real snapshot (the server's or the open
  // Messages page's) has been applied; a signed-out reset does not count.
  function setUnread(total, conversations, { fromSnapshot = false } = {}) {
    const next = normalizeTotal(total);
    const list = Array.isArray(conversations) ? conversations : [];
    const changed = next !== state.lastTotal || JSON.stringify(list) !== JSON.stringify(state.conversations);
    state.lastTotal = next;
    state.conversations = list;
    state.loaded = fromSnapshot;
    if (!changed) return;
    window.AtlasShell?.emit?.('messages:unread', { total: next, conversations: list });
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function fetchUnread() {
    const api = endpoint();
    if (!api) throw new Error('Messages are not set up.');

    const session = await activeSession();
    if (!session?.access_token) return { total: 0, conversations: [] };

    const url = new URL(api);
    url.searchParams.set('action', 'snapshot');
    url.searchParams.set('channel', 'general');
    url.searchParams.set('limit', '1');

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json'
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Not allowed or sign-in not confirmed: keep the last known count
        // rather than showing a false 0.
        if (response.status === 401 || response.status === 403) throw new Error(`Unread count unavailable (${response.status}).`);
        throw new Error(`Unread count unavailable (${response.status}).`);
      }
      // The same lightweight snapshot carries the active staff count that
      // Home shows, so Home does not need Messages to be opened first.
      const members = Number(payload?.snapshot?.summary?.active_members);
      if (Number.isFinite(members) && members !== state.activeMembers) {
        state.activeMembers = members;
        window.dispatchEvent(new CustomEvent('atlas:team-summary', { detail: { activeMembers: members } }));
      }
      return {
        total: normalizeTotal(payload?.snapshot?.summary?.total_unread),
        conversations: conversationsFrom(payload?.snapshot?.channels),
        fromSnapshot: Boolean(payload?.snapshot)
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function refreshUnread(options = {}) {
    if (state.inFlight && options.now) state.refreshAgain = true;
    if (state.inFlight || document.hidden || !appIsSignedIn()) {
      if (!appIsSignedIn()) setUnread(0, []);
      return;
    }

    // While Messages is open, reuse its current full snapshot so the background
    // poll does not race against the channel mark-as-read request.
    if (teamIsVisible() && window.AtlasTeamMessages?.snapshot?.()) {
      setUnread(window.AtlasTeamMessages.unreadCount?.() || 0, conversationsFrom(window.AtlasTeamMessages.snapshot()?.channels), { fromSnapshot: true });
      return;
    }

    state.inFlight = true;
    try {
      const result = await fetchUnread();
      setUnread(result.total, result.conversations, { fromSnapshot: result.fromSnapshot });
      state.failures = 0;
    } catch (error) {
      state.failures = Math.min(state.failures + 1, 16);
      if (!options.silent) console.warn('Messages unread count could not refresh.');
    } finally {
      state.inFlight = false;
    }
    if (state.refreshAgain) {
      state.refreshAgain = false;
      restartPoll();
      await refreshUnread({ silent: true });
    }
  }

  // The next poll: POLL_MS while healthy; after consecutive failures it
  // doubles (16 s, 32 s, 64 s ...) up to BACKOFF_MAX_MS, less up to 20 %
  // jitter so open tabs do not retry in step.
  function nextDelay() {
    if (!state.failures) return POLL_MS;
    const backoff = Math.min(BACKOFF_MAX_MS, POLL_MS * (2 ** state.failures));
    return Math.round(backoff * (1 - Math.random() * 0.2));
  }

  function schedulePoll(delay = nextDelay()) {
    if (!state.polling || state.timer) return;
    state.timer = window.setTimeout(async () => {
      state.timer = null;
      await refreshUnread({ silent: true });
      schedulePoll();
    }, delay);
  }

  function startPolling() {
    if (state.polling) return;
    state.polling = true;
    schedulePoll();
  }

  function stopPolling() {
    state.polling = false;
    if (!state.timer) return;
    window.clearTimeout(state.timer);
    state.timer = null;
  }

  // A fresh signal (tab visible again, back online, focus, a push): forget the
  // backoff, refresh now and restart the chain at the normal cadence.
  // The next poll counts from this refresh.
  function restartPoll() {
    if (state.polling && state.timer) {
      window.clearTimeout(state.timer);
      state.timer = null;
      schedulePoll(POLL_MS);
    }
  }

  function refreshNow(options = {}) {
    state.failures = 0;
    restartPoll();
    return refreshUnread({ ...options, now: true });
  }

  function handleFocus() {
    const now = Date.now();
    if (now - state.lastFocusRefreshAt < FOCUS_MIN_GAP_MS) return;
    state.lastFocusRefreshAt = now;
    refreshNow({ silent: true });
  }

  function handleVisibility() {
    if (document.hidden) {
      stopPolling();
      return;
    }
    startPolling();
    refreshNow();
  }

  function subscribeToAuth() {
    const client = window.atlasSupabase;
    if (!client?.auth?.onAuthStateChange || state.authSubscription) return false;
    let userId = null;
    const subscription = client.auth.onAuthStateChange((event, session) => {
      if (!session) {
        userId = null;
        setUnread(0, []);
        stopPolling();
        return;
      }
      startPolling();
      // Fetch on sign-in or a different person only. A token renewal
      // (TOKEN_REFRESHED) must not trigger a fetch: a 401 that renews the
      // token would otherwise fetch, 401 and renew again in a loop.
      const changed = session.user?.id !== userId;
      userId = session.user?.id || null;
      if (changed || event === 'SIGNED_IN') window.setTimeout(() => refreshNow(), 0);
    });
    state.authSubscription = subscription?.data?.subscription || subscription?.subscription || null;
    return true;
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    startPolling();
    refreshUnread();

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', () => refreshNow());
    // The service worker relays a Messages push so the badge updates at once.
    navigator.serviceWorker?.addEventListener?.('message', (event) => {
      if (event.data?.type === 'atlas:push' && event.data?.route === 'team') refreshNow({ silent: true });
    });
    // Messages announces every snapshot it applies (a read, a send).
    window.AtlasShell?.on?.('messages:unread', (detail) => {
      if (!detail || !teamIsVisible()) return;
      state.lastTotal = normalizeTotal(detail.total);
      state.loaded = true;
      state.conversations = (detail.conversations || []).map(({ id, name, unread, route, lastMessageAt, lastMessage }) => ({ id, name, unread, route, lastMessageAt, lastMessage: lastMessage || null }));
    });

    if (!subscribeToAuth()) {
      const authTimer = window.setInterval(() => {
        if (subscribeToAuth()) window.clearInterval(authTimer);
      }, 250);
      window.setTimeout(() => window.clearInterval(authTimer), 10000);
    }

    // A page kept in the back-forward cache (event.persisted) only pauses: it
    // keeps its auth subscription and resumes on pageshow. Only a page that is
    // really going away unsubscribes (audit L20).
    const onPageShow = (event) => {
      if (!event?.persisted || document.hidden) return;
      startPolling();
      refreshNow({ silent: true });
    };
    const onPageHide = (event) => {
      stopPolling();
      if (event?.persisted) return;
      state.authSubscription?.unsubscribe?.();
      state.authSubscription = null;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
  }

  window.AtlasTeamUnreadBadge = {
    refresh: () => refreshUnread(),
    count: () => state.lastTotal,
    loaded: () => state.loaded,
    conversations: () => state.conversations.map((entry) => ({ ...entry })),
    activeMembers: () => state.activeMembers,
    clear: () => setUnread(0, [])
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
