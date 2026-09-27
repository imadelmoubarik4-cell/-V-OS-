// S94C test doubles for the marketing publisher (report 09 §4, report 07 §8.3).
//
// createProviderFakes({ now, script }) -> { fetchImpl, calls, published, world, unexpected, count }
//   A fetch router for Meta Graph (graph.facebook.com, rupload.facebook.com),
//   TikTok (open.tiktokapis.com, open-upload.tiktokapis.com), Google Business
//   Profile (mybusiness.googleapis.com) and our Storage (https://branch.test).
//   Any other URL is recorded in `unexpected` and throws. `published` records
//   the real-world side effects (posts that exist) so duplicates can be counted.
//   Every error body echoes the caller's bearer token, so tests prove the
//   worker sanitises provider text before it reaches an RPC or a response.
//   script: { '<op>': [step, ...] } consumed in order per op (then default ok):
//     { status, body, headers }  answer with this error (body gets the token echoed)
//     'lost'                     apply the side effect, then throw (lost response)
//     'drop'                     throw without applying anything
//     'timeout'                  throw a TimeoutError without applying anything
//     { apply(ctx) }             custom
//
// createFakePublishingDb({ now, random }) -> an in-memory implementation of the
//   S94C worker RPC contract (/tmp s94c-rpc-signatures v1): claim with lease,
//   fencing on the claim token, begin_submit gate, record_step write-once ids,
//   complete with the report 07 §2.3 transition table and backoff. The SQL
//   semantics themselves are proven by the DB agent's previews
//   (scripts/verify_s94c_publishing_preview.sql) and the concurrency script;
//   this fake mirrors them so the worker can be tested without Postgres.
//
// createFakeCredentials(db, { tokens, resources, failures }) -> { openPublishingCredential }

export const SUPABASE_URL = 'https://branch.test';
export const SERVICE_KEY = 'service-role-secret-key-for-tests-0001';
export const TOKENS = Object.freeze({
  instagram: 'EAABsecretInstagramPageToken0001112223334445',
  facebook: 'EAABsecretFacebookPageToken0001112223334445',
  tiktok: 'act.secretTikTokUserToken0001112223334445!4',
  'google-business-profile': 'ya29.secretGoogleAccessToken000111222333',
});
export const RESOURCES = Object.freeze({
  instagram: { kind: 'instagram_account', id: '17841400000000001', label: 'vabar.reykjavik' },
  facebook: { kind: 'facebook_page', id: '104000000000001', label: 'VÁ Bar' },
  tiktok: { kind: 'tiktok_account', id: 'open-id-vabar', label: '@vabar.rvk' },
  'google-business-profile': { kind: 'gbp_location', id: 'accounts/111/locations/222', label: 'VÁ Bar, Laugavegur 1' },
});

const SIGNED_URL_MARK = 'SIGNEDURLTOKEN';

function readBody(init) {
  const body = init?.body;
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  return String(body);
}

function formOf(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  return out;
}

function jsonOf(text) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function respond(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function tokenOf(headers) {
  const h = new Headers(headers ?? {});
  const auth = h.get('authorization') ?? '';
  return auth.replace(/^(Bearer|OAuth)\s+/i, '');
}

function errorBody(family, status, token, extra = {}) {
  if (family === 'meta') return { error: { message: `Error validating access token ${token}: session invalid`, type: 'OAuthException', code: 100, fbtrace_id: 'Atrace', ...extra } };
  if (family === 'tiktok') return { data: {}, error: { code: 'invalid_param', message: `Request failed for token ${token}`, log_id: 'log123', ...extra } };
  return { error: { code: status, message: `Request had invalid credentials ${token}`, status: 'INVALID_ARGUMENT', ...extra } };
}

// Ready-made steps.
export const steps = {
  metaError: (status, code, extra = {}) => ({ status, family: 'meta', body: { code, ...extra } }),
  metaAuthExpired: () => ({ status: 400, family: 'meta', body: { code: 190, error_subcode: 463, type: 'OAuthException' } }),
  metaRateLimited: (retryAfter) => ({ status: 429, family: 'meta', body: { code: 4, is_transient: true }, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} }),
  serverError: (family, status = 500) => ({ status, family, raw: 'upstream unavailable' }),
  tiktokError: (status, code) => ({ status, family: 'tiktok', body: { code } }),
  googleError: (status, grpc) => ({ status, family: 'google', body: { status: grpc } }),
};

