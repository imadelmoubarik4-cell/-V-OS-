// Alcedo app shell start-up: Supabase client, sign-in, session lifecycle,
// shell data loading and the base views. Moved out of index.html in S96 so the
// Content-Security-Policy can drop script-src 'unsafe-inline' (docs/SECURITY.md).
// A classic script: its top-level declarations stay global, exactly as when
// this code was inline.
  const SUPABASE_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
  ];
  const SUPABASE_SRI = 'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug';

  function showBootError(msg, prefix = 'Setup problem') {
    const err = document.getElementById('login-error');
    if (!err) return;
    console.error(prefix, msg);
    err.textContent = "Alcedo couldn't connect. Check your connection, then try again.";
    err.hidden = false;
  }

  function clearBootError() {
    const err = document.getElementById('login-error');
    if (!err) return;
    err.textContent = '';
    err.hidden = true;
  }

  function loadScriptWithTimeout(src, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find(script => script.src === src);
      if (existing && window.supabase?.createClient) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      const timer = window.setTimeout(() => {
        script.remove();
        reject(new Error('Timed out while loading ' + src));
      }, timeoutMs);

      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.integrity = SUPABASE_SRI;
      script.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error('Could not load ' + src));
      };
      document.head.appendChild(script);
    });
  }

  async function ensureSupabaseLibrary() {
    if (window.supabase?.createClient) return window.supabase;

    const failures = [];
    for (const src of SUPABASE_CDN_URLS) {
      try {
        await loadScriptWithTimeout(src);
        if (window.supabase?.createClient) return window.supabase;
        failures.push(src + ' loaded without exposing createClient');
      } catch (error) {
        failures.push(error.message);
      }
    }

    throw new Error(
      'The Supabase client library could not load. Check the internet connection or disable a content blocker, then refresh. ' +
      failures.join(' | ')
    );
  }

  const cfg = window.VABAR_CONFIG || {};

  // S96 (session fixation / login CSRF): Alcedo never signs in from tokens in
  // the address bar. Recovery and invitation links are consumed on their own
  // pages from a single-use token hash; anything that still arrives here with
  // auth parameters in the fragment is dropped before the client starts, so a
  // crafted link can neither plant someone else's session nor sign this
  // device out.
  (function dropAuthFragment() {
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      if (['access_token', 'refresh_token', 'token_hash', 'provider_token', 'error_description', 'error_code'].some((key) => params.has(key))) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (_) { /* never block start-up */ }
  })();
  let sb = null;

  // Every workspace talks to Supabase (Edge Functions, PostgREST) through
  // fetch, some directly. A 401 from the project, whichever module saw it,
  // starts the same check: renew this device's session, or return to sign-in
  // (see 'atlas:auth-required' below). Auth endpoints themselves are left out.
  (function watchSupabaseAuth() {
    const base = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');
    if (!base || typeof window.fetch !== 'function' || window.fetch.atlasAuthWatch) return;
    const original = window.fetch.bind(window);
    const watched = async (input, init) => {
      const response = await original(input, init);
      try {
        const url = typeof input === 'string' ? input : (input?.url || String(input));
        if (response.status === 401 && url.startsWith(base) && !url.startsWith(`${base}/auth/`)) {
          window.dispatchEvent(new CustomEvent('atlas:auth-required', { detail: { status: 401 } }));
        }
      } catch (_) { /* never break the request */ }
      return response;
    };
    watched.atlasAuthWatch = true;
    window.fetch = watched;
  })();
  let supabaseReady = null;

  async function initializeSupabase() {
    if (sb?.auth) return sb;
    if (supabaseReady) return supabaseReady;

    supabaseReady = (async () => {
      if (!window.VABAR_CONFIG) {
        throw new Error('config.js did not load. Make sure config.js is in the repository root beside index.html.');
      }
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
        throw new Error('config.js is missing the Supabase URL or publishable key.');
      }
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.SUPABASE_URL)) {
        throw new Error('The Supabase URL in config.js is not valid.');
      }

      const library = await ensureSupabaseLibrary();
      const client = library.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });

      if (!client?.auth) {
        throw new Error('The Supabase client initialized without the Auth module.');
      }

      sb = client;
      window.atlasSupabase = client;
      // Supabase ends the session itself when a refresh is refused (the
      // session was revoked or expired). Never stay half signed in.
      client.auth.onAuthStateChange((event) => {
        if (event !== 'SIGNED_OUT' || !currentUser || signingOut) return;
        let deliberate = false;
        try { deliberate = Date.now() - Number(localStorage.getItem(SIGNED_OUT_AT_KEY) || 0) < 15000; } catch (_) { /* storage unavailable */ }
        if (deliberate) { signingOut = true; location.reload(); return; }
        sessionEnded();
      });
      clearBootError();
      return client;
    })();

    try {
      return await supabaseReady;
    } catch (error) {
      supabaseReady = null;
      throw error;
    }
  }

  window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled Alcedo error:', event.reason);
  });

  const loginScreen = document.getElementById('login-screen');
  const appScreen = document.getElementById('app-screen');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const loginBtn = document.getElementById('login-btn');
  const loginCooldownEl = document.getElementById('login-cooldown');
  const loginCaptchaEl = document.getElementById('login-captcha');
  const userEmailEl = document.getElementById('user-email');

  let currentUser = null;
  let currentProfile = null;

  function canManageCommercial() {
    return ['admin', 'manager'].includes(currentProfile?.role);
  }

  window.atlasCanManageCommercial = canManageCommercial;

  function requireCommercialManager(action = 'This action') {
    if (canManageCommercial()) return true;
    window.AtlasShell.toast(`${action} is for managers. Ask an administrator if you need access.`, { tone: 'info' });
    return false;
  }

  function applyRoleVisibility() {
    document.body.classList.toggle('atlas-commercial-manager', canManageCommercial());
    window.atlasCurrentProfile = currentProfile
      ? { id: currentProfile.id, role: currentProfile.role, active: currentProfile.active }
      : null;
    // Emits the shell's profile:ready event (mirrored as window 'atlas:profile-ready').
    window.AtlasShell.profileReady(window.atlasCurrentProfile);
  }

  function showDataBoundaryError(label) {
    // Home shows one neutral "couldn't be loaded" row with Try again (home.js).
    window.AtlasShell.emit('data:error', { source: label });
  }

  let items = [];
  let restockLog = [];
  let inventoryMovements = [];
  let recipes = [];
  let suppliers = [];
  let locations = [];
  let itemLocations = [];
  let countSnapshot = null;
  let itemsStatus = 'loading';
  // Health of each shell data input: 'loading' | 'ok' | 'failed', plus the
  // derived stock state: 'ok' | 'partial' (items loaded but verified balances
  // or movements did not, so no stock figure is projected) | 'failed'.
  let dataHealth = { inventory: 'loading', balances: 'loading', movements: 'loading', recipes: 'loading', suppliers: 'loading', locations: 'loading', stock: 'loading', stockMissing: [] };
  // Read-only access to the loaded, role-filtered records for other modules
  // (Inventory, Purchasing, Search). Returns the same arrays every page renders
  // from; status() says whether the last inventory load failed (the previous
  // rows are kept, never blanked) or is 'partial' (stock withheld); health()
  // says which input failed.
  window.AtlasData = Object.freeze({
    items: () => items,
    recipes: () => recipes,
    suppliers: () => suppliers,
    movements: () => inventoryMovements,
    locations: () => locations,
    itemLocations: () => itemLocations,
    countSnapshot: () => countSnapshot,
    status: () => ({ items: itemsStatus, stock: dataHealth.stock }),
    health: () => ({ ...dataHealth, stockMissing: [...dataHealth.stockMissing] })
  });
  let draftIngredients = [];
  let activeView = 'dashboard';


  // ---------- AUTH ----------
  function setLoginBusy(busy, label = 'Sign in') {
    loginBtn.disabled = busy;
    loginBtn.classList.toggle('is-loading', busy);
    loginBtn.setAttribute('aria-busy', String(busy));
    loginBtn.textContent = label;
  }
  function showLoginError(message) {
    loginError.textContent = message;
    loginError.hidden = !message;
    ['email', 'password'].forEach((id) => document.getElementById(id)?.setAttribute('aria-invalid', String(Boolean(message))));
  }
  // Inline field errors (design system §6.6) instead of the browser's
  // validation bubble: the form is novalidate and says what to fix under the
  // field, linked with aria-describedby.
  function showFieldError(id, message) {
    const input = document.getElementById(id);
    const error = document.getElementById(`${id}-error`);
    if (error) { error.textContent = message; error.hidden = !message; }
    input?.setAttribute('aria-invalid', String(Boolean(message)));
  }
  function validateLogin(email, password) {
    const emailProblem = !email ? 'Enter your email.' : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter an email address like name@example.com.');
    const passwordProblem = password ? '' : 'Enter your password.';
    showFieldError('email', emailProblem);
    showFieldError('password', passwordProblem);
    if (emailProblem) document.getElementById('email')?.focus();
    else if (passwordProblem) document.getElementById('password')?.focus();
    return !emailProblem && !passwordProblem;
  }
  ['email', 'password'].forEach((id) => document.getElementById(id)?.addEventListener('input', () => {
    if (document.getElementById(`${id}-error`)?.hidden === false) showFieldError(id, '');
  }));

  // ---------- LOGIN ABUSE SPEED-BUMP (S99) ----------
  // A CLIENT-SIDE UX brake only. It is NOT a security boundary on its own: it
  // lives in this one browser, can be cleared, and only slows repeated guesses
  // from a single device. Supabase Auth's own server-side rate limits remain the
  // real control (OWNER-GATED in the Supabase dashboard › Auth › Rate Limits).
  // Only genuine bad-credential failures count; a network/503 blip never does,
  // so a connectivity problem is never punished. A successful sign-in clears it.
  // The counter is kept in memory and mirrored to localStorage so a reload does
  // not reset an attacker's cooldown; all storage access is wrapped in try/catch
  // (private mode / disabled storage must never break sign-in).
  const LOGIN_THROTTLE_KEY = 'atlas:login-throttle.v1';
  // Progressive cooldown, checked high-to-low: 5–7 failures → 30s, 8–9 → 2 min,
  // 10+ → 5 min. Below 5 failures there is no cooldown.
  const LOGIN_LOCKOUT_STEPS = [
    { fails: 10, cooldownMs: 300000 },
    { fails: 8, cooldownMs: 120000 },
    { fails: 5, cooldownMs: 30000 }
  ];
  let loginFailures = 0;      // consecutive bad-credential failures (this device)
  let loginLockedUntil = 0;   // epoch ms before which the next attempt is refused
  let loginCooldownTimer = null;
  function cooldownForFailures(fails) {
    for (const step of LOGIN_LOCKOUT_STEPS) if (fails >= step.fails) return step.cooldownMs;
    return 0;
  }
  function loginCooldownRemaining() {
    return Math.max(0, loginLockedUntil - Date.now());
  }
  function readLoginThrottle() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOGIN_THROTTLE_KEY) || 'null');
      if (raw && typeof raw.fails === 'number') {
        loginFailures = raw.fails;
        loginLockedUntil = Number(raw.until) || 0;
      }
    } catch (_) { /* storage unavailable (private mode) */ }
  }
  function writeLoginThrottle() {
    try { localStorage.setItem(LOGIN_THROTTLE_KEY, JSON.stringify({ fails: loginFailures, until: loginLockedUntil })); } catch (_) { /* storage unavailable */ }
  }
  function clearLoginThrottle() {
    loginFailures = 0;
    loginLockedUntil = 0;
    if (loginCooldownTimer) { clearInterval(loginCooldownTimer); loginCooldownTimer = null; }
    if (loginCooldownEl) { loginCooldownEl.textContent = ''; loginCooldownEl.hidden = true; }
    try { localStorage.removeItem(LOGIN_THROTTLE_KEY); } catch (_) { /* storage unavailable */ }
  }
  function registerLoginFailure() {
    loginFailures += 1;
    const cooldownMs = cooldownForFailures(loginFailures);
    loginLockedUntil = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
    writeLoginThrottle();
  }
  // Calm, polite countdown. The button is disabled (never spinning) for the
  // duration; the message never reveals whether the email exists.
  function renderLoginCooldown() {
    const remaining = loginCooldownRemaining();
    if (remaining <= 0) { endLoginCooldown(); return; }
    loginBtn.disabled = true;
    loginBtn.classList.remove('is-loading');
    loginBtn.removeAttribute('aria-busy');
    loginBtn.textContent = 'Sign in';
    if (loginCooldownEl) {
      loginCooldownEl.textContent = `Too many attempts. Try again in ${Math.ceil(remaining / 1000)}s.`;
      loginCooldownEl.hidden = false;
    }
  }
  function startLoginCooldown() {
    if (loginCooldownTimer) clearInterval(loginCooldownTimer);
    renderLoginCooldown();
    loginCooldownTimer = setInterval(renderLoginCooldown, 1000);
  }
  function endLoginCooldown() {
    if (loginCooldownTimer) { clearInterval(loginCooldownTimer); loginCooldownTimer = null; }
    if (loginCooldownEl) { loginCooldownEl.textContent = ''; loginCooldownEl.hidden = true; }
    if (!bootRetry && loginCooldownRemaining() <= 0) loginBtn.disabled = false;
  }
  readLoginThrottle();

  // ---------- CAPTCHA (OWNER-GATED, inert by default) ----------
  // Threads a provider token through Supabase Auth, but only when the owner sets
  // AUTH_CAPTCHA_PROVIDER in config.js AND enables the same provider in the
  // Supabase dashboard. With no provider (the default) this is a strict no-op:
  // no script loads, no widget renders, and captchaOptions() returns undefined
  // so signInWithPassword is called with exactly { email, password } as before.
  // When a provider is turned on, its script and frame origins MUST be added to
  // the netlify CSP (script-src / frame-src) — OWNER-GATED, not broadened here.
  const CAPTCHA_PROVIDERS = {
    hcaptcha: { script: 'https://js.hcaptcha.com/1/api.js?render=explicit', api: () => window.hcaptcha },
    turnstile: { script: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', api: () => window.turnstile }
  };
  const captchaProvider = CAPTCHA_PROVIDERS[String(cfg.AUTH_CAPTCHA_PROVIDER || '').toLowerCase()] || null;
  const captchaSiteKey = String(cfg.AUTH_CAPTCHA_SITE_KEY || '');
  let captchaWidgetId = null;
  let captchaToken = '';
  function captchaEnabled() { return Boolean(captchaProvider && captchaSiteKey); }
  function loadCaptchaScript() {
    return new Promise((resolve, reject) => {
      if (captchaProvider.api()) { resolve(); return; }
      const existing = [...document.scripts].find((script) => script.src === captchaProvider.script);
      if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', () => reject(new Error('captcha unavailable'))); return; }
      const script = document.createElement('script');
      script.src = captchaProvider.script;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('captcha unavailable'));
      document.head.appendChild(script);
    });
  }
  async function renderCaptcha() {
    if (!captchaEnabled() || !loginCaptchaEl || captchaWidgetId !== null) return;
    try {
      await loadCaptchaScript();
      const api = captchaProvider.api();
      if (!api?.render) return;
      captchaWidgetId = api.render(loginCaptchaEl, {
        sitekey: captchaSiteKey,
        callback: (token) => { captchaToken = token || ''; },
        'expired-callback': () => { captchaToken = ''; },
        'error-callback': () => { captchaToken = ''; }
      });
      loginCaptchaEl.hidden = false;
    } catch (_) { /* provider unreachable: the server still enforces its own check */ }
  }
  function resetCaptcha() {
    captchaToken = '';
    try { if (captchaWidgetId !== null) captchaProvider?.api()?.reset?.(captchaWidgetId); } catch (_) { /* ignore */ }
  }
  // undefined when disabled, so the no-op path adds no captchaToken key at all.
  function captchaOptions() {
    return captchaEnabled() ? { captchaToken } : undefined;
  }

  // Set when start-up could not finish (connection, or the staff profile could
  // not be read for a kept session): the button then retries start-up.
  let bootRetry = false;
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (bootRetry) { location.reload(); return; }
    // Still cooling down (button disabled, but guard the keyboard/programmatic
    // submit path too): re-show the countdown, attempt nothing.
    if (loginCooldownRemaining() > 0) { startLoginCooldown(); return; }
    showLoginError('');
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!validateLogin(email, password)) return;
    setLoginBusy(true, 'Signing in…');
    try {
      const client = await initializeSupabase();
      // captchaToken key is present only when a provider is configured (no-op otherwise).
      const options = captchaOptions();
      const { data, error } = await client.auth.signInWithPassword(options ? { email, password, options } : { email, password });
      setLoginBusy(false);
      if (error) {
        console.warn('Sign-in failed', error.status || '', error.message);
        const badCredentials = error.status === 400 || /invalid/i.test(error.message || '');
        if (badCredentials) {
          // A genuine wrong email/password: count it toward the speed-bump.
          registerLoginFailure();
          resetCaptcha();
          showLoginError('Email or password is incorrect.');
          if (loginCooldownRemaining() > 0) startLoginCooldown();
        } else {
          // Network / 503 / other: a connectivity blip, never counted.
          showLoginError("Alcedo couldn't sign you in right now. Check your connection and try again.");
        }
        return;
      }
      clearLoginThrottle();
      await onSignedIn(data.session);
    } catch (e) {
      console.error('Sign-in failed', e);
      setLoginBusy(false);
      showLoginError(e?.code === 'inactive_profile' ? INACTIVE_PROFILE_MESSAGE : "Alcedo couldn't sign you in right now. Check your connection and try again.");
    }
  });
  document.getElementById('login-password-toggle')?.addEventListener('click', (event) => {
    const input = document.getElementById('password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-pressed', String(show));
    event.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    event.currentTarget.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}" aria-hidden="true"></i>`;
    window.lucide?.createIcons?.();
  });

  // Sign out (account menu, More sheet). Used by assets/js/atlas-chrome.js.
  // Always this device only: supabase-js defaults to scope 'global', which
  // revokes every session of the account and signs out the person's other
  // phones and computers too.
  // If Auth cannot be reached, supabase-js keeps the stored session; this
  // device must still end up signed out (a shared bar tablet), so the stored
  // session is removed here.
  let signingOut = false;
  const SIGNED_OUT_AT_KEY = 'atlas:signed-out-at';
  async function signOut() {
    signingOut = true;
    // Other tabs of this browser receive SIGNED_OUT too; this tells them it
    // was on purpose (no "session ended" notice there).
    try { localStorage.setItem(SIGNED_OUT_AT_KEY, String(Date.now())); } catch (_) { /* storage unavailable */ }
    try {
      window.AtlasPalette?.clearRecent?.();
      const client = await initializeSupabase();
      const result = await client.auth.signOut({ scope: 'local' }).catch((error) => ({ error }));
      if (result?.error) forgetStoredSession(client);
    } catch (_) {
      forgetStoredSession(sb);
    } finally {
      location.reload();
    }
  }
  function forgetStoredSession(client) {
    const key = client?.auth?.storageKey || (cfg.SUPABASE_URL ? `sb-${new URL(cfg.SUPABASE_URL).hostname.split('.')[0]}-auth-token` : null);
    try { if (key) localStorage.removeItem(key); } catch (_) { /* storage unavailable */ }
  }
  window.atlasSignOut = signOut;

  // One consistent state when the session is over: this device's session is
  // cleared (never the person's other devices) and Alcedo returns to the
  // sign-in screen with a clear message, keeping the page address so signing
  // in again reopens it with every module loaded fresh. No page is left
  // showing old data, spinning, or signed in while its requests fail.
  const SESSION_ENDED_KEY = 'atlas:session-ended';
  const SESSION_ENDED_AT_KEY = 'atlas:session-ended-at';
  const RENEW_COOLDOWN_MS = 60000;
  let sessionEnding = false;
  async function sessionEnded() {
    if (sessionEnding) return;
    sessionEnding = true;
    // Never reload in a loop: a second automatic sign-out within a minute
    // (the first one could not clear the session) stays on this page.
    let recent = false;
    try {
      recent = Date.now() - Number(sessionStorage.getItem(SESSION_ENDED_AT_KEY) || 0) < RENEW_COOLDOWN_MS;
      sessionStorage.setItem(SESSION_ENDED_AT_KEY, String(Date.now()));
      sessionStorage.setItem(SESSION_ENDED_KEY, '1');
    } catch (_) { /* storage unavailable */ }
    if (recent) {
      forgetStoredSession(sb);
      window.AtlasShell?.toast?.('Your session ended. Reload Alcedo and sign in again.', { tone: 'warning', duration: 15000 });
      return;
    }
    await signOut();
  }

  // Sign-in could not be checked (Auth busy or unreachable): the session is
  // kept and the person is told once a minute, nothing is signed out.
  let authNoticeAt = 0;
  function authUnavailableNotice() {
    if (Date.now() - authNoticeAt < RENEW_COOLDOWN_MS) return;
    authNoticeAt = Date.now();
    window.AtlasShell?.toast?.('Alcedo can’t check your sign-in right now. You’re still signed in; try again in a moment.', { tone: 'warning' });
  }
  // A refresh error is final only when Auth says the session is gone.
  function sessionIsGone(error) {
    if (!error) return false;
    if (error.name === 'AuthSessionMissingError') return true;
    const status = Number(error.status || 0);
    return status === 400 || status === 401 || status === 403;
  }

  // A 401 from any module first renews this device's session (an access token
  // can simply have expired). At most one renewal per minute: a 401 that
  // persists after a fresh renewal is the endpoint's problem, not the
  // session's, and must never loop or sign anyone out.
  let authCheck = null;
  let lastRenewedAt = 0;
  window.addEventListener('atlas:auth-required', () => {
    if (authCheck || sessionEnding || signingOut || !currentUser) return;
    if (Date.now() - lastRenewedAt < RENEW_COOLDOWN_MS) return;
    authCheck = (async () => {
      let result = null;
      try {
        const client = await initializeSupabase();
        // A token that is not about to expire is checked first: if Auth still
        // accepts the session, the 401 is the endpoint's problem and nothing
        // is renewed (fewer renewals, so no renewal rate limit either).
        const current = (await client.auth.getSession()).data?.session;
        const expiresInMs = current?.expires_at ? current.expires_at * 1000 - Date.now() : 0;
        if (current && expiresInMs > 60000) {
          const check = await client.auth.getUser().catch((error) => ({ error }));
          if (!check?.error && check?.data?.user) { lastRenewedAt = Date.now(); return; }
          const status = Number(check?.error?.status || 0);
          if (!(status === 400 || status === 401 || status === 403 || check?.error?.name === 'AuthSessionMissingError')) {
            lastRenewedAt = Date.now();
            authUnavailableNotice();
            return;
          }
        }
        result = await client.auth.refreshSession();
      } catch (error) {
        result = { error };
      }
      if (!result?.error && result?.data?.session) {
        lastRenewedAt = Date.now();
        window.dispatchEvent(new CustomEvent('atlas:auth-renewed'));
        return;
      }
      if (sessionIsGone(result?.error)) { await sessionEnded(); return; }
      lastRenewedAt = Date.now();
      authUnavailableNotice();
    })().finally(() => { authCheck = null; });
  });

  const INACTIVE_PROFILE_MESSAGE = 'This account is not an active VÁ staff profile. Ask an administrator to review access.';
  async function loadActiveProfile(session) {
    const { data, error } = await sb
      .from('profiles')
      .select('id,email,display_name,role,active')
      .eq('id', session.user.id)
      .maybeSingle();

    const allowedRoles = new Set(['admin', 'manager', 'bartender', 'viewer']);
    if (error) {
      // A read error is a connection problem, not an access decision: keep
      // the session (on this and every other device) and let the person retry.
      const problem = new Error('The staff profile could not be read.');
      problem.code = 'profile_unavailable';
      throw problem;
    }
    if (!data?.active || !allowedRoles.has(data.role)) {
      // A missing, inactive or unknown-role profile is an access problem the
      // person can act on. Clear this device's session only.
      signingOut = true;
      await sb.auth.signOut({ scope: 'local' }).catch(() => null);
      signingOut = false;
      currentUser = null;
      const problem = new Error(INACTIVE_PROFILE_MESSAGE);
      problem.code = 'inactive_profile';
      throw problem;
    }
    currentProfile = data;
    applyRoleVisibility();
    return data;
  }

  // S96: second-factor step. A person with a verified authenticator app
  // confirms a 6-digit code after the password, which upgrades this session
  // to aal2. Manager and administrator tools require aal2 once a factor is
  // enrolled (_shared/auth.mjs and private.is_manager_or_admin); without it the
  // person keeps staff access and can retry by signing in again.
  async function ensureAssurance(client, ask = (message) => window.prompt(message)) {
    try {
      const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!data || data.currentLevel === 'aal2' || data.nextLevel !== 'aal2') return 'not_required';
      const listed = await client.auth.mfa.listFactors();
      const factor = (listed?.data?.totp || []).find((candidate) => candidate.status === 'verified');
      if (!factor) return 'not_required';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = String(ask(attempt ? 'That code did not work. Enter the current 6-digit code from your authenticator app.' : 'Enter the 6-digit code from your authenticator app.') || '').replace(/\s+/g, '');
        if (!/^\d{6}$/.test(code)) return 'skipped';
        const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
        if (!error) return 'verified';
      }
      return 'failed';
    } catch (_) {
      return 'unavailable';
    }
  }
  window.atlasEnsureAssurance = ensureAssurance;

  // S99 two-factor ENTRY gate. Two independent things are enforced here and must
  // not be confused:
  //   * A person who ALREADY has a verified authenticator must step up to aal2
  //     every sign-in (challenge) — if you have 2FA, you use it. This is
  //     unconditional and was already true under S96.
  //   * A person with NO factor is sent to enrolment ONLY when the rollout
  //     policy requires it FOR THEM (`must_enroll`, computed server-side by the
  //     atlas_auth_policy RPC from the auth_policy flags + their role + whether
  //     they have a factor). With the flags off, `must_enroll` is false, so
  //     existing factor-less staff simply enter — the RELEASE is non-breaking,
  //     and enrolment for existing staff turns on only when the owner flips the
  //     policy during rollout. New invitees enrol in the invite wizard, not here.
  // A transient MFA-API or policy read error fails open (logs, lets the person
  // in) so a fault never locks anyone out.
  function mfaEntryDecision(state) {
    if (state && state.hasVerifiedFactor) return state.aal === 'aal2' ? 'allow' : 'challenge';
    return state && state.mustEnroll ? 'enroll' : 'allow';
  }
  window.atlasMfaEntryDecision = mfaEntryDecision;

  // What mountLoginEnrollment does given whether the enrolment UI is present.
  // Pure and unit-tested so the "missing UI" path can never loop back through
  // the gate: 'mount' shows the enrol UI, 'enter' fails open into the app.
  function enrollmentPlan(hasUi) { return hasUi ? 'mount' : 'enter'; }
  window.atlasEnrollmentPlan = enrollmentPlan;

  // Whether THIS session must enrol now, per the rollout policy. Fails safe to
  // false so a read error never forces enrolment or a lock-out.
  async function fetchMustEnroll() {
    try {
      const { data, error } = await sb.rpc('atlas_auth_policy');
      if (error) return false;
      return data?.must_enroll === true;
    } catch (_) { return false; }
  }

  // Returns 'ok' to enter, or 'enroll'/'blocked' when it took over the screen.
  async function enforceEntryMfa(session) {
    try {
      const listed = await sb.auth.mfa.listFactors();
      const hasVerifiedFactor = (listed?.data?.totp || []).some((candidate) => candidate.status === 'verified');
      let aal = 'aal1';
      try { aal = (await sb.auth.mfa.getAuthenticatorAssuranceLevel())?.data?.currentLevel || 'aal1'; } catch (_) { /* default aal1 */ }
      const mustEnroll = hasVerifiedFactor ? false : await fetchMustEnroll();
      const decision = mfaEntryDecision({ hasVerifiedFactor, aal, mustEnroll });
      if (decision === 'allow') return 'ok';
      if (decision === 'challenge') {
        const outcome = await ensureAssurance(sb);
        if (outcome === 'verified' || outcome === 'not_required' || outcome === 'unavailable') return 'ok';
        // The person has a factor but did not confirm the code: require it.
        showLoginError('Confirm your authenticator code to enter Alcedo. Sign in again to try once more.');
        bootRetry = true;
        setLoginBusy(false, 'Try again');
        loginScreen.style.display = '';
        appScreen.style.display = 'none';
        return 'blocked';
      }
      return mountLoginEnrollment(session); // 'enroll', or 'ok' if it failed open
    } catch (error) {
      console.warn('MFA entry check failed; continuing without step-up', error?.message || error);
      return 'ok';
    }
  }

  // Returns 'enroll' when it took over the screen with the enrol UI, or 'ok'
  // when the UI was unavailable and it entered the app directly. It NEVER calls
  // back into onSignedIn/the gate, so a missing UI cannot cause a retry loop.
  function mountLoginEnrollment(session) {
    loginScreen.style.display = '';
    appScreen.style.display = 'none';
    document.documentElement.dataset.atlasSignin = 'shown';
    setLoginBusy(false, 'Sign in');
    showLoginError('');
    const host = document.getElementById('login-mfa');
    const mountPoint = document.getElementById('login-mfa-host');
    if (enrollmentPlan(Boolean(host && mountPoint && window.AtlasMfaEnroll)) === 'enter') {
      // No enrolment UI available: enter the app directly rather than trap the
      // person or loop them back through the gate.
      console.warn('Two-factor enrolment UI is unavailable; continuing.');
      enterApp(session).catch((error) => console.error(error));
      return 'ok';
    }
    loginForm.hidden = true;
    host.hidden = false;
    window.AtlasMfaEnroll.mount(mountPoint, {
      client: sb,
      onVerified: async () => {
        host.hidden = true;
        loginForm.hidden = false;
        const fresh = (await sb.auth.getSession()).data?.session || session;
        await enterApp(fresh);
      }
    });
    return 'enroll';
  }

  async function onSignedIn(session) {
    if (sb?.auth?.mfa) {
      const gate = await enforceEntryMfa(session);
      if (gate === 'enroll' || gate === 'blocked') return;
      session = (await sb.auth.getSession()).data?.session || session;
    }
    await enterApp(session);
  }

  async function enterApp(session) {
    currentUser = session.user;
    try { sessionStorage.removeItem(SESSION_ENDED_KEY); sessionStorage.removeItem(SESSION_ENDED_AT_KEY); } catch (_) { /* storage unavailable */ }
    const profile = await loadActiveProfile(session);
    // S87 identity rule: the profile display name (AtlasIdentity, atlas-api.js),
    // otherwise "Team member". An email address is never shown or turned into
    // a name; without a display name the greeting has no name.
    const identity = window.AtlasIdentity;
    const displayName = identity.label(profile);
    userEmailEl.textContent = '';
    document.getElementById('profile-name').textContent = displayName;
    window.atlasGreetingName = identity.firstName(profile);
    document.getElementById('user-avatar').textContent = identity.initials(identity.safeName(profile.display_name));
    window.AtlasChrome?.setAccount?.({ id: profile.id, name: displayName, email: '', role: profile.role });
    loginScreen.style.display = 'none';
    appScreen.style.display = 'block';
    const preferences = cachedPreferences(currentUser.id);
    window.AtlasPreferences.apply(preferences);
    // From here the shell keeps the address bar in step with the open view, so
    // #view links, Back and Forward work.
    window.AtlasShell.startRouting();
    // Spec §4.11: never a blank screen. The requested page opens at once with
    // its header and skeletons (views that read the shell data render their
    // loading state until data:loaded) and the correct navigation item, while
    // the 2 px loading line runs under the top bar.
    openInitialView(preferences);
    if (window.lucide) window.lucide.createIcons();
    setAppLoading(true);
    try { await loadAll(); } finally { setAppLoading(false); }
    document.body.dataset.atlasReady = 'true';
    if (window.lucide) window.lucide.createIcons();
  }

  function setAppLoading(loading) {
    const line = document.getElementById('atlas-loading-line');
    if (line) line.hidden = !loading;
    document.getElementById('atlas-main')?.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  // Personal preferences are cached per user by Settings after every load or
  // save, so they apply at sign-in without waiting for the Settings module.
  const PREFERENCE_CACHE_KEY = 'atlas.preferences.v1';
  function cachedPreferences(userId) {
    try {
      const value = JSON.parse(window.localStorage.getItem(PREFERENCE_CACHE_KEY) || 'null');
      return value && value.user_id === userId ? value : null;
    } catch (_) { return null; }
  }
  window.AtlasPreferences = {
    apply(preferences) {
      document.documentElement.classList.toggle('atlas-reduce-motion', Boolean(preferences?.reduce_motion));
    }
  };
  // A #view link (for example a notification tap opening #team) wins over the
  // saved start view; unknown or unavailable destinations fall back to Home.
  // Links may carry a section and parameters (#reports/inventory, #inventory?item=…);
  // AtlasShell.parseRoute is the one parser for them.
  function openInitialView(preferences) {
    const route = window.AtlasShell.parseRoute(location.hash);
    if (location.hash.length > 1 && !window.AtlasShell.isKnownRoute(location.hash)) {
      window.AtlasShell.show('not-found', { path: route.route }, { source: 'link', history: false });
      return;
    }
    for (const { view, params } of [route, { view: preferences?.start_view, params: {} }]) {
      if (!view || view === 'dashboard') continue;
      if (window.AtlasShell.nav.allowed(view) && (window.AtlasShell.nav.forView(view) || window.AtlasShell.view(view))) { window.AtlasShell.show(view, params, { source: 'link', route: location.hash }); return; }
    }
    window.AtlasShell.show('dashboard', {}, { source: 'link' });
  }

  (async function init() {
    try {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Connecting…';
      const client = await initializeSupabase();
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
      if (data.session) {
        await onSignedIn(data.session);
      } else {
        // No session: the sign-in form is what this visitor sees (logo intro).
        document.documentElement.dataset.atlasSignin = 'shown';
        window.AtlasSignInIntro?.start();
        renderCaptcha();
        // A cooldown from a prior device session survives the reload.
        if (loginCooldownRemaining() > 0) startLoginCooldown();
        let ended = false;
        try { ended = sessionStorage.getItem(SESSION_ENDED_KEY) === '1'; sessionStorage.removeItem(SESSION_ENDED_KEY); } catch (_) { /* storage unavailable */ }
        if (ended) {
          // A notice, not a form error: the fields stay valid.
          loginError.textContent = 'Your session ended. Sign in again to continue where you were.';
          loginError.hidden = false;
        }
      }
    } catch (error) {
      loginBtn.disabled = false;
      if (error?.code === 'inactive_profile') {
        // The saved session belonged to a deactivated (or unknown-role)
        // profile and has been signed out: show the sign-in form with the
        // access message, not a connection error with a retry that can't work.
        loginBtn.textContent = 'Sign in';
        loginScreen.style.display = '';
        appScreen.style.display = 'none';
        document.documentElement.dataset.atlasSignin = 'shown';
        window.AtlasSignInIntro?.start();
        renderCaptcha();
        showLoginError(INACTIVE_PROFILE_MESSAGE);
        ['email', 'password'].forEach((id) => document.getElementById(id)?.setAttribute('aria-invalid', 'false'));
        return;
      }
      bootRetry = true;
      loginBtn.textContent = 'Retry connection';
      showBootError(error.message);
    }
  })();

  // ---------- DATA ----------
  async function loadItems() {
    const relation = canManageCommercial() ? 'inventory_items' : 'inventory_catalog';
    const { data, error } = await sb
      .from(relation)
      .select('*')
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      console.error(`${relation} could not be loaded`, error);
      itemsStatus = 'error';
      dataHealth.inventory = 'failed';
      dataHealth.stock = 'failed';
      showDataBoundaryError('Inventory');
      return;
    }
    dataHealth.inventory = 'ok';
    let balances = [];
    try {
      const session = (await sb.auth.getSession()).data?.session;
      const endpoint = window.VABAR_CONFIG?.STOCK_COUNTS_API;
      if (!session?.access_token || !endpoint) throw new Error('Verified stock unavailable');
      const url = new URL(endpoint); url.searchParams.set('action', 'snapshot');
      const response = await fetch(url, {headers: {authorization: `Bearer ${session.access_token}`}, signal: AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error('Verified stock unavailable');
      countSnapshot = (await response.json()).counts || null;
      balances = countSnapshot?.verified_balances || [];
      dataHealth.balances = 'ok';
    } catch (error) {
      console.warn('Stock remains unknown until verified balances can be read.');
      dataHealth.balances = 'failed';
    }
    // Every workspace, including this table, reads the single reconciled quantity.
    // A projection from partial inputs is not stock truth: without verified
    // balances every item would read "Not counted", and without movements every
    // quantity would be its last count without sales or waste since. Stock is
    // then withheld (unknown, reason stock_data_incomplete) and the pages say so.
    const missing = [dataHealth.balances === 'ok' ? null : 'balances', dataHealth.movements === 'ok' ? null : 'movements'].filter(Boolean);
    dataHealth.stockMissing = missing;
    if (missing.length) {
      dataHealth.stock = 'partial';
      itemsStatus = 'partial';
      items = window.AtlasStockTruth.withhold(data || []);
      window.AtlasShell.emit('data:error', { source: 'Stock figures', kind: 'stock_incomplete', missing: [...missing] });
      return;
    }
    items = window.AtlasStockTruth.project(data || [], balances, inventoryMovements);
    dataHealth.stock = 'ok';
    itemsStatus = 'ok';
  }

  // The newest AtlasStockTruth.MOVEMENT_ROW_LIMIT movements (5 000, the same
  // cap as Reports and Alcedo AI), read in pages so the PostgREST max-rows
  // default (1 000) cannot silently cut the stock projection short.
  async function loadRestockLog() {
    const relation = canManageCommercial() ? 'inventory_movements' : 'inventory_movement_catalog';
    const limit = window.AtlasStockTruth?.MOVEMENT_ROW_LIMIT || 5000;
    const pageSize = window.AtlasStockTruth?.MOVEMENT_PAGE_SIZE || 1000;
    const rows = [];
    for (let from = 0; from < limit; from += pageSize) {
      let query = sb.from(relation);
      query = canManageCommercial()
        ? query.select('*, suppliers(name)')
        : query.select('*');
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, Math.min(from + pageSize, limit) - 1);
      if (error) {
        console.error(`${relation} could not be loaded`, error);
        inventoryMovements = [];
        restockLog = [];
        dataHealth.movements = 'failed';
        return;
      }
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    dataHealth.movements = 'ok';
    inventoryMovements = rows;
    restockLog = inventoryMovements.filter(entry => entry.movement_type === 'restock');
  }

  async function loadRecipes() {
    if (canManageCommercial()) {
      const { data, error } = await sb
        .from('recipes')
        .select('*, recipe_ingredients(*)')
        .order('name', { ascending: true });
      if (error) {
        console.error(error);
        recipes = [];
        dataHealth.recipes = 'failed';
        showDataBoundaryError('Recipes');
        return;
      }
      recipes = data || [];
      dataHealth.recipes = 'ok';
      return;
    }

    let result = await sb
      .from('recipe_catalog')
      .select('*')
      .order('name', { ascending: true });

    // Compatibility fallback for the draft preview before production migration.
    // It requests only operational columns and is removed as a usable path once
    // the canonical recipe tables become manager-only in production RLS.
    if (result.error) {
      result = await sb
        .from('recipes')
        .select('id,category_id,name,type,method,yield_quantity,yield_unit,menu_price,active,show_on_menu,glassware,garnish,notes,image_url,updated_at,recipe_ingredients(id,recipe_id,item_id,item_name,quantity,unit)')
        .order('name', { ascending: true });
    }
    if (result.error) {
      console.error('The staff recipe catalogue could not be loaded', result.error);
      recipes = [];
      dataHealth.recipes = 'failed';
      showDataBoundaryError('Recipes');
      return;
    }
    recipes = result.data || [];
    dataHealth.recipes = 'ok';
  }

  async function loadSuppliersData() {
    if (!canManageCommercial()) {
      suppliers = [];
      dataHealth.suppliers = 'ok';
      return;
    }
    const { data, error } = await sb
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });
    if (error) {
      console.warn('Supplier list could not be loaded:', error.message);
      suppliers = [];
      dataHealth.suppliers = 'failed';
      return;
    }
    suppliers = data || [];
    dataHealth.suppliers = 'ok';
  }

  // Storage Locations (S97): the managed location catalogue and the item→location
  // assignments. Location is a place, never a quantity: neither read here touches
  // stock. Every active staff member may read both (inventory_location_catalog is
  // gated to is_active_staff and grants SELECT to authenticated; the assignment
  // rows carry the same SELECT policy), so this loads for staff and managers alike.
  async function loadLocations() {
    const catalog = await sb
      .from('inventory_location_catalog')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('code', { ascending: true });
    if (catalog.error) {
      console.warn('Storage locations could not be loaded:', catalog.error.message);
      locations = [];
      itemLocations = [];
      dataHealth.locations = 'failed';
      return;
    }
    locations = catalog.data || [];
    const assignments = await sb
      .from('inventory_item_locations')
      .select('inventory_item_id,location_id,is_primary,sort_order');
    if (assignments.error) {
      console.warn('Storage location assignments could not be loaded:', assignments.error.message);
      itemLocations = [];
      dataHealth.locations = 'failed';
      return;
    }
    itemLocations = assignments.data || [];
    dataHealth.locations = 'ok';
  }

  // loadAll() loads the shell data, then emits data:loaded. Modules refresh
  // through AtlasShell.onDataLoaded() instead of wrapping this function.
  async function loadAll() {
    await loadAtlasData();
    window.AtlasShell.dataLoaded({ online: navigator.onLine, health: window.AtlasData.health() });
  }
  async function loadAtlasData() {
    // Keep the last loaded, role-filtered in-memory snapshot during an outage.
    // No offline login, persistent commercial cache, or automatic write replay.
    if (!navigator.onLine) return;
    // Movement history must load before inventory projection so current verified
    // balances can be adjusted by audited restocks, waste, sales and transfers.
    await loadRestockLog();
    await Promise.all([loadItems(), loadRecipes(), loadSuppliersData(), loadLocations()]);
    renderRecipes();
  }
  window.atlasPurchasingData = () => canManageCommercial()
    ? { items: structuredClone(items), suppliers: structuredClone(suppliers) }
    : { items: [], suppliers: [] };
  // Purchasing reloads the shell data only; Inventory and Purchasing reload
  // everything (and re-render through data:loaded) after a change they made.
  window.atlasReloadPurchasingData = loadAtlasData;
  window.atlasReloadData = loadAll;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  // ---------- PROJECT ATLAS NAVIGATION ----------
  // AtlasShell (assets/js/atlas-shell.js) owns navigation. The base shell
  // registers its own views here; modules register theirs through
  // AtlasShell.registerView() and never write into these tables.
  // Inventory (inventory, movements, waste) and Purchasing (suppliers) are
  // registered by assets/js/atlas-inventory.js and assets/js/atlas-purchasing.js.
  const viewMap = {
    dashboard: document.getElementById('dashboard-view'),
    recipes: document.getElementById('recipes-view'),

    team: document.getElementById('team-view'), shifts: document.getElementById('shifts-view'),
    knowledge: document.getElementById('knowledge-view'), reports: document.getElementById('reports-view'),
    settings: document.getElementById('settings-view'),
    'not-found': document.getElementById('not-found-view')
  };
  const titleMap = {'not-found':'Page not found',dashboard:'Home',recipes:'Recipes',imports:'Data',team:'Messages',shifts:'Shifts',knowledge:'Knowledge',reports:'Reports',settings:'Settings'};
  const workspaceRootIds = {
    dashboard: 'dashboard-view', inventory: 'inventory-view', recipes: 'recipes-view', suppliers: 'suppliers-view',
    data: 'data-view', team: 'team-view', shifts: 'shifts-view', knowledge: 'knowledge-view',
    movements: 'inventory-view', waste: 'inventory-view', reports: 'reports-view', settings: 'settings-view',
    operations: 'operations-view', marketing: 'marketing-view',
    'team-profiles': 'team-profiles-view'
  };
  function hideAtlasWorkspaceRoots(keepView = '') {
    const keepId = workspaceRootIds[keepView] || window.AtlasShell.view(keepView)?.root?.id || '';
    const main = document.querySelector('.atlas-content.standard-view main');
    if (!main) return;
    [...main.children].forEach((element) => {
      if (!element.id || !element.id.endsWith('-view')) return;
      if (element.id !== keepId) element.style.display = 'none';
    });
  }
  function resetAtlasWorkspaceScroll() {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.scrollingElement?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
      document.querySelector('.atlas-content')?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
    });
  }
  // The base shell chrome for every destination. AtlasShell.show() runs it once
  // per navigation, before the view's render and onShow hooks.
  function layoutAtlasView(view, entry, context) {
    activeView = view;
    document.body.dataset.atlasView = view;
    hideAtlasWorkspaceRoots(view);
    Object.values(viewMap).forEach(v => { if(v) v.style.display='none'; });
    const root = viewMap[view] || window.AtlasShell.view(view)?.root;
    if (root) root.style.display = entry.display;
    // The page title in the phone top bar, the active navigation item and the
    // overlay sidebar follow view:show in assets/js/atlas-chrome.js.
    resetAtlasWorkspaceScroll();
  }
  function commercialWorkspaceGuard() {
    if (canManageCommercial()) return true;
    window.AtlasShell.toast('That page is for managers. Ask an administrator if you need access.', { tone: 'info' });
    return 'dashboard';
  }
  window.AtlasShell.setLayout(layoutAtlasView);
  [
    ['dashboard', { render: () => renderAtlasHome() }],
    ['recipes', { render: () => renderRecipes(), onShow: (params) => window.AtlasRecipes?.show?.(params) }],
    // Import Center and Real VÁ Data are one manager page now: Data (assets/js/data-workspace.js).
    ['imports', { guard: () => 'data' }],
    ['team', {}], ['shifts', {}], ['knowledge', {}], ['reports', {}], ['settings', {}],
    // An address Alcedo doesn't know (#bogus) opens this page instead of
    // leaving the previous page on screen (AtlasShell.isKnownRoute).
    ['not-found', { render: () => renderNotFound() }]
  ].forEach(([view, definition]) => window.AtlasShell.registerView(view, { root: viewMap[view], title: titleMap[view], ...definition }));
  // Compatibility shim: modules and tests still call the global by name. It is
  // a thin call into the shell and is never reassigned (tests/node/shell-contract-s88).
  function setActiveView(view) {
    return window.AtlasShell.show(view);
  }
  Object.assign(window.AtlasShell, { hideWorkspaceRoots: hideAtlasWorkspaceRoots, resetScroll: resetAtlasWorkspaceScroll });
  function renderNotFound() {
    const root = viewMap['not-found'];
    if (!root) return;
    root.innerHTML = `${window.AtlasShell.pageHead({ title: 'Page not found' })}<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon"><i data-lucide="compass" aria-hidden="true"></i></div><h2 class="atlas-empty__title">This page doesn’t exist</h2><p class="atlas-empty__text">The link may be old or mistyped. Nothing was changed.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a></div></div>`;
    window.lucide?.createIcons?.();
  }

  // Home (assets/js/home.js) is the one Home section; modules contribute
  // attention rows with AtlasShell.home.contribute() instead of drawing into it.
  function renderAtlasHome(){
    return window.AtlasShell.renderHome();
  }

  // Canonical actions owned by the base shell (spec §4.8). The command palette
  // and the + button list them per role; everything the retired quick-action
  // button and service grid offered is here. The editors keep their own manager
  // check, so a denied action runs the same function, which explains the limit.
  // recipes.new is an interim registration until the Recipes (E4) module
  // registers its own (same id). Inventory, stock count and Purchasing actions
  // are registered by their modules (atlas-inventory.js, stock-count-workspace.js,
  // atlas-purchasing.js).
  const MANAGERS=['admin','manager'];
  [
    { id:'recipes.new', label:'New recipe', icon:'martini', keywords:['recipe','cocktail','drink'], roles:MANAGERS, contexts:['recipes'], run:()=>{ setActiveView('recipes'); window.AtlasRecipes?.openEditor?.(null); } }
  ].forEach(action=>window.AtlasShell.actions.register({ ...action, denied:action.run }));

  // ---------- RECIPES · ATLAS ALPHA 0.2 ----------
  function renderRecipes() {
    if (window.AtlasRecipes) window.AtlasRecipes.render();
  }

  if (window.lucide) window.lucide.createIcons();
