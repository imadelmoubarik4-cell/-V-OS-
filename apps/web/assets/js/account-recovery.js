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
  const rules = () => {
    const password = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    const met = { length: password.length >= 10, match: Boolean(password) && password === confirm };
    document.querySelectorAll?.('#recovery-rules [data-rule]').forEach((rule) => rule.classList.toggle('is-met', met[rule.dataset.rule]));
  };
  try {
    const cfg = window.VABAR_CONFIG;
    window.AtlasRehearsalBoundary.validate(cfg);
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
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
    if (new URLSearchParams(location.hash.slice(1)).has('error')) {
      status.textContent = 'This reset link is invalid or has expired. Request a new link below.';
      history.replaceState(null, '', location.pathname);
    }
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
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      request.hidden = true;
      setTitle('Check your email');
      status.textContent = 'If this email can receive a reset, a link will arrive shortly. Check your inbox and spam folder, then open the link on this device.';
    } catch (_) { status.textContent = "A reset link couldn't be requested. Check your connection and try again in a moment."; }
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
      const { error: signOutError } = await client.auth.signOut();
      setTitle('Password updated');
      status.textContent = signOutError
        ? 'Your password is updated. Sign out before using another account on this device.'
        : 'Your password is updated. You can sign in with it now.';
    } catch (_) { status.textContent = "The password couldn't be updated. Check the requirements, or request a new link."; }
    finally { busy(complete, false); }
  });
})();
