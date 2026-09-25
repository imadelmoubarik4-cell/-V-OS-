// Data (#data) — bring outside data in correctly and keep live records clean.
// Manager and admin only (spec §3.3, §7.14).
//
// Tabs (spec §3.4 routes):
//   #data                  Imports (files needing attention first)
//   #data/import/<batchId> One import: Upload · Review · Import
//   #data/issues[?issue=]  Live-record issues (atlas_data_review_summary / _rows),
//                          each row with a Fix action that opens the canonical editor
//   #data/pars[?item=]     Bulk par editor (atlas_par_level_evidence,
//                          atlas_apply_par_levels); nothing saves until
//                          "Save n changes"; conflicts write nothing
//   #data/import-review    Staged import records (atlas-sprint3-review); nothing
//                          changes live records until approved
//   #data/approvals        Catalogue change requests waiting for a manager
//                          (atlas-item-master catalog-queue / catalog-decide)
//
// Replaces import-center.js (Import Center) and sprint3-review.js (Real VÁ Data).
(function (root) {
  'use strict';

  if (root.AtlasDataWorkspace) return;

  const cfg = root.VABAR_CONFIG || {};
  const MANAGERS = ['admin', 'manager'];
  const TABS = [
    ['imports', 'Imports'],
    ['issues', 'Issues'],
    ['pars', 'Par levels'],
    ['import-review', 'Import review'],
    ['approvals', 'Waiting for approval']
  ];
  const BUCKET = 'atlas-imports';
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const ALLOWED_EXTENSIONS = new Set(['pdf', 'xlsx', 'xls', 'csv', 'json', 'txt', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
  const TERMINAL = new Set(['completed', 'completed_with_review', 'imported', 'failed', 'cancelled']);
  const COMPLETE = new Set(['completed', 'completed_with_review', 'imported']);
  const SCOPES = [
    ['inventory', 'Inventory and stock counts'], ['recipe', 'Recipes'], ['supplier', 'Suppliers'],
    ['menu', 'Menus'], ['invoice', 'Invoices'], ['purchase', 'Purchases'], ['image', 'Photos']
  ];
  const REVIEW_SCOPES = [
    ['all', 'All types'], ['inventory', 'Inventory'], ['recipe', 'Recipes'], ['menu', 'Menus'],
    ['supplier', 'Suppliers'], ['invoice', 'Invoices'], ['purchase', 'Purchases'], ['delivery', 'Deliveries'],
    ['equipment', 'Equipment'], ['wine', 'Wine'], ['routine', 'Routines'], ['staff_document', 'Staff documents'], ['offer', 'Offers']
  ];
  const REVIEW_STATUSES = [
    ['all', 'All statuses'], ['pending', 'Waiting'], ['held', 'Held'], ['source_checked', 'Source checked'],
    ['approved', 'Approved'], ['rejected', 'Rejected'], ['excluded', 'Excluded']
  ];
  const KIND_LABELS = {
    alias: 'Alias', code: 'Barcode or code', new_item: 'New item', duplicate_resolution: 'Duplicate',
    metadata_correction: 'Detail correction', wrong_match_report: 'Wrong match', code_conflict: 'Code conflict'
  };
  const SOURCE_LABELS = {
    recognition: 'from a scan', ai_proposal: 'from Atlas AI', manager: 'by a manager', data_review: 'from Data',
    backfill: 'suggested from existing details', import: 'from an import'
  };
  const REQUEST_STATUS = {
    pending: ['Waiting', 'info'], approved: ['Approved', 'positive'], applied: ['Applied', 'positive'],
    rejected: ['Rejected', 'neutral'], failed: ['Couldn\'t apply', 'danger'], withdrawn: ['Withdrawn', 'neutral'],
    superseded: ['Replaced', 'neutral']
  };
  const FIELD_LABELS = {
    name: 'Name', brand: 'Brand', product_name: 'Product', variant: 'Variant', category: 'Category', subcategory: 'Subcategory',
    item_class: 'Product type', unit: 'Count unit', unit_size_quantity: 'Unit size', unit_size_base: 'Size unit',
    size_ml: 'Size (ml)', package_size: 'Package', units_per_case: 'Units per case', cost_price: 'Unit cost',
    case_cost: 'Case cost', supplier_id: 'Supplier', par_level: 'Par level'
  };
  const PAGE = 50;

  const state = {
    initialized: false,
    root: null,
    tab: 'imports',
    params: {},
    summary: null, summaryError: null, summaryLoading: false, summaryAt: 0,
    imports: { rows: [], loading: false, loaded: false, error: null, query: '', filter: 'all', busy: new Set() },
    issues: { code: null, rows: [], total: 0, offset: 0, loading: false, error: null },
    pars: { items: null, loading: false, error: null, query: '', category: '', supplier: '', cover: '', coverApplied: null, edits: new Map(), conflicts: null, saving: false, saveError: null, focusItem: null },
    review: { summary: null, rows: [], total: 0, offset: 0, scope: 'all', status: 'pending', query: '', batch: null, loading: false, error: null, detail: null, detailLoading: false, submitting: false },
    queue: { status: 'pending', kind: '', rows: [], counts: {}, total: 0, loading: false, error: null, loaded: false, deciding: false },
    pollTimer: null,
    searchTimer: null
  };

  // ---------- small helpers ----------

  const clock = () => root.AtlasVenueClock || null;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const attr = escapeHtml;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const money = (value) => (root.AtlasFormat?.money ? root.AtlasFormat.money(value) : (value == null ? '—' : `${Math.round(Number(value))} kr`));
  function formatDateTime(value) {
    if (!value) return '—';
    return clock()?.formatDateTime?.(value, {}, '—') || '—';
  }
  function formatRelative(value) {
    if (!value) return '—';
    return clock()?.formatRelative?.(value, undefined, '—') || formatDateTime(value);
  }
  function number(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function formatQuantity(value) {
    const n = number(value);
    if (n === null) return '—';
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }
  function requestId(prefix = 'data') {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function icons() { root.lucide?.createIcons?.(); }
  function profile() { return root.AtlasShell?.profile?.() || root.atlasCurrentProfile || null; }
  function isManager() {
    const current = profile();
    return Boolean(current && current.active !== false && MANAGERS.includes(current.role));
  }
  function client() { return root.atlasSupabase || null; }
  function shellItems() {
    try { return typeof items !== 'undefined' && Array.isArray(items) ? items : []; } catch { return []; } // eslint-disable-line no-undef
  }
  function shellSuppliers() {
    try { return typeof suppliers !== 'undefined' && Array.isArray(suppliers) ? suppliers : []; } catch { return []; } // eslint-disable-line no-undef
  }
  function pill(label, tone = 'neutral') {
    return `<span class="atlas-pill atlas-pill--${attr(tone)}">${escapeHtml(label)}</span>`;
  }
  function alertMarkup({ tone = 'danger', title = '', body = '', action = '' }) {
    const icon = tone === 'danger' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : tone === 'positive' ? 'circle-check' : 'info';
    return `<div class="atlas-alert atlas-alert--${tone}"${tone === 'danger' ? ' role="alert"' : ''}><i data-lucide="${icon}"></i><div class="atlas-alert__content">${title ? `<p class="atlas-alert__title">${escapeHtml(title)}</p>` : ''}${body ? `<p class="atlas-alert__body">${escapeHtml(body)}</p>` : ''}</div>${action ? `<div class="atlas-alert__actions">${action}</div>` : ''}</div>`;
  }
  function emptyMarkup({ icon = 'inbox', title, text = '', action = '' }) {
    return `<div class="atlas-empty"><div class="atlas-empty__icon"><i data-lucide="${icon}"></i></div><h3 class="atlas-empty__title">${escapeHtml(title)}</h3>${text ? `<p class="atlas-empty__text">${escapeHtml(text)}</p>` : ''}${action ? `<div class="atlas-empty__actions">${action}</div>` : ''}</div>`;
  }
  function skeletonRows(count = 6) {
    return `<div class="data-skeleton" aria-busy="true" aria-label="Loading">${Array.from({ length: count }, () => '<span class="atlas-skel atlas-skel--row"></span>').join('')}</div>`;
  }
  function retryButton(action) {
    return `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-data-retry="${attr(action)}">Try again</button>`;
  }
  function toast(message) { root.AtlasShell?.toast?.(message); }

  // Errors never show raw server text; known refusals get plain words.
  const REFUSALS = {
    stale_request: 'This request changed after you opened it. It has been reloaded — check it and decide again.',
    open_purchase_order: 'The duplicate is on an open purchase order. Receive or edit that order first.',
    open_count: 'The duplicate has an unfinished stock count. Finish or cancel that count first.',
    stock_on_duplicate: 'The duplicate still has counted stock. Count it to zero first.',
    duplicate_suspected: 'This new item looks like an existing item. Merge it into that item or reject the request.',
    duplicate_identity: 'An identical active item already exists. Reject this request or merge it into that item.',
    code_conflict: 'This code already belongs to another active item.',
    alias_conflict: 'This name is already used by another item.',
    invalid_code: 'This barcode or code is not valid.',
    forbidden: 'Your role can\'t make this change. Ask an administrator.',
    not_found: 'This record no longer exists. The list has been refreshed.',
    append_only: 'This change can\'t be edited after it was recorded.'
  };
  function friendlyError(error, fallback) {
    if (error?.code && REFUSALS[error.code]) return REFUSALS[error.code];
    if (error?.status === 401) return 'Your session has ended. Sign in again, then try again.';
    if (error?.status === 403 || error?.code === '42501') return 'Your role can\'t do this. Ask an administrator for access.';
    if (error?.name === 'AbortError' || error?.timeout) return `${fallback} The connection timed out. Nothing was changed.`;
    return fallback;
  }

  async function accessToken() {
    const supabase = client();
    if (!supabase?.auth) throw Object.assign(new Error('offline'), { status: 0 });
    const { data, error } = await supabase.auth.getSession();
    if (error || !data?.session?.access_token) throw Object.assign(new Error('session'), { status: 401 });
    return data.session.access_token;
  }

  // Edge Function call. Throws { status, code } without exposing server text.
  async function edge(endpoint, action, { method = 'GET', params = {}, body = null, timeout = 30000 } = {}) {
    if (!endpoint) throw Object.assign(new Error('not configured'), { status: 404, code: 'not_configured' });
    const url = new URL(endpoint);
    if (action) url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => { if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value)); });
    const token = await accessToken();
    const controller = new AbortController();
    const timer = root.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: body ? JSON.stringify(method === 'POST' && action && !body.action ? { action, ...body } : body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('request failed'), { status: response.status, code: payload?.code || null });
      return payload;
    } finally {
      root.clearTimeout(timer);
    }
  }

  async function rpc(name, args) {
    const supabase = client();
    if (!supabase?.rpc) throw Object.assign(new Error('offline'), { status: 0 });
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw Object.assign(new Error('rpc failed'), { status: error.status || 400, code: error.code || null });
    return data;
  }

  // ---------- data loading ----------

  function issueCount(code) {
    const issue = (state.summary?.issues || []).find((entry) => entry.code === code);
    return issue ? Number(issue.count) || 0 : null;
  }
  function recordIssueTotal() {
    if (!state.summary?.issues) return null;
    return state.summary.issues.filter((entry) => entry.code !== 'catalog.pending_approval').reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
  }

  async function loadSummary({ force = false } = {}) {
    if (!isManager() || state.summaryLoading) return;
    if (!force && state.summary && Date.now() - state.summaryAt < 30000) return;
    state.summaryLoading = true;
    try {
      state.summary = await rpc('atlas_data_review_summary', {});
      state.summaryError = null;
      state.summaryAt = Date.now();
    } catch (error) {
      state.summaryError = error;
    } finally {
      state.summaryLoading = false;
      syncBadge();
      contributeChanged();
      if (visible()) render();
    }
  }

  async function loadImports({ quiet = false } = {}) {
    if (state.imports.loading) return;
    state.imports.loading = true;
    if (!quiet && visible()) render();
    try {
      const supabase = client();
      if (!supabase) throw Object.assign(new Error('offline'), { status: 0 });
      const { data, error } = await supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw Object.assign(new Error('load'), { status: error.status || 400 });
      state.imports.rows = Array.isArray(data) ? data : [];
      state.imports.error = null;
    } catch (error) {
      state.imports.error = error;
    } finally {
      state.imports.loading = false;
      state.imports.loaded = true;
      if (visible()) render();
    }
  }

  async function loadIssueRows() {
    const code = state.issues.code;
    if (!code) return;
    state.issues.loading = true;
    render();
    try {
      const payload = await rpc('atlas_data_review_rows', { p_issue: code, p_limit: PAGE, p_offset: state.issues.offset });
      if (state.issues.code !== code) return;
      state.issues.rows = Array.isArray(payload?.rows) ? payload.rows : [];
      state.issues.total = Number(payload?.total) || 0;
      state.issues.error = null;
    } catch (error) {
      state.issues.error = error;
      state.issues.rows = [];
    } finally {
      state.issues.loading = false;
      render();
    }
  }

  async function loadPars({ cover = null } = {}) {
    state.pars.loading = true;
    state.pars.error = null;
    render();
    try {
      const payload = await rpc('atlas_par_level_evidence', { p_item_ids: null, p_cover_days: cover });
      state.pars.items = Array.isArray(payload?.items) ? payload.items : [];
      state.pars.rule = payload?.rule || null;
      state.pars.coverApplied = cover;
    } catch (error) {
      state.pars.error = error;
    } finally {
      state.pars.loading = false;
      render();
    }
  }

  async function loadReviewSummary() {
    try {
      state.review.summary = await edge(cfg.SPRINT3_REVIEW_API, 'summary');
    } catch {
      state.review.summary = null;
    }
  }

  async function loadReviewRows() {
    state.review.loading = true;
    render();
    try {
      const query = state.review.batch ? `csv:${state.review.batch}` : state.review.query;
      const payload = await edge(cfg.SPRINT3_REVIEW_API, 'rows', {
        params: { scope: state.review.scope, status: state.review.status, q: query, limit: PAGE, offset: state.review.offset }
      });
      state.review.rows = Array.isArray(payload?.rows) ? payload.rows : [];
      state.review.total = Number(payload?.total) || 0;
      state.review.error = null;
    } catch (error) {
      state.review.error = error;
      state.review.rows = [];
    } finally {
      state.review.loading = false;
      render();
    }
  }

  async function loadQueue() {
    state.queue.loading = true;
    render();
    try {
      const payload = await edge(cfg.ITEM_MASTER_API, 'catalog-queue', {
        params: { status: state.queue.status, kind: state.queue.kind, limit: 100, offset: 0 }
      });
      const queue = payload?.queue || {};
      state.queue.rows = Array.isArray(queue.rows) ? queue.rows : [];
      state.queue.counts = queue.counts || {};
      state.queue.total = Number(queue.total) || 0;
      state.queue.error = null;
    } catch (error) {
      state.queue.error = error;
      state.queue.rows = [];
    } finally {
      state.queue.loading = false;
      state.queue.loaded = true;
      render();
    }
  }

  // ---------- nav badge + Home attention ----------

  function pendingApprovals() {
    return issueCount('catalog.pending_approval');
  }

  function syncBadge() {
    const count = isManager() ? pendingApprovals() : null;
    root.document?.querySelectorAll('[data-nav-badge="data"]').forEach((badge) => {
      badge.hidden = !count;
      badge.textContent = count ? String(count) : '';
    });
    const link = root.document?.querySelector('.atlas-sidebar .nav-item[data-nav-id="data"]');
    if (link) link.setAttribute('aria-label', count ? `Data, ${plural(count, 'change', 'changes')} waiting for approval` : 'Data');
  }

  function contributeChanged() {
    root.AtlasShell?.emit?.('notify:changed', { source: 'home:data' });
    if (root.AtlasShell?.current?.() === 'dashboard') root.AtlasShell?.renderHome?.('data');
  }

  function focusRows() {
    if (!isManager()) return [];
    const count = pendingApprovals();
    if (!count) return [];
    return [{
      id: 'catalog-approvals',
      severity: 'info',
      icon: 'badge-check',
      roles: MANAGERS,
      title: `${plural(count, 'catalogue change', 'catalogue changes')} ${count === 1 ? 'is' : 'are'} waiting for your approval`,
      detail: 'New names, barcodes, items and duplicates from scans, imports and Atlas AI',
      action: { label: 'Review', route: '#data/approvals' }
    }];
  }

  // ---------- markup: page ----------

  function visible() {
    return Boolean(state.root && root.AtlasShell?.current?.() === 'data');
  }

  function headSub() {
    const parts = [];
    if (state.imports.loaded && !state.imports.error) {
      const attention = state.imports.rows.filter(needsAttention).length;
      parts.push(attention ? `${plural(attention, 'import needs', 'imports need')} attention` : 'No imports need attention');
    }
    const issues = recordIssueTotal();
    if (issues !== null) parts.push(plural(issues, 'record issue', 'record issues'));
    const pending = pendingApprovals();
    if (pending) parts.push(`${pending} waiting for approval`);
    return parts.join(' · ') || 'Imports, record issues, par levels and approvals';
  }

  function tabsMarkup() {
    const counts = {
      issues: recordIssueTotal(),
      'import-review': number(state.review.summary?.totals?.pending),
      approvals: pendingApprovals()
    };
    const current = state.tab === 'import' ? 'imports' : state.tab;
    return `<nav class="atlas-tabs data-tabs" aria-label="Data sections">${TABS.map(([key, label]) => {
      const count = counts[key];
      const href = key === 'imports' ? '#data' : `#data/${key}`;
      return `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${escapeHtml(label)}${count ? ` <span class="count">${count}</span>` : ''}</a>`;
    }).join('')}</nav>`;
  }

  function permissionMarkup() {
    return `${root.AtlasShell.pageHead({ title: 'Data' })}
      ${emptyMarkup({ icon: 'lock', title: 'Data is for managers', text: 'Ask an administrator for access.', action: '<a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a>' })}`;
  }

  function bodyMarkup() {
    switch (state.tab) {
      case 'import': return importDetailMarkup();
      case 'issues': return issuesMarkup();
      case 'pars': return parsMarkup();
      case 'import-review': return reviewMarkup();
      case 'approvals': return queueMarkup();
      default: return importsMarkup();
    }
  }

  function render() {
    if (!state.root) return;
    const activeElement = root.document.activeElement;
    const focusKey = activeElement && state.root.contains(activeElement) ? activeElement.getAttribute('data-focus-key') : null;
    const caret = focusKey && typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null;
    if (!isManager()) {
      state.root.innerHTML = `<div class="atlas-page data-page">${permissionMarkup()}</div>`;
      icons();
      return;
    }
    state.root.innerHTML = `<div class="atlas-page data-page${state.tab === 'import' ? ' is-detail' : ''}">
      ${root.AtlasShell.pageHead({ title: 'Data', sub: headSub(), actions: [{ label: 'Import a file', icon: 'upload', variant: 'primary', attrs: { 'data-data-upload': '' } }] })}
      ${tabsMarkup()}
      <div class="data-body">${bodyMarkup()}</div>
    </div>`;
    if (focusKey) {
      const target = state.root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (target) {
        target.focus({ preventScroll: true });
        if (caret !== null && typeof target.setSelectionRange === 'function') { try { target.setSelectionRange(caret, caret); } catch { /* number inputs */ } }
      }
    }
    icons();
  }

  // ---------- Imports ----------

  function stageOf(batch) {
    if (batch.status === 'failed' || batch.status === 'cancelled') return batch.status;
    if (COMPLETE.has(batch.status)) return 'complete';
    return batch.current_stage || batch.status || 'uploaded';
  }
  // Import processing stays fail-closed until its activation gate: the worker
  // is used only when IMPORT_WORKER_API is exactly this project's
  // atlas-import-worker (production ships it empty).
  function workerEndpoint() {
    const target = String(cfg.SUPABASE_URL || '').replace(/\/$/, '');
    return cfg.SUPABASE_URL === target && cfg.IMPORT_WORKER_API === `${target}/functions/v1/atlas-import-worker` ? cfg.IMPORT_WORKER_API : '';
  }
  function workerStatus(batch) {
    return batch?.record_counts?.worker === 'atlas-csv-1' ? batch.record_counts.processing_status : null;
  }
  function needsAttention(batch) {
    return batch.status === 'failed' || batch.status === 'ready' || workerStatus(batch) === 'staged';
  }
  function importStatus(batch) {
    const stage = stageOf(batch);
    if (stage === 'failed') return ['Failed', 'danger'];
    if (stage === 'cancelled') return ['Cancelled', 'neutral'];
    if (stage === 'complete') return ['Imported', 'positive'];
    if (batch.status === 'ready' || workerStatus(batch) === 'staged') return ['Needs review', 'warning'];
    if (['reading', 'extracting', 'matching', 'importing'].includes(stage) || workerStatus(batch) === 'claimed') return ['Reading', 'info'];
    if (stage === 'uploading' || batch.status === 'prepared') return ['Uploading', 'info'];
    return ['Uploaded', 'neutral'];
  }
  function sourceName(batch) {
    return batch.file_name || batch.source_files?.[0] || 'Untitled file';
  }
  function scopeLabel(scope) {
    return (SCOPES.find(([key]) => key === scope) || [null, scope ? String(scope).replace(/_/g, ' ') : 'Inventory and stock counts'])[1];
  }
  function recordCount(batch) {
    const counts = batch?.record_counts;
    if (!counts || typeof counts !== 'object') return null;
    for (const key of ['rows', 'records', 'total', 'staged_rows', 'row_count']) {
      const value = number(counts[key]);
      if (value !== null) return value;
    }
    return null;
  }
  function uploadedBy(batch) {
    const me = profile();
    if (me && batch.created_by && batch.created_by === me.id) return 'You';
    return null;
  }
  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function filteredImports() {
    const query = state.imports.query.trim().toLowerCase();
    return state.imports.rows
      .filter((batch) => {
        if (state.imports.filter === 'attention' && !needsAttention(batch)) return false;
        if (state.imports.filter === 'imported' && !COMPLETE.has(batch.status)) return false;
        if (!query) return true;
        return [sourceName(batch), scopeLabel(batch.entity_scope), importStatus(batch)[0]].join(' ').toLowerCase().includes(query);
      })
      .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  }

  function importsMarkup() {
    const imports = state.imports;
    if (imports.error && !imports.rows.length) {
      return alertMarkup({ title: 'Imports couldn\'t be loaded.', body: friendlyError(imports.error, 'Your files and live records are safe. Try again.'), action: retryButton('imports') });
    }
    if (!imports.loaded || (imports.loading && !imports.rows.length)) return skeletonRows();
    if (!imports.rows.length) {
      return emptyMarkup({ icon: 'file-up', title: 'No imports yet', text: 'Upload a spreadsheet, invoice or stock count. Nothing changes live records until you review it.', action: '<button type="button" class="atlas-btn atlas-btn--secondary" data-data-upload><i data-lucide="upload"></i>Import a file</button>' });
    }
    const rows = filteredImports();
    const segmented = [['all', 'All'], ['attention', 'Needs attention'], ['imported', 'Imported']]
      .map(([key, label]) => `<button type="button" aria-pressed="${state.imports.filter === key}" data-data-import-filter="${key}">${label}</button>`).join('');
    const table = rows.length ? `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table">
        <thead><tr><th>File</th><th data-priority="2">Contains</th><th>Status</th><th class="is-num" data-priority="3">Records</th><th data-priority="3">Uploaded by</th><th>When</th></tr></thead>
        <tbody>${rows.map((batch) => {
          const [label, tone] = importStatus(batch);
          const records = recordCount(batch);
          const by = uploadedBy(batch);
          return `<tr><td><a class="cell-primary" href="#data/import/${attr(encodeURIComponent(batch.id))}">${escapeHtml(sourceName(batch))}</a><span class="cell-sub">${escapeHtml(formatBytes(batch.file_size))}</span></td>
            <td data-priority="2">${escapeHtml(scopeLabel(batch.entity_scope))}</td>
            <td>${pill(label, tone)}</td>
            <td class="is-num" data-priority="3">${records === null ? '<span title="Not read yet">—</span>' : escapeHtml(records)}</td>
            <td data-priority="3">${by ? escapeHtml(by) : '<span title="Uploader name is not loaded on this page">—</span>'}</td>
            <td>${escapeHtml(formatRelative(batch.created_at))}</td></tr>`;
        }).join('')}</tbody></table></div>
      <ul class="atlas-table-list">${rows.map((batch) => {
        const [label, tone] = importStatus(batch);
        return `<li><a class="atlas-table-list__row" href="#data/import/${attr(encodeURIComponent(batch.id))}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${escapeHtml(sourceName(batch))}</div><div class="atlas-table-list__meta">${escapeHtml(scopeLabel(batch.entity_scope))} · ${escapeHtml(formatRelative(batch.created_at))}</div></div><div class="atlas-table-list__value">${pill(label, tone)}</div></a></li>`;
      }).join('')}</ul>
      <div class="atlas-table-foot"><span>${plural(rows.length, 'file', 'files')}</span><span>Files stay private to managers. Nothing changes live records until you review it.</span></div>`
      : emptyMarkup({ icon: 'search-x', title: `No files match “${state.imports.query || 'this filter'}”`, action: '<button type="button" class="atlas-btn atlas-btn--secondary" data-data-clear-imports>Clear filters</button>' });
    return `${imports.error ? alertMarkup({ tone: 'warning', title: 'The list couldn\'t be refreshed.', body: 'Showing the last loaded files.' }) : ''}
      <div class="atlas-toolbar">
        <label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" placeholder="Search files" aria-label="Search files" value="${attr(state.imports.query)}" data-data-import-search data-focus-key="import-search"></label>
        <div class="atlas-segmented" role="group" aria-label="Show">${segmented}</div>
        <div class="atlas-toolbar__end">${plural(state.imports.rows.length, 'file', 'files')}</div>
      </div>
      ${table}`;
  }

  // ---------- Import detail ----------

  function importDetailMarkup() {
    const batch = state.imports.rows.find((entry) => String(entry.id) === String(state.params.batch));
    const back = '<a class="atlas-btn atlas-btn--ghost atlas-btn--sm data-back" href="#data"><i data-lucide="arrow-left"></i>All imports</a>';
    if (!batch) {
      if (!state.imports.loaded || state.imports.loading) return `${back}${skeletonRows(4)}`;
      return `${back}${emptyMarkup({ icon: 'file-x', title: 'This import no longer exists', text: 'It may have been deleted. The list of imports is up to date.', action: '<a class="atlas-btn atlas-btn--secondary" href="#data">All imports</a>' })}`;
    }
    const [label, tone] = importStatus(batch);
    const stage = stageOf(batch);
    const worker = workerStatus(batch);
    const busy = state.imports.busy.has(batch.id);
    const uploaded = !['prepared', 'uploading'].includes(stage);
    const reviewed = COMPLETE.has(batch.status);
    const step = (done, current, n, text) => `<li class="${done ? 'is-done' : current ? 'is-current' : ''}"${current ? ' aria-current="step"' : ''}><span class="n">${done ? '<i data-lucide="check"></i>' : n}</span>${text}</li>`;
    const steps = `<ol class="atlas-steps" aria-label="Import progress">
        ${step(uploaded, !uploaded, 1, 'Upload')}<li class="sep" aria-hidden="true"></li>
        ${step(reviewed, uploaded && !reviewed, 2, 'Review')}<li class="sep" aria-hidden="true"></li>
        ${step(reviewed, false, 3, 'Import')}
      </ol>`;
    const actions = [];
    const workerOn = Boolean(workerEndpoint());
    if (workerOn && !worker && batch.status === 'uploaded' && batch.entity_scope === 'inventory' && String(batch.file_extension || '').toLowerCase() === 'csv') actions.push(['stage', 'play', 'Read this file', 'primary']);
    if (workerOn && worker === 'claimed') actions.push(['stage', 'play', 'Continue reading', 'primary']);
    if (worker === 'staged' || batch.status === 'ready') actions.push(['review', 'list-checks', 'Review rows', worker === 'staged' ? 'secondary' : 'primary']);
    if (workerOn && worker === 'staged') actions.push(['promote', 'check-check', 'Import approved rows', 'primary']);
    if (workerOn && ['staged', 'claimed'].includes(worker)) actions.push(['discard', 'undo-2', 'Discard reading', 'ghost']);
    if (!worker && (batch.status === 'failed' || batch.status === 'cancelled')) actions.push(['retry', 'rotate-ccw', 'Try again', 'secondary']);
    if (batch.storage_bucket && batch.storage_path) actions.push(['source', 'download', 'Download file', 'ghost']);
    if (!worker && !TERMINAL.has(batch.status) && batch.status !== 'ready') actions.push(['cancel', 'circle-x', 'Cancel import', 'ghost']);
    if (!worker) actions.push(['delete', 'trash-2', 'Delete import', 'danger']);
    const buttons = actions.map(([action, icon, text, variant]) => `<button type="button" class="atlas-btn atlas-btn--${variant}" data-data-batch-action="${action}" data-batch-id="${attr(batch.id)}"${busy ? ' disabled aria-busy="true"' : ''}><i data-lucide="${icon}"></i>${text}</button>`).join('');
    const records = recordCount(batch);
    const failure = batch.status === 'failed'
      ? alertMarkup({ title: 'Atlas couldn\'t read this file.', body: 'Your live records were not changed. Try again, or upload a corrected file — spreadsheets work best as CSV with one product per row.', action: '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-data-upload>Upload a corrected file</button>' })
      : '';
    return `${back}
      <section class="atlas-section data-import-detail" aria-labelledby="data-import-title">
        <div class="atlas-section__head"><h2 class="atlas-section__title" id="data-import-title">${escapeHtml(sourceName(batch))}</h2>${pill(label, tone)}</div>
        ${steps}
        ${failure}
        <dl class="data-facts">
          <div><dt>Contains</dt><dd>${escapeHtml(scopeLabel(batch.entity_scope))}</dd></div>
          <div><dt>Size</dt><dd>${escapeHtml(formatBytes(batch.file_size))}</dd></div>
          <div><dt>Records</dt><dd>${records === null ? 'Not read yet' : escapeHtml(records)}</dd></div>
          <div><dt>Uploaded</dt><dd>${escapeHtml(formatDateTime(batch.created_at))}</dd></div>
          <div><dt>Last change</dt><dd>${escapeHtml(formatDateTime(batch.updated_at || batch.created_at))}</dd></div>
        </dl>
        ${worker === 'staged' ? alertMarkup({ tone: 'info', body: 'Review every row before importing. Only approved new items are added; their quantities are added once.' }) : ''}
        <div class="atlas-btn-group data-actions">${buttons}</div>
      </section>`;
  }

  async function updateBatch(id, payload, message) {
    const { data, error } = await client().from('import_batches').update(payload).eq('id', id).select('*').single();
    if (error) throw Object.assign(new Error('update'), { status: error.status || 400 });
    state.imports.rows = state.imports.rows.map((batch) => (batch.id === id ? data : batch));
    if (message) toast(message);
    render();
  }

  async function batchAction(action, id) {
    const batch = state.imports.rows.find((entry) => String(entry.id) === String(id));
    if (!batch || state.imports.busy.has(batch.id)) return;
    try {
      if (action === 'review') {
        root.AtlasShell.navigate(`#data/import-review?batch=${encodeURIComponent(batch.id)}`);
        return;
      }
      if (action === 'source') { await downloadSource(batch); return; }
      if (action === 'retry') {
        await updateBatch(batch.id, { status: 'uploaded', current_stage: 'uploaded', progress_percent: 100, last_error: null, completed_at: null, started_at: null }, 'The file is back in the queue.');
        return;
      }
      if (action === 'cancel') {
        if (!await confirmDialog({ title: `Cancel ${sourceName(batch)}?`, body: 'Atlas stops reading this file. The file is kept so you can delete it or try again.', confirm: 'Cancel import', keep: 'Keep importing' })) return;
        await updateBatch(batch.id, { status: 'cancelled', current_stage: 'cancelled', last_error: 'Cancelled by a manager.' }, 'Import cancelled.');
        return;
      }
      if (action === 'delete') {
        if (!await confirmDialog({ title: `Delete ${sourceName(batch)}?`, body: 'The uploaded file and its import record are removed. Live records are not changed. This can\'t be undone.', confirm: 'Delete import', keep: 'Keep file', danger: true })) return;
        state.imports.busy.add(batch.id);
        render();
        const supabase = client();
        if (batch.storage_bucket && batch.storage_path) {
          const { error: storageError } = await supabase.storage.from(batch.storage_bucket).remove([batch.storage_path]);
          if (storageError && storageError.statusCode !== 404) throw Object.assign(new Error('storage'), { status: 400 });
        }
        const { error } = await supabase.from('import_batches').delete().eq('id', batch.id);
        if (error) throw Object.assign(new Error('delete'), { status: error.status || 400 });
        state.imports.rows = state.imports.rows.filter((entry) => entry.id !== batch.id);
        state.imports.busy.delete(batch.id);
        toast('Import deleted.');
        if (root.location.hash !== '#data') root.location.hash = '#data';
        return;
      }
      if (['stage', 'promote', 'discard'].includes(action)) {
        if (action === 'promote' && !await confirmDialog({ title: 'Import approved rows?', body: `Approved new items from ${sourceName(batch)} are added to Inventory and their quantities are added once.`, confirm: 'Import approved rows', keep: 'Not now' })) return;
        if (action === 'discard' && !await confirmDialog({ title: 'Discard this reading?', body: 'Unimported rows and their review decisions are removed. The uploaded file stays so you can read it again or delete it.', confirm: 'Discard reading', keep: 'Keep', danger: true })) return;
        state.imports.busy.add(batch.id);
        render();
        const result = await edge(workerEndpoint(), null, { method: 'POST', body: { action, batch_id: batch.id } });
        state.imports.busy.delete(batch.id);
        await loadImports({ quiet: true });
        toast(result?.status === 'promoted' ? 'Approved rows imported.' : result?.status === 'discarded' ? 'Reading discarded.' : 'File read. Review every row before importing.');
      }
    } catch (error) {
      state.imports.busy.delete(batch.id);
      render();
      showError(friendlyError(error, 'That didn\'t work. Your live records were not changed. Try again.'));
    }
  }

  async function downloadSource(batch) {
    const { data, error } = await client().storage.from(batch.storage_bucket).createSignedUrl(batch.storage_path, 120);
    if (error || !data?.signedUrl) throw Object.assign(new Error('source'), { status: 400 });
    root.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  // Upload dialog (spec §7.14: file drop + "What does this file contain?").
  function openUpload() {
    const modal = ensureModal('data-upload-modal');
    modal.innerHTML = `<section class="atlas-dialog atlas-dialog--form" data-modal-panel aria-labelledby="data-upload-title">
        <h2 class="atlas-dialog__title" id="data-upload-title">Import a file</h2>
        <form class="atlas-dialog__body atlas-form" data-data-upload-form>
          <div class="atlas-field">
            <label for="data-upload-scope">What does this file contain?</label>
            <select class="atlas-select" id="data-upload-scope" name="scope">${SCOPES.map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join('')}</select>
          </div>
          <label class="atlas-upload data-upload-drop" data-data-drop>
            <span class="atlas-upload__thumb"><i data-lucide="file-up"></i></span>
            <span class="atlas-upload__body"><span class="atlas-upload__title" data-data-file-name>Choose a file or drop it here</span><span class="atlas-upload__help">CSV, Excel, PDF, JSON, text or a photo, up to 50 MB.</span></span>
            <input class="sr-only" type="file" name="file" multiple accept=".pdf,.xlsx,.xls,.csv,.json,.txt,.jpg,.jpeg,.png,.webp,.heic,.heif">
          </label>
          <p class="data-upload-note">Nothing changes live records until you review the file.</p>
          <p class="error" data-data-upload-error hidden></p>
          <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary">Upload</button></div>
        </form>
      </section>`;
    const form = modal.querySelector('form');
    const input = form.querySelector('input[type="file"]');
    const drop = form.querySelector('[data-data-drop]');
    const nameLabel = form.querySelector('[data-data-file-name]');
    let chosen = [];
    const choose = (list) => {
      chosen = [...(list || [])];
      nameLabel.textContent = chosen.length ? chosen.map((file) => file.name).join(', ') : 'Choose a file or drop it here';
    };
    input.addEventListener('change', () => choose(input.files));
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('is-dragover'); }));
    ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('is-dragover'); }));
    drop.addEventListener('drop', (event) => choose(event.dataTransfer?.files));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorLine = form.querySelector('[data-data-upload-error]');
      if (!chosen.length) { errorLine.hidden = false; errorLine.textContent = 'Choose a file first.'; return; }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.classList.add('is-loading');
      submit.setAttribute('aria-busy', 'true');
      const scope = form.elements.scope.value;
      const failures = [];
      let last = null;
      for (const file of chosen) {
        try { last = await uploadOne(file, scope); } catch (error) { failures.push(`${file.name}: ${error.userMessage || 'couldn\'t be uploaded'}`); }
      }
      submit.disabled = false;
      submit.classList.remove('is-loading');
      submit.removeAttribute('aria-busy');
      if (failures.length) {
        errorLine.hidden = false;
        errorLine.textContent = `${failures.join('. ')}. Other files were uploaded.`;
        await loadImports({ quiet: true });
        return;
      }
      root.AtlasModal.close(modal, 'saved');
      toast(chosen.length === 1 ? 'File uploaded.' : `${chosen.length} files uploaded.`);
      await loadImports({ quiet: true });
      if (last && chosen.length === 1) root.AtlasShell.navigate(`#data/import/${encodeURIComponent(last.id)}`);
    });
    root.AtlasModal.open(modal);
    icons();
  }

  function extensionOf(name) {
    const parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }
  function safeFileName(name) {
    return String(name || 'source-file').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 140) || 'source-file';
  }
  function mimeFor(file) {
    if (file.type) return file.type;
    return ({ pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', json: 'application/json', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' })[extensionOf(file.name)] || 'application/octet-stream';
  }

  async function uploadOne(file, scope) {
    const ext = extensionOf(file.name);
    const refuse = (message) => { throw Object.assign(new Error(message), { userMessage: message }); };
    if (!ALLOWED_EXTENSIONS.has(ext)) refuse('this file type isn\'t supported');
    if (file.size > MAX_FILE_SIZE) refuse('it is larger than 50 MB');
    if (!file.size) refuse('the file is empty');
    const supabase = client();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) refuse('your session has ended — sign in again');
    const user = userData.user;
    const batchKey = `upload-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${requestId('batch')}`;
    const { data: batch, error: insertError } = await supabase.from('import_batches').insert({
      batch_key: batchKey, source_files: [file.name], file_name: file.name, file_extension: ext || null,
      mime_type: mimeFor(file), file_size: file.size, entity_scope: scope, status: 'uploaded',
      current_stage: 'uploading', progress_percent: 5, created_by: user.id, record_counts: {},
      notes: 'Uploaded from Atlas Data.'
    }).select('*').single();
    if (insertError || !batch) refuse('Atlas couldn\'t start the upload');
    // Storage path stays in UTC (storage layout, not an operational date).
    const now = new Date();
    const directory = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')].join('/');
    const storagePath = `${user.id}/${directory}/${batch.id}-${safeFileName(file.name)}`;
    try {
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, file, { cacheControl: '3600', upsert: false, contentType: mimeFor(file) });
      if (uploadError) throw uploadError;
      const { data: updated, error: updateError } = await supabase.from('import_batches').update({ status: 'uploaded', current_stage: 'uploaded', progress_percent: 100, storage_bucket: BUCKET, storage_path: storagePath, last_error: null }).eq('id', batch.id).select('*').single();
      if (updateError) throw updateError;
      return updated || batch;
    } catch {
      await supabase.from('import_batches').update({ status: 'failed', current_stage: 'failed', last_error: 'Upload failed.' }).eq('id', batch.id);
      refuse('the upload didn\'t finish');
    }
    return batch;
  }

  // ---------- Issues ----------

  function issueDetail(code, row) {
    const detail = row.detail || {};
    switch (code) {
      case 'inventory.missing_supplier':
        return detail.supplier_text ? `Supplier typed as “${detail.supplier_text}” but not linked` : 'No supplier';
      case 'inventory.supplier_text_unlinked': return `“${detail.supplier_text || ''}” isn't linked to a supplier`;
      case 'inventory.missing_cost': return 'No unit or case cost';
      case 'inventory.missing_reference': return 'No SKU, barcode or supplier reference';
      case 'inventory.package_missing': return 'No package size';
      case 'inventory.package_unreadable': return `Package “${detail.package_size || ''}” can't be read`;
      case 'inventory.missing_par': return detail.unit ? `Counted in ${detail.unit}` : 'No par level';
      case 'inventory.flagged_needs_review': return 'Flagged for review when it was imported';
      case 'recipe.missing_price': return 'No menu price';
      case 'recipe.no_ingredients': return 'No ingredients';
      case 'recipe.ingredient_unlinked': return `${detail.ingredient_name || 'An ingredient'} isn't linked to an item`;
      case 'recipe.ingredient_inactive_item': return `${detail.ingredient_name || 'An ingredient'} uses ${detail.item_name || 'an item'}, which is inactive`;
      case 'inventory.possible_duplicate': {
        const score = number(detail.score);
        return `Looks like ${detail.other_item_name || 'another item'}${detail.code_collision ? ' (same barcode or code)' : score !== null ? ` (${Math.round(score * 100)} % match)` : ''}`;
      }
      case 'catalog.code_collision': return `${detail.code ? `Code ${detail.code}` : 'A code'} is also on ${plural((detail.other_item_ids || []).length || 1, 'other item', 'other items')}`;
      case 'inventory.category_unmapped': return `Category “${detail.category || 'none'}” isn't in the product list`;
      case 'catalog.pending_approval': return `${KIND_LABELS[detail.kind] || 'Change'} ${SOURCE_LABELS[detail.source] || ''}${detail.requested_by_label ? ` · ${detail.requested_by_label}` : ''}`.trim();
      default: return '';
    }
  }

  function fixAction(code, row) {
    const id = encodeURIComponent(row.entity_id);
    switch (row.fix) {
      case 'par_levels': return `<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#data/pars?item=${attr(id)}">Set par</a>`;
      case 'recipe': return `<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#recipes/${attr(encodeURIComponent(row.detail?.recipe_id || row.entity_id))}/edit">Edit recipe</a>`;
      case 'catalog_duplicates': return `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-data-resolve-duplicate="${attr(row.entity_id)}" data-other="${attr(row.detail?.other_item_id || '')}">Resolve</button>`;
      case 'catalog_queue': return '<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#data/approvals">Review</a>';
      case 'catalog_codes':
      case 'item_master':
      default: return `<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#inventory/item/${attr(id)}">Open item</a>`;
    }
  }

  function issuesMarkup() {
    if (state.summaryError && !state.summary) {
      return alertMarkup({ title: 'Record issues couldn\'t be loaded.', body: friendlyError(state.summaryError, 'Your records are safe. Try again.'), action: retryButton('summary') });
    }
    if (!state.summary) return skeletonRows();
    const issues = (state.summary.issues || []).filter((entry) => Number(entry.count) > 0);
    if (!issues.length) return emptyMarkup({ icon: 'circle-check', title: 'No record issues', text: 'Every active item and recipe has its supplier, cost, package, par and links in place.' });
    if (!issues.some((entry) => entry.code === state.issues.code)) {
      state.issues.code = issues[0].code;
      state.issues.offset = 0;
      state.issues.rows = [];
      root.setTimeout(loadIssueRows, 0);
    }
    const current = issues.find((entry) => entry.code === state.issues.code);
    const chips = issues.map((entry) => `<button type="button" class="atlas-chip${entry.code === state.issues.code ? ' is-active' : ''}" aria-pressed="${entry.code === state.issues.code}" data-data-issue="${attr(entry.code)}">${escapeHtml(entry.label)} <span class="atlas-badge atlas-badge--muted">${Number(entry.count)}</span></button>`).join('');
    let table;
    if (state.issues.error) table = alertMarkup({ title: `${current.label} couldn't be loaded.`, body: 'Your records are safe. Try again.', action: retryButton('issue-rows') });
    else if (state.issues.loading && !state.issues.rows.length) table = skeletonRows(5);
    else if (!state.issues.rows.length) table = emptyMarkup({ icon: 'circle-check', title: 'Nothing left here', text: 'This issue was fixed since the count was loaded.' });
    else {
      const end = state.issues.offset + state.issues.rows.length;
      table = `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table">
          <thead><tr><th>${current.entity_type === 'inventory_item' ? 'Item' : current.entity_type === 'catalog_change_request' ? 'Request' : 'Recipe'}</th><th data-priority="2">Category</th><th>What's missing</th><th class="col-actions"><span class="sr-only">Fix</span></th></tr></thead>
          <tbody>${state.issues.rows.map((row) => `<tr><td><span class="cell-primary">${escapeHtml(row.name || 'Unnamed')}</span></td><td data-priority="2">${escapeHtml(row.category || '—')}</td><td>${escapeHtml(issueDetail(current.code, row))}</td><td class="col-actions">${fixAction(current.code, row)}</td></tr>`).join('')}</tbody>
        </table></div>
        <ul class="atlas-table-list">${state.issues.rows.map((row) => `<li class="atlas-table-list__row"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${escapeHtml(row.name || 'Unnamed')}</div><div class="atlas-table-list__meta">${escapeHtml(issueDetail(current.code, row))}</div></div><div class="atlas-table-list__value">${fixAction(current.code, row)}</div></li>`).join('')}</ul>
        <div class="atlas-table-foot"><span>${state.issues.offset + 1}–${end} of ${state.issues.total}</span><span class="atlas-btn-group">${state.issues.offset > 0 ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-data-issue-page="-1">Previous</button>' : ''}${end < state.issues.total ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-data-issue-page="1">Next</button>' : ''}</span></div>`;
    }
    return `<div class="atlas-chips data-issue-chips" role="group" aria-label="Issue types">${chips}</div>
      <p class="data-caption">Counts refresh when you come back after fixing a record.</p>
      ${table}`;
  }

  // Duplicate resolution (inventory.possible_duplicate): a manager decision,
  // recorded as a self-approved catalogue request so it is audited.
  function openDuplicate(itemId, otherId) {
    const row = state.issues.rows.find((entry) => String(entry.entity_id) === String(itemId));
    const itemName = row?.name || 'This item';
    const otherName = row?.detail?.other_item_name || 'the other item';
    const modal = ensureModal('data-duplicate-modal');
    modal.innerHTML = `<section class="atlas-sheet atlas-sheet--wide" data-modal-panel aria-labelledby="data-dup-title">
        <span class="atlas-sheet__grabber"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="data-dup-title">Possible duplicate</h2><p class="atlas-sheet__desc">${escapeHtml(itemName)} and ${escapeHtml(otherName)}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header>
        <form class="atlas-sheet__body atlas-form" data-data-dup-form>
          <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">What are they?</legend>
            <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="mode" value="retire_into" checked>The same product — keep one, retire the other</label>
            <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="mode" value="not_duplicates">Different products — stop suggesting this pair</label>
            <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="mode" value="different_pack">Same product in a different pack size</label>
          </fieldset>
          <div class="atlas-field" data-show-mode="retire_into">
            <label for="data-dup-keep">Keep</label>
            <select class="atlas-select" id="data-dup-keep" name="keep"><option value="${attr(itemId)}">${escapeHtml(itemName)}</option><option value="${attr(otherId)}">${escapeHtml(otherName)}</option></select>
            <p class="help">The other item is retired. Its counts and movements stay on it for the record; stock is never moved.</p>
          </div>
          <div class="atlas-grid-2" data-show-mode="different_pack" hidden>
            <div class="atlas-field"><label for="data-dup-size">Pack size of ${escapeHtml(otherName)}</label><input class="atlas-input" id="data-dup-size" name="size" inputmode="decimal"></div>
            <div class="atlas-field"><label for="data-dup-base">Unit</label><select class="atlas-select" id="data-dup-base" name="base"><option value="ml">ml</option><option value="g">g</option><option value="each">each</option></select></div>
          </div>
          <div class="atlas-field"><label for="data-dup-reason">Reason <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="data-dup-reason" name="reason" maxlength="500" rows="2"></textarea></div>
          <p class="error" data-data-dup-error hidden></p>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-data-dup-save>Save decision</button></footer>
      </section>`;
    const form = modal.querySelector('form');
    const sync = () => {
      const mode = form.elements.mode.value;
      form.querySelectorAll('[data-show-mode]').forEach((element) => { element.hidden = element.dataset.showMode !== mode; });
    };
    form.addEventListener('change', sync);
    modal.querySelector('[data-data-dup-save]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const errorLine = form.querySelector('[data-data-dup-error]');
      const mode = form.elements.mode.value;
      const keep = mode === 'retire_into' ? form.elements.keep.value : itemId;
      const retire = keep === itemId ? otherId : itemId;
      const reason = form.elements.reason.value.trim();
      const resolution = { mode, reason: reason || null };
      if (mode === 'different_pack') {
        const size = number(form.elements.size.value);
        if (size === null || size <= 0) { errorLine.hidden = false; errorLine.textContent = 'Enter the pack size of the other item.'; return; }
        resolution.values = { unit_size_quantity: size, unit_size_base: form.elements.base.value };
      }
      button.disabled = true;
      button.classList.add('is-loading');
      try {
        const payload = await edge(cfg.ITEM_MASTER_API, 'catalog-request', {
          method: 'POST',
          body: { kind: 'duplicate_resolution', subject_item_id: keep, source: 'data_review', self_approve: true, request_id: requestId('dup'), payload: { keep_item_id: keep, retire_item_id: retire, mode, reason: reason || null, resolution } }
        });
        const status = payload?.request?.status;
        root.AtlasModal.close(modal, 'saved');
        toast(status === 'failed' ? 'The decision was recorded but couldn\'t be applied. Check it in Waiting for approval.' : 'Decision saved.');
        state.summaryAt = 0;
        await loadSummary({ force: true });
        loadIssueRows();
      } catch (error) {
        errorLine.hidden = false;
        errorLine.textContent = friendlyError(error, 'The decision couldn\'t be saved. Nothing was changed. Try again.');
      } finally {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    });
    root.AtlasModal.open(modal);
    icons();
  }

  // ---------- Par levels ----------

  function onHand(itemId) {
    const item = shellItems().find((entry) => String(entry.id) === String(itemId));
    if (!item) return { text: '—', known: false };
    const known = root.AtlasStockTruth?.known ? root.AtlasStockTruth.known(item) : item.freshness_state === 'current';
    return known ? { text: formatQuantity(item.verified_quantity ?? item.quantity), known: true } : { text: 'Not counted', known: false };
  }
  function supplierOf(itemId) {
    const item = shellItems().find((entry) => String(entry.id) === String(itemId));
    if (!item) return '';
    const linked = item.supplier_id ? shellSuppliers().find((entry) => entry.id === item.supplier_id) : null;
    return linked?.name || item.supplier || '';
  }
  const REASONS = {
    insufficient_observations: (row, rule) => `Needs ${rule?.min_observations || 3} counts; has ${row.observations}`,
    unit_changed: () => 'The count unit changed, so counts can\'t be compared',
    span_too_short: (row, rule) => `Counts cover ${Math.round(Number(row.span_days) || 0)} days; needs ${rule?.min_span_days || 14}`,
    inconsistent_evidence: () => 'Counts and deliveries don\'t add up',
    no_usage: () => 'No usage between counts'
  };
  function evidenceText(row) {
    if (!row.eligible) return (REASONS[row.reason] || (() => 'Not enough evidence yet'))(row, state.pars.rule);
    const usage = number(row.avg_daily_usage);
    return `${plural(row.observations, 'count', 'counts')} over ${Math.round(Number(row.span_days) || 0)} days · about ${formatQuantity(usage)} ${escapeHtml(row.unit || '')} a day`;
  }

  function parRows() {
    const items = state.pars.items || [];
    const query = state.pars.query.trim().toLowerCase();
    return items.filter((row) => {
      if (state.pars.category && (row.category || 'Uncategorised') !== state.pars.category) return false;
      if (state.pars.supplier && supplierOf(row.item_id) !== state.pars.supplier) return false;
      if (query && !`${row.name} ${row.category || ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function pendingParChanges() {
    const items = new Map((state.pars.items || []).map((row) => [String(row.item_id), row]));
    const changes = [];
    let invalid = 0;
    state.pars.edits.forEach((value, itemId) => {
      const row = items.get(itemId);
      if (!row) return;
      const text = String(value).trim();
      if (text === '') return;
      const next = number(text.replace(',', '.'));
      if (next === null || next < 0) { invalid += 1; return; }
      if (next === number(row.par_level)) return;
      changes.push({ row, next });
    });
    return { changes, invalid };
  }

  function parsFooterMarkup() {
    const { changes, invalid } = pendingParChanges();
    if (!changes.length && !invalid) return '';
    return `<div class="atlas-bulkbar atlas-bulkbar--sticky data-par-bar" role="region" aria-label="Unsaved par levels">
        <span>${invalid ? `${plural(invalid, 'value needs', 'values need')} fixing` : `${plural(changes.length, 'change', 'changes')} not saved`}</span><span class="atlas-bulkbar__sep"></span>
        <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-data-par-discard>Discard</button>
        <button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" data-data-par-save${invalid || !changes.length || state.pars.saving ? ' disabled' : ''}${state.pars.saving ? ' aria-busy="true"' : ''}>Save ${plural(changes.length, 'change', 'changes')}</button>
      </div>`;
  }

  function parsMarkup() {
    const pars = state.pars;
    if (pars.error && !pars.items) return alertMarkup({ title: 'Par levels couldn\'t be loaded.', body: friendlyError(pars.error, 'Nothing was changed. Try again.'), action: retryButton('pars') });
    if (!pars.items) return skeletonRows();
    if (!pars.items.length) return emptyMarkup({ icon: 'package', title: 'No active items', text: 'Add items in Inventory first, then set their par levels here.', action: '<a class="atlas-btn atlas-btn--secondary" href="#inventory">Open Inventory</a>' });
    const categories = [...new Set(pars.items.map((row) => row.category || 'Uncategorised'))].sort((a, b) => a.localeCompare(b));
    const supplierNames = [...new Set(pars.items.map((row) => supplierOf(row.item_id)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const rows = parRows();
    const suggestionsOn = pars.coverApplied !== null;
    const conflicts = pars.conflicts?.length ? alertMarkup({
      tone: 'warning',
      title: `Nothing was saved: ${plural(pars.conflicts.length, 'par level was', 'par levels were')} changed by someone else`,
      body: pars.conflicts.map((entry) => `${entry.name}: you started from ${entry.expected_par_level ?? 'no par'}, it is now ${entry.current_par_level ?? 'no par'}`).join(' · '),
      action: '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-data-par-reload>Load current values</button>'
    }) : '';
    const saveError = pars.saveError ? alertMarkup({ title: 'Par levels couldn\'t be saved.', body: pars.saveError }) : '';
    const table = rows.length ? `<div class="atlas-table-wrap data-par-table"><table class="atlas-table">
        <thead><tr><th>Item</th><th class="is-num" data-priority="2">On hand</th><th class="is-num">Current par</th><th data-priority="2">Suggested par</th><th class="is-num">New par</th></tr></thead>
        <tbody>${rows.map((row) => {
          const id = String(row.item_id);
          const stock = onHand(id);
          const suggestion = row.suggestion && number(row.suggestion.par_level) !== null ? row.suggestion : null;
          const edit = pars.edits.has(id) ? pars.edits.get(id) : '';
          const conflict = pars.conflicts?.some((entry) => String(entry.item_id) === id);
          const suggestionCell = suggestion
            ? `<span class="data-suggestion"><span class="num">${escapeHtml(formatQuantity(suggestion.par_level))}</span>${suggestion.cases ? ` <span class="cell-sub">${plural(Number(suggestion.cases), 'case', 'cases')}</span>` : ''}<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-data-par-use="${attr(id)}" data-value="${attr(suggestion.par_level)}">Use</button></span><span class="cell-sub">${escapeHtml(evidenceText(row))}</span>`
            : `<span class="cell-sub">${row.eligible && !suggestionsOn ? 'Enter days of cover to see a suggestion' : escapeHtml(evidenceText(row))}</span>`;
          return `<tr${pars.focusItem === id ? ' class="is-selected"' : ''}><td><span class="cell-primary">${escapeHtml(row.name)}</span><span class="cell-sub">${escapeHtml([row.category, supplierOf(id)].filter(Boolean).join(' · ') || 'Uncategorised')}</span></td>
            <td class="is-num" data-priority="2">${stock.known ? escapeHtml(stock.text) : `<span class="atlas-pill">${escapeHtml(stock.text)}</span>`}</td>
            <td class="is-num">${row.par_level === null || row.par_level === undefined ? '<span title="No par level set">—</span>' : escapeHtml(formatQuantity(row.par_level))}</td>
            <td data-priority="2">${suggestionCell}</td>
            <td class="is-num"><input class="atlas-input data-par-input" type="text" inputmode="decimal" aria-label="New par for ${attr(row.name)}" value="${attr(edit)}" data-data-par-input="${attr(id)}" data-focus-key="par-${attr(id)}"${conflict ? ' aria-invalid="true"' : ''}></td></tr>`;
        }).join('')}</tbody></table></div>`
      : emptyMarkup({ icon: 'search-x', title: 'No items match these filters', action: '<button type="button" class="atlas-btn atlas-btn--secondary" data-data-par-clear>Clear filters</button>' });
    return `${conflicts}${saveError}
      <div class="atlas-toolbar">
        <label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" placeholder="Search items" aria-label="Search items" value="${attr(pars.query)}" data-data-par-search data-focus-key="par-search"></label>
        <select class="atlas-select data-filter" aria-label="Category" data-data-par-category><option value="">All categories</option>${categories.map((name) => `<option${pars.category === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>
        ${supplierNames.length ? `<select class="atlas-select data-filter" aria-label="Supplier" data-data-par-supplier><option value="">All suppliers</option>${supplierNames.map((name) => `<option${pars.supplier === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>` : ''}
        <form class="data-cover" data-data-cover-form><span class="atlas-affix"><input class="atlas-input" id="data-cover-days" inputmode="decimal" placeholder="Days of cover" aria-label="Days of cover" value="${attr(pars.cover)}" data-focus-key="cover"><span class="suffix">days</span></span><button type="submit" class="atlas-btn atlas-btn--secondary">Suggest pars</button></form>
        <div class="atlas-toolbar__end">${plural(rows.length, 'item', 'items')}</div>
      </div>
      <p class="data-caption">Suggestions use only verified counts and recorded deliveries (at least ${state.pars.rule?.min_observations || 3} counts over ${state.pars.rule?.min_span_days || 14} days). Nothing is saved until you press Save.</p>
      ${table}
      <div data-data-par-footer>${parsFooterMarkup()}</div>`;
  }

  function syncParFooter() {
    const host = state.root?.querySelector('[data-data-par-footer]');
    if (host) host.innerHTML = parsFooterMarkup();
  }

  async function saveParLevels() {
    const { changes, invalid } = pendingParChanges();
    if (invalid || !changes.length || state.pars.saving) return;
    state.pars.saving = true;
    state.pars.saveError = null;
    syncParFooter();
    try {
      const result = await rpc('atlas_apply_par_levels', {
        p_request_id: requestId('pars'),
        p_changes: changes.map(({ row, next }) => {
          const suggestion = row.suggestion && number(row.suggestion.par_level) !== null ? row.suggestion : null;
          return {
            item_id: row.item_id,
            expected_par_level: row.par_level ?? null,
            expected_updated_at: row.updated_at || null,
            par_level: next,
            suggestion: suggestion ? { shown: true, value: Number(suggestion.par_level), cover_days: Number(suggestion.cover_days), evidence_digest: row.evidence_digest || null } : { shown: false }
          };
        })
      });
      if (result?.status === 'conflict') {
        state.pars.conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
      } else {
        const saved = Array.isArray(result?.changed) ? result.changed.length : changes.length;
        state.pars.edits.clear();
        state.pars.conflicts = null;
        toast(`${plural(saved, 'par level', 'par levels')} saved.`);
        state.summaryAt = 0;
        loadSummary({ force: true });
        await loadPars({ cover: state.pars.coverApplied });
        try { if (typeof loadAll === 'function') loadAll(); } catch { /* shell data refresh is best effort */ } // eslint-disable-line no-undef
      }
    } catch (error) {
      state.pars.saveError = friendlyError(error, 'Nothing was saved. Check the values and try again.');
    } finally {
      state.pars.saving = false;
      render();
    }
  }

  // ---------- Import review ----------

  function reviewStatusPill(status) {
    const map = { pending: ['Waiting', 'info'], approved: ['Approved', 'positive'], rejected: ['Rejected', 'neutral'], held: ['Held', 'warning'], source_checked: ['Source checked', 'neutral'], excluded: ['Excluded', 'neutral'] };
    const [label, tone] = map[status] || [String(status || 'Waiting').replace(/_/g, ' '), 'neutral'];
    return pill(label.charAt(0).toUpperCase() + label.slice(1), tone);
  }
  function humanKey(value) {
    const text = String(value || '').replace(/_/g, ' ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function reviewMarkup() {
    const review = state.review;
    const caption = alertMarkup({ tone: 'info', body: 'Nothing here changes live records until you approve it.' });
    const batchNote = review.batch ? `<p class="data-caption">Showing rows from one import. <a href="#data/import-review">Show all imports</a></p>` : '';
    let body;
    if (review.error && !review.rows.length) body = alertMarkup({ title: 'Import review couldn\'t be loaded.', body: friendlyError(review.error, 'Nothing was changed. Try again.'), action: retryButton('review') });
    else if (review.loading && !review.rows.length) body = skeletonRows();
    else if (!review.rows.length) body = emptyMarkup({ icon: 'circle-check', title: review.query || review.scope !== 'all' || review.status !== 'pending' ? 'No records match these filters' : 'Nothing waiting for review', text: 'Records from new imports appear here before they change anything.' });
    else {
      const end = review.offset + review.rows.length;
      body = `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table">
          <thead><tr><th>Record</th><th data-priority="2">Type</th><th data-priority="3">Proposed</th><th class="is-num" data-priority="2">Issues</th><th>Status</th></tr></thead>
          <tbody>${review.rows.map((row) => {
            const issues = Array.isArray(row.issues) ? row.issues.length : 0;
            const source = [row.source_file, row.source_page ? `page ${row.source_page}` : null].filter(Boolean).join(' · ');
            return `<tr><td><button type="button" class="data-link cell-primary" data-data-review-open="${attr(row.row_kind)}" data-id="${attr(row.row_id)}">${escapeHtml(row.display_name || 'Record')}</button>${source ? `<span class="cell-sub">${escapeHtml(source)}</span>` : ''}</td>
              <td data-priority="2">${escapeHtml(humanKey(row.entity_scope))}</td><td data-priority="3">${escapeHtml(humanKey(row.proposed_action))}</td>
              <td class="is-num" data-priority="2">${issues}</td><td>${reviewStatusPill(row.review_status)}</td></tr>`;
          }).join('')}</tbody></table></div>
        <ul class="atlas-table-list">${review.rows.map((row) => `<li><button type="button" class="atlas-table-list__row data-link" data-data-review-open="${attr(row.row_kind)}" data-id="${attr(row.row_id)}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${escapeHtml(row.display_name || 'Record')}</div><div class="atlas-table-list__meta">${escapeHtml(humanKey(row.entity_scope))} · ${escapeHtml(humanKey(row.proposed_action))}</div></div><div class="atlas-table-list__value">${reviewStatusPill(row.review_status)}</div></button></li>`).join('')}</ul>
        <div class="atlas-table-foot"><span>${review.offset + 1}–${end} of ${review.total}</span><span class="atlas-btn-group">${review.offset > 0 ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-data-review-page="-1">Previous</button>' : ''}${end < review.total ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-data-review-page="1">Next</button>' : ''}</span></div>`;
    }
    return `${caption}${batchNote}
      <div class="atlas-toolbar">
        <label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" placeholder="Search records" aria-label="Search records" value="${attr(review.query)}" data-data-review-search data-focus-key="review-search"></label>
        <select class="atlas-select data-filter" aria-label="Type" data-data-review-scope>${REVIEW_SCOPES.map(([key, label]) => `<option value="${key}"${review.scope === key ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <select class="atlas-select data-filter" aria-label="Status" data-data-review-status>${REVIEW_STATUSES.map(([key, label]) => `<option value="${key}"${review.status === key ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <div class="atlas-toolbar__end">${plural(review.total, 'record', 'records')}</div>
      </div>${body}`;
  }

  function evidenceList(object) {
    const entries = Object.entries(object || {}).filter(([, value]) => value !== null && value !== undefined && value !== '' && typeof value !== 'object').slice(0, 24);
    if (!entries.length) return '<p class="data-caption">No values were read for this record.</p>';
    return `<dl class="data-facts">${entries.map(([key, value]) => `<div><dt>${escapeHtml(humanKey(key))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
  }

  async function openReviewDetail(rowKind, rowId) {
    const modal = ensureModal('data-review-modal');
    const paint = () => {
      const review = state.review;
      const detail = review.detail;
      const row = detail?.row;
      let body;
      if (review.detailLoading) body = skeletonRows(4);
      else if (!row) body = alertMarkup({ title: 'This record couldn\'t be loaded.', body: 'Nothing was changed. Close and try again.' });
      else {
        const issues = [...new Set([...(row.issues || []), ...(detail.issue_records || []).map((entry) => entry.issue)])].filter(Boolean);
        const locked = detail.row_kind === 'review_item';
        const actions = detail.row_kind === 'inventory'
          ? [['review', 'Needs review'], ['create', 'Create new item'], ['merge', 'Merge into an existing item'], ['skip', 'Skip']]
          : [['review', 'Needs review'], ['create', 'Create new'], ['merge', 'Merge into an existing record'], ['link', 'Link to an existing record'], ['skip', 'Skip']];
        body = `<div class="atlas-cluster">${reviewStatusPill(row.review_status)}${issues.map((issue) => pill(humanKey(issue), 'warning')).join('')}</div>
          <section class="atlas-stack atlas-stack--sm"><h3 class="data-sheet-heading">What the file says</h3>${evidenceList(row.normalized_data)}</section>
          <details class="data-raw"><summary>Original row</summary><dl class="data-facts">${Object.entries(row.raw_data || {}).slice(0, 30).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`).join('') || '<div><dt>Row</dt><dd>—</dd></div>'}</dl></details>
          ${locked ? alertMarkup({ tone: 'info', body: 'This record is background from the source file. It can\'t be approved on its own.' }) : `<form class="atlas-form" data-data-decision-form>
            <div class="atlas-field"><label for="data-decision-action">Action</label><select class="atlas-select" id="data-decision-action" name="action">${actions.map(([key, label]) => `<option value="${key}"${row.proposed_action === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="atlas-field"><label for="data-decision-match">Existing record <span class="optional">(for merge or link)</span></label><input class="atlas-input" id="data-decision-match" name="match" value="${attr(detail.row_kind === 'inventory' ? row.matched_item_id || '' : row.matched_entity_id || '')}"></div>
            <div class="atlas-field"><label for="data-decision-notes">Notes <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="data-decision-notes" name="notes" rows="2">${escapeHtml(row.decision_notes || '')}</textarea></div>
            <p class="error" data-data-decision-error hidden></p>
          </form>`}
          <section class="atlas-stack atlas-stack--sm"><h3 class="data-sheet-heading">History</h3>${(detail.history || []).length ? `<ul class="atlas-list">${detail.history.map((entry) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(humanKey(entry.decision))}</p><p class="atlas-row__meta">${escapeHtml(entry.decided_by_label || 'A manager')} · ${escapeHtml(formatDateTime(entry.created_at))}${entry.notes ? ` · ${escapeHtml(entry.notes)}` : ''}</p></div></li>`).join('')}</ul>` : '<p class="data-caption">No decision yet.</p>'}</section>`;
      }
      const decidable = row && detail.row_kind !== 'review_item';
      const name = row?.normalized_data?.name || row?.normalized_data?.description || row?.canonical_key || 'Record';
      modal.innerHTML = `<section class="atlas-sheet atlas-sheet--wide" data-modal-panel aria-labelledby="data-review-title">
          <span class="atlas-sheet__grabber"></span>
          <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="data-review-title">${escapeHtml(name)}</h2><p class="atlas-sheet__desc">${escapeHtml(humanKey(row?.entity_scope || detail?.row_kind || ''))}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header>
          <div class="atlas-sheet__body">${body}</div>
          ${decidable ? `<footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-data-decide="reset">Back to waiting</button><button type="button" class="atlas-btn atlas-btn--secondary" data-data-decide="reject">Reject</button><button type="button" class="atlas-btn atlas-btn--primary" data-data-decide="approve">Approve</button></footer>` : ''}
        </section>`;
      modal.querySelectorAll('[data-data-decide]').forEach((button) => button.addEventListener('click', () => decideReview(button.dataset.dataDecide, paint)));
      icons();
    };
    state.review.detail = null;
    state.review.detailLoading = true;
    paint();
    if (!root.AtlasModal.isOpen(modal)) root.AtlasModal.open(modal);
    try {
      state.review.detail = await edge(cfg.SPRINT3_REVIEW_API, 'detail', { params: { row_kind: rowKind, row_id: rowId } });
    } catch {
      state.review.detail = null;
    } finally {
      state.review.detailLoading = false;
      paint();
    }
  }

  async function decideReview(decision, repaint) {
    const detail = state.review.detail;
    const modal = root.document.getElementById('data-review-modal');
    const form = modal?.querySelector('[data-data-decision-form]');
    if (!detail?.row || !form || state.review.submitting) return;
    const errorLine = form.querySelector('[data-data-decision-error]');
    const action = form.elements.action.value;
    const matched = form.elements.match.value.trim() || null;
    if (decision === 'approve' && ['merge', 'link'].includes(action) && !matched) {
      errorLine.hidden = false;
      errorLine.textContent = 'Choose the existing record to merge or link with.';
      return;
    }
    state.review.submitting = true;
    modal.querySelectorAll('[data-data-decide]').forEach((button) => { button.disabled = true; });
    try {
      const payload = await edge(cfg.SPRINT3_REVIEW_API, 'decision', {
        method: 'POST',
        body: { row_kind: detail.row_kind, row_id: detail.row.id, decision, action, matched_id: matched, matched_entity_type: null, notes: form.elements.notes.value.trim() || null }
      });
      state.review.detail = payload?.detail || detail;
      toast(decision === 'approve' ? 'Approved. Live records change only when the import runs.' : decision === 'reject' ? 'Rejected.' : 'Moved back to waiting.');
      repaint();
      loadReviewSummary().then(render);
      loadReviewRows();
    } catch (error) {
      errorLine.hidden = false;
      errorLine.textContent = friendlyError(error, 'The decision couldn\'t be saved. Nothing was changed. Try again.');
      modal.querySelectorAll('[data-data-decide]').forEach((button) => { button.disabled = false; });
    } finally {
      state.review.submitting = false;
    }
  }

  // ---------- Waiting for approval (catalogue governance) ----------

  function valueText(key, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (key === 'cost_price' || key === 'case_cost') return money(value);
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  function describeValues(values) {
    return Object.entries(values || {}).map(([key, value]) => `${FIELD_LABELS[key] || humanKey(key)}: ${valueText(key, value)}`).join(' · ');
  }
  function subjectName(request) {
    return request.subject_item?.name || request.payload?.values?.name || request.payload?.name || 'an item';
  }
  function requestTitle(request) {
    const payload = request.payload || {};
    const subject = subjectName(request);
    switch (request.kind) {
      case 'alias': return `Add the name “${payload.alias || ''}” to ${subject}`;
      case 'code': return `Link ${payload.kind === 'sku' ? 'SKU' : 'barcode'} ${payload.code || payload.value || ''} to ${subject}`;
      case 'new_item': return `Add a new item: ${payload.values?.name || 'unnamed'}`;
      case 'duplicate_resolution': {
        const other = (request.related_items || [])[0]?.name || 'another item';
        return `Resolve duplicate: ${subject} and ${other}`;
      }
      case 'metadata_correction': return `Correct details of ${subject}`;
      case 'wrong_match_report': return `Wrong match reported on ${subject}`;
      case 'code_conflict': return `Code conflict on ${subject}`;
      default: return `${KIND_LABELS[request.kind] || 'Change'} for ${subject}`;
    }
  }
  function requestMeta(request) {
    return [request.requested_by_label, SOURCE_LABELS[request.source], formatRelative(request.requested_at)].filter(Boolean).join(' · ');
  }
  function requestStatus(request) {
    const [label, tone] = REQUEST_STATUS[request.status] || [humanKey(request.status), 'neutral'];
    return pill(label, tone);
  }

  function queueMarkup() {
    const queue = state.queue;
    const counts = Object.entries(queue.counts || {}).filter(([, n]) => Number(n) > 0);
    const kinds = [['', 'All types'], ...Object.entries(KIND_LABELS)];
    const toolbar = `<div class="atlas-toolbar">
        <div class="atlas-segmented" role="group" aria-label="Show"><button type="button" aria-pressed="${queue.status === 'pending'}" data-data-queue-status="pending">Waiting</button><button type="button" aria-pressed="${queue.status === 'all'}" data-data-queue-status="all">All decisions</button></div>
        <select class="atlas-select data-filter" aria-label="Type" data-data-queue-kind>${kinds.map(([key, label]) => `<option value="${key}"${queue.kind === key ? ' selected' : ''}>${escapeHtml(label)}${key && queue.counts?.[key] ? ` (${queue.counts[key]})` : ''}</option>`).join('')}</select>
        <div class="atlas-toolbar__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-data-backfill><i data-lucide="wand-sparkles"></i>Suggest missing details</button></div>
      </div>`;
    let body;
    if (queue.error && !queue.rows.length) {
      const notConfigured = queue.error.status === 404;
      body = alertMarkup({ title: notConfigured ? 'Approvals aren\'t available yet.' : 'Requests couldn\'t be loaded.', body: notConfigured ? 'The catalogue service isn\'t switched on for this venue. Nothing is waiting on you.' : friendlyError(queue.error, 'Nothing was changed. Try again.'), action: notConfigured ? '' : retryButton('queue') });
    } else if (!queue.loaded || (queue.loading && !queue.rows.length)) body = skeletonRows(4);
    else if (!queue.rows.length) body = emptyMarkup({ icon: 'badge-check', title: queue.status === 'pending' ? 'Nothing waiting for approval' : 'No decisions yet', text: 'New names, barcodes, items and duplicate reports from scans, imports and Atlas AI wait here until a manager decides.' });
    else {
      body = `<ul class="atlas-list data-queue">${queue.rows.map((request) => `<li class="atlas-row atlas-row--link"><span class="atlas-row__icon"><i data-lucide="${request.kind === 'new_item' ? 'package-plus' : request.kind === 'duplicate_resolution' ? 'copy' : request.kind === 'wrong_match_report' ? 'flag' : request.kind === 'code' ? 'barcode' : 'tag'}"></i></span>
          <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(requestTitle(request))}</p><p class="atlas-row__meta">${escapeHtml(requestMeta(request))}</p></div>
          <div class="atlas-row__end">${requestStatus(request)}<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" data-data-request="${attr(request.id)}">${request.status === 'pending' ? 'Review' : 'View'}</button></div></li>`).join('')}</ul>`;
    }
    return `${counts.length && queue.status === 'pending' ? `<p class="data-caption">${counts.map(([kind, n]) => `${n} ${escapeHtml((KIND_LABELS[kind] || kind).toLowerCase())}`).join(' · ')}</p>` : ''}${toolbar}${body}`;
  }

  function openRequest(id) {
    const request = state.queue.rows.find((entry) => String(entry.id) === String(id));
    if (!request) return;
    const modal = ensureModal('data-request-modal');
    const payload = request.payload || {};
    const pending = request.status === 'pending';
    const facts = [];
    if (request.kind === 'new_item' || request.kind === 'metadata_correction') facts.push(['Details', describeValues(payload.values)]);
    if (request.kind === 'metadata_correction' && payload.expected) facts.push(['Currently', describeValues(payload.expected)]);
    if (request.kind === 'alias') facts.push(['Name', payload.alias || '—']);
    if (request.kind === 'code') facts.push(['Code', `${payload.code || payload.value || '—'}${payload.kind ? ` (${payload.kind})` : ''}`]);
    if (payload.note) facts.push(['Note', payload.note]);
    if (request.subject_item) facts.push(['Item', `${request.subject_item.name}${request.subject_item.active === false ? ' (inactive)' : ''}`]);
    (request.related_items || []).forEach((item) => facts.push(['Related item', `${item.name}${item.active === false ? ' (inactive)' : ''}`]));
    const candidates = request.duplicate_check?.candidates || [];
    const audit = [
      ['Requested', `${request.requested_by_label || 'Someone'} · ${formatDateTime(request.requested_at)}${SOURCE_LABELS[request.source] ? ` · ${SOURCE_LABELS[request.source]}` : ''}`],
      request.decided_at ? ['Decided', `${request.decided_by_label || 'A manager'} · ${formatDateTime(request.decided_at)}${request.self_approved ? ' · own request' : ''}`] : null,
      request.decision_note ? ['Decision note', request.decision_note] : null,
      request.status === 'failed' ? ['Result', 'Approved, but Atlas couldn\'t apply the change. Nothing was changed.'] : null,
      request.status === 'applied' ? ['Result', 'Applied. Stock quantities were not changed.'] : null
    ].filter(Boolean);
    const duplicateControls = request.kind === 'duplicate_resolution' && pending ? `<fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Decision</legend>
        <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="mode" value="retire_into"${(payload.mode || 'retire_into') === 'retire_into' ? ' checked' : ''}>Same product — keep ${escapeHtml(subjectName(request))}, retire ${escapeHtml((request.related_items || [])[0]?.name || 'the other')}</label>
        <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="mode" value="not_duplicates"${payload.mode === 'not_duplicates' ? ' checked' : ''}>Different products</label>
        <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="mode" value="different_pack"${payload.mode === 'different_pack' ? ' checked' : ''}>Same product, different pack size</label>
      </fieldset>` : '';
    modal.innerHTML = `<section class="atlas-sheet atlas-sheet--wide" data-modal-panel aria-labelledby="data-request-title">
        <span class="atlas-sheet__grabber"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="data-request-title">${escapeHtml(requestTitle(request))}</h2><p class="atlas-sheet__desc">${escapeHtml(KIND_LABELS[request.kind] || 'Change')}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header>
        <form class="atlas-sheet__body atlas-form" data-data-request-form>
          <div class="atlas-cluster">${requestStatus(request)}</div>
          ${facts.length ? `<dl class="data-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
          ${candidates.length ? `<section class="atlas-stack atlas-stack--sm"><h3 class="data-sheet-heading">Similar items</h3><ul class="atlas-list">${candidates.slice(0, 5).map((candidate) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(candidate.name || 'Item')}</p><p class="atlas-row__meta">${number(candidate.score) !== null ? `${Math.round(Number(candidate.score) * 100)} % match` : 'Similar'}${candidate.active === false ? ' · inactive' : ''}</p></div></li>`).join('')}</ul></section>` : ''}
          ${duplicateControls}
          ${pending ? `<div class="atlas-field"><label for="data-request-note">Note <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="data-request-note" name="note" maxlength="2000" rows="2"></textarea></div>` : ''}
          <section class="atlas-stack atlas-stack--sm"><h3 class="data-sheet-heading">Record</h3><dl class="data-facts">${audit.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></section>
          <p class="error" data-data-request-error hidden></p>
        </form>
        ${pending ? '<footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--danger" data-data-request-decide="reject">Reject</button><button type="button" class="atlas-btn atlas-btn--primary" data-data-request-decide="approve">Approve</button></footer>' : ''}
      </section>`;
    modal.querySelectorAll('[data-data-request-decide]').forEach((button) => button.addEventListener('click', () => decideRequest(request, button.dataset.dataRequestDecide, modal)));
    root.AtlasModal.open(modal);
    icons();
  }

  async function decideRequest(request, decision, modal) {
    if (state.queue.deciding) return;
    const form = modal.querySelector('form');
    const errorLine = form.querySelector('[data-data-request-error]');
    const note = form.elements.note?.value.trim() || null;
    const resolution = {};
    if (request.kind === 'duplicate_resolution' && form.elements.mode) {
      resolution.mode = form.elements.mode.value;
      if (note) resolution.reason = note;
    }
    state.queue.deciding = true;
    modal.querySelectorAll('[data-data-request-decide]').forEach((button) => { button.disabled = true; });
    try {
      const payload = await edge(cfg.ITEM_MASTER_API, 'catalog-decide', {
        method: 'POST',
        body: { id: request.id, decision, note, expected_version: request.version, resolution }
      });
      const status = payload?.request?.status;
      root.AtlasModal.close(modal, 'saved');
      toast(decision === 'reject' ? 'Request rejected.' : status === 'failed' ? 'Approved, but the change couldn\'t be applied. Nothing was changed.' : 'Approved and applied.');
      state.summaryAt = 0;
      loadSummary({ force: true });
      loadQueue();
    } catch (error) {
      errorLine.hidden = false;
      errorLine.textContent = friendlyError(error, 'The decision couldn\'t be saved. Nothing was changed. Try again.');
      modal.querySelectorAll('[data-data-request-decide]').forEach((button) => { button.disabled = false; });
      if (error?.code === 'stale_request') loadQueue();
    } finally {
      state.queue.deciding = false;
    }
  }

  async function runBackfill() {
    const ok = await confirmDialog({
      title: 'Suggest missing details?',
      body: 'Atlas reads each active item\'s category, size and package text and proposes the missing product type and unit size. Every suggestion waits here for your approval; no item changes until you approve it.',
      confirm: 'Suggest details', keep: 'Not now'
    });
    if (!ok) return;
    try {
      const payload = await edge(cfg.ITEM_MASTER_API, 'catalog-backfill', { method: 'POST', body: { limit: 100 } });
      const created = Number(payload?.proposals?.created) || 0;
      toast(created ? `${plural(created, 'suggestion is', 'suggestions are')} waiting for approval.` : 'No new suggestions. Items either have their details or can\'t be read.');
      state.summaryAt = 0;
      loadSummary({ force: true });
      loadQueue();
    } catch (error) {
      showError(friendlyError(error, 'Suggestions couldn\'t be created. Nothing was changed. Try again.'));
    }
  }

  // ---------- dialogs ----------

  function ensureModal(id) {
    let modal = root.document.getElementById(id);
    if (!modal) {
      modal = root.document.createElement('div');
      modal.id = id;
      modal.className = 'atlas-modal';
      modal.hidden = true;
      modal.setAttribute('data-atlas-modal', '');
      root.document.body.appendChild(modal);
      root.AtlasModal.register(modal, { closeOnBackdrop: true });
    }
    return modal;
  }

  function confirmDialog({ title, body, confirm, keep = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const modal = ensureModal('data-confirm-modal');
      modal.innerHTML = `<section class="atlas-dialog" data-modal-panel aria-labelledby="data-confirm-title">
          <h2 class="atlas-dialog__title" id="data-confirm-title">${escapeHtml(title)}</h2>
          <div class="atlas-dialog__body"><p>${escapeHtml(body)}</p></div>
          <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>${escapeHtml(keep)}</button><button type="button" class="atlas-btn atlas-btn--${danger ? 'danger-solid' : 'primary'}" data-data-confirm>${escapeHtml(confirm)}</button></div>
        </section>`;
      let answered = false;
      const done = (value) => { if (answered) return; answered = true; resolve(value); };
      modal.querySelector('[data-data-confirm]').addEventListener('click', () => { done(true); root.AtlasModal.close(modal, 'confirm'); });
      modal.addEventListener('atlas:modal-close', () => done(false), { once: true });
      root.AtlasModal.open(modal);
    });
  }

  function showError(message) {
    const modal = ensureModal('data-error-modal');
    modal.innerHTML = `<section class="atlas-dialog" data-modal-panel aria-labelledby="data-error-title">
        <h2 class="atlas-dialog__title" id="data-error-title">That didn't work</h2>
        <div class="atlas-dialog__body"><p>${escapeHtml(message)}</p></div>
        <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--primary" data-modal-close>OK, got it</button></div>
      </section>`;
    root.AtlasModal.open(modal);
  }

  // ---------- events ----------

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const inPage = state.root?.contains(target);
    if (!inPage) return;
    if (target.closest('[data-data-upload]')) { event.preventDefault(); openUpload(); return; }
    const retry = target.closest('[data-data-retry]');
    if (retry) {
      const what = retry.dataset.dataRetry;
      if (what === 'imports') loadImports();
      else if (what === 'summary') loadSummary({ force: true });
      else if (what === 'issue-rows') loadIssueRows();
      else if (what === 'pars') loadPars({ cover: state.pars.coverApplied });
      else if (what === 'review') loadReviewRows();
      else if (what === 'queue') loadQueue();
      return;
    }
    const filter = target.closest('[data-data-import-filter]');
    if (filter) { state.imports.filter = filter.dataset.dataImportFilter; render(); return; }
    if (target.closest('[data-data-clear-imports]')) { state.imports.filter = 'all'; state.imports.query = ''; render(); return; }
    const batchButton = target.closest('[data-data-batch-action]');
    if (batchButton) { batchAction(batchButton.dataset.dataBatchAction, batchButton.dataset.batchId); return; }
    const issue = target.closest('[data-data-issue]');
    if (issue) {
      state.issues.code = issue.dataset.dataIssue;
      state.issues.offset = 0;
      state.issues.rows = [];
      root.AtlasShell.navigate(`#data/issues?issue=${encodeURIComponent(state.issues.code)}`);
      return;
    }
    const issuePage = target.closest('[data-data-issue-page]');
    if (issuePage) { state.issues.offset = Math.max(0, state.issues.offset + Number(issuePage.dataset.dataIssuePage) * PAGE); loadIssueRows(); return; }
    const duplicate = target.closest('[data-data-resolve-duplicate]');
    if (duplicate) { openDuplicate(duplicate.dataset.dataResolveDuplicate, duplicate.dataset.other); return; }
    const use = target.closest('[data-data-par-use]');
    if (use) {
      state.pars.edits.set(use.dataset.dataParUse, String(use.dataset.value));
      const input = state.root.querySelector(`[data-data-par-input="${CSS.escape(use.dataset.dataParUse)}"]`);
      if (input) input.value = use.dataset.value;
      syncParFooter();
      return;
    }
    if (target.closest('[data-data-par-discard]')) { state.pars.edits.clear(); state.pars.conflicts = null; render(); return; }
    if (target.closest('[data-data-par-save]')) { saveParLevels(); return; }
    if (target.closest('[data-data-par-reload]')) { state.pars.conflicts = null; loadPars({ cover: state.pars.coverApplied }); return; }
    if (target.closest('[data-data-par-clear]')) { state.pars.query = ''; state.pars.category = ''; state.pars.supplier = ''; render(); return; }
    const reviewOpen = target.closest('[data-data-review-open]');
    if (reviewOpen) { openReviewDetail(reviewOpen.dataset.dataReviewOpen, reviewOpen.dataset.id); return; }
    const reviewPage = target.closest('[data-data-review-page]');
    if (reviewPage) { state.review.offset = Math.max(0, state.review.offset + Number(reviewPage.dataset.dataReviewPage) * PAGE); loadReviewRows(); return; }
    const queueStatus = target.closest('[data-data-queue-status]');
    if (queueStatus) { state.queue.status = queueStatus.dataset.dataQueueStatus; loadQueue(); return; }
    const request = target.closest('[data-data-request]');
    if (request) { openRequest(request.dataset.dataRequest); return; }
    if (target.closest('[data-data-backfill]')) runBackfill();
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !state.root?.contains(target)) return;
    if (target.matches('[data-data-import-search]')) { state.imports.query = target.value; render(); return; }
    if (target.matches('[data-data-par-search]')) { state.pars.query = target.value; render(); return; }
    if (target.matches('[data-data-par-input]')) {
      const id = target.dataset.dataParInput;
      if (target.value.trim() === '') state.pars.edits.delete(id);
      else state.pars.edits.set(id, target.value);
      const next = number(target.value.trim().replace(',', '.'));
      target.setAttribute('aria-invalid', String(target.value.trim() !== '' && (next === null || next < 0)));
      syncParFooter();
      return;
    }
    if (target.matches('#data-cover-days')) { state.pars.cover = target.value; return; }
    if (target.matches('[data-data-review-search]')) {
      state.review.query = target.value;
      root.clearTimeout(state.searchTimer);
      state.searchTimer = root.setTimeout(() => { state.review.offset = 0; state.review.batch = null; loadReviewRows(); }, 300);
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !state.root?.contains(target)) return;
    if (target.matches('[data-data-par-category]')) { state.pars.category = target.value; render(); return; }
    if (target.matches('[data-data-par-supplier]')) { state.pars.supplier = target.value; render(); return; }
    if (target.matches('[data-data-review-scope]')) { state.review.scope = target.value; state.review.offset = 0; loadReviewRows(); return; }
    if (target.matches('[data-data-review-status]')) { state.review.status = target.value; state.review.offset = 0; loadReviewRows(); return; }
    if (target.matches('[data-data-queue-kind]')) { state.queue.kind = target.value; loadQueue(); }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !state.root?.contains(form)) return;
    if (form.matches('[data-data-cover-form]')) {
      event.preventDefault();
      const cover = number(String(state.pars.cover).replace(',', '.'));
      if (cover === null || cover <= 0 || cover > 365) {
        const input = form.querySelector('input');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      loadPars({ cover });
    }
  }

  // ---------- routing ----------

  function applyParams(params = {}) {
    const section = params.section || 'imports';
    state.params = { ...params };
    state.tab = section === 'import' && params.batch ? 'import' : TABS.some(([key]) => key === section) ? section : 'imports';
    if (state.tab === 'import') {
      const batch = state.imports.rows.find((entry) => String(entry.id) === String(params.batch));
      root.AtlasChrome?.setTopBar?.({ title: batch ? sourceName(batch) : 'Import', back: '#data' });
    }
    if (state.tab === 'issues' && params.issue) state.issues.code = params.issue;
    if (state.tab === 'pars' && params.item) {
      state.pars.focusItem = String(params.item);
      const row = (state.pars.items || []).find((entry) => String(entry.item_id) === state.pars.focusItem);
      const name = row?.name || shellItems().find((entry) => String(entry.id) === state.pars.focusItem)?.name;
      if (name) state.pars.query = name;
    }
    if (state.tab === 'import-review') {
      state.review.batch = params.batch || null;
      if (state.review.batch) state.review.status = 'all';
    }
  }

  function onShow(params = {}) {
    ensureRoot();
    applyParams(params);
    render();
    if (!isManager()) return;
    loadSummary({ force: Date.now() - state.summaryAt > 5000 });
    if (!state.imports.loaded || ['imports', 'import'].includes(state.tab)) loadImports({ quiet: state.imports.loaded });
    if (!state.review.summary) loadReviewSummary().then(() => { if (visible()) render(); });
    if (state.tab === 'issues' && state.issues.code) loadIssueRows();
    if (state.tab === 'pars') loadPars({ cover: state.pars.coverApplied });
    if (state.tab === 'import-review') { state.review.offset = 0; loadReviewRows(); }
    if (state.tab === 'approvals') loadQueue();
    root.clearInterval(state.pollTimer);
    state.pollTimer = root.setInterval(() => {
      if (visible() && ['imports', 'import'].includes(state.tab) && root.document.visibilityState !== 'hidden') loadImports({ quiet: true });
    }, 20000);
  }

  function onHide() {
    root.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function ensureRoot() {
    if (state.root?.isConnected) return state.root;
    let element = root.document.getElementById('data-view');
    if (!element) {
      const main = root.document.querySelector('.atlas-content.standard-view main') || root.document.querySelector('.atlas-content main') || root.document.body;
      element = root.document.createElement('div');
      element.id = 'data-view';
      element.className = 'data-view';
      element.style.display = 'none';
      main.appendChild(element);
    }
    state.root = element;
    return element;
  }

  function init() {
    if (state.initialized || !root.AtlasShell || !root.document) return;
    state.initialized = true;
    ensureRoot();
    root.AtlasShell.registerView('data', { root: () => ensureRoot(), title: 'Data', display: 'block', onShow, onHide });
    // Retired view ids (Real VÁ Data) open the matching Data tab.
    root.AtlasShell.registerView('sprint3-review', { root: null, guard: () => { root.AtlasShell.navigate('#data/import-review'); return false; } });
    root.AtlasShell.home?.contribute?.('data', { order: 60, focusRows });
    root.AtlasShell.actions?.register?.({ id: 'data.import', label: 'Import a file', icon: 'upload', keywords: ['import', 'upload', 'csv', 'excel', 'spreadsheet'], roles: MANAGERS, contexts: ['data'], run: () => { if (root.location.hash !== '#data') root.location.hash = '#data'; root.setTimeout(openUpload, 0); } });
    root.AtlasShell.actions?.register?.({ id: 'data.pars', label: 'Set par levels', icon: 'gauge', keywords: ['par', 'par levels', 'reorder'], roles: MANAGERS, contexts: ['data', 'inventory'], run: () => root.AtlasShell.navigate('#data/pars') });
    root.AtlasShell.actions?.register?.({ id: 'data.approvals', label: 'Review catalogue changes', icon: 'badge-check', keywords: ['approve', 'alias', 'barcode', 'duplicate', 'catalogue'], roles: MANAGERS, contexts: ['data', 'home'], run: () => root.AtlasShell.navigate('#data/approvals') });
    root.AtlasShell.on?.('profile:ready', () => { loadSummary({ force: true }); if (visible()) render(); });
    root.AtlasShell.onDataLoaded?.(() => loadSummary());
    root.document.addEventListener('click', handleClick);
    root.document.addEventListener('input', handleInput);
    root.document.addEventListener('change', handleChange);
    root.document.addEventListener('submit', handleSubmit);
    root.addEventListener('focus', () => { if (visible()) loadSummary({ force: true }); });
    if (profile()) loadSummary({ force: true });
  }

  root.AtlasDataWorkspace = {
    open: (section = '') => root.AtlasShell?.navigate?.(section ? `#data/${section}` : '#data'),
    refresh: () => { state.summaryAt = 0; return loadSummary({ force: true }); },
    summary: () => state.summary,
    pendingApprovals,
    focusRows
  };

  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(typeof window === 'undefined' ? globalThis : window);
