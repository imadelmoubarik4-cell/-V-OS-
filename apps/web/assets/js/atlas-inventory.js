// Inventory (spec §7.5, §8.2): the items workspace, item detail, add item
// (guarded create-item with the duplicate check), activation, movements,
// waste, and the Visual Inventory flows that start from Inventory (identify
// item, unknown item, add product by camera). Counts render through
// AtlasStockCounts (stock-count-workspace.js); capture through AtlasCapture.
//
// Truth rules: quantities come only from AtlasStockTruth (last verified count
// plus recorded movements); unknown stays "Not counted". Nothing here creates
// an item except atlas-item-master ?action=create-item, and nothing here
// changes stock except the explicit waste command (managers).
(function (root) {
  'use strict';

  const shell = root.AtlasShell;
  if (!shell || root.AtlasInventory) return;

  const MANAGERS = ['admin', 'manager'];
  const STAFF = ['admin', 'manager', 'bartender'];
  const ALMOST_OUT_RATIO = 0.25;
  const UNITS = ['bottles', 'cans', 'each', 'kg', 'g', 'litres', 'ml', 'cases', 'boxes', 'bags', 'packs', 'jars', 'kegs'];
  const WASTE_REASONS = [['spoilage', 'Spoilage'], ['breakage', 'Breakage'], ['spill', 'Spill'], ['expiry', 'Expired'], ['preparation', 'Preparation waste'], ['other', 'Other']];
  const MOVEMENT_TYPES = { restock: ['Restock', 'positive'], waste: ['Waste', 'danger'], adjustment: ['Adjustment', 'neutral'], count: ['Count', 'info'], sale: ['Sale', 'neutral'], transfer: ['Transfer', 'neutral'] };
  const ITEM_MASTER_ERRORS = {
    invalid_request: 'Some details weren’t valid. Check the highlighted fields.',
    forbidden: 'This is for managers. Ask an administrator for access.',
    not_found: 'This item no longer exists. Refresh the list.',
    stale_item: 'This item changed while you were looking. Refresh and try again.',
    open_purchase_order: 'It’s on an open purchase order. Receive or cancel the order first.',
    active_duplicate_name: 'Another active item has the same name. Rename one of them first.',
    duplicate_suspected: 'This looks like an existing item.',
    duplicate_identity: 'An active item with the same name and package already exists.',
    code_conflict: 'That barcode, SKU or supplier number already belongs to another item.',
    alias_conflict: 'That other name already belongs to another item.',
    invalid_code: 'That code isn’t valid. Check the digits.'
  };

  const state = {
    view: 'inventory',
    params: {},
    query: '',
    status: null,
    category: null,
    subcategory: null,
    supplier: null,
    location: null,
    activity: 'active',
    sort: { key: 'status', dir: 'asc' },
    selected: new Set(),
    movementType: null,
    movementQuery: '',
    focusMovement: null,
    detailId: null,
    detailFromList: false,
    lastLoadedAt: null,
    rendered: false
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = () => root.AtlasVenueClock;
  const truth = () => root.AtlasStockTruth;
  const role = () => shell.profile?.()?.role || root.atlasCurrentProfile?.role || null;
  const isManager = () => MANAGERS.includes(role());
  const canCount = () => STAFF.includes(role());
  const icon = (name) => `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
  const lucide = () => root.lucide?.createIcons?.();
  const uuid = () => (root.AtlasCapture?.uuid ? root.AtlasCapture.uuid() : root.crypto.randomUUID());
  const toast = (message, options) => shell.toast?.(message, options);

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function qty(value) {
    const parsed = num(value);
    if (parsed === null) return '—';
    return parsed.toLocaleString('en-GB', { maximumFractionDigits: 3 });
  }
  function money(value) {
    const parsed = num(value);
    if (parsed === null) return '—';
    return clock()?.formatKr ? clock().formatKr(parsed) : `${Math.round(parsed)} kr`;
  }
  function dateText(value, options) {
    if (!value) return '';
    return clock()?.formatDate ? clock().formatDate(typeof value === 'number' ? new Date(value) : value, options || {}) : '';
  }
  function dateTimeText(value) {
    if (!value) return '';
    return clock()?.formatDateTime ? clock().formatDateTime(value) : '';
  }

  function items() { return root.AtlasData?.items?.() || []; }
  function suppliers() { return root.AtlasData?.suppliers?.() || []; }
  function recipes() { return root.AtlasData?.recipes?.() || []; }
  function movements() { return root.AtlasData?.movements?.() || []; }
  function dataStatus() { return root.AtlasData?.status?.() || { items: 'ok' }; }
  // One shell input's load health ('loading' | 'ok' | 'failed').
  function inputHealth(key) { return root.AtlasData?.health?.()?.[key] || 'ok'; }
  function loadFailedHtml(title, body) {
    return alertHtml('danger', title, body, '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-inv-retry>Try again</button>');
  }
  function loadingRowsHtml() {
    return `<div class="atlas-table-wrap" aria-busy="true" aria-label="Loading"><div class="inv-skeleton">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(6)}</div></div>`;
  }
  // Stock withheld by the shell (verified balances or movements failed to load):
  // no quantity is shown as if it were complete.
  function stockIncomplete() { return dataStatus().stock === 'partial'; }
  function missingStockText() {
    const missing = root.AtlasData?.health?.()?.stockMissing || [];
    const names = missing.map((key) => (key === 'balances' ? 'verified counts' : key === 'movements' ? 'movements' : null)).filter(Boolean);
    return names.length ? names.join(' and ') : 'stock data';
  }
  function itemById(id) { return items().find((item) => String(item.id) === String(id)) || null; }
  async function reloadData() {
    if (typeof root.atlasReloadData === 'function') await root.atlasReloadData();
    else if (typeof root.atlasReloadPurchasingData === 'function') { await root.atlasReloadPurchasingData(); shell.dataLoaded?.({}); }
  }

  // The pill for the canonical AtlasStockTruth.stockStatus. "Almost out" is
  // only a display tier of below par (at or under ALMOST_OUT_RATIO of par): it
  // counts as below par everywhere (filters, Home, Reports, Atlas AI).
  function stockStatus(item) {
    if (item.active === false) return { key: 'inactive', label: 'Inactive', tone: '', rank: 6 };
    const status = truth()?.stockStatus ? truth().stockStatus(item) : 'unknown';
    // Unknown with a reason: stock withheld because its inputs failed to load
    // is "Unknown", not the never-counted "Not counted".
    if (status === 'unknown' && truth()?.unknownReason?.(item) === 'stock_data_incomplete') return { key: 'unknown', label: 'Unknown', tone: '', rank: 4 };
    if (status === 'unknown') return { key: 'not_counted', label: 'Not counted', tone: '', rank: 4 };
    if (status === 'out') return { key: 'out', label: 'Out', tone: 'danger', rank: 0 };
    if (status === 'below_par') {
      if ((num(item.quantity) ?? 0) <= (num(item.par_level) ?? 0) * ALMOST_OUT_RATIO) return { key: 'almost_out', label: 'Almost out', tone: 'danger', rank: 1 };
      return { key: 'below_par', label: 'Below par', tone: 'warning', rank: 2 };
    }
    return { key: 'ok', label: 'In stock', tone: '', rank: 5 };
  }
  function statusPill(status) {
    if (!status.label) return '';
    // In stock is the normal state: quiet text, not a pill (review P3).
    if (status.key === 'ok') return `<span class="inv__muted">${esc(status.label)}</span>`;
    return `<span class="atlas-pill${status.tone ? ` atlas-pill--${status.tone}` : ''}">${esc(status.label)}</span>`;
  }
  function packLine(item) {
    const size = num(item.size_ml);
    const weight = num(item.package_weight_g);
    const pack = item.package_size || (size ? (size >= 1000 && size % 100 === 0 ? `${size / 1000} L` : `${size} ml`) : weight ? (weight >= 1000 && weight % 100 === 0 ? `${weight / 1000} kg` : `${weight} g`) : '');
    return [pack, item.bin_location].filter(Boolean).join(' · ');
  }
  function unitWord(item, quantity = null) {
    const unit = item.unit || 'units';
    if (num(quantity) !== 1) return unit;
    if (/^(boxes|glasses)$/i.test(unit)) return unit.slice(0, -2);
    return /^(bottles|cans|cases|bags|packs|jars|kegs|litres|units|cartons)$/i.test(unit) ? unit.slice(0, -1) : unit;
  }

  // Errors Inventory shows carry fixed copy only; a JavaScript error or server
  // text reads as the fallback (AtlasApi.message) and goes to the console.
  function fixedError(text, props = {}) {
    return root.AtlasApi?.fixed ? root.AtlasApi.fixed(text, props) : Object.assign(new Error(text), props, { atlasFixed: true });
  }
  function shown(error, fallback = 'That didn’t go through. Nothing was changed; try again.') {
    if (root.AtlasApi?.message) return root.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }

  async function session() {
    const client = root.atlasSupabase;
    const result = client?.auth ? await client.auth.getSession() : null;
    const token = result?.data?.session?.access_token;
    if (!token) throw fixedError('Sign in again to continue.', { code: 'unauthorized' });
    return token;
  }

  // atlas-item-master: create-item, activation, catalogue requests (managers).
  async function itemMaster(action, { method = 'POST', body = null, params = {} } = {}) {
    const base = String(root.VABAR_CONFIG?.ITEM_MASTER_API || '').trim();
    if (!base) throw fixedError('Item changes aren’t available right now.', { code: 'unavailable' });
    if (navigator.onLine === false) throw fixedError('You’re offline. Nothing was saved; reconnect and try again.', { code: 'offline' });
    const token = await session();
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    let response;
    try {
      response = await fetch(url, {
        method,
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify({ action, ...body }) : undefined
      });
    } catch (_) {
      throw fixedError('Atlas couldn’t reach the server. Nothing was saved; check your connection and try again.', { code: 'network' });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = payload.code || (response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : response.status >= 500 ? 'unavailable' : 'invalid_request');
      throw fixedError(ITEM_MASTER_ERRORS[code] || 'Atlas couldn’t save this right now. Nothing was changed; try again.', { code, status: response.status, duplicateCheck: payload.duplicate_check || null });
    }
    return payload;
  }

  // ---------------------------------------------------------------------------
  // Overlays: sheets and dialogs on modal.js
  // ---------------------------------------------------------------------------
  function openOverlay(panelHtml, { className = 'atlas-sheet atlas-sheet--wide', onClose, label } = {}) {
    const host = document.createElement('div');
    host.className = 'atlas-modal';
    host.dataset.atlasModal = '';
    host.hidden = true;
    host.innerHTML = `<section class="${className}" data-modal-panel role="dialog" aria-modal="true"${label ? ` aria-label="${esc(label)}"` : ''}>${panelHtml}</section>`;
    document.body.appendChild(host);
    root.AtlasModal.register(host, { onClose: (reason) => { onClose?.(reason); window.setTimeout(() => host.remove(), 0); } });
    root.AtlasModal.open(host);
    lucide();
    return { host, panel: host.firstElementChild, close: (reason) => root.AtlasModal.close(host, reason) };
  }

  function sheetHtml({ title, desc = '', body, foot = '' }) {
    return `<span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title">${esc(title)}</h2>${desc ? `<p class="atlas-sheet__desc">${esc(desc)}</p>` : ''}</div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <div class="atlas-sheet__body">${body}</div>${foot ? `<footer class="atlas-sheet__foot">${foot}</footer>` : ''}`;
  }

  function alertHtml(tone, title, body = '', action = '') {
    const glyph = tone === 'danger' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : tone === 'positive' ? 'circle-check' : 'info';
    return `<div class="atlas-alert atlas-alert--${tone}"${tone === 'danger' ? ' role="alert"' : ''}>${icon(glyph)}<div class="atlas-alert__content">${title ? `<p class="atlas-alert__title">${esc(title)}</p>` : ''}${body ? `<p class="atlas-alert__body">${esc(body)}</p>` : ''}</div>${action ? `<div class="atlas-alert__actions">${action}</div>` : ''}</div>`;
  }

  function busy(button, on, label) {
    if (!button) return;
    if (on) { button.dataset.label = button.innerHTML; button.disabled = true; button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true'); if (label) button.textContent = label; }
    else { button.disabled = false; button.classList.remove('is-loading'); button.removeAttribute('aria-busy'); if (button.dataset.label) button.innerHTML = button.dataset.label; }
  }

  // ---------------------------------------------------------------------------
  // Page frame
  // ---------------------------------------------------------------------------
  function rootEl() {
    let element = document.getElementById('inventory-view');
    if (!element) {
      element = document.createElement('div');
      element.id = 'inventory-view';
      document.getElementById('atlas-main')?.appendChild(element);
    }
    element.classList.add('inv');
    return element;
  }

  function activeTab() {
    if (state.view === 'movements') return 'movements';
    if (state.view === 'waste') return 'waste';
    if (state.params.section === 'stock-count') return 'counts';
    return 'items';
  }

  function lastCountedAt() {
    let latest = 0;
    items().forEach((item) => { const at = num(item.stock_baseline_at); if (at && at > latest) latest = at; });
    return latest || null;
  }

  function subtitle() {
    const active = items().filter((item) => item.active !== false);
    if (dataStatus().items === 'error' && !active.length) return 'Inventory couldn’t be loaded';
    if (dataStatus().items === 'loading' && !active.length) return 'Loading items…';
    const last = lastCountedAt();
    const count = `${active.length} active ${active.length === 1 ? 'item' : 'items'}`;
    if (stockIncomplete()) return `${count} · stock figures incomplete`;
    return last ? `${count} · counted ${dateText(last, { long: true })}` : `${count} · not counted yet`;
  }

  function headActions(tab = 'items') {
    const actions = [];
    const countPrimary = tab === 'counts' || !isManager();
    if (canCount()) actions.push({ label: 'Start stock count', icon: 'list-checks', variant: countPrimary ? 'primary' : 'secondary', attrs: { 'data-inv-count': '' } });
    if (isManager()) actions.push({ label: 'Add item', icon: 'plus', variant: tab === 'counts' ? 'secondary' : 'primary', attrs: { 'data-inv-add': '' } });
    return actions;
  }

  function tabsHtml(tab) {
    const tabs = [['items', 'Items', '#inventory'], ['counts', 'Counts', '#inventory/counts']];
    if (isManager()) tabs.push(['movements', 'Movements', '#inventory/movements'], ['waste', 'Waste', '#inventory/waste']);
    return `<nav class="atlas-tabs" aria-label="Inventory sections">${tabs.map(([key, label, href]) => `<a href="${href}"${key === tab ? ' aria-current="page"' : ''} data-inv-tab="${key}">${label}</a>`).join('')}</nav>`;
  }

  function render() {
    const element = rootEl();
    const tab = activeTab();
    if ((tab === 'movements' || tab === 'waste') && !isManager()) {
      element.innerHTML = `${shell.pageHead({ title: 'Inventory', sub: subtitle() })}${tabsHtml(tab)}<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon">${icon('lock')}</div><h3 class="atlas-empty__title">${tab === 'waste' ? 'Waste' : 'Movements'} is for managers</h3><p class="atlas-empty__text">Ask an administrator for access.</p><a class="atlas-btn atlas-btn--secondary" href="#inventory">Go to items</a></div>`;
      lucide();
      return;
    }
    const head = shell.pageHead({ title: 'Inventory', sub: subtitle(), actions: tab === 'items' || tab === 'counts' ? headActions(tab) : (tab === 'waste' && inputHealth('movements') !== 'failed' ? [{ label: 'Record waste', icon: 'trash-2', variant: 'primary', attrs: { 'data-inv-waste': '' } }] : []) });
    element.innerHTML = `${head}${tabsHtml(tab)}<div class="inv__body" data-inv-body></div>`;
    const body = element.querySelector('[data-inv-body]');
    if (tab === 'counts') renderCounts(body);
    else if (tab === 'movements') renderMovements(body);
    else if (tab === 'waste') renderWaste(body);
    else renderItems(body);
    state.rendered = true;
    lucide();
  }

  function renderCounts(body) {
    if (root.AtlasStockCounts?.renderList) {
      root.AtlasStockCounts.renderList(body, state.params);
      return;
    }
    body.innerHTML = alertHtml('warning', 'Stock count couldn’t be loaded.', 'Refresh the page to try again. Your counts are safe.');
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------
  // The owner's category model (S38 owner decisions): a primary group from the
  // stored category (authoritative over product-name words such as "Ginger
  // Beer" or "Four Roses"), then a contextual subcategory. Wine always offers
  // exactly Red, White, Rosé and Sparkling.
  const GROUPS = [
    ['spirits', 'Spirits'], ['wine', 'Wine'], ['beer', 'Beer'], ['mixers', 'Mixers'], ['syrups', 'Syrups'], ['bitters', 'Bitters'],
    ['fresh-fruit', 'Fresh fruit'], ['fresh-herbs', 'Fresh herbs'], ['garnish', 'Garnish'], ['bar-ingredients', 'Bar ingredients'],
    ['consumables', 'Consumables'], ['bar-equipment', 'Bar equipment'], ['coffee', 'Coffee'], ['other', 'Other']
  ];
  const WINE_TYPES = ['Red', 'White', 'Rosé', 'Sparkling'];
  const SPIRITS = /vodka|gin|whisk(?:e)?y|rum|tequila|mezcal|brandy|cognac|aquavit|brenniv[ií]n|liqueur|aperitif|vermouth|spirit|shot/;
  const BEERS = /beer|lager|ale|ipa|stout|cider|\bkeg\b|ready.to.drink|\brtd\b/;
  function inventoryGroup(item) {
    const category = String(item?.category || '').toLowerCase();
    const value = `${category} ${String(item?.name || '').toLowerCase()}`;
    if (/wine|champagne|prosecco|cava|sparkling|ros[eé]/.test(category)) return 'wine';
    if (/soda|mixer|juice|tonic|soft drink|energy drink/.test(category)) return 'mixers';
    if (SPIRITS.test(category)) return 'spirits';
    if (BEERS.test(category)) return 'beer';
    if (/bitters?/.test(value)) return 'bitters';
    if (/syrup/.test(value)) return 'syrups';
    if (/coffee|espresso|hot drink/.test(value)) return 'coffee';
    if (/glassware|equipment|tool|utensil/.test(value)) return 'bar-equipment';
    if (/cleaning|consumable|napkin|straw|receipt roll/.test(value)) return 'consumables';
    if (/herb|mint|basil|rosemary|thyme/.test(value)) return 'fresh-herbs';
    if (/garnish|olive|cherry|dehydrated|zest/.test(value)) return 'garnish';
    if (/fruit|lemon|lime|orange|grapefruit|berry/.test(value)) return 'fresh-fruit';
    if (/mixer|juice|tonic|soda|soft drink|energy drink|ginger beer/.test(value)) return 'mixers';
    if (SPIRITS.test(value)) return 'spirits';
    if (BEERS.test(value)) return 'beer';
    if (/ingredient|food|tapas|salt|sugar|cream|milk|egg/.test(value)) return 'bar-ingredients';
    return 'other';
  }
  function inventorySubcategory(item, group = inventoryGroup(item)) {
    const stored = String(item?.subcategory || '').trim();
    const category = String(item?.category || '').toLowerCase();
    const name = String(item?.name || '').toLowerCase();
    const value = `${stored} ${category} ${name} ${item?.unit || ''}`.toLowerCase();
    if (group === 'wine') {
      const categoryValue = `${stored} ${category}`.toLowerCase();
      if (/champagne|sparkling|prosecco|cava|cr[eé]mant|franciacorta/.test(categoryValue)) return 'Sparkling';
      if (/ros[eé]/.test(categoryValue)) return 'Rosé';
      if (/red wine|\bred\b/.test(categoryValue)) return 'Red';
      if (/white wine|\bwhite\b/.test(categoryValue)) return 'White';
      if (/champagne|sparkling|prosecco|cava|cr[eé]mant|franciacorta/.test(name)) return 'Sparkling';
      if (/ros[eé]/.test(name)) return 'Rosé';
      return 'White';
    }
    if (group === 'spirits') {
      if (/whisk(?:e)?y|bourbon|scotch|rye/.test(value)) return 'Whiskey';
      if (/gin/.test(value)) return 'Gin';
      if (/vodka/.test(value)) return 'Vodka';
      if (/rum/.test(value)) return 'Rum';
      if (/tequila|mezcal/.test(value)) return 'Tequila and mezcal';
      if (/brandy|cognac/.test(value)) return 'Brandy and cognac';
      if (/aquavit|brenniv[ií]n/.test(value)) return 'Aquavit';
      if (/shot/.test(value)) return 'Shots';
      return 'Liqueurs and aperitifs';
    }
    if (group === 'beer') {
      if (/\bkeg|30l|20l|50l/.test(value)) return 'Kegs';
      if (/cider/.test(name) || (/cider/.test(category) && !/beer/.test(category))) return 'Cider';
      if (/ready.to.drink|\brtd\b|breezer/.test(value)) return 'Ready to drink';
      return 'Bottles';
    }
    if (stored) return stored.replace(/[_-]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
    return String(item?.category || 'Other').trim() || 'Other';
  }
  const groupLabel = (key) => (GROUPS.find(([value]) => value === key) || [key, key])[1];
  function groupCounts() {
    const counts = new Map();
    items().filter((item) => item.active !== false).forEach((item) => { const group = inventoryGroup(item); counts.set(group, (counts.get(group) || 0) + 1); });
    return GROUPS.filter(([key]) => counts.has(key)).map(([key, label]) => [key, label, counts.get(key)]);
  }
  function subcategoryCounts(group) {
    const counts = new Map(group === 'wine' ? WINE_TYPES.map((label) => [label, 0]) : []);
    items().filter((item) => item.active !== false && inventoryGroup(item) === group).forEach((item) => {
      const label = inventorySubcategory(item, group);
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    const list = [...counts];
    return group === 'wine' ? list : list.sort((a, b) => a[0].localeCompare(b[0]));
  }

  function filtered() {
    const query = state.query.trim().toLowerCase();
    return items().filter((item) => {
      if (state.activity === 'active' && item.active === false) return false;
      if (state.activity === 'inactive' && item.active !== false) return false;
      if (state.category && inventoryGroup(item) !== state.category) return false;
      if (state.category && state.subcategory && inventorySubcategory(item) !== state.subcategory) return false;
      if (state.supplier && String(item.supplier || '') !== state.supplier) return false;
      if (state.location && String(item.bin_location || '') !== state.location) return false;
      if (state.status) {
        const status = stockStatus(item).key;
        if (state.status === 'below-par' && truth()?.stockStatus?.(item) !== 'below_par') return false;
        if (state.status === 'not-counted' && status !== 'not_counted') return false;
        if (state.status === 'out' && !['out', 'almost_out'].includes(status)) return false;
      }
      if (!query) return true;
      return [item.name, item.category, item.subcategory, item.supplier, item.sku, item.barcode, item.brand, item.bin_location, item.supplier_product_reference]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }

  function sorted(list) {
    const { key, dir } = state.sort;
    const factor = dir === 'desc' ? -1 : 1;
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' });
    const value = (item) => {
      if (key === 'onhand') return truth()?.known(item) ? num(item.quantity) : null;
      if (key === 'par') return num(item.par_level);
      if (key === 'cost') return num(item.cost_price);
      if (key === 'counted') return num(item.stock_baseline_at);
      if (key === 'status') return stockStatus(item).rank;
      return null;
    };
    return [...list].sort((a, b) => {
      if (key === 'name') return factor * byName(a, b);
      const left = value(a);
      const right = value(b);
      if (left === right) return byName(a, b);
      if (left === null) return 1;
      if (right === null) return -1;
      return factor * (left - right) || byName(a, b);
    });
  }

  function distinct(field) {
    const counts = new Map();
    items().filter((item) => item.active !== false).forEach((item) => {
      const value = String(item[field] || '').trim();
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    });
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }

  const STATUS_FILTERS = [['below-par', 'Below par'], ['out', 'Out or almost out'], ['not-counted', 'Not counted']];

  function chip(label, { active = false, menu = null, clear = null, dashed = false, iconName = null } = {}) {
    if (active) return `<button type="button" class="atlas-chip is-active" data-inv-clear="${esc(clear)}" aria-label="${esc(label)}. Clear this filter">${esc(label)}<span class="atlas-chip__clear" aria-hidden="true">${icon('x')}</span></button>`;
    return `<button type="button" class="atlas-chip${dashed ? ' atlas-chip--dashed' : ''}" data-inv-menu-trigger="${esc(menu)}">${iconName ? icon(iconName) : ''}${esc(label)}${dashed ? '' : icon('chevron-down')}</button>`;
  }

  function menuHtml(name, entries) {
    return `<ul class="atlas-menu" data-inv-menu="${esc(name)}" hidden>${entries.map((entry) => entry === '-' ? '<li role="separator" class="atlas-menu__sep"></li>'
      : `<li><button type="button" class="atlas-menu__item" data-filter="${esc(entry[0])}" data-value="${esc(entry[1])}">${esc(entry[2])}</button></li>`).join('')}</ul>`;
  }

  function toolbarHtml(count, total) {
    const chips = [];
    const statusLabel = STATUS_FILTERS.find(([value]) => value === state.status)?.[1];
    chips.push(state.status ? chip(statusLabel, { active: true, clear: 'status' }) : chip('Status', { menu: 'status' }));
    chips.push(state.category ? chip(groupLabel(state.category), { active: true, clear: 'category' }) : chip('Category', { menu: 'category' }));
    if (state.category) chips.push(state.subcategory ? chip(state.subcategory, { active: true, clear: 'subcategory' }) : chip('Type', { menu: 'subcategory' }));
    if (isManager()) chips.push(state.supplier ? chip(state.supplier, { active: true, clear: 'supplier' }) : chip('Supplier', { menu: 'supplier' }));
    if (state.location) chips.push(chip(state.location, { active: true, clear: 'location' }));
    if (state.activity !== 'active') chips.push(chip(state.activity === 'inactive' ? 'Inactive items' : 'All items', { active: true, clear: 'activity' }));
    chips.push(chip('More filters', { menu: 'more', dashed: true, iconName: 'list-filter' }));
    const menus = [
      menuHtml('status', STATUS_FILTERS.map(([value, label]) => ['status', value, label])),
      menuHtml('category', groupCounts().map(([value, label, n]) => ['category', value, `${label} · ${n}`])),
      state.category ? menuHtml('subcategory', subcategoryCounts(state.category).map(([value, n]) => ['subcategory', value, `${value} · ${n}`])) : '',
      isManager() ? menuHtml('supplier', distinct('supplier').map(([value, n]) => ['supplier', value, `${value} · ${n}`])) : '',
      menuHtml('more', [
        ...distinct('bin_location').slice(0, 12).map(([value]) => ['location', value, `Location: ${value}`]),
        ...(distinct('bin_location').length ? ['-'] : []),
        ['activity', 'active', 'Active items'], ['activity', 'inactive', 'Inactive items'], ['activity', 'all', 'All items']
      ]),
      menuHtml('tools', [
        ['tool', 'identify', 'Identify item'],
        ...(isManager() ? [['tool', 'scan-product', 'Add product by camera'], ['tool', 'export', 'Download as CSV']] : [])
      ])
    ].join('');
    return `<div class="inv__filters"><label class="atlas-search inv__search">${icon('search')}<input class="atlas-input" type="search" data-inv-search placeholder="Search items, suppliers or codes" aria-label="Search items, suppliers or codes" value="${esc(state.query)}" autocomplete="off"></label>
      <div class="atlas-toolbar inv__toolbar">
      ${chips.join('')}
      <div class="atlas-toolbar__end"><span data-inv-count>${count === total ? `${total} ${total === 1 ? 'item' : 'items'}` : `${count} of ${total} items`}</span>
      <button type="button" class="atlas-icon-btn" data-inv-menu-trigger="tools" aria-label="More inventory actions">${icon('ellipsis')}</button></div>
    </div></div>${menus}`;
  }

  function neverCounted() {
    const active = items().filter((item) => item.active !== false);
    return active.length > 0 && !active.some((item) => truth()?.known(item));
  }

  function thSort(key, label, extra = '') {
    const sortedHere = state.sort.key === key;
    const aria = sortedHere ? ` aria-sort="${state.sort.dir === 'desc' ? 'descending' : 'ascending'}"` : '';
    return `<th${aria}${extra}><button type="button" class="atlas-th-sort" data-inv-sort="${key}">${esc(label)}${icon('chevron-down')}</button></th>`;
  }

  function parBar(item, status) {
    const par = num(item.par_level);
    if (!par || !truth()?.known(item)) return '';
    const ratio = Math.max(0, Math.min(1, (num(item.quantity) || 0) / par));
    const tone = status.tone === 'danger' ? ' atlas-par--danger' : status.tone === 'warning' ? ' atlas-par--warning' : '';
    return `<span class="atlas-par${tone}" aria-hidden="true"><i style="width:${Math.round(ratio * 100)}%"></i></span>`;
  }

  function rowHtml(item) {
    const status = stockStatus(item);
    const known = truth()?.known(item);
    const selected = state.selected.has(String(item.id));
    const manager = isManager();
    const counted = num(item.stock_baseline_at);
    const onHand = known ? `${qty(item.quantity)}${parBar(item, status)}` : '<span class="inv__muted" title="No verified count yet">—</span>';
    return `<tr data-inv-row="${esc(item.id)}"${selected ? ' class="is-selected"' : ''}>
      ${manager ? `<td class="col-check"><input type="checkbox" class="atlas-check" data-inv-select="${esc(item.id)}" aria-label="Select ${esc(item.name)}"${selected ? ' checked' : ''}></td>` : ''}
      <td class="inv-col--name"><a class="inv__item-link" href="#inventory/item/${encodeURIComponent(item.id)}" data-inv-open="${esc(item.id)}" title="${esc(item.name)}"><span class="cell-primary inv__clip">${esc(item.name)}</span><span class="cell-sub inv__clip">${esc([unitWord(item), packLine(item)].filter(Boolean).join(' · '))}${known && item.stock_recount_due ? ' · recount due' : ''}</span></a></td>
      <td class="inv-col--text" data-priority="3"><span class="inv__clip" title="${esc(item.category || '')}">${esc(item.category || '—')}</span></td>
      ${manager ? `<td class="inv-col--text" data-priority="2"><span class="inv__clip" title="${esc(item.supplier || '')}">${esc(item.supplier || '—')}</span></td>` : ''}
      <td class="is-num">${onHand}</td>
      <td class="is-num" data-priority="2">${num(item.par_level) ? qty(item.par_level) : '—'}</td>
      <td class="inv-col--status">${statusPill(status)}</td>
      ${manager ? `<td class="is-num" data-priority="2">${money(item.cost_price)}</td>` : ''}
      <td data-priority="3">${counted ? esc(dateText(counted)) : '—'}</td>
      <td class="col-actions"><button type="button" class="atlas-icon-btn row-action" data-inv-row-menu="${esc(item.id)}" aria-label="Actions for ${esc(item.name)}">${icon('ellipsis')}</button></td>
    </tr>`;
  }

  function listRowHtml(item) {
    const status = stockStatus(item);
    const known = truth()?.known(item);
    const par = num(item.par_level);
    const meta = [item.category, isManager() ? item.supplier : null, item.bin_location].filter(Boolean).join(' · ') || unitWord(item);
    const value = known ? `<span class="num">${qty(item.quantity)}</span>${par ? `<span class="inv__par"> / ${qty(par)}</span>` : ''}` : '<span class="inv__muted">—</span>';
    return `<li><a class="atlas-table-list__row" href="#inventory/item/${encodeURIComponent(item.id)}" data-inv-open="${esc(item.id)}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(item.name)}</div><div class="atlas-table-list__meta">${esc(meta)}</div></div><div class="atlas-table-list__value">${value}${status.label && status.key !== 'ok' ? `<br>${statusPill(status)}` : ''}</div></a></li>`;
  }

  function emptyItemsHtml(total) {
    if (!items().length) {
      if (dataStatus().items === 'error') return '';
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('package')}</div><h3 class="atlas-empty__title">No items yet</h3><p class="atlas-empty__text">Items you add appear here, ready to count and order.</p>${isManager() ? `<div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-inv-add>${icon('plus')}Add item</button><a class="atlas-btn atlas-btn--ghost" href="#data">Import a file</a></div>` : ''}</div>`;
    }
    const what = state.query ? `“${state.query}”` : 'these filters';
    return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('search-x')}</div><h3 class="atlas-empty__title">No items match ${esc(what)}</h3><p class="atlas-empty__text">${total} ${total === 1 ? 'item is' : 'items are'} hidden by the search or filters.</p><button type="button" class="atlas-btn atlas-btn--secondary" data-inv-clear-all>Clear filters</button></div>`;
  }

  function renderItems(body) {
    const all = items();
    const scopeTotal = all.filter((item) => state.activity === 'all' || (state.activity === 'inactive' ? item.active === false : item.active !== false)).length;
    const visible = sorted(filtered());
    const manager = isManager();
    // Selection only holds visible rows.
    const visibleIds = new Set(visible.map((item) => String(item.id)));
    [...state.selected].forEach((id) => { if (!visibleIds.has(id)) state.selected.delete(id); });

    // Loading and failed loads are never shown as an empty inventory: no
    // "0 items", no "No items yet" (S90, review P1-3).
    if (!all.length && dataStatus().items === 'loading') { body.innerHTML = loadingRowsHtml(); return; }
    if (!all.length && dataStatus().items === 'error') {
      body.innerHTML = loadFailedHtml('Inventory couldn’t be loaded.', 'Nothing was changed and your items are safe. Check your connection and try again.');
      return;
    }
    const alerts = [];
    if (dataStatus().items === 'error') {
      alerts.push(alertHtml('danger', 'Inventory couldn’t be loaded.', all.length ? `Showing the items loaded ${state.lastLoadedAt ? `at ${clock()?.formatTime?.(state.lastLoadedAt) || ''}` : 'earlier'}. Nothing was changed.` : 'Nothing was changed. Check your connection and try again.', '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-inv-retry>Try again</button>'));
    } else if (stockIncomplete()) {
      alerts.push(alertHtml('warning', `Stock figures are incomplete — ${missingStockText()} couldn’t load. Try again.`, 'No stock numbers are shown until everything loads. Nothing was changed.', '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-inv-retry>Try again</button>'));
    } else if (neverCounted()) {
      alerts.push(alertHtml('info', 'Stock hasn’t been counted yet.', 'Quantities appear after the first verified count.', canCount() ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-inv-count>Start stock count</button>' : ''));
    }
    const bulk = manager && state.selected.size ? `<div class="atlas-bulkbar" role="region" aria-label="Selected items"><span>${state.selected.size} selected</span><span class="atlas-bulkbar__sep"></span>
      <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-inv-bulk="order">${icon('truck')}Add to order</button>
      <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-inv-bulk="count">${icon('list-checks')}Count these</button>
      <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm inv__bulk-clear" data-inv-bulk="clear">Clear</button></div>` : '';
    const allChecked = visible.length && visible.every((item) => state.selected.has(String(item.id)));
    const someChecked = !allChecked && visible.some((item) => state.selected.has(String(item.id)));
    const table = `<div class="atlas-table-wrap atlas-table-wrap--responsive inv__table"><table class="atlas-table">
      <thead><tr>
        ${manager ? `<th class="col-check"><input type="checkbox" class="atlas-check" data-inv-select-all aria-label="Select all shown items"${allChecked ? ' checked' : ''}${someChecked ? ' data-indeterminate' : ''}></th>` : ''}
        ${thSort('name', 'Item', ' class="inv-col--name"')}
        <th class="inv-col--category" data-priority="3">Category</th>
        ${manager ? '<th class="inv-col--supplier" data-priority="2">Supplier</th>' : ''}
        ${thSort('onhand', 'On hand', ' class="is-num inv-col--qty"')}
        ${thSort('par', 'Par', ' class="is-num inv-col--par" data-priority="2"')}
        ${thSort('status', 'Status', ' class="inv-col--status"')}
        ${manager ? thSort('cost', 'Unit cost', ' class="is-num inv-col--cost" data-priority="2"') : ''}
        ${thSort('counted', 'Counted', ' class="inv-col--date" data-priority="3"')}
        <th class="col-actions"><span class="sr-only">Actions</span></th>
      </tr></thead>
      <tbody>${visible.map(rowHtml).join('')}</tbody></table>
      ${visible.length ? '' : emptyItemsHtml(scopeTotal)}</div>`;
    const list = `<ul class="atlas-table-list inv__list" aria-label="Items">${visible.map(listRowHtml).join('')}</ul>${visible.length ? '' : `<div class="inv__list-empty">${emptyItemsHtml(scopeTotal)}</div>`}`;
    const foot = `<div class="atlas-table-foot"><span>${state.status === 'below-par' ? `Showing ${visible.length} below-par ${visible.length === 1 ? 'item' : 'items'}` : `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`}</span><span>Quantities are from the last verified count plus recorded movements.</span></div>`;
    body.innerHTML = `${alerts.join('')}${bulk || toolbarHtml(visible.length, scopeTotal)}${table}${list}${foot}`;
    const selectAll = body.querySelector('[data-inv-select-all]');
    if (selectAll && selectAll.hasAttribute('data-indeterminate')) selectAll.indeterminate = true;
    bindMenus(body);
  }

  // Filter and tool menus: every trigger/menu pair in the page, bound once per render.
  function bindMenus(scope) {
    scope.querySelectorAll('[data-inv-menu-trigger]').forEach((trigger) => {
      const menu = scope.querySelector(`[data-inv-menu="${CSS.escape(trigger.dataset.invMenuTrigger)}"]`) || document.querySelector(`[data-inv-menu="${CSS.escape(trigger.dataset.invMenuTrigger)}"]`);
      if (!menu) return;
      shell.menu(trigger, menu, { align: 'start', onSelect: (item) => applyMenuChoice(item.dataset.filter, item.dataset.value) });
    });
  }

  function applyMenuChoice(filter, value) {
    if (filter === 'tool') { runTool(value); return; }
    if (filter === 'movementType') { state.movementType = value; render(); return; }
    if (filter === 'status') state.status = value;
    else if (filter === 'category') { state.category = value; state.subcategory = null; }
    else if (filter === 'subcategory') state.subcategory = value;
    else if (filter === 'supplier') state.supplier = value;
    else if (filter === 'location') state.location = value;
    else if (filter === 'activity') state.activity = value;
    state.selected.clear();
    syncFilterRoute();
    renderItemsOnly();
  }

  function runTool(value) {
    if (value === 'identify') openIdentify();
    else if (value === 'scan-product') openAddProductByCamera();
    else if (value === 'export') exportCsv();
  }

  function renderItemsOnly() {
    const body = rootEl().querySelector('[data-inv-body]');
    if (!body || activeTab() !== 'items') { render(); return; }
    const focusSearch = document.activeElement?.matches?.('[data-inv-search]');
    const caret = focusSearch ? document.activeElement.selectionStart : null;
    renderItems(body);
    lucide();
    if (focusSearch) {
      const input = body.querySelector('[data-inv-search]');
      input?.focus();
      if (input && caret != null) input.setSelectionRange(caret, caret);
    }
  }

  // Filters are part of the route: #inventory?filter=below-par links reopen them.
  function syncFilterRoute() {
    if (state.view !== 'inventory' || state.params.section || state.params.item) return;
    const target = state.status ? `#inventory?filter=${encodeURIComponent(state.status)}` : '#inventory';
    if (location.hash !== target) {
      try { history.replaceState(history.state, '', target); } catch (_) { /* address bar is a convenience */ }
    }
  }

  function exportCsv() {
    const rows = sorted(filtered());
    const header = ['Item', 'Category', 'Supplier', 'On hand', 'Unit', 'Par', 'Status', 'Unit cost', 'Counted'];
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((item) => {
      const known = truth()?.known(item);
      const status = stockStatus(item);
      return [item.name, item.category, item.supplier, known ? item.quantity : '', item.unit, item.par_level ?? '', status.label || 'OK', item.cost_price ?? '', item.stock_baseline_at ? dateText(item.stock_baseline_at) : 'Not counted'].map(cell).join(',');
    });
    const blob = new Blob([[header.map(cell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `atlas-inventory-${clock()?.today?.() || 'export'}.csv`;
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 0);
  }

  // One row menu, filled for the row whose … was pressed.
  function openRowMenu(trigger, id) {
    const item = itemById(id);
    if (!item) return;
    let menu = document.getElementById('inv-row-menu');
    if (!menu) {
      menu = document.createElement('ul');
      menu.id = 'inv-row-menu';
      menu.className = 'atlas-menu';
      menu.hidden = true;
      document.body.appendChild(menu);
    }
    const entries = [['open', 'panel-right-open', 'Open item']];
    if (canCount() && item.active !== false) entries.push(['count', 'list-checks', `Count ${item.name}`]);
    if (isManager() && item.active !== false) entries.push(['order', 'truck', 'Add to an order'], ['waste', 'trash-2', 'Record waste']);
    entries.push(['ask', 'sparkles', 'Ask Atlas about this']);
    if (isManager()) entries.push('-', item.active === false ? ['reactivate', 'rotate-ccw', 'Reactivate'] : ['deactivate', 'archive', 'Deactivate']);
    menu.innerHTML = entries.map((entry) => entry === '-' ? '<li role="separator" class="atlas-menu__sep"></li>'
      : `<li><button type="button" class="atlas-menu__item${entry[0] === 'deactivate' ? ' atlas-menu__item--danger' : ''}" data-row-action="${entry[0]}">${icon(entry[1])}${esc(entry[2])}</button></li>`).join('');
    lucide();
    const handle = shell.menu(trigger, menu, { onSelect: (button) => runRecordAction(button.dataset.rowAction, item) });
    handle?.open();
  }

  function runRecordAction(action, item) {
    if (!item) return;
    if (action === 'open') openItem(item.id, true);
    else if (action === 'count') countItem(item.id);
    else if (action === 'order') shell.actions.run('purchasing.order.new', { record: { type: 'inventory_item', id: item.id, label: item.name } });
    else if (action === 'waste') openWasteDialog(item.id);
    else if (action === 'ask') askAbout(item);
    else if (action === 'deactivate') openActivation(item, false);
    else if (action === 'reactivate') openActivation(item, true);
    else if (action === 'edit') openEditSheet(item);
  }

  function askAbout(item) {
    const record = { type: 'inventory_item', id: item.id, label: item.name };
    if (root.AtlasAI?.askAbout) root.AtlasAI.askAbout(record);
    else shell.actions.run('ai.ask.record', { record }).catch(() => {});
  }

  function countItem(itemId) {
    const counts = root.AtlasStockCounts;
    if (counts?.openForItem) counts.openForItem(itemId);
    else shell.navigate('#inventory/counts');
  }

  // ---------------------------------------------------------------------------
  // Item detail (#inventory/item/<id>)
  // ---------------------------------------------------------------------------
  let detail = null;

  function recipesUsing(item) {
    return recipes().filter((recipe) => (recipe.recipe_ingredients || recipe.ingredients || []).some((ingredient) => String(ingredient.item_id) === String(item.id)));
  }

  function detailHtml(item) {
    const status = stockStatus(item);
    const known = truth()?.known(item);
    const manager = isManager();
    const used = recipesUsing(item);
    const history = movements().filter((entry) => String(entry.item_id) === String(item.id)).slice(0, 10);
    const counts = history.filter((entry) => entry.movement_type === 'count');
    const facts = [
      ['On hand', known ? `${qty(item.quantity)} ${unitWord(item, item.quantity)}` : truth()?.unknownReason?.(item) === 'stock_data_incomplete' ? 'Unknown (stock figures incomplete)' : 'Not counted'],
      ['Par', num(item.par_level) ? `${qty(item.par_level)} ${unitWord(item, item.par_level)}` : 'Not set'],
      ['Location', item.bin_location || 'Not set'],
      manager ? ['Supplier', item.supplier || 'Not set'] : null,
      manager ? ['Unit cost', num(item.cost_price) !== null ? money(item.cost_price) : 'Not set'] : null,
      ['Pack', [packLine({ ...item, bin_location: null }), num(item.units_per_case) ? `${qty(item.units_per_case)} per case` : ''].filter(Boolean).join(' · ') || 'Not set'],
      ['Last counted', num(item.stock_baseline_at) ? dateText(item.stock_baseline_at, { long: true }) : 'Never'],
      ['Category', item.category || 'Not set']
    ].filter(Boolean);
    const codes = [['Barcode', item.barcode], ['SKU', item.sku], manager ? ['Supplier number', item.supplier_product_reference] : null].filter((entry) => entry && entry[1]);
    const recipeChips = used.length
      ? `<div class="inv-detail__chips">${used.slice(0, 6).map((recipe) => `<a class="atlas-record-chip inv-record-chip" href="#recipes/${encodeURIComponent(recipe.id)}">${icon('martini')}${esc(recipe.name)}</a>`).join('')}${used.length > 6 ? `<span class="inv__muted">+${used.length - 6} more</span>` : ''}</div>`
      : '<p class="inv__muted">Not used in any recipe.</p>';
    const historyRows = history.length
      ? `<ul class="atlas-list inv-detail__history">${history.map((entry) => {
        const change = num(entry.quantity_change) || 0;
        const [label] = MOVEMENT_TYPES[entry.movement_type] || [String(entry.movement_type || 'Change').replace(/_/g, ' ')];
        return `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${esc(label)}</p><p class="atlas-row__meta">${esc(dateTimeText(entry.created_at))}${entry.note ? ` · ${esc(entry.note)}` : ''}</p></div><div class="atlas-row__end"><span class="atlas-row__value num">${change > 0 ? '+' : ''}${qty(change)}</span></div></li>`;
      }).join('')}</ul>`
      : '<p class="inv__muted">No recorded movements yet.</p>';
    return `<span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="inv-detail-title">${esc(item.name)}</h2><p class="atlas-sheet__desc">${esc([item.category, packLine(item)].filter(Boolean).join(' · ') || unitWord(item))}</p><div class="inv-detail__pills">${statusPill(status)}${known && item.stock_recount_due ? '<span class="atlas-pill atlas-pill--warning">Recount due</span>' : ''}</div></div>
        <button type="button" class="atlas-icon-btn" data-inv-detail-menu aria-label="More actions for ${esc(item.name)}">${icon('ellipsis')}</button>
        <button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <div class="atlas-sheet__body">
        <div class="inv-detail__hero"><p class="inv-detail__figure num">${known ? esc(qty(item.quantity)) : '—'}<span class="inv-detail__unit">${known ? esc(unitWord(item, item.quantity)) : truth()?.unknownReason?.(item) === 'stock_data_incomplete' ? 'Unknown' : 'Not counted'}</span></p><p class="inv-detail__hint">${known ? `Last verified count plus recorded movements${num(item.par_level) ? ` · par ${qty(item.par_level)}` : ''}.` : truth()?.unknownReason?.(item) === 'stock_data_incomplete' ? `Stock figures are incomplete — ${esc(missingStockText())} couldn’t load. Try again.` : 'Quantities appear after the first verified count.'}</p></div>
        <dl class="inv-detail__facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
        ${manager && num(item.par_level) !== null ? '<p class="inv__muted inv-detail__note">Par levels are changed in <a href="#data/pars">Data › Par levels</a>.</p>' : manager ? '<p class="inv__muted inv-detail__note">Set a par level in <a href="#data/pars">Data › Par levels</a>.</p>' : ''}
        <section class="inv-detail__section" data-inv-detail-recipes><h3 class="inv-detail__heading">Used in</h3>${recipeChips}</section>
        <section class="inv-detail__section"><h3 class="inv-detail__heading">Codes</h3>${codes.length ? `<dl class="inv-detail__facts inv-detail__facts--codes">${codes.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd class="inv-code">${esc(value)}</dd></div>`).join('')}</dl>` : '<p class="inv__muted">No barcode or SKU saved.</p>'}
          ${item.active !== false && canCount() ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-inv-add-code>${icon('scan-barcode')}${manager ? 'Add a barcode' : 'Suggest a barcode'}</button>` : ''}</section>
        <section class="inv-detail__section"><h3 class="inv-detail__heading">Recent movements</h3>${historyRows}</section>
        ${counts.length ? `<section class="inv-detail__section"><h3 class="inv-detail__heading">Counts</h3><ul class="inv-detail__counts">${counts.slice(0, 5).map((entry) => `<li><span>${esc(dateText(entry.created_at))}</span><span class="num">${num(entry.quantity_change) > 0 ? '+' : ''}${qty(entry.quantity_change)}</span></li>`).join('')}</ul></section>` : ''}
        ${item.active === false ? alertHtml('info', 'This item is inactive.', 'It’s kept for history and left out of counts and orders.', manager ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-inv-reactivate>Reactivate</button>' : '') : ''}
      </div>
      <footer class="atlas-sheet__foot">
        <button type="button" class="atlas-btn atlas-btn--ghost" data-inv-ask>${icon('sparkles')}Ask Atlas</button>
        ${canCount() && item.active !== false ? `<button type="button" class="atlas-btn atlas-btn--${manager ? 'secondary' : 'primary'}" data-inv-count-item>${icon('list-checks')}Count this</button>` : ''}
        ${manager ? '<button type="button" class="atlas-btn atlas-btn--primary" data-inv-edit>Edit details</button>' : ''}
      </footer>
      <ul class="atlas-menu" data-inv-detail-menu-list hidden>
        ${manager ? '<li><button type="button" class="atlas-menu__item" data-row-action="edit">Edit details</button></li>' : ''}
        ${manager && item.active !== false ? '<li><button type="button" class="atlas-menu__item" data-row-action="order">Add to an order</button></li><li><button type="button" class="atlas-menu__item" data-row-action="waste">Record waste</button></li>' : ''}
        <li><button type="button" class="atlas-menu__item" data-row-action="ask">Ask Atlas about this</button></li>
        ${manager ? `<li role="separator" class="atlas-menu__sep"></li><li><button type="button" class="atlas-menu__item${item.active === false ? '' : ' atlas-menu__item--danger'}" data-row-action="${item.active === false ? 'reactivate' : 'deactivate'}">${item.active === false ? 'Reactivate' : 'Deactivate'}</button></li>` : ''}
      </ul>`;
  }

  function openItem(id, fromList = false) {
    const target = `#inventory/item/${encodeURIComponent(id)}`;
    state.detailFromList = fromList;
    if (location.hash !== target) shell.navigate(target);
    else showDetail(id);
  }

  function showDetail(id, focusSection) {
    const item = itemById(id);
    if (detail && detail.id === String(id) && document.body.contains(detail.overlay.host)) {
      detail.overlay.panel.innerHTML = item ? detailHtml(item) : '';
      bindDetail(item);
      return;
    }
    if (detail) { const previous = detail; detail = null; previous.overlay.close('replace'); }
    if (!item) {
      if (!items().length) return; // data not loaded yet: data:loaded reopens it
      toast('That item isn’t in Atlas any more.');
      shell.navigate('#inventory');
      return;
    }
    const overlay = openOverlay(detailHtml(item), {
      className: 'atlas-sheet atlas-sheet--wide inv-detail',
      onClose: (reason) => {
        if (detail?.overlay !== overlay) return;
        detail = null;
        state.detailId = null;
        if (reason === 'replace' || reason === 'navigate') return;
        // The list re-renders on the way back; focus the row that opened the item.
        state.returnFocusId = String(item.id);
        if (/^#inventory\/item\//.test(location.hash)) {
          if (state.detailFromList && history.length > 1) history.back();
          // Closing a sheet opened from a link replaces its address, so Back
          // doesn't reopen it.
          else shell.navigate('#inventory', { replace: true });
        }
      }
    });
    overlay.panel.setAttribute('aria-labelledby', 'inv-detail-title');
    detail = { id: String(id), overlay };
    state.detailId = String(id);
    bindDetail(item);
    if (focusSection === 'recipes') overlay.panel.querySelector('[data-inv-detail-recipes]')?.scrollIntoView({ block: 'start' });
  }

  function bindDetail(item) {
    if (!detail || !item) return;
    const panel = detail.overlay.panel;
    lucide();
    const trigger = panel.querySelector('[data-inv-detail-menu]');
    const menu = panel.querySelector('[data-inv-detail-menu-list]');
    if (trigger && menu) shell.menu(trigger, menu, { onSelect: (button) => runRecordAction(button.dataset.rowAction, item) });
    panel.querySelector('[data-inv-ask]')?.addEventListener('click', () => askAbout(item));
    panel.querySelector('[data-inv-count-item]')?.addEventListener('click', () => { closeDetail(); countItem(item.id); });
    panel.querySelector('[data-inv-edit]')?.addEventListener('click', () => openEditSheet(item));
    panel.querySelector('[data-inv-reactivate]')?.addEventListener('click', () => openActivation(item, true));
    panel.querySelector('[data-inv-add-code]')?.addEventListener('click', () => openAddCode(item));
  }

  function closeDetail() {
    if (!detail) return;
    const current = detail;
    detail = null;
    state.detailId = null;
    current.overlay.close('navigate');
  }

  // ---------------------------------------------------------------------------
  // Activation (atlas-item-master set_item_active with the dependency check)
  // ---------------------------------------------------------------------------
  const BLOCKER_COPY = {
    open_purchase_order: (deps) => `It’s on ${deps.open_orders?.total || 'an'} open purchase ${deps.open_orders?.total === 1 ? 'order' : 'orders'}. Receive or cancel ${deps.open_orders?.total === 1 ? 'it' : 'them'} first.`,
    active_duplicate_name: (deps) => `Another active item is called ${deps.active_duplicate_name?.name || 'the same'}. Rename one of them first.`
  };
  const WARNING_COPY = {
    supplier_inactive: (deps) => `Its supplier${deps.supplier?.name ? `, ${deps.supplier.name},` : ''} is inactive.`,
    stock_needs_count: () => 'Its stock needs a count before it’s used again.',
    used_by_active_recipes: (deps) => `It’s used by ${deps.recipes?.active || deps.recipes?.total || ''} active ${deps.recipes?.active === 1 ? 'recipe' : 'recipes'}${deps.recipes?.names?.length ? `: ${deps.recipes.names.slice(0, 5).join(', ')}` : ''}. Those recipes will show it as unavailable.`
  };

  function openActivation(item, activate) {
    if (!isManager()) { toast('Changing items is for managers.', { icon: false }); return; }
    const title = activate ? `Reactivate ${item.name}?` : `Deactivate ${item.name}?`;
    const overlay = openOverlay(`<h2 class="atlas-dialog__title">${esc(title)}</h2>
      <div class="atlas-dialog__body" data-activation-body><div class="atlas-stack atlas-stack--sm" aria-hidden="true"><span class="atlas-skel"></span><span class="atlas-skel" style="width:70%"></span></div><p class="sr-only" role="status">Checking what depends on this item…</p></div>
      <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn ${activate ? 'atlas-btn--primary' : 'atlas-btn--danger-solid'}" data-activation-confirm disabled>${activate ? 'Reactivate' : 'Deactivate'}</button></div>`, { className: 'atlas-dialog atlas-dialog--form' });
    const body = overlay.panel.querySelector('[data-activation-body]');
    const confirm = overlay.panel.querySelector('[data-activation-confirm]');
    let deps = null;
    itemMaster('item_dependencies', { method: 'GET', params: { item_id: item.id } }).then((payload) => {
      deps = payload.dependencies || {};
      const allowed = activate ? deps.can_reactivate !== false : deps.can_deactivate !== false;
      const blockers = (deps.blockers || []).map((code) => BLOCKER_COPY[code]?.(deps) || 'Something still depends on this item.');
      const warnings = (deps.warnings || []).map((code) => WARNING_COPY[code]?.(deps)).filter(Boolean);
      body.innerHTML = `<p>${activate ? 'It comes back into counts, orders and recipes. Its history is unchanged.' : 'It leaves counts, ordering and search. Its history and recipe links are kept, and you can reactivate it later.'}</p>
        ${!allowed && blockers.length ? alertHtml('danger', activate ? 'It can’t be reactivated yet' : 'It can’t be deactivated yet', blockers.join(' ')) : ''}
        ${warnings.length ? `<div class="atlas-alert atlas-alert--warning">${icon('triangle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Check before you continue</p><ul class="inv-bullets">${warnings.map((text) => `<li>${esc(text)}</li>`).join('')}</ul></div></div>` : ''}
        ${allowed ? `<div class="atlas-field"><label for="inv-activation-reason">Reason <span class="optional">(optional)</span></label><input class="atlas-input" id="inv-activation-reason" maxlength="500" placeholder="${activate ? 'Back on the menu' : 'No longer stocked'}"></div>` : ''}`;
      confirm.disabled = !allowed;
      if (!allowed) confirm.title = 'Resolve the items above first.';
      lucide();
      body.querySelector('input')?.focus();
    }).catch((error) => {
      body.innerHTML = alertHtml('danger', 'Atlas couldn’t check this item.', `${shown(error, 'Atlas couldn’t reach the server.')} Nothing was changed.`);
      lucide();
    });
    confirm.addEventListener('click', async () => {
      if (!deps) return;
      busy(confirm, true);
      try {
        await itemMaster('set_item_active', { body: { item_id: item.id, active: activate, reason: body.querySelector('#inv-activation-reason')?.value.trim() || null, expected_updated_at: deps.item?.updated_at || item.updated_at || null } });
        overlay.close('done');
        toast(activate ? `${item.name} is active again` : `${item.name} deactivated`);
        await reloadData();
      } catch (error) {
        busy(confirm, false);
        body.insertAdjacentHTML('afterbegin', alertHtml('danger', activate ? 'Reactivation didn’t go through.' : 'Deactivation didn’t go through.', shown(error)));
        lucide();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Add item (create-item with the mandatory duplicate check)
  // ---------------------------------------------------------------------------
  function categoryOptions(selected) {
    const list = distinct('category').map(([value]) => value);
    if (selected && !list.includes(selected)) list.unshift(selected);
    return `<option value="">Choose a category</option>${list.map((value) => `<option${value === selected ? ' selected' : ''}>${esc(value)}</option>`).join('')}<option value="__new">New category…</option>`;
  }
  function supplierOptions(selectedName) {
    const list = suppliers().filter((supplier) => supplier.active !== false);
    return `<option value="">No supplier</option>${list.map((supplier) => `<option value="${esc(supplier.id)}" data-name="${esc(supplier.name)}"${supplier.name === selectedName ? ' selected' : ''}>${esc(supplier.name)}</option>`).join('')}`;
  }
  function unitOptions(selected) {
    const list = UNITS.includes(selected) || !selected ? UNITS : [selected, ...UNITS];
    return list.map((unit) => `<option${unit === (selected || 'bottles') ? ' selected' : ''}>${esc(unit)}</option>`).join('');
  }

  function itemFormHtml(draft = {}, { staff = false } = {}) {
    const field = (id, label, input, help = '') => `<div class="atlas-field"><label for="${id}">${label}</label>${input}${help ? `<p class="help">${help}</p>` : ''}</div>`;
    const text = (name, value, extra = '') => `<input class="atlas-input" id="inv-f-${name}" name="${name}" value="${esc(value ?? '')}" ${extra}>`;
    const number = (name, value, extra = '') => `<input class="atlas-input" id="inv-f-${name}" name="${name}" type="number" inputmode="decimal" min="0" step="any" value="${esc(value ?? '')}" ${extra}>`;
    return `<form class="atlas-form inv-item-form" data-inv-item-form novalidate>
      <div data-inv-form-alert></div>
      ${field('inv-f-name', 'Name', text('name', draft.name, 'required maxlength="200" autocomplete="off" data-autofocus placeholder="e.g. Campari"'))}
      <div class="atlas-grid-2">
        ${field('inv-f-category', 'Category', `<select class="atlas-select" id="inv-f-category" name="category">${categoryOptions(draft.category)}</select><input class="atlas-input inv-item-form__new-category" name="category_new" aria-label="New category name" placeholder="New category" hidden>`)}
        ${field('inv-f-unit', 'Counted in', `<select class="atlas-select" id="inv-f-unit" name="unit">${unitOptions(draft.unit)}</select>`)}
      </div>
      <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Product details <span class="optional">(optional)</span></legend>
        <div class="atlas-grid-2">${field('inv-f-brand', 'Brand', text('brand', draft.brand))}${field('inv-f-variant', 'Variant or flavour', text('variant', draft.variant))}</div>
        <div class="atlas-grid-2">${field('inv-f-unit_size_quantity', 'Unit size', `<div class="inv-size">${number('unit_size_quantity', draft.unit_size_quantity)}<select class="atlas-select" name="unit_size_base" aria-label="Size unit">${['ml', 'g', 'count'].map((base) => `<option value="${base}"${draft.unit_size_base === base ? ' selected' : ''}>${base === 'count' ? 'pieces' : base}</option>`).join('')}</select></div>`)}${field('inv-f-units_per_case', 'Units per case', number('units_per_case', draft.units_per_case))}</div>
        ${field('inv-f-package_size', 'Package', text('package_size', draft.package_size, 'placeholder="e.g. 1 L bottle, 1 kg bag"'))}
        ${draft.abv_percent != null ? field('inv-f-abv_percent', 'ABV %', number('abv_percent', draft.abv_percent, 'max="100"')) : ''}
      </fieldset>
      ${staff ? '' : `<fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Stock and cost</legend>
        <div class="atlas-grid-2">${field('inv-f-supplier', 'Supplier', `<select class="atlas-select" id="inv-f-supplier" name="supplier_id">${supplierOptions(draft.supplier)}</select>`)}${field('inv-f-cost_price', 'Cost per unit', `<div class="atlas-affix">${number('cost_price', draft.cost_price)}<span class="suffix">kr</span></div>`)}</div>
        <div class="atlas-grid-2">${field('inv-f-par_level', 'Par level <span class="optional">(optional)</span>', number('par_level', draft.par_level, 'placeholder="e.g. 4"'), 'The quantity you want on hand after a delivery.')}${field('inv-f-bin_location', 'Location', text('bin_location', draft.bin_location, 'placeholder="e.g. Back bar · shelf 2"'))}</div>
      </fieldset>`}
      <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Codes and other names <span class="optional">(optional)</span></legend>
        <div class="atlas-grid-2">${field('inv-f-barcode', 'Barcode', text('barcode', draft.barcode, 'inputmode="numeric" autocomplete="off"'))}${field('inv-f-sku', 'SKU or supplier number', text('sku', draft.sku, 'autocomplete="off"'))}</div>
        ${field('inv-f-aliases', 'Also known as', text('aliases', (draft.aliases || []).join(', '), 'placeholder="Other names, separated by commas"'), 'Names the team or suppliers use for this item.')}
      </fieldset>
      <div data-inv-duplicates></div>
    </form>`;
  }

  function readItemForm(form) {
    const data = new FormData(form);
    const value = (key) => String(data.get(key) ?? '').trim();
    const numberValue = (key) => { const raw = value(key); return raw === '' ? null : Number(raw); };
    const category = value('category') === '__new' ? value('category_new') : value('category');
    const supplierSelect = form.elements.supplier_id;
    const supplierName = supplierSelect?.selectedOptions?.[0]?.dataset?.name || null;
    const values = {
      name: value('name'),
      category: category || null,
      unit: value('unit') || 'bottles',
      brand: value('brand') || null,
      variant: value('variant') || null,
      package_size: value('package_size') || null,
      units_per_case: numberValue('units_per_case'),
      unit_size_quantity: numberValue('unit_size_quantity'),
      unit_size_base: numberValue('unit_size_quantity') ? value('unit_size_base') || null : null,
      abv_percent: numberValue('abv_percent'),
      cost_price: numberValue('cost_price'),
      par_level: numberValue('par_level'),
      bin_location: value('bin_location') || null,
      supplier_id: supplierSelect ? (value('supplier_id') || null) : undefined,
      supplier: supplierName || undefined
    };
    Object.keys(values).forEach((key) => { if (values[key] === undefined || values[key] === null || values[key] === '') delete values[key]; });
    const codes = [];
    if (value('barcode')) codes.push({ code: value('barcode') });
    if (value('sku')) codes.push({ kind: 'sku', code: value('sku') });
    const aliases = value('aliases').split(',').map((alias) => alias.trim()).filter(Boolean).slice(0, 20);
    return { values, codes, aliases };
  }

  function validateItemForm(form) {
    const errors = [];
    form.querySelectorAll('[aria-invalid="true"]').forEach((input) => input.removeAttribute('aria-invalid'));
    form.querySelectorAll('.atlas-field .error').forEach((node) => node.remove());
    const mark = (input, message) => {
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      input.closest('.atlas-field')?.insertAdjacentHTML('beforeend', `<p class="error">${icon('circle-alert')}${esc(message)}</p>`);
      errors.push(input);
    };
    if (!form.elements.name.value.trim()) mark(form.elements.name, 'Enter the item name.');
    if (form.elements.category.value === '__new' && !form.elements.category_new.value.trim()) mark(form.elements.category_new, 'Enter the new category.');
    ['cost_price', 'par_level', 'units_per_case', 'unit_size_quantity', 'abv_percent'].forEach((name) => {
      const input = form.elements[name];
      if (input && input.value !== '' && (!Number.isFinite(Number(input.value)) || Number(input.value) < 0)) mark(input, 'Enter a number of 0 or more.');
    });
    lucide();
    errors[0]?.focus();
    return !errors.length;
  }

  function duplicateEvidence(candidate) {
    const entries = Array.isArray(candidate.evidence) ? candidate.evidence : [];
    return entries.length ? `<ul class="atlas-capture-evidence">${entries.slice(0, 6).map((entry) => `<li data-polarity="${esc(entry.polarity || 'for')}">${icon(entry.polarity === 'against' ? 'x' : entry.polarity === 'missing' ? 'minus' : 'check')}${esc(entry.text || entry.signal || '')}</li>`).join('')}</ul>` : '';
  }

  // The duplicate-candidate panel (409 from create-item, or a recognition
  // duplicate check). Codes, identical active items and alias clashes can't be
  // overridden; other candidates need "Create anyway" with a reason each.
  function duplicatesHtml(check, code, { manager = true } = {}) {
    const candidates = Array.isArray(check?.candidates) ? check.candidates : [];
    const requires = new Set((check?.requires_ack || []).map(String));
    const hard = code === 'duplicate_identity' || code === 'code_conflict' || code === 'alias_conflict'
      || (check?.code_conflicts || []).length > 0 || (check?.alias_conflicts || []).length > 0 || (check?.identity_conflict && typeof check.identity_conflict === 'object');
    const conflictNames = [];
    if (check?.identity_conflict?.name) conflictNames.push(check.identity_conflict.name);
    const hardText = code === 'code_conflict' || (check?.code_conflicts || []).length
      ? 'That barcode, SKU or supplier number already belongs to another item. Codes can’t be shared, so this can’t be created anyway.'
      : code === 'alias_conflict' || (check?.alias_conflicts || []).length
        ? 'One of the other names already names another item. Remove it or use the existing item.'
        : 'An active item with the same name and package already exists. Use it instead.';
    return `<section class="inv-dup" data-inv-dup-panel aria-labelledby="inv-dup-title">
      <h3 class="inv-dup__title" id="inv-dup-title">Possible existing matches</h3>
      ${hard ? alertHtml('danger', 'This can’t be created as a new item.', hardText) : `<p class="inv__muted">Check these first. ${manager ? 'If it really is a different product, give a reason for each one and create it anyway.' : 'A manager decides whether it’s new.'}</p>`}
      <ol class="inv-dup__list">${candidates.slice(0, 8).map((candidate) => {
        const needs = requires.has(String(candidate.item_id));
        const percent = Math.round((Number(candidate.score) || 0) * 100);
        return `<li class="inv-dup__item" data-dup-item="${esc(candidate.item_id)}">
          <div class="inv-dup__head"><div><p class="inv-dup__name">${esc(candidate.name || 'Inventory item')}</p><p class="inv__muted">${esc([candidate.category, candidate.unit].filter(Boolean).join(' · '))}</p></div><div class="atlas-cluster"><span class="num inv-dup__percent">${percent}%</span>${candidate.active === false ? '<span class="atlas-pill">Inactive</span>' : ''}</div></div>
          ${duplicateEvidence(candidate)}
          <div class="atlas-cluster"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-use-existing="${esc(candidate.item_id)}">Use existing item</button></div>
          ${needs && manager && !hard ? `<div class="atlas-field"><label for="inv-ack-${esc(candidate.item_id)}">Why is it different from ${esc(candidate.name || 'this item')}?</label><input class="atlas-input" id="inv-ack-${esc(candidate.item_id)}" data-ack-reason="${esc(candidate.item_id)}" maxlength="300" placeholder="e.g. Different size: 70 cl vs 1 L"></div>` : ''}
        </li>`;
      }).join('')}</ol>
      ${!candidates.length && conflictNames.length ? `<p>${esc(conflictNames.join(', '))}</p>` : ''}
    </section>`;
  }

  function openAddItemSheet({ draft = {}, recognition = null, title = 'Add item' } = {}) {
    if (!isManager()) { openSuggestProductSheet({ draft, recognition }); return; }
    const requestId = uuid();
    let lastCheck = null;
    let ackMode = false;
    const overlay = openOverlay(sheetHtml({
      title,
      desc: recognition ? 'Filled in from the photo. Check every field before you add it.' : 'New items start as Not counted.',
      body: `${recognition ? alertHtml('info', '', 'Readings Atlas wasn’t sure about are left empty. Nothing is saved until you add the item.') : `<button type="button" class="atlas-btn atlas-btn--secondary inv-scan-product" data-inv-scan-product>${icon('scan-line')}Scan product</button>`}${itemFormHtml(draft)}`,
      foot: '<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary" data-inv-submit form="inv-item-form">Add item</button>'
    }), { label: title });
    const form = overlay.panel.querySelector('[data-inv-item-form]');
    form.id = 'inv-item-form';
    const submit = overlay.panel.querySelector('[data-inv-submit]');
    const category = form.elements.category;
    category.addEventListener('change', () => { form.elements.category_new.hidden = category.value !== '__new'; if (!form.elements.category_new.hidden) form.elements.category_new.focus(); });
    overlay.panel.querySelector('[data-inv-scan-product]')?.addEventListener('click', () => { overlay.close('replace'); openAddProductByCamera(); });
    form.addEventListener('input', () => { if (lastCheck && !ackMode) clearDuplicates(); });
    const dupHost = form.querySelector('[data-inv-duplicates]');
    const alertHost = form.querySelector('[data-inv-form-alert]');
    function clearDuplicates() { lastCheck = null; dupHost.innerHTML = ''; submit.textContent = 'Add item'; }
    dupHost.addEventListener('click', (event) => {
      const use = event.target.closest('[data-use-existing]');
      if (!use) return;
      overlay.close('replace');
      recordRecognitionChoice(recognition, use.dataset.useExisting, 'draft');
      openItem(use.dataset.useExisting);
    });
    dupHost.addEventListener('input', () => {
      if (!lastCheck) return;
      submit.disabled = !ackReady();
    });
    function ackReady() {
      const needed = (lastCheck?.check?.requires_ack || []).map(String);
      return needed.every((id) => (dupHost.querySelector(`[data-ack-reason="${CSS.escape(id)}"]`)?.value.trim().length || 0) >= 3);
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      alertHost.innerHTML = '';
      if (!validateItemForm(form)) return;
      const { values, codes, aliases } = readItemForm(form);
      const body = { values, codes, aliases, request_id: requestId };
      if (recognition?.mediaId) body.media_id = recognition.mediaId;
      if (lastCheck && ackMode) {
        body.duplicate_ack = { acknowledged: (lastCheck.check.requires_ack || []).map((id) => ({ item_id: id, reason: dupHost.querySelector(`[data-ack-reason="${CSS.escape(String(id))}"]`)?.value.trim() || '' })) };
      }
      busy(submit, true, 'Checking for duplicates…');
      try {
        const payload = await itemMaster('create-item', { body });
        const created = payload.result?.item || {};
        overlay.close('done');
        if (recognition) recordRecognitionOutcome(recognition, { outcome: 'new_product_draft', used_for: 'draft', chosen_item_id: null, used_ref: { created_item_id: payload.result?.item_id || created.id || null } });
        toast(`${created.name || values.name} added. It shows as Not counted until the first count.`);
        await reloadData();
        if (payload.result?.item_id || created.id) openItem(payload.result?.item_id || created.id);
      } catch (error) {
        busy(submit, false);
        if (['duplicate_suspected', 'duplicate_identity', 'code_conflict', 'alias_conflict'].includes(error.code) && error.duplicateCheck) {
          lastCheck = { code: error.code, check: error.duplicateCheck };
          dupHost.innerHTML = duplicatesHtml(error.duplicateCheck, error.code, { manager: true });
          const hard = error.code !== 'duplicate_suspected';
          ackMode = !hard && (error.duplicateCheck.requires_ack || []).length > 0;
          if (hard) { submit.disabled = true; submit.textContent = 'Can’t create'; submit.title = 'Use the existing item, or change the name, codes or other names.'; }
          else { submit.textContent = 'Create anyway'; submit.disabled = !ackReady(); }
          lucide();
          dupHost.querySelector('.inv-dup__title')?.setAttribute('tabindex', '-1');
          dupHost.querySelector('.inv-dup__title')?.focus();
          form.addEventListener('input', function reset(e) {
            if (dupHost.contains(e.target)) return;
            form.removeEventListener('input', reset);
            ackMode = false; lastCheck = null; dupHost.innerHTML = ''; submit.disabled = false; submit.textContent = 'Add item'; submit.removeAttribute('title');
          });
        } else {
          alertHost.innerHTML = alertHtml('danger', 'The item wasn’t added.', shown(error, 'Nothing was saved. Check your connection and try again.'));
          lucide();
          alertHost.scrollIntoView({ block: 'nearest' });
        }
      }
    });
    return overlay;
  }

  // Staff (and anyone from the unknown-item flow without manager rights)
  // submit a draft for approval: propose new_item, always pending.
  function openSuggestProductSheet({ draft = {}, recognition = null } = {}) {
    const overlay = openOverlay(sheetHtml({
      title: 'Suggest a new product',
      desc: 'A manager checks it before it’s added. Nothing changes until then.',
      body: itemFormHtml(draft, { staff: true }),
      foot: '<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary" form="inv-suggest-form" data-inv-submit>Send for approval</button>'
    }), { label: 'Suggest a new product' });
    const form = overlay.panel.querySelector('[data-inv-item-form]');
    form.id = 'inv-suggest-form';
    const submit = overlay.panel.querySelector('[data-inv-submit]');
    const alertHost = form.querySelector('[data-inv-form-alert]');
    form.elements.category.addEventListener('change', () => { form.elements.category_new.hidden = form.elements.category.value !== '__new'; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!validateItemForm(form)) return;
      const { values, codes, aliases } = readItemForm(form);
      busy(submit, true, 'Sending…');
      try {
        const payload = await root.AtlasCapture.propose({ kind: 'new_item', payload: { values, codes, aliases }, evidence: recognition ? { detection_id: recognition.detectionId || null } : {}, recognition_request_id: recognition?.requestId || null, media_id: recognition?.mediaId || null });
        const dupes = payload.duplicates?.candidates || [];
        overlay.close('done');
        if (recognition) recordRecognitionOutcome(recognition, { outcome: 'new_product_draft', used_for: 'draft', chosen_item_id: null });
        toast(dupes.length ? 'Sent for approval. A manager will compare it with similar items first.' : 'Sent for approval. A manager will check it.');
      } catch (error) {
        busy(submit, false);
        alertHost.innerHTML = alertHtml('danger', 'Your suggestion wasn’t sent.', shown(error, 'Nothing was sent. Check your connection and try again.'));
        lucide();
      }
    });
    return overlay;
  }

  // ---------------------------------------------------------------------------
  // Edit details: a governed catalogue change (metadata_correction). Managers
  // approve their own change; it is audited either way. Par → Data › Par levels.
  // ---------------------------------------------------------------------------
  const EDITABLE = ['name', 'category', 'unit', 'brand', 'variant', 'package_size', 'units_per_case', 'cost_price', 'case_cost', 'bin_location', 'supplier', 'minimum_order_quantity', 'lead_time_days'];

  function openEditSheet(item) {
    if (!isManager()) return;
    const field = (name, label, value, type = 'text', extra = '') => `<div class="atlas-field"><label for="inv-e-${name}">${label}</label><input class="atlas-input" id="inv-e-${name}" name="${name}" ${type === 'number' ? 'type="number" inputmode="decimal" min="0" step="any"' : ''} value="${esc(value ?? '')}" ${extra}></div>`;
    const overlay = openOverlay(sheetHtml({
      title: `Edit ${item.name}`,
      desc: 'Changes are recorded with your name. Stock isn’t changed here.',
      body: `<form class="atlas-form" id="inv-edit-form" novalidate><div data-inv-form-alert></div>
        ${field('name', 'Name', item.name, 'text', 'required maxlength="200"')}
        <div class="atlas-grid-2"><div class="atlas-field"><label for="inv-e-category">Category</label><select class="atlas-select" id="inv-e-category" name="category">${categoryOptions(item.category).replace('<option value="__new">New category…</option>', '')}</select></div>
        <div class="atlas-field"><label for="inv-e-unit">Counted in</label><select class="atlas-select" id="inv-e-unit" name="unit">${unitOptions(item.unit)}</select></div></div>
        <div class="atlas-grid-2">${field('brand', 'Brand <span class="optional">(optional)</span>', item.brand)}${field('variant', 'Variant <span class="optional">(optional)</span>', item.variant)}</div>
        <div class="atlas-grid-2">${field('package_size', 'Package', item.package_size)}${field('units_per_case', 'Units per case', item.units_per_case, 'number')}</div>
        <div class="atlas-grid-2"><div class="atlas-field"><label for="inv-e-supplier">Supplier</label><select class="atlas-select" id="inv-e-supplier" name="supplier">${supplierOptions(item.supplier).replace(/value="[^"]*" data-name="([^"]*)"/g, 'value="$1"')}</select></div>${field('bin_location', 'Location', item.bin_location)}</div>
        <div class="atlas-grid-2">${field('cost_price', 'Cost per unit (kr)', item.cost_price, 'number')}${field('case_cost', 'Case cost (kr)', item.case_cost, 'number')}</div>
        <div class="atlas-grid-2">${field('minimum_order_quantity', 'Minimum order', item.minimum_order_quantity, 'number')}${field('lead_time_days', 'Lead time (days)', item.lead_time_days, 'number', 'step="1"')}</div>
        <p class="inv__muted">Par level: ${num(item.par_level) !== null ? esc(qty(item.par_level)) : 'not set'}. Change it in <a href="#data/pars">Data › Par levels</a>.</p>
      </form>`,
      foot: '<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary" form="inv-edit-form" data-inv-submit>Save changes</button>'
    }), { label: `Edit ${item.name}` });
    const form = overlay.panel.querySelector('#inv-edit-form');
    const submit = overlay.panel.querySelector('[data-inv-submit]');
    const alertHost = form.querySelector('[data-inv-form-alert]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const values = {};
      const expected = {};
      EDITABLE.forEach((key) => {
        if (!form.elements[key]) return;
        const raw = String(data.get(key) ?? '').trim();
        const isNumber = ['units_per_case', 'cost_price', 'case_cost', 'minimum_order_quantity', 'lead_time_days'].includes(key);
        const next = raw === '' ? null : isNumber ? Number(raw) : raw;
        const current = item[key] === undefined || item[key] === '' ? null : isNumber && item[key] !== null ? Number(item[key]) : item[key];
        if (String(next ?? '') !== String(current ?? '')) { values[key] = next; expected[key] = current; }
      });
      if (!values.name && form.elements.name.value.trim() === '') { form.elements.name.setAttribute('aria-invalid', 'true'); form.elements.name.focus(); return; }
      if (!Object.keys(values).length) { overlay.close('done'); toast('No changes to save'); return; }
      busy(submit, true, 'Saving…');
      try {
        const payload = await itemMaster('catalog-request', { body: { kind: 'metadata_correction', subject_item_id: item.id, payload: { item_id: item.id, values, expected }, source: 'manager', request_id: uuid(), self_approve: true } });
        overlay.close('done');
        const status = payload.request?.status;
        toast(status === 'pending' ? 'Sent for review. It applies once approved.' : `${values.name || item.name} updated`);
        await reloadData();
      } catch (error) {
        busy(submit, false);
        alertHost.innerHTML = alertHtml('danger', 'Your changes weren’t saved.', shown(error, 'Nothing was saved. Check your connection and try again.'));
        lucide();
      }
    });
  }

  function openAddCode(item) {
    const manager = isManager();
    const overlay = openOverlay(`<h2 class="atlas-dialog__title">${manager ? 'Add a barcode' : 'Suggest a barcode'}</h2>
      <form class="atlas-dialog__body atlas-form" id="inv-code-form"><p>${manager ? `Link a barcode or SKU to ${esc(item.name)}. Atlas checks it isn’t used by another item.` : `A manager checks it before it’s linked to ${esc(item.name)}.`}</p>
      <div class="atlas-field"><label for="inv-code">Barcode or SKU</label><input class="atlas-input" id="inv-code" name="code" inputmode="numeric" autocomplete="off" required></div><div data-inv-form-alert></div></form>
      <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="inv-code-form" class="atlas-btn atlas-btn--primary">${manager ? 'Add barcode' : 'Send for approval'}</button></div>`, { className: 'atlas-dialog' });
    const form = overlay.panel.querySelector('#inv-code-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = form.elements.code.value.trim();
      if (!code) { form.elements.code.setAttribute('aria-invalid', 'true'); return; }
      const button = overlay.panel.querySelector('[type="submit"]');
      busy(button, true);
      try {
        if (manager) await itemMaster('catalog-request', { body: { kind: 'code', subject_item_id: item.id, payload: { item_id: item.id, code }, source: 'manager', request_id: uuid(), self_approve: true } });
        else await root.AtlasCapture.propose({ kind: 'code', payload: { item_id: item.id, code } });
        overlay.close('done');
        toast(manager ? `Barcode linked to ${item.name}` : 'Sent for approval');
      } catch (error) {
        busy(button, false);
        form.querySelector('[data-inv-form-alert]').innerHTML = alertHtml('danger', '', shown(error, 'The barcode wasn’t linked. Nothing was changed; try again.'));
        lucide();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Movements and waste
  // ---------------------------------------------------------------------------
  function movementPill(type) {
    const [label, tone] = MOVEMENT_TYPES[type] || [String(type || 'Change').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), 'neutral'];
    return `<span class="atlas-pill${tone && tone !== 'neutral' ? ` atlas-pill--${tone}` : ''}">${esc(label)}</span>`;
  }

  function movementsFailedHtml(what) {
    return loadFailedHtml(`${what} couldn’t be loaded.`, 'Nothing was changed; your records are safe. Check your connection and try again.');
  }

  function renderMovements(body) {
    if (inputHealth('movements') === 'loading' && !movements().length) { body.innerHTML = loadingRowsHtml(); return; }
    if (inputHealth('movements') === 'failed') { body.innerHTML = movementsFailedHtml('Movements'); return; }
    const query = state.movementQuery.trim().toLowerCase();
    const list = movements().filter((entry) => (!state.movementType || entry.movement_type === state.movementType)
      && (!query || [entry.item_name, entry.note].some((value) => String(value || '').toLowerCase().includes(query))));
    const focus = state.focusMovement;
    // The linked record is always listed, even when it is older than the latest 300.
    const shown = list.slice(0, 300);
    if (focus && !shown.some((entry) => String(entry.id) === focus)) {
      const linked = list.find((entry) => String(entry.id) === focus);
      if (linked) shown.unshift(linked);
    }
    const focusAttrs = (entry) => ` data-movement-id="${esc(entry.id)}"${focus && String(entry.id) === focus ? ' class="is-linked-target" aria-current="true"' : ''}`;
    const types = [...new Set(movements().map((entry) => entry.movement_type).filter(Boolean))];
    body.innerHTML = `<div class="atlas-toolbar">
        <label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" data-inv-movement-search placeholder="Search item or note" aria-label="Search movements" value="${esc(state.movementQuery)}"></label>
        ${state.movementType ? chip((MOVEMENT_TYPES[state.movementType] || [state.movementType])[0], { active: true, clear: 'movementType' }) : chip('Type', { menu: 'mtype' })}
        <div class="atlas-toolbar__end">${list.length} ${list.length === 1 ? 'movement' : 'movements'}</div>
      </div>${menuHtml('mtype', types.map((type) => ['movementType', type, (MOVEMENT_TYPES[type] || [type])[0]]))}
      <div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table"><thead><tr><th>Date</th><th>Item</th><th>Type</th><th class="is-num">Change</th><th data-priority="2">Note</th></tr></thead>
      <tbody>${shown.map((entry) => { const change = num(entry.quantity_change) || 0; return `<tr${focusAttrs(entry)}><td>${esc(dateTimeText(entry.created_at))}</td><td><a href="#inventory/item/${encodeURIComponent(entry.item_id)}" class="cell-primary">${esc(entry.item_name || 'Inventory item')}</a></td><td>${movementPill(entry.movement_type)}</td><td class="is-num">${change > 0 ? '+' : ''}${qty(change)}</td><td data-priority="2" class="inv__note">${esc(entry.note || '—')}</td></tr>`; }).join('')}</tbody></table>
      ${list.length ? '' : `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('history')}</div><h3 class="atlas-empty__title">${movements().length ? 'No movements match' : 'No movements yet'}</h3><p class="atlas-empty__text">${movements().length ? 'Clear the search or type filter.' : 'Deliveries, counts, adjustments and waste appear here as they’re recorded.'}</p></div>`}</div>
      <ul class="atlas-table-list">${shown.slice(0, 200).map((entry) => { const change = num(entry.quantity_change) || 0; return `<li${focusAttrs(entry)}><a class="atlas-table-list__row" href="#inventory/item/${encodeURIComponent(entry.item_id)}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(entry.item_name || 'Inventory item')}</div><div class="atlas-table-list__meta">${esc(dateTimeText(entry.created_at))}${entry.note ? ` · ${esc(entry.note)}` : ''}</div></div><div class="atlas-table-list__value">${change > 0 ? '+' : ''}${qty(change)}<br>${movementPill(entry.movement_type)}</div></a></li>`; }).join('')}</ul>
      <div class="atlas-table-foot"><span>${list.length > 300 ? 'Showing the latest 300' : ''}</span><span>Every restock, count, adjustment and waste record, newest first.</span></div>`;
    bindMenus(body);
  }

  function renderWaste(body) {
    if (inputHealth('movements') === 'loading' && !movements().length) { body.innerHTML = loadingRowsHtml(); return; }
    if (inputHealth('movements') === 'failed') { body.innerHTML = movementsFailedHtml('Waste records'); return; }
    const list = movements().filter((entry) => entry.movement_type === 'waste');
    body.innerHTML = `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table"><thead><tr><th>Date</th><th>Item</th><th class="is-num">Quantity</th><th>Reason</th></tr></thead>
      <tbody>${list.map((entry) => `<tr><td>${esc(dateTimeText(entry.created_at))}</td><td class="cell-primary">${esc(entry.item_name || 'Inventory item')}</td><td class="is-num">${qty(Math.abs(num(entry.quantity_change) || 0))}</td><td class="inv__note">${esc(entry.note || 'Waste')}</td></tr>`).join('')}</tbody></table>
      ${list.length ? '' : `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('trash-2')}</div><h3 class="atlas-empty__title">No waste recorded</h3><p class="atlas-empty__text">Only waste you record appears here. Atlas never treats other adjustments as waste.</p><button type="button" class="atlas-btn atlas-btn--secondary" data-inv-waste>Record waste</button></div>`}</div>
      <ul class="atlas-table-list">${list.map((entry) => `<li><div class="atlas-table-list__row"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(entry.item_name || 'Inventory item')}</div><div class="atlas-table-list__meta">${esc(dateTimeText(entry.created_at))} · ${esc(entry.note || 'Waste')}</div></div><div class="atlas-table-list__value">${qty(Math.abs(num(entry.quantity_change) || 0))}</div></div></li>`).join('')}</ul>
      <div class="atlas-table-foot"><span>${list.length} ${list.length === 1 ? 'record' : 'records'}</span><span>Recording waste lowers stock straight away.</span></div>`;
  }

  function openWasteDialog(itemId = null) {
    if (!isManager()) { toast('Recording waste is for managers.', { icon: false }); return; }
    const choices = items().filter((item) => item.active !== false && truth()?.known(item) && (num(item.quantity) || 0) > 0);
    const overlay = openOverlay(`<h2 class="atlas-dialog__title">Record waste</h2>
      <form class="atlas-dialog__body atlas-form" id="inv-waste-form" novalidate>
        <p>Waste lowers stock straight away and is kept in the movement history.</p>
        ${choices.length ? '' : alertHtml('info', '', 'Only counted items with stock can be recorded as waste.')}
        <div class="atlas-field"><label for="inv-w-item">Item</label><select class="atlas-select" id="inv-w-item" name="item_id" required><option value="">Choose an item</option>${choices.map((item) => `<option value="${esc(item.id)}"${String(item.id) === String(itemId) ? ' selected' : ''}>${esc(item.name)} · ${qty(item.quantity)} ${esc(unitWord(item))}</option>`).join('')}</select></div>
        <div class="atlas-grid-2"><div class="atlas-field"><label for="inv-w-qty">Quantity</label><input class="atlas-input" id="inv-w-qty" name="quantity" type="number" inputmode="decimal" min="0.001" step="any" required></div>
        <div class="atlas-field"><label for="inv-w-reason">Reason</label><select class="atlas-select" id="inv-w-reason" name="reason" required><option value="">Choose</option>${WASTE_REASONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div></div>
        <div class="atlas-field"><label for="inv-w-note">Note</label><input class="atlas-input" id="inv-w-note" name="note" maxlength="900" required placeholder="What happened and where"></div>
        <div data-inv-form-alert></div>
      </form>
      <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="inv-waste-form" class="atlas-btn atlas-btn--primary">Record waste</button></div>`, { className: 'atlas-dialog atlas-dialog--form' });
    const form = overlay.panel.querySelector('#inv-waste-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const alert = form.querySelector('[data-inv-form-alert]');
      const item = itemById(form.elements.item_id.value);
      const quantity = Number(form.elements.quantity.value);
      const reason = form.elements.reason.value;
      const note = form.elements.note.value.trim();
      const problems = [];
      if (!item) problems.push([form.elements.item_id, 'Choose an item.']);
      if (!(quantity > 0) || (item && quantity > (num(item.quantity) || 0))) problems.push([form.elements.quantity, `Enter a quantity up to ${item ? qty(item.quantity) : 'the stock on hand'}.`]);
      if (!reason) problems.push([form.elements.reason, 'Choose a reason.']);
      if (!note) problems.push([form.elements.note, 'Say what happened.']);
      form.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
      if (problems.length) {
        problems.forEach(([input]) => input.setAttribute('aria-invalid', 'true'));
        alert.innerHTML = alertHtml('danger', '', problems.map(([, text]) => text).join(' '));
        lucide();
        problems[0][0].focus();
        return;
      }
      const button = overlay.panel.querySelector('[type="submit"]');
      busy(button, true);
      const { error } = await root.atlasSupabase.rpc('adjust_inventory', {
        p_item_id: item.id, p_quantity_change: -quantity, p_movement_type: 'waste', p_unit_cost: item.cost_price || null, p_supplier_id: null,
        p_note: `${(WASTE_REASONS.find(([value]) => value === reason) || [reason, reason])[1]}: ${note}`
      });
      if (error) {
        busy(button, false);
        alert.innerHTML = alertHtml('danger', 'Waste wasn’t recorded.', 'Stock is unchanged. Check your connection and try again.');
        lucide();
        return;
      }
      overlay.close('done');
      toast(`Recorded ${qty(quantity)} ${unitWord(item)} of ${item.name} as waste`);
      await reloadData();
    });
  }

  // ---------------------------------------------------------------------------
  // Visual Inventory flows (owner §§5–15) on AtlasCapture
  // ---------------------------------------------------------------------------
  const R = () => root.AtlasCapture.render;

  function recognitionRef(result, detection) {
    return { requestId: result?.request_id || null, detectionId: detection?.detection_id || null, mediaId: result?.media?.media_id || null, band: detection?.band || null, preselected: detection?.preselected_item_id || null };
  }

  async function recordRecognitionOutcome(ref, body) {
    if (!ref?.detectionId || !root.AtlasCapture) return null;
    try {
      const payload = await root.AtlasCapture.outcome({ detection_id: ref.detectionId, ...body });
      return payload?.outcome?.outcome_id || payload?.outcome?.id || null;
    } catch (_) { return null; }
  }

  function recordRecognitionChoice(ref, itemId, usedFor, rank = null, how = null) {
    if (!ref?.detectionId) return Promise.resolve(null);
    const outcome = how || (ref.band === 'high' && String(ref.preselected) === String(itemId) ? 'confirmed_preselected' : 'chose_candidate');
    if (ref.recorded) return Promise.resolve(ref.outcomeId || null);
    ref.recorded = true;
    return recordRecognitionOutcome(ref, { outcome, chosen_item_id: itemId, chosen_rank: rank, used_for: usedFor }).then((id) => { ref.outcomeId = id; return id; });
  }

  function draftFromDetection(detection) {
    const read = detection?.read || {};
    const conf = detection?.field_confidence || {};
    const sure = (key, field) => (conf[key] == null || conf[key] >= 60 ? field : null);
    const value = (entry) => (entry && typeof entry === 'object' ? entry.value ?? null : entry ?? null);
    const brand = sure('brand', value(read.brand));
    const product = sure('identity', value(read.product_name));
    const variant = sure('variant', value(read.variant));
    const size = read.unit_size || {};
    const sizeOk = sure('unit_size', size.quantity);
    const base = { ml: 'ml', cl: 'ml', l: 'ml', g: 'g', kg: 'g', count: 'count' }[size.unit] || null;
    const factor = { cl: 10, l: 1000, kg: 1000 }[size.unit] || 1;
    const barcode = value(read.barcode) || null;
    const name = [brand, product, variant].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const packaging = sure('package_type', value(read.packaging_type));
    return {
      name: name || null,
      brand: brand || null,
      product_name: product || null,
      variant: variant || null,
      category: sure('category', value(read.subcategory)) || null,
      unit_size_quantity: sizeOk && base ? Math.round(sizeOk * factor * 1000) / 1000 : null,
      unit_size_base: sizeOk && base ? base : null,
      package_size: [size.text || (sizeOk ? `${sizeOk} ${size.unit}` : null), packaging].filter(Boolean).join(' ') || null,
      units_per_case: sure('package_size', value(read.units_per_case)) || null,
      abv_percent: value(read.abv_percent) ?? null,
      barcode: sure('barcode', barcode),
      sku: value(read.sku_or_supplier_ref) || null,
      unit: packaging === 'bag' ? 'bags' : packaging === 'can' ? 'cans' : packaging === 'bottle' ? 'bottles' : null
    };
  }

  // Result sheet for identify mode (owner §12): read-only, nothing changes.
  function identifySheet(result, detection, ctl, preset = null) {
    const ref = recognitionRef(result, detection);
    let selected = preset || detection.preselected_item_id || null;
    let selectedRank = selected ? (detection.candidates || []).find((c) => String(c.item_id) === String(selected))?.rank ?? null : null;
    const draw = () => {
      const candidate = (detection.candidates || []).find((entry) => String(entry.item_id) === String(selected)) || null;
      const item = selected ? itemById(selected) || candidate?.item || null : null;
      const known = item && truth()?.known(item);
      const heading = selected ? (detection.band === 'high' && !preset ? 'Likely match' : 'Chosen match') : 'Which product is this?';
      const others = (detection.candidates || []).filter((entry) => String(entry.item_id) !== String(selected));
      ctl.showSheet(`<div class="atlas-capture-result" data-capture-result="identify">
        <div class="atlas-capture-result__head">${item?.image_url ? `<img class="atlas-capture-result__img" src="${esc(item.image_url)}" alt="">` : `<span class="atlas-capture-result__img" aria-hidden="true">${icon('package')}</span>`}
          <div class="atlas-capture-result__text"><p class="atlas-capture-result__kicker">${heading}</p><h3 class="atlas-capture-result__title">${esc(item?.name || 'Choose the product')}</h3><p class="atlas-capture-muted">${esc([item?.brand, item?.category, packLine(item || {})].filter(Boolean).join(' · ') || 'Nothing changes until you choose.')}</p></div>
          ${R().band(detection, candidate)}</div>
        ${item ? `<dl class="atlas-capture-facts"><div><dt>In Atlas</dt><dd>${item.active === false ? 'Yes · inactive' : 'Yes'}</dd></div><div><dt>Verified stock</dt><dd>${known ? `${qty(item.quantity)} ${esc(unitWord(item))}` : 'Not counted'}</dd></div>${isManager() ? `<div><dt>Supplier</dt><dd>${esc(item.supplier || item.supplier_name || 'Not set')}</dd></div>` : ''}</dl>` : ''}
        ${R().fields(detection, { item, showSupplier: isManager(), keys: ['identity', 'brand', 'variant', 'category', 'package_type', 'unit_size', 'barcode', 'inventory_match', 'supplier_match'] })}
        ${selected ? (others.length ? `<details class="atlas-capture-more"><summary>Other possible matches (${others.length})</summary>${R().candidates({ ...detection, candidates: others }, { action: 'Choose', startOpen: false })}</details>` : '')
          : R().candidates(detection, { action: 'Choose' })}
        <div class="atlas-capture__actions atlas-capture__actions--grid">
          <button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-id-action="open"${selected ? '' : ' disabled'}>${icon('panel-right-open')}Open item</button>
          ${canCount() ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-id-action="count"${selected && item?.active !== false ? '' : ' disabled'}>${icon('list-checks')}Count item</button>` : ''}
          <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-id-action="recipes"${selected ? '' : ' disabled'}>${icon('martini')}View recipes</button>
          <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-id-action="ask">${icon('sparkles')}Ask Atlas</button>
          <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-id-action="wrong">${icon('thumbs-down')}Wrong product</button>
        </div>
        <p class="atlas-capture-note">Identifying never changes stock or items.</p>
      </div>`, (sheet) => {
        sheet.querySelectorAll('[data-capture-choose]').forEach((button) => button.addEventListener('click', () => {
          selected = button.dataset.captureChoose;
          selectedRank = Number(button.dataset.rank) || null;
          draw();
        }));
        sheet.querySelectorAll('[data-id-action]').forEach((button) => button.addEventListener('click', () => identifyAction(button.dataset.idAction, { result, detection, ctl, ref, selected, selectedRank, name: (itemById(selected) || (detection.candidates || []).find((c) => String(c.item_id) === String(selected))?.item || {}).name })));
      });
    };
    draw();
  }

  async function identifyAction(action, { result, detection, ctl, ref, selected, selectedRank, name }) {
    if (action === 'wrong') { wrongProduct({ result, detection, ctl, ref, itemId: selected || detection.candidates?.[0]?.item_id || null }); return; }
    if (action === 'ask') {
      ctl.close();
      if (selected) askAbout({ id: selected, name: name || 'This product' });
      else root.AtlasAI?.askAbout?.({ type: 'recognition', id: result.request_id, label: 'Scanned product' });
      return;
    }
    if (!selected) return;
    recordRecognitionChoice(ref, selected, 'identify', selectedRank);
    ctl.close();
    if (action === 'open') openItem(selected);
    else if (action === 'count') countItem(selected);
    else if (action === 'recipes') { shell.navigate(`#inventory/item/${encodeURIComponent(selected)}`); window.setTimeout(() => showDetail(selected, 'recipes'), 0); }
  }

  async function wrongProduct({ result, detection, ctl, ref, itemId, onRetry }) {
    ctl.setBusy('Saving your report…');
    await recordRecognitionOutcome(ref, { outcome: 'wrong_product', chosen_item_id: null, used_for: 'identify', note: itemId ? `Suggested ${itemId}` : null });
    if (detection?.band !== 'high') {
      try { await root.AtlasCapture.report({ detection_id: ref.detectionId, item_id: itemId, note: 'Reported from the scan result' }); } catch (_) { /* the outcome already records it */ }
    }
    ctl.showSheet(`<div class="atlas-capture-result"><h3 class="atlas-capture-result__title">Thanks. A manager will review this match.</h3><p class="atlas-capture-muted">Nothing was changed. Try again or search for the product.</p>
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-retry>Retry scan</button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-search>Search inventory</button></div></div>`, (sheet) => {
      sheet.querySelector('[data-retry]').addEventListener('click', () => (onRetry ? onRetry() : ctl.resume()));
      sheet.querySelector('[data-search]').addEventListener('click', () => searchSheet({ result, detection, ctl, onChoose: (id, rank) => identifySheet(result, detection, ctl, id) }));
    });
    void result;
  }

  // Search inside the capture (owner §13 "Search inventory"): the service's
  // ranked text search, prefilled with what the label says.
  function searchSheet({ result, detection, ctl, onChoose, prefill }) {
    const guess = prefill ?? [R().readValue(detection, 'brand'), R().readValue(detection, 'identity')].filter(Boolean).join(' ');
    ctl.showSheet(`<div class="atlas-capture-result"><h3 class="atlas-capture-result__title">Search inventory</h3>
      <form class="atlas-capture-search" data-capture-search-form><label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" name="q" value="${esc(guess)}" aria-label="Search inventory" data-autofocus autocomplete="off"></label><button type="submit" class="atlas-btn atlas-btn--primary">Search</button></form>
      <div data-capture-search-results></div>
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-back>Back</button></div></div>`, (sheet) => {
      const results = sheet.querySelector('[data-capture-search-results]');
      sheet.querySelector('[data-back]').addEventListener('click', () => (detection && detection.band !== 'low' ? identifyOrCount() : unknownSheet(result, detection, ctl, { onChoose })));
      function identifyOrCount() { onChoose.back ? onChoose.back() : unknownSheet(result, detection, ctl, { onChoose }); }
      sheet.querySelector('[data-capture-search-form]').addEventListener('submit', async (event) => {
        event.preventDefault();
        const q = event.currentTarget.elements.q.value.trim();
        if (!q) return;
        results.innerHTML = '<p class="atlas-capture-muted" role="status">Searching…</p>';
        try {
          const payload = await root.AtlasCapture.search(q);
          const list = payload.candidates || [];
          results.innerHTML = list.length ? R().candidates({ candidates: list }, { action: 'Choose', startOpen: false }) : `<p class="atlas-capture-muted">No items match “${esc(q)}”.</p>`;
          lucide();
          results.querySelectorAll('[data-capture-choose]').forEach((button) => button.addEventListener('click', () => {
            const ref = recognitionRef(result, detection);
            recordRecognitionChoice(ref, button.dataset.captureChoose, onChoose.usedFor || 'identify', Number(button.dataset.rank) || null, 'chose_by_search');
            onChoose(button.dataset.captureChoose, Number(button.dataset.rank) || null, 'chose_by_search');
          }));
        } catch (error) {
          results.innerHTML = alertHtml('danger', 'Search didn’t work.', shown(error, 'Check your connection and try again.'));
          lucide();
        }
      });
      if (guess) sheet.querySelector('[data-capture-search-form]').requestSubmit();
    });
  }

  // Unknown item flow (owner §13). Shared with the stock count (options.mode).
  function unknownSheet(result, detection, ctl, options = {}) {
    const onChoose = options.onChoose || ((id) => identifySheet(result, detection, ctl, id));
    onChoose.usedFor = onChoose.usedFor || options.usedFor || 'identify';
    const candidates = detection?.candidates || [];
    ctl.showSheet(`<div class="atlas-capture-result" data-capture-result="unknown">
      <div class="atlas-capture-result__head"><span class="atlas-capture-result__img" aria-hidden="true">${icon('scan-search')}</span><div class="atlas-capture-result__text"><h3 class="atlas-capture-result__title">Atlas couldn’t tell which item this is.</h3><p class="atlas-capture-muted">Nothing was created or changed.</p></div>${detection ? R().band(detection) : ''}</div>
      ${detection ? `<details class="atlas-capture-more" open><summary>What Atlas could read</summary>${R().fields(detection, { keys: ['identity', 'brand', 'variant', 'category', 'package_type', 'unit_size', 'barcode'] }) || '<p class="atlas-capture-muted">Nothing readable. Try a closer photo of the label.</p>'}</details>` : ''}
      <div class="atlas-capture__actions atlas-capture__actions--grid">
        <button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-unknown="retry">${icon('scan-line')}Retry scan</button>
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-unknown="search">${icon('search')}Search inventory</button>
        ${candidates.length ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-unknown="matches">${icon('list')}View possible matches</button>` : ''}
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-unknown="ask">${icon('sparkles')}Ask Atlas</button>
        ${options.allowDraft === false ? '' : `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--lg" data-unknown="draft">${icon('file-plus')}Create new product draft</button>`}
      </div></div>`, (sheet) => {
      sheet.querySelectorAll('[data-unknown]').forEach((button) => button.addEventListener('click', () => {
        const action = button.dataset.unknown;
        if (action === 'retry') { recordRecognitionOutcome(recognitionRef(result, detection), { outcome: 'no_match', used_for: onChoose.usedFor }); ctl.resume(); }
        else if (action === 'search') searchSheet({ result, detection, ctl, onChoose });
        else if (action === 'matches') possibleMatchesSheet(result, detection, ctl, onChoose, options);
        else if (action === 'ask') { ctl.close(); root.AtlasAI?.askAbout?.({ type: 'recognition', id: result.request_id, label: 'Scanned product' }); }
        else if (action === 'draft') newProductDraft(result, detection, ctl);
      }));
    });
  }

  function possibleMatchesSheet(result, detection, ctl, onChoose, options) {
    ctl.showSheet(`<div class="atlas-capture-result"><h3 class="atlas-capture-result__title">Possible matches</h3><p class="atlas-capture-muted">Atlas isn’t sure about any of these. Choose one only if it’s the product in your hand.</p>
      ${R().candidates(detection, { action: 'Choose' })}
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-back>Back</button></div></div>`, (sheet) => {
      sheet.querySelector('[data-back]').addEventListener('click', () => unknownSheet(result, detection, ctl, { ...options, onChoose }));
      sheet.querySelectorAll('[data-capture-choose]').forEach((button) => button.addEventListener('click', () => {
        recordRecognitionChoice(recognitionRef(result, detection), button.dataset.captureChoose, onChoose.usedFor, Number(button.dataset.rank) || null, 'chose_candidate');
        onChoose(button.dataset.captureChoose, Number(button.dataset.rank) || null, 'chose_candidate');
      }));
    });
  }

  // "Create new product draft" runs another duplicate search with every piece
  // of evidence before a draft exists (owner §13, §14).
  async function newProductDraft(result, detection, ctl) {
    const draft = draftFromDetection(detection);
    ctl.setBusy('Checking for existing products…');
    let duplicates = null;
    const values = Object.fromEntries(Object.entries({ name: draft.name || draft.product_name || draft.brand || 'Unnamed product', brand: draft.brand, product_name: draft.product_name, variant: draft.variant, category: draft.category, unit_size_quantity: draft.unit_size_quantity, unit_size_base: draft.unit_size_base, package_size: draft.package_size, unit: draft.unit }).filter(([, value]) => value != null && value !== ''));
    try {
      const payload = await root.AtlasCapture.duplicates({ values, codes: draft.barcode ? [{ code: draft.barcode }] : [], aliases: [], limit: 8 });
      duplicates = payload.duplicates || null;
    } catch (error) {
      ctl.error(error);
      return;
    }
    const ref = recognitionRef(result, detection);
    const likely = (duplicates?.candidates || []).filter((candidate) => Number(candidate.score) >= 0.6);
    const toDraft = () => {
      ctl.close();
      if (isManager()) openAddItemSheet({ draft, recognition: ref, title: 'Review draft' });
      else openSuggestProductSheet({ draft, recognition: ref });
    };
    if (!likely.length) { toDraft(); return; }
    ctl.showSheet(`<div class="atlas-capture-result">${duplicatesHtml({ ...duplicates, candidates: likely }, null, { manager: false })}
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-review>Review draft</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--lg" data-back>Back</button></div></div>`, (sheet) => {
      sheet.querySelector('[data-review]').addEventListener('click', toDraft);
      sheet.querySelector('[data-back]').addEventListener('click', () => unknownSheet(result, detection, ctl));
      sheet.querySelectorAll('[data-use-existing]').forEach((button) => button.addEventListener('click', () => {
        recordRecognitionChoice(ref, button.dataset.useExisting, 'draft', null, 'chose_candidate');
        ctl.close();
        openItem(button.dataset.useExisting);
      }));
    });
  }

  function onIdentifyResult(result, ctl) {
    const detections = result.detections || [];
    if (detections.length > 1) {
      ctl.showSheet(`<div class="atlas-capture-result"><h3 class="atlas-capture-result__title">${detections.length} products found</h3><p class="atlas-capture-muted">Choose one to check.</p>
        <ul class="atlas-list">${detections.map((detection, index) => { const top = detection.candidates?.[0]; return `<li class="atlas-row atlas-row--link"><button type="button" class="atlas-capture-row" data-detection="${index}"><span class="atlas-row__body"><span class="atlas-row__title">${esc(detection.band === 'low' ? 'Unknown product' : top?.item?.name || 'Product')}</span><span class="atlas-row__meta">${esc(detection.summary || '')}</span></span>${R().band(detection)}</button></li>`; }).join('')}</ul></div>`, (sheet) => {
        sheet.querySelectorAll('[data-detection]').forEach((button) => button.addEventListener('click', () => showDetection(result, detections[Number(button.dataset.detection)], ctl)));
      });
      return;
    }
    showDetection(result, detections[0] || null, ctl);
  }

  function showDetection(result, detection, ctl) {
    if (!detection || detection.band === 'low') unknownSheet(result, detection, ctl);
    else identifySheet(result, detection, ctl);
  }

  function openIdentify() {
    if (!root.AtlasCapture) { toast('Scanning isn’t available right now.'); return; }
    root.AtlasCapture.open({
      mode: 'identify',
      title: 'Identify item',
      onResult: onIdentifyResult,
      onSearch: (ctl) => searchSheet({ result: {}, detection: null, ctl, onChoose: (id) => { ctl.close(); openItem(id); }, prefill: '' })
    });
  }

  // Add product by camera (owner §14): the photo is always read; possible
  // existing matches come first; only managers create a genuinely new item.
  function openAddProductByCamera() {
    if (!root.AtlasCapture) { toast('Scanning isn’t available right now.'); return; }
    root.AtlasCapture.open({
      mode: 'add_product',
      title: 'Scan product',
      photoRequired: true,
      onResult: (result, ctl) => addProductResult(result, ctl)
    });
  }

  function addProductResult(result, ctl) {
    const detection = (result.detections || [])[0] || null;
    if (!detection) { unknownSheet(result, null, ctl, { allowDraft: false }); return; }
    const draft = draftFromDetection(detection);
    const ref = recognitionRef(result, detection);
    const matches = (detection.candidates || []).filter((candidate) => (candidate.percent ?? 0) >= 60);
    ctl.showSheet(`<div class="atlas-capture-result" data-capture-result="add_product">
      <div class="atlas-capture-result__head"><span class="atlas-capture-result__img" aria-hidden="true">${icon('file-plus')}</span><div class="atlas-capture-result__text"><p class="atlas-capture-result__kicker">Draft from the photo</p><h3 class="atlas-capture-result__title">${esc(draft.name || 'Unnamed product')}</h3><p class="atlas-capture-muted">${esc([draft.category, draft.package_size].filter(Boolean).join(' · ') || 'Check every field before saving.')}</p></div></div>
      ${R().fields(detection, { keys: ['identity', 'brand', 'variant', 'category', 'package_type', 'unit_size', 'package_size', 'barcode'] })}
      <h4 class="atlas-capture-subhead">Possible existing matches</h4>
      ${matches.length ? R().candidates({ ...detection, candidates: matches }, { action: 'Use existing item' }) : '<p class="atlas-capture-muted">No existing item looks like this one.</p>'}
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-review>Review draft</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--lg" data-retry>Retake photo</button></div>
      <p class="atlas-capture-note">${isManager() ? 'Nothing is added until you review the draft and create the item.' : 'A manager approves new products before they’re added.'}</p></div>`, (sheet) => {
      sheet.querySelector('[data-retry]').addEventListener('click', () => ctl.resume());
      sheet.querySelector('[data-review]').addEventListener('click', () => { ctl.close(); if (isManager()) openAddItemSheet({ draft, recognition: ref, title: 'Review draft' }); else openSuggestProductSheet({ draft, recognition: ref }); });
      sheet.querySelectorAll('[data-capture-choose]').forEach((button) => button.addEventListener('click', () => {
        recordRecognitionChoice(ref, button.dataset.captureChoose, 'draft', Number(button.dataset.rank) || null, 'chose_candidate');
        ctl.close();
        openItem(button.dataset.captureChoose);
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !rootEl().contains(target)) return;
    if (target.closest('[data-inv-add]')) { openAddItemSheet(); return; }
    if (target.closest('[data-inv-count]')) { shell.actions.run('inventory.count.start', { context: 'inventory' }); return; }
    if (target.closest('[data-inv-waste]')) { openWasteDialog(); return; }
    if (target.closest('[data-inv-retry]')) { reloadData(); return; }
    if (target.closest('[data-inv-clear-all]')) { Object.assign(state, { query: '', status: null, category: null, subcategory: null, supplier: null, location: null, activity: 'active' }); syncFilterRoute(); renderItemsOnly(); return; }
    const clear = target.closest('[data-inv-clear]');
    if (clear) {
      const key = clear.dataset.invClear;
      if (key === 'activity') state.activity = 'active'; else state[key] = null;
      if (key === 'category') state.subcategory = null;
      syncFilterRoute();
      if (activeTab() === 'items') renderItemsOnly(); else render();
      return;
    }
    const sort = target.closest('[data-inv-sort]');
    if (sort) {
      const key = sort.dataset.invSort;
      state.sort = state.sort.key === key ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'status' ? 'asc' : 'desc' };
      renderItemsOnly();
      rootEl().querySelector(`[data-inv-sort="${key}"]`)?.focus();
      return;
    }
    const rowMenu = target.closest('[data-inv-row-menu]');
    if (rowMenu) {
      event.preventDefault();
      if (!rowMenu.hasAttribute('aria-controls')) openRowMenu(rowMenu, rowMenu.dataset.invRowMenu);
      return;
    }
    const bulk = target.closest('[data-inv-bulk]');
    if (bulk) {
      const ids = [...state.selected];
      if (bulk.dataset.invBulk === 'clear') state.selected.clear();
      else if (bulk.dataset.invBulk === 'order') root.AtlasPurchasing?.newOrder?.({ itemIds: ids });
      else if (bulk.dataset.invBulk === 'count') root.AtlasStockCounts?.startForItems?.(ids);
      renderItemsOnly();
      return;
    }
    if (target.closest('[data-inv-select], [data-inv-select-all], .col-check')) return;
    const open = target.closest('[data-inv-open]');
    if (open) {
      event.preventDefault();
      openItem(open.dataset.invOpen, true);
      return;
    }
    const row = target.closest('[data-inv-row]');
    if (row && !target.closest('button, a, input')) openItem(row.dataset.invRow, true);
  }

  function onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !rootEl().contains(target)) return;
    if (target.matches('[data-inv-select]')) {
      const id = target.dataset.invSelect;
      if (target.checked) state.selected.add(id); else state.selected.delete(id);
      renderItemsOnly();
      const again = rootEl().querySelector(`[data-inv-select="${CSS.escape(id)}"]`) || rootEl().querySelector('[data-inv-bulk="clear"]');
      again?.focus();
    } else if (target.matches('[data-inv-select-all]')) {
      const visible = filtered();
      if (target.checked) visible.forEach((item) => state.selected.add(String(item.id))); else state.selected.clear();
      renderItemsOnly();
    }
  }

  let searchTimer = null;
  function onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !rootEl().contains(target)) return;
    if (target.matches('[data-inv-search]')) {
      state.query = target.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(renderItemsOnly, 120);
    } else if (target.matches('[data-inv-movement-search]')) {
      state.movementQuery = target.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => { render(); const input = rootEl().querySelector('[data-inv-movement-search]'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }, 150);
    }
  }

  // ---------------------------------------------------------------------------
  // Views, routes, actions, Home
  // ---------------------------------------------------------------------------
  function topBar() {
    root.AtlasChrome?.setTopBar?.({ actions: [{ icon: 'scan-line', label: 'Identify item', run: () => openIdentify() }] });
  }

  function onShow(view, params) {
    state.view = view;
    state.params = { ...(params || {}) };
    if (view === 'inventory' && params?.filter) {
      const filter = String(params.filter);
      state.status = ['below-par', 'out', 'not-counted'].includes(filter) ? filter : state.status;
      if (filter === 'inactive') state.activity = 'inactive';
    }
    if (view === 'inventory' && params?.q != null) state.query = String(params.q);
    // #inventory/movements?movement=<id> (Atlas AI evidence links) opens the
    // ledger on that record: filters are cleared so the row is present.
    state.focusMovement = view === 'movements' && params?.movement ? String(params.movement) : null;
    if (state.focusMovement) { state.movementQuery = ''; state.movementType = null; }
    const countSession = view === 'inventory' && params?.section === 'stock-count' && params?.session;
    if (!countSession) render();
    if (state.focusMovement) {
      const row = rootEl().querySelector(`tr[data-movement-id="${CSS.escape(state.focusMovement)}"]`);
      if (row && row.offsetParent !== null) row.scrollIntoView({ block: 'center' });
      else rootEl().querySelector(`[data-movement-id="${CSS.escape(state.focusMovement)}"]`)?.scrollIntoView({ block: 'center' });
    }
    if (countSession) root.AtlasStockCounts?.openSession?.(params.session, { mount: rootEl() });
    else if (!params?.item) topBar();
    if (view === 'inventory' && params?.item) {
      if (!state.rendered || !rootEl().querySelector('[data-inv-body]')) render();
      showDetail(params.item, params.section === 'recipes' ? 'recipes' : null);
    } else if (detail) closeDetail();
    if (!params?.item && state.returnFocusId) {
      const id = state.returnFocusId;
      state.returnFocusId = null;
      const link = [...rootEl().querySelectorAll('[data-inv-open]')].find((node) => node.dataset.invOpen === id && node.offsetParent !== null);
      link?.focus({ preventScroll: false });
    }
  }

  function onHide() {
    if (detail) closeDetail();
    root.AtlasStockCounts?.leave?.();
  }

  // ---------------------------------------------------------------------------
  // Home › Needs attention ('inventory' key). Out-of-stock items name the
  // recipes they stop; below-par items group into one row; unknown stock asks
  // for a count instead of guessing. Stock count and Purchasing contribute
  // their own rows ('stock-count', 'purchasing').
  // ---------------------------------------------------------------------------
  function nameList(names, max = 2) {
    const shown = names.slice(0, max);
    if (names.length > max) return `${shown.join(', ')} and ${names.length - max} more`;
    if (shown.length < 2) return shown.join('');
    return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  }
  function recipeNamesUsing(itemId) {
    return recipes().filter((recipe) => recipe.active !== false
      && (recipe.recipe_ingredients || []).some((ingredient) => String(ingredient.item_id) === String(itemId)))
      .map((recipe) => recipe.name);
  }
  function homeRows() {
    if (!shell.dataLoadedAt?.() || dataStatus().items === 'error') return [];
    const stock = truth();
    const active = items().filter((item) => item.active !== false);
    if (!stock || !active.length) return [];
    const known = active.filter((item) => stock.stockStatus(item) !== 'unknown');
    const rows = [];
    if (!known.length) {
      rows.push({ id: 'not-counted', severity: 'info', icon: 'list-checks', title: 'Stock isn’t counted yet', detail: `${active.length} ${active.length === 1 ? 'item has' : 'items have'} no verified count, so Atlas can’t tell what’s low.`, action: { label: 'Start stock count', actionId: 'inventory.count.start' }, roles: STAFF });
      rows.push({ id: 'not-counted-view', severity: 'info', icon: 'list-checks', title: 'Stock isn’t counted yet', detail: 'Low stock shows here once a count is verified.', action: { label: 'View inventory', route: '#inventory' }, roles: ['viewer'] });
      return rows;
    }
    // The canonical partition: out and below par are separate sets.
    const out = known.filter((item) => stock.stockStatus(item) === 'out');
    const below = known.filter((item) => stock.stockStatus(item) === 'below_par');
    const ordered = root.AtlasPurchaseOrders?.openItemIds?.() || new Set();
    out.slice(0, 3).forEach((item) => {
      const affected = recipeNamesUsing(item.id);
      const onOrder = ordered.has(item.id);
      const detail = `${affected.length ? `${nameList(affected)} ${affected.length === 1 ? 'is' : 'are'} affected` : `0 of ${qty(item.par_level)} ${unitWord(item)} left`}${onOrder ? ' · on order' : ''}`;
      const view = { label: 'View item', route: `#inventory/item/${encodeURIComponent(item.id)}` };
      rows.push({ id: `out:${item.id}`, severity: 'danger', icon: 'package', title: `${item.name}: out of stock`, detail, action: onOrder ? view : { label: 'Add to order', actionId: 'purchasing.order.new', record: { type: 'inventory_item', id: item.id, label: item.name } }, roles: MANAGERS });
      rows.push({ id: `out-view:${item.id}`, severity: 'danger', icon: 'package', title: `${item.name}: out of stock`, detail, action: view, roles: ['bartender', 'viewer'] });
    });
    const low = below;
    if (low.length === 1) {
      const item = low[0];
      rows.push({ id: `low:${item.id}`, severity: 'warning', icon: 'package', title: `${item.name} is below par`, detail: `${qty(item.quantity)} of ${qty(item.par_level)} ${unitWord(item)} left`, action: { label: 'View items', route: '#inventory?filter=below-par' } });
    } else if (low.length > 1) {
      rows.push({ id: 'low', severity: 'warning', icon: 'package', title: `${low.length} items are below par`, detail: nameList(low.map((item) => item.name), 3), action: { label: 'View items', route: '#inventory?filter=below-par' } });
    }
    return rows;
  }

  function register() {
    const definition = (view) => ({ root: () => rootEl(), title: 'Inventory', display: 'block', data: 'shell', onShow: (params) => onShow(view, params), onHide });
    shell.registerView('inventory', definition('inventory'));
    shell.home?.contribute?.('inventory', { focusRows: homeRows, order: 10 });
    shell.registerView('movements', { ...definition('movements'), guard: () => (isManager() ? true : 'inventory') });
    shell.registerView('waste', { ...definition('waste'), guard: () => (isManager() ? true : 'inventory') });

    const actions = [
      { id: 'inventory.item.add', label: 'Add item', icon: 'package-plus', keywords: ['new item', 'product', 'inventory'], roles: MANAGERS, contexts: ['home', 'inventory'], run: () => { shell.navigate('#inventory'); openAddItemSheet(); } },
      { id: 'inventory.product.scan', label: 'Add product by camera', icon: 'scan-line', keywords: ['scan', 'photo', 'new product', 'camera'], roles: MANAGERS, contexts: ['inventory'], run: () => openAddProductByCamera() },
      { id: 'inventory.scan', label: 'Identify item', icon: 'scan-search', keywords: ['scan', 'barcode', 'what is this', 'identify', 'camera'], roles: ['admin', 'manager', 'bartender', 'viewer'], contexts: ['home', 'inventory'], run: () => openIdentify() },
      { id: 'inventory.waste.record', label: 'Record waste', icon: 'trash-2', keywords: ['waste', 'spoilage', 'breakage', 'spill'], roles: MANAGERS, contexts: ['inventory'], forRecord: 'inventory_item', recordLabel: 'Record waste for {name}', run: (ctx) => openWasteDialog(ctx?.record?.type === 'inventory_item' ? ctx.record.id : null) },
      { id: 'inventory.item.deactivate', label: 'Deactivate item', icon: 'archive', keywords: ['deactivate', 'archive', 'remove'], roles: MANAGERS, forRecord: 'inventory_item', recordLabel: 'Deactivate {name}', when: (ctx) => Boolean(ctx?.record?.id), run: (ctx) => { const item = itemById(ctx.record.id); if (item) openActivation(item, item.active === false); } }
    ];
    const registerAction = (action) => shell.actions.register({ ...action, denied: () => toast(`${action.label} is for managers. Ask an administrator if you need access.`, { icon: false }) });
    // Add item first; the rest after every module has loaded, so the palette
    // suggests Add item and Start stock count (stock-count-workspace.js) first.
    registerAction(actions[0]);
    const registerRest = () => actions.slice(1).forEach(registerAction);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', registerRest, { once: true });
    else registerRest();

    shell.onDataLoaded(() => {
      if (dataStatus().items !== 'error') state.lastLoadedAt = new Date();
      const current = shell.current();
      if (['inventory', 'movements', 'waste'].includes(current)) {
        const params = shell.params();
        if (params.section === 'stock-count') return;
        if (params.item) { render(); showDetail(params.item); }
        else render();
      }
    });
    shell.on('profile:ready', () => { if (['inventory', 'movements', 'waste'].includes(shell.current())) render(); });

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
  }

  root.AtlasInventory = Object.freeze({
    showBelowPar: () => shell.navigate('#inventory?filter=below-par'),
    openItem,
    openIdentify,
    openAddItem: (options) => openAddItemSheet(options || {}),
    openAddProductByCamera,
    stockStatus,
    homeRows,
    inventoryGroup,
    inventorySubcategory,
    unknownSheet,
    searchSheet,
    wrongProduct,
    draftFromDetection,
    recognitionRef,
    recordRecognitionChoice,
    recordRecognitionOutcome,
    duplicatesHtml,
    render
  });

  register();
})(window);
