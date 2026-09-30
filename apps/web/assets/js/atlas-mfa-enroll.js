// Atlas TOTP two-factor enrolment (S99).
//
// window.AtlasMfaEnroll.mount(container, { client, onVerified }) renders a
// self-contained authenticator-app enrolment step: it enrols a TOTP factor,
// shows the QR code and the secret to type by hand, takes the 6-digit code and
// verifies it. On success it calls onVerified(factor). If the person abandons
// the step before verifying, the just-created unverified factor is removed
// (best effort) so it cannot pile up.
//
// It is a classic script with no dependencies beyond the Supabase client passed
// in, so it runs both inside the app (window.atlasSupabase) and on the
// standalone invitation page (its own in-memory client). CSP-safe: no inline
// handlers, no external scripts.
(function () {
  'use strict';

  const FRIENDLY_NAME = 'Alcedo';

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // Every failure shows friendly copy; the raw error is only logged. Branch on
  // the HTTP status (never on raw error text) so no server or JS message reaches
  // the page.
  function friendly(error) {
    const status = Number(error?.status || 0);
    if (status === 400 || status === 401 || status === 422) {
      return 'That code didn’t match. Enter the current 6-digit code from your authenticator app and try again.';
    }
    return 'Two-factor setup couldn’t be completed right now. Check your connection and try again.';
  }

  async function verifiedTotpFactor(client) {
    try {
      const { data } = await client.auth.mfa.listFactors();
      return (data?.totp || data?.all || []).find((f) => f && f.factor_type !== 'phone' && f.status === 'verified') || null;
    } catch (_) {
      return null;
    }
  }

  async function mount(container, options = {}) {
    const client = options.client;
    const onVerified = typeof options.onVerified === 'function' ? options.onVerified : () => {};
    if (!container) return { destroy() {} };
    if (!client?.auth?.mfa) {
      container.innerHTML = `<p class="atlas-field__error" role="alert">${esc('Two-factor setup isn’t available right now. Reload Alcedo and try again.')}</p>`;
      return { destroy() {} };
    }

    // Someone who already finished enrolment (e.g. re-opening the step) is done.
    const already = await verifiedTotpFactor(client);
    if (already) {
      container.innerHTML = `<div class="atlas-mfa-enroll" data-atlas-mfa-enroll>
        <p class="atlas-auth__status" role="status">${esc('Your authenticator app is already set up.')}</p>
      </div>`;
      onVerified(already);
      return { destroy() {} };
    }

    let factorId = null;
    let verified = false;
    let destroyed = false;

    container.innerHTML = `<div class="atlas-mfa-enroll" data-atlas-mfa-enroll aria-busy="true">
      <p class="atlas-auth__status" role="status">${esc('Preparing your authenticator setup…')}</p>
    </div>`;

    let enrollment;
    try {
      const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: FRIENDLY_NAME });
      if (error || !data?.id) throw error || new Error('enroll');
      enrollment = data;
      factorId = data.id;
    } catch (error) {
      console.warn('MFA enrol failed', error?.status || '', error?.message || '');
      container.innerHTML = `<div class="atlas-mfa-enroll" data-atlas-mfa-enroll>
        <p class="atlas-field__error" role="alert">${esc(friendly(error))}</p>
        <button type="button" class="atlas-btn atlas-btn--secondary" data-mfa-retry>Try again</button>
      </div>`;
      container.querySelector('[data-mfa-retry]')?.addEventListener('click', () => { mount(container, options); });
      return { destroy() {} };
    }

    if (destroyed) { await cleanup(); return { destroy() {} }; }

    const qr = enrollment.totp?.qr_code || '';
    const secret = enrollment.totp?.secret || '';
    container.innerHTML = `<div class="atlas-mfa-enroll" data-atlas-mfa-enroll>
      <ol class="atlas-mfa-enroll__steps">
        <li>Open an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator).</li>
        <li>Scan this code, or type the setup key by hand.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      ${qr ? `<div class="atlas-mfa-enroll__qr"><img src="${esc(qr)}" alt="QR code to add Alcedo to your authenticator app" width="200" height="200"></div>` : ''}
      <div class="atlas-mfa-enroll__secret">
        <span class="atlas-mfa-enroll__secret-label" id="atlas-mfa-secret-label">Setup key</span>
        <code data-mfa-secret aria-labelledby="atlas-mfa-secret-label">${esc(secret)}</code>
        <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mfa-copy aria-label="Copy setup key">Copy</button>
      </div>
      <form class="atlas-mfa-enroll__form" novalidate data-mfa-form>
        <div class="atlas-field">
          <label for="atlas-mfa-code">6-digit code</label>
          <input class="atlas-input" id="atlas-mfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required aria-describedby="atlas-mfa-code-error">
          <p class="atlas-field__error" id="atlas-mfa-code-error" role="alert" hidden></p>
        </div>
        <button type="submit" class="atlas-btn atlas-btn--primary atlas-btn--lg atlas-mfa-enroll__submit">Verify and finish</button>
      </form>
    </div>`;

    const form = container.querySelector('[data-mfa-form]');
    const input = container.querySelector('#atlas-mfa-code');
    const errorEl = container.querySelector('#atlas-mfa-code-error');
    const submit = form?.querySelector('button[type="submit"]');

    const showError = (message) => {
      if (!errorEl) return;
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
      input?.setAttribute('aria-invalid', String(Boolean(message)));
    };

    container.querySelector('[data-mfa-copy]')?.addEventListener('click', async (event) => {
      try {
        await navigator.clipboard?.writeText(secret);
        event.currentTarget.textContent = 'Copied';
        window.setTimeout(() => { if (event.currentTarget) event.currentTarget.textContent = 'Copy'; }, 1500);
      } catch (_) {
        // Clipboard blocked: the key is already visible to type by hand.
      }
    });

    input?.addEventListener('input', () => {
      input.value = input.value.replace(/\D+/g, '').slice(0, 6);
      if (!errorEl?.hidden) showError('');
    });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = String(input?.value || '').replace(/\D+/g, '');
      if (!/^\d{6}$/.test(code)) { showError('Enter the current 6-digit code from your authenticator app.'); input?.focus(); return; }
      showError('');
      if (submit) { submit.disabled = true; submit.classList.add('is-loading'); submit.setAttribute('aria-busy', 'true'); submit.textContent = 'Verifying…'; }
      try {
        const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
        if (error) throw error;
        verified = true;
        container.innerHTML = `<div class="atlas-mfa-enroll" data-atlas-mfa-enroll><p class="atlas-auth__status" role="status">${esc('Your authenticator app is set up.')}</p></div>`;
        onVerified(enrollment);
      } catch (error) {
        console.warn('MFA verify failed', error?.status || '', error?.message || '');
        showError(friendly(error));
        if (submit) { submit.disabled = false; submit.classList.remove('is-loading'); submit.removeAttribute('aria-busy'); submit.textContent = 'Verify and finish'; }
        input?.focus();
      }
    });

    window.setTimeout(() => input?.focus(), 0);

    async function cleanup() {
      if (verified || !factorId) return;
      try { await client.auth.mfa.unenroll({ factorId }); } catch (_) { /* best effort */ }
      factorId = null;
    }

    const onPageHide = () => { cleanup(); };
    window.addEventListener('pagehide', onPageHide, { once: true });

    return {
      get verified() { return verified; },
      destroy() {
        destroyed = true;
        window.removeEventListener('pagehide', onPageHide);
        return cleanup();
      }
    };
  }

  window.AtlasMfaEnroll = { mount, hasVerifiedFactor: verifiedTotpFactor };
})();
