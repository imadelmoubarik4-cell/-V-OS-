// AtlasCapture: the one shared capture component for Visual Inventory
// (stock count, identify item, add product, receiving).
//
// It owns the full-screen camera (getUserMedia, rear camera), client barcode
// decoding with the native BarcodeDetector when the browser has it (photo only
// otherwise), still photos and photo upload, and the calls to the
// atlas-inventory-recognition Edge Function. It renders the shared result
// pieces (confidence pill, per-field confidence, candidates with evidence);
// each mode owns its own result sheet through onResult().
//
// Owner gate (binding): recognition never changes stock. Nothing here writes
// an item, an alias, a code or a count. A High match is only pre-selected; a
// person always confirms, and counts are saved by the stock-count command with
// the confirmed outcome as evidence.
//
//   AtlasCapture.open({ mode, title, context, continuous, photoRequired, onResult, onClose })
//     → { resume(), close(), showSheet(html, bind), setBusy(text), setStatus(text), element }
//   AtlasCapture.identify({ mode, codes, image, context, clientRequestId })
//   AtlasCapture.search(q) · outcome(body) · propose(body) · report(body) · duplicates(body) · status()
//   AtlasCapture.decodeImage(source) · prepareImage(file)
//   AtlasCapture.render.{ band, fields, candidates, evidence, readValue }
(function (root) {
  'use strict';

  if (root.AtlasCapture) return;

  const REQUEST_TIMEOUT_MS = 25000;
  const DETECT_INTERVAL_MS = 180;
  const NO_CODE_HINT_MS = 1500;
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.85;
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];

  const MODES = Object.freeze({
    stock_count: { title: 'Scan item', hint: 'Point at the barcode. Avoid people and screens.' },
    identify: { title: 'Identify item', hint: 'Point at the product or its barcode. Nothing changes in Atlas.' },
    add_product: { title: 'Scan product', hint: 'Take a photo of the front label. Avoid people and screens.' },
    receiving: { title: 'Scan delivery', hint: 'Take a photo of the goods or the delivery note.' }
  });

  const FIELD_LABELS = Object.freeze({
    identity: 'Product', brand: 'Brand', variant: 'Variant', category: 'Category', package_type: 'Package',
    unit_size: 'Unit size', package_size: 'Pack', barcode: 'Barcode', inventory_match: 'Atlas item', supplier_match: 'Supplier'
  });
  const STATE_WORDS = Object.freeze({ sure: 'Sure', check: 'Check', not_sure: 'Not sure', unknown: 'Not read' });
  const STATE_TONES = Object.freeze({ sure: 'positive', check: 'warning', not_sure: 'neutral', unknown: 'neutral' });
  const BAND_TONES = Object.freeze({ high: 'positive', medium: 'warning', low: 'neutral' });
  const BAND_WORDS = Object.freeze({ high: 'Sure', medium: 'Check', low: 'Not sure' });

  // Fixed, friendly copy per error code (the service already sends fixed text;
  // anything unknown gets a generic line, never raw server text).
  const ERROR_COPY = Object.freeze({
    invalid_request: 'Atlas couldn’t read that request. Try again.',
    unauthorized: 'Sign in again to continue.',
    forbidden: 'This isn’t available for your role.',
    not_found: 'That could not be found. Refresh and try again.',
    conflict: 'This was already handled. Refresh and try again.',
    stale_request: 'This changed while you were looking. Refresh and try again.',
    duplicate_suspected: 'This looks like an existing product. Check the possible matches first.',
    invalid_code: 'This code isn’t valid. Check the digits and try again.',
    rate_limited: 'You’ve reached the photo recognition limit. Scan barcodes or search instead, and try photos again later.',
    upload_quota_exceeded: 'You’ve reached today’s photo upload limit. Scan barcodes or search instead.',
    too_large: 'Photos can be up to 12 MB.',
    unsupported_type: 'Send a JPEG, PNG, WebP or HEIC photo.',
    not_configured: 'Photo recognition isn’t set up yet. Scan the barcode or search instead.',
    storage_failed: 'The photo couldn’t be stored. Try again.',
    unavailable: 'Recognition is unavailable right now. Scan the barcode or search instead.',
    internal: 'Recognition couldn’t finish. Scan the barcode or search instead.'
  });

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function uuid() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function endpoint() {
    const cfg = root.VABAR_CONFIG || {};
    const explicit = String(cfg.INVENTORY_RECOGNITION_API || '').trim();
    if (explicit) return explicit;
    const base = String(cfg.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    return base ? `${base}/functions/v1/atlas-inventory-recognition` : '';
  }

  class CaptureError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.name = 'CaptureError';
      this.code = code;
      // Fixed copy Atlas wrote (ERROR_COPY), safe to show (AtlasApi.message).
      this.atlasFixed = true;
      Object.assign(this, extra);
    }
  }

  async function accessToken() {
    const client = root.atlasSupabase;
    if (!client?.auth) throw new CaptureError('unauthorized', ERROR_COPY.unauthorized);
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session?.access_token) throw new CaptureError('unauthorized', ERROR_COPY.unauthorized);
    return data.session.access_token;
  }

  async function request(action, { method = 'POST', body = null, form = null, params = {} } = {}) {
    const base = endpoint();
    if (!base) throw new CaptureError('unavailable', ERROR_COPY.unavailable);
    if (root.navigator && root.navigator.onLine === false) throw new CaptureError('offline', 'You’re offline. Scanning needs a connection; search once you’re back online.');
    const token = await accessToken();
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => { if (value != null && value !== '') url.searchParams.set(key, String(value)); });
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const key = root.VABAR_CONFIG?.SUPABASE_ANON_KEY;
    if (key) headers.apikey = key;
    if (body && !form) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = root.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { method, headers, cache: 'no-store', signal: controller.signal, body: form || (body ? JSON.stringify(body) : undefined) });
    } catch (error) {
      if (error?.name === 'AbortError') throw new CaptureError('timeout', 'Recognition took too long. Try again, or scan the barcode.');
      throw new CaptureError('network', 'Atlas couldn’t reach recognition. Check your connection and try again.');
    } finally {
      root.clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(payload.error_code || payload.code || (response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unavailable'));
      throw new CaptureError(code, ERROR_COPY[code] || ERROR_COPY.unavailable, { status: response.status, reason: payload.reason || null, duplicates: payload.duplicates || null });
    }
    if (payload && payload.stock_changed === true) {
      // Structural guarantee: recognition can never report a stock change.
      throw new CaptureError('internal', ERROR_COPY.internal);
    }
    return payload;
  }

  function normalizeCodes(codes) {
    return (Array.isArray(codes) ? codes : [])
      .map((code) => (typeof code === 'string' ? { raw: code } : code))
      .filter((code) => code && String(code.raw || '').trim())
      .slice(0, 10)
      .map((code) => ({ raw: String(code.raw).trim(), format: code.format || null, engine: code.engine || 'native' }));
  }

  // Codes alone use the fast path (JSON, no photo, no vision). A photo goes as
  // multipart with the payload; the same client_request_id makes retries idempotent.
  async function identify({ mode = 'identify', codes = [], image = null, context = {}, clientRequestId = uuid() } = {}) {
    const payload = { client_request_id: clientRequestId, mode, context: cleanContext(context), client_barcodes: normalizeCodes(codes) };
    if (!image && !payload.client_barcodes.length) throw new CaptureError('invalid_request', 'Scan a barcode or take a photo first.');
    if (!image) return request('identify', { body: payload });
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    form.append('image', image, image.name || 'capture.jpg');
    return request('identify', { form });
  }

  function cleanContext(context) {
    const out = {};
    Object.entries(context || {}).forEach(([key, value]) => { if (value != null && value !== '') out[key] = value; });
    return out;
  }

  const api = {
    identify,
    search: (q) => request('search', { method: 'GET', params: { q } }),
    outcome: (body) => request('outcome', { body: { client_outcome_id: uuid(), ...body } }),
    propose: (body) => request('propose', { body: { request_id: uuid(), ...body } }),
    report: (body) => request('report', { body }),
    duplicates: (body) => request('duplicates', { body }),
    status: () => request('status', { method: 'GET' })
  };

  // ---------------------------------------------------------------------------
  // Images: re-encode through a canvas (drops EXIF and GPS), 1600 px on the
  // long edge, JPEG 0.85. If the browser can't decode it (some HEIC), the
  // original file is sent unchanged; the service accepts HEIC.
  // ---------------------------------------------------------------------------
  function canvasBlob(canvas) {
    return new Promise((resolve) => {
      if (canvas.toBlob) canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
      else resolve(null);
    });
  }

  function drawScaled(source, width, height) {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function prepareImage(file) {
    if (!file) return null;
    try {
      const bitmap = await root.createImageBitmap(file);
      const canvas = drawScaled(bitmap, bitmap.width, bitmap.height);
      bitmap.close?.();
      const blob = await canvasBlob(canvas);
      if (!blob) return { blob: file, canvas: null };
      return { blob: new File([blob], 'capture.jpg', { type: 'image/jpeg' }), canvas };
    } catch (_) {
      return { blob: file, canvas: null };
    }
  }

  // ---------------------------------------------------------------------------
  // Barcode decoding: native BarcodeDetector only. Without it the capture works
  // photo-only (the service reads printed digits from the photo).
  // ---------------------------------------------------------------------------
  let detectorPromise = null;
  function detector() {
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
      if (!('BarcodeDetector' in root)) return null;
      try {
        const supported = typeof root.BarcodeDetector.getSupportedFormats === 'function'
          ? await root.BarcodeDetector.getSupportedFormats() : FORMATS;
        const formats = FORMATS.filter((format) => supported.includes(format));
        return formats.length ? new root.BarcodeDetector({ formats }) : null;
      } catch (_) {
        return null;
      }
    })();
    return detectorPromise;
  }

  async function decodeImage(source) {
    const instance = await detector();
    if (!instance || !source) return [];
    try {
      const results = await instance.detect(source);
      const seen = new Set();
      return (results || []).filter((entry) => entry?.rawValue && !seen.has(entry.rawValue) && seen.add(entry.rawValue))
        .map((entry) => ({ raw: String(entry.rawValue), format: entry.format || null, engine: 'native' }));
    } catch (_) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Shared result rendering
  // ---------------------------------------------------------------------------
  // Field keys of field_confidence → keys of the reading (`read`).
  const READ_KEYS = Object.freeze({
    identity: ['product_name'], brand: ['brand'], variant: ['variant'], category: ['subcategory', 'category_class'],
    package_type: ['packaging_type'], unit_size: ['unit_size'], package_size: ['units_per_case'], barcode: ['barcode', 'sku_or_supplier_ref']
  });

  function readValue(detection, field) {
    const keys = READ_KEYS[field] || [field];
    for (const key of keys) {
      const entry = detection?.read?.[key];
      if (entry == null) continue;
      if (typeof entry !== 'object' || Array.isArray(entry)) { if (String(entry).trim()) return String(entry); continue; }
      if (entry.quantity != null && entry.unit) return `${entry.quantity} ${entry.unit}`;
      const value = entry.value ?? entry.text ?? null;
      if (value == null || value === '') continue;
      const text = typeof value === 'object' ? (value.text || value.display || '') : String(value);
      if (!text) continue;
      return key === 'units_per_case' ? `${text} per case` : text.replace(/_/g, ' ');
    }
    return null;
  }

  function bandPill(detection, candidate = null) {
    const band = detection?.band || 'low';
    const percent = candidate?.percent ?? detection?.candidates?.[0]?.percent;
    const word = detection?.band_label || BAND_WORDS[band] || 'Not sure';
    return `<span class="atlas-pill atlas-pill--${BAND_TONES[band] || 'neutral'}" data-capture-band="${escapeHtml(band)}">${escapeHtml(word)}${percent != null && band !== 'low' ? ` · ${escapeHtml(percent)}%` : ''}</span>`;
  }

  function fieldState(detection, key) {
    const state = detection?.field_state?.[key];
    if (state) return state;
    const value = detection?.field_confidence?.[key];
    if (value == null) return 'unknown';
    return value >= 90 ? 'sure' : value >= 60 ? 'check' : 'not_sure';
  }

  // Per-field confidence (owner §6): each field shows its own word, never one
  // overall score. Values below 60 are shown as readings, not facts.
  function fieldsMarkup(detection, { item = null, keys = null, showSupplier = false } = {}) {
    const list = (keys || Object.keys(FIELD_LABELS)).filter((key) => key !== 'supplier_match' || showSupplier);
    const rows = list.map((key) => {
      const confidence = detection?.field_confidence?.[key];
      const state = fieldState(detection, key);
      if (confidence == null && state === 'unknown' && !['identity', 'inventory_match'].includes(key)) return '';
      let value = readValue(detection, key);
      if (key === 'inventory_match') value = item ? item.name : 'No Atlas item';
      if (key === 'identity' && !value) value = item?.name || null;
      if (key === 'brand' && !value) value = item?.brand || null;
      if (key === 'category' && !value) value = item?.category || null;
      if (key === 'supplier_match' && !value) value = item?.supplier_name || item?.supplier || null;
      // A confidence without a reading is not shown as "Sure".
      const shown = value ? state : 'unknown';
      return `<div class="atlas-capture-field" data-field="${escapeHtml(key)}" data-state="${escapeHtml(shown)}"><dt>${escapeHtml(FIELD_LABELS[key])}</dt><dd><span class="atlas-capture-field__value">${value ? escapeHtml(value) : '<span class="atlas-capture-muted">Not read</span>'}</span>${value ? `<span class="atlas-pill${STATE_TONES[shown] === 'neutral' ? '' : ` atlas-pill--${STATE_TONES[shown]}`}">${escapeHtml(STATE_WORDS[shown])}</span>` : ''}</dd></div>`;
    }).filter(Boolean).join('');
    return rows ? `<dl class="atlas-capture-fields" aria-label="How sure Atlas is, field by field">${rows}</dl>` : '';
  }

  const POLARITY_ICON = { for: 'check', against: 'x', missing: 'minus' };
  const POLARITY_WORD = { for: 'Supports', against: 'Against', missing: 'Missing' };
  function evidenceMarkup(candidate) {
    const entries = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
    if (!entries.length) return '';
    return `<ul class="atlas-capture-evidence">${entries.slice(0, 8).map((entry) => {
      const polarity = POLARITY_ICON[entry.polarity] ? entry.polarity : 'for';
      return `<li data-polarity="${polarity}"><i data-lucide="${POLARITY_ICON[polarity]}" aria-hidden="true"></i><span class="sr-only">${POLARITY_WORD[polarity]}: </span>${escapeHtml(entry.text || '')}</li>`;
    }).join('')}</ul>`;
  }

  function flagPills(candidate) {
    const flags = candidate?.flags || {};
    const pills = [];
    if (flags.inactive || candidate?.item?.active === false) pills.push('<span class="atlas-pill">Inactive</span>');
    if (flags.counted_in_session) pills.push('<span class="atlas-pill atlas-pill--positive">Counted</span>');
    else if (flags.in_session) pills.push('<span class="atlas-pill atlas-pill--info">In this count</span>');
    if (flags.on_order) pills.push('<span class="atlas-pill atlas-pill--info">On this order</span>');
    return pills.join('');
  }

  // Ranked candidates with evidence (owner §7). `action` renders the per-row
  // button ('Choose'); `selectedId` marks the chosen one.
  function candidatesMarkup(detection, { action = 'Choose', selectedId = null, limit = 5, startOpen = true } = {}) {
    const candidates = (detection?.candidates || []).slice(0, limit);
    if (!candidates.length) return '<p class="atlas-capture-muted">No possible matches.</p>';
    return `<ol class="atlas-capture-candidates">${candidates.map((candidate) => {
      const item = candidate.item || {};
      const name = item.name || 'Inventory item';
      const size = [item.package_size, item.unit].filter(Boolean).join(' · ');
      const selected = selectedId && String(selectedId) === String(candidate.item_id);
      return `<li class="atlas-capture-candidate${selected ? ' is-selected' : ''}" data-candidate="${escapeHtml(candidate.item_id)}" data-rank="${escapeHtml(candidate.rank)}">
        <div class="atlas-capture-candidate__head"><div class="atlas-capture-candidate__text"><p class="atlas-capture-candidate__name">${escapeHtml(name)}</p><p class="atlas-capture-candidate__meta">${escapeHtml([item.category, size].filter(Boolean).join(' · ') || 'Inventory item')}</p></div><span class="atlas-capture-candidate__percent num">${escapeHtml(candidate.percent)}%</span></div>
        <div class="atlas-cluster">${flagPills(candidate)}</div>
        <details class="atlas-capture-why"${startOpen ? ' open' : ''}><summary>Why Atlas suggests it</summary>${evidenceMarkup(candidate)}</details>
        ${action ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-capture-choose="${escapeHtml(candidate.item_id)}" data-rank="${escapeHtml(candidate.rank)}"${candidate.item?.active === false || candidate.flags?.inactive ? ' disabled title="Inactive items can’t be chosen. Reactivate it first."' : ''}>${escapeHtml(action)} ${escapeHtml(name)}</button>` : ''}
      </li>`;
    }).join('')}</ol>`;
  }

  // ---------------------------------------------------------------------------
  // The full-screen capture overlay
  // ---------------------------------------------------------------------------
  let active = null;

  function overlayMarkup(session) {
    const mode = MODES[session.mode] || MODES.identify;
    const title = session.title || mode.title;
    return `<div class="atlas-capture" role="dialog" aria-modal="true" aria-labelledby="atlas-capture-title" data-capture-mode="${escapeHtml(session.mode)}">
      <header class="atlas-capture__bar">
        <button type="button" class="atlas-icon-btn atlas-capture__close" data-capture-close aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
        <h2 class="atlas-capture__title" id="atlas-capture-title">${escapeHtml(title)}</h2>
        ${session.continuous ? '<span class="atlas-pill atlas-pill--info" data-capture-rapid>Rapid scan</span>' : ''}
        ${session.doneLabel ? `<button type="button" class="atlas-chip atlas-capture__done" data-capture-done>${escapeHtml(session.doneLabel)}</button>` : ''}
      </header>
      <div class="atlas-capture__stage">
        <video class="atlas-capture__video" data-capture-video playsinline muted autoplay aria-hidden="true"></video>
        <div class="atlas-capture__frame" aria-hidden="true"></div>
        <p class="atlas-capture__status" data-capture-status role="status" aria-live="polite">${escapeHtml(mode.hint)}</p>
      </div>
      <div class="atlas-capture__controls" data-capture-controls>
        <label class="atlas-btn atlas-btn--secondary atlas-capture__upload"><i data-lucide="image-up" aria-hidden="true"></i>Upload photo<input type="file" accept="image/*" data-capture-file hidden></label>
        <button type="button" class="atlas-capture__shutter" data-capture-shutter aria-label="Take photo"><span aria-hidden="true"></span></button>
        <button type="button" class="atlas-btn atlas-btn--secondary" data-capture-manual-toggle><i data-lucide="keyboard" aria-hidden="true"></i>Type code</button>
      </div>
      <form class="atlas-capture__manual" data-capture-manual hidden>
        <div class="atlas-field"><label for="atlas-capture-code">Barcode or SKU</label>
        <div class="atlas-capture__manual-row"><input class="atlas-input" id="atlas-capture-code" name="code" inputmode="numeric" autocomplete="off" enterkeyhint="search"><button type="submit" class="atlas-btn atlas-btn--primary">Look up</button></div></div>
      </form>
      <section class="atlas-capture__sheet" data-capture-sheet hidden aria-live="polite"></section>
    </div>`;
  }

  function setStatus(session, text) {
    const node = session.element?.querySelector('[data-capture-status]');
    if (node) node.textContent = text;
  }

  function stopDetection(session) {
    session.detecting = false;
    if (session.detectTimer) root.clearTimeout(session.detectTimer);
    if (session.hintTimer) root.clearTimeout(session.hintTimer);
    session.detectTimer = null;
    session.hintTimer = null;
  }

  function stopCamera(session) {
    stopDetection(session);
    if (session.stream) session.stream.getTracks().forEach((track) => { try { track.stop(); } catch (_) { /* stopped */ } });
    session.stream = null;
    const video = session.element?.querySelector('[data-capture-video]');
    if (video) { try { video.pause(); } catch (_) { /* no-op */ } video.srcObject = null; }
  }

  async function startCamera(session) {
    const video = session.element?.querySelector('[data-capture-video]');
    if (!video) return false;
    if (!root.isSecureContext || !root.navigator?.mediaDevices?.getUserMedia) {
      session.element.dataset.cameraState = 'unavailable';
      setStatus(session, 'The camera isn’t available here. Upload a photo or type the code.');
      return false;
    }
    try {
      session.stream = await root.navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (session.closed) { stopCamera(session); return false; }
      video.srcObject = session.stream;
      await video.play().catch(() => {});
      session.element.dataset.cameraState = 'live';
      return true;
    } catch (error) {
      session.element.dataset.cameraState = 'unavailable';
      setStatus(session, error?.name === 'NotAllowedError'
        ? 'Camera access is off. Allow the camera in your browser settings, or upload a photo.'
        : 'The camera couldn’t start. Upload a photo or type the code.');
      return false;
    }
  }

  async function startDetection(session) {
    stopDetection(session);
    if (session.closed || session.busy) return;
    const video = session.element?.querySelector('[data-capture-video]');
    const instance = await detector();
    const mode = MODES[session.mode] || MODES.identify;
    if (!instance || !session.stream || session.photoRequired) {
      setStatus(session, session.photoRequired ? mode.hint : (session.stream ? 'Take a photo of the label or barcode.' : 'Upload a photo or type the code.'));
      session.element.dataset.detector = instance ? 'native' : 'none';
      return;
    }
    session.element.dataset.detector = 'native';
    session.detecting = true;
    setStatus(session, 'Looking for a barcode…');
    session.hintTimer = root.setTimeout(() => {
      if (session.detecting) setStatus(session, 'No barcode found. Take a photo of the label.');
    }, NO_CODE_HINT_MS);
    const tick = async () => {
      if (!session.detecting || session.closed) return;
      let codes = [];
      if (video && video.readyState >= 2) codes = await decodeImage(video);
      if (!session.detecting || session.closed) return;
      if (codes.length) {
        stopDetection(session);
        try { root.navigator.vibrate?.(20); } catch (_) { /* optional */ }
        handleCapture(session, { codes, source: 'barcode' });
        return;
      }
      session.detectTimer = root.setTimeout(tick, DETECT_INTERVAL_MS);
    };
    tick();
  }

  function setBusy(session, text) {
    session.busy = Boolean(text);
    session.element?.classList.toggle('is-busy', session.busy);
    const sheet = session.element?.querySelector('[data-capture-sheet]');
    if (text && sheet) {
      sheet.hidden = false;
      sheet.innerHTML = `<div class="atlas-capture__working"><span class="atlas-spinner" aria-hidden="true"></span><p>${escapeHtml(text)}</p></div>`;
    }
  }

  function showSheet(session, html, bind) {
    const sheet = session.element?.querySelector('[data-capture-sheet]');
    if (!sheet) return null;
    session.busy = false;
    session.element.classList.remove('is-busy');
    session.element.classList.add('has-sheet');
    sheet.hidden = false;
    sheet.innerHTML = `<span class="atlas-sheet__grabber" aria-hidden="true"></span>${html}`;
    root.lucide?.createIcons?.();
    if (typeof bind === 'function') bind(sheet);
    const focusTarget = sheet.querySelector('[data-autofocus]') || sheet.querySelector('h3, h2');
    if (focusTarget) {
      if (!focusTarget.matches('input, button, select, textarea') && !focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    }
    return sheet;
  }

  function hideSheet(session) {
    const sheet = session.element?.querySelector('[data-capture-sheet]');
    if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
    session.element?.classList.remove('has-sheet');
  }

  function errorSheet(session, error) {
    const message = error instanceof CaptureError ? error.message : ERROR_COPY.internal;
    showSheet(session, `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="circle-alert" aria-hidden="true"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Atlas couldn’t check this.</p><p class="atlas-alert__body">${escapeHtml(message)} Nothing was changed.</p></div></div>
      <div class="atlas-capture__actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg" data-capture-retry>Retry scan</button>${session.onSearch ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg" data-capture-search>Search inventory</button>' : ''}</div>`,
    (sheet) => {
      sheet.querySelector('[data-capture-retry]')?.addEventListener('click', () => controller(session).resume());
      sheet.querySelector('[data-capture-search]')?.addEventListener('click', () => session.onSearch?.(controller(session)));
    });
  }

  function controller(session) {
    if (session.controller) return session.controller;
    session.controller = {
      element: session.element,
      mode: session.mode,
      resume: () => {
        if (session.closed) return;
        hideSheet(session);
        session.busy = false;
        session.clientRequestId = uuid();
        startDetection(session);
      },
      close: () => close(session),
      showSheet: (html, bind) => showSheet(session, html, bind),
      setBusy: (text) => setBusy(session, text),
      setStatus: (text) => setStatus(session, text),
      error: (error) => errorSheet(session, error),
      lastImage: () => session.lastImage || null
    };
    return session.controller;
  }

  async function handleCapture(session, { codes = [], image = null, source }) {
    if (session.closed) return;
    stopDetection(session);
    setBusy(session, 'Checking Atlas inventory…');
    const clientRequestId = session.clientRequestId || uuid();
    session.clientRequestId = clientRequestId;
    try {
      const response = await identify({ mode: session.mode, codes, image, context: session.context, clientRequestId });
      if (session.closed) return;
      session.lastImage = image || null;
      const result = { ...response, source, codes };
      if (typeof session.onResult === 'function') await session.onResult(result, controller(session));
      else hideSheet(session);
    } catch (error) {
      if (session.closed) return;
      errorSheet(session, error);
    }
  }

  async function captureFrame(session) {
    const video = session.element?.querySelector('[data-capture-video]');
    if (!video || !session.stream || video.readyState < 2) {
      session.element.querySelector('[data-capture-file]')?.click();
      return;
    }
    const canvas = drawScaled(video, video.videoWidth || 1280, video.videoHeight || 720);
    const blob = await canvasBlob(canvas);
    const codes = await decodeImage(canvas);
    const image = blob ? new File([blob], 'capture.jpg', { type: 'image/jpeg' }) : null;
    if (!image && !codes.length) { setStatus(session, 'The photo couldn’t be taken. Try again or upload one.'); return; }
    handleCapture(session, { codes, image, source: 'photo' });
  }

  async function captureFile(session, file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024 && !/^image\//.test(file.type)) { errorSheet(session, new CaptureError('too_large', ERROR_COPY.too_large)); return; }
    stopDetection(session);
    setBusy(session, 'Reading the photo…');
    const prepared = await prepareImage(file);
    const codes = await decodeImage(prepared?.canvas || null);
    if (prepared?.blob && prepared.blob.size > 12 * 1024 * 1024) { errorSheet(session, new CaptureError('too_large', ERROR_COPY.too_large)); return; }
    handleCapture(session, { codes, image: prepared?.blob || file, source: 'photo' });
  }

  function onClick(session, event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-capture-close]')) { close(session); return; }
    if (target.closest('[data-capture-done]')) { session.onDone?.(); close(session); return; }
    if (target.closest('[data-capture-shutter]')) { if (!session.busy) captureFrame(session); return; }
    if (target.closest('[data-capture-manual-toggle]')) {
      const form = session.element.querySelector('[data-capture-manual]');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('input')?.focus();
    }
  }

  function onKeydown(session, event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      const sheet = session.element.querySelector('[data-capture-sheet]');
      if (sheet && !sheet.hidden && !session.busy) controller(session).resume();
      else close(session);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...session.element.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="file"]), select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function open(options = {}) {
    if (active) close(active, { silent: true });
    const session = {
      mode: MODES[options.mode] ? options.mode : 'identify',
      title: options.title || null,
      context: options.context || {},
      continuous: Boolean(options.continuous),
      photoRequired: Boolean(options.photoRequired ?? options.mode === 'add_product'),
      doneLabel: options.doneLabel || null,
      onResult: options.onResult || null,
      onClose: options.onClose || null,
      onDone: options.onDone || null,
      onSearch: options.onSearch || null,
      clientRequestId: uuid(),
      previousFocus: document.activeElement,
      closed: false,
      busy: false
    };
    const host = document.createElement('div');
    host.className = 'atlas-capture-host';
    host.innerHTML = overlayMarkup(session);
    document.body.appendChild(host);
    session.host = host;
    session.element = host.firstElementChild;
    document.body.classList.add('atlas-capture-open');
    root.AtlasChrome?.setTabBarHidden?.('capture', true);
    session.inert = [...document.body.children].filter((node) => node !== host && !node.matches('script, style, link, [aria-live], .atlas-toast-region'));
    session.inert.forEach((node) => { node.dataset.captureInert = String(Boolean(node.inert)); node.inert = true; });
    session.element.addEventListener('click', (event) => onClick(session, event));
    session.element.addEventListener('keydown', (event) => onKeydown(session, event));
    session.element.querySelector('[data-capture-file]')?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      captureFile(session, file);
    });
    session.element.querySelector('[data-capture-manual]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = event.currentTarget.elements.code;
      const code = String(input.value || '').trim();
      if (!code) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      input.removeAttribute('aria-invalid');
      event.currentTarget.hidden = true;
      handleCapture(session, { codes: [{ raw: code, format: null, engine: 'manual' }], source: 'manual' });
    });
    active = session;
    root.lucide?.createIcons?.();
    session.element.querySelector('[data-capture-close]')?.focus();
    startCamera(session).then(() => startDetection(session));
    return controller(session);
  }

  function close(session = active, { silent = false } = {}) {
    if (!session || session.closed) return;
    session.closed = true;
    stopCamera(session);
    (session.inert || []).forEach((node) => { node.inert = node.dataset.captureInert === 'true'; delete node.dataset.captureInert; });
    session.host?.remove();
    if (active === session) active = null;
    document.body.classList.remove('atlas-capture-open');
    root.AtlasChrome?.setTabBarHidden?.('capture', false);
    if (!silent) session.onClose?.();
    if (session.previousFocus instanceof HTMLElement && session.previousFocus.isConnected) session.previousFocus.focus({ preventScroll: true });
  }

  root.addEventListener?.('pagehide', () => { if (active) close(active, { silent: true }); });

  root.AtlasCapture = Object.freeze({
    open,
    close: () => close(active),
    isOpen: () => Boolean(active),
    ...api,
    decodeImage,
    prepareImage,
    detectorAvailable: async () => Boolean(await detector()),
    CaptureError,
    ERROR_COPY,
    FIELD_LABELS,
    uuid,
    render: Object.freeze({
      band: bandPill,
      fields: fieldsMarkup,
      candidates: candidatesMarkup,
      evidence: evidenceMarkup,
      readValue,
      escape: escapeHtml
    })
  });
})(typeof window === 'undefined' ? globalThis : window);
