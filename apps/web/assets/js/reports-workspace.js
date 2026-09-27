// Reports (#reports, #reports/<report>) — how the business is doing, with
// evidence you can export (spec §7.12). Manager and admin only.
//
// Tabs: Overview (absorbs Business Intelligence) · Stock · Purchasing ·
// Recipes · Waste · Labour. The period is computed in the venue zone and the
// comparison period comes from AtlasVenueClock.compareRange (a whole calendar
// month compares with the whole previous month; any other period with the
// same number of days just before it). Sales stay "not connected" until a
// point-of-sale source exists — no revenue is ever invented.
(function () {
  'use strict';
  // Native date picker (design system: forms use the platform date and time
  // controls). The value is 'YYYY-MM-DD'; AtlasVenueClock validates it inline.
  const DATE_FIELD = 'type="date"';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 30000;
  const MANAGERS = ['admin', 'manager'];
  const TABS = [
    ['overview', 'Overview'], ['inventory', 'Stock'], ['purchasing', 'Purchasing'],
    ['recipes', 'Recipes'], ['waste', 'Waste'], ['labour', 'Labour']
  ];
  const ROUTE_NAMES = { inventory: 'stock' };
  const SECTION_ALIASES = { stock: 'inventory', suppliers: 'purchasing', business: 'overview' };
  const PRESETS = [
    ['today', 'Today'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'],
    ['this_month', 'This month'], ['last_month', 'Last month'], ['year_to_date', 'Year to date'], ['custom', 'Custom dates']
  ];
  const PAGE_SIZE = 25;

  const state = {
    snapshot: null,
    activeSection: 'overview',
    preset: 'last_30_days',
    compare: true,
    customStart: '',
    customEnd: '',
    loading: false,
    error: null,
    requestSeq: 0,
    sortKey: '',
    sortDirection: 'asc',
    page: 1,
    initialized: false,
    root: null
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = () => window.AtlasVenueClock;
  const money = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : (window.AtlasFormat?.money ? window.AtlasFormat.money(Number(value)) : `${Math.round(Number(value))} kr`));
  function number(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // The noun for a count: "1 item", "3 items" (the count itself is shown apart).
  const noun = (count, one, many) => (number(count) === 1 ? one : many);
  function formatNumber(value, digits = 0) {
    const n = number(value);
    if (n === null) return '—';
    const fixed = n.toFixed(digits);
    const [whole, fraction] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return fraction ? `${grouped},${fraction}` : grouped;
  }
  const percent = (value) => (number(value) === null ? '—' : `${Math.round(Number(value))} %`);
  const dateLabel = (key) => clock()?.formatDate?.(key, {}, key) || key;
  const dateTime = (value) => (value ? clock()?.formatDateTime?.(value, {}, '—') || '—' : '—');
  const time = (value) => (value ? clock()?.formatTime?.(value, '—') || '—' : '—');

  function profile() {
    return window.AtlasShell?.profile?.() || window.atlasCurrentProfile || null;
  }
  function isManager() {
    const current = profile();
    return Boolean(current && current.active !== false && MANAGERS.includes(current.role));
  }
  function host() {
    return document.getElementById('reports-view');
  }
  function visible() {
    return window.AtlasShell?.current?.() === 'reports';
  }

  // ---------- period (venue zone) ----------

  function venueToday() {
    const c = clock();
    return c?.venueDate ? c.venueDate() : new Date().toISOString().slice(0, 10);
  }

  function period() {
    const c = clock();
    const today = c?.venueDate ? c.venueDate() : new Date().toISOString().slice(0, 10);
    const add = (key, n) => (c?.addDays ? c.addDays(key, n) : key);
    switch (state.preset) {
      case 'today': return { start: today, end: today };
      case 'last_7_days': return { start: add(today, -6), end: today };
      case 'this_month': return { start: `${today.slice(0, 7)}-01`, end: today };
      case 'last_month': {
        const range = c?.monthRange ? c.monthRange(add(`${today.slice(0, 7)}-01`, -1)) : null;
        return range ? { start: range.start, end: range.end } : { start: add(today, -29), end: today };
      }
      case 'year_to_date': return { start: `${today.slice(0, 4)}-01-01`, end: today };
      case 'custom':
        if (/^\d{4}-\d{2}-\d{2}$/.test(state.customStart) && /^\d{4}-\d{2}-\d{2}$/.test(state.customEnd) && state.customStart <= state.customEnd) {
          return { start: state.customStart, end: state.customEnd };
        }
        return { start: add(today, -29), end: today };
      case 'last_30_days':
      default: return { start: add(today, -29), end: today };
    }
  }

  function comparison(range = period()) {
    if (!state.compare) return null;
    return clock()?.compareRange ? clock().compareRange(range) : null;
  }

  function periodText(range = period()) {
    return range.start === range.end ? dateLabel(range.start) : `${dateLabel(range.start)} – ${dateLabel(range.end)}`;
  }

  // ---------- data ----------

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) throw Object.assign(new Error('offline'), { status: 0 });
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session?.access_token) throw Object.assign(new Error('session'), { status: 401 });
    return data.session;
  }

  async function loadSnapshot() {
    const endpoint = String(cfg.REPORTS_API || '').trim();
    const seq = ++state.requestSeq;
    state.loading = true;
    state.error = null;
    render();
    try {
      if (!endpoint) throw Object.assign(new Error('not configured'), { status: 404 });
      const range = period();
      const compare = comparison(range);
      const url = new URL(endpoint);
      url.searchParams.set('action', 'snapshot');
      url.searchParams.set('section', state.activeSection);
      url.searchParams.set('preset', 'custom');
      url.searchParams.set('start_date', range.start);
      url.searchParams.set('end_date', range.end);
      if (compare) {
        url.searchParams.set('comparison', 'custom');
        url.searchParams.set('comparison_start_date', compare.start);
        url.searchParams.set('comparison_end_date', compare.end);
      } else {
        url.searchParams.set('comparison', 'none');
      }
      const session = await activeSession();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, { cache: 'no-store', signal: controller.signal, headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' } });
      } finally {
        window.clearTimeout(timer);
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status });
      if (seq !== state.requestSeq) return;
      state.snapshot = payload.workspace || {};
      state.error = null;
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.error = error;
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        render();
      }
    }
  }

  function report(section) {
    return state.snapshot?.reports?.[section] || {};
  }
  function sources() {
    return Array.isArray(state.snapshot?.data_sources) ? state.snapshot.data_sources : [];
  }
  function kpi(key) {
    return (state.snapshot?.kpis || []).find((entry) => entry.key === key || entry.section === key) || null;
  }

  function errorText(error) {
    if (!error) return '';
    if (error.status === 401) return 'Atlas couldn’t confirm your sign-in for this. Try again in a moment.';
    if (error.status === 403) return 'Reports are for managers. Ask an administrator for access.';
    if (error.status === 404) return 'Reports aren\'t switched on for this venue yet.';
    if (error.name === 'AbortError') return 'The connection timed out. Nothing was changed. Try again.';
    return 'Nothing was changed. Check the connection and try again.';
  }

  // ---------- markup helpers ----------

  function alertMarkup({ tone = 'danger', title = '', body = '', action = '' }) {
    const icon = tone === 'danger' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : 'info';
    return `<div class="atlas-alert atlas-alert--${tone}"${tone === 'danger' ? ' role="alert"' : ''}><i data-lucide="${icon}"></i><div class="atlas-alert__content">${title ? `<p class="atlas-alert__title">${escapeHtml(title)}</p>` : ''}${body ? `<p class="atlas-alert__body">${escapeHtml(body)}</p>` : ''}</div>${action ? `<div class="atlas-alert__actions">${action}</div>` : ''}</div>`;
  }

  function notEnough(text) {
    return `<p class="reports-not-enough"><i data-lucide="chart-no-axes-column"></i>${escapeHtml(text)}</p>`;
  }

  // Delta vs comparison: sign and a word; colour only when it matters.
  function deltaMarkup(entry, { goodWhenUp = null } = {}) {
    if (!entry || !state.compare) return '';
    const pct = number(entry.change_percent);
    if (pct === null) return '<span class="reports-delta">No comparable figure</span>';
    const rounded = Math.round(pct);
    if (rounded === 0) return '<span class="reports-delta">Same as before</span>';
    const up = rounded > 0;
    const tone = goodWhenUp === null || Math.abs(rounded) < 10 ? '' : (up === goodWhenUp ? ' is-good' : ' is-bad');
    return `<span class="reports-delta${tone}">${up ? '▲' : '▼'} ${Math.abs(rounded)} % ${up ? 'up' : 'down'}</span>`;
  }

  function statMarkup({ label, value, unit = '', detail = '', delta = '', link = '' }) {
    return `<div class="atlas-stat"><p class="atlas-stat__label">${escapeHtml(label)}</p><p class="atlas-stat__value">${value}${unit ? `<span class="atlas-stat__unit">${escapeHtml(unit)}</span>` : ''}</p>${delta ? `<p class="atlas-stat__detail">${delta}</p>` : ''}${detail ? `<p class="atlas-stat__detail">${escapeHtml(detail)}</p>` : ''}${link}</div>`;
  }

  // One horizontal bar per row, single hue (--accent-illustration), value
  // labels beside each bar, a native title per bar for hover.
  function barChart(rows, { label, value, format, title, takeaway }) {
    const usable = rows.filter((row) => number(row[value]) !== null && Number(row[value]) > 0).slice(0, 8);
    if (!usable.length) return '';
    const max = Math.max(...usable.map((row) => Number(row[value])));
    return `<figure class="reports-chart" aria-label="${escapeHtml(title)}">
        <figcaption><span class="reports-chart__title">${escapeHtml(title)}</span>${takeaway ? `<span class="reports-chart__takeaway">${escapeHtml(takeaway)}</span>` : ''}</figcaption>
        <ul class="reports-bars">${usable.map((row) => {
          const amount = Number(row[value]);
          return `<li class="reports-bars__row" title="${escapeHtml(`${row[label]}: ${format(amount)}`)}"><span class="reports-bars__label">${escapeHtml(row[label])}</span><span class="reports-bars__track"><span class="reports-bars__bar" style="width:${Math.max(2, amount / max * 100).toFixed(1)}%"></span></span><span class="reports-bars__value num">${escapeHtml(format(amount))}</span></li>`;
        }).join('')}</ul>
      </figure>`;
  }

  // ---------- header ----------

  function headerMarkup() {
    const range = period();
    const compare = comparison(range);
    const list = sources();
    const connected = list.filter((source) => ['connected', 'complete'].includes(source.status)).length;
    const subParts = [];
    if (state.snapshot?.generated_at) subParts.push(`Updated ${time(state.snapshot.generated_at)}`);
    if (list.length) subParts.push(`${connected} of ${list.length} data sources connected`);
    if (!subParts.length) subParts.push('Stock, purchasing, recipes, waste and labour');
    const custom = state.preset === 'custom'
      ? `<span class="reports-custom"><label class="sr-only" for="reports-start">From</label><input class="atlas-input" ${DATE_FIELD} id="reports-start" value="${escapeHtml(state.customStart || range.start)}" max="${escapeHtml(state.customEnd || range.end)}" data-reports-start><span aria-hidden="true">–</span><label class="sr-only" for="reports-end">To</label><input class="atlas-input" ${DATE_FIELD} id="reports-end" value="${escapeHtml(state.customEnd || range.end)}" min="${escapeHtml(state.customStart || range.start)}" max="${escapeHtml(venueToday())}" data-reports-end></span>`
      : '';
    return `<header class="page-head reports-head">
        <div class="page-head__text"><h1 class="page-head__title">Reports</h1><p class="page-head__sub">${escapeHtml(subParts.join(' · '))}</p></div>
        <div class="page-head__actions">
          <label class="sr-only" for="reports-period">Period</label>
          <select class="atlas-select" id="reports-period" data-reports-preset>${PRESETS.map(([key, text]) => `<option value="${key}"${state.preset === key ? ' selected' : ''}>${text}</option>`).join('')}</select>
          ${custom}
          <label class="sr-only" for="reports-compare">Comparison</label>
          <select class="atlas-select" id="reports-compare" data-reports-compare><option value="on"${state.compare ? ' selected' : ''}>vs previous period</option><option value="off"${state.compare ? '' : ' selected'}>No comparison</option></select>
          <span class="reports-export"><button type="button" class="atlas-btn atlas-btn--secondary" id="reports-export-btn" aria-haspopup="menu" aria-expanded="false"><i data-lucide="download"></i>Export<i data-lucide="chevron-down"></i></button>
            <ul class="atlas-menu" role="menu" id="reports-export-menu" aria-label="Export" hidden>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="csv"><i data-lucide="file-spreadsheet"></i>Download CSV</button></li>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="print"><i data-lucide="printer"></i>Print or save as PDF</button></li>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="copy"><i data-lucide="copy"></i>Copy summary</button></li>
            </ul></span>
          <button type="button" class="atlas-btn atlas-btn--ghost" data-reports-ask>${window.AtlasBot ? window.AtlasBot.html({ size: 18 }) : '<i data-lucide="sparkles"></i>'}Ask Atlas</button>
        </div>
      </header>`;
  }

  function tabsMarkup() {
    return `<nav class="atlas-tabs" aria-label="Reports">${TABS.map(([key, label]) => `<a href="#reports/${ROUTE_NAMES[key] || key}"${state.activeSection === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }

  // ---------- Overview (absorbs Business Intelligence) ----------

  // Stock withheld by the shell (verified balances or movements failed to load,
  // index.html AtlasData.health()): no figure derived from partial inputs.
  function stockIncomplete() {
    return window.AtlasData?.health?.()?.stock === 'partial';
  }

  function stockIncompleteAlert() {
    const missing = (window.AtlasData?.health?.()?.stockMissing || []).map((key) => (key === 'balances' ? 'verified counts' : key === 'movements' ? 'movements' : null)).filter(Boolean);
    return alertMarkup({ tone: 'warning', title: `Stock figures are incomplete — ${missing.length ? missing.join(' and ') : 'stock data'} couldn’t load. Try again.`, body: 'Inventory value, suggested orders and count coverage are hidden until everything loads.', action: '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-reports-stock-retry>Try again</button>' });
  }

  // The one inventory value (Overview and the Stock tab): the canonical
  // AtlasStockTruth value over the loaded items (AtlasReportsOverview), never
  // a second figure from another source.
  function inventoryValueStat(label) {
    const incomplete = stockIncomplete();
    const stock = incomplete ? null : window.AtlasReportsOverview?.inventoryValueParts?.() || null;
    const detail = incomplete ? 'Stock figures are incomplete'
      : !stock ? 'Stock isn\'t loaded'
      : stock.items === 0 ? 'No active items yet'
      : stock.value !== null ? 'Counted stock at unit cost, now'
      : stockValueGap(stock.knownValue, stock.uncounted, stock.uncosted);
    return statMarkup({ label, value: stock && stock.value !== null ? escapeHtml(money(stock.value)) : '—', detail });
  }

  function overviewMarkup() {
    const overview = window.AtlasReportsOverview;
    const range = period();
    const incomplete = stockIncomplete();
    const purchasing = report('purchasing').summary || {};
    const spendKpi = kpi('purchasing_spend') || kpi('purchasing');
    const waste = report('waste').summary || {};
    const costing = overview?.recipeCosting?.() || null;
    const spendValue = number(purchasing.spend);
    const wasteCount = number(waste.recorded_waste_count);
    const wasteValue = number(waste.estimated_waste_value);
    const stats = `<div class="atlas-stats reports-stats">
        ${inventoryValueStat('Inventory value')}
        ${statMarkup({ label: 'Purchasing spend', value: spendValue === null ? '—' : escapeHtml(money(spendValue)), delta: deltaMarkup(spendKpi), detail: spendValue === null ? 'No deliveries with a cost in this period' : 'Costed deliveries in this period' })}
        ${statMarkup({ label: 'Waste', value: wasteValue !== null ? escapeHtml(money(wasteValue)) : wasteCount === 0 ? 'None' : '—', detail: wasteCount === 0 ? 'No waste recorded in this period' : wasteValue === null ? `${formatNumber(wasteCount)} ${noun(wasteCount, 'entry', 'entries')}; some have no cost` : `${formatNumber(wasteCount)} ${noun(wasteCount, 'entry', 'entries')}` })}
        ${statMarkup({ label: 'Recipe margin', value: costing && costing.averageMargin !== null ? escapeHtml(percent(costing.averageMargin)) : '—', detail: costing && costing.total ? `Theoretical · ${costing.complete} of ${costing.total} ${noun(costing.total, 'recipe', 'recipes')} fully costed` : 'No active recipes' })}
      </div>`;

    const attention = Array.isArray(state.snapshot?.attention) ? state.snapshot.attention : [];
    const attentionSection = `<section class="atlas-section" aria-labelledby="reports-attention"><div class="atlas-section__head"><h2 class="atlas-section__title" id="reports-attention">Needs attention</h2></div>
        ${attention.length ? `<ul class="atlas-list">${attention.slice(0, 6).map((entry) => `<li class="atlas-row"><span class="atlas-row__icon atlas-row__icon--${entry.tone === 'danger' ? 'danger' : entry.tone === 'warn' ? 'warning' : 'info'}"><i data-lucide="${entry.tone === 'danger' ? 'circle-alert' : entry.tone === 'warn' ? 'triangle-alert' : 'info'}"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(entry.title)}</p><p class="atlas-row__meta">${escapeHtml(entry.detail || '')}</p></div><div class="atlas-row__end"><a class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" href="#reports/${escapeHtml(ROUTE_NAMES[SECTION_ALIASES[entry.section] || entry.section] || SECTION_ALIASES[entry.section] || entry.section)}">Open report</a></div></li>`).join('')}</ul>` : '<p class="reports-muted">Nothing needs attention for this period.</p>'}
      </section>`;

    const concentration = overview?.supplierConcentration?.(range.start, range.end) || [];
    const supplierRows = (report('suppliers').rows || []).map((row) => ({ name: row.supplier, spend: number(row.spend) }));
    const bySupplier = supplierRows.length ? supplierRows : concentration;
    const total = bySupplier.reduce((sum, row) => sum + (row.spend || 0), 0);
    const top = bySupplier.slice().sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];
    const takeaway = top && total ? `${top.name} is ${Math.round(top.spend / total * 100)} % of spend this period${Math.round(top.spend / total * 100) >= 70 ? ' — worth watching for price and supply risk' : ''}.` : '';
    const suppliersChart = barChart(bySupplier, { label: 'name', value: 'spend', format: money, title: 'Spend by supplier', takeaway })
      || `<figure class="reports-chart"><figcaption><span class="reports-chart__title">Spend by supplier</span></figcaption>${notEnough('Not enough data yet — needs deliveries with a supplier and a cost in this period.')}</figure>`;
    const exposure = incomplete ? null : overview?.orderExposure?.() || null;
    const salesSource = sources().find((source) => source.key === 'sales');
    const charts = `<section class="atlas-section" aria-labelledby="reports-money"><div class="atlas-section__head"><h2 class="atlas-section__title" id="reports-money">Money</h2></div>
        <div class="reports-chart-grid">${suppliersChart}
          <div class="atlas-card atlas-card--pad reports-facts"><ul class="atlas-list">
            <li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">Sales</p><p class="atlas-row__meta">${salesSource?.status === 'connected' ? 'Connected' : 'Not connected — no point-of-sale system sends sales to Atlas, so revenue and realised margin aren\'t shown.'}</p></div></li>
            <li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">Suggested order</p><p class="atlas-row__meta">${incomplete ? 'Unknown — stock figures are incomplete' : exposure && exposure.items ? `${exposure.items} ${noun(exposure.items, 'item', 'items')} below par · about ${money(exposure.estimate)}${exposure.uncosted ? ` plus ${exposure.uncosted} without a cost` : ''}` : 'Nothing below par that isn\'t already ordered'}</p></div><div class="atlas-row__end"><a class="atlas-btn atlas-btn--ghost atlas-btn--sm" href="#purchasing">Purchasing</a></div></li>
            <li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">Average cost per serve</p><p class="atlas-row__meta">${costing && costing.averageCostPerServe !== null ? `${money(costing.averageCostPerServe)} across ${costing.complete} fully costed ${noun(costing.complete, 'recipe', 'recipes')}` : 'Needs recipes with every ingredient costed'}</p></div></li>
          </ul></div>
        </div></section>`;

    const complete = overview?.completeness?.() || null;
    const line = (label, value, fix) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${label}</p><p class="atlas-row__meta">${value === null ? 'Not available' : `${Math.round(value)} % complete`}</p></div><div class="atlas-row__end">${value !== null && value < 100 ? `<a class="atlas-btn atlas-btn--ghost atlas-btn--sm" href="${fix}">Fix</a>` : ''}</div></li>`;
    const completeness = `<section class="atlas-section" aria-labelledby="reports-completeness"><div class="atlas-section__head"><h2 class="atlas-section__title" id="reports-completeness">Data completeness</h2><a class="atlas-section__link" href="#data/issues">Data › Issues</a></div>
        <div class="reports-chart-grid">
          <div class="atlas-card atlas-card--pad"><ul class="atlas-list">${complete ? [
            line('Items with a cost', complete.cost, '#data/issues?issue=inventory.missing_cost'),
            line('Items with a par level', complete.par, '#data/pars'),
            line('Items with a supplier', complete.supplier, '#data/issues?issue=inventory.missing_supplier'),
            line('Items counted recently', incomplete ? null : complete.counted, '#inventory/counts'),
            line('Recipes fully costed', complete.recipesCosted, '#recipes')
          ].join('') : '<li class="reports-muted">Stock isn\'t loaded.</li>'}</ul></div>
          <div class="atlas-card atlas-card--pad"><ul class="atlas-list">${sources().map((source) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(source.name)}</p><p class="atlas-row__meta">${escapeHtml(source.note || (source.last_refreshed_at ? `Updated ${dateTime(source.last_refreshed_at)}` : ''))}</p></div><div class="atlas-row__end">${sourcePill(source.status)}</div></li>`).join('') || '<li class="reports-muted">No sources reported.</li>'}</ul></div>
        </div></section>`;

    return `${incomplete ? stockIncompleteAlert() : ''}${stats}${attentionSection}${charts}${completeness}`;
  }

  function sourcePill(status) {
    const map = { connected: ['Connected', 'positive'], complete: ['Connected', 'positive'], partial: ['Partly complete', 'warning'], not_connected: ['Not connected', 'neutral'], no_records: ['No records yet', 'neutral'], no_data_for_period: ['Nothing this period', 'neutral'], unavailable: ['Unavailable', 'danger'] };
    const [label, tone] = map[status] || ['Unknown state', 'neutral'];
    return `<span class="atlas-pill atlas-pill--${tone}">${label}</span>`;
  }

  // ---------- report tabs ----------

  const COLUMNS = {
    inventory: [['name', 'Item', 'text'], ['category', 'Category', 'text', 2], ['quantity', 'On hand', 'number'], ['par_level', 'Par', 'number', 3], ['status', 'Status', 'status'], ['cost_price', 'Unit cost', 'money', 3], ['estimated_value', 'Value', 'money']],
    recipes: [['name', 'Recipe', 'text'], ['availability_state', 'Availability', 'status'], ['menu_price', 'Price', 'money', 2], ['estimated_cost_per_serving', 'Cost per serve', 'money'], ['estimated_margin_percent', 'Margin', 'percent'], ['estimated_servings_available', 'Serves', 'number', 3]],
    purchasing: [['created_at', 'Date', 'datetime'], ['item_name', 'Item', 'text'], ['supplier', 'Supplier', 'text', 2], ['quantity_change', 'Quantity', 'number', 3], ['unit_cost', 'Unit cost', 'money', 3], ['total_cost', 'Total', 'money']],
    waste: [['created_at', 'Date', 'datetime'], ['item_name', 'Item', 'text'], ['movement_type', 'Type', 'status', 2], ['quantity_change', 'Quantity', 'number'], ['estimated_value', 'Value', 'money'], ['note', 'Note', 'text', 3]],
    labour: [['starts_at', 'Start', 'datetime'], ['person_label', 'Person', 'text'], ['role_name', 'Role', 'text', 2], ['ends_at', 'End', 'datetime', 3], ['planned_hours', 'Hours', 'number'], ['published', 'Published', 'boolean', 2]]
  };

  function humanize(value) {
    const text = String(value || '').replace(/[_-]+/g, ' ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function cell(row, [key, , type]) {
    const value = row[key];
    if (value === null || value === undefined || value === '') return '<span title="Not recorded">—</span>';
    if (type === 'money') return escapeHtml(money(value));
    if (type === 'percent') return escapeHtml(percent(value));
    if (type === 'number') return escapeHtml(formatNumber(value, Number(value) % 1 ? 1 : 0));
    if (type === 'datetime') return escapeHtml(dateTime(value));
    if (type === 'boolean') return value ? 'Yes' : 'No';
    if (type === 'status') return `<span class="atlas-pill">${escapeHtml(humanize(value))}</span>`;
    return escapeHtml(value);
  }

  function sortedRows(section) {
    const rows = Array.isArray(report(section).rows) ? [...report(section).rows] : [];
    if (!state.sortKey) return rows;
    const direction = state.sortDirection === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      const x = a[state.sortKey];
      const y = b[state.sortKey];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const nx = number(x);
      const ny = number(y);
      if (nx !== null && ny !== null) return (nx - ny) * direction;
      return String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' }) * direction;
    });
  }

  function tableMarkup(section) {
    const columns = COLUMNS[section] || [];
    const rows = sortedRows(section);
    // Stock is a snapshot, not a period: its empty table says so.
    // Labour totals can exist without a per-person breakdown: the empty
    // table must not contradict the figures above it.
    if (!rows.length) return notEnough(section === 'inventory' ? 'No item rows to show.' : section === 'labour' && number(report('labour').summary?.shift_count) > 0 ? 'No per-person breakdown for this period yet.' : 'No records for this period.');
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    const isNum = (type) => ['money', 'percent', 'number'].includes(type);
    return `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table">
        <thead><tr>${columns.map(([key, label, type, priority]) => `<th${isNum(type) ? ' class="is-num"' : ''}${priority ? ` data-priority="${priority}"` : ''}${state.sortKey === key ? ` aria-sort="${state.sortDirection === 'desc' ? 'descending' : 'ascending'}"` : ''}><button type="button" class="atlas-th-sort" data-reports-sort="${key}">${label}<i data-lucide="chevron-down"></i></button></th>`).join('')}</tr></thead>
        <tbody>${slice.map((row) => `<tr>${columns.map((column) => `<td${isNum(column[2]) ? ' class="is-num"' : ''}${column[3] ? ` data-priority="${column[3]}"` : ''}>${cell(row, column)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <ul class="atlas-table-list">${slice.map((row) => `<li class="atlas-table-list__row"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${cell(row, columns[0])} · ${cell(row, columns[1])}</div><div class="atlas-table-list__meta">${columns.slice(2, 4).map((column) => `${column[1]}: ${cell(row, column)}`).join(' · ')}</div></div><div class="atlas-table-list__value">${cell(row, columns[columns.length - 1])}</div></li>`).join('')}</ul>
      <div class="atlas-table-foot"><span>${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}</span><span class="atlas-btn-group">${state.page > 1 ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-reports-page="${state.page - 1}">Previous</button>` : ''}${state.page < pages ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-reports-page="${state.page + 1}">Next</button>` : ''}</span></div>`;
  }

  // The one "stock value is unknown" wording (Overview and the Inventory
  // report): the lower bound plus the counts of what is missing. The value
  // itself is null unless every active item is counted and costed.
  function stockValueGap(knownValue, uncounted, uncosted) {
    const missing = [uncounted ? `${formatNumber(uncounted)} not counted` : '', uncosted ? `${formatNumber(uncosted)} without a cost` : ''].filter(Boolean).join(' · ');
    // A payload without a lower bound (undefined) says only what is missing;
    // "nothing counted" is claimed only when the server says so (null).
    const floor = knownValue === undefined ? '' : number(knownValue) === null ? 'Nothing counted and costed yet' : `At least ${money(knownValue)}`;
    return [floor, missing].filter(Boolean).join(' — ') || 'Unknown until every item is counted and costed';
  }

  function sectionMarkup(section) {
    const data = report(section);
    const summary = data.summary || {};
    let figures = '';
    let chart = '';
    if (section === 'inventory') {
      figures = `<div class="atlas-stats reports-stats">${inventoryValueStat('Stock value')}${statMarkup({ label: 'Below par', value: escapeHtml(formatNumber(summary.below_par)), unit: noun(summary.below_par, 'item', 'items') })}${statMarkup({ label: 'Out of stock', value: escapeHtml(formatNumber(summary.out_of_stock)), unit: noun(summary.out_of_stock, 'item', 'items') })}${statMarkup({ label: 'Counted recently', value: escapeHtml(`${formatNumber(summary.current_items)} of ${formatNumber(summary.active_items)}`) })}</div>`;
      // The same canonical source as the Stock value above (never a second figure).
      const categories = stockIncomplete() ? [] : window.AtlasReportsOverview?.inventoryValueByCategory?.() || [];
      const top = categories.slice().sort((a, b) => (b.value || 0) - (a.value || 0))[0];
      chart = barChart(categories, { label: 'name', value: 'value', format: money, title: 'Counted stock value by category', takeaway: top ? `${top.name} holds the most value.` : '' }) || notEnough('Not enough data yet — needs a current stock count with costs.');
    } else if (section === 'recipes') {
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Available', value: escapeHtml(formatNumber(summary.ready)), unit: noun(summary.ready, 'recipe', 'recipes') })}${statMarkup({ label: 'Running low', value: escapeHtml(formatNumber(summary.needs_attention)), unit: noun(summary.needs_attention, 'recipe', 'recipes') })}${statMarkup({ label: 'Unavailable', value: escapeHtml(formatNumber(summary.unavailable)), unit: noun(summary.unavailable, 'recipe', 'recipes') })}${statMarkup({ label: 'Setup incomplete', value: escapeHtml(formatNumber(summary.incomplete_setup)), unit: noun(summary.incomplete_setup, 'recipe', 'recipes') })}</div>`;
      chart = `<p class="reports-muted">Margins are theoretical, from recipe costs and menu prices. Popularity and realised margin need sales, which aren't connected.</p>`;
    } else if (section === 'purchasing') {
      const spendKpi = kpi('purchasing_spend') || kpi('purchasing');
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Spend', value: number(summary.spend) === null ? '—' : escapeHtml(money(summary.spend)), delta: deltaMarkup(spendKpi), detail: 'Costed deliveries' })}${statMarkup({ label: 'Deliveries', value: escapeHtml(formatNumber(summary.movement_count)) })}</div>`;
      const suppliers = (report('suppliers').rows || []).map((row) => ({ name: row.supplier, spend: number(row.spend) }));
      const total = suppliers.reduce((sum, row) => sum + (row.spend || 0), 0);
      const top = suppliers.slice().sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];
      chart = barChart(suppliers, { label: 'name', value: 'spend', format: money, title: 'Spend by supplier', takeaway: top && total ? `${top.name} is ${Math.round(top.spend / total * 100)} % of spend.` : '' }) || notEnough('Not enough data yet — needs deliveries with a supplier and a cost.');
    } else if (section === 'waste') {
      const count = number(summary.recorded_waste_count);
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Entries', value: escapeHtml(formatNumber(count)) })}${statMarkup({ label: 'Value', value: number(summary.estimated_waste_value) === null ? '—' : escapeHtml(money(summary.estimated_waste_value)), detail: number(summary.estimated_waste_value) === null && count ? 'Some entries have no cost' : '' })}</div>`;
      if (!count) chart = notEnough('No waste recorded in this period.');
    } else if (section === 'labour') {
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Shifts', value: escapeHtml(formatNumber(summary.shift_count)) })}${statMarkup({ label: 'Scheduled hours', value: escapeHtml(formatNumber(summary.scheduled_hours, 1)), unit: 'h' })}${statMarkup({ label: 'Not published', value: escapeHtml(formatNumber(summary.unpublished_shift_entries)), unit: noun(summary.unpublished_shift_entries, 'shift', 'shifts') })}</div>`;
      chart = '<p class="reports-muted">Scheduled hours only. Labour cost needs pay rates, which Atlas doesn\'t store.</p>';
    }
    return `${figures}<section class="atlas-section"><div class="atlas-section__head"><h2 class="atlas-section__title">${escapeHtml(TABS.find(([key]) => key === section)?.[1] || '')} detail</h2></div>${chart}${tableMarkup(section)}</section>`;
  }

  // ---------- render ----------

  function skeleton() {
    return `<div class="atlas-stats reports-stats" aria-busy="true" aria-label="Loading reports">${Array.from({ length: 4 }, () => '<div class="atlas-stat"><span class="atlas-skel atlas-skel--text"></span><span class="atlas-skel atlas-skel--title"></span></div>').join('')}</div><div class="reports-skeleton">${Array.from({ length: 5 }, () => '<span class="atlas-skel atlas-skel--row"></span>').join('')}</div>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.remove('placeholder-view');
    if (!isManager()) {
      element.innerHTML = `<div class="atlas-page reports-page">${window.AtlasShell.pageHead({ title: 'Reports' })}<div class="atlas-empty"><div class="atlas-empty__icon"><i data-lucide="lock"></i></div><h3 class="atlas-empty__title">Reports are for managers</h3><p class="atlas-empty__text">Ask an administrator for access.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a></div></div></div>`;
      window.lucide?.createIcons?.();
      return;
    }
    let body;
    if (state.error && !state.snapshot) body = alertMarkup({ title: 'Reports couldn\'t be loaded.', body: errorText(state.error), action: '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-reports-retry>Try again</button>' });
    else if (!state.snapshot) body = skeleton();
    else {
      const refreshError = state.error ? alertMarkup({ tone: 'warning', title: 'This period couldn\'t be loaded.', body: `Showing the last loaded figures. ${errorText(state.error)}`, action: '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-reports-retry>Try again</button>' }) : '';
      const range = period();
      const compare = comparison(range);
      const caption = `<p class="reports-period">${escapeHtml(periodText(range))}${compare ? ` <span>compared with ${escapeHtml(periodText(compare))}</span>` : ''}</p>`;
      body = `${refreshError}${caption}${state.activeSection === 'overview' ? overviewMarkup() : sectionMarkup(state.activeSection)}`;
    }
    element.innerHTML = `<div class="atlas-page reports-page${state.loading && state.snapshot ? ' is-refreshing' : ''}" aria-busy="${state.loading}">${headerMarkup()}${tabsMarkup()}<div class="reports-body">${body}</div></div>`;
    const trigger = element.querySelector('#reports-export-btn');
    const menu = element.querySelector('#reports-export-menu');
    if (trigger && menu) window.AtlasShell?.menu?.(trigger, menu, { onSelect: (item) => exportAs(item?.dataset?.reportsExport) });
    window.lucide?.createIcons?.();
  }

  // ---------- export ----------

  function escapeCsv(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportRows() {
    const section = state.activeSection === 'overview' ? null : state.activeSection;
    if (!section) {
      const overview = window.AtlasReportsOverview;
      const stock = overview?.inventoryValueParts?.();
      const spend = number(report('purchasing').summary?.spend);
      return { columns: ['Figure', 'Value'], rows: [
        ['Inventory value', stockIncomplete() ? 'Unknown (stock figures are incomplete)' : stock?.value === null || !stock ? 'Unknown (not everything is counted and costed)' : money(stock.value)],
        ['Purchasing spend', spend === null ? 'None recorded' : money(spend)],
        ['Sales', 'Not connected'],
        ...(state.snapshot?.attention || []).map((entry) => ['Needs attention', `${entry.title} — ${entry.detail || ''}`])
      ] };
    }
    const columns = COLUMNS[section] || [];
    return { columns: columns.map((column) => column[1]), rows: sortedRows(section).map((row) => columns.map(([key]) => row[key] ?? '')) };
  }

  function exportAs(kind) {
    const range = period();
    const compare = comparison(range);
    const name = TABS.find(([key]) => key === state.activeSection)?.[1] || 'Report';
    const meta = [['Report', name], ['Period', periodText(range)], ['Compared with', compare ? periodText(compare) : 'None'], ['Generated', dateTime(state.snapshot?.generated_at)], ['Currency', 'kr (ISK)']];
    const { columns, rows } = exportRows();
    if (kind === 'csv') {
      const lines = [...meta.map((row) => row.map(escapeCsv).join(',')), '', columns.map(escapeCsv).join(','), ...rows.map((row) => row.map(escapeCsv).join(','))];
      const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `atlas-${ROUTE_NAMES[state.activeSection] || state.activeSection}-${range.start}-${range.end}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      window.AtlasShell?.toast?.('CSV downloaded.');
    } else if (kind === 'copy') {
      const text = [...meta.map(([k, v]) => `${k}: ${v}`), '', ...rows.map((row) => row.join(' · '))].join('\n');
      navigator.clipboard?.writeText?.(text).then(() => window.AtlasShell?.toast?.('Summary copied.'), () => window.AtlasShell?.toast?.('Copying isn\'t allowed in this browser. Download the CSV instead.'));
    } else if (kind === 'print') {
      window.print();
    }
  }

  // ---------- events and routing ----------

  function askAtlas() {
    const range = period();
    const name = TABS.find(([key]) => key === state.activeSection)?.[1] || 'Overview';
    window.AtlasAI?.askAbout?.({ type: 'report', id: `${ROUTE_NAMES[state.activeSection] || state.activeSection}:${range.start}..${range.end}`, label: `${name} report, ${periodText(range)}` });
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    if (target.closest('[data-reports-retry]')) { loadSnapshot(); return; }
    if (target.closest('[data-reports-stock-retry]')) { window.atlasReloadData?.(); return; }
    if (target.closest('[data-reports-ask]')) { askAtlas(); return; }
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
    if (page) { state.page = Number(page.dataset.reportsPage) || 1; render(); }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !host()?.contains(target)) return;
    if (target.matches('[data-reports-preset]')) {
      state.preset = target.value;
      if (state.preset === 'custom' && !state.customStart) {
        const range = period();
        state.customStart = range.start;
        state.customEnd = range.end;
      }
      loadSnapshot();
      return;
    }
    if (target.matches('[data-reports-compare]')) { state.compare = target.value === 'on'; loadSnapshot(); return; }
    if (target.matches('[data-reports-start]') || target.matches('[data-reports-end]')) {
      if (target.matches('[data-reports-start]')) state.customStart = target.value;
      else state.customEnd = target.value;
      // Keep the native pickers' limits in step: From never after To.
      host()?.querySelector('[data-reports-end]')?.setAttribute('min', state.customStart || '');
      host()?.querySelector('[data-reports-start]')?.setAttribute('max', state.customEnd || '');
      if (state.customStart && state.customEnd && state.customStart <= state.customEnd) loadSnapshot();
      else target.setAttribute('aria-invalid', 'true');
    }
  }

  function routeSection(value) {
    const section = SECTION_ALIASES[value] || value;
    return TABS.some(([key]) => key === section) ? section : null;
  }

  function onShow(params = {}) {
    const section = routeSection(params.section) || (params.section ? 'overview' : state.activeSection);
    const changed = section !== state.activeSection;
    state.activeSection = section;
    if (changed) { state.sortKey = ''; state.page = 1; }
    render();
    if (!isManager()) return;
    if (!state.snapshot || changed) loadSnapshot();
  }

  function init() {
    if (state.initialized || !host() || !window.AtlasShell) return false;
    state.initialized = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    window.AtlasShell.onView?.('reports', { show: onShow });
    window.AtlasShell.actions?.register?.({
      id: 'reports.ask', label: 'Ask Atlas about this report', icon: 'atlas-bot', keywords: ['ask', 'report', 'explain'],
      roles: MANAGERS, contexts: ['reports'], run: () => askAtlas()
    });
    window.AtlasShell.onDataLoaded?.(() => { if (visible() && state.activeSection === 'overview' && state.snapshot) render(); });
    window.addEventListener('online', () => { if (visible()) loadSnapshot(); });
    if (visible()) onShow(window.AtlasShell.params?.() || {});
    return true;
  }

  window.AtlasReports = {
    open: (section = 'overview') => window.AtlasShell?.navigate?.(`#reports/${ROUTE_NAMES[routeSection(section) || 'overview'] || routeSection(section) || 'overview'}`),
    refresh: () => loadSnapshot(),
    snapshot: () => state.snapshot,
    section: () => state.activeSection,
    period: () => ({ ...period(), comparison: comparison() })
  };

  if (!init()) {
    const timer = setInterval(() => { if (init()) clearInterval(timer); }, 150);
    setTimeout(() => clearInterval(timer), 12000);
  }
})();
