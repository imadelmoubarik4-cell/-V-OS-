(() => {
  'use strict';

  const AUTH_PROJECT_URL = 'https://dnefgcmjcgxlynycxkts.supabase.co';
  const GATEWAY_HOST = 'uhbamqetppqmygesoeeh.supabase.co';
  const DEFAULT_TIMEOUT_MS = 22000;

  const state = {
    client: null,
    readyResolve: null,
    readyReject: null,
  };

  const ready = new Promise((resolve, reject) => {
    state.readyResolve = resolve;
    state.readyReject = reject;
  });

  function normalizeEndpoint(endpoint) {
    let url;
    try {
      url = new URL(String(endpoint || ''));
    } catch {
      throw new Error('Atlas gateway URL is invalid.');
    }
    if (url.protocol !== 'https:' || url.hostname !== GATEWAY_HOST) {
      throw new Error('Atlas gateway is outside the approved private runtime.');
    }
    if (!/^\/functions\/v1\/atlas-[a-z0-9-]+$/i.test(url.pathname)) {
      throw new Error('Atlas gateway path is invalid.');
    }
    url.search = '';
    url.hash = '';
    return url;
  }

  function installClientCapture() {
    const supabase = window.supabase;
    const originalCreateClient = supabase?.createClient;
    if (typeof originalCreateClient !== 'function') {
      state.readyReject?.(new Error('The Supabase client library did not load.'));
      return;
    }
    if (originalCreateClient.__atlasGatewayCapture) return;

    function capturedCreateClient(...args) {
      const client = originalCreateClient.apply(this, args);
      if (!state.client && String(args[0] || '').replace(/\/$/, '') === AUTH_PROJECT_URL) {
        state.client = client;
        state.readyResolve?.(client);
        supabase.createClient = originalCreateClient;
      }
      return client;
    }

    Object.defineProperty(capturedCreateClient, '__atlasGatewayCapture', { value: true });
    supabase.createClient = capturedCreateClient;
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => window.clearTimeout(timer));
  }

  async function request(endpoint, action, options = {}) {
    const url = normalizeEndpoint(endpoint);
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(normalizedAction)) throw new Error('Atlas gateway action is invalid.');

    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new Error('Atlas gateway method is not allowed.');
    url.searchParams.set('action', normalizedAction);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });

    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(1000, Math.min(60000, Number(options.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    const client = state.client || await withTimeout(
      ready,
      15000,
      'Atlas authentication did not become available.',
    );
    const sessionResult = await withTimeout(
      client.auth.getSession(),
      12000,
      'Atlas session verification took too long.',
    );
    if (sessionResult.error) throw sessionResult.error;
    const session = sessionResult.data?.session;
    if (!session?.access_token) throw new Error('Sign in again to continue.');

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const hasBody = method === 'POST' && options.body !== undefined;
      const response = await fetch(url, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(options.body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = typeof payload?.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : `Atlas gateway request failed (${response.status}).`;
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The Atlas gateway took too long to respond.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  window.AtlasGatewayBridge = Object.freeze({
    request,
    ready: () => ready.then(() => undefined),
  });

  installClientCapture();
})();