export function createProviderFakes({ now, script = {} } = {}) {
  const calls = [];
  const unexpected = [];
  const published = { instagram: [], facebook: [], tiktok: [], 'google-business-profile': [] };
  const queues = Object.fromEntries(Object.entries(script).map(([op, list]) => [op, [...list]]));
  let seq = 1000;
  const nextId = (prefix) => `${prefix}${(seq += 1)}`;
  const world = {
    containers: new Map(), // IG container id -> {status, polls, finishAfter, caption, kind, children, mediaId}
    igMedia: [], // {id, caption, timestamp, permalink, container}
    igFinishAfter: 0, // status polls answered IN_PROGRESS before FINISHED
    fbPosts: [], // {id, message, created_time, permalink_url, kind, attached}
    fbUnpublishedPhotos: new Map(),
    fbReels: new Map(),
    tiktokPublishes: new Map(), // publish_id -> {size, received, status, polls, kind, privacy}
    tiktokInits: 0,
    tiktokPrivacyOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    tiktokMaxDuration: 600,
    tiktokCompleteAfter: 1,
    tiktokUploadHost: 'https://open-upload.tiktokapis.com',
    gbpPosts: [], // {name, summary, topicType, event, state, polls, createTime, searchUrl, media}
    gbpLiveAfter: 1,
    storageObjects: new Map(), // path -> size
    signedUrls: 0,
  };

  function take(op) {
    const queue = queues[op];
    if (queue && queue.length) return queue.shift();
    return null;
  }

  function setScript(op, list) {
    queues[op] = [...list];
  }

  // Runs `effect` (the side effect + success response) under the scripted step.
  async function run(op, family, token, effect) {
    const step = take(op);
    if (!step) return effect();
    if (step === 'lost') {
      await effect();
      throw new TypeError('fetch failed');
    }
    if (step === 'drop') throw new TypeError('fetch failed');
    if (step === 'timeout') {
      const error = new Error('The operation timed out.');
      error.name = 'TimeoutError';
      throw error;
    }
    if (typeof step.apply === 'function') return step.apply({ effect, token });
    if (step.raw !== undefined) return new Response(step.raw, { status: step.status, headers: step.headers ?? {} });
    const fam = step.family ?? family;
    return respond(step.status, errorBody(fam, step.status, token, step.body ?? {}), step.headers ?? {});
  }

  function nowIso() {
    return new Date(now()).toISOString();
  }

  function assertSigned(url) {
    if (!String(url ?? '').includes(SIGNED_URL_MARK)) throw new Error(`media URL is not a signed storage URL: ${url}`);
  }

  // ---- Storage ---------------------------------------------------------------
  async function storage(url, init, record) {
    const h = new Headers(init?.headers ?? {});
    if (h.get('authorization') !== `Bearer ${SERVICE_KEY}`) return respond(401, { message: 'unauthorized' });
    const signMatch = url.pathname.match(/^\/storage\/v1\/object\/sign\/atlas-marketing-media\/(.+)$/);
    if (signMatch && init?.method === 'POST') {
      record.op = 'storage.sign';
      const path = decodeURIComponent(signMatch[1]);
      return run('storage.sign', 'storage', '', () => {
        if (!world.storageObjects.has(path)) return respond(404, { message: 'Object not found' });
        world.signedUrls += 1;
        return respond(200, { signedURL: `/object/sign/atlas-marketing-media/${signMatch[1]}?token=${SIGNED_URL_MARK}-${world.signedUrls}` });
      });
    }
    const readMatch = url.pathname.match(/^\/storage\/v1\/object\/authenticated\/atlas-marketing-media\/(.+)$/);
    if (readMatch && (init?.method ?? 'GET') === 'GET') {
      record.op = 'storage.read';
      const path = decodeURIComponent(readMatch[1]);
      return run('storage.read', 'storage', '', () => {
        const size = world.storageObjects.get(path);
        if (size === undefined) return respond(404, { message: 'Object not found' });
        const range = /bytes=(\d+)-(\d+)/.exec(h.get('range') ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Math.min(Number(range[2]), size - 1) : size - 1;
        const bytes = new Uint8Array(end - start + 1);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = (start + i) % 251;
        record.range = [start, end];
        return new Response(bytes, { status: range ? 206 : 200, headers: { 'content-range': `bytes ${start}-${end}/${size}` } });
      });
    }
    return null;
  }

  // ---- Meta ------------------------------------------------------------------
  async function meta(url, init, record, token) {
    const method = init?.method ?? 'GET';
    if (url.hostname === 'rupload.facebook.com') {
      const videoId = url.pathname.split('/').pop();
      record.op = 'fb.rupload';
      return run('fb.rupload', 'meta', token, () => {
        const reel = world.fbReels.get(videoId);
        if (!reel) return respond(400, errorBody('meta', 400, token));
        assertSigned(new Headers(init.headers).get('file_url'));
        reel.uploaded = true;
        return respond(200, { success: true });
      });
    }
    const parts = url.pathname.split('/').filter(Boolean); // [v25.0, ...]
    const [, first, second] = parts;
    const form = formOf(readBody(init));
    const igUser = RESOURCES.instagram.id;
    const page = RESOURCES.facebook.id;

    if (first === igUser && second === 'media' && method === 'POST') {
      record.op = 'ig.media';
      record.form = form;
      return run('ig.media', 'meta', token, () => {
        if (form.image_url) assertSigned(form.image_url);
        if (form.video_url) assertSigned(form.video_url);
        const id = nextId('9000000');
        world.containers.set(id, {
          status: 'IN_PROGRESS', polls: 0, finishAfter: world.igFinishAfter,
          caption: form.caption ?? null, kind: form.media_type ?? (form.image_url ? 'IMAGE' : 'VIDEO'),
          children: form.children ? form.children.split(',') : [], carouselItem: form.is_carousel_item === 'true',
        });
        return respond(200, { id });
      });
    }
    if (first === igUser && second === 'media_publish' && method === 'POST') {
      record.op = 'ig.publish';
      record.form = form;
      return run('ig.publish', 'meta', token, () => {
        const container = world.containers.get(form.creation_id);
        if (!container) return respond(400, errorBody('meta', 400, token, { code: 100 }));
        if (container.status === 'PUBLISHED') return respond(400, errorBody('meta', 400, token, { code: 9007, error_subcode: 2207008, message: 'already published' }));
        if (container.status !== 'FINISHED') return respond(400, errorBody('meta', 400, token, { code: 9007, error_subcode: 2207027 }));
        const mediaId = nextId('1790000');
        container.status = 'PUBLISHED';
        container.mediaId = mediaId;
        const media = { id: mediaId, caption: container.caption, timestamp: nowIso(), permalink: `https://www.instagram.com/p/${mediaId}/`, container: form.creation_id, children: container.children };
        world.igMedia.unshift(media);
        published.instagram.push(media);
        return respond(200, { id: mediaId });
      });
    }
    if (first === igUser && second === 'media' && method === 'GET') {
      record.op = 'ig.media_list';
      return run('ig.media_list', 'meta', token, () => respond(200, { data: world.igMedia.slice(0, Number(url.searchParams.get('limit') ?? 10)).map(({ id, caption, timestamp, permalink }) => ({ id, caption, timestamp, permalink })) }));
    }
    if (first === page && method === 'POST' && (second === 'feed' || second === 'photos' || second === 'videos' || second === 'video_reels')) {
      const op = `fb.${second}`;
      record.op = op;
      record.form = form;
      return run(op, 'meta', token, () => {
        if (second === 'photos') {
          assertSigned(form.url);
          const id = nextId('5550000');
          if (form.published === 'false') {
            world.fbUnpublishedPhotos.set(id, { url: true });
            return respond(200, { id });
          }
          const post = { id: `${page}_${id}`, message: form.message ?? '', created_time: nowIso(), permalink_url: `https://www.facebook.com/${page}/posts/${id}`, kind: 'photo' };
          world.fbPosts.unshift(post);
          published.facebook.push(post);
          return respond(200, { id, post_id: post.id });
        }
        if (second === 'videos') {
          assertSigned(form.file_url);
          const id = nextId('6660000');
          const post = { id, message: form.description ?? '', created_time: nowIso(), permalink_url: `https://www.facebook.com/${page}/videos/${id}`, kind: 'video' };
          world.fbPosts.unshift(post);
          published.facebook.push(post);
          return respond(200, { id });
        }
        if (second === 'video_reels') {
          if (form.upload_phase === 'start') {
            const videoId = nextId('7770000');
            world.fbReels.set(videoId, { uploaded: false, published: false });
            return respond(200, { video_id: videoId, upload_url: `https://rupload.facebook.com/video-upload/v25.0/${videoId}` });
          }
          const reel = world.fbReels.get(form.video_id);
          if (!reel || !reel.uploaded) return respond(400, errorBody('meta', 400, token));
          reel.published = true;
          const post = { id: form.video_id, message: form.description ?? '', created_time: nowIso(), permalink_url: `https://www.facebook.com/reel/${form.video_id}`, kind: 'reel' };
          published.facebook.push(post);
          return respond(200, { success: true });
        }
        // feed
        const attached = Object.keys(form).filter((key) => key.startsWith('attached_media[')).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((key) => JSON.parse(form[key]).media_fbid);
        for (const id of attached) if (!world.fbUnpublishedPhotos.has(id)) return respond(400, errorBody('meta', 400, token));
        const id = nextId('8880000');
        const post = { id: `${page}_${id}`, message: form.message ?? '', link: form.link ?? null, created_time: nowIso(), permalink_url: `https://www.facebook.com/${page}/posts/${id}`, kind: attached.length ? 'multi_photo' : 'text', attached };
        world.fbPosts.unshift(post);
        published.facebook.push(post);
        return respond(200, { id: post.id });
      });
    }
    if (first === page && second === 'published_posts' && method === 'GET') {
      record.op = 'fb.published_posts';
      return run('fb.published_posts', 'meta', token, () => {
        const since = Number(url.searchParams.get('since') ?? 0) * 1000;
        return respond(200, { data: world.fbPosts.filter((post) => Date.parse(post.created_time) >= since).map(({ id, message, created_time, permalink_url }) => ({ id, message, created_time, permalink_url })) });
      });
    }
    if (parts.length === 2 && method === 'GET') {
      const id = first;
      const fields = url.searchParams.get('fields') ?? '';
      if (world.containers.has(id) && fields === 'status_code') {
        record.op = 'ig.status';
        return run('ig.status', 'meta', token, () => {
          const container = world.containers.get(id);
          if (container.status === 'IN_PROGRESS') {
            container.polls += 1;
            if (container.polls > container.finishAfter) container.status = 'FINISHED';
            else return respond(200, { status_code: 'IN_PROGRESS', id });
          }
          return respond(200, { status_code: container.status, id });
        });
      }
      const media = world.igMedia.find((row) => row.id === id);
      if (media) {
        record.op = 'ig.permalink';
        return run('ig.permalink', 'meta', token, () => respond(200, { id, permalink: media.permalink, timestamp: media.timestamp }));
      }
      const post = world.fbPosts.find((row) => row.id === id);
      if (post) {
        record.op = 'fb.object';
        return run('fb.object', 'meta', token, () => respond(200, { id, permalink_url: post.permalink_url, created_time: post.created_time }));
      }
      if (world.fbReels.has(id)) {
        record.op = 'fb.reel_status';
        return run('fb.reel_status', 'meta', token, () => {
          const reel = world.fbReels.get(id);
          return respond(200, { id, published: reel.published, permalink_url: `/reel/${id}` });
        });
      }
    }
    return null;
  }

  // ---- TikTok ----------------------------------------------------------------
  async function tiktok(url, init, record, token) {
    const method = init?.method ?? 'GET';
    if (url.hostname !== 'open.tiktokapis.com') {
      // upload host
      const publish = [...world.tiktokPublishes.values()].find((row) => url.href === row.uploadUrl);
      record.op = 'tt.upload';
      if (!publish || method !== 'PUT') return null;
      return run('tt.upload', 'tiktok', token, () => {
        const h = new Headers(init.headers);
        const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(h.get('content-range') ?? '');
        const body = init.body;
        if (!range || Number(range[1]) !== publish.received || Number(range[3]) !== publish.size || body.length !== Number(range[2]) - Number(range[1]) + 1) {
          return respond(400, { error: { code: 'invalid_param', message: 'bad chunk' } });
        }
        publish.received += body.length;
        publish.chunks.push([Number(range[1]), Number(range[2])]);
        if (publish.received === publish.size) {
          publish.status = 'PROCESSING_UPLOAD';
          return new Response('', { status: 201 });
        }
        return new Response('', { status: 206, headers: { 'content-range': `bytes 0-${publish.received - 1}/${publish.size}` } });
      });
    }
    const body = jsonOf(readBody(init)) ?? {};
    const path = url.pathname;
    if (path === '/v2/post/publish/creator_info/query/' && method === 'POST') {
      record.op = 'tt.creator_info';
      return run('tt.creator_info', 'tiktok', token, () => respond(200, {
        data: { creator_nickname: 'VÁ Bar', creator_username: 'vabar.rvk', privacy_level_options: world.tiktokPrivacyOptions, comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: world.tiktokMaxDuration },
        error: { code: 'ok', message: '', log_id: 'log1' },
      }));
    }
    if ((path === '/v2/post/publish/video/init/' || path === '/v2/post/publish/inbox/video/init/') && method === 'POST') {
      const op = path.includes('inbox') ? 'tt.inbox_init' : 'tt.init';
      record.op = op;
      record.json = body;
      return run(op, 'tiktok', token, () => {
        const src = body.source_info ?? {};
        if (src.source !== 'FILE_UPLOAD' || !(src.video_size > 0) || !(src.chunk_size > 0) || !(src.total_chunk_count >= 1)) return respond(400, { error: { code: 'invalid_param', message: `bad source for ${token}` } });
        if (op === 'tt.init') {
          const privacy = body.post_info?.privacy_level;
          if (!world.tiktokPrivacyOptions.includes(privacy)) {
            return respond(403, { error: { code: world.tiktokPrivacyOptions.every((v) => v === 'SELF_ONLY') ? 'unaudited_client_can_only_post_to_private_accounts' : 'privacy_level_option_mismatch', message: `nope ${token}` } });
          }
        }
        world.tiktokInits += 1;
        const publishId = `v_pub_file~v2-1.${nextId('')}`;
        const uploadUrl = `${world.tiktokUploadHost}/video/?upload_id=${publishId}&upload_token=${SIGNED_URL_MARK}-tt`;
        world.tiktokPublishes.set(publishId, { size: src.video_size, chunkSize: src.chunk_size, total: src.total_chunk_count, received: 0, chunks: [], status: 'PROCESSING_UPLOAD_PENDING', polls: 0, kind: op, postInfo: body.post_info ?? null, uploadUrl });
        return respond(200, { data: { publish_id: publishId, upload_url: uploadUrl }, error: { code: 'ok', message: '', log_id: 'log2' } });
      });
    }
    if (path === '/v2/post/publish/status/fetch/' && method === 'POST') {
      record.op = 'tt.status';
      return run('tt.status', 'tiktok', token, () => {
        const publish = world.tiktokPublishes.get(body.publish_id);
        if (!publish) return respond(400, { error: { code: 'invalid_param', message: 'unknown publish_id' } });
        let status = publish.status;
        if (status === 'PROCESSING_UPLOAD_PENDING') status = 'PROCESSING_UPLOAD';
        if (publish.received === publish.size && publish.status !== 'DONE' && publish.status !== 'FAILED') {
          publish.polls += 1;
          if (publish.polls >= world.tiktokCompleteAfter) {
            publish.status = 'DONE';
            publish.postId = nextId('7300000000000');
            published.tiktok.push({ publish_id: body.publish_id, post_id: publish.postId, kind: publish.kind });
          }
        }
        if (publish.status === 'DONE') {
          const inbox = publish.kind === 'tt.inbox_init';
          return respond(200, { data: { status: inbox ? 'SEND_TO_USER_INBOX' : 'PUBLISH_COMPLETE', publicaly_available_post_id: inbox ? [] : [publish.postId], uploaded_bytes: publish.received }, error: { code: 'ok' } });
        }
        if (publish.status === 'FAILED') return respond(200, { data: { status: 'FAILED', fail_reason: publish.failReason ?? 'internal' }, error: { code: 'ok' } });
        return respond(200, { data: { status, uploaded_bytes: publish.received }, error: { code: 'ok' } });
      });
    }
    return null;
  }

  // ---- Google ----------------------------------------------------------------
  async function google(url, init, record, token) {
    const method = init?.method ?? 'GET';
    const parent = RESOURCES['google-business-profile'].id;
    const base = `/v4/${parent}/localPosts`;
    if (url.pathname === base && method === 'POST') {
      record.op = 'gbp.create';
      const body = jsonOf(readBody(init)) ?? {};
      record.json = body;
      return run('gbp.create', 'google', token, () => {
        for (const item of body.media ?? []) assertSigned(item.sourceUrl);
        const name = `${parent}/localPosts/${nextId('lp')}`;
        const post = { name, summary: body.summary, topicType: body.topicType, event: body.event ?? null, callToAction: body.callToAction ?? null, offer: body.offer ?? null, media: body.media ?? [], state: world.gbpLiveAfter === 0 ? 'LIVE' : 'PROCESSING', polls: 0, createTime: nowIso(), searchUrl: `https://local.google.com/place?id=1&use=posts&lpsid=${name.split('/').pop()}` };
        world.gbpPosts.unshift(post);
        published['google-business-profile'].push(post);
        const { polls, ...visible } = post;
        return respond(200, visible);
      });
    }
    if (url.pathname === base && method === 'GET') {
      record.op = 'gbp.list';
      return run('gbp.list', 'google', token, () => respond(200, { localPosts: world.gbpPosts.map(({ polls, ...visible }) => visible) }));
    }
    if (url.pathname.startsWith(`${base}/`) && method === 'GET') {
      record.op = 'gbp.get';
      const name = decodeURIComponent(url.pathname.slice('/v4/'.length));
      return run('gbp.get', 'google', token, () => {
        const post = world.gbpPosts.find((row) => row.name === name);
        if (!post) return respond(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });
        if (post.state === 'PROCESSING') {
          post.polls += 1;
          if (post.polls >= world.gbpLiveAfter) post.state = 'LIVE';
        }
        const { polls, ...visible } = post;
        return respond(200, visible);
      });
    }
    return null;
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const token = tokenOf(init.headers);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    if (headers.authorization) headers.authorization = '[redacted]';
    const record = { op: null, method: init.method ?? 'GET', url: url.href, host: url.hostname, headers, at: now(), redirect: init.redirect ?? null };
    calls.push(record);
    let response = null;
    if (url.origin === SUPABASE_URL) response = await storage(url, init, record);
    else if (url.hostname === 'graph.facebook.com' || url.hostname === 'rupload.facebook.com') response = await meta(url, init, record, token);
    else if (url.hostname.endsWith('tiktokapis.com')) response = await tiktok(url, init, record, token);
    else if (url.hostname === 'mybusiness.googleapis.com') response = await google(url, init, record, token);
    if (!response) {
      unexpected.push(`${record.method} ${url.href}`);
      throw new Error(`Unexpected provider request ${record.method} ${url.href}`);
    }
    return response;
  }

  const count = (op) => calls.filter((call) => call.op === op).length;
  return { fetchImpl, calls, published, world, unexpected, count, setScript };
}

