(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const TAB_ORDER = [
    'overview', 'environments', 'integrations', 'sources',
    'jobs', 'incidents', 'security', 'audit'
  ];

  const TAB_LABELS = {
    overview: 'Overview',
    environments: 'Environments',
    integrations: 'Integrations',
    sources: 'Data sources',
    jobs: 'Jobs',
    incidents: 'Incidents',
    security: 'Security',
    audit: 'Audit & recovery'
  };

  const STATUS_LABELS = {
    healthy: 'Healthy',
    connected: 'Connected',
    ready: 'Ready',
    current: 'Current',
    degraded: 'Degraded',
    down: 'Down',
    outage: 'Outage',
    limited: 'Limited',
    partial: 'Partially complete',
    stale: 'Stale',
    no_records: 'No records',
    not_connected: 'Not connected',
    waiting_for_authorization: 'Waiting for authorization',
    waiting_authorization: 'Waiting for authorization',
    authorization_required: 'Authorization required',
    pending_review: 'Pending review',
    missing_publishing_permission: 'Missing publishing permission',
    missing_analytics_permission: 'Missing analytics permission',
    missing_permission: 'Missing permission',
    connection_expired: 'Connection expired',
    expired: 'Expired',
    disabled_by_policy: 'Disabled by policy',
    historical: 'Historical evidence',
    blocked: 'Blocked',
    unknown: 'Unknown',
    running: 'Running',
    waiting: 'Waiting',
    failed: 'Failed',
    idle: 'Idle',
    open: 'Open',
    monitoring: 'Monitoring',
    resolved: 'Resolved',
    dismissed: 'Dismissed',
    critical: 'Critical',
    warning: 'Warning',
    info: 'Information',
    preview_only: 'Preview only',
    disabled: 'Disabled'
  };

  const state = {
    workspace: null,
    staff: null,
    policy: null,
    activeTab: 'overview',
    loading: false,
    refreshing: false,
    error: null,
    message: null,
    initialized: false,
    activating: false,
    viewObserver: null,
    authTimer: null,
    sourceFilter: 'all',
    integrationFilter: 'all',
    auditFilter: 'all'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function statusLabel(value) {
    return STATUS_LABELS[value] || humanize(value || 'unknown');
  }

  function statusTone(value) {
    if (['healthy', 'connected', 'ready', 'current', 'resolved'].includes(value)) return 'good';
    if (['degraded', 'partial', 'stale', 'warning', 'monitoring', 'waiting', 'pending_review', 'waiting_for_authorization', 'waiting_authorization', 'authorization_required', 'no_records'].includes(value)) return 'warn';
    if (['down', 'outage', 'critical', 'failed', 'open', 'blocked'].includes(value)) return 'bad';
    if (['not_connected', 'disabled_by_policy', 'historical', 'unknown', 'idle', 'dismissed'].includes(value)) return 'neutral';
    return 'neutral';
  }

  function statusPill(value, label) {
    return `<span class="system-status is-${statusTone(value)}"><i></i>${escapeHtml(label || statusLabel(value))}</span>`;
  }

  function iconForStatus(value) {
    if (['healthy', 'connected', 'ready', 'current', 'resolved'].includes(value)) return 'circle-check-big';
    if (['degraded', 'partial', 'stale', 'warning', 'monitoring', 'waiting', 'pending_review', 'no_records'].includes(value)) return 'triangle-alert';
    if (['down', 'outage', 'critical', 'failed', 'open', 'blocked'].includes(value)) return 'circle-x';
    if (value === 'historical') return 'history';
    if (value === 'disabled_by_policy') return 'shield-ban';
    if (value === 'not_connected') return 'unplug';
    return 'circle-help';
  }

  function formatNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString('en-GB') : '—';
  }

  function formatDateTime(value, fallback = 'Not recorded') {
    if (!value || String(value).startsWith('1970-01-01')) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  function compactDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function relativeTime(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const difference = Date.now() - date.getTime();
    const absolute = Math.abs(difference);
    const future = difference < 0;
    const units = [
      ['day', 86400000],
      ['hour', 3600000],
      ['minute', 60000]
    ];
    for (const [unit, duration] of units) {
      if (absolute >= duration) {
        const count = Math.round(absolute / duration);
        return future ? `in ${count} ${unit}${count === 1 ? '' : 's'}` : `${count} ${unit}${count === 1 ? '' : 's'} ago`;
      }
    }
    return 'just now';
  }

  function truncate(value, length = 140) {
    const text = String(value || '').trim();
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  function endpoint() {
    return String(cfg.SYSTEM_API || '').trim();
  }

  function host() {
    return document.getElementById('system-view');
  }

  function systemVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action = 'snapshot') {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('System API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open System.');

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
      if (!response.ok) {
        const error = new Error(payload.error || `System request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('System health checks took too long. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function services() {
    return Array.isArray(state.workspace?.services) ? state.workspace.services : [];
  }

  function integrations() {
    return Array.isArray(state.workspace?.integrations) ? state.workspace.integrations : [];
  }

  function sources() {
    return Array.isArray(state.workspace?.data_sources) ? state.workspace.data_sources : [];
  }

  function jobs() {
    return Array.isArray(state.workspace?.jobs) ? state.workspace.jobs : [];
  }

  function incidents() {
    return Array.isArray(state.workspace?.incidents) ? state.workspace.incidents : [];
  }

  function releases() {
    return Array.isArray(state.workspace?.releases) ? state.workspace.releases : [];
  }

  function auditEvents() {
    return Array.isArray(state.workspace?.audit) ? state.workspace.audit : [];
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="system-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    if (state.message) return `<div class="system-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    return '';
  }

  function tabsMarkup() {
    const incidentCount = Number(state.workspace?.summary?.open_incidents || 0);
    return `<nav class="system-tabs" aria-label="System sections">${TAB_ORDER.map((tab) => `<button type="button" data-system-tab="${tab}" class="${state.activeTab === tab ? 'is-active' : ''}"><span>${escapeHtml(TAB_LABELS[tab])}</span>${tab === 'incidents' && incidentCount ? `<em>${incidentCount}</em>` : ''}</button>`).join('')}</nav>`;
  }

  function loadingMarkup() {
    return `<section class="system-shell system-loading">
      <div class="system-loading-icon"><i data-lucide="server-cog"></i></div>
      <h2>Checking Atlas System</h2>
      <p>Reading service health, deployment state, integrations, data sources, incidents and security safeguards.</p>
      <div class="system-loading-grid">${Array.from({ length: 4 }, () => '<span></span>').join('')}</div>
    </section>`;
  }

  function errorMarkup() {
    return `<section class="system-shell system-loading">
      <div class="system-loading-icon is-error"><i data-lucide="server-off"></i></div>
      <h2>System unavailable</h2>
      <p>${escapeHtml(state.error || 'The System health snapshot could not load.')}</p>
      <button type="button" class="system-primary" data-system-refresh><i data-lucide="refresh-cw"></i>Try again</button>
    </section>`;
  }

  function summaryCardsMarkup() {
    const summary = state.workspace?.summary || {};
    const cards = [
      ['server', 'Healthy services', summary.healthy_services, `${summary.degraded_services || 0} degraded or down`],
      ['siren', 'Open incidents', summary.open_incidents, `${summary.release_blockers || 0} release blocker${Number(summary.release_blockers || 0) === 1 ? '' : 's'}`],
      ['plug-zap', 'Connected integrations', summary.connected_integrations, `${summary.unconnected_integrations || 0} not fully connected`],
      ['database-zap', 'Trusted live sources', summary.trusted_live_sources, `${summary.blocked_sources || 0} blocked or unconnected`]
    ];
    return `<section class="system-summary-grid">${cards.map(([icon, label, value, note]) => `<article><span><i data-lucide="${icon}"></i>${label}</span><strong>${formatNumber(value)}</strong><small>${escapeHtml(note)}</small></article>`).join('')}</section>`;
  }

  function serviceCard(service) {
    return `<article class="system-service-card is-${statusTone(service.status)}">
      <header><span class="system-card-icon"><i data-lucide="${iconForStatus(service.status)}"></i></span><div><small>${escapeHtml(humanize(service.category))} · ${escapeHtml(humanize(service.environment))}</small><h3>${escapeHtml(service.label)}</h3></div>${statusPill(service.status)}</header>
      <dl>
        <div><dt>Check</dt><dd>${escapeHtml(humanize(service.check_strategy))}</dd></div>
        <div><dt>Last checked</dt><dd>${escapeHtml(relativeTime(service.last_checked_at))}</dd></div>
        ${service.version_label ? `<div><dt>Version</dt><dd>${escapeHtml(service.version_label)}</dd></div>` : ''}
        ${service.failure_code ? `<div><dt>Error code</dt><dd><code>${escapeHtml(service.failure_code)}</code></dd></div>` : ''}
      </dl>
      ${service.failure_message ? `<p class="system-card-warning">${escapeHtml(service.failure_message)}</p>` : ''}
      <footer><span>Production: ${escapeHtml(statusLabel(service.production_impact))}</span><span>Preview: ${escapeHtml(statusLabel(service.preview_impact))}</span></footer>
    </article>`;
  }

  function incidentCard(incident, compact = false) {
    return `<article class="system-incident-card is-${statusTone(incident.severity)} ${compact ? 'is-compact' : ''}">
      <header><span class="system-card-icon"><i data-lucide="${incident.severity === 'critical' ? 'siren' : 'triangle-alert'}"></i></span><div><small>${escapeHtml(statusLabel(incident.severity))} · ${escapeHtml(statusLabel(incident.status))}</small><h3>${escapeHtml(incident.title)}</h3></div>${statusPill(incident.status)}</header>
      <p>${escapeHtml(incident.summary)}</p>
      <dl>
        <div><dt>Production impact</dt><dd>${escapeHtml(statusLabel(incident.production_impact))}</dd></div>
        <div><dt>Preview impact</dt><dd>${escapeHtml(statusLabel(incident.preview_impact))}</dd></div>
        <div><dt>Occurrences</dt><dd>${formatNumber(incident.occurrence_count)}</dd></div>
        <div><dt>Last seen</dt><dd>${escapeHtml(formatDateTime(incident.last_occurred_at))}</dd></div>
      </dl>
      ${incident.resolution_note ? `<div class="system-resolution"><strong>Resolution</strong><span>${escapeHtml(incident.resolution_note)}</span></div>` : ''}
      ${incident.metadata?.release_blocker ? '<footer><span class="system-release-blocker"><i data-lucide="shield-alert"></i>Release blocker</span></footer>' : ''}
    </article>`;
  }

  function releaseCard(release) {
    const blockers = Array.isArray(release.release_blockers) ? release.release_blockers : [];
    const sha = String(release.commit_sha || '').slice(0, 10);
    return `<article class="system-release-card is-${statusTone(release.status)}">
      <header><div><small>${escapeHtml(humanize(release.environment))} environment</small><h3>${escapeHtml(release.label)}</h3></div>${statusPill(release.status)}</header>
      <dl>
        <div><dt>Repository</dt><dd>${escapeHtml(release.repository || 'Not recorded')}</dd></div>
        <div><dt>Branch</dt><dd><code>${escapeHtml(release.branch || 'Not recorded')}</code></dd></div>
        <div><dt>Commit</dt><dd><code>${escapeHtml(sha || 'Not verified')}</code>${release.commit_date ? `<small>${escapeHtml(compactDate(release.commit_date))}</small>` : ''}</dd></div>
        <div><dt>Pull request</dt><dd>${release.pull_request_number ? `#${formatNumber(release.pull_request_number)}` : 'Not recorded'}</dd></div>
        <div><dt>Migrations</dt><dd>${escapeHtml(release.migration_status || 'Unknown')}</dd></div>
        <div><dt>Functions</dt><dd>${escapeHtml(release.functions_status || 'Unknown')}</dd></div>
        <div><dt>Production sync</dt><dd>${statusPill(release.production_sync_state)}</dd></div>
      </dl>
      ${release.deployment_url ? `<a href="${escapeHtml(release.deployment_url)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i>Open deployment</a>` : ''}
      ${blockers.length ? `<section class="system-blocker-list"><strong>Release blockers</strong>${blockers.map((blocker) => `<div><i data-lucide="shield-alert"></i><span><b>${escapeHtml(blocker.label || blocker.key)}</b><small>${escapeHtml(blocker.preview_impact || '')} · Production: ${escapeHtml(blocker.production_impact || 'none')}</small></span></div>`).join('')}</section>` : '<div class="system-no-blockers"><i data-lucide="shield-check"></i>No release blockers recorded.</div>'}
    </article>`;
  }

  function overviewMarkup() {
    const summary = state.workspace?.summary || {};
    const openIncidents = incidents().filter((incident) => ['open', 'monitoring'].includes(incident.status));
    const mainRelease = releases()[0];
    const primaryServices = services().filter((service) => ['web-app', 'production-auth', 'private-database', 'private-storage', 'edge-functions', 'reports-service'].includes(service.service_key));
    return `<div class="system-overview">
      ${summaryCardsMarkup()}
      <section class="system-section-head"><div><span>Runtime health</span><h2>Core services</h2><p>Verified services and explicitly recorded degraded modules.</p></div><button type="button" data-system-tab-jump="environments">View environments<i data-lucide="arrow-right"></i></button></section>
      <div class="system-service-grid">${primaryServices.map(serviceCard).join('')}</div>
      <div class="system-overview-split">
        <section class="system-panel">
          <header><div><span>Release gate</span><h2>${summary.release_blockers ? 'Preview has release blockers' : 'Preview ready for review'}</h2></div>${statusPill(summary.overall_status)}</header>
          ${mainRelease ? releaseCard(mainRelease) : '<div class="system-empty"><i data-lucide="git-branch"></i>No release checkpoint is available.</div>'}
        </section>
        <section class="system-panel">
          <header><div><span>Incident centre</span><h2>Open incidents</h2></div><button type="button" data-system-tab-jump="incidents">View all</button></header>
          <div class="system-incident-list">${openIncidents.length ? openIncidents.slice(0, 3).map((incident) => incidentCard(incident, true)).join('') : '<div class="system-empty is-good"><i data-lucide="circle-check-big"></i>No open incidents.</div>'}</div>
        </section>
      </div>
      <section class="system-trust-contract"><i data-lucide="shield-check"></i><div><strong>Checkpoint I trust contract</strong><span>View only · No retries · No incident mutation · No rollback · No production promotion · No secrets or access tokens returned</span></div></section>
    </div>`;
  }

  function environmentsMarkup() {
    const recovery = state.workspace?.recovery || {};
    return `<div class="system-environments">
      <section class="system-section-head"><div><span>Deployment boundaries</span><h2>Environments & releases</h2><p>Preview and production remain deliberately separated.</p></div></section>
      <div class="system-release-grid">${releases().length ? releases().map(releaseCard).join('') : '<div class="system-empty"><i data-lucide="git-branch"></i>No release checkpoints recorded.</div>'}</div>
      <section class="system-safeguards-grid">
        <article><i data-lucide="shield-ban"></i><div><strong>Production synchronization</strong><span>${recovery.production_sync_enabled ? 'Enabled' : 'Disabled'}</span><small>Preview features do not automatically change production source records.</small></div></article>
        <article><i data-lucide="rotate-ccw"></i><div><strong>Rollback actions</strong><span>${recovery.rollback_actions_enabled ? 'Enabled' : 'View only'}</span><small>System displays recovery references but cannot execute rollback.</small></div></article>
        <article><i data-lucide="database-backup"></i><div><strong>Backup verification</strong><span>${escapeHtml(statusLabel(recovery.backup_status))}</span><small>Atlas does not claim a backup is healthy without runtime verification.</small></div></article>
        <article><i data-lucide="refresh-cw-off"></i><div><strong>Automatic retries</strong><span>${recovery.automatic_retries_enabled ? 'Enabled' : 'Disabled'}</span><small>Failed work is visible, but Checkpoint I cannot retry it.</small></div></article>
      </section>
      <section class="system-panel system-recovery-references">
        <header><div><span>Recovery reference</span><h2>Last known checkpoint</h2></div></header>
        <dl>
          <div><dt>Last known healthy</dt><dd><code>${escapeHtml(recovery.last_known_healthy_reference || 'Not recorded')}</code></dd></div>
          <div><dt>Rollback reference</dt><dd><code>${escapeHtml(recovery.rollback_reference || 'Not recorded')}</code></dd></div>
          <div><dt>Mode</dt><dd>${statusPill(recovery.mode || 'view_only', 'View only')}</dd></div>
        </dl>
      </section>
    </div>`;
  }

  function capabilitySummary(value) {
    if (!value || typeof value !== 'object') return 'No capabilities recorded';
    const entries = Object.entries(value).slice(0, 4);
    return entries.map(([key, item]) => `${humanize(key)}: ${typeof item === 'boolean' ? (item ? 'Yes' : 'No') : humanize(item)}`).join(' · ');
  }

  function integrationMarkup(integration) {
    const displayStatus = integration.display_status || integration.status;
    return `<article class="system-integration-card is-${statusTone(displayStatus)}">
      <header><span class="system-card-icon"><i data-lucide="${displayStatus === 'connected' ? 'plug-zap' : displayStatus === 'disabled_by_policy' ? 'shield-ban' : 'unplug'}"></i></span><div><small>${escapeHtml(humanize(integration.category))}</small><h3>${escapeHtml(integration.label)}</h3></div>${statusPill(displayStatus)}</header>
      <p>${escapeHtml(truncate(capabilitySummary(integration.capabilities), 220))}</p>
      <dl>
        <div><dt>Authorization</dt><dd>${escapeHtml(statusLabel(integration.authorization_state))}</dd></div>
        <div><dt>Publishing</dt><dd>${escapeHtml(statusLabel(integration.publishing_permission_state))}</dd></div>
        <div><dt>Analytics</dt><dd>${escapeHtml(statusLabel(integration.analytics_permission_state))}</dd></div>
        <div><dt>Last verified</dt><dd>${escapeHtml(formatDateTime(integration.last_verified_at, 'Never verified'))}</dd></div>
      </dl>
      ${integration.last_connection_error ? `<p class="system-card-warning">${escapeHtml(integration.last_connection_error)}</p>` : ''}
      ${integration.external_account_label ? `<footer><span>Account</span><b>${escapeHtml(integration.external_account_label)}</b></footer>` : ''}
    </article>`;
  }

  function integrationsMarkup() {
    const categories = ['all', ...new Set(integrations().map((entry) => entry.category).filter(Boolean))];
    const visible = state.integrationFilter === 'all'
      ? integrations()
      : integrations().filter((entry) => entry.category === state.integrationFilter);
    return `<div class="system-integrations">
      <section class="system-section-head"><div><span>Connection registry</span><h2>Integrations</h2><p>Atlas reports only verified runtime connection states. Assistant connectors do not automatically count as Atlas application connections.</p></div></section>
      <div class="system-filter-row">${categories.map((category) => `<button type="button" data-system-integration-filter="${escapeHtml(category)}" class="${state.integrationFilter === category ? 'is-active' : ''}">${escapeHtml(category === 'all' ? 'All' : humanize(category))}</button>`).join('')}</div>
      <div class="system-integration-grid">${visible.length ? visible.map(integrationMarkup).join('') : '<div class="system-empty"><i data-lucide="unplug"></i>No integrations match this filter.</div>'}</div>
    </div>`;
  }

  function sourceMarkup(source) {
    const effectiveStatus = source.status || source.freshness_state;
    return `<article class="system-source-row is-${statusTone(effectiveStatus)}">
      <span class="system-source-icon"><i data-lucide="${source.is_historical ? 'archive' : source.is_live ? 'database-zap' : 'database'}"></i></span>
      <div class="system-source-name"><small>${escapeHtml(humanize(source.domain))}</small><strong>${escapeHtml(source.label)}</strong><span>${escapeHtml(humanize(source.source_type))} · ${escapeHtml(humanize(source.source_scope || 'unknown scope'))}</span></div>
      <div><small>Records</small><strong>${formatNumber(source.record_count)}</strong></div>
      <div><small>Freshness</small><strong>${escapeHtml(statusLabel(source.freshness_state))}</strong><span>${escapeHtml(relativeTime(source.last_successful_at))}</span></div>
      <div class="system-source-trust"><small>Atlas Brain</small>${source.trusted_for_brain ? '<span class="is-trusted"><i data-lucide="shield-check"></i>Trusted</span>' : '<span><i data-lucide="shield-question"></i>Not trusted</span>'}</div>
      <div>${statusPill(effectiveStatus)}</div>
      ${source.error_message ? `<p class="system-source-error"><code>${escapeHtml(source.error_code || 'SOURCE')}</code>${escapeHtml(source.error_message)}</p>` : ''}
    </article>`;
  }

  function sourcesMarkup() {
    const filters = [
      ['all', 'All sources'],
      ['live', 'Live'],
      ['historical', 'Historical'],
      ['trusted', 'Trusted for Brain'],
      ['blocked', 'Blocked / missing']
    ];
    const visible = sources().filter((source) => {
      if (state.sourceFilter === 'all') return true;
      if (state.sourceFilter === 'live') return source.is_live;
      if (state.sourceFilter === 'historical') return source.is_historical;
      if (state.sourceFilter === 'trusted') return source.trusted_for_brain;
      if (state.sourceFilter === 'blocked') return ['not_connected', 'blocked', 'stale', 'partial'].includes(source.status);
      return true;
    });
    return `<div class="system-sources">
      <section class="system-section-head"><div><span>Evidence registry</span><h2>Data sources & freshness</h2><p>Live operational data, private imports and historical snapshots remain visibly distinct.</p></div></section>
      <div class="system-filter-row">${filters.map(([key, label]) => `<button type="button" data-system-source-filter="${key}" class="${state.sourceFilter === key ? 'is-active' : ''}">${label}</button>`).join('')}</div>
      <section class="system-source-table">${visible.length ? visible.map(sourceMarkup).join('') : '<div class="system-empty"><i data-lucide="database-off"></i>No data sources match this filter.</div>'}</section>
      <section class="system-source-guard"><i data-lucide="brain-circuit"></i><div><strong>Atlas Brain evidence gate</strong><span>Historical evidence, pending Sprint 3 rows, disconnected sales and missing bookings never become live operational facts automatically.</span></div></section>
    </div>`;
  }

  function jobMarkup(job) {
    return `<article class="system-job-row is-${statusTone(job.status)}">
      <span class="system-job-icon"><i data-lucide="${job.status === 'running' ? 'loader-circle' : job.status === 'failed' ? 'circle-x' : job.is_automatic ? 'timer-reset' : 'list-todo'}"></i></span>
      <div><small>${escapeHtml(humanize(job.category))}</small><strong>${escapeHtml(job.label)}</strong><span>${escapeHtml(job.schedule_description || 'No schedule recorded')}</span></div>
      <div><small>Write scope</small><strong>${escapeHtml(humanize(job.write_scope))}</strong><span>${job.is_automatic ? 'Automatic' : 'Manager initiated'}</span></div>
      <div><small>Last success</small><strong>${escapeHtml(relativeTime(job.last_succeeded_at))}</strong><span>${escapeHtml(compactDate(job.last_succeeded_at))}</span></div>
      <div>${statusPill(job.status)}${job.retry_enabled ? '<small>Retry available</small>' : '<small>Retry disabled</small>'}</div>
      ${job.last_error_message ? `<p class="system-job-error"><code>${escapeHtml(job.last_error_code || 'JOB_FAILED')}</code>${escapeHtml(job.last_error_message)}</p>` : ''}
    </article>`;
  }

  function jobsMarkup() {
    const failed = jobs().filter((job) => job.status === 'failed').length;
    const waiting = jobs().filter((job) => job.status === 'waiting').length;
    return `<div class="system-jobs">
      <section class="system-section-head"><div><span>Operational work</span><h2>Jobs & synchronization</h2><p>Background work is visible, but Checkpoint I cannot retry or mutate jobs.</p></div><div class="system-head-counts"><span>${failed} failed</span><span>${waiting} waiting</span></div></section>
      <section class="system-jobs-table">${jobs().length ? jobs().map(jobMarkup).join('') : '<div class="system-empty"><i data-lucide="list-todo"></i>No jobs are registered.</div>'}</section>
      <section class="system-disabled-action"><i data-lucide="shield-ban"></i><div><strong>Retry controls are disabled</strong><span>Future controlled retry actions require idempotency, role checks, confirmation and audit evidence.</span></div><button type="button" disabled>Retry failed jobs</button></section>
    </div>`;
  }

  function incidentsMarkup() {
    return `<div class="system-incidents">
      <section class="system-section-head"><div><span>Error centre</span><h2>Incidents</h2><p>Open, monitoring and resolved system issues with honest production and preview impact.</p></div></section>
      <div class="system-incident-grid">${incidents().length ? incidents().map((incident) => incidentCard(incident)).join('') : '<div class="system-empty is-good"><i data-lucide="circle-check-big"></i>No incidents have been recorded.</div>'}</div>
      <section class="system-disabled-action"><i data-lucide="lock-keyhole"></i><div><strong>Incident mutation is disabled</strong><span>Checkpoint I cannot dismiss, resolve or rewrite incident history.</span></div><button type="button" disabled>Resolve incident</button></section>
    </div>`;
  }

  function securityMetric(icon, label, value, note, tone = 'good') {
    return `<article class="is-${tone}"><i data-lucide="${icon}"></i><div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note)}</small></div></article>`;
  }

  function securityMarkup() {
    const security = state.workspace?.security || {};
    const profile = security.profiles || {};
    const schema = security.private_schema || {};
    const roleEntries = Object.entries(profile.roles || {});
    const rlsTone = Number(schema.rls_missing || 0) === 0 ? 'good' : 'bad';
    const grantsTone = Number(security.unexpected_table_grants || 0) === 0 && Number(security.unexpected_atlas_function_grants || 0) === 0 ? 'good' : 'bad';
    return `<div class="system-security">
      <section class="system-section-head"><div><span>Access & protection</span><h2>Security posture</h2><p>Manager-visible counts and safeguards. Passwords, API keys, tokens and raw credentials are never returned.</p></div></section>
      <section class="system-security-grid">
        ${securityMetric('users-round', 'Active profiles', formatNumber(profile.active), `${formatNumber(profile.inactive)} inactive · ${formatNumber(profile.active_managers)} active managers`, 'good')}
        ${securityMetric('shield-check', 'Private RLS coverage', `${formatNumber(schema.rls_enabled)}/${formatNumber(schema.tables)}`, `${formatNumber(schema.rls_missing)} private tables missing RLS`, rlsTone)}
        ${securityMetric('key-round', 'Unexpected grants', formatNumber(Number(security.unexpected_table_grants || 0) + Number(security.unexpected_atlas_function_grants || 0)), 'anon, authenticated or PUBLIC grants against private surfaces', grantsTone)}
        ${securityMetric('archive-restore', 'Private storage buckets', formatNumber(security.private_storage_buckets), security.profile_photo_bucket_private ? 'Profile photo bucket verified private' : 'Profile photo bucket not verified private', security.profile_photo_bucket_private ? 'good' : 'bad')}
        ${securityMetric('user-cog', 'Recent access changes', formatNumber(security.recent_access_changes), 'Role or active-status changes in the last 30 days', 'neutral')}
        ${securityMetric('terminal-square', 'Browser service role', security.browser_service_role_exposed ? 'Exposed' : 'Not exposed', 'Privileged server credentials must never reach the browser', security.browser_service_role_exposed ? 'bad' : 'good')}
      </section>
      <section class="system-panel system-role-distribution">
        <header><div><span>Role distribution</span><h2>Atlas profiles</h2></div></header>
        <div>${roleEntries.length ? roleEntries.map(([role, count]) => `<article><span>${escapeHtml(humanize(role))}</span><strong>${formatNumber(count)}</strong></article>`).join('') : '<div class="system-empty">No role distribution available.</div>'}</div>
      </section>
      <section class="system-security-contract">
        <div><i data-lucide="eye-off"></i><strong>Secrets hidden</strong><span>${security.secrets_visible_in_ui ? 'Attention required' : 'Verified by System policy'}</span></div>
        <div><i data-lucide="shield-ban"></i><strong>Destructive actions</strong><span>${security.destructive_actions_enabled ? 'Enabled' : 'Disabled'}</span></div>
        <div><i data-lucide="database-lock"></i><strong>Source mutation</strong><span>Disabled in System</span></div>
      </section>
    </div>`;
  }

  function eventIcon(domain) {
    return ({
      system: 'server-cog', shifts: 'calendar-days', knowledge: 'book-open-check',
      marketing: 'megaphone', profiles: 'user-cog', operations: 'gauge',
      reports: 'chart-no-axes-combined', messages: 'messages-square', scanner: 'scan-barcode', brain: 'brain-circuit'
    })[domain] || 'activity';
  }

  function auditMarkup() {
    const domains = ['all', ...new Set(auditEvents().map((entry) => entry.domain).filter(Boolean))];
    const visible = state.auditFilter === 'all' ? auditEvents() : auditEvents().filter((entry) => entry.domain === state.auditFilter);
    const recovery = state.workspace?.recovery || {};
    return `<div class="system-audit">
      <section class="system-section-head"><div><span>Immutable evidence</span><h2>Audit & recovery</h2><p>Major Atlas events across schedules, Knowledge, Marketing, profiles, Operations, Reports, Team, scanner and Brain.</p></div></section>
      <div class="system-filter-row">${domains.map((domain) => `<button type="button" data-system-audit-filter="${escapeHtml(domain)}" class="${state.auditFilter === domain ? 'is-active' : ''}">${escapeHtml(domain === 'all' ? 'All domains' : humanize(domain))}</button>`).join('')}</div>
      <div class="system-audit-layout">
        <section class="system-audit-timeline">${visible.length ? visible.slice(0, 120).map((event) => `<article><span><i data-lucide="${eventIcon(event.domain)}"></i></span><div><small>${escapeHtml(humanize(event.domain))} · ${escapeHtml(formatDateTime(event.created_at))}</small><strong>${escapeHtml(humanize(event.event_type))}</strong><p>${event.actor_label ? `By ${escapeHtml(event.actor_label)}` : 'System-generated event'}${event.entity_key ? ` · ${escapeHtml(truncate(event.entity_key, 70))}` : ''}</p></div></article>`).join('') : '<div class="system-empty"><i data-lucide="activity"></i>No audit events match this filter.</div>'}</section>
        <aside class="system-recovery-card">
          <span>Recovery safeguards</span><h2>View only</h2><dl>
            <div><dt>Last healthy</dt><dd><code>${escapeHtml(recovery.last_known_healthy_reference || 'Not recorded')}</code></dd></div>
            <div><dt>Rollback reference</dt><dd><code>${escapeHtml(recovery.rollback_reference || 'Not recorded')}</code></dd></div>
            <div><dt>Backup status</dt><dd>${escapeHtml(statusLabel(recovery.backup_status))}</dd></div>
            <div><dt>Production sync</dt><dd>${recovery.production_sync_enabled ? 'Enabled' : 'Disabled'}</dd></div>
          </dl><button type="button" disabled><i data-lucide="rotate-ccw"></i>Rollback unavailable</button><small>Recovery references are informational until explicit safeguards and confirmations are implemented.</small>
        </aside>
      </div>
    </div>`;
  }

  function activeBodyMarkup() {
    if (state.activeTab === 'overview') return overviewMarkup();
    if (state.activeTab === 'environments') return environmentsMarkup();
    if (state.activeTab === 'integrations') return integrationsMarkup();
    if (state.activeTab === 'sources') return sourcesMarkup();
    if (state.activeTab === 'jobs') return jobsMarkup();
    if (state.activeTab === 'incidents') return incidentsMarkup();
    if (state.activeTab === 'security') return securityMarkup();
    if (state.activeTab === 'audit') return auditMarkup();
    return overviewMarkup();
  }

  function shellMarkup() {
    const summary = state.workspace?.summary || {};
    const overall = summary.overall_status || 'unknown';
    return `<section class="system-shell">
      <header class="system-hero is-${statusTone(overall)}">
        <div><span class="system-kicker"><i data-lucide="server-cog"></i>Checkpoint I · System control room</span><h1>Atlas System</h1><p>One view of application health, environments, integrations, data sources, jobs, incidents, security and recovery boundaries.</p></div>
        <aside><span>Overall status</span><strong>${escapeHtml(statusLabel(overall))}</strong><small>Checked ${escapeHtml(formatDateTime(state.workspace?.generated_at))}</small><button type="button" data-system-refresh ${state.refreshing ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>${state.refreshing ? 'Checking…' : 'Refresh health'}</button></aside>
      </header>
      ${feedbackMarkup()}
      ${tabsMarkup()}
      <main class="system-main">${activeBodyMarkup()}</main>
      <footer class="system-footer"><i data-lucide="shield-check"></i><span>Manager only · View only · Preview isolated · Production synchronization disabled · Secrets and tokens never returned</span></footer>
    </section>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.remove('placeholder-view');
    if (state.loading && !state.workspace) element.innerHTML = loadingMarkup();
    else if (state.error && !state.workspace) element.innerHTML = errorMarkup();
    else element.innerHTML = shellMarkup();
    updateNavStatus();
    window.lucide?.createIcons?.();
  }

  function updateNavStatus() {
    const marker = document.querySelector('.nav-item[data-view="system"] .system-nav-status');
    if (!marker) return;
    const status = state.workspace?.summary?.overall_status || (state.error ? 'down' : 'unknown');
    marker.className = `system-nav-status is-${statusTone(status)}`;
    marker.title = `System: ${statusLabel(status)}`;
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || (!systemVisible() && !options.force)) return;
    state.loading = !state.workspace;
    state.refreshing = Boolean(state.workspace);
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot');
      state.workspace = payload.workspace || {};
      state.staff = payload.staff || null;
      state.policy = payload.policy || null;
      state.error = null;
      state.message = options.silent ? null : 'System health refreshed.';
    } catch (error) {
      if (error?.status === 403) {
        document.querySelector('.nav-item[data-view="system"]')?.setAttribute('hidden', '');
        hideSystem();
        window.setActiveView?.('home');
        return;
      }
      state.error = error instanceof Error ? error.message : 'System could not load.';
    } finally {
      state.loading = false;
      state.refreshing = false;
      render();
    }
  }

  function ensureStructure() {
    let navButton = document.querySelector('.nav-item[data-view="system"]');
    if (!navButton) {
      const groups = [...document.querySelectorAll('.nav-group')];
      let systemGroup = groups.find((group) => group.querySelector('.nav-label')?.textContent?.trim().toUpperCase() === 'SYSTEM');
      if (!systemGroup) {
        systemGroup = document.createElement('div');
        systemGroup.className = 'nav-group';
        systemGroup.innerHTML = '<div class="nav-label">SYSTEM</div>';
        document.querySelector('.atlas-nav')?.appendChild(systemGroup);
      }
      navButton = document.createElement('button');
      navButton.type = 'button';
      navButton.className = 'nav-item';
      navButton.dataset.view = 'system';
      navButton.innerHTML = '<i data-lucide="server-cog"></i>System<span class="system-nav-status is-neutral"></span>';
      const settingsButton = systemGroup.querySelector('.nav-item[data-view="settings"]');
      if (settingsButton) systemGroup.insertBefore(navButton, settingsButton);
      else systemGroup.appendChild(navButton);
      navButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateSystem();
      });
    }

    if (!host()) {
      const view = document.createElement('div');
      view.id = 'system-view';
      view.className = 'system-view';
      view.style.display = 'none';
      const parent = document.getElementById('settings-view')?.parentElement
        || document.getElementById('reports-view')?.parentElement
        || document.querySelector('.atlas-content main')
        || document.querySelector('.atlas-content');
      parent?.appendChild(view);
    }
    window.lucide?.createIcons?.();
  }

  function hideOtherViews() {
    document.querySelectorAll([
      '#inventory-view', '#dashboard-view', '#recipes-view', '#suppliers-view', '#imports-view',
      '#team-view', '#shifts-view', '#knowledge-view', '#reports-view', '#settings-view',
      '#operations-center', '#brain-shell', '#marketing-view', '#profiles-view', '#team-profiles-view'
    ].join(',')).forEach((view) => { if (view !== host()) view.style.display = 'none'; });
    ['home-intro', 'home-focus', 'home-metrics'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.style.display = 'none';
    });
  }

  function activateSystem() {
    ensureStructure();
    state.activating = true;
    hideOtherViews();
    const element = host();
    if (element) element.style.display = 'block';
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = 'System';
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === 'system'));
    document.getElementById('atlas-sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
    state.activating = false;
    render();
    if (!state.workspace && !state.loading) loadSnapshot({ force: true });
  }

  function hideSystem() {
    const element = host();
    if (element && element.style.display !== 'none') element.style.display = 'none';
  }

  function handleNavigationCapture(event) {
    const button = event.target instanceof Element ? event.target.closest('.nav-item[data-view]') : null;
    if (!button || button.dataset.view === 'system') return;
    hideSystem();
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    const tab = target.closest('[data-system-tab]');
    if (tab) {
      state.activeTab = TAB_ORDER.includes(tab.dataset.systemTab) ? tab.dataset.systemTab : 'overview';
      render();
      return;
    }
    const jump = target.closest('[data-system-tab-jump]');
    if (jump) {
      state.activeTab = TAB_ORDER.includes(jump.dataset.systemTabJump) ? jump.dataset.systemTabJump : 'overview';
      render();
      return;
    }
    if (target.closest('[data-system-refresh]')) {
      loadSnapshot({ force: true });
      return;
    }
    const sourceFilter = target.closest('[data-system-source-filter]');
    if (sourceFilter) {
      state.sourceFilter = sourceFilter.dataset.systemSourceFilter || 'all';
      render();
      return;
    }
    const integrationFilter = target.closest('[data-system-integration-filter]');
    if (integrationFilter) {
      state.integrationFilter = integrationFilter.dataset.systemIntegrationFilter || 'all';
      render();
      return;
    }
    const auditFilter = target.closest('[data-system-audit-filter]');
    if (auditFilter) {
      state.auditFilter = auditFilter.dataset.systemAuditFilter || 'all';
      render();
    }
  }

  function observeViewChanges() {
    const parent = host()?.parentElement;
    if (!parent) return;
    state.viewObserver?.disconnect();
    state.viewObserver = new MutationObserver(() => {
      if (state.activating || !systemVisible()) return;
      const anotherVisible = [...parent.children].some((child) => {
        if (child === host()) return false;
        const id = child.id || '';
        if (!id || ['home-intro', 'home-focus', 'home-metrics'].includes(id)) return false;
        return window.getComputedStyle(child).display !== 'none';
      });
      if (anotherVisible) hideSystem();
    });
    state.viewObserver.observe(parent, { subtree: false, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStructure();
    observeViewChanges();
    document.addEventListener('click', handleNavigationCapture, true);
    document.addEventListener('click', handleClick);
    window.addEventListener('focus', () => {
      if (systemVisible() && state.workspace && !state.loading) loadSnapshot({ force: true, silent: true });
    });
    window.addEventListener('online', () => {
      if (systemVisible()) loadSnapshot({ force: true });
    });
    window.addEventListener('pagehide', () => {
      state.viewObserver?.disconnect();
      if (state.authTimer) window.clearInterval(state.authTimer);
    }, { once: true });
  }

  window.AtlasSystem = {
    open: (tab = 'overview') => {
      state.activeTab = TAB_ORDER.includes(tab) ? tab : 'overview';
      activateSystem();
    },
    refresh: () => loadSnapshot({ force: true }),
    snapshot: () => state.workspace,
    tab: () => state.activeTab
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
