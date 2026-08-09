(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const POLL_MS = 8000;
  const REQUEST_TIMEOUT_MS = 12000;
  const state = {
    inFlight: false,
    timer: null,
    badgeObserver: null,
    badgeCleanupFrame: null,
    authSubscription: null,
    lastTotal: 0,
    initialized: false
  };

  function endpoint() {
    return String(cfg.TEAM_MESSAGES_API || '').trim();
  }

  function appIsSignedIn() {
    const app = document.getElementById('app-screen');
    const login = document.getElementById('auth-screen') || document.getElementById('login-screen');
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

  function connectBell() {
    let bell = document.getElementById('notifications-open');
    if (!bell) {
      bell = document.querySelector('.topbar .icon-button[title="Notifications are not connected yet"]')
        || document.querySelector('.topbar .icon-button[aria-label="Notifications are not connected yet"]');
    }
    if (!bell) return null;
    bell.id = 'notifications-open';
    bell.disabled = false;
    bell.title = 'Open Messages';
    bell.setAttribute('aria-label', 'Open Messages');
    if (bell.dataset.atlasMessagesBound !== 'true') {
      bell.dataset.atlasMessagesBound = 'true';
      bell.addEventListener('click', () => window.AtlasNext?.navigate?.('messages'));
    }
    return bell;
  }

  function badgeTargets() {
    return [
      {
        container: document.querySelector('#sidebar-nav .nav-item[data-view="messages"]')
          || document.querySelector('.nav-item[data-view="team"]'),
        className: 'team-nav-unread'
      },
      {
        container: connectBell()
          || document.querySelector('.topbar .icon-button[title="Notifications"]')
          || document.querySelector('.atlas-topbar .top-icon[title="Notifications"]'),
        className: 'team-bell-unread'
      }
    ];
  }

  function updateOneBadge(container, className, total) {
    if (!container) return;
    let badge = container.querySelector(`.${className}`);
    if (total <= 0) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = className;
      container.appendChild(badge);
    }
    const nextText = total > 99 ? '99+' : String(total);
    if (badge.textContent !== nextText) badge.textContent = nextText;
    badge.hidden = false;
    badge.style.display = 'inline-grid';
    badge.setAttribute('aria-label', `${total} unread team message${total === 1 ? '' : 's'}`);
  }

  function setUnreadTotal(value) {
    const total = normalizeTotal(value);
    state.lastTotal = total;
    badgeTargets().forEach(({ container, className }) => updateOneBadge(container, className, total));
  }

  function cleanLegacyZeroBadges() {
    document.querySelectorAll('.team-nav-unread,.team-bell-unread').forEach((badge) => {
      const total = normalizeTotal(badge.textContent);
      if (badge.hidden || total <= 0) badge.remove();
    });
  }

  function scheduleZeroCleanup() {
    if (state.badgeCleanupFrame) return;
    state.badgeCleanupFrame = window.requestAnimationFrame(() => {
      state.badgeCleanupFrame = null;
      cleanLegacyZeroBadges();
    });
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function fetchUnreadTotal() {
    const api = endpoint();
    if (!api) throw new Error('Team Messages API is not configured.');
    const session = await activeSession();
    if (!session?.access_token) return 0;
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
        headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return 0;
        throw new Error(payload.error || `Unread-count request failed (${response.status}).`);
      }
      return normalizeTotal(payload?.snapshot?.summary?.total_unread);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function refreshUnread(options = {}) {
    cleanLegacyZeroBadges();
    if (state.inFlight || document.hidden || !appIsSignedIn()) {
      if (!appIsSignedIn()) setUnreadTotal(0);
      return;
    }
    if (teamIsVisible() && window.AtlasTeamMessages?.snapshot?.()) {
      setUnreadTotal(window.AtlasTeamMessages.unreadCount?.() || 0);
      return;
    }
    state.inFlight = true;
    try {
      setUnreadTotal(await fetchUnreadTotal());
    } catch (error) {
      if (!options.silent) console.warn('Team unread badge could not refresh:', error?.message || error);
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

  function attachBadgeObserver() {
    state.badgeObserver?.disconnect();
    state.badgeObserver = new MutationObserver(scheduleZeroCleanup);
    badgeTargets().forEach(({ container }) => {
      if (!container) return;
      state.badgeObserver.observe(container, { childList: true });
    });
  }

  function subscribeToAuth() {
    const client = window.atlasSupabase;
    if (!client?.auth?.onAuthStateChange || state.authSubscription) return false;
    const subscription = client.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setUnreadTotal(0);
        stopPolling();
        return;
      }
      startPolling();
      window.setTimeout(() => refreshUnread(), 0);
    });
    state.authSubscription = subscription?.data?.subscription || subscription?.subscription || null;
    return true;
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    connectBell();
    attachBadgeObserver();
    cleanLegacyZeroBadges();
    startPolling();
    refreshUnread();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', () => refreshUnread({ silent: true }));
    window.addEventListener('online', () => refreshUnread());
    document.addEventListener('atlas:auth', () => {
      connectBell();
      attachBadgeObserver();
      refreshUnread();
    });
    if (!subscribeToAuth()) {
      const authTimer = window.setInterval(() => {
        if (subscribeToAuth()) window.clearInterval(authTimer);
      }, 250);
      window.setTimeout(() => window.clearInterval(authTimer), 10000);
    }
    window.addEventListener('pagehide', () => {
      stopPolling();
      state.badgeObserver?.disconnect();
      if (state.badgeCleanupFrame) window.cancelAnimationFrame(state.badgeCleanupFrame);
      state.authSubscription?.unsubscribe?.();
    }, { once: true });
  }

  window.AtlasTeamUnreadBadge = {
    refresh: () => refreshUnread(),
    count: () => state.lastTotal,
    clear: () => setUnreadTotal(0)
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
