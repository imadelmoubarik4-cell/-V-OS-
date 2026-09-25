// Stock count (spec §7.6, §8.1; owner Visual Inventory §§8–11).
//
// Inventory › Counts lists the sessions; #inventory/counts/<id> is the
// phone-first count flow (one item at a time, stepper, partial containers,
// sticky Scan + Save and next, up next, finish summary) with a desktop List
// mode. Scan and rapid scan use the shared AtlasCapture component; a match is
// only used after a person confirms it, and the count is saved through the
// stock-count command with the confirmed recognition outcome as evidence.
//
// Stock changes only after a manager verifies a count (verified balances are
// what AtlasStockTruth reads); publication to production stock stays the
// separate, explicit manager step it always was.
(function (root) {
  'use strict';

  const shell = root.AtlasShell;
  const RAPID_KEY = 'atlas.count.rapid.v1';
  const MODE_KEY = 'atlas.count.mode.v1';
  const REQUEST_TIMEOUT_MS = 22000;
  const SESSION_TIMEOUT_MS = 8000;
  const BOTTLE_UNITS = /^(bottle|bottles|btl|flaska|flöskur|jar|jars|carton|cartons|keg|kegs)$/i;
  const UNIT_LABELS = { inventory: 'Base unit', bottle: 'Bottles', case: 'Cases', unit: 'Units', litre: 'Litres', millilitre: 'ml', kilogram: 'kg', gram: 'g' };

  const state = {
    snapshot: null,
    staff: null,
    policy: null,
    detail: null,
    sessionId: null,
    loading: false,
    loadSerial: 0,
    error: null,
    saving: false,
    listFilter: 'active',
    lineIndex: 0,
    mode: readPref(MODE_KEY, 'card'),
    rapid: readPref(RAPID_KEY, 'off') === 'on',
    showAll: false,
    allQuery: '',
    allFilter: 'pending',
    finishing: false,
    focusIds: null,
    mount: null,
    active: false
  };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icon = (name) => `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
  const lucide = () => root.lucide?.createIcons?.();
  const clock = () => root.AtlasVenueClock;
  const role = () => shell?.profile?.()?.role || root.atlasCurrentProfile?.role || null;
  const isManager = () => ['admin', 'manager'].includes(role());
  const toast = (message, options) => shell?.toast?.(message, options);

  function readPref(key, fallback) {
    try { return root.localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }
  function writePref(key, value) {
    try { root.localStorage.setItem(key, value); } catch (_) { /* per-device convenience only */ }
  }
  function uuid() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function qty(value) {
    const parsed = num(value);
    return parsed === null ? '—' : parsed.toLocaleString('en-GB', { maximumFractionDigits: 3 });
  }
  function round3(value) { return Math.round(value * 1000) / 1000; }
  function dateText(value, options) { return value && clock()?.formatDate ? clock().formatDate(value, options || {}) : ''; }
  function dateTimeText(value) { return value && clock()?.formatDateTime ? clock().formatDateTime(value) : ''; }
  function timeText(value) { return value && clock()?.formatTime ? clock().formatTime(value) : ''; }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  function endpoint() { return String(root.VABAR_CONFIG?.STOCK_COUNTS_API || '').trim(); }

  // Errors this page shows carry fixed copy only; a JavaScript error or server
  // text reads as the fallback (AtlasApi.message) and goes to the console.
  function fixedError(text, props = {}) {
    return root.AtlasApi?.fixed ? root.AtlasApi.fixed(text, props) : Object.assign(new Error(text), props, { atlasFixed: true });
  }
  function shown(error, fallback = 'That didn’t work. Your saved counts are safe; try again.') {
    if (root.AtlasApi?.message) return root.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }

  function withTimeout(promise, ms, message) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).finally(() => root.clearTimeout(timer)),
      new Promise((_, reject) => { timer = root.setTimeout(() => reject(fixedError(message)), ms); })
    ]);
  }

  async function token() {
    const client = root.atlasSupabase;
    if (!client?.auth) throw fixedError('Sign in again to continue.');
    // getSession() waits on the auth lock without a deadline of its own.
    const result = await withTimeout(client.auth.getSession(), SESSION_TIMEOUT_MS, 'Atlas couldn’t confirm your session in time. Check the connection, then try again.');
    const access = result?.data?.session?.access_token;
    if (!access) throw fixedError('Sign in again to continue.');
    return access;
  }

  // Server text is replaced by fixed copy for the codes the UI knows about.
  function friendly(status, message) {
    const text = String(message || '');
    if (status === 401) return 'Sign in again to continue.';
    if (status === 403) return 'This isn’t available for your role.';
    if (/version|changed|stale|refresh/i.test(text)) return 'This line changed on another device. It’s been refreshed; check it and save again.';
    if (/three decimal/i.test(text)) return 'Use up to three decimal places.';
    if (/zero or more/i.test(text)) return 'Enter a quantity of zero or more.';
    if (/not part of|scope|not in this/i.test(text)) return 'That item isn’t in this count.';
    if (/active inventory item/i.test(text)) return 'That item isn’t active, so it can’t be counted.';
    if (/publication is disabled/i.test(text)) return 'Publishing counts to stock is switched off here.';
    if (status >= 500) return 'The stock count service isn’t responding. Your saved counts are safe; try again.';
    return 'That didn’t work. Your saved counts are safe; try again.';
  }

  async function api(action, { method = 'GET', body = null, params = {} } = {}) {
    const base = endpoint();
    if (!base) throw fixedError('Stock counts aren’t available here.');
    if (method !== 'GET' && root.navigator?.onLine === false) throw fixedError('You’re offline. Nothing was saved; reconnect and try again.');
    const access = await token();
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => { if (value != null && value !== '') url.searchParams.set(key, String(value)); });
    const controller = new AbortController();
    const timer = root.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method, cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw fixedError(friendly(response.status, payload && typeof payload === 'object' ? payload.error : ''), { status: response.status });
      // A 200 that isn't a JSON object is a failure with fixed copy, never a
      // JavaScript error on the page or an endless skeleton (S90).
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fixedError(MALFORMED, { status: response.status });
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw fixedError('The stock count service took too long. Your saved counts are safe; try again.');
      if (error instanceof TypeError) throw fixedError('Atlas couldn’t reach the stock count service. Check your connection; nothing was lost.');
      throw error;
    } finally {
      root.clearTimeout(timer);
    }
  }

  const MALFORMED = 'The stock count service sent an answer Atlas couldn’t read. Your saved counts are safe; try again.';

  function applyPayload(payload) {
    if (payload.counts && typeof payload.counts === 'object') state.snapshot = { ...payload.counts, sessions: Array.isArray(payload.counts.sessions) ? payload.counts.sessions : [] };
    if (payload.staff) state.staff = payload.staff;
    if (payload.policy) state.policy = payload.policy;
    if (payload.detail && typeof payload.detail === 'object') { state.detail = payload.detail; state.sessionId = payload.detail.session?.id || state.sessionId; }
  }

  async function loadSnapshot(force = false) {
    if (state.snapshot && !force) return state.snapshot;
    const serial = ++state.loadSerial;
    state.loading = true;
    state.error = null;
    try {
      const payload = await api('snapshot');
      if (serial !== state.loadSerial) return state.snapshot;
      applyPayload(payload);
      shell?.emit?.('notify:changed', { source: 'stock-count' });
    } catch (error) {
      if (serial === state.loadSerial) state.error = shown(error, 'Your counts are safe. Check your connection and try again.');
    } finally {
      if (serial === state.loadSerial) state.loading = false;
    }
    return state.snapshot;
  }

  async function loadDetail(id) {
    const payload = await api('detail', { params: { id } });
    if (!payload.count || typeof payload.count !== 'object' || !payload.count.session) throw fixedError(MALFORMED);
    state.detail = payload.count;
    if (payload.policy) state.policy = payload.policy;
    state.sessionId = state.detail?.session?.id || id;
    return state.detail;
  }

  async function mutate(action, body) {
    const payload = await api(action, { method: 'POST', body });
    applyPayload(payload);
    shell?.emit?.('notify:changed', { source: 'stock-count' });
    return payload;
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  const session = () => state.detail?.session || null;
  const permissions = () => state.detail?.permissions || {};
  const lines = () => (Array.isArray(state.detail?.lines) ? state.detail.lines : []);
  const summary = () => state.detail?.summary || {};

  function catalogItem(itemId) {
    return (state.snapshot?.catalog || []).find((item) => String(item.id) === String(itemId))
      || root.AtlasData?.items?.().find((item) => String(item.id) === String(itemId)) || null;
  }
  function liveItem(itemId) {
    return root.AtlasData?.items?.().find((item) => String(item.id) === String(itemId)) || null;
  }

  function scopeLabel(entry) {
    if (!entry) return '';
    if (entry.scope_type === 'all') return 'Full count';
    return String(entry.scope_value || entry.scope_type || '');
  }

  function statusPill(status) {
    const map = { draft: ['In progress', 'info'], submitted: ['Needs review', 'warning'], verified: ['Verified', 'positive'], rejected: ['Sent back', 'warning'], cancelled: ['Cancelled', ''] };
    const [label, tone] = map[status] || [String(status || '').replace(/_/g, ' '), ''];
    return `<span class="atlas-pill${tone ? ` atlas-pill--${tone}` : ''}">${esc(label)}</span>`;
  }
  function linePill(line) {
    if (line.line_status === 'counted') return '<span class="atlas-pill atlas-pill--positive">Counted</span>';
    if (line.line_status === 'skipped') return '<span class="atlas-pill atlas-pill--warning">Skipped</span>';
    return '<span class="atlas-pill">Not counted</span>';
  }

  function lastVerifiedText(line) {
    const item = catalogItem(line.inventory_item_id);
    const verified = num(item?.verified_quantity);
    const par = num(item?.par_level);
    const parts = [];
    if (verified !== null && item?.verified_at) parts.push(`Last verified ${qty(verified)} on ${dateText(item.verified_at, { long: true }).split(' ')[0]}`);
    else parts.push('Not verified yet');
    if (par) parts.push(`par ${qty(par)}`);
    return parts.join(' · ');
  }

  function bottleLike(line) { return BOTTLE_UNITS.test(String(line.inventory_unit || '').trim()); }

  // Count units. The service converts the observed input to the item's unit;
  // this preview mirrors that rule so the counter sees what will be saved.
  // Packaged units (boxes, packs, cases) are counted as they are.
  const PACKAGED_UNITS = /^(box|boxes|pack|packs|case|cases)$/i;
  function quantityFamily(unit) {
    const normalized = String(unit || '').trim().toLowerCase();
    if (['l', 'ltr', 'litre', 'litres', 'liter', 'liters'].includes(normalized)) return 'litre';
    if (['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'].includes(normalized)) return 'millilitre';
    if (['kg', 'kilogram', 'kilograms'].includes(normalized)) return 'kilogram';
    if (['g', 'gram', 'grams'].includes(normalized)) return 'gram';
    if (['bottle', 'bottles'].includes(normalized)) return 'bottle';
    return 'unit';
  }
  function countUnits(line) {
    const supported = Array.isArray(line.supported_count_units) && line.supported_count_units.length ? line.supported_count_units : ['inventory'];
    return PACKAGED_UNITS.test(String(line.inventory_unit || '').trim()) ? ['inventory'] : supported;
  }
  function previewNormalization(line, inputQuantity, inputUnit) {
    if (inputQuantity == null || String(inputQuantity).trim() === '') return null;
    if (PACKAGED_UNITS.test(String(line.inventory_unit || '').trim()) && inputUnit !== 'inventory') return null;
    const quantity = Number(String(inputQuantity).trim().replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity < 0) return null;
    const family = quantityFamily(line.inventory_unit);
    const unitsPerCase = num(line.units_per_case_snapshot) || 0;
    const sizeMl = num(line.size_ml_snapshot) || 0;
    const weightG = num(line.package_weight_g_snapshot) || 0;
    const volume = (ml) => (family === 'litre' ? ml / 1000 : ml);
    const weight = (grams) => (family === 'kilogram' ? grams / 1000 : grams);
    let normalized = quantity;
    if (inputUnit === 'case') {
      if (!unitsPerCase) return null;
      if (['unit', 'bottle'].includes(family)) normalized = quantity * unitsPerCase;
      else if (['litre', 'millilitre'].includes(family) && sizeMl) normalized = volume(quantity * unitsPerCase * sizeMl);
      else if (['kilogram', 'gram'].includes(family) && weightG) normalized = weight(quantity * unitsPerCase * weightG);
      else return null;
    } else if (inputUnit === 'bottle' || inputUnit === 'unit') {
      if (['litre', 'millilitre'].includes(family)) {
        if (!sizeMl) return null;
        normalized = volume(quantity * sizeMl);
      } else if (['kilogram', 'gram'].includes(family)) {
        if (!weightG) return null;
        normalized = weight(quantity * weightG);
      }
    } else if (inputUnit === 'litre' || inputUnit === 'millilitre') {
      const ml = inputUnit === 'litre' ? quantity * 1000 : quantity;
      if (['litre', 'millilitre'].includes(family)) normalized = volume(ml);
      else if (['unit', 'bottle'].includes(family) && sizeMl) normalized = ml / sizeMl;
      else return null;
    } else if (inputUnit === 'kilogram' || inputUnit === 'gram') {
      const grams = inputUnit === 'kilogram' ? quantity * 1000 : quantity;
      if (['kilogram', 'gram'].includes(family)) normalized = weight(grams);
      else if (['unit', 'bottle'].includes(family) && weightG) normalized = grams / weightG;
      else return null;
    }
    return { normalized: round3(normalized) };
  }
  function previewText(line, inputQuantity, inputUnit) {
    if (!inputUnit || inputUnit === 'inventory') return 'Up to three decimals for part containers, e.g. 1.7';
    if (String(inputQuantity ?? '').trim() === '') return `Counted in ${UNIT_LABELS[inputUnit] || inputUnit}; Atlas converts to ${line.inventory_unit || 'units'}.`;
    const result = previewNormalization(line, inputQuantity, inputUnit);
    return result ? `Saves as ${qty(result.normalized)} ${line.inventory_unit || 'units'}.` : 'This item is missing its pack size, so count it in its own unit.';
  }
  // Variance against the last verified count; no baseline means unknown, never zero.
  function varianceText(change) {
    if (change === null) return 'No earlier count';
    if (change === 0) return 'No difference';
    return `${change > 0 ? '+' : ''}${qty(change)}`;
  }

  function orderedLines() {
    const list = lines();
    if (state.focusIds?.size) return list.filter((line) => state.focusIds.has(String(line.inventory_item_id)));
    return list;
  }
  function pendingIndex(from = 0) {
    const list = orderedLines();
    for (let offset = 0; offset < list.length; offset += 1) {
      const index = (from + offset) % list.length;
      if (list[index].line_status === 'pending') return index;
    }
    return -1;
  }

  function variance(line) {
    if (line.line_status !== 'counted') return null;
    const item = catalogItem(line.inventory_item_id);
    const baseline = line.source_kind === 'manager_verified_count' ? num(line.expected_quantity) : num(item?.verified_quantity);
    if (baseline === null) return null;
    return round3((num(line.observed_quantity) || 0) - baseline);
  }
  function tolerancePercent() { return num(state.snapshot?.settings?.variance_tolerance_percent) ?? 10; }
  function bigVariance(line) {
    const change = variance(line);
    if (change === null || change === 0) return false;
    const item = catalogItem(line.inventory_item_id);
    const base = Math.abs(num(item?.verified_quantity) ?? num(line.expected_quantity) ?? 0);
    return base === 0 ? Math.abs(change) >= 1 : (Math.abs(change) / base) * 100 > tolerancePercent();
  }

  // ---------------------------------------------------------------------------
  // Counts tab (Inventory › Counts)
  // ---------------------------------------------------------------------------
  let listHost = null;

  function sessionsFiltered() {
    const sessions = Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
    if (state.listFilter === 'active') return sessions.filter((entry) => ['draft', 'submitted'].includes(entry.status));
    if (state.listFilter === 'verified') return sessions.filter((entry) => entry.status === 'verified');
    return sessions;
  }

  function renderList(host) {
    listHost = host || listHost;
    if (!listHost) return;
    const canStart = state.snapshot?.permissions?.can_start ?? ['admin', 'manager', 'bartender'].includes(role());
    const toolbar = `<div class="atlas-toolbar">
      <div class="atlas-segmented" role="group" aria-label="Show counts">${[['active', 'In progress'], ['verified', 'Verified'], ['all', 'All']].map(([value, label]) => `<button type="button" aria-pressed="${state.listFilter === value}" data-count-filter="${value}">${label}</button>`).join('')}</div>
      <div class="atlas-toolbar__end"></div>
    </div>
    <p class="sc-caption">Counts update stock only after a manager verifies them.</p>`;
    if (!state.snapshot && state.loading) {
      listHost.innerHTML = `${toolbar}<div class="atlas-table-wrap" aria-busy="true"><div class="sc-skeleton">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(5)}</div></div>`;
      lucide();
      return;
    }
    if (!state.snapshot && state.error) {
      listHost.innerHTML = `${toolbar}<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Counts couldn’t be loaded.</p><p class="atlas-alert__body">${esc(state.error)}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-count-retry>Try again</button></div></div>`;
      lucide();
      return;
    }
    const sessions = sessionsFiltered();
    const rows = sessions.map((entry) => {
      const s = entry.summary || {};
      const total = num(s.total_lines) ?? ((num(s.counted_lines) || 0) + (num(s.skipped_lines) || 0) + (num(s.pending_lines) || 0));
      const counted = (num(s.counted_lines) || 0) + (num(s.skipped_lines) || 0);
      const when = entry.verified_at || entry.submitted_at || entry.started_at;
      const variances = (num(s.negative_variances) || 0) + (num(s.positive_variances) || 0);
      return { entry, total, counted, when, variances };
    });
    const empty = `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('list-checks')}</div><h3 class="atlas-empty__title">${state.listFilter === 'active' ? 'No count in progress' : 'No counts here yet'}</h3><p class="atlas-empty__text">Start a count for one area or the whole bar. Staff count; a manager verifies.</p>${canStart ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-count-start>Start stock count</button>' : ''}</div>`;
    listHost.innerHTML = `${toolbar}
      <div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table"><thead><tr><th>Count</th><th data-priority="2">Area</th><th>Status</th><th data-priority="2">Counted by</th><th class="is-num">Items</th><th class="is-num" data-priority="3">Differences</th><th data-priority="3">Date</th></tr></thead>
      <tbody>${rows.map(({ entry, total, counted, when, variances }) => `<tr data-count-open="${esc(entry.id)}"><td><a class="cell-primary" href="#inventory/counts/${encodeURIComponent(entry.id)}">${esc(entry.title || 'Stock count')}</a></td><td data-priority="2">${esc(scopeLabel(entry))}</td><td>${statusPill(entry.status)}</td><td data-priority="2">${esc(entry.started_by_label || '—')}</td><td class="is-num">${counted} of ${total}</td><td class="is-num" data-priority="3">${entry.status === 'draft' ? '—' : variances}</td><td data-priority="3">${esc(dateText(when))}</td></tr>`).join('')}</tbody></table>${rows.length ? '' : empty}</div>
      <ul class="atlas-table-list">${rows.map(({ entry, total, counted }) => `<li><a class="atlas-table-list__row" href="#inventory/counts/${encodeURIComponent(entry.id)}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(entry.title || 'Stock count')}</div><div class="atlas-table-list__meta">${esc([scopeLabel(entry), entry.started_by_label, dateText(entry.started_at)].filter(Boolean).join(' · '))}</div></div><div class="atlas-table-list__value">${counted} / ${total}<br>${statusPill(entry.status)}</div></a></li>`).join('')}</ul>
      ${rows.length ? '' : `<div class="sc-list-empty">${empty}</div>`}`;
    lucide();
  }

  async function renderListAsync(host, params) {
    listHost = host;
    renderList(host);
    if (!state.snapshot) {
      await loadSnapshot();
      if (listHost === host && host.isConnected) renderList(host);
    } else {
      loadSnapshot(true).then(() => { if (listHost === host && host.isConnected && !state.active) renderList(host); });
    }
    void params;
  }

  // Start sheet: choose an area (location), a category, or a full count.
  function openStartSheet({ itemIds = null } = {}) {
    const catalog = state.snapshot?.catalog || root.AtlasData?.items?.().filter((item) => item.active !== false) || [];
    const groups = (field) => {
      const map = new Map();
      catalog.forEach((item) => { const key = String(item[field] || '').trim(); if (key) map.set(key, (map.get(key) || 0) + 1); });
      return [...map].sort((a, b) => a[0].localeCompare(b[0]));
    };
    const locations = groups('bin_location');
    const categories = groups('category');
    const option = (type, value, label, count) => `<label class="sc-area"><input type="radio" class="atlas-radio" name="scope" value="${esc(type)}::${esc(value)}"${type === 'all' ? ' checked' : ''}><span class="sc-area__body"><span class="sc-area__title">${esc(label)}</span><span class="sc-area__meta">${count} ${count === 1 ? 'item' : 'items'}</span></span></label>`;
    const host = document.createElement('div');
    host.className = 'atlas-modal';
    host.dataset.atlasModal = '';
    host.hidden = true;
    host.innerHTML = `<section class="atlas-sheet" data-modal-panel role="dialog" aria-modal="true" aria-labelledby="sc-start-title"><span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="sc-start-title">Start stock count</h2><p class="atlas-sheet__desc">Choose what to count. You can pause and continue on any device.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <form class="atlas-sheet__body" id="sc-start-form">
        <fieldset class="sc-areas"><legend class="atlas-form-group__title">What are you counting?</legend>
        ${option('all', '', itemIds?.length ? `${itemIds.length} selected items (full count list)` : 'Full count', catalog.length)}
        ${locations.length ? `<p class="sc-areas__label">Areas</p>${locations.map(([value, count]) => option('location', value, value, count)).join('')}` : ''}
        ${categories.length ? `<p class="sc-areas__label">Categories</p>${categories.map(([value, count]) => option('category', value, value, count)).join('')}` : ''}
        </fieldset>
        <div class="atlas-field"><label for="sc-start-title-input">Name <span class="optional">(optional)</span></label><input class="atlas-input" id="sc-start-title-input" name="title" maxlength="200" placeholder="e.g. Back bar count"></div>
        <div data-sc-start-alert></div>
      </form>
      <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="sc-start-form" class="atlas-btn atlas-btn--primary" data-sc-start-submit>Start count</button></footer></section>`;
    document.body.appendChild(host);
    root.AtlasModal.register(host, { onClose: () => root.setTimeout(() => host.remove(), 0) });
    root.AtlasModal.open(host);
    lucide();
    const form = host.querySelector('#sc-start-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const [type, value] = String(new FormData(form).get('scope') || 'all::').split('::');
      const submit = host.querySelector('[data-sc-start-submit]');
      submit.disabled = true;
      submit.classList.add('is-loading');
      const title = form.elements.title.value.trim() || (type === 'all' ? 'Full count' : `${value} count`);
      try {
        const payload = await mutate('start', { title, scope_type: type, scope_value: type === 'all' ? null : value, notes: null, client_request_id: uuid() });
        root.AtlasModal.close(host);
        const id = payload.detail?.session?.id || payload.result?.session?.id;
        state.focusIds = itemIds?.length ? new Set(itemIds.map(String)) : null;
        if (id) shell.navigate(`#inventory/counts/${encodeURIComponent(id)}`);
      } catch (error) {
        submit.disabled = false;
        submit.classList.remove('is-loading');
        host.querySelector('[data-sc-start-alert]').innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">The count didn’t start.</p><p class="atlas-alert__body">${esc(shown(error))}</p></div></div>`;
        lucide();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Session screen (#inventory/counts/<id>)
  // ---------------------------------------------------------------------------
  function mountEl() { return state.mount && state.mount.isConnected ? state.mount : document.getElementById('inventory-view'); }

  function setPhoneTitle(text) {
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = text;
    document.title = `${text} · Atlas`;
  }

  function enterFlow() {
    state.active = true;
    document.body.classList.add('stock-count-active');
    root.AtlasChrome?.setTabBarHidden?.('stock-count', true);
    root.AtlasChrome?.setTopBar?.({ title: session()?.title || 'Stock count', back: () => pause(), actions: [{ icon: 'scan-line', label: 'Scan item', run: () => openScan() }] });
  }

  function leave() {
    if (!state.active) return;
    state.active = false;
    state.finishing = false;
    state.showAll = false;
    document.body.classList.remove('stock-count-active');
    root.AtlasChrome?.setTabBarHidden?.('stock-count', false);
    if (root.AtlasCapture?.isOpen?.()) root.AtlasCapture.close();
  }

  function pause() {
    const s = summary();
    leave();
    shell.navigate('#inventory/counts');
    if (session()?.status === 'draft') toast(`${session()?.title || 'Count'} paused · ${(num(s.counted_lines) || 0) + (num(s.skipped_lines) || 0)} of ${num(s.total_lines) || lines().length} counted`);
  }

  async function openSession(id, { mount = null } = {}) {
    state.mount = mount || state.mount || document.getElementById('inventory-view');
    const host = mountEl();
    if (!host) return;
    if (String(state.sessionId) !== String(id) || !state.detail) {
      state.detail = null;
      state.lineIndex = 0;
      state.finishing = false;
      state.showAll = false;
      if (state.sessionId && String(state.sessionId) !== String(id)) state.focusIds = null;
    }
    state.sessionId = id;
    enterFlow();
    if (!state.detail) {
      host.innerHTML = `<div class="sc-flow" aria-busy="true"><div class="sc-flow__head"><span class="atlas-skel atlas-skel--title"></span><span class="atlas-skel"></span></div><div class="atlas-card atlas-card--pad"><span class="atlas-skel atlas-skel--block"></span></div></div>`;
      try {
        await Promise.all([loadDetail(id), state.snapshot ? null : loadSnapshot()]);
      } catch (error) {
        host.innerHTML = `<div class="sc-flow"><div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">This count couldn’t be opened.</p><p class="atlas-alert__body">${esc(shown(error))}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-count-reopen="${esc(id)}">Try again</button></div></div><a class="atlas-btn atlas-btn--ghost" href="#inventory/counts">${icon('chevron-left')}All counts</a></div>`;
        lucide();
        return;
      }
      if (!state.detail) return;
      const first = pendingIndex(0);
      state.lineIndex = first >= 0 ? first : 0;
      if (first < 0 && session()?.status === 'draft' && lines().length) state.finishing = true;
    }
    root.AtlasChrome?.setTopBar?.({ title: session()?.title || 'Stock count', back: () => pause(), actions: session()?.status === 'draft' && permissions().can_edit ? [{ icon: 'scan-line', label: 'Scan item', run: () => openScan() }] : [] });
    // body.stock-count-active keeps the shell from overwriting the title.
    setPhoneTitle(session()?.title || 'Stock count');
    renderFlow();
  }

  function renderFlow() {
    const host = mountEl();
    if (!host || !state.detail || !state.active) return;
    const s = session();
    const perm = permissions();
    if (s.status !== 'draft' || !perm.can_edit) { host.innerHTML = reviewHtml(); lucide(); bindFlow(host); return; }
    host.innerHTML = state.finishing ? finishHtml() : state.showAll ? allItemsHtml() : (state.mode === 'list' && root.matchMedia?.('(min-width: 768px)').matches ? listModeHtml() : cardHtml());
    lucide();
    bindFlow(host);
  }

  function flowHead(extra = '') {
    const s = session();
    const sum = summary();
    const total = num(sum.total_lines) ?? lines().length;
    const done = (num(sum.counted_lines) || 0) + (num(sum.skipped_lines) || 0);
    const percent = total ? Math.round((done / total) * 100) : 0;
    const started = s.started_at ? `started ${timeText(s.started_at)}${s.started_by_label ? ` by ${s.started_by_label.split(' ')[0]}` : ''}` : '';
    const menu = [
      ['rapid', state.rapid ? 'Turn off rapid scan' : 'Rapid scan'],
      ['all', 'Show all items'],
      ...(root.AtlasAIVoice?.supported?.().liveVoice ? [['voice', 'Count by voice']] : []),
      ['finish', 'Finish count'],
      ...(perm().can_cancel ? [['cancel', 'Cancel count']] : [])
    ];
    return `<header class="sc-flow__head">
      <a class="atlas-btn atlas-btn--ghost atlas-btn--sm sc-back" href="#inventory/counts">${icon('chevron-left')}All counts</a>
      <h1 class="sc-flow__title">${esc(s.title || 'Stock count')}</h1>
      <div class="sc-flow__meta-row"><p class="sc-flow__meta">${done} of ${total} counted${started ? ` · ${esc(started)}` : ''}</p>
        <div class="sc-flow__tools">${state.focusIds?.size ? `<span class="atlas-pill atlas-pill--info">${state.focusIds.size} selected items</span>` : ''}${state.rapid ? '<span class="atlas-pill atlas-pill--info">Rapid scan</span>' : ''}
        ${root.matchMedia?.('(min-width: 768px)').matches ? `<div class="atlas-segmented" role="group" aria-label="Count view"><button type="button" aria-pressed="${state.mode !== 'list'}" data-count-mode="card">One by one</button><button type="button" aria-pressed="${state.mode === 'list'}" data-count-mode="list">List</button></div>` : ''}
        <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-count-pause>Pause</button>
        <button type="button" class="atlas-icon-btn" data-count-menu-trigger aria-label="More count options">${icon('ellipsis')}</button>
        <ul class="atlas-menu" data-count-menu hidden>${menu.map(([key, label]) => `<li><button type="button" class="atlas-menu__item${key === 'cancel' ? ' atlas-menu__item--danger' : ''}" data-count-menu-action="${key}">${esc(label)}</button></li>`).join('')}</ul></div></div>
      <div class="atlas-progress sc-flow__progress" role="progressbar" aria-label="Count progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${percent}%"></i></div>
      ${extra}
    </header>`;
  }
  const perm = () => permissions();

  function stepperHtml(line, value, { idPrefix = 'sc' } = {}) {
    const allowed = countUnits(line);
    const units = allowed.length > 1 ? allowed : null;
    const unit = units && units.includes(line.observed_input_unit) ? line.observed_input_unit : 'inventory';
    return `<div class="sc-stepper" data-stepper>
        <button type="button" class="sc-stepper__btn" data-step="-1" aria-label="One less">${icon('minus')}</button>
        <label class="sc-stepper__value"><span class="sr-only">Quantity of ${esc(line.item_name)} in ${esc(line.inventory_unit || 'units')}</span><input class="sc-stepper__input num" id="${idPrefix}-qty" data-count-qty type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${esc(value ?? '')}" placeholder="0"></label>
        <button type="button" class="sc-stepper__btn" data-step="1" aria-label="One more">${icon('plus')}</button>
      </div>
      ${bottleLike(line) ? `<div class="sc-partials" role="group" aria-label="Add part of a container">${[['0.25', '+ ¼'], ['0.5', '+ ½'], ['0.75', '+ ¾']].map(([step, label]) => `<button type="button" class="atlas-chip sc-partial" data-step="${step}">${label}</button>`).join('')}</div>` : ''}
      <div class="sc-unit-row" data-count-line-id="${esc(line.id)}">${units ? `<label class="sc-unit"><span class="sr-only">Count unit</span><select class="atlas-select" data-count-unit>${units.map((option) => `<option value="${esc(option)}"${unit === option ? ' selected' : ''}>${esc(option === 'inventory' ? `${line.inventory_unit || 'units'}` : UNIT_LABELS[option] || option)}</option>`).join('')}</select></label>` : `<span class="sc-unit-word">${esc(line.inventory_unit || 'units')}</span>`}<span class="sc-hint" data-count-hint aria-live="polite">${esc(previewText(line, value, unit))}</span></div>`;
  }

  function cardHtml() {
    const list = orderedLines();
    if (!list.length) return `<div class="sc-flow">${flowHead()}<div class="atlas-empty"><div class="atlas-empty__icon">${icon('package')}</div><h3 class="atlas-empty__title">Nothing to count here</h3><p class="atlas-empty__text">This count has no items. Scan an item to add it, or start a different count.</p></div></div>`;
    state.lineIndex = Math.max(0, Math.min(state.lineIndex, list.length - 1));
    const line = list[state.lineIndex];
    const value = line.line_status === 'counted' ? (line.observed_input_quantity ?? line.observed_quantity) : '';
    const upNext = [];
    for (let offset = 1; offset < list.length && upNext.length < 3; offset += 1) upNext.push(list[(state.lineIndex + offset) % list.length]);
    const position = `${line.bin_location ? `${line.bin_location} · ` : ''}item ${state.lineIndex + 1} of ${list.length}`;
    return `<div class="sc-flow">${flowHead()}
      <section class="atlas-card sc-card" aria-labelledby="sc-item-name" data-count-line="${esc(line.id)}">
        <p class="sc-card__where">${esc(position)}</p>
        <h2 class="sc-card__name" id="sc-item-name">${esc(line.item_name)}</h2>
        <p class="sc-card__last">${esc(lastVerifiedText(line))}</p>
        ${line.line_status !== 'pending' ? `<div class="sc-card__state">${linePill(line)}${line.line_status === 'counted' ? `<span class="sc-hint">Saved ${qty(line.observed_input_quantity ?? line.observed_quantity)}${line.counted_by_label ? ` by ${esc(line.counted_by_label)}` : ''}. Saving again replaces it.</span>` : `<span class="sc-hint">${esc(line.skipped_reason || '')}</span>`}</div>` : ''}
        ${stepperHtml(line, value)}
        <div class="sc-card__links"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-count-skip>Skip</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-count-open-item="${esc(line.inventory_item_id)}">Open item</button></div>
        <div data-count-alert></div>
      </section>
      ${upNext.length ? `<section class="sc-upnext" aria-labelledby="sc-upnext-title"><div class="atlas-section__head"><h2 class="atlas-section__title" id="sc-upnext-title">Up next</h2><button type="button" class="atlas-section__link sc-link-btn" data-count-show-all>Show all items</button></div>
        <ul class="atlas-card atlas-list">${upNext.map((entry) => `<li class="atlas-row atlas-row--link"><button type="button" class="sc-row-btn" data-count-goto="${esc(entry.id)}"><span class="atlas-row__body"><span class="atlas-row__title">${esc(entry.item_name)}</span><span class="atlas-row__meta">${esc([entry.bin_location, entry.line_status === 'counted' ? `counted ${qty(entry.observed_input_quantity ?? entry.observed_quantity)}` : lastVerifiedText(entry).replace('Last verified', 'last')].filter(Boolean).join(' · '))}</span></span><span class="atlas-row__end">${linePill(entry)}</span></button></li>`).join('')}</ul></section>` : ''}
      <p class="sc-caption">Stock changes only after a manager verifies this count.</p>
      <footer class="sc-footer">
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg sc-footer__scan" data-count-scan aria-label="Scan item">${icon('scan-line')}</button>
        <button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg sc-footer__save" data-count-save>Save and next${icon('arrow-right')}</button>
      </footer>
    </div>`;
  }

  function allItemsHtml() {
    const query = state.allQuery.trim().toLowerCase();
    const list = orderedLines().map((line, index) => ({ line, index })).filter(({ line }) => (state.allFilter === 'all' || line.line_status === state.allFilter)
      && (!query || [line.item_name, line.category, line.bin_location, line.sku, line.barcode].some((value) => String(value || '').toLowerCase().includes(query))));
    return `<div class="sc-flow">${flowHead()}
      <div class="atlas-toolbar sc-all__toolbar"><label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" data-count-all-search placeholder="Search this count" aria-label="Search this count" value="${esc(state.allQuery)}"></label>
      <div class="atlas-segmented" role="group" aria-label="Show">${[['pending', 'Not counted'], ['counted', 'Counted'], ['all', 'All']].map(([value, label]) => `<button type="button" aria-pressed="${state.allFilter === value}" data-count-all-filter="${value}">${label}</button>`).join('')}</div></div>
      <ul class="atlas-card atlas-list sc-all">${list.map(({ line, index }) => `<li class="atlas-row atlas-row--link"><button type="button" class="sc-row-btn" data-count-goto-index="${index}"><span class="atlas-row__body"><span class="atlas-row__title">${esc(line.item_name)}</span><span class="atlas-row__meta">${esc([line.bin_location, line.category].filter(Boolean).join(' · '))}</span></span><span class="atlas-row__end">${line.line_status === 'counted' ? `<span class="num">${qty(line.observed_input_quantity ?? line.observed_quantity)}</span>` : ''}${linePill(line)}</span></button></li>`).join('') || '<li class="sc-all__empty">No items match.</li>'}</ul>
      <div class="sc-footer sc-footer--plain"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-count-back-card>Back to counting</button></div></div>`;
  }

  // Desktop List mode: a dense table with inline numeric inputs; Enter or Tab
  // moves down, and each change saves that line.
  function listModeHtml() {
    const list = orderedLines();
    return `<div class="sc-flow sc-flow--wide">${flowHead()}
      <div class="atlas-table-wrap"><table class="atlas-table atlas-table--compact sc-list-table"><thead><tr><th>Item</th><th>Location</th><th class="is-num">Last verified</th><th class="is-num">Counted</th><th>Status</th></tr></thead>
      <tbody>${list.map((line) => { const item = catalogItem(line.inventory_item_id); return `<tr data-count-line="${esc(line.id)}"><td><span class="cell-primary">${esc(line.item_name)}</span><span class="cell-sub">${esc(line.inventory_unit || 'units')}</span></td><td>${esc(line.bin_location || '—')}</td><td class="is-num">${num(item?.verified_quantity) !== null ? qty(item.verified_quantity) : '—'}</td><td class="is-num"><input class="atlas-input sc-list-input num" data-count-list-qty="${esc(line.id)}" inputmode="decimal" aria-label="Counted ${esc(line.item_name)}" value="${esc(line.line_status === 'counted' ? (line.observed_input_quantity ?? line.observed_quantity) : '')}" placeholder="—"></td><td data-count-list-status>${linePill(line)}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="sc-footer sc-footer--plain"><span class="sc-caption">Changes save as you move to the next row.</span><button type="button" class="atlas-btn atlas-btn--primary" data-count-finish>Finish count</button></div></div>`;
  }

  function finishHtml() {
    const list = lines();
    const counted = list.filter((line) => line.line_status === 'counted');
    const skipped = list.filter((line) => line.line_status === 'skipped');
    const pending = list.filter((line) => line.line_status === 'pending');
    const big = counted.filter(bigVariance);
    const canSubmit = perm().can_submit && !pending.length;
    return `<div class="sc-flow">${flowHead()}
      <section class="atlas-card atlas-card--pad sc-finish" aria-labelledby="sc-finish-title">
        <h2 class="sc-finish__title" id="sc-finish-title">${pending.length ? 'Almost done' : 'Ready to submit'}</h2>
        <dl class="sc-finish__stats"><div><dt>Counted</dt><dd class="num">${counted.length}</dd></div><div><dt>Skipped</dt><dd class="num">${skipped.length}</dd></div><div><dt>Not counted</dt><dd class="num">${pending.length}</dd></div></dl>
        ${pending.length ? `<h3 class="sc-finish__sub">Not counted yet</h3><ul class="atlas-list">${pending.slice(0, 12).map((line) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${esc(line.item_name)}</p><p class="atlas-row__meta">${esc(line.bin_location || line.category || '')}</p></div><div class="atlas-row__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-count-goto="${esc(line.id)}">Count now</button></div></li>`).join('')}</ul>` : ''}
        ${skipped.length ? `<h3 class="sc-finish__sub">Skipped</h3><ul class="atlas-list">${skipped.map((line) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${esc(line.item_name)}</p><p class="atlas-row__meta">${esc(line.skipped_reason || '')}</p></div><div class="atlas-row__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-count-goto="${esc(line.id)}">Count now</button></div></li>`).join('')}</ul>` : ''}
        ${big.length ? `<h3 class="sc-finish__sub">Big differences</h3><p class="sc-hint">More than ${qty(tolerancePercent())}% away from the last verified count.</p><ul class="atlas-list">${big.map((line) => { const change = variance(line); return `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${esc(line.item_name)}</p><p class="atlas-row__meta">Counted ${qty(line.observed_quantity)} · ${change > 0 ? '+' : ''}${qty(change)} ${esc(line.inventory_unit || '')}</p></div><div class="atlas-row__end"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-count-goto="${esc(line.id)}">Recount</button></div></li>`; }).join('')}</ul>` : ''}
        <div data-count-alert></div>
      </section>
      <p class="sc-caption">Stock changes only after a manager verifies this count.</p>
      <footer class="sc-footer">
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-count-back-card>Keep counting</button>
        ${perm().can_submit ? `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg sc-footer__save" data-count-submit${canSubmit ? '' : ' disabled title="Count or skip every item first."'}>Submit for verification</button>` : ''}
      </footer></div>`;
  }

  // Submitted / verified / other statuses: the review screen (manager verify
  // unchanged: Verify count, Send back, then the separate publication step).
  function reviewHtml() {
    const s = session();
    const p = perm();
    const list = lines();
    const publication = state.detail?.publication || null;
    const policy = state.policy || {};
    const actions = [];
    if (p.can_reject) actions.push('<button type="button" class="atlas-btn atlas-btn--secondary" data-count-reject>Send back</button>');
    if (p.can_cancel && s.status !== 'draft') actions.push('<button type="button" class="atlas-btn atlas-btn--danger" data-count-cancel>Cancel count</button>');
    if (p.can_prepare_publication) actions.push('<button type="button" class="atlas-btn atlas-btn--secondary" data-count-prepare>Prepare stock update</button>');
    if (publication?.status === 'ready' && p.production_apply_enabled && policy.publication_environment_enabled) actions.push('<button type="button" class="atlas-btn atlas-btn--primary" data-count-publish>Update stock from this count</button>');
    if (p.can_verify) actions.push('<button type="button" class="atlas-btn atlas-btn--primary" data-count-verify>Verify count</button>');
    const note = s.status === 'submitted'
      ? (isManager() ? 'Check the differences, then verify. Verified counts become the stock Atlas shows.' : 'Waiting for a manager to verify it.')
      : s.status === 'verified' ? `Verified${s.verified_by_label ? ` by ${s.verified_by_label}` : ''}${s.verified_at ? ` on ${dateText(s.verified_at, { long: true })}` : ''}.`
        : s.status === 'draft' ? 'You can’t edit this count.' : 'This count is closed.';
    return `<div class="sc-flow sc-flow--wide">
      <header class="sc-flow__head"><div class="sc-flow__title-row"><a class="atlas-btn atlas-btn--ghost atlas-btn--sm sc-back" href="#inventory/counts">${icon('chevron-left')}All counts</a></div>
      <h1 class="sc-flow__title">${esc(s.title || 'Stock count')}</h1><p class="sc-flow__meta">${statusPill(s.status)} ${esc(note)}</p></header>
      ${publication?.status === 'blocked' ? `<div class="atlas-alert atlas-alert--warning">${icon('triangle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">The stock update is blocked.</p><p class="atlas-alert__body">${esc(publication.blocked_reason || 'Review the count first.')}</p></div></div>` : ''}
      ${s.publication_status === 'published' ? `<div class="atlas-alert atlas-alert--positive">${icon('circle-check')}<div class="atlas-alert__content"><p class="atlas-alert__body">This count updated stock. The count and the earlier quantities are kept in the history.</p></div></div>` : ''}
      <div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table"><thead><tr><th>Item</th><th class="is-num">Last verified</th><th class="is-num">Counted</th><th class="is-num">Difference</th><th>Status</th></tr></thead>
      <tbody>${list.map((line) => { const item = catalogItem(line.inventory_item_id); const change = variance(line); return `<tr${bigVariance(line) ? ' class="sc-row--flag"' : ''}><td><span class="cell-primary">${esc(line.item_name)}</span><span class="cell-sub">${esc([line.bin_location, line.counted_by_label].filter(Boolean).join(' · '))}</span></td><td class="is-num">${num(item?.verified_quantity) !== null ? qty(item.verified_quantity) : '—'}</td><td class="is-num">${line.line_status === 'counted' ? qty(line.observed_quantity) : '—'}</td><td class="is-num">${line.line_status === 'counted' ? esc(varianceText(change)) : '—'}</td><td>${linePill(line)}</td></tr>`; }).join('')}</tbody></table></div>
      <ul class="atlas-table-list">${list.map((line) => { const change = variance(line); return `<li><div class="atlas-table-list__row"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(line.item_name)}</div><div class="atlas-table-list__meta">${esc(line.bin_location || '')}${line.line_status === 'counted' ? ` · ${esc(varianceText(change))}` : ''}</div></div><div class="atlas-table-list__value">${line.line_status === 'counted' ? qty(line.observed_quantity) : '—'}<br>${linePill(line)}</div></div></li>`; }).join('')}</ul>
      <div data-count-alert></div>
      ${actions.length ? `<footer class="sc-footer sc-footer--plain">${actions.join('')}</footer>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------
  function parseQuantity(raw) {
    const text = String(raw ?? '').trim().replace(',', '.');
    if (text === '') return { error: 'Enter how many there are. Use 0 if there are none.' };
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return { error: 'Enter a number of 0 or more.' };
    if (Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-6) return { error: 'Use up to three decimal places.' };
    return { value };
  }

  async function saveLine(line, value, { unit = null, method = 'manual', evidence = null, note = undefined } = {}) {
    const previous = { status: line.line_status, quantity: line.observed_input_quantity ?? line.observed_quantity, unit: line.observed_input_unit || 'inventory', note: line.note || null };
    const payload = await mutate('save-line', {
      session_id: session().id,
      line_id: line.id,
      line_status: 'counted',
      observed_input_quantity: value,
      observed_input_unit: unit || line.observed_input_unit || 'inventory',
      count_method: method,
      note: note === undefined ? (line.note || null) : note,
      skipped_reason: null,
      expected_version: line.version,
      evidence: { capture_surface: method === 'manual' ? 'count_screen' : 'atlas_capture', client_recorded_at: new Date().toISOString(), ...(evidence ? { recognition: evidence } : {}) }
    });
    const fresh = lines().find((entry) => entry.id === line.id) || line;
    toast(`Saved ${qty(value)} ${line.inventory_unit || ''} · ${line.item_name}`, { action: { label: 'Undo', onClick: () => undoLine(fresh.id, previous) } });
    return payload;
  }

  async function undoLine(lineId, previous) {
    const line = lines().find((entry) => entry.id === lineId);
    if (!line || session()?.status !== 'draft') return;
    try {
      if (previous.status === 'counted') {
        await mutate('save-line', { session_id: session().id, line_id: line.id, line_status: 'counted', observed_input_quantity: previous.quantity, observed_input_unit: previous.unit, count_method: 'manual', note: previous.note, skipped_reason: null, expected_version: line.version, evidence: { capture_surface: 'undo' } });
      } else {
        await mutate('save-line', { session_id: session().id, line_id: line.id, line_status: 'pending', observed_input_quantity: null, count_method: null, note: previous.note, skipped_reason: null, expected_version: line.version, evidence: { capture_surface: 'undo' } });
      }
      toast(`${line.item_name} restored`);
      renderFlow();
    } catch (error) {
      toast(shown(error));
    }
  }

  function showCardError(message) {
    const host = mountEl()?.querySelector('[data-count-alert]');
    if (host) {
      host.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${esc(message)}</p></div></div>`;
      lucide();
    } else toast(message);
  }

  async function saveCurrent(button) {
    const list = orderedLines();
    const line = list[state.lineIndex];
    const host = mountEl();
    const input = host?.querySelector('[data-count-qty]');
    if (!line || !input || state.saving) return;
    const parsed = parseQuantity(input.value);
    if (parsed.error) { input.setAttribute('aria-invalid', 'true'); showCardError(parsed.error); input.focus(); return; }
    state.saving = true;
    button?.classList.add('is-loading');
    if (button) button.disabled = true;
    try {
      await saveLine(line, parsed.value, { unit: host.querySelector('[data-count-unit]')?.value || null });
      const next = pendingIndex(state.lineIndex + 1);
      if (next < 0) state.finishing = true;
      else state.lineIndex = next;
      renderFlow();
      const nextInput = mountEl()?.querySelector('[data-count-qty]');
      if (nextInput && root.matchMedia?.('(pointer: fine)').matches) nextInput.focus();
    } catch (error) {
      if (/changed on another device/.test(error.message)) { await loadDetail(session().id).catch(() => {}); renderFlow(); }
      showCardError(shown(error));
    } finally {
      state.saving = false;
      button?.classList.remove('is-loading');
      if (button) button.disabled = false;
    }
  }

  function dialog({ title, body, confirm, tone = 'primary', field = null }) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.className = 'atlas-modal';
      host.dataset.atlasModal = '';
      host.hidden = true;
      host.innerHTML = `<section class="atlas-dialog${field ? ' atlas-dialog--form' : ''}" data-modal-panel role="dialog" aria-modal="true" aria-labelledby="sc-dialog-title"><h2 class="atlas-dialog__title" id="sc-dialog-title">${esc(title)}</h2><form class="atlas-dialog__body" id="sc-dialog-form"><p>${esc(body)}</p>${field ? `<div class="atlas-field"><label for="sc-dialog-field">${esc(field.label)}</label><input class="atlas-input" id="sc-dialog-field" name="value" maxlength="${field.max || 1000}" value="${esc(field.value || '')}" ${field.required ? 'required' : ''}></div>` : ''}</form><div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="sc-dialog-form" class="atlas-btn atlas-btn--${tone}">${esc(confirm)}</button></div></section>`;
      document.body.appendChild(host);
      let answered = false;
      root.AtlasModal.register(host, { onClose: () => { root.setTimeout(() => host.remove(), 0); if (!answered) resolve(null); } });
      root.AtlasModal.open(host);
      host.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const value = host.querySelector('#sc-dialog-field')?.value.trim() ?? true;
        if (field?.required && !value) { host.querySelector('#sc-dialog-field').setAttribute('aria-invalid', 'true'); return; }
        answered = true;
        resolve(value);
        root.AtlasModal.close(host, 'confirm');
      });
    });
  }

  async function skipCurrent() {
    const line = orderedLines()[state.lineIndex];
    if (!line) return;
    const reason = await dialog({ title: `Skip ${line.item_name}?`, body: 'It stays on the list as skipped. A manager sees the reason.', confirm: 'Skip item', field: { label: 'Reason', value: 'Couldn’t reach it', required: true } });
    if (!reason) return;
    try {
      await mutate('save-line', { session_id: session().id, line_id: line.id, line_status: 'skipped', observed_input_quantity: null, count_method: null, note: line.note || null, skipped_reason: reason, expected_version: line.version });
      const next = pendingIndex(state.lineIndex + 1);
      if (next < 0) state.finishing = true; else state.lineIndex = next;
      renderFlow();
    } catch (error) { showCardError(shown(error)); }
  }

  async function command(action, confirmText, body, successMessage) {
    const alert = mountEl()?.querySelector('[data-count-alert]');
    try {
      await mutate(action, { session_id: session().id, ...body });
      toast(successMessage);
      if (action === 'submit' || action === 'cancel') state.finishing = false;
      if (action === 'cancel') { leave(); shell.navigate('#inventory/counts'); return; }
      renderFlow();
      if (['verify', 'publish'].includes(action)) root.atlasReloadData?.();
    } catch (error) {
      if (alert) { alert.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${esc(shown(error))}</p></div></div>`; lucide(); }
      else toast(shown(error));
      throw error;
    }
    void confirmText;
  }

  async function verify() {
    const ok = await dialog({ title: 'Verify this count?', body: 'The counted quantities become the stock Atlas shows for these items. The count and who did it are kept.', confirm: 'Verify count' });
    if (!ok) return;
    try {
      await command('verify', null, { acknowledge_conflicts: false }, 'Count verified');
    } catch (error) {
      if (!/changed|conflict|acknowledge/i.test(String(error.message))) return;
      const again = await dialog({ title: 'Stock changed during this count', body: 'Some items had deliveries or other changes after the count started. Verify anyway and keep the counted quantities?', confirm: 'Verify anyway' });
      if (again) await command('verify', null, { acknowledge_conflicts: true }, 'Count verified').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Scan and rapid scan (owner §§8–9): AtlasCapture in stock_count mode
  // ---------------------------------------------------------------------------
  function openScan() {
    if (!root.AtlasCapture) { toast('Scanning isn’t available right now.'); return; }
    if (!session() || session().status !== 'draft') return;
    root.AtlasCapture.open({
      mode: 'stock_count',
      title: state.rapid ? 'Rapid scan' : 'Scan item',
      context: { count_session_id: session().id },
      continuous: state.rapid,
      doneLabel: state.rapid ? 'Done' : null,
      onResult: (result, ctl) => scanResult(result, ctl),
      onSearch: (ctl) => root.AtlasInventory?.searchSheet?.({ result: {}, detection: null, ctl, onChoose: chooseHandler({}, null, ctl), prefill: '' }),
      onClose: () => renderFlow(),
      onDone: () => { state.finishing = pendingIndex(0) < 0; }
    });
  }

  function chooseHandler(result, detection, ctl) {
    const handler = (itemId, rank, how) => countSheet(result, detection, ctl, { itemId, rank, how });
    handler.usedFor = 'count_line';
    handler.back = () => scanResult(result, ctl);
    return handler;
  }

  function scanResult(result, ctl) {
    const detection = (result.detections || [])[0] || null;
    if (!detection || detection.band === 'low') {
      root.AtlasInventory.unknownSheet(result, detection, ctl, { onChoose: chooseHandler(result, detection, ctl), usedFor: 'count_line' });
      return;
    }
    if (detection.band === 'high' && detection.preselected_item_id) {
      countSheet(result, detection, ctl, { itemId: detection.preselected_item_id, rank: 1, how: 'confirmed_preselected' });
      return;
    }
    const R = root.AtlasCapture.render;
    ctl.showSheet(`<div class="atlas-capture-result"><div class="atlas-capture-result__head"><div class="atlas-capture-result__text"><h3 class="atlas-capture-result__title">Which product is this?</h3><p class="atlas-capture-muted">Choose the right one. Nothing is counted until you save.</p></div>${R.band(detection)}</div>
      ${R.candidates(detection, { action: 'Count' })}
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-none>None of these</button></div></div>`, (sheet) => {
      sheet.querySelectorAll('[data-capture-choose]').forEach((button) => button.addEventListener('click', () => countSheet(result, detection, ctl, { itemId: button.dataset.captureChoose, rank: Number(button.dataset.rank) || null, how: 'chose_candidate' })));
      sheet.querySelector('[data-none]').addEventListener('click', () => root.AtlasInventory.unknownSheet(result, detection, ctl, { onChoose: chooseHandler(result, detection, ctl), usedFor: 'count_line' }));
    });
  }

  // The count card inside the capture (owner §8): product, last verified, the
  // band, [-] n [+], then Save and scan next / Open item / Wrong product.
  function countSheet(result, detection, ctl, { itemId, rank = null, how = 'chose_candidate', mode = null }) {
    const R = root.AtlasCapture.render;
    const line = lines().find((entry) => String(entry.inventory_item_id) === String(itemId));
    const candidate = (detection?.candidates || []).find((entry) => String(entry.item_id) === String(itemId)) || null;
    const item = liveItem(itemId) || candidate?.item || catalogItem(itemId) || { id: itemId, name: 'This item' };
    if (!line) {
      ctl.showSheet(`<div class="atlas-capture-result"><div class="atlas-capture-result__head"><div class="atlas-capture-result__text"><p class="atlas-capture-result__kicker">Not in this count</p><h3 class="atlas-capture-result__title">${esc(item.name)}</h3><p class="atlas-capture-muted">${esc([item.category, item.bin_location].filter(Boolean).join(' · '))}</p></div>${detection ? R.band(detection, candidate) : ''}</div>
        <p>Add it to ${esc(session().title || 'this count')} to count it now.</p><div data-sheet-alert></div>
        <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-add-line>Add to this count</button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-retry>Scan something else</button></div></div>`, (sheet) => {
        sheet.querySelector('[data-retry]').addEventListener('click', () => ctl.resume());
        sheet.querySelector('[data-add-line]').addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.classList.add('is-loading');
          try {
            await mutate('add-line', { session_id: session().id, item_id: itemId });
            countSheet(result, detection, ctl, { itemId, rank, how });
          } catch (error) {
            button.disabled = false;
            button.classList.remove('is-loading');
            sheet.querySelector('[data-sheet-alert]').innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${esc(shown(error))}</p></div></div>`;
            lucide();
          }
        });
      });
      return;
    }
    const already = line.line_status === 'counted' ? num(line.observed_input_quantity ?? line.observed_quantity) : null;
    if (already !== null && !mode) {
      ctl.showSheet(`<div class="atlas-capture-result"><div class="atlas-capture-result__head"><div class="atlas-capture-result__text"><p class="atlas-capture-result__kicker">Counted earlier</p><h3 class="atlas-capture-result__title">${esc(line.item_name)}</h3><p class="atlas-capture-muted">Counted ${qty(already)} earlier · replace or add?</p></div></div>
        <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-mode="add">Add more</button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-mode="replace">Replace</button></div></div>`, (sheet) => {
        sheet.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => countSheet(result, detection, ctl, { itemId, rank, how, mode: button.dataset.mode })));
      });
      return;
    }
    const ref = root.AtlasInventory?.recognitionRef?.(result, detection) || null;
    ctl.showSheet(`<div class="atlas-capture-result sc-scan-card" data-capture-result="count">
      <div class="atlas-capture-result__head">${item.image_url ? `<img class="atlas-capture-result__img" src="${esc(item.image_url)}" alt="">` : `<span class="atlas-capture-result__img" aria-hidden="true">${icon('package')}</span>`}
        <div class="atlas-capture-result__text"><h3 class="atlas-capture-result__title">${esc(line.item_name)}</h3><p class="atlas-capture-muted">${esc([item.brand, item.category, item.package_size || null].filter(Boolean).join(' · '))}</p><p class="atlas-capture-muted">Counted in ${esc(line.inventory_unit || 'units')} · ${esc(lastVerifiedText(line))}</p></div>
        ${detection ? R.band(detection, candidate) : '<span class="atlas-pill atlas-pill--info">Chosen</span>'}</div>
      ${detection ? `<details class="atlas-capture-more"><summary>How sure Atlas is</summary>${R.fields(detection, { item, keys: ['identity', 'brand', 'variant', 'unit_size', 'barcode', 'inventory_match'] })}</details>` : ''}
      ${mode === 'add' ? `<p class="sc-hint">Adds to the ${qty(already)} counted earlier.</p>` : ''}
      ${stepperHtml(line, '', { idPrefix: 'sc-scan' })}
      <div data-sheet-alert></div>
      <div class="atlas-capture__actions atlas-capture__actions--count">
        <button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-save-next>Save and scan next</button>
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-open-item>Open item</button>
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-wrong>Wrong product</button>
      </div></div>`, (sheet) => {
      const input = sheet.querySelector('[data-count-qty]');
      bindStepper(sheet);
      if (root.matchMedia?.('(pointer: fine)').matches) input?.focus();
      sheet.querySelector('[data-open-item]').addEventListener('click', () => { recordChoice(ref, itemId, rank, how); ctl.close(); root.AtlasInventory?.openItem?.(itemId); });
      sheet.querySelector('[data-wrong]').addEventListener('click', () => root.AtlasInventory?.wrongProduct?.({ result, detection, ctl, ref: ref || {}, itemId, onRetry: () => ctl.resume() }));
      sheet.querySelector('[data-save-next]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const parsed = parseQuantity(input.value);
        const alert = sheet.querySelector('[data-sheet-alert]');
        if (parsed.error) { input.setAttribute('aria-invalid', 'true'); alert.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${esc(parsed.error)}</p></div></div>`; lucide(); input.focus(); return; }
        button.disabled = true;
        button.classList.add('is-loading');
        try {
          const outcomeId = await recordChoice(ref, itemId, rank, how);
          const method = result.method === 'vision' ? 'photo' : result.method === 'barcode' ? 'barcode' : 'manual';
          const evidence = outcomeId ? { outcome_id: outcomeId, detection_id: ref?.detectionId || null, request_id: ref?.requestId || null } : null;
          const value = mode === 'add' ? round3(already + parsed.value) : parsed.value;
          await saveLine(line, value, { unit: sheet.querySelector('[data-count-unit]')?.value || null, method: evidence ? method : 'manual', evidence });
          ctl.resume();
          renderFlowSilently();
        } catch (error) {
          button.disabled = false;
          button.classList.remove('is-loading');
          alert.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${esc(shown(error))}</p></div></div>`;
          lucide();
        }
      });
    });
  }

  function recordChoice(ref, itemId, rank, how) {
    if (!ref?.detectionId || !root.AtlasInventory?.recordRecognitionChoice) return Promise.resolve(null);
    return root.AtlasInventory.recordRecognitionChoice(ref, itemId, 'count_line', rank, how);
  }

  function renderFlowSilently() {
    const index = orderedLines().findIndex((line) => line.line_status === 'pending');
    if (index >= 0 && orderedLines()[state.lineIndex]?.line_status !== 'pending') state.lineIndex = index;
    if (!root.AtlasCapture?.isOpen?.()) renderFlow();
  }

  // ---------------------------------------------------------------------------
  // Binding
  // ---------------------------------------------------------------------------
  function bindStepper(scope) {
    const input = scope.querySelector('[data-count-qty]');
    scope.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => {
      const current = parseQuantity(input.value).value || 0;
      input.value = String(round3(Math.max(0, current + Number(button.dataset.step))));
      input.removeAttribute('aria-invalid');
    }));
    input?.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    const row = scope.querySelector('[data-count-line-id]');
    const line = row && lines().find((entry) => String(entry.id) === row.dataset.countLineId);
    const hint = row?.querySelector('[data-count-hint]');
    const unit = row?.querySelector('[data-count-unit]');
    if (!line || !hint || !unit) return;
    const update = () => { hint.textContent = previewText(line, input?.value, unit.value); };
    unit.addEventListener('change', update);
    input?.addEventListener('input', update);
    scope.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', update));
  }

  function bindFlow(host) {
    bindStepper(host);
    const trigger = host.querySelector('[data-count-menu-trigger]');
    const menu = host.querySelector('[data-count-menu]');
    if (trigger && menu) shell.menu(trigger, menu, { onSelect: (item) => menuAction(item.dataset.countMenuAction) });
    host.querySelector('[data-count-qty]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); saveCurrent(host.querySelector('[data-count-save]')); }
    });
    host.querySelectorAll('[data-count-list-qty]').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const all = [...host.querySelectorAll('[data-count-list-qty]')];
        all[all.indexOf(input) + 1]?.focus();
      });
      input.addEventListener('change', () => saveListInput(input));
    });
  }

  async function saveListInput(input) {
    const line = lines().find((entry) => entry.id === input.dataset.countListQty);
    if (!line) return;
    const parsed = parseQuantity(input.value);
    if (input.value.trim() === '') return;
    if (parsed.error) { input.setAttribute('aria-invalid', 'true'); input.title = parsed.error; return; }
    input.removeAttribute('aria-invalid');
    try {
      await mutate('save-line', { session_id: session().id, line_id: line.id, line_status: 'counted', observed_input_quantity: parsed.value, observed_input_unit: line.observed_input_unit || 'inventory', count_method: 'manual', note: line.note || null, skipped_reason: null, expected_version: line.version, evidence: { capture_surface: 'count_list' } });
      const row = input.closest('tr');
      const status = row?.querySelector('[data-count-list-status]');
      if (status) status.innerHTML = '<span class="atlas-pill atlas-pill--positive">Counted</span>';
      const head = mountEl()?.querySelector('.sc-flow__meta');
      const sum = summary();
      if (head) head.textContent = `${(num(sum.counted_lines) || 0) + (num(sum.skipped_lines) || 0)} of ${num(sum.total_lines) || lines().length} counted`;
    } catch (error) {
      input.setAttribute('aria-invalid', 'true');
      input.title = shown(error);
      toast(shown(error));
    }
  }

  function menuAction(action) {
    if (action === 'rapid') {
      state.rapid = !state.rapid;
      writePref(RAPID_KEY, state.rapid ? 'on' : 'off');
      renderFlow();
      if (state.rapid) openScan();
    } else if (action === 'all') { state.showAll = true; state.finishing = false; renderFlow(); }
    else if (action === 'voice') root.AtlasAI?.ask?.({ question: '', record: { type: 'count_session', id: session().id, label: session().title }, view: 'inventory' });
    else if (action === 'finish') { state.finishing = true; state.showAll = false; renderFlow(); }
    else if (action === 'cancel') {
      dialog({ title: 'Cancel this count?', body: 'Nothing counted so far changes stock. The count is kept as cancelled.', confirm: 'Cancel count', tone: 'danger-solid' })
        .then((ok) => { if (ok) command('cancel', null, { reason: 'Cancelled from the count screen' }, 'Count cancelled').catch(() => {}); });
    }
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const inList = listHost && listHost.contains(target);
    const inFlow = state.active && mountEl()?.contains(target);
    if (!inList && !inFlow) return;
    if (target.closest('[data-count-start]')) { openStartSheet(); return; }
    if (target.closest('[data-count-retry]')) { loadSnapshot(true).then(() => renderList()); return; }
    const filter = target.closest('[data-count-filter]');
    if (filter) { state.listFilter = filter.dataset.countFilter; renderList(); return; }
    const row = target.closest('tr[data-count-open]');
    if (row && !target.closest('a')) { shell.navigate(`#inventory/counts/${encodeURIComponent(row.dataset.countOpen)}`); return; }
    if (!inFlow) return;
    const reopen = target.closest('[data-count-reopen]');
    if (reopen) { state.detail = null; openSession(reopen.dataset.countReopen); return; }
    if (target.closest('[data-count-pause]')) { pause(); return; }
    if (target.closest('[data-count-save]')) { saveCurrent(target.closest('[data-count-save]')); return; }
    if (target.closest('[data-count-scan]')) { openScan(); return; }
    if (target.closest('[data-count-skip]')) { skipCurrent(); return; }
    const openItem = target.closest('[data-count-open-item]');
    if (openItem) { root.AtlasInventory?.openItem?.(openItem.dataset.countOpenItem); return; }
    if (target.closest('[data-count-show-all]')) { state.showAll = true; renderFlow(); return; }
    if (target.closest('[data-count-back-card]')) { state.showAll = false; state.finishing = false; renderFlow(); return; }
    if (target.closest('[data-count-finish]')) { state.finishing = true; renderFlow(); return; }
    const mode = target.closest('[data-count-mode]');
    if (mode) { state.mode = mode.dataset.countMode; writePref(MODE_KEY, state.mode); renderFlow(); return; }
    const allFilter = target.closest('[data-count-all-filter]');
    if (allFilter) { state.allFilter = allFilter.dataset.countAllFilter; renderFlow(); return; }
    const goto = target.closest('[data-count-goto]');
    if (goto) {
      const index = orderedLines().findIndex((line) => line.id === goto.dataset.countGoto);
      if (index < 0) state.focusIds = null;
      state.lineIndex = Math.max(0, orderedLines().findIndex((line) => line.id === goto.dataset.countGoto));
      state.showAll = false;
      state.finishing = false;
      renderFlow();
      return;
    }
    const gotoIndex = target.closest('[data-count-goto-index]');
    if (gotoIndex) { state.lineIndex = Number(gotoIndex.dataset.countGotoIndex) || 0; state.showAll = false; renderFlow(); return; }
    if (target.closest('[data-count-submit]')) {
      dialog({ title: 'Submit this count?', body: 'A manager checks it and verifies it. You can’t change it after you submit.', confirm: 'Submit for verification' })
        .then((ok) => { if (ok) command('submit', null, { notes: null }, 'Count submitted for verification').catch(() => {}); });
      return;
    }
    if (target.closest('[data-count-verify]')) { verify(); return; }
    if (target.closest('[data-count-reject]')) {
      dialog({ title: 'Send this count back?', body: 'The team can correct it and submit it again.', confirm: 'Send back', field: { label: 'What needs fixing?', required: true } })
        .then((reason) => { if (reason) command('reject', null, { reason }, 'Count sent back').catch(() => {}); });
      return;
    }
    if (target.closest('[data-count-cancel]')) { menuAction('cancel'); return; }
    if (target.closest('[data-count-prepare]')) {
      command('prepare-publication', null, { request_id: state.detail?.publication?.request_id || uuid() }, 'Stock update prepared').catch(() => {});
      return;
    }
    if (target.closest('[data-count-publish]')) {
      dialog({ title: 'Update stock from this count?', body: 'Stock is set to the verified quantities. Earlier quantities and the count stay in the history.', confirm: 'Update stock' })
        .then((ok) => { if (ok) command('publish', null, { request_id: state.detail?.publication?.request_id }, 'Stock updated').catch(() => {}); });
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !state.active) return;
    if (target.matches('[data-count-all-search]')) {
      state.allQuery = target.value;
      renderFlow();
      const input = mountEl()?.querySelector('[data-count-all-search]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------
  async function openForItem(itemId) {
    await loadSnapshot();
    const drafts = (state.snapshot?.sessions || []).filter((entry) => entry.status === 'draft');
    const target = drafts[0] || null;
    if (!target) {
      // No count in progress: offer to start one for this item (nothing is
      // started without the counter choosing it).
      if (!(state.snapshot?.permissions?.can_start ?? true)) { toast('Ask a manager to start a count.'); return; }
      shell.navigate('#inventory/counts');
      state.focusIds = new Set([String(itemId)]);
      openStartSheet({ itemIds: [itemId] });
      return;
    }
    await loadDetail(target.id);
    let line = lines().find((entry) => String(entry.inventory_item_id) === String(itemId));
    if (!line) {
      try { await mutate('add-line', { session_id: target.id, item_id: itemId }); line = lines().find((entry) => String(entry.inventory_item_id) === String(itemId)); } catch (error) { toast(shown(error)); }
    }
    state.focusIds = null;
    state.lineIndex = Math.max(0, lines().findIndex((entry) => line && entry.id === line.id));
    state.finishing = false;
    state.showAll = false;
    shell.navigate(`#inventory/counts/${encodeURIComponent(target.id)}`);
  }

  async function startForItems(ids) {
    await loadSnapshot();
    state.focusIds = new Set((ids || []).map(String));
    const draft = (state.snapshot?.sessions || []).find((entry) => entry.status === 'draft');
    if (draft) { shell.navigate(`#inventory/counts/${encodeURIComponent(draft.id)}`); return; }
    openStartSheet({ itemIds: ids });
  }

  function homeRows() {
    const shared = root.AtlasData?.countSnapshot?.()?.sessions;
    const sessions = state.snapshot?.sessions || (Array.isArray(shared) ? shared : []);
    const rows = [];
    sessions.filter((entry) => entry.status === 'draft').slice(0, 2).forEach((entry) => {
      const s = entry.summary || {};
      const total = num(s.total_lines) || 0;
      const done = (num(s.counted_lines) || 0) + (num(s.skipped_lines) || 0);
      rows.push({ id: `paused:${entry.id}`, severity: 'info', icon: 'list-checks', title: `${entry.title || 'Stock count'} paused · ${done} of ${total}`, detail: entry.started_by_label ? `Started by ${entry.started_by_label}` : 'Continue where you left off', action: { label: 'Continue', route: `#inventory/counts/${entry.id}` }, roles: ['admin', 'manager', 'bartender'] });
    });
    sessions.filter((entry) => entry.status === 'submitted').slice(0, 2).forEach((entry) => {
      rows.push({ id: `verify:${entry.id}`, severity: 'warning', icon: 'badge-check', title: `${entry.title || 'Stock count'} is waiting for verification`, detail: entry.submitted_at ? `Submitted ${dateTimeText(entry.submitted_at)}` : 'Submitted', action: { label: 'Review', route: `#inventory/counts/${entry.id}` }, roles: ['admin', 'manager'] });
    });
    return rows;
  }

  function init() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    shell?.actions?.register?.({
      id: 'inventory.count.start', label: 'Start stock count', icon: 'list-checks', keywords: ['count', 'stocktake', 'count stock'], roles: ['admin', 'manager', 'bartender'], contexts: ['home', 'inventory'],
      forRecord: 'inventory_item', recordLabel: 'Count {name}',
      run: async (ctx = {}) => {
        if (ctx.record?.type === 'inventory_item' && ctx.record.id) { await openForItem(ctx.record.id); return; }
        await loadSnapshot();
        const draft = (state.snapshot?.sessions || []).find((entry) => entry.status === 'draft');
        if (draft) shell.navigate(`#inventory/counts/${encodeURIComponent(draft.id)}`);
        else { if (shell.current() !== 'inventory' || shell.params().section !== 'stock-count') shell.navigate('#inventory/counts'); openStartSheet(); }
      },
      denied: () => toast('Counting is for bar staff and managers.')
    });
    shell?.home?.contribute?.('stock-count', { order: 30, focusRows: homeRows });
    shell?.on?.('view:before-show', (context) => {
      if (!state.active) return;
      const params = context.params || {};
      if (context.view !== 'inventory' || params.section !== 'stock-count' || !params.session) leave();
    });
    shell?.on?.('profile:ready', () => { state.snapshot = null; state.detail = null; if (['admin', 'manager', 'bartender'].includes(role())) loadSnapshot(); });
    root.addEventListener('pagehide', () => leave(), { once: true });
  }

  root.AtlasStockCounts = {
    renderList: (host, params) => renderListAsync(host, params),
    openSession,
    openForItem,
    startForItems,
    openScan,
    leave,
    open: () => shell.navigate('#inventory/counts'),
    close: leave,
    refresh: () => loadSnapshot(true),
    snapshot: () => state.snapshot,
    detail: () => state.detail,
    policy: () => state.policy,
    // Pure helpers, exported for tests.
    parseQuantity,
    quantityFamily,
    countUnits,
    previewNormalization,
    previewText,
    varianceText,
    homeRows
  };
  init();
})(window);
