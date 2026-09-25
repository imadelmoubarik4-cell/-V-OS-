// Settings › System health (#settings/system, administrators) —
// docs/design/Atlas_Experience_Redesign.md §7.15. Formerly the separate System
// page; it is now a section Settings mounts: window.AtlasSystem.mount(host).
//
// Read only. Talks to atlas-system (GET ?action=snapshot) with the signed-in
// person's session; it never retries jobs, changes incidents or rolls back.
// Anything Atlas has not verified reads "Not checked yet", never "Healthy".
(function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 22000;
  const TABS = [
    ['services', 'Services'],
    ['incidents', 'Incidents'],
    ['sources', 'Data sources'],
    ['environments', 'Environments'],
    ['jobs', 'Jobs'],
    ['audit', 'Audit & recovery']
  ];
  const LABELS = {
    healthy: 'Healthy', connected: 'Connected', ready: 'Ready', current: 'Up to date', degraded: 'Degraded', down: 'Down',
    outage: 'Outage', limited: 'Limited', partial: 'Partly complete', stale: 'Out of date', no_records: 'No records yet',
    not_connected: 'Not connected', disabled_by_policy: 'Off by policy', historical: 'Historical', blocked: 'Blocked',
    running: 'Running', waiting: 'Waiting', failed: 'Failed', idle: 'Idle', open: 'Open', monitoring: 'Monitoring',
    resolved: 'Resolved', dismissed: 'Dismissed', critical: 'Critical', warning: 'Warning', info: 'Information',
    disabled: 'Off', enabled: 'On', unverified: 'Not verified', preview_only: 'Test only', none: 'None'
  };
  const GOOD = ['healthy', 'connected', 'ready', 'current', 'resolved'];
  const WARN = ['degraded', 'partial', 'stale', 'warning', 'monitoring', 'waiting', 'no_records', 'limited', 'unverified'];
  const BAD = ['down', 'outage', 'critical', 'failed', 'open', 'blocked'];

  const state = {
    host: null,
    tab: 'services',
    workspace: null,
    status: 'idle', // idle | loading | ready | error | forbidden
    refreshing: false,
    checkedAt: null,
    sourceFilter: 'all',
    auditFilter: 'all',
    bound: false
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    const text = String(value || '').replace(/[_-]+/g, ' ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function label(value) {
    if (!value || value === 'unknown') return 'Not checked yet';
    return LABELS[value] || humanize(value);
  }

  function pill(value, text) {
    const tone = GOOD.includes(value) ? 'positive' : WARN.includes(value) ? 'warning' : BAD.includes(value) ? 'danger' : 'neutral';
    return `<span class="atlas-pill atlas-pill--${tone}">${escapeHtml(text || label(value))}</span>`;
  }

  function icon(name) {
    return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
  }

  function when(value, fallback = 'Not recorded') {
    if (!value || String(value).startsWith('1970-01-01')) return fallback;
    const clock = window.AtlasVenueClock;
    return clock?.formatDateTime?.(value) || fallback;
  }

  function ago(value, fallback = 'Not checked yet') {
    if (!value) return fallback;
    const clock = window.AtlasVenueClock;
    return clock?.formatRelative?.(value) || fallback;
  }

  function count(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(Math.round(parsed)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '—';
  }

  function environmentName(value) {
    return { production: 'Live app', preview: 'Test copy', staging: 'Test copy', local: 'Local' }[value] || humanize(value);
  }

  function list(name) {
    return Array.isArray(state.workspace?.[name]) ? state.workspace[name] : [];
  }

  // ---------- server ----------

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action = 'snapshot') {
    const apiUrl = String(window.VABAR_CONFIG?.SYSTEM_API || '').trim();
    if (!apiUrl) throw Object.assign(new Error('not configured'), { status: 0 });
    const session = await activeSession();
    if (!session?.access_token) throw Object.assign(new Error('signed out'), { status: 401 });
    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    url.searchParams.set('client_host', location.hostname);
    url.searchParams.set('client_url', location.origin);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json'
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('request failed'), { status: response.status });
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function load(force = false) {
    if (state.status === 'loading' || state.refreshing) return;
    if (!force && state.status === 'ready') return;
    if (state.workspace) state.refreshing = true; else state.status = 'loading';
    render();
    try {
      const payload = await api('snapshot');
      state.workspace = payload.workspace || {};
      state.status = 'ready';
      state.checkedAt = new Date();
    } catch (error) {
      state.status = error?.status === 403 ? 'forbidden' : state.workspace ? 'ready' : 'error';
      if (state.workspace && error?.status !== 403) state.refreshError = true;
    } finally {
      state.refreshing = false;
      render();
    }
  }

  // ---------- markup ----------

  function overallStatus() {
    const reported = state.workspace?.summary?.overall_status || 'unknown';
    const complete = list('services').length && list('data_sources').length && list('releases').length;
    return reported === 'healthy' && !complete ? 'unverified' : reported;
  }

  function summaryMarkup() {
    const summary = state.workspace?.summary || {};
    const overall = overallStatus();
    return `<div class="sys-summary">
      <div class="sys-summary__state">${pill(overall, overall === 'healthy' ? 'Everything checked is healthy' : overall === 'unverified' || overall === 'unknown' ? 'Not fully checked yet' : `Overall: ${label(overall)}`)}
        <span class="sys-summary__checked">${state.checkedAt ? `Checked ${escapeHtml(ago(state.checkedAt, ''))}` : ''}</span></div>
      <dl class="sys-facts">
        <div><dt>Healthy services</dt><dd>${count(summary.healthy_services)}</dd></div>
        <div><dt>Degraded or down</dt><dd>${count(summary.degraded_services ?? 0)}</dd></div>
        <div><dt>Open incidents</dt><dd>${count(summary.open_incidents ?? 0)}</dd></div>
        <div><dt>Blocked data sources</dt><dd>${count(summary.blocked_sources ?? 0)}</dd></div>
      </dl>
    </div>`;
  }

  function servicesMarkup() {
    const services = list('services');
    if (!services.length) return emptyMarkup('server', 'No service checks recorded yet', 'Atlas shows a service here once a check has run. It never reports a service as healthy without one.');
    return `<ul class="atlas-list atlas-card">${services.map((service) => `<li class="atlas-row">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(service.label)}</p>
        <p class="atlas-row__meta">${escapeHtml([humanize(service.category), environmentName(service.environment), `checked ${ago(service.last_checked_at)}`].filter(Boolean).join(' · '))}</p>
        ${service.failure_message ? `<p class="atlas-row__meta sys-warn">${escapeHtml(service.failure_message)}</p>` : ''}</div>
      <div class="atlas-row__end">${pill(service.status)}</div>
    </li>`).join('')}</ul>`;
  }

  function incidentsMarkup() {
    const incidents = list('incidents');
    const body = incidents.length ? `<ul class="atlas-list atlas-card">${incidents.map((incident) => `<li class="atlas-row">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(incident.title)}${incident.metadata?.release_blocker ? ' <span class="atlas-pill atlas-pill--danger">Release blocker</span>' : ''}</p>
        <p class="atlas-row__meta">${escapeHtml(incident.summary || '')}</p>
        <p class="atlas-row__meta">${escapeHtml([label(incident.severity), `last seen ${when(incident.last_occurred_at)}`, `${count(incident.occurrence_count)} times`].join(' · '))}</p>
        ${incident.resolution_note ? `<p class="atlas-row__meta">Resolution: ${escapeHtml(incident.resolution_note)}</p>` : ''}</div>
      <div class="atlas-row__end">${pill(incident.status)}</div>
    </li>`).join('')}</ul>` : emptyMarkup('circle-check', 'No incidents recorded', 'Problems Atlas detects appear here with their impact.');
    return `${body}<p class="sys-note">${icon('lock')}Incidents are read-only here: Atlas can’t resolve or dismiss them from this page.</p>`;
  }

  function sourcesMarkup() {
    const sources = list('data_sources');
    const filters = [['all', 'All'], ['live', 'Live'], ['historical', 'Historical'], ['blocked', 'Needs attention']];
    const visible = sources.filter((source) => state.sourceFilter === 'all'
      || (state.sourceFilter === 'live' && source.is_live)
      || (state.sourceFilter === 'historical' && source.is_historical)
      || (state.sourceFilter === 'blocked' && ['not_connected', 'blocked', 'stale', 'partial'].includes(source.status)));
    const chips = `<div class="atlas-chips sys-filters" role="group" aria-label="Filter data sources">${filters.map(([key, text]) => `<button type="button" class="atlas-chip" aria-pressed="${state.sourceFilter === key}" data-system-source-filter="${key}">${text}</button>`).join('')}</div>`;
    if (!sources.length) return emptyMarkup('database', 'No data sources registered yet', 'Pages may still hold data; this list shows only sources Atlas has checked.');
    return `${chips}<div class="atlas-table-wrap"><table class="atlas-table">
      <thead><tr><th scope="col">Source</th><th scope="col" class="is-num">Records</th><th scope="col">Last update</th><th scope="col">Status</th></tr></thead>
      <tbody>${visible.map((source) => `<tr>
        <td><span class="cell-primary">${escapeHtml(source.label)}</span><span class="cell-sub">${escapeHtml([humanize(source.domain), source.is_historical ? 'Historical' : source.is_live ? 'Live' : ''].filter(Boolean).join(' · '))}</span></td>
        <td class="is-num">${count(source.record_count)}</td>
        <td>${escapeHtml(ago(source.last_successful_at, 'Not updated yet'))}</td>
        <td>${pill(source.status || source.freshness_state)}</td>
      </tr>`).join('') || '<tr><td colspan="4">No sources match this filter.</td></tr>'}</tbody>
    </table></div>`;
  }

  function environmentsMarkup() {
    const releases = list('releases');
    const recovery = state.workspace?.recovery || {};
    const body = releases.length ? `<ul class="atlas-list atlas-card">${releases.map((release) => {
      const blockers = Array.isArray(release.release_blockers) ? release.release_blockers : [];
      return `<li class="atlas-row">
        <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(release.label)} · ${escapeHtml(environmentName(release.environment))}</p>
          <p class="atlas-row__meta">${escapeHtml([release.commit_sha ? `Version ${String(release.commit_sha).slice(0, 7)}` : 'Version not recorded', release.commit_date ? `released ${when(release.commit_date)}` : null, `database updates: ${label(release.migration_status || 'unknown').toLowerCase()}`].filter(Boolean).join(' · '))}</p>
          ${blockers.length ? `<p class="atlas-row__meta sys-warn">${escapeHtml(`${blockers.length} release ${blockers.length === 1 ? 'blocker' : 'blockers'}: ${blockers.map((blocker) => blocker.label || blocker.key).join(', ')}`)}</p>` : ''}</div>
        <div class="atlas-row__end">${pill(release.status)}</div>
      </li>`;
    }).join('')}</ul>` : emptyMarkup('git-compare', 'No releases recorded yet', 'Each release Atlas records appears here.');
    return `${body}<dl class="sys-facts sys-facts--list">
      <div><dt>Automatic copy of test data to the live app</dt><dd>${recovery.production_sync_enabled ? 'On' : 'Off'}</dd></div>
      <div><dt>Automatic retries</dt><dd>${recovery.automatic_retries_enabled ? 'On' : 'Off'}</dd></div>
    </dl>`;
  }

  function jobsMarkup() {
    const jobs = list('jobs');
    const body = jobs.length ? `<ul class="atlas-list atlas-card">${jobs.map((job) => `<li class="atlas-row">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(job.label)}</p>
        <p class="atlas-row__meta">${escapeHtml([job.schedule_description || (job.is_automatic ? 'Runs automatically' : 'Started by a manager'), `last success ${ago(job.last_succeeded_at, 'never')}`].join(' · '))}</p>
        ${job.last_error_message ? `<p class="atlas-row__meta sys-warn">${escapeHtml(job.last_error_message)}</p>` : ''}</div>
      <div class="atlas-row__end">${pill(job.status)}</div>
    </li>`).join('')}</ul>` : emptyMarkup('list-todo', 'No background jobs registered', 'Scheduled work appears here once it exists.');
    return `${body}<p class="sys-note">${icon('lock')}Retry controls are disabled: failed jobs can’t be retried from Atlas yet.</p>`;
  }

  function auditMarkup() {
    const events = Array.isArray(state.workspace?.audit) ? state.workspace.audit : [];
    const domains = ['all', ...new Set(events.map((entry) => entry.domain).filter(Boolean))];
    const visible = state.auditFilter === 'all' ? events : events.filter((entry) => entry.domain === state.auditFilter);
    const recovery = state.workspace?.recovery || {};
    const security = state.workspace?.security || {};
    const schema = security.private_schema || {};
    const grants = Number(security.unexpected_table_grants || 0) + Number(security.unexpected_atlas_function_grants || 0);
    return `<section class="sys-block" aria-labelledby="sys-recovery-title">
        <h3 class="sys-block__title" id="sys-recovery-title">Recovery</h3>
        <dl class="sys-facts sys-facts--list">
          <div><dt>Last known healthy release</dt><dd>${escapeHtml(recovery.last_known_healthy_reference || 'Not recorded')}</dd></div>
          <div><dt>Rollback point</dt><dd>${escapeHtml(recovery.rollback_reference || 'Not recorded')}</dd></div>
          <div><dt>Verified backup</dt><dd>${escapeHtml(label(recovery.backup_status))}</dd></div>
        </dl>
        <p class="sys-note">${icon('lock')}Rollback unavailable: Atlas shows the recovery points but can’t roll back from here.</p>
      </section>
      <section class="sys-block" aria-labelledby="sys-protection-title">
        <h3 class="sys-block__title" id="sys-protection-title">Protection checks</h3>
        <dl class="sys-facts sys-facts--list">
          <div><dt>Private tables protected</dt><dd>${schema.tables != null ? `${count(schema.rls_enabled)} of ${count(schema.tables)}` : 'Not checked yet'}</dd></div>
          <div><dt>Unexpected access rules</dt><dd>${security.unexpected_table_grants != null ? count(grants) : 'Not checked yet'}</dd></div>
          <div><dt>Profile photos kept private</dt><dd>${security.profile_photo_bucket_private == null ? 'Not checked yet' : security.profile_photo_bucket_private ? 'Yes' : 'No'}</dd></div>
          <div><dt>Access changes in the last 30 days</dt><dd>${count(security.recent_access_changes ?? 0)}</dd></div>
        </dl>
        <p class="sys-note">${icon('eye-off')}Passwords, keys and sign-in secrets are never shown here.</p>
      </section>
      <section class="sys-block" aria-labelledby="sys-audit-title">
        <h3 class="sys-block__title" id="sys-audit-title">Recent activity</h3>
        ${domains.length > 1 ? `<div class="atlas-chips sys-filters" role="group" aria-label="Filter activity">${domains.map((domain) => `<button type="button" class="atlas-chip" aria-pressed="${state.auditFilter === domain}" data-system-audit-filter="${escapeHtml(domain)}">${escapeHtml(domain === 'all' ? 'All' : humanize(domain))}</button>`).join('')}</div>` : ''}
        ${visible.length ? `<ul class="atlas-list atlas-card">${visible.slice(0, 60).map((event) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(humanize(event.event_type))}</p><p class="atlas-row__meta">${escapeHtml([humanize(event.domain), event.actor_label ? `by ${event.actor_label}` : 'by Atlas', when(event.created_at)].join(' · '))}</p></div></li>`).join('')}</ul>` : '<p class="sys-muted">No activity recorded for this filter.</p>'}
      </section>`;
  }

  function emptyMarkup(name, title, text) {
    return `<div class="atlas-empty atlas-empty--inline"><div class="atlas-empty__icon">${icon(name)}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
  }

  function tabBody() {
    switch (state.tab) {
      case 'incidents': return incidentsMarkup();
      case 'sources': return sourcesMarkup();
      case 'environments': return environmentsMarkup();
      case 'jobs': return jobsMarkup();
      case 'audit': return auditMarkup();
      default: return servicesMarkup();
    }
  }

  function markup() {
    if (state.status === 'forbidden') return emptyMarkup('lock', 'System health is for administrators', 'Ask an administrator for access.');
    if (state.status === 'idle' || state.status === 'loading') {
      return `<div aria-busy="true">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(4)}<span class="sr-only">Checking system health</span></div>`;
    }
    if (state.status === 'error') {
      return `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">System health couldn’t be checked.</p><p class="atlas-alert__body">Nothing was changed. Try again in a moment.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-system-refresh>Try again</button></div></div>`;
    }
    const incidents = Number(state.workspace?.summary?.open_incidents || 0);
    return `${summaryMarkup()}
      <div class="sys-toolbar"><nav class="atlas-tabs" aria-label="System health sections">${TABS.map(([key, text]) => `<button type="button" role="tab" aria-selected="${state.tab === key}" data-system-tab="${key}">${text}${key === 'incidents' && incidents ? ` <span class="count">${incidents}</span>` : ''}</button>`).join('')}</nav>
      <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm${state.refreshing ? ' is-loading' : ''}" data-system-refresh${state.refreshing ? ' aria-busy="true" disabled' : ''}>${icon('refresh-cw')}Check now</button></div>
      ${state.refreshError ? '<p class="sys-note sys-warn" role="alert">The last check didn’t complete; these are the previous results.</p>' : ''}
      <div class="sys-body" role="tabpanel">${tabBody()}</div>
      <p class="sys-foot">View only. Nothing on this page changes the app or its data.</p>`;
  }

  function render() {
    if (!state.host || !state.host.isConnected) return;
    state.host.innerHTML = markup();
    window.lucide?.createIcons?.();
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !state.host?.contains(target)) return;
    const tab = target.closest('[data-system-tab]');
    if (tab) {
      state.tab = TABS.some(([key]) => key === tab.dataset.systemTab) ? tab.dataset.systemTab : 'services';
      render();
      state.host.querySelector(`[data-system-tab="${state.tab}"]`)?.focus();
      return;
    }
    if (target.closest('[data-system-refresh]')) { state.refreshError = false; load(true); return; }
    const source = target.closest('[data-system-source-filter]');
    if (source) { state.sourceFilter = source.dataset.systemSourceFilter || 'all'; render(); return; }
    const audit = target.closest('[data-system-audit-filter]');
    if (audit) { state.auditFilter = audit.dataset.systemAuditFilter || 'all'; render(); }
  }

  function mount(host, options = {}) {
    state.host = host || null;
    if (options.tab && TABS.some(([key]) => key === options.tab)) state.tab = options.tab;
    if (!state.bound) {
      state.bound = true;
      document.addEventListener('click', onClick);
    }
    render();
    load();
  }

  window.AtlasSystem = {
    mount,
    open: (tab) => {
      if (tab && TABS.some(([key]) => key === tab)) state.tab = tab;
      window.AtlasShell?.navigate?.('#settings/system');
    },
    refresh: () => load(true),
    snapshot: () => state.workspace,
    tab: () => state.tab
  };
})();
