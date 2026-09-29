// Training — #knowledge/training, #knowledge/training/<lessonId>
// (Knowledge → Training). A self-contained shell view ('training') that lives
// under the Knowledge route: the shell's ROUTES.knowledge prefers a registered
// 'training' view for #knowledge/training[/<id>] and falls back to the Knowledge
// training tab when this module is absent.
//
// Staff get a lesson player (video → chapters → written SOP → procedure steps →
// completion). Managers additionally author lessons (private drafts, immutable
// published versions), upload video and read completion reports. Role and
// permission are server-authoritative: permissions.can_manage_training from the
// payload only shows or hides manager controls. Every server string is escaped;
// the SOP is rendered through renderMarkdown, never raw innerHTML. Video is
// fetched as a Blob and played through an object URL because the site CSP is
// `media-src 'self' blob:` (no Supabase host).
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 24000;
  // Video position is reported at most this often while playing (plus on pause
  // and when the tab is hidden or unloaded).
  const PROGRESS_THROTTLE_MS = 10000;
  const STEP_STORAGE_KEY = 'atlas.training.steps.v1';
  const ROLE_LABELS = { all: 'Everyone', admin: 'Administrators', manager: 'Managers', bartender: 'Bartenders', viewer: 'Read-only staff' };
  const ROLE_KEYS = ['all', 'admin', 'manager', 'bartender', 'viewer'];
  const DIFFICULTY = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
  const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime';
  const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener() {} };

  const state = {
    snapshot: null,
    permissions: null,
    actorRole: null,
    loading: false,
    error: null,
    failedAt: 0,
    submitting: false,
    lessonId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    detailMissing: false,
    completing: false,
    started: false,
    // Video playback (object URL from a Blob, per the CSP).
    video: { url: null, fetching: false, error: false, lastPosition: 0, lastSentAt: 0, hydratedFor: null },
    // Device-local procedure-step ticks, keyed `${versionId}:${stepId}`.
    stepChecks: null,
    // Manager video upload for the authoring sheet.
    upload: { status: 'idle', percent: 0, mediaId: null, error: null, filename: '' },
    visible: false,
    initialized: false
  };

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  // Only absolute http(s) URLs are ever opened (no javascript:, data:, file:).
  function safeHttpUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    try {
      const url = new URL(text);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch { return null; }
  }

  function icon(name) {
    return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
  }

  function paintIcons() {
    window.lucide?.createIcons?.();
  }

  function humanize(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  function vc() {
    return window.AtlasVenueClock;
  }

  function formatDate(value, fallback = '') {
    if (!value) return fallback;
    return vc()?.formatDate?.(value) || fallback;
  }

  function formatDateTime(value, fallback = 'Not recorded') {
    if (!value) return fallback;
    return vc()?.formatDateTime?.(value) || fallback;
  }

  function pill(label, tone = 'neutral') {
    return `<span class="atlas-pill atlas-pill--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
  }

  // mm:ss ⇄ seconds.
  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function parseClock(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) return Number(value);
    const match = value.match(/^(\d+):([0-5]?\d)$/);
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return text;
  }

  // Markdown subset. Raw HTML is escaped first; only the formatting below is
  // added. The written SOP is rendered only through this.
  function renderMarkdown(value) {
    const lines = String(value || '').replace(/\r/g, '').split('\n');
    const output = [];
    let listType = null;
    const closeList = () => {
      if (!listType) return;
      output.push(`</${listType}>`);
      listType = null;
    };
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) { closeList(); continue; }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        closeList();
        const level = Math.min(4, heading[1].length + 1);
        output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }
      if (/^---+$/.test(line.trim())) { closeList(); output.push('<hr>'); continue; }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) {
        if (listType !== 'ul') { closeList(); listType = 'ul'; output.push('<ul>'); }
        output.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        if (listType !== 'ol') { closeList(); listType = 'ol'; output.push('<ol>'); }
        output.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
        continue;
      }
      const quote = line.match(/^>\s?(.+)$/);
      if (quote) { closeList(); output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
      closeList();
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    closeList();
    return output.join('');
  }

  function host() {
    return document.getElementById('training-view');
  }

  function canManage() {
    return Boolean(state.permissions?.can_manage_training);
  }

  function myRole() {
    return state.actorRole || window.AtlasShell?.profile?.()?.role || window.atlasCurrentProfile?.role || null;
  }

  // Categories for the authoring sheet. The training snapshot may carry them;
  // otherwise Knowledge (loaded in the same shell) has the canonical list.
  function categories() {
    if (Array.isArray(state.snapshot?.categories) && state.snapshot.categories.length) return state.snapshot.categories;
    const fromKnowledge = window.AtlasKnowledge?.snapshot?.()?.categories;
    return Array.isArray(fromKnowledge) ? fromKnowledge : [];
  }

  // ---------- device-local step ticks ----------

  function loadStepChecks() {
    if (state.stepChecks) return state.stepChecks;
    state.stepChecks = new Map();
    try {
      const stored = JSON.parse(window.localStorage?.getItem(STEP_STORAGE_KEY) || '{}');
      if (stored && typeof stored === 'object') Object.entries(stored).forEach(([key, value]) => state.stepChecks.set(key, Boolean(value)));
    } catch { /* storage unavailable: ticks last for this page only */ }
    return state.stepChecks;
  }

  function saveStepChecks() {
    try {
      const object = {};
      loadStepChecks().forEach((value, key) => { if (value) object[key] = true; });
      window.localStorage?.setItem(STEP_STORAGE_KEY, JSON.stringify(object));
    } catch { /* storage unavailable */ }
  }

  // ---------- API ----------

  class TrainingError extends Error {
    constructor(message, status) { super(message); this.status = status; this.atlasFixed = true; }
  }

  function shown(error, fallback) {
    if (window.AtlasApi?.message) return window.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }

  const API_MESSAGES = {
    auth: 'Your session has ended. Sign in again to open Training.',
    forbidden: 'Your role can’t open that in Training.',
    not_found: 'This lesson isn’t available. It may have been retired or isn’t shared with your role.',
    conflict: 'This lesson changed while you were editing. Refresh and try again.',
    invalid: 'Training couldn’t accept that. Check the details and try again.',
    unavailable: 'Training is temporarily unavailable.',
    failed: 'Training is temporarily unavailable.'
  };

  function friendlyError(status) {
    const api = window.AtlasApi;
    return api ? api.friendlyMessage(api.kindFor(status, null), null, API_MESSAGES) : 'Training is temporarily unavailable.';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function accessToken() {
    const session = await activeSession();
    if (!session?.access_token) throw new TrainingError('Sign in again to open Training.', 401);
    return session.access_token;
  }

  async function api(action, options = {}) {
    const endpoint = String(cfg.TRAINING_API || '').trim();
    if (!endpoint) throw new TrainingError('Training is not set up for this Atlas yet.', 0);
    const token = await accessToken();
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new TrainingError(friendlyError(response.status), response.status);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new TrainingError('Training took too long to answer. Check the connection and try again.', 0);
      if (error instanceof TrainingError) throw error;
      throw new TrainingError('Training couldn’t be reached. Check the connection and try again.', 0);
    } finally {
      window.clearTimeout(timer);
    }
  }

  // ---------- data ----------

  function lessons() {
    return Array.isArray(state.snapshot?.lessons) ? state.snapshot.lessons : [];
  }

  function lessonState(lesson) {
    return lesson?.progress?.completion_state || null;
  }

  function isDone(lesson) {
    return lessonState(lesson) === 'completed';
  }

  function isInProgress(lesson) {
    return lessonState(lesson) === 'in_progress';
  }

  function targetedToMe(lesson) {
    const roles = Array.isArray(lesson.target_roles) ? lesson.target_roles : [];
    if (!roles.length || roles.includes('all')) return true;
    const role = myRole();
    return Boolean(role) && roles.includes(role);
  }

  function publishedLessons() {
    return lessons().filter((lesson) => lesson.version_state === 'published' && lesson.status !== 'retired');
  }

  function continueLessons() {
    return publishedLessons().filter((lesson) => isInProgress(lesson));
  }

  function requiredLessons() {
    return publishedLessons().filter((lesson) => lesson.required && targetedToMe(lesson) && !isDone(lesson) && !isInProgress(lesson));
  }

  function recommendedLessons() {
    return publishedLessons().filter((lesson) => !lesson.required && !isDone(lesson) && !isInProgress(lesson));
  }

  // ---------- layers ----------

  function openLayer({ id, panel, onClose, initialFocus }) {
    const root = window.AtlasModal.layer({ id, panel, className: 'tr-layer', onClose, initialFocus });
    paintIcons();
    return root;
  }

  function closeLayer(root) {
    if (root) window.AtlasModal.dismiss(root);
  }

  function confirmDialog({ title, body, confirmLabel, danger = false, field = null }) {
    const options = { id: 'tr-confirm', title, body, confirmLabel, danger };
    if (!field) return window.AtlasModal.confirm(options).then((ok) => (ok ? { value: '' } : null));
    return window.AtlasModal.prompt({ ...options, label: field.label, value: field.value, placeholder: field.placeholder, required: field.required, maxLength: 3000 })
      .then((value) => (value === null ? null : { value }));
  }

  // ---------- home ----------

  function roleTag(lesson) {
    if (!lesson.required) return 'Recommended';
    const roles = (Array.isArray(lesson.target_roles) ? lesson.target_roles : []).filter((r) => r && r !== 'all');
    return roles.length ? `Required · ${roles.map((r) => ROLE_LABELS[r] || humanize(r)).join(', ')}` : 'Required · Everyone';
  }

  function cardMeta(lesson) {
    const parts = [];
    if (lesson.estimated_minutes) parts.push(`${Number(lesson.estimated_minutes)} min`);
    const steps = Number(lesson.step_count || 0);
    if (steps) parts.push(`${steps} ${steps === 1 ? 'step' : 'steps'}`);
    if (lesson.has_video) parts.push('Video');
    if (lesson.difficulty && DIFFICULTY[lesson.difficulty]) parts.push(DIFFICULTY[lesson.difficulty]);
    return parts.join(' · ');
  }

  function cardStatePill(lesson) {
    if (isDone(lesson)) return pill('Completed', 'positive');
    if (isInProgress(lesson)) return pill('Continue', 'info');
    return pill('Start', 'neutral');
  }

  function lessonCard(lesson) {
    const id = lesson.article_id;
    const meta = cardMeta(lesson);
    return `<li class="tr-card-wrap"><a class="atlas-card atlas-card--pad tr-card" href="#knowledge/training/${encodeURIComponent(id)}" data-training-card="${escapeHtml(id)}">
      <div class="tr-card__body">
        <p class="tr-card__tag">${escapeHtml(roleTag(lesson))}</p>
        <p class="tr-card__title">${escapeHtml(lesson.title || 'Untitled lesson')}</p>
        ${lesson.summary ? `<p class="tr-card__summary">${escapeHtml(lesson.summary)}</p>` : ''}
        ${meta ? `<p class="tr-card__meta">${escapeHtml(meta)}</p>` : ''}
      </div>
      <div class="tr-card__end">${cardStatePill(lesson)}<span class="tr-card__chevron">${icon('chevron-right')}</span></div>
    </a></li>`;
  }

  function cardSection(title, list, key) {
    if (!list.length) return '';
    return `<section class="tr-section" aria-labelledby="tr-${key}-title" data-training-section="${key}">
      <h2 class="tr-section__title" id="tr-${key}-title">${escapeHtml(title)}</h2>
      <ul class="tr-cards">${list.map(lessonCard).join('')}</ul>
    </section>`;
  }

  function managerListMarkup() {
    if (!canManage()) return '';
    const all = lessons().slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    const drafts = all.filter((lesson) => lesson.version_state === 'draft' || lesson.status === 'draft');
    const published = all.filter((lesson) => lesson.version_state === 'published' && lesson.status !== 'retired');
    const rowFor = (lesson) => `<li class="atlas-row tr-manage-row" data-training-manage="${escapeHtml(lesson.article_id)}">
        <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(lesson.title || 'Untitled lesson')}</p><p class="atlas-row__meta">${escapeHtml([lesson.version_number ? `v${Number(lesson.version_number)}` : null, humanize(lesson.version_state || lesson.status || ''), cardMeta(lesson)].filter(Boolean).join(' · '))}</p></div>
        <div class="atlas-row__end"><a class="atlas-btn atlas-btn--ghost atlas-btn--sm" href="#knowledge/training/${encodeURIComponent(lesson.article_id)}" data-training-card="${escapeHtml(lesson.article_id)}">${icon('pencil')}Open</a><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-training-report="${escapeHtml(lesson.article_id)}">${icon('users')}View completion</button></div>
      </li>`;
    return `<section class="tr-section tr-manage" aria-labelledby="tr-manage-title" data-training-section="manage">
      <div class="tr-section__head"><h2 class="tr-section__title" id="tr-manage-title">Manage training</h2></div>
      ${drafts.length ? `<h3 class="tr-subhead">Drafts</h3><ul class="atlas-list tr-list">${drafts.map(rowFor).join('')}</ul>` : ''}
      ${published.length ? `<h3 class="tr-subhead">Published</h3><ul class="atlas-list tr-list">${published.map(rowFor).join('')}</ul>` : ''}
      ${!drafts.length && !published.length ? '<p class="tr-note">No lessons yet. Create the first with “New training”.</p>' : ''}
    </section>`;
  }

  function headerMarkup() {
    const published = publishedLessons();
    const done = published.filter((lesson) => isDone(lesson)).length;
    const sub = state.snapshot
      ? [`${published.length} ${published.length === 1 ? 'lesson' : 'lessons'}`, published.length ? `${done} completed` : null].filter(Boolean).join(' · ')
      : state.error ? 'Training couldn’t be loaded' : 'Watch, read and confirm the procedures for your role';
    return `<header class="page-head"><div class="page-head__text"><a class="tr-crumb" href="#knowledge">${icon('chevron-left')}Knowledge</a><h1 class="page-head__title">Training</h1><p class="page-head__sub">${escapeHtml(sub)}</p></div>${canManage() ? `<div class="page-head__actions"><button type="button" class="atlas-btn atlas-btn--primary" data-training-new>${icon('plus')}New training</button></div>` : ''}</header>`;
  }

  function alertMarkup() {
    if (!state.error) return '';
    return `<div class="atlas-alert atlas-alert--danger tr-alert" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Training couldn’t be ${state.snapshot ? 'updated' : 'loaded'}.</p><p class="atlas-alert__body">${escapeHtml(state.error)} ${state.snapshot ? 'You’re seeing what loaded last.' : 'Nothing has changed.'}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-training-refresh>Try again</button></div></div>`;
  }

  function homeMarkup() {
    if (!state.snapshot) {
      if (state.error) return '';
      return `<div class="tr-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(5)}<span class="sr-only">Loading Training</span></div>`;
    }
    if (!publishedLessons().length && !canManage()) {
      return `<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon">${icon('graduation-cap')}</div><h3 class="atlas-empty__title">No training yet</h3><p class="atlas-empty__text">Your manager will add the lessons your role needs.</p></div>`;
    }
    const sections = [
      cardSection('Continue', continueLessons(), 'continue'),
      cardSection('Required for you', requiredLessons(), 'required'),
      cardSection('Recommended', recommendedLessons(), 'recommended'),
      cardSection('Library', publishedLessons(), 'library')
    ].join('');
    const empty = !sections && !canManage()
      ? `<p class="tr-note">You’re all caught up.</p>` : '';
    return `${sections}${empty}${managerListMarkup()}`;
  }

  // ---------- lesson ----------

  function lessonMarkup() {
    if (state.detailLoading && !state.detail) {
      return `<div class="tr-lesson" aria-busy="true"><a class="atlas-btn atlas-btn--ghost atlas-btn--sm tr-back" href="#knowledge/training">${icon('chevron-left')}Training</a><div class="atlas-skel atlas-skel--title"></div>${'<div class="atlas-skel atlas-skel--text"></div>'.repeat(6)}<span class="sr-only">Loading lesson</span></div>`;
    }
    if (!state.detail) {
      const message = state.detailError || 'It may have been retired, or it isn’t shared with your role.';
      return `<div class="tr-lesson"><a class="atlas-btn atlas-btn--ghost atlas-btn--sm tr-back" href="#knowledge/training">${icon('chevron-left')}Training</a>
        <div class="atlas-empty"><div class="atlas-empty__icon">${icon('circle-alert')}</div><h1 class="atlas-empty__title">This lesson isn’t available</h1><p class="atlas-empty__text">${escapeHtml(message)}</p><div class="atlas-empty__actions">${state.detailMissing ? '' : '<button type="button" class="atlas-btn atlas-btn--secondary" data-training-retry>Try again</button>'}<a class="atlas-btn atlas-btn--secondary" href="#knowledge/training">Back to Training</a></div></div></div>`;
    }
    const detail = state.detail;
    const article = detail.article || {};
    const version = detail.version || {};
    const trainingMeta = detail.training || {};
    const media = detail.media || null;
    const chapters = (Array.isArray(detail.chapters) ? detail.chapters : []).slice().sort((a, b) => Number(a.start_seconds || 0) - Number(b.start_seconds || 0));
    const steps = Array.isArray(detail.steps) ? detail.steps : [];
    const progress = detail.progress || null;
    const draft = version.state === 'draft';
    const done = progress?.completion_state === 'completed';
    const manager = canManage();
    const versionNumber = Number(version.version_number || 1);
    const metaLine = [
      trainingMeta.estimated_minutes ? `${Number(trainingMeta.estimated_minutes)} min` : null,
      steps.length ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : null,
      trainingMeta.difficulty && DIFFICULTY[trainingMeta.difficulty] ? DIFFICULTY[trainingMeta.difficulty] : null,
      `Version ${versionNumber}`,
      version.published_at ? `Published ${formatDate(version.published_at)}` : null
    ].filter(Boolean).join(' · ');

    const managerActions = manager ? `<div class="tr-lesson__manage">
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-training-edit>${icon('pencil')}${draft ? 'Edit draft' : 'Edit draft for next version'}</button>
        ${draft ? `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" data-training-publish>${icon('send')}Publish</button>` : ''}
        ${article.status !== 'retired' ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-training-retire>Retire</button>` : ''}
        <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-training-report="${escapeHtml(article.id)}">${icon('users')}View completion</button>
      </div>` : '';

    // Video: a ready video plays through a Blob object URL (set after paint).
    const hasVideo = Boolean(media && media.upload_status === 'stored');
    const videoBlock = draft
      ? ''
      : hasVideo
        ? `<div class="tr-video" data-training-video-wrap>
            <video class="tr-video__el" data-training-video controls playsinline preload="metadata" ${media?.width && media?.height ? `width="${Number(media.width)}" height="${Number(media.height)}"` : ''}></video>
            <p class="tr-video__status" data-training-video-status hidden></p>
          </div>`
        : media
          ? `<div class="atlas-alert atlas-alert--info tr-video-note">${icon('video')}<div class="atlas-alert__content"><p class="atlas-alert__title">Video is still processing</p><p class="atlas-alert__body">The written procedure below is ready to read now.</p></div></div>`
          : '';

    const chaptersBlock = !draft && chapters.length ? `<section class="tr-section tr-lesson__section"><h2 class="tr-section__title">Chapters</h2><ul class="tr-chapters">${chapters.map((chapter) => `<li><button type="button" class="tr-chapter" data-training-chapter="${Number(chapter.start_seconds || 0)}"><span class="tr-chapter__time">${formatClock(chapter.start_seconds)}</span><span class="tr-chapter__title">${escapeHtml(chapter.title || 'Chapter')}</span></button></li>`).join('')}</ul></section>` : '';

    const sopBlock = version.content ? `<section class="tr-section tr-lesson__section"><h2 class="tr-section__title">Written procedure</h2><div class="tr-prose">${renderMarkdown(version.content)}</div></section>` : '';

    const checks = loadStepChecks();
    const stepsBlock = steps.length ? `<section class="tr-section tr-lesson__section"><h2 class="tr-section__title">Procedure steps</h2><ul class="tr-steps">${steps.map((step, index) => {
      const key = `${version.id}:${step.id ?? index}`;
      const checked = checks.get(key);
      const id = `tr-step-${index}`;
      return `<li><label class="atlas-check-row tr-step" for="${id}"><input type="checkbox" class="atlas-check" id="${id}" data-training-step="${escapeHtml(key)}" ${checked ? 'checked' : ''}><span>${escapeHtml(step.label || `Step ${index + 1}`)}</span></label></li>`;
    }).join('')}</ul><p class="tr-note">Ticks are a personal aid on this device; completing the training is what your manager sees.</p></section>` : '';

    const completeFooter = draft
      ? `<div class="atlas-alert atlas-alert--warning tr-lesson__draftnote">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Private draft</p><p class="atlas-alert__body">Only managers see this. Publish it to release it to the team.</p></div></div>`
      : done
        ? `<p class="tr-done" data-training-completed>${icon('circle-check')}Completed · ${escapeHtml(version.title || article.title || 'Training')} v${versionNumber}${progress?.completed_at ? ` · ${escapeHtml(formatDate(progress.completed_at))}` : ''}</p>`
        : `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--lg tr-complete" data-training-complete ${state.completing ? 'disabled' : ''}>${icon('circle-check')}I have completed this training</button>`;

    const stickyBar = phoneQuery.matches && !draft && !done
      ? `<div class="tr-bar"><button type="button" class="atlas-btn atlas-btn--primary" data-training-complete ${state.completing ? 'disabled' : ''}>${icon('circle-check')}I have completed this training</button></div>`
      : '';

    return `<article class="tr-lesson" aria-labelledby="tr-lesson-title">
      <a class="atlas-btn atlas-btn--ghost atlas-btn--sm tr-back" href="#knowledge/training">${icon('chevron-left')}Training</a>
      <header class="tr-lesson__head">
        <h1 class="tr-lesson__title" id="tr-lesson-title">${escapeHtml(version.title || article.title || 'Untitled lesson')}</h1>
        <p class="tr-lesson__meta">${escapeHtml(metaLine)}</p>
        ${article.required ? `<p class="tr-lesson__state">${pill(roleTag({ required: true, target_roles: article.target_roles }), 'info')}${draft ? pill('Draft', 'neutral') : ''}</p>` : draft ? `<p class="tr-lesson__state">${pill('Draft', 'neutral')}</p>` : ''}
        ${managerActions}
      </header>
      ${version.summary ? `<p class="tr-lesson__summary">${escapeHtml(version.summary)}</p>` : ''}
      ${videoBlock}
      ${chaptersBlock}
      ${sopBlock}
      ${stepsBlock}
      <footer class="tr-lesson__foot">${completeFooter}</footer>
    </article>${stickyBar}`;
  }

  // ---------- video playback (Blob object URL per CSP) ----------

  function teardownVideo() {
    if (state.video.url) {
      try { URL.revokeObjectURL(state.video.url); } catch { /* nothing to revoke */ }
    }
    state.video = { url: null, fetching: false, error: false, lastPosition: 0, lastSentAt: 0, hydratedFor: null };
  }

  function setVideoStatus(message) {
    const el = host()?.querySelector('[data-training-video-status]');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
  }

  async function fetchVideoBlob() {
    const detail = state.detail;
    if (!detail?.article?.id || !detail?.version?.id) return;
    if (state.video.fetching || state.video.url) return;
    state.video.fetching = true;
    setVideoStatus('Loading video…');
    try {
      const payload = await api('playback', { method: 'POST', body: { article_id: detail.article.id, version_id: detail.version.id } });
      const url = safeHttpUrl(payload?.url);
      if (!url) throw new TrainingError('Video is unavailable right now.', 0);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new TrainingError('Video is unavailable right now.', response.status);
      const blob = await response.blob();
      // The lesson may have changed while the video downloaded.
      if (state.lessonId !== detail.article.id) { try { URL.revokeObjectURL(URL.createObjectURL(blob)); } catch { /* ignore */ } return; }
      state.video.url = URL.createObjectURL(blob);
      state.video.error = false;
      setVideoStatus('');
      hydrateVideo();
    } catch (error) {
      state.video.error = true;
      setVideoStatus(shown(error, 'Video couldn’t be loaded.'));
    } finally {
      state.video.fetching = false;
    }
  }

  function sendProgress(force = false) {
    const detail = state.detail;
    if (!detail?.version?.id || detail.version.state === 'draft') return;
    const now = Date.now();
    if (!force && now - state.video.lastSentAt < PROGRESS_THROTTLE_MS) return;
    state.video.lastSentAt = now;
    const position = Math.max(0, Math.round(state.video.lastPosition || 0));
    api('progress', { method: 'POST', body: { version_id: detail.version.id, position_seconds: position } })
      .catch(() => { /* progress is a convenience; playing still works */ });
  }

  // Attaches the Blob source and listeners to the freshly painted <video>.
  function hydrateVideo() {
    const detail = state.detail;
    const video = host()?.querySelector('[data-training-video]');
    if (!video || !detail?.article?.id) return;
    if (!state.video.url) { if (!state.video.fetching && !state.video.error) fetchVideoBlob(); return; }
    if (video.dataset.trainingHydrated === state.video.url) return;
    video.dataset.trainingHydrated = state.video.url;
    video.src = state.video.url;
    const startAt = Number(detail.progress?.last_video_position_seconds || 0);
    video.addEventListener('loadedmetadata', () => {
      if (startAt > 0 && Number.isFinite(video.duration) && startAt < video.duration) {
        try { video.currentTime = startAt; } catch { /* seeking may be refused before ready */ }
      }
    }, { once: true });
    video.addEventListener('timeupdate', () => {
      state.video.lastPosition = video.currentTime;
      if (!video.paused) sendProgress(false);
    });
    video.addEventListener('pause', () => sendProgress(true));
    video.addEventListener('ended', () => sendProgress(true));
  }

  function seekVideo(seconds) {
    const video = host()?.querySelector('[data-training-video]');
    if (!video) return;
    const target = Math.max(0, Number(seconds) || 0);
    try {
      video.currentTime = target;
      video.play?.().catch(() => { /* autoplay may be blocked; that is fine */ });
    } catch { /* seeking may be refused before ready */ }
  }

  // ---------- authoring sheet (managers) ----------

  function chapterRowMarkup(chapter = {}) {
    return `<div class="tr-chapter-row" data-training-chapter-row>
      <input class="atlas-input tr-chapter-row__time" name="chapter_time" inputmode="numeric" placeholder="mm:ss" value="${chapter.start_seconds != null ? escapeHtml(formatClock(chapter.start_seconds)) : ''}" aria-label="Chapter time">
      <input class="atlas-input tr-chapter-row__title" name="chapter_title" maxlength="200" placeholder="Chapter title" value="${escapeHtml(chapter.title || '')}" aria-label="Chapter title">
      <button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-training-chapter-remove aria-label="Remove chapter">${icon('trash-2')}</button>
    </div>`;
  }

  function stepRowMarkup(label = '') {
    return `<div class="tr-step-row" data-training-step-row>
      <input class="atlas-input" name="step_label" maxlength="300" placeholder="Describe one step" value="${escapeHtml(label)}" aria-label="Procedure step">
      <button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-training-step-remove aria-label="Remove step">${icon('trash-2')}</button>
    </div>`;
  }

  function uploadPanelMarkup(article) {
    const media = state.detail?.media || null;
    if (!article?.id) {
      return `<div class="atlas-alert atlas-alert--info">${icon('video')}<div class="atlas-alert__content"><p class="atlas-alert__title">Save the draft first</p><p class="atlas-alert__body">Save this draft, then reopen it to add or replace the video.</p></div></div>`;
    }
    const up = state.upload;
    let statusHtml = '';
    if (up.status === 'uploading') statusHtml = `<div class="tr-upload__progress"><div class="atlas-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${up.percent}"><i style="width:${up.percent}%"></i></div><p class="tr-note">Uploading ${up.percent}%</p></div>`;
    else if (up.status === 'processing') statusHtml = `<p class="tr-note" data-training-upload-state>Processing…</p>`;
    else if (up.status === 'ready') statusHtml = `<p class="tr-done" data-training-upload-state>${icon('circle-check')}Ready</p>`;
    else if (up.status === 'error') statusHtml = `<div class="atlas-alert atlas-alert--danger">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Upload failed</p><p class="atlas-alert__body">${escapeHtml(up.error || 'The video couldn’t be uploaded.')}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-training-retry-upload>Retry</button></div></div>`;
    else if (media && media.upload_status === 'stored') statusHtml = `<p class="tr-done">${icon('circle-check')}Video attached${media.original_filename ? ` · ${escapeHtml(media.original_filename)}` : ''}</p>`;
    const busy = up.status === 'uploading' || up.status === 'processing';
    return `<input type="file" accept="${VIDEO_ACCEPT}" hidden data-training-file>
      <button type="button" class="atlas-btn atlas-btn--secondary" data-training-upload ${busy ? 'disabled' : ''}>${icon('upload')}${media || up.status === 'ready' ? 'Replace video' : 'Select video'}</button>
      ${statusHtml}`;
  }

  function paintUploadPanel(root) {
    const panel = root.querySelector('[data-training-upload-panel]');
    if (!panel) return;
    panel.innerHTML = uploadPanelMarkup(state.detail?.article || {});
    paintIcons();
  }

  function openEditor(options = {}) {
    if (!canManage()) return;
    const detail = options.fresh ? null : state.detail;
    const article = detail?.article || {};
    const version = detail?.version || {};
    const trainingMeta = detail?.training || {};
    const chapters = (Array.isArray(detail?.chapters) ? detail.chapters : []).slice().sort((a, b) => Number(a.start_seconds || 0) - Number(b.start_seconds || 0));
    const steps = Array.isArray(detail?.steps) ? detail.steps : [];
    const selectedRoles = Array.isArray(article.target_roles) && article.target_roles.length ? article.target_roles : ['all'];
    const categoryList = categories();

    const root = openLayer({
      id: 'tr-editor',
      panel: `<section class="atlas-sheet atlas-sheet--wide tr-editor" data-modal-panel aria-labelledby="tr-editor-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="tr-editor-title">${article.id ? 'Edit training draft' : 'New training'}</h2><p class="atlas-sheet__desc">Saved as a private draft. The team sees it only after you publish.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="tr-editor-form" data-training-editor-form novalidate>
          <input type="hidden" name="article_id" value="${escapeHtml(article.id || '')}">
          <fieldset class="tr-fieldset"><legend class="tr-fieldset__title">Basics</legend>
            <div class="atlas-field"><label for="tr-title">Title</label><input class="atlas-input" id="tr-title" name="title" maxlength="220" required value="${escapeHtml(version.title || '')}" placeholder="Pouring the perfect pint"><p class="error" hidden data-error-for="title">Add a title.</p></div>
            <div class="atlas-field"><label for="tr-summary">Summary <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="tr-summary" name="summary" rows="2" maxlength="3000" placeholder="What the learner will be able to do">${escapeHtml(version.summary || '')}</textarea></div>
            <div class="atlas-grid-2">
              <div class="atlas-field"><label for="tr-category">Category</label><select class="atlas-select" id="tr-category" name="category_id" ${categoryList.length ? 'required' : ''}>${categoryList.length ? categoryList.map((category) => `<option value="${escapeHtml(category.id)}" ${category.id === article.category_id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('') : '<option value="">No categories available</option>'}</select><p class="error" hidden data-error-for="category_id">Choose a category.</p></div>
              <div class="atlas-field"><label for="tr-difficulty">Difficulty</label><select class="atlas-select" id="tr-difficulty" name="difficulty">${Object.entries(DIFFICULTY).map(([value, label]) => `<option value="${value}" ${value === (trainingMeta.difficulty || 'easy') ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            </div>
            <div class="atlas-field"><label for="tr-minutes">Estimated minutes <span class="optional">Optional</span></label><input class="atlas-input tr-minutes" id="tr-minutes" name="estimated_minutes" type="number" min="0" max="600" inputmode="numeric" value="${trainingMeta.estimated_minutes != null ? escapeHtml(String(trainingMeta.estimated_minutes)) : ''}"></div>
            <fieldset class="atlas-form-group tr-roles"><legend class="atlas-form-group__title">Who it’s for</legend>${ROLE_KEYS.map((key) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="target_roles" value="${key}" data-training-role="${key}" ${selectedRoles.includes(key) ? 'checked' : ''}>${key === 'all' ? 'Everyone on the team' : escapeHtml(ROLE_LABELS[key] || humanize(key))}</label>`).join('')}<p class="error" hidden data-error-for="target_roles">Choose who it’s for.</p></fieldset>
            <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="tr-required-label">Required training</p><p class="atlas-toggle-row__help">Everyone it’s for must complete each published version.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${article.required ? 'true' : 'false'}" aria-labelledby="tr-required-label" data-training-required></button></div>
            <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="tr-video-required-label">Video required to complete</p><p class="atlas-toggle-row__help">The learner must watch the video before they can confirm.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${trainingMeta.requires_video ? 'true' : 'false'}" aria-labelledby="tr-video-required-label" data-training-video-required></button></div>
          </fieldset>
          <fieldset class="tr-fieldset"><legend class="tr-fieldset__title">Video</legend><div data-training-upload-panel>${uploadPanelMarkup(article)}</div></fieldset>
          <fieldset class="tr-fieldset"><legend class="tr-fieldset__title">Chapters</legend><div class="tr-chapter-rows" data-training-chapter-rows>${chapters.length ? chapters.map(chapterRowMarkup).join('') : chapterRowMarkup()}</div><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-training-chapter-add>${icon('plus')}Add chapter</button><p class="error" hidden data-error-for="chapters">Chapter times must count up and start at or after 0:00.</p></fieldset>
          <fieldset class="tr-fieldset"><legend class="tr-fieldset__title">Written procedure (SOP)</legend><div class="atlas-field"><label class="sr-only" for="tr-content">Written procedure</label><textarea class="atlas-input atlas-textarea tr-editor__content" id="tr-content" name="content" rows="12" maxlength="250000" required placeholder="# Heading&#10;&#10;- A point&#10;1. A numbered step">${escapeHtml(version.content || '')}</textarea><p class="help"># for headings, - for lists, 1. for numbered steps, **bold**.</p><p class="error" hidden data-error-for="content">Write the procedure before saving.</p></div></fieldset>
          <fieldset class="tr-fieldset"><legend class="tr-fieldset__title">Procedure steps</legend><div class="tr-step-rows" data-training-step-rows>${steps.length ? steps.map((step) => stepRowMarkup(step.label || '')).join('') : stepRowMarkup()}</div><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-training-step-add>${icon('plus')}Add step</button></fieldset>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="tr-editor-form" class="atlas-btn atlas-btn--secondary" data-training-save-draft>Save draft</button>${article.id ? `<button type="button" class="atlas-btn atlas-btn--primary" data-training-publish-editor>${icon('send')}Publish</button>` : ''}</footer>
      </section>`
    });

    // Toggles.
    root.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-training-required], [data-training-video-required]');
      if (toggle) { toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true')); return; }
      if (event.target.closest('[data-training-chapter-add]')) {
        root.querySelector('[data-training-chapter-rows]')?.insertAdjacentHTML('beforeend', chapterRowMarkup());
        paintIcons();
        return;
      }
      if (event.target.closest('[data-training-chapter-remove]')) { event.target.closest('[data-training-chapter-row]')?.remove(); return; }
      if (event.target.closest('[data-training-step-add]')) {
        root.querySelector('[data-training-step-rows]')?.insertAdjacentHTML('beforeend', stepRowMarkup());
        paintIcons();
        return;
      }
      if (event.target.closest('[data-training-step-remove]')) { event.target.closest('[data-training-step-row]')?.remove(); return; }
      if (event.target.closest('[data-training-upload]')) { root.querySelector('[data-training-file]')?.click(); return; }
      if (event.target.closest('[data-training-retry-upload]')) { state.upload = { status: 'idle', percent: 0, mediaId: null, error: null, filename: '' }; paintUploadPanel(root); root.querySelector('[data-training-file]')?.click(); return; }
      if (event.target.closest('[data-training-publish-editor]')) { publishFromEditor(root); return; }
    });

    // Exclusive "Everyone" role logic (mirrors Knowledge).
    root.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches?.('[data-training-file]')) { handleVideoFile(root, target.files?.[0] || null); return; }
      if (!target.matches?.('input[name="target_roles"]')) return;
      const form = target.form;
      if (target.value === 'all' && target.checked) form.querySelectorAll('input[name="target_roles"]:not([value="all"])').forEach((input) => { input.checked = false; });
      else if (target.checked) { const all = form.querySelector('input[name="target_roles"][value="all"]'); if (all) all.checked = false; }
    });

    root.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      saveDraftFromEditor(root, { closeAfter: true });
    });
  }

  function collectChapters(root) {
    const rows = [...root.querySelectorAll('[data-training-chapter-row]')];
    const chapters = [];
    let previous = -1;
    let valid = true;
    const duration = Number(state.detail?.media?.duration_seconds || 0);
    rows.forEach((row) => {
      const time = row.querySelector('[name="chapter_time"]').value;
      const title = row.querySelector('[name="chapter_title"]').value.trim();
      if (!time.trim() && !title) return;
      const seconds = parseClock(time);
      if (seconds === null || Number.isNaN(seconds) || seconds < 0) { valid = false; return; }
      if (seconds <= previous) valid = false;
      if (duration && seconds > duration) valid = false;
      previous = seconds;
      chapters.push({ start_seconds: seconds, title: title || `Chapter at ${formatClock(seconds)}` });
    });
    return { chapters, valid };
  }

  function collectEditor(root) {
    const form = root.querySelector('form');
    const data = new FormData(form);
    const roles = data.getAll('target_roles').map(String);
    const categoryList = categories();
    const errors = {
      title: !String(data.get('title') || '').trim(),
      content: !String(data.get('content') || '').trim(),
      target_roles: !roles.length,
      category_id: categoryList.length ? !String(data.get('category_id') || '').trim() : false
    };
    const { chapters, valid } = collectChapters(root);
    errors.chapters = !valid;
    Object.entries(errors).forEach(([key, bad]) => { const el = root.querySelector(`[data-error-for="${key}"]`); if (el) el.hidden = !bad; });
    if (Object.values(errors).some(Boolean)) {
      const first = ['title', 'content', 'target_roles', 'category_id'].find((key) => errors[key]);
      if (first === 'target_roles') form.querySelector('input[name="target_roles"]')?.focus();
      else if (first) form[first]?.focus?.();
      return null;
    }
    const steps = [...root.querySelectorAll('[data-training-step-row] [name="step_label"]')].map((input) => input.value.trim()).filter(Boolean);
    const minutes = String(data.get('estimated_minutes') || '').trim();
    return {
      article_id: data.get('article_id') || null,
      category_id: data.get('category_id') || null,
      title: data.get('title'),
      summary: data.get('summary'),
      content: data.get('content'),
      required: root.querySelector('[data-training-required]').getAttribute('aria-checked') === 'true',
      target_roles: roles.includes('all') ? ['all'] : roles,
      estimated_minutes: minutes ? Number(minutes) : null,
      difficulty: data.get('difficulty') || null,
      requires_video: root.querySelector('[data-training-video-required]').getAttribute('aria-checked') === 'true',
      chapters,
      steps
    };
  }

  async function saveDraftFromEditor(root, { closeAfter = false } = {}) {
    const body = collectEditor(root);
    if (!body) return null;
    const payload = await mutate('save-draft', body, 'Draft saved. The team hasn’t seen it change.');
    if (!payload) return null;
    const savedId = payload.article_id || body.article_id;
    if (savedId) {
      await loadLesson(savedId, { force: true });
      if (state.lessonId !== savedId) routeToLesson(savedId);
    }
    if (closeAfter) closeLayer(root);
    return payload;
  }

  async function publishFromEditor(root) {
    const saved = await saveDraftFromEditor(root, { closeAfter: false });
    if (!saved) return;
    const articleId = saved.article_id || state.detail?.article?.id;
    if (!articleId) return;
    const answer = await confirmDialog({
      title: 'Publish this training?',
      body: 'Everyone it’s for sees it straight away. If it’s required, they’re asked to complete it again. Earlier completions are kept.',
      confirmLabel: 'Publish',
      field: { label: 'What changed', value: '' }
    });
    if (!answer) return;
    const ok = await mutate('publish', { article_id: articleId, change_note: answer.value || null }, 'Training published to the team');
    if (ok) { closeLayer(root); await loadLesson(articleId, { force: true }); }
  }

  // ---------- video upload (managers) ----------

  function readVideoMeta(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      const done = (meta) => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } resolve(meta); };
      probe.addEventListener('loadedmetadata', () => done({
        duration_seconds: Number.isFinite(probe.duration) ? Math.round(probe.duration) : null,
        width: probe.videoWidth || null,
        height: probe.videoHeight || null
      }), { once: true });
      probe.addEventListener('error', () => done({ duration_seconds: null, width: null, height: null }), { once: true });
      probe.src = url;
    });
  }

  function putWithProgress(url, token, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new TrainingError('The video upload was rejected.', xhr.status));
      });
      xhr.addEventListener('error', () => reject(new TrainingError('The video couldn’t be uploaded.', 0)));
      xhr.addEventListener('abort', () => reject(new TrainingError('The video upload was cancelled.', 0)));
      xhr.send(file);
    });
  }

  async function handleVideoFile(root, file) {
    const article = state.detail?.article;
    if (!file || !article?.id) return;
    state.upload = { status: 'uploading', percent: 0, mediaId: null, error: null, filename: file.name };
    paintUploadPanel(root);
    try {
      const clientRequestId = (window.crypto?.randomUUID?.() || `tr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const reserved = await api('reserve-media', { method: 'POST', body: { client_request_id: clientRequestId, mime_type: file.type, declared_bytes: file.size, original_filename: file.name } });
      const mediaId = reserved?.media?.id;
      const upload = reserved?.upload || {};
      const uploadUrl = safeHttpUrl(upload.url);
      if (!mediaId || !uploadUrl || !upload.token) throw new TrainingError('Training couldn’t start the upload.', 0);
      state.upload.mediaId = mediaId;
      await putWithProgress(uploadUrl, upload.token, file, (percent) => {
        state.upload.percent = percent;
        const bar = root.querySelector('.tr-upload__progress .atlas-progress i');
        const label = root.querySelector('.tr-upload__progress .tr-note');
        if (bar) bar.style.width = `${percent}%`;
        if (label) label.textContent = `Uploading ${percent}%`;
      });
      state.upload.status = 'processing';
      state.upload.percent = 100;
      paintUploadPanel(root);
      const meta = await readVideoMeta(file);
      await api('finalize-media', { method: 'POST', body: { media_id: mediaId, path: upload.path, duration_seconds: meta.duration_seconds, width: meta.width, height: meta.height } });
      await api('attach-media', { method: 'POST', body: { article_id: article.id, media_id: mediaId } });
      // Only "Ready" after finalize (and attach) succeed.
      state.upload.status = 'ready';
      await loadLesson(article.id, { force: true, keepEditor: true });
      paintUploadPanel(root);
      window.AtlasShell?.toast?.('Video attached');
    } catch (error) {
      state.upload.status = 'error';
      state.upload.error = shown(error, 'The video couldn’t be uploaded.');
      paintUploadPanel(root);
    } finally {
      const input = root.querySelector('[data-training-file]');
      if (input) input.value = '';
    }
  }

  // ---------- completion report (managers) ----------

  async function openReport(articleId) {
    if (!canManage() || !articleId) return;
    const lesson = lessons().find((entry) => entry.article_id === articleId);
    const root = openLayer({
      id: 'tr-report',
      panel: `<section class="atlas-sheet tr-report" data-modal-panel aria-labelledby="tr-report-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="tr-report-title">Completion</h2><p class="atlas-sheet__desc">${escapeHtml(lesson?.title || 'Training')}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <div class="atlas-sheet__body" data-training-report-body><div class="tr-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(4)}<span class="sr-only">Loading completion</span></div></div>
      </section>`
    });
    try {
      const report = await api('report', { params: { article_id: articleId } });
      const body = root.querySelector('[data-training-report-body]');
      if (!body) return;
      const staff = Array.isArray(report.staff) ? report.staff : [];
      body.innerHTML = `<div class="tr-report__stats">
          <div class="tr-stat"><span class="tr-stat__num">${Number(report.assigned || 0)}</span><span class="tr-stat__label">Assigned</span></div>
          <div class="tr-stat"><span class="tr-stat__num">${Number(report.completed || 0)}</span><span class="tr-stat__label">Completed</span></div>
          <div class="tr-stat"><span class="tr-stat__num">${Number(report.outstanding || 0)}</span><span class="tr-stat__label">Outstanding</span></div>
        </div>
        ${staff.length ? `<ul class="atlas-list tr-list">${staff.map((person) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon${person.completed ? ' atlas-row__icon--positive' : ''}">${icon(person.completed ? 'circle-check' : 'circle')}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(person.user_label || 'Team member')}</p><p class="atlas-row__meta">${escapeHtml([humanize(person.role || ''), person.completed ? `Completed${person.completed_at ? ` ${formatDate(person.completed_at)}` : ''}` : 'Not yet'].filter(Boolean).join(' · '))}</p></div></li>`).join('')}</ul>` : '<p class="tr-note">No one is assigned to this training yet.</p>'}`;
      paintIcons();
    } catch (error) {
      const body = root.querySelector('[data-training-report-body]');
      if (body) body.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Completion couldn’t be loaded.</p><p class="atlas-alert__body">${escapeHtml(shown(error, 'Check the connection and try again.'))}</p></div></div>`;
      paintIcons();
    }
  }

  // ---------- load & save ----------

  function loadSnapshot(options = {}) {
    // Memoised: concurrent callers (e.g. render's snapshot + a lesson deep-link that
    // needs permissions) await the same in-flight load, so canManage() is settled
    // before loadLesson chooses draft vs published.
    if (state.snapshotPromise) return state.snapshotPromise;
    state.loading = true;
    if (!options.silent) state.error = null;
    paint();
    state.snapshotPromise = (async () => {
      try {
        const payload = await api('snapshot');
        if (!payload || !Array.isArray(payload.lessons)) throw new TrainingError('Training is temporarily unavailable.', 0);
        state.snapshot = payload;
        state.permissions = payload.permissions || null;
        state.actorRole = payload.actor_role || state.actorRole;
        state.error = null;
        state.failedAt = 0;
      } catch (error) {
        if (!options.silent || !state.snapshot) state.error = shown(error, 'Training couldn’t be loaded. Check the connection and try again.');
        state.failedAt = Date.now();
      } finally {
        state.loading = false;
        state.snapshotPromise = null;
        paint();
      }
    })();
    return state.snapshotPromise;
  }

  async function loadLesson(lessonId, options = {}) {
    const serial = lessonId;
    state.detailLoading = true;
    state.detailError = null;
    state.detailMissing = false;
    if (!options.force && state.detail?.article?.id !== lessonId) { teardownVideo(); state.detail = null; }
    if (options.force && state.detail?.article?.id !== lessonId) teardownVideo();
    if (!options.keepEditor) paint();
    try {
      const payload = await api('lesson', { params: { article_id: lessonId, prefer_draft: canManage() ? 1 : 0 } });
      if (state.lessonId !== serial) return payload;
      state.detail = payload || null;
      state.permissions = state.permissions || (payload?.permissions || null);
      if (!options.keepEditor) paint();
      // Record the open and pick up the latest progress for a published version.
      if (state.detail?.version?.state === 'published' && !state.started) {
        state.started = true;
        api('start', { method: 'POST', body: { article_id: state.detail.article.id, version_id: state.detail.version.id } })
          .then((started) => {
            if (state.lessonId !== serial || !state.detail) return;
            if (started?.progress) state.detail.progress = started.progress;
            if (!options.keepEditor) paint();
          })
          .catch(() => { /* opening still works without the start mark */ });
      }
      return payload;
    } catch (error) {
      if (state.lessonId !== serial) return null;
      state.detail = null;
      state.detailMissing = error?.status === 404 || error?.status === 403;
      state.detailError = shown(error, 'Nothing was changed. Check the connection and try again.');
      return null;
    } finally {
      if (state.lessonId === serial) {
        state.detailLoading = false;
        if (!options.keepEditor) paint();
      }
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.submitting) return null;
    state.submitting = true;
    try {
      const payload = await api(action, { method: 'POST', body });
      if (successMessage) window.AtlasShell?.toast?.(successMessage);
      loadSnapshot({ silent: true });
      return payload || {};
    } catch (error) {
      window.AtlasShell?.toast?.(shown(error, 'The change couldn’t be saved. Nothing was changed; try again.'));
      return null;
    } finally {
      state.submitting = false;
    }
  }

  // ---------- render ----------

  function paint() {
    if (!state.visible) return;
    const view = host();
    if (!view) return;
    if (view.classList.contains('placeholder-view')) view.classList.remove('placeholder-view');
    view.classList.add('tr-host');
    if (state.lessonId) {
      view.innerHTML = `<div class="tr tr--lesson">${lessonMarkup()}</div>`;
      window.AtlasChrome?.setTopBar?.({ title: state.detail?.version?.title || state.detail?.article?.title || 'Training', back: () => routeToHome() });
      window.AtlasChrome?.setTabBarHidden?.('training', phoneQuery.matches);
      hydrateVideo();
    } else {
      view.innerHTML = `<div class="tr">${headerMarkup()}${alertMarkup()}<div class="tr-body">${homeMarkup()}</div></div>`;
      window.AtlasChrome?.setTopBar?.(canManage() && phoneQuery.matches ? { actions: [{ icon: 'plus', label: 'New training', run: () => openEditor({ fresh: true }) }] } : {});
      window.AtlasChrome?.setTabBarHidden?.('training', false);
    }
    paintIcons();
  }

  function render(params = {}) {
    state.visible = true;
    const lesson = params.lesson ? String(params.lesson) : null;
    const changed = lesson !== state.lessonId;
    if (changed) { state.started = false; teardownVideo(); }
    state.lessonId = lesson;
    const ensure = (!state.snapshot && (!state.failedAt || Date.now() - state.failedAt > 20000))
      ? loadSnapshot() : Promise.resolve();
    if (lesson && (changed || !state.detail)) {
      // Wait for permissions before loadLesson picks draft (manager) vs published.
      ensure.then(() => { if (state.lessonId === lesson) loadLesson(lesson); });
    } else {
      paint();
    }
    if (!lesson) window.scrollTo?.(0, 0);
  }

  function onHide() {
    state.visible = false;
    sendProgress(true);
    teardownVideo();
    window.AtlasChrome?.setTabBarHidden?.('training', false);
  }

  // ---------- navigation ----------

  function routeToHome() {
    window.AtlasShell?.show?.('training', {}, { source: 'route', route: '#knowledge/training' });
  }

  function routeToLesson(lessonId) {
    const id = String(lessonId || '').trim();
    if (!id) { routeToHome(); return; }
    window.AtlasShell?.show?.('training', { lesson: id }, { source: 'route', route: `#knowledge/training/${encodeURIComponent(id)}` });
  }

  // ---------- events ----------

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    if (target.closest('[data-training-refresh]')) { state.failedAt = 0; loadSnapshot(); return; }
    if (target.closest('[data-training-retry]')) { if (state.lessonId) loadLesson(state.lessonId, { force: true }); return; }
    if (target.closest('[data-training-new]')) { openEditor({ fresh: true }); return; }

    const card = target.closest('[data-training-card]');
    if (card && card.tagName === 'A') {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
      event.preventDefault();
      routeToLesson(card.dataset.trainingCard);
      return;
    }

    const report = target.closest('[data-training-report]');
    if (report) { openReport(report.dataset.trainingReport); return; }

    const chapter = target.closest('[data-training-chapter]');
    if (chapter) { seekVideo(Number(chapter.dataset.trainingChapter)); return; }

    if (target.closest('[data-training-edit]')) { openEditor(); return; }

    if (target.closest('[data-training-publish]')) {
      const detail = state.detail;
      if (!detail?.article?.id) return;
      const answer = await confirmDialog({
        title: 'Publish this training?',
        body: 'Everyone it’s for sees it straight away. If it’s required, they’re asked to complete it again. Earlier completions are kept.',
        confirmLabel: 'Publish',
        field: { label: 'What changed', value: '' }
      });
      if (!answer) return;
      const ok = await mutate('publish', { article_id: detail.article.id, change_note: answer.value || null }, 'Training published to the team');
      if (ok) await loadLesson(detail.article.id, { force: true });
      return;
    }

    if (target.closest('[data-training-retire]')) {
      const detail = state.detail;
      if (!detail?.article?.id) return;
      const answer = await confirmDialog({ title: 'Retire this training?', body: 'It disappears from Training for everyone. Its versions and completions are kept.', confirmLabel: 'Retire training', danger: true, field: { label: 'Reason', required: true } });
      if (!answer) return;
      const ok = await mutate('retire', { article_id: detail.article.id, reason: answer.value }, 'Training retired');
      if (ok) routeToHome();
      return;
    }

    if (target.closest('[data-training-complete]')) {
      const detail = state.detail;
      if (!detail?.article?.id || !detail?.version?.id || state.completing) return;
      state.completing = true;
      paint();
      try {
        const result = await api('complete', { method: 'POST', body: { article_id: detail.article.id, version_id: detail.version.id } });
        if (state.detail) {
          state.detail.progress = { ...(state.detail.progress || {}), completion_state: result?.completion_state || 'completed', completed_at: result?.completed_at || new Date().toISOString() };
        }
        window.AtlasShell?.toast?.(result?.replayed ? 'Completed again' : 'Training completed');
        loadSnapshot({ silent: true });
      } catch (error) {
        window.AtlasShell?.toast?.(shown(error, 'That couldn’t be saved. Nothing was changed; try again.'));
      } finally {
        state.completing = false;
        paint();
      }
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !host()?.contains(target)) return;
    if (target.matches('[data-training-step]')) {
      loadStepChecks().set(target.dataset.trainingStep, target.checked);
      saveStepChecks();
    }
  }

  function flushProgress() {
    if (state.visible && state.lessonId) sendProgress(true);
  }

  // ---------- registration ----------

  function openLessonFromLink(lessonId) {
    const id = String(lessonId || '').trim();
    if (id) routeToLesson(id);
  }

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell?.registerView) return;
    shell.registerView('training', { root: () => host(), title: 'Training', render, onHide });
    shell.links?.register?.('training_lesson', openLessonFromLink);
    shell.actions?.register?.({
      id: 'training.open', label: 'Open Training', icon: 'graduation-cap', keywords: ['training', 'learn', 'lesson', 'video', 'onboarding'], contexts: ['knowledge', 'home'],
      run: () => routeToHome()
    });
    shell.actions?.register?.({
      id: 'training.new', label: 'New training', icon: 'graduation-cap', keywords: ['training', 'lesson', 'video', 'create'], roles: ['admin', 'manager'], contexts: ['knowledge', 'training'],
      run: () => { routeToHome(); window.setTimeout(() => openEditor({ fresh: true }), 300); }
    });
    if (shell.current?.() === 'training') render(shell.params?.() || {});
  }

  function init() {
    if (state.initialized || !host()) return;
    state.initialized = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    window.addEventListener('online', () => { if (state.visible) loadSnapshot({ silent: true }); });
    window.addEventListener('pagehide', flushProgress);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushProgress(); });
    phoneQuery.addEventListener?.('change', () => { if (state.visible) paint(); });
    registerWithShell();
  }

  window.AtlasTraining = {
    open: () => routeToHome(),
    openLesson: (lessonId) => openLessonFromLink(lessonId),
    refresh: () => loadSnapshot(),
    snapshot: () => state.snapshot,
    detail: () => state.detail,
    safeHttpUrl
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
