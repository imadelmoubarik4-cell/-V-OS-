(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const state = {
    workspace: null,
    loading: false,
    error: null,
    initialized: false,
    observer: null,
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
    const explicit = String(cfg.READ_SOURCES_API || '').trim();
    if (explicit) return explicit;
    const knowledge = String(cfg.KNOWLEDGE_API || '').trim();
    return knowledge.replace(/\/atlas-knowledge\/?$/, '/atlas-read-sources');
  }

  function root() {
    return document.getElementById('knowledge-view');
  }

  function host() {
    return root()?.querySelector('.knowledge-sources-page') || null;
  }

  function visible() {
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

  async function api() {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Read-only Source Center API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Source Center.');
    const url = new URL(apiUrl);
    url.searchParams.set('action', 'snapshot');
    url.searchParams.set('limit', '200');
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          'x-atlas-request-id': requestId
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload?.result?.error || payload?.error || `Source request failed (${response.status}).`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return payload?.result || payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Source Center took too long to respond. Try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function statusTone(value) {
    if (value === 'healthy' || value === 'current') return 'good';
    if (['degraded', 'expired', 'blocked', 'error'].includes(value)) return 'bad';
    return 'warn';
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function summaryMarkup() {
    const summary = state.workspace?.summary || {};
    const cards = [
      ['database', 'Private source batches', Number(summary.private_source_batches || 0), 'Preserved Real VÁ evidence'],
      ['list-checks', 'Unified review rows', Number(summary.unified_review_rows || 0), 'Review-first source graph'],
      ['circle-check-big', 'Current metadata', Number(summary.current_sources || 0), 'Fingerprint and completion evidence'],
      ['cloud-cog', 'External feeds healthy', Number(summary.external_connections_healthy || 0), 'OAuth feeds remain explicit']
    ];
    return `<div class="p22-source-summary">${cards.map(([icon, label, value, note]) => `<article><i data-lucide="${icon}"></i><div><span>${escapeHtml(label)}</span><strong>${value.toLocaleString('en-GB')}</strong><small>${escapeHtml(note)}</small></div></article>`).join('')}</div>`;
  }

  function connectionsMarkup() {
    const rows = Array.isArray(state.workspace?.connections) ? state.workspace.connections : [];
    return `<section class="p22-source-connections"><header><div><span>Canonical connection truth</span><h3>Read-only providers</h3></div></header><div>${rows.map((row) => `<article class="is-${statusTone(row.state)}"><div><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.connection_key)} · ${escapeHtml(humanize(row.provider_type))}</small></div><span>${escapeHtml(humanize(row.state))}</span><p>${row.state === 'healthy' ? `Verified ${escapeHtml(formatDate(row.last_succeeded_at))}` : row.state === 'not_configured' ? 'No Atlas-owned authorization is configured.' : row.state === 'authorization_required' ? 'Authorization is required before any read.' : 'Verification evidence is still required.'}</p></article>`).join('') || '<p>No read-only providers registered.</p>'}</div></section>`;
  }

  function sourceRowsMarkup() {
    const rows = Array.isArray(state.workspace?.local_sources) ? state.workspace.local_sources : [];
    return `<section class="p22-source-index"><header><div><span>Metadata-only source index</span><h3>Preserved Real VÁ documents</h3></div><strong>${rows.length.toLocaleString('en-GB')} shown</strong></header><div class="p22-source-table"><div class="p22-source-row is-heading"><span>Source</span><span>Scope</span><span>Review stage</span><span>Freshness</span></div>${rows.map((row) => `<article class="p22-source-row"><div><strong>${escapeHtml(row.source_label || row.source_key)}</strong><small>${escapeHtml(row.file_extension ? String(row.file_extension).toUpperCase() : 'Source')} · ${escapeHtml(formatDate(row.last_modified_at))}</small></div><span>${escapeHtml(humanize(row.source_type))}</span><span>${escapeHtml(humanize(row.current_stage))} · ${Number(row.progress_percent || 0)}%</span><span class="is-${statusTone(row.freshness_state)}">${escapeHtml(humanize(row.freshness_state))}</span></article>`).join('') || '<div class="p22-source-empty">No private source metadata is available.</div>'}</div></section>`;
  }

  function errorMarkup() {
    return `<section class="p22-source-center is-error"><div><i data-lucide="database-zap"></i><span><strong>Read-only Source Center unavailable</strong><small>${escapeHtml(state.error || 'The source snapshot could not load.')}</small></span></div><button type="button" data-p22-source-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function loadingMarkup() {
    return `<section class="p22-source-center is-loading"><i data-lucide="loader-circle"></i><div><strong>Loading source evidence</strong><small>Checking metadata, freshness and canonical connection state.</small></div></section>`;
  }

  function workspaceMarkup() {
    return `<section class="p22-source-center" data-p22-source-center>
      <header class="p22-source-hero"><div><span><i data-lucide="database-zap"></i>Phase 2.2 · Read-only sources</span><h2>Source Center</h2><p>Trusted metadata and freshness evidence without returning source bodies, private URLs or credentials.</p></div><button type="button" data-p22-source-refresh ${state.loading ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>Refresh evidence</button></header>
      <div class="p22-source-trust"><i data-lucide="shield-check"></i><div><strong>Graceful degradation by design</strong><span>Google Drive, Gmail and Outlook stay not configured until Atlas-owned OAuth and source scoping exist. Automatic synchronization is off.</span></div></div>
      ${summaryMarkup()}
      ${connectionsMarkup()}
      ${sourceRowsMarkup()}
    </section>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    let mount = element.querySelector('[data-p22-source-mount]');
    if (!mount) {
      mount = document.createElement('div');
      mount.dataset.p22SourceMount = 'true';
      const trustPanel = element.querySelector('.knowledge-trust-panel');
      if (trustPanel) trustPanel.insertAdjacentElement('afterend', mount);
      else element.prepend(mount);
    }
    if (state.loading && !state.workspace) mount.innerHTML = loadingMarkup();
    else if (state.error && !state.workspace) mount.innerHTML = errorMarkup();
    else mount.innerHTML = workspaceMarkup();
    window.lucide?.createIcons?.();
  }

  async function refresh(options = {}) {
    if (state.loading || !visible()) return;
    state.loading = true;
    if (!options.silent) state.error = null;
    render();
    try {
      const payload = await api();
      state.workspace = payload.workspace || payload;
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Source Center could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.('[data-p22-source-refresh]')) return;
    refresh();
  }

  function mountWhenReady() {
    if (!host()) return false;
    render();
    refresh({ silent: true });
    return true;
  }

  function init() {
    if (state.initialized) return true;
    const knowledge = root();
    if (!knowledge) return false;
    state.initialized = true;
    knowledge.addEventListener('click', handleClick);
    state.observer = new MutationObserver(() => {
      if (!host()) return;
      render();
      if (!state.workspace && !state.loading) refresh({ silent: true });
    });
    state.observer.observe(knowledge, { childList: true, subtree: true });
    mountWhenReady();
    window.addEventListener('pagehide', () => {
      knowledge.removeEventListener('click', handleClick);
      state.observer?.disconnect();
      if (state.retryTimer) window.clearInterval(state.retryTimer);
    }, { once: true });
    return true;
  }

  window.AtlasReadSourcesP22 = { refresh, snapshot: () => state.workspace };
  if (!init()) {
    state.retryTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 150);
    window.setTimeout(() => {
      if (!state.retryTimer) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 12000);
  }
})();
