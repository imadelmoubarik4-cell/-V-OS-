// Messages unread worker. Polls the Messages snapshot while the app is signed
// in so the shell's Messages badge (atlas-chrome.js reads count()) and the
// notifications feed stay current outside Messages. While Messages is open it
// reuses that page's snapshot so this poll never races its read cursor.
//
// Read API: count() · conversations() → [{ id, name, unread, route, lastMessageAt,
// lastMessage: { id, sender, body, deleted } | null }]
// · activeMembers() · refresh() · clear(). Each change is announced on the
// shell as 'messages:unread' { total, conversations }.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const POLL_MS = 8000;
  const REQUEST_TIMEOUT_MS = 12000;
  const state = {
    inFlight: false,
    timer: null,
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
      sender: message.message_type === 'system' ? 'Atlas' : senderOf(message),
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
    } catch (error) {
      if (!options.silent) console.warn('Messages unread count could not refresh.');
    } finally {
      state.inFlight = false;
    }
  }

  function startPolling() {
    if (state.timer) return;
    state.timer = window.setInterval(() => refreshUnread({ silent: true }), POLL_MS);
  }

  function stopPolling() {
    if (!state.timer) return;
    window.clearInterval(state.timer);
    state.timer = null;
  }

  function handleVisibility() {
    if (document.hidden) {
      stopPolling();
      return;
    }
    startPolling();
    refreshUnread();
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
      if (changed || event === 'SIGNED_IN') window.setTimeout(() => refreshUnread(), 0);
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
    window.addEventListener('focus', () => refreshUnread({ silent: true }));
    window.addEventListener('online', () => refreshUnread());
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

    window.addEventListener('pagehide', () => {
      stopPolling();
      state.authSubscription?.unsubscribe?.();
    }, { once: true });
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
