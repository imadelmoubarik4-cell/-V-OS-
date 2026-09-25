(async function () {
  'use strict';
  const status = document.getElementById('status');
  const form = document.getElementById('accept-invitation');
  const checking = document.getElementById('invite-checking');
  // Venue line: the name Settings last gave this device, never an invented one.
  try {
    const venue = JSON.parse(window.localStorage?.getItem('atlas.venue.v1') || 'null');
    if (venue?.line) document.querySelectorAll?.('[data-atlas-venue-line]').forEach((node) => { node.textContent = venue.line; node.hidden = false; });
  } catch (_) { /* no remembered venue */ }
  const token = new URLSearchParams(location.hash.slice(1)).get('token_hash');
  history.replaceState(null, '', location.pathname);
  const say = (text, tone = '') => {
    status.textContent = text;
    status.classList.toggle('is-error', tone === 'error');
  };
  // Live password rules (spec §7.17): at least 10 characters, both match.
  const rules = () => {
    const password = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    const met = { length: password.length >= 10, match: Boolean(password) && password === confirm };
    document.querySelectorAll('#invite-rules [data-rule]').forEach((rule) => rule.classList.toggle('is-met', met[rule.dataset.rule]));
    return met.length && met.match;
  };
  let client;
  try {
    const cfg = window.VABAR_CONFIG;
    window.AtlasRehearsalBoundary.validate(cfg);
    if (!token) throw new Error('missing');
    // A separate, in-memory session keeps the owner's current login intact.
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'atlas-invitation-setup' }
    });
    const { data, error } = await client.auth.verifyOtp({ token_hash: token, type: 'invite' });
    if (error || !data.session) throw error || new Error('session');
    if (checking) checking.hidden = true;
    const email = document.getElementById('invite-email');
    if (email) { email.textContent = data.user.email; document.getElementById('invite-account').hidden = false; }
    say('Choose a password with at least 10 characters.');
    form.hidden = false;
    document.getElementById('new-password').focus();
  } catch (_) {
    if (checking) checking.hidden = true;
    const sub = document.getElementById('invite-sub');
    if (sub) sub.textContent = 'This invitation link cannot be used.';
    say('This invitation has expired or was already used. Ask your manager for a new one. If you already set a password, sign in instead.', 'error');
    return;
  }
  ['new-password', 'confirm-password'].forEach((id) => document.getElementById(id).addEventListener('input', rules));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('new-password').value;
    const error = document.getElementById('confirm-password-error');
    const confirmInput = document.getElementById('confirm-password');
    if (!rules() || password.length < 10 || password !== confirmInput.value) {
      // Inline field error (design system §6.6); the form is novalidate.
      if (error) { error.textContent = password.length < 10 ? 'Use at least 10 characters.' : 'The passwords don’t match.'; error.hidden = false; }
      confirmInput.setAttribute('aria-invalid', 'true');
      confirmInput.focus();
      return;
    }
    if (error) error.hidden = true;
    confirmInput.setAttribute('aria-invalid', 'false');
    const submit = form.querySelector('button');
    submit.disabled = true;
    submit.classList.add('is-loading');
    submit.setAttribute('aria-busy', 'true');
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      await client.auth.signOut({ scope: 'local' });
      form.reset(); form.hidden = true;
      say('Your password is set. You can now sign in to Atlas with your email and password.');
    } catch (_) {
      say('Your password could not be set. Check the requirements and try again before closing this page.', 'error');
    } finally {
      submit.disabled = false;
      submit.classList.remove('is-loading');
      submit.removeAttribute('aria-busy');
    }
  });
})();