// ---- fake publishing database (worker RPCs, fenced) ---------------------------

export const TRANSITIONS = Object.freeze([
  // queued -> needs_attention: the claim's stale-schedule path (signatures v1);
  // missing from report 07 §2.3's table, present in the S94C migration contract.
  ['queued', 'publishing'], ['queued', 'cancelled'], ['queued', 'needs_attention'],
  ['retrying', 'publishing'], ['retrying', 'cancelled'], ['retrying', 'needs_attention'],
  ['publishing', 'published'], ['publishing', 'processing'], ['publishing', 'retrying'], ['publishing', 'verifying'],
  ['publishing', 'failed'], ['publishing', 'needs_attention'],
  ['processing', 'published'], ['processing', 'failed'], ['processing', 'needs_attention'], ['processing', 'verifying'],
  ['processing', 'publishing'],
  ['verifying', 'published'], ['verifying', 'retrying'], ['verifying', 'needs_attention'],
  ['failed', 'queued'], ['failed', 'cancelled'],
  ['needs_attention', 'queued'], ['needs_attention', 'published'], ['needs_attention', 'cancelled'],
]);
const LEGAL = new Set(TRANSITIONS.map(([a, b]) => `${a}>${b}`));
const PHASES = new Set(['none', 'media_ready', 'container_created', 'container_ready', 'submitted', 'remote_processing']);
const STEP_KEYS = new Set(['step', 'http_status', 'provider_request_id', 'outcome', 'code', 'message', 'poll_status', 'detail']);
const CLASSES = new Set(['transient', 'rate_limited', 'auth', 'permanent', 'uncertain', 'stale', 'policy']);
const REASONS = new Set(['outcome_unknown', 'auth_expired', 'rate_limit_exhausted', 'max_attempts', 'stale_schedule', 'provider_rejected', 'media_invalid', 'manual_hold', 'no_resource', 'provider_not_ready']);

