(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const state = {
    active: false,
    loading: false,
    workspace: null,
    selectedId: null,
    search: '',
    tier: 'all',
    missing: 'all',
    category: 'all',
    draftStatus: 'all',
    message: '',
    error: '',
    requestSerial: 0,
    observer: null,
    mount: null,
    navButton: null,
  };

  const MASTER_FIELDS = [
    ['par_level', 'Par level'],
    ['critical_minimum', 'Critical minimum'],
    ['supplier', 'Supplier'],
    ['supplier_product_reference', 'Supplier product reference'],
    ['units_per_case', 'Units per case'],
    ['package_size_or_weight', 'Bottle size or package weight'],
    ['cost_price', 'Unit cost'],
    ['case_cost', 'Case cost'],
    ['bin_location', 'Storage location'],
    ['lead_time_days', 'Lead time'],
    ['minimum_order_quantity', 'Minimum order quantity'],
    ['recipe_links', 'Recipe links'],
    ['barcode_aliases', 'Barcode aliases'],
  ];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function titleCase(value) {
    return text(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatNumber(value, fallback = '—') {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(number);
  }

  function formatDate(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(parsed);
  }

  function endpoint() {
    return text(cfg.ITEM_MASTER_API);
  }

  async function currentSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, method = 'GET', body = null) {
    const base = endpoint();
    if (!base) throw new Error('Checkpoint L2 item-master API is not configured.');
    const session = await currentSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to use the item-master queue.');
    const url = new URL(base);
    url.searchParams.set('action', action);
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Checkpoint L2 request failed (${response.status}).`);
    return payload;
  }

  function ensureNav() {
    if (state.navButton?.isConnected) return state.navButton;
    const parent = document.querySelector('.nav-parent[data-default="inventory"]');
    const sub = parent?.nextElementSibling;
    if (!sub?.classList.contains('nav-sub')) return null;
    let button = sub.querySelector('[data-item-master-l2]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item';
      button.dataset.itemMasterL2 = 'true';
      button.innerHTML = '<span data-lucide="list-checks"></span>Item master';
      const stockCount = sub.querySelector('[data-subview="Stock count"]');
      if (stockCount?.nextSibling) sub.insertBefore(button, stockCount.nextSibling);
      else sub.appendChild(button);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      });
    }
    state.navButton = button;
    window.lucide?.createIcons?.();
    return button;
  }

  function ensureMount() {
    if (state.mount?.isConnected) return state.mount;
    const inventory = document.getElementById('inventory-view');
    if (!inventory) return null;
    let mount = inventory.querySelector('[data-item-master-l2-workspace]');
    if (!mount) {
      mount = document.createElement('section');
      mount.dataset.itemMasterL2Workspace = 'true';
      mount.className = 'item-master-workspace';
      mount.hidden = true;
      inventory.appendChild(mount);
    }
    state.mount = mount;
    return mount;
  }

  function setBaseInventoryVisible(visible) {
    const inventory = document.getElementById('inventory-view');
    const mount = ensureMount();
    if (!inventory || !mount) return;
    [...inventory.children].forEach((child) => {
      if (child === mount) return;
      if (!visible) {
        if (!child.dataset.itemMasterPreviousDisplay) {
          child.dataset.itemMasterPreviousDisplay = child.style.display || '__default__';
        }
        child.style.display = 'none';
      } else if (child.dataset.itemMasterPreviousDisplay) {
        child.style.display = child.dataset.itemMasterPreviousDisplay === '__default__'
          ? ''
          : child.dataset.itemMasterPreviousDisplay;
        delete child.dataset.itemMasterPreviousDisplay;
      }
    });
    mount.hidden = visible;
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    state.navButton?.classList.remove('active');
    setBaseInventoryVisible(true);
    closeEditor();
  }

  async function activate() {
    const itemNav = document.querySelector('[data-view="inventory"][data-subview="Items"]');
    if (itemNav) itemNav.click();
    state.active = true;
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.remove('active'));
    ensureNav()?.classList.add('active');
    document.getElementById('atlas-page-title').textContent = 'Item master';
    setBaseInventoryVisible(false);
    render();
    await refresh();
  }

  function queue() {
    return Array.isArray(state.workspace?.queue) ? state.workspace.queue : [];
  }

  function categories() {
    return [...new Set(queue().map((entry) => text(entry.item?.category)).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
  }

  function visibleQueue() {
    const query = state.search.toLowerCase();
    return queue().filter((entry) => {
      const item = entry.item || {};
      const haystack = [
        item.name, item.category, item.sku, item.barcode,
        ...(entry.missing_field_labels || []),
        ...(entry.priority_reasons || []),
      ].join(' ').toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (state.tier !== 'all' && entry.priority_tier !== state.tier) return false;
      if (state.missing !== 'all' && !(entry.missing_fields || []).includes(state.missing)) return false;
      if (state.category !== 'all' && item.category !== state.category) return false;
      if (state.draftStatus === 'draft' && !entry.draft) return false;
      if (state.draftStatus === 'not_started' && entry.draft) return false;
      if (state.draftStatus === 'complete' && entry.priority_tier !== 'complete') return false;
      return true;
    });
  }

  function tierLabel(tier) {
    return ({ critical: 'Critical', high: 'High', standard: 'Standard', complete: 'Complete' })[tier] || titleCase(tier);
  }

  function quantityLabel(status) {
    return ({ current: 'Verified current', stale: 'Stale', historical: 'Historical', unverified: 'Unverified' })[status] || titleCase(status);
  }

  function summaryMarkup() {
    const summary = state.workspace?.summary || {};
    return `<div class="item-master-summary" aria-label="Item-master completion summary">
      <article><span>Active items</span><strong>${formatNumber(summary.active_items, '0')}</strong><small>In the completion queue</small></article>
      <article class="is-critical"><span>Critical priority</span><strong>${formatNumber(summary.critical_items, '0')}</strong><small>Service or evidence blockers</small></article>
      <article><span>Private drafts</span><strong>${formatNumber(summary.draft_items, '0')}</strong><small>Not published to production</small></article>
      <article><span>Average completion</span><strong>${formatNumber(summary.average_completion_percent, '0')}%</strong><small>${formatNumber(summary.total_missing_fields, '0')} fields remain</small></article>
    </div>`;
  }

  function policyMarkup() {
    const policy = state.workspace?.policy || {};
    const apply = Boolean(policy.production_apply_enabled);
    return `<div class="item-master-policy ${apply ? 'is-enabled' : 'is-preview'}">
      <span data-lucide="shield-check"></span>
      <div><strong>${apply ? 'Controlled publication enabled' : 'Preview publication disabled'}</strong>
      <p>Private manager drafts only. L2 never changes quantity, creates an inventory movement, submits a supplier order, or alters a recipe without explicit manager publication.</p></div>
    </div>`;
  }

  function toolbarMarkup() {
    return `<div class="item-master-toolbar">
      <label class="item-master-search"><span data-lucide="search"></span><input data-l2-search type="search" value="${escapeHtml(state.search)}" placeholder="Search item, category, blocker…" /></label>
      <select data-l2-tier aria-label="Priority tier">
        ${['all','critical','high','standard','complete'].map((value) => `<option value="${value}" ${state.tier === value ? 'selected' : ''}>${value === 'all' ? 'All priorities' : tierLabel(value)}</option>`).join('')}
      </select>
      <select data-l2-missing aria-label="Missing field">
        <option value="all">All missing fields</option>
        ${MASTER_FIELDS.map(([value, label]) => `<option value="${value}" ${state.missing === value ? 'selected' : ''}>Missing: ${escapeHtml(label)}</option>`).join('')}
      </select>
      <select data-l2-category aria-label="Category">
        <option value="all">All categories</option>
        ${categories().map((value) => `<option value="${escapeHtml(value)}" ${state.category === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
      </select>
      <select data-l2-draft-status aria-label="Draft status">
        <option value="all" ${state.draftStatus === 'all' ? 'selected' : ''}>All records</option>
        <option value="draft" ${state.draftStatus === 'draft' ? 'selected' : ''}>Private drafts</option>
        <option value="not_started" ${state.draftStatus === 'not_started' ? 'selected' : ''}>Not started</option>
        <option value="complete" ${state.draftStatus === 'complete' ? 'selected' : ''}>Complete</option>
      </select>
      <button type="button" class="btn ghost" data-l2-refresh><span data-lucide="refresh-cw"></span>Refresh</button>
    </div>`;
  }

  function queueCard(entry) {
    const item = entry.item || {};
    const missing = Array.isArray(entry.missing_field_labels) ? entry.missing_field_labels : [];
    const reasons = Array.isArray(entry.priority_reasons) ? entry.priority_reasons : [];
    const draftStatus = entry.draft?.status ? titleCase(entry.draft.status) : 'Not started';
    return `<article class="item-master-card is-${escapeHtml(entry.priority_tier)}" data-l2-item="${escapeHtml(item.id)}">
      <header>
        <div><span class="item-master-tier">${escapeHtml(tierLabel(entry.priority_tier))} · ${formatNumber(entry.priority_score, '0')}</span>
        <h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category || 'Uncategorised')} · ${escapeHtml(formatNumber(item.quantity))} ${escapeHtml(item.unit || '')}</p></div>
        <span class="item-master-draft-state">${escapeHtml(draftStatus)}</span>
      </header>
      <div class="item-master-progress"><span style="width:${Math.max(0, Math.min(100, Number(entry.completion_percent) || 0))}%"></span></div>
      <div class="item-master-progress-copy"><strong>${formatNumber(entry.completion_percent, '0')}% complete</strong><span class="quantity-state is-${escapeHtml(entry.quantity_status)}">${escapeHtml(quantityLabel(entry.quantity_status))}</span></div>
      ${reasons.length ? `<ul class="item-master-reasons">${reasons.slice(0, 4).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
      <div class="item-master-missing">${missing.length ? missing.slice(0, 7).map((label) => `<span>${escapeHtml(label)}</span>`).join('') : '<span class="is-complete">All priority fields complete</span>'}</div>
      <footer><span>${formatNumber(entry.linked_recipes?.length, '0')} linked recipe${Number(entry.linked_recipes?.length) === 1 ? '' : 's'} · ${formatNumber(entry.count_observations, '0')} count observation${Number(entry.count_observations) === 1 ? '' : 's'}</span>
      <button type="button" class="btn" data-l2-open="${escapeHtml(item.id)}">${entry.draft ? 'Review draft' : 'Complete item'}</button></footer>
    </article>`;
  }

  function queueMarkup() {
    const entries = visibleQueue();
    if (!entries.length) return '<div class="item-master-empty"><span data-lucide="inbox"></span><h3>No items match this view</h3><p>Clear a filter or refresh the live completion queue.</p></div>';
    return `<div class="item-master-queue">${entries.map(queueCard).join('')}</div>`;
  }

  function render() {
    const mount = ensureMount();
    if (!mount || !state.active) return;
    mount.hidden = false;
    mount.innerHTML = `<div class="item-master-hero"><div><p class="item-master-eyebrow">Checkpoint L2 · Verified Inventory Foundation</p><h1>Item-master completion</h1><p>Prioritise the records that block verified shortage, purchasing and menu guidance. Save privately, review evidence, then publish explicitly.</p></div>
      <button type="button" class="btn ghost" data-l2-refresh ${state.loading ? 'disabled' : ''}><span data-lucide="refresh-cw"></span>${state.loading ? 'Refreshing…' : 'Refresh queue'}</button></div>
      ${state.error ? `<div class="item-master-message is-error"><span data-lucide="triangle-alert"></span>${escapeHtml(state.error)}</div>` : ''}
      ${state.message ? `<div class="item-master-message is-success"><span data-lucide="circle-check"></span>${escapeHtml(state.message)}</div>` : ''}
      ${state.workspace ? `${summaryMarkup()}${policyMarkup()}${toolbarMarkup()}<div class="item-master-result-count">${visibleQueue().length} of ${queue().length} active items</div>${queueMarkup()}` : `<div class="item-master-loading"><span></span><p>${state.loading ? 'Building the prioritised completion queue…' : 'Open the queue to load item-master evidence.'}</p></div>`}
      <div data-l2-editor-host></div>`;
    bind();
    window.lucide?.createIcons?.();
  }

  function bind() {
    const mount = state.mount;
    if (!mount) return;
    mount.querySelectorAll('[data-l2-refresh]').forEach((button) => button.addEventListener('click', refresh));
    mount.querySelector('[data-l2-search]')?.addEventListener('input', (event) => {
      state.search = event.target.value;
      render();
      const input = state.mount?.querySelector('[data-l2-search]');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
    mount.querySelector('[data-l2-tier]')?.addEventListener('change', (event) => { state.tier = event.target.value; render(); });
    mount.querySelector('[data-l2-missing]')?.addEventListener('change', (event) => { state.missing = event.target.value; render(); });
    mount.querySelector('[data-l2-category]')?.addEventListener('change', (event) => { state.category = event.target.value; render(); });
    mount.querySelector('[data-l2-draft-status]')?.addEventListener('change', (event) => { state.draftStatus = event.target.value; render(); });
    mount.querySelectorAll('[data-l2-open]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.l2Open)));
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    state.message = '';
    const serial = ++state.requestSerial;
    render();
    try {
      const payload = await api('snapshot');
      if (serial !== state.requestSerial) return;
      state.workspace = payload;
    } catch (error) {
      if (serial !== state.requestSerial) return;
      state.error = error instanceof Error ? error.message : 'The item-master queue could not be loaded.';
    } finally {
      if (serial === state.requestSerial) state.loading = false;
      render();
    }
  }

  function selectedEntry() {
    return queue().find((entry) => entry.item?.id === state.selectedId) || null;
  }

  function fieldValue(entry, field) {
    const proposed = entry.proposed_values || entry.draft?.proposed_values || {};
    if (Object.prototype.hasOwnProperty.call(proposed, field)) return proposed[field] ?? '';
    return entry.effective_values?.[field] ?? '';
  }

  function supplierOptions(entry) {
    const currentId = text(fieldValue(entry, 'supplier_id'));
    return `<option value="">Select supplier</option>${(state.workspace?.suppliers || []).map((supplier) => `<option value="${escapeHtml(supplier.id)}" ${currentId === supplier.id ? 'selected' : ''}>${escapeHtml(supplier.name)}</option>`).join('')}`;
  }

  function editorMarkup(entry) {
    const item = entry.item;
    const proposedAliases = (entry.proposed_barcode_aliases || entry.draft?.proposed_barcode_aliases || []).map((alias) => alias.code).join('\n');
    const existingAliases = (entry.barcode_aliases || []).filter((alias) => !alias.draft);
    const recipeCandidates = entry.recipe_link_candidates || [];
    const linkedRecipes = entry.linked_recipes || [];
    const draft = entry.draft;
    return `<div class="item-master-backdrop" data-l2-close></div><aside class="item-master-drawer" role="dialog" aria-modal="true" aria-labelledby="item-master-editor-title">
      <header><div><p class="item-master-eyebrow">${escapeHtml(tierLabel(entry.priority_tier))} priority · score ${formatNumber(entry.priority_score, '0')}</p><h2 id="item-master-editor-title">${escapeHtml(item.name)}</h2><p>${escapeHtml(item.category)} · ${escapeHtml(quantityLabel(entry.quantity_status))}</p></div><button type="button" class="item-master-close" data-l2-close aria-label="Close">×</button></header>
      <form data-l2-form>
        <div class="item-master-drawer-body">
          <section><h3>Stock rules</h3><p>Set the operating thresholds used by shortage and replenishment guidance.</p><div class="item-master-form-grid">
            <label><span>Par level</span><input name="par_level" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(entry, 'par_level'))}" /></label>
            <label><span>Critical minimum</span><input name="critical_minimum" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(entry, 'critical_minimum'))}" /></label>
          </div></section>
          <section><h3>Supplier and ordering</h3><p>These fields support reviewable purchase drafts; Atlas never submits an order automatically.</p><div class="item-master-form-grid">
            <label><span>Supplier</span><select name="supplier_id">${supplierOptions(entry)}</select></label>
            <label><span>Supplier product reference</span><input name="supplier_product_reference" value="${escapeHtml(fieldValue(entry, 'supplier_product_reference'))}" /></label>
            <label><span>Lead time (days)</span><input name="lead_time_days" type="number" min="0" step="1" value="${escapeHtml(fieldValue(entry, 'lead_time_days'))}" /></label>
            <label><span>Minimum order quantity</span><input name="minimum_order_quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(fieldValue(entry, 'minimum_order_quantity'))}" /></label>
          </div></section>
          <section><h3>Package and cost</h3><p>Use volume for liquids, weight for solid packages, and preserve the supplier pack description.</p><div class="item-master-form-grid">
            <label><span>Units per case</span><input name="units_per_case" type="number" min="0.01" step="0.01" value="${escapeHtml(fieldValue(entry, 'units_per_case'))}" /></label>
            <label><span>Bottle/package size (ml)</span><input name="size_ml" type="number" min="0.01" step="0.01" value="${escapeHtml(fieldValue(entry, 'size_ml'))}" /></label>
            <label><span>Package weight (g)</span><input name="package_weight_g" type="number" min="0.01" step="0.01" value="${escapeHtml(fieldValue(entry, 'package_weight_g'))}" /></label>
            <label><span>Package description</span><input name="package_size" value="${escapeHtml(fieldValue(entry, 'package_size'))}" placeholder="750 ml bottle, 1 kg bag…" /></label>
            <label><span>Unit cost (ISK)</span><input name="cost_price" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(entry, 'cost_price'))}" /></label>
            <label><span>Case cost (ISK)</span><input name="case_cost" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(entry, 'case_cost'))}" /></label>
            <label class="is-wide"><span>Storage location</span><input name="bin_location" value="${escapeHtml(fieldValue(entry, 'bin_location'))}" placeholder="Back bar shelf 2" /></label>
          </div></section>
          <section><h3>Active recipe links</h3><p>Only explicit, name-matched candidates are offered. Existing links remain visible and unchanged.</p>
            ${linkedRecipes.length ? `<div class="item-master-linked-list"><strong>Already linked</strong>${linkedRecipes.map((link) => `<span>${escapeHtml(link.recipe_name)} · ${escapeHtml(link.quantity)} ${escapeHtml(link.unit)}</span>`).join('')}</div>` : ''}
            ${recipeCandidates.length ? `<div class="item-master-check-list">${recipeCandidates.map((link) => `<label><input type="checkbox" name="recipe_link" value="${escapeHtml(link.ingredient_id)}" ${link.selected ? 'checked' : ''} /><span><strong>${escapeHtml(link.recipe_name)}</strong><small>${escapeHtml(link.item_name)} · ${escapeHtml(link.quantity)} ${escapeHtml(link.unit)}</small></span></label>`).join('')}</div>` : '<p class="item-master-note">No unlinked active-recipe ingredient uniquely matches this item.</p>'}
          </section>
          <section><h3>Barcode aliases</h3><p>Add one verified barcode per line. Existing scanner aliases are read-only in this draft.</p>
            ${existingAliases.length ? `<div class="item-master-aliases">${existingAliases.map((alias) => `<span>${escapeHtml(alias.code || alias.normalized_code)}</span>`).join('')}</div>` : ''}
            <label><span>New aliases</span><textarea name="barcode_aliases" rows="4" placeholder="One barcode per line">${escapeHtml(proposedAliases)}</textarea></label>
          </section>
          <section class="item-master-evidence"><h3>Evidence and blockers</h3><dl>
            <div><dt>Source</dt><dd>${escapeHtml(entry.source_snapshot?.source_file || 'Production inventory record')}</dd></div>
            <div><dt>Source date</dt><dd>${escapeHtml(entry.source_snapshot?.source_updated_at || '—')}</dd></div>
            <div><dt>Verified count</dt><dd>${escapeHtml(entry.verified_quantity == null ? 'No verified current count' : `${formatNumber(entry.verified_quantity)} ${item.unit}`)}</dd></div>
            <div><dt>Counted</dt><dd>${formatNumber(entry.count_observations, '0')} time${Number(entry.count_observations) === 1 ? '' : 's'}</dd></div>
          </dl><div class="item-master-missing">${(entry.missing_field_labels || []).map((label) => `<span>${escapeHtml(label)}</span>`).join('') || '<span class="is-complete">No blockers</span>'}</div></section>
        </div>
        <footer><div><strong>${draft ? `Private draft v${escapeHtml(draft.version)}` : 'No draft saved'}</strong><small>${draft?.updated_at ? `Updated ${escapeHtml(formatDate(draft.updated_at))}` : 'Production remains unchanged until explicit publication.'}</small></div><div class="item-master-drawer-actions"><button type="button" class="btn ghost" data-l2-close>Cancel</button><button type="submit" class="btn" data-l2-save>Save private draft</button>${draft ? '<button type="button" class="btn item-master-publish" data-l2-publish>Publish</button>' : ''}</div></footer>
      </form></aside>`;
  }

  function openEditor(itemId) {
    state.selectedId = itemId;
    const entry = selectedEntry();
    const host = state.mount?.querySelector('[data-l2-editor-host]');
    if (!entry || !host) return;
    host.innerHTML = editorMarkup(entry);
    host.querySelectorAll('[data-l2-close]').forEach((button) => button.addEventListener('click', closeEditor));
    host.querySelector('[data-l2-form]')?.addEventListener('submit', saveDraft);
    host.querySelector('[data-l2-publish]')?.addEventListener('click', publishDraft);
    document.body.classList.add('item-master-editor-open');
    window.lucide?.createIcons?.();
  }

  function closeEditor() {
    state.selectedId = null;
    const host = state.mount?.querySelector('[data-l2-editor-host]');
    if (host) host.innerHTML = '';
    document.body.classList.remove('item-master-editor-open');
  }

  function valuesFromForm(form) {
    const data = new FormData(form);
    const value = (name) => text(data.get(name));
    return {
      par_level: value('par_level'),
      critical_minimum: value('critical_minimum'),
      supplier_id: value('supplier_id'),
      supplier_product_reference: value('supplier_product_reference'),
      lead_time_days: value('lead_time_days'),
      minimum_order_quantity: value('minimum_order_quantity'),
      units_per_case: value('units_per_case'),
      size_ml: value('size_ml'),
      package_weight_g: value('package_weight_g'),
      package_size: value('package_size'),
      cost_price: value('cost_price'),
      case_cost: value('case_cost'),
      bin_location: value('bin_location'),
    };
  }

  async function saveDraft(event) {
    event.preventDefault();
    const entry = selectedEntry();
    const form = event.currentTarget;
    if (!entry || !(form instanceof HTMLFormElement)) return;
    const saveButton = form.querySelector('[data-l2-save]');
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Saving…'; }
    state.error = '';
    state.message = '';
    try {
      const recipeLinks = [...form.querySelectorAll('[name="recipe_link"]:checked')].map((input) => ({ ingredient_id: input.value }));
      const aliases = text(new FormData(form).get('barcode_aliases')).split(/\r?\n/).map((code) => code.trim()).filter(Boolean).map((code) => ({ code, symbology: 'unknown' }));
      const payload = await api('save_draft', 'POST', {
        action: 'save_draft',
        item_id: entry.item.id,
        proposed_values: valuesFromForm(form),
        recipe_links: recipeLinks,
        barcode_aliases: aliases,
      });
      state.workspace = payload;
      state.message = payload.message || `Private draft saved for ${entry.item.name}.`;
      const next = queue().find((item) => item.item?.id === entry.item.id);
      closeEditor();
      render();
      if (next) openEditor(next.item.id);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The item-master draft could not be saved.';
      render();
      openEditor(entry.item.id);
    }
  }

  async function publishDraft(event) {
    event.preventDefault();
    const entry = selectedEntry();
    if (!entry?.draft) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Preparing…';
    state.error = '';
    state.message = '';
    try {
      const payload = await api('publish', 'POST', {
        action: 'publish',
        draft_id: entry.draft.id,
        request_id: `checkpoint-l2:${entry.item.id}:${crypto.randomUUID()}`,
      });
      state.workspace = payload;
      state.message = payload.message || 'Publication plan prepared.';
      closeEditor();
      render();
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Publication could not be prepared.';
      closeEditor();
      render();
    }
  }

  function interceptNavigation(event) {
    const target = event.target instanceof Element ? event.target.closest('.nav-item,[data-service-view]') : null;
    if (!target || target.matches('[data-item-master-l2]')) return;
    if (state.active) deactivate();
  }

  function init() {
    ensureNav();
    ensureMount();
    document.addEventListener('click', interceptNavigation, true);
    state.observer = new MutationObserver(() => {
      ensureNav();
      ensureMount();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('pagehide', () => {
      document.removeEventListener('click', interceptNavigation, true);
      state.observer?.disconnect();
    }, { once: true });
  }

  window.AtlasItemMaster = {
    open: activate,
    close: deactivate,
    refresh,
    snapshot: () => state.workspace,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
