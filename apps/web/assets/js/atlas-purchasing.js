// Purchasing (spec §7.8): Orders · Deliveries · Suppliers on purchasing v2.
//
// Commands go through rpc('atlas_purchase_order_command_v2') only; which
// buttons show comes from rpc('atlas_purchase_order_policy') and the order's
// own detail (rpc('atlas_purchase_order_detail')). "Mark as ordered" records
// that the manager ordered it: Atlas never sends anything to a supplier.
// Receiving records stock through the same command (one request id per
// submit, so a retry never receives twice). Photos only propose which lines
// arrived; a person always confirms the quantities.
(function (root) {
  'use strict';
  // Native date picker (design system: forms use the platform date and time
  // controls). The value is 'YYYY-MM-DD'; AtlasVenueClock validates it inline.
  const DATE_FIELD = 'type="date"';

  const shell = root.AtlasShell;
  if (!shell || root.AtlasPurchasing) return;

  const MANAGERS = ['admin', 'manager'];
  const OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'ordered', 'partially_received'];
  const STATUS = {
    draft: ['Draft', 'warning'],
    pending_approval: ['Needs approval', 'info'],
    approved: ['Approved', 'positive'],
    ordered: ['Ordered', 'info'],
    partially_received: ['Partly received', 'warning'],
    received: ['Received', 'positive'],
    cancelled: ['Cancelled', '']
  };
  const FLOW = [['draft', 'Draft'], ['pending_approval', 'Needs approval'], ['approved', 'Approved'], ['ordered', 'Ordered'], ['partially_received', 'Partly received'], ['received', 'Received']];
  const ERRORS = [
    [/order changed|refresh before continuing/i, 'This order changed on another device. It’s been refreshed; check it and try again.'],
    [/choose an active supplier/i, 'Choose an active supplier.'],
    [/1 to 100 order lines/i, 'Add between 1 and 100 lines.'],
    [/invalid order quantity or unit cost|invalid receipt quantity/i, 'Check the quantities and costs: quantities above 0, costs 0 or more.'],
    [/one line per inventory item|one receipt line per/i, 'Each item can only be on the order once.'],
    [/order item is unavailable/i, 'One of the items is inactive. Remove it from the order.'],
    [/delivery date cannot be in the past/i, 'Choose today or a later delivery date.'],
    [/does not need approval/i, 'This order doesn’t need approval. Mark it as ordered instead.'],
    [/needs approval before it is placed/i, 'This order needs approval before it’s marked as ordered.'],
    [/expected delivery date before placing/i, 'Set an expected delivery date first.'],
    [/only an administrator can approve/i, 'Only an administrator can approve orders.'],
    [/another manager must approve/i, 'Another manager needs to approve this order.'],
    [/reason .*required/i, 'Add a reason.'],
    [/received lines and cannot be cancelled/i, 'Part of this order was received, so it can’t be cancelled.'],
    [/closing an order with missing lines is not enabled/i, 'Closing an order short is switched off in Settings.'],
    [/more than was ordered/i, 'That’s more than was ordered. Check the quantities.'],
    [/order item changed/i, 'An item on this order changed. Check the order before receiving.'],
    [/nothing remains to be received/i, 'Everything on this order has been received.'],
    [/already used for different quantities/i, 'This delivery was already recorded with other quantities. Refresh the order.'],
    [/not allowed for the current order state/i, 'The order’s status changed. Refresh and try again.'],
    [/manager access required|42501|permission denied/i, 'Purchasing is for managers.'],
    [/already belongs to a different request/i, 'An order with other lines was already created for this supplier. Check Orders before creating it again.'],
    [/order not found/i, 'This order no longer exists.']
  ];

  const state = {
    params: {},
    section: 'orders',
    orders: [],
    ordersLoaded: false,
    ordersError: null,
    policy: null,
    statusFilter: null,
    supplierFilter: null,
    supplierQuery: '',
    detailSheet: null,
    supplierSheet: null
  };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icon = (name) => `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
  const lucide = () => root.lucide?.createIcons?.();
  const clock = () => root.AtlasVenueClock;
  const role = () => shell.profile?.()?.role || root.atlasCurrentProfile?.role || null;
  const isManager = () => MANAGERS.includes(role());
  const toast = (message, options) => shell.toast?.(message, options);
  const uuid = () => (root.crypto?.randomUUID ? root.crypto.randomUUID() : root.AtlasCapture?.uuid?.());
  const client = () => root.atlasSupabase;

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const qty = (value) => (num(value) === null ? '—' : num(value).toLocaleString('en-GB', { maximumFractionDigits: 3 }));
  const money = (value) => (num(value) === null ? '—' : (clock()?.formatKr ? clock().formatKr(num(value)) : `${Math.round(num(value))} kr`));
  const dateText = (value, options) => (value && clock()?.formatDate ? clock().formatDate(value, options || {}) : '');
  const dateTimeText = (value) => (value && clock()?.formatDateTime ? clock().formatDateTime(value) : '');
  const today = () => clock()?.today?.() || '';

  function items() { return root.AtlasData?.items?.() || []; }
  function suppliers() { return root.AtlasData?.suppliers?.() || []; }
  function movements() { return root.AtlasData?.movements?.() || []; }
  function supplierById(id) { return suppliers().find((supplier) => String(supplier.id) === String(id)) || null; }
  function itemById(id) { return items().find((item) => String(item.id) === String(id)) || null; }
  function supplierName(order) { return supplierById(order.supplier_id)?.name || 'Supplier'; }
  // What is on the order, in words (never a UUID fragment, review P3).
  function orderSummary(order) {
    const names = linesOf(order).map((line) => line.item_name || itemById(line.item_id)?.name).filter(Boolean);
    if (!names.length) return '';
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  }
  // Rows are read defensively: a wrongly shaped answer is never a crash.
  function linesOf(order) { return Array.isArray(order?.lines) ? order.lines : []; }
  function orderTotal(order) { return linesOf(order).reduce((sum, line) => sum + (num(line.quantity) || 0) * (num(line.unit_cost) || 0), 0); }

  function friendlyError(error) {
    const text = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ');
    const match = ERRORS.find(([pattern]) => pattern.test(text));
    if (match) return match[1];
    if (root.navigator?.onLine === false) return 'You’re offline. Nothing was saved; reconnect and try again.';
    return 'That didn’t go through. Nothing was changed; refresh the order and try again.';
  }

  // Errors Purchasing shows carry fixed copy only (AtlasApi.fixed); anything
  // else (a JavaScript error, server text) reads as the fallback via shown().
  function fixedError(text, props = {}) {
    return root.AtlasApi?.fixed ? root.AtlasApi.fixed(text, props) : Object.assign(new Error(text), props, { atlasFixed: true });
  }
  function shown(error, fallback = 'That didn’t go through. Nothing was changed; refresh the order and try again.') {
    if (root.AtlasApi?.message) return root.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }
  function isNotFound(error) {
    return /order not found|no longer exists/i.test([error?.raw?.message, error?.message].filter(Boolean).join(' ')) || error?.raw?.code === 'P0002';
  }

  async function rpc(name, args) {
    if (!client()) throw fixedError('Purchasing isn’t available right now.');
    if (root.navigator?.onLine === false && name === 'atlas_purchase_order_command_v2') throw fixedError('You’re offline. Nothing was saved; reconnect and try again.');
    const { data, error } = await client().rpc(name, args);
    if (error) throw fixedError(friendlyError(error), { raw: error });
    return data;
  }

  async function command(action, args) {
    const row = await rpc('atlas_purchase_order_command_v2', {
      p_id: args.id, p_action: action, p_version: args.version ?? null, p_supplier_id: args.supplierId ?? null, p_lines: args.lines ?? null,
      p_note: args.note ?? '', p_expected_delivery_date: args.deliveryDate || null, p_receipt: args.receipt ?? null,
      p_request_id: args.requestId ?? null, p_reason: args.reason ?? null
    });
    const updated = Array.isArray(row) ? row[0] : row;
    if (updated?.id) {
      const index = state.orders.findIndex((order) => order.id === updated.id);
      if (index >= 0) state.orders[index] = updated; else state.orders.unshift(updated);
      announceOrders();
    }
    return updated;
  }

  async function loadOrders() {
    if (!isManager() || !client()) return;
    try {
      const { data, error } = await client().from('purchase_orders').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      state.orders = Array.isArray(data) ? data.filter((order) => order && typeof order === 'object' && order.id) : [];
      state.ordersError = null;
    } catch (_) {
      state.ordersError = 'Orders couldn’t be loaded. Your orders are safe; check your connection and try again.';
    }
    state.ordersLoaded = true;
    announceOrders();
  }

  async function loadPolicy() {
    if (!isManager()) return null;
    try { state.policy = (await rpc('atlas_purchase_order_policy', {})) || null; } catch (_) { state.policy = state.policy || null; }
    return state.policy;
  }

  function announceOrders() {
    root.dispatchEvent(new CustomEvent('atlas:purchase-orders-updated'));
    shell.emit?.('notify:changed', { source: 'purchasing' });
  }

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------
  function openOverlay(panelHtml, { className = 'atlas-sheet atlas-sheet--wide', onClose, label } = {}) {
    const host = document.createElement('div');
    host.className = 'atlas-modal';
    host.dataset.atlasModal = '';
    host.hidden = true;
    host.innerHTML = `<section class="${className}" data-modal-panel role="dialog" aria-modal="true"${label ? ` aria-label="${esc(label)}"` : ''}>${panelHtml}</section>`;
    document.body.appendChild(host);
    root.AtlasModal.register(host, { onClose: (reason) => { onClose?.(reason); root.setTimeout(() => host.remove(), 0); } });
    root.AtlasModal.open(host);
    lucide();
    return { host, panel: host.firstElementChild, close: (reason) => root.AtlasModal.close(host, reason) };
  }
  function sheetHtml({ title, desc = '', body, foot = '', headExtra = '' }) {
    return `<span class="atlas-sheet__grabber" aria-hidden="true"></span><header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title">${esc(title)}</h2>${desc ? `<p class="atlas-sheet__desc">${desc}</p>` : ''}${headExtra}</div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header><div class="atlas-sheet__body">${body}</div>${foot ? `<footer class="atlas-sheet__foot">${foot}</footer>` : ''}`;
  }
  function alertHtml(tone, title, body = '', action = '') {
    const glyph = tone === 'danger' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : tone === 'positive' ? 'circle-check' : 'info';
    return `<div class="atlas-alert atlas-alert--${tone}"${tone === 'danger' ? ' role="alert"' : ''}>${icon(glyph)}<div class="atlas-alert__content">${title ? `<p class="atlas-alert__title">${esc(title)}</p>` : ''}${body ? `<p class="atlas-alert__body">${esc(body)}</p>` : ''}</div>${action ? `<div class="atlas-alert__actions">${action}</div>` : ''}</div>`;
  }
  function busy(button, on) {
    if (!button) return;
    button.disabled = on;
    button.classList.toggle('is-loading', on);
    if (on) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
  }
  function confirmDialog({ title, body, confirm, tone = 'primary', field = null }) {
    return new Promise((resolve) => {
      let answered = false;
      const overlay = openOverlay(`<h2 class="atlas-dialog__title">${esc(title)}</h2><form class="atlas-dialog__body" id="po-dialog-form"><p>${esc(body)}</p>${field ? `<div class="atlas-field"><label for="po-dialog-field">${esc(field.label)}</label><textarea class="atlas-textarea" id="po-dialog-field" name="value" maxlength="1000" rows="3" ${field.required ? 'required' : ''}></textarea></div>` : ''}</form><div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="po-dialog-form" class="atlas-btn atlas-btn--${tone}">${esc(confirm)}</button></div>`,
        { className: `atlas-dialog${field ? ' atlas-dialog--form' : ''}`, onClose: () => { if (!answered) resolve(null); } });
      overlay.panel.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const input = overlay.panel.querySelector('#po-dialog-field');
        const value = input ? input.value.trim() : true;
        if (field?.required && !value) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        answered = true;
        resolve(value);
        overlay.close('confirm');
      });
    });
  }
  function statusPill(order) {
    if (order.status === 'received' && order.closed_short) return '<span class="atlas-pill atlas-pill--warning">Closed short</span>';
    if (['ordered', 'partially_received'].includes(order.status) && order.expected_delivery_date && order.expected_delivery_date < today()) return `<span class="atlas-pill atlas-pill--danger">Overdue</span>`;
    const [label, tone] = STATUS[order.status] || [String(order.status || '').replace(/_/g, ' '), ''];
    return `<span class="atlas-pill${tone ? ` atlas-pill--${tone}` : ''}">${esc(label)}</span>`;
  }
  function deliveryText(order) {
    if (!order.expected_delivery_date) return '—';
    if (order.expected_delivery_date === today()) return 'Today';
    return dateText(order.expected_delivery_date);
  }

  // ---------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------
  function rootEl() {
    let element = document.getElementById('suppliers-view');
    if (!element) {
      element = document.createElement('div');
      element.id = 'suppliers-view';
      document.getElementById('atlas-main')?.appendChild(element);
    }
    element.classList.add('po');
    return element;
  }

  function subtitle() {
    const open = state.orders.filter((order) => OPEN_STATUSES.includes(order.status));
    const waiting = state.orders.filter((order) => order.status === 'pending_approval').length;
    if (!state.ordersLoaded || (state.ordersError && !state.orders.length)) return 'Orders, deliveries and suppliers';
    return `${open.length} open ${open.length === 1 ? 'order' : 'orders'}${waiting ? ` · ${waiting} waiting for approval` : ''}`;
  }

  function render() {
    const element = rootEl();
    if (!isManager()) {
      element.innerHTML = `${shell.pageHead({ title: 'Purchasing' })}<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon">${icon('lock')}</div><h3 class="atlas-empty__title">Purchasing is for managers</h3><p class="atlas-empty__text">Orders, deliveries and suppliers are managed by managers. Ask an administrator for access.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a></div></div>`;
      lucide();
      return;
    }
    const actions = state.section === 'suppliers'
      ? [{ label: 'Add supplier', icon: 'plus', variant: 'primary', attrs: { 'data-po-add-supplier': '' } }]
      : [{ label: 'Receive delivery', icon: 'package-check', variant: 'secondary', attrs: { 'data-po-receive-any': '' } }, { label: 'New order', icon: 'plus', variant: 'primary', attrs: { 'data-po-new': '' } }];
    const tabs = [['orders', 'Orders', '#purchasing/orders'], ['deliveries', 'Deliveries', '#purchasing/deliveries'], ['suppliers', 'Suppliers', '#purchasing/suppliers']];
    element.innerHTML = `${shell.pageHead({ title: 'Purchasing', sub: subtitle(), actions })}
      <nav class="atlas-tabs" aria-label="Purchasing sections">${tabs.map(([key, label, href]) => `<a href="${href}"${key === state.section ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div class="po__body" data-po-body></div>`;
    const body = element.querySelector('[data-po-body]');
    if (state.section === 'suppliers') renderSuppliers(body);
    else if (state.section === 'deliveries') renderDeliveries(body);
    else renderOrders(body);
    lucide();
  }

  function loadingRows() {
    return `<div class="atlas-table-wrap" aria-busy="true"><div class="po-skeleton">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(6)}</div></div>`;
  }

  // Suggested order: the canonical AtlasOperations.orderSuggestions for items
  // not on any open order. Items already on a draft, pending, approved or
  // placed order are listed separately with their order's state, never
  // suggested again silently (S90 P2-7).
  const ON_ORDER_LABEL = {
    draft: 'on a draft order',
    pending_approval: 'on an order waiting for approval',
    approved: 'on an approved order',
    ordered: 'on order',
    partially_received: 'on a partly received order'
  };
  function itemOrderStatus(itemId) {
    let furthest = null;
    for (const order of state.orders) {
      if (!OPEN_STATUSES.includes(order.status)) continue;
      if (!linesOf(order).some((line) => String(line?.item_id) === String(itemId))) continue;
      if (furthest === null || OPEN_STATUSES.indexOf(order.status) > OPEN_STATUSES.indexOf(furthest)) furthest = order.status;
    }
    return furthest;
  }
  function suggestions() {
    const list = root.AtlasOperations?.orderSuggestions?.() || [];
    const ordered = root.AtlasPurchaseOrders.openItemIds();
    return list.filter((entry) => !entry.ordered && !ordered.has(entry.id));
  }
  function suggestionsOnOrder() {
    const list = root.AtlasOperations?.orderSuggestions?.() || [];
    return list.map((entry) => ({ ...entry, orderStatus: itemOrderStatus(entry.id) })).filter((entry) => entry.orderStatus);
  }
  function onOrderNote(list) {
    if (!list.length) return '';
    return `<p class="po__muted" data-po-on-order>Not suggested again: ${list.map((entry) => `${esc(entry.name)} (${esc(ON_ORDER_LABEL[entry.orderStatus] || 'on an open order')})`).join(', ')}.</p>`;
  }
  function suggestionGroups() {
    const groups = new Map();
    suggestions().forEach((entry) => {
      const item = itemById(entry.id) || {};
      const supplier = item.supplier_id ? supplierById(item.supplier_id) : suppliers().find((candidate) => candidate.name === entry.supplier) || null;
      const key = supplier?.id || `name:${entry.supplier}`;
      if (!groups.has(key)) groups.set(key, { supplier, name: supplier?.name || entry.supplier, lines: [] });
      groups.get(key).lines.push({ ...entry, item });
    });
    return [...groups.values()].sort((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name));
  }

  function suggestedCard() {
    const groups = suggestionGroups();
    const count = groups.reduce((sum, group) => sum + group.lines.length, 0);
    if (!count) return '';
    return `<section class="atlas-card atlas-card--pad po-suggest" aria-labelledby="po-suggest-title">
      <div class="po-suggest__text"><h2 class="po-suggest__title" id="po-suggest-title">Suggested order</h2>
      <p>${count} ${count === 1 ? 'item is' : 'items are'} below par across ${groups.length} ${groups.length === 1 ? 'supplier' : 'suppliers'}.</p>
      <p class="po__muted">${groups.slice(0, 4).map((group) => `${esc(group.name)} ${group.lines.length}`).join(' · ')}</p>${onOrderNote(suggestionsOnOrder())}</div>
      <button type="button" class="atlas-btn atlas-btn--secondary" data-po-suggestions>Review suggestions</button></section>`;
  }

  function filterChip(label, { active = false, clear = '', menu = '' }) {
    if (active) return `<button type="button" class="atlas-chip is-active" data-po-clear="${esc(clear)}" aria-label="${esc(label)}. Clear this filter">${esc(label)}<span class="atlas-chip__clear" aria-hidden="true">${icon('x')}</span></button>`;
    return `<button type="button" class="atlas-chip" data-po-menu-trigger="${esc(menu)}">${esc(label)}${icon('chevron-down')}</button>`;
  }

  function ordersTable(list, { deliveries = false } = {}) {
    if (!list.length) return '';
    return `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table">
      <thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th class="is-num" data-priority="2">Lines</th><th class="is-num">Total</th><th>${deliveries ? 'Expected' : 'Delivery'}</th><th class="col-actions"><span class="sr-only">Open</span></th></tr></thead>
      <tbody>${list.map((order) => `<tr data-po-open="${esc(order.id)}"><td><a class="cell-primary" href="#purchasing/order/${encodeURIComponent(order.id)}">${esc(dateText(order.created_at) || 'Order')}</a><span class="cell-sub">${esc(orderSummary(order))}</span></td><td class="po-col--text"><span class="cell-clip" title="${esc(supplierName(order))}">${esc(supplierName(order))}</span></td><td>${statusPill(order)}</td><td class="is-num" data-priority="2">${linesOf(order).length}</td><td class="is-num">${money(orderTotal(order))}</td><td>${esc(deliveryText(order))}</td><td class="col-actions"><span class="po__chev" aria-hidden="true">${icon('chevron-right')}</span></td></tr>`).join('')}</tbody></table></div>
      <ul class="atlas-table-list">${list.map((order) => `<li><a class="atlas-table-list__row" href="#purchasing/order/${encodeURIComponent(order.id)}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(supplierName(order))}</div><div class="atlas-table-list__meta">${esc([`${linesOf(order).length} lines`, money(orderTotal(order)), order.expected_delivery_date ? `delivery ${deliveryText(order)}` : ''].filter(Boolean).join(' · '))}</div></div><div class="atlas-table-list__value">${statusPill(order)}</div></a></li>`).join('')}</ul>`;
  }

  // A failed load never reads as an empty venue: no "0 orders", no "No
  // orders yet", only what failed, that the orders are safe, and Try again.
  function ordersFailedHtml() {
    return alertHtml('danger', 'Orders couldn’t be loaded.', state.ordersError.replace('Orders couldn’t be loaded. ', ''), '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-po-retry>Try again</button>');
  }

  function renderOrders(body) {
    if (!state.ordersLoaded) { body.innerHTML = loadingRows(); return; }
    if (state.ordersError && !state.orders.length) { body.innerHTML = ordersFailedHtml(); return; }
    const list = state.orders.filter((order) => (!state.statusFilter || order.status === state.statusFilter) && (!state.supplierFilter || String(order.supplier_id) === String(state.supplierFilter)));
    const statusLabel = state.statusFilter ? (STATUS[state.statusFilter] || [state.statusFilter])[0] : null;
    const supplierLabel = state.supplierFilter ? supplierById(state.supplierFilter)?.name || 'Supplier' : null;
    const usedSuppliers = [...new Set(state.orders.map((order) => order.supplier_id).filter(Boolean))].map(supplierById).filter(Boolean);
    const empty = state.orders.length
      ? `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('search-x')}</div><h3 class="atlas-empty__title">No orders match these filters</h3><button type="button" class="atlas-btn atlas-btn--secondary" data-po-clear-all>Clear filters</button></div>`
      : `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('truck')}</div><h3 class="atlas-empty__title">No orders yet</h3><p class="atlas-empty__text">Orders you create or approve appear here with their delivery status.</p><button type="button" class="atlas-btn atlas-btn--secondary" data-po-new>New order</button></div>`;
    body.innerHTML = `${state.ordersError ? ordersFailedHtml() : ''}
      ${suggestedCard()}
      <div class="atlas-toolbar">${filterChip(statusLabel || 'Status', { active: Boolean(statusLabel), clear: 'status', menu: 'status' })}${filterChip(supplierLabel || 'Supplier', { active: Boolean(supplierLabel), clear: 'supplier', menu: 'supplier' })}<div class="atlas-toolbar__end">${list.length} ${list.length === 1 ? 'order' : 'orders'}</div></div>
      <ul class="atlas-menu" data-po-menu="status" hidden>${Object.entries(STATUS).map(([key, [label]]) => `<li><button type="button" class="atlas-menu__item" data-po-filter="status" data-value="${key}">${esc(label)}</button></li>`).join('')}</ul>
      <ul class="atlas-menu" data-po-menu="supplier" hidden>${usedSuppliers.map((supplier) => `<li><button type="button" class="atlas-menu__item" data-po-filter="supplier" data-value="${esc(supplier.id)}">${esc(supplier.name)}</button></li>`).join('') || '<li><span class="atlas-menu__label">No suppliers on orders yet</span></li>'}</ul>
      ${ordersTable(list) || empty}`;
    body.querySelectorAll('[data-po-menu-trigger]').forEach((trigger) => {
      const menu = body.querySelector(`[data-po-menu="${trigger.dataset.poMenuTrigger}"]`);
      if (menu) shell.menu(trigger, menu, { align: 'start', onSelect: (item) => { if (item.dataset.poFilter === 'status') state.statusFilter = item.dataset.value; else state.supplierFilter = item.dataset.value; render(); } });
    });
  }

  function renderDeliveries(body) {
    if (!state.ordersLoaded) { body.innerHTML = loadingRows(); return; }
    if (state.ordersError && !state.orders.length) { body.innerHTML = ordersFailedHtml(); return; }
    const list = state.orders.filter((order) => ['ordered', 'partially_received', 'received'].includes(order.status))
      .sort((a, b) => (a.status === 'received') - (b.status === 'received') || String(a.expected_delivery_date || '9999').localeCompare(String(b.expected_delivery_date || '9999')));
    body.innerHTML = `<p class="po__caption">Deliveries you’re waiting for and what has arrived. Receiving updates stock.</p>
      ${ordersTable(list, { deliveries: true }) || `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('package-check')}</div><h3 class="atlas-empty__title">No deliveries expected</h3><p class="atlas-empty__text">Orders you mark as ordered appear here until they’re received.</p></div>`}`;
  }

  function supplierStats(supplier) {
    const supplierItems = items().filter((item) => String(item.supplier_id || '') === String(supplier.id) || (!item.supplier_id && item.supplier === supplier.name));
    const openOrders = state.orders.filter((order) => String(order.supplier_id) === String(supplier.id) && OPEN_STATUSES.includes(order.status));
    const cutoff = Date.now() - 30 * 86400000;
    const restocks = movements().filter((entry) => entry.movement_type === 'restock' && (String(entry.supplier_id || '') === String(supplier.id) || entry.suppliers?.name === supplier.name));
    const recent = restocks.filter((entry) => Date.parse(entry.created_at) >= cutoff);
    const costed = recent.filter((entry) => num(entry.total_cost) !== null);
    const spend = costed.length ? costed.reduce((sum, entry) => sum + num(entry.total_cost), 0) : null;
    const lastDelivery = restocks.reduce((latest, entry) => (!latest || entry.created_at > latest ? entry.created_at : latest), null);
    return { supplierItems, openOrders, spend, lastDelivery };
  }

  function renderSuppliers(body) {
    const health = root.AtlasData?.health?.() || {};
    if (health.suppliers === 'loading' && !suppliers().length) { body.innerHTML = loadingRows(); return; }
    if (health.suppliers === 'failed' && !suppliers().length) {
      body.innerHTML = alertHtml('danger', 'Suppliers couldn’t be loaded.', 'Your suppliers and orders are safe. Check your connection and try again.', '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-po-retry-data>Try again</button>');
      return;
    }
    const query = state.supplierQuery.trim().toLowerCase();
    const list = suppliers().filter((supplier) => !query || [supplier.name, supplier.contact_name, supplier.email].some((value) => String(value || '').toLowerCase().includes(query)));
    const rows = list.map((supplier) => ({ supplier, ...supplierStats(supplier) }));
    body.innerHTML = `<div class="atlas-toolbar"><label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" data-po-supplier-search placeholder="Search suppliers" aria-label="Search suppliers" value="${esc(state.supplierQuery)}"></label><div class="atlas-toolbar__end">${rows.length} ${rows.length === 1 ? 'supplier' : 'suppliers'}</div></div>
      ${rows.length ? `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table"><thead><tr><th>Supplier</th><th data-priority="2">Contact</th><th class="is-num">Items</th><th class="is-num">Open orders</th><th data-priority="3">Last delivery</th><th class="is-num" data-priority="2">Spend 30 days</th></tr></thead>
      <tbody>${rows.map(({ supplier, supplierItems, openOrders, spend, lastDelivery }) => `<tr data-po-supplier="${esc(supplier.id)}"><td class="po-col--text"><a class="cell-primary cell-clip" href="#purchasing/suppliers/${encodeURIComponent(supplier.id)}" title="${esc(supplier.name)}">${esc(supplier.name)}</a>${supplier.active === false ? '<span class="cell-sub">Inactive</span>' : ''}</td><td data-priority="2">${esc(supplier.contact_name || supplier.email || supplier.phone || '—')}</td><td class="is-num">${supplierItems.length}</td><td class="is-num">${openOrders.length}</td><td data-priority="3">${esc(lastDelivery ? dateText(lastDelivery) : '—')}</td><td class="is-num" data-priority="2"${spend === null ? ' title="No costed deliveries in the last 30 days"' : ''}>${spend === null ? '—' : money(spend)}</td></tr>`).join('')}</tbody></table></div>
      <ul class="atlas-table-list">${rows.map(({ supplier, supplierItems, openOrders }) => `<li><a class="atlas-table-list__row" href="#purchasing/suppliers/${encodeURIComponent(supplier.id)}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${esc(supplier.name)}</div><div class="atlas-table-list__meta">${esc([supplier.contact_name, `${supplierItems.length} items`].filter(Boolean).join(' · '))}</div></div><div class="atlas-table-list__value">${openOrders.length ? `${openOrders.length} open` : ''}</div></a></li>`).join('')}</ul>
      <div class="atlas-table-foot"><span></span><span>Spend shows only where deliveries were recorded with a cost.</span></div>`
    : `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('store')}</div><h3 class="atlas-empty__title">${suppliers().length ? `No suppliers match “${esc(state.supplierQuery)}”` : 'No suppliers yet'}</h3><p class="atlas-empty__text">${suppliers().length ? 'Clear the search to see every supplier.' : 'Add the suppliers you order from to create orders and track deliveries.'}</p>${suppliers().length ? '' : '<button type="button" class="atlas-btn atlas-btn--secondary" data-po-add-supplier>Add supplier</button>'}</div>`}`;
  }

  // ---------------------------------------------------------------------------
  // New / edit order
  // ---------------------------------------------------------------------------
  function lineRowHtml(line = {}, index = 0) {
    const active = items().filter((item) => item.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return `<div class="po-line" data-po-line>
      <div class="atlas-field po-line__item"><label for="po-line-item-${index}">Item</label><select class="atlas-select" id="po-line-item-${index}" data-po-line-item required><option value="">Choose an item</option>${active.map((item) => `<option value="${esc(item.id)}" data-cost="${esc(item.cost_price ?? '')}" data-unit="${esc(item.unit || '')}"${String(item.id) === String(line.item_id) ? ' selected' : ''}>${esc(item.name)}${item.unit ? ` (${esc(item.unit)})` : ''}</option>`).join('')}</select></div>
      <div class="atlas-field po-line__qty"><label for="po-line-qty-${index}">Quantity</label><input class="atlas-input" id="po-line-qty-${index}" data-po-line-qty type="number" inputmode="decimal" min="0.001" step="any" value="${esc(line.quantity ?? 1)}" required></div>
      <div class="atlas-field po-line__cost"><label for="po-line-cost-${index}">Unit cost</label><div class="atlas-affix"><input class="atlas-input" id="po-line-cost-${index}" data-po-line-cost type="number" inputmode="decimal" min="0" step="any" value="${esc(line.unit_cost ?? '')}" required><span class="suffix">kr</span></div></div>
      <button type="button" class="atlas-icon-btn po-line__remove" data-po-remove-line aria-label="Remove line">${icon('trash-2')}</button>
    </div>`;
  }

  function openOrderSheet({ order = null, itemIds = [], supplierId = null } = {}) {
    if (!isManager()) { toast('Purchasing is for managers.', { tone: 'info' }); return; }
    const editing = Boolean(order);
    const presetLines = order ? order.lines : itemIds.map((id) => ({ item_id: id, quantity: 1, unit_cost: itemById(id)?.cost_price ?? '' }));
    const inferredSupplier = supplierId || order?.supplier_id || (itemIds.length ? itemById(itemIds[0])?.supplier_id : null) || '';
    const id = order?.id || uuid();
    const active = suppliers().filter((supplier) => supplier.active !== false);
    const overlay = openOverlay(sheetHtml({
      title: editing ? 'Edit order' : 'New order',
      desc: 'Atlas doesn’t send orders to suppliers. Send it as you usually do, then mark it as ordered.',
      body: `<form class="atlas-form" id="po-order-form" novalidate><div data-po-alert></div>
        ${active.length ? '' : alertHtml('warning', 'No active suppliers', 'Add a supplier before creating an order.', '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-po-add-supplier>Add supplier</button>')}
        <div class="atlas-grid-2"><div class="atlas-field"><label for="po-supplier">Supplier</label><select class="atlas-select" id="po-supplier" name="supplier" required><option value="">Choose a supplier</option>${active.map((supplier) => `<option value="${esc(supplier.id)}"${String(supplier.id) === String(inferredSupplier) ? ' selected' : ''}>${esc(supplier.name)}</option>`).join('')}</select></div>
        <div class="atlas-field"><label for="po-date">Expected delivery <span class="optional">(optional)</span></label><input class="atlas-input" id="po-date" name="date" ${DATE_FIELD} min="${esc(today())}" value="${esc(order?.expected_delivery_date || '')}"></div></div>
        <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Lines</legend><div data-po-lines>${(presetLines.length ? presetLines : [{}]).map(lineRowHtml).join('')}</div>
        <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-po-add-line>${icon('plus')}Add line</button></fieldset>
        <div class="atlas-field"><label for="po-note">Note <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="po-note" name="note" maxlength="2000">${esc(order?.note || '')}</textarea></div>
        <p class="po__total" data-po-total></p></form>`,
      foot: `<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="po-order-form" class="atlas-btn atlas-btn--primary" data-po-save>${editing ? 'Save order' : 'Create order'}</button>`
    }), { label: editing ? 'Edit order' : 'New order' });
    const form = overlay.panel.querySelector('#po-order-form');
    const linesHost = form.querySelector('[data-po-lines]');
    const totalNode = form.querySelector('[data-po-total]');
    const updateTotal = () => {
      const total = [...linesHost.querySelectorAll('[data-po-line]')].reduce((sum, row) => sum + (Number(row.querySelector('[data-po-line-qty]').value) || 0) * (Number(row.querySelector('[data-po-line-cost]').value) || 0), 0);
      totalNode.textContent = `Total ${money(total)}`;
    };
    updateTotal();
    form.addEventListener('input', updateTotal);
    form.addEventListener('change', (event) => {
      const select = event.target.closest('[data-po-line-item]');
      if (!select) return;
      const cost = select.selectedOptions[0]?.dataset.cost;
      const costInput = select.closest('[data-po-line]').querySelector('[data-po-line-cost]');
      if (cost !== undefined && cost !== '' && !costInput.value) costInput.value = cost;
      updateTotal();
    });
    form.addEventListener('click', (event) => {
      if (event.target.closest('[data-po-add-line]')) {
        if (linesHost.children.length >= 100) return;
        linesHost.insertAdjacentHTML('beforeend', lineRowHtml({}, linesHost.children.length + Date.now() % 1000));
        lucide();
        linesHost.lastElementChild.querySelector('select').focus();
      } else if (event.target.closest('[data-po-remove-line]')) {
        const rows = linesHost.querySelectorAll('[data-po-line]');
        if (rows.length > 1) event.target.closest('[data-po-line]').remove();
        updateTotal();
      } else if (event.target.closest('[data-po-add-supplier]')) {
        overlay.close('replace');
        openSupplierSheet();
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const alert = form.querySelector('[data-po-alert]');
      const lines = [...linesHost.querySelectorAll('[data-po-line]')].map((row) => ({ item_id: row.querySelector('[data-po-line-item]').value, quantity: Number(row.querySelector('[data-po-line-qty]').value), unit_cost: Number(row.querySelector('[data-po-line-cost]').value) }));
      const problems = [];
      if (!form.elements.supplier.value) problems.push('Choose a supplier.');
      if (lines.some((line) => !line.item_id)) problems.push('Choose an item on every line.');
      if (lines.some((line) => !(line.quantity > 0))) problems.push('Quantities must be above 0.');
      if (lines.some((line) => !(line.unit_cost >= 0) || Number.isNaN(line.unit_cost))) problems.push('Enter a unit cost of 0 or more on every line.');
      if (new Set(lines.map((line) => line.item_id)).size !== lines.length) problems.push('Each item can only be on the order once.');
      if (form.elements.date.value && form.elements.date.value < today()) problems.push('Choose today or a later delivery date.');
      if (problems.length) { alert.innerHTML = alertHtml('danger', 'Check the order', problems.join(' ')); lucide(); return; }
      const save = overlay.panel.querySelector('[data-po-save]');
      busy(save, true);
      try {
        const saved = await command(editing ? 'update' : 'create', { id, version: order?.version ?? null, supplierId: form.elements.supplier.value, lines, note: form.elements.note.value.trim(), deliveryDate: form.elements.date.value || null });
        overlay.close('done');
        toast(editing ? 'Order saved' : 'Order created', { action: { label: 'View', onClick: () => shell.navigate(`#purchasing/order/${saved?.id || id}`) } });
        render();
        if (editing) openOrderDetail(id);
      } catch (error) {
        busy(save, false);
        alert.innerHTML = alertHtml('danger', editing ? 'The order wasn’t saved.' : 'The order wasn’t created.', shown(error, 'Nothing was saved. Check your connection and try again.'));
        lucide();
      }
    });
  }

  // One stable order id per supplier group (S90 P2-1). The id is chosen when
  // the manager first presses Create and reused for every retry of that group,
  // in memory and in sessionStorage keyed by the group's suggestion
  // fingerprint (supplier + items), so a reload after a timeout still reuses
  // it. The server's create is idempotent on the id: a retry of a create that
  // did commit returns the same draft instead of a second one. Groups already
  // created are never re-sent.
  const SUGGEST_IDS_KEY = 'atlas.purchasing.suggested-order-ids.v1';
  function readSuggestIds() {
    try {
      const parsed = JSON.parse(root.sessionStorage?.getItem(SUGGEST_IDS_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }
  function writeSuggestIds(map) {
    try {
      if (Object.keys(map).length) root.sessionStorage?.setItem(SUGGEST_IDS_KEY, JSON.stringify(map));
      else root.sessionStorage?.removeItem(SUGGEST_IDS_KEY);
    } catch (_) { /* storage unavailable: the in-memory id still covers retries on this page */ }
  }
  function groupFingerprint(group) {
    return `${group.supplier?.id || group.name}|${group.lines.map((line) => String(line.id)).sort().join(',')}`;
  }

  function openSuggestionsSheet() {
    const groups = suggestionGroups();
    const orderable = groups.filter((group) => group.supplier).length;
    const overlay = openOverlay(sheetHtml({
      title: 'Suggested order',
      desc: 'Items below par, grouped by supplier. Change quantities before creating the orders.',
      body: `<form id="po-suggest-form" class="atlas-form" novalidate>${onOrderNote(suggestionsOnOrder())}${groups.map((group, gIndex) => `<fieldset class="po-group" data-po-group="${gIndex}"${group.supplier ? '' : ' disabled'}><legend class="po-group__title">${esc(group.name)} <span data-po-group-state></span></legend>
        ${group.supplier ? '' : '<p class="po__muted">These items aren’t linked to a supplier in Atlas yet, so they can’t go on an order. Link a supplier in the item details.</p>'}
        <div class="atlas-table-wrap"><table class="atlas-table atlas-table--compact"><thead><tr><th class="col-check"><span class="sr-only">Include</span></th><th>Item</th><th class="is-num">On hand</th><th class="is-num">Par</th><th class="is-num">Order</th></tr></thead><tbody>
        ${group.lines.map((line) => `<tr><td class="col-check"><input type="checkbox" class="atlas-check" data-po-include checked aria-label="Include ${esc(line.name)}" value="${esc(line.id)}"></td><td><span class="cell-primary">${esc(line.name)}</span><span class="cell-sub">${line.cases ? `${line.cases} ${line.cases === 1 ? 'case' : 'cases'} · ` : ''}${esc(line.unit)}</span></td><td class="is-num">${qty(line.item?.quantity)}</td><td class="is-num">${qty(line.item?.par_level)}</td><td class="is-num"><input class="atlas-input po-suggest__qty num" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(line.orderQuantity)}" data-po-suggest-qty="${esc(line.id)}" aria-label="Quantity of ${esc(line.name)}"></td></tr>`).join('')}
        </tbody></table></div></fieldset>`).join('')}<div data-po-alert></div></form>`,
      foot: `<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="po-suggest-form" class="atlas-btn atlas-btn--primary" data-po-create-many>Create ${orderable} ${orderable === 1 ? 'order' : 'orders'}</button>`
    }), { label: 'Suggested order' });
    const form = overlay.panel.querySelector('#po-suggest-form');
    const alert = form.querySelector('[data-po-alert]');
    const stored = readSuggestIds();
    const attempts = new Map();
    groups.forEach((group, index) => {
      if (!group.supplier) return;
      const key = groupFingerprint(group);
      attempts.set(index, { key, id: typeof stored[key] === 'string' ? stored[key] : null, created: false });
    });
    const includedLines = (group, fieldset) => group.lines.filter((line) => fieldset.querySelector(`[data-po-include][value="${CSS.escape(String(line.id))}"]`)?.checked);
    const qtyInput = (fieldset, line) => fieldset.querySelector(`[data-po-suggest-qty="${CSS.escape(String(line.id))}"]`);
    form.addEventListener('input', (event) => {
      if (event.target.matches?.('[data-po-suggest-qty]')) event.target.removeAttribute('aria-invalid');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = overlay.panel.querySelector('[data-po-create-many]');
      // A blank or non-positive quantity is a visible field error, never a
      // silent return to the suggested quantity (S90 P3).
      form.querySelectorAll('[data-po-suggest-qty][aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
      const invalid = [];
      for (const [index, group] of groups.entries()) {
        const attempt = attempts.get(index);
        if (!attempt || attempt.created) continue;
        const fieldset = form.querySelector(`[data-po-group="${index}"]`);
        includedLines(group, fieldset).forEach((line) => {
          const input = qtyInput(fieldset, line);
          const raw = String(input?.value ?? '').trim();
          if (raw === '' || !(Number(raw) > 0) || Number(raw) > 1000000) invalid.push([input, line]);
        });
      }
      if (invalid.length) {
        invalid.forEach(([input]) => { input?.setAttribute('aria-invalid', 'true'); input?.setAttribute('aria-describedby', 'po-suggest-error'); });
        alert.innerHTML = `<div id="po-suggest-error">${alertHtml('danger', 'Check the quantities', `Enter a quantity above 0 for ${invalid.map(([, line]) => line.name).join(', ')}, or untick ${invalid.length === 1 ? 'it' : 'them'}.`)}</div>`;
        lucide();
        invalid[0][0]?.focus();
        return;
      }
      busy(button, true);
      const failures = [];
      for (const [index, group] of groups.entries()) {
        const attempt = attempts.get(index);
        if (!attempt || attempt.created) continue;
        const fieldset = form.querySelector(`[data-po-group="${index}"]`);
        const lines = includedLines(group, fieldset)
          .map((line) => ({ item_id: line.id, quantity: Number(String(qtyInput(fieldset, line).value).trim()), unit_cost: num(line.item?.cost_price) ?? 0 }));
        if (!lines.length) continue;
        if (!attempt.id) {
          attempt.id = uuid();
          stored[attempt.key] = attempt.id;
          writeSuggestIds(stored);
        }
        try {
          await command('create', { id: attempt.id, supplierId: group.supplier.id, lines, note: 'Created from the suggested order' });
          attempt.created = true;
          delete stored[attempt.key];
          writeSuggestIds(stored);
          fieldset.disabled = true;
          fieldset.dataset.poCreated = '';
          fieldset.querySelector('[data-po-group-state]').innerHTML = '<span class="atlas-pill atlas-pill--positive">Draft created</span>';
        } catch (error) { failures.push(`${group.name}: ${shown(error, 'Nothing was saved for this supplier. Try again.')}`); }
      }
      busy(button, false);
      const created = [...attempts.values()].filter((attempt) => attempt.created).length;
      if (failures.length) {
        const remaining = [...attempts.values()].filter((attempt) => !attempt.created).length;
        button.textContent = `Create ${remaining} ${remaining === 1 ? 'order' : 'orders'}`;
        alert.innerHTML = alertHtml('danger', created ? `${created} created, ${failures.length} didn’t go through` : 'The orders weren’t created.', `${failures.join(' ')} Trying again only sends ${failures.length === 1 ? 'this one' : 'these'}; ${created ? 'the created drafts aren’t sent again' : 'nothing is created twice'}.`);
        lucide();
        render();
        return;
      }
      overlay.close('done');
      toast(`${created} ${created === 1 ? 'order' : 'orders'} created as drafts`);
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // Order detail (#purchasing/order/<id>)
  // ---------------------------------------------------------------------------
  function stepperHtml(order) {
    if (order.status === 'cancelled') return '<p class="po__muted">This order was cancelled.</p>';
    const flow = FLOW.filter(([key]) => key !== 'pending_approval' || state.policy?.approval_required || order.submitted_at || order.status === 'pending_approval')
      .filter(([key]) => key !== 'approved' || state.policy?.approval_required || order.approved_at || order.status === 'approved')
      .filter(([key]) => key !== 'partially_received' || order.status === 'partially_received');
    const currentIndex = flow.findIndex(([key]) => key === order.status);
    return `<ol class="atlas-steps po-steps" aria-label="Order progress">${flow.map(([key, label], index) => `${index ? '<li class="sep" aria-hidden="true"></li>' : ''}<li class="${index < currentIndex || (order.status === 'received' && index === currentIndex) ? 'is-done' : index === currentIndex ? 'is-current' : ''}"${index === currentIndex ? ' aria-current="step"' : ''}><span class="n">${index < currentIndex || (order.status === 'received' && index === currentIndex) ? icon('check') : index + 1}</span>${esc(label)}</li>`).join('')}</ol>
      <div class="atlas-steps-compact po-steps-compact"><span>Step ${currentIndex + 1} of ${flow.length} · ${esc((flow[currentIndex] || ['', ''])[1])}</span><div class="atlas-progress"><i style="width:${Math.round(((currentIndex + 1) / flow.length) * 100)}%"></i></div></div>`;
  }

  const EVENT_LABELS = { created: 'Created', updated: 'Edited', delivery_date_set: 'Delivery date changed', submitted: 'Submitted for approval', approved: 'Approved', rejected: 'Sent back', ordered: 'Marked as ordered', received: 'Received', received_partial: 'Part received', closed_short: 'Closed short', cancelled: 'Cancelled' };

  function approveBlockedReason(order, policy) {
    if (policy?.approval_approver_role === 'admin' && role() !== 'admin') return 'Only an administrator can approve this order.';
    const me = shell.profile?.()?.id || root.atlasCurrentProfile?.id || null;
    if (policy?.approval_separate_approver && me && order?.submitted_by && String(order.submitted_by) === String(me)) return 'You submitted this order, so another manager needs to approve it.';
    return null;
  }

  function detailHtml(data) {
    const order = data.order;
    const policy = data.policy || state.policy || {};
    const supplier = supplierById(order.supplier_id);
    const lines = data.lines || order.lines || [];
    const receipts = data.receipts || [];
    const events = data.events || [];
    const received = receipts.length > 0;
    const needsApproval = policy.approval_required && data.approval_needed;
    const foot = [];
    const secondary = [];
    if (order.status === 'draft') {
      secondary.push('<button type="button" class="atlas-btn atlas-btn--secondary" data-po-edit>Edit order</button>');
      if (needsApproval) foot.push('<button type="button" class="atlas-btn atlas-btn--primary" data-po-cmd="submit">Submit for approval</button>');
      else foot.push('<button type="button" class="atlas-btn atlas-btn--primary" data-po-cmd="place">Mark as ordered</button>');
    } else if (order.status === 'pending_approval') {
      secondary.push('<button type="button" class="atlas-btn atlas-btn--secondary" data-po-cmd="reject">Send back</button>');
      // Approve only when the policy lets this person approve (S90 P3); the
      // server enforces the same rules.
      const blocked = approveBlockedReason(order, policy);
      if (blocked) foot.push(`<p class="po__muted" data-po-approve-blocked>${esc(blocked)}</p>`);
      else foot.push('<button type="button" class="atlas-btn atlas-btn--primary" data-po-cmd="approve">Approve</button>');
    } else if (order.status === 'approved') {
      foot.push('<button type="button" class="atlas-btn atlas-btn--primary" data-po-cmd="place">Mark as ordered</button>');
    } else if (['ordered', 'partially_received'].includes(order.status)) {
      secondary.push('<button type="button" class="atlas-btn atlas-btn--secondary" data-po-cmd="receive">Receive all</button>');
      if (order.status === 'partially_received' && policy.short_close_enabled) secondary.push('<button type="button" class="atlas-btn atlas-btn--secondary" data-po-cmd="close_short">Close short</button>');
      foot.push('<button type="button" class="atlas-btn atlas-btn--primary" data-po-receive>Receive delivery</button>');
    }
    const canCancel = ['draft', 'pending_approval', 'approved', 'ordered'].includes(order.status) && !received;
    const canSetDate = ['draft', 'pending_approval', 'approved', 'ordered', 'partially_received'].includes(order.status);
    return sheetHtml({
      title: `${supplier?.name || 'Supplier'} order`,
      desc: esc(dateText(order.created_at, { long: true })),
      headExtra: `<div class="po-detail__pills">${statusPill(order)}${needsApproval && order.status === 'draft' ? '<span class="atlas-pill atlas-pill--info">Needs approval</span>' : ''}</div>`,
      body: `${stepperHtml(order)}
        <div data-po-alert></div>
        ${order.status === 'draft' || order.status === 'approved' ? alertHtml('info', '', 'Atlas doesn’t send orders to suppliers. Send it as you usually do, then mark it as ordered.') : ''}
        <dl class="po-detail__facts">
          <div><dt>Total</dt><dd class="num">${money(data.total ?? orderTotal(order))}</dd></div>
          <div><dt>Expected delivery</dt><dd>${order.expected_delivery_date ? esc(dateText(order.expected_delivery_date, { long: true })) : 'Not set'}${canSetDate ? ' <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-po-date>Change</button>' : ''}</dd></div>
          ${supplier?.email || supplier?.phone ? `<div><dt>Supplier contact</dt><dd>${supplier.email ? `<a href="mailto:${esc(supplier.email)}">${esc(supplier.email)}</a>` : ''}${supplier.email && supplier.phone ? ' · ' : ''}${esc(supplier.phone || '')}</dd></div>` : ''}
          ${order.close_reason ? `<div><dt>Closed short</dt><dd>${esc(order.close_reason)}</dd></div>` : ''}
        </dl>
        <section><h3 class="po-detail__heading">Lines</h3><div class="atlas-table-wrap"><table class="atlas-table atlas-table--compact"><thead><tr><th>Item</th><th class="is-num">Ordered</th><th class="is-num">Received</th><th class="is-num" data-priority="2">Unit cost</th><th class="is-num">Total</th></tr></thead>
        <tbody>${lines.map((line) => `<tr><td><a class="cell-primary" href="#inventory/item/${encodeURIComponent(line.item_id)}">${esc(line.item_name || itemById(line.item_id)?.name || 'Item')}</a><span class="cell-sub">${esc(line.unit || '')}</span></td><td class="is-num">${qty(line.quantity)}</td><td class="is-num">${['ordered', 'partially_received', 'received'].includes(order.status) && line.received_quantity != null ? `${qty(line.received_quantity)}${num(line.remaining_quantity) && order.status !== 'received' ? ` <span class="po__muted">(${qty(line.remaining_quantity)} left)</span>` : ''}` : '—'}</td><td class="is-num" data-priority="2">${money(line.unit_cost)}</td><td class="is-num">${money((num(line.quantity) || 0) * (num(line.unit_cost) || 0))}</td></tr>`).join('')}</tbody></table></div></section>
        ${order.note ? `<section><h3 class="po-detail__heading">Note</h3><p>${esc(order.note)}</p></section>` : ''}
        <section><h3 class="po-detail__heading">Activity</h3>${events.length ? `<ol class="po-timeline">${events.map((entry) => `<li><span class="po-timeline__what">${esc(EVENT_LABELS[entry.event_type] || String(entry.event_type || '').replace(/_/g, ' '))}${entry.payload?.reason ? ` · ${esc(entry.payload.reason)}` : ''}</span><span class="po-timeline__when">${esc(dateTimeText(entry.created_at))}</span></li>`).join('')}</ol>` : '<p class="po__muted">No activity recorded yet.</p>'}</section>`,
      foot: `${canCancel ? '<button type="button" class="atlas-btn atlas-btn--danger atlas-sheet__foot-start" data-po-cmd="cancel">Cancel order</button>' : ''}${secondary.join('')}${foot.join('')}`
    });
  }

  async function openOrderDetail(id) {
    if (!isManager()) return;
    const existing = state.detailSheet;
    let overlay = existing?.id === String(id) && document.body.contains(existing.overlay.host) ? existing.overlay : null;
    if (!overlay) {
      if (existing) { state.detailSheet = null; existing.overlay.close('replace'); }
      overlay = openOverlay(sheetHtml({ title: 'Order', body: '<div class="atlas-stack" aria-busy="true"><span class="atlas-skel atlas-skel--title"></span><span class="atlas-skel atlas-skel--block"></span></div>' }), {
        onClose: (reason) => {
          if (state.detailSheet?.overlay !== overlay) return;
          state.detailSheet = null;
          if (reason !== 'replace' && reason !== 'navigate' && /^#purchasing\/order\//.test(location.hash)) shell.navigate('#purchasing/orders');
        }
      });
      state.detailSheet = { id: String(id), overlay, data: null };
    }
    const back = '<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#purchasing/orders" data-po-back>Back to orders</a>';
    const showProblem = (body) => {
      overlay.panel.innerHTML = sheetHtml({ title: 'Order', body });
      lucide();
      overlay.panel.querySelector('[data-po-reload]')?.addEventListener('click', () => openOrderDetail(id));
      overlay.panel.querySelector('[data-po-back]')?.addEventListener('click', (event) => { event.preventDefault(); overlay.close('back'); shell.navigate('#purchasing/orders'); });
    };
    let data;
    try {
      [data] = await Promise.all([rpc('atlas_purchase_order_detail', { p_id: id }), state.policy ? null : loadPolicy()]);
    } catch (error) {
      if (state.detailSheet?.overlay !== overlay) return;
      console.warn('[purchasing] order detail failed', error?.raw || error);
      showProblem(isNotFound(error)
        ? alertHtml('info', 'This order no longer exists.', 'It may have been deleted, or the link is out of date. Your other orders are unchanged.', back)
        : alertHtml('danger', 'This order couldn’t be loaded.', 'Nothing was changed. Check your connection and try again.', `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-po-reload>Try again</button>${back}`));
      return;
    }
    if (state.detailSheet?.overlay !== overlay) return;
    // An empty answer (deleted order, stale notification link) is "not found",
    // never a crash on a missing order.
    if (!data || typeof data !== 'object' || !data.order || !data.order.id) {
      showProblem(alertHtml('info', 'This order no longer exists.', 'It may have been deleted, or the link is out of date. Your other orders are unchanged.', back));
      return;
    }
    try {
      state.detailSheet.data = data;
      if (data?.policy) state.policy = { ...(state.policy || {}), ...data.policy };
      const index = state.orders.findIndex((order) => order.id === data.order.id);
      if (index >= 0) state.orders[index] = data.order;
      overlay.panel.innerHTML = detailHtml(data);
      lucide();
      bindDetail(overlay, data);
    } catch (error) {
      console.warn('[purchasing] order detail could not be shown', error);
      showProblem(alertHtml('danger', 'This order couldn’t be shown.', 'Nothing was changed. Try again, or go back to your orders.', `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-po-reload>Try again</button>${back}`));
    }
  }

  function bindDetail(overlay, data) {
    const order = data.order;
    const panel = overlay.panel;
    const alertHost = panel.querySelector('[data-po-alert]');
    const fail = (error) => { const text = shown(error); alertHost.innerHTML = alertHtml('danger', 'That didn’t go through.', text); lucide(); alertHost.scrollIntoView({ block: 'nearest' }); if (/changed|refresh/i.test(text)) openOrderDetail(order.id); };
    panel.querySelector('[data-po-edit]')?.addEventListener('click', () => { overlay.close('replace'); state.detailSheet = null; openOrderSheet({ order }); });
    panel.querySelector('[data-po-receive]')?.addEventListener('click', () => openReceiveSheet(data));
    panel.querySelector('[data-po-date]')?.addEventListener('click', async () => {
      const value = await datePrompt(order.expected_delivery_date);
      if (value === null) return;
      try { await command('set_delivery_date', { id: order.id, version: order.version, deliveryDate: value || null }); toast('Delivery date saved'); openOrderDetail(order.id); render(); } catch (error) { fail(error); }
    });
    panel.querySelectorAll('[data-po-cmd]').forEach((button) => button.addEventListener('click', async () => {
      const action = button.dataset.poCmd;
      let reason = null;
      if (action === 'place') {
        const ok = await confirmDialog({ title: 'Mark this order as ordered?', body: 'Atlas doesn’t send orders to suppliers. Mark it as ordered once you’ve sent it by phone, email or the supplier’s portal.', confirm: 'Mark as ordered' });
        if (!ok) return;
      } else if (action === 'reject') {
        reason = await confirmDialog({ title: 'Send this order back?', body: 'It goes back to draft so it can be changed.', confirm: 'Send back', field: { label: 'Reason', required: true } });
        if (!reason) return;
      } else if (action === 'cancel') {
        const ok = await confirmDialog({ title: 'Cancel this order?', body: 'Nothing is received and stock doesn’t change. The order stays in the history as cancelled.', confirm: 'Cancel order', tone: 'danger-solid' });
        if (!ok) return;
      } else if (action === 'close_short') {
        reason = await confirmDialog({ title: 'Close this order short?', body: 'What arrived stays received. The rest is no longer expected.', confirm: 'Close short', field: { label: 'Reason', required: true } });
        if (!reason) return;
      } else if (action === 'receive') {
        const remaining = (data.lines || []).filter((line) => num(line.remaining_quantity) > 0);
        const ok = await confirmDialog({ title: 'Receive everything that’s left?', body: `${remaining.length} ${remaining.length === 1 ? 'line is' : 'lines are'} received in full at the ordered cost, and stock goes up.`, confirm: 'Receive all' });
        if (!ok) return;
      }
      busy(button, true);
      try {
        await command(action, { id: order.id, version: order.version, reason });
        toast({ place: 'Marked as ordered', submit: 'Submitted for approval', approve: 'Order approved', reject: 'Order sent back', cancel: 'Order cancelled', close_short: 'Order closed short', receive: 'Delivery received · stock updated' }[action] || 'Saved');
        render();
        openOrderDetail(order.id);
        if (action === 'receive') root.atlasReloadData?.();
      } catch (error) {
        busy(button, false);
        fail(error);
      }
    }));
  }

  function datePrompt(current) {
    return new Promise((resolve) => {
      let answered = false;
      const overlay = openOverlay(`<h2 class="atlas-dialog__title">Expected delivery</h2><form class="atlas-dialog__body" id="po-date-form"><div class="atlas-field"><label for="po-date-input">Date</label><input class="atlas-input" ${DATE_FIELD} id="po-date-input" min="${esc(today())}" value="${esc(current || '')}"></div></form><div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="po-date-form" class="atlas-btn atlas-btn--primary">Save date</button></div>`,
        { className: 'atlas-dialog', onClose: () => { if (!answered) resolve(null); } });
      overlay.panel.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const value = overlay.panel.querySelector('#po-date-input').value;
        if (value && value < today()) { overlay.panel.querySelector('#po-date-input').setAttribute('aria-invalid', 'true'); return; }
        answered = true;
        resolve(value);
        overlay.close('confirm');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Receiving (partial lines, idempotent per submit, optional photo check)
  // ---------------------------------------------------------------------------
  function openReceiveSheet(data) {
    const order = data.order;
    const lines = (data.lines || []).filter((line) => num(line.remaining_quantity ?? line.quantity) > 0);
    let requestId = uuid();
    const seen = new Set();
    const overlay = openOverlay(sheetHtml({
      title: 'Receive delivery',
      desc: `${esc(supplierName(order))} · check what arrived, then receive it`,
      body: `<div data-po-alert></div>
        <div class="atlas-upload po-photo"><div class="atlas-upload__thumb">${icon('camera')}</div><div class="atlas-upload__body"><p class="atlas-upload__title">Check with a photo <span class="optional">(optional)</span></p><p class="atlas-upload__help">Atlas matches what it sees to this order. You still confirm every line.</p></div><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-po-scan>Scan delivery</button></div>
        <form id="po-receive-form" class="po-receive">${lines.map((line, index) => `<div class="po-receive__line" data-po-rline="${esc(line.item_id)}">
          <div class="po-receive__head"><p class="po-receive__name">${esc(line.item_name || itemById(line.item_id)?.name || 'Item')}</p><p class="po__muted">Ordered ${qty(line.quantity)} ${esc(line.unit || '')}${num(line.received_quantity) ? ` · ${qty(line.received_quantity)} already received` : ''}</p><span class="po-receive__seen" data-po-seen hidden><span class="atlas-pill atlas-pill--positive">Seen in photo</span></span></div>
          <div class="po-receive__controls"><div class="po-stepper"><button type="button" class="atlas-icon-btn" data-po-step="-1" aria-label="One less">${icon('minus')}</button><label class="sr-only" for="po-rq-${index}">Received quantity</label><input class="atlas-input po-stepper__input num" id="po-rq-${index}" data-po-rqty type="text" inputmode="decimal" value="${esc(qty(line.remaining_quantity ?? line.quantity).replace(/,/g, ''))}"><button type="button" class="atlas-icon-btn" data-po-step="1" aria-label="One more">${icon('plus')}</button></div>
          <div class="atlas-chips po-receive__reasons" role="group" aria-label="Reason"><button type="button" class="atlas-chip" aria-pressed="false" data-po-reason="Short">Short</button><button type="button" class="atlas-chip" aria-pressed="false" data-po-reason="Damaged">Damaged</button></div></div>
        </div>`).join('')}</form>`,
      foot: '<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="po-receive-form" class="atlas-btn atlas-btn--primary" data-po-receive-submit>Receive</button>'
    }), { label: 'Receive delivery' });
    const panel = overlay.panel;
    const submit = panel.querySelector('[data-po-receive-submit]');
    const alertHost = panel.querySelector('[data-po-alert]');
    const readLines = () => [...panel.querySelectorAll('[data-po-rline]')].map((row) => {
      const raw = String(row.querySelector('[data-po-rqty]').value || '').trim().replace(',', '.');
      const reasons = [...row.querySelectorAll('[data-po-reason][aria-pressed="true"]')].map((chip) => chip.dataset.poReason);
      return { item_id: row.dataset.poRline, raw, quantity: raw === '' ? 0 : Number(raw), note: reasons.length ? reasons.join(', ') : null };
    });
    const updateLabel = () => {
      const counted = readLines().filter((line) => line.quantity > 0).length;
      submit.textContent = `Receive ${counted} of ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
      submit.disabled = !counted;
    };
    updateLabel();
    panel.addEventListener('input', updateLabel);
    panel.addEventListener('click', (event) => {
      const step = event.target.closest('[data-po-step]');
      if (step) {
        const input = step.closest('.po-stepper').querySelector('input');
        const next = Math.max(0, (Number(String(input.value).replace(',', '.')) || 0) + Number(step.dataset.poStep));
        input.value = String(Math.round(next * 1000) / 1000);
        updateLabel();
        return;
      }
      const reason = event.target.closest('[data-po-reason]');
      if (reason) { reason.setAttribute('aria-pressed', String(reason.getAttribute('aria-pressed') !== 'true')); return; }
      if (event.target.closest('[data-po-scan]')) scanDelivery(order, lines, (itemId) => {
        seen.add(String(itemId));
        const row = panel.querySelector(`[data-po-rline="${CSS.escape(String(itemId))}"]`);
        const pill = row?.querySelector('[data-po-seen]');
        if (pill) pill.hidden = false;
      });
    });
    panel.querySelector('#po-receive-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const entries = readLines();
      const bad = entries.find((line) => line.raw !== '' && (!Number.isFinite(line.quantity) || line.quantity < 0 || Math.abs(line.quantity * 1000 - Math.round(line.quantity * 1000)) > 1e-6));
      if (bad) { alertHost.innerHTML = alertHtml('danger', '', 'Quantities must be 0 or more, with up to three decimals.'); lucide(); return; }
      const receipt = entries.filter((line) => line.quantity > 0).map(({ item_id, quantity, note }) => ({ item_id, quantity, ...(note ? { note } : {}) }));
      if (!receipt.length) return;
      busy(submit, true);
      try {
        await command('receive_lines', { id: order.id, version: order.version, receipt, requestId });
        requestId = uuid();
        overlay.close('done');
        toast(`Received ${receipt.length} ${receipt.length === 1 ? 'line' : 'lines'} · stock updated`);
        render();
        openOrderDetail(order.id);
        root.atlasReloadData?.();
      } catch (error) {
        busy(submit, false);
        updateLabel();
        // The same request id is kept, so trying again can't receive twice.
        alertHost.innerHTML = alertHtml('danger', 'The delivery wasn’t received.', `${shown(error, 'Nothing was received.')} Trying again is safe; it won’t be counted twice.`);
        lucide();
      }
    });
  }

  // Photo check (design §7.6): recognition in receiving mode, scoped to the
  // order. It only marks lines as seen; quantities are always confirmed.
  function scanDelivery(order, lines, markSeen) {
    if (!root.AtlasCapture) { toast('Scanning isn’t available right now.'); return; }
    const onOrder = new Set(lines.map((line) => String(line.item_id)));
    root.AtlasCapture.open({
      mode: 'receiving',
      title: 'Scan delivery',
      photoRequired: true,
      context: { purchase_order_id: order.id, supplier_id: order.supplier_id },
      onResult: (result, ctl) => {
        const R = root.AtlasCapture.render;
        const detections = result.detections || [];
        const rows = detections.map((detection) => {
          const top = detection.candidates?.[0] || null;
          const match = detection.band !== 'low' && top && onOrder.has(String(top.item_id)) ? top : null;
          return { detection, top, match };
        });
        ctl.showSheet(`<div class="atlas-capture-result"><h3 class="atlas-capture-result__title">${detections.length ? `${detections.length} ${detections.length === 1 ? 'product' : 'products'} in the photo` : 'Nothing recognised'}</h3>
          <p class="atlas-capture-muted">Confirm the ones that are on this order. Quantities are always checked by you.</p>
          <ul class="atlas-list">${rows.map(({ detection, top, match }, index) => `<li class="atlas-row"><div class="atlas-row__body"><p class="atlas-row__title">${esc(match ? match.item?.name : detection.band === 'low' ? 'Unknown product' : top?.item?.name || 'Product')}</p><p class="atlas-row__meta">${match ? 'On this order' : detection.band === 'low' ? 'No confident match' : 'Not on this order'}</p></div><div class="atlas-row__end">${R.band(detection, top)}${match ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-use="${index}">Use for receiving</button>` : ''}</div></li>`).join('')}</ul>
          <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-done>Back to the delivery</button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-retry>Retake photo</button></div></div>`, (sheet) => {
          sheet.querySelector('[data-done]').addEventListener('click', () => ctl.close());
          sheet.querySelector('[data-retry]').addEventListener('click', () => ctl.resume());
          sheet.querySelectorAll('[data-use]').forEach((button) => button.addEventListener('click', async () => {
            const { detection, match } = rows[Number(button.dataset.use)];
            const ref = root.AtlasInventory?.recognitionRef?.(result, detection);
            if (ref) root.AtlasInventory.recordRecognitionChoice(ref, match.item_id, 'receiving', match.rank);
            markSeen(match.item_id);
            button.disabled = true;
            button.textContent = 'Marked';
          }));
        });
      }
    });
  }

  // "Receive a delivery" (formerly the restock modal): pick an open order,
  // or record a delivery that has no order.
  function openReceiveAny() {
    if (!isManager()) { toast('Receiving deliveries is for managers.', { tone: 'info' }); return; }
    const open = state.orders.filter((order) => ['ordered', 'partially_received'].includes(order.status));
    const overlay = openOverlay(sheetHtml({
      title: 'Receive a delivery',
      desc: 'Choose the order it belongs to. Receiving updates stock.',
      body: `${open.length ? `<ul class="atlas-card atlas-list">${open.map((order) => `<li class="atlas-row atlas-row--link"><button type="button" class="po-row-btn" data-po-receive-order="${esc(order.id)}"><span class="atlas-row__body"><span class="atlas-row__title">${esc(supplierName(order))}</span><span class="atlas-row__meta">${esc([`${linesOf(order).length} lines`, order.expected_delivery_date ? `expected ${deliveryText(order)}` : ''].filter(Boolean).join(' · '))}</span></span><span class="atlas-row__end">${statusPill(order)}</span></button></li>`).join('')}</ul>` : '<p class="po__muted">No orders are waiting for delivery.</p>'}
        <details class="po-noorder"${open.length ? '' : ' open'}><summary>No order? Record a delivery without one</summary>
        <form class="atlas-form" id="po-restock-form" novalidate><div data-po-alert></div>
          <div class="atlas-field"><label for="po-rs-item">Item</label><select class="atlas-select" id="po-rs-item" name="item" required><option value="">Choose an item</option>${items().filter((item) => item.active !== false).map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></div>
          <div class="atlas-grid-2"><div class="atlas-field"><label for="po-rs-qty">Quantity received</label><input class="atlas-input" id="po-rs-qty" name="quantity" type="number" inputmode="decimal" min="0.001" step="any" required></div>
          <div class="atlas-field"><label for="po-rs-supplier">Supplier</label><select class="atlas-select" id="po-rs-supplier" name="supplier"><option value="">No supplier</option>${suppliers().filter((supplier) => supplier.active !== false).map((supplier) => `<option value="${esc(supplier.id)}">${esc(supplier.name)}</option>`).join('')}</select></div></div>
          <div class="atlas-grid-2"><div class="atlas-field"><label for="po-rs-cost">Unit cost <span class="optional">(optional)</span></label><div class="atlas-affix"><input class="atlas-input" id="po-rs-cost" name="cost" type="number" inputmode="decimal" min="0" step="any"><span class="suffix">kr</span></div></div>
          <div class="atlas-field"><label for="po-rs-discount">Discount <span class="optional">(optional)</span></label><div class="atlas-affix"><input class="atlas-input" id="po-rs-discount" name="discount" type="number" inputmode="decimal" min="0" max="100" step="any"><span class="suffix">%</span></div></div></div>
          <button type="submit" class="atlas-btn atlas-btn--secondary">Record delivery</button>
        </form></details>`
    }), { label: 'Receive a delivery' });
    const panel = overlay.panel;
    panel.querySelectorAll('[data-po-receive-order]').forEach((button) => button.addEventListener('click', async () => {
      busy(button, true);
      try {
        const data = await rpc('atlas_purchase_order_detail', { p_id: button.dataset.poReceiveOrder });
        if (!data?.order?.id) { busy(button, false); toast('This order no longer exists. Your other orders are unchanged.'); return; }
        overlay.close('replace');
        openReceiveSheet(data);
      } catch (error) { busy(button, false); toast(shown(error, 'This order couldn’t be opened. Nothing was changed; try again.')); }
    }));
    const form = panel.querySelector('#po-restock-form');
    // Not form.elements.item: that is HTMLFormControlsCollection.item(), a
    // method, so the sheet threw before its handlers were bound.
    const item = form.querySelector('#po-rs-item');
    item.addEventListener('change', () => {
      const chosen = itemById(item.value);
      if (!chosen) return;
      if (chosen.supplier_id && !form.elements.supplier.value) form.elements.supplier.value = chosen.supplier_id;
      if (chosen.cost_price != null && !form.elements.cost.value) form.elements.cost.value = chosen.cost_price;
    });
    // One request id per form: a retry after an unconfirmed save replays the
    // stored movement instead of receiving the delivery twice (S90 P2-2).
    const requestId = uuid();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const alert = form.querySelector('[data-po-alert]');
      const quantity = Number(form.elements.quantity.value);
      const chosen = itemById(item.value);
      const cost = form.elements.cost.value === '' ? null : Number(form.elements.cost.value);
      const discount = form.elements.discount.value === '' ? 0 : Number(form.elements.discount.value);
      const problems = [];
      if (!chosen) problems.push([item, 'Choose an item.']);
      if (!(quantity > 0)) problems.push([form.elements.quantity, 'Enter a quantity above 0.']);
      if (cost !== null && !(cost >= 0)) problems.push([form.elements.cost, 'Enter a unit cost of 0 or more.']);
      if (!(discount >= 0 && discount <= 100)) problems.push([form.elements.discount, 'Enter a discount between 0 and 100 %.']);
      form.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
      if (problems.length) {
        problems.forEach(([input]) => input.setAttribute('aria-invalid', 'true'));
        alert.innerHTML = alertHtml('danger', '', problems.map(([, text]) => text).join(' '));
        lucide();
        problems[0][0].focus();
        return;
      }
      const button = form.querySelector('[type="submit"]');
      busy(button, true);
      const adjust = root.AtlasInventory?.adjustStock;
      const { error } = adjust
        ? await adjust({
          requestId, itemId: chosen.id, change: quantity, type: 'restock',
          unitCost: cost == null ? null : cost * (1 - discount / 100), supplierId: form.elements.supplier.value || null,
          note: discount ? `Supplier discount: ${discount}%` : 'Delivery without an order'
        })
        : { error: { refused: true, text: 'Receiving isn’t available right now. Nothing was recorded.' } };
      if (error) {
        busy(button, false);
        alert.innerHTML = error.refused
          ? alertHtml('danger', 'The delivery wasn’t recorded.', error.text)
          : alertHtml('warning', 'The delivery may not have been recorded.', error.text, '<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#inventory/movements" data-modal-close>Open Movements</a>');
        lucide();
        return;
      }
      overlay.close('done');
      toast(`Received ${qty(quantity)} ${chosen.unit || ''} of ${chosen.name} · stock updated`);
      root.atlasReloadData?.();
    });
  }

  // ---------------------------------------------------------------------------
  // Suppliers
  // ---------------------------------------------------------------------------
  function openSupplierSheet() {
    if (!isManager()) { toast('Suppliers are for managers.', { tone: 'info' }); return; }
    const overlay = openOverlay(sheetHtml({
      title: 'Add supplier',
      desc: 'Save a supplier once and use it for items, orders and deliveries.',
      body: `<form class="atlas-form" id="po-supplier-form" novalidate><div data-po-alert></div>
        <div class="atlas-field"><label for="po-s-name">Name</label><input class="atlas-input" id="po-s-name" name="name" required maxlength="200"></div>
        <div class="atlas-grid-2"><div class="atlas-field"><label for="po-s-contact">Contact person <span class="optional">(optional)</span></label><input class="atlas-input" id="po-s-contact" name="contact"></div>
        <div class="atlas-field"><label for="po-s-phone">Phone <span class="optional">(optional)</span></label><input class="atlas-input" id="po-s-phone" name="phone" inputmode="tel"></div></div>
        <div class="atlas-field"><label for="po-s-email">Email <span class="optional">(optional)</span></label><input class="atlas-input" id="po-s-email" name="email" type="email" placeholder="orders@example.com"></div>
        <div class="atlas-field"><label for="po-s-notes">Ordering notes <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="po-s-notes" name="notes" placeholder="Delivery days, account number, minimum order"></textarea></div></form>`,
      foot: '<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="po-supplier-form" class="atlas-btn atlas-btn--primary">Add supplier</button>'
    }), { label: 'Add supplier' });
    const form = overlay.panel.querySelector('#po-supplier-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) { form.elements.name.setAttribute('aria-invalid', 'true'); form.elements.name.focus(); return; }
      const button = overlay.panel.querySelector('[type="submit"]');
      busy(button, true);
      const payload = { name, contact_name: form.elements.contact.value.trim() || null, email: form.elements.email.value.trim() || null, phone: form.elements.phone.value.trim() || null, notes: form.elements.notes.value.trim() || null };
      let result = await client().from('suppliers').insert(payload);
      if (result.error && !/duplicate|unique/i.test(result.error.message || '')) result = await client().from('suppliers').insert({ name });
      if (result.error) {
        busy(button, false);
        form.querySelector('[data-po-alert]').innerHTML = alertHtml('danger', 'The supplier wasn’t added.', /duplicate|unique/i.test(result.error.message || '') ? 'A supplier with this name already exists.' : 'Check your connection and try again.');
        lucide();
        return;
      }
      overlay.close('done');
      toast(`${name} added`);
      await root.atlasReloadData?.();
      render();
    });
  }

  function openSupplierDetail(id) {
    const supplier = supplierById(id);
    if (!supplier) { if (suppliers().length) { toast('That supplier isn’t in Atlas any more.'); shell.navigate('#purchasing/suppliers'); } return; }
    if (state.supplierSheet) { const previous = state.supplierSheet; state.supplierSheet = null; previous.close('replace'); }
    const { supplierItems, openOrders, spend, lastDelivery } = supplierStats(supplier);
    const orders = state.orders.filter((order) => String(order.supplier_id) === String(supplier.id)).slice(0, 10);
    const overlay = openOverlay(sheetHtml({
      title: supplier.name,
      desc: supplier.active === false ? 'Inactive supplier' : `${supplierItems.length} ${supplierItems.length === 1 ? 'item' : 'items'} · ${openOrders.length} open ${openOrders.length === 1 ? 'order' : 'orders'}`,
      body: `<dl class="po-detail__facts">
          <div><dt>Contact</dt><dd>${esc(supplier.contact_name || 'Not set')}</dd></div>
          <div><dt>Email</dt><dd>${supplier.email ? `<a href="mailto:${esc(supplier.email)}">${esc(supplier.email)}</a>` : 'Not set'}</dd></div>
          <div><dt>Phone</dt><dd>${supplier.phone ? `<a href="tel:${esc(supplier.phone)}">${esc(supplier.phone)}</a>` : 'Not set'}</dd></div>
          <div><dt>Last delivery</dt><dd>${esc(lastDelivery ? dateText(lastDelivery, { long: true }) : 'None recorded')}</dd></div>
          <div><dt>Spend 30 days</dt><dd>${spend === null ? '— <span class="po__muted">no costed deliveries</span>' : money(spend)}</dd></div>
        </dl>
        ${supplier.notes ? `<section><h3 class="po-detail__heading">Ordering notes</h3><p>${esc(supplier.notes)}</p></section>` : ''}
        <section><h3 class="po-detail__heading">Items</h3>${supplierItems.length ? `<ul class="atlas-list">${supplierItems.slice(0, 30).map((item) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><a class="atlas-row__title" href="#inventory/item/${encodeURIComponent(item.id)}">${esc(item.name)}</a><p class="atlas-row__meta">${esc(item.category || '')}</p></div><div class="atlas-row__end">${root.AtlasStockTruth?.known(item) ? `<span class="num">${qty(item.quantity)}</span>` : '<span class="atlas-pill">Not counted</span>'}</div></li>`).join('')}</ul>` : '<p class="po__muted">No items are linked to this supplier.</p>'}</section>
        <section><h3 class="po-detail__heading">Orders</h3>${orders.length ? `<ul class="atlas-list">${orders.map((order) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><a class="atlas-row__title" href="#purchasing/order/${encodeURIComponent(order.id)}">${esc(dateText(order.created_at))} · ${money(orderTotal(order))}</a><p class="atlas-row__meta">${linesOf(order).length} lines</p></div><div class="atlas-row__end">${statusPill(order)}</div></li>`).join('')}</ul>` : '<p class="po__muted">No orders yet.</p>'}</section>`,
      foot: supplier.active === false ? '' : '<button type="button" class="atlas-btn atlas-btn--primary" data-po-new-for>New order</button>'
    }), {
      onClose: (reason) => {
        if (state.supplierSheet !== overlay) return;
        state.supplierSheet = null;
        if (reason !== 'replace' && reason !== 'navigate' && /^#purchasing\/suppliers\//.test(location.hash)) shell.navigate('#purchasing/suppliers');
      }
    });
    state.supplierSheet = overlay;
    overlay.panel.querySelector('[data-po-new-for]')?.addEventListener('click', () => { overlay.close('replace'); state.supplierSheet = null; openOrderSheet({ supplierId: supplier.id }); });
  }

  // ---------------------------------------------------------------------------
  // Events, view, actions, Home
  // ---------------------------------------------------------------------------
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !rootEl().contains(target)) return;
    if (target.closest('[data-po-new]')) { openOrderSheet(); return; }
    if (target.closest('[data-po-receive-any]')) { openReceiveAny(); return; }
    if (target.closest('[data-po-add-supplier]')) { openSupplierSheet(); return; }
    if (target.closest('[data-po-suggestions]')) { openSuggestionsSheet(); return; }
    if (target.closest('[data-po-retry]')) { loadOrders().then(render); return; }
    if (target.closest('[data-po-retry-data]')) { Promise.resolve(root.atlasReloadData?.()).then(render); return; }
    if (target.closest('[data-po-clear-all]')) { state.statusFilter = null; state.supplierFilter = null; render(); return; }
    const clear = target.closest('[data-po-clear]');
    if (clear) { if (clear.dataset.poClear === 'status') state.statusFilter = null; else state.supplierFilter = null; render(); return; }
    const row = target.closest('tr[data-po-open]');
    if (row && !target.closest('a, button')) { shell.navigate(`#purchasing/order/${encodeURIComponent(row.dataset.poOpen)}`); return; }
    const supplierRow = target.closest('tr[data-po-supplier]');
    if (supplierRow && !target.closest('a, button')) shell.navigate(`#purchasing/suppliers/${encodeURIComponent(supplierRow.dataset.poSupplier)}`);
  }
  function onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-po-supplier-search]')) return;
    state.supplierQuery = target.value;
    const body = rootEl().querySelector('[data-po-body]');
    if (body) { renderSuppliers(body); lucide(); const input = body.querySelector('[data-po-supplier-search]'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }
  }

  // The shell renders the page once per navigation (render), then onShow
  // loads data and opens the order or supplier the route names.
  function renderRoute(params = {}) {
    state.params = { ...params };
    state.section = ['orders', 'deliveries', 'suppliers'].includes(params.section) ? params.section : 'orders';
    render();
  }

  function onShow(params = {}) {
    if (!isManager()) return;
    if (!state.ordersLoaded) loadOrders().then(() => { if (shell.current() === 'suppliers') render(); });
    if (!state.policy) loadPolicy();
    if (params.order) openOrderDetail(params.order);
    else if (state.detailSheet) { const sheet = state.detailSheet; state.detailSheet = null; sheet.overlay.close('navigate'); }
    if (params.supplier) openSupplierDetail(params.supplier);
    else if (state.supplierSheet) { const sheet = state.supplierSheet; state.supplierSheet = null; sheet.close('navigate'); }
  }

  function onHide() {
    if (state.detailSheet) { const sheet = state.detailSheet; state.detailSheet = null; sheet.overlay.close('navigate'); }
    if (state.supplierSheet) { const sheet = state.supplierSheet; state.supplierSheet = null; sheet.close('navigate'); }
  }

  function homeRows() {
    if (!isManager()) return [];
    const rows = [];
    state.orders.filter((order) => order.status === 'pending_approval').slice(0, 2).forEach((order) => rows.push({ id: `approve:${order.id}`, severity: 'warning', icon: 'truck', title: `Order from ${supplierName(order)} needs approval`, detail: `${linesOf(order).length} lines · ${money(orderTotal(order))}`, action: { label: 'Review', route: `#purchasing/order/${order.id}` }, roles: MANAGERS }));
    state.orders.filter((order) => ['ordered', 'partially_received'].includes(order.status) && order.expected_delivery_date && order.expected_delivery_date <= today()).slice(0, 2).forEach((order) => rows.push({
      id: `delivery:${order.id}`, severity: order.expected_delivery_date < today() ? 'danger' : 'info', icon: 'package-check',
      title: order.expected_delivery_date < today() ? `Delivery from ${supplierName(order)} is overdue` : `Delivery from ${supplierName(order)} is due today`,
      detail: `Expected ${dateText(order.expected_delivery_date)}`, due: order.expected_delivery_date, action: { label: 'Receive', route: `#purchasing/order/${order.id}` }, roles: MANAGERS
    }));
    return rows;
  }

  function register() {
    shell.registerView('suppliers', {
      root: () => rootEl(), title: 'Purchasing', display: 'block', render: (params) => renderRoute(params || {}), onShow, onHide,
      // Staff following a Purchasing link (an order, a notification) see the
      // page's permission state, like Reports, Data and Decisions (G17): never
      // a silent jump to Home.
    });
    const actions = [
      { id: 'purchasing.order.new', label: 'New order', icon: 'shopping-cart', keywords: ['order', 'purchase', 'buy'], roles: MANAGERS, contexts: ['home', 'purchasing', 'suppliers'], forRecord: 'inventory_item', recordLabel: 'Add {name} to an order', run: (ctx = {}) => { if (shell.current() !== 'suppliers') shell.navigate('#purchasing/orders'); openOrderSheet({ itemIds: ctx.record?.type === 'inventory_item' ? [ctx.record.id] : (ctx.itemIds || []) }); } },
      { id: 'purchasing.delivery.receive', label: 'Receive a delivery', icon: 'truck', keywords: ['restock', 'delivery', 'receive'], roles: MANAGERS, contexts: ['home', 'inventory', 'purchasing', 'suppliers'], run: async () => { if (!state.ordersLoaded) await loadOrders(); openReceiveAny(); } },
      { id: 'purchasing.supplier.add', label: 'Add supplier', icon: 'store', keywords: ['supplier', 'vendor'], roles: MANAGERS, contexts: ['purchasing', 'suppliers'], run: () => { shell.navigate('#purchasing/suppliers'); openSupplierSheet(); } },
      { id: 'purchasing.suggestions.review', label: 'Review suggested order', icon: 'list-checks', keywords: ['suggested', 'below par', 'reorder'], roles: MANAGERS, contexts: ['home', 'purchasing', 'suppliers'], when: () => suggestions().length > 0, run: () => { shell.navigate('#purchasing/orders'); openSuggestionsSheet(); } }
    ];
    actions.forEach((action) => shell.actions.register({ ...action, denied: () => toast(`${action.label} is for managers. Ask an administrator if you need access.`, { tone: 'info' }) }));
    shell.home?.contribute?.('purchasing', { order: 40, focusRows: homeRows });
    shell.onDataLoaded(() => { if (shell.current() === 'suppliers') render(); });
    shell.on('profile:ready', () => {
      state.orders = [];
      state.ordersLoaded = false;
      state.policy = null;
      if (isManager()) root.setTimeout(() => { loadOrders(); loadPolicy(); }, 0);
      if (shell.current() === 'suppliers') render();
    });
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
  }

  // Items on any open order: a draft, one waiting for approval, approved,
  // placed or partly received (S90 P2-7: a draft already covers the need, so
  // suggesting it again invites double ordering). Operations and the canonical
  // order suggestions read "on order" from here, never from storage.
  root.AtlasPurchaseOrders = Object.freeze({
    openItemIds: () => new Set(state.orders.filter((order) => ['draft', 'pending_approval', 'approved', 'ordered', 'partially_received'].includes(order.status)).flatMap((order) => (order.lines || []).map((line) => line.item_id)).filter(Boolean)),
    // The furthest-along open order each item is on, for honest labels
    // ("On a draft order" is not "On order").
    itemOrderStatus: (itemId) => itemOrderStatus(itemId)
  });
  root.AtlasPurchasing = Object.freeze({
    newOrder: (options = {}) => { shell.navigate('#purchasing/orders'); openOrderSheet(options); },
    openOrder: (id) => shell.navigate(`#purchasing/order/${encodeURIComponent(id)}`),
    receive: openReceiveAny,
    orders: () => state.orders.slice(),
    friendlyError,
    render
  });
  register();
})(window);
