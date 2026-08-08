(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const STOCK_COUNT_API = String(cfg.STOCK_COUNTS_API || 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-stock-counts').trim();
  const SCANNER_API = String(cfg.INVENTORY_SCANNER_API || 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-inventory-scanner').trim();
  const ZXING_ESM_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/+esm';
  const REQUEST_TIMEOUT_MS = 22000;
  const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

  const state = {
    initialized: false,
    active: false,
    loading: false,
    saving: false,
    snapshot: null,
    staff: null,
    policy: null,
    detail: null,
    activeSessionId: null,
    search: '',
    lineFilter: 'all',
    sessionFilter: 'active',
    message: null,
    error: null,
    observer: null,
    retryTimer: null,
    modal: null,
    scan: {
      open: false,
      scanning: false,
      stream: null,
      controls: null,
      nativeTimer: null,
      code: '',
      source: 'manual',
      lookup: null,
      line: null,
      error: null,
      message: null,
      submitting: false,
      zxingModule: null
    }
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatNumber(value) {
    const parsed = number(value);
    return parsed.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function humanize(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function randomUuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function host() {
    return document.getElementById('inventory-view');
  }

  function workspace() {
    return document.getElementById('stock-count-workspace');
  }

  function inventoryVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  function sessionById(id) {
    return (state.snapshot?.sessions || []).find((session) => session.id === id) || null;
  }

  function currentSession() {
    return state.detail?.session || sessionById(state.activeSessionId);
  }

  function currentSummary() {
    return state.detail?.summary || currentSession()?.summary || {};
  }

  function currentPermissions() {
    return state.detail?.permissions || {};
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(endpoint, action, options = {}) {
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in again to continue.');
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Stock-count request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The stock-count service took too long to respond. Please try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function countApi(action, options) {
    return api(STOCK_COUNT_API, action, options);
  }

  async function scannerLookup(code) {
    return api(SCANNER_API, 'lookup', { params: { code } });
  }

  function setLegacyVisibility(hidden) {
    const element = host();
    if (!element) return;
    const toolbar = element.querySelector(':scope > .toolbar');
    const tableWrap = document.getElementById('table-wrap');
    if (toolbar) toolbar.hidden = hidden;
    if (tableWrap) tableWrap.hidden = hidden;
    document.body.classList.toggle('stock-count-active', hidden);
  }

  function ensureWorkspace() {
    const element = host();
    if (!element) return null;
    let mount = workspace();
    if (!mount) {
      mount = document.createElement('section');
      mount.id = 'stock-count-workspace';
      mount.className = 'stock-count-workspace';
      mount.setAttribute('aria-live', 'polite');
      element.appendChild(mount);
    }
    return mount;
  }

  function statusTone(status) {
    if (status === 'verified' || status === 'current') return 'good';
    if (status === 'submitted' || status === 'stale') return 'warn';
    if (status === 'rejected' || status === 'cancelled' || status === 'revoked') return 'bad';
    return 'neutral';
  }

  function statusPill(status, label) {
    return `<span class="stock-count-pill is-${statusTone(status)}">${escapeHtml(label || humanize(status))}</span>`;
  }

  function loadingMarkup() {
    return `<div class="stock-count-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading stock counts</h2><p>Checking the live inventory catalog, private count sessions and verified balances.</p></div>`;
  }

  function errorMarkup() {
    return `<div class="stock-count-state"><span class="is-error"><i data-lucide="triangle-alert"></i></span><h2>Stock counts unavailable</h2><p>${escapeHtml(state.error)}</p><button type="button" data-stock-count-retry><i data-lucide="refresh-cw"></i>Try again</button></div>`;
  }

  function heroMarkup() {
    const summary = state.snapshot?.summary || {};
    return `<header class="stock-count-hero">
      <div><span>Checkpoint L1 · Verified live inventory</span><h1>${state.detail ? escapeHtml(currentSession()?.title || 'Stock count') : 'Current stock counts'}</h1><p>${state.detail ? 'Count every item in scope, preserve the evidence, then submit it for manager verification.' : 'Create auditable count sessions without changing production quantities. Verified balances feed Atlas intelligence for a limited freshness window.'}</p></div>
      <div class="stock-count-hero-actions">
        ${state.detail ? '<button type="button" class="stock-count-secondary" data-count-back><i data-lucide="arrow-left"></i>All counts</button>' : ''}
        <button type="button" class="stock-count-secondary" data-count-refresh><i data-lucide="refresh-cw"></i>Refresh</button>
        ${!state.detail && state.snapshot?.permissions?.can_start ? '<button type="button" class="stock-count-primary" data-count-start><i data-lucide="clipboard-plus"></i>Start count</button>' : ''}
      </div>
      <div class="stock-count-summary-strip">
        <article><span>Verified current</span><strong>${formatNumber(summary.current_verified_balances || 0)}</strong><small>fresh manager-approved balances</small></article>
        <article><span>Awaiting verification</span><strong>${formatNumber(summary.submitted_sessions || 0)}</strong><small>submitted count sessions</small></article>
        <article><span>Draft sessions</span><strong>${formatNumber(summary.draft_sessions || 0)}</strong><small>work still in progress</small></article>
        <article><span>Catalog coverage</span><strong>${formatNumber(summary.catalog_items || 0)}</strong><small>active inventory items</small></article>
      </div>
    </header>`;
  }

  function trustMarkup() {
    return `<div class="stock-count-trust"><i data-lucide="shield-check"></i><span>Counts remain private until submitted and manager verified · Historical July quantities are never promoted automatically · Production inventory mutation is off</span></div>`;
  }

  function sessionCard(session) {
    const summary = session.summary || {};
    const scope = session.scope_type === 'all' ? 'All active inventory' : `${humanize(session.scope_type)} · ${session.scope_value}`;
    return `<article class="stock-count-session-card" data-count-session-card="${escapeHtml(session.id)}">
      <header><div><span>${escapeHtml(scope)}</span><h3>${escapeHtml(session.title)}</h3></div>${statusPill(session.status)}</header>
      <p>Started by ${escapeHtml(session.started_by_label || 'Atlas staff')} · ${escapeHtml(formatDate(session.started_at))}</p>
      <div class="stock-count-progress"><i style="width:${Math.max(0, Math.min(100, number(summary.progress_percent)))}%"></i></div>
      <div class="stock-count-session-stats"><span><strong>${formatNumber(summary.counted_lines || 0)}</strong> counted</span><span><strong>${formatNumber(summary.skipped_lines || 0)}</strong> skipped</span><span><strong>${formatNumber(summary.pending_lines || 0)}</strong> pending</span></div>
      <footer><span>${session.verified_at ? `Verified ${escapeHtml(formatDate(session.verified_at))}` : session.submitted_at ? `Submitted ${escapeHtml(formatDate(session.submitted_at))}` : `${formatNumber(summary.progress_percent || 0)}% complete`}</span><button type="button" data-open-count-session="${escapeHtml(session.id)}">Open <i data-lucide="arrow-right"></i></button></footer>
    </article>`;
  }

  function filteredSessions() {
    const sessions = Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
    if (state.sessionFilter === 'all') return sessions;
    if (state.sessionFilter === 'active') return sessions.filter((session) => ['draft', 'submitted'].includes(session.status));
    return sessions.filter((session) => session.status === state.sessionFilter);
  }

  function verifiedBalanceMarkup(balance) {
    return `<article class="stock-count-balance-row"><div><strong>${escapeHtml(balance.item_name)}</strong><span>${escapeHtml(balance.bin_location || balance.category || 'Inventory')}</span></div><div><strong>${formatNumber(balance.verified_quantity)} ${escapeHtml(balance.inventory_unit || '')}</strong><span>expires ${escapeHtml(formatDate(balance.expires_at))}</span></div>${statusPill(balance.freshness_state)}</article>`;
  }

  function overviewMarkup() {
    const sessions = filteredSessions();
    const balances = (state.snapshot?.verified_balances || []).filter((balance) => balance.freshness_state === 'current');
    return `<div class="stock-count-overview-grid">
      <section class="stock-count-panel stock-count-sessions-panel">
        <header class="stock-count-panel-head"><div><span>Count sessions</span><h2>Inventory evidence workflow</h2><p>Drafts can be completed by operational staff. Only managers can turn submitted counts into current verified balances.</p></div><select data-session-filter aria-label="Filter count sessions"><option value="active" ${state.sessionFilter === 'active' ? 'selected' : ''}>Active</option><option value="draft" ${state.sessionFilter === 'draft' ? 'selected' : ''}>Draft</option><option value="submitted" ${state.sessionFilter === 'submitted' ? 'selected' : ''}>Awaiting verification</option><option value="verified" ${state.sessionFilter === 'verified' ? 'selected' : ''}>Verified</option><option value="all" ${state.sessionFilter === 'all' ? 'selected' : ''}>All</option></select></header>
        <div class="stock-count-session-list">${sessions.length ? sessions.map(sessionCard).join('') : '<div class="stock-count-empty"><i data-lucide="clipboard-list"></i><h3>No sessions in this view</h3><p>Start a full, location or category count when the team is ready.</p></div>'}</div>
      </section>
      <aside class="stock-count-side-stack">
        <section class="stock-count-panel"><header class="stock-count-panel-head"><div><span>Verified evidence</span><h2>Fresh balances</h2><p>These private values can be used by Checkpoint K until the freshness window expires.</p></div></header><div class="stock-count-balance-list">${balances.length ? balances.slice(0, 12).map(verifiedBalanceMarkup).join('') : '<div class="stock-count-empty is-compact"><i data-lucide="badge-check"></i><h3>No verified balances yet</h3><p>Complete and verify the first current count.</p></div>'}</div></section>
        <section class="stock-count-panel"><header class="stock-count-panel-head"><div><span>Evidence contract</span><h2>What verification means</h2></div></header><ul class="stock-count-contract-list"><li>Every line keeps its observed quantity, staff identity and time.</li><li>Source changes after the count started are detected as conflicts.</li><li>Manager verification creates private current evidence for seven days.</li><li>No production quantity or movement is created in this checkpoint.</li></ul></section>
      </aside>
    </div>`;
  }

  function lineMatches(line) {
    const query = state.search.trim().toLowerCase();
    if (query && ![line.item_name, line.category, line.bin_location, line.sku, line.barcode]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(query))) return false;
    if (state.lineFilter !== 'all' && line.line_status !== state.lineFilter) return false;
    return true;
  }

  function sourceBadge(line) {
    if (line.source_kind === 'historical_snapshot') return statusPill('stale', 'Historical opening');
    if (line.source_kind === 'manager_verified_count') return statusPill('current', 'Previously verified');
    return statusPill('neutral', 'Production observation');
  }

  function lineCard(line) {
    const editable = Boolean(currentPermissions().can_edit);
    const variance = line.observed_quantity == null ? null : number(line.observed_quantity) - number(line.expected_quantity);
    const varianceText = variance === null ? 'Not counted' : variance === 0 ? 'No variance' : `${variance > 0 ? '+' : ''}${formatNumber(variance)} ${line.inventory_unit || ''}`;
    return `<form class="stock-count-line is-${escapeHtml(line.line_status)}" data-count-line-form data-line-id="${escapeHtml(line.id)}" data-line-version="${line.version}">
      <header><div><span>${escapeHtml(line.bin_location || line.category || 'Inventory')}</span><h3>${escapeHtml(line.item_name)}</h3></div><div>${sourceBadge(line)}${statusPill(line.line_status)}</div></header>
      <div class="stock-count-line-evidence"><div><span>Source quantity</span><strong>${formatNumber(line.expected_quantity)} ${escapeHtml(line.inventory_unit || '')}</strong></div><div><span>Variance</span><strong class="${variance != null && variance !== 0 ? 'is-variance' : ''}">${escapeHtml(varianceText)}</strong></div><div><span>Counted by</span><strong>${escapeHtml(line.counted_by_label || '—')}</strong></div></div>
      ${line.source_kind === 'historical_snapshot' ? '<div class="stock-count-line-warning"><i data-lucide="history"></i><span>The displayed source quantity came from the historical July opening evidence and is not treated as current stock.</span></div>' : ''}
      ${line.source_changed_since_start ? '<div class="stock-count-line-warning is-conflict"><i data-lucide="git-compare-arrows"></i><span>The production source changed after this session started. Manager acknowledgement is required.</span></div>' : ''}
      <div class="stock-count-line-entry"><label><span>Observed quantity</span><div><button type="button" data-line-step="-1" ${editable ? '' : 'disabled'}>−</button><input type="number" min="0" step="0.1" data-line-quantity value="${line.observed_quantity == null ? '' : escapeHtml(line.observed_quantity)}" placeholder="0" ${editable ? '' : 'disabled'}/><button type="button" data-line-step="1" ${editable ? '' : 'disabled'}>+</button><em>${escapeHtml(line.inventory_unit || 'units')}</em></div></label><label><span>Count note</span><input type="text" data-line-note value="${escapeHtml(line.note || '')}" placeholder="Open bottle estimate, damage, storage note…" ${editable ? '' : 'disabled'}/></label></div>
      ${line.line_status === 'skipped' ? `<p class="stock-count-skip-reason"><strong>Skipped:</strong> ${escapeHtml(line.skipped_reason || '')}</p>` : ''}
      <footer><span>${line.counted_at ? escapeHtml(formatDate(line.counted_at)) : line.sku || line.barcode ? escapeHtml([line.sku, line.barcode].filter(Boolean).join(' · ')) : 'Awaiting observation'}</span>${editable ? `<div><button type="button" class="stock-count-text-action" data-skip-line="${escapeHtml(line.id)}">Skip</button><button type="submit" class="stock-count-primary"><i data-lucide="check"></i>Save count</button></div>` : ''}</footer>
    </form>`;
  }

  function detailActionsMarkup() {
    const session = currentSession();
    const summary = currentSummary();
    const permissions = currentPermissions();
    if (!session) return '';
    return `<div class="stock-count-detail-actions">
      ${permissions.can_edit ? '<button type="button" class="stock-count-secondary" data-count-scan><i data-lucide="scan-barcode"></i>Scan next bottle</button>' : ''}
      ${permissions.can_cancel ? '<button type="button" class="stock-count-secondary is-danger" data-count-cancel><i data-lucide="x"></i>Cancel session</button>' : ''}
      ${permissions.can_reject ? '<button type="button" class="stock-count-secondary is-danger" data-count-reject><i data-lucide="undo-2"></i>Reject</button>' : ''}
      ${permissions.can_verify ? '<button type="button" class="stock-count-primary" data-count-verify><i data-lucide="badge-check"></i>Verify count</button>' : ''}
      ${permissions.can_submit ? `<button type="button" class="stock-count-primary" data-count-submit ${number(summary.pending_lines) > 0 ? 'disabled' : ''}><i data-lucide="send"></i>Submit for verification</button>` : ''}
    </div>`;
  }

  function detailMarkup() {
    const session = currentSession();
    const summary = currentSummary();
    const lines = (state.detail?.lines || []).filter(lineMatches);
    if (!session) return '<div class="stock-count-empty"><h3>Stock-count session unavailable</h3></div>';
    return `<section class="stock-count-panel stock-count-detail-panel">
      <header class="stock-count-detail-head"><div><div class="stock-count-detail-kicker">${statusPill(session.status)}<span>${escapeHtml(session.scope_type === 'all' ? 'All active inventory' : `${humanize(session.scope_type)} · ${session.scope_value}`)}</span></div><h2>${escapeHtml(session.title)}</h2><p>Started by ${escapeHtml(session.started_by_label)} · ${escapeHtml(formatDate(session.started_at))}${session.verified_by_label ? ` · verified by ${escapeHtml(session.verified_by_label)}` : ''}</p></div>${detailActionsMarkup()}</header>
      <div class="stock-count-progress-block"><div><span>Session progress</span><strong>${formatNumber(summary.progress_percent || 0)}%</strong></div><div class="stock-count-progress"><i style="width:${Math.max(0, Math.min(100, number(summary.progress_percent)))}%"></i></div><div class="stock-count-session-stats"><span><strong>${formatNumber(summary.counted_lines || 0)}</strong> counted</span><span><strong>${formatNumber(summary.skipped_lines || 0)}</strong> skipped</span><span><strong>${formatNumber(summary.pending_lines || 0)}</strong> pending</span><span><strong>${formatNumber(summary.negative_variances || 0)}</strong> negative variances</span></div></div>
      ${session.status === 'submitted' ? '<div class="stock-count-review-banner"><i data-lucide="shield-alert"></i><span>This session is locked for staff edits and awaits manager verification. Verification records private current balances; it does not change production inventory.</span></div>' : ''}
      <div class="stock-count-controls"><label><i data-lucide="search"></i><input type="search" data-count-search placeholder="Search item, category, location or barcode" value="${escapeHtml(state.search)}"/></label><select data-line-filter><option value="all" ${state.lineFilter === 'all' ? 'selected' : ''}>All lines</option><option value="pending" ${state.lineFilter === 'pending' ? 'selected' : ''}>Pending</option><option value="counted" ${state.lineFilter === 'counted' ? 'selected' : ''}>Counted</option><option value="skipped" ${state.lineFilter === 'skipped' ? 'selected' : ''}>Skipped</option></select></div>
      <div class="stock-count-line-list">${lines.length ? lines.map(lineCard).join('') : '<div class="stock-count-empty"><i data-lucide="search-x"></i><h3>No count lines match</h3><p>Clear the search or choose another status.</p></div>'}</div>
    </section>`;
  }

  function render() {
    if (!state.active) return;
    const mount = ensureWorkspace();
    if (!mount) return;
    setLegacyVisibility(true);
    if (state.loading && !state.snapshot) {
      mount.innerHTML = loadingMarkup();
      window.lucide?.createIcons?.();
      return;
    }
    if (state.error && !state.snapshot) {
      mount.innerHTML = errorMarkup();
      window.lucide?.createIcons?.();
      return;
    }
    if (!state.snapshot) return;
    mount.innerHTML = `${heroMarkup()}${state.error ? `<div class="stock-count-alert is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>` : ''}${state.message ? `<div class="stock-count-alert is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>` : ''}${trustMarkup()}${state.detail ? detailMarkup() : overviewMarkup()}`;
    window.lucide?.createIcons?.();
  }

  async function loadSnapshot(force = false) {
    if (state.loading || (!force && state.snapshot)) return;
    state.loading = true;
    state.error = null;
    render();
    try {
      const payload = await countApi('snapshot');
      state.snapshot = payload.counts || {};
      state.staff = payload.staff || null;
      state.policy = payload.policy || null;
      if (state.activeSessionId) {
        const detailPayload = await countApi('detail', { params: { id: state.activeSessionId } });
        state.detail = detailPayload.count || null;
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Stock counts could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openSession(id) {
    state.activeSessionId = id;
    state.detail = null;
    state.error = null;
    state.loading = true;
    render();
    try {
      const payload = await countApi('detail', { params: { id } });
      state.detail = payload.count || null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The count session could not load.';
      state.activeSessionId = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.saving) return null;
    state.saving = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await countApi(action, { method: 'POST', body });
      state.snapshot = payload.counts || state.snapshot;
      state.staff = payload.staff || state.staff;
      state.policy = payload.policy || state.policy;
      if (payload.detail) {
        state.detail = payload.detail;
        state.activeSessionId = payload.detail.session?.id || state.activeSessionId;
      }
      state.message = successMessage;
      return payload;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The stock-count change could not be saved.';
      throw error;
    } finally {
      state.saving = false;
      render();
      window.setTimeout(() => {
        if (state.message) {
          state.message = null;
          render();
        }
      }, 5000);
    }
  }

  function startModalMarkup() {
    const catalog = state.snapshot?.catalog || [];
    const locations = [...new Set(catalog.map((item) => item.bin_location).filter(Boolean))].sort();
    const categories = [...new Set(catalog.map((item) => item.category).filter(Boolean))].sort();
    const type = state.modal?.scopeType || 'all';
    const options = type === 'location' ? locations : type === 'category' ? categories : [];
    return `<div class="stock-count-modal-backdrop"><section class="stock-count-modal" role="dialog" aria-modal="true"><header><div><span>Checkpoint L1</span><h2>Start current stock count</h2><p>Create a private snapshot of the selected inventory scope.</p></div><button type="button" data-close-count-modal aria-label="Close"><i data-lucide="x"></i></button></header><form data-start-count-form><div class="stock-count-form-grid"><label><span>Count title</span><input name="title" value="${escapeHtml(state.modal?.title || 'Current stock count')}" required/></label><label><span>Scope</span><select name="scope_type" data-start-scope><option value="all" ${type === 'all' ? 'selected' : ''}>All active inventory</option><option value="location" ${type === 'location' ? 'selected' : ''}>One storage location</option><option value="category" ${type === 'category' ? 'selected' : ''}>One category</option></select></label>${type !== 'all' ? `<label class="is-full"><span>${type === 'location' ? 'Storage location' : 'Category'}</span><select name="scope_value" required><option value="">Choose…</option>${options.map((value) => `<option value="${escapeHtml(value)}" ${state.modal?.scopeValue === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>` : ''}<label class="is-full"><span>Count note</span><textarea name="notes" rows="3" placeholder="Optional instructions for the team">${escapeHtml(state.modal?.notes || '')}</textarea></label></div><div class="stock-count-modal-contract"><i data-lucide="shield-check"></i><span>This creates count lines only. Production quantities remain unchanged before and after verification.</span></div><footer><button type="button" class="stock-count-secondary" data-close-count-modal>Cancel</button><button type="submit" class="stock-count-primary"><i data-lucide="clipboard-plus"></i>Start session</button></footer></form></section></div>`;
  }

  function openStartModal() {
    closeModal();
    state.modal = { type: 'start', scopeType: 'all', scopeValue: '', title: 'Current stock count', notes: '' };
    const wrapper = document.createElement('div');
    wrapper.dataset.stockCountModalRoot = 'true';
    wrapper.innerHTML = startModalMarkup();
    document.body.appendChild(wrapper);
    window.lucide?.createIcons?.();
  }

  function rerenderStartModal() {
    const root = document.querySelector('[data-stock-count-modal-root]');
    if (!root || state.modal?.type !== 'start') return;
    root.innerHTML = startModalMarkup();
    window.lucide?.createIcons?.();
  }

  function closeModal() {
    document.querySelector('[data-stock-count-modal-root]')?.remove();
    state.modal = null;
  }

  async function startCount(form) {
    const scopeType = form.elements.scope_type.value;
    const scopeValue = scopeType === 'all' ? null : form.elements.scope_value.value;
    const payload = await mutate('start', {
      title: form.elements.title.value.trim(),
      scope_type: scopeType,
      scope_value: scopeValue,
      notes: form.elements.notes.value.trim() || null,
      client_request_id: randomUuid()
    }, 'Stock-count session started.');
    closeModal();
    if (payload?.detail?.session?.id) state.activeSessionId = payload.detail.session.id;
    render();
  }

  function lineFromForm(form) {
    return state.detail?.lines?.find((line) => line.id === form.dataset.lineId) || null;
  }

  async function saveLine(form, override = {}) {
    const line = lineFromForm(form);
    if (!line) return;
    const input = form.querySelector('[data-line-quantity]');
    const note = form.querySelector('[data-line-note]');
    const quantity = override.observed_quantity ?? Number(input?.value);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Enter an observed quantity of zero or more.');
    await mutate('save-line', {
      session_id: currentSession().id,
      line_id: line.id,
      line_status: 'counted',
      observed_quantity: quantity,
      count_method: override.count_method || 'manual',
      note: (override.note ?? note?.value?.trim()) || null,
      skipped_reason: null,
      expected_version: line.version
    }, `${line.item_name} count saved.`);
  }

  async function skipLine(id) {
    const line = state.detail?.lines?.find((item) => item.id === id);
    if (!line) return;
    const reason = window.prompt(`Why is ${line.item_name} being skipped?`, line.skipped_reason || 'Not accessible during this count');
    if (!reason?.trim()) return;
    await mutate('save-line', {
      session_id: currentSession().id,
      line_id: line.id,
      line_status: 'skipped',
      observed_quantity: null,
      count_method: null,
      note: line.note || null,
      skipped_reason: reason.trim(),
      expected_version: line.version
    }, `${line.item_name} marked as skipped.`);
  }

  async function submitCount() {
    if (number(currentSummary().pending_lines) > 0) return;
    if (!window.confirm('Submit this completed count for manager verification? Staff editing will be locked.')) return;
    await mutate('submit', { session_id: currentSession().id, notes: null }, 'Stock count submitted for manager verification.');
  }

  async function verifyCount(acknowledgeConflicts = false) {
    if (!window.confirm(acknowledgeConflicts
      ? 'Acknowledge the source conflicts and verify these private current balances? Production inventory will still remain unchanged.'
      : 'Verify this count as current private evidence for Atlas? Production inventory will remain unchanged.')) return;
    try {
      await mutate('verify', {
        session_id: currentSession().id,
        acknowledge_conflicts: acknowledgeConflicts
      }, 'Stock count verified. Atlas can now use these balances until they expire.');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!acknowledgeConflicts && /source changed|acknowledge the conflicts/i.test(message)) {
        state.error = null;
        render();
        await verifyCount(true);
      }
    }
  }

  async function rejectCount() {
    const reason = window.prompt('Why should this submitted count be rejected?', 'Count requires correction');
    if (!reason?.trim()) return;
    await mutate('reject', { session_id: currentSession().id, reason: reason.trim() }, 'Stock count rejected for correction.');
  }

  async function cancelCount() {
    if (!window.confirm('Cancel this stock-count session? The audit history remains preserved.')) return;
    await mutate('cancel', { session_id: currentSession().id, reason: 'Cancelled from stock-count workspace' }, 'Stock-count session cancelled.');
  }

  function scanModalMarkup() {
    const scan = state.scan;
    const line = scan.line;
    return `<div class="stock-count-scan-backdrop"><section class="stock-count-scan-modal" role="dialog" aria-modal="true"><header><div><span>Mobile count capture</span><h2>Scan next inventory item</h2><p>Identify one item, confirm the quantity and save it into ${escapeHtml(currentSession()?.title || 'this count')}.</p></div><button type="button" data-close-count-scan aria-label="Close"><i data-lucide="x"></i></button></header>${scan.error ? `<div class="stock-count-alert is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(scan.error)}</span></div>` : ''}${scan.message ? `<div class="stock-count-alert is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(scan.message)}</span></div>` : ''}<div class="stock-count-scan-grid"><section><div class="stock-count-camera ${scan.scanning ? 'is-scanning' : ''}"><video data-count-video playsinline muted></video><div><i data-lucide="scan-barcode"></i><strong>${scan.scanning ? 'Looking for a barcode…' : 'Camera ready'}</strong><span>Place the full barcode inside the frame.</span></div><i></i></div><div class="stock-count-camera-actions">${scan.scanning ? '<button type="button" class="stock-count-secondary" data-stop-count-camera><i data-lucide="square"></i>Stop camera</button>' : '<button type="button" class="stock-count-primary" data-start-count-camera><i data-lucide="camera"></i>Start camera</button>'}<label class="stock-count-secondary"><i data-lucide="image-up"></i>Scan photo<input type="file" accept="image/*" capture="environment" data-count-scan-photo hidden/></label></div><form data-manual-count-code><label><span>Barcode or SKU</span><div><input name="code" value="${escapeHtml(scan.code)}" autocomplete="off" inputmode="numeric" placeholder="Enter code"/><button type="submit">Look up</button></div></label></form></section><section class="stock-count-scan-result">${line ? `<span class="stock-count-scan-kicker">Matched count line</span><h3>${escapeHtml(line.item_name)}</h3><p>${escapeHtml(line.bin_location || line.category || 'Inventory')} · source ${formatNumber(line.expected_quantity)} ${escapeHtml(line.inventory_unit || '')}</p><form data-save-scanned-count><label><span>Observed quantity</span><div class="stock-count-scan-quantity"><button type="button" data-scan-step="-1">−</button><input type="number" min="0" step="0.1" name="quantity" value="${line.observed_quantity == null ? escapeHtml(line.expected_quantity) : escapeHtml(line.observed_quantity)}" required/><button type="button" data-scan-step="1">+</button><em>${escapeHtml(line.inventory_unit || 'units')}</em></div></label><label><span>Count note</span><textarea name="note" rows="2" placeholder="Optional observation">${escapeHtml(line.note || '')}</textarea></label><button type="submit" class="stock-count-primary" ${scan.submitting ? 'disabled' : ''}><i data-lucide="clipboard-check"></i>Add to count</button></form>` : `<div class="stock-count-scan-empty"><i data-lucide="bottle"></i><h3>Scan one item</h3><p>Atlas checks verified barcode aliases and the live item catalog, then matches only items included in this session.</p></div>`}</section></div><footer><i data-lucide="shield-check"></i><span>Images and camera frames stay on this device · The saved observation remains private · No live inventory change</span></footer></section></div>`;
  }

  function renderScanModal() {
    let root = document.querySelector('[data-stock-count-scan-root]');
    if (!state.scan.open) {
      root?.remove();
      return;
    }
    if (!root) {
      root = document.createElement('div');
      root.dataset.stockCountScanRoot = 'true';
      document.body.appendChild(root);
    }
    root.innerHTML = scanModalMarkup();
    window.lucide?.createIcons?.();
    if (state.scan.scanning && state.scan.stream) {
      const video = root.querySelector('[data-count-video]');
      if (video && video.srcObject !== state.scan.stream) {
        video.srcObject = state.scan.stream;
        video.play().catch(() => {});
      }
    }
  }

  function openScanModal() {
    state.scan.open = true;
    state.scan.code = '';
    state.scan.lookup = null;
    state.scan.line = null;
    state.scan.source = 'manual';
    state.scan.error = null;
    state.scan.message = null;
    renderScanModal();
  }

  function stopCountCamera() {
    state.scan.scanning = false;
    if (state.scan.nativeTimer) {
      window.clearTimeout(state.scan.nativeTimer);
      state.scan.nativeTimer = null;
    }
    if (state.scan.controls?.stop) {
      try { state.scan.controls.stop(); } catch (_) { /* no-op */ }
    }
    state.scan.controls = null;
    if (state.scan.stream) {
      state.scan.stream.getTracks().forEach((track) => track.stop());
      state.scan.stream = null;
    }
    const video = document.querySelector('[data-count-video]');
    if (video) {
      try { video.pause(); } catch (_) { /* no-op */ }
      video.srcObject = null;
    }
  }

  function closeScanModal() {
    stopCountCamera();
    state.scan.open = false;
    state.scan.line = null;
    state.scan.lookup = null;
    document.querySelector('[data-stock-count-scan-root]')?.remove();
  }

  async function supportedNativeFormats() {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const supported = typeof window.BarcodeDetector.getSupportedFormats === 'function'
        ? await window.BarcodeDetector.getSupportedFormats()
        : SCAN_FORMATS;
      return SCAN_FORMATS.filter((format) => supported.includes(format));
    } catch (_) {
      return [];
    }
  }

  async function loadZxing() {
    if (state.scan.zxingModule) return state.scan.zxingModule;
    state.scan.zxingModule = await import(ZXING_ESM_URL);
    return state.scan.zxingModule;
  }

  async function resolveScannedCode(rawCode, source) {
    const code = String(rawCode || '').trim();
    if (!code) return;
    stopCountCamera();
    state.scan.code = code;
    state.scan.source = source;
    state.scan.lookup = null;
    state.scan.line = null;
    state.scan.error = null;
    state.scan.message = 'Checking the verified barcode link…';
    renderScanModal();
    try {
      const payload = await scannerLookup(code);
      const lookup = payload.lookup || { matched: false };
      state.scan.lookup = lookup;
      if (!lookup.matched || !lookup.item?.id) {
        throw new Error('No verified inventory item matches this code. Link it in the Bottle scanner first.');
      }
      const line = state.detail?.lines?.find((item) => item.inventory_item_id === lookup.item.id) || null;
      if (!line) throw new Error(`${lookup.item.name || 'This item'} is not included in the current count scope.`);
      state.scan.line = line;
      state.scan.message = null;
    } catch (error) {
      state.scan.message = null;
      state.scan.error = error instanceof Error ? error.message : 'The scanned code could not be matched.';
    }
    renderScanModal();
  }

  async function nativeScanLoop(detector, video) {
    if (!state.scan.scanning) return;
    try {
      const results = await detector.detect(video);
      if (results?.[0]?.rawValue) {
        await resolveScannedCode(results[0].rawValue, 'barcode');
        return;
      }
    } catch (_) { /* keep scanning */ }
    state.scan.nativeTimer = window.setTimeout(() => nativeScanLoop(detector, video), 220);
  }

  async function startCountCamera() {
    state.scan.error = null;
    if (!window.isSecureContext) {
      state.scan.error = 'Camera access requires the secure HTTPS preview. Use a barcode photo or enter the code manually.';
      renderScanModal();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      state.scan.error = 'This browser does not expose camera access. Use a barcode photo or enter the code manually.';
      renderScanModal();
      return;
    }
    stopCountCamera();
    state.scan.scanning = true;
    renderScanModal();
    const video = document.querySelector('[data-count-video]');
    if (!video) return;
    try {
      const formats = await supportedNativeFormats();
      if (formats.length) {
        state.scan.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
        video.srcObject = state.scan.stream;
        await video.play();
        const detector = new window.BarcodeDetector({ formats });
        nativeScanLoop(detector, video);
      } else {
        const module = await loadZxing();
        const reader = new module.BrowserMultiFormatReader();
        state.scan.controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
          const code = result && (typeof result.getText === 'function' ? result.getText() : result.text);
          if (code) resolveScannedCode(code, 'barcode');
        });
      }
    } catch (error) {
      stopCountCamera();
      state.scan.error = error?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access or use a barcode photo.'
        : error instanceof Error ? error.message : 'The camera could not start.';
      renderScanModal();
    }
  }

  async function decodeCountPhoto(file) {
    if (!file) return;
    stopCountCamera();
    state.scan.error = null;
    state.scan.message = 'Reading the barcode photo on this device…';
    renderScanModal();
    let objectUrl = null;
    try {
      const formats = await supportedNativeFormats();
      if (formats.length && 'createImageBitmap' in window) {
        const bitmap = await window.createImageBitmap(file);
        try {
          const detector = new window.BarcodeDetector({ formats });
          const results = await detector.detect(bitmap);
          if (!results?.[0]?.rawValue) throw new Error('No supported barcode was found in this photo.');
          await resolveScannedCode(results[0].rawValue, 'photo');
          return;
        } finally {
          bitmap.close?.();
        }
      }
      const module = await loadZxing();
      const reader = new module.BrowserMultiFormatReader();
      objectUrl = URL.createObjectURL(file);
      const result = await reader.decodeFromImageUrl(objectUrl);
      const code = typeof result.getText === 'function' ? result.getText() : result.text;
      if (!code) throw new Error('No supported barcode was found in this photo.');
      await resolveScannedCode(code, 'photo');
    } catch (error) {
      state.scan.message = null;
      state.scan.error = error instanceof Error ? error.message : 'No supported barcode was found in this photo.';
      renderScanModal();
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function saveScannedCount(form) {
    const line = state.scan.line;
    if (!line || state.scan.submitting) return;
    const quantity = Number(form.elements.quantity.value);
    if (!Number.isFinite(quantity) || quantity < 0) {
      state.scan.error = 'Enter an observed quantity of zero or more.';
      renderScanModal();
      return;
    }
    state.scan.submitting = true;
    state.scan.error = null;
    renderScanModal();
    try {
      await mutate('save-line', {
        session_id: currentSession().id,
        line_id: line.id,
        line_status: 'counted',
        observed_quantity: quantity,
        count_method: state.scan.source === 'photo' ? 'photo' : state.scan.source === 'barcode' ? 'barcode' : 'manual',
        note: form.elements.note.value.trim() || null,
        skipped_reason: null,
        expected_version: line.version
      }, `${line.item_name} count saved.`);
      closeScanModal();
    } catch (_) {
      state.scan.error = state.error || 'The scanned count could not be saved.';
      state.error = null;
      render();
      renderScanModal();
    } finally {
      state.scan.submitting = false;
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const stockNav = target.closest('[data-view="inventory"][data-subview="Stock count"]');
    if (stockNav) {
      window.setTimeout(() => open(), 0);
      return;
    }
    const anotherNav = target.closest('.nav-item[data-view]');
    if (anotherNav && !stockNav && state.active) {
      close();
      return;
    }

    if (target.closest('[data-count-refresh], [data-stock-count-retry]')) {
      state.snapshot = null;
      state.detail = null;
      loadSnapshot(true);
      return;
    }
    if (target.closest('[data-count-start]')) { openStartModal(); return; }
    if (target.closest('[data-close-count-modal]')) { closeModal(); return; }
    const sessionButton = target.closest('[data-open-count-session]');
    if (sessionButton) { openSession(sessionButton.dataset.openCountSession); return; }
    if (target.closest('[data-count-back]')) {
      state.activeSessionId = null;
      state.detail = null;
      state.search = '';
      state.lineFilter = 'all';
      render();
      return;
    }
    const step = target.closest('[data-line-step]');
    if (step) {
      const form = step.closest('[data-count-line-form]');
      const input = form?.querySelector('[data-line-quantity]');
      if (input) input.value = String(Math.max(0, number(input.value) + number(step.dataset.lineStep)));
      return;
    }
    const skip = target.closest('[data-skip-line]');
    if (skip) { skipLine(skip.dataset.skipLine).catch(() => {}); return; }
    if (target.closest('[data-count-submit]')) { submitCount().catch(() => {}); return; }
    if (target.closest('[data-count-verify]')) { verifyCount(false).catch(() => {}); return; }
    if (target.closest('[data-count-reject]')) { rejectCount().catch(() => {}); return; }
    if (target.closest('[data-count-cancel]')) { cancelCount().catch(() => {}); return; }
    if (target.closest('[data-count-scan]')) { openScanModal(); return; }
    if (target.closest('[data-close-count-scan]')) { closeScanModal(); return; }
    if (target.closest('[data-start-count-camera]')) { startCountCamera(); return; }
    if (target.closest('[data-stop-count-camera]')) { stopCountCamera(); renderScanModal(); return; }
    const scanStep = target.closest('[data-scan-step]');
    if (scanStep) {
      const input = document.querySelector('[data-save-scanned-count] input[name="quantity"]');
      if (input) input.value = String(Math.max(0, number(input.value) + number(scanStep.dataset.scanStep)));
      return;
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.matches('[data-count-search]')) {
      state.search = target.value;
      render();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-session-filter]')) {
      state.sessionFilter = target.value;
      render();
      return;
    }
    if (target.matches('[data-line-filter]')) {
      state.lineFilter = target.value;
      render();
      return;
    }
    if (target.matches('[data-start-scope]') && state.modal?.type === 'start') {
      const form = target.closest('form');
      state.modal.scopeType = target.value;
      state.modal.scopeValue = '';
      state.modal.title = form?.elements.title?.value || state.modal.title;
      state.modal.notes = form?.elements.notes?.value || state.modal.notes;
      rerenderStartModal();
      return;
    }
    if (target.matches('[data-count-scan-photo]')) {
      const file = target.files?.[0];
      target.value = '';
      if (file) decodeCountPhoto(file);
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (window.AtlasStockCountsL1?.handleSubmit?.(event, form)) return;
    if (form.matches('[data-start-count-form]')) {
      event.preventDefault();
      startCount(form).catch(() => {});
      return;
    }
    if (form.matches('[data-count-line-form]')) {
      event.preventDefault();
      saveLine(form).catch((error) => {
        state.error = error instanceof Error ? error.message : 'The count line could not be saved.';
        render();
      });
      return;
    }
    if (form.matches('[data-manual-count-code]')) {
      event.preventDefault();
      resolveScannedCode(form.elements.code.value, 'manual');
      return;
    }
    if (form.matches('[data-save-scanned-count]')) {
      event.preventDefault();
      saveScannedCount(form);
    }
  }

  function open() {
    state.active = true;
    ensureWorkspace();
    setLegacyVisibility(true);
    if (!state.snapshot && !state.loading) loadSnapshot();
    else render();
  }

  function close() {
    state.active = false;
    closeModal();
    closeScanModal();
    setLegacyVisibility(false);
    const mount = workspace();
    if (mount) mount.hidden = true;
  }

  function restoreIfVisible() {
    if (!state.active || !inventoryVisible()) return;
    const mount = ensureWorkspace();
    if (mount) mount.hidden = false;
    setLegacyVisibility(true);
    render();
  }

  function init() {
    if (state.initialized) return true;
    if (!host()) return false;
    state.initialized = true;
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('submit', handleSubmit, true);
    state.observer = new MutationObserver(restoreIfVisible);
    state.observer.observe(document.getElementById('app-screen') || document.body, { attributes: true, childList: true, subtree: true });
    window.addEventListener('pagehide', () => {
      state.observer?.disconnect();
      closeScanModal();
    }, { once: true });
    return true;
  }

  window.AtlasStockCounts = {
    open,
    close,
    refresh() { return loadSnapshot(true); },
    openSession,
    snapshot() { return state.snapshot; },
    detail() { return state.detail; }
  };

  if (!init()) {
    state.retryTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 120);
    window.setTimeout(() => {
      if (!state.retryTimer) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 12000);
  }
})();
