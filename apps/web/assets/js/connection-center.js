(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const REFRESH_INTERVAL_MS = 60000;
  const LEGACY_CONNECTION_KEYS = new Set(['supabase']);
  const GRANT_STATES = [
    'not_requested', 'verification_required', 'read_only', 'granted',
    'denied', 'blocked', 'not_supported'
  ];

  const state = {
    workspace: null,
    loading: false,
    mutating: false,
    error: null,
    message: null,
    filter: 'all',
    category: 'all',
    initialized: false,
    observer: null,
    refreshTimer: null,
    retryTimer: null
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function endpoint() {
    const explicit = String(cfg.CONNECTIONS_API || '').trim();
    if (explicit) return explicit;
    const gateway = String(cfg.SYSTEM_API || cfg.SETTINGS_API || '').trim();
    return gateway.replace(/\/atlas-(?:system|settings)\/?$/, '/atlas-connections');
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action = 'snapshot', body = null) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Connection Center API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Connection Center.');

    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          'x-atlas-request-id': requestId,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify({ request_id: requestId, ...body }) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.result?.error || payload?.error || `Connection request failed (${response.status}).`);
        error.status = response.status;
        error.code = payload?.result?.error_code || payload?.error_code || 'REQUEST_FAILED';
        throw error;
      }
      return payload?.result || payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Connection Center took too long to respond. Try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function settingsHost() {
    return document.querySelector('#settings-view .settings-integrations');
  }

  function systemHost() {
    return document.querySelector('#system-view .system-integrations');
  }

  function hosts() {
    return [
      [settingsHost(), 'settings'],
      [systemHost(), 'system']
    ].filter(([host]) => host instanceof HTMLElement);
  }

  function visible() {
    return hosts().some(([host]) => {
      const app = document.getElementById('app-screen');
      return app && window.getComputedStyle(app).display !== 'none'
        && window.getComputedStyle(host).display !== 'none';
    });
  }

  function connections() {
    const rows = Array.isArray(state.workspace?.connections) ? state.workspace.connections : [];
    return rows.filter((entry) => !LEGACY_CONNECTION_KEYS.has(entry.connection_key));
  }

  function permissions() {
    return state.workspace?.permissions || {};
  }

  function statusTone(value) {
    if (value === 'healthy') return 'good';
    if (['verifying', 'authorization_required', 'not_configured'].includes(value)) return 'warn';
    if (['degraded', 'expired', 'blocked'].includes(value)) return 'bad';
    return 'neutral';
  }

  function statusIcon(value) {
    if (value === 'healthy') return 'circle-check-big';
    if (value === 'verifying') return 'loader-circle';
    if (value === 'authorization_required') return 'key-round';
    if (value === 'not_configured') return 'unplug';
    if (value === 'intentionally_disabled') return 'shield-ban';
    if (value === 'expired') return 'clock-alert';
    if (value === 'blocked') return 'ban';
    return 'triangle-alert';
  }

  function formatDateTime(value, fallback = 'Not verified') {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function relativeTime(value) {
    if (!value) return 'Not verified';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not verified';
    const delta = Date.now() - date.getTime();
    const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000]];
    for (const [label, duration] of units) {
      if (Math.abs(delta) >= duration) {
        const count = Math.max(1, Math.round(Math.abs(delta) / duration));
        return `${count} ${label}${count === 1 ? '' : 's'} ${delta < 0 ? 'from now' : 'ago'}`;
      }
    }
    return 'just now';
  }

  function visibleConnections() {
    return connections().filter((connection) => {
      if (state.filter !== 'all' && connection.state !== state.filter) return false;
      if (state.category !== 'all' && connection.category !== state.category) return false;
      return true;
    });
  }

  function summary() {
    const rows = connections();
    return {
      total: rows.length,
      healthy: rows.filter((entry) => entry.state === 'healthy').length,
      degraded: rows.filter((entry) => ['degraded', 'expired', 'blocked'].includes(entry.state)).length,
      actionRequired: rows.filter((entry) => ['not_configured', 'authorization_required', 'verifying'].includes(entry.state)).length,
      disabled: rows.filter((entry) => entry.state === 'intentionally_disabled').length
    };
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="connection-center-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    if (state.message) return `<div class="connection-center-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    return '';
  }

  function summaryMarkup() {
    const value = summary();
    const cards = [
      ['network', 'Registered', value.total, 'One canonical registry'],
      ['circle-check-big', 'Healthy', value.healthy, 'Recent verification evidence'],
      ['triangle-alert', 'Action required', value.actionRequired, 'Configuration, authorization or verification'],
      ['shield-alert', 'Degraded / blocked', value.degraded, `${value.disabled} intentionally disabled`]
    ];
    return `<section class="connection-center-summary">${cards.map(([icon, label, count, note]) => `<article><i data-lucide="${icon}"></i><div><span>${escapeHtml(label)}</span><strong>${Number(count).toLocaleString('en-GB')}</strong><small>${escapeHtml(note)}</small></div></article>`).join('')}</section>`;
  }

  function filterMarkup() {
    const states = ['all', ...new Set(connections().map((entry) => entry.state))];
    const categories = ['all', ...new Set(connections().map((entry) => entry.category).filter(Boolean))];
    return `<section class="connection-center-filters">
      <label><span>State</span><select data-connection-filter>${states.map((entry) => `<option value="${escapeHtml(entry)}" ${entry === state.filter ? 'selected' : ''}>${escapeHtml(entry === 'all' ? 'All states' : humanize(entry))}</option>`).join('')}</select></label>
      <label><span>Category</span><select data-connection-category>${categories.map((entry) => `<option value="${escapeHtml(entry)}" ${entry === state.category ? 'selected' : ''}>${escapeHtml(entry === 'all' ? 'All categories' : humanize(entry))}</option>`).join('')}</select></label>
      <button type="button" class="connection-center-secondary" data-connection-refresh ${state.loading || state.mutating ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>Refresh</button>
      ${permissions().can_run_checks ? `<button type="button" class="connection-center-primary" data-connection-check-all ${state.mutating ? 'disabled' : ''}><i data-lucide="activity"></i>${state.mutating ? 'Checking…' : 'Check all'}</button>` : ''}
    </section>`;
  }

  function capabilityMarkup(connection, capability) {
    const editable = permissions().can_manage_capabilities;
    const canGrant = permissions().can_grant_high_risk
      || !['write', 'publish', 'admin'].includes(capability.kind)
      && !['high', 'critical'].includes(capability.risk_level);
    const select = editable ? `<select data-connection-capability-state ${canGrant ? '' : 'data-restricted="true"'}>
      ${GRANT_STATES.map((value) => `<option value="${value}" ${value === capability.grant_state ? 'selected' : ''} ${value === 'granted' && !canGrant ? 'disabled' : ''}>${humanize(value)}</option>`).join('')}
    </select>` : `<strong>${escapeHtml(humanize(capability.grant_state))}</strong>`;
    return `<div class="connection-center-capability" data-connection-key="${escapeHtml(connection.connection_key)}" data-capability-key="${escapeHtml(capability.capability_key)}" data-capability-kind="${escapeHtml(capability.kind)}" data-risk-level="${escapeHtml(capability.risk_level)}" data-manager-approval="${Boolean(capability.manager_approval_required)}">
      <div><span>${escapeHtml(humanize(capability.capability_key))}</span><small>${escapeHtml(humanize(capability.kind))} · ${escapeHtml(humanize(capability.risk_level))} risk</small></div>
      ${select}
      ${editable ? `<button type="button" data-connection-save-capability ${state.mutating ? 'disabled' : ''}>Save</button>` : ''}
      <em>${capability.automatic_execution_allowed ? 'Automatic execution enabled' : 'Automatic execution off'}</em>
    </div>`;
  }

  function smtpEvidenceMarkup(connection) {
    if (connection.connection_key !== 'custom-smtp' || !permissions().can_run_checks) return '';
    return `<form class="connection-center-manual" data-connection-manual-form="custom-smtp">
      <strong>SMTP delivery evidence</strong>
      <p>Configured is not healthy until both messages arrive through the custom provider.</p>
      <label><input type="checkbox" name="invitation_delivered"> Invitation delivered</label>
      <label><input type="checkbox" name="password_reset_delivered"> Password reset delivered</label>
      <input type="text" name="summary" maxlength="500" placeholder="Optional test note">
      <button type="submit" class="connection-center-secondary" ${state.mutating ? 'disabled' : ''}><i data-lucide="mail-check"></i>Record delivery test</button>
    </form>`;
  }

  function connectionCard(connection) {
    const capabilities = Array.isArray(connection.capabilities) ? connection.capabilities : [];
    const dependencies = Array.isArray(connection.dependencies) ? connection.dependencies : [];
    const canCheck = permissions().can_run_checks
      && !['manual', 'aggregate', 'disabled'].includes(connection.check_strategy);
    return `<article class="connection-center-card is-${statusTone(connection.state)}">
      <header>
        <span class="connection-center-icon"><i data-lucide="${statusIcon(connection.state)}"></i></span>
        <div><small>${escapeHtml(humanize(connection.environment))} · ${escapeHtml(humanize(connection.category))}</small><h3>${escapeHtml(connection.label)}</h3><p>${escapeHtml(connection.connection_key)}</p></div>
        <span class="connection-center-status is-${statusTone(connection.state)}"><i></i>${escapeHtml(humanize(connection.state))}</span>
      </header>
      <dl>
        <div><dt>Owner</dt><dd>${escapeHtml(humanize(connection.owner_module))}</dd></div>
        <div><dt>Check</dt><dd>${escapeHtml(humanize(connection.check_strategy))}</dd></div>
        <div><dt>Last success</dt><dd>${escapeHtml(relativeTime(connection.last_succeeded_at))}</dd></div>
        <div><dt>Latency</dt><dd>${connection.latency_ms == null ? '—' : `${Number(connection.latency_ms)} ms`}</dd></div>
      </dl>
      ${connection.last_error_summary ? `<div class="connection-center-error"><code>${escapeHtml(connection.last_error_code || 'CONNECTION')}</code><span>${escapeHtml(connection.last_error_summary)}</span></div>` : ''}
      <footer>
        <span>Verified ${escapeHtml(formatDateTime(connection.last_succeeded_at))}</span>
        ${canCheck ? `<button type="button" data-connection-check="${escapeHtml(connection.connection_key)}" ${state.mutating ? 'disabled' : ''}><i data-lucide="activity"></i>Check now</button>` : `<span>${connection.check_strategy === 'manual' ? 'Manual evidence required' : connection.check_strategy === 'disabled' ? 'Disabled by policy' : 'Derived connection'}</span>`}
      </footer>
      ${smtpEvidenceMarkup(connection)}
      <details>
        <summary>Capabilities & dependent modules</summary>
        <section class="connection-center-capabilities">${capabilities.length ? capabilities.map((capability) => capabilityMarkup(connection, capability)).join('') : '<p>No capability grants registered.</p>'}</section>
        <section class="connection-center-dependencies">${dependencies.length ? dependencies.map((dependency) => `<article><strong>${escapeHtml(humanize(dependency.module_key))}</strong><span>${escapeHtml(humanize(dependency.requirement_level))}</span><p>${escapeHtml(dependency.safety_boundary || '')}</p></article>`).join('') : '<p>No dependent modules registered.</p>'}</section>
      </details>
    </article>`;
  }

  function historyMarkup(mode) {
    if (mode !== 'system' || !permissions().can_run_checks) return '';
    const events = Array.isArray(state.workspace?.history) ? state.workspace.history : [];
    return `<section class="connection-center-history">
      <header><div><span>Event history</span><h3>Connection evidence</h3></div><small>${events.length} recent events</small></header>
      <div>${events.length ? events.slice(0, 60).map((event) => `<article><i data-lucide="${event.event_type === 'state_changed' ? 'git-compare-arrows' : event.event_type === 'capability_changed' ? 'shield-check' : 'activity'}"></i><div><small>${escapeHtml(formatDateTime(event.created_at))} · ${escapeHtml(event.actor_label || 'Atlas')}</small><strong>${escapeHtml(humanize(event.event_type))}</strong><p>${escapeHtml(humanize(event.connection_key))}${event.new_state ? ` · ${escapeHtml(humanize(event.new_state))}` : ''}</p></div></article>`).join('') : '<p>No connection events have been recorded.</p>'}</div>
    </section>`;
  }

  function loadingMarkup() {
    return `<section class="connection-center connection-center-loading"><i data-lucide="network"></i><h3>Loading Connection Center</h3><p>Reading verified states, capabilities, dependencies and recent evidence.</p><span></span></section>`;
  }

  function errorMarkup() {
    return `<section class="connection-center connection-center-loading is-error"><i data-lucide="server-off"></i><h3>Connection Center unavailable</h3><p>${escapeHtml(state.error || 'Connection state could not be loaded.')}</p><button type="button" class="connection-center-primary" data-connection-refresh>Try again</button></section>`;
  }

  function shellMarkup(mode) {
    const rows = visibleConnections();
    return `<section class="connection-center" data-connection-center-mode="${mode}">
      <header class="connection-center-hero">
        <div><span><i data-lucide="network"></i>Phase 2 · P2.0</span><h2>Connection Center</h2><p>${mode === 'system' ? 'Technical health, freshness, capability and event evidence from one canonical registry.' : 'Verified business connection state and required authorization actions. No credentials are shown.'}</p></div>
        <aside><strong>${escapeHtml(String(state.workspace?.version || 'atlas-connections/0.1.0'))}</strong><small>Generated ${escapeHtml(formatDateTime(state.workspace?.generated_at))}</small></aside>
      </header>
      ${feedbackMarkup()}
      ${summaryMarkup()}
      <section class="connection-center-contract"><i data-lucide="shield-check"></i><div><strong>Connection safety boundary</strong><span>Healthy requires recent verification. External write, publishing, ordering and production-sync capabilities remain blocked unless explicitly authorized.</span></div></section>
      ${filterMarkup()}
      <section class="connection-center-grid">${rows.length ? rows.map(connectionCard).join('') : '<div class="connection-center-empty"><i data-lucide="search-x"></i>No connections match the selected filters.</div>'}</section>
      ${historyMarkup(mode)}
    </section>`;
  }

  function hideLegacy(host, mode) {
    if (mode === 'system') {
      host.querySelector('.system-filter-row')?.setAttribute('hidden', '');
      host.querySelector('.system-integration-grid')?.setAttribute('hidden', '');
    } else {
      host.querySelector('.settings-integration-grid')?.setAttribute('hidden', '');
    }
  }

  function render() {
    for (const [host, mode] of hosts()) {
      hideLegacy(host, mode);
      let mount = host.querySelector(':scope > [data-atlas-connection-center]');
      if (!mount) {
        mount = document.createElement('div');
        mount.dataset.atlasConnectionCenter = mode;
        host.appendChild(mount);
      }
      if (state.loading && !state.workspace) mount.innerHTML = loadingMarkup();
      else if (state.error && !state.workspace) mount.innerHTML = errorMarkup();
      else mount.innerHTML = shellMarkup(mode);
    }
    window.lucide?.createIcons?.();
  }

  function applyWorkspace(payload, message = null) {
    const workspace = payload?.workspace || payload;
    if (!workspace || !Array.isArray(workspace.connections)) throw new Error('Connection Center returned an invalid snapshot.');
    state.workspace = workspace;
    state.error = null;
    state.message = message;
  }

  async function load(options = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!options.silent) state.error = null;
    render();
    try {
      applyWorkspace(await api('snapshot'));
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Connection Center could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, message) {
    if (state.mutating) return;
    state.mutating = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api(action, body);
      applyWorkspace(payload.workspace || payload, message);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Connection action failed.';
    } finally {
      state.mutating = false;
      render();
    }
  }

  function handleChange(event) {
    const target = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!target) return;
    if (target.matches('[data-connection-filter]')) {
      state.filter = target.value;
      render();
    }
    if (target.matches('[data-connection-category]')) {
      state.category = target.value;
      render();
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-connection-refresh]')) {
      load();
      return;
    }
    if (target.closest('[data-connection-check-all]')) {
      mutate('check-all', { client_origin: location.origin }, 'Automated connection checks completed.');
      return;
    }
    const check = target.closest('[data-connection-check]');
    if (check) {
      mutate('check', {
        connection_key: check.dataset.connectionCheck,
        client_origin: location.origin
      }, `${humanize(check.dataset.connectionCheck)} checked.`);
      return;
    }
    const capabilityButton = target.closest('[data-connection-save-capability]');
    if (capabilityButton) {
      const row = capabilityButton.closest('[data-capability-key]');
      const select = row?.querySelector('[data-connection-capability-state]');
      if (!row || !(select instanceof HTMLSelectElement)) return;
      mutate('set-capability', {
        connection_key: row.dataset.connectionKey,
        capability_key: row.dataset.capabilityKey,
        capability_kind: row.dataset.capabilityKind,
        grant_state: select.value,
        risk_level: row.dataset.riskLevel,
        manager_approval_required: row.dataset.managerApproval === 'true',
        metadata: {}
      }, `${humanize(row.dataset.capabilityKey)} capability reviewed.`);
    }
  }

  function handleSubmit(event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form?.matches('[data-connection-manual-form]')) return;
    event.preventDefault();
    const invitation = Boolean(form.querySelector('[name="invitation_delivered"]')?.checked);
    const passwordReset = Boolean(form.querySelector('[name="password_reset_delivered"]')?.checked);
    const summaryInput = form.querySelector('[name="summary"]');
    mutate('manual-check', {
      connection_key: form.dataset.connectionManualForm,
      state: invitation && passwordReset ? 'healthy' : 'verifying',
      summary: summaryInput instanceof HTMLInputElement ? summaryInput.value.trim() : '',
      evidence: {
        invitation_delivered: invitation,
        password_reset_delivered: passwordReset
      }
    }, invitation && passwordReset
      ? 'SMTP delivery evidence verified.'
      : 'Partial SMTP evidence recorded; connection remains unverified.');
  }

  function mount() {
    const currentHosts = hosts();
    if (!currentHosts.length) return;
    const needsMount = currentHosts.some(([host]) => !host.querySelector(':scope > [data-atlas-connection-center]'));
    if (needsMount) render();
    if (!state.workspace && !state.loading) load();
  }

  function init() {
    if (state.initialized) return true;
    state.initialized = true;
    document.addEventListener('click', handleClick, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('submit', handleSubmit, true);

    state.observer = new MutationObserver(() => mount());
    state.observer.observe(document.getElementById('app-screen') || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    state.refreshTimer = window.setInterval(() => {
      if (visible() && state.workspace && !state.loading && !state.mutating) load({ silent: true });
    }, REFRESH_INTERVAL_MS);

    window.addEventListener('online', () => {
      if (visible()) load({ silent: true });
    });
    window.addEventListener('focus', () => {
      if (visible() && state.workspace) load({ silent: true });
    });
    window.addEventListener('pagehide', () => {
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('change', handleChange, true);
      document.removeEventListener('submit', handleSubmit, true);
      state.observer?.disconnect();
      if (state.refreshTimer) window.clearInterval(state.refreshTimer);
      if (state.retryTimer) window.clearInterval(state.retryTimer);
    }, { once: true });

    mount();
    return true;
  }

  window.AtlasConnectionCenter = {
    refresh: load,
    snapshot: () => state.workspace
  };

  if (!init()) {
    state.retryTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 100);
  }
})();
