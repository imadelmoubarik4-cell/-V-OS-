(function (root) {
  'use strict';
  const TARGET = 'atialqebqxcquzdkezln';
  function allowed(url, config, origin) {
    const value = new URL(url, origin);
    if (value.origin === origin) return true;
    if (value.origin === `https://${TARGET}.supabase.co`) return true;
    return false;
  }
  function validate(config) {
    if (config.MODE !== 'isolated-rehearsal') return;
    if (config.SUPABASE_URL !== `https://${TARGET}.supabase.co`) throw new Error('Rehearsal target mismatch.');
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.SUPABASE_ANON_KEY || '')) throw new Error('A staging publishable key is required.');
    for (const [key, value] of Object.entries(config)) {
      if (key.endsWith('_API') && value && !String(value).startsWith(`${config.SUPABASE_URL}/functions/v1/`)) throw new Error(`Rehearsal endpoint mismatch: ${key}`);
    }
  }
  const api = { TARGET, allowed, validate };
  if (typeof module !== 'undefined') module.exports = api;
  if (!root.document) return;
  root.AtlasRehearsalBoundary = api;
  const config = root.VABAR_CONFIG || {};
  let failure = null;
  try { validate(config); } catch (error) { failure = error; }
  const originalFetch = root.fetch.bind(root);
  root.fetch = function (input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (failure) return Promise.reject(failure);
    if (config.MODE === 'isolated-rehearsal' && !allowed(url, config, root.location.origin)) {
      return Promise.reject(new Error('This service is not connected to the isolated rehearsal.'));
    }
    if (!root.navigator.onLine && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return Promise.reject(new Error('Offline: nothing was submitted. Reconnect and refresh before saving.'));
    }
    return originalFetch(input, init);
  };
  const banner = document.createElement('div');
  banner.id = 'atlas-connection-status';
  banner.setAttribute('role', 'status');
  banner.style.cssText = 'position:sticky;top:0;z-index:10000;padding:10px 18px;background:#fff2c9;color:#372900;text-align:center';
  document.body.prepend(banner);
  const update = () => {
    banner.hidden = !failure && root.navigator.onLine && config.MODE !== 'isolated-rehearsal';
    banner.textContent = failure?.message || (!root.navigator.onLine
      ? 'Offline — showing this session’s last loaded data. Saves are paused; refresh after reconnecting.'
      : config.MODE === 'isolated-rehearsal' ? 'Isolated rehearsal — synthetic data only. Runtime modules require separate setup.' : '');
  };
  root.addEventListener('online', () => { update(); root.dispatchEvent(new CustomEvent('atlas:reconnected')); });
  root.addEventListener('offline', update);
  // Do not queue mutations. Unknown outcomes after a dropped connection must be
  // reconciled by refreshing, rather than replayed automatically.
  document.addEventListener('submit', event => {
    if (!root.navigator.onLine || failure) {
      event.preventDefault(); event.stopImmediatePropagation(); update();
    }
  }, true);
  update();
})(typeof window === 'undefined' ? {} : window);
