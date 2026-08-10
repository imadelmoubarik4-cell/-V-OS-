(() => {
  'use strict';

  const CONFIG = Object.freeze({
    supabaseUrl: 'https://dnefgcmjcgxlynycxkts.supabase.co',
    supabaseKey: 'sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp',
    requestTimeoutMs: 12000,
    sessionTimeoutMs: 15000,
    signOutTimeoutMs: 4000,
  });
  const ALLOWED_ROLES = new Set(['admin', 'manager', 'bartender', 'viewer']);
  const dom = {};
  let client = null;

  function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => window.clearTimeout(timer));
  }

  function cacheDom() {
    for (const id of ['login-boot', 'login-screen', 'login-form', 'login-email', 'login-password', 'login-submit', 'login-error']) {
      dom[id] = document.getElementById(id);
    }
  }

  function setBoot(visible, copy = '') {
    if (!dom['login-boot']) return;
    dom['login-boot'].hidden = !visible;
    const label = dom['login-boot'].querySelector('[data-login-boot-copy]');
    if (label && copy) label.textContent = copy;
  }

  function setError(message = '') {
    dom['login-error'].textContent = message;
    dom['login-error'].hidden = !message;
  }

  function setBusy(busy) {
    dom['login-submit'].disabled = busy;
    dom['login-submit'].textContent = busy ? 'Signing in…' : 'Sign in';
    dom['login-email'].disabled = busy;
    dom['login-password'].disabled = busy;
  }

  function showForm(message = '') {
    setBoot(false);
    dom['login-screen'].hidden = false;
    setBusy(false);
    setError(message);
    window.requestAnimationFrame(() => dom['login-email']?.focus({ preventScroll: true }));
  }

  function appUrl() {
    const url = new URL('next.html', window.location.href);
    const requestedView = new URLSearchParams(window.location.search).get('view');
    if (requestedView && /^[a-z-]+$/i.test(requestedView)) url.hash = requestedView;
    url.searchParams.set('signed-in', Date.now().toString(36));
    return url.href;
  }

  function enterApp() {
    window.location.replace(appUrl());
  }

  async function resolveProfile(user) {
    const response = await withTimeout(
      client.from('profiles').select('id,email,display_name,role,active').eq('id', user.id).maybeSingle(),
      CONFIG.requestTimeoutMs,
      'Profile verification took too long.',
    );
    if (response.error) throw response.error;
    const profile = response.data;
    if (!profile?.active) throw new Error('This account does not have active Atlas access. Ask an administrator to activate the profile.');
    if (!ALLOWED_ROLES.has(profile.role)) throw new Error('This Atlas profile has an unsupported role.');
    return profile;
  }

  async function clearLocalSession() {
    if (!client?.auth?.signOut) return;
    try {
      await withTimeout(
        client.auth.signOut({ scope: 'local' }),
        CONFIG.signOutTimeoutMs,
        'Local session cleanup took too long.',
      );
    } catch (error) {
      console.warn('Atlas isolated login cleanup warning', error);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const email = dom['login-email'].value.trim();
    const password = dom['login-password'].value;
    if (!email || !password) {
      setError('Enter your email and password.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const response = await withTimeout(
        client.auth.signInWithPassword({ email, password }),
        CONFIG.requestTimeoutMs,
        'Sign-in took too long. Check the connection and try again.',
      );
      if (response.error) throw response.error;
      const session = response.data?.session;
      if (!session?.user) throw new Error('Atlas did not receive a valid session.');
      setBoot(true, 'Verifying Atlas access…');
      dom['login-screen'].hidden = true;
      await resolveProfile(session.user);
      enterApp();
    } catch (error) {
      await clearLocalSession();
      showForm(error instanceof Error ? error.message : 'Sign-in failed.');
    }
  }

  async function boot() {
    cacheDom();
    dom['login-form'].addEventListener('submit', handleSubmit);
    setBoot(true, 'Opening secure sign-in…');

    const params = new URLSearchParams(window.location.search);
    const suppliedMessage = params.get('message');
    const forceSignOut = params.get('force_signout') === '1';

    try {
      if (!window.supabase?.createClient) throw new Error('The Supabase client did not load. Check the network connection and refresh.');
      client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        global: { headers: { 'x-client-info': 'atlas-login-recovery/1.0.0' } },
      });

      if (forceSignOut) {
        await clearLocalSession();
        showForm(suppliedMessage || 'You have signed out of Atlas.');
        return;
      }

      const response = await withTimeout(
        client.auth.getSession(),
        CONFIG.sessionTimeoutMs,
        'Atlas session recovery timed out.',
      );
      if (response.error) throw response.error;
      const session = response.data?.session;
      if (!session?.user) {
        showForm(suppliedMessage || '');
        return;
      }

      setBoot(true, 'Verifying Atlas access…');
      try {
        await resolveProfile(session.user);
        enterApp();
      } catch (error) {
        await clearLocalSession();
        showForm(error instanceof Error ? error.message : 'Atlas access could not be verified.');
      }
    } catch (error) {
      showForm(error instanceof Error ? error.message : 'Atlas sign-in could not start.');
    }
  }

  window.addEventListener('error', (event) => {
    if (!dom['login-screen']) return;
    showForm(event.message || 'Atlas sign-in encountered an error.');
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (!dom['login-screen']) return;
    const reason = event.reason;
    showForm(reason instanceof Error ? reason.message : 'Atlas sign-in encountered an error.');
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
