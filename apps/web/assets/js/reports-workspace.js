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
    if (error.status === 401) return 'Alcedo couldn’t confirm your sign-in for this. Try again in a moment.';
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

  // An empty block keeps its frame: one quiet sentence with a grey glyph.
  function notEnough(text) {
    return `<p class="reports-not-enough"><i data-lucide="chart-no-axes-column"></i>${escapeHtml(text)}</p>`;
  }

  // Delta vs comparison: the sign and the window in words; colour only when
  // the change is large and the metric has a good direction.
  function deltaMarkup(entry, { goodWhenUp = null } = {}) {
    if (!entry || !state.compare) return '';
    const pct = number(entry.change_percent);
    if (pct === null) return '<span class="reports-delta">No comparable figure</span>';
    const rounded = Math.round(pct);
    if (rounded === 0) return '<span class="reports-delta">Same as the previous period</span>';
    const up = rounded > 0;
    const tone = goodWhenUp === null || Math.abs(rounded) < 10 ? '' : (up === goodWhenUp ? ' is-good' : ' is-bad');
    return `<span class="reports-delta${tone}"><span class="reports-delta__figure">${up ? '+' : '−'}${Math.abs(rounded)} %</span> vs previous period</span>`;
  }

  // A missing figure is a short grey dash, never a dash at full value size.
  function statMarkup({ label, value, unit = '', detail = '', delta = '', link = '' }) {
    const empty = value === '—';
    return `<div class="atlas-stat"><p class="atlas-stat__label">${escapeHtml(label)}</p><p class="atlas-stat__value${empty ? ' is-empty' : ''}">${value}${unit && !empty ? `<span class="atlas-stat__unit">${escapeHtml(unit)}</span>` : ''}</p>${delta ? `<p class="atlas-stat__detail">${delta}</p>` : ''}${detail ? `<p class="atlas-stat__detail">${escapeHtml(detail)}</p>` : ''}${link}</div>`;
  }

  // ---------- charts: inline SVG, no inline style, one hue ----------
  //
  // Horizontal positions are percentages and vertical ones pixels, so a plot
  // fills its column at any width without a viewBox stretching its text.

  // Round, even y ticks with the top tick above the maximum (3–5 steps).
  function niceTicks(max, integer = false) {
    if (!(max > 0)) return [0, 1];
    const power = 10 ** Math.floor(Math.log10(max / 4));
    for (const factor of [1, 2, 2.5, 5, 10, 20, 25, 50]) {
      const step = factor * power;
      if (integer && (step < 1 || !Number.isInteger(step))) continue;
      const count = Math.floor(max / step) + 1;
      if (count <= 5) return Array.from({ length: count + 1 }, (_, index) => index * step);
    }
    return [0, max * 1.25];
  }

  // Calendar buckets for a period: days up to two weeks, weeks (from Monday)
  // up to four months, months beyond.
  function periodBuckets(range) {
    const c = clock();
    if (!c?.addDays || !c?.weekday || !range?.start || !range?.end) return null;
    const days = [];
    for (let key = range.start; key && key <= range.end && days.length < 400; key = c.addDays(key, 1)) days.push(key);
    if (!days.length) return null;
    const short = (key) => String(dateLabel(key)).split(' ').slice(1).join(' ') || key;
    if (days.length <= 14) return { grain: 'day', buckets: days.map((key) => ({ start: key, end: key, label: short(key) })) };
    const groups = new Map();
    days.forEach((key) => {
      const id = days.length <= 120 ? c.addDays(key, -((c.weekday(key) + 6) % 7)) : key.slice(0, 7);
      if (!groups.has(id)) groups.set(id, { start: key, end: key });
      groups.get(id).end = key;
    });
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      grain: days.length <= 120 ? 'week' : 'month',
      buckets: [...groups.values()].map((bucket) => ({ ...bucket, label: days.length <= 120 ? short(bucket.start) : months[Number(bucket.start.slice(5, 7)) - 1] }))
    };
  }

  // Sums rows into the period's buckets. Returns null unless every row lands
  // in a bucket and the buckets add up to `total` (the figure in the strip):
  // a chart never disagrees with the number above it.
  function seriesFor(rows, { date, value, total }, range = period()) {
    const shape = periodBuckets(range);
    if (!shape || !Array.isArray(rows) || !rows.length) return null;
    const buckets = shape.buckets.map((bucket) => ({ ...bucket, value: 0, rows: [] }));
    for (const row of rows) {
      const key = clock()?.venueDate ? clock().venueDate(row[date]) : String(row[date] || '').slice(0, 10);
      const amount = typeof value === 'function' ? value(row) : number(row[value]);
      if (amount === null) continue;   // not valued (a receipt without a cost): not in the total either
      if (!key) return null;
      const bucket = buckets.find((entry) => key >= entry.start && key <= entry.end);
      if (!bucket) return null;
      bucket.value += amount;
      bucket.rows.push(row);
    }
    const sum = buckets.reduce((acc, bucket) => acc + bucket.value, 0);
    if (number(total) === null || Math.abs(sum - Number(total)) > 0.5 || !(sum > 0)) return null;
    return { grain: shape.grain, buckets };
  }

  // Columns per period (one series, kingfisher). The tallest column, when it
  // stands well above the rest, gets a leader line and a label naming it.
  function columnChart({ title, takeaway = '', series, format, ticksAs = formatNumber, integer = false, describe, annotate = null }) {
    if (!series) return '';
    const { buckets } = series;
    const max = Math.max(...buckets.map((bucket) => bucket.value));
    if (!(max > 0)) return '';
    const ticks = niceTicks(max, integer);
    const top = ticks[ticks.length - 1];
    const peak = buckets.reduce((best, bucket) => (bucket.value > best.value ? bucket : best), buckets[0]);
    const others = buckets.filter((bucket) => bucket !== peak && bucket.value > 0).map((bucket) => bucket.value).sort((a, b) => a - b);
    const median = others.length ? others[Math.floor(others.length / 2)] : 0;
    const note = annotate && buckets.length >= 3 && (!median || peak.value >= median * 2) ? annotate(peak) : '';
    const plotTop = note ? 30 : 12;
    const base = plotTop + 128;
    const height = base + 26;
    const y = (amount) => base - (amount / top) * (base - plotTop);
    const slot = 100 / buckets.length;
    const share = buckets.length <= 6 ? 0.36 : 0.56;   // a few columns stay slim, many keep a clear gap
    const step = Math.max(1, Math.ceil(buckets.length / 7));
    const crisp = (value) => Math.round(value) + 0.5;
    const grid = ticks.map((tick) => `<line class="reports-plot__${tick === 0 ? 'base' : 'grid'}" x1="0" x2="100%" y1="${crisp(y(tick))}" y2="${crisp(y(tick))}"/>`).join('');
    const bars = buckets.map((bucket, index) => {
      if (!(bucket.value > 0)) return '';
      const barTop = Math.round(y(bucket.value));
      return `<rect class="reports-plot__bar" x="${(index * slot + slot * (1 - share) / 2).toFixed(3)}%" y="${barTop}" width="${(slot * share).toFixed(3)}%" height="${Math.max(1, base - barTop)}"><title>${escapeHtml(`${describe(bucket)}: ${format(bucket.value)}`)}</title></rect>`;
    }).join('');
    const labels = buckets.map((bucket, index) => (index % step ? '' : `<text class="reports-plot__x${(index / step) % 2 ? ' is-minor' : ''}" x="${(index * slot + slot / 2).toFixed(3)}%" y="${height - 6}" text-anchor="middle">${escapeHtml(bucket.label)}</text>`)).join('');
    let marker = '';
    if (note) {
      const index = buckets.indexOf(peak);
      const centre = index * slot + slot / 2;
      const end = centre > 62;
      marker = `<line class="reports-plot__leader" x1="${centre.toFixed(3)}%" x2="${centre.toFixed(3)}%" y1="6" y2="${Math.round(y(peak.value)) - 3}"/><text class="reports-plot__note" x="${centre.toFixed(3)}%" y="14" dx="${end ? -6 : 6}" text-anchor="${end ? 'end' : 'start'}">${escapeHtml(note)}</text>`;
    }
    const yLabels = ticks.map((tick) => `<text x="44" y="${Math.round(y(tick)) + 4}" text-anchor="end">${escapeHtml(ticksAs(tick))}</text>`).join('');
    return `<figure class="atlas-card reports-panel reports-chart reports-chart--columns" aria-label="${escapeHtml(title)}">
        <figcaption class="reports-panel__head"><span class="reports-chart__title">${escapeHtml(title)}</span>${takeaway ? `<span class="reports-chart__takeaway">${escapeHtml(takeaway)}</span>` : ''}</figcaption>
        <div class="reports-plot">
          <svg class="reports-plot__y" width="52" height="${height}" aria-hidden="true" focusable="false">${yLabels}</svg>
          <svg class="reports-plot__area" width="100%" height="${height}" role="img" aria-label="${escapeHtml(`${title}. ${takeaway}`)}" focusable="false">${grid}${bars}${marker}${labels}</svg>
        </div>
      </figure>`;
  }

  // A ranked bar list: label and value on one line, the bar under them at its
  // true share of the largest row. `quiet` draws grey bars with the leader in
  // ink (a secondary chart beside the main series).
  function barList(rows, { label, value, format, quiet = false, share = false, limit = 6 }) {
    const usable = rows.filter((row) => number(row[value]) !== null && Number(row[value]) > 0)
      .sort((a, b) => Number(b[value]) - Number(a[value])).slice(0, limit);
    if (!usable.length) return '';
    const max = Number(usable[0][value]);
    const total = rows.reduce((sum, row) => sum + (number(row[value]) > 0 ? Number(row[value]) : 0), 0);
    return `<ol class="reports-bars${quiet ? ' reports-bars--quiet' : ''}">${usable.map((row) => {
      const amount = Number(row[value]);
      const pct = total > 0 ? Math.round(amount / total * 100) : null;
      return `<li class="reports-bars__row" title="${escapeHtml(`${row[label]}: ${format(amount)}`)}"><span class="reports-bars__label">${escapeHtml(row[label])}</span><span class="reports-bars__value num">${share && pct !== null ? `<span class="reports-bars__share">${pct} %</span>` : ''}${escapeHtml(format(amount))}</span><svg class="reports-bars__track" width="100%" height="6" aria-hidden="true" focusable="false"><rect class="reports-bars__bar" width="${(amount / max * 100).toFixed(2)}%" height="6" rx="3"/></svg></li>`;
    }).join('')}</ol>`;
  }

  // A bar list in its own card. Returns '' when there is nothing to draw.
  function barChart(rows, { label, value, format, title, takeaway, quiet = false, share = true }) {
    const list = barList(rows, { label, value, format, quiet, share });
    if (!list) return '';
    return `<figure class="atlas-card reports-panel reports-chart" aria-label="${escapeHtml(title)}">
        <figcaption class="reports-panel__head"><span class="reports-chart__title">${escapeHtml(title)}</span>${takeaway ? `<span class="reports-chart__takeaway">${escapeHtml(takeaway)}</span>` : ''}</figcaption>
        ${list}
      </figure>`;
  }

  // The same frame with one sentence when a chart has nothing to draw.
  function emptyChart(title, text) {
    return `<figure class="atlas-card reports-panel reports-chart" aria-label="${escapeHtml(title)}"><figcaption class="reports-panel__head"><span class="reports-chart__title">${escapeHtml(title)}</span></figcaption>${notEnough(text)}</figure>`;
  }

  // A titled card (Needs attention, Money, completeness, sources).
  function panel({ id, title, meta = '', body, cls = '' }) {
    return `<section class="atlas-card reports-panel${cls ? ` ${cls}` : ''}" aria-labelledby="${id}"><header class="reports-panel__head reports-panel__head--row"><h2 class="reports-panel__title" id="${id}">${escapeHtml(title)}</h2>${meta}</header>${body}</section>`;
  }

  // The method beside the answer: a tinted key-value well.
  function well(title, rows, note = '') {
    return `<aside class="reports-well" aria-label="${escapeHtml(title)}"><h3 class="reports-well__title">${escapeHtml(title)}</h3><dl class="reports-well__list">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${value}</dd></div>`).join('')}</dl>${note ? `<p class="reports-well__note">${escapeHtml(note)}</p>` : ''}</aside>`;
  }

  // Two blocks side by side (a wide answer and its evidence); one block spans.
  function band(blocks, cls = '') {
    const present = blocks.filter(Boolean);
    if (!present.length) return '';
    return `<div class="reports-band${present.length === 1 ? ' reports-band--single' : ''}${cls ? ` ${cls}` : ''}">${present.join('')}</div>`;
  }

  // A completeness meter: label, the share in words, a 4 px bar at the true
  // ratio (no stub at zero) and a Fix link while anything is missing.
  function meterRow(label, value, fix) {
    const known = value !== null;
    const pct = known ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    const tone = !known ? '' : pct < 50 ? ' is-low' : pct >= 100 ? ' is-full' : '';
    return `<li class="reports-meter${tone}"><span class="reports-meter__label">${escapeHtml(label)}</span><span class="reports-meter__value num">${known ? `${pct} %` : 'Not available'}</span>${known && pct < 100 ? `<a class="atlas-link reports-meter__fix" href="${fix}">Fix</a>` : ''}<svg class="reports-meter__track" width="100%" height="4" aria-hidden="true" focusable="false"><rect class="reports-meter__rail" width="100%" height="4" rx="2"/>${pct > 0 ? `<rect class="reports-meter__fill" width="${pct}%" height="4" rx="2"/>` : ''}</svg></li>`;
  }

  // ---------- header ----------

  // The title row carries the freshness stamp and the utilities (Export, Ask);
  // the period is the scope bar under the tabs.
  function headerMarkup() {
    // The subtitle states the finding (what needs a manager, counted from the
    // same records as the Overview), then how fresh the figures are; with
    // nothing to say it names the period every figure is for.
    const subParts = attentionEntries().slice(0, 2).map((entry) => entry.title);
    if (state.snapshot && !subParts.length) subParts.push('Nothing needs attention');
    if (state.snapshot?.generated_at) subParts.push(`Updated ${time(state.snapshot.generated_at)}`);
    if (!subParts.length) subParts.push(periodText(period()));
    return `<header class="page-head reports-head">
        <div class="page-head__text"><h1 class="page-head__title">Reports</h1><p class="page-head__sub">${escapeHtml(subParts.join(' · '))}</p></div>
        <div class="page-head__actions">
          <span class="reports-export"><button type="button" class="atlas-btn atlas-btn--secondary" id="reports-export-btn" aria-haspopup="menu" aria-expanded="false"><i data-lucide="download"></i>Export<i data-lucide="chevron-down"></i></button>
            <ul class="atlas-menu" role="menu" id="reports-export-menu" aria-label="Export" hidden>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="csv"><i data-lucide="file-spreadsheet"></i>Download CSV</button></li>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="csv-icelandic"><i data-lucide="file-spreadsheet"></i>Download for Excel (Icelandic)</button></li>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="print"><i data-lucide="printer"></i>Print or save as PDF</button></li>
              <li><button type="button" class="atlas-menu__item" role="menuitem" data-reports-export="copy"><i data-lucide="copy"></i>Copy summary</button></li>
            </ul></span>
          <button type="button" class="atlas-btn atlas-btn--ghost" data-reports-ask><i data-lucide="atlas-bot" aria-hidden="true"></i>Ask Alcedo</button>
        </div>
      </header>`;
  }

  function tabsMarkup() {
    return `<nav class="atlas-tabs" aria-label="Reports">${TABS.map(([key, label]) => `<a href="#reports/${ROUTE_NAMES[key] || key}"${state.activeSection === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }

  // Scope first: the period, its custom dates and the comparison, then the
  // period in words (the same dates every figure below is for).
  function scopeMarkup() {
    const range = period();
    const compare = comparison(range);
    const custom = state.preset === 'custom'
      ? `<span class="reports-custom"><label class="sr-only" for="reports-start">From</label><input class="atlas-input" ${DATE_FIELD} id="reports-start" value="${escapeHtml(state.customStart || range.start)}" max="${escapeHtml(state.customEnd || range.end)}" data-reports-start><span class="reports-custom__to" aria-hidden="true">–</span><label class="sr-only" for="reports-end">To</label><input class="atlas-input" ${DATE_FIELD} id="reports-end" value="${escapeHtml(state.customEnd || range.end)}" min="${escapeHtml(state.customStart || range.start)}" max="${escapeHtml(venueToday())}" data-reports-end></span>`
      : '';
    return `<div class="reports-scope" role="group" aria-label="Period">
        <div class="reports-scope__controls">
          <label class="sr-only" for="reports-period">Period</label>
          <select class="atlas-select" id="reports-period" data-reports-preset>${PRESETS.map(([key, text]) => `<option value="${key}"${state.preset === key ? ' selected' : ''}>${text}</option>`).join('')}</select>
          ${custom}
          <label class="sr-only" for="reports-compare">Comparison</label>
          <select class="atlas-select" id="reports-compare" data-reports-compare><option value="on"${state.compare ? ' selected' : ''}>vs previous period</option><option value="off"${state.compare ? '' : ' selected'}>No comparison</option></select>
        </div>
        <p class="reports-period">${escapeHtml(periodText(range))}${compare ? ` <span>compared with ${escapeHtml(periodText(compare))}</span>` : ''}</p>
      </div>`;
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

  // What needs a manager: the server's findings for the period, else the ones
  // the page can count itself from the same records the Overview shows
  // (items below par and not on an order, recipes not fully costed, items
  // never counted), so the block never contradicts the cards beside it.
  function attentionEntries() {
    const server = Array.isArray(state.snapshot?.attention) ? state.snapshot.attention : [];
    if (server.length) {
      return server.map((entry) => {
        const route = ROUTE_NAMES[SECTION_ALIASES[entry.section] || entry.section] || SECTION_ALIASES[entry.section] || entry.section;
        return { ...entry, href: `#reports/${route}`, go: 'Open report' };
      });
    }
    const overview = window.AtlasReportsOverview;
    if (!overview) return [];
    const entries = [];
    const incomplete = stockIncomplete();
    const exposure = incomplete ? null : overview.orderExposure?.() || null;
    if (exposure && exposure.items) {
      entries.push({ tone: 'warn', title: `${formatNumber(exposure.items)} ${noun(exposure.items, 'item', 'items')} below par`, detail: exposure.estimate > 0 ? `Not on an order yet · about ${money(exposure.estimate)} to reorder` : 'Not on an order yet', href: '#purchasing', go: 'Purchasing' });
    }
    const costing = overview.recipeCosting?.() || null;
    if (costing && costing.total > costing.complete) {
      const missing = costing.total - costing.complete;
      entries.push({ tone: 'warn', title: `${formatNumber(missing)} of ${formatNumber(costing.total)} ${noun(costing.total, 'recipe', 'recipes')} not fully costed`, detail: 'Margin and cost per serve leave them out', href: '#recipes', go: 'Recipes' });
    }
    const parts = incomplete ? null : overview.inventoryValueParts?.() || null;
    if (parts && parts.uncounted) {
      entries.push({ tone: 'info', title: `${formatNumber(parts.uncounted)} ${noun(parts.uncounted, 'item', 'items')} not counted`, detail: 'Inventory value is a lower bound until they are', href: '#inventory/counts', go: 'Counts' });
    }
    return entries;
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
    // A real zero is printed ("0 kr"); a figure the period doesn't report is a dash.
    const wasteFigure = wasteValue !== null ? money(wasteValue) : wasteCount === 0 ? money(0) : '—';
    const wasteDetail = wasteCount === null ? 'Waste isn\'t reported for this period'
      : wasteCount === 0 ? 'No waste recorded in this period'
      : wasteValue === null ? `${formatNumber(wasteCount)} ${noun(wasteCount, 'entry', 'entries')}; some have no cost`
      : `${formatNumber(wasteCount)} ${noun(wasteCount, 'entry', 'entries')}`;
    const stats = `<div class="atlas-stats reports-stats">
        ${inventoryValueStat('Inventory value')}
        ${statMarkup({ label: 'Purchasing spend', value: spendValue === null ? '—' : escapeHtml(money(spendValue)), delta: deltaMarkup(spendKpi), detail: spendValue === null ? 'Not reported for this period' : spendValue === 0 ? 'No deliveries with a cost in this period' : 'Costed deliveries in this period' })}
        ${statMarkup({ label: 'Waste', value: wasteFigure === '—' ? '—' : escapeHtml(wasteFigure), detail: wasteDetail })}
        ${statMarkup({ label: 'Recipe margin', value: costing && costing.averageMargin !== null ? escapeHtml(percent(costing.averageMargin)) : '—', detail: costing && costing.total ? `Theoretical · ${costing.complete} of ${costing.total} ${noun(costing.total, 'recipe', 'recipes')} fully costed` : 'No active recipes' })}
      </div>`;

    // The finding first: what needs a manager this period, each row opening
    // the record behind it (the whole row is the link, on phones too). With
    // nothing to act on the block is left out rather than saying so.
    const attention = attentionEntries();
    const toneOf = (entry) => (entry.tone === 'danger' ? 'danger' : entry.tone === 'warn' ? 'warning' : 'info');
    const iconOf = (entry) => (entry.tone === 'danger' ? 'circle-alert' : entry.tone === 'warn' ? 'triangle-alert' : 'info');
    const attentionPanel = attention.length ? panel({
      id: 'reports-attention',
      title: 'Needs attention',
      meta: `<span class="reports-panel__meta num">${formatNumber(Math.min(attention.length, 6))}${attention.length > 6 ? ` of ${formatNumber(attention.length)}` : ''}</span>`,
      cls: 'reports-attention',
      body: `<ul class="atlas-list">${attention.slice(0, 6).map((entry) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon atlas-row__icon--${toneOf(entry)}"><i data-lucide="${iconOf(entry)}"></i></span><div class="atlas-row__body"><a class="atlas-row__link" href="${escapeHtml(entry.href)}">${escapeHtml(entry.title)}</a><p class="atlas-row__meta">${escapeHtml(entry.detail || '')}</p></div><div class="atlas-row__end"><span class="reports-go atlas-row__action" aria-hidden="true">${escapeHtml(entry.go)}</span><i data-lucide="chevron-right" class="atlas-row__chevron" aria-hidden="true"></i></div></li>`).join('')}</ul>`
    }) : '';

    // Where the money went: one series, the one hue.
    const concentration = overview?.supplierConcentration?.(range.start, range.end) || [];
    const supplierRows = (report('suppliers').rows || []).map((row) => ({ name: row.supplier, spend: number(row.spend) }));
    const bySupplier = supplierRows.length ? supplierRows : concentration;
    const total = bySupplier.reduce((sum, row) => sum + (row.spend || 0), 0);
    const top = bySupplier.slice().sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];
    const takeaway = top && total ? `${top.name} is ${Math.round(top.spend / total * 100)} % of spend this period${Math.round(top.spend / total * 100) >= 70 ? ', worth watching for price and supply risk' : ''}.` : '';
    const suppliersChart = barChart(bySupplier, { label: 'name', value: 'spend', format: money, title: 'Spend by supplier', takeaway })
      || emptyChart('Spend by supplier', 'Not enough data yet. Needs deliveries with a supplier and a cost in this period.');

    const exposure = incomplete ? null : overview?.orderExposure?.() || null;
    const salesSource = sources().find((source) => source.key === 'sales');
    const money_ = panel({
      id: 'reports-money',
      title: 'Money',
      cls: 'reports-facts',
      body: `<ul class="atlas-list">
          <li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">Sales</p><p class="atlas-row__meta">${salesSource?.status === 'connected' ? 'Connected' : 'Not connected — no point-of-sale system sends sales to Alcedo, so revenue and realised margin aren\'t shown.'}</p></div></li>
          <li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><a class="atlas-row__link" href="#purchasing">Suggested order</a><p class="atlas-row__meta">${incomplete ? 'Unknown — stock figures are incomplete' : exposure && exposure.items ? `${exposure.items} ${noun(exposure.items, 'item', 'items')} below par${exposure.uncosted ? `, ${exposure.uncosted} without a cost` : ''}` : 'Nothing below par that isn\'t already ordered'}</p></div><div class="atlas-row__end"><span class="atlas-row__value${exposure && exposure.items && !incomplete ? '' : ' is-empty'}">${!incomplete && exposure && exposure.items ? `about ${escapeHtml(money(exposure.estimate))}` : '—'}</span></div></li>
          <li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">Average cost per serve</p><p class="atlas-row__meta">${costing && costing.averageCostPerServe !== null ? `Across ${costing.complete} fully costed ${noun(costing.complete, 'recipe', 'recipes')}` : 'Needs recipes with every ingredient costed'}</p></div><div class="atlas-row__end"><span class="atlas-row__value${costing && costing.averageCostPerServe !== null ? '' : ' is-empty'}">${costing && costing.averageCostPerServe !== null ? escapeHtml(money(costing.averageCostPerServe)) : '—'}</span></div></li>
        </ul>`
    });

    // Coverage: how much of the record each figure stands on.
    const complete = overview?.completeness?.() || null;
    const completeness = panel({
      id: 'reports-completeness',
      title: 'Data completeness',
      meta: '<a class="reports-panel__link" href="#data/issues">Data › Issues</a>',
      body: complete ? `<ul class="reports-meters">${[
        meterRow('Items with a cost', complete.cost, '#data/issues?issue=inventory.missing_cost'),
        meterRow('Items with a par level', complete.par, '#data/pars'),
        meterRow('Items with a supplier', complete.supplier, '#data/issues?issue=inventory.missing_supplier'),
        meterRow('Items counted recently', incomplete ? null : complete.counted, '#inventory/counts'),
        meterRow('Recipes fully costed', complete.recipesCosted, '#recipes')
      ].join('')}</ul>` : '<p class="reports-panel__empty">Stock isn\'t loaded.</p>'
    });
    const list = sources();
    const connected = list.filter((source) => ['connected', 'complete'].includes(source.status)).length;
    const sourcesPanel = panel({
      id: 'reports-sources',
      title: 'Data sources',
      meta: list.length ? `<span class="reports-panel__meta num">${connected} of ${list.length} connected</span>` : '',
      body: list.length ? `<ul class="atlas-list">${list.map((source) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(source.name)}</p><p class="atlas-row__meta">${escapeHtml(source.note || (source.last_refreshed_at ? `Updated ${dateTime(source.last_refreshed_at)}` : 'Not updated yet'))}</p></div><div class="atlas-row__end">${sourcePill(source.status)}</div></li>`).join('')}</ul>` : '<p class="reports-panel__empty">No sources reported.</p>'
    });

    // Reading order: the figures, what needs a manager, then two columns on
    // one 7:5 split so both edges carry down the page: where the money went
    // over what the figures stand on (left), the money facts over the data
    // sources (right). Each column keeps its cards' own heights.
    return `${incomplete ? stockIncompleteAlert() : ''}${stats}${attentionPanel}
      <div class="reports-columns">
        <div class="reports-column">${suppliersChart}${completeness}</div>
        <div class="reports-column">${money_}${sourcesPanel}</div>
      </div>`;
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
      // Names in the venue language, the same on every device (audit L34).
      return (window.AtlasFormat?.compareNames ? window.AtlasFormat.compareNames(x, y) : String(x).localeCompare(String(y), 'is', { numeric: true, sensitivity: 'base' })) * direction;
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
      ${pages > 1 ? `<div class="atlas-table-foot"><span>${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}</span><span class="atlas-btn-group">${state.page > 1 ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-reports-page="${state.page - 1}">Previous</button>` : ''}${state.page < pages ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-reports-page="${state.page + 1}">Next</button>` : ''}</span></div>` : ''}`;
  }

  // The one "stock value is unknown" wording (Overview and the Inventory
  // report): the lower bound plus the counts of what is missing. The value
  // itself is null unless every active item is counted and costed.
  function stockValueGap(knownValue, uncounted, uncosted) {
    const missing = [uncounted ? `${formatNumber(uncounted)} not counted` : '', uncosted ? `${formatNumber(uncosted)} without a cost` : ''].filter(Boolean).join(' · ');
    // A payload without a lower bound (undefined) says only what is missing;
    // "nothing counted" is claimed only when the server says so (null).
    const floor = knownValue === undefined ? '' : number(knownValue) === null ? 'Nothing counted and costed yet' : `At least ${money(knownValue)}`;
    return [floor, missing].filter(Boolean).join(' · ') || 'Unknown until every item is counted and costed';
  }

  // The detail table's heading and its row noun, per report.
  const DETAIL = {
    inventory: ['Items', 'item', 'items'], purchasing: ['Deliveries', 'delivery', 'deliveries'], recipes: ['Recipes', 'recipe', 'recipes'],
    waste: ['Waste entries', 'entry', 'entries'], labour: ['Shifts', 'shift', 'shifts']
  };

  function bucketName(bucket, grain) {
    if (grain === 'day') return dateLabel(bucket.start);
    if (grain === 'week') return `Week of ${dateLabel(bucket.start)}`;
    return `${bucket.label} ${bucket.start.slice(0, 4)}`;
  }
  const grainWord = (grain) => ({ day: 'day', week: 'week', month: 'month' })[grain] || 'period';

  // The receipt value Reports counts as spend (the server's `amount`, else
  // the canonical total_cost / unit cost × quantity rule).
  function receiptAmount(row) {
    const amount = number(row.amount);
    if (amount !== null) return amount;
    if (number(row.total_cost) > 0) return Number(row.total_cost);
    if (number(row.unit_cost) > 0 && number(row.quantity_change) > 0) return Number(row.unit_cost) * Number(row.quantity_change);
    return null;
  }

  // The largest contributor to a bucket, for the peak's label.
  function leader(rows, key, amount) {
    const totals = new Map();
    rows.forEach((row) => { const name = row[key]; if (name) totals.set(name, (totals.get(name) || 0) + (amount(row) || 0)); });
    return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  function sectionMarkup(section) {
    const data = report(section);
    const summary = data.summary || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    let figures = '';
    let charts = '';
    let note = '';
    if (section === 'inventory') {
      figures = `<div class="atlas-stats reports-stats">${inventoryValueStat('Stock value')}${statMarkup({ label: 'Below par', value: escapeHtml(formatNumber(summary.below_par)), unit: noun(summary.below_par, 'item', 'items') })}${statMarkup({ label: 'Out of stock', value: escapeHtml(formatNumber(summary.out_of_stock)), unit: noun(summary.out_of_stock, 'item', 'items') })}${statMarkup({ label: 'Counted recently', value: escapeHtml(`${formatNumber(summary.current_items)} of ${formatNumber(summary.active_items)}`) })}</div>`;
      // The same canonical source as the Stock value above (never a second figure).
      const incomplete = stockIncomplete();
      const categories = incomplete ? [] : window.AtlasReportsOverview?.inventoryValueByCategory?.() || [];
      const top = categories.slice().sort((a, b) => (b.value || 0) - (a.value || 0))[0];
      const chart = barChart(categories, { label: 'name', value: 'value', format: money, title: 'Counted stock value by category', takeaway: top ? `${top.name} holds the most value.` : '' })
        || emptyChart('Counted stock value by category', 'Not enough data yet. Needs a current stock count with costs.');
      const parts = incomplete ? null : window.AtlasReportsOverview?.inventoryValueParts?.() || null;
      const evidence = parts ? well('How the value is counted', [
        ['Counted and costed', parts.value !== null ? escapeHtml(money(parts.value)) : number(parts.knownValue) === null ? '—' : `at least ${escapeHtml(money(parts.knownValue))}`],
        ['Active items', escapeHtml(formatNumber(parts.items))],
        ['Not counted', escapeHtml(formatNumber(parts.uncounted || 0))],
        ['Without a cost', escapeHtml(formatNumber(parts.uncosted || 0))]
      ], 'Counted stock at unit cost. The total is shown only when every active item is counted and has a cost.') : '';
      charts = band([chart, evidence]);
    } else if (section === 'recipes') {
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Available', value: escapeHtml(formatNumber(summary.ready)), unit: noun(summary.ready, 'recipe', 'recipes') })}${statMarkup({ label: 'Running low', value: escapeHtml(formatNumber(summary.needs_attention)), unit: noun(summary.needs_attention, 'recipe', 'recipes') })}${statMarkup({ label: 'Unavailable', value: escapeHtml(formatNumber(summary.unavailable)), unit: noun(summary.unavailable, 'recipe', 'recipes') })}${statMarkup({ label: 'Setup incomplete', value: escapeHtml(formatNumber(summary.incomplete_setup)), unit: noun(summary.incomplete_setup, 'recipe', 'recipes') })}</div>`;
      note = 'Margins are theoretical, from recipe costs and menu prices. Popularity and realised margin need sales, which aren\'t connected.';
    } else if (section === 'purchasing') {
      const spendKpi = kpi('purchasing_spend') || kpi('purchasing');
      const uncosted = number(summary.uncosted_receipts);
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Spend', value: number(summary.spend) === null ? '—' : escapeHtml(money(summary.spend)), delta: deltaMarkup(spendKpi), detail: 'Costed deliveries' })}${statMarkup({ label: 'Deliveries', value: escapeHtml(formatNumber(summary.movement_count)), detail: uncosted ? `Plus ${formatNumber(uncosted)} without a cost` : '' })}</div>`;
      const suppliers = (report('suppliers').rows || []).map((row) => ({ name: row.supplier, spend: number(row.spend) }));
      const total = suppliers.reduce((sum, row) => sum + (row.spend || 0), 0);
      const top = suppliers.slice().sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];
      const series = seriesFor(rows, { date: 'created_at', value: receiptAmount, total: summary.spend });
      const busiest = series ? series.buckets.reduce((best, bucket) => (bucket.value > best.value ? bucket : best), series.buckets[0]) : null;
      const overTime = columnChart({
        title: `Spend per ${grainWord(series?.grain)}`,
        takeaway: busiest ? `The most was spent in the ${grainWord(series.grain)} ${series.grain === 'week' ? 'of ' : ''}${series.grain === 'month' ? busiest.label : dateLabel(busiest.start)}: ${money(busiest.value)}.` : '',
        series, format: money, describe: (bucket) => bucketName(bucket, series.grain),
        annotate: (bucket) => { const name = leader(bucket.rows, 'supplier', receiptAmount); return name ? `${name} · ${money(bucket.value)}` : money(bucket.value); }
      });
      const bySupplier = barChart(suppliers, { label: 'name', value: 'spend', format: money, title: 'Spend by supplier', takeaway: top && total ? `${top.name} is ${Math.round(top.spend / total * 100)} % of spend.` : '', quiet: Boolean(overTime) })
        || emptyChart('Spend by supplier', 'Not enough data yet. Needs deliveries with a supplier and a cost.');
      charts = band(overTime ? [overTime, bySupplier] : [bySupplier, well('How spend is counted', [
        ['Costed deliveries', escapeHtml(formatNumber(summary.movement_count))],
        ['Without a cost', uncosted === null ? '—' : escapeHtml(formatNumber(uncosted))],
        ['Suppliers', escapeHtml(formatNumber(suppliers.length))]
      ], 'Spend is costed purchase receipts. Waste and adjustments are never spend.')]);
    } else if (section === 'waste') {
      const count = number(summary.recorded_waste_count);
      const value = number(summary.estimated_waste_value);
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Entries', value: escapeHtml(formatNumber(count)) })}${statMarkup({ label: 'Value', value: value === null ? (count === 0 ? escapeHtml(money(0)) : '—') : escapeHtml(money(value)), detail: value === null && count ? 'Some entries have no cost' : '' })}</div>`;
      if (!count) charts = notEnough('No waste recorded in this period.');
      else {
        const byValue = seriesFor(rows, { date: 'created_at', value: 'estimated_value', total: value });
        const byCount = byValue ? null : seriesFor(rows, { date: 'created_at', value: () => 1, total: count });
        const series = byValue || byCount;
        const format = byValue ? money : (n) => `${formatNumber(n)} ${noun(n, 'entry', 'entries')}`;
        const overTime = columnChart({
          title: byValue ? `Waste value per ${grainWord(series?.grain)}` : `Waste entries per ${grainWord(series?.grain)}`,
          series, format, integer: !byValue, describe: (bucket) => bucketName(bucket, series.grain),
          annotate: (bucket) => leader(bucket.rows, 'item_name', (row) => (byValue ? number(row.estimated_value) : 1))
        });
        const items = new Map();
        rows.forEach((row) => { if (row.item_name) items.set(row.item_name, (items.get(row.item_name) || 0) + (byValue ? number(row.estimated_value) || 0 : 1)); });
        const most = barChart([...items.entries()].map(([name, amount]) => ({ name, amount })), { label: 'name', value: 'amount', format, title: 'Most wasted', quiet: true, share: false });
        charts = band([overTime, most]);
      }
    } else if (section === 'labour') {
      figures = `<div class="atlas-stats reports-stats">${statMarkup({ label: 'Shifts', value: escapeHtml(formatNumber(summary.shift_count)) })}${statMarkup({ label: 'Scheduled hours', value: escapeHtml(formatNumber(summary.scheduled_hours, 1)), unit: 'h' })}${statMarkup({ label: 'Not published', value: escapeHtml(formatNumber(summary.unpublished_shift_entries)), unit: noun(summary.unpublished_shift_entries, 'shift', 'shifts') })}</div>`;
      const hours = (n) => `${formatNumber(n, Number.isInteger(n) ? 0 : 1)} h`;
      const series = seriesFor(rows, { date: 'starts_at', value: 'planned_hours', total: summary.scheduled_hours });
      const overTime = columnChart({ title: `Scheduled hours per ${grainWord(series?.grain)}`, series, format: hours, describe: (bucket) => bucketName(bucket, series.grain) });
      const roles = new Map();
      rows.forEach((row) => { const hoursFor = number(row.planned_hours); if (row.role_name && hoursFor) roles.set(row.role_name, (roles.get(row.role_name) || 0) + hoursFor); });
      const byRole = overTime ? barChart([...roles.entries()].map(([name, amount]) => ({ name, amount })), { label: 'name', value: 'amount', format: hours, title: 'Hours by role', quiet: true }) : '';
      charts = band([overTime, byRole]);
      note = 'Scheduled hours only. Labour cost needs pay rates, which Alcedo doesn\'t store.';
    }
    const [heading, one, many] = DETAIL[section] || ['Detail', 'row', 'rows'];
    const count = rows.length ? `<span class="reports-section__meta num">${formatNumber(rows.length)} ${noun(rows.length, one, many)}</span>` : '';
    return `${figures}${charts}${note ? `<p class="reports-note"><i data-lucide="info"></i>${escapeHtml(note)}</p>` : ''}<section class="atlas-section reports-detail" aria-labelledby="reports-detail-title"><div class="atlas-section__head"><h2 class="atlas-section__title" id="reports-detail-title">${escapeHtml(heading)}</h2>${count}</div>${tableMarkup(section)}</section>`;
  }

  // ---------- render ----------

  // Loading: the final layout with each value a flat grey bar at its size.
  function skeleton() {
    const rows = (n) => Array.from({ length: n }, () => '<span class="reports-skeleton__row"><span class="atlas-skel atlas-skel--text"></span><span class="atlas-skel atlas-skel--text"></span></span>').join('');
    return `<div class="atlas-stats reports-stats" aria-busy="true" aria-label="Loading reports">${Array.from({ length: 4 }, () => '<div class="atlas-stat"><span class="atlas-skel atlas-skel--text reports-skeleton__label"></span><span class="atlas-skel atlas-skel--title reports-skeleton__value"></span></div>').join('')}</div>
      <div class="reports-columns reports-skeleton" aria-hidden="true"><div class="atlas-card reports-panel"><span class="atlas-skel atlas-skel--text reports-skeleton__head"></span>${rows(3)}</div><div class="atlas-card reports-panel"><span class="atlas-skel atlas-skel--text reports-skeleton__head"></span>${rows(3)}</div></div>`;
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
      body = `${refreshError}${state.activeSection === 'overview' ? overviewMarkup() : sectionMarkup(state.activeSection)}`;
    }
    element.innerHTML = `<div class="atlas-page reports-page${state.loading && state.snapshot ? ' is-refreshing' : ''}" aria-busy="${state.loading}">${headerMarkup()}${tabsMarkup()}${scopeMarkup()}<div class="reports-body">${body}</div></div>`;
    const trigger = element.querySelector('#reports-export-btn');
    const menu = element.querySelector('#reports-export-menu');
    if (trigger && menu) window.AtlasShell?.menu?.(trigger, menu, { onSelect: (item) => exportAs(item?.dataset?.reportsExport) });
    window.lucide?.createIcons?.();
  }

  // ---------- export ----------

  // S96: formula-looking text (= + - @, tab or carriage return first) opens as
  // text in a spreadsheet; numbers stay numbers. A ';' is quoted too, so the
  // same cell works in both CSV variants.
  function escapeCsv(value) {
    let text = String(value ?? '');
    if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // Standard CSV (comma, decimal point) or Excel on an Icelandic PC (semicolon,
  // decimal comma), as in the Accounting export (audit M17). Number cells are
  // numbers, not formatted '3.900 kr' text.
  const CSV_FORMATS = { standard: { separator: ',', decimal: '.' }, icelandic: { separator: ';', decimal: ',' } };
  function csvLine(values, csv = CSV_FORMATS.standard) {
    return values.map((value) => (typeof value === 'number' ? (Number.isFinite(value) ? String(value).replace('.', csv.decimal) : '') : escapeCsv(value))).join(csv.separator);
  }

  // An instant as 'YYYY-MM-DD HH:MM' venue time: a spreadsheet sorts it and reads it as a date.
  function csvDateTime(value) {
    const p = value ? clock()?.parts?.(value) : null;
    return p ? `${p.dateKey} ${p.time}` : String(value ?? '');
  }

  function csvValue(value, type) {
    if (value === null || value === undefined || value === '') return '';
    if (type === 'money' || type === 'number' || type === 'percent') return number(value) ?? String(value);
    if (type === 'datetime') return csvDateTime(value);
    if (type === 'boolean') return value ? 'Yes' : 'No';
    return value;
  }

  function exportRows({ csv = false } = {}) {
    const section = state.activeSection === 'overview' ? null : state.activeSection;
    if (!section) {
      const overview = window.AtlasReportsOverview;
      const stock = overview?.inventoryValueParts?.();
      const spend = number(report('purchasing').summary?.spend);
      // In the CSV a known figure is a number; the copied summary shows kr.
      return { columns: ['Figure', 'Value'], rows: [
        ['Inventory value', stockIncomplete() ? 'Unknown (stock figures are incomplete)' : stock?.value === null || !stock ? 'Unknown (not everything is counted and costed)' : csv ? number(stock.value) ?? money(stock.value) : money(stock.value)],
        ['Purchasing spend', spend === null ? 'None recorded' : csv ? spend : money(spend)],
        ['Sales', 'Not connected'],
        ...(state.snapshot?.attention || []).map((entry) => ['Needs attention', `${entry.title} — ${entry.detail || ''}`])
      ] };
    }
    const columns = COLUMNS[section] || [];
    return { columns: columns.map((column) => column[1]), rows: sortedRows(section).map((row) => columns.map(([key, , type]) => (csv ? csvValue(row[key], type) : row[key] ?? ''))) };
  }

  function exportAs(kind) {
    const range = period();
    const compare = comparison(range);
    const name = TABS.find(([key]) => key === state.activeSection)?.[1] || 'Report';
    const meta = [['Report', name], ['Period', periodText(range)], ['Compared with', compare ? periodText(compare) : 'None'], ['Generated', dateTime(state.snapshot?.generated_at)], ['Currency', 'kr (ISK)']];
    const { columns, rows } = exportRows({ csv: kind === 'csv' || kind === 'csv-icelandic' });
    if (kind === 'csv' || kind === 'csv-icelandic') {
      const csv = kind === 'csv-icelandic' ? CSV_FORMATS.icelandic : CSV_FORMATS.standard;
      const lines = [...meta.map((row) => csvLine(row, csv)), '', csvLine(columns, csv), ...rows.map((row) => csvLine(row, csv))];
      const blob = new Blob([`\ufeff${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `atlas-${ROUTE_NAMES[state.activeSection] || state.activeSection}-${range.start}-${range.end}${kind === 'csv-icelandic' ? ' (Excel)' : ''}.csv`;
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
      id: 'reports.ask', label: 'Ask Alcedo about this report', icon: 'atlas-bot', keywords: ['ask', 'report', 'explain'],
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
