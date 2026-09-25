// Atlas platform helpers (S89): the one browser request helper for Atlas Edge
// Functions, and the one staff identity label.
//
// AtlasApi.request(url, { method, body, params, timeoutMs, messages })
//   - adds the signed-in session's bearer token, sends/reads JSON (FormData
//     bodies are sent as-is), and times out;
//   - maps every failure to FIXED friendly copy chosen by HTTP status and the
//     server's error_code/code. Raw server or database text is never shown;
//     a module may pass `messages` keyed by error code or kind to word its own
//     cases;
//   - a 401 (or no session) reads "sign in again" and fires
//     `atlas:auth-required` so the shell can offer sign-in;
//   - network failures and timeouts have their own copy.
// Errors are AtlasApiError { kind, status, code, message }.
//
// AtlasIdentity.label(profile) is a person's display name, otherwise
// "Team member" — never an email address (S87 identity rule; mirrors
// supabase/functions/_shared/auth.mjs actorLabel).
(function () {
  'use strict';

  const MESSAGES = Object.freeze({
    auth: 'Atlas couldn’t confirm your sign-in for this. Try again in a moment.',
    forbidden: 'Your Atlas role can’t do this. Ask a manager if you need access.',
    not_found: 'That isn’t available any more. Refresh and try again.',
    conflict: 'This changed while you were working. Refresh and try again.',
    invalid: 'Atlas couldn’t accept that. Check the details and try again.',
    too_large: 'That is too large to send. Try something smaller.',
    rate_limited: 'Too many requests just now. Wait a moment, then try again.',
    not_configured: 'This part of Atlas isn’t set up for this venue yet.',
    unavailable: 'This part of Atlas isn’t available right now. Nothing was changed. Try again shortly.',
    timeout: 'The connection timed out. Nothing was changed. Try again.',
    network: 'Atlas couldn’t reach the server. Check the connection, then try again.',
    failed: 'Something went wrong. Nothing was changed. Try again.'
  });

  const DEFAULT_TIMEOUT_MS = 20000;

  class AtlasApiError extends Error {
    constructor(kind, message, status = 0, code = null) {
      super(message);
      this.name = 'AtlasApiError';
      this.kind = kind;
      this.status = status;
      this.code = code;
    }
  }

  // Kind from status and the server's machine-readable code (never its text).
  function kindFor(status, code) {
    const key = String(code || '').toLowerCase();
    if (status === 401 || key === 'auth_required' || key === 'unauthenticated') return 'auth';
    if (status === 403 || key === 'forbidden') return 'forbidden';
    if (status === 404 || key === 'not_found') return 'not_found';
    if (status === 409 || key === 'conflict' || key === 'stale' || key === 'stale_item') return 'conflict';
    if (status === 413) return 'too_large';
    if (status === 429 || key === 'rate_limited') return 'rate_limited';
    if (key === 'not_configured') return 'not_configured';
    if (status >= 400 && status < 500) return 'invalid';
    if (status === 502 || status === 503 || status === 504) return 'unavailable';
    return 'failed';
  }

  function friendlyMessage(kind, code, messages = {}) {
    const byCode = code && Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : null;
    const byKind = Object.prototype.hasOwnProperty.call(messages, kind) ? messages[kind] : null;
    return String(byCode || byKind || MESSAGES[kind] || MESSAGES.failed);
  }

  function fail(kind, status, code, messages) {
    if (kind === 'auth') {
      try { window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status } })); } catch (_) { /* no window events */ }
    }
    return new AtlasApiError(kind, friendlyMessage(kind, code, messages), status, code);
  }

  async function accessToken() {
    const client = window.atlasSupabase;
    if (!client?.auth?.getSession) return null;
    try {
      const result = await client.auth.getSession();
      return result?.data?.session?.access_token || null;
    } catch (_) {
      return null;
    }
  }

  async function request(url, options = {}) {
    const messages = options.messages || {};
    if (!url) throw fail('not_configured', 0, null, messages);
    const token = await accessToken();
    if (!token) throw fail('auth', 401, null, messages);

    const target = new URL(String(url), window.location.href);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') target.searchParams.set(key, String(value));
    });
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (options.body !== undefined && !isForm) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response;
    try {
      response = await window.fetch(target.toString(), {
        method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
        cache: 'no-store',
        keepalive: Boolean(options.keepalive),
        signal: controller.signal,
        headers,
        body: isForm ? options.body : options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      if (error?.name === 'AbortError' && !timedOut && options.signal?.aborted) throw error;
      throw fail(timedOut ? 'timeout' : 'network', 0, null, messages);
    } finally {
      window.clearTimeout(timer);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload && typeof payload === 'object'
        ? (typeof payload.error_code === 'string' ? payload.error_code : typeof payload.code === 'string' ? payload.code : null)
        : null;
      throw fail(kindFor(response.status, code), response.status, code, messages);
    }
    return payload && typeof payload === 'object' ? payload : {};
  }

  // The message to show for any error (an AtlasApiError, or anything else).
  // Only copy Atlas wrote itself is ever shown: an AtlasApiError (including
  // fixed()) or a module error marked `atlasFixed` (AtlasCapture's
  // CaptureError). A JavaScript error (TypeError, …) or server text reads as
  // `fallback` and is logged to the console only.
  function message(error, fallback = MESSAGES.failed) {
    if (error instanceof AtlasApiError || (error && error.atlasFixed === true && typeof error.message === 'string' && error.message)) return error.message;
    if (error && typeof error === 'object' && error.name !== 'AbortError') {
      try { console.warn('[atlas] shown as fixed copy:', error); } catch (_) { /* no console */ }
    }
    return String(fallback);
  }

  // A module's own fixed, friendly copy as a showable error. `props` keeps
  // machine fields (code, status, …) for the module's own branching.
  function fixed(text, props = {}) {
    const error = new AtlasApiError(props.kind || 'failed', String(text || MESSAGES.failed), Number(props.status) || 0, props.code ?? null);
    error.atlasFixed = true;
    Object.keys(props).forEach((key) => { if (!['kind', 'status', 'code', 'message'].includes(key)) error[key] = props[key]; });
    return error;
  }

  // ---- identity -----------------------------------------------------------

  function safeName(value) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    return text && !text.includes('@') ? text.slice(0, 120) : '';
  }

  function label(profile, fallback = 'Team member') {
    return safeName(profile?.display_name) || safeName(profile?.displayName) || safeName(profile?.name) || safeName(fallback) || 'Team member';
  }

  function firstName(profile) {
    const name = safeName(profile?.display_name) || safeName(profile?.displayName) || safeName(profile?.name);
    return name ? name.split(' ')[0] : '';
  }

  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || 'A';
  }

  window.AtlasApi = Object.freeze({ request, message, fixed, kindFor, friendlyMessage, MESSAGES, AtlasApiError });
  window.AtlasIdentity = Object.freeze({ label, safeName, firstName, initials });
})();
