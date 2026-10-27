// Alcedo platform helpers (S89): the one browser request helper for Alcedo Edge
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
//   - network failures and timeouts have their own copy;
//   - a write (any method but GET/HEAD) that timed out after it was sent, or
//     got a 502/503/504, may still have been saved: it reads "couldn't confirm
//     whether this was saved" (or the module's `outcome_unknown` copy) and the
//     error carries `outcomeUnknown: true`, never "Nothing was changed";
//   - the deadline covers the session lookup, the request and the body.
// Errors are AtlasApiError { kind, status, code, message[, outcomeUnknown] }.
//
// AtlasApi.restReadFetch(supabaseUrl) is the Supabase client's fetch: it gives
// PostgREST reads (GET/HEAD under /rest/v1/) a deadline, so a stalled socket
// fails the read instead of leaving a page loading for minutes. Writes, RPCs,
// Auth and Storage are passed through untouched.
//
// AtlasIdentity.label(profile) is a person's display name, otherwise
// "Team member" — never an email address (S87 identity rule; mirrors
// supabase/functions/_shared/auth.mjs actorLabel).
(function () {
  'use strict';

  const MESSAGES = Object.freeze({
    auth: 'Alcedo couldn’t confirm your sign-in for this. Try again in a moment.',
    forbidden: 'Your Alcedo role can’t do this. Ask a manager if you need access.',
    not_found: 'That isn’t available any more. Refresh and try again.',
    conflict: 'This changed while you were working. Refresh and try again.',
    invalid: 'Alcedo couldn’t accept that. Check the details and try again.',
    too_large: 'That is too large to send. Try something smaller.',
    rate_limited: 'Too many requests just now. Wait a moment, then try again.',
    not_configured: 'This part of Alcedo isn’t set up for this venue yet.',
    unavailable: 'This part of Alcedo isn’t available right now. Nothing was changed. Try again shortly.',
    timeout: 'The connection timed out. Nothing was changed. Try again.',
    network: 'Alcedo couldn’t reach the server. Check the connection, then try again.',
    failed: 'Something went wrong. Nothing was changed. Try again.',
    outcome_unknown: 'Alcedo couldn’t confirm whether this was saved. Check before trying again.'
  });

  const DEFAULT_TIMEOUT_MS = 20000;
  const REST_READ_TIMEOUT_MS = 25000;
  const SESSION_TIMED_OUT = Symbol('session-timed-out');

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

  // A write that reached the server but whose answer was lost (timeout after
  // sending, or a 502/503/504 from a gateway in front of a function that may
  // have committed). Its result is unknown, so the copy never says "Nothing
  // was changed"; a module words it with messages.outcome_unknown, or with
  // messages[code] for a code of its own. A code that only names a generic
  // kind ('unavailable', 'timeout', 'failed', …, as atlas-bookings,
  // atlas-accounting and atlas-ai send on a lost RPC answer) never picks the
  // module's copy for that kind: that copy is written for a refusal and says
  // "Nothing was changed".
  function failUnknownOutcome(kind, status, code, messages) {
    const error = fail(kind, status, code, messages);
    const own = (key) => Object.prototype.hasOwnProperty.call(messages, key);
    const genericCode = code && Object.prototype.hasOwnProperty.call(MESSAGES, String(code).toLowerCase());
    const byOutcome = own('outcome_unknown') ? messages.outcome_unknown : null;
    const byCode = code && !genericCode && own(code) ? messages[code] : null;
    error.message = String(byOutcome || byCode || MESSAGES.outcome_unknown);
    error.outcomeUnknown = true;
    return error;
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
    const method = String(options.method || (options.body !== undefined ? 'POST' : 'GET')).toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD';

    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let expire = null;
    const expired = new Promise((resolve) => { expire = resolve; });
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); expire(SESSION_TIMED_OUT); }, timeoutMs);
    try {
      // getSession() can wait on the auth lock with no deadline of its own, so
      // it shares this request's deadline. Nothing has been sent yet: a
      // timeout here changed nothing.
      const token = await Promise.race([accessToken(), expired]);
      if (token === SESSION_TIMED_OUT) throw fail('timeout', 0, null, messages);
      if (!token) throw fail('auth', 401, null, messages);
      return await send(url, options, { messages, method, isWrite, token, controller, didTimeOut: () => timedOut });
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function send(url, options, { messages, method, isWrite, token, controller, didTimeOut }) {
    const target = new URL(String(url), window.location.href);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') target.searchParams.set(key, String(value));
    });
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (options.body !== undefined && !isForm) headers['content-type'] = 'application/json';

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response;
    try {
      response = await window.fetch(target.toString(), {
        method,
        cache: 'no-store',
        keepalive: Boolean(options.keepalive),
        signal: controller.signal,
        headers,
        body: isForm ? options.body : options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      if (error?.name === 'AbortError' && !didTimeOut() && options.signal?.aborted) throw error;
      if (didTimeOut()) throw isWrite ? failUnknownOutcome('timeout', 0, null, messages) : fail('timeout', 0, null, messages);
      throw fail('network', 0, null, messages);
    }

    // The body is read under the same deadline: a body that stalls after the
    // headers fails as a timeout instead of hanging (or reading as {}).
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload && typeof payload === 'object'
        ? (typeof payload.error_code === 'string' ? payload.error_code : typeof payload.code === 'string' ? payload.code : null)
        : null;
      const kind = kindFor(response.status, code);
      if (isWrite && kind === 'unavailable' && [502, 503, 504].includes(response.status)) throw failUnknownOutcome(kind, response.status, code, messages);
      throw fail(kind, response.status, code, messages);
    }
    if (didTimeOut()) throw isWrite ? failUnknownOutcome('timeout', 0, null, messages) : fail('timeout', 0, null, messages);
    return payload && typeof payload === 'object' ? payload : {};
  }

  // The Supabase client's fetch (atlas-app.js createClient global.fetch).
  // supabase-js sets no deadline, so a half-open socket (Wi-Fi/4G handover)
  // left reads spinning until the browser gave up (1–5 min). PostgREST reads
  // (GET/HEAD under <project>/rest/v1/) get a deadline; a stalled read then
  // returns supabase-js's usual { error } and the page shows its retry. Writes
  // and RPCs (POST), Auth and Storage are never cut short: their outcome would
  // be unknown. window.fetch is looked up per call, so the shell's 401 watcher
  // still sees every request.
  function restReadFetch(supabaseUrl, { timeoutMs = REST_READ_TIMEOUT_MS } = {}) {
    const base = String(supabaseUrl || '').replace(/\/+$/, '');
    const restPrefix = `${base}/rest/v1/`;
    return function atlasRestFetch(input, init) {
      const options = init || {};
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
      const method = String(options.method || 'GET').toUpperCase();
      if (!base || !url.startsWith(restPrefix) || (method !== 'GET' && method !== 'HEAD')) return window.fetch(input, init);
      const controller = new AbortController();
      const caller = options.signal;
      if (caller) {
        if (caller.aborted) controller.abort(caller.reason);
        else caller.addEventListener('abort', () => controller.abort(caller.reason), { once: true });
      }
      // Kept until it fires (aborting a finished read is a no-op), so a body
      // that stalls after the headers is cut short too.
      window.setTimeout(() => controller.abort(), timeoutMs);
      return window.fetch(input, { ...options, signal: controller.signal });
    };
  }

  // The message to show for any error (an AtlasApiError, or anything else).
  // Only copy Alcedo wrote itself is ever shown: an AtlasApiError (including
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

  window.AtlasApi = Object.freeze({ request, restReadFetch, message, fixed, kindFor, friendlyMessage, MESSAGES, AtlasApiError });
  window.AtlasIdentity = Object.freeze({ label, safeName, firstName, initials });
})();
