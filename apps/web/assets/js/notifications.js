(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const state = { status: 'pending', detail: 'Not checked', busy: false };

  function endpoint() {
    return String(cfg.NOTIFICATIONS_API || '').trim();
  }

  function supported() {
    return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  }

  function base64ToBytes(value) {
    const normalized = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  }

  async function session() {
    const result = await window.atlasSupabase?.auth?.getSession?.();
    if (result?.error) throw result.error;
    if (!result?.data?.session?.access_token) throw new Error('Sign in to manage notifications.');
    return result.data.session;
  }

  async function api(action, body) {
    if (!endpoint()) throw new Error('Notification delivery is not configured for this environment.');
    const active = await session();
    const response = await fetch(`${endpoint()}?action=${encodeURIComponent(action)}`, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${active.access_token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Notification request failed (${response.status}).`);
    return payload;
  }

  async function registration() {
    return navigator.serviceWorker.register('service-worker.js', { scope: './' });
  }

  async function refresh() {
    if (!supported()) {
      Object.assign(state, { status: 'unsupported', detail: 'This browser does not support push notifications.' });
      return { ...state };
    }
    if (Notification.permission === 'denied') {
      Object.assign(state, { status: 'denied', detail: 'Permission is blocked in browser settings.' });
      return { ...state };
    }
    const worker = await registration();
    const subscription = await worker.pushManager.getSubscription();
    Object.assign(state, subscription
      ? { status: 'enabled', detail: 'This device is subscribed.' }
      : { status: 'pending', detail: 'Notifications are off for this device.' });
    return { ...state };
  }

  async function enable() {
    if (state.busy) return { ...state };
    state.busy = true;
    try {
      if (!supported()) throw new Error('This browser does not support push notifications.');
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (permission !== 'granted') {
        Object.assign(state, { status: permission === 'denied' ? 'denied' : 'pending', detail: 'Permission was not granted.' });
        return { ...state };
      }
      const worker = await registration();
      const configuration = await api('configuration');
      if (!configuration.public_key) throw new Error('Notification delivery is not ready in this environment.');
      const subscription = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(configuration.public_key)
      });
      await api('subscribe', { subscription: subscription.toJSON() });
      Object.assign(state, { status: 'enabled', detail: 'This device is subscribed.' });
      return { ...state };
    } finally {
      state.busy = false;
    }
  }

  async function disable() {
    if (!supported()) return refresh();
    const worker = await registration();
    const subscription = await worker.pushManager.getSubscription();
    if (subscription) {
      await api('unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    Object.assign(state, { status: 'pending', detail: 'Notifications are off for this device.' });
    return { ...state };
  }

  window.AtlasNotifications = { supported, refresh, enable, disable, snapshot: () => ({ ...state }) };
})();
