// Atlas Training (S98) fixtures — a stateful mock of the atlas-training Edge
// Function and its private-video Storage, shaped like the ?action= HTTP contract
// the training-workspace.js frontend calls. Modelled on inventory-fixtures.mjs
// (locationBackend): trainingBackend({lessons}) returns { handler, calls } plus
// live state accessors so a test can seed lessons directly and assert both what
// the UI sent and what the backend now holds (versions, media, progress).
//
// A published lesson keeps immutable versions: publishing a draft supersedes the
// prior current version without mutating it, and each user's completion is kept
// per version. The signed URLs the mock hands back are on the Supabase host the
// harness intercepts, so the browser's real upload (XHR PUT) and playback
// (fetch -> Blob -> object URL) paths run end to end against trainingStorage().
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { emptyFunctions } from './fixtures.mjs';
import { ROOT, SUPABASE, USERS, fixtureTime } from './harness.mjs';

const DAY = 86400000;
export const iso = (offsetDays = 0) => fixtureTime(offsetDays * DAY);

// A real, short WebM the harness can decode in headless Chromium (the sign-in
// intro clip): served as the private-video body so the lesson player's
// Blob/object-URL playback and chapter seeking run for real, and used as the
// upload payload so the manager's readVideoMeta() probe resolves.
export const VIDEO_WEBM = readFileSync(path.join(ROOT, 'apps/web/assets/brand/motion/atlas-signin-intro.webm'));

// Categories carried on the snapshot so the authoring sheet's category <select>
// is populated (the frontend reads snapshot.categories, else Knowledge's list).
export const CATEGORIES = [
  { id: 'cat-bar', name: 'Bar service' },
  { id: 'cat-open', name: 'Opening & closing' }
];

// Report roster: who training is assigned to (independent of the auth session).
// Two bartenders so a bartender-targeted lesson has assigned=2.
export const ROSTER = [
  { id: USERS.admin.id, label: USERS.admin.display_name, role: 'admin' },
  { id: USERS.bartender.id, label: USERS.bartender.display_name, role: 'bartender' },
  { id: '7d3c1f10-0000-4000-8000-000000000003', label: 'Jón Bartender', role: 'bartender' }
];

function canManage(user) {
  return ['admin', 'manager'].includes(user?.role);
}

function normalizeRoles(roles) {
  const list = Array.isArray(roles) ? roles.map(String) : [];
  if (!list.length) return ['all'];
  return list.includes('all') ? ['all'] : list;
}

/**
 * A stateful atlas-training mock over the ?action= contract.
 *
 * Seed each lesson as:
 *   { id, title, summary, content, category_id, status:'published'|'draft'|'retired',
 *     required, target_roles, estimated_minutes, difficulty, requires_video,
 *     chapters:[{start_seconds,title}], steps:[label|{label}],
 *     video:{upload_status,duration_seconds,width,height,original_filename,mime_type,byte_size},
 *     completedBy:[userId],           // completions of the current published version
 *     draft:{...overrides}            // also seed a v2 draft on top of the published v1
 *   }
 */
