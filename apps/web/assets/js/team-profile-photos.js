(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 45000;
  const REFRESH_MS = 5 * 60 * 60 * 1000;
  const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

  const state = {
    photos: new Map(),
    staff: null,
    policy: null,
    loading: false,
    busyProfileId: null,
    started: false,
    hostObserver: null,
    viewObserver: null,
    bootstrapTimer: null,
    refreshTimer: null,
    decorateFrame: null,
    lastLoadedAt: 0
  };

  function endpoint() {
    return String(cfg.TEAM_PROFILE_PHOTOS_API || '').trim();
  }

  function host() {
    return document.getElementById('team-profiles-view');
  }

  function appVisible() {
    const app = document.getElementById('app-screen');
    return Boolean(app) && window.getComputedStyle(app).display !== 'none';
  }

  function profilesVisible() {
    const element = host();
    return Boolean(element) && appVisible() && window.getComputedStyle(element).display !== 'none';
  }

  function initials(value) {
    const words = String(value || 'Atlas').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || 'A';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function request(action, options = {}) {
    const api = endpoint();
    if (!api) throw new Error('Team Profile photos API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to manage profile photos.');

    const url = new URL(api);
    url.searchParams.set('action', action);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = {
      authorization: `Bearer ${session.access_token}`,
      accept: 'application/json'
    };
    if (options.body && !(options.body instanceof FormData)) headers['content-type'] = 'application/json';

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers,
        body: options.body instanceof FormData
          ? options.body
          : options.body
          ? JSON.stringify(options.body)
          : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Profile-photo request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The profile-photo service took too long to respond. Check the connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function applyPayload(payload) {
    const rows = Array.isArray(payload?.photos) ? payload.photos : [];
    state.photos = new Map(rows.map((photo) => [photo.profile_id, photo]));
    state.staff = payload?.staff || state.staff;
    state.policy = payload?.policy || state.policy;
    state.lastLoadedAt = Date.now();
    scheduleDecorate();
    window.dispatchEvent(new CustomEvent('atlas:profile-photos-updated', {
      detail: { photos: rows, staff: state.staff }
    }));
  }

  // Completed actions and failures are announced with the shell toast
  // (design system §4.11); the photo controls stay where they are.
  function showFeedback(message) {
    if (window.AtlasShell?.toast) window.AtlasShell.toast(message);
  }

  function photoFor(profileId) {
    return state.photos.get(profileId) || null;
  }

  function imageMarkup(photo, name) {
    if (!photo?.signed_url) return `<span>${escapeHtml(initials(name))}</span>`;
    return `<img src="${escapeHtml(photo.signed_url)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
  }

  function decorateAvatar(element, profileId, name) {
    if (!element || !profileId) return;
    const photo = photoFor(profileId);
    const key = photo?.signed_url ? `${photo.version || ''}:${photo.signed_url}` : `initials:${initials(name)}`;
    if (element.dataset.teamProfilePhotoKey === key) return;
    element.dataset.teamProfilePhotoKey = key;
    element.dataset.teamProfilePhotoId = profileId;
    element.classList.toggle('has-profile-photo', Boolean(photo?.signed_url));
    element.innerHTML = imageMarkup(photo, name);
  }

  // Team renders the open profile with data-team-profile-detail (the sheet on
  // wider screens, the page on phones); its actions area holds the controls.
  function detailElements() {
    return [...document.querySelectorAll('[data-team-profile-detail]')];
  }

  function canManagePhoto(profileId) {
    return Boolean(profileId && state.staff && (state.staff.can_manage_team || state.staff.id === profileId));
  }

  function controlsMarkup(profileId, hasPhoto) {
    const busy = state.busyProfileId === profileId;
    // No capture attribute: phones offer the photo library and the camera.
    return `<div class="team-profile-photo-controls" data-team-profile-photo-controls="${escapeHtml(profileId)}">
      <input type="file" hidden data-team-profile-photo-input accept="image/jpeg,image/png,image/webp" />
      <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm${busy ? ' is-loading' : ''}" data-team-profile-photo-upload ${busy ? 'disabled aria-busy="true"' : ''} aria-label="${hasPhoto ? 'Change photo' : 'Add photo'} from camera or library">
        <i data-lucide="camera" aria-hidden="true"></i>${busy ? 'Saving\u2026' : hasPhoto ? 'Change photo' : 'Add photo'}
      </button>
      ${hasPhoto ? `<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-team-profile-photo-remove ${busy ? 'disabled' : ''} aria-label="Remove profile photo"><i data-lucide="trash-2" aria-hidden="true"></i></button>` : ''}
    </div>`;
  }

  function decorateControls(detail) {
    const profileId = detail.dataset.teamProfileDetail;
    const actions = detail.querySelector('.team-profile-detail-actions');
    if (!actions) return;
    const existing = actions.querySelector('[data-team-profile-photo-controls]');
    if (!canManagePhoto(profileId)) {
      existing?.remove();
      return;
    }
    const photo = photoFor(profileId);
    const key = `${profileId}:${photo?.version || 'none'}:${state.busyProfileId === profileId ? 'busy' : 'ready'}`;
    if (existing?.dataset.teamProfilePhotoRenderKey === key) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = controlsMarkup(profileId, Boolean(photo?.signed_url));
    const controls = wrapper.firstElementChild;
    controls.dataset.teamProfilePhotoRenderKey = key;
    if (existing) existing.replaceWith(controls);
    else actions.prepend(controls);
    window.lucide?.createIcons?.();
  }

  function decorateSidebarAvatar() {
    if (!state.staff?.id) return;
    const avatar = document.getElementById('user-avatar');
    const name = document.getElementById('profile-name')?.textContent?.trim() || state.staff.label || 'Atlas';
    decorateAvatar(avatar, state.staff.id, name);
  }

  function decorate() {
    // Team, Messages and Shifts render avatars from photoFor(); this pass adds
    // the upload controls to an open profile and keeps the sidebar avatar current.
    detailElements().filter((detail) => !detail.closest('[data-schedule-only]')).forEach(decorateControls);
    decorateSidebarAvatar();
    window.AtlasShell?.emit?.('team-profile-photos:decorated');
  }

  function scheduleDecorate() {
    if (state.decorateFrame) return;
    state.decorateFrame = window.requestAnimationFrame(() => {
      state.decorateFrame = null;
      decorate();
    });
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || !appVisible()) return;
    if (!options.force && state.lastLoadedAt && Date.now() - state.lastLoadedAt < 30000) {
      scheduleDecorate();
      return;
    }
    state.loading = true;
    try {
      applyPayload(await request('snapshot'));
    } catch (error) {
      if (!options.silent) showFeedback('Profile photos couldn\u2019t be loaded. Initials are shown instead.');
    } finally {
      state.loading = false;
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url)
      });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Atlas could not read this image. Use a JPEG, PNG, or WebP photo.'));
      };
      image.src = url;
    });
  }

  async function decodedImage(file) {
    if (window.createImageBitmap) {
      try {
        const bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
      } catch (_) {
        // Fall back to an HTML image for browsers with partial bitmap support.
      }
    }
    return loadImage(file);
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  async function preparePhoto(file) {
    if (!(file instanceof File)) throw new Error('Choose a profile photo first.');
    if (!ACCEPTED_TYPES.has(file.type)) throw new Error('Use a JPEG, PNG, or WebP profile photo.');
    if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw new Error('Choose an image smaller than 12 MB.');

    const decoded = await decodedImage(file);
    try {
      if (decoded.width < 64 || decoded.height < 64) throw new Error('Profile photos must be at least 64 × 64 pixels.');
      const target = 512;
      const crop = Math.min(decoded.width, decoded.height);
      const sx = Math.max(0, (decoded.width - crop) / 2);
      const sy = Math.max(0, (decoded.height - crop) / 2);
      const canvas = document.createElement('canvas');
      canvas.width = target;
      canvas.height = target;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('This browser cannot prepare the profile photo.');
      context.fillStyle = '#f1eee7';
      context.fillRect(0, 0, target, target);
      context.drawImage(decoded.source, sx, sy, crop, crop, 0, 0, target, target);

      let blob = await canvasBlob(canvas, 'image/webp', 0.86);
      let mime = 'image/webp';
      let extension = 'webp';
      if (!blob) {
        blob = await canvasBlob(canvas, 'image/jpeg', 0.88);
        mime = 'image/jpeg';
        extension = 'jpg';
      }
      if (!blob) throw new Error('Atlas could not prepare this profile photo.');
      if (blob.size > MAX_UPLOAD_BYTES) {
        blob = await canvasBlob(canvas, mime, 0.68);
      }
      if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error('The prepared photo is still larger than 2 MB. Choose a simpler image.');
      return {
        file: new File([blob], `profile.${extension}`, { type: mime, lastModified: Date.now() }),
        width: target,
        height: target
      };
    } finally {
      decoded.close?.();
    }
  }

  async function uploadPhoto(profileId, file) {
    if (state.busyProfileId) return;
    state.busyProfileId = profileId;
    scheduleDecorate();
    try {
      const prepared = await preparePhoto(file);
      const form = new FormData();
      form.set('profile_id', profileId);
      form.set('file', prepared.file);
      form.set('width', String(prepared.width));
      form.set('height', String(prepared.height));
      applyPayload(await request('upload', { method: 'POST', body: form }));
      showFeedback('Photo saved');
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : 'The photo couldn\u2019t be saved. Try again.');
    } finally {
      state.busyProfileId = null;
      scheduleDecorate();
    }
  }

  function confirmRemove() {
    return new Promise((resolve) => {
      if (!window.AtlasModal) { resolve(true); return; }
      const root = document.createElement('div');
      root.className = 'atlas-modal';
      root.setAttribute('data-atlas-modal', '');
      root.hidden = true;
      root.innerHTML = `<section class="atlas-dialog" data-modal-panel aria-labelledby="photo-remove-title"><h2 class="atlas-dialog__title" id="photo-remove-title">Remove this photo?</h2><div class="atlas-dialog__body"><p>Initials are shown instead. The change is kept in the history.</p></div><div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--danger-solid" data-photo-remove-confirm>Remove photo</button></div></section>`;
      document.body.appendChild(root);
      let answer = false;
      window.AtlasModal.register(root, { onClose: () => { root.remove(); resolve(answer); } });
      root.querySelector('[data-photo-remove-confirm]').addEventListener('click', () => { answer = true; window.AtlasModal.close(root); });
      window.AtlasModal.open(root);
    });
  }

  async function removePhoto(profileId) {
    if (state.busyProfileId) return;
    if (!(await confirmRemove())) return;
    state.busyProfileId = profileId;
    scheduleDecorate();
    try {
      applyPayload(await request('remove', { method: 'POST', body: { profile_id: profileId } }));
      showFeedback('Photo removed');
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : 'The photo couldn\u2019t be removed. Try again.');
    } finally {
      state.busyProfileId = null;
      scheduleDecorate();
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const upload = target.closest('[data-team-profile-photo-upload]');
    if (upload) {
      event.preventDefault();
      upload.closest('[data-team-profile-photo-controls]')?.querySelector('[data-team-profile-photo-input]')?.click();
      return;
    }

    const remove = target.closest('[data-team-profile-photo-remove]');
    if (remove) {
      event.preventDefault();
      const profileId = remove.closest('[data-team-profile-photo-controls]')?.dataset.teamProfilePhotoControls;
      if (profileId) removePhoto(profileId);
      return;
    }

  }

  function handleChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-team-profile-photo-input]')) return;
    const profileId = input.closest('[data-team-profile-photo-controls]')?.dataset.teamProfilePhotoControls;
    const file = input.files?.[0];
    input.value = '';
    if (profileId && file) uploadPhoto(profileId, file);
  }

  function startRefreshTimer() {
    if (state.refreshTimer) return;
    state.refreshTimer = window.setInterval(() => {
      if (!document.hidden && appVisible()) loadSnapshot({ force: true, silent: true });
    }, REFRESH_MS);
  }

  function ensureStarted() {
    const element = host();
    if (!element) return false;
    if (state.started) {
      scheduleDecorate();
      return true;
    }
    state.started = true;
    // S88: Team Profiles announces each render and AtlasShell announces the view
    // opening; decorate and refresh then (formerly a MutationObserver on the view).
    const refreshVisibleProfiles = () => {
      scheduleDecorate();
      if (profilesVisible() && (!state.lastLoadedAt || Date.now() - state.lastLoadedAt > 30000)) {
        loadSnapshot({ silent: true });
      }
    };
    window.AtlasShell?.on?.('team-profiles:rendered', refreshVisibleProfiles);
    window.AtlasShell?.onView?.('team-profiles', { show: refreshVisibleProfiles });
    startRefreshTimer();
    loadSnapshot({ force: true, silent: true });
    return true;
  }

  function init() {
    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    window.addEventListener('focus', () => {
      if (Date.now() - state.lastLoadedAt > REFRESH_MS) loadSnapshot({ force: true, silent: true });
      else scheduleDecorate();
    });
    window.addEventListener('online', () => loadSnapshot({ force: true, silent: true }));
    // Messages and the sidebar show photos too, so load them at sign-in rather
    // than waiting for someone to open Team Profiles.
    const loadForSignedInApp = () => {
      if (!appVisible()) return;
      startRefreshTimer();
      if (!state.lastLoadedAt) loadSnapshot({ force: true, silent: true });
    };
    window.addEventListener('atlas:profile-ready', () => window.setTimeout(loadForSignedInApp, 0));
    loadForSignedInApp();

    if (ensureStarted()) return;
    state.bootstrapTimer = window.setInterval(() => {
      if (!ensureStarted()) return;
      window.clearInterval(state.bootstrapTimer);
      state.bootstrapTimer = null;
    }, 250);
    window.setTimeout(() => {
      if (state.bootstrapTimer) window.clearInterval(state.bootstrapTimer);
      state.bootstrapTimer = null;
    }, 30000);

    window.addEventListener('pagehide', () => {
      state.viewObserver?.disconnect();
      if (state.bootstrapTimer) window.clearInterval(state.bootstrapTimer);
      if (state.refreshTimer) window.clearInterval(state.refreshTimer);
      if (state.decorateFrame) window.cancelAnimationFrame(state.decorateFrame);
    }, { once: true });
  }

  window.AtlasTeamProfilePhotos = {
    refresh: () => loadSnapshot({ force: true }),
    photos: () => [...state.photos.values()],
    photoFor: (profileId) => photoFor(profileId),
    decorate: scheduleDecorate
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
