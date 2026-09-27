// Marketing media library (S94A; docs/marketing/S94_Publishing_Architecture.md §3,
// docs/marketing/research/08-ux-spec.md §4). Manager and admin only.
//
// window.AtlasMarketingMedia — the contract other Marketing code uses:
//
//   mount(host, { mode: 'library' }) -> { refresh(), destroy() }
//       Renders the Media tab into `host`: search, filters (All · Photos ·
//       Videos · Collections · Used · Unused), tags, sort, the upload queue,
//       the grid, the asset detail sheet and the collection builder. Calling
//       it again for the same host returns the same controller.
//   pick({ multiple, kinds, allowCollections, initialTab?, exclude? })
//       -> Promise<[{ asset_id, variant_id?, publish_variant_id, collection_id?,
//          collection_name?, kind, thumb_url, width, height, duration_ms,
//          mime_type, byte_size, alt_text, title }] | null>
//       The library / collection picker sheet with "Upload new". A collection
//       resolves with its items in order (each with collection_id). null when
//       dismissed. `kinds` limits to ['image'] / ['video']; `exclude` lists
//       asset ids already attached (shown as added).
//   upload(files) -> Promise<[entry | null]>
//       Uploads through the shared queue (same entries as pick; null for a
//       file that failed or was cancelled).
//   thumbUrl(asset) -> string | null
//       The asset's short-lived thumbnail link (signed for 5 minutes), from
//       the entry itself or the last listing.
//   ensureCrops(assetId, ratios?) -> Promise<{ '<ratio>': variant_id }>
//       Makes (or reuses) the crop copies for a photo from its focal point.
//   takePendingUse() -> entries | null
//       What "Use in new post" handed to the composer (read once).
//
// Every call goes through the atlas-marketing-media gateway with the Atlas
// session; nothing reads Storage or private tables directly. Bytes go from the
// browser straight to Storage with the one-time signed upload token the
// gateway returns (single PUT up to 6 MiB, TUS resumable above: 6 MB chunks,
// the token in x-signature, retry and cancel). Thumbnails, video posters,
// crops and the JPEG publish copy are made here with <canvas> and uploaded as
// variants; the original is never changed.
(function () {
  'use strict';
  // Loaded once: a second copy of this file keeps the first (and its queue).
  if (window.AtlasMarketingMedia?.version) return;

  const VERSION = '20261004-s94a';
  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 20000;
  const MIB = 1024 * 1024;
  const LIMITS = { image: 30 * MIB, video: 1024 * MIB };
  const PARALLEL_UPLOADS = 2;
  const TUS_CHUNK = 6 * MIB;
  const THUMB_EDGE = 400;
  const PUBLISH_EDGE = 2048;
  const CROP_EDGE = 1440;
  const URL_FRESH_MS = 4 * 60 * 1000;
  const MANAGERS = ['admin', 'manager'];
  const TYPES = {
    'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/heic': 'image', 'image/heif': 'image',
    'video/mp4': 'video', 'video/quicktime': 'video'
  };
  const EXTENSIONS = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime' };
  const ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,image/webp,video/mp4,video/quicktime,.heic,.heif,.mov';
  const FILTERS = [['all', 'All'], ['image', 'Photos'], ['video', 'Videos'], ['collections', 'Collections'], ['used', 'Used'], ['unused', 'Unused']];
  const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name']];
  // Crop presets (contract §3 plus Google's 4:3): [ratio, label, w, h]. The
  // ratio keys are built from their numbers ('w:h').
  const ratioKey = (w, h) => `${w}:${h}`;
  const CROPS = [[1, 1, 'Square'], [4, 5, 'Portrait'], [9, 16, 'Story and Reel'], [16, 9, 'Landscape'], [1.91, 1, 'Landscape'], [4, 3, 'Google']]
    .map(([w, h, name]) => [ratioKey(w, h), `${name} ${ratioKey(w, h)}`, w, h]);

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const requestId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
  const toast = (message, options) => window.AtlasShell?.toast?.(message, options);
  const icons = () => window.lucide?.createIcons?.();
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const clock = () => window.AtlasVenueClock;

  function profile() { return window.AtlasShell?.profile?.() || window.atlasCurrentProfile || null; }
  function isManager() { const p = profile(); return Boolean(p && p.active !== false && MANAGERS.includes(p.role)); }

  function bytesText(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * MIB) return `${(n / (1024 * MIB)).toFixed(1)} GB`;
    if (n >= MIB) return `${(n / MIB).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }
  function durationText(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function parseDuration(text) {
    const match = /^\s*(?:(\d{1,3}):)?(\d{1,2})(?:\.(\d{1,3}))?\s*$/.exec(String(text || ''));
    if (!match) return null;
    const minutes = Number(match[1] || 0);
    const seconds = Number(match[2]);
    if (match[1] && seconds > 59) return null;
    return (minutes * 60 + seconds) * 1000 + Number((match[3] || '0').padEnd(3, '0'));
  }
  function dateText(value) {
    if (!value) return '';
    return clock()?.formatDate?.(value, { weekday: 'short', day: 'numeric', month: 'short' }, '') || String(value).slice(0, 10);
  }
  function kindWord(asset) { return asset?.kind === 'video' ? 'video' : 'photo'; }
  function nameOf(asset) { return String(asset?.name || asset?.title || asset?.original_filename || (asset?.kind === 'video' ? 'Video' : 'Photo')); }
  function usedText(asset) {
    const count = Number(asset?.used_count) || 0;
    return count ? `Used in ${plural(count, 'post')}` : 'Not used yet';
  }
  function focalCss(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return '';
    return ` style="object-position:${Math.round(x * 100)}% ${Math.round(y * 100)}%"`;
  }

  // ---------- gateway ----------

  function endpoint() {
    const explicit = String(cfg.MARKETING_MEDIA_API || '').trim();
    if (explicit) return explicit;
    const base = String(cfg.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    return base ? `${base}/functions/v1/atlas-marketing-media` : '';
  }

  async function sessionToken() {
    const client = window.atlasSupabase;
    const { data } = client?.auth ? await client.auth.getSession() : { data: null };
    const token = data?.session?.access_token;
    if (!token) throw Object.assign(new Error('session'), { status: 401 });
    return token;
  }

  async function api(action, { method = 'GET', params = {}, body = null, signal = null } = {}) {
    const base = endpoint();
    if (!base) throw Object.assign(new Error('not configured'), { status: 404, code: 'not_configured' });
    const token = await sessionToken();
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
      else if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort);
    try {
      let response;
      try {
        response = await fetch(url, {
          method, cache: 'no-store', signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // No HTTP response at all: offline, or the media service could not be
        // reached (not set up yet, blocked, or down; a browser cannot tell
        // those apart). Not the same as an error the service answered with.
        throw Object.assign(new Error('unreachable'), { status: 0, code: 'unreachable', offline: navigator.onLine === false });
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status, code: String(payload?.error_code || ''), block: payload?.block || null });
      return payload;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  // Our own copy per gateway error code; server text is never shown.
  const CODE_TEXT = {
    invalid_request: 'Some of the details were not valid. Check them and try again.',
    not_found: 'That photo or video could not be found. It may have been deleted.',
    conflict: 'This was already done. Refresh and try again.',
    unsupported_type: 'Choose a JPEG, PNG, WebP or HEIC photo, or an MP4 or MOV video.',
    too_large: 'Photos can be up to 30 MB and videos up to 1 GB.',
    quota: 'You have too many unfinished uploads. Let them finish, or cancel some, then try again.',
    in_use: 'It’s used in a post that is waiting, scheduled or published. Remove it from those posts first.',
    content_locked: 'This post can no longer change.',
    not_ready: 'Only finished library media can be attached.',
    duplicate_name: 'A collection with that name already exists.',
    too_many: 'A post can have at most 35 photos and videos.',
    storage_failed: 'The file could not be reached. Nothing was changed. Try again.',
    frame: 'This frame can’t be captured in this browser. Try another browser, or upload a cover image.'
  };
  function errorText(error, fallback = 'Nothing was changed. Check the connection and try again.') {
    if (error?.code === 'unreachable') return error.offline
      ? 'You’re offline. Nothing was changed. Reconnect, then try again.'
      : 'Atlas couldn’t reach Media. Nothing was changed. Try again in a moment.';
    if (error?.status === 401) return 'Atlas couldn’t confirm your sign-in for this. Try again in a moment.';
    if (error?.status === 403) return 'Media is for managers and administrators.';
    if (error?.status === 404 && (error.code === 'not_configured' || !error.code)) return 'Media storage isn’t set up for this venue yet. An administrator can set it up.';
    if (error?.code && CODE_TEXT[error.code]) return CODE_TEXT[error.code];
    if (error?.name === 'AbortError') return 'The connection timed out. Nothing was changed. Try again.';
    return fallback;
  }

  // Short-lived links seen in listings, by asset id.
  const thumbCache = new Map();
  function remember(asset) {
    const id = asset?.asset_id || asset?.id;
    if (id && asset.thumb_url) thumbCache.set(id, { url: asset.thumb_url, at: Date.now() });
    return asset;
  }
  function thumbUrl(asset) {
    if (!asset) return null;
    if (typeof asset === 'string') return fresh(thumbCache.get(asset));
    const id = asset.asset_id || asset.id;
    return asset.thumb_url || fresh(thumbCache.get(id)) || null;
  }
  function fresh(entry) { return entry && Date.now() - entry.at < URL_FRESH_MS ? entry.url : null; }

  function entryFor(asset, extra = {}) {
    return {
      asset_id: asset.asset_id || asset.id,
      variant_id: extra.variant_id ?? null,
      // The JPEG copy that is published for a non-JPEG photo (null otherwise).
      publish_variant_id: asset.publish_variant_id ?? null,
      ...(extra.collection_id ? { collection_id: extra.collection_id, collection_name: extra.collection_name || null } : {}),
      kind: asset.kind,
      thumb_url: thumbUrl(asset),
      width: asset.width ?? null,
      height: asset.height ?? null,
      duration_ms: asset.duration_ms ?? null,
      mime_type: asset.mime_type ?? null,
      byte_size: asset.byte_size ?? null,
      alt_text: asset.alt_text ?? null,
      title: nameOf(asset)
    };
  }

  // ---------- files, canvas and video helpers ----------

  function classify(file) {
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(file?.name || '') || [])[1]?.toLowerCase() || '';
    let mime = String(file?.type || '').toLowerCase();
    if (ext && !EXTENSIONS[ext]) return { error: 'type' };
    if (!mime || mime === 'application/octet-stream') mime = EXTENSIONS[ext] || '';
    if (!TYPES[mime]) return { error: 'type' };
    const kind = TYPES[mime];
    if (file.size > LIMITS[kind]) return { error: 'size', kind, mime };
    if (!file.size) return { error: 'empty', kind, mime };
    return { kind, mime };
  }

  function uploadError(file, problem) {
    const name = file?.name || 'This file';
    if (problem.error === 'type') return `${name} isn’t a photo or video. Choose a JPEG, PNG, HEIC, MP4 or MOV file.`;
    if (problem.error === 'size') return problem.kind === 'video'
      ? `${name} is larger than 1 GB. Nothing was uploaded. Trim or compress it, then try again.`
      : `${name} is larger than 30 MB. Nothing was uploaded. Make it smaller, then try again.`;
    if (problem.error === 'empty') return `${name} is empty. Nothing was uploaded.`;
    return 'The upload stopped. The other files are fine. Retry this one.';
  }

  // A decoded photo: { source, width, height, close() }, or null.
  async function decodeImage(blob) {
    if (typeof window.createImageBitmap === 'function') {
      try {
        const bitmap = await window.createImageBitmap(blob, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
      } catch { /* fall back to <img> */ }
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    try {
      await image.decode();
      return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      return null;
    }
  }

  // Draws a region (source pixels) scaled so the long edge is at most maxEdge;
  // resolves a JPEG blob with its size.
  function jpegFrom(source, region, maxEdge, quality = 0.86) {
    const scale = Math.min(1, maxEdge / Math.max(region.w, region.h));
    const width = Math.max(1, Math.round(region.w * scale));
    const height = Math.max(1, Math.round(region.h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? { blob, width, height } : null), 'image/jpeg', quality));
  }

  // The largest rectangle of ratio w:h inside the image, centred on the focal point.
  function cropRegion(width, height, ratio, focal = { x: 0.5, y: 0.5 }, zoom = 1) {
    const target = ratio;
    let w = width;
    let h = width / target;
    if (h > height) { h = height; w = height * target; }
    w /= zoom; h /= zoom;
    const fx = Number.isFinite(focal?.x) ? focal.x : 0.5;
    const fy = Number.isFinite(focal?.y) ? focal.y : 0.5;
    const x = Math.min(Math.max(0, fx * width - w / 2), width - w);
    const y = Math.min(Math.max(0, fy * height - h / 2), height - h);
    return { x, y, w, h };
  }

  function videoFacts(file, { seekMs = null } = {}) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve(value ? { ...value, video, release: () => { video.removeAttribute('src'); video.load?.(); URL.revokeObjectURL(url); } } : (URL.revokeObjectURL(url), null));
      };
      const timer = window.setTimeout(() => finish(null), 8000);
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.addEventListener('error', () => finish(null), { once: true });
      video.addEventListener('loadeddata', () => {
        const facts = {
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          duration_ms: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null
        };
        if (seekMs === null) { finish(facts); return; }
        const target = Math.min(seekMs / 1000, Math.max(0, (video.duration || 0) - 0.05));
        video.addEventListener('seeked', () => finish(facts), { once: true });
        try { video.currentTime = Math.max(0, target); } catch { finish(facts); }
      }, { once: true });
      video.src = url;
    });
  }

  async function sha256Hex(blob) {
    if (!window.crypto?.subtle || blob.size > LIMITS.image) return null;
    try {
      const digest = await window.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  // ---------- transfer: single PUT and a small TUS client ----------

  function publishableKey() { return String(cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_PUBLISHABLE_KEY || ''); }

  // XHR (fetch has no upload progress). Resolves { status, headers(name) }.
  function xhrSend({ method, url, headers = {}, body = null, onProgress = null, signal = null }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      Object.entries(headers).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') xhr.setRequestHeader(key, String(value)); });
      if (onProgress && xhr.upload) xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded); };
      const abort = () => xhr.abort();
      if (signal) {
        if (signal.aborted) { reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); return; }
        signal.addEventListener('abort', abort, { once: true });
      }
      xhr.onload = () => {
        signal?.removeEventListener?.('abort', abort);
        resolve({ status: xhr.status, header: (name) => xhr.getResponseHeader(name) });
      };
      xhr.onerror = () => { signal?.removeEventListener?.('abort', abort); reject(Object.assign(new Error('network'), { network: true })); };
      xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      xhr.send(body);
    });
  }

  async function putUpload(upload, blob, mime, { onProgress, signal }) {
    const result = await xhrSend({
      method: 'PUT', url: upload.url, body: blob, signal, onProgress,
      headers: { 'content-type': mime, 'x-upsert': 'false', 'cache-control': 'max-age=3600', apikey: publishableKey() }
    });
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('upload failed'), { status: result.status, transfer: true });
  }

  const b64 = (text) => window.btoa(unescape(encodeURIComponent(String(text))));
  const tusKey = (upload) => `atlas.mm.tus.${upload.object_name}`;
  function tusStored(upload) { try { return window.localStorage.getItem(tusKey(upload)); } catch { return null; } }
  function tusStore(upload, value) { try { if (value) window.localStorage.setItem(tusKey(upload), value); else window.localStorage.removeItem(tusKey(upload)); } catch { /* per-viewer convenience only */ } }

  async function tusUpload(upload, blob, mime, { onProgress, signal }) {
    const base = { 'tus-resumable': '1.0.0', 'x-signature': upload.token, apikey: publishableKey() };
    const chunk = Math.max(256 * 1024, Number(upload.chunk_size) || TUS_CHUNK);
    let location = tusStored(upload);
    let offset = 0;
    if (location) {
      try {
        const head = await xhrSend({ method: 'HEAD', url: location, headers: base, signal });
        if (head.status >= 200 && head.status < 300) offset = Number(head.header('upload-offset')) || 0;
        else location = null;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        location = null;
      }
    }
    if (!location) {
      const created = await xhrSend({
        method: 'POST', url: upload.url, signal,
        headers: {
          ...base,
          'upload-length': blob.size,
          'upload-metadata': [`bucketName ${b64(upload.bucket)}`, `objectName ${b64(upload.object_name)}`, `contentType ${b64(mime)}`, `cacheControl ${b64('3600')}`].join(',')
        }
      });
      const header = created.header('location');
      if (created.status !== 201 || !header) throw Object.assign(new Error('tus create failed'), { status: created.status, transfer: true });
      location = new URL(header, upload.url).toString();
      tusStore(upload, location);
    }
    onProgress?.(offset);
    let failures = 0;
    while (offset < blob.size) {
      const end = Math.min(blob.size, offset + chunk);
      try {
        const sent = await xhrSend({
          method: 'PATCH', url: location, signal, body: blob.slice(offset, end),
          headers: { ...base, 'upload-offset': offset, 'content-type': 'application/offset+octet-stream' },
          onProgress: (loaded) => onProgress?.(offset + loaded)
        });
        if (sent.status === 409 || sent.status === 412) {
          const head = await xhrSend({ method: 'HEAD', url: location, headers: base, signal });
          offset = Number(head.header('upload-offset')) || offset;
          continue;
        }
        if (sent.status < 200 || sent.status >= 300) throw Object.assign(new Error('chunk failed'), { status: sent.status, transfer: true });
        offset = Number(sent.header('upload-offset')) || end;
        failures = 0;
        onProgress?.(offset);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        failures += 1;
        if (failures > 3 || (error.status && error.status < 500 && error.status !== 429)) throw Object.assign(error, { transfer: true });
        await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** (failures - 1)));
        try {
          const head = await xhrSend({ method: 'HEAD', url: location, headers: base, signal });
          if (head.status >= 200 && head.status < 300) offset = Number(head.header('upload-offset')) || offset;
        } catch (headError) { if (headError?.name === 'AbortError') throw headError; }
      }
    }
    tusStore(upload, null);
  }

  function transfer(upload, blob, mime, options) {
    return upload.method === 'tus' ? tusUpload(upload, blob, mime, options) : putUpload(upload, blob, mime, options);
  }

  // One derived copy: reserve, upload, verify. Resolves the variant or null.
  async function uploadVariant(assetId, blob, facts, signal = null) {
    try {
      const reserved = await api('reserve-variant', {
        method: 'POST', signal,
        body: { client_request_id: requestId(), asset_id: assetId, mime_type: 'image/jpeg', byte_size: blob.size, ...facts }
      });
      if (reserved.upload) await transfer(reserved.upload, blob, 'image/jpeg', { signal });
      const done = await completeWithRetry('complete-variant', { variant_id: reserved.variant.id }, signal);
      return done.variant || null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }

  async function completeWithRetry(action, body, signal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await api(action, { method: 'POST', body, signal });
      } catch (error) {
        if (error?.code !== 'upload_missing' || attempt >= 3) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  }

  // ---------- the upload queue (shared by the Media tab, picker and upload()) ----------

  const queue = [];
  const queueListeners = new Set();
  let batch = { total: 0, done: 0 };
  let sequence = 0;
  const notifyQueue = () => queueListeners.forEach((listener) => { try { listener(); } catch { /* a listener never breaks the queue */ } });
  const activeJobs = () => queue.filter((job) => ['waiting', 'preparing', 'uploading', 'processing'].includes(job.status));

  function beforeUnload(event) {
    if (!activeJobs().length) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  }
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('online', () => pump());

  function enqueue(files) {
    const list = Array.from(files || []);
    if (!activeJobs().length) batch = { total: 0, done: 0 };
    const promises = list.map((file) => {
      const job = {
        id: `mmjob-${sequence += 1}`, file, name: file.name || 'Untitled', size: file.size, status: 'waiting',
        loaded: 0, error: '', asset: null, reservation: null, requestId: requestId(), controller: null, preview: null, settle: null
      };
      const problem = classify(file);
      job.kind = problem.kind || null;
      job.mime = problem.mime || null;
      if (problem.error) {
        job.status = 'failed';
        job.error = uploadError(file, problem);
        job.permanent = true;
      } else if (job.kind === 'image') {
        try { job.preview = URL.createObjectURL(file); } catch { job.preview = null; }
      }
      batch.total += 1;
      queue.push(job);
      return new Promise((resolve) => { job.settle = resolve; if (job.permanent) resolve(null); });
    });
    notifyQueue();
    pump();
    return Promise.all(promises);
  }

  function pump() {
    if (navigator.onLine === false) { notifyQueue(); return; }
    const running = queue.filter((job) => ['preparing', 'uploading', 'processing'].includes(job.status)).length;
    const next = queue.filter((job) => job.status === 'waiting').slice(0, Math.max(0, PARALLEL_UPLOADS - running));
    next.forEach((job) => { runJob(job); });
  }

  function finishJob(job, entry) {
    if (job.preview) { URL.revokeObjectURL(job.preview); job.preview = null; }
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.settle?.(entry);
    job.settle = null;
  }

  async function runJob(job) {
    job.status = 'preparing';
    job.error = '';
    job.controller = new AbortController();
    const signal = job.controller.signal;
    notifyQueue();
    let decoded = null;
    let facts = null;
    try {
      const hints = {};
      if (job.kind === 'image') {
        decoded = await decodeImage(job.file);
        if (!decoded && (job.mime === 'image/heic' || job.mime === 'image/heif')) {
          throw Object.assign(new Error('heic'), { permanent: true, text: `${job.name} can’t be read in this browser. Export it as JPEG, or upload it from Safari on an iPhone or Mac.` });
        }
        if (decoded) { hints.width = decoded.width; hints.height = decoded.height; }
      } else {
        facts = await videoFacts(job.file, { seekMs: 1000 });
        if (facts) Object.assign(hints, { width: facts.width, height: facts.height, duration_ms: facts.duration_ms });
      }
      const sha = job.kind === 'image' ? await sha256Hex(job.file) : null;
      job.status = 'uploading';
      notifyQueue();
      const reserved = await api('reserve', {
        method: 'POST', signal,
        body: { client_request_id: job.requestId, mime_type: job.mime, byte_size: job.size, original_filename: job.name, client_hints: hints, ...(sha ? { client_sha256: sha } : {}) }
      });
      job.reservation = reserved.asset;
      if (reserved.upload) {
        await transfer(reserved.upload, job.file, job.mime, {
          signal,
          onProgress: (loaded) => { job.loaded = Math.min(job.size, loaded); renderQueueProgress(job); }
        });
      }
      job.loaded = job.size;
      job.status = 'processing';
      notifyQueue();
      const completed = reserved.upload ? await completeWithRetry('complete', { asset_id: reserved.asset.id }, signal) : { asset: reserved.asset };
      let asset = completed.asset;
      // Derived copies. A failure here keeps the upload; the tile shows an icon.
      if (job.kind === 'image' && decoded) {
        const full = { x: 0, y: 0, w: decoded.width, h: decoded.height };
        const thumb = await jpegFrom(decoded.source, full, THUMB_EDGE, 0.82);
        if (thumb) await uploadVariant(asset.id, thumb.blob, { purpose: 'thumb', width: thumb.width, height: thumb.height }, signal);
        if (asset.mime_type !== 'image/jpeg') {
          const copy = await jpegFrom(decoded.source, full, PUBLISH_EDGE, 0.9);
          if (copy) await uploadVariant(asset.id, copy.blob, { purpose: 'publish', aspect_ratio: 'original', width: copy.width, height: copy.height }, signal);
        }
      } else if (job.kind === 'video' && facts?.video && facts.width) {
        const frame = { x: 0, y: 0, w: facts.width, h: facts.height };
        const poster = await jpegFrom(facts.video, frame, 1080, 0.85);
        if (poster) {
          await uploadVariant(asset.id, poster.blob, { purpose: 'poster', source_time_ms: Math.round((facts.video.currentTime || 0) * 1000), width: poster.width, height: poster.height }, signal);
          const thumb = await jpegFrom(facts.video, frame, THUMB_EDGE, 0.82);
          if (thumb) await uploadVariant(asset.id, thumb.blob, { purpose: 'thumb', width: thumb.width, height: thumb.height }, signal);
        }
      }
      try { asset = (await api('asset', { params: { id: asset.id }, signal })).asset || asset; } catch { /* the completed row is enough */ }
      remember(asset);
      job.status = 'done';
      batch.done += 1;
      finishJob(job, entryFor(asset));
      if (!activeJobs().length) {
        const failed = queue.filter((entry) => entry.status === 'failed').length;
        const uploaded = batch.done;
        if (uploaded) toast(`${plural(uploaded, 'file')} uploaded.${failed ? ` ${plural(failed, 'file')} didn’t upload.` : ''}`);
        window.dispatchEvent(new CustomEvent('atlas:marketing-media:changed'));
      }
    } catch (error) {
      if (error?.name === 'AbortError' || job.status === 'cancelled') {
        if (job.status !== 'cancelled') job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.permanent = Boolean(error?.permanent);
        job.rejected = ['size_mismatch', 'unsupported_type'].includes(error?.code);
        job.error = error?.text || jobErrorText(job, error);
      }
    } finally {
      decoded?.close?.();
      facts?.release?.();
      notifyQueue();
      pump();
    }
  }

  function jobErrorText(job, error) {
    if (error?.code === 'too_large') return uploadError(job.file, { error: 'size', kind: job.kind });
    if (error?.code === 'unsupported_type') return job.kind === 'video'
      ? 'This video’s format can’t be read. Export it as MP4 (H.264) and upload again.'
      : `${job.name} isn’t a photo or video. Choose a JPEG, PNG, HEIC, MP4 or MOV file.`;
    if (error?.code === 'size_mismatch') return 'The upload didn’t arrive complete. Nothing was kept. Retry this one.';
    if (error?.code === 'quota') return 'You have too many unfinished uploads. Let them finish, or cancel some, then try again.';
    if (error?.status === 403 || error?.status === 401 || error?.code === 'not_configured') return errorText(error);
    if (error?.code === 'unreachable') return error.offline
      ? 'You’re offline, so this didn’t upload. Retry it when you’re back online.'
      : 'Atlas couldn’t reach Media, so this didn’t upload. Retry it in a moment.';
    return 'The upload stopped. The other files are fine. Retry this one.';
  }

  async function cancelJob(id) {
    const job = queue.find((entry) => entry.id === id);
    if (!job) return;
    const reservation = job.reservation;
    const wasRunning = ['preparing', 'uploading'].includes(job.status);
    job.status = 'cancelled';
    job.controller?.abort();
    finishJob(job, null);
    notifyQueue();
    pump();
    if (reservation?.id && (wasRunning || reservation.status === 'pending_upload')) {
      try { await api('abandon', { method: 'POST', body: { asset_id: reservation.id } }); } catch { /* the janitor removes it later */ }
    }
  }

  function retryJob(id) {
    const job = queue.find((entry) => entry.id === id);
    if (!job || job.status !== 'failed' || job.permanent) return;
    // A rejected upload starts over; a stopped one replays its reservation.
    if (job.rejected) { job.requestId = requestId(); job.reservation = null; job.rejected = false; }
    job.status = 'waiting';
    job.loaded = 0;
    job.error = '';
    notifyQueue();
    pump();
  }

  function removeJob(id) {
    const job = queue.find((entry) => entry.id === id);
    if (job) { finishJob(job, null); notifyQueue(); }
  }

  function queueMarkup() {
    if (!queue.length) return '';
    const done = batch.done;
    const active = activeJobs().length;
    const rows = queue.map((job) => {
      const name = escapeHtml(job.name);
      const pct = job.size ? Math.floor((job.loaded / job.size) * 100) : 0;
      let meta = '';
      let end = `<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mm-cancel="${job.id}" aria-label="Cancel upload of ${name}"><i data-lucide="x"></i></button>`;
      if (job.status === 'waiting') meta = navigator.onLine === false ? 'Waiting for connection' : `Waiting · ${bytesText(job.size)}`;
      else if (job.status === 'preparing') meta = `Preparing · ${bytesText(job.size)}`;
      else if (job.status === 'uploading') meta = `<span data-mm-progress-text>${pct}% · ${bytesText(job.loaded)} of ${bytesText(job.size)}</span>`;
      else if (job.status === 'processing') { meta = 'Preparing preview…'; end = ''; }
      else if (job.status === 'failed') {
        meta = `<span class="atlas-field__error mk-queue__error" role="alert">${escapeHtml(job.error)}</span>`;
        end = `${job.permanent ? '' : `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mm-retry="${job.id}">Retry</button>`}<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mm-remove="${job.id}" aria-label="Remove ${name} from uploads"><i data-lucide="x"></i></button>`;
      }
      const progress = job.status === 'uploading'
        ? `<div class="atlas-progress atlas-progress--thin" role="progressbar" aria-label="Uploading ${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-mm-bar style="width:${pct}%"></span></div>`
        : '';
      const thumb = job.preview ? `<img src="${escapeHtml(job.preview)}" alt="">` : `<i data-lucide="${job.kind === 'video' ? 'film' : 'image'}"></i>`;
      return `<li class="atlas-row atlas-row--compact mk-queue__row" data-mm-job="${job.id}" data-mm-state="${job.status}"><span class="atlas-upload__thumb" aria-hidden="true">${thumb}</span><div class="atlas-row__body"><p class="atlas-row__title">${name}</p><p class="atlas-row__meta">${meta}</p>${progress}</div><div class="atlas-row__end">${end}</div></li>`;
    }).join('');
    const summary = `Uploads (${queue.length})`;
    const body = `<ul class="atlas-list mk-queue__list">${rows}</ul>`;
    if (!active) return `<details class="mk-queue" data-mm-queue open><summary>${summary}</summary>${body}</details>`;
    return `<section class="mk-queue" data-mm-queue aria-label="Uploads"><div class="mk-queue__head"><h3 class="atlas-section__title">Uploads</h3><span class="atlas-section__meta">${done} of ${batch.total} done</span></div>${body}</section>`;
  }

  // Progress updates touch only the bar, so focus and layout stay put.
  function renderQueueProgress(job) {
    document.querySelectorAll(`[data-mm-job="${job.id}"]`).forEach((row) => {
      const pct = job.size ? Math.floor((job.loaded / job.size) * 100) : 0;
      const bar = row.querySelector('[data-mm-bar]');
      if (bar) bar.style.width = `${pct}%`;
      row.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(pct));
      const text = row.querySelector('[data-mm-progress-text]');
      if (text) text.textContent = `${pct}% · ${bytesText(job.loaded)} of ${bytesText(job.size)}`;
    });
  }

  function bindQueue(container) {
    container.addEventListener('click', (event) => {
      const cancel = event.target.closest('[data-mm-cancel]');
      if (cancel) { cancelJob(cancel.dataset.mmCancel); return; }
      const retry = event.target.closest('[data-mm-retry]');
      if (retry) { retryJob(retry.dataset.mmRetry); return; }
      const remove = event.target.closest('[data-mm-remove]');
      if (remove) removeJob(remove.dataset.mmRemove);
    });
  }

  // ---------- shared markup ----------

  function tileMarkup(asset, { selectable = false, selected = false, disabled = false, label = '' } = {}) {
    const name = nameOf(asset);
    const url = thumbUrl(asset);
    const alt = asset.alt_text || `${asset.kind === 'video' ? 'Video' : 'Photo'}: ${name}`;
    const used = Number(asset.used_count) > 0;
    const aria = `${name}, ${kindWord(asset)}, ${used ? `used in ${plural(Number(asset.used_count), 'post')}` : 'not used yet'}${label ? `, ${label}` : ''}`;
    const image = url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy"${focalCss(asset.focal_point)}>` : `<i data-lucide="${asset.kind === 'video' ? 'film' : 'image'}" aria-hidden="true"></i>`;
    const badges = `${asset.kind === 'video' ? `<span class="atlas-badge mk-asset__badge" aria-hidden="true"><i data-lucide="play"></i>${durationText(asset.duration_ms)}</span>` : ''}${used ? '<span class="atlas-badge atlas-badge--muted mk-asset__used" aria-hidden="true">Used</span>' : ''}${selectable ? `<span class="mk-asset__check" aria-hidden="true">${selected ? '<i data-lucide="check"></i>' : ''}</span>` : ''}`;
    const pressed = selectable ? ` aria-pressed="${selected ? 'true' : 'false'}"` : '';
    return `<li class="mk-media-grid__cell"><button type="button" class="mk-asset${selected ? ' is-selected' : ''}" data-mm-asset="${escapeHtml(asset.id || asset.asset_id)}" aria-label="${escapeHtml(aria)}" title="${escapeHtml(name)}"${pressed}${disabled ? ' disabled' : ''}><span class="mk-asset__img">${image}${badges}</span><span class="mk-asset__name">${escapeHtml(name)}</span><span class="mk-asset__meta">${escapeHtml(label || usedText(asset))}</span></button></li>`;
  }

  function collectionTileMarkup(collection) {
    const items = Array.isArray(collection.items) ? collection.items.slice(0, 4) : [];
    const cells = Array.from({ length: 4 }, (_, index) => {
      const item = items[index];
      const url = item ? thumbUrl({ ...item, id: item.asset_id }) : null;
      return `<span class="mk-collection-tile__cell">${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy">` : ''}</span>`;
    }).join('');
    const count = Number(collection.count) || 0;
    return `<li class="mk-media-grid__cell"><button type="button" class="mk-collection-tile" data-mm-collection="${escapeHtml(collection.id)}" aria-label="${escapeHtml(`${collection.name}, collection of ${plural(count, 'item')}`)}"><span class="mk-collection-tile__mosaic" aria-hidden="true">${cells}</span><span class="mk-asset__name">${escapeHtml(collection.name)}</span><span class="mk-asset__meta">${plural(count, 'item')}</span></button></li>`;
  }

  function emptyMarkup(icon, title, text, action = '') {
    return `<div class="atlas-empty"><span class="atlas-empty__icon"><i data-lucide="${icon}"></i></span><h3 class="atlas-empty__title">${escapeHtml(title)}</h3>${text ? `<p class="atlas-empty__text">${escapeHtml(text)}</p>` : ''}${action}</div>`;
  }

  function announce(text) {
    let region = document.getElementById('mm-live');
    if (!region) {
      region = document.createElement('p');
      region.id = 'mm-live';
      region.className = 'sr-only';
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    region.textContent = '';
    window.setTimeout(() => { region.textContent = text; }, 30);
  }

  function sheetShell(id, title, desc, body, foot, extraClass = '') {
    return `<section class="atlas-sheet atlas-sheet--wide atlas-sheet--full-phone ${extraClass}" data-modal-panel aria-labelledby="${id}-title"><span class="atlas-sheet__grabber" aria-hidden="true"></span><header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="${id}-title">${escapeHtml(title)}</h2>${desc ? `<p class="atlas-sheet__desc" data-mm-desc>${escapeHtml(desc)}</p>` : ''}</div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header><div class="atlas-sheet__body">${body}</div><footer class="atlas-sheet__foot" data-atlas-sticky-actions>${foot}</footer></section>`;
  }

  // ---------- the Media tab ----------

  const mounts = new WeakMap();

  function mount(host, options = {}) {
    if (!(host instanceof HTMLElement)) throw new Error('AtlasMarketingMedia.mount needs an element');
    if (mounts.has(host)) { mounts.get(host).refresh(); return mounts.get(host); }
    const view = {
      mode: options.mode || 'library',
      filter: 'all', tags: [], q: '', sort: 'newest',
      assets: [], total: 0, next: null, tagList: [], counts: {}, collections: [],
      loading: false, error: null, loadedAt: 0, selecting: false, selected: new Set(), seq: 0
    };
    host.classList.add('mk-media');
    host.innerHTML = `<div class="atlas-toolbar mk-media__toolbar">
        <label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" placeholder="Search by name, tag or caption" aria-label="Search photos and videos" data-mm-search></label>
        <div class="atlas-chips" role="group" aria-label="Show" data-mm-filters>${FILTERS.map(([key, label]) => `<button type="button" class="atlas-chip" data-mm-filter="${key}" aria-pressed="${key === 'all'}">${label}</button>`).join('')}</div>
        <div class="atlas-chips" data-mm-tags></div>
        <div class="atlas-toolbar__end">
          <label class="sr-only" for="mm-sort-${host.id || 'media'}">Sort</label>
          <select class="atlas-select mk-media__sort" id="mm-sort-${host.id || 'media'}" data-mm-sort>${SORTS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select>
          <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-select aria-pressed="false">Select</button>
          <button type="button" class="atlas-btn atlas-btn--secondary mk-media__upload" data-mm-upload aria-label="Upload photos or videos"><i data-lucide="upload"></i><span class="mk-media__upload-label">Upload</span></button>
          <input type="file" multiple accept="${ACCEPT}" hidden data-mm-file>
        </div>
      </div>
      <div class="atlas-upload mk-dropzone" data-mm-drop hidden><span class="atlas-upload__thumb" aria-hidden="true"><i data-lucide="upload"></i></span><div class="atlas-upload__body"><p class="atlas-upload__title">Drop photos and videos to upload</p></div></div>
      <div data-mm-queue-slot></div>
      <div class="mk-media__body" data-mm-body></div>
      <div class="atlas-bulkbar atlas-bulkbar--sticky mk-media__bulk" data-mm-bulk hidden></div>`;
    const $ = (selector) => host.querySelector(selector);
    icons();

    function renderQueue() {
      const slot = $('[data-mm-queue-slot]');
      if (!slot) return;
      slot.innerHTML = queueMarkup();
      icons();
    }

    function renderTags() {
      const slot = $('[data-mm-tags]');
      if (!slot) return;
      const selected = view.tags.map((slug) => view.tagList.find((tag) => tag.slug === slug) || { slug, label: slug });
      slot.innerHTML = `${selected.map((tag) => `<span class="atlas-chip is-active">${escapeHtml(tag.label)}<button type="button" class="atlas-chip__clear" data-mm-tag-clear="${escapeHtml(tag.slug)}" aria-label="Remove tag filter ${escapeHtml(tag.label)}"><i data-lucide="x"></i></button></span>`).join('')}${view.tagList.length ? `<button type="button" class="atlas-chip" data-mm-tag-trigger><i data-lucide="tag"></i>Tag<i data-lucide="chevron-down"></i></button><div class="atlas-menu" role="menu" data-mm-tag-menu hidden>${view.tagList.map((tag) => `<button type="button" class="atlas-menu__item" role="menuitemcheckbox" aria-checked="${view.tags.includes(tag.slug)}" data-mm-tag="${escapeHtml(tag.slug)}">${escapeHtml(tag.label)} <span class="mk-media__count">${Number(tag.count) || 0}</span></button>`).join('')}</div>` : ''}`;
      icons();
      const trigger = slot.querySelector('[data-mm-tag-trigger]');
      const menu = slot.querySelector('[data-mm-tag-menu]');
      if (trigger && menu) {
        window.AtlasShell?.menu?.(trigger, menu, {
          align: 'start',
          onSelect: (item) => {
            const slug = item?.dataset?.mmTag;
            if (!slug) return;
            view.tags = view.tags.includes(slug) ? view.tags.filter((entry) => entry !== slug) : [...view.tags, slug];
            queueMicrotask(() => { renderTags(); load(); });
          }
        });
      }
    }

    function filterParams() {
      const params = { sort: view.sort, limit: 60 };
      if (view.filter === 'image' || view.filter === 'video') params.kind = view.filter;
      if (view.filter === 'used' || view.filter === 'unused') params.used = view.filter;
      if (view.q) params.q = view.q;
      if (view.tags.length) params.tag = view.tags;
      return params;
    }

    async function load({ more = false } = {}) {
      const seq = view.seq += 1;
      view.loading = !more;
      view.error = null;
      if (!more) renderBody();
      try {
        if (view.filter === 'collections') {
          const result = await api('collections');
          if (seq !== view.seq) return;
          view.collections = Array.isArray(result.collections) ? result.collections : [];
          view.collections.forEach((collection) => (collection.items || []).forEach((item) => remember({ ...item, id: item.asset_id })));
        } else {
          const params = filterParams();
          if (more && view.next) params.cursor = view.next;
          const result = await api('list', { params });
          if (seq !== view.seq) return;
          const assets = (Array.isArray(result.assets) ? result.assets : []).map(remember);
          view.assets = more ? [...view.assets, ...assets] : assets;
          view.total = Number(result.total) || view.assets.length;
          view.next = result.next_cursor || null;
          view.tagList = Array.isArray(result.tags) ? result.tags : [];
          view.counts = result.counts || {};
          view.collectionsCount = Number(result.collections_count) || 0;
          renderTags();
        }
        view.loadedAt = Date.now();
      } catch (error) {
        if (seq !== view.seq) return;
        view.error = error;
      } finally {
        if (seq === view.seq) { view.loading = false; renderBody(); }
      }
    }

    function renderBody() {
      const body = $('[data-mm-body]');
      if (!body) return;
      host.querySelectorAll('[data-mm-filter]').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.mmFilter === view.filter)));
      if (view.loading) {
        body.innerHTML = `<ul class="mk-media-grid" aria-busy="true">${'<li class="mk-media-grid__cell"><span class="atlas-skel mk-asset__skel"></span></li>'.repeat(8)}</ul>`;
        return;
      }
      if (view.error) {
        body.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Media couldn’t be loaded. Your files are safe.</p><p class="atlas-alert__body">${escapeHtml(errorText(view.error))}</p></div><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mm-reload>Try again</button></div>`;
        icons();
        return;
      }
      if (view.filter === 'collections') {
        body.innerHTML = view.collections.length
          ? `<div class="mk-media__row-actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mm-new-collection><i data-lucide="plus"></i>New collection</button></div><ul class="mk-media-grid" aria-label="Collections">${view.collections.map(collectionTileMarkup).join('')}</ul>`
          : emptyMarkup('layers', 'No collections yet', 'Group photos in the order you want them, such as a carousel for the autumn menu.', '<button type="button" class="atlas-btn atlas-btn--secondary" data-mm-new-collection>New collection</button>');
        icons();
        return;
      }
      if (!view.assets.length) {
        const filtered = view.q || view.tags.length || view.filter !== 'all';
        if (!filtered) body.innerHTML = emptyMarkup('images', 'No photos or videos yet', 'Upload the photos and videos you post, then reuse them in any post.', '<button type="button" class="atlas-btn atlas-btn--secondary" data-mm-upload>Upload photos or videos</button>');
        else if (view.filter === 'unused' && !view.q && !view.tags.length) body.innerHTML = emptyMarkup('check', 'Every photo and video is in a post.', '');
        else {
          const what = view.filter === 'video' ? 'videos' : view.filter === 'image' ? 'photos' : 'photos or videos';
          body.innerHTML = emptyMarkup('search', view.q ? `No ${what} match “${view.q}”.` : `No ${what} match these filters.`, '', '<button type="button" class="atlas-btn atlas-btn--secondary" data-mm-clear>Clear filters</button>');
        }
        icons();
        return;
      }
      body.innerHTML = `<ul class="mk-media-grid" aria-label="Photos and videos">${view.assets.map((asset) => tileMarkup(asset, { selectable: view.selecting, selected: view.selected.has(asset.id) })).join('')}</ul>${view.next ? '<div class="mk-media__more"><button type="button" class="atlas-btn atlas-btn--secondary" data-mm-more>Show more</button></div>' : ''}`;
      icons();
      renderBulk();
    }

    function renderBulk() {
      const bar = $('[data-mm-bulk]');
      if (!bar) return;
      const count = view.selected.size;
      bar.hidden = !(view.selecting && count);
      bar.innerHTML = count ? `<span>${count} selected</span><span class="atlas-bulkbar__sep"></span><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-bulk-use>Add to post</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-bulk-collection>Add to collection</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-bulk-tag>Add tag</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-bulk-delete>Delete</button>` : '';
    }

    function selectedAssets() { return view.assets.filter((asset) => view.selected.has(asset.id)); }

    async function bulkTag() {
      const label = await window.AtlasModal?.prompt?.({ title: 'Add tag', label: 'Tag', required: true, multiline: false, maxLength: 48, confirmLabel: 'Add tag' });
      if (!label) return;
      let failed = 0;
      for (const asset of selectedAssets()) {
        const tags = [...(asset.tags || []).map((tag) => tag.label), label];
        try { await api('update', { method: 'POST', body: { asset_id: asset.id, tags } }); } catch { failed += 1; }
      }
      toast(failed ? `The tag wasn’t added to ${plural(failed, 'item')}. Try again.` : `Tag “${label}” added.`, failed ? { tone: 'warning' } : undefined);
      load();
    }

    async function bulkDelete() {
      const items = selectedAssets();
      const ok = await window.AtlasModal?.confirm?.({ title: `Delete ${plural(items.length, 'item')}?`, body: 'They’re removed from the library. Posts already published keep their copy.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      let refused = 0;
      let failed = 0;
      let problem = null;
      for (const asset of items) {
        try { await api('delete', { method: 'POST', body: { asset_id: asset.id } }); } catch (error) {
          // Only an in_use refusal means "it's in a post"; anything else says what went wrong.
          if (error?.code === 'in_use') refused += 1; else { failed += 1; problem = error; }
        }
      }
      view.selected.clear();
      const notes = [];
      if (refused) notes.push(`${plural(refused, 'item')} couldn’t be deleted: they’re in posts that are waiting, scheduled or published.`);
      if (failed) notes.push(`${plural(failed, 'item')} ${failed === 1 ? 'wasn’t' : 'weren’t'} deleted. ${errorText(problem)}`);
      const deleted = items.length - refused - failed;
      toast(notes.length ? `${deleted ? `${plural(deleted, 'item')} deleted. ` : ''}${notes.join(' ')}` : `${plural(items.length, 'item')} deleted.`, notes.length ? { tone: 'warning' } : undefined);
      load();
    }

    async function bulkCollection() {
      let collections = [];
      try { collections = (await api('collections')).collections || []; } catch (error) { toast(errorText(error), { tone: 'warning' }); return; }
      const ids = selectedAssets().map((asset) => asset.id);
      const options = collections.map((collection) => `<label class="atlas-check-row"><input type="radio" class="atlas-radio" name="collection" value="${escapeHtml(collection.id)}"><span>${escapeHtml(collection.name)} <span class="mk-media__count">${plural(Number(collection.count) || 0, 'item')}</span></span></label>`).join('');
      const body = `<div class="atlas-stack">${options}<label class="atlas-check-row"><input type="radio" class="atlas-radio" name="collection" value="__new" ${collections.length ? '' : 'checked'}><span>New collection</span></label><div class="atlas-field"><label for="mm-new-collection-name">Name of a new collection</label><input class="atlas-input" id="mm-new-collection-name" name="name" maxlength="120"></div></div>`;
      await window.AtlasModal?.form?.({
        title: 'Add to collection', body, submitLabel: 'Add', wide: true,
        onSubmit: async (form) => {
          const choice = form.querySelector('input[name="collection"]:checked')?.value;
          if (!choice) return 'Choose a collection.';
          try {
            if (choice === '__new') {
              const name = form.querySelector('#mm-new-collection-name').value.trim();
              if (!name) return 'Give the collection a name.';
              await api('collection-upsert', { method: 'POST', body: { name, asset_ids: ids } });
            } else {
              const current = collections.find((collection) => collection.id === choice)?.asset_ids || [];
              await api('collection-upsert', { method: 'POST', body: { id: choice, asset_ids: [...current, ...ids.filter((id) => !current.includes(id))] } });
            }
          } catch (error) {
            return errorText(error);
          }
          toast(`${plural(ids.length, 'item')} added to the collection.`);
          return null;
        }
      });
    }

    function onClick(event) {
      if (suppressClick) { suppressClick = false; return; }
      const target = event.target;
      const filter = target.closest('[data-mm-filter]');
      if (filter) { view.filter = filter.dataset.mmFilter; view.selected.clear(); load(); return; }
      if (target.closest('[data-mm-upload]')) { $('[data-mm-file]')?.click(); return; }
      if (target.closest('[data-mm-reload]')) { load(); return; }
      if (target.closest('[data-mm-more]')) { load({ more: true }); return; }
      if (target.closest('[data-mm-clear]')) {
        view.q = ''; view.tags = []; view.filter = 'all';
        const search = $('[data-mm-search]');
        if (search) search.value = '';
        renderTags(); load(); return;
      }
      const clearTag = target.closest('[data-mm-tag-clear]');
      if (clearTag) { view.tags = view.tags.filter((slug) => slug !== clearTag.dataset.mmTagClear); renderTags(); load(); return; }
      if (target.closest('[data-mm-select]')) {
        view.selecting = !view.selecting;
        view.selected.clear();
        target.closest('[data-mm-select]').setAttribute('aria-pressed', String(view.selecting));
        renderBody();
        return;
      }
      if (target.closest('[data-mm-new-collection]')) { openCollection(null, { onSaved: () => load() }); return; }
      const collection = target.closest('[data-mm-collection]');
      if (collection) { openCollection(collection.dataset.mmCollection, { onSaved: () => load() }); return; }
      const tile = target.closest('[data-mm-asset]');
      if (tile) {
        const id = tile.dataset.mmAsset;
        if (view.selecting) {
          if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
          renderBody();
          host.querySelector(`[data-mm-asset="${CSS.escape(id)}"]`)?.focus();
          return;
        }
        openAsset(id, { onChanged: () => load() });
        return;
      }
      if (target.closest('[data-mm-bulk-use]')) { useInNewPost(selectedAssets().map((asset) => entryFor(asset))); return; }
      if (target.closest('[data-mm-bulk-tag]')) { bulkTag(); return; }
      if (target.closest('[data-mm-bulk-delete]')) { bulkDelete(); return; }
      if (target.closest('[data-mm-bulk-collection]')) bulkCollection();
    }

    let searchTimer = null;
    function onInput(event) {
      if (event.target.matches('[data-mm-search]')) {
        window.clearTimeout(searchTimer);
        const value = event.target.value.trim();
        searchTimer = window.setTimeout(() => { view.q = value; if (view.filter === 'collections') view.filter = 'all'; load(); }, 250);
      }
    }
    function onChange(event) {
      if (event.target.matches('[data-mm-sort]')) { view.sort = event.target.value; load(); return; }
      if (event.target.matches('[data-mm-file]')) {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length) enqueue(files);
      }
    }
    // Long-press on a tile (phone) starts selection mode.
    let pressTimer = null;
    function onPointerDown(event) {
      const tile = event.target.closest('[data-mm-asset]');
      if (!tile || event.pointerType !== 'touch' || view.selecting) return;
      pressTimer = window.setTimeout(() => {
        view.selecting = true;
        view.selected.add(tile.dataset.mmAsset);
        $('[data-mm-select]')?.setAttribute('aria-pressed', 'true');
        renderBody();
        suppressClick = true;
      }, 550);
    }
    let suppressClick = false;
    const cancelPress = () => { window.clearTimeout(pressTimer); };
    // Desktop drag and drop onto the Media tab.
    function onDragOver(event) {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      const zone = $('[data-mm-drop]');
      if (zone) { zone.hidden = false; zone.classList.add('is-dragover'); }
    }
    function onDragLeave(event) {
      if (event.relatedTarget && host.contains(event.relatedTarget)) return;
      const zone = $('[data-mm-drop]');
      if (zone) { zone.hidden = true; zone.classList.remove('is-dragover'); }
    }
    function onDrop(event) {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      onDragLeave({});
      enqueue(event.dataTransfer.files);
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointerup', cancelPress);
    host.addEventListener('pointercancel', cancelPress);
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);
    bindQueue(host);
    const queueListener = () => renderQueue();
    queueListeners.add(queueListener);
    const changed = () => load();
    window.addEventListener('atlas:marketing-media:changed', changed);

    const controller = {
      refresh() { if (Date.now() - view.loadedAt > 30000 || !view.loadedAt) load(); },
      reload: () => load(),
      destroy() {
        queueListeners.delete(queueListener);
        window.removeEventListener('atlas:marketing-media:changed', changed);
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
        host.removeEventListener('change', onChange);
        host.removeEventListener('pointerdown', onPointerDown);
        host.removeEventListener('dragover', onDragOver);
        host.removeEventListener('dragleave', onDragLeave);
        host.removeEventListener('drop', onDrop);
        mounts.delete(host);
        host.innerHTML = '';
      }
    };
    mounts.set(host, controller);
    if (!isManager() && profile()) {
      host.querySelector('[data-mm-body]').innerHTML = emptyMarkup('lock', 'Media is for managers', 'Ask a manager or administrator to upload and organise photos and videos.');
      icons();
      return controller;
    }
    renderQueue();
    load();
    return controller;
  }

  // ---------- "Use in new post" hand-off ----------

  let pendingUse = null;
  function useInNewPost(entries) {
    if (!entries.length) return;
    pendingUse = entries;
    window.dispatchEvent(new CustomEvent('atlas:marketing-media:use', { detail: { entries } }));
    window.AtlasShell?.navigate?.('#marketing/new');
  }
  function takePendingUse() {
    const entries = pendingUse;
    pendingUse = null;
    return entries;
  }

  // ---------- asset detail sheet ----------

  async function openAsset(id, { onChanged = null } = {}) {
    const root = window.AtlasModal?.layer?.({
      id: 'mm-asset-sheet',
      panel: sheetShell('mm-asset', 'Photo or video', '', '<div class="mk-skeleton" aria-busy="true"><span class="atlas-skel atlas-skel--row"></span><span class="atlas-skel atlas-skel--row"></span></div>', '<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Close</button>')
    });
    if (!root) return;
    let asset;
    try {
      asset = (await api('asset', { params: { id } })).asset;
    } catch (error) {
      root.querySelector('.atlas-sheet__body').innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">This couldn’t be opened. Your files are safe.</p><p class="atlas-alert__body">${escapeHtml(errorText(error))}</p></div></div>`;
      icons();
      return;
    }
    remember(asset);
    renderAssetSheet(root, asset, onChanged);
  }

  function assetDesc(asset) {
    const parts = [asset.kind === 'video' ? 'Video' : 'Photo'];
    if (asset.width && asset.height) parts.push(`${asset.width} × ${asset.height}`);
    if (asset.kind === 'video' && asset.duration_ms) parts.push(durationText(asset.duration_ms));
    parts.push(bytesText(asset.byte_size));
    const when = dateText(asset.created_at);
    parts.push(`uploaded by ${asset.uploaded_by_label || 'Team member'}${when ? `, ${when}` : ''}`);
    return parts.join(' · ');
  }

  function renderAssetSheet(root, asset, onChanged) {
    const draft = {
      title: asset.title || asset.original_filename || '',
      alt_text: asset.alt_text || '',
      tags: (asset.tags || []).map((tag) => tag.label),
      focal_point: asset.focal_point ? { x: Number(asset.focal_point.x), y: Number(asset.focal_point.y) } : null,
      trim: asset.trim ? { ...asset.trim } : null,
      cover_variant_id: asset.cover_variant_id || null
    };
    const initial = JSON.stringify(draft);
    const dirty = () => JSON.stringify(draft) !== initial;
    const isVideo = asset.kind === 'video';
    const scheduledUses = (asset.used_in || []).filter((use) => ['scheduled', 'approved', 'pending_approval'].includes(use.status));
    const block = asset.delete_block;
    const blockText = block ? (block.reason === 'published'
      ? 'It has been published. Archive it instead; published posts keep their history.'
      : `It’s in ${plural(Number(block.count) || 1, 'post')} that ${Number(block.count) === 1 ? 'is' : 'are'} waiting, scheduled or published. Remove it from those posts first.`) : '';
    const variants = Array.isArray(asset.variants) ? asset.variants : [];
    const cropState = asset.crops || {};
    const preview = asset.preview_url
      ? (isVideo
        ? `<video class="mk-detail__video" controls muted playsinline preload="metadata" src="${escapeHtml(asset.preview_url)}" data-mm-video></video>`
        : `<div class="mk-focal" data-mm-focal-area><img src="${escapeHtml(asset.preview_url)}" alt="${escapeHtml(asset.alt_text || `Photo: ${nameOf(asset)}`)}" data-mm-focal-img><span class="mk-focal__ring" role="slider" tabindex="0" aria-label="Focal point" aria-valuemin="0" aria-valuemax="100" data-mm-focal></span></div>`)
      : `<p class="mk-muted">The preview isn’t available right now.</p>`;
    const crops = !isVideo ? `<fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Crops</legend><p class="help">Atlas makes these copies for posting. The original is never changed.</p><ul class="mk-crops" data-mm-crops>${CROPS.map(([ratio, label, w, h]) => {
      const saved = cropState[ratio];
      const variant = saved && variants.find((entry) => entry.id === saved.variant_id);
      const width = variant?.width || null;
      const low = width && [ratioKey(1, 1), ratioKey(4, 5), ratioKey(9, 16)].includes(ratio) && width < 1080;
      return `<li class="mk-crop"><span class="mk-crop__frame mk-crop__frame--${ratio.replace(/[:.]/g, '-')}" aria-hidden="true">${variant?.url ? `<img src="${escapeHtml(variant.url)}" alt="">` : (asset.preview_url ? `<img src="${escapeHtml(asset.preview_url)}" alt="" data-mm-crop-auto${focalCss(draft.focal_point)}>` : '')}</span><span class="mk-crop__label">${escapeHtml(label)}</span><span class="mk-crop__state">${saved?.mode === 'adjusted' ? 'Adjusted' : 'Auto'}${low ? ` <span class="atlas-pill atlas-pill--warning" data-atlas-tooltip="This crop is ${width} px wide; Instagram recommends 1080 px.">Low resolution</span>` : ''}</span><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-adjust="${ratio}" aria-label="Adjust the ${escapeHtml(label)} crop" data-w="${w}" data-h="${h}">Adjust</button></li>`;
    }).join('')}</ul></fieldset>` : '';
    const video = isVideo ? `<fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Video</legend>
        <div class="atlas-field"><label for="mm-cover-range">Cover frame</label><div class="atlas-range"><input type="range" id="mm-cover-range" min="0" max="${Math.max(0, Number(asset.duration_ms) || 0)}" step="100" value="${Number(variants.find((entry) => entry.id === draft.cover_variant_id)?.source_time_ms) || 1000}" data-mm-cover-range><span data-mm-cover-time>${durationText(Number(variants.find((entry) => entry.id === draft.cover_variant_id)?.source_time_ms) || 1000)}</span></div><p class="help">Instagram, Facebook and TikTok show this before the video plays.</p><div><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mm-cover-use>Use this frame</button></div></div>
        <div class="mk-trim"><div class="atlas-field"><label for="mm-trim-start">Start at</label><input class="atlas-input" id="mm-trim-start" type="text" inputmode="numeric" placeholder="0:00" value="${draft.trim ? durationText(draft.trim.start_ms) : ''}" data-mm-trim="start"></div><div class="atlas-field"><label for="mm-trim-end">End at</label><input class="atlas-input" id="mm-trim-end" type="text" inputmode="numeric" placeholder="${durationText(asset.duration_ms)}" value="${draft.trim ? durationText(draft.trim.end_ms) : ''}" data-mm-trim="end"></div></div>
        <p class="help">Trim is saved as a setting. The video file isn’t cut; each platform gets the trimmed part.</p><p class="atlas-field__error" data-mm-trim-error role="alert" hidden></p>
        <details class="mk-detail__facts"><summary>File details</summary><p class="mk-muted">${escapeHtml([asset.mime_type, asset.rotation ? `rotated ${asset.rotation}°` : '', asset.has_audio === false ? 'no sound' : asset.has_audio ? 'with sound' : '', asset.frame_rate ? `${asset.frame_rate} fps` : ''].filter(Boolean).join(' · '))}</p></details>
      </fieldset>` : '';
    const usedIn = (asset.used_in || []).length ? `<fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Used in</legend><div class="atlas-chips">${asset.used_in.map((use) => `<a class="atlas-record-chip" href="#marketing/post/${escapeHtml(use.content_id)}">${escapeHtml(use.title)} · ${escapeHtml(String(use.status || '').replace(/_/g, ' '))}${use.scheduled_for ? ` ${escapeHtml(dateText(use.scheduled_for))}` : ''}</a>`).join('')}</div></fieldset>` : '';
    const body = `<div class="atlas-form mk-detail">
        <div class="mk-detail__preview">${preview}${!isVideo ? '<p class="help">Tap the part of the photo that must stay in every crop.</p><div><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-focal-reset>Reset to centre</button></div>' : ''}</div>
        <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Details</legend>
          <div class="atlas-field"><label for="mm-name">Name</label><input class="atlas-input" id="mm-name" maxlength="180" value="${escapeHtml(draft.title)}" data-mm-field="title"></div>
          <div class="atlas-field"><label for="mm-alt">Alt text</label><textarea class="atlas-input atlas-textarea" id="mm-alt" rows="2" maxlength="1000" aria-describedby="mm-alt-help" data-mm-field="alt_text">${escapeHtml(draft.alt_text)}</textarea><p class="help" id="mm-alt-help">Describes the photo for people who use screen readers. Instagram and Facebook post it with the photo.</p>${!draft.alt_text && scheduledUses.length ? `<p class="atlas-field__error" data-mm-alt-warning>Add alt text — ${plural(scheduledUses.length, 'scheduled post')} use${scheduledUses.length === 1 ? 's' : ''} this ${kindWord(asset)}.</p>` : ''}</div>
          <div class="atlas-field"><span class="atlas-label" id="mm-tags-label">Tags</span><div class="atlas-chips" aria-labelledby="mm-tags-label" data-mm-tag-list></div></div>
        </fieldset>
        ${crops}${video}${usedIn}
      </div>`;
    const deleteButton = `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--danger atlas-sheet__foot-start" data-mm-delete${block ? ` disabled aria-disabled="true" data-atlas-tooltip="${escapeHtml(blockText)}" aria-describedby="mm-delete-why"` : ''}>Delete</button>${block ? `<span class="sr-only" id="mm-delete-why">${escapeHtml(blockText)}</span>` : ''}`;
    const foot = `${deleteButton}<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Close</button><button type="button" class="atlas-btn atlas-btn--secondary" data-mm-use>Use in new post</button><button type="button" class="atlas-btn atlas-btn--primary" data-mm-save hidden>Save</button>`;
    const panel = root.querySelector('[data-modal-panel]');
    panel.outerHTML = sheetShell('mm-asset', nameOf(asset), assetDesc(asset), body, foot);
    const $ = (selector) => root.querySelector(selector);
    icons();

    const saveButton = $('[data-mm-save]');
    const syncDirty = () => { if (saveButton) saveButton.hidden = !dirty(); };

    function renderTagList() {
      const list = $('[data-mm-tag-list]');
      list.innerHTML = `${draft.tags.map((label, index) => `<span class="atlas-chip">${escapeHtml(label)}<button type="button" class="atlas-chip__clear" data-mm-tag-remove="${index}" aria-label="Remove tag ${escapeHtml(label)}"><i data-lucide="x"></i></button></span>`).join('')}<button type="button" class="atlas-chip atlas-chip--dashed" data-mm-tag-add><i data-lucide="plus"></i>Add tag</button>`;
      icons();
    }
    renderTagList();

    function placeRing() {
      const ring = $('[data-mm-focal]');
      if (!ring) return;
      const point = draft.focal_point || { x: 0.5, y: 0.5 };
      ring.style.left = `${point.x * 100}%`;
      ring.style.top = `${point.y * 100}%`;
      ring.setAttribute('aria-valuenow', String(Math.round(point.x * 100)));
      ring.setAttribute('aria-valuetext', `${Math.round(point.x * 100)}% across, ${Math.round(point.y * 100)}% down`);
      root.querySelectorAll('[data-mm-crop-auto]').forEach((img) => { img.style.objectPosition = `${Math.round(point.x * 100)}% ${Math.round(point.y * 100)}%`; });
    }
    placeRing();

    function setFocal(x, y) {
      draft.focal_point = { x: Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000, y: Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000 };
      placeRing();
      syncDirty();
    }

    root.addEventListener('input', (event) => {
      const field = event.target.closest('[data-mm-field]');
      if (field) { draft[field.dataset.mmField] = field.value; syncDirty(); return; }
      if (event.target.matches('[data-mm-cover-range]')) {
        const ms = Number(event.target.value) || 0;
        const label = $('[data-mm-cover-time]');
        if (label) label.textContent = durationText(ms);
        const player = $('[data-mm-video]');
        if (player) { try { player.currentTime = ms / 1000; } catch { /* not seekable yet */ } }
        return;
      }
      if (event.target.matches('[data-mm-trim]')) {
        const start = parseDuration($('[data-mm-trim="start"]').value);
        const end = parseDuration($('[data-mm-trim="end"]').value);
        const error = $('[data-mm-trim-error]');
        let problem = '';
        const bothEmpty = !$('[data-mm-trim="start"]').value.trim() && !$('[data-mm-trim="end"]').value.trim();
        if (bothEmpty) draft.trim = null;
        else if (start === null || end === null) problem = 'Write times as m:ss, for example 0:07.';
        else if (end <= start) problem = 'End must be after start.';
        else if (asset.duration_ms && end > asset.duration_ms) problem = `The video is ${durationText(asset.duration_ms)} long.`;
        else {
          draft.trim = { start_ms: start, end_ms: end };
          if (end - start < 3000) problem = `The trimmed video is ${Math.round((end - start) / 1000)} seconds; Reels need at least 3 seconds.`;
        }
        if (error) { error.hidden = !problem; error.textContent = problem; }
        ['start', 'end'].forEach((key) => $(`[data-mm-trim="${key}"]`)?.setAttribute('aria-invalid', String(Boolean(problem) && problem !== '' && !problem.includes('Reels'))));
        syncDirty();
      }
    });

    root.addEventListener('click', async (event) => {
      const target = event.target;
      const area = target.closest('[data-mm-focal-area]');
      if (area && !target.closest('[data-mm-focal]')) {
        const img = area.querySelector('img');
        const rect = img.getBoundingClientRect();
        if (rect.width && rect.height) setFocal((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
        return;
      }
      if (target.closest('[data-mm-focal-reset]')) { setFocal(0.5, 0.5); return; }
      const removeTag = target.closest('[data-mm-tag-remove]');
      if (removeTag) { draft.tags.splice(Number(removeTag.dataset.mmTagRemove), 1); renderTagList(); syncDirty(); return; }
      if (target.closest('[data-mm-tag-add]')) {
        const button = target.closest('[data-mm-tag-add]');
        const input = document.createElement('input');
        input.className = 'atlas-input mk-tag-input';
        input.setAttribute('aria-label', 'New tag');
        input.maxLength = 48;
        button.replaceWith(input);
        input.focus();
        let committed = false;
        const commit = (keep) => {
          if (committed) return;
          committed = true;
          const value = input.value.replace(/\s+/g, ' ').trim();
          if (keep && value && !draft.tags.some((tag) => tag.toLowerCase() === value.toLowerCase()) && draft.tags.length < 20) draft.tags.push(value);
          renderTagList();
          syncDirty();
          if (keep && value) root.querySelector('[data-mm-tag-add]')?.focus();
        };
        input.addEventListener('keydown', (keyEvent) => {
          if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); commit(true); }
          if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); commit(false); }
        });
        input.addEventListener('blur', () => { if (input.isConnected) commit(true); });
        return;
      }
      if (target.closest('[data-mm-use]')) {
        window.AtlasModal?.dismiss?.(root);
        useInNewPost([entryFor(asset)]);
        return;
      }
      if (target.closest('[data-mm-cover-use]')) { await saveCoverFrame(); return; }
      const adjust = target.closest('[data-mm-adjust]');
      if (adjust) { openCropDialog(asset, adjust.dataset.mmAdjust, draft.focal_point, async () => { await reopen(); }); return; }
      if (target.closest('[data-mm-delete]')) { await deleteAsset(); return; }
      if (target.closest('[data-mm-save]')) await save();
    });

    root.addEventListener('keydown', (event) => {
      if (!event.target.matches('[data-mm-focal]')) return;
      const step = event.shiftKey ? 0.1 : 0.02;
      const point = draft.focal_point || { x: 0.5, y: 0.5 };
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!moves[event.key]) return;
      event.preventDefault();
      setFocal(point.x + moves[event.key][0], point.y + moves[event.key][1]);
    });

    async function reopen() {
      try {
        const next = (await api('asset', { params: { id: asset.id } })).asset;
        renderAssetSheet(root, next, onChanged);
      } catch { /* keep the sheet as it is */ }
    }

    async function save() {
      const error = $('[data-mm-trim-error]');
      if (error && !error.hidden && !/Reels/.test(error.textContent)) { $('[data-mm-trim="start"]')?.focus(); return; }
      const before = JSON.parse(initial);
      const patch = { asset_id: asset.id };
      ['title', 'alt_text'].forEach((key) => { if (draft[key] !== before[key]) patch[key] = draft[key]; });
      if (JSON.stringify(draft.tags) !== JSON.stringify(before.tags)) patch.tags = draft.tags;
      const focalChanged = JSON.stringify(draft.focal_point) !== JSON.stringify(before.focal_point);
      if (focalChanged) patch.focal_point = draft.focal_point;
      if (JSON.stringify(draft.trim) !== JSON.stringify(before.trim)) patch.trim = draft.trim;
      saveButton.disabled = true;
      saveButton.classList.add('is-loading');
      try {
        await api('update', { method: 'POST', body: patch });
        if (focalChanged && !isVideo) await ensureCrops(asset.id, null, { respectAdjusted: true, focal: draft.focal_point });
        toast('Saved.');
        onChanged?.();
        await reopen();
      } catch (problem) {
        toast(errorText(problem, 'That couldn’t be saved. Nothing was changed. Try again.'), { tone: 'warning' });
        saveButton.disabled = false;
        saveButton.classList.remove('is-loading');
      }
    }

    async function saveCoverFrame() {
      const range = $('[data-mm-cover-range]');
      const ms = Number(range?.value) || 0;
      const button = $('[data-mm-cover-use]');
      button.disabled = true;
      button.classList.add('is-loading');
      try {
        const player = $('[data-mm-video]');
        let frame = null;
        if (player && player.videoWidth) {
          await new Promise((resolve) => {
            if (Math.abs(player.currentTime * 1000 - ms) < 50) { resolve(); return; }
            player.addEventListener('seeked', resolve, { once: true });
            player.currentTime = ms / 1000;
            window.setTimeout(resolve, 3000);
          });
          frame = await jpegFrom(player, { x: 0, y: 0, w: player.videoWidth, h: player.videoHeight }, 1080, 0.85);
        }
        if (!frame) throw Object.assign(new Error('frame'), { code: 'frame' });
        const variant = await uploadVariant(asset.id, frame.blob, { purpose: 'poster', source_time_ms: ms, width: frame.width, height: frame.height });
        if (!variant) throw new Error('upload');
        const thumb = await jpegFrom(player, { x: 0, y: 0, w: player.videoWidth, h: player.videoHeight }, THUMB_EDGE, 0.82);
        if (thumb) await uploadVariant(asset.id, thumb.blob, { purpose: 'thumb', width: thumb.width, height: thumb.height });
        await api('update', { method: 'POST', body: { asset_id: asset.id, cover_variant_id: variant.id } });
        toast('Cover frame saved.');
        onChanged?.();
        await reopen();
      } catch (problem) {
        toast(errorText(problem, 'The cover frame couldn’t be saved. Try again.'), { tone: 'warning' });
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }

    async function deleteAsset() {
      if (block) return;
      const ok = await window.AtlasModal?.confirm?.({ title: `Delete ${nameOf(asset)}?`, body: 'It’s removed from the library. Posts already published keep their copy.', confirmLabel: `Delete ${kindWord(asset)}`, danger: true });
      if (!ok) return;
      try {
        const result = await api('delete', { method: 'POST', body: { asset_id: asset.id } });
        window.AtlasModal?.dismiss?.(root);
        const detached = Number(result.detached) || 0;
        toast(`${nameOf(asset)} deleted.${detached ? ` It was removed from ${plural(detached, 'draft')}.` : ''}`, {
          action: { label: 'Undo', onClick: async () => { try { await api('restore', { method: 'POST', body: { asset_id: asset.id } }); onChanged?.(); } catch { /* the toast is gone */ } } }
        });
        onChanged?.();
      } catch (problem) {
        toast(errorText(problem), { tone: 'warning' });
      }
    }
    syncDirty();
  }

  // Crop dialog: a fixed-ratio frame over the photo; drag or arrow keys move
  // it, the range zooms (100–300%).
  async function openCropDialog(asset, ratio, focal, onSaved) {
    const preset = CROPS.find((entry) => entry[0] === ratio);
    if (!preset || !asset.preview_url) return;
    const [, label, w, h] = preset;
    const state = { focal: focal ? { ...focal } : { x: 0.5, y: 0.5 }, zoom: 1 };
    const body = `<div class="mk-cropper" data-mm-cropper><img src="${escapeHtml(asset.preview_url)}" alt="" data-mm-crop-img><span class="mk-cropper__frame" tabindex="0" role="application" aria-label="${escapeHtml(`${label} crop frame. Use the arrow keys to move it.`)}" data-mm-crop-frame></span></div><div class="atlas-field"><label for="mm-crop-zoom">Zoom</label><div class="atlas-range"><input type="range" id="mm-crop-zoom" min="100" max="300" step="5" value="100" data-mm-crop-zoom><span data-mm-crop-zoom-text>100%</span></div></div><div><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mm-crop-reset>Reset</button></div>`;
    const dialog = window.AtlasModal?.form?.({
      title: `Adjust ${label}`, body, submitLabel: 'Save crop', wide: true,
      onSubmit: async () => {
        const decoded = await fetchDecoded(asset.preview_url);
        if (!decoded) return 'The photo couldn’t be read here. Try again.';
        try {
          const region = cropRegion(decoded.width, decoded.height, w / h, state.focal, state.zoom);
          const out = await jpegFrom(decoded.source, region, CROP_EDGE, 0.88);
          if (!out) return 'The crop couldn’t be made. Try again.';
          const rect = { x: region.x / decoded.width, y: region.y / decoded.height, w: region.w / decoded.width, h: region.h / decoded.height };
          const variant = await uploadVariant(asset.id, out.blob, { purpose: 'crop', aspect_ratio: ratio, crop_rect: rect, width: out.width, height: out.height });
          if (!variant) return 'The crop couldn’t be saved. Try again.';
          await api('update', { method: 'POST', body: { asset_id: asset.id, crops: { [ratio]: { variant_id: variant.id, mode: 'adjusted' } } } });
          toast(`${label} crop saved.`);
          queueMicrotask(() => onSaved?.());
          return null;
        } catch (problem) {
          return errorText(problem);
        } finally {
          decoded.close();
        }
      }
    });
    const root = dialog?.root;
    if (!root) return;
    const frame = root.querySelector('[data-mm-crop-frame]');
    const img = root.querySelector('[data-mm-crop-img]');
    const place = () => {
      const width = img.naturalWidth || 1;
      const height = img.naturalHeight || 1;
      const region = cropRegion(width, height, w / h, state.focal, state.zoom);
      frame.style.left = `${(region.x / width) * 100}%`;
      frame.style.top = `${(region.y / height) * 100}%`;
      frame.style.width = `${(region.w / width) * 100}%`;
      frame.style.height = `${(region.h / height) * 100}%`;
    };
    if (img.complete) place(); else img.addEventListener('load', place, { once: true });
    root.addEventListener('input', (event) => {
      if (!event.target.matches('[data-mm-crop-zoom]')) return;
      state.zoom = Number(event.target.value) / 100;
      root.querySelector('[data-mm-crop-zoom-text]').textContent = `${event.target.value}%`;
      place();
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-mm-crop-reset]')) {
        state.focal = focal ? { ...focal } : { x: 0.5, y: 0.5 };
        state.zoom = 1;
        root.querySelector('[data-mm-crop-zoom]').value = '100';
        root.querySelector('[data-mm-crop-zoom-text]').textContent = '100%';
        place();
      }
    });
    frame.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!moves[event.key]) return;
      event.preventDefault();
      state.focal = { x: Math.min(1, Math.max(0, state.focal.x + moves[event.key][0])), y: Math.min(1, Math.max(0, state.focal.y + moves[event.key][1])) };
      place();
    });
    let dragging = null;
    frame.addEventListener('pointerdown', (event) => { dragging = { x: event.clientX, y: event.clientY, focal: { ...state.focal } }; frame.setPointerCapture?.(event.pointerId); });
    frame.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      state.focal = {
        x: Math.min(1, Math.max(0, dragging.focal.x + (event.clientX - dragging.x) / rect.width)),
        y: Math.min(1, Math.max(0, dragging.focal.y + (event.clientY - dragging.y) / rect.height))
      };
      place();
    });
    const stop = () => { dragging = null; };
    frame.addEventListener('pointerup', stop);
    frame.addEventListener('pointercancel', stop);
  }

  async function fetchDecoded(url) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return null;
      return await decodeImage(await response.blob());
    } catch { return null; }
  }

  // Auto crops from the focal point (for every preset, or `ratios`). Existing
  // adjusted crops are kept when respectAdjusted. Resolves { ratio: variant_id }.
  async function ensureCrops(assetId, ratios = null, { respectAdjusted = true, focal = undefined } = {}) {
    const asset = (await api('asset', { params: { id: assetId } })).asset;
    if (!asset || asset.kind !== 'image') return {};
    const existing = asset.crops || {};
    const wanted = (Array.isArray(ratios) && ratios.length ? CROPS.filter(([ratio]) => ratios.includes(ratio)) : CROPS);
    const point = focal === undefined ? asset.focal_point : focal;
    const out = {};
    const todo = [];
    for (const preset of wanted) {
      const saved = existing[preset[0]];
      if (saved && (focal === undefined || (respectAdjusted && saved.mode === 'adjusted'))) out[preset[0]] = saved.variant_id;
      else todo.push(preset);
    }
    if (!todo.length) return out;
    const source = asset.mime_type === 'image/jpeg' || asset.mime_type === 'image/png' || asset.mime_type === 'image/webp' ? asset.preview_url : null;
    const decoded = source ? await fetchDecoded(source) : (asset.preview_url ? await fetchDecoded(asset.preview_url) : null);
    if (!decoded) return out;
    const update = {};
    try {
      for (const [ratio, , w, h] of todo) {
        const region = cropRegion(decoded.width, decoded.height, w / h, point || { x: 0.5, y: 0.5 });
        const blob = await jpegFrom(decoded.source, region, CROP_EDGE, 0.88);
        if (!blob) continue;
        const rect = { x: region.x / decoded.width, y: region.y / decoded.height, w: region.w / decoded.width, h: region.h / decoded.height };
        const variant = await uploadVariant(assetId, blob.blob, { purpose: 'crop', aspect_ratio: ratio, crop_rect: rect, width: blob.width, height: blob.height });
        if (variant) { update[ratio] = { variant_id: variant.id, mode: 'auto' }; out[ratio] = variant.id; }
      }
    } finally {
      decoded.close();
    }
    if (Object.keys(update).length) await api('update', { method: 'POST', body: { asset_id: assetId, crops: update } });
    return out;
  }

  // ---------- collection builder ----------

  async function openCollection(id, { onSaved = null } = {}) {
    let collection = { id: null, name: '', items: [] };
    if (id) {
      try {
        const result = await api('collections');
        collection = (result.collections || []).find((entry) => entry.id === id) || collection;
      } catch (error) { toast(errorText(error), { tone: 'warning' }); return; }
    }
    const draft = {
      name: collection.name || '',
      items: (collection.items || []).map((item) => ({ ...item, id: item.asset_id })).map(remember)
    };
    const sheetId = 'mm-collection';
    const foot = `${collection.id ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--danger atlas-sheet__foot-start" data-mm-col-delete>Delete collection</button>' : ''}<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-mm-col-save>Save collection</button>`;
    const body = `<div class="atlas-form"><div class="atlas-field"><label for="mm-col-name">Name</label><input class="atlas-input" id="mm-col-name" maxlength="120" value="${escapeHtml(draft.name)}" aria-describedby="mm-col-name-error" data-mm-col-name><p class="atlas-field__error" id="mm-col-name-error" role="alert" hidden>Give the collection a name.</p></div><p class="help" data-mm-col-help>The first item is the cover. Instagram carousels take up to 10.</p><ol class="atlas-list mk-reorder" data-mm-col-list aria-label="Items in order"></ol><div><button type="button" class="atlas-btn atlas-btn--secondary" data-mm-col-add><i data-lucide="plus"></i>Add photos or videos</button></div></div>`;
    const root = window.AtlasModal?.layer?.({ id: 'mm-collection-sheet', panel: sheetShell(sheetId, collection.id ? collection.name : 'New collection', '', body, foot) });
    if (!root) return;
    const $ = (selector) => root.querySelector(selector);
    const finePointer = window.matchMedia?.('(pointer: fine)')?.matches;

    function renderList(focus = null) {
      const list = $('[data-mm-col-list]');
      const total = draft.items.length;
      list.innerHTML = total ? draft.items.map((item, index) => {
        const name = nameOf(item);
        const url = thumbUrl(item);
        return `<li class="atlas-row atlas-row--compact mk-reorder__item" data-mm-col-item="${escapeHtml(item.asset_id)}"${finePointer ? ' draggable="true"' : ''}>${finePointer ? '<span class="mk-reorder__grip" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>' : ''}<span class="atlas-row__icon mk-reorder__thumb">${url ? `<img src="${escapeHtml(url)}" alt="">` : `<i data-lucide="${item.kind === 'video' ? 'film' : 'image'}"></i>`}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(name)}</p><p class="atlas-row__meta">${index + 1} of ${total}${index === 0 ? ' · Cover' : ''}</p></div><div class="atlas-row__end"><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mm-move="${index}" data-direction="-1" aria-label="Move ${escapeHtml(name)} up"${index === 0 ? ' disabled' : ''}><i data-lucide="arrow-up"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mm-move="${index}" data-direction="1" aria-label="Move ${escapeHtml(name)} down"${index === total - 1 ? ' disabled' : ''}><i data-lucide="arrow-down"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mm-col-remove="${index}" aria-label="Remove ${escapeHtml(name)} from collection"><i data-lucide="x"></i></button></div></li>`;
      }).join('') : '<li class="mk-muted">No photos or videos yet. Add some below.</li>';
      const help = $('[data-mm-col-help]');
      if (help) help.textContent = total > 10 ? 'The first item is the cover. Instagram and Facebook use the first 10. TikTok photo posts use up to 35.' : 'The first item is the cover. Instagram carousels take up to 10.';
      help?.classList.toggle('mk-warning', total > 10);
      icons();
      if (focus) {
        const target = root.querySelector(`[data-mm-move="${focus.index}"][data-direction="${focus.direction}"]`);
        (target && !target.disabled ? target : root.querySelector(`[data-mm-move="${focus.index}"]:not([disabled])`))?.focus();
      }
    }
    renderList();

    function move(from, to) {
      if (to < 0 || to >= draft.items.length || from === to) return;
      const [item] = draft.items.splice(from, 1);
      draft.items.splice(to, 0, item);
      renderList();
      announce(`${nameOf(item)} moved to position ${to + 1} of ${draft.items.length}.`);
      return item;
    }

    root.addEventListener('click', async (event) => {
      const target = event.target;
      const mover = target.closest('[data-mm-move]');
      if (mover) {
        const from = Number(mover.dataset.mmMove);
        const direction = Number(mover.dataset.direction);
        move(from, from + direction);
        renderList({ index: from + direction, direction });
        return;
      }
      const remove = target.closest('[data-mm-col-remove]');
      if (remove) {
        const [item] = draft.items.splice(Number(remove.dataset.mmColRemove), 1);
        renderList();
        announce(`${nameOf(item)} removed from the collection.`);
        return;
      }
      if (target.closest('[data-mm-col-add]')) {
        const picked = await pick({ multiple: true, kinds: ['image', 'video'], allowCollections: false, exclude: draft.items.map((item) => item.asset_id) });
        if (Array.isArray(picked)) {
          picked.forEach((entry) => { if (!draft.items.some((item) => item.asset_id === entry.asset_id)) draft.items.push({ ...entry, id: entry.asset_id, name: entry.title }); });
          renderList();
        }
        return;
      }
      if (target.closest('[data-mm-col-delete]')) {
        const ok = await window.AtlasModal?.confirm?.({ title: `Delete ${collection.name}?`, body: 'The collection goes; its photos and videos stay in the library and in posts.', confirmLabel: 'Delete collection', danger: true });
        if (!ok) return;
        try {
          await api('collection-archive', { method: 'POST', body: { collection_id: collection.id } });
          window.AtlasModal?.dismiss?.(root);
          toast('Collection deleted.');
          onSaved?.();
        } catch (error) { toast(errorText(error), { tone: 'warning' }); }
        return;
      }
      if (target.closest('[data-mm-col-save]')) {
        const nameInput = $('[data-mm-col-name]');
        const name = nameInput.value.trim();
        const error = $('#mm-col-name-error');
        if (!name) { error.hidden = false; nameInput.setAttribute('aria-invalid', 'true'); nameInput.focus(); return; }
        const button = target.closest('[data-mm-col-save]');
        button.disabled = true;
        button.classList.add('is-loading');
        try {
          const ids = draft.items.map((item) => item.asset_id);
          if (collection.id) {
            const unchangedSet = JSON.stringify([...ids].sort()) === JSON.stringify([...(collection.asset_ids || [])].sort());
            if (unchangedSet && ids.length) {
              if (name !== collection.name) await api('collection-upsert', { method: 'POST', body: { id: collection.id, name } });
              await api('collection-reorder', { method: 'POST', body: { collection_id: collection.id, asset_ids: ids } });
            } else {
              await api('collection-upsert', { method: 'POST', body: { id: collection.id, name, asset_ids: ids } });
            }
          } else {
            await api('collection-upsert', { method: 'POST', body: { name, asset_ids: ids } });
          }
          window.AtlasModal?.dismiss?.(root);
          toast('Collection saved.');
          onSaved?.();
        } catch (problem) {
          error.hidden = false;
          error.textContent = problem?.code === 'duplicate_name' ? 'A collection with that name already exists.' : errorText(problem, 'The collection couldn’t be saved. Nothing was changed. Try again.');
          button.disabled = false;
          button.classList.remove('is-loading');
        }
      }
    });

    // Desktop drag (an extra; the buttons always work).
    let dragFrom = null;
    const list = $('[data-mm-col-list]');
    list.addEventListener('dragstart', (event) => {
      const row = event.target.closest('[data-mm-col-item]');
      if (!row) return;
      dragFrom = [...list.children].indexOf(row);
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', row.dataset.mmColItem); } catch { /* some browsers refuse */ }
    });
    list.addEventListener('dragover', (event) => {
      if (dragFrom === null) return;
      event.preventDefault();
      const row = event.target.closest('[data-mm-col-item]');
      list.querySelectorAll('.is-drop-before').forEach((node) => node.classList.remove('is-drop-before'));
      row?.classList.add('is-drop-before');
    });
    list.addEventListener('drop', (event) => {
      if (dragFrom === null) return;
      event.preventDefault();
      const row = event.target.closest('[data-mm-col-item]');
      const to = row ? [...list.children].indexOf(row) : draft.items.length - 1;
      const from = dragFrom;
      dragFrom = null;
      move(from, to > from ? to : to);
    });
    list.addEventListener('dragend', () => { dragFrom = null; list.querySelectorAll('.is-drop-before').forEach((node) => node.classList.remove('is-drop-before')); });
  }

  // ---------- picker ----------

  function pick({ multiple = true, kinds = ['image', 'video'], allowCollections = true, initialTab = 'library', exclude = [] } = {}) {
    return new Promise((resolve) => {
      const allowed = Array.isArray(kinds) && kinds.length ? kinds.filter((kind) => kind === 'image' || kind === 'video') : ['image', 'video'];
      const excluded = new Set(Array.isArray(exclude) ? exclude : []);
      const state = { tab: allowCollections && initialTab === 'collections' ? 'collections' : 'library', q: '', assets: [], collections: [], selected: [], loading: true, error: null, seq: 0 };
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const tabs = allowCollections ? `<div class="atlas-segmented mk-picker__tabs" role="group" aria-label="Choose from"><button type="button" data-mm-pick-tab="library" aria-pressed="${state.tab === 'library'}">Library</button><button type="button" data-mm-pick-tab="collections" aria-pressed="${state.tab === 'collections'}">Collections</button></div>` : '';
      const body = `<div class="mk-picker">${tabs}<div class="atlas-toolbar mk-picker__toolbar"><label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" placeholder="Search by name or tag" aria-label="Search photos and videos" data-mm-pick-search></label><div class="atlas-toolbar__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mm-pick-upload><i data-lucide="upload"></i>Upload new</button><input type="file" ${multiple ? 'multiple ' : ''}accept="${ACCEPT}" hidden data-mm-pick-file></div></div><div data-mm-pick-queue></div><div data-mm-pick-body></div></div>`;
      const foot = `<span class="mk-picker__count" data-mm-pick-count aria-live="polite"></span><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-mm-pick-done disabled>Add</button>`;
      const root = window.AtlasModal?.layer?.({ id: 'mm-picker-sheet', panel: sheetShell('mm-picker', allowCollections ? 'Add photos, videos or a collection' : 'Add photos or videos', '', body, foot, 'mk-picker-sheet'), onClose: () => { queueListeners.delete(queueListener); finish(null); } });
      if (!root) { finish(null); return; }
      const $ = (selector) => root.querySelector(selector);
      const queueListener = () => { const slot = $('[data-mm-pick-queue]'); if (slot) { slot.innerHTML = queueMarkup(); icons(); } };
      queueListeners.add(queueListener);
      queueListener();
      bindQueue(root);

      function renderFoot() {
        const count = state.selected.length;
        const done = $('[data-mm-pick-done]');
        done.disabled = !count;
        done.textContent = count ? `Add ${count}` : 'Add';
        $('[data-mm-pick-count]').textContent = count ? `${count} selected` : '';
      }

      function renderBody() {
        const body = $('[data-mm-pick-body]');
        root.querySelectorAll('[data-mm-pick-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mmPickTab === state.tab)));
        if (state.loading) { body.innerHTML = `<ul class="mk-media-grid mk-picker__grid" aria-busy="true">${'<li class="mk-media-grid__cell"><span class="atlas-skel mk-asset__skel"></span></li>'.repeat(6)}</ul>`; return; }
        if (state.error) { body.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Media couldn’t be loaded. Your files are safe.</p></div><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mm-pick-reload>Try again</button></div>`; icons(); return; }
        if (state.tab === 'collections') {
          body.innerHTML = state.collections.length ? `<ul class="mk-media-grid mk-picker__grid" aria-label="Collections">${state.collections.map(collectionTileMarkup).join('')}</ul>` : emptyMarkup('layers', 'No collections yet', 'Make one in Marketing › Media › Collections.');
          icons();
          return;
        }
        const assets = state.assets.filter((asset) => allowed.includes(asset.kind));
        body.innerHTML = assets.length ? `<ul class="mk-media-grid mk-picker__grid" aria-label="Photos and videos">${assets.map((asset) => {
          const added = excluded.has(asset.id);
          const position = state.selected.indexOf(asset.id);
          return tileMarkup(asset, { selectable: true, selected: position >= 0, disabled: added, label: added ? 'Already added' : position >= 0 ? `Selected ${position + 1}` : usedText(asset) });
        }).join('')}</ul>` : emptyMarkup('images', state.q ? `Nothing matches “${state.q}”.` : 'No photos or videos yet', state.q ? '' : 'Upload new ones here; they’re kept in the library.');
        icons();
      }

      async function load() {
        const seq = state.seq += 1;
        state.loading = true;
        state.error = null;
        renderBody();
        try {
          if (state.tab === 'collections') {
            const result = await api('collections');
            if (seq !== state.seq) return;
            state.collections = result.collections || [];
            state.collections.forEach((collection) => (collection.items || []).forEach((item) => remember({ ...item, id: item.asset_id })));
          } else {
            const params = { limit: 100, sort: 'newest' };
            if (allowed.length === 1) params.kind = allowed[0];
            if (state.q) params.q = state.q;
            const result = await api('list', { params });
            if (seq !== state.seq) return;
            state.assets = (result.assets || []).map(remember);
          }
        } catch (error) {
          if (seq === state.seq) state.error = error;
        } finally {
          if (seq === state.seq) { state.loading = false; renderBody(); }
        }
      }

      root.addEventListener('click', async (event) => {
        const target = event.target;
        const tab = target.closest('[data-mm-pick-tab]');
        if (tab) { state.tab = tab.dataset.mmPickTab; load(); return; }
        if (target.closest('[data-mm-pick-reload]')) { load(); return; }
        if (target.closest('[data-mm-pick-upload]')) { $('[data-mm-pick-file]').click(); return; }
        const collectionTile = target.closest('[data-mm-collection]');
        if (collectionTile) {
          const collection = state.collections.find((entry) => entry.id === collectionTile.dataset.mmCollection);
          const items = (collection?.items || []).filter((item) => item.status === 'ready' && !item.archived && allowed.includes(item.kind));
          if (!items.length) { toast('This collection has nothing that can be added here.', { tone: 'warning' }); return; }
          const entries = items.map((item) => entryFor({ ...item, id: item.asset_id }, { collection_id: collection.id, collection_name: collection.name }));
          finish(multiple ? entries : entries.slice(0, 1));
          window.AtlasModal?.dismiss?.(root, 'submit');
          return;
        }
        const tile = target.closest('[data-mm-asset]');
        if (tile && !tile.disabled) {
          const id = tile.dataset.mmAsset;
          const index = state.selected.indexOf(id);
          if (index >= 0) state.selected.splice(index, 1);
          else if (multiple) state.selected.push(id);
          else state.selected = [id];
          renderBody();
          renderFoot();
          root.querySelector(`[data-mm-asset="${CSS.escape(id)}"]`)?.focus();
          return;
        }
        if (target.closest('[data-mm-pick-done]')) {
          const byId = new Map(state.assets.map((asset) => [asset.id, asset]));
          const entries = state.selected.map((id) => byId.get(id)).filter(Boolean).map((asset) => entryFor(asset));
          finish(entries);
          window.AtlasModal?.dismiss?.(root, 'submit');
        }
      });
      let searchTimer = null;
      root.addEventListener('input', (event) => {
        if (!event.target.matches('[data-mm-pick-search]')) return;
        window.clearTimeout(searchTimer);
        const value = event.target.value.trim();
        searchTimer = window.setTimeout(() => { state.q = value; if (state.tab !== 'library') state.tab = 'library'; load(); }, 250);
      });
      root.addEventListener('change', async (event) => {
        if (!event.target.matches('[data-mm-pick-file]')) return;
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        const uploaded = (await enqueue(files)).filter(Boolean);
        if (settled) return;
        uploaded.forEach((entry) => {
          if (!allowed.includes(entry.kind)) return;
          if (!state.assets.some((asset) => asset.id === entry.asset_id)) state.assets.unshift({ ...entry, id: entry.asset_id, name: entry.title });
          if (!state.selected.includes(entry.asset_id)) { if (multiple) state.selected.push(entry.asset_id); else state.selected = [entry.asset_id]; }
        });
        state.tab = 'library';
        renderBody();
        renderFoot();
      });
      renderFoot();
      load();
    });
  }

  function upload(files) {
    return enqueue(files);
  }

  window.AtlasMarketingMedia = Object.freeze({
    version: VERSION,
    mount,
    pick,
    upload,
    thumbUrl,
    ensureCrops: (assetId, ratios) => ensureCrops(assetId, ratios, { respectAdjusted: true }),
    takePendingUse,
    openAsset: (id) => openAsset(id),
    openCollection: (id) => openCollection(id || null),
    // Test and diagnostics hook: the current upload queue (read-only snapshot).
    queue: () => queue.map((job) => ({ id: job.id, name: job.name, status: job.status, loaded: job.loaded, size: job.size, error: job.error }))
  });
})();
