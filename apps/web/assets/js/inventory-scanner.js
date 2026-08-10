(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const ZXING_ESM_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/+esm';
  const DEFAULT_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

  const state = {
    snapshot: null,
    items: [],
    staff: null,
    policy: null,
    overlay: null,
    observer: null,
    open: false,
    loading: false,
    submitting: false,
    scanning: false,
    scanEngine: null,
    stream: null,
    scanTimer: null,
    nativeDetector: null,
    zxingModule: null,
    zxingControls: null,
    zxingReader: null,
    code: '',
    symbology: 'unknown',
    source: 'manual',
    lookup: null,
    selectedItemId: null,
    itemQuery: '',
    note: '',
    message: null,
    error: null,
    lastFocused: null,
    initialized: false
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
    const parsed = number(value);
    if (Number.isInteger(parsed)) return String(parsed).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return parsed.toLocaleString('en-US', { maximumFractionDigits: 2 }).replace(/,/g, '·').replace(/\./g, ',').replace(/·/g, '.');
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function scannerEndpoint() {
    return String(cfg.INVENTORY_SCANNER_API || '').trim();
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

  async function api(action, options = {}) {
    const endpoint = scannerEndpoint();
    if (!endpoint) throw new Error('Checkpoint B scanner API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas before using the bottle scanner.');

    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });

    const response = await fetch(url, {
      method: options.method || 'GET',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Scanner request failed (${response.status}).`);
    return payload;
  }

  function liveApplyEnabled() {
    return Boolean(state.snapshot?.settings?.live_apply_enabled);
  }

  function allowedFormats() {
    const configured = state.snapshot?.settings?.allowed_formats;
    return Array.isArray(configured) && configured.length ? configured : DEFAULT_FORMATS;
  }

  function itemById(id) {
    return state.items.find((item) => item.id === id) || null;
  }

  function matchedItem() {
    return state.lookup?.matched ? state.lookup.item || null : null;
  }

  function currentStep() {
    if (state.loading && !state.snapshot) return 'loading';
    if (state.scanning) return 'scanning';
    if (state.lookup?.matched) return 'matched';
    if (state.code && state.lookup && !state.lookup.matched) return 'unmatched';
    return 'ready';
  }

  function scannerSupport() {
    return {
      secure: window.isSecureContext,
      camera: Boolean(navigator.mediaDevices?.getUserMedia),
      nativeBarcode: 'BarcodeDetector' in window,
      imageBitmap: 'createImageBitmap' in window
    };
  }

  function renderModeBadge() {
    return liveApplyEnabled()
      ? '<span class="inventory-scanner-mode is-live"><i data-lucide="radio"></i>Live count mode</span>'
      : '<span class="inventory-scanner-mode is-shadow"><i data-lucide="shield-check"></i>Preview · no live quantity change</span>';
  }

  function cameraMarkup() {
    const support = scannerSupport();
    const cameraNote = !support.secure
      ? 'Camera access requires the secure preview address. Manual code entry remains available.'
      : !support.camera
      ? 'This browser does not expose a camera API. Use a barcode photo or enter the code manually.'
      : 'Use the rear camera and place the full barcode inside the frame.';

    return `<section class="inventory-scanner-capture">
      <div class="inventory-scanner-viewport ${state.scanning ? 'is-scanning' : ''}">
        <video id="inventory-scanner-video" playsinline muted aria-label="Bottle barcode camera"></video>
        <div class="inventory-scanner-placeholder">
          <i data-lucide="scan-barcode"></i>
          <strong>${state.scanning ? 'Looking for a barcode…' : 'Camera ready when you are'}</strong>
          <span>${escapeHtml(cameraNote)}</span>
        </div>
        <div class="inventory-scanner-frame" aria-hidden="true"><span></span></div>
        ${state.scanning ? `<div class="inventory-scanner-engine">${escapeHtml(state.scanEngine === 'native' ? 'Native detector' : state.scanEngine === 'zxing' ? 'ZXing fallback' : 'Starting camera')}</div>` : ''}
      </div>

      <div class="inventory-scanner-actions">
        ${state.scanning
          ? '<button type="button" class="inventory-scanner-secondary" data-scanner-stop><i data-lucide="square"></i>Stop camera</button>'
          : '<button type="button" class="inventory-scanner-primary" data-scanner-start><i data-lucide="camera"></i>Start camera</button>'}
        <label class="inventory-scanner-secondary is-file"><i data-lucide="image-up"></i>Scan photo<input type="file" accept="image/*" capture="environment" data-scanner-image hidden /></label>
      </div>

      <form class="inventory-scanner-manual" data-scanner-manual-form>
        <label for="inventory-scanner-code">Barcode or SKU</label>
        <div><input id="inventory-scanner-code" autocomplete="off" inputmode="numeric" placeholder="Enter the number below the barcode" value="${escapeHtml(state.code)}" /><button type="submit">Look up</button></div>
      </form>

      <div class="inventory-scanner-privacy"><i data-lucide="eye-off"></i><span>Camera frames and uploaded barcode photos are processed on this device and are not stored by Atlas.</span></div>
    </section>`;
  }

  function readyResultMarkup() {
    const summary = state.snapshot?.summary || {};
    return `<section class="inventory-scanner-result is-empty">
      <div class="inventory-scanner-result-icon"><i data-lucide="bottle"></i></div>
      <h3>Scan one bottle</h3>
      <p>Atlas will identify a linked inventory item, show its current quantity, and let staff enter the observed count.</p>
      <div class="inventory-scanner-mini-stats">
        <div><strong>${formatNumber(summary.active_aliases || 0)}</strong><span>Linked codes</span></div>
        <div><strong>${formatNumber(summary.count_events || 0)}</strong><span>Count events</span></div>
      </div>
      <div class="inventory-scanner-rule"><i data-lucide="badge-check"></i><span>A manager must confirm the first link between a barcode and an inventory item.</span></div>
    </section>`;
  }

  function loadingResultMarkup() {
    return `<section class="inventory-scanner-result is-empty"><div class="inventory-scanner-spinner"><i data-lucide="loader-circle"></i></div><h3>Loading scanner</h3><p>Checking inventory items, verified barcode links and preview safety settings.</p></section>`;
  }

  function itemCardMarkup(item) {
    const image = item.image_url
      ? `<img src="${escapeHtml(item.image_url)}" alt="" />`
      : '<div class="inventory-scanner-item-fallback"><i data-lucide="wine"></i></div>';
    return `<article class="inventory-scanner-item-card">
      <div class="inventory-scanner-item-image">${image}</div>
      <div class="inventory-scanner-item-copy">
        <span>${escapeHtml(item.category || 'Inventory')}</span>
        <h3>${escapeHtml(item.name)}</h3>
        <p>${item.bin_location ? `${escapeHtml(item.bin_location)} · ` : ''}${escapeHtml(humanize(state.lookup?.match_source || 'verified link'))}</p>
      </div>
      <div class="inventory-scanner-current"><span>Current</span><strong>${formatNumber(item.quantity)} ${escapeHtml(item.unit || '')}</strong></div>
    </article>`;
  }

  function matchedResultMarkup() {
    const item = matchedItem();
    if (!item) return readyResultMarkup();
    const buttonCopy = liveApplyEnabled() ? 'Save inventory count' : 'Test count safely';
    const helper = liveApplyEnabled()
      ? 'The observed quantity will replace the current count and create an inventory movement.'
      : 'The observed quantity will be recorded only in the isolated scanner audit. Live inventory will remain unchanged.';

    return `<section class="inventory-scanner-result is-matched">
      <div class="inventory-scanner-code-line"><span>Scanned code</span><strong>${escapeHtml(state.code)}</strong><small>${escapeHtml(humanize(state.symbology))}</small></div>
      ${itemCardMarkup(item)}
      <form class="inventory-scanner-count-form" data-scanner-count-form>
        <label><span>Observed quantity</span><div class="inventory-scanner-quantity"><button type="button" data-scanner-step="-1" aria-label="Decrease quantity">−</button><input id="inventory-scanner-quantity" type="number" min="0" step="0.1" value="${escapeHtml(item.quantity)}" required /><button type="button" data-scanner-step="1" aria-label="Increase quantity">+</button><em>${escapeHtml(item.unit || 'units')}</em></div></label>
        <label><span>Count note</span><textarea id="inventory-scanner-note" rows="2" placeholder="Optional: open bottle estimate, damaged bottle, storage note…">${escapeHtml(state.note)}</textarea></label>
        <p>${escapeHtml(helper)}</p>
        <button type="submit" class="inventory-scanner-primary" ${state.staff?.can_count && !state.submitting ? '' : 'disabled'}><i data-lucide="clipboard-check"></i>${escapeHtml(buttonCopy)}</button>
      </form>
      <button type="button" class="inventory-scanner-text-button" data-scanner-reset><i data-lucide="scan-line"></i>Scan another bottle</button>
    </section>`;
  }

  function filteredItems() {
    const query = state.itemQuery.trim().toLowerCase();
    const items = state.items.slice();
    if (!query) return items.slice(0, 12);
    return items.filter((item) => [item.name, item.category, item.bin_location]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)))
      .slice(0, 20);
  }

  function linkItemMarkup(item) {
    const selected = state.selectedItemId === item.id;
    return `<button type="button" class="inventory-scanner-link-item ${selected ? 'is-selected' : ''}" data-scanner-select-item="${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category || 'Inventory')} · ${formatNumber(item.quantity)} ${escapeHtml(item.unit || '')}${item.bin_location ? ` · ${escapeHtml(item.bin_location)}` : ''}</small></span>
      <i data-lucide="${selected ? 'circle-check-big' : 'circle'}"></i>
    </button>`;
  }

  function unmatchedResultMarkup() {
    const canLink = Boolean(state.staff?.can_link);
    const items = filteredItems();
    return `<section class="inventory-scanner-result is-unmatched">
      <div class="inventory-scanner-unmatched-icon"><i data-lucide="scan-search"></i></div>
      <span class="inventory-scanner-kicker">No verified match</span>
      <h3>${escapeHtml(state.code)}</h3>
      <p>None of the current VÁ inventory items has this barcode or SKU linked yet.</p>
      ${canLink ? `<div class="inventory-scanner-linker">
        <label for="inventory-scanner-item-search">Link to an inventory item</label>
        <input id="inventory-scanner-item-search" type="search" placeholder="Search item name, category or location" value="${escapeHtml(state.itemQuery)}" autocomplete="off" />
        <div class="inventory-scanner-link-list">${items.length ? items.map(linkItemMarkup).join('') : '<p class="inventory-scanner-no-results">No inventory item matches this search.</p>'}</div>
        <button type="button" class="inventory-scanner-primary" data-scanner-link ${state.selectedItemId && !state.submitting ? '' : 'disabled'}><i data-lucide="link-2"></i>Confirm barcode link</button>
        <small>The link is private, verified and auditable. Atlas will never infer a product from an uncertain image match.</small>
      </div>` : `<div class="inventory-scanner-rule is-warning"><i data-lucide="shield-alert"></i><span>A manager must link this barcode before staff can use it for inventory counts.</span></div>`}
      <button type="button" class="inventory-scanner-text-button" data-scanner-reset><i data-lucide="scan-line"></i>Try another code</button>
    </section>`;
  }

  function resultMarkup() {
    if (currentStep() === 'loading') return loadingResultMarkup();
    if (currentStep() === 'matched') return matchedResultMarkup();
    if (currentStep() === 'unmatched') return unmatchedResultMarkup();
    return readyResultMarkup();
  }

  function recentMarkup() {
    const events = Array.isArray(state.snapshot?.recent_events) ? state.snapshot.recent_events : [];
    if (!events.length) return '';
    return `<details class="inventory-scanner-history"><summary>Recent scanner activity</summary><div>${events.slice(0, 8).map((event) => `<article><span>${escapeHtml(event.item_name)}</span><strong>${event.observed_quantity == null ? humanize(event.event_type) : `${formatNumber(event.observed_quantity)} ${escapeHtml(event.unit || '')}`}</strong><small>${escapeHtml(humanize(event.status))}${event.actor_label ? ` · ${escapeHtml(event.actor_label)}` : ''}</small></article>`).join('')}</div></details>`;
  }

  function overlayMarkup() {
    return `<div class="inventory-scanner-backdrop" data-scanner-close></div>
      <section class="inventory-scanner-panel" role="dialog" aria-modal="true" aria-labelledby="inventory-scanner-title">
        <header class="inventory-scanner-header">
          <div><span>Checkpoint B · Mobile inventory</span><h2 id="inventory-scanner-title">Bottle scanner</h2><p>Scan a barcode, confirm the product, then enter the observed quantity.</p></div>
          <div>${renderModeBadge()}<button type="button" class="inventory-scanner-close" data-scanner-close aria-label="Close bottle scanner"><i data-lucide="x"></i></button></div>
        </header>
        ${state.error ? `<div class="inventory-scanner-message is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>` : ''}
        ${state.message ? `<div class="inventory-scanner-message is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>` : ''}
        <div class="inventory-scanner-layout">${cameraMarkup()}${resultMarkup()}</div>
        ${recentMarkup()}
        <footer class="inventory-scanner-trust"><i data-lucide="shield-check"></i><span>Verified item link required · Staff identity recorded · Images not uploaded · Uncertain matches never change inventory</span></footer>
      </section>`;
  }

  function ensureOverlay() {
    if (state.overlay?.isConnected) return state.overlay;
    const overlay = document.createElement('div');
    overlay.className = 'inventory-scanner-overlay';
    overlay.dataset.inventoryScanner = 'true';
    overlay.hidden = true;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    return overlay;
  }

  function render() {
    if (!state.open) return;
    const overlay = ensureOverlay();
    overlay.innerHTML = overlayMarkup();
    overlay.hidden = false;
    document.body.classList.add('inventory-scanner-open');
    window.lucide?.createIcons?.();
  }

  async function loadSnapshot() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const payload = await api('snapshot');
      state.snapshot = payload.scanner || {};
      state.items = Array.isArray(payload.items) ? payload.items : [];
      state.staff = payload.staff || null;
      state.policy = payload.policy || null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The scanner could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  function resetResult() {
    state.code = '';
    state.symbology = 'unknown';
    state.source = 'manual';
    state.lookup = null;
    state.selectedItemId = null;
    state.itemQuery = '';
    state.note = '';
    state.message = null;
    state.error = null;
    render();
  }

  async function openScanner() {
    state.lastFocused = document.activeElement;
    state.open = true;
    state.error = null;
    state.message = null;
    ensureOverlay();
    render();
    if (!state.snapshot) await loadSnapshot();
    requestAnimationFrame(() => state.overlay?.querySelector('[data-scanner-start]')?.focus());
  }

  function stopScanner() {
    state.scanning = false;
    state.scanEngine = null;
    if (state.scanTimer) {
      window.clearTimeout(state.scanTimer);
      state.scanTimer = null;
    }
    if (state.zxingControls?.stop) {
      try { state.zxingControls.stop(); } catch (_) { /* no-op */ }
    }
    state.zxingControls = null;
    state.zxingReader = null;
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    const video = document.getElementById('inventory-scanner-video');
    if (video) {
      try { video.pause(); } catch (_) { /* no-op */ }
      video.srcObject = null;
    }
  }

  function closeScanner() {
    stopScanner();
    state.open = false;
    if (state.overlay) state.overlay.hidden = true;
    document.body.classList.remove('inventory-scanner-open');
    if (state.lastFocused instanceof HTMLElement) state.lastFocused.focus();
  }

  async function loadZxing() {
    if (state.zxingModule) return state.zxingModule;
    state.zxingModule = await import(ZXING_ESM_URL);
    return state.zxingModule;
  }

  async function supportedNativeFormats() {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const supported = typeof window.BarcodeDetector.getSupportedFormats === 'function'
        ? await window.BarcodeDetector.getSupportedFormats()
        : allowedFormats();
      return allowedFormats().filter((format) => supported.includes(format));
    } catch (_) {
      return [];
    }
  }

  async function startNativeCamera(video, formats) {
    state.scanEngine = 'native';
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    video.srcObject = state.stream;
    await video.play();
    state.nativeDetector = new window.BarcodeDetector({ formats });

    let detecting = false;
    const loop = async () => {
      if (!state.scanning || detecting) return;
      detecting = true;
      try {
        if (video.readyState >= 2) {
          const results = await state.nativeDetector.detect(video);
          if (results?.length) {
            const result = results[0];
            await handleCode(result.rawValue, result.format || 'unknown', 'camera_native');
            return;
          }
        }
      } catch (_) {
        // Individual frames can fail while the camera is focusing. Keep scanning.
      } finally {
        detecting = false;
      }
      if (state.scanning) state.scanTimer = window.setTimeout(loop, 220);
    };
    loop();
  }

  async function startZxingCamera(video) {
    state.scanEngine = 'zxing';
    const module = await loadZxing();
    state.zxingReader = new module.BrowserMultiFormatReader();
    state.zxingControls = await state.zxingReader.decodeFromVideoDevice(undefined, video, async (result) => {
      if (!state.scanning || !result) return;
      const text = typeof result.getText === 'function' ? result.getText() : String(result.text || '');
      const format = typeof result.getBarcodeFormat === 'function' ? String(result.getBarcodeFormat()) : 'unknown';
      if (text) await handleCode(text, format, 'camera_zxing');
    });
  }

  async function startCamera() {
    state.error = null;
    state.message = null;
    const support = scannerSupport();
    if (!support.secure) {
      state.error = 'Camera access is available only from a secure HTTPS address. Enter the code manually or use a barcode photo.';
      render();
      return;
    }
    if (!support.camera) {
      state.error = 'This browser does not provide camera access. Enter the code manually or use a barcode photo.';
      render();
      return;
    }

    stopScanner();
    state.scanning = true;
    state.scanEngine = null;
    render();
    const video = document.getElementById('inventory-scanner-video');
    if (!video) return;

    try {
      const nativeFormats = await supportedNativeFormats();
      if (nativeFormats.length) await startNativeCamera(video, nativeFormats);
      else await startZxingCamera(video);
      renderScanningEngineOnly();
    } catch (error) {
      stopScanner();
      const name = error?.name || '';
      state.error = name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in the browser, or use manual entry.'
        : name === 'NotFoundError'
        ? 'No camera was found on this device.'
        : `The camera could not start. ${error instanceof Error ? error.message : ''}`.trim();
      render();
    }
  }

  function renderScanningEngineOnly() {
    const engine = state.overlay?.querySelector('.inventory-scanner-engine');
    if (engine) engine.textContent = state.scanEngine === 'native' ? 'Native detector' : 'ZXing fallback';
  }

  async function decodeImage(file) {
    if (!file) return;
    stopScanner();
    state.error = null;
    state.message = 'Reading the barcode photo on this device…';
    render();
    let objectUrl = null;
    try {
      const nativeFormats = await supportedNativeFormats();
      if (nativeFormats.length && scannerSupport().imageBitmap) {
        const bitmap = await window.createImageBitmap(file);
        try {
          const detector = new window.BarcodeDetector({ formats: nativeFormats });
          const results = await detector.detect(bitmap);
          if (!results?.length) throw new Error('No supported barcode was found in this image.');
          await handleCode(results[0].rawValue, results[0].format || 'unknown', 'image_native');
          return;
        } finally {
          bitmap.close?.();
        }
      }

      const module = await loadZxing();
      const reader = new module.BrowserMultiFormatReader();
      objectUrl = URL.createObjectURL(file);
      const result = await reader.decodeFromImageUrl(objectUrl);
      const text = typeof result.getText === 'function' ? result.getText() : String(result.text || '');
      const format = typeof result.getBarcodeFormat === 'function' ? String(result.getBarcodeFormat()) : 'unknown';
      if (!text) throw new Error('No supported barcode was found in this image.');
      await handleCode(text, format, 'image_zxing');
    } catch (error) {
      state.message = null;
      state.error = error instanceof Error ? error.message : 'No supported barcode was found in this image.';
      render();
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function handleCode(rawCode, symbology = 'unknown', source = 'manual') {
    const code = String(rawCode || '').trim();
    if (!code) return;
    stopScanner();
    state.code = code;
    state.symbology = String(symbology || 'unknown').toLowerCase().replace(/[\s-]+/g, '_');
    state.source = source;
    state.lookup = null;
    state.selectedItemId = null;
    state.itemQuery = '';
    state.message = null;
    state.error = null;
    render();

    try {
      const payload = await api('lookup', { params: { code } });
      state.lookup = payload.lookup || { matched: false };
      if (state.lookup.matched) state.selectedItemId = state.lookup.item?.id || null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The scanned code could not be checked.';
      state.lookup = null;
    }
    render();
  }

  async function linkCode() {
    if (!state.staff?.can_link || !state.selectedItemId || !state.code || state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api('link', {
        method: 'POST',
        body: {
          code: state.code,
          symbology: state.symbology,
          item_id: state.selectedItemId,
          client_request_id: randomUuid()
        }
      });
      state.lookup = payload.lookup || null;
      state.message = `Barcode linked to ${state.lookup?.item?.name || 'the selected item'}.`;
      const refreshed = await api('snapshot');
      state.snapshot = refreshed.scanner || state.snapshot;
      state.items = Array.isArray(refreshed.items) ? refreshed.items : state.items;
      state.staff = refreshed.staff || state.staff;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The barcode link could not be saved.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function recordCount(form) {
    const item = matchedItem();
    if (!item || !state.staff?.can_count || state.submitting) return;
    const quantityInput = form.querySelector('#inventory-scanner-quantity');
    const noteInput = form.querySelector('#inventory-scanner-note');
    const observed = Number(quantityInput?.value);
    if (!Number.isFinite(observed) || observed < 0) {
      state.error = 'Enter a valid quantity of zero or more.';
      render();
      return;
    }

    state.note = noteInput?.value || '';
    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api('count', {
        method: 'POST',
        body: {
          code: state.code,
          symbology: state.symbology,
          item_id: item.id,
          observed_quantity: observed,
          note: state.note || null,
          source: state.source,
          client_request_id: randomUuid()
        }
      });

      if (payload.mode === 'shadow') {
        state.message = `Preview count recorded for ${item.name}: ${formatNumber(observed)} ${item.unit || 'units'}. Live inventory remains ${formatNumber(item.quantity)}.`;
      } else if (payload.no_change) {
        state.message = `${item.name} was already recorded at ${formatNumber(observed)} ${item.unit || 'units'}.`;
      } else {
        const updatedQuantity = payload.item?.quantity ?? observed;
        state.message = `${item.name} updated to ${formatNumber(updatedQuantity)} ${item.unit || 'units'}.`;
        state.lookup.item = payload.item || { ...item, quantity: updatedQuantity };
        const catalogItem = itemById(item.id);
        if (catalogItem) Object.assign(catalogItem, state.lookup.item);
        if (typeof window.loadItems === 'function') window.loadItems().catch?.(() => {});
      }

      const refreshed = await api('snapshot');
      state.snapshot = refreshed.scanner || state.snapshot;
      state.items = Array.isArray(refreshed.items) ? refreshed.items : state.items;
      state.staff = refreshed.staff || state.staff;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The bottle count could not be recorded.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function stepQuantity(delta) {
    const input = document.getElementById('inventory-scanner-quantity');
    if (!input) return;
    const next = Math.max(0, number(input.value) + delta);
    input.value = String(Math.round(next * 10) / 10);
    input.focus();
  }

  function ensureEntryPoints() {
    const toolbar = document.querySelector('#inventory-view .toolbar');
    if (toolbar && !document.getElementById('inventory-scan-btn')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost inventory-scan-entry';
      button.id = 'inventory-scan-btn';
      button.innerHTML = '<i data-lucide="scan-barcode"></i>Scan bottle';
      const addButton = document.getElementById('add-item-btn');
      toolbar.insertBefore(button, addButton || null);
    }

    const fabMenu = document.getElementById('fab-menu');
    if (fabMenu && !document.getElementById('fab-scan-bottle')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'fab-scan-bottle';
      button.innerHTML = '<i data-lucide="scan-barcode"></i><span>Scan bottle</span>';
      fabMenu.prepend(button);
    }

    window.lucide?.createIcons?.();
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest('#inventory-scan-btn, #fab-scan-bottle')) {
      event.preventDefault();
      document.getElementById('fab-menu')?.classList.remove('open');
      document.getElementById('fab-btn')?.classList.remove('open');
      openScanner();
      return;
    }
    if (!state.open || !state.overlay?.contains(target)) return;

    if (target.closest('[data-scanner-close]')) {
      event.preventDefault();
      closeScanner();
      return;
    }
    if (target.closest('[data-scanner-start]')) {
      event.preventDefault();
      startCamera();
      return;
    }
    if (target.closest('[data-scanner-stop]')) {
      event.preventDefault();
      stopScanner();
      render();
      return;
    }
    if (target.closest('[data-scanner-reset]')) {
      event.preventDefault();
      stopScanner();
      resetResult();
      return;
    }
    const select = target.closest('[data-scanner-select-item]');
    if (select) {
      event.preventDefault();
      state.selectedItemId = select.dataset.scannerSelectItem || null;
      render();
      document.getElementById('inventory-scanner-item-search')?.focus();
      return;
    }
    if (target.closest('[data-scanner-link]')) {
      event.preventDefault();
      linkCode();
      return;
    }
    const step = target.closest('[data-scanner-step]');
    if (step) {
      event.preventDefault();
      stepQuantity(Number(step.dataset.scannerStep));
    }
  }

  function handleSubmit(event) {
    if (!state.open) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches('[data-scanner-manual-form]')) {
      event.preventDefault();
      const input = form.querySelector('#inventory-scanner-code');
      handleCode(input?.value || '', 'manual', 'manual');
    }
    if (form.matches('[data-scanner-count-form]')) {
      event.preventDefault();
      recordCount(form);
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === 'inventory-scanner-item-search') {
      state.itemQuery = target.value;
      const list = state.overlay?.querySelector('.inventory-scanner-link-list');
      if (list) {
        const items = filteredItems();
        list.innerHTML = items.length ? items.map(linkItemMarkup).join('') : '<p class="inventory-scanner-no-results">No inventory item matches this search.</p>';
        window.lucide?.createIcons?.();
      }
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches('[data-scanner-image]')) {
      const file = target.files?.[0];
      target.value = '';
      if (file) decodeImage(file);
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.open) closeScanner();
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureOverlay();
    ensureEntryPoints();

    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('pagehide', stopScanner);

    state.observer = new MutationObserver(ensureEntryPoints);
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  window.AtlasInventoryScanner = {
    open: openScanner,
    close: closeScanner,
    stop: stopScanner,
    lookup: (code) => handleCode(code, 'manual', 'manual'),
    snapshot: () => state.snapshot
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