export function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function mediaPath(n, ext = 'jpg') {
  return `venues/main/2026/10/${uuid(n)}/original.${ext}`;
}

export function createFakePublishingDb({ now, random = () => 0.5, skipStaleGuard = false } = {}) {
  const deliveries = new Map();
  const attempts = [];
  const rpcLog = [];
  const notifications = [];
  const cooldowns = new Map();
  const hooks = { afterRpc: null, beforeRpc: null };
  let seq = 0;

  function add(fields) {
    seq += 1;
    const id = fields.id ?? uuid(500 + seq);
    const due = fields.due_at ?? new Date(now()).toISOString();
    const row = {
      id,
      content_id: fields.content_id ?? uuid(900 + seq),
      provider_key: fields.provider_key,
      external_account_id: fields.external_account_id ?? RESOURCES[fields.provider_key]?.id ?? 'pending',
      target_kind: fields.target_kind,
      status: fields.status ?? 'queued',
      phase: fields.phase ?? 'none',
      attempt_count: fields.attempt_count ?? 0,
      max_attempts: 6,
      poll_count: 0,
      verify_attempts: 0,
      due_at: due,
      next_attempt_at: fields.next_attempt_at ?? due,
      latest_acceptable_at: fields.latest_acceptable_at ?? new Date(Date.parse(due) + 6 * 3600 * 1000).toISOString(),
      priority: fields.priority ?? 100,
      provider_container_id: null,
      provider_publish_id: null,
      provider_post_id: null,
      provider_permalink: null,
      submit_started_at: null,
      progress: {},
      claim_token: null,
      claimed_by: null,
      claimed_until: null,
      cancel_requested_at: null,
      published_at: null,
      published_source: null,
      last_error_class: null,
      last_error_code: null,
      last_error_message: null,
      attention_reason: null,
      attention_notified_at: null,
      row_version: 1,
      gate: { fingerprint_ok: true, automatic: true, ready: true, cancelled: false, ...(fields.gate ?? {}) },
      payload_snapshot: {
        version: 1,
        content_id: fields.content_id ?? uuid(900 + seq),
        title: fields.title ?? 'Friday DJ',
        content_type: 'post',
        caption: fields.caption ?? 'Friday DJ at VÁ from 21:00 #reykjavik',
        provider_key: fields.provider_key,
        target_kind: fields.target_kind,
        external_account_id: fields.external_account_id ?? RESOURCES[fields.provider_key]?.id,
        platform_options: fields.platform_options ?? {},
        media: fields.media ?? [],
        scheduled_for: due,
        event_starts_at: null,
        approved_at: new Date(now() - 3600_000).toISOString(),
      },
    };
    deliveries.set(id, row);
    return row;
  }

  function transition(row, to) {
    if (row.status === to) return;
    if (!LEGAL.has(`${row.status}>${to}`)) throw new Error(`illegal delivery transition ${row.status}→${to}`);
    if (row.status === 'publishing' && to === 'retrying' && ['submitting', 'submitted'].includes(row.phase)) throw new Error('unsafe retry after submit; verify first');
    row.status = to;
  }

  function bump(row) {
    row.row_version += 1;
  }

  function release(row) {
    row.claim_token = null;
    row.claimed_by = null;
    row.claimed_until = null;
  }

  function owned(row, token) {
    return row && row.claim_token === token && Date.parse(row.claimed_until) > now();
  }

  function attemptFor(row) {
    return attempts.find((a) => a.delivery_id === row.id && a.claim_token === row.claim_token);
  }

  function backoffSeconds(attempt, retryAfter) {
    const base = 60;
    const cap = 3600;
    const raw = (Math.min(cap, base * 2 ** (Math.max(attempt, 1) - 1)) / 2) * (1 + random());
    return Math.max(Number(retryAfter) || 0, raw);
  }

  function snapshot(row) {
    return {
      id: row.id, content_id: row.content_id, provider_key: row.provider_key, external_account_id: row.external_account_id,
      target_kind: row.target_kind, status: row.status, phase: row.phase, attempt_count: row.attempt_count, max_attempts: row.max_attempts,
      poll_count: row.poll_count, verify_attempts: row.verify_attempts, due_at: row.due_at, latest_acceptable_at: row.latest_acceptable_at,
      provider_container_id: row.provider_container_id, provider_publish_id: row.provider_publish_id, provider_post_id: row.provider_post_id,
      provider_permalink: row.provider_permalink, submit_started_at: row.submit_started_at, progress: structuredClone(row.progress), priority: row.priority,
      cancel_requested_at: row.cancel_requested_at,
    };
  }

  function notifyOnce(row) {
    if (row.attention_notified_at) return;
    row.attention_notified_at = new Date(now()).toISOString();
    notifications.push({ delivery_id: row.id, status: row.status, reason: row.attention_reason });
  }

  function claim({ p_worker_id, p_limit = 4, p_lease_seconds = 300 }) {
    const t = now();
    // (a) stale-lease recovery
    for (const row of deliveries.values()) {
      if (row.claim_token && Date.parse(row.claimed_until) < t) {
        const attempt = attemptFor(row);
        if (attempt && !attempt.outcome) attempt.outcome = 'lease_lost';
        if (row.status === 'publishing') {
          const to = ['submitting', 'submitted'].includes(row.phase) ? 'verifying' : 'retrying';
          transition(row, to);
          row.last_error_class = 'uncertain';
        }
        release(row);
        row.next_attempt_at = new Date(t).toISOString();
        bump(row);
      }
    }
    // stale schedules
    if (!skipStaleGuard) {
      for (const row of deliveries.values()) {
        if (['queued', 'retrying'].includes(row.status) && !row.claim_token && t > Date.parse(row.latest_acceptable_at)) {
          transition(row, 'needs_attention');
          row.attention_reason = 'stale_schedule';
          row.last_error_class = 'stale';
          bump(row);
          notifyOnce(row);
        }
      }
    }
    const candidates = [...deliveries.values()]
      .filter((row) => ['queued', 'retrying', 'processing', 'verifying'].includes(row.status))
      .filter((row) => Date.parse(row.next_attempt_at) <= t && !row.claim_token && !row.cancel_requested_at)
      .filter((row) => {
        if (['processing', 'verifying'].includes(row.status)) return true;
        const cd = cooldowns.get(`${row.provider_key}|${row.external_account_id}`);
        if (cd && cd > t) return false;
        const g = row.gate;
        return g.fingerprint_ok && g.automatic && g.ready && !g.cancelled;
      })
      .sort((a, b) => a.priority - b.priority || Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at) || a.id.localeCompare(b.id));
    const perAccount = new Map();
    const chosen = [];
    for (const row of candidates) {
      const key = `${row.provider_key}|${row.external_account_id}`;
      const n = perAccount.get(key) ?? 0;
      if (n >= 2) continue;
      perAccount.set(key, n + 1);
      chosen.push(row);
      if (chosen.length >= Math.max(1, Math.min(p_limit, 20))) break;
    }
    return chosen.map((row) => {
      let kind = 'publish';
      if (row.status === 'processing') {
        kind = 'poll';
        row.poll_count += 1;
      } else if (row.status === 'verifying') {
        kind = 'verify';
        row.verify_attempts += 1;
      } else {
        transition(row, 'publishing');
        row.attempt_count += 1;
      }
      seq += 1;
      row.claim_token = uuid(100000 + seq);
      row.claimed_by = p_worker_id;
      row.claimed_until = new Date(t + p_lease_seconds * 1000).toISOString();
      bump(row);
      attempts.push({ delivery_id: row.id, attempt_no: attempts.filter((a) => a.delivery_id === row.id).length + 1, claim_token: row.claim_token, claimed_by: p_worker_id, claim_kind: kind, steps: [], outcome: null });
      return { claim_token: row.claim_token, claim_kind: kind, attempt_no: attempts.length, lease_until: row.claimed_until, delivery: snapshot(row), payload_snapshot: structuredClone(row.payload_snapshot) };
    });
  }

  function heartbeat({ p_delivery_id, p_claim_token, p_seconds = 300 }) {
    const row = deliveries.get(p_delivery_id);
    if (!owned(row, p_claim_token)) return { ok: false, lease_lost: true };
    row.claimed_until = new Date(now() + p_seconds * 1000).toISOString();
    return { ok: true, lease_until: row.claimed_until };
  }

  function recordStep({ p_delivery_id, p_claim_token, p_phase, p_ids = {}, p_step = {} }) {
    const row = deliveries.get(p_delivery_id);
    if (!owned(row, p_claim_token)) return { ok: false, lease_lost: true };
    if (p_phase !== null && p_phase !== undefined && !PHASES.has(p_phase)) throw new Error(`record_step: bad phase ${p_phase}`);
    for (const key of Object.keys(p_step)) if (!STEP_KEYS.has(key)) throw new Error(`record_step: unexpected step key ${key}`);
    for (const key of ['provider_post_id', 'provider_publish_id']) {
      if (p_ids[key] && row[key] && row[key] !== p_ids[key]) throw new Error('provider ids are write-once');
    }
    if (p_ids.reset_container === true) {
      if (p_phase !== 'none') throw new Error('reset_container needs phase none');
      row.provider_container_id = null;
    }
    for (const key of ['provider_container_id', 'provider_publish_id', 'provider_post_id', 'provider_permalink']) {
      if (p_ids[key]) row[key] = p_ids[key];
    }
    if (p_ids.progress) row.progress = { ...row.progress, ...p_ids.progress };
    if (p_phase) row.phase = p_phase;
    attemptFor(row)?.steps.push({ ...p_step, at: new Date(now()).toISOString() });
    bump(row);
    return { ok: true, phase: row.phase, lease_until: row.claimed_until };
  }

  function beginSubmit({ p_delivery_id, p_claim_token }) {
    const row = deliveries.get(p_delivery_id);
    if (!owned(row, p_claim_token)) return { ok: false, lease_lost: true };
    const g = row.gate;
    let reason = null;
    if (row.cancel_requested_at) reason = 'cancel_requested';
    else if (g.cancelled) reason = 'content_cancelled';
    else if (!g.fingerprint_ok) reason = 'superseded_by_edit';
    else if (!g.automatic) reason = 'automatic_publishing_disabled';
    else if (!g.ready) reason = 'provider_not_ready';
    else if (now() > Date.parse(row.latest_acceptable_at)) reason = 'stale_schedule';
    if (reason) {
      const attempt = attemptFor(row);
      if (['cancel_requested', 'content_cancelled', 'superseded_by_edit'].includes(reason)) {
        if (row.status === 'publishing' || row.status === 'processing') row.status = 'cancelled';
      } else {
        transition(row, 'needs_attention');
        row.attention_reason = reason === 'stale_schedule' ? 'stale_schedule' : 'provider_not_ready';
      }
      if (attempt) attempt.outcome = 'refused';
      release(row);
      bump(row);
      return { ok: false, refused: true, reason, status: row.status };
    }
    if (row.status === 'processing') transition(row, 'publishing');
    row.phase = 'submitting';
    row.submit_started_at = new Date(now()).toISOString();
    row.claimed_until = new Date(Math.max(Date.parse(row.claimed_until), now() + 300_000)).toISOString();
    bump(row);
    return { ok: true, lease_until: row.claimed_until, submit_started_at: row.submit_started_at };
  }

  function complete({ p_delivery_id, p_claim_token, p_outcome }) {
    const row = deliveries.get(p_delivery_id);
    if (!owned(row, p_claim_token)) return { ok: false, lease_lost: true };
    const o = p_outcome ?? {};
    const t = now();
    const attempt = attemptFor(row);
    if (o.error) {
      if (!CLASSES.has(o.error.class)) throw new Error(`complete: bad error class ${o.error.class}`);
      row.last_error_class = o.error.class;
      row.last_error_code = o.error.code;
      row.last_error_message = o.error.message;
    }
    if (o.attention_reason !== undefined && !REASONS.has(o.attention_reason)) throw new Error(`complete: bad attention reason ${o.attention_reason}`);
    let status = o.status;
    if (status === 'published') {
      if (!o.post_id) throw new Error('complete: published without post_id');
      if (row.provider_post_id && row.provider_post_id !== o.post_id) throw new Error('provider ids are write-once');
      transition(row, 'published');
      row.provider_post_id = o.post_id;
      if (o.permalink) row.provider_permalink = o.permalink;
      row.published_at = o.published_at ?? new Date(t).toISOString();
      row.published_source = o.source ?? 'provider';
    } else if (status === 'processing') {
      transition(row, 'processing');
      for (const key of ['provider_container_id', 'provider_publish_id', 'provider_post_id']) if (o.ids?.[key]) row[key] = o.ids[key];
      row.next_attempt_at = new Date(t + (o.poll_after_s ?? 30) * 1000).toISOString();
    } else if (status === 'retrying') {
      if (row.status === 'publishing' && ['submitting', 'submitted'].includes(row.phase)) {
        status = 'verifying';
        transition(row, 'verifying');
        row.next_attempt_at = new Date(t + 60_000).toISOString();
      } else if (row.attempt_count >= row.max_attempts) {
        status = 'needs_attention';
        transition(row, 'needs_attention');
        row.attention_reason = 'max_attempts';
        notifyOnce(row);
      } else {
        const wait = backoffSeconds(row.attempt_count, o.retry_after_s);
        if (t + wait * 1000 > Date.parse(row.latest_acceptable_at)) {
          status = 'needs_attention';
          transition(row, 'needs_attention');
          row.attention_reason = 'stale_schedule';
          notifyOnce(row);
        } else {
          transition(row, 'retrying');
          row.next_attempt_at = new Date(t + wait * 1000).toISOString();
        }
      }
      if (o.cooldown_s) cooldowns.set(`${row.provider_key}|${row.external_account_id}`, t + o.cooldown_s * 1000);
    } else if (status === 'verifying') {
      transition(row, 'verifying');
      row.next_attempt_at = new Date(t + (o.poll_after_s ?? 60) * 1000).toISOString();
    } else if (status === 'failed' || status === 'needs_attention') {
      transition(row, status);
      row.attention_reason = o.attention_reason ?? (status === 'needs_attention' ? 'outcome_unknown' : 'provider_rejected');
      notifyOnce(row);
    } else {
      throw new Error(`complete: bad status ${status}`);
    }
    if (attempt) attempt.outcome = status;
    release(row);
    bump(row);
    return { ok: true, status: row.status, next_attempt_at: row.next_attempt_at, attention_reason: row.attention_reason };
  }

  // Security P2-1: fenced on the live claim; the connection becomes expired.
  const authFailures = [];
  function markAuthFailed({ p_delivery_id, p_claim_token, p_error }) {
    const row = deliveries.get(p_delivery_id);
    if (!owned(row, p_claim_token)) return { ok: false, lease_lost: true };
    authFailures.push({ delivery_id: row.id, provider_key: row.provider_key, error: p_error });
    return { ok: true, provider_key: row.provider_key, connection_status: 'expired' };
  }

  // Media publication uses (never a URL or token).
  const mediaUses = [];
  function recordUse({ p_use }) {
    if (/"(url|signed_url|signedurl|token|access_token)"\s*:/i.test(JSON.stringify(p_use))) throw new Error('urls and tokens are never stored');
    for (const key of ['asset_id', 'content_id', 'platform', 'fetch_method']) if (!p_use?.[key]) throw new Error(`record_use: ${key} missing`);
    mediaUses.push(structuredClone(p_use));
    return { id: uuid(700000 + mediaUses.length) };
  }

  const handlers = {
    atlas_integration_mark_auth_failed: markAuthFailed,
    atlas_marketing_media_record_use: recordUse,
    atlas_marketing_delivery_claim: claim,
    atlas_marketing_delivery_heartbeat: heartbeat,
    atlas_marketing_delivery_record_step: recordStep,
    atlas_marketing_delivery_begin_submit: beginSubmit,
    atlas_marketing_delivery_complete: complete,
  };

  async function rpc(name, payload) {
    rpcLog.push({ name, payload: structuredClone(payload) });
    if (hooks.beforeRpc) await hooks.beforeRpc(name, payload);
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected rpc ${name}`);
    const result = handler(payload);
    if (hooks.afterRpc) await hooks.afterRpc(name, payload, result);
    return structuredClone(result);
  }

  // Simulates another worker recovering the row (the lease was lost).
  function stealLease(id) {
    const row = deliveries.get(id);
    row.claim_token = uuid(999999);
    row.claimed_until = new Date(now() + 300_000).toISOString();
  }

  return { rpc, deliveries, attempts, rpcLog, notifications, cooldowns, hooks, add, stealLease, authFailures, mediaUses, isOwned: (id, token) => owned(deliveries.get(id), token) };
}

export function createFakeCredentials(db, { tokens = TOKENS, resources = RESOURCES, failures = {} } = {}) {
  const opened = [];
  return {
    opened,
    failures,
    async openPublishingCredential(deps, { deliveryId, claimToken }) {
      if (!deps || typeof deps.rpc !== 'function' || typeof deps.now !== 'function') throw new Error('credential deps missing');
      const row = db.deliveries.get(deliveryId);
      if (!db.isOwned(deliveryId, claimToken)) {
        const error = new Error('not claimed');
        error.code = 'not_claimed';
        throw error;
      }
      opened.push(deliveryId);
      const failure = failures[row.provider_key];
      if (failure) {
        // Shaped like CredentialError from _shared/integrations/credentials.mjs.
        const spec = typeof failure === 'string' ? { code: failure } : failure;
        const error = new Error(`Publishing credential unavailable: ${spec.code}.`);
        error.name = 'CredentialError';
        error.code = spec.code;
        error.retryable = spec.retryable === true;
        error.reauthorize = spec.reauthorize === true;
        throw error;
      }
      return {
        provider_key: row.provider_key,
        access_token: tokens[row.provider_key],
        resource: resources[row.provider_key] === undefined ? null : structuredClone(resources[row.provider_key]),
        expires_at: new Date(deps.now() + 3600_000).toISOString(),
      };
    },
  };
}
