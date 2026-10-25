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
  // App-wide background poll for the unread badge. 30s keeps the count "live
  // enough" for a secondary indicator while cutting steady-state requests ~73%
  // vs the former 8s (≈450→120 req/hour per idle tab). The Messages view itself
  // polls faster (~6s) while open, and this poll pauses when the tab is hidden.
  const POLL_MS = 30000;
  // The fast cadence only applies while the first snapshot has not yet landed AND
  // no request has actually failed — i.e. the app screen is still mid-boot and the
  // poll is a no-op (no network). It makes the badge populate promptly after
  // sign-in instead of waiting a full 30s tick, and is bounded so a login screen
  // that never signs in settles to POLL_MS.
  const WARMUP_MS = 2000;
  const WARMUP_MAX_ATTEMPTS = 8;
  // When a request actually fails (401/403/429/5xx or the API is unreachable) the
  // poll must NOT keep the fast cadence, or a persistently failing API would be
  // hit in a tight loop. Back off exponentially from 8s, doubling, capped at the
  // steady-state interval: 8s → 16s → 30s. The base is >= the former steady poll,
  // so a failing API is never polled faster than it was before this change.
  const ERROR_BASE_MS = 8000;
  const REQUEST_TIMEOUT_MS = 12000;
  const state = {
    inFlight: false,
    timer: null,
    timerToken: null,
    warmupAttempts: 0,
    errorStreak: 0,
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

  // Returns the outcome so the scheduler can pick the next cadence:
  //   'skipped' — no request was sent (not signed in, tab hidden, already in
  //               flight, or no session yet); safe to retry on the fast cadence.
  //   'loaded'  — a real snapshot was applied.
  //   'error'   — the request failed (HTTP error or unreachable); back off.
  async function refreshUnread(options = {}) {
    if (state.inFlight || document.hidden || !appIsSignedIn()) {
      if (!appIsSignedIn()) { setUnread(0, []); state.errorStreak = 0; }
      return 'skipped';
    }

    // While Messages is open, reuse its current full snapshot so the background
    // poll does not race against the channel mark-as-read request.
    if (teamIsVisible() && window.AtlasTeamMessages?.snapshot?.()) {
      setUnread(window.AtlasTeamMessages.unreadCount?.() || 0, conversationsFrom(window.AtlasTeamMessages.snapshot()?.channels), { fromSnapshot: true });
      state.errorStreak = 0;
      return 'loaded';
    }

    state.inFlight = true;
    try {
      const result = await fetchUnread();
      setUnread(result.total, result.conversations, { fromSnapshot: result.fromSnapshot });
      if (result.fromSnapshot) {
        state.errorStreak = 0;
        return 'loaded';
      }
      return 'skipped'; // no session yet: no API request was made, keep warming up
    } catch (error) {
      state.errorStreak += 1;
      if (!options.silent) console.warn('Messages unread count could not refresh.');
      return 'error';
    } finally {
      state.inFlight = false;
    }
  }

  // Delay until the next poll, chosen from the state the last attempt left behind.
  // Error backoff wins over everything, so a failing API is never polled fast.
  function nextDelay() {
    if (state.errorStreak > 0) {
      return Math.min(POLL_MS, ERROR_BASE_MS * Math.pow(2, state.errorStreak - 1));
    }
    if (!state.loaded && state.warmupAttempts < WARMUP_MAX_ATTEMPTS) return WARMUP_MS;
    return POLL_MS;
  }

  // Self-scheduling timer. A plain interval cannot change its own cadence, so each
  // tick re-arms the next one AFTER its refresh resolves, using that result's
  // delay. The first tick runs immediately (delay 0). A per-chain token means a
  // stop or restart during an in-flight refresh can never leave two timers running.
  function scheduleTick(delay) {
    const token = {};
    state.timerToken = token;
    state.timer = window.setTimeout(async () => {
      state.timer = null;
      // Count a warm-up attempt only while actually warming up (not erroring), so
      // the fast cadence is bounded and backoff is never cut short.
      if (!state.loaded && state.errorStreak === 0) state.warmupAttempts += 1;
      await refreshUnread({ silent: true });
      // Re-arm only if this chain is still the active one — not stopped, and not
      // superseded by a restart (e.g. a visibility flip) during the await.
      if (state.timerToken === token) scheduleTick(nextDelay());
    }, delay);
  }

  function startPolling() {
    if (state.timer !== null) return;
    scheduleTick(0); // poll now; subsequent cadence follows each result
  }

  function stopPolling() {
    if (state.timer === null) return;
    window.clearTimeout(state.timer);
    state.timer = null;
    state.timerToken = null;
  }

  function handleVisibility() {
    if (document.hidden) {
      stopPolling();
      return;
    }
    // Becoming visible restarts polling, whose first tick runs immediately.
    startPolling();
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

    startPolling(); // runs the first poll immediately, then re-arms by result

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
