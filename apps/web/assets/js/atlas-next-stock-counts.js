(() => {
  'use strict';

  const ENDPOINT = 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-stock-counts';
  const VERSION = 'atlas-next-stock-counts/0.1.0';
  const UNIT_LABELS = Object.freeze({
    inventory: 'Base unit', bottle: 'Bottle', case: 'Case', unit: 'Unit',
    litre: 'Litre', millilitre: 'Millilitre', kilogram: 'Kilogram', gram: 'Gram',
  });

  const state = {
    initialized: false,
    active: false,
    loading: false,
    saving: false,
    snapshot: null,
    detail: null,
    policy: null,
    staff: null,
    sessionId: null,
    sessionFilter: 'active',
    lineFilter: 'all',
    search: '',
    modal: null,
    startWhenReady: false,
    error: null,
    message: null,
    messageTone: 'success',
    messageTimer: null,
  };

  const dom = { view: null, root: null, tabs: null, title: null, service: null, itemSurfaces: [] };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const formatNumber = (value, fallback = '—') => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? fallback
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(Number(value));
  const first = (object, keys) => keys.find((key) => object?.[key] !== null && object?.[key] !== undefined)
    ? object[keys.find((key) => object?.[key] !== null && object?.[key] !== undefined)]
    : null;
  const human = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
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

  function icons() {
    try { window.lucide?.createIcons?.(); } catch (error) { console.warn('Atlas count icons could not render.', error); }
  }

  async function gateway(action, options = {}) {
    if (!window.AtlasGatewayBridge?.request) throw new Error('The Atlas authenticated gateway bridge is unavailable.');
    return window.AtlasGatewayBridge.request(ENDPOINT, action, { timeoutMs: 24000, ...options });
  }

  const snapshotPermissions = () => state.snapshot?.permissions || {};
  const detailPermissions = () => state.detail?.permissions || {};
  const currentSession = () => state.detail?.session
    || (state.snapshot?.sessions || []).find((session) => session.id === state.sessionId)
    || null;
  const currentSummary = () => state.detail?.summary || currentSession()?.summary || {};

  function setMessage(message, tone = 'success') {
    state.message = message || null;
    state.messageTone = tone;
    window.clearTimeout(state.messageTimer);
    if (message) state.messageTimer = window.setTimeout(() => {
      state.message = null;
      if (state.active) render();
    }, 6000);
  }

  function install() {
    if (dom.root) return true;
    dom.view = document.getElementById('view-inventory');
    dom.title = document.getElementById('page-title');
    dom.service = document.getElementById('service-overlay');
    if (!dom.view) return false;

    dom.itemSurfaces = [
      dom.view.querySelector('.inventory-page-hero'),
      dom.view.querySelector('.notice'),
      dom.view.querySelector('.inventory-toolbar'),
      dom.view.querySelector('.inventory-table-wrap'),
    ].filter(Boolean);

    dom.tabs = document.createElement('nav');
    dom.tabs.className = 'atlas-inventory-sections';
    dom.tabs.setAttribute('aria-label', 'Inventory sections');
    dom.tabs.innerHTML = '<button type="button" class="active" data-atlas-inventory-section="items" aria-current="page"><i data-lucide="package"></i><span>Items</span></button><button type="button" data-atlas-inventory-section="counts"><i data-lucide="clipboard-list"></i><span>Stock count</span></button>';
    dom.view.insertBefore(dom.tabs, dom.view.firstChild);

    dom.root = document.createElement('section');
    dom.root.id = 'atlas-next-stock-counts';
    dom.root.className = 'atlas-counts-workspace';
    dom.root.hidden = true;
    dom.root.setAttribute('aria-live', 'polite');
    dom.view.appendChild(dom.root);

    dom.root.addEventListener('click', onWorkspaceClick);
    dom.root.addEventListener('submit', onWorkspaceSubmit);
    dom.root.addEventListener('input', onWorkspaceInput);
    dom.root.addEventListener('change', onWorkspaceChange);
    icons();
    return true;
  }

  function selectTab(section) {
    dom.tabs?.querySelectorAll('[data-atlas-inventory-section]').forEach((button) => {
      const selected = button.dataset.atlasInventorySection === section;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function showItems() {
    if (!install()) return;
    state.active = false;
    state.startWhenReady = false;
    state.modal = null;
    dom.itemSurfaces.forEach((surface) => { surface.hidden = false; });
    dom.root.hidden = true;
    selectTab('items');
    if (window.AtlasNext?.state?.().currentView === 'inventory' && dom.title) dom.title.textContent = 'Inventory';
  }

  function openCounts(options = {}) {
    if (!install()) return;
    if (window.AtlasNext?.state?.().currentView !== 'inventory') window.AtlasNext?.navigate?.('inventory');
    if (dom.service) dom.service.hidden = true;
    state.active = true;
    state.startWhenReady = Boolean(options.start);
    dom.itemSurfaces.forEach((surface) => { surface.hidden = true; });
    dom.root.hidden = false;
    selectTab('counts');
    if (dom.title) dom.title.textContent = 'Stock count';
    if (!state.snapshot && !state.loading) loadSnapshot();
    else {
      render();
      if (state.startWhenReady && snapshotPermissions().can_start) openStartModal();
      else state.startWhenReady = false;
    }
  }

  function tone(status) {
    if (['verified', 'current', 'published', 'counted'].includes(status)) return 'good';
    if (['submitted', 'stale', 'draft', 'pending', 'ready'].includes(status)) return 'warn';
    if (status === 'historical') return 'historical';
    if (['rejected', 'cancelled', 'revoked', 'blocked', 'conflict'].includes(status)) return 'bad';
    return 'neutral';
  }

  function pill(status, label) {
    const normalized = String(status || 'neutral').toLowerCase();
    return `<span class="atlas-count-pill is-${tone(normalized)}">${esc(label || human(normalized))}</span>`;
  }

  function summaryCard(label, value, copy, icon) {
    return `<article class="atlas-count-summary-card"><div><i data-lucide="${icon}"></i><span>${esc(label)}</span></div><strong>${esc(formatNumber(value))}</strong><small>${esc(copy)}</small></article>`;
  }

  function alerts() {
    return [
      state.error ? `<div class="atlas-count-alert is-error"><i data-lucide="triangle-alert"></i><span>${esc(state.error)}</span></div>` : '',
      state.message ? `<div class="atlas-count-alert is-${state.messageTone === 'error' ? 'error' : 'success'}"><i data-lucide="${state.messageTone === 'error' ? 'triangle-alert' : 'circle-check-big'}"></i><span>${esc(state.message)}</span></div>` : '',
    ].join('');
  }

  function hero() {
    const summary = state.snapshot?.summary || {};
    const session = currentSession();
    const detail = Boolean(state.detail);
    return `<header class="atlas-count-hero"><div class="atlas-count-hero-copy"><span class="atlas-count-eyebrow">Checkpoint L1 · Verified inventory evidence</span><h1>${esc(detail ? session?.title || 'Stock count' : 'Current stock counts')}</h1><p>${detail ? 'Record observations in their original units, preserve the evidence, and submit the completed session for manager verification.' : 'Create auditable count sessions through the existing private gateway. Observation and verification do not silently change live inventory.'}</p></div><div class="atlas-count-hero-actions">${detail ? '<button type="button" class="atlas-count-button secondary" data-count-back><i data-lucide="arrow-left"></i>All counts</button>' : ''}<button type="button" class="atlas-count-button secondary" data-count-refresh><i data-lucide="refresh-cw"></i>Refresh</button>${!detail && snapshotPermissions().can_start ? '<button type="button" class="atlas-count-button primary" data-count-start><i data-lucide="clipboard-plus"></i>Start count</button>' : ''}</div><div class="atlas-count-summary-grid">${summaryCard('Verified current', first(summary, ['current_verified_balances', 'current_items']), 'fresh manager-approved balances', 'badge-check')}${summaryCard('Awaiting verification', first(summary, ['submitted_sessions']), 'submitted sessions', 'shield-question')}${summaryCard('Draft sessions', first(summary, ['draft_sessions']), 'work still in progress', 'file-pen-line')}${summaryCard('Catalog coverage', first(summary, ['catalog_items']), 'active inventory items', 'package-check')}</div></header>`;
  }

  function trust() {
    return `<div class="atlas-count-trust"><i data-lucide="shield-check"></i><div><strong>${esc(state.policy?.environment ? human(state.policy.environment) : 'Protected gateway')}</strong><span>Counts remain private until submitted and verified. Only the separately gated manager publication action can create controlled inventory adjustments.</span></div></div>`;
  }

  function classifications() {
    const summary = state.snapshot?.summary || {};
    const values = [
      ['Verified current', first(summary, ['current_items', 'current_verified_balances']), 'good'],
      ['Stale', first(summary, ['stale_items']), 'warn'],
      ['Historical', first(summary, ['historical_items']), 'historical'],
      ['Unverified', first(summary, ['unverified_items']), 'neutral'],
    ];
    return `<section class="atlas-count-classification" aria-label="Inventory quantity trust states">${values.map(([label, value, status]) => `<article class="is-${status}"><span>${esc(label)}</span><strong>${esc(formatNumber(value))}</strong></article>`).join('')}</section>`;
  }

  function filteredSessions() {
    const sessions = Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
    if (state.sessionFilter === 'all') return sessions;
    if (state.sessionFilter === 'active') return sessions.filter((session) => ['draft', 'submitted'].includes(session.status));
    return sessions.filter((session) => session.status === state.sessionFilter);
  }

  function sessionCard(session) {
    const summary = session.summary || {};
    const progress = Math.max(0, Math.min(100, number(summary.progress_percent)));
    const scope = session.scope_type === 'all' ? 'All active inventory' : `${human(session.scope_type)} · ${session.scope_value || 'Selected scope'}`;
    return `<article class="atlas-count-session-card"><header><div><span>${esc(scope)}</span><h3>${esc(session.title || 'Stock count')}</h3></div>${pill(session.status)}</header><p>Started by ${esc(session.started_by_label || 'Atlas staff')} · ${esc(formatDate(session.started_at))}</p><div class="atlas-count-progress" aria-label="${progress}% complete"><i style="width:${progress}%"></i></div><div class="atlas-count-session-stats"><span><strong>${esc(formatNumber(summary.counted_lines, '0'))}</strong> counted</span><span><strong>${esc(formatNumber(summary.skipped_lines, '0'))}</strong> skipped</span><span><strong>${esc(formatNumber(summary.pending_lines, '0'))}</strong> pending</span></div><footer><span>${session.verified_at ? `Verified ${esc(formatDate(session.verified_at))}` : session.submitted_at ? `Submitted ${esc(formatDate(session.submitted_at))}` : `${progress}% complete`}</span><button type="button" data-open-count-session="${esc(session.id)}">Open <i data-lucide="arrow-right"></i></button></footer></article>`;
  }

  function balanceRow(balance) {
    return `<article class="atlas-count-balance-row"><div><strong>${esc(balance.item_name || 'Inventory item')}</strong><span>${esc(balance.bin_location || balance.category || 'Inventory')}</span></div><div><strong>${esc(`${formatNumber(balance.verified_quantity)} ${balance.inventory_unit || ''}`.trim())}</strong><span>${balance.expires_at ? `expires ${esc(formatDate(balance.expires_at))}` : 'expiry not recorded'}</span></div>${pill(balance.freshness_state || 'current')}</article>`;
  }

  function overview() {
    const sessions = filteredSessions();
    const balances = (state.snapshot?.verified_balances || []).filter((balance) => balance.freshness_state === 'current');
    return `<div class="atlas-count-overview-grid"><section class="atlas-count-panel"><header class="atlas-count-panel-head"><div><span>Count sessions</span><h2>Inventory evidence workflow</h2><p>Operational staff may complete drafts. Managers verify submitted sessions before Atlas treats balances as current evidence.</p></div><select data-count-session-filter aria-label="Filter count sessions"><option value="active" ${state.sessionFilter === 'active' ? 'selected' : ''}>Active</option><option value="draft" ${state.sessionFilter === 'draft' ? 'selected' : ''}>Draft</option><option value="submitted" ${state.sessionFilter === 'submitted' ? 'selected' : ''}>Awaiting verification</option><option value="verified" ${state.sessionFilter === 'verified' ? 'selected' : ''}>Verified</option><option value="all" ${state.sessionFilter === 'all' ? 'selected' : ''}>All</option></select></header><div class="atlas-count-session-list">${sessions.length ? sessions.map(sessionCard).join('') : '<div class="atlas-count-empty"><i data-lucide="clipboard-list"></i><h3>No sessions in this view</h3><p>Start a full, location, or category count when the team is ready.</p></div>'}</div></section><aside class="atlas-count-side-stack"><section class="atlas-count-panel"><header class="atlas-count-panel-head"><div><span>Verified evidence</span><h2>Fresh balances</h2><p>Current verified values remain usable only for their configured freshness window.</p></div></header><div class="atlas-count-balance-list">${balances.length ? balances.slice(0, 12).map(balanceRow).join('') : '<div class="atlas-count-empty compact"><i data-lucide="badge-check"></i><h3>No current balances</h3><p>Complete and verify a count to create fresh evidence.</p></div>'}</div></section><section class="atlas-count-panel"><header class="atlas-count-panel-head"><div><span>Evidence contract</span><h2>What verification means</h2></div></header><ul class="atlas-count-contract"><li>Every observation keeps its original quantity, selected unit, staff identity, and time.</li><li>Source changes after a count starts are surfaced as conflicts.</li><li>Manager verification creates private current evidence; it does not publish stock.</li><li>Production publication remains a separate, double-gated manager action.</li></ul></section></aside></div>`;
  }

  function unitOptions(line, selected) {
    const supported = Array.isArray(line.supported_count_units) && line.supported_count_units.length ? line.supported_count_units : ['inventory'];
    return supported.map((unit) => `<option value="${esc(unit)}" ${unit === selected ? 'selected' : ''}>${esc(UNIT_LABELS[unit] || human(unit))}</option>`).join('');
  }

  function sourcePill(line) {
    if (line.source_kind === 'historical_snapshot') return pill('historical', 'Historical opening');
    if (line.source_kind === 'manager_verified_count') return pill('current', 'Previously verified');
    return pill('neutral', 'Production observation');
  }

  function lineMatches(line) {
    if (state.lineFilter !== 'all' && line.line_status !== state.lineFilter) return false;
    const query = state.search.trim().toLowerCase();
    if (!query) return true;
    return [line.item_name, line.category, line.bin_location, line.sku, line.barcode]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
  }

  function lineCard(line) {
    const editable = Boolean(detailPermissions().can_edit);
    const inputQuantity = line.observed_input_quantity ?? line.observed_quantity ?? '';
    const selectedUnit = line.observed_input_unit || 'inventory';
    const variance = line.observed_quantity == null ? null : number(line.observed_quantity) - number(line.expected_quantity);
    const varianceText = variance === null ? 'Not counted' : variance === 0 ? 'No variance' : `${variance > 0 ? '+' : ''}${formatNumber(variance)} ${line.inventory_unit || ''}`.trim();
    return `<form class="atlas-count-line is-${esc(line.line_status || 'pending')} ${line.source_changed_since_start ? 'has-conflict' : ''}" data-count-line-form data-line-id="${esc(line.id)}"><header><div><span>${esc(line.bin_location || line.category || 'Inventory')}</span><h3>${esc(line.item_name || 'Inventory item')}</h3></div><div>${pill(line.quantity_status || 'unverified', `${human(line.quantity_status || 'unverified')} quantity`)}${sourcePill(line)}${pill(line.line_status || 'pending')}</div></header><div class="atlas-count-line-evidence"><div><span>Source quantity</span><strong>${esc(`${formatNumber(line.expected_quantity)} ${line.inventory_unit || ''}`.trim())}</strong></div><div><span>Variance</span><strong class="${variance !== null && variance !== 0 ? 'is-variance' : ''}">${esc(varianceText)}</strong></div><div><span>Counted by</span><strong>${esc(line.counted_by_label || '—')}</strong></div></div>${line.source_kind === 'historical_snapshot' ? '<div class="atlas-count-line-warning"><i data-lucide="history"></i><span>The displayed source quantity is historical evidence and is not treated as current stock.</span></div>' : ''}${line.source_changed_since_start ? '<div class="atlas-count-line-warning is-conflict"><i data-lucide="git-compare-arrows"></i><span>The production source changed after this session started. Manager acknowledgement is required.</span></div>' : ''}<div class="atlas-count-line-entry"><label><span>Observed quantity</span><div class="atlas-count-quantity-control"><button type="button" data-count-step="-1" ${editable ? '' : 'disabled'} aria-label="Decrease observed quantity">−</button><input type="number" min="0" step="0.1" data-count-quantity value="${esc(inputQuantity)}" placeholder="0" ${editable ? '' : 'disabled'} /><button type="button" data-count-step="1" ${editable ? '' : 'disabled'} aria-label="Increase observed quantity">+</button><select data-count-unit aria-label="Count unit for ${esc(line.item_name || 'item')}" ${editable ? '' : 'disabled'}>${unitOptions(line, selectedUnit)}</select><em>base: ${esc(line.inventory_unit || 'units')}</em></div></label><label><span>Count note</span><input type="text" data-count-note value="${esc(line.note || '')}" placeholder="Open bottle estimate, damage, storage note…" ${editable ? '' : 'disabled'} /></label></div>${line.line_status === 'skipped' ? `<p class="atlas-count-skip"><strong>Skipped:</strong> ${esc(line.skipped_reason || 'No reason recorded')}</p>` : ''}<footer><span>${line.counted_at ? esc(formatDate(line.counted_at)) : esc([line.sku, line.barcode].filter(Boolean).join(' · ') || 'Awaiting observation')}</span>${editable ? `<div><button type="button" class="atlas-count-button text" data-count-skip="${esc(line.id)}">Skip</button><button type="submit" class="atlas-count-button primary"><i data-lucide="check"></i>Save count</button></div>` : ''}</footer></form>`;
  }

  function publicationBanner() {
    const session = currentSession();
    const publication = state.detail?.publication;
    if (session?.publication_status === 'published') return '<div class="atlas-count-alert is-success"><i data-lucide="badge-check"></i><span>This verified count was published through the controlled adjustment boundary. Prior quantities and evidence remain preserved.</span></div>';
    if (!publication) return '';
    if (publication.status === 'blocked') return `<div class="atlas-count-alert is-error"><i data-lucide="shield-alert"></i><span><strong>Publication blocked.</strong> ${esc(publication.blocked_reason || 'Review the publication evidence before trying again.')}</span></div>`;
    if (publication.status === 'ready') {
      const enabled = Boolean(state.policy?.publication_environment_enabled && detailPermissions().production_apply_enabled);
      return `<div class="atlas-count-alert ${enabled ? 'is-success' : ''}"><i data-lucide="clipboard-check"></i><span>${enabled ? 'The manager-approved publication plan is ready for its explicit Publish action.' : 'The publication plan is prepared, but production application remains disabled in this deployment.'}</span></div>`;
    }
    return '';
  }

  function detailActions() {
    const permissions = detailPermissions();
    const publication = state.detail?.publication;
    const publishEnabled = publication?.status === 'ready' && permissions.production_apply_enabled && state.policy?.publication_environment_enabled;
    return `<div class="atlas-count-detail-actions">${permissions.can_cancel ? '<button type="button" class="atlas-count-button secondary danger" data-count-cancel><i data-lucide="x"></i>Cancel session</button>' : ''}${permissions.can_reject ? '<button type="button" class="atlas-count-button secondary danger" data-count-reject><i data-lucide="undo-2"></i>Reject</button>' : ''}${permissions.can_verify ? '<button type="button" class="atlas-count-button primary" data-count-verify><i data-lucide="badge-check"></i>Verify count</button>' : ''}${permissions.can_submit ? `<button type="button" class="atlas-count-button primary" data-count-submit ${number(currentSummary().pending_lines) > 0 ? 'disabled' : ''}><i data-lucide="send"></i>Submit for verification</button>` : ''}${permissions.can_prepare_publication ? '<button type="button" class="atlas-count-button primary" data-count-prepare-publication><i data-lucide="file-check-2"></i>Prepare publication</button>' : ''}${publishEnabled ? '<button type="button" class="atlas-count-button publish" data-count-publish><i data-lucide="package-check"></i>Publish verified count</button>' : ''}</div>`;
  }

  function detail() {
    const session = currentSession();
    if (!session) return '<div class="atlas-count-empty"><h3>Stock-count session unavailable</h3></div>';
    const summary = currentSummary();
    const progress = Math.max(0, Math.min(100, number(summary.progress_percent)));
    const lines = (state.detail?.lines || []).filter(lineMatches);
    const scope = session.scope_type === 'all' ? 'All active inventory' : `${human(session.scope_type)} · ${session.scope_value || 'Selected scope'}`;
    return `<section class="atlas-count-panel atlas-count-detail-panel"><header class="atlas-count-detail-head"><div><div class="atlas-count-detail-kicker">${pill(session.status)}<span>${esc(scope)}</span></div><h2>${esc(session.title || 'Stock count')}</h2><p>Started by ${esc(session.started_by_label || 'Atlas staff')} · ${esc(formatDate(session.started_at))}${session.verified_by_label ? ` · verified by ${esc(session.verified_by_label)}` : ''}</p></div>${detailActions()}</header>${publicationBanner()}<div class="atlas-count-progress-block"><div><span>Session progress</span><strong>${progress}%</strong></div><div class="atlas-count-progress"><i style="width:${progress}%"></i></div><div class="atlas-count-session-stats"><span><strong>${formatNumber(summary.counted_lines, '0')}</strong> counted</span><span><strong>${formatNumber(summary.skipped_lines, '0')}</strong> skipped</span><span><strong>${formatNumber(summary.pending_lines, '0')}</strong> pending</span><span><strong>${formatNumber(summary.negative_variances, '0')}</strong> negative variances</span></div></div>${session.status === 'submitted' ? '<div class="atlas-count-alert"><i data-lucide="shield-alert"></i><span>This session is locked for staff edits and awaits manager verification. Verification records private current evidence; it does not publish live stock.</span></div>' : ''}<div class="atlas-count-controls"><label><i data-lucide="search"></i><input type="search" data-count-search placeholder="Search item, category, location or barcode" value="${esc(state.search)}" /></label><select data-count-line-filter aria-label="Filter count lines"><option value="all" ${state.lineFilter === 'all' ? 'selected' : ''}>All lines</option><option value="pending" ${state.lineFilter === 'pending' ? 'selected' : ''}>Pending</option><option value="counted" ${state.lineFilter === 'counted' ? 'selected' : ''}>Counted</option><option value="skipped" ${state.lineFilter === 'skipped' ? 'selected' : ''}>Skipped</option></select></div><div class="atlas-count-line-list">${lines.length ? lines.map(lineCard).join('') : '<div class="atlas-count-empty"><i data-lucide="search-x"></i><h3>No count lines match</h3><p>Clear the search or choose another status.</p></div>'}</div></section>`;
  }

  function startModal() {
    const catalog = state.snapshot?.catalog || [];
    const type = state.modal?.scopeType || 'all';
    const values = [...new Set(catalog.map((item) => type === 'location' ? item.bin_location : item.category).filter(Boolean))].sort();
    return `<div class="atlas-count-modal-backdrop" data-count-modal-backdrop><section class="atlas-count-modal" role="dialog" aria-modal="true" aria-labelledby="atlas-count-modal-title"><header><div><span>Checkpoint L1</span><h2 id="atlas-count-modal-title">Start current stock count</h2><p>Create a private evidence session for the selected inventory scope.</p></div><button type="button" class="atlas-count-modal-close" data-count-modal-close aria-label="Close"><i data-lucide="x"></i></button></header><form data-count-start-form><div class="atlas-count-form-grid"><label><span>Count title</span><input name="title" value="${esc(state.modal?.title || 'Current stock count')}" required /></label><label><span>Scope</span><select name="scope_type" data-count-start-scope><option value="all" ${type === 'all' ? 'selected' : ''}>All active inventory</option><option value="location" ${type === 'location' ? 'selected' : ''}>One storage location</option><option value="category" ${type === 'category' ? 'selected' : ''}>One category</option></select></label>${type !== 'all' ? `<label class="full"><span>${type === 'location' ? 'Storage location' : 'Category'}</span><select name="scope_value" required><option value="">Choose…</option>${values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('')}</select></label>` : ''}<label class="full"><span>Count note</span><textarea name="notes" rows="3" placeholder="Optional instructions for the team">${esc(state.modal?.notes || '')}</textarea></label></div><div class="atlas-count-trust compact"><i data-lucide="shield-check"></i><div><strong>Private evidence session</strong><span>Starting, saving, submitting, and verifying this session do not change production inventory.</span></div></div><footer><button type="button" class="atlas-count-button secondary" data-count-modal-close>Cancel</button><button type="submit" class="atlas-count-button primary"><i data-lucide="clipboard-plus"></i>Start session</button></footer></form></section></div>`;
  }

  function render() {
    if (!state.active || !dom.root) return;
    if (state.loading && !state.snapshot) dom.root.innerHTML = '<div class="atlas-count-state"><span class="atlas-spinner" aria-hidden="true"></span><h2>Loading stock counts</h2><p>Checking role-permitted inventory and the private count-session gateway.</p></div>';
    else if (state.error && !state.snapshot) dom.root.innerHTML = `<div class="atlas-count-state"><i data-lucide="triangle-alert"></i><h2>Stock counts unavailable</h2><p>${esc(state.error)}</p><button type="button" class="atlas-count-button secondary" data-count-retry><i data-lucide="refresh-cw"></i>Try again</button></div>`;
    else if (state.snapshot) dom.root.innerHTML = `${hero()}${alerts()}${trust()}${classifications()}${state.detail ? detail() : overview()}${state.modal?.type === 'start' ? startModal() : ''}`;
    icons();
  }

  async function loadSnapshot(force = false) {
    if (state.loading || (!force && state.snapshot)) return;
    state.loading = true;
    state.error = null;
    render();
    try {
      const payload = await gateway('snapshot');
      state.snapshot = payload.counts || {};
      state.policy = payload.policy || null;
      state.staff = payload.staff || null;
      if (state.startWhenReady && snapshotPermissions().can_start) openStartModal();
      else state.startWhenReady = false;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Stock counts could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openSession(id) {
    state.sessionId = id;
    state.detail = null;
    state.loading = true;
    state.error = null;
    render();
    try {
      const payload = await gateway('detail', { params: { id } });
      state.detail = payload.count || null;
      state.policy = payload.policy || state.policy;
      state.staff = payload.staff || state.staff;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The count session could not load.';
      state.sessionId = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.saving) return null;
    state.saving = true;
    state.error = null;
    try {
      const payload = await gateway(action, { method: 'POST', body });
      state.snapshot = payload.counts || state.snapshot;
      state.detail = payload.detail || state.detail;
      state.policy = payload.policy || state.policy;
      state.staff = payload.staff || state.staff;
      if (payload.detail?.session?.id) state.sessionId = payload.detail.session.id;
      setMessage(successMessage);
      return payload;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The stock-count change could not be saved.';
      throw error;
    } finally {
      state.saving = false;
      render();
    }
  }

  function openStartModal() {
    state.startWhenReady = false;
    state.modal = { type: 'start', scopeType: 'all', title: 'Current stock count', notes: '' };
    render();
    window.requestAnimationFrame(() => dom.root?.querySelector('[data-count-start-form] input[name="title"]')?.focus());
  }

  function closeModal() { state.modal = null; render(); }

  async function startCount(form) {
    const scopeType = form.elements.scope_type.value;
    const payload = await mutate('start', {
      title: form.elements.title.value.trim(),
      scope_type: scopeType,
      scope_value: scopeType === 'all' ? null : form.elements.scope_value.value,
      notes: form.elements.notes.value.trim() || null,
      client_request_id: randomUuid(),
    }, 'Stock-count session started.');
    state.modal = null;
    if (payload?.detail?.session?.id) state.sessionId = payload.detail.session.id;
    render();
  }

  const lineById = (id) => (state.detail?.lines || []).find((line) => line.id === id) || null;

  async function saveLine(form) {
    const line = lineById(form.dataset.lineId);
    const quantity = Number(form.querySelector('[data-count-quantity]')?.value);
    const unit = form.querySelector('[data-count-unit]')?.value || 'inventory';
    const note = form.querySelector('[data-count-note]')?.value.trim() || null;
    if (!line || !Number.isFinite(quantity) || quantity < 0) {
      state.error = 'Enter an observed quantity of zero or more.';
      render();
      return;
    }
    await mutate('save-line', {
      session_id: currentSession().id,
      line_id: line.id,
      line_status: 'counted',
      observed_input_quantity: quantity,
      observed_input_unit: unit,
      count_method: 'manual',
      note,
      skipped_reason: null,
      expected_version: line.version,
      evidence: { capture_surface: 'atlas_next_count_line', unit_selected: unit, client_recorded_at: new Date().toISOString(), interface_version: VERSION },
    }, `${line.item_name} count saved with its original unit evidence.`);
  }

  async function skipLine(id) {
    const line = lineById(id);
    if (!line) return;
    const reason = window.prompt(`Why is ${line.item_name} being skipped?`, line.skipped_reason || 'Not accessible during this count');
    if (!reason?.trim()) return;
    await mutate('save-line', {
      session_id: currentSession().id, line_id: line.id, line_status: 'skipped',
      observed_input_quantity: null, observed_input_unit: 'inventory', count_method: null,
      note: line.note || null, skipped_reason: reason.trim(), expected_version: line.version,
      evidence: { capture_surface: 'atlas_next_count_line', client_recorded_at: new Date().toISOString(), interface_version: VERSION },
    }, `${line.item_name} marked as skipped.`);
  }

  async function verifyCount(acknowledgeConflicts = false) {
    const message = acknowledgeConflicts
      ? 'Acknowledge source conflicts and verify these private current balances? Production inventory will remain unchanged.'
      : 'Verify this count as current private evidence for Atlas? Production inventory will remain unchanged.';
    if (!window.confirm(message)) return;
    try {
      await mutate('verify', { session_id: currentSession().id, acknowledge_conflicts: acknowledgeConflicts }, 'Stock count verified. Atlas may use these balances until they expire.');
    } catch (error) {
      if (!acknowledgeConflicts && /source changed|acknowledge the conflicts/i.test(error instanceof Error ? error.message : '')) {
        state.error = null;
        await verifyCount(true);
      }
    }
  }

  async function preparePublication() {
    const payload = await mutate('prepare-publication', {
      session_id: currentSession().id,
      request_id: state.detail?.publication?.request_id || randomUuid(),
    }, 'Publication plan evaluated.');
    const publication = payload?.detail?.publication;
    setMessage(publication?.status === 'blocked'
      ? publication.blocked_reason || 'Publication is safely blocked.'
      : 'Manager publication plan prepared.', publication?.status === 'blocked' ? 'error' : 'success');
    render();
  }

  async function publishCount() {
    const requestId = state.detail?.publication?.request_id;
    if (!requestId || !state.policy?.publication_environment_enabled || !detailPermissions().production_apply_enabled) return;
    if (!window.confirm('Publish this manager-verified count as controlled inventory adjustments? This is the only L1 action that may change live stock.')) return;
    await mutate('publish', { session_id: currentSession().id, request_id: requestId }, 'Verified count published. Prior quantities and count evidence remain preserved.');
  }

  function onWorkspaceClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-count-refresh], [data-count-retry]')) {
      if (state.detail && state.sessionId) openSession(state.sessionId); else { state.snapshot = null; loadSnapshot(true); }
    } else if (target.closest('[data-count-start]')) openStartModal();
    else if (target.closest('[data-count-modal-close]')) closeModal();
    else if (target.matches('[data-count-modal-backdrop]')) closeModal();
    else if (target.closest('[data-open-count-session]')) openSession(target.closest('[data-open-count-session]').dataset.openCountSession);
    else if (target.closest('[data-count-back]')) { state.detail = null; state.sessionId = null; state.search = ''; state.lineFilter = 'all'; render(); }
    else if (target.closest('[data-count-step]')) {
      const step = target.closest('[data-count-step]');
      const input = step.closest('[data-count-line-form]')?.querySelector('[data-count-quantity]');
      if (input) input.value = String(Math.max(0, number(input.value) + number(step.dataset.countStep)));
    } else if (target.closest('[data-count-skip]')) skipLine(target.closest('[data-count-skip]').dataset.countSkip).catch(() => undefined);
    else if (target.closest('[data-count-submit]') && number(currentSummary().pending_lines) === 0 && window.confirm('Submit this completed count for manager verification? Staff editing will be locked.')) mutate('submit', { session_id: currentSession().id, notes: null }, 'Stock count submitted for manager verification.').catch(() => undefined);
    else if (target.closest('[data-count-verify]')) verifyCount(false).catch(() => undefined);
    else if (target.closest('[data-count-reject]')) {
      const reason = window.prompt('Why should this submitted count be rejected?', 'Count requires correction');
      if (reason?.trim()) mutate('reject', { session_id: currentSession().id, reason: reason.trim() }, 'Stock count rejected for correction.').catch(() => undefined);
    } else if (target.closest('[data-count-cancel]') && window.confirm('Cancel this stock-count session? The audit history will remain preserved.')) mutate('cancel', { session_id: currentSession().id, reason: 'Cancelled from the Atlas replacement interface' }, 'Stock-count session cancelled.').catch(() => undefined);
    else if (target.closest('[data-count-prepare-publication]')) preparePublication().catch(() => undefined);
    else if (target.closest('[data-count-publish]')) publishCount().catch(() => undefined);
  }

  function onWorkspaceSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches('[data-count-start-form]')) { event.preventDefault(); startCount(form).catch(() => undefined); }
    else if (form.matches('[data-count-line-form]')) { event.preventDefault(); saveLine(form).catch(() => undefined); }
  }

  function onWorkspaceInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-count-search]')) return;
    state.search = target.value;
    const caret = target.selectionStart ?? state.search.length;
    render();
    window.requestAnimationFrame(() => {
      const replacement = dom.root?.querySelector('[data-count-search]');
      replacement?.focus();
      replacement?.setSelectionRange?.(caret, caret);
    });
  }

  function onWorkspaceChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-count-session-filter]')) { state.sessionFilter = target.value; render(); }
    else if (target.matches('[data-count-line-filter]')) { state.lineFilter = target.value; render(); }
    else if (target.matches('[data-count-start-scope]') && state.modal?.type === 'start') {
      const form = target.closest('form');
      state.modal.scopeType = target.value;
      state.modal.title = form?.elements.title?.value || state.modal.title;
      state.modal.notes = form?.elements.notes?.value || state.modal.notes;
      render();
    }
  }

  function captureApplicationClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const section = target.closest('[data-atlas-inventory-section]');
    if (section) {
      event.preventDefault();
      if (section.dataset.atlasInventorySection === 'counts') openCounts(); else showItems();
      return;
    }
    if (target.closest('[data-action="start-count"]')) {
      event.preventDefault(); event.stopImmediatePropagation(); openCounts({ start: true }); return;
    }
    if (target.closest('[data-service-action="count"]')) {
      event.preventDefault(); event.stopImmediatePropagation(); openCounts(); return;
    }
    if (state.active && target.closest('[data-service-view], .nav-item[data-view], [data-command-view]')) showItems();
  }

  function init() {
    if (state.initialized || !install()) return;
    state.initialized = true;
    document.addEventListener('click', captureApplicationClick, true);
    window.addEventListener('popstate', () => { if (location.hash.replace(/^#/, '') !== 'inventory') showItems(); });
    window.addEventListener('pagehide', () => window.clearTimeout(state.messageTimer), { once: true });
  }

  window.AtlasNextStockCounts = Object.freeze({
    version: VERSION,
    open: openCounts,
    close: showItems,
    refresh: () => state.detail && state.sessionId ? openSession(state.sessionId) : loadSnapshot(true),
    state: () => ({ active: state.active, loading: state.loading, sessionId: state.sessionId, role: state.staff?.role || null, policy: state.policy ? { ...state.policy } : null }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
