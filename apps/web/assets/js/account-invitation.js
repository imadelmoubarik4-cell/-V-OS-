(async function () {
  'use strict';
  const status = document.getElementById('status');
  const form = document.getElementById('accept-invitation');
  const token = new URLSearchParams(location.hash.slice(1)).get('token_hash');
  history.replaceState(null, '', location.pathname);
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
    status.textContent = `Welcome, ${data.user.email}. Choose a password with at least 10 characters.`;
    form.hidden = false;
  } catch (_) {
    status.textContent = 'This invitation is missing, expired or already used. Ask your manager for help. If you already set a password, return to sign in.';
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('new-password').value;
    if (password.length < 10 || password !== document.getElementById('confirm-password').value) {
      status.textContent = 'Passwords must match and have at least 10 characters.'; return;
    }
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      await client.auth.signOut({ scope: 'local' });
      form.reset(); form.hidden = true;
      status.textContent = 'Your password is set. You can now sign in to Atlas with your email and password.';
    } catch (_) {
      status.textContent = 'Could not set your password. Check the requirements and try again before closing this page.';
    } finally { submit.disabled = false; }
  });
})();
