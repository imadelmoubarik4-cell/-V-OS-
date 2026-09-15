(function () {
  'use strict';

  const VERSION = '3.1.0';
  const SCOPES = [
    ['all', 'All'],
    ['inventory', 'Inventory'],
    ['recipe', 'Recipes'],
    ['menu', 'Menus'],
    ['supplier', 'Suppliers'],
    ['invoice', 'Invoices'],
    ['purchase', 'Purchases'],
    ['delivery', 'Deliveries'],
    ['equipment', 'Equipment']
  ];

  const state = {
    initialized: false,
    authorized: false,
    profile: null,
    summary: null,
    rows: [],
    total: 0,
    limit: 40,
    offset: 0,
    scope: 'all',
    status: 'pending',
    query: '',
    selectedKey: null,
    detail: null,
    loadingRows: false,
    loadingDetail: false,
    submitting: false,
    searchTimer: null,
    authSubscription: null
  };

  const dom = {};

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatKey(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value ?? {}, null, 2);
    } catch (error) {
      return '{}';
    }
  }

  function endpoint() {
    const value = window.VABAR_CONFIG?.SPRINT3_REVIEW_API;
    if (!value) throw new Error('Sprint 3 Review API is not configured.');
    return value;
  }

  async function client() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (window.atlasSupabase?.auth) return window.atlasSupabase;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Atlas authentication is not ready.');
  }

  async function accessToken() {
    const supabase = await client();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const token = data?.session?.access_token;
    if (!token) throw new Error('Sign in to Atlas to open the Sprint 3 Review Center.');
    return token;
  }

  async function api(action, options = {}) {
    const url = new URL(endpoint());
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });
    const token = await accessToken();
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Sprint 3 review request failed (${response.status}).`);
    return payload;
  }

  function profileIsManager(profile) {
    return Boolean(profile?.active && ['admin', 'manager'].includes(profile.role));
  }

  async function resolveProfile() {
    const supabase = await client();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) return null;
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id,email,role,active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (error) throw error;
    return profile;
  }

  function setMessage(message, tone = '') {
    if (!dom.message) return;
    dom.message.textContent = message || '';
    dom.message.className = `review-message${tone ? ` ${tone}` : ''}`;
  }

  function notify(message) {
    if (typeof showToast === 'function') showToast(message);
    else setMessage(message, 'success');
  }

  function ensureMarkup() {
    if (document.getElementById('sprint3-review-view')) return;
    const main = document.querySelector('.atlas-content.standard-view main');
    if (!main) return;

    const view = document.createElement('div');
    view.id = 'sprint3-review-view';
    view.className = 'placeholder-view sprint3-review-view';
    view.style.display = 'none';
    view.innerHTML = `
      <section class="review-shell">
        <header class="review-hero">
          <div class="review-hero-copy">
            <span class="review-kicker"><i data-lucide="shield-check"></i>Sprint 3 · Private Review</span>
            <h1>Real VÁ Data</h1>
            <p>Review inventory, recipes, menus, suppliers, invoices, purchases, deliveries and equipment before anything reaches live Atlas records.</p>
          </div>
          <div class="review-branch-card">
            <span>Environment</span>
            <strong>Isolated PR branch</strong>
            <small>Production remains unchanged</small>
          </div>
        </header>

        <div class="review-message" id="review-message" role="status" aria-live="polite"></div>
        <section class="review-summary-grid" id="review-summary-grid" aria-label="Review summary"></section>

        <section class="review-controls" aria-label="Review filters">
          <div class="review-scope-row" id="review-scope-row"></div>
          <div class="review-filter-row">
            <label class="review-search"><i data-lucide="search"></i><input id="review-search" type="search" placeholder="Search name, source, issue…" /></label>
            <select id="review-status" aria-label="Review status">
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="all">All statuses</option>
            </select>
            <button type="button" class="review-refresh" id="review-refresh"><i data-lucide="refresh-cw"></i><span>Refresh</span></button>
          </div>
        </section>

        <div class="review-workspace">
          <section class="review-list-card">
            <header class="review-card-head">
              <div><h2>Review queue</h2><p id="review-list-count">Loading records…</p></div>
            </header>
            <div class="review-row-list" id="review-row-list"></div>
            <footer class="review-pagination">
              <button type="button" id="review-prev"><i data-lucide="chevron-left"></i>Previous</button>
              <span id="review-page-label">Page 1</span>
              <button type="button" id="review-next">Next<i data-lucide="chevron-right"></i></button>
            </footer>
          </section>

          <aside class="review-detail-card" id="review-detail-card" aria-live="polite">
            <div class="review-detail-empty"><i data-lucide="scan-search"></i><strong>Select a record</strong><span>Inspect its source evidence, issues and proposed action.</span></div>
          </aside>
        </div>

        <section class="review-issues-card">
          <header class="review-card-head"><div><h2>Most common unresolved issues</h2><p>These groups determine the fastest path through Sprint 3 review.</p></div></header>
          <div class="review-issue-list" id="review-issue-list"></div>
        </section>
      </section>`;

    const teamView = document.getElementById('team-view');
    main.insertBefore(view, teamView || null);

    const nav = document.querySelector('.atlas-nav');
    if (nav && !document.querySelector('[data-sprint3-review-nav]')) {
      const group = document.createElement('div');
      group.className = 'nav-group';
      group.dataset.sprint3ReviewNav = 'true';
      group.innerHTML = `<div class="nav-label">DATA REVIEW</div><button type="button" class="nav-item" data-view="sprint3-review"><i data-lucide="list-checks"></i><span>Real VÁ Data</span><b class="review-nav-count" id="review-nav-count">—</b></button>`;
      const operations = Array.from(nav.querySelectorAll('.nav-group')).find((candidate) => candidate.querySelector('.nav-label')?.textContent?.trim() === 'OPERATIONS');
      if (operations) operations.insertAdjacentElement('afterend', group);
      else nav.appendChild(group);
      group.querySelector('[data-view="sprint3-review"]')?.addEventListener('click', () => setActiveView('sprint3-review'));
    }

    dom.view = view;
    dom.summary = document.getElementById('review-summary-grid');
    dom.scopeRow = document.getElementById('review-scope-row');
    dom.status = document.getElementById('review-status');
    dom.search = document.getElementById('review-search');
    dom.refresh = document.getElementById('review-refresh');
    dom.list = document.getElementById('review-row-list');
    dom.listCount = document.getElementById('review-list-count');
    dom.detail = document.getElementById('review-detail-card');
    dom.prev = document.getElementById('review-prev');
    dom.next = document.getElementById('review-next');
    dom.page = document.getElementById('review-page-label');
    dom.issues = document.getElementById('review-issue-list');
    dom.message = document.getElementById('review-message');
    dom.navCount = document.getElementById('review-nav-count');

    if (typeof viewMap !== 'undefined') viewMap['sprint3-review'] = view;
    if (typeof titleMap !== 'undefined') titleMap['sprint3-review'] = 'Real VÁ Data';
    patchViewSwitching();
    bindControls();
    renderScopes();
    window.lucide?.createIcons?.();
  }

  function patchViewSwitching() {
    if (typeof setActiveView !== 'function' || setActiveView.__sprint3ReviewPatched) return;
    const original = setActiveView;
    const patched = function (view) {
      const result = original.apply(this, arguments);
      if (view === 'sprint3-review') openReviewCenter();
      return result;
    };
    patched.__sprint3ReviewPatched = true;
    patched.__sprint3ReviewOriginal = original;
    setActiveView = patched;
  }

  function bindControls() {
    dom.status?.addEventListener('change', () => {
      state.status = dom.status.value;
      state.offset = 0;
      state.selectedKey = null;
      state.detail = null;
      loadRows();
    });
    dom.search?.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.query = dom.search.value.trim();
        state.offset = 0;
        loadRows();
      }, 300);
    });
    dom.refresh?.addEventListener('click', () => refreshAll(true));
    dom.prev?.addEventListener('click', () => {
      if (state.offset <= 0) return;
      state.offset = Math.max(0, state.offset - state.limit);
      loadRows();
    });
    dom.next?.addEventListener('click', () => {
      if (state.offset + state.limit >= state.total) return;
      state.offset += state.limit;
      loadRows();
    });
  }

  function renderScopes() {
    if (!dom.scopeRow) return;
    dom.scopeRow.innerHTML = SCOPES.map(([value, label]) => `
      <button type="button" class="review-scope-chip ${state.scope === value ? 'active' : ''}" data-review-scope="${escapeHtml(value)}">${escapeHtml(label)}<span>${scopeCount(value)}</span></button>`).join('');
    dom.scopeRow.querySelectorAll('[data-review-scope]').forEach((button) => button.addEventListener('click', () => {
      state.scope = button.dataset.reviewScope || 'all';
      state.offset = 0;
      state.selectedKey = null;
      state.detail = null;
      renderScopes();
      loadRows();
    }));
  }

  function progressCount(scope, status = 'pending') {
    const rows = state.summary?.progress || [];
    return rows
      .filter((entry) => (scope === 'all' || entry.entity_scope === scope) && (status === 'all' || entry.review_status === status))
      .reduce((sum, entry) => sum + Number(entry.row_count || 0), 0);
  }

  function scopeCount(scope) {
    if (scope === 'all') return Number(state.summary?.totals?.pending || 0);
    return progressCount(scope, 'pending');
  }

  function renderSummary() {
    if (!dom.summary) return;
    const totals = state.summary?.totals || {};
    const operational = ['invoice', 'purchase', 'delivery'].reduce((sum, scope) => sum + progressCount(scope, 'pending'), 0);
    const reviewed = Number(totals.approved || 0) + Number(totals.rejected || 0) + Number(totals.imported || 0);
    const cards = [
      ['clipboard-list', totals.pending || 0, 'Pending review', 'No promotion until approved'],
      ['package-search', progressCount('inventory'), 'Inventory candidates', 'July quantity remains historical'],
      ['martini', progressCount('recipe'), 'Recipe records', 'Recipes and ingredient links'],
      ['receipt-text', operational, 'Purchasing evidence', 'Invoices, purchases and deliveries'],
      ['badge-check', reviewed, 'Reviewed decisions', `${totals.decisions || 0} audit events`]
    ];
    dom.summary.innerHTML = cards.map(([icon, value, label, detail]) => `
      <article class="review-summary-card"><div class="review-summary-icon"><i data-lucide="${icon}"></i></div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small></article>`).join('');
    if (dom.navCount) dom.navCount.textContent = String(totals.pending || 0);
    renderScopes();
    window.lucide?.createIcons?.();
  }

  function renderIssues() {
    if (!dom.issues) return;
    const issues = state.summary?.top_issues || [];
    dom.issues.innerHTML = issues.length ? issues.map((entry) => `
      <div class="review-issue-row"><div><strong>${escapeHtml(formatKey(entry.issue))}</strong><span>${escapeHtml(formatKey(entry.entity_type))} · ${escapeHtml(entry.severity)}</span></div><b>${escapeHtml(entry.issue_count)}</b></div>`).join('') : '<div class="review-empty-copy">No unresolved issue groups.</div>';
  }

  function renderRows() {
    if (!dom.list) return;
    if (state.loadingRows) {
      dom.list.innerHTML = '<div class="review-loading"><span></span><p>Loading private review records…</p></div>';
      return;
    }
    dom.listCount.textContent = `${state.total.toLocaleString('en-GB')} records · ${formatKey(state.status)}`;
    if (!state.rows.length) {
      dom.list.innerHTML = '<div class="review-list-empty"><i data-lucide="circle-check-big"></i><strong>No records in this view</strong><span>Change the scope, status or search.</span></div>';
    } else {
      dom.list.innerHTML = state.rows.map((row) => {
        const key = `${row.row_kind}:${row.row_id}`;
        const issueCount = Array.isArray(row.issues) ? row.issues.length : 0;
        const source = [row.source_file, row.source_page ? `page ${row.source_page}` : null].filter(Boolean).join(' · ') || 'Derived private source';
        return `<button type="button" class="review-row ${state.selectedKey === key ? 'selected' : ''}" data-review-row-kind="${escapeHtml(row.row_kind)}" data-review-row-id="${escapeHtml(row.row_id)}">
          <div class="review-row-copy"><div><span class="review-scope-badge">${escapeHtml(formatKey(row.entity_scope))}</span><span class="review-status-badge ${escapeHtml(row.review_status)}">${escapeHtml(formatKey(row.review_status))}</span></div><strong>${escapeHtml(row.display_name)}</strong><small>${escapeHtml(source)}</small></div>
          <div class="review-row-meta"><span>${escapeHtml(formatKey(row.proposed_action))}</span><b>${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}</b><i data-lucide="chevron-right"></i></div>
        </button>`;
      }).join('');
      dom.list.querySelectorAll('[data-review-row-id]').forEach((button) => button.addEventListener('click', () => selectRow(button.dataset.reviewRowKind, button.dataset.reviewRowId)));
    }
    const currentPage = Math.floor(state.offset / state.limit) + 1;
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    dom.page.textContent = `Page ${currentPage} of ${pages}`;
    dom.prev.disabled = state.offset <= 0;
    dom.next.disabled = state.offset + state.limit >= state.total;
    window.lucide?.createIcons?.();
  }

  function actionOptions(rowKind, selected) {
    const values = rowKind === 'inventory'
      ? [['review', 'Needs review'], ['create', 'Create new'], ['merge', 'Merge existing'], ['skip', 'Skip source']]
      : [['review', 'Needs review'], ['create', 'Create new'], ['merge', 'Merge existing'], ['link', 'Link existing'], ['skip', 'Skip source']];
    return values.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  }

  function renderObject(object) {
    const entries = Object.entries(object || {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
    if (!entries.length) return '<div class="review-empty-copy">No values captured.</div>';
    return `<dl class="review-data-grid">${entries.slice(0, 40).map(([key, value]) => {
      const shown = typeof value === 'object' ? safeJson(value) : String(value);
      return `<div><dt>${escapeHtml(formatKey(key))}</dt><dd>${escapeHtml(shown)}</dd></div>`;
    }).join('')}</dl>`;
  }

  function renderDetail() {
    if (!dom.detail) return;
    if (state.loadingDetail) {
      dom.detail.innerHTML = '<div class="review-loading detail"><span></span><p>Reading source evidence…</p></div>';
      return;
    }
    if (!state.detail?.row) {
      dom.detail.innerHTML = '<div class="review-detail-empty"><i data-lucide="scan-search"></i><strong>Select a record</strong><span>Inspect its source evidence, issues and proposed action.</span></div>';
      window.lucide?.createIcons?.();
      return;
    }

    const detail = state.detail;
    const row = detail.row;
    const rowKind = detail.row_kind;
    const displayName = row.normalized_data?.name || row.normalized_data?.description || row.canonical_key || row.source_key || 'Review record';
    const scope = rowKind === 'inventory' ? 'inventory' : row.entity_scope;
    const source = row.normalized_data?.source_file || row.normalized_data?.source_files || row.batch_file_name || row.batch_source_files?.[0] || 'Private source';
    const issues = Array.from(new Set([...(row.issues || []), ...(detail.issue_records || []).map((entry) => entry.issue)])).filter(Boolean);
    const matchedId = rowKind === 'inventory' ? row.matched_item_id : row.matched_entity_id;

    dom.detail.innerHTML = `
      <header class="review-detail-head"><div><span>${escapeHtml(formatKey(scope))}</span><h2>${escapeHtml(displayName)}</h2><p>${escapeHtml(source)}${row.source_page ? ` · page ${escapeHtml(row.source_page)}` : ''}</p></div><span class="review-status-badge ${escapeHtml(row.review_status)}">${escapeHtml(formatKey(row.review_status))}</span></header>

      <section class="review-detail-section"><h3>Review issues</h3><div class="review-issue-chips">${issues.length ? issues.map((issue) => `<span>${escapeHtml(formatKey(issue))}</span>`).join('') : '<span class="clear">No issue flags</span>'}</div></section>

      <section class="review-detail-section"><h3>Normalized evidence</h3>${renderObject(row.normalized_data)}</section>

      <details class="review-source-details"><summary>Raw source evidence</summary><pre>${escapeHtml(safeJson(row.raw_data))}</pre><div class="review-source-meta"><span>Source hash</span><code>${escapeHtml(String(row.source_hash || row.batch_source_hash || '—').slice(0, 24))}</code></div></details>

      <form class="review-decision-form" id="review-decision-form">
        <h3>Decision</h3>
        <div class="review-form-grid">
          <label><span>Action</span><select id="review-action">${actionOptions(rowKind, row.proposed_action)}</select></label>
          ${rowKind === 'entity' ? `<label><span>Matched entity type</span><input id="review-match-type" type="text" value="${escapeHtml(row.matched_entity_type || '')}" placeholder="inventory_item, recipe…" /></label>` : ''}
          <label class="wide"><span>Matched record ID</span><input id="review-match-id" type="text" value="${escapeHtml(matchedId || '')}" placeholder="Required for merge or link" /></label>
          <label class="wide"><span>Decision notes</span><textarea id="review-notes" rows="3" placeholder="Explain the evidence or remaining uncertainty.">${escapeHtml(row.decision_notes || '')}</textarea></label>
        </div>
        <div class="review-decision-actions">
          <button type="button" class="review-approve" data-review-decision="approve"><i data-lucide="badge-check"></i>Approve</button>
          <button type="button" class="review-reject" data-review-decision="reject"><i data-lucide="circle-x"></i>Reject</button>
          <button type="button" class="review-reset" data-review-decision="reset"><i data-lucide="rotate-ccw"></i>Reset to pending</button>
        </div>
      </form>

      <section class="review-history"><h3>Decision history</h3>${(detail.history || []).length ? detail.history.map((entry) => `<div class="review-history-row"><div><strong>${escapeHtml(formatKey(entry.decision))}</strong><span>${escapeHtml(entry.decided_by_label || 'Manager')} · ${escapeHtml(formatDate(entry.created_at))}</span></div><small>${escapeHtml(entry.notes || `${formatKey(entry.previous_status)} → ${formatKey(entry.new_status)}`)}</small></div>`).join('') : '<div class="review-empty-copy">No decision has been recorded for this source row.</div>'}</section>`;

    dom.detail.querySelectorAll('[data-review-decision]').forEach((button) => button.addEventListener('click', () => submitDecision(button.dataset.reviewDecision)));
    window.lucide?.createIcons?.();
  }

  async function loadSummary() {
    state.summary = await api('summary');
    renderSummary();
    renderIssues();
  }

  async function loadRows(selectFirst = true) {
    if (!state.authorized || state.loadingRows) return;
    state.loadingRows = true;
    renderRows();
    setMessage('');
    try {
      const payload = await api('rows', {
        params: {
          scope: state.scope,
          status: state.status,
          q: state.query,
          limit: state.limit,
          offset: state.offset
        }
      });
      state.rows = payload.rows || [];
      state.total = Number(payload.total || 0);
      if (selectFirst && !state.selectedKey && state.rows.length) {
        const first = state.rows[0];
        state.selectedKey = `${first.row_kind}:${first.row_id}`;
        await loadDetail(first.row_kind, first.row_id);
      } else if (!state.rows.length) {
        state.detail = null;
        renderDetail();
      }
    } catch (error) {
      state.rows = [];
      state.total = 0;
      setMessage(error.message, 'error');
    } finally {
      state.loadingRows = false;
      renderRows();
    }
  }

  async function loadDetail(rowKind, rowId) {
    if (!rowKind || !rowId) return;
    state.loadingDetail = true;
    renderDetail();
    try {
      state.detail = await api('detail', { params: { row_kind: rowKind, row_id: rowId } });
    } catch (error) {
      state.detail = null;
      setMessage(error.message, 'error');
    } finally {
      state.loadingDetail = false;
      renderDetail();
    }
  }

  async function selectRow(rowKind, rowId) {
    state.selectedKey = `${rowKind}:${rowId}`;
    renderRows();
    await loadDetail(rowKind, rowId);
  }

  async function submitDecision(decision) {
    if (state.submitting || !state.detail?.row) return;
    const row = state.detail.row;
    const rowKind = state.detail.row_kind;
    const action = document.getElementById('review-action')?.value || row.proposed_action || 'review';
    const matchedId = document.getElementById('review-match-id')?.value?.trim() || null;
    const matchedEntityType = document.getElementById('review-match-type')?.value?.trim() || null;
    const notes = document.getElementById('review-notes')?.value?.trim() || null;
    if (decision === 'approve' && action === 'review') {
      setMessage('Choose Create, Merge, Link or Skip before approving.', 'error');
      return;
    }
    if (decision === 'approve' && ['merge', 'link'].includes(action) && !matchedId) {
      setMessage('A matched record ID is required for Merge or Link.', 'error');
      return;
    }

    state.submitting = true;
    dom.detail.classList.add('submitting');
    setMessage('Saving review decision…');
    try {
      const payload = await api('decision', {
        method: 'POST',
        body: {
          row_kind: rowKind,
          row_id: row.id,
          decision,
          action,
          matched_id: matchedId,
          matched_entity_type: matchedEntityType,
          notes
        }
      });
      state.detail = payload.detail;
      await Promise.all([loadSummary(), loadRows(false)]);
      renderDetail();
      notify(`Review decision saved: ${formatKey(decision)}.`);
      setMessage('');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      state.submitting = false;
      dom.detail.classList.remove('submitting');
    }
  }

  async function refreshAll(manual = false) {
    if (!state.authorized) return;
    if (manual) setMessage('Refreshing private Sprint 3 data…');
    try {
      await Promise.all([loadSummary(), loadRows(false)]);
      if (state.selectedKey) {
        const [rowKind, rowId] = state.selectedKey.split(':');
        await loadDetail(rowKind, rowId);
      }
      if (manual) notify('Sprint 3 review data refreshed.');
      setMessage('');
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  async function openReviewCenter() {
    if (!state.authorized) return;
    if (!state.summary) await refreshAll();
  }

  function removeReviewCenter() {
    const wasActive = typeof activeView !== 'undefined' && activeView === 'sprint3-review';
    document.querySelector('[data-sprint3-review-nav]')?.remove();
    if (dom.view) dom.view.remove();
    if (typeof viewMap !== 'undefined') delete viewMap['sprint3-review'];
    if (typeof titleMap !== 'undefined') delete titleMap['sprint3-review'];
    Object.keys(dom).forEach((key) => delete dom[key]);
    state.initialized = false;
    state.summary = null;
    state.rows = [];
    state.detail = null;
    if (wasActive && typeof setActiveView === 'function') setActiveView('dashboard');
  }

  async function authorize() {
    try {
      const profile = await resolveProfile();
      state.profile = profile;
      state.authorized = profileIsManager(profile);
      if (!state.authorized) {
        removeReviewCenter();
        return false;
      }
      ensureMarkup();
      if (!state.initialized) {
        state.initialized = true;
        await refreshAll();
      }
      return true;
    } catch (error) {
      console.warn('Sprint 3 Review Center authorization:', error.message);
      state.authorized = false;
      removeReviewCenter();
      return false;
    }
  }

  async function init() {
    try {
      const supabase = await client();
      await authorize();
      if (!state.authSubscription) {
        const { data } = supabase.auth.onAuthStateChange(() => setTimeout(authorize, 0));
        state.authSubscription = data?.subscription || null;
      }
      document.documentElement.dataset.atlasSprint3Review = VERSION;
    } catch (error) {
      console.warn('Sprint 3 Review Center:', error.message);
    }
  }

  window.AtlasSprint3Review = {
    version: VERSION,
    refresh: refreshAll,
    open: () => state.authorized && setActiveView('sprint3-review')
  };

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();