export function trainingBackend({ lessons = [], roster = ROSTER, categories = CATEGORIES } = {}) {
  const articles = new Map();
  const versions = new Map();
  const media = new Map();
  const progress = new Map(); // key `${userId}:${versionId}`
  const calls = [];
  let seq = 0;
  const uid = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;

  function createMedia(overrides = {}) {
    const id = uid();
    const m = {
      id,
      upload_status: overrides.upload_status || 'pending',
      mime_type: overrides.mime_type || 'video/webm',
      byte_size: overrides.byte_size ?? VIDEO_WEBM.length,
      duration_seconds: overrides.duration_seconds ?? null,
      width: overrides.width ?? 1080,
      height: overrides.height ?? 1920,
      original_filename: overrides.original_filename || 'lesson.webm',
      // internal only; NEVER returned to the client
      path: overrides.path || `lessons/${uid()}/${uid()}.mp4`,
      article_id: null,
      version_id: null,
      client_request_id: null
    };
    media.set(id, m);
    return m;
  }

  function buildVersion(article, spec, number, stateName) {
    const v = {
      id: uid(),
      article_id: article.id,
      version_number: number,
      state: stateName,
      title: spec.title || 'Untitled lesson',
      summary: spec.summary || '',
      content: spec.content || '',
      content_format: 'markdown',
      published_at: stateName === 'published' ? (spec.published_at || iso(-2)) : null,
      estimated_minutes: spec.estimated_minutes ?? 5,
      difficulty: spec.difficulty || 'easy',
      requires_video: !!spec.requires_video,
      completion_rule: spec.completion_rule || 'explicit',
      media_asset_id: null,
      chapters: (spec.chapters || []).map((c, i) => ({ id: uid(), start_seconds: Number(c.start_seconds) || 0, title: c.title || `Chapter ${i + 1}`, sort_order: i })),
      steps: (spec.steps || []).map((s, i) => ({ id: uid(), label: typeof s === 'string' ? s : (s.label || `Step ${i + 1}`), sort_order: i }))
    };
    versions.set(v.id, v);
    if (spec.video) {
      const m = createMedia({ upload_status: 'stored', ...spec.video });
      m.article_id = article.id;
      m.version_id = v.id;
      v.media_asset_id = m.id;
    }
    return v;
  }

  // ---- seed ----
  for (const L of lessons) {
    const status = L.status || 'published';
    const article = {
      id: L.id,
      status,
      required: !!L.required,
      target_roles: normalizeRoles(L.target_roles),
      category_id: L.category_id || categories[0]?.id || null,
      current_version_id: null,
      draft_version_id: null
    };
    articles.set(article.id, article);
    if (status === 'draft') {
      const v = buildVersion(article, L, 1, 'draft');
      article.draft_version_id = v.id;
    } else {
      const v1 = buildVersion(article, L, 1, 'published');
      article.current_version_id = v1.id;
      (L.completedBy || []).forEach((userId) => {
        progress.set(`${userId}:${v1.id}`, { completion_state: 'completed', last_video_position_seconds: 0, completed_at: iso(-1), last_opened_at: iso(-1) });
      });
      if (L.draft) {
        const v2 = buildVersion(article, { ...L, ...L.draft }, 2, 'draft');
        article.draft_version_id = v2.id;
      }
    }
  }

  // ---- views ----
  function targeted(article, role) {
    const roles = Array.isArray(article.target_roles) ? article.target_roles : [];
    if (!roles.length || roles.includes('all')) return true;
    return !!role && roles.includes(role);
  }

  function hasVideo(version) {
    const m = version.media_asset_id ? media.get(version.media_asset_id) : null;
    return !!m && (m.upload_status === 'ready' || m.upload_status === 'stored');
  }

  function mediaView(version) {
    const m = version.media_asset_id ? media.get(version.media_asset_id) : null;
    if (!m) return null;
    // strip internal fields (path is never exposed)
    const { path: _p, article_id: _a, version_id: _v, client_request_id: _c, ...view } = m;
    return view;
  }

  function progressView(user, versionId) {
    const pr = progress.get(`${user.id}:${versionId}`);
    if (!pr) return null;
    return { completion_state: pr.completion_state, last_video_position_seconds: pr.last_video_position_seconds ?? 0, completed_at: pr.completed_at ?? null, last_opened_at: pr.last_opened_at ?? null };
  }

  function resolveVersion(article, { preferDraft } = {}) {
    if (preferDraft && article.draft_version_id) return versions.get(article.draft_version_id);
    if (article.current_version_id) return versions.get(article.current_version_id);
    if (article.draft_version_id) return versions.get(article.draft_version_id);
    return [...versions.values()].find((v) => v.article_id === article.id) || null;
  }

  function displayVersion(article) {
    const current = article.current_version_id ? versions.get(article.current_version_id) : null;
    if (current && current.state === 'published' && article.status !== 'retired') return current;
    const draft = article.draft_version_id ? versions.get(article.draft_version_id) : null;
    return draft || current || resolveVersion(article, {});
  }

  function lessonPayload(article, version, user) {
    return {
      article: {
        id: article.id, status: article.status, required: article.required, target_roles: article.target_roles,
        category_id: article.category_id, current_version_id: article.current_version_id, draft_version_id: article.draft_version_id
      },
      version: {
        id: version.id, version_number: version.version_number, state: version.state,
        title: version.title, summary: version.summary, content: version.content,
        content_format: version.content_format, published_at: version.published_at
      },
      training: { estimated_minutes: version.estimated_minutes, difficulty: version.difficulty, requires_video: version.requires_video, completion_rule: version.completion_rule },
      media: mediaView(version),
      chapters: version.chapters.map((c) => ({ id: c.id, start_seconds: c.start_seconds, title: c.title, sort_order: c.sort_order })),
      steps: version.steps.map((s) => ({ id: s.id, label: s.label, sort_order: s.sort_order })),
      progress: progressView(user, version.id)
    };
  }

  function snapshotRow(article, user) {
    const v = displayVersion(article);
    return {
      article_id: article.id, status: article.status, required: article.required, target_roles: article.target_roles,
      title: v.title, summary: v.summary,
      version_id: v.id, version_number: v.version_number, version_state: v.state,
      estimated_minutes: v.estimated_minutes, difficulty: v.difficulty,
      has_video: hasVideo(v), chapter_count: v.chapters.length, step_count: v.steps.length,
      progress: progressView(user, v.id)
    };
  }

  function snapshot(user) {
    const manage = canManage(user);
    let list = [...articles.values()];
    if (!manage) {
      // Staff see only published, non-retired lessons targeted to their role.
      list = list.filter((a) => {
        const cur = a.current_version_id ? versions.get(a.current_version_id) : null;
        return cur && cur.state === 'published' && a.status !== 'retired' && targeted(a, user.role);
      });
    }
    return {
      lessons: list.map((a) => snapshotRow(a, user)),
      permissions: { can_manage_training: manage },
      actor_role: user.role,
      categories
    };
  }

  function report(articleId, user) {
    void user;
    const article = articles.get(articleId);
    if (!article) return { __status: 404, body: { error: 'Training not found.' } };
    const currentVersionId = article.current_version_id;
    const staff = roster.filter((p) => targeted(article, p.role)).map((p) => {
      const pr = currentVersionId ? progress.get(`${p.id}:${currentVersionId}`) : null;
      const done = pr?.completion_state === 'completed';
      return { user_label: p.label, role: p.role, completed: done, completed_at: done ? pr.completed_at : null };
    });
    const completed = staff.filter((s) => s.completed).length;
    return { article_id: article.id, current_version_id: currentVersionId, assigned: staff.length, completed, outstanding: staff.length - completed, staff };
  }

  // ---- handler ----
  function handler(ctx) {
    const { method, action, body, user } = ctx;
    const params = new URLSearchParams(ctx.search || '');
    calls.push({ method, action, body, search: ctx.search });
    const manage = canManage(user);

    if (method === 'GET' && action === 'snapshot') return snapshot(user);

    if (method === 'GET' && action === 'lesson') {
      const article = articles.get(params.get('article_id'));
      if (!article) return { __status: 404, body: { error: 'This lesson isn’t available.' } };
      if (!manage) {
        const cur = article.current_version_id ? versions.get(article.current_version_id) : null;
        if (!cur || cur.state !== 'published' || article.status === 'retired' || !targeted(article, user.role)) return { __status: 404, body: { error: 'This lesson isn’t available.' } };
      }
      const preferDraft = ['1', 'true'].includes(String(params.get('prefer_draft') || ''));
      const version = resolveVersion(article, { preferDraft: manage && preferDraft });
      if (!version) return { __status: 404, body: { error: 'This lesson isn’t available.' } };
      return lessonPayload(article, version, user);
    }

    if (method === 'GET' && action === 'report') return report(params.get('article_id'), user);

    if (method === 'POST' && action === 'reserve-media') {
      const existing = [...media.values()].find((m) => m.client_request_id && m.client_request_id === body.client_request_id);
      const m = existing || createMedia({ upload_status: 'pending', mime_type: body.mime_type, byte_size: body.declared_bytes, original_filename: body.original_filename });
      m.client_request_id = body.client_request_id;
      return { media: { id: m.id, upload_status: 'pending' }, upload: { url: `${SUPABASE}/storage/v1/object/upload/sign/atlas-training-videos/${m.path}?token=x`, token: 'x', path: m.path } };
    }

    if (method === 'POST' && action === 'finalize-media') {
      const m = media.get(body.media_id);
      if (!m) return { __status: 404, body: { error: 'Upload not found.' } };
      m.upload_status = 'stored';
      m.mime_type = 'video/mp4';
      if (body.path) m.path = body.path;
      if (body.duration_seconds != null) m.duration_seconds = body.duration_seconds;
      if (body.width != null) m.width = body.width;
      if (body.height != null) m.height = body.height;
      return { media: { id: m.id, upload_status: 'stored', mime_type: 'video/mp4', byte_size: m.byte_size, duration_seconds: m.duration_seconds } };
    }

    if (method === 'POST' && action === 'attach-media') {
      const article = articles.get(body.article_id);
      if (!article) return { __status: 404, body: { error: 'Lesson not found.' } };
      const draft = article.draft_version_id ? versions.get(article.draft_version_id) : null;
      const target = draft || (article.current_version_id ? versions.get(article.current_version_id) : null);
      if (!target) return { __status: 409, body: { error: 'Save the draft first.' } };
      const m = media.get(body.media_id);
      if (m) { m.article_id = article.id; m.version_id = target.id; }
      target.media_asset_id = body.media_id;
      return { article_id: article.id, version_id: target.id, media_asset_id: body.media_id };
    }

    if (method === 'POST' && action === 'save-draft') {
      let article = body.article_id ? articles.get(body.article_id) : null;
      if (!article) {
        const id = body.article_id || uid();
        article = { id, status: 'draft', required: !!body.required, target_roles: normalizeRoles(body.target_roles), category_id: body.category_id || null, current_version_id: null, draft_version_id: null };
        articles.set(id, article);
      } else {
        article.required = !!body.required;
        article.target_roles = normalizeRoles(body.target_roles);
        article.category_id = body.category_id || article.category_id;
      }
      // Reuse the open draft; only start a NEW draft (max+1) over a published one.
      let draft = article.draft_version_id ? versions.get(article.draft_version_id) : null;
      if (draft && draft.state !== 'draft') draft = null;
      if (!draft) {
        const maxNum = Math.max(0, ...[...versions.values()].filter((v) => v.article_id === article.id).map((v) => v.version_number));
        draft = { id: uid(), article_id: article.id, version_number: maxNum + 1, state: 'draft', content_format: 'markdown', published_at: null, media_asset_id: null, completion_rule: 'explicit', chapters: [], steps: [] };
        versions.set(draft.id, draft);
        article.draft_version_id = draft.id;
      }
      draft.title = body.title || '';
      draft.summary = body.summary || '';
      draft.content = body.content || '';
      draft.estimated_minutes = body.estimated_minutes ?? null;
      draft.difficulty = body.difficulty || 'easy';
      draft.requires_video = !!body.requires_video;
      draft.chapters = (body.chapters || []).map((c, i) => ({ id: uid(), start_seconds: Number(c.start_seconds) || 0, title: c.title || `Chapter ${i + 1}`, sort_order: i }));
      draft.steps = (body.steps || []).map((s, i) => ({ id: uid(), label: typeof s === 'string' ? s : (s.label || `Step ${i + 1}`), sort_order: i }));
      return { article_id: article.id, version_id: draft.id };
    }

    if (method === 'POST' && action === 'publish') {
      const article = articles.get(body.article_id);
      if (!article) return { __status: 404, body: { error: 'Lesson not found.' } };
      const draft = article.draft_version_id ? versions.get(article.draft_version_id) : null;
      if (!draft) return { __status: 409, body: { error: 'There is no draft to publish.' } };
      if (draft.requires_video && !draft.media_asset_id) return { __status: 409, body: { error: 'Add the video before publishing.' } };
      const prior = article.current_version_id ? versions.get(article.current_version_id) : null;
      if (prior && prior.id !== draft.id) prior.state = 'superseded';
      draft.state = 'published';
      draft.published_at = iso(0);
      article.current_version_id = draft.id;
      article.draft_version_id = null;
      article.status = 'published';
      return { article_id: article.id, version_id: draft.id };
    }

    if (method === 'POST' && action === 'retire') {
      const article = articles.get(body.article_id);
      if (!article) return { __status: 404, body: { error: 'Lesson not found.' } };
      article.status = 'retired';
      return { ok: true };
    }

    if (method === 'POST' && action === 'playback') {
      const article = articles.get(body.article_id);
      const version = body.version_id ? versions.get(body.version_id) : (article && article.current_version_id ? versions.get(article.current_version_id) : null);
      const m = version && version.media_asset_id ? media.get(version.media_asset_id) : null;
      return { url: `${SUPABASE}/storage/v1/object/sign/atlas-training-videos/${(m && m.path) || 'lessons/x/x.mp4'}?token=play`, expires_in: 300 };
    }

    if (method === 'POST' && action === 'start') {
      const article = articles.get(body.article_id);
      if (!article) return { __status: 404, body: { error: 'Lesson not found.' } };
      const version = body.version_id ? versions.get(body.version_id) : (article.current_version_id ? versions.get(article.current_version_id) : null);
      if (!version) return { __status: 404, body: { error: 'This lesson isn’t available.' } };
      const key = `${user.id}:${version.id}`;
      const existing = progress.get(key);
      if (existing) existing.last_opened_at = iso(0);
      else progress.set(key, { completion_state: 'in_progress', last_video_position_seconds: 0, completed_at: null, last_opened_at: iso(0) });
      return lessonPayload(article, version, user);
    }

    if (method === 'POST' && action === 'progress') {
      const version = body.version_id ? versions.get(body.version_id) : null;
      if (version) {
        const key = `${user.id}:${version.id}`;
        const pr = progress.get(key) || { completion_state: 'in_progress', completed_at: null, last_opened_at: iso(0) };
        pr.last_video_position_seconds = Number(body.position_seconds) || 0;
        progress.set(key, pr);
      }
      return { ok: true };
    }

    if (method === 'POST' && action === 'complete') {
      const article = articles.get(body.article_id);
      const version = body.version_id ? versions.get(body.version_id) : (article && article.current_version_id ? versions.get(article.current_version_id) : null);
      if (!version) return { __status: 404, body: { error: 'This lesson isn’t available.' } };
      const key = `${user.id}:${version.id}`;
      const existing = progress.get(key);
      const replayed = !!(existing && existing.completion_state === 'completed');
      const completed_at = replayed ? existing.completed_at : iso(0);
      progress.set(key, { ...(existing || { last_video_position_seconds: 0, last_opened_at: iso(0) }), completion_state: 'completed', completed_at });
      return { completion_state: 'completed', completed_at, replayed };
    }

    return { __status: 400, body: { error: `Unknown training action: ${action}` } };
  }

  return {
    handler,
    calls,
    // live state (for asserting version immutability, retained completions, etc.)
    articles,
    versions,
    media,
    progress,
    article: (id) => articles.get(id),
    version: (id) => versions.get(id),
    mediaFor: (versionId) => { const v = versions.get(versionId); return v && v.media_asset_id ? media.get(v.media_asset_id) : null; },
    report,
    snapshotFor: (user) => snapshot(user),
    callsFor: (action) => calls.filter((c) => c.action === action)
  };
}

