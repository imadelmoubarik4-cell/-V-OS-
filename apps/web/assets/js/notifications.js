(function () {
  'use strict';

  // Device notification state is derived from three sources that must agree:
  //   browser permission  → PushManager subscription on this device
  //   → the server's stored subscription for this profile.
  // "enabled" is reported only when the device subscription exists AND the
  // server confirms an enabled subscription. A device-only subscription (the
  // server call failed or was never made) is reported as "unsynced".
  //
  // Statuses: unsupported · denied · unavailable (server not configured)
  //           pending (off) · unsynced · enabled
  const cfg = window.VABAR_CONFIG || {};
  const state = {
    status: 'pending',
    detail: 'Not checked yet.',
    busy: false,
    deliveryEnabled: null,
    serverKey: null
  };

  function endpoint() {
    return String(cfg.NOTIFICATIONS_API || '').trim();
  }

  function supported() {
    return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  }

  function standaloneIos() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
    return { ios, standalone };
  }

  function unsupportedDetail() {
    const { ios, standalone } = standaloneIos();
    if (ios && !standalone) return 'On iPhone and iPad, add Atlas to the Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.';
    return 'This browser does not support push notifications.';
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
    if (!endpoint()) throw new Error('Notifications are not available in this environment.');
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

  function deliveryNote() {
    return state.deliveryEnabled === false
      ? ' Atlas has not switched on alert delivery yet, so nothing will arrive until it does.'
      : '';
  }

  function set(status, detail) {
    Object.assign(state, { status, detail });
    return snapshot();
  }

  function snapshot() {
    return { ...state };
  }

  async function serverConfiguration() {
    const configuration = await api('configuration');
    state.deliveryEnabled = configuration.delivery_enabled === true;
    state.serverKey = configuration.public_key || null;
    return configuration;
  }

  async function refresh() {
    if (!supported()) return set('unsupported', unsupportedDetail());
    if (Notification.permission === 'denied') {
      return set('denied', 'Notifications are blocked for Atlas in this browser. Allow them in the browser’s site settings, then return here.');
    }
    const worker = await registration();
    const subscription = await worker.pushManager.getSubscription();
    let configuration;
    try {
      configuration = await serverConfiguration();
    } catch (error) {
      return set(subscription ? 'unsynced' : 'pending', `Atlas could not confirm notification status: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!configuration.public_key) {
      return set('unavailable', 'Notifications are not set up on the Atlas server yet.');
    }
    if (!subscription) return set('pending', 'Notifications are off for this device.');
    if (!configuration.enabled) {
      return set('unsynced', 'This device has a subscription that Atlas has not saved. Turn notifications on again to reconnect it.');
    }
    return set('enabled', `This device is subscribed.${deliveryNote()}`);
  }

  async function enable() {
    if (state.busy) return snapshot();
    state.busy = true;
    let created = null;
    try {
      if (!supported()) return set('unsupported', unsupportedDetail());
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (permission !== 'granted') {
        return permission === 'denied'
          ? set('denied', 'Notifications are blocked for Atlas in this browser. Allow them in the browser’s site settings, then return here.')
          : set('pending', 'Permission was not granted. Notifications stay off.');
      }
      const configuration = await serverConfiguration();
      if (!configuration.public_key) return set('unavailable', 'Notifications are not set up on the Atlas server yet.');
      const worker = await registration();
      const existing = await worker.pushManager.getSubscription();
      const subscription = existing || await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(configuration.public_key)
      });
      if (!existing) created = subscription;
      await api('subscribe', { subscription: subscription.toJSON() });
      created = null;
      return set('enabled', `This device is subscribed.${deliveryNote()}`);
    } finally {
      // Never leave a device-only subscription behind: if the server did not
      // store it, the browser would otherwise report "on" with no delivery.
      if (created) await created.unsubscribe().catch(() => false);
      state.busy = false;
    }
  }

  async function disable() {
    if (!supported()) return set('unsupported', unsupportedDetail());
    const worker = await registration();
    const subscription = await worker.pushManager.getSubscription();
    if (subscription) {
      const endpointUrl = subscription.endpoint;
      // Unsubscribe the device first: OFF must stop delivery to this device
      // even if the server cannot be reached right now.
      await subscription.unsubscribe();
      try {
        await api('unsubscribe', { endpoint: endpointUrl });
      } catch (error) {
        set('pending', 'Notifications are off for this device.');
        throw new Error(`This device is unsubscribed, but Atlas could not update the server: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return set('pending', 'Notifications are off for this device.');
  }

  window.AtlasNotifications = { supported, refresh, enable, disable, snapshot };
})();
