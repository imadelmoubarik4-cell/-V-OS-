(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const ENDPOINT = String(cfg.STOCK_COUNTS_API || '').trim();
  const state = {
    enhancing: false,
    saving: false,
    observer: null,
    messageTimer: null
  };

  const UNIT_LABELS = {
    inventory: 'Base unit',
    bottle: 'Bottle',
    case: 'Case',
    unit: 'Unit',
    litre: 'Litre',
    millilitre: 'Millilitre',
    kilogram: 'Kilogram',
    gram: 'Gram'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatNumber(value) {
    return number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
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

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, body) {
    if (!ENDPOINT) throw new Error('The Checkpoint L1 API is not configured.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in again to continue.');
    const url = new URL(ENDPOINT);
    url.searchParams.set('action', action);
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Stock-count request failed (${response.status}).`);
    return payload;
  }

  function detail() {
    return window.AtlasStockCounts?.detail?.() || null;
  }

  function lineById(id) {
    return (detail()?.lines || []).find((line) => line.id === id) || null;
  }

  function quantityFamily(unit) {
    const normalized = String(unit || '').trim().toLowerCase();
    if (['l', 'ltr', 'litre', 'litres', 'liter', 'liters'].includes(normalized)) return 'litre';
    if (['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'].includes(normalized)) return 'millilitre';
    if (['kg', 'kilogram', 'kilograms'].includes(normalized)) return 'kilogram';
    if (['g', 'gram', 'grams'].includes(normalized)) return 'gram';
    if (['bottle', 'bottles'].includes(normalized)) return 'bottle';
    return 'unit';
  }

  function previewNormalization(line, inputQuantity, inputUnit) {
    const quantity = number(inputQuantity, NaN);
    if (!Number.isFinite(quantity) || quantity < 0) return null;
    const family = quantityFamily(line.inventory_unit);
    const unitsPerCase = number(line.units_per_case_snapshot, 0);
    const sizeMl = number(line.size_ml_snapshot, 0);
    const weightG = number(line.package_weight_g_snapshot, 0);
    let normalized = quantity;
    let basis = 'base unit';

    if (inputUnit === 'case') {
      if (!unitsPerCase) return null;
      if (['unit', 'bottle'].includes(family)) normalized = quantity * unitsPerCase;
      else if (['litre', 'millilitre'].includes(family) && sizeMl) {
        const ml = quantity * unitsPerCase * sizeMl;
        normalized = family === 'litre' ? ml / 1000 : ml;
      } else if (['kilogram', 'gram'].includes(family) && weightG) {
        const grams = quantity * unitsPerCase * weightG;
        normalized = family === 'kilogram' ? grams / 1000 : grams;
      } else return null;
      basis = 'case conversion';
    } else if (inputUnit === 'bottle' || inputUnit === 'unit') {
      if (['litre', 'millilitre'].includes(family)) {
        if (!sizeMl) return null;
        const ml = quantity * sizeMl;
        normalized = family === 'litre' ? ml / 1000 : ml;
      } else if (['kilogram', 'gram'].includes(family)) {
        if (!weightG) return null;
        const grams = quantity * weightG;
        normalized = family === 'kilogram' ? grams / 1000 : grams;
      }
      basis = inputUnit === 'bottle' ? 'bottle conversion' : 'unit conversion';
    } else if (inputUnit === 'litre' || inputUnit === 'millilitre') {
      const ml = inputUnit === 'litre' ? quantity * 1000 : quantity;
      if (family === 'litre') normalized = ml / 1000;
      else if (family === 'millilitre') normalized = ml;
      else if (['unit', 'bottle'].includes(family) && sizeMl) normalized = ml / sizeMl;
      else return null;
      basis = 'volume conversion';
    } else if (inputUnit === 'kilogram' || inputUnit === 'gram') {
      const grams = inputUnit === 'kilogram' ? quantity * 1000 : quantity;
      if (family === 'kilogram') normalized = grams / 1000;
      else if (family === 'gram') normalized = grams;
      else if (['unit', 'bottle'].includes(family) && weightG) normalized = grams / weightG;
      else return null;
      basis = 'weight conversion';
    }

    return { normalized, basis };
  }

  function updatePreview(form, line) {
    const input = form.querySelector('[data-line-quantity], input[name="quantity"]');
    const select = form.querySelector('[data-l1-count-unit]');
    const preview = form.querySelector('[data-l1-conversion-preview]');
    if (!input || !select || !preview) return;
    const result = previewNormalization(line, input.value, select.value);
    preview.textContent = result
      ? `${formatNumber(result.normalized)} ${line.inventory_unit || 'units'} after ${result.basis}`
      : 'Complete package information is required for this conversion.';
    preview.classList.toggle('is-warning', !result);
  }

  function unitOptions(line) {
    const supported = Array.isArray(line.supported_count_units) && line.supported_count_units.length
      ? line.supported_count_units
      : ['inventory'];
    return supported.map((unit) => `<option value="${escapeHtml(unit)}">${escapeHtml(UNIT_LABELS[unit] || unit)}</option>`).join('');
  }

  function addQuantityStatus(form, line) {
    const headerActions = form.querySelector('header > div:last-child');
    if (!headerActions || headerActions.querySelector('[data-l1-quantity-status]')) return;
    const status = line.quantity_status || 'unverified';
    const pill = document.createElement('span');
    pill.className = `stock-count-pill l1-quantity-status is-${status}`;
    pill.dataset.l1QuantityStatus = 'true';
    pill.textContent = `${status} quantity`;
    headerActions.prepend(pill);
  }

  function enhanceLineForm(form) {
    const line = lineById(form.dataset.lineId);
    if (!line) return;
    addQuantityStatus(form, line);
    form.classList.toggle('has-source-conflict', Boolean(line.source_changed_since_start));

    const quantityInput = form.querySelector('[data-line-quantity]');
    const quantityWrap = quantityInput?.parentElement;
    if (!quantityInput || !quantityWrap) return;

    let select = form.querySelector('[data-l1-count-unit]');
    if (!select) {
      select = document.createElement('select');
      select.dataset.l1CountUnit = 'true';
      select.setAttribute('aria-label', `Count unit for ${line.item_name}`);
      select.innerHTML = unitOptions(line);
      const baseUnit = quantityWrap.querySelector('em');
      quantityWrap.insertBefore(select, baseUnit || null);
      if (baseUnit) {
        baseUnit.dataset.l1BaseUnit = 'true';
        baseUnit.textContent = `base: ${line.inventory_unit || 'units'}`;
      }

      const preview = document.createElement('small');
      preview.dataset.l1ConversionPreview = 'true';
      preview.className = 'l1-conversion-preview';
      quantityWrap.parentElement?.appendChild(preview);
      select.addEventListener('change', () => updatePreview(form, line));
      quantityInput.addEventListener('input', () => updatePreview(form, line));
    }

    const preferredUnit = line.observed_input_unit || 'inventory';
    if ([...select.options].some((option) => option.value === preferredUnit)) select.value = preferredUnit;
    if (line.observed_input_quantity !== null && line.observed_input_quantity !== undefined) {
      quantityInput.value = String(line.observed_input_quantity);
    }
    updatePreview(form, line);
  }

  function matchedScanLine(form) {
    if (form.dataset.l1LineId) return lineById(form.dataset.l1LineId);
    const name = form.closest('.stock-count-scan-result')?.querySelector('h3')?.textContent?.trim();
    const line = (detail()?.lines || []).find((entry) => entry.item_name === name) || null;
    if (line) form.dataset.l1LineId = line.id;
    return line;
  }

  function enhanceScanForm(form) {
    const line = matchedScanLine(form);
    if (!line) return;
    const quantityInput = form.querySelector('input[name="quantity"]');
    const quantityWrap = quantityInput?.parentElement;
    if (!quantityInput || !quantityWrap || form.querySelector('[data-l1-count-unit]')) return;

    const select = document.createElement('select');
    select.dataset.l1CountUnit = 'true';
    select.setAttribute('aria-label', `Count unit for ${line.item_name}`);
    select.innerHTML = unitOptions(line);
    select.value = line.observed_input_unit || 'inventory';
    quantityWrap.insertBefore(select, quantityWrap.querySelector('em') || null);
    const preview = document.createElement('small');
    preview.dataset.l1ConversionPreview = 'true';
    preview.className = 'l1-conversion-preview';
    quantityWrap.parentElement?.appendChild(preview);
    if (line.observed_input_quantity !== null && line.observed_input_quantity !== undefined) {
      quantityInput.value = String(line.observed_input_quantity);
    }
    select.addEventListener('change', () => updatePreview(form, line));
    quantityInput.addEventListener('input', () => updatePreview(form, line));
    updatePreview(form, line);
  }

  function classificationMarkup() {
    const summary = window.AtlasStockCounts?.snapshot?.()?.summary || {};
    return `<section class="l1-classification-strip" data-l1-classification>
      <article><span>Verified current</span><strong>${formatNumber(summary.current_items || 0)}</strong></article>
      <article><span>Stale</span><strong>${formatNumber(summary.stale_items || 0)}</strong></article>
      <article><span>Historical</span><strong>${formatNumber(summary.historical_items || 0)}</strong></article>
      <article><span>Unverified</span><strong>${formatNumber(summary.unverified_items || 0)}</strong></article>
    </section>`;
  }

  function enhanceClassification() {
    const workspace = document.getElementById('stock-count-workspace');
    const trust = workspace?.querySelector('.stock-count-trust');
    if (!workspace || !trust || workspace.querySelector('[data-l1-classification]')) return;
    trust.insertAdjacentHTML('afterend', classificationMarkup());
  }

  function publicationBanner(publication, session) {
    if (session?.publication_status === 'published') {
      return `<div class="stock-count-review-banner l1-publication-banner is-published" data-l1-publication-banner><i data-lucide="badge-check"></i><span>This verified count was published as controlled inventory adjustments. The complete count evidence and prior quantities remain preserved.</span></div>`;
    }
    if (!publication) return '';
    if (publication.status === 'blocked') {
      return `<div class="stock-count-review-banner l1-publication-banner is-blocked" data-l1-publication-banner><i data-lucide="shield-alert"></i><span><strong>Publication blocked.</strong> ${escapeHtml(publication.blocked_reason || 'Review the publication evidence before trying again.')}</span></div>`;
    }
    if (publication.status === 'ready') {
      return `<div class="stock-count-review-banner l1-publication-banner" data-l1-publication-banner><i data-lucide="clipboard-check"></i><span>The manager-approved publication plan is ready. Only its explicit Publish action may create controlled count adjustments.</span></div>`;
    }
    return '';
  }

  function enhancePublication() {
    const current = detail();
    const session = current?.session;
    const permissions = current?.permissions || {};
    const publication = current?.publication || null;
    const actions = document.querySelector('.stock-count-detail-actions');
    const detailPanel = document.querySelector('.stock-count-detail-panel');
    if (!session || !actions || !detailPanel) return;

    if (permissions.can_prepare_publication && !actions.querySelector('[data-l1-prepare-publication]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stock-count-primary';
      button.dataset.l1PreparePublication = 'true';
      button.innerHTML = '<i data-lucide="file-check-2"></i>Prepare publication';
      actions.appendChild(button);
    }

    const policy = window.AtlasStockCountsL1?.lastPolicy || {};
    if (publication?.status === 'ready'
        && permissions.production_apply_enabled
        && policy.publication_environment_enabled
        && !actions.querySelector('[data-l1-publish]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stock-count-primary is-publish';
      button.dataset.l1Publish = 'true';
      button.innerHTML = '<i data-lucide="package-check"></i>Publish verified count';
      actions.appendChild(button);
    }

    if (!detailPanel.querySelector('[data-l1-publication-banner]')) {
      const markup = publicationBanner(publication, session);
      if (markup) detailPanel.querySelector('.stock-count-detail-head')?.insertAdjacentHTML('afterend', markup);
    }
  }

  function showMessage(message, tone = 'success') {
    const workspace = document.getElementById('stock-count-workspace');
    if (!workspace) return;
    workspace.querySelector('[data-l1-message]')?.remove();
    const alert = document.createElement('div');
    alert.dataset.l1Message = 'true';
    alert.className = `stock-count-alert is-${tone}`;
    alert.innerHTML = `<i data-lucide="${tone === 'error' ? 'triangle-alert' : 'circle-check-big'}"></i><span>${escapeHtml(message)}</span>`;
    workspace.querySelector('.stock-count-hero')?.insertAdjacentElement('afterend', alert);
    window.lucide?.createIcons?.();
    window.clearTimeout(state.messageTimer);
    state.messageTimer = window.setTimeout(() => alert.remove(), 6500);
  }

  async function refreshSession(sessionId) {
    if (window.AtlasStockCounts?.openSession && sessionId) {
      await window.AtlasStockCounts.openSession(sessionId);
    } else {
      await window.AtlasStockCounts?.refresh?.();
    }
    scheduleEnhance();
  }

  async function saveForm(form, line, source = 'manual') {
    if (state.saving) return;
    const current = detail();
    const sessionId = current?.session?.id;
    const input = form.querySelector('[data-line-quantity], input[name="quantity"]');
    const select = form.querySelector('[data-l1-count-unit]');
    const note = form.querySelector('[data-line-note], textarea[name="note"]');
    const quantity = Number(input?.value);
    if (!sessionId || !line || !Number.isFinite(quantity) || quantity < 0) {
      showMessage('Enter an observed quantity of zero or more.', 'error');
      return;
    }
    state.saving = true;
    try {
      const payload = await api('save-line', {
        session_id: sessionId,
        line_id: line.id,
        line_status: 'counted',
        observed_input_quantity: quantity,
        observed_input_unit: select?.value || 'inventory',
        count_method: source,
        note: note?.value?.trim() || null,
        skipped_reason: null,
        expected_version: line.version,
        evidence: {
          capture_surface: source === 'manual' ? 'inventory_count_line' : 'mobile_scanner',
          unit_selected: select?.value || 'inventory',
          client_recorded_at: new Date().toISOString()
        }
      });
      window.AtlasStockCountsL1.lastPolicy = payload.policy || window.AtlasStockCountsL1.lastPolicy;
      showMessage(`${line.item_name} count saved with its original unit evidence.`);
      await refreshSession(sessionId);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'The count could not be saved.', 'error');
    } finally {
      state.saving = false;
    }
  }

  function handleSubmit(event, form) {
    if (!(form instanceof HTMLFormElement)) return false;
    if (form.matches('[data-count-line-form]')) {
      event.preventDefault();
      const line = lineById(form.dataset.lineId);
      saveForm(form, line, 'manual');
      return true;
    }
    if (form.matches('[data-save-scanned-count]')) {
      event.preventDefault();
      const line = matchedScanLine(form);
      const source = document.querySelector('[data-count-video]') ? 'barcode' : 'manual';
      saveForm(form, line, source);
      return true;
    }
    return false;
  }

  async function preparePublication() {
    const current = detail();
    const sessionId = current?.session?.id;
    if (!sessionId || state.saving) return;
    state.saving = true;
    try {
      const requestId = current.publication?.request_id || randomUuid();
      const payload = await api('prepare-publication', { session_id: sessionId, request_id: requestId });
      window.AtlasStockCountsL1.lastPolicy = payload.policy || window.AtlasStockCountsL1.lastPolicy;
      const blocked = payload.detail?.publication?.status === 'blocked';
      showMessage(blocked
        ? payload.detail.publication.blocked_reason || 'Publication is safely blocked.'
        : 'Manager publication plan prepared.', blocked ? 'error' : 'success');
      await refreshSession(sessionId);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'The publication plan could not be prepared.', 'error');
    } finally {
      state.saving = false;
    }
  }

  async function publish() {
    const current = detail();
    const sessionId = current?.session?.id;
    const requestId = current?.publication?.request_id;
    if (!sessionId || !requestId || state.saving) return;
    if (!window.confirm('Publish this manager-verified count as controlled inventory adjustments? This is the only L1 step that may change live stock.')) return;
    state.saving = true;
    try {
      const payload = await api('publish', { session_id: sessionId, request_id: requestId });
      window.AtlasStockCountsL1.lastPolicy = payload.policy || window.AtlasStockCountsL1.lastPolicy;
      showMessage('Verified count published. Prior quantities and count evidence remain preserved.');
      await refreshSession(sessionId);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'The verified count could not be published.', 'error');
    } finally {
      state.saving = false;
    }
  }

  function enhance() {
    if (state.enhancing) return;
    state.enhancing = true;
    try {
      document.querySelectorAll('[data-count-line-form]').forEach(enhanceLineForm);
      document.querySelectorAll('[data-save-scanned-count]').forEach(enhanceScanForm);
      enhanceClassification();
      enhancePublication();
      window.lucide?.createIcons?.();
    } finally {
      state.enhancing = false;
    }
  }

  function scheduleEnhance() {
    window.requestAnimationFrame(enhance);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-l1-prepare-publication]')) {
      event.preventDefault();
      preparePublication();
    } else if (target.closest('[data-l1-publish]')) {
      event.preventDefault();
      publish();
    }
  }

  function init() {
    document.addEventListener('click', handleClick, true);
    state.observer = new MutationObserver(scheduleEnhance);
    state.observer.observe(document.body, { childList: true, subtree: true });
    scheduleEnhance();
    window.addEventListener('pagehide', () => state.observer?.disconnect(), { once: true });
  }

  window.AtlasStockCountsL1 = {
    handleSubmit,
    enhance: scheduleEnhance,
    lastPolicy: null,
    version: '0.2.0'
  };

  init();
})();
