(function () {
  'use strict';
  // Reset your password → "Check your email" (never reveals whether an account
  // exists) → set a new password from the emailed link (spec §7.17).
  const status = document.getElementById('status');
  const request = document.getElementById('request-recovery');
  const complete = document.getElementById('complete-recovery');
  const title = document.getElementById('recovery-title');
  // Venue line: the name Settings last gave this device, never an invented one.
  try {
    const venue = JSON.parse(window.localStorage?.getItem('atlas.venue.v1') || 'null');
    if (venue?.line) document.querySelectorAll?.('[data-atlas-venue-line]').forEach((node) => { node.textContent = venue.line; node.hidden = false; });
  } catch (_) { /* no remembered venue */ }
  let recoverySession = false;
  let client;
  const busy = (form, value) => {
    const button = form.querySelector('button');
    button.disabled = value;
    button.classList?.toggle('is-loading', value);
    button.setAttribute?.('aria-busy', String(value));
  };
  // Inline field errors (design system §6.6); the forms are novalidate so the
  // browser's validation bubble never shows.
  const fieldError = (id, message) => {
    const error = document.getElementById(`${id}-error`);
    if (error) { error.textContent = message; error.hidden = !message; }
    document.getElementById(id)?.setAttribute?.('aria-invalid', String(Boolean(message)));
    if (message) document.getElementById(id)?.focus?.();
  };
  const setTitle = (text) => { if (title) title.textContent = text; };

  // ---------- CAPTCHA (OWNER-GATED, inert by default) ----------
  // Mirrors the sign-in flow: a provider token is threaded into
  // resetPasswordForEmail only when the owner sets AUTH_CAPTCHA_PROVIDER in
  // config.js AND enables the same provider in the Supabase dashboard. With no
  // provider (the default) this is a strict no-op: no script loads, no widget
  // renders, and resetPasswordForEmail is called with exactly { redirectTo } as
  // before. If a provider is enabled, its script/frame origins MUST be added to
  // the netlify CSP (OWNER-GATED; the CSP is not broadened here).
  const CAPTCHA_PROVIDERS = {
    hcaptcha: { script: 'https://js.hcaptcha.com/1/api.js?render=explicit', api: () => window.hcaptcha },
    turnstile: { script: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', api: () => window.turnstile }
  };
  const captchaCfg = window.VABAR_CONFIG || {};
  const captchaProvider = CAPTCHA_PROVIDERS[String(captchaCfg.AUTH_CAPTCHA_PROVIDER || '').toLowerCase()] || null;
  const captchaSiteKey = String(captchaCfg.AUTH_CAPTCHA_SITE_KEY || '');
  const captchaContainer = document.getElementById('recovery-captcha');
  let captchaWidgetId = null;
  let captchaToken = '';
  const captchaEnabled = () => Boolean(captchaProvider && captchaSiteKey);
  const loadCaptchaScript = () => new Promise((resolve, reject) => {
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
  const renderCaptcha = async () => {
    if (!captchaEnabled() || !captchaContainer || captchaWidgetId !== null) return;
    try {
      await loadCaptchaScript();
      const api = captchaProvider.api();
      if (!api?.render) return;
      captchaWidgetId = api.render(captchaContainer, {
        sitekey: captchaSiteKey,
        callback: (token) => { captchaToken = token || ''; },
        'expired-callback': () => { captchaToken = ''; },
        'error-callback': () => { captchaToken = ''; }
      });
      captchaContainer.hidden = false;
    } catch (_) { /* provider unreachable: the server still enforces its own check */ }
  };
  const resetCaptcha = () => {
    captchaToken = '';
    try { if (captchaWidgetId !== null) captchaProvider?.api()?.reset?.(captchaWidgetId); } catch (_) { /* ignore */ }
  };
  const rules = () => {
    const password = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    const met = { length: password.length >= 10, match: Boolean(password) && password === confirm };
    document.querySelectorAll?.('#recovery-rules [data-rule]').forEach((rule) => rule.classList.toggle('is-met', met[rule.dataset.rule]));
  };
  try {
    const cfg = window.VABAR_CONFIG;
    window.AtlasRehearsalBoundary.validate(cfg);
    // S96: the recovery session lives in this page's memory only. It is never
    // written to the app's stored session, so an abandoned (or planted) reset
    // link does not leave this device signed in to Alcedo.
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'atlas-recovery-setup' }
    });
    client.auth.onAuthStateChange((event, session) => {
      // Keep the callback synchronous: awaiting another Auth call here can deadlock.
      if (event === 'PASSWORD_RECOVERY' && session) {
        recoverySession = true;
        request.hidden = true; complete.hidden = false;
        setTitle('Choose a new password');
        status.textContent = 'Choose a new password with at least 10 characters.';
        history.replaceState(null, '', location.pathname);
      } else if (event === 'SIGNED_OUT') {
        recoverySession = false; complete.hidden = true;
      }
    });
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has('error')) {
      status.textContent = 'This reset link is invalid or has expired. Request a new link below.';
      history.replaceState(null, '', location.pathname);
    } else if (fragment.get('token_hash') && fragment.get('type') === 'recovery') {
      // S96: the email links straight to this page with a single-use token hash
      // (template: recovery.html#token_hash={{ .TokenHash }}&type=recovery), so no
      // session token ever travels in a redirect URL. The hash leaves the address
      // bar before it is exchanged here, on our own origin.
      const tokenHash = fragment.get('token_hash');
      history.replaceState(null, '', location.pathname);
      client.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' }).then(({ data, error }) => {
        if (error || !data?.session) throw error || new Error('no session');
        recoverySession = true;
        request.hidden = true; complete.hidden = false;
        setTitle('Choose a new password');
        status.textContent = 'Choose a new password with at least 10 characters.';
      }).catch(() => {
        status.textContent = 'This reset link is invalid or has expired. Request a new link below.';
      });
    }
    // Render the captcha on the reset-request form (no-op unless configured).
    renderCaptcha();
  } catch (_) {
    // Nothing is in progress: the send button is unavailable (no spinner) and
    // the page offers a reload.
    status.textContent = "Password reset couldn't connect. Check your connection and reload the page.";
    const button = request.querySelector('button');
    button.disabled = true;
    button.classList?.remove('is-loading');
    const reload = document.getElementById('recovery-reload');
    if (reload) { reload.hidden = false; reload.addEventListener?.('click', () => location.reload()); }
    return;
  }
  ['new-password', 'confirm-password'].forEach((id) => document.getElementById(id)?.addEventListener?.('input', rules));
  request.addEventListener('submit', async event => {
    event.preventDefault();
    const email = document.getElementById('recovery-email').value.trim();
    const problem = !email ? 'Enter your email.' : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter an email address like name@example.com.');
    fieldError('recovery-email', problem);
    if (problem) return;
    busy(request, true);
    try {
      const redirectTo = new URL('recovery.html', location.href).href;
      // captchaToken key is present only when a provider is configured (no-op otherwise).
      const options = captchaEnabled() ? { redirectTo, captchaToken } : { redirectTo };
      const { error } = await client.auth.resetPasswordForEmail(email, options);
      if (error) throw error;
      request.hidden = true;
      setTitle('Check your email');
      status.textContent = 'If this email can receive a reset, a link will arrive shortly. Check your inbox and spam folder, then open the link on this device.';
    } catch (_) { resetCaptcha(); status.textContent = "A reset link couldn't be requested. Check your connection and try again in a moment."; }
    finally { busy(request, false); }
  });
  complete.addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('new-password').value;
    if (!recoverySession) { status.textContent = 'Request a new reset link first.'; return; }
    if (password.length < 10 || password !== document.getElementById('confirm-password').value) {
      fieldError('confirm-password', password.length < 10 ? 'Use at least 10 characters.' : 'The passwords don’t match.');
      return;
    }
    fieldError('confirm-password', '');
    busy(complete, true);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      complete.reset(); complete.hidden = true; recoverySession = false;
      // Deliberately every device: after a password reset, sessions opened
      // with the old password (possibly by someone else) must end too.
      const { error: signOutError } = await client.auth.signOut({ scope: 'global' });
      setTitle('Password updated');
      status.textContent = signOutError
        ? 'Your password is updated. Sign out before using another account on this device.'
        : 'Your password is updated and you are signed out on every device. Sign in with the new password.';
    } catch (_) { status.textContent = "The password couldn't be updated. Check the requirements, or request a new link."; }
    finally { busy(complete, false); }
  });
})();