/**
 * A mocked private-video Storage for /storage/v1/*: answers the signed upload
 * PUT with 200 and the signed playback GET with the WebM body, so both the
 * upload and the Blob/object-URL playback path run for real. Recorded uploads
 * are exposed on the returned function's `.uploads`.
 */
export function trainingStorage() {
  const uploads = [];
  const reads = [];
  const fn = (entry, request) => {
    const p = entry.path;
    if (entry.method === 'PUT' && p.includes('/object/upload/sign/')) {
      const bytes = request.postDataBuffer() || Buffer.alloc(0);
      uploads.push({ path: p, size: bytes.length, contentType: request.headers()['content-type'], token: new URLSearchParams(entry.search).get('token') });
      return { __raw: { status: 200, contentType: 'application/json', body: JSON.stringify({ Key: p.split('/object/upload/sign/')[1] || '' }) } };
    }
    if (entry.method === 'GET' && (p.includes('/object/sign/') || p.startsWith('/storage/v1/object/'))) {
      reads.push({ path: p });
      return { __raw: { status: 200, contentType: 'video/webm', body: VIDEO_WEBM } };
    }
    return {};
  };
  fn.uploads = uploads;
  fn.reads = reads;
  return fn;
}

/** Assembles fixtures for launchAtlas: a training backend + its Storage. */
export function trainingWorld({ lessons = [], roster = ROSTER, categories = CATEGORIES, functions = {}, tables = {}, rpc = {} } = {}) {
  const training = trainingBackend({ lessons, roster, categories });
  const storage = trainingStorage();
  return {
    training,
    storage,
    fixtures: {
      tables: { ...tables },
      rpc: { ...rpc },
      functions: { ...emptyFunctions(), 'atlas-training': training.handler, ...functions },
      storage
    }
  };
}
