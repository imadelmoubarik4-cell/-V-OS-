// Atlas account setup wizard (S99). The single set-password form is now a
// four-step wizard on ONE in-memory invite session (persistSession:false so the
// owner's own login is never touched):
//   1. password  2. name + phone  3. profile photo (required)  4. authenticator
// Only after the TOTP factor is verified does the wizard call the
// `complete-onboarding` edge action, which activates the account server-side.
//
// The invite-flow onboarding requirements enforced here (and re-verified by the
// edge function) are SEPARATE from the database-wide MFA enforcement flag
// (private.auth_policy.require_all_staff_mfa), which stays off until rollout.
// This wizard is the invite path only; it does not affect existing staff.
//
// CSP-safe: the only external script is the pinned Supabase UMD; no inline
// handlers. Standalone page — no AtlasShell/AtlasApi; calls the Atlas edge
// functions directly with the invitee's own session token.
(async function () {
  'use strict';
  const cfg = window.VABAR_CONFIG || {};
  const status = document.getElementById('status');
  const checking = document.getElementById('invite-checking');
  const progress = document.getElementById('wizard-progress');
  const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
  const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
    status.hidden = !text;
  };
  const el = (id) => document.getElementById(id);
  const steps = {
    password: el('step-password'), details: el('step-details'), photo: el('step-photo'),
    mfa: el('step-mfa'), done: el('step-done')
  };
  const stepOrder = ['password', 'details', 'photo', 'mfa'];
  function showStep(name) {
    Object.entries(steps).forEach(([key, node]) => { if (node) node.hidden = key !== name; });
    if (progress) {
      progress.hidden = name === 'done';
      const index = stepOrder.indexOf(name);
      [...progress.children].forEach((li) => {
        const step = Number(li.dataset.step);
        li.classList.toggle('is-done', step - 1 < index);
        li.classList.toggle('is-current', step - 1 === index);
        if (step - 1 === index) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
    }
    say('');
    const focusable = steps[name]?.querySelector('input, button');
    window.setTimeout(() => focusable?.focus?.(), 0);
  }
  function fieldError(id, message) {
    const error = el(`${id}-error`);
    if (error) { error.textContent = message || ''; error.hidden = !message; }
    el(id)?.setAttribute('aria-invalid', String(Boolean(message)));
  }
  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('is-loading', busy);
    button.setAttribute('aria-busy', String(busy));
    if (label) button.textContent = label;
  }

  let client;
  let userId = null;

  // ---- session bootstrap ----
  try {
    window.AtlasRehearsalBoundary.validate(cfg);
    if (!token) throw new Error('missing');
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'atlas-invitation-setup' }
    });
    const { data, error } = await client.auth.verifyOtp({ token_hash: token, type: 'invite' });
    if (error || !data.session) throw error || new Error('session');
    userId = data.user.id;
    if (checking) checking.hidden = true;
    const email = el('invite-email');
    if (email) { email.textContent = data.user.email; el('invite-account').hidden = false; }
    // Pre-fill the name from the invite metadata, if the manager set one.
    const known = data.user.user_metadata?.full_name || data.user.user_metadata?.display_name || '';
    if (known && el('display-name')) el('display-name').value = known;
    showStep('password');
    say('Choose a password with at least 10 characters.');
  } catch (_) {
    if (checking) checking.hidden = true;
    if (progress) progress.hidden = true;
    const sub = el('invite-sub');
    if (sub) sub.textContent = 'This invitation link cannot be used.';
    say('This invitation has expired or was already used. Ask your manager for a new one. If you already set up your account, sign in instead.', 'error');
    return;
  }

  async function edgeRequest(endpoint, action, body) {
    const session = (await client.auth.getSession()).data?.session;
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    const init = {
      method: 'POST',
      headers: { authorization: `Bearer ${session?.access_token || ''}`, apikey: cfg.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(45000)
    };
    if (body instanceof FormData) init.body = body;
    else { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Never surface server text; the caller branches on status and shows its
      // own fixed copy.
      throw Object.assign(new Error('request_failed'), { status: response.status, code: payload?.code });
    }
    return payload;
  }

  // ---- step 1: password ----
  const passwordRules = () => {
    const password = el('new-password').value;
    const confirm = el('confirm-password').value;
    const met = { length: password.length >= 10, match: Boolean(password) && password === confirm };
    document.querySelectorAll('#invite-rules [data-rule]').forEach((rule) => rule.classList.toggle('is-met', met[rule.dataset.rule]));
    return met.length && met.match;
  };
  ['new-password', 'confirm-password'].forEach((id) => el(id).addEventListener('input', passwordRules));
  steps.password.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = el('new-password').value;
    const confirmInput = el('confirm-password');
    if (!passwordRules() || password.length < 10 || password !== confirmInput.value) {
      fieldError('confirm-password', password.length < 10 ? 'Use at least 10 characters.' : 'The passwords don’t match.');
      confirmInput.focus();
      return;
    }
    fieldError('confirm-password', '');
    const submit = steps.password.querySelector('button[type="submit"]');
    setBusy(submit, true, 'Saving…');
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      showStep('details');
      say('Tell your team who you are.');
    } catch (_) {
      say('Your password couldn’t be set. Check the requirements and try again.', 'error');
    } finally {
      setBusy(submit, false, 'Continue');
    }
  });

  // ---- step 2: name + phone ----
  ['display-name', 'phone'].forEach((id) => el(id).addEventListener('input', () => fieldError(id, '')));
  steps.details.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = el('display-name').value.trim();
    const phone = el('phone').value.trim();
    if (name.length < 2 || name.includes('@')) { fieldError('display-name', 'Enter your name.'); el('display-name').focus(); return; }
    if (phone.length < 3) { fieldError('phone', 'Enter a phone number so your team can reach you.'); el('phone').focus(); return; }
    const submit = steps.details.querySelector('button[type="submit"]');
    setBusy(submit, true, 'Saving…');
    try {
      // Name → auth metadata (the profile display_name is set from this at
      // completion); name + phone → the private team-profile details (self-scope).
      await client.auth.updateUser({ data: { full_name: name, display_name: name } });
      await edgeRequest(cfg.TEAM_PROFILES_API, 'save-details', {
        profile_id: userId, preferred_name: name, phone, phone_visibility: 'managers_only'
      });
      showStep('photo');
      say('Add a profile photo to continue.');
    } catch (error) {
      say(error?.status === 401 ? 'Your setup session expired. Open the invitation link again.' : 'Your details couldn’t be saved. Try again.', 'error');
    } finally {
      setBusy(submit, false, 'Continue');
    }
  });

  // ---- step 3: photo (required, upload confirmed before advancing) ----
  let photoUploaded = false;
  // Local validation failures carry their own display copy on `userText`, so the
  // handler renders that fixed copy (never a raw error string or server text).
  const photoErr = (text) => Object.assign(new Error(text), { userText: text });
  async function preparePhoto(file) {
    if (!(file instanceof File)) throw photoErr('Choose a profile photo first.');
    if (!ACCEPTED_TYPES.has(file.type)) throw photoErr('Use a JPEG, PNG, or WebP photo.');
    if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw photoErr('Choose an image smaller than 12 MB.');
    const bitmap = await createImageBitmap(file).catch(() => null);
    const source = bitmap || await new Promise((resolve, reject) => {
      const img = new Image(); const objectUrl = URL.createObjectURL(file);
      img.onload = () => { resolve({ el: img, width: img.naturalWidth, height: img.naturalHeight, revoke: () => URL.revokeObjectURL(objectUrl) }); };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(photoErr('Alcedo could not read this image. Use a JPEG, PNG or WebP photo.')); };
      img.src = objectUrl;
    });
    const width = bitmap ? bitmap.width : source.width;
    const height = bitmap ? bitmap.height : source.height;
    try {
      if (width < 64 || height < 64) throw photoErr('Photos must be at least 64 × 64 pixels.');
      const target = 512;
      const crop = Math.min(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = target; canvas.height = target;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw photoErr('This browser cannot prepare the photo.');
      context.fillStyle = '#f1eee7';
      context.fillRect(0, 0, target, target);
      context.drawImage(bitmap || source.el, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, target, target);
      let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.86));
      let mime = 'image/webp'; let ext = 'webp';
      if (!blob) { blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88)); mime = 'image/jpeg'; ext = 'jpg'; }
      if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await new Promise((r) => canvas.toBlob(r, mime, 0.68));
      if (!blob || blob.size > MAX_UPLOAD_BYTES) throw photoErr('The prepared photo is still too large. Choose a simpler image.');
      return { file: new File([blob], `profile.${ext}`, { type: mime }), preview: canvas.toDataURL(mime), width: target, height: target };
    } finally {
      bitmap?.close?.(); source.revoke?.();
    }
  }
  el('photo-choose').addEventListener('click', () => el('photo-input').click());
  el('photo-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    fieldError('photo', '');
    el('photo-choose').disabled = true;
    say('Uploading your photo…');
    try {
      const prepared = await preparePhoto(file);
      const form = new FormData();
      form.set('profile_id', userId);
      form.set('file', prepared.file);
      form.set('width', String(prepared.width));
      form.set('height', String(prepared.height));
      await edgeRequest(cfg.TEAM_PROFILE_PHOTOS_API, 'upload', form);
      // Only mark the step complete once the server confirmed the upload.
      photoUploaded = true;
      const preview = el('photo-preview');
      if (preview) { preview.classList.add('has-profile-photo'); preview.innerHTML = `<img src="${prepared.preview}" alt="Your profile photo">`; }
      el('photo-continue').disabled = false;
      el('photo-choose').textContent = 'Choose a different photo';
      say('Photo saved.');
    } catch (error) {
      fieldError('photo', error?.userText || 'Your photo couldn’t be saved. Try another image.');
    } finally {
      el('photo-choose').disabled = false;
    }
  });
  steps.photo.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!photoUploaded) { fieldError('photo', 'Add a profile photo to continue.'); return; }
    showStep('mfa');
    mountMfa();
  });

  // ---- step 4: authenticator, then complete ----
  let mfaController = null;
  async function completeOnboarding() {
    say('Finishing your account…');
    try {
      await edgeRequest(cfg.TEAM_PROFILES_API, 'complete-onboarding', {});
      await client.auth.signOut({ scope: 'local' }).catch(() => null);
      el('done-message').textContent = 'You’re all set. Sign in to Alcedo with your email, password and authenticator code.';
      showStep('done');
      if (progress) progress.hidden = true;
    } catch (error) {
      say(error?.status === 401
        ? 'Your setup session expired. Open the invitation link again to finish.'
        : 'Your account couldn’t be finished. Make sure every step is complete, then try again.', 'error');
    }
  }
  let mfaMounted = false;
  async function mountMfa() {
    if (mfaMounted) return;
    mfaMounted = true;
    mfaController = await window.AtlasMfaEnroll.mount(el('mfa-host'), {
      client,
      onVerified: () => { completeOnboarding(); }
    });
  }
})();
