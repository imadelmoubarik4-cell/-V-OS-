(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 30000;
  const PAGE_SIZE = 20;
  const SECTION_ORDER = [
    'overview', 'sales', 'inventory', 'recipes', 'purchasing', 'suppliers',
    'waste', 'labour', 'operations', 'knowledge', 'saved', 'exports'
  ];

  const state = {
    snapshot: null,
    staff: null,
    controls: null,
    policy: null,
    activeSection: 'overview',
    preset: 'last_30_days',
    comparison: 'previous_period',
    startDate: '',
    endDate: '',
    comparisonStartDate: '',
    comparisonEndDate: '',
    filters: {
      search: '',
      status: '',
      category: '',
      supplier: '',
      employee: ''
    },
    loading: false,
    refreshing: false,
    error: null,
    message: null,
    page: 1,
    sortKey: '',
    sortDirection: 'asc',
    askOpen: false,
    askQuestion: '',
    askLoading: false,
    askAnswer: null,
    savedOpen: false,
    initialized: false,
    viewObserver: null,
    searchTimer: null,
    authTimer: null
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function escapeCsv(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatIsk(value) {
    const parsed = number(value);
    if (parsed === null) return 'Unavailable';
    return `${Math.round(parsed).toLocaleString('en-US')} ISK`;
  }

  function formatNumber(value, digits = 0) {
    const parsed = number(value);
    if (parsed === null) return 'Unavailable';
    return parsed.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function formatPercent(value, digits = 1) {
    const parsed = number(value);
    if (parsed === null) return 'Unavailable';
    return `${parsed.toFixed(digits)}%`;
  }

  function formatDateTime(value) {
    if (!value) return 'Not refreshed';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(String(value).length === 10 ? `${value}T12:00:00Z` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: String(value).length === 10 ? 'UTC' : 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric'
    }).format(date);
  }

  function formatDateTimeShort(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function formatValue(value, unit) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    if (unit === 'ISK') return formatIsk(value);
    if (unit === 'percent') return formatPercent(value);
    if (unit === 'hours') return `${formatNumber(value, 1)} h`;
    return formatNumber(value, Number(value) % 1 ? 1 : 0);
  }

  function host() {
    return document.getElementById('reports-view');
  }

  function viewVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  function endpoint() {
    return String(cfg.REPORTS_API || '').trim();
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  function requestParams() {
    const params = {
      preset: state.preset,
      comparison: state.comparison,
      section: state.activeSection
    };
    if (state.preset === 'custom') {
      params.start_date = state.startDate;
      params.end_date = state.endDate;
    }
    if (state.comparison === 'custom') {
      params.comparison_start_date = state.comparisonStartDate;
      params.comparison_end_date = state.comparisonEndDate;
    }
    Object.entries(state.filters).forEach(([key, value]) => {
      if (String(value || '').trim()) params[key] = String(value).trim();
    });
    return params;
  }

  async function api(action, options = {}) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Reports API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Reports.');

    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    Object.entries({ ...requestParams(), ...(options.params || {}) }).forEach(([key, value]) => {
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
          'content-type': 'application/json'
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Reports request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Reports took too long to respond. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function sections() {
    return Array.isArray(state.snapshot?.sections) ? state.snapshot.sections : [];
  }

  function report(section = state.activeSection) {
    return state.snapshot?.reports?.[section] || {};
  }

  function sectionMeta(section = state.activeSection) {
    return sections().find((entry) => entry.key === section) || {
      key: section,
      name: humanize(section),
      status: 'no_records',
      description: ''
    };
  }

  function rowsForSection(section = state.activeSection) {
    const data = report(section);
    if (Array.isArray(data.rows)) return data.rows;
    if (section === 'knowledge' && Array.isArray(data.team)) return data.team;
    if (section === 'inventory' && Array.isArray(data.categories) && state.filters.status === 'category_value') return data.categories;
    return [];
  }

  function activeFilterCount() {
    return Object.values(state.filters).filter((value) => String(value || '').trim()).length;
  }

  function sourceStatusLabel(value) {
    const labels = {
      connected: 'Connected', partial: 'Partially complete', not_connected: 'Not connected',
      no_records: 'No records', no_data_for_period: 'No data for period', complete: 'Complete',
      unavailable: 'Unavailable', estimated: 'Estimated', permission_restricted: 'Permission restricted'
    };
    return labels[value] || humanize(value || 'unknown');
  }

  function statusPill(value, label) {
    return `<span class="report-status is-${escapeHtml(value || 'neutral')}"><i></i>${escapeHtml(label || sourceStatusLabel(value))}</span>`;
  }

  function loadingMarkup() {
    return `<section class="reports-shell reports-state">
      <div class="reports-state-icon"><i data-lucide="chart-no-axes-combined"></i></div>
      <h2>Loading Reports</h2>
      <p>Checking live sources, permissions, reporting periods and data quality.</p>
      <div class="reports-skeleton-grid">${Array.from({ length: 4 }, () => '<span></span>').join('')}</div>
    </section>`;
  }

  function errorMarkup() {
    return `<section class="reports-shell reports-state">
      <div class="reports-state-icon is-error"><i data-lucide="chart-no-axes-column-increasing"></i></div>
      <h2>Reports unavailable</h2>
      <p>${escapeHtml(state.error || 'The report could not load.')}</p>
      <button type="button" class="reports-primary" data-reports-refresh><i data-lucide="refresh-cw"></i>Try again</button>
    </section>`;
  }

  function periodOptionsMarkup() {
    const options = [
      ['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7_days', 'Last 7 days'],
      ['last_30_days', 'Last 30 days'], ['this_week', 'This week'], ['last_week', 'Last week'],
      ['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'],
      ['year_to_date', 'Year to date'], ['custom', 'Custom range']
    ];
    return options.map(([value, label]) => `<option value="${value}" ${state.preset === value ? 'selected' : ''}>${label}</option>`).join('');
  }

  function comparisonOptionsMarkup() {
    const options = [
      ['previous_period', 'Previous period'], ['previous_week', 'Previous week'],
      ['previous_month', 'Previous month'], ['previous_year', 'Previous year'],
      ['custom', 'Custom comparison'], ['none', 'No comparison']
    ];
    return options.map(([value, label]) => `<option value="${value}" ${state.comparison === value ? 'selected' : ''}>${label}</option>`).join('');
  }

  function controlsMarkup() {
    return `<section class="reports-controls">
      <div class="reports-control-group">
        <label><span>Reporting period</span><select data-reports-preset>${periodOptionsMarkup()}</select></label>
        ${state.preset === 'custom' ? `<div class="reports-date-pair"><label><span>From</span><input type="date" data-reports-start value="${escapeHtml(state.startDate)}"></label><label><span>To</span><input type="date" data-reports-end value="${escapeHtml(state.endDate)}"></label></div>` : ''}
      </div>
      <div class="reports-control-group">
        <label><span>Comparison</span><select data-reports-comparison>${comparisonOptionsMarkup()}</select></label>
        ${state.comparison === 'custom' ? `<div class="reports-date-pair"><label><span>Compare from</span><input type="date" data-reports-comparison-start value="${escapeHtml(state.comparisonStartDate)}"></label><label><span>Compare to</span><input type="date" data-reports-comparison-end value="${escapeHtml(state.comparisonEndDate)}"></label></div>` : ''}
      </div>
      <div class="reports-control-actions">
        <button type="button" data-reports-refresh><i data-lucide="refresh-cw"></i>Refresh</button>
        <button type="button" data-reports-save-view><i data-lucide="bookmark-plus"></i>Save view</button>
        <button type="button" class="reports-primary" data-reports-export="csv"><i data-lucide="download"></i>Export CSV</button>
      </div>
    </section>`;
  }

  function filterOptions(name) {
    const options = state.snapshot?.filter_options?.[name];
    return Array.isArray(options) ? options : [];
  }

  function filtersMarkup() {
    const categories = filterOptions('categories');
    const suppliers = filterOptions('suppliers');
    const employees = filterOptions('employees');
    const statuses = filterOptions('statuses');
    const count = activeFilterCount();
    return `<section class="reports-filter-shell">
      <div class="reports-filter-row">
        <label class="reports-search"><i data-lucide="search"></i><input type="search" data-reports-search value="${escapeHtml(state.filters.search)}" placeholder="Search the current report"></label>
        <label><span>Status</span><select data-reports-filter="status"><option value="">All statuses</option>${statuses.map((value) => `<option value="${escapeHtml(value)}" ${state.filters.status === value ? 'selected' : ''}>${escapeHtml(humanize(value))}</option>`).join('')}</select></label>
        <label><span>Category</span><select data-reports-filter="category"><option value="">All categories</option>${categories.map((value) => `<option value="${escapeHtml(value)}" ${state.filters.category === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>
        <label><span>Supplier</span><select data-reports-filter="supplier"><option value="">All suppliers</option>${suppliers.map((value) => `<option value="${escapeHtml(value)}" ${state.filters.supplier === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>
        ${employees.length ? `<label><span>Employee</span><select data-reports-filter="employee"><option value="">All employees</option>${employees.map((entry) => `<option value="${escapeHtml(entry.id)}" ${state.filters.employee === entry.id ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select></label>` : ''}
        ${count ? `<button type="button" class="reports-clear-filters" data-reports-clear-filters><i data-lucide="filter-x"></i>Clear ${count}</button>` : ''}
      </div>
      ${count ? `<div class="reports-filter-chips">${Object.entries(state.filters).filter(([, value]) => String(value || '').trim()).map(([key, value]) => `<button type="button" data-reports-remove-filter="${escapeHtml(key)}"><span>${escapeHtml(humanize(key))}: ${escapeHtml(value)}</span><i data-lucide="x"></i></button>`).join('')}</div>` : ''}
    </section>`;
  }

  function navigationMarkup() {
    return `<nav class="reports-navigation" aria-label="Report sections">${sections().map((section) => `<button type="button" data-reports-section="${escapeHtml(section.key)}" class="${state.activeSection === section.key ? 'is-active' : ''}">
      <span>${escapeHtml(section.name)}</span>${statusPill(section.status, '')}
    </button>`).join('')}</nav>`;
  }

  function changeMarkup(kpi) {
    const change = number(kpi.change_value);
    const percentage = number(kpi.change_percent);
    if (change === null && percentage === null) return '<small class="report-change is-neutral">No equivalent comparison</small>';
    const direction = kpi.trend === 'up' ? 'trending-up' : kpi.trend === 'down' ? 'trending-down' : 'minus';
    const sign = change !== null && change > 0 ? '+' : '';
    const text = percentage !== null ? `${percentage > 0 ? '+' : ''}${percentage.toFixed(1)}%` : `${sign}${formatValue(change, kpi.unit)}`;
    return `<small class="report-change is-${escapeHtml(kpi.trend || 'neutral')}"><i data-lucide="${direction}"></i>${escapeHtml(text)} vs comparison</small>`;
  }

  function kpisMarkup() {
    const kpis = Array.isArray(state.snapshot?.kpis) ? state.snapshot.kpis : [];
    if (!kpis.length) return '';
    return `<section class="reports-kpi-grid">${kpis.map((kpi) => `<button type="button" class="report-kpi" data-reports-section="${escapeHtml(kpi.section)}">
      <span class="report-kpi-head"><span>${escapeHtml(kpi.label)}</span>${statusPill(kpi.status, '')}</span>
      <strong>${escapeHtml(formatValue(kpi.value, kpi.unit))}</strong>
      ${changeMarkup(kpi)}
      <p>${escapeHtml(kpi.detail || '')}</p>
    </button>`).join('')}</section>`;
  }

  function attentionMarkup() {
    const entries = Array.isArray(state.snapshot?.attention) ? state.snapshot.attention : [];
    return `<section class="reports-panel reports-attention">
      <header><div><span class="reports-eyebrow">Evidence-backed queue</span><h2>Requires attention</h2></div><span>${entries.length} items</span></header>
      <div class="reports-attention-list">${entries.length ? entries.map((entry) => `<button type="button" data-reports-section="${escapeHtml(entry.section)}" class="is-${escapeHtml(entry.tone || 'neutral')}">
        <span class="reports-attention-icon"><i data-lucide="${entry.tone === 'danger' ? 'circle-alert' : entry.tone === 'warn' ? 'triangle-alert' : 'info'}"></i></span>
        <span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.detail)}</small><em>${escapeHtml(entry.source || humanize(entry.section))}</em></span>
        <i data-lucide="arrow-right"></i>
      </button>`).join('') : '<div class="reports-empty-inline"><i data-lucide="circle-check-big"></i><span>No evidence-backed attention items for the selected period.</span></div>'}</div>
    </section>`;
  }

  function sourceCoverageMarkup() {
    const sources = Array.isArray(state.snapshot?.data_sources) ? state.snapshot.data_sources : [];
    return `<section class="reports-panel reports-sources-overview">
      <header><div><span class="reports-eyebrow">Data quality</span><h2>Source coverage</h2></div><button type="button" data-reports-section="exports">Export details</button></header>
      <div>${sources.map((source) => `<article>
        <span class="reports-source-icon"><i data-lucide="${source.status === 'connected' ? 'database-zap' : source.status === 'partial' ? 'database-backup' : 'database-off'}"></i></span>
        <div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.note || '')}</small><em>Included ${formatNumber(source.records_included || 0)} · Excluded ${formatNumber(source.records_excluded || 0)} · Refreshed ${escapeHtml(formatDateTime(source.last_refreshed_at))}</em></div>
        ${statusPill(source.status, '')}
      </article>`).join('')}</div>
    </section>`;
  }

  function overviewMarkup() {
    const summary = report('overview').summary || {};
    return `<div class="reports-overview">
      ${kpisMarkup()}
      <div class="reports-overview-grid">
        ${attentionMarkup()}
        <section class="reports-panel reports-summary-card">
          <header><div><span class="reports-eyebrow">Manager summary</span><h2>Operational picture</h2></div></header>
          <dl>
            <div><dt>Business performance</dt><dd>${escapeHtml(summary.business_performance || 'No performance summary available.')}</dd></div>
            <div><dt>Service readiness</dt><dd>${escapeHtml(summary.service_readiness || 'No readiness data available.')}</dd></div>
            <div><dt>Stock risk</dt><dd>${escapeHtml(summary.stock_risk || 'No stock data available.')}</dd></div>
            <div><dt>Trust state</dt><dd>${summary.data_complete_enough ? 'At least one live operational source contains data.' : 'Connected sources do not yet contain enough records for a complete overview.'}</dd></div>
          </dl>
        </section>
      </div>
      ${sourceCoverageMarkup()}
    </div>`;
  }

  function unavailableMarkup(section) {
    const data = report(section);
    const meta = sectionMeta(section);
    return `<section class="reports-panel reports-unavailable">
      <div><i data-lucide="plug-zap"></i></div>
      <span>${escapeHtml(meta.name)}</span>
      <h2>${escapeHtml(data.message || meta.description || 'Data source not connected')}</h2>
      <p>Atlas does not replace missing data with sample values. Connect and verify the source before this report can calculate trusted results.</p>
      ${statusPill(meta.status, '')}
    </section>`;
  }

  function summaryCardsMarkup(summary, definitions) {
    return `<section class="reports-summary-grid">${definitions.map((definition) => {
      const raw = summary?.[definition.key];
      const unavailable = raw === null || raw === undefined;
      return `<article><span><i data-lucide="${escapeHtml(definition.icon)}"></i>${escapeHtml(definition.label)}</span><strong>${unavailable ? 'Unavailable' : escapeHtml(formatValue(raw, definition.unit))}</strong><small>${escapeHtml(definition.note || '')}</small></article>`;
    }).join('')}</section>`;
  }

  function barChartMarkup(rows, options) {
    const usable = rows.filter((row) => number(row[options.valueKey]) !== null && number(row[options.valueKey]) >= 0).slice(0, options.limit || 10);
    if (!usable.length || !usable.some((row) => number(row[options.valueKey]) > 0)) {
      return `<div class="reports-chart-empty"><i data-lucide="chart-no-axes-column"></i><span>${escapeHtml(options.empty || 'No values are available for this chart.')}</span></div>`;
    }
    const max = Math.max(...usable.map((row) => number(row[options.valueKey]) || 0), 1);
    const total = usable.reduce((sum, row) => sum + (number(row[options.valueKey]) || 0), 0);
    return `<figure class="reports-bar-chart" aria-label="${escapeHtml(options.title)}">
      <figcaption><strong>${escapeHtml(options.title)}</strong><small>${escapeHtml(options.summary || `${usable.length} rows · total ${formatValue(total, options.unit)}`)}</small></figcaption>
      <div>${usable.map((row) => {
        const value = number(row[options.valueKey]) || 0;
        return `<article><span>${escapeHtml(row[options.labelKey] || 'Unlabelled')}</span><div><i style="width:${Math.max(2, value / max * 100)}%"></i></div><strong>${escapeHtml(formatValue(value, options.unit))}</strong></article>`;
      }).join('')}</div>
    </figure>`;
  }

  function columnsForSection(section) {
    const columns = {
      inventory: [
        ['name', 'Item', 'text'], ['category', 'Category', 'text'], ['quantity', 'Quantity', 'number'],
        ['unit', 'Unit', 'text'], ['par_level', 'Par', 'number'], ['status', 'Status', 'status'],
        ['supplier', 'Supplier', 'text'], ['cost_price', 'Unit cost', 'ISK'], ['estimated_value', 'Value', 'ISK'],
        ['updated_at', 'Updated', 'datetime'], ['_action', '', 'action']
      ],
      recipes: [
        ['name', 'Recipe', 'text'], ['type', 'Category', 'text'], ['availability_state', 'State', 'status'],
        ['menu_price', 'Menu price', 'ISK'], ['estimated_cost_per_serving', 'Cost / serve', 'ISK'],
        ['estimated_gross_profit', 'Gross profit', 'ISK'], ['estimated_margin_percent', 'Margin', 'percent'],
        ['estimated_servings_available', 'Servings', 'number'], ['missing_links', 'Missing links', 'number'],
        ['updated_at', 'Updated', 'datetime'], ['_action', '', 'action']
      ],
      purchasing: [
        ['created_at', 'Date', 'datetime'], ['item_name', 'Item', 'text'], ['movement_type', 'Movement', 'status'],
        ['supplier', 'Supplier', 'text'], ['quantity_change', 'Quantity', 'number'], ['unit_cost', 'Unit cost', 'ISK'],
        ['total_cost', 'Total cost', 'ISK'], ['note', 'Note', 'text'], ['_action', '', 'action']
      ],
      suppliers: [
        ['supplier', 'Supplier', 'text'], ['active_item_count', 'Active items', 'number'],
        ['movement_count', 'Movements', 'number'], ['spend', 'Spend', 'ISK'],
        ['last_movement_at', 'Latest movement', 'datetime'], ['_action', '', 'action']
      ],
      waste: [
        ['created_at', 'Date', 'datetime'], ['item_name', 'Item', 'text'], ['movement_type', 'Type', 'status'],
        ['quantity_change', 'Quantity', 'number'], ['estimated_value', 'Estimated value', 'ISK'],
        ['note', 'Note', 'text'], ['_action', '', 'action']
      ],
      labour: [
        ['starts_at', 'Start', 'datetime'], ['person_label', 'Employee', 'text'], ['role_name', 'Role', 'text'],
        ['ends_at', 'End', 'datetime'], ['planned_hours', 'Hours', 'hours'], ['published', 'Published', 'boolean'],
        ['note', 'Note', 'text'], ['_action', '', 'action']
      ],
      operations: [
        ['scheduled_date', 'Date', 'date'], ['template_name', 'Checklist', 'text'], ['routine_type', 'Type', 'text'],
        ['status', 'Status', 'status'], ['assigned_to_label', 'Assigned', 'text'],
        ['completed_at', 'Completed', 'datetime'], ['manager_signed_off_at', 'Manager sign-off', 'datetime'],
        ['_action', '', 'action']
      ],
      knowledge: [
        ['name', 'Employee', 'text'], ['role', 'Role', 'text'], ['required_completed', 'Completed', 'number'],
        ['required_total', 'Required', 'number'], ['_training_percent', 'Progress', 'percent'], ['_action', '', 'action']
      ]
    };
    return columns[section] || [];
  }

  function derivedValue(row, key) {
    if (key === '_training_percent') {
      const total = number(row.required_total) || 0;
      return total ? (number(row.required_completed) || 0) / total * 100 : 100;
    }
    return row[key];
  }

  function cellValue(row, column, section) {
    const [key, , type] = column;
    if (type === 'action') return `<button type="button" class="reports-row-action" data-reports-source="${escapeHtml(section)}" data-reports-record="${escapeHtml(row.id || row.profile_id || row.item_id || '')}">Open source<i data-lucide="arrow-up-right"></i></button>`;
    const value = derivedValue(row, key);
    if (value === null || value === undefined || value === '') return '<span class="reports-cell-empty">Unavailable</span>';
    if (type === 'ISK') return escapeHtml(formatIsk(value));
    if (type === 'percent') return escapeHtml(formatPercent(value));
    if (type === 'hours') return `${escapeHtml(formatNumber(value, 1))} h`;
    if (type === 'number') return escapeHtml(formatNumber(value, Number(value) % 1 ? 1 : 0));
    if (type === 'datetime') return escapeHtml(formatDateTimeShort(value));
    if (type === 'date') return escapeHtml(formatDate(value));
    if (type === 'boolean') return statusPill(value ? 'connected' : 'partial', value ? 'Yes' : 'No');
    if (type === 'status') return statusPill(String(value), humanize(value));
    return escapeHtml(value);
  }

  function sortedRows(section) {
    const rows = [...rowsForSection(section)];
    if (!state.sortKey) return rows;
    const direction = state.sortDirection === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      const aValue = derivedValue(a, state.sortKey);
      const bValue = derivedValue(b, state.sortKey);
      if (aValue === bValue) return 0;
      if (aValue === null || aValue === undefined) return 1;
      if (bValue === null || bValue === undefined) return -1;
      const aNumber = number(aValue);
      const bNumber = number(bValue);
      if (aNumber !== null && bNumber !== null) return (aNumber - bNumber) * direction;
      return String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' }) * direction;
    });
  }

  function reportTableMarkup(section) {
    const columns = columnsForSection(section);
    const allRows = sortedRows(section);
    if (!columns.length) return '';
    const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = (state.page - 1) * PAGE_SIZE;
    const rows = allRows.slice(start, start + PAGE_SIZE);
    return `<section class="reports-panel reports-table-panel">
      <header><div><span class="reports-eyebrow">Supporting rows</span><h2>${escapeHtml(sectionMeta(section).name)} detail</h2><p>${allRows.length} rows match the current period and filters.</p></div><button type="button" data-reports-export="csv"><i data-lucide="download"></i>Export rows</button></header>
      <div class="reports-table-scroll"><table class="reports-table"><thead><tr>${columns.map(([key, label, type]) => `<th ${type === 'action' ? '' : `data-reports-sort="${escapeHtml(key)}"`} class="${state.sortKey === key ? 'is-sorted' : ''}">${escapeHtml(label)}${type !== 'action' ? `<i data-lucide="${state.sortKey === key && state.sortDirection === 'desc' ? 'arrow-down' : 'arrow-up-down'}"></i>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${columns.map((column) => `<td>${cellValue(row, column, section)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}"><div class="reports-empty-inline"><i data-lucide="inbox"></i><span>No records match this report and filter combination.</span></div></td></tr>`}</tbody></table></div>
      <footer><span>Rows ${allRows.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, allRows.length)} of ${allRows.length}</span><div><button type="button" data-reports-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i>Previous</button><span>Page ${state.page} of ${totalPages}</span><button type="button" data-reports-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>Next<i data-lucide="chevron-right"></i></button></div></footer>
    </section>`;
  }

  function formulaMarkup(section) {
    const data = report(section);
    if (!data.formula && !data.permission_note) return '';
    return `<section class="reports-formula"><i data-lucide="sigma"></i><div>${data.formula ? `<strong>Calculation</strong><p>${escapeHtml(data.formula)}</p>` : ''}${data.permission_note ? `<strong>Permission boundary</strong><p>${escapeHtml(data.permission_note)}</p>` : ''}</div></section>`;
  }

  function inventoryMarkup() {
    const data = report('inventory');
    const summary = data.summary || {};
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(summary, [
        { key: 'active_items', label: 'Active items', icon: 'boxes', unit: 'count' },
        { key: 'estimated_value', label: 'Estimated value', icon: 'circle-dollar-sign', unit: 'ISK', note: 'Excludes missing cost' },
        { key: 'below_par', label: 'Below par', icon: 'gauge', unit: 'count' },
        { key: 'out_of_stock', label: 'Out of stock', icon: 'package-x', unit: 'count' },
        { key: 'missing_cost', label: 'Missing cost', icon: 'badge-dollar-sign', unit: 'count' },
        { key: 'missing_supplier', label: 'Missing supplier', icon: 'truck', unit: 'count' }
      ])}
      <div class="reports-chart-grid">${barChartMarkup(data.categories || [], { title: 'Inventory value by category', labelKey: 'category', valueKey: 'estimated_value', unit: 'ISK', empty: 'Add complete item costs to unlock category valuation.' })}<section class="reports-panel reports-quality-card"><header><h2>Valuation quality</h2></header><dl><div><dt>Items included</dt><dd>${formatNumber(Math.max(0, (number(summary.active_items) || 0) - (number(summary.missing_cost) || 0)))}</dd></div><div><dt>Items excluded</dt><dd>${formatNumber(summary.missing_cost || 0)}</dd></div><div><dt>Missing par</dt><dd>${formatNumber(summary.missing_par || 0)}</dd></div><div><dt>Recently updated</dt><dd>${formatNumber(summary.recently_updated || 0)}</dd></div></dl></section></div>
      ${formulaMarkup('inventory')}${reportTableMarkup('inventory')}
    </div>`;
  }

  function recipesMarkup() {
    const data = report('recipes');
    const summary = data.summary || {};
    const distribution = [
      { label: 'Ready', value: summary.ready }, { label: 'Needs attention', value: summary.needs_attention },
      { label: 'Unavailable', value: summary.unavailable }, { label: 'Incomplete setup', value: summary.incomplete_setup }
    ];
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(summary, [
        { key: 'active_recipes', label: 'Active recipes', icon: 'book-open', unit: 'count' },
        { key: 'shown_on_menu', label: 'Shown on menu', icon: 'panel-top', unit: 'count' },
        { key: 'ready', label: 'Ready', icon: 'circle-check-big', unit: 'count' },
        { key: 'needs_attention', label: 'Needs attention', icon: 'triangle-alert', unit: 'count' },
        { key: 'unavailable', label: 'Unavailable', icon: 'circle-x', unit: 'count' },
        { key: 'incomplete_setup', label: 'Incomplete setup', icon: 'unlink', unit: 'count' }
      ])}
      <div class="reports-chart-grid">${barChartMarkup(distribution, { title: 'Recipe availability states', labelKey: 'label', valueKey: 'value', unit: 'count' })}<section class="reports-panel reports-quality-card"><header><h2>Menu engineering</h2></header><div class="reports-empty-inline"><i data-lucide="scatter-chart"></i><span>Popularity classifications remain unavailable until sales mapping is connected and recipe costs are complete.</span></div></section></div>
      ${formulaMarkup('recipes')}${reportTableMarkup('recipes')}
    </div>`;
  }

  function purchasingMarkup() {
    const data = report('purchasing');
    const summary = data.summary || {};
    const priceChanges = Array.isArray(data.price_changes) ? data.price_changes : [];
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(summary, [
        { key: 'spend', label: 'Movement spend', icon: 'receipt-text', unit: 'ISK', note: 'Not a PO ledger' },
        { key: 'movement_count', label: 'Costed movements', icon: 'arrow-left-right', unit: 'count' },
        { key: 'open_purchase_orders', label: 'Open orders', icon: 'shopping-cart', unit: 'count', note: 'Source not connected' },
        { key: 'overdue_orders', label: 'Overdue orders', icon: 'clock-alert', unit: 'count', note: 'Source not connected' },
        { key: 'receiving_differences', label: 'Receiving differences', icon: 'package-search', unit: 'count', note: 'Source not connected' }
      ])}
      <div class="reports-chart-grid">${barChartMarkup(priceChanges.slice(0, 10), { title: 'Largest recorded unit-cost changes', labelKey: 'item_name', valueKey: 'absolute_change', unit: 'ISK', empty: 'At least two compatible unit-cost records per item are required.' })}<section class="reports-panel reports-quality-card"><header><h2>Purchase-order status</h2></header><div class="reports-empty-inline"><i data-lucide="database-off"></i><span>Purchase orders, expected deliveries and receiving differences are not connected. Atlas does not derive them from restock movements.</span></div></section></div>
      ${formulaMarkup('purchasing')}${reportTableMarkup('purchasing')}
    </div>`;
  }

  function suppliersMarkup() {
    const data = report('suppliers');
    const rows = Array.isArray(data.rows) ? data.rows : [];
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(data.summary || {}, [
        { key: 'active_suppliers', label: 'Active suppliers', icon: 'truck', unit: 'count' },
        { key: 'supplier_rows', label: 'Suppliers with evidence', icon: 'database', unit: 'count' }
      ])}
      ${barChartMarkup(rows, { title: 'Recorded spend by supplier', labelKey: 'supplier', valueKey: 'spend', unit: 'ISK', empty: 'No costed supplier movements match the selected period.' })}
      ${formulaMarkup('suppliers')}${reportTableMarkup('suppliers')}
    </div>`;
  }

  function wasteMarkup() {
    const data = report('waste');
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(data.summary || {}, [
        { key: 'recorded_waste_count', label: 'Recorded entries', icon: 'trash-2', unit: 'count' },
        { key: 'estimated_waste_value', label: 'Estimated value', icon: 'circle-dollar-sign', unit: 'ISK' }
      ])}
      ${formulaMarkup('waste')}${reportTableMarkup('waste')}
    </div>`;
  }

  function labourMarkup() {
    const data = report('labour');
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(data.summary || {}, [
        { key: 'shift_count', label: 'Scheduled shifts', icon: 'calendar-days', unit: 'count' },
        { key: 'scheduled_hours', label: 'Scheduled hours', icon: 'clock-3', unit: 'hours' },
        { key: 'unpublished_shift_entries', label: 'Unpublished entries', icon: 'send-horizontal', unit: 'count' }
      ])}
      <section class="reports-formula"><i data-lucide="shield-check"></i><div><strong>Privacy</strong><p>${escapeHtml(data.permission_note || '')} Bank, tax, identification and private payroll information are never loaded.</p></div></section>
      ${reportTableMarkup('labour')}
    </div>`;
  }

  function operationsMarkup() {
    const data = report('operations');
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(data.summary || {}, [
        { key: 'routine_count', label: 'Scheduled routines', icon: 'clipboard-list', unit: 'count' },
        { key: 'completed_routines', label: 'Completed', icon: 'circle-check-big', unit: 'count' },
        { key: 'overdue_routines', label: 'Overdue', icon: 'clock-alert', unit: 'count' },
        { key: 'completion_percent', label: 'Completion', icon: 'chart-no-axes-column-increasing', unit: 'percent' },
        { key: 'temperature_logs', label: 'Temperature logs', icon: 'thermometer', unit: 'count' },
        { key: 'temperature_out_of_range', label: 'Out of range', icon: 'thermometer-sun', unit: 'count' }
      ])}
      ${formulaMarkup('operations')}<section class="reports-formula"><i data-lucide="lock-keyhole"></i><div><strong>Read-only boundary</strong><p>Reports cannot mark a checklist step complete. Open Operations to change operational records.</p></div></section>
      ${reportTableMarkup('operations')}
    </div>`;
  }

  function knowledgeMarkup() {
    const data = report('knowledge');
    return `<div class="reports-section-body">
      ${summaryCardsMarkup(data.summary || {}, [
        { key: 'published_articles', label: 'Published articles', icon: 'book-open-check', unit: 'count' },
        { key: 'required_articles', label: 'Required articles', icon: 'badge-check', unit: 'count' },
        { key: 'acknowledgements', label: 'Acknowledgements', icon: 'signature', unit: 'count' },
        { key: 'required_due_for_current_user', label: 'Your reading due', icon: 'book-alert', unit: 'count' },
        { key: 'training_required_total', label: 'Required training', icon: 'graduation-cap', unit: 'count' },
        { key: 'training_completed_for_current_user', label: 'Your training complete', icon: 'circle-check-big', unit: 'count' }
      ])}
      <section class="reports-formula"><i data-lucide="shield-check"></i><div><strong>Permission boundary</strong><p>${escapeHtml(data.permission_note || '')} Knowledge article content is not exposed through Reports.</p></div></section>
      ${rowsForSection('knowledge').length ? reportTableMarkup('knowledge') : '<section class="reports-panel reports-unavailable"><div><i data-lucide="user-round-check"></i></div><h2>Your training summary is shown above</h2><p>Team-level rows are available only to authorised managers and administrators.</p></section>'}
    </div>`;
  }

  function savedStorageKey() {
    return `atlas-reports-saved:${state.staff?.id || 'anonymous'}`;
  }

  function savedReports() {
    try {
      const parsed = JSON.parse(localStorage.getItem(savedStorageKey()) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeSavedReports(rows) {
    localStorage.setItem(savedStorageKey(), JSON.stringify(rows));
  }

  function savedMarkup() {
    const rows = savedReports();
    return `<div class="reports-section-body"><section class="reports-panel reports-saved-panel">
      <header><div><span class="reports-eyebrow">Saved configurations</span><h2>Saved Reports</h2><p>Saved views store filters and layout only. Reopening always rechecks current permissions and live data.</p></div><button type="button" class="reports-primary" data-reports-save-view><i data-lucide="bookmark-plus"></i>Save current view</button></header>
      <div class="reports-saved-list">${rows.length ? rows.map((row) => `<article class="${row.archived ? 'is-archived' : ''}"><div><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(sectionMeta(row.section).name || humanize(row.section))} · ${escapeHtml(humanize(row.preset))} · ${escapeHtml(humanize(row.comparison))}</span><small>Updated ${escapeHtml(formatDateTime(row.updatedAt))}${row.archived ? ' · Archived' : ''}</small></div><div><button type="button" data-reports-saved-open="${escapeHtml(row.id)}">Open</button><button type="button" data-reports-saved-update="${escapeHtml(row.id)}">Update</button><button type="button" data-reports-saved-duplicate="${escapeHtml(row.id)}">Duplicate</button><button type="button" data-reports-saved-rename="${escapeHtml(row.id)}">Rename</button><button type="button" data-reports-saved-archive="${escapeHtml(row.id)}">${row.archived ? 'Restore' : 'Archive'}</button><button type="button" data-reports-saved-remove="${escapeHtml(row.id)}">Remove</button></div></article>`).join('') : '<div class="reports-empty-inline"><i data-lucide="bookmark"></i><span>No saved report configurations yet.</span></div>'}</div>
      <footer><i data-lucide="shield-check"></i>Saved configurations cannot bypass current report permissions.</footer>
    </section></div>`;
  }

  function exportsMarkup() {
    return `<div class="reports-section-body"><section class="reports-panel reports-export-panel">
      <header><div><span class="reports-eyebrow">Current report</span><h2>Export & share</h2><p>Exports include the report name, period, comparison, active filters, generated time, currency and visible row totals.</p></div></header>
      <div class="reports-export-grid">
        <button type="button" data-reports-export="csv"><i data-lucide="file-spreadsheet"></i><strong>CSV</strong><span>Visible rows with metadata and data-quality notes.</span></button>
        <button type="button" data-reports-export="print"><i data-lucide="printer"></i><strong>Print / PDF</strong><span>Print-ready report that can be saved as PDF.</span></button>
        <button type="button" data-reports-export="copy"><i data-lucide="copy"></i><strong>Copy summary</strong><span>Copy the KPI and source-quality summary.</span></button>
      </div>
      <div class="reports-export-note"><i data-lucide="lock-keyhole"></i><span>Only data already visible to the logged-in role is included. Hidden employee or commercial fields are never added to exports.</span></div>
    </section>${sourceCoverageMarkup()}</div>`;
  }

  function sectionBodyMarkup() {
    const meta = sectionMeta();
    if (state.activeSection === 'overview') return overviewMarkup();
    if (state.activeSection === 'sales') return unavailableMarkup('sales');
    if (state.activeSection === 'inventory') return inventoryMarkup();
    if (state.activeSection === 'recipes') return recipesMarkup();
    if (state.activeSection === 'purchasing') return purchasingMarkup();
    if (state.activeSection === 'suppliers') return suppliersMarkup();
    if (state.activeSection === 'waste') return wasteMarkup();
    if (state.activeSection === 'labour') return labourMarkup();
    if (state.activeSection === 'operations') return operationsMarkup();
    if (state.activeSection === 'knowledge') return knowledgeMarkup();
    if (state.activeSection === 'saved') return savedMarkup();
    if (state.activeSection === 'exports') return exportsMarkup();
    return `<section class="reports-panel reports-unavailable"><h2>${escapeHtml(meta.name)}</h2><p>${escapeHtml(meta.description)}</p></section>`;
  }

  function askMarkup() {
    if (!state.askOpen) return `<button type="button" class="reports-ask-fab" data-reports-ask-open><i data-lucide="sparkles"></i><span>Ask Atlas about this report</span></button>`;
    return `<aside class="reports-ask-panel" aria-label="Ask Atlas about this report">
      <header><div><span>Report intelligence</span><h2>Ask Atlas</h2></div><button type="button" data-reports-ask-close aria-label="Close"><i data-lucide="x"></i></button></header>
      <p>Answers use only this permission-filtered report snapshot, name the selected period, and separate evidence from limitations.</p>
      <div class="reports-ask-suggestions">${['What requires attention?', 'What data is missing?', 'Which products need attention?', 'Which recipes are unavailable?', 'Summarise purchasing.', 'How are operations performing?'].map((question) => `<button type="button" data-reports-ask-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`).join('')}</div>
      <form data-reports-ask-form><textarea rows="3" maxlength="500" data-reports-ask-input placeholder="Ask about the current report…">${escapeHtml(state.askQuestion)}</textarea><button type="submit" ${state.askLoading ? 'disabled' : ''}><i data-lucide="send"></i>${state.askLoading ? 'Checking evidence…' : 'Ask Atlas'}</button></form>
      ${state.askAnswer ? `<section class="reports-ask-answer"><strong>${escapeHtml(state.askAnswer.answer || '')}</strong><div><h3>Evidence used</h3>${(state.askAnswer.evidence || []).map((item) => `<article><span>${escapeHtml(item.label)}</span><b>${escapeHtml(formatEvidenceValue(item))}</b>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</article>`).join('')}</div><div><h3>Limitations</h3><ul>${(state.askAnswer.limitations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></section>` : ''}
    </aside>`;
  }

  function formatEvidenceValue(item) {
    if (item.unit === 'ISK') return formatIsk(item.value);
    if (item.unit === '%') return formatPercent(item.value);
    return String(item.value ?? 'Unavailable');
  }

  function shellMarkup() {
    const meta = sectionMeta();
    const activeSources = (state.snapshot?.data_sources || []).filter((source) => source.status === 'connected').length;
    const totalSources = (state.snapshot?.data_sources || []).length;
    return `<section class="reports-shell">
      <header class="reports-hero">
        <div><span class="reports-kicker"><i data-lucide="chart-no-axes-combined"></i>Checkpoint H · Read & analyse</span><h1>Reports</h1><p>Understand what happened, what requires attention and how trustworthy the available evidence is—without changing source records.</p></div>
        <div class="reports-hero-meta"><span><i data-lucide="calendar-range"></i>${escapeHtml(state.snapshot?.period?.label || '')}</span><span><i data-lucide="clock-3"></i>Refreshed ${escapeHtml(formatDateTime(state.snapshot?.generated_at))}</span><span><i data-lucide="database"></i>${activeSources}/${totalSources} sources connected</span></div>
      </header>
      ${state.message ? `<div class="reports-feedback is-success"><i data-lucide="circle-check-big"></i>${escapeHtml(state.message)}</div>` : ''}
      ${state.error ? `<div class="reports-feedback is-error"><i data-lucide="triangle-alert"></i>${escapeHtml(state.error)}</div>` : ''}
      ${controlsMarkup()}
      ${filtersMarkup()}
      <div class="reports-layout">
        ${navigationMarkup()}
        <main class="reports-main">
          <header class="reports-section-head"><div><span>${statusPill(meta.status, '')}</span><h2>${escapeHtml(meta.name)}</h2><p>${escapeHtml(meta.description || '')}</p></div><button type="button" data-reports-export="copy"><i data-lucide="copy"></i>Copy summary</button></header>
          ${sectionBodyMarkup()}
        </main>
      </div>
      <footer class="reports-trust"><i data-lucide="shield-check"></i><span>Read-only reports · Reykjavík time · ISK · Missing data labelled · Role permissions enforced server-side · Source records unchanged</span></footer>
      ${askMarkup()}
    </section>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.remove('placeholder-view');
    if (state.loading && !state.snapshot) element.innerHTML = loadingMarkup();
    else if (state.error && !state.snapshot) element.innerHTML = errorMarkup();
    else element.innerHTML = shellMarkup();
    window.lucide?.createIcons?.();
  }

  function resetTableState() {
    state.page = 1;
    state.sortKey = '';
    state.sortDirection = 'asc';
  }

  function applySnapshot(payload) {
    state.snapshot = payload.workspace || {};
    state.staff = payload.staff || state.staff;
    state.controls = payload.controls || state.controls;
    state.policy = payload.policy || state.policy;
    state.error = null;
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || (!viewVisible() && !options.force)) return;
    state.loading = !state.snapshot;
    state.refreshing = Boolean(options.silent);
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot');
      applySnapshot(payload);
      if (state.preset === 'custom' && !state.startDate) {
        state.startDate = state.snapshot?.period?.start || '';
        state.endDate = state.snapshot?.period?.end || '';
      }
      render();
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Reports could not load.';
      render();
    } finally {
      state.loading = false;
      state.refreshing = false;
      render();
    }
  }

  function changeSection(section) {
    if (!SECTION_ORDER.includes(section)) return;
    state.activeSection = section;
    resetTableState();
    state.askAnswer = null;
    const hash = `#reports/${section}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    loadSnapshot({ force: true });
  }

  function currentColumnsAndRows() {
    const columns = columnsForSection(state.activeSection).filter((column) => column[2] !== 'action');
    const rows = sortedRows(state.activeSection);
    return { columns, rows };
  }

  function filterDescription() {
    const entries = Object.entries(state.filters).filter(([, value]) => String(value || '').trim());
    return entries.length ? entries.map(([key, value]) => `${humanize(key)}=${value}`).join('; ') : 'None';
  }

  function sourceQualityNote() {
    const meta = sectionMeta();
    return `${sourceStatusLabel(meta.status)}. ${meta.description || ''}`.trim();
  }

  function downloadCsv() {
    const { columns, rows } = currentColumnsAndRows();
    const meta = sectionMeta();
    const metadata = [
      ['Report', meta.name],
      ['Period', state.snapshot?.period?.label || ''],
      ['Comparison', state.snapshot?.comparison?.enabled ? `${formatDate(state.snapshot.comparison.start)} – ${formatDate(state.snapshot.comparison.end)}` : 'None'],
      ['Filters', filterDescription()],
      ['Generated', formatDateTime(state.snapshot?.generated_at)],
      ['Currency', state.snapshot?.currency || 'ISK'],
      ['Timezone', state.snapshot?.timezone || 'Atlantic/Reykjavik'],
      ['Data quality', sourceQualityNote()]
    ];
    const lines = metadata.map((row) => row.map(escapeCsv).join(','));
    lines.push('');
    if (columns.length) {
      lines.push(columns.map((column) => escapeCsv(column[1])).join(','));
      rows.forEach((row) => lines.push(columns.map((column) => {
        const value = derivedValue(row, column[0]);
        return escapeCsv(value ?? 'Unavailable');
      }).join(',')));
    } else {
      lines.push('Summary');
      lines.push(escapeCsv(JSON.stringify(report(state.activeSection).summary || report(state.activeSection).message || {})));
    }
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `atlas-${state.activeSection}-${state.snapshot?.period?.start || 'report'}-${state.snapshot?.period?.end || ''}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    state.message = 'CSV exported. Displayed totals and visible rows were preserved.';
    render();
  }

  function summaryText() {
    const meta = sectionMeta();
    const summary = report(state.activeSection).summary || {};
    const values = Object.entries(summary).map(([key, value]) => `${humanize(key)}: ${typeof value === 'number' ? formatNumber(value, Number(value) % 1 ? 1 : 0) : value ?? 'Unavailable'}`);
    return [
      `Atlas Report: ${meta.name}`,
      `Period: ${state.snapshot?.period?.label || ''}`,
      `Comparison: ${state.snapshot?.comparison?.enabled ? `${formatDate(state.snapshot.comparison.start)} – ${formatDate(state.snapshot.comparison.end)}` : 'None'}`,
      `Filters: ${filterDescription()}`,
      `Generated: ${formatDateTime(state.snapshot?.generated_at)}`,
      `Currency: ${state.snapshot?.currency || 'ISK'}`,
      `Data quality: ${sourceQualityNote()}`,
      '',
      ...values
    ].join('\n');
  }

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(summaryText());
      state.message = 'Report summary copied.';
    } catch {
      state.error = 'The browser did not allow copying. Use the print or CSV export instead.';
    }
    render();
  }

  function printReport() {
    const { columns, rows } = currentColumnsAndRows();
    const meta = sectionMeta();
    const popup = window.open('', '_blank', 'noopener,noreferrer');
    if (!popup) {
      state.error = 'The browser blocked the print view. Allow pop-ups for this preview and try again.';
      render();
      return;
    }
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meta.name)} · Atlas</title><style>body{font:14px Arial,sans-serif;color:#222;margin:32px}h1{font:32px Georgia,serif;margin:0 0 8px}p{color:#555}dl{display:grid;grid-template-columns:160px 1fr;gap:6px 16px;margin:24px 0}dt{font-weight:bold}dd{margin:0}table{width:100%;border-collapse:collapse;margin-top:24px;font-size:12px}th,td{border-bottom:1px solid #ddd;text-align:left;padding:8px;vertical-align:top}th{background:#f4f2ed}.note{margin-top:28px;padding:12px;background:#f4f2ed}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(meta.name)}</h1><p>${escapeHtml(meta.description || '')}</p><dl><dt>Period</dt><dd>${escapeHtml(state.snapshot?.period?.label || '')}</dd><dt>Comparison</dt><dd>${escapeHtml(state.snapshot?.comparison?.enabled ? `${formatDate(state.snapshot.comparison.start)} – ${formatDate(state.snapshot.comparison.end)}` : 'None')}</dd><dt>Filters</dt><dd>${escapeHtml(filterDescription())}</dd><dt>Generated</dt><dd>${escapeHtml(formatDateTime(state.snapshot?.generated_at))}</dd><dt>Currency</dt><dd>ISK</dd><dt>Data quality</dt><dd>${escapeHtml(sourceQualityNote())}</dd></dl>${columns.length ? `<table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column[1])}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(derivedValue(row, column[0]) ?? 'Unavailable')}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<pre>${escapeHtml(summaryText())}</pre>`}<div class="note">Read-only Atlas report · Reykjavík time · Source records unchanged</div><script>window.onload=()=>window.print();<\/script></body></html>`);
    popup.document.close();
  }

  function saveCurrentView() {
    const suggested = `${sectionMeta().name} · ${humanize(state.preset)}`;
    const name = window.prompt('Saved report name:', suggested);
    if (!name?.trim()) return;
    const rows = savedReports();
    rows.unshift({
      id: window.crypto?.randomUUID?.() || `saved-${Date.now()}`,
      name: name.trim(),
      section: state.activeSection,
      preset: state.preset,
      comparison: state.comparison,
      startDate: state.startDate,
      endDate: state.endDate,
      comparisonStartDate: state.comparisonStartDate,
      comparisonEndDate: state.comparisonEndDate,
      filters: { ...state.filters },
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    writeSavedReports(rows);
    state.message = 'Report configuration saved. Permissions will be rechecked when it is opened.';
    if (state.activeSection === 'saved') render();
    else render();
  }

  function savedAction(id, action) {
    const rows = savedReports();
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const row = rows[index];

    if (action === 'open') {
      state.activeSection = row.section;
      state.preset = row.preset;
      state.comparison = row.comparison;
      state.startDate = row.startDate || '';
      state.endDate = row.endDate || '';
      state.comparisonStartDate = row.comparisonStartDate || '';
      state.comparisonEndDate = row.comparisonEndDate || '';
      state.filters = { ...state.filters, ...(row.filters || {}) };
      resetTableState();
      history.replaceState(null, '', `#reports/${state.activeSection}`);
      loadSnapshot({ force: true });
      return;
    }

    if (action === 'rename') {
      const name = window.prompt('New saved report name:', row.name);
      if (!name?.trim()) return;
      row.name = name.trim();
    } else if (action === 'duplicate') {
      rows.splice(index + 1, 0, { ...row, id: window.crypto?.randomUUID?.() || `saved-${Date.now()}`, name: `${row.name} copy`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } else if (action === 'archive') {
      row.archived = !row.archived;
    } else if (action === 'update') {
      row.section = state.activeSection;
      row.preset = state.preset;
      row.comparison = state.comparison;
      row.startDate = state.startDate;
      row.endDate = state.endDate;
      row.comparisonStartDate = state.comparisonStartDate;
      row.comparisonEndDate = state.comparisonEndDate;
      row.filters = { ...state.filters };
    } else if (action === 'remove') {
      if (!window.confirm(`Remove saved report “${row.name}”?`)) return;
      rows.splice(index, 1);
      writeSavedReports(rows);
      render();
      return;
    }
    if (rows[index]) rows[index].updatedAt = new Date().toISOString();
    writeSavedReports(rows);
    render();
  }

  async function askAtlas() {
    const question = state.askQuestion.trim();
    if (!question || state.askLoading) return;
    state.askLoading = true;
    state.askAnswer = null;
    state.error = null;
    render();
    try {
      const payload = await api('ask', { method: 'POST', body: { question } });
      state.askAnswer = {
        answer: payload.answer,
        evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
        limitations: Array.isArray(payload.limitations) ? payload.limitations : []
      };
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Ask Atlas could not answer from this report.';
    } finally {
      state.askLoading = false;
      render();
    }
  }

  function navigateView(view) {
    const button = document.querySelector(`.nav-item[data-view="${CSS.escape(view)}"]`);
    if (button) button.click();
    else window.setActiveView?.(view);
  }

  function openSource(section, recordId) {
    const map = {
      inventory: 'inventory', recipes: 'recipes', purchasing: 'inventory', suppliers: 'suppliers',
      waste: 'inventory', labour: 'shifts', operations: 'operations', knowledge: 'knowledge'
    };
    const view = map[section] || section;
    navigateView(view);
    if (section === 'recipes' && recordId) window.setTimeout(() => window.AtlasRecipes?.openDetail?.(recordId), 250);
    if (section === 'knowledge' && recordId) window.setTimeout(() => window.AtlasTeamProfiles?.openProfile?.(recordId), 250);
  }

  function updateCustomDateDefaults() {
    const period = state.snapshot?.period;
    if (state.preset === 'custom' && !state.startDate && period) {
      state.startDate = period.start || '';
      state.endDate = period.end || '';
    }
    if (state.comparison === 'custom' && !state.comparisonStartDate && period) {
      const start = new Date(`${period.start}T12:00:00Z`);
      const end = new Date(`${period.end}T12:00:00Z`);
      const days = Math.round((end - start) / 86400000) + 1;
      end.setUTCDate(start.getUTCDate() - 1);
      start.setTime(end.getTime());
      start.setUTCDate(end.getUTCDate() - days + 1);
      state.comparisonStartDate = start.toISOString().slice(0, 10);
      state.comparisonEndDate = end.toISOString().slice(0, 10);
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    const section = target.closest('[data-reports-section]');
    if (section) {
      event.preventDefault();
      changeSection(section.dataset.reportsSection);
      return;
    }
    if (target.closest('[data-reports-refresh]')) {
      event.preventDefault();
      loadSnapshot({ force: true });
      return;
    }
    if (target.closest('[data-reports-clear-filters]')) {
      state.filters = { search: '', status: '', category: '', supplier: '', employee: '' };
      resetTableState();
      loadSnapshot({ force: true });
      return;
    }
    const removeFilter = target.closest('[data-reports-remove-filter]');
    if (removeFilter) {
      state.filters[removeFilter.dataset.reportsRemoveFilter] = '';
      resetTableState();
      loadSnapshot({ force: true });
      return;
    }
    const sort = target.closest('[data-reports-sort]');
    if (sort) {
      const key = sort.dataset.reportsSort;
      state.sortDirection = state.sortKey === key && state.sortDirection === 'asc' ? 'desc' : 'asc';
      state.sortKey = key;
      state.page = 1;
      render();
      return;
    }
    const page = target.closest('[data-reports-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.reportsPage || 1);
      render();
      return;
    }
    const source = target.closest('[data-reports-source]');
    if (source) {
      openSource(source.dataset.reportsSource, source.dataset.reportsRecord || '');
      return;
    }
    const exportButton = target.closest('[data-reports-export]');
    if (exportButton) {
      const action = exportButton.dataset.reportsExport;
      if (action === 'csv') downloadCsv();
      else if (action === 'print') printReport();
      else if (action === 'copy') copySummary();
      return;
    }
    if (target.closest('[data-reports-save-view]')) {
      saveCurrentView();
      return;
    }
    for (const action of ['open', 'update', 'duplicate', 'rename', 'archive', 'remove']) {
      const saved = target.closest(`[data-reports-saved-${action}]`);
      if (saved) {
        savedAction(saved.dataset[`reportsSaved${action.charAt(0).toUpperCase()}${action.slice(1)}`], action);
        return;
      }
    }
    if (target.closest('[data-reports-ask-open]')) {
      state.askOpen = true;
      render();
      requestAnimationFrame(() => host()?.querySelector('[data-reports-ask-input]')?.focus());
      return;
    }
    if (target.closest('[data-reports-ask-close]')) {
      state.askOpen = false;
      render();
      return;
    }
    const suggestion = target.closest('[data-reports-ask-question]');
    if (suggestion) {
      state.askQuestion = suggestion.dataset.reportsAskQuestion || '';
      askAtlas();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    if (!host()?.contains(target)) return;

    if (target.matches('[data-reports-search]')) {
      state.filters.search = target.value;
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        resetTableState();
        loadSnapshot({ force: true });
      }, 350);
    } else if (target.matches('[data-reports-ask-input]')) {
      state.askQuestion = target.value;
    } else if (target.matches('[data-reports-start]')) state.startDate = target.value;
    else if (target.matches('[data-reports-end]')) state.endDate = target.value;
    else if (target.matches('[data-reports-comparison-start]')) state.comparisonStartDate = target.value;
    else if (target.matches('[data-reports-comparison-end]')) state.comparisonEndDate = target.value;
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (!host()?.contains(target)) return;

    if (target.matches('[data-reports-preset]')) {
      state.preset = target.value;
      updateCustomDateDefaults();
      resetTableState();
      if (state.preset === 'custom') render();
      else loadSnapshot({ force: true });
      return;
    }
    if (target.matches('[data-reports-comparison]')) {
      state.comparison = target.value;
      updateCustomDateDefaults();
      resetTableState();
      if (state.comparison === 'custom') render();
      else loadSnapshot({ force: true });
      return;
    }
    const filter = target.closest('[data-reports-filter]');
    if (filter) {
      state.filters[filter.dataset.reportsFilter] = target.value;
      resetTableState();
      loadSnapshot({ force: true });
      return;
    }
    if (target.matches('[data-reports-start],[data-reports-end],[data-reports-comparison-start],[data-reports-comparison-end]')) {
      const ready = state.preset !== 'custom' || (state.startDate && state.endDate);
      const comparisonReady = state.comparison !== 'custom' || (state.comparisonStartDate && state.comparisonEndDate);
      if (ready && comparisonReady) loadSnapshot({ force: true });
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !host()?.contains(form)) return;
    if (form.matches('[data-reports-ask-form]')) {
      event.preventDefault();
      const input = form.querySelector('[data-reports-ask-input]');
      state.askQuestion = input?.value || state.askQuestion;
      askAtlas();
    }
  }

  function initialSection() {
    const match = location.hash.match(/^#reports\/([a-z-]+)$/);
    return match && SECTION_ORDER.includes(match[1]) ? match[1] : 'overview';
  }

  function init() {
    if (state.initialized || !host()) return false;
    state.initialized = true;
    state.activeSection = initialSection();

    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    document.addEventListener('submit', handleSubmit);

    state.viewObserver = new MutationObserver(() => {
      if (viewVisible() && !state.snapshot && !state.loading) loadSnapshot();
    });
    state.viewObserver.observe(host(), { attributes: true, attributeFilter: ['style', 'class'] });

    window.addEventListener('hashchange', () => {
      const section = initialSection();
      if (section !== state.activeSection) changeSection(section);
    });
    window.addEventListener('focus', () => {
      if (viewVisible() && state.snapshot && !state.loading) loadSnapshot({ force: true, silent: true });
    });
    window.addEventListener('online', () => {
      if (viewVisible()) loadSnapshot({ force: true });
    });
    window.addEventListener('pagehide', () => {
      state.viewObserver?.disconnect();
      if (state.searchTimer) clearTimeout(state.searchTimer);
      if (state.authTimer) clearInterval(state.authTimer);
    }, { once: true });

    render();
    if (viewVisible()) loadSnapshot();
    return true;
  }

  window.AtlasReports = {
    open: (section = 'overview') => {
      navigateView('reports');
      window.setTimeout(() => changeSection(SECTION_ORDER.includes(section) ? section : 'overview'), 100);
    },
    refresh: () => loadSnapshot({ force: true }),
    snapshot: () => state.snapshot,
    section: () => state.activeSection
  };

  if (!init()) {
    state.authTimer = setInterval(() => {
      if (init()) {
        clearInterval(state.authTimer);
        state.authTimer = null;
      }
    }, 150);
    setTimeout(() => {
      if (state.authTimer) {
        clearInterval(state.authTimer);
        state.authTimer = null;
      }
    }, 12000);
  }
})();
