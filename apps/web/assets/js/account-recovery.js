(function () {
  'use strict';
  const status = document.getElementById('status');
  const request = document.getElementById('request-recovery');
  const complete = document.getElementById('complete-recovery');
  let recoverySession = false;
  let client;
  const busy = (form, value) => { form.querySelector('button').disabled = value; };
  try {
    const cfg = window.VABAR_CONFIG;
    window.AtlasRehearsalBoundary.validate(cfg);
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    client.auth.onAuthStateChange((event, session) => {
      // Keep the callback synchronous: awaiting another Auth call here can deadlock.
      if (event === 'PASSWORD_RECOVERY' && session) {
        recoverySession = true;
        request.hidden = true; complete.hidden = false;
        status.textContent = 'Choose a new password with at least 10 characters.';
        history.replaceState(null, '', location.pathname);
      } else if (event === 'SIGNED_OUT') {
        recoverySession = false; complete.hidden = true;
      }
    });
    if (new URLSearchParams(location.hash.slice(1)).has('error')) {
      status.textContent = 'This reset link is invalid or expired. Request a new link.';
      history.replaceState(null, '', location.pathname);
    }
  } catch (_) {
    status.textContent = 'Account recovery could not connect. Check your connection and reload.';
    busy(request, true); return;
  }
  request.addEventListener('submit', async event => {
    event.preventDefault(); busy(request, true);
    try {
      const redirectTo = new URL('recovery.html', location.href).href;
      const { error } = await client.auth.resetPasswordForEmail(document.getElementById('recovery-email').value.trim(), { redirectTo });
      if (error) throw error;
      status.textContent = 'If this email can receive a reset, a link will arrive shortly. Check your inbox and spam folder.';
    } catch (_) { status.textContent = 'Could not request a reset link. Check your connection and try again later.'; }
    finally { busy(request, false); }
  });
  complete.addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('new-password').value;
    if (!recoverySession) { status.textContent = 'Request a new recovery link first.'; return; }
    if (password.length < 10 || password !== document.getElementById('confirm-password').value) {
      status.textContent = 'Passwords must match and have at least 10 characters.'; return;
    }
    busy(complete, true);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      complete.reset(); complete.hidden = true; recoverySession = false;
      const { error: signOutError } = await client.auth.signOut();
      status.textContent = signOutError
        ? 'Password updated. Sign out before using another account on this device.'
        : 'Password updated. You can return to sign in.';
    } catch (_) { status.textContent = 'The password could not be updated. Check the password requirements or request a new link.'; }
    finally { busy(complete, false); }
  });
})();
