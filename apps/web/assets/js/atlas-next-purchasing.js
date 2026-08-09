(() => {
  'use strict';

  const DRAFT_KEY = 'atlas.next.purchase-drafts.v1';
  const state = {
    activeTab: 'suggestions',
    query: '',
    modal: null,
    message: null,
    error: null,
    saving: false,
  };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const formatNumber = (value) => Number.isFinite(Number(value))
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value))
    : '—';
  const formatIsk = (value, fallback = '—') => Number.isFinite(Number(value))
    ? new Intl.NumberFormat('en-IS', { style: 'currency', currency: 'ISK', maximumFractionDigits: 0 }).format(Number(value))
    : fallback;
  const formatDate = (value) => {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  };

  function host() {
    return document.getElementById('purchasing-view');
  }

  function canManage() {
    return ['admin', 'manager'].includes(document.body.dataset.atlasRole || '');
  }

  function activeItems() {
    return (Array.isArray(window.items) ? window.items : []).filter((item) => item.active !== false);
  }

  function shortage(item) {
    const par = Number(item.par_level);
    const current = Number(item.quantity);
    if (!Number.isFinite(par) || !Number.isFinite(current)) return 0;
    return Math.max(par - current, 0);
  }

  function suggestions() {
    const query = state.query.trim().toLowerCase();
    return activeItems().map((item) => ({
      item,
      quantity: shortage(item),
      supplier: String(item.supplier || 'Supplier not assigned').trim() || 'Supplier not assigned',
      unit: item.unit || 'units',
      estimatedCost: Number.isFinite(Number(item.cost_price)) ? shortage(item) * Number(item.cost_price) : null,
    })).filter((entry) => entry.quantity > 0)
      .filter((entry) => !query || [entry.item.name, entry.item.category, entry.supplier, entry.item.sku]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)))
      .sort((left, right) => left.supplier.localeCompare(right.supplier) || right.quantity - left.quantity || left.item.name.localeCompare(right.item.name));
  }

  function supplierRows() {
    const query = state.query.trim().toLowerCase();
    const records = Array.isArray(window.suppliers) ? window.suppliers : [];
    const names = new Map(records.map((supplier) => [String(supplier.name || '').trim(), supplier]));
    activeItems().forEach((item) => {
      const name = String(item.supplier || '').trim();
      if (name && !names.has(name)) names.set(name, { name, inferred: true });
    });
    return Array.from(names.values()).filter((supplier) => supplier.name)
      .map((supplier) => ({
        ...supplier,
        itemCount: activeItems().filter((item) => item.supplier_id === supplier.id || item.supplier === supplier.name).length,
      }))
      .filter((supplier) => !query || [supplier.name, supplier.contact_name, supplier.email, supplier.phone]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function movementRows() {
    const query = state.query.trim().toLowerCase();
    return (Array.isArray(window.restockLog) ? window.restockLog : [])
      .filter((movement) => !query || [movement.item_name, movement.note, movement.suppliers?.name, movement.movement_type]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)))
      .sort((left, right) => new Date(right.created_at || 0) - new Date(left.created_at || 0));
  }

  function readDrafts() {
    try {
      const value = JSON.parse(localStorage.getItem(DRAFT_KEY));
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function writeDrafts(rows) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(rows)); } catch (_) { /* storage optional */ }
  }

  function draftRows() {
    const query = state.query.trim().toLowerCase();
    return readDrafts().filter((draft) => !query || [draft.supplier, draft.title]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)));
  }

  function groupSuggestions() {
    const groups = new Map();
    suggestions().forEach((entry) => {
      if (!groups.has(entry.supplier)) groups.set(entry.supplier, []);
      groups.get(entry.supplier).push(entry);
    });
    return Array.from(groups, ([supplier, rows]) => ({
      supplier,
      rows,
      estimatedCost: rows.reduce((sum, row) => sum + (row.estimatedCost || 0), 0),
      completeCost: rows.every((row) => row.estimatedCost !== null),
    }));
  }

  function totals() {
    const rows = suggestions();
    const groups = new Set(rows.map((entry) => entry.supplier));
    const estimated = rows.reduce((sum, entry) => sum + (entry.estimatedCost || 0), 0);
    const missingCost = rows.filter((entry) => entry.estimatedCost === null).length;
    return { rows: rows.length, suppliers: groups.size, estimated, missingCost };
  }

  function summaryMarkup() {
    const total = totals();
    return `<section class="atlas-purchasing-summary" aria-label="Purchasing summary">
      <article><span>Below par</span><strong>${total.rows}</strong><small>recorded items with a positive shortfall</small></article>
      <article><span>Supplier groups</span><strong>${total.suppliers}</strong><small>including unassigned items</small></article>
      <article><span>Estimated draft value</span><strong>${esc(formatIsk(total.estimated, '0 ISK'))}</strong><small>only where a unit cost exists</small></article>
      <article><span>Missing cost evidence</span><strong>${total.missingCost}</strong><small>requires item-master completion</small></article>
    </section>`;
  }

  function suggestionRow(entry) {
    return `<div class="atlas-purchasing-row"><div><strong>${esc(entry.item.name || 'Unnamed item')}</strong><span>${esc(entry.item.category || 'Uncategorised')} · on hand ${esc(`${formatNumber(entry.item.quantity)} ${entry.unit}`)} · par ${esc(`${formatNumber(entry.item.par_level)} ${entry.unit}`)}</span></div><div class="atlas-purchasing-quantity"><strong>+${esc(formatNumber(entry.quantity))} ${esc(entry.unit)}</strong><span>${entry.estimatedCost === null ? 'cost unavailable' : esc(formatIsk(entry.estimatedCost))}</span></div><button type="button" class="atlas-button secondary" data-purchasing-restock="${esc(entry.item.id)}">Log delivery</button></div>`;
  }

  function suggestionsMarkup() {
    const groups = groupSuggestions();
    if (!groups.length) return '<div class="atlas-purchasing-empty"><i data-lucide="circle-check-big"></i><h3>No recorded shortfalls</h3><p>Atlas shows only items whose recorded quantity is below their par level.</p></div>';
    return groups.map((group) => `<section class="atlas-purchasing-group"><header><div><strong>${esc(group.supplier)}</strong><span>${group.rows.length} ${group.rows.length === 1 ? 'item' : 'items'} · ${group.completeCost ? esc(formatIsk(group.estimatedCost)) : 'partial cost evidence'}</span></div><button type="button" class="atlas-button secondary" data-purchasing-draft="${esc(group.supplier)}">Prepare draft</button></header>${group.rows.map(suggestionRow).join('')}</section>`).join('');
  }

  function suppliersMarkup() {
    const rows = supplierRows();
    if (!rows.length) return '<div class="atlas-purchasing-empty"><i data-lucide="truck"></i><h3>No suppliers found</h3><p>Add a manager-controlled supplier record or complete supplier assignments in Item master.</p></div>';
    return `<div class="atlas-purchasing-table-wrap"><table class="atlas-purchasing-table"><thead><tr><th>Supplier</th><th>Contact</th><th>Linked items</th><th>Notes</th></tr></thead><tbody>${rows.map((supplier) => `<tr><td><strong>${esc(supplier.name)}</strong><span>${supplier.inferred ? 'Inferred from inventory assignment' : 'Canonical supplier record'}</span></td><td>${esc(supplier.contact_name || supplier.email || supplier.phone || 'Not recorded')}</td><td>${supplier.itemCount}</td><td>${esc(supplier.notes || '—')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function movementsMarkup() {
    const rows = movementRows();
    if (!rows.length) return '<div class="atlas-purchasing-empty"><i data-lucide="history"></i><h3>No restock movements found</h3><p>Controlled delivery entries will appear here after the existing inventory RPC accepts them.</p></div>';
    return `<div class="atlas-purchasing-table-wrap"><table class="atlas-purchasing-table"><thead><tr><th>Recorded</th><th>Item</th><th>Quantity</th><th>Supplier</th><th>Cost</th></tr></thead><tbody>${rows.map((movement) => `<tr><td>${esc(formatDate(movement.created_at))}</td><td><strong>${esc(movement.item_name || movement.inventory_items?.name || 'Inventory item')}</strong><span>${esc(movement.note || movement.movement_type || '')}</span></td><td>${esc(`${formatNumber(movement.quantity_change ?? movement.quantity)} ${movement.unit || ''}`.trim())}</td><td>${esc(movement.suppliers?.name || movement.supplier || '—')}</td><td>${esc(formatIsk(movement.total_cost ?? movement.unit_cost, '—'))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function draftsMarkup() {
    const rows = draftRows();
    if (!rows.length) return '<div class="atlas-purchasing-empty"><i data-lucide="file-check-2"></i><h3>No review drafts</h3><p>Prepare a supplier draft from the recorded shortfall list. Drafts remain local and cannot submit an order.</p></div>';
    return rows.map((draft) => `<section class="atlas-purchasing-group"><header><div><strong>${esc(draft.title)}</strong><span>${esc(formatDate(draft.createdAt))} · review only</span></div><button type="button" class="atlas-button secondary" data-purchasing-export="${esc(draft.id)}">Export CSV</button></header>${draft.lines.map((line) => `<div class="atlas-purchasing-row"><div><strong>${esc(line.name)}</strong><span>${esc(line.category || 'Inventory')}</span></div><div class="atlas-purchasing-quantity"><strong>+${esc(formatNumber(line.quantity))} ${esc(line.unit)}</strong><span>${line.estimatedCost == null ? 'cost unavailable' : esc(formatIsk(line.estimatedCost))}</span></div><button type="button" class="atlas-button ghost" data-purchasing-delete-draft="${esc(draft.id)}">Remove</button></div>`).join('')}</section>`).join('');
  }

  function currentMarkup() {
    if (state.activeTab === 'suppliers') return suppliersMarkup();
    if (state.activeTab === 'movements') return movementsMarkup();
    if (state.activeTab === 'drafts') return draftsMarkup();
    return suggestionsMarkup();
  }

  function render() {
    const element = host();
    if (!element) return;
    const total = totals();
    element.innerHTML = `<section class="atlas-purchasing"><header class="atlas-purchasing-hero"><div><span class="eyebrow">Operations · Purchasing</span><h1>Purchasing</h1><p>Review recorded shortfalls, supplier assignments and costed deliveries. Atlas does not submit supplier orders from this workspace.</p></div><div class="atlas-purchasing-actions"><button type="button" class="atlas-button secondary" data-purchasing-refresh><i data-lucide="refresh-cw"></i>Refresh</button>${canManage() ? '<button type="button" class="atlas-button secondary" data-purchasing-add-supplier><i data-lucide="truck"></i>Add supplier</button><button type="button" class="atlas-button" data-purchasing-open-restock><i data-lucide="package-plus"></i>Log delivery</button>' : ''}</div></header>${state.error ? `<div class="atlas-connected-error"><i data-lucide="triangle-alert"></i><h2>Purchasing action failed</h2><p>${esc(state.error)}</p></div>` : ''}${state.message ? `<div class="atlas-purchasing-boundary"><i data-lucide="circle-check-big"></i><div><strong>Saved</strong><span>${esc(state.message)}</span></div></div>` : ''}<div class="atlas-purchasing-boundary"><i data-lucide="shield-check"></i><div><strong>Review-first purchasing boundary</strong><span>Suggested quantity is exactly max(par − recorded on hand, 0). Draft preparation is local and supplier submission remains disabled.</span></div></div>${summaryMarkup()}<nav class="atlas-purchasing-tabs" aria-label="Purchasing sections">${[['suggestions', `Shortfalls (${total.rows})`], ['suppliers', 'Suppliers'], ['movements', 'Deliveries'], ['drafts', `Review drafts (${readDrafts().length})`]].map(([key, label]) => `<button type="button" class="${state.activeTab === key ? 'active' : ''}" data-purchasing-tab="${key}">${label}</button>`).join('')}</nav><div class="toolbar inventory-toolbar"><input class="atlas-input" type="search" data-purchasing-search value="${esc(state.query)}" placeholder="Search item, supplier or movement…" aria-label="Search purchasing" /></div><section class="atlas-purchasing-card"><header class="atlas-purchasing-card-head"><div><h2>${state.activeTab === 'suggestions' ? 'Recorded shortfalls' : state.activeTab === 'suppliers' ? 'Supplier directory' : state.activeTab === 'movements' ? 'Controlled delivery history' : 'Review-only purchase drafts'}</h2><p>Live role-permitted evidence from the existing Atlas data boundary.</p></div></header><div class="atlas-purchasing-list">${currentMarkup()}</div></section></section>${modalMarkup()}`;
    bind();
    window.lucide?.createIcons?.();
  }

  function restockModal(itemId = '') {
    const options = activeItems().sort((a, b) => String(a.name).localeCompare(String(b.name))).map((item) => `<option value="${esc(item.id)}" ${item.id === itemId ? 'selected' : ''}>${esc(item.name)} · ${esc(`${formatNumber(item.quantity)} ${item.unit || ''}`.trim())}</option>`).join('');
    const supplierOptions = supplierRows().map((supplier) => `<option value="${esc(supplier.name)}"></option>`).join('');
    return `<div class="atlas-workspace-modal-backdrop" data-purchasing-modal-backdrop><section class="atlas-workspace-modal" role="dialog" aria-modal="true" aria-labelledby="purchasing-restock-title"><header><div><h2 id="purchasing-restock-title">Log controlled delivery</h2><p>The existing inventory-adjustment RPC records the quantity and audit movement.</p></div><button type="button" class="icon-button" data-purchasing-close aria-label="Close"><i data-lucide="x"></i></button></header><form data-purchasing-restock-form><div class="atlas-workspace-form-grid"><label class="full"><span>Inventory item</span><select name="item_id" required><option value="">Choose item…</option>${options}</select></label><label><span>Quantity received</span><input name="quantity" type="number" min="0.01" step="0.01" required /></label><label><span>Unit cost (ISK)</span><input name="unit_cost" type="number" min="0" step="0.01" /></label><label class="full"><span>Supplier</span><input name="supplier" list="atlas-purchasing-suppliers" placeholder="Optional supplier" /><datalist id="atlas-purchasing-suppliers">${supplierOptions}</datalist></label><label class="full"><span>Delivery note</span><textarea name="note" placeholder="Invoice, delivery or storage note"></textarea></label></div><div class="atlas-workspace-contract"><i data-lucide="shield-check"></i><span>This is a controlled inventory operation. The user role, RPC validation and movement audit remain authoritative.</span></div><footer><button type="button" class="atlas-button secondary" data-purchasing-close>Cancel</button><button type="submit" class="atlas-button" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Log delivery'}</button></footer></form></section></div>`;
  }

  function supplierModal() {
    return `<div class="atlas-workspace-modal-backdrop" data-purchasing-modal-backdrop><section class="atlas-workspace-modal" role="dialog" aria-modal="true" aria-labelledby="purchasing-supplier-title"><header><div><h2 id="purchasing-supplier-title">Add supplier</h2><p>Create one manager-controlled supplier record for inventory and deliveries.</p></div><button type="button" class="icon-button" data-purchasing-close aria-label="Close"><i data-lucide="x"></i></button></header><form data-purchasing-supplier-form><div class="atlas-workspace-form-grid"><label class="full"><span>Supplier name</span><input name="name" required /></label><label><span>Contact person</span><input name="contact_name" /></label><label><span>Email</span><input name="email" type="email" /></label><label><span>Phone</span><input name="phone" /></label><label class="full"><span>Notes</span><textarea name="notes"></textarea></label></div><div class="atlas-workspace-contract"><i data-lucide="shield-check"></i><span>Supplier records remain subject to production role and RLS controls.</span></div><footer><button type="button" class="atlas-button secondary" data-purchasing-close>Cancel</button><button type="submit" class="atlas-button" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save supplier'}</button></footer></form></section></div>`;
  }

  function modalMarkup() {
    if (state.modal?.type === 'restock') return restockModal(state.modal.itemId);
    if (state.modal?.type === 'supplier') return supplierModal();
    return '';
  }

  function closeModal() {
    state.modal = null;
    state.saving = false;
    render();
  }

  function openRestock(itemId = '') {
    if (!canManage()) {
      state.error = 'Logging a delivery is limited to managers and administrators.';
      render();
      return;
    }
    state.error = null;
    state.modal = { type: 'restock', itemId };
    render();
  }

  function openSupplier() {
    if (!canManage()) {
      state.error = 'Creating a supplier is limited to managers and administrators.';
      render();
      return;
    }
    state.error = null;
    state.modal = { type: 'supplier' };
    render();
  }

  function prepareDraft(supplierName) {
    const rows = suggestions().filter((entry) => entry.supplier === supplierName);
    if (!rows.length) return;
    const draft = {
      id: window.crypto?.randomUUID?.() || `draft-${Date.now()}`,
      title: `${supplierName} replenishment review`,
      supplier: supplierName,
      createdAt: new Date().toISOString(),
      submissionEnabled: false,
      lines: rows.map((entry) => ({
        itemId: entry.item.id,
        name: entry.item.name,
        category: entry.item.category,
        quantity: entry.quantity,
        unit: entry.unit,
        estimatedCost: entry.estimatedCost,
      })),
    };
    const drafts = readDrafts();
    drafts.unshift(draft);
    writeDrafts(drafts.slice(0, 50));
    state.activeTab = 'drafts';
    state.message = 'Review draft prepared locally. No supplier order was submitted.';
    render();
  }

  function exportDraft(id) {
    const draft = readDrafts().find((entry) => entry.id === id);
    if (!draft) return;
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = [
      ['Supplier', 'Item', 'Category', 'Quantity', 'Unit', 'Estimated cost ISK'].map(quote).join(','),
      ...draft.lines.map((line) => [draft.supplier, line.name, line.category, line.quantity, line.unit, line.estimatedCost ?? ''].map(quote).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${draft.supplier.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'atlas'}-review-draft.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function removeDraft(id) {
    writeDrafts(readDrafts().filter((entry) => entry.id !== id));
    state.message = 'Review draft removed.';
    render();
  }

  async function saveRestock(form) {
    const data = new FormData(form);
    const item = activeItems().find((entry) => entry.id === data.get('item_id'));
    const quantity = Number(data.get('quantity'));
    if (!item || !Number.isFinite(quantity) || quantity <= 0) return;
    if (!window.AtlasData?.adjustInventory) throw new Error('The controlled Inventory data boundary is unavailable.');
    state.saving = true;
    render();
    try {
      let supplierId = item.supplier_id || null;
      const supplierName = String(data.get('supplier') || '').trim();
      if (supplierName && window.AtlasData.ensureSupplier) {
        const record = await window.AtlasData.ensureSupplier(supplierName);
        supplierId = record?.id || supplierId;
      }
      const unitCost = data.get('unit_cost') === '' ? null : Number(data.get('unit_cost'));
      await window.AtlasData.adjustInventory({
        itemId: item.id,
        quantityChange: quantity,
        movementType: 'restock',
        unitCost: Number.isFinite(unitCost) ? unitCost : null,
        supplierId,
        note: String(data.get('note') || '').trim() || null,
      });
      state.modal = null;
      state.message = `${item.name} delivery recorded through the controlled Inventory RPC.`;
      await window.AtlasNext?.refresh?.({ quiet: true });
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The delivery could not be recorded.';
    } finally {
      state.saving = false;
      render();
    }
  }

  async function saveSupplier(form) {
    if (!window.AtlasData?.createSupplier) throw new Error('The supplier data boundary is unavailable.');
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      contact_name: String(data.get('contact_name') || '').trim() || null,
      email: String(data.get('email') || '').trim() || null,
      phone: String(data.get('phone') || '').trim() || null,
      notes: String(data.get('notes') || '').trim() || null,
    };
    if (!payload.name) return;
    state.saving = true;
    render();
    try {
      await window.AtlasData.createSupplier(payload);
      state.modal = null;
      state.message = `${payload.name} added through the existing supplier boundary.`;
      await window.AtlasNext?.refresh?.({ quiet: true });
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The supplier could not be saved.';
    } finally {
      state.saving = false;
      render();
    }
  }

  function bind() {
    const element = host();
    if (!element) return;
    element.querySelectorAll('[data-purchasing-tab]').forEach((button) => button.addEventListener('click', () => {
      state.activeTab = button.dataset.purchasingTab;
      state.message = null;
      state.error = null;
      render();
    }));
    element.querySelector('[data-purchasing-search]')?.addEventListener('input', (event) => {
      state.query = event.target.value;
      const caret = event.target.selectionStart ?? state.query.length;
      render();
      window.requestAnimationFrame(() => {
        const field = host()?.querySelector('[data-purchasing-search]');
        field?.focus();
        field?.setSelectionRange?.(caret, caret);
      });
    });
    element.querySelector('[data-purchasing-refresh]')?.addEventListener('click', () => window.AtlasNext?.refresh?.());
    element.querySelector('[data-purchasing-open-restock]')?.addEventListener('click', () => openRestock());
    element.querySelector('[data-purchasing-add-supplier]')?.addEventListener('click', openSupplier);
    element.querySelectorAll('[data-purchasing-restock]').forEach((button) => button.addEventListener('click', () => openRestock(button.dataset.purchasingRestock)));
    element.querySelectorAll('[data-purchasing-draft]').forEach((button) => button.addEventListener('click', () => prepareDraft(button.dataset.purchasingDraft)));
    element.querySelectorAll('[data-purchasing-export]').forEach((button) => button.addEventListener('click', () => exportDraft(button.dataset.purchasingExport)));
    element.querySelectorAll('[data-purchasing-delete-draft]').forEach((button) => button.addEventListener('click', () => removeDraft(button.dataset.purchasingDeleteDraft)));
    element.querySelectorAll('[data-purchasing-close]').forEach((button) => button.addEventListener('click', closeModal));
    element.querySelector('[data-purchasing-modal-backdrop]')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); });
    element.querySelector('[data-purchasing-restock-form]')?.addEventListener('submit', (event) => { event.preventDefault(); saveRestock(event.currentTarget); });
    element.querySelector('[data-purchasing-supplier-form]')?.addEventListener('submit', (event) => { event.preventDefault(); saveSupplier(event.currentTarget); });
  }

  function open() {
    render();
  }

  window.AtlasNextPurchasing = Object.freeze({
    open,
    render,
    openRestock,
    openSupplier,
    suggestions,
  });
})();
