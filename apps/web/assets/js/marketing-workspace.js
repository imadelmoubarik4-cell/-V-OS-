// Marketing (#marketing, #marketing/<tab>) — plan posts and campaigns, get
// approvals, publish approved posts (spec §7.13, S94 UX spec). Manager and
// admin only.
//
// Tabs: Overview · Calendar · Posts · Media · Campaigns · History. The post
// composer is a routed page: #marketing/new and #marketing/post?id=<id>.
// Nothing publishes unless a manager approved that exact post; the server
// (atlas-marketing-workspace + the SQL approval gate) enforces it and the
// publisher worker posts approved deliveries only. Every date and time is
// venue time: datetime inputs go through AtlasVenueClock.localInputValue /
// fromLocalInput, so a browser in another zone stores the instant the manager
// meant.
(function () {
  'use strict';
  // Native date picker (design system: forms use the platform date and time
  // controls). The value is 'YYYY-MM-DD'; AtlasVenueClock validates it inline.
  const DATE_FIELD = 'type="date"';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 15000;
  const POLL_MS = 10000;
  const CHECK_DEBOUNCE_MS = 300;
  const MANAGERS = ['admin', 'manager'];
  const TABS = [['overview', 'Overview'], ['calendar', 'Calendar'], ['posts', 'Posts'], ['media', 'Media'], ['campaigns', 'Campaigns'], ['history', 'History']];
  const TAB_ALIASES = { content: 'posts', connections: 'overview' };
  const CHANNELS = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', 'google-business-profile': 'Google Business Profile' };
  const CHANNEL_SHORT = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', 'google-business-profile': 'Google' };
  const CHANNEL_LETTER = { instagram: 'I', facebook: 'F', tiktok: 'T', 'google-business-profile': 'G' };
  const CHANNEL_ORDER = Object.keys(CHANNELS);
  const TYPES = { post: 'Post', story: 'Story', reel: 'Reel', campaign_task: 'Campaign task', event_promotion: 'Event promotion', content_idea: 'Idea', google_post: 'Google post' };
  const NEW_TYPES = ['post', 'event_promotion', 'campaign_task', 'content_idea'];
  const PUBLISHABLE = new Set(['post', 'story', 'reel', 'google_post', 'event_promotion']);
  const STATUS = {
    idea: ['Idea', 'neutral'], draft: ['Draft', 'neutral'], pending_approval: ['Waiting for approval', 'info'],
    changes_requested: ['Changes requested', 'warning'], approved: ['Approved', 'positive'], scheduled: ['Scheduled', 'positive'],
    published: ['Published', 'positive'], completed: ['Done', 'positive'], rejected: ['Rejected', 'neutral'], cancelled: ['Cancelled', 'neutral']
  };
  // Derived from the channel deliveries (snapshot publication_state).
  const PUBLICATION = {
    ready_not_sent: ['Ready, not sent', 'warning'], queued: null, publishing: ['Publishing', 'info'],
    partial: ['Partly published', 'warning'], published: ['Published', 'positive'], attention: ['Failed', 'danger']
  };
  const FINAL = new Set(['published', 'completed', 'rejected', 'cancelled']);
  const EDITABLE = new Set(['idea', 'draft', 'changes_requested']);
  const IN_FLIGHT = new Set(['publishing', 'processing', 'verifying']);
  const HISTORY_LABELS = {
    campaign_created: 'Campaign created', content_created: 'Draft created', content_updated: 'Draft updated',
    approval_submitted: 'Sent for approval', approval_decided: 'Approval decided', content_published: 'Marked as posted by hand',
    content_completed: 'Marked as done', content_cancelled: 'Cancelled', recommendation_converted: 'Suggestion planned',
    recommendation_dismissed: 'Suggestion dismissed', connection_state_changed: 'Connection changed',
    publish_started: 'Publishing started', publish_now: 'Publish now pressed', channel_published: 'Published',
    channel_failed: 'Channel failed', channel_retry: 'Channel retried', delivery_cancelled: 'Channel not posted', posted_by_hand: 'Marked as posted by hand'
  };
  const CAPTION_LIMIT = { instagram: 2200, tiktok: 2200, 'google-business-profile': 1500, facebook: 63206 };
  const TIKTOK_PRIVACY = { PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' };
  const TIKTOK_MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
  const TIKTOK_BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';
  const GBP_TOPICS = [['STANDARD', 'Update'], ['EVENT', 'Event'], ['OFFER', 'Offer']];
  const GBP_BUTTONS = [['', 'No button'], ['BOOK', 'Book'], ['ORDER', 'Order online'], ['SHOP', 'Buy'], ['LEARN_MORE', 'Learn more'], ['SIGN_UP', 'Sign up'], ['CALL', 'Call now']];
  const REMINDERS = [['off', 'Off'], ['15', '15 minutes before'], ['30', '30 minutes before'], ['60', '1 hour before'], ['1440', '1 day before']];
  const FORMAT_LABEL = {
    ig_feed: 'Post', ig_carousel: 'Carousel', ig_reel: 'Reel', fb_page_post: 'Post', fb_page_photo: 'Photo post', fb_page_video: 'Video',
    fb_reel: 'Reel', tiktok_video: 'Post directly', tiktok_inbox_video: 'Send to TikTok inbox', gbp_local_post: 'Update'
  };
  const REASON_TEXT = {
    not_connected: (c) => `${c} isn't connected, so you'll post it by hand.`,
    needs_reauthorization: (c) => `${c} needs reconnecting before it can publish. Reconnect in Settings.`,
    publishing_permission_missing: (c) => `${c} is connected, but posting wasn't allowed. Allow publishing in Settings.`,
    review_required: (c) => `${c} hasn't approved Atlas for posting yet, so you'll post it by hand.`,
    review_pending: (c) => `${c} is still reviewing Atlas's access, so you'll post it by hand.`,
    no_resource_selected: (c) => `${c}: choose where to post in Settings.`,
    not_configured: (c) => `${c} isn't set up yet, so you'll post it by hand.`
  };
  const ATTENTION_TEXT = {
    auth_expired: (c) => `${c} needs reconnecting. Nothing was posted to ${c}. Reconnect, then retry.`,
    outcome_unknown: (c) => `Atlas couldn't confirm whether ${c} received the post. Check ${c}; if it isn't there, retry.`,
    rate_limit_exhausted: (c) => `${c}'s posting limit was reached. Nothing was posted. Retry later.`,
    max_attempts: (c) => `${c} didn't answer after several tries. Nothing was posted. Retry in a few minutes.`,
    stale_schedule: (c) => `The time to post passed before ${c} could publish it. Nothing was posted. Retry to post it now.`,
    provider_rejected: (c) => `${c} didn't accept the post. Edit the post, then retry.`,
    media_invalid: (c) => `${c} didn't accept the photo or video. Edit the post, then retry.`,
    no_resource: (c) => `${c}: choose where to post in Settings, then retry.`,
    provider_not_ready: (c) => `${c} can't publish yet. Check Integrations in Settings.`,
    manual_hold: (c) => `${c} is on hold.`
  };
  const RETRY_NEEDS_FIX = new Set(['auth_expired', 'no_resource', 'provider_not_ready']);

  const state = {
    workspace: null,
    staff: null,
    members: [],
    tab: 'overview',
    month: null,
    postFilter: null,
    historyFilter: 'all',
    channelFilter: 'all',
    expandedDay: null,
    linkedPost: null,
    loading: false,
    submitting: false,
    error: null,
    initialized: false,
    registered: false,
    extra: new Map(),
    composer: null,
    creatorInfo: null,
    mediaHost: null,
    mediaMounted: false,
    pollTimer: null
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = () => window.AtlasVenueClock;
  const humanize = (value) => { const text = String(value || '').replace(/[_-]+/g, ' ').trim(); return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''; };
  const requestId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `marketing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const venueToday = () => state.workspace?.venue_date || clock()?.venueDate?.() || new Date().toISOString().slice(0, 10);
  const venueKey = (value) => (value ? clock()?.venueDate?.(value) || String(value).slice(0, 10) : null);
  const dateTime = (value, fallback = 'Not scheduled') => (value ? clock()?.formatDateTime?.(value, {}, fallback) || fallback : fallback);
  const dateOnly = (value, fallback = '—') => (value ? clock()?.formatDate?.(value, {}, fallback) || fallback : fallback);
  const timeOnly = (value, fallback = '') => (value ? clock()?.formatTime?.(value, fallback) || fallback : fallback);
  const inputValue = (value) => (value ? clock()?.localInputValue?.(value) || '' : '');
  const fromInput = (value) => (value ? clock()?.fromLocalInput?.(value) || null : null);
  const number = (value) => Number(value || 0).toLocaleString('en-GB');
  const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const listText = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

  function profile() { return window.AtlasShell?.profile?.() || window.atlasCurrentProfile || null; }
  function isManager() { const p = profile(); return Boolean(p && p.active !== false && MANAGERS.includes(p.role)); }
  function host() { return document.getElementById('marketing-view'); }
  function visible() { return window.AtlasShell?.current?.() === 'marketing'; }
  const items = () => (Array.isArray(state.workspace?.content_items) ? state.workspace.content_items : []);
  const campaigns = () => (Array.isArray(state.workspace?.campaigns) ? state.workspace.campaigns : []);
  const suggestions = () => (Array.isArray(state.workspace?.recommendations) ? state.workspace.recommendations : []);
  const history = () => (Array.isArray(state.workspace?.history) ? state.workspace.history : []);
  const targets = () => (Array.isArray(state.workspace?.publish_targets) ? state.workspace.publish_targets : []);
  const targetFor = (platform) => targets().find((entry) => entry?.provider_key === platform) || null;
  const autoPublishing = () => state.workspace?.automatic_publishing_enabled === true;
  const deliveriesOf = (item) => (Array.isArray(item?.deliveries) ? item.deliveries : []);
  const mediaOf = (item) => (Array.isArray(item?.media) ? item.media.filter((m) => !m.platform).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) : []);
  const findItem = (id) => items().find((entry) => entry.id === id) || state.extra.get(id) || null;

  function monthRange() {
    const key = state.month || venueToday().slice(0, 7);
    return clock()?.monthRange ? clock().monthRange(key) : { month: key, start: `${key}-01`, end: `${key}-28` };
  }

  // The venue zone's city for labels ('Reykjavík time'); never a literal zone.
  function venueCity() {
    const zone = clock()?.timeZone?.() || '';
    const city = zone.split('/').pop()?.replace(/_/g, ' ') || '';
    return ({ Reykjavik: 'Reykjavík' })[city] || city;
  }
  const venueTimeLabel = () => (venueCity() ? `${venueCity()} time` : 'venue time');

  // ---------- data ----------

  async function api(action, { method = 'GET', params = {}, body = null } = {}) {
    const endpoint = String(cfg.MARKETING_WORKSPACE_API || '').trim();
    if (!endpoint) throw Object.assign(new Error('not configured'), { status: 404 });
    const client = window.atlasSupabase;
    const { data } = client?.auth ? await client.auth.getSession() : { data: null };
    const session = data?.session;
    if (!session?.access_token) throw Object.assign(new Error('session'), { status: 401 });
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => { if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value)); });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method, cache: 'no-store', signal: controller.signal, headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status, code: payload?.error_code || null, serverMessage: typeof payload?.error === 'string' ? payload.error : null });
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function errorText(error, what) {
    if (error?.status === 401) return 'Atlas couldn’t confirm your sign-in for this. Try again in a moment.';
    if (error?.status === 403) return 'Your role can\'t do this. Ask an administrator.';
    if (error?.status === 404 && error?.code === 'not_found') return 'That post no longer exists. The list has been reloaded.';
    if (error?.status === 404) return 'Marketing isn\'t switched on for this venue yet.';
    if (error?.status === 409 && error?.code === 'stale_request') return `${what} changed while you were working. It has been reloaded — check it and try again.`;
    if (error?.status === 409 && error?.serverMessage) return error.serverMessage;
    if (error?.status === 409) return `${what} changed while you were working. It has been reloaded — check it and try again.`;
    if (error?.status === 400 && error?.serverMessage) return `${error.serverMessage} Nothing was changed.`.replace('. Nothing was changed. Nothing was changed.', '. Nothing was changed.');
    if (error?.name === 'AbortError') return 'The connection timed out. Nothing was changed. Try again.';
    return 'Nothing was changed. Check the connection and try again.';
  }

  function applyPayload(payload) {
    if (payload.workspace) state.workspace = payload.workspace;
    if (payload.staff) state.staff = payload.staff;
    if (Array.isArray(payload.members)) state.members = payload.members;
  }

  async function load({ quiet = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!quiet) render();
    try {
      const range = monthRange();
      applyPayload(await api('snapshot', { params: { start: range.start, end: range.end } }));
      state.error = null;
    } catch (error) {
      state.error = error;
    } finally {
      state.loading = false;
      render();
      schedulePoll();
    }
  }

  // POST an action; the response carries a fresh snapshot. The RPC result is
  // returned so callers use the created id instead of diffing the list.
  async function mutate(action, body, message, what = 'The post') {
    if (state.submitting) throw Object.assign(new Error('busy'), { userMessage: 'Still saving the last change. Try again in a moment.' });
    state.submitting = true;
    try {
      const range = monthRange();
      const payload = await api(action, { method: 'POST', body: { ...body, start_date: range.start, end_date: range.end } });
      applyPayload(payload);
      const content = payload.result?.content;
      if (content?.id) state.extra.set(content.id, { ...(state.extra.get(content.id) || {}), ...content });
      if (message) window.AtlasShell?.toast?.(message);
      render();
      schedulePoll();
      return payload.result ?? {};
    } catch (error) {
      if (error?.status === 409 || error?.code === 'not_found') load({ quiet: true });
      throw Object.assign(new Error('mutate'), { userMessage: errorText(error, what), status: error?.status, code: error?.code });
    } finally {
      state.submitting = false;
    }
  }

  // While a channel is being published, refresh every 10 s (visible only).
  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    const busy = items().some((item) => deliveriesOf(item).some((d) => IN_FLIGHT.has(d.status)) || item.publication_state === 'publishing');
    if (!busy || !visible()) return;
    state.pollTimer = window.setTimeout(() => { if (visible() && !state.submitting) load({ quiet: true }); }, POLL_MS);
  }

  // ---------- small markup helpers ----------

  function pill(status) {
    const [label, tone] = STATUS[status] || [humanize(status), 'neutral'];
    return `<span class="atlas-pill atlas-pill--${tone}">${escapeHtml(label)}</span>`;
  }
  // Post-level pill: publication state wins over the stored status once
  // channels have been handed to the publisher.
  function postPill(item) {
    const derived = PUBLICATION[item?.publication_state];
    if (derived && !['draft', 'pending_approval', 'changes_requested', 'rejected', 'cancelled'].includes(item.status)) {
      return `<span class="atlas-pill atlas-pill--${derived[1]}">${escapeHtml(derived[0])}</span>`;
    }
    return pill(item?.status);
  }
  function channelText(list) {
    const names = (Array.isArray(list) ? list : []).map((key) => CHANNELS[key] || humanize(key));
    return names.length ? names.join(', ') : 'No channel';
  }
  function emptyMarkup(icon, title, text, action = '') {
    return `<div class="atlas-empty"><div class="atlas-empty__icon"><i data-lucide="${icon}"></i></div><h3 class="atlas-empty__title">${escapeHtml(title)}</h3>${text ? `<p class="atlas-empty__text">${escapeHtml(text)}</p>` : ''}${action ? `<div class="atlas-empty__actions">${action}</div>` : ''}</div>`;
  }
  function newPostButton(label = 'New post', variant = 'primary') {
    return state.staff?.can_create === false ? '' : `<button type="button" class="atlas-btn atlas-btn--${variant}" data-mk-new><i data-lucide="plus"></i>${label}</button>`;
  }
  function thumbMarkup(item, className = 'mk-thumb') {
    const cover = mediaOf(item)[0];
    if (cover?.thumb_url) return `<span class="${className}"><img src="${escapeHtml(cover.thumb_url)}" alt="${escapeHtml(cover.alt_text || `Cover of ${item.title}`)}" loading="lazy"></span>`;
    const icon = item.content_type === 'reel' ? 'clapperboard' : item.content_type === 'story' ? 'gallery-vertical-end' : item.content_type === 'campaign_task' ? 'list-checks' : 'image';
    return `<span class="${className} ${className}--empty" aria-hidden="true"><i data-lucide="${icon}"></i></span>`;
  }

  // Channel-level status (UX spec §5.10): never by colour alone — every dot
  // carries the channel letter and a text label.
  function channelStatus(item, platform) {
    const delivery = deliveriesOf(item).find((d) => d.provider_key === platform);
    if (delivery) {
      switch (delivery.status) {
        case 'published': return { key: 'published', label: 'Published', tone: 'positive', at: delivery.published_at, delivery };
        case 'publishing': return { key: 'publishing', label: 'Publishing', tone: 'info', delivery };
        case 'processing': return { key: 'processing', label: platform === 'tiktok' ? 'Processing on TikTok' : 'Processing', tone: 'info', delivery };
        case 'verifying': return { key: 'processing', label: 'Checking', tone: 'info', delivery };
        case 'retrying': return { key: 'publishing', label: 'Retrying', tone: 'info', at: delivery.next_attempt_at, delivery };
        case 'failed': return { key: 'failed', label: 'Failed', tone: 'danger', delivery };
        case 'needs_attention': return { key: 'failed', label: 'Needs attention', tone: 'danger', delivery };
        case 'cancelled': return { key: 'skipped', label: 'Not posted', tone: 'neutral', delivery };
        default: return autoPublishing()
          ? { key: 'scheduled', label: 'Scheduled', tone: 'neutral', at: delivery.due_at || item.scheduled_for, delivery }
          : { key: 'by_hand_due', label: 'Ready, not sent', tone: 'warning', delivery };
      }
    }
    if (item.status === 'pending_approval') return { key: 'waiting_approval', label: 'Waiting for approval', tone: 'info' };
    if (['draft', 'idea', 'changes_requested'].includes(item.status)) return { key: 'draft', label: 'Draft', tone: 'neutral' };
    if (item.status === 'published' || item.status === 'completed') return { key: 'posted_by_hand', label: 'Posted by hand', tone: 'positive', at: item.published_at };
    if (['approved', 'scheduled'].includes(item.status)) {
      const target = targetFor(platform);
      return target?.ready ? { key: 'scheduled', label: 'Scheduled', tone: 'neutral', at: item.scheduled_for } : { key: 'by_hand_due', label: 'Post by hand', tone: 'warning' };
    }
    return { key: 'skipped', label: STATUS[item.status]?.[0] || 'Not posted', tone: 'neutral' };
  }
  function dotsMarkup(item) {
    const platforms = CHANNEL_ORDER.filter((key) => (item.platforms || []).includes(key));
    if (!platforms.length) return '';
    return `<span class="mk-chans">${platforms.map((platform) => {
      const status = channelStatus(item, platform);
      const label = `${CHANNELS[platform]}: ${status.label}${status.at ? ` ${timeOnly(status.at)}` : ''}`;
      return `<span class="mk-chan mk-chan--${status.key}" role="img" aria-label="${escapeHtml(label)}" data-atlas-tooltip="${escapeHtml(label)}">${CHANNEL_LETTER[platform]}</span>`;
    }).join('')}</span>`;
  }

  function postRow(item, { linked = false } = {}) {
    return `<li class="atlas-row atlas-row--link${linked ? ' is-linked-target' : ''}" data-mk-row="${escapeHtml(item.id)}">${thumbMarkup(item)}
        <div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="atlas-link mk-link" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button></p><p class="atlas-row__meta">${escapeHtml([TYPES[item.content_type] || humanize(item.content_type), dateTime(item.scheduled_for)].join(' · '))}</p>${dotsMarkup(item)}</div>
        <div class="atlas-row__end">${postPill(item)}</div></li>`;
  }

  function attentionItems() {
    const out = [];
    items().forEach((item) => {
      deliveriesOf(item).filter((d) => ['failed', 'needs_attention'].includes(d.status)).forEach((delivery) => {
        const channel = CHANNEL_SHORT[delivery.provider_key] || humanize(delivery.provider_key);
        out.push({ item, delivery, title: `${channel} didn't publish`, text: (ATTENTION_TEXT[delivery.attention_reason] || ((c) => `${c} didn't accept the post. Open History to retry.`))(channel) });
      });
    });
    return out;
  }

  // ---------- tabs ----------

  function overviewMarkup() {
    const today = venueToday();
    const horizon = clock()?.addDays ? clock().addDays(today, 14) : today;
    const coming = items()
      .filter((item) => !FINAL.has(item.status) || item.publication_state === 'partial')
      .filter((item) => { const key = venueKey(item.scheduled_for || item.reminder_at); return key && key >= today && key <= horizon; })
      .sort((a, b) => String(a.scheduled_for || a.reminder_at).localeCompare(String(b.scheduled_for || b.reminder_at)));
    const waiting = items().filter((item) => item.status === 'pending_approval');
    const ideas = suggestions().filter((entry) => entry.available_for_today !== false);
    const problems = attentionItems();
    const reconnect = targets().filter((target) => ['needs_reauthorization', 'publishing_permission_missing', 'no_resource_selected'].includes(target.reason));
    const monthAhead = clock()?.addDays ? clock().addDays(today, 30) : today;
    const blocked = reconnect.length ? items().filter((item) => ['approved', 'scheduled', 'pending_approval'].includes(item.status))
      .filter((item) => { const key = venueKey(item.scheduled_for); return key && key >= today && key <= monthAhead; })
      .filter((item) => (item.platforms || []).some((p) => reconnect.some((t) => t.provider_key === p))) : [];
    const attention = problems.length || reconnect.length
      ? `<section class="atlas-section" aria-labelledby="mk-attention"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-attention">Needs attention</h2><span class="atlas-section__meta">${plural(problems.length + reconnect.length, 'item')}</span></div><ul class="atlas-list">
          ${problems.map(({ item, title, text }) => `<li class="atlas-row"><span class="atlas-row__icon atlas-row__icon--danger"><i data-lucide="circle-alert"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(title)} · ${escapeHtml(item.title)}</p><p class="atlas-row__meta">${escapeHtml(text)}</p></div><div class="atlas-row__end"><a class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" href="#marketing/history?post=${encodeURIComponent(item.id)}">Open in History</a></div></li>`).join('')}
          ${reconnect.map((target) => { const name = CHANNELS[target.provider_key] || humanize(target.provider_key); return `<li class="atlas-row"><span class="atlas-row__icon atlas-row__icon--warning"><i data-lucide="plug"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(target.reason === 'no_resource_selected' ? `${name}: choose where to post` : target.reason === 'publishing_permission_missing' ? `${name} can't publish yet` : `${name} needs reconnecting`)}</p><p class="atlas-row__meta">${escapeHtml(blocked.length ? `${plural(blocked.length, 'post')} in the next 30 days can't be published there until this is fixed.` : 'Scheduled posts won’t publish there until this is fixed.')}</p></div><div class="atlas-row__end"><a class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" href="#settings/integrations?provider=${encodeURIComponent(target.provider_key)}">Fix in Settings</a></div></li>`; }).join('')}
        </ul></section>` : '';
    return `${attention}<section class="atlas-section" aria-labelledby="mk-coming"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-coming">Coming up</h2><span class="atlas-section__meta">Next 14 days</span></div>
        ${coming.length ? `<ul class="atlas-list">${coming.map((item) => postRow(item)).join('')}</ul>` : emptyMarkup('calendar', 'Nothing planned yet', 'Plan a post, story or campaign task and it shows here two weeks ahead.', newPostButton('New post', 'secondary'))}</section>
      <section class="atlas-section" aria-labelledby="mk-waiting"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-waiting">Waiting for approval</h2></div>
        ${waiting.length ? `<ul class="atlas-list">${waiting.map((item) => `<li class="atlas-row">${thumbMarkup(item)}<div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="atlas-link mk-link" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button></p><p class="atlas-row__meta">${escapeHtml([item.created_by_label, dateTime(item.scheduled_for)].filter(Boolean).join(' · '))}</p>${dotsMarkup(item)}</div><div class="atlas-row__end">${item.can_approve ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" data-mk-open="${escapeHtml(item.id)}">Review</button>` : pill(item.status)}</div></li>`).join('')}</ul>` : '<p class="mk-muted">Nothing is waiting for approval.</p>'}</section>
      ${ideas.length ? `<section class="atlas-section" aria-labelledby="mk-ideas"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-ideas">Suggestions</h2><span class="atlas-section__meta">From your venue's routines. Suggestions are never posted without approval.</span></div>
        <ul class="atlas-list">${ideas.map((entry) => `<li class="atlas-row${state.focusSuggestion && String(entry.id) === state.focusSuggestion ? ' is-linked-target' : ''}" data-mk-suggestion="${escapeHtml(entry.id)}"${state.focusSuggestion && String(entry.id) === state.focusSuggestion ? ' aria-current="true"' : ''}><span class="atlas-row__icon"><i data-lucide="lightbulb"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(entry.title)} <span class="atlas-pill">Suggestion</span></p><p class="atlas-row__meta">${escapeHtml(entry.summary || '')}</p></div><div class="atlas-row__end">${entry.is_due_today && state.staff?.can_create !== false ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" data-mk-plan="${escapeHtml(entry.id)}">Plan this</button>` : ''}</div></li>`).join('')}</ul></section>` : ''}`;
  }

  function calendarEntries() {
    const range = monthRange();
    const byDay = new Map();
    items().forEach((item) => {
      if (state.channelFilter !== 'all' && !(item.platforms || []).includes(state.channelFilter)) return;
      if (item.status === 'cancelled') return;
      const key = venueKey(item.scheduled_for || item.reminder_at || item.event_starts_at);
      if (!key) return;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(item);
    });
    byDay.forEach((list) => list.sort((a, b) => String(a.scheduled_for || a.reminder_at || '').localeCompare(String(b.scheduled_for || b.reminder_at || ''))));
    return { range, byDay };
  }

  function entryClass(item) {
    if (deliveriesOf(item).some((d) => ['failed', 'needs_attention'].includes(d.status))) return ' is-failed';
    if (item.status === 'pending_approval') return ' is-waiting';
    return '';
  }

  function calendarMarkup() {
    const c = clock();
    const { range, byDay } = calendarEntries();
    const first = range.start;
    const lead = c?.weekday ? (c.weekday(first) + 6) % 7 : 0;
    const start = c?.addDays ? c.addDays(first, -lead) : first;
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const key = c?.addDays ? c.addDays(start, i) : first;
      if (i >= 35 && key > range.end) break;
      cells.push(key);
    }
    const today = venueToday();
    const monthName = c?.formatDate ? c.formatDate(first, { long: true, year: true }).split(' ').slice(2).join(' ') : range.month;
    const filters = [['all', 'All'], ...CHANNEL_ORDER.map((key) => [key, CHANNEL_SHORT[key]])];
    const entry = (item) => `<button type="button" class="mk-day__item${entryClass(item)}" data-mk-open="${escapeHtml(item.id)}" aria-label="${escapeHtml(`${item.title}, ${item.scheduled_for ? timeOnly(item.scheduled_for) : 'no time'}, ${STATUS[item.status]?.[0] || ''}`)}">${thumbMarkup(item, 'mk-day__thumb')}<span class="mk-day__time num">${escapeHtml(item.scheduled_for ? timeOnly(item.scheduled_for) : '—')}</span><span class="mk-day__title">${escapeHtml(item.title)}</span>${dotsMarkup(item)}</button>`;
    const inMonth = [...byDay.entries()].filter(([key]) => key >= range.start && key <= range.end).sort(([a], [b]) => a.localeCompare(b));
    return `<div class="atlas-toolbar mk-cal-toolbar"><div class="atlas-btn-group"><button type="button" class="atlas-icon-btn" data-mk-month="-1" aria-label="Previous month"><i data-lucide="chevron-left"></i></button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mk-month="0">This month</button><button type="button" class="atlas-icon-btn" data-mk-month="1" aria-label="Next month"><i data-lucide="chevron-right"></i></button></div><h2 class="mk-month">${escapeHtml(monthName)}</h2>
        <div class="atlas-chips mk-cal-filter" role="group" aria-label="Channel">${filters.map(([key, label]) => `<button type="button" class="atlas-chip" aria-pressed="${state.channelFilter === key}" data-mk-channel-filter="${key}">${escapeHtml(label)}</button>`).join('')}</div></div>
      <details class="mk-legend"><summary>What the dots mean</summary><ul class="mk-legend__list">${[['scheduled', 'Scheduled'], ['waiting_approval', 'Waiting for approval'], ['by_hand_due', 'Post by hand or not sent yet'], ['publishing', 'Publishing'], ['published', 'Published'], ['posted_by_hand', 'Posted by hand'], ['failed', 'Failed or needs attention'], ['skipped', 'Not posted']].map(([key, label]) => `<li><span class="mk-chan mk-chan--${key}" aria-hidden="true">I</span>${escapeHtml(label)}</li>`).join('')}</ul><p class="mk-muted">Letters are the channels: I Instagram, F Facebook, T TikTok, G Google Business Profile.</p></details>
      <div class="mk-calendar" role="grid" aria-label="${escapeHtml(monthName)}">
        <div class="mk-calendar__head" role="row">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span role="columnheader">${d}</span>`).join('')}</div>
        <div class="mk-calendar__grid">${cells.map((key) => {
          const list = byDay.get(key) || [];
          const outside = key < range.start || key > range.end;
          const expanded = state.expandedDay === key;
          const shown = expanded ? list : list.slice(0, 3);
          return `<div class="mk-day${outside ? ' is-outside' : ''}${key === today ? ' is-today' : ''}" role="gridcell" aria-label="${escapeHtml(dateOnly(key))}${list.length ? `, ${list.length} planned` : ''}">
            <button type="button" class="mk-day__num" data-mk-new-on="${key}" aria-label="New post on ${escapeHtml(dateOnly(key))}">${Number(key.slice(8, 10))}</button>
            ${shown.map(entry).join('')}${list.length > 3 ? `<button type="button" class="atlas-link mk-day__more" data-mk-expand-day="${key}">${expanded ? 'Show less' : `+${list.length - 3} more`}</button>` : ''}
          </div>`;
        }).join('')}</div>
      </div>
      ${agendaMarkup(inMonth, range, monthName)}`;
  }

  // Phone (< 768): agenda grouped by day; today always shown; earlier days collapsed.
  function agendaMarkup(inMonth, range, monthName) {
    const today = venueToday();
    const c = clock();
    const tomorrow = c?.addDays ? c.addDays(today, 1) : null;
    const dayLabel = (key) => `${dateOnly(key)}${key === today ? ' · Today' : key === tomorrow ? ' · Tomorrow' : ''}`;
    const row = (item) => `<li class="atlas-row atlas-row--link">${thumbMarkup(item)}<div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="atlas-link mk-link" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button></p><p class="atlas-row__meta">${escapeHtml([item.scheduled_for ? timeOnly(item.scheduled_for) : 'No time', TYPES[item.content_type] || humanize(item.content_type)].join(' · '))}</p>${dotsMarkup(item)}</div><div class="atlas-row__end">${postPill(item)}</div></li>`;
    const group = (key, list) => `<section class="mk-agenda__day"><h3 class="mk-agenda__head">${escapeHtml(dayLabel(key))}</h3>${list.length ? `<ul class="atlas-list">${list.map(row).join('')}</ul>` : '<p class="mk-muted">Nothing today.</p>'}</section>`;
    const inRange = today >= range.start && today <= range.end;
    const earlier = inRange ? inMonth.filter(([key]) => key < today) : [];
    const later = inRange ? inMonth.filter(([key]) => key > today) : inMonth;
    const todayList = inRange ? (inMonth.find(([key]) => key === today)?.[1] || []) : null;
    if (!inMonth.length && !inRange) return `<div class="mk-agenda">${emptyMarkup('calendar', `Nothing planned in ${monthName.split(' ')[0]}`, 'Plan a post and it shows here.', newPostButton('New post', 'secondary'))}</div>`;
    return `<div class="mk-agenda">${earlier.length ? `<details class="mk-agenda__earlier"><summary>Earlier this month (${earlier.reduce((n, [, list]) => n + list.length, 0)})</summary>${earlier.map(([key, list]) => group(key, list)).join('')}</details>` : ''}${todayList ? group(today, todayList) : ''}${later.map(([key, list]) => group(key, list)).join('')}</div>`;
  }

  function postsMarkup() {
    const waitingCount = items().filter((item) => item.status === 'pending_approval').length;
    const filter = state.postFilter || (waitingCount ? 'approval' : 'active');
    const filters = [['active', 'Active'], ['drafts', 'Drafts'], ['approval', 'Waiting'], ['approved', 'Approved']];
    const list = items().filter((item) => {
      if (filter === 'drafts') return ['idea', 'draft', 'changes_requested'].includes(item.status);
      if (filter === 'approval') return item.status === 'pending_approval';
      if (filter === 'approved') return ['approved', 'scheduled'].includes(item.status);
      return !FINAL.has(item.status);
    });
    return `<div class="atlas-toolbar"><div class="atlas-segmented" role="group" aria-label="Show">${filters.map(([key, label]) => `<button type="button" aria-pressed="${filter === key}" data-mk-filter="${key}">${label}</button>`).join('')}</div><div class="atlas-toolbar__end">${plural(list.length, 'post')}</div></div>
      ${list.length ? `<ul class="atlas-list">${list.map((item) => postRow(item)).join('')}</ul>` : emptyMarkup('file-pen-line', 'No posts here', 'Drafts, posts waiting for approval and approved posts appear here.', newPostButton('New post', 'secondary'))}`;
  }

  function mediaMarkup() {
    return '<div class="mk-media-slot" data-mk-media-slot></div>';
  }

  // The Media tab belongs to AtlasMarketingMedia (marketing-media.js). Its
  // host element is created once and moved into each render so the library
  // keeps its own state (queue, filters) across Marketing renders.
  function attachMedia(element) {
    const slot = element.querySelector('[data-mk-media-slot]');
    if (!slot) return;
    if (!state.mediaHost) {
      state.mediaHost = document.createElement('div');
      state.mediaHost.className = 'mk-media-host';
    }
    slot.replaceWith(state.mediaHost);
    const media = window.AtlasMarketingMedia;
    if (media?.mount && !state.mediaMounted) {
      state.mediaMounted = true;
      try { media.mount(state.mediaHost, { mode: 'library' }); } catch { state.mediaMounted = false; }
    }
    if (!state.mediaMounted) {
      state.mediaHost.innerHTML = emptyMarkup('images', 'The media library is loading', 'If it doesn’t appear, reload Atlas. Your files are safe.', '<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-media-retry>Try again</button>');
      ensureMediaModule().then(() => { if (window.AtlasMarketingMedia?.mount && state.tab === 'media' && !state.composer && visible()) render(); });
    }
  }

  // marketing-media.js loads with the Marketing view (config.js); the shell's
  // loader deduplicates, so this only waits for the same script.
  function ensureMediaModule() {
    if (window.AtlasMarketingMedia) return Promise.resolve(window.AtlasMarketingMedia);
    if (state.mediaLoading) return state.mediaLoading;
    const src = document.querySelector('script[src*="assets/js/marketing-media.js"]')?.getAttribute('src') || 'assets/js/marketing-media.js';
    state.mediaLoading = Promise.resolve(window.AtlasShell?.load?.(src, { global: 'AtlasMarketingMedia' })).catch(() => null).finally(() => { state.mediaLoading = null; });
    return state.mediaLoading;
  }

  function campaignsMarkup() {
    const list = campaigns();
    return `<div class="atlas-toolbar"><div class="atlas-toolbar__end">${state.staff?.can_approve ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mk-new-campaign><i data-lucide="plus"></i>New campaign</button>' : ''}</div></div>
      ${list.length ? `<ul class="atlas-list">${list.map((campaign) => `<li class="atlas-row"><span class="atlas-row__icon"><i data-lucide="target"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(campaign.name)}</p><p class="atlas-row__meta">${escapeHtml([humanize(campaign.campaign_type), `${dateOnly(campaign.start_date)} – ${dateOnly(campaign.end_date)}`, channelText(campaign.platforms)].join(' · '))}</p>${campaign.description ? `<p class="atlas-row__meta">${escapeHtml(campaign.description)}</p>` : ''}</div><div class="atlas-row__end">${pill(campaign.status)}</div></li>`).join('')}</ul>` : emptyMarkup('target', 'No campaigns yet', 'Group posts and tasks around one goal, such as a menu launch or an event.', state.staff?.can_approve ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-new-campaign>New campaign</button>' : '')}`;
  }

  // One row per channel: status, time, link, and Retry on a failed channel only.
  function deliveryRows(item, { compact = false } = {}) {
    const platforms = CHANNEL_ORDER.filter((key) => (item.platforms || []).includes(key));
    return platforms.map((platform) => {
      const status = channelStatus(item, platform);
      const delivery = status.delivery;
      const name = CHANNELS[platform];
      const short = CHANNEL_SHORT[platform];
      const failed = status.key === 'failed';
      const reason = delivery?.attention_reason;
      const target = targetFor(platform);
      const needsFix = failed && RETRY_NEEDS_FIX.has(reason) && !target?.ready;
      const message = failed ? (ATTENTION_TEXT[reason] || ((c) => `${c} didn't accept the post. Retry, or check the details.`))(name) : '';
      const when = status.at ? dateTime(status.at, '') : '';
      const link = delivery?.provider_permalink && status.key === 'published' ? `<a class="atlas-link" href="${escapeHtml(delivery.provider_permalink)}" target="_blank" rel="noopener">View on ${escapeHtml(short)}<i data-lucide="arrow-up-right"></i></a>` : '';
      const retry = failed && delivery && state.staff?.can_publish !== false
        ? (needsFix
          ? `<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#settings/integrations?provider=${encodeURIComponent(platform)}">Reconnect ${escapeHtml(short)} first</a>`
          : `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm mk-retry" data-mk-retry-delivery="${escapeHtml(delivery.id)}" data-mk-channel="${escapeHtml(platform)}" data-mk-content="${escapeHtml(item.id)}">Retry ${escapeHtml(short)}</button>`)
        : '';
      const more = failed && delivery && state.staff?.can_publish !== false
        ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mk-mark-posted="${escapeHtml(delivery.id)}" data-mk-channel="${escapeHtml(platform)}">Mark posted by hand</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mk-skip-delivery="${escapeHtml(delivery.id)}" data-mk-channel="${escapeHtml(platform)}">Don't post to ${escapeHtml(short)}</button>`
        : '';
      return `<li class="atlas-row atlas-row--compact mk-history-channel${failed ? ' is-failed' : ''}" data-mk-delivery-row="${escapeHtml(platform)}">
          <span class="mk-chan mk-chan--${status.key}" aria-hidden="true">${CHANNEL_LETTER[platform]}</span>
          <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(name)} <span class="mk-channel-state">${escapeHtml(status.label)}${when ? ` · ${escapeHtml(when)}` : ''}</span></p>${message ? `<p class="atlas-row__meta mk-channel-error">${escapeHtml(message)}</p>` : ''}${delivery?.target_kind && !compact ? `<p class="atlas-row__meta">${escapeHtml(FORMAT_LABEL[delivery.target_kind] || humanize(delivery.target_kind))}</p>` : ''}</div>
          <div class="atlas-row__end mk-channel-actions">${link}${retry}${more}</div></li>`;
    }).join('');
  }

  function historyMarkup() {
    const filters = [['all', 'All'], ['failed', 'Failed'], ['published', 'Published'], ['by_hand', 'Posted by hand']];
    const relevant = items().filter((item) => deliveriesOf(item).length || ['published', 'completed', 'cancelled', 'rejected'].includes(item.status));
    const list = relevant.filter((item) => {
      const d = deliveriesOf(item);
      if (state.historyFilter === 'failed') return d.some((x) => ['failed', 'needs_attention'].includes(x.status));
      if (state.historyFilter === 'published') return d.some((x) => x.status === 'published');
      if (state.historyFilter === 'by_hand') return !d.length && ['published', 'completed'].includes(item.status);
      return true;
    }).sort((a, b) => String(b.scheduled_for || b.published_at || b.updated_at || '').localeCompare(String(a.scheduled_for || a.published_at || a.updated_at || '')));
    const groups = new Map();
    list.forEach((item) => { const key = venueKey(item.scheduled_for || item.published_at || item.updated_at) || 'none'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); });
    const posts = [...groups.entries()].map(([key, group]) => `<section class="mk-agenda__day"><h3 class="mk-agenda__head">${escapeHtml(key === 'none' ? 'No date' : dateOnly(key))}</h3><ul class="atlas-list mk-history">${group.map((item) => {
      const linked = state.linkedPost === item.id;
      return `<li class="mk-history__post${linked ? ' is-linked-target' : ''}" data-mk-history-post="${escapeHtml(item.id)}"><div class="atlas-row">${thumbMarkup(item)}<div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="atlas-link mk-link" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button></p><p class="atlas-row__meta">${escapeHtml([dateTime(item.scheduled_for || item.published_at, 'No time'), TYPES[item.content_type] || humanize(item.content_type)].join(' · '))}</p></div><div class="atlas-row__end">${postPill(item)}<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-mk-history-details="${escapeHtml(item.id)}">Details</button></div></div>
        <ul class="atlas-list mk-history__channels">${deliveryRows(item)}</ul></li>`;
    }).join('')}</ul></section>`).join('');
    return `<div class="atlas-toolbar"><div class="atlas-chips" role="group" aria-label="Show">${filters.map(([key, label]) => `<button type="button" class="atlas-chip" aria-pressed="${state.historyFilter === key}" data-mk-history-filter="${key}">${label}</button>`).join('')}</div></div>
      ${list.length ? posts : emptyMarkup('history', state.historyFilter === 'all' ? 'Nothing published yet' : 'Nothing here', 'Posts appear here once they go out, with each channel’s result.')}
      <details class="mk-activity"><summary>All activity</summary>${history().length ? `<ul class="atlas-list">${history().map((event) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(HISTORY_LABELS[event.event_type] || humanize(event.event_type))}${event.payload?.provider_key ? ` · ${escapeHtml(CHANNELS[event.payload.provider_key] || '')}` : ''}${event.payload?.title ? ` · ${escapeHtml(event.payload.title)}` : ''}</p><p class="atlas-row__meta">${escapeHtml(event.actor_label || 'Atlas')} · ${escapeHtml(dateTime(event.created_at, '—'))}</p></div></li>`).join('')}</ul>` : '<p class="mk-muted">No marketing activity yet.</p>'}</details>`;
  }

  // Header caption from publishing capability (UX spec §3; architecture §0.2).
  function captionMarkup() {
    const settings = isManager() ? ' <a href="#settings/integrations">Integrations in Settings</a>' : '';
    const reconnect = targets().filter((target) => target.reason === 'needs_reauthorization');
    if (reconnect.length) {
      const target = reconnect[0];
      const name = CHANNELS[target.provider_key] || humanize(target.provider_key);
      const affected = items().filter((item) => ['approved', 'scheduled'].includes(item.status) && (item.platforms || []).includes(target.provider_key)).length;
      return `<div class="atlas-alert atlas-alert--warning mk-caption-alert" role="status"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(name)} needs reconnecting</p><p class="atlas-alert__body">Scheduled ${escapeHtml(name)} posts won't publish until someone reconnects.${affected ? ` ${escapeHtml(plural(affected, 'post'))} ${affected === 1 ? 'is' : 'are'} affected.` : ''}</p></div><div class="atlas-alert__actions"><a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#settings/integrations?provider=${encodeURIComponent(target.provider_key)}">Reconnect</a></div></div>`;
    }
    const ready = CHANNEL_ORDER.filter((key) => targetFor(key)?.ready);
    const notReady = CHANNEL_ORDER.filter((key) => !ready.includes(key));
    let text;
    if (!ready.length) text = 'Atlas can\'t publish yet, so you post by hand and mark it here. Connect accounts in Settings.';
    else if (!autoPublishing()) text = 'Automatic publishing is off, so Atlas doesn\'t publish yet. Approved posts wait as “Ready, not sent”. An administrator can turn it on in Settings › Marketing.';
    else if (notReady.length) text = `Atlas publishes approved posts to ${listText(ready.map((key) => CHANNELS[key]))}. ${listText(notReady.map((key) => CHANNELS[key]))} ${notReady.length === 1 ? 'is' : 'are'} posted by hand.`;
    else text = 'Atlas publishes approved posts at their scheduled time.';
    return `<p class="mk-caption">${escapeHtml(text)}${settings}</p>`;
  }

  function headSub() {
    if (!state.workspace) return 'Posts, campaigns and approvals';
    const scheduled = items().filter((item) => item.status === 'scheduled' && item.publication_state !== 'published').length;
    const waiting = items().filter((item) => item.status === 'pending_approval').length;
    const failed = attentionItems().length;
    const parts = [scheduled ? `${scheduled} scheduled` : '', waiting ? `${waiting} waiting for approval` : '', failed ? `${failed} failed` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Nothing planned';
  }

  function render() {
    const element = host();
    if (!element) return;
    if (!isManager()) {
      element.innerHTML = `<div class="atlas-page mk-page">${window.AtlasShell.pageHead({ title: 'Marketing' })}${emptyMarkup('lock', 'Marketing is for managers', 'Ask an administrator for access.', '<a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a>')}</div>`;
      window.lucide?.createIcons?.();
      return;
    }
    if (state.composer) { renderComposer(); return; }
    const actions = [{ label: 'Ask Atlas', icon: 'sparkles', variant: 'ghost', attrs: { 'data-mk-ask': '' } }];
    if (state.staff?.can_create !== false) actions.push({ label: 'New post', icon: 'plus', variant: 'primary', attrs: { 'data-mk-new': '' } });
    const waiting = items().filter((item) => item.status === 'pending_approval').length;
    const failed = attentionItems().length;
    let body;
    if (state.error && !state.workspace) body = `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="circle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Marketing couldn't be loaded.</p><p class="atlas-alert__body">${escapeHtml(errorText(state.error, 'Marketing'))}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mk-retry>Try again</button></div></div>`;
    else if (state.tab === 'media') body = mediaMarkup();
    else if (!state.workspace) body = `<div class="mk-skeleton" aria-busy="true" aria-label="Loading marketing">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(5)}</div>`;
    else body = ({ calendar: calendarMarkup, posts: postsMarkup, campaigns: campaignsMarkup, history: historyMarkup })[state.tab]?.() || overviewMarkup();
    element.innerHTML = `<div class="atlas-page mk-page">
        ${window.AtlasShell.pageHead({ title: 'Marketing', sub: headSub(), actions })}
        ${state.workspace ? captionMarkup() : ''}
        <nav class="atlas-tabs" aria-label="Marketing">${TABS.map(([key, label]) => `<a href="#marketing${key === 'overview' ? '' : `/${key}`}"${state.tab === key ? ' aria-current="page"' : ''}>${label}${key === 'posts' && waiting ? ` <span class="count">${waiting}</span>` : ''}${key === 'history' && failed ? ` <span class="count">${failed}</span>` : ''}</a>`).join('')}</nav>
        <div class="mk-body">${body}</div>
      </div>`;
    if (state.tab === 'media') attachMedia(element);
    window.lucide?.createIcons?.();
    // Six tabs overflow at 390 px: keep the active one in view.
    const tabs = element.querySelector('.atlas-tabs');
    const active = tabs?.querySelector('[aria-current="page"]');
    if (tabs && active && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = Math.max(0, active.getBoundingClientRect().left - tabs.getBoundingClientRect().left + tabs.scrollLeft - (tabs.clientWidth - active.offsetWidth) / 2);
    // #marketing?recommendation=<id> (Atlas AI record links): show that suggestion.
    if (state.focusSuggestion && state.workspace) {
      const row = [...element.querySelectorAll('[data-mk-suggestion]')].find((node) => node.dataset.mkSuggestion === state.focusSuggestion);
      if (row) { row.scrollIntoView({ block: 'center' }); row.querySelector('[data-mk-plan]')?.focus({ preventScroll: true }); }
      state.focusSuggestion = null;
    }
    if (state.linkedPost && state.tab === 'history' && state.workspace) {
      element.querySelector(`[data-mk-history-post="${CSS.escape(state.linkedPost)}"]`)?.scrollIntoView({ block: 'center' });
    }
  }

  // =====================================================================
  // Composer (#marketing/new, #marketing/post?id=<id>) — UX spec §5
  // =====================================================================

  function derivedWhen(item) {
    if (!item) return 'time';
    return item.scheduled_for ? 'time' : 'none';
  }

  function draftFromItem(item, { date = null, suggestion = null } = {}) {
    const options = item?.platform_options && typeof item.platform_options === 'object' ? item.platform_options : {};
    const tt = options.tiktok?.tiktok || {};
    const gbp = options['google-business-profile']?.gbp || {};
    const overrides = {};
    const kinds = {};
    CHANNEL_ORDER.forEach((key) => {
      if (typeof options[key]?.caption === 'string') overrides[key] = options[key].caption;
      if (options[key]?.target_kind) kinds[key] = options[key].target_kind;
    });
    let reminder = 'off';
    if (item?.reminder_at && item?.scheduled_for) {
      const minutes = Math.round((Date.parse(item.scheduled_for) - Date.parse(item.reminder_at)) / 60000);
      reminder = REMINDERS.some(([key]) => key === String(minutes)) ? String(minutes) : 'off';
    }
    return {
      title: item?.title || suggestion?.title || '',
      content_type: item?.content_type || suggestion?.content_type || 'post',
      campaign_id: item?.campaign_id || '',
      platforms: [...(item?.platforms || suggestion?.platforms || [])],
      caption: item?.caption_draft || suggestion?.caption_draft || '',
      overrides,
      kinds,
      tiktok: {
        privacy_level: tt.privacy_level || '',
        allow_comment: tt.disable_comment === false,
        allow_duet: tt.disable_duet === false,
        allow_stitch: tt.disable_stitch === false,
        commercial: Boolean(tt.brand_content_toggle || tt.brand_organic_toggle),
        brand_organic: Boolean(tt.brand_organic_toggle),
        brand_content: Boolean(tt.brand_content_toggle),
        consent_confirmed_at: tt.consent_confirmed_at || null
      },
      gbp: {
        topic: gbp.topic_type || 'STANDARD',
        cta: gbp.call_to_action?.action_type || '',
        cta_url: gbp.call_to_action?.url || '',
        event_title: gbp.event?.title || '',
        event_start: gbp.event?.start ? inputValue(gbp.event.start) : '',
        event_end: gbp.event?.end ? inputValue(gbp.event.end) : '',
        coupon: gbp.offer?.coupon_code || '',
        redeem_url: gbp.offer?.redeem_online_url || '',
        terms: gbp.offer?.terms || ''
      },
      media: mediaOf(item).map((m) => ({ ...m })),
      when: item ? derivedWhen(item) : 'time',
      scheduled: item?.scheduled_for ? inputValue(item.scheduled_for) : date ? `${date}T` : '',
      reminder,
      note: ''
    };
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));

  function openComposer({ id = null, date = null, suggestion = null } = {}) {
    const item = id ? findItem(id) : null;
    const draft = draftFromItem(item, { date, suggestion });
    // "Use in new post" from the Media tab hands its photos and videos over once.
    if (!id) {
      let pending = null;
      try { pending = window.AtlasMarketingMedia?.takePendingUse?.() || null; } catch { pending = null; }
      if (Array.isArray(pending)) draft.media = pending.map(normalizeMedia).filter((m) => m.asset_id);
    }
    state.composer = {
      id: item?.id || null,
      requestedId: id,
      suggestion,
      draft,
      original: clone(draft),
      editing: !item || (item.can_edit !== false && EDITABLE.has(item.status)),
      pane: 'edit',
      preview: null,
      mounted: false,
      error: null,
      busy: false,
      uploads: 0,
      savedAt: null,
      checkTimer: null
    };
    state.creatorInfo = null;
    render();
  }

  function closeComposer() {
    state.composer = null;
    window.clearTimeout(state.pollTimer);
  }

  const composerItem = () => (state.composer?.id ? findItem(state.composer.id) : null);
  const dirty = () => Boolean(state.composer && state.composer.editing && JSON.stringify(state.composer.draft) !== JSON.stringify(state.composer.original));
  const isPostType = (type) => PUBLISHABLE.has(type);

  // ---- format (target kind) per channel ----

  function formatOptions(platform, draft) {
    const media = draft.media;
    const videos = media.filter((m) => m.kind === 'video');
    const images = media.filter((m) => m.kind !== 'video');
    const allowed = targetFor(platform)?.target_kinds;
    const offer = (list) => (Array.isArray(allowed) && allowed.length ? list.filter((kind) => allowed.includes(kind)) : list);
    switch (platform) {
      case 'instagram': {
        if (videos.length === 1 && media.length === 1) return offer(['ig_reel']);
        if (media.length > 1) return offer(['ig_carousel']);
        return offer(['ig_feed']);
      }
      case 'facebook': {
        if (!media.length) return offer(['fb_page_post']);
        if (videos.length === 1 && media.length === 1) {
          const v = videos[0];
          return offer(v.height > v.width ? ['fb_page_video', 'fb_reel'] : ['fb_page_video']);
        }
        return offer(['fb_page_photo']);
      }
      case 'tiktok': return offer(['tiktok_inbox_video', 'tiktok_video']).length ? offer(['tiktok_inbox_video', 'tiktok_video']) : ['tiktok_inbox_video'];
      case 'google-business-profile': return ['gbp_local_post'];
      default: return [];
    }
  }
  function kindFor(platform, draft) {
    const options = formatOptions(platform, draft);
    const chosen = draft.kinds[platform];
    return options.includes(chosen) ? chosen : options[0] || null;
  }

  function platformOptionsPayload(draft) {
    const out = {};
    draft.platforms.forEach((platform) => {
      const entry = { caption: typeof draft.overrides[platform] === 'string' ? draft.overrides[platform] : null, target_kind: kindFor(platform, draft) };
      if (platform === 'tiktok') {
        const t = draft.tiktok;
        entry.tiktok = {
          privacy_level: t.privacy_level || null,
          disable_comment: !t.allow_comment,
          disable_duet: !t.allow_duet,
          disable_stitch: !t.allow_stitch,
          brand_organic_toggle: Boolean(t.commercial && t.brand_organic),
          brand_content_toggle: Boolean(t.commercial && t.brand_content),
          consent_confirmed_at: t.consent_confirmed_at || null
        };
      }
      if (platform === 'google-business-profile') {
        const g = draft.gbp;
        const gbp = { topic_type: g.topic };
        if (g.cta && g.topic !== 'OFFER') gbp.call_to_action = { action_type: g.cta, url: g.cta === 'CALL' ? null : g.cta_url || null };
        if (g.topic === 'EVENT' || g.topic === 'OFFER') gbp.event = { title: g.event_title || null, start: fromInput(g.event_start), end: fromInput(g.event_end) };
        if (g.topic === 'OFFER') gbp.offer = { coupon_code: g.coupon || null, redeem_online_url: g.redeem_url || null, terms: g.terms || null };
        entry.gbp = gbp;
      }
      out[platform] = entry;
    });
    return out;
  }

  function scheduledInstant(draft) {
    return draft.when === 'time' ? fromInput(draft.scheduled) : null;
  }

  function contentFields(draft) {
    const scheduled = scheduledInstant(draft);
    const minutes = Number(draft.reminder);
    return {
      title: draft.title.trim(),
      campaign_id: draft.campaign_id || null,
      platforms: [...draft.platforms],
      caption_draft: draft.caption,
      scheduled_for: scheduled,
      reminder_at: scheduled && Number.isFinite(minutes) && minutes > 0 ? new Date(Date.parse(scheduled) - minutes * 60000).toISOString() : null,
      platform_options: platformOptionsPayload(draft)
    };
  }
  const mediaPayload = (draft) => draft.media.map((m, index) => ({ asset_id: m.asset_id, variant_id: m.variant_id || null, collection_id: m.collection_id || null, role: index === 0 ? 'cover' : 'item' }));

  // ---- checks (UX spec §5.8): must fix vs worth checking ----

  function captionFor(platform, draft) {
    return typeof draft.overrides[platform] === 'string' ? draft.overrides[platform] : draft.caption;
  }
  const hashtags = (text) => (String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const duration = (ms) => { const s = Math.round(Number(ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function localChecks(draft, { purpose = 'submit' } = {}) {
    const must = [];
    const worth = [];
    const add = (list, message, field, platform = null) => list.push({ message, field, platform });
    if (!draft.title.trim()) add(must, 'Give the post a title.', 'title');
    const posting = isPostType(draft.content_type);
    if (posting && !draft.platforms.length) add(must, 'Choose at least one channel.', 'channels');
    const media = draft.media;
    const videos = media.filter((m) => m.kind === 'video');
    const images = media.filter((m) => m.kind !== 'video');
    const rulesLoaded = Boolean(window.AtlasPlatformRules?.validate);
    draft.platforms.forEach((platform) => {
      const name = CHANNELS[platform];
      const caption = captionFor(platform, draft);
      const limit = CAPTION_LIMIT[platform];
      const target = targetFor(platform);
      if (!target?.ready) {
        const reason = target?.reason || 'not_connected';
        const text = (REASON_TEXT[reason] || REASON_TEXT.not_connected)(name);
        if (reason === 'needs_reauthorization' && purpose === 'publish') add(must, text, 'channels', platform);
        else add(worth, text, 'channels', platform);
      }
      if (platform === 'tiktok' && draft.tiktok.commercial && kindFor('tiktok', draft) === 'tiktok_video' && !draft.tiktok.brand_organic && !draft.tiktok.brand_content) add(must, 'Choose whether this promotes your brand, another brand, or both.', 'tiktok-commercial', platform);
      // TikTok Direct Post: the worker refuses it without the recorded consent.
      if (platform === 'tiktok' && kindFor('tiktok', draft) === 'tiktok_video' && !draft.tiktok.consent_confirmed_at) add(must, `Confirm TikTok's ${draft.tiktok.commercial && draft.tiktok.brand_content ? 'Branded Content Policy and ' : ''}Music Usage Confirmation before this can be approved.`, 'tiktok-consent', platform);
      // Provider limits come from the shared rules when they are loaded.
      if (rulesLoaded) return;
      if (limit && caption.length > limit) add(must, `${name} caption is ${number(caption.length)} characters; the limit is ${number(limit)}. Shorten it or write a shorter ${name} caption.`, typeof draft.overrides[platform] === 'string' ? `override-${platform}` : 'caption', platform);
      if (platform === 'instagram') {
        if (!media.length) add(must, 'Instagram needs at least one photo or video.', 'media', platform);
        if (media.length > 10) add(must, `Instagram carousels take up to 10 photos or videos. Remove ${media.length - 10}.`, 'media', platform);
        if (hashtags(caption) > 30) add(must, `Instagram allows up to 30 hashtags. This caption has ${hashtags(caption)}.`, 'caption', platform);
        if (media.length === 1 && videos.length === 1 && videos[0].duration_ms) {
          const s = videos[0].duration_ms / 1000;
          if (s < 3 || s > 900) add(must, `Instagram Reels must be 3 seconds to 15 minutes. This video is ${s < 60 ? `${Math.round(s)} seconds` : duration(videos[0].duration_ms)}.`, 'media', platform);
        }
      }
      if (platform === 'tiktok') {
        if (!videos.length) add(must, 'TikTok needs one video.', 'media', platform);
        else if (media.length > 1) add(must, 'TikTok posts take one video. Remove the other photos or videos, or turn off TikTok.', 'media', platform);
        const max = state.creatorInfo?.max_video_post_duration_sec;
        if (max && videos[0]?.duration_ms && videos[0].duration_ms / 1000 > max) add(must, `TikTok: this account can post videos up to ${Math.round(max / 60)} minutes. This one is ${duration(videos[0].duration_ms)}.`, 'media', platform);
        if (kindFor('tiktok', draft) === 'tiktok_video') {
          if (!draft.tiktok.privacy_level) add(must, 'Choose who can see it on TikTok.', 'tiktok-privacy', platform);
          if (draft.tiktok.brand_content && draft.tiktok.privacy_level === 'SELF_ONLY') add(must, 'Branded content can\'t be private. Choose Everyone or Friends.', 'tiktok-privacy', platform);
        }
      }
      if (platform === 'google-business-profile') {
        const g = draft.gbp;
        if (videos.length) add(must, 'Google Business Profile can\'t post videos. Remove the video or turn off Google Business Profile.', 'media', platform);
        if (images.length > 1) add(worth, 'Google Business Profile uses only the first photo.', 'media', platform);
        if (/(?:\+?\d[\d ()-]{6,}\d)/.test(caption)) add(must, 'Google removes posts with a phone number in the text. Use the Call now button instead.', 'caption', platform);
        if (g.topic !== 'OFFER' && g.cta && g.cta !== 'CALL') {
          if (!g.cta_url.trim()) add(must, 'Add the link the button opens.', 'gbp-cta-url', platform);
          else if (!/^https:\/\/\S+$/i.test(g.cta_url.trim())) add(must, 'Enter a full link starting with https://', 'gbp-cta-url', platform);
        }
        if (g.topic === 'EVENT' || g.topic === 'OFFER') {
          if (!g.event_title.trim()) add(must, g.topic === 'EVENT' ? 'Give the Google event a title.' : 'Give the Google offer a title.', 'gbp-title', platform);
          if (!fromInput(g.event_start) || !fromInput(g.event_end)) add(must, 'Add when the event starts and ends.', 'gbp-start', platform);
          else if (fromInput(g.event_end) < fromInput(g.event_start)) add(must, 'The event ends before it starts.', 'gbp-end', platform);
        }
        if (g.redeem_url && !/^https:\/\/\S+$/i.test(g.redeem_url.trim())) add(must, 'Enter a full link starting with https://', 'gbp-redeem', platform);
      }
    });
    if (!rulesLoaded) media.forEach((m, index) => { if (m.kind !== 'video' && m.alt_text === '') add(worth, `Photo ${index + 1} has no alt text. Add it so people using screen readers know what it shows.`, 'media'); });
    if (draft.when === 'time') {
      const at = scheduledInstant(draft);
      if (draft.scheduled && !at) add(must, 'Enter a full date and time, or choose No time yet.', 'when');
      else if (!at && posting) add(must, 'Choose when it posts, or choose No time yet.', 'when');
      else if (at) {
        const diff = Date.parse(at) - Date.now();
        if (diff < 0 && purpose !== 'approve') add(must, 'Choose a time in the future.', 'when');
        else if (diff >= 0 && diff < 15 * 60000) add(worth, `This is in ${Math.max(1, Math.round(diff / 60000))} minutes. If approval takes longer, it posts as soon as it's approved.`, 'when');
      }
    }
    if (state.composer?.uploads) add(must, `Wait for ${plural(state.composer.uploads, 'upload')} to finish.`, 'media');
    return { must, worth };
  }

  // The shared platform rules (marketing-platform-rules.js, generated from the
  // worker's rules) add the provider limits; the server applies them again.
  const RULE_FIELDS = [
    [/^no_channel$/, 'channels'], [/^time_past$/, 'when'], [/caption_length|hashtags|mentions|gbp_phone|_empty$/, 'caption'],
    [/^tiktok_privacy|tiktok_branded_private/, 'tiktok-privacy'], [/^tiktok_commercial/, 'tiktok-commercial'],
    [/^gbp_event_title/, 'gbp-title'], [/^gbp_event_(dates|order)/, 'gbp-start'], [/^gbp_cta/, 'gbp-cta-url'], [/^gbp_offer_link/, 'gbp-redeem']
  ];
  function ruleField(code, platform, draft) {
    const hit = RULE_FIELDS.find(([pattern]) => pattern.test(String(code || '')));
    const field = hit ? hit[1] : 'media';
    return field === 'caption' && platform && typeof draft.overrides[platform] === 'string' ? `override-${platform}` : field;
  }
  function ruleChecks(draft) {
    const rules = window.AtlasPlatformRules;
    if (!rules?.validate || !draft.platforms.length) return { must: [], worth: [] };
    let result;
    try {
      result = rules.validate({
        platforms: draft.platforms,
        caption: draft.caption,
        overrides: Object.fromEntries(Object.entries(draft.overrides).filter(([key]) => draft.platforms.includes(key))),
        media: draft.media.map((m) => ({ asset_id: m.asset_id, kind: m.kind, mime_type: m.mime_type, width: m.width, height: m.height, duration_ms: m.duration_ms, byte_size: m.byte_size, ...(m.alt_text !== undefined ? { alt_text: m.alt_text } : {}) })),
        options: platformOptionsPayload(draft),
        tiktok_creator_info: state.creatorInfo?.available ? state.creatorInfo : null
      });
    } catch {
      return { must: [], worth: [] };
    }
    const toEntry = (issue) => ({ message: String(issue.message), field: ruleField(issue.code, issue.platform, draft), platform: issue.platform || null, code: issue.code });
    return {
      must: (result?.errors || []).filter((x) => x?.message && x.code !== 'no_channel').map(toEntry),
      worth: (result?.warnings || []).filter((x) => x?.message && x.code !== 'not_ready').map(toEntry)
    };
  }

  function allChecks(draft, options) {
    const local = localChecks(draft, options);
    const rules = ruleChecks(draft);
    const seen = new Set();
    const uniq = (list) => list.filter((entry) => { const key = entry.message; if (seen.has(key)) return false; seen.add(key); return true; });
    return { must: uniq([...local.must, ...rules.must]), worth: uniq([...local.worth, ...rules.worth]) };
  }

  // ---- composer markup ----

  function readinessNote(draft) {
    if (!draft.platforms.length) return 'Choose where it goes. You can post to more than one channel.';
    const ready = draft.platforms.filter((p) => targetFor(p)?.ready);
    const lines = [];
    if (ready.length) lines.push(`${listText(ready.map((p) => CHANNELS[p]))}: ${autoPublishing() ? 'Atlas publishes' : 'Atlas can publish once automatic publishing is on'}.`);
    draft.platforms.filter((p) => !ready.includes(p)).forEach((p) => {
      const reason = targetFor(p)?.reason || 'not_connected';
      lines.push((REASON_TEXT[reason] || REASON_TEXT.not_connected)(CHANNELS[p]).replace(', so you\'ll post it by hand', ': you post it by hand'));
    });
    return lines.join(' ');
  }

  function stripMarkup(draft, editable) {
    if (!draft.media.length) {
      return `<div class="atlas-upload mk-strip-empty"><span class="atlas-upload__thumb" aria-hidden="true"><i data-lucide="image-plus"></i></span><div class="atlas-upload__body"><p class="atlas-upload__title">Add photos or videos</p><p class="atlas-upload__help">Instagram and TikTok need at least one. Up to 10 for a carousel.</p></div>${editable ? addMediaButton() : ''}</div>`;
    }
    return `<ol class="mk-strip" aria-label="Photos and videos in this post">${draft.media.map((m, index) => {
      const name = m.title || m.file_name || `${m.kind === 'video' ? 'Video' : 'Photo'} ${index + 1}`;
      return `<li class="mk-strip__item" data-mk-media-index="${index}"${editable ? ' draggable="true"' : ''}>
        <span class="mk-strip__thumb">${m.thumb_url ? `<img src="${escapeHtml(m.thumb_url)}" alt="${escapeHtml(m.alt_text || `${m.kind === 'video' ? 'Video' : 'Photo'}: ${name}`)}">` : `<i data-lucide="${m.kind === 'video' ? 'film' : 'image'}" aria-hidden="true"></i>`}</span>
        <span class="atlas-badge mk-strip__order" aria-hidden="true">${index + 1}</span>
        ${index === 0 ? '<span class="atlas-badge atlas-badge--muted mk-strip__cover">Cover</span>' : ''}
        ${m.kind === 'video' && m.duration_ms ? `<span class="atlas-badge atlas-badge--muted mk-strip__dur">${escapeHtml(duration(m.duration_ms))}</span>` : ''}
        ${editable ? `<span class="mk-strip__tools"><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mk-media-move="-1" aria-label="Move ${escapeHtml(name)} left"${index === 0 ? ' disabled' : ''}><i data-lucide="arrow-left"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mk-media-move="1" aria-label="Move ${escapeHtml(name)} right"${index === draft.media.length - 1 ? ' disabled' : ''}><i data-lucide="arrow-right"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mk-media-cover aria-label="Make ${escapeHtml(name)} the cover"${index === 0 ? ' disabled' : ''}><i data-lucide="star"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-mk-media-remove aria-label="Remove ${escapeHtml(name)} from post"><i data-lucide="x"></i></button></span>` : ''}
      </li>`;
    }).join('')}</ol>${editable ? `<div class="mk-strip-actions">${addMediaButton()}</div>` : ''}`;
  }

  function addMediaButton() {
    return `<span class="mk-add-media"><button type="button" class="atlas-btn atlas-btn--secondary" id="mk-add-media" data-mk-add-media><i data-lucide="image-plus"></i>Add media</button><ul class="atlas-menu" id="mk-add-media-menu" aria-label="Add media" hidden><li><button type="button" class="atlas-menu__item" data-mk-media-source="upload"><i data-lucide="upload"></i>Upload new</button></li><li><button type="button" class="atlas-menu__item" data-mk-media-source="library"><i data-lucide="images"></i>From library</button></li><li><button type="button" class="atlas-menu__item" data-mk-media-source="collection"><i data-lucide="layers"></i>From a collection</button></li></ul><input type="file" class="sr-only" id="mk-media-file" multiple accept="image/jpeg,image/png,image/heic,image/webp,video/mp4,video/quicktime" tabindex="-1" aria-hidden="true"></span>`;
  }

  function counterText(draft) {
    const common = draft.platforms.filter((p) => typeof draft.overrides[p] !== 'string');
    const limits = common.map((p) => [p, CAPTION_LIMIT[p]]).filter(([, limit]) => limit && limit < 10000).sort((a, b) => a[1] - b[1]);
    const count = draft.caption.length;
    if (!limits.length) return { text: `${number(count)} characters`, over: false };
    const [platform, limit] = limits[0];
    const strictest = limits.length > 1 ? ` · ${CHANNELS[platform]} is the shortest limit` : ` · ${CHANNELS[platform]}`;
    return { text: `${number(count)} / ${number(limit)}${strictest}`, over: count > limit };
  }

  function channelSummary(platform, draft) {
    const custom = typeof draft.overrides[platform] === 'string';
    const kind = kindFor(platform, draft);
    return `${custom ? 'Custom caption' : 'Uses the common caption'}${kind ? ` · ${FORMAT_LABEL[kind] || humanize(kind)}` : ''}`;
  }

  function tiktokSection(draft, editable) {
    const t = draft.tiktok;
    const info = state.creatorInfo;
    const direct = kindFor('tiktok', draft) === 'tiktok_video';
    const dis = editable ? '' : ' disabled';
    const options = info?.available && info.privacy_level_options?.length ? info.privacy_level_options : Object.keys(TIKTOK_PRIVACY);
    const privateOnly = info?.available && options.length === 1 && options[0] === 'SELF_ONLY';
    const who = info?.available && (info.username || info.nickname) ? `Posting as <strong>@${escapeHtml(info.username || info.nickname)}</strong>` : info && !info.available ? 'TikTok’s settings for this account couldn’t be read. Atlas checks them again before posting.' : 'Reading the TikTok account…';
    const check = (key, label, disabledByCreator) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" data-mk-tt="${key}"${t[key] ? ' checked' : ''}${disabledByCreator || !editable ? ' disabled' : ''}>${escapeHtml(label)}${disabledByCreator ? ' <span class="help">Turned off in your TikTok settings.</span>' : ''}</label>`;
    return `<div class="mk-channel__extra" data-mk-tiktok>
        <p class="mk-creator"><span class="atlas-avatar atlas-avatar--sm atlas-avatar--a" aria-hidden="true">T</span><span>${who}</span></p>
        ${direct ? `${privateOnly ? '<div class="atlas-alert atlas-alert--info"><i data-lucide="info"></i><div class="atlas-alert__content"><p class="atlas-alert__body">Until TikTok approves Atlas, TikTok posts are private (Only me). You can make them public in the TikTok app afterwards.</p></div></div>' : ''}
        <div class="atlas-field"><label for="mk-tt-privacy">Who can see this video</label><select class="atlas-select" id="mk-tt-privacy" data-mk-tt-privacy${dis}><option value="" disabled${t.privacy_level ? '' : ' selected'}>Choose who can see it</option>${options.map((key) => { const blocked = key === 'SELF_ONLY' && t.brand_content; return `<option value="${escapeHtml(key)}"${t.privacy_level === key ? ' selected' : ''}${blocked ? ' disabled' : ''}>${escapeHtml(TIKTOK_PRIVACY[key] || humanize(key))}${blocked ? ' (branded content can’t be private)' : ''}</option>`; }).join('')}</select></div>
        <fieldset class="mk-fieldset"><legend class="atlas-label">Allow people to</legend>${check('allow_comment', 'Comment', info?.comment_disabled)}${check('allow_duet', 'Duet', info?.duet_disabled)}${check('allow_stitch', 'Stitch', info?.stitch_disabled)}</fieldset>`
        : ''}
        ${direct ? `<div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="mk-tt-commercial-label">Disclose commercial content</p><p class="atlas-toggle-row__help">Turn on if this post promotes your venue, a brand, product or service.</p></div><button type="button" class="atlas-toggle" role="switch" id="mk-tt-commercial" aria-labelledby="mk-tt-commercial-label" aria-checked="${t.commercial}" data-mk-tt-commercial${dis}></button></div>
        ${t.commercial ? `<fieldset class="mk-fieldset" id="mk-tt-commercial-kinds"><legend class="sr-only">What this promotes</legend><label class="atlas-check-row"><input type="checkbox" class="atlas-check" data-mk-tt="brand_organic"${t.brand_organic ? ' checked' : ''}${dis}><span><span>Your brand</span><span class="help mk-block">You're promoting yourself or your own business. The post is labelled “Promotional content”.</span></span></label><label class="atlas-check-row"><input type="checkbox" class="atlas-check" data-mk-tt="brand_content"${t.brand_content ? ' checked' : ''}${dis}><span><span>Branded content</span><span class="help mk-block">You're promoting another brand or a third party. The post is labelled “Paid partnership”.</span></span></label></fieldset>` : ''}
        <label class="atlas-check-row mk-consent-row"><input type="checkbox" class="atlas-check" id="mk-tt-consent" data-mk-tt-consent${t.consent_confirmed_at ? ' checked' : ''}${dis}><span>I agree to TikTok's ${t.commercial && t.brand_content ? `<a href="${TIKTOK_BRANDED_URL}" target="_blank" rel="noopener">Branded Content Policy</a> and ` : ''}<a href="${TIKTOK_MUSIC_URL}" target="_blank" rel="noopener">Music Usage Confirmation</a> for this post.</span></label>` : '<p class="help">Atlas sends the video to your TikTok inbox. You choose who can see it, add any labels and post it from the TikTok app.</p>'}
      </div>`;
  }

  function googleSection(draft, editable) {
    const g = draft.gbp;
    const dis = editable ? '' : ' disabled';
    const location = targetFor('google-business-profile')?.resource?.label;
    const minFrom = (id) => ` data-atlas-min-from="${id}"`;
    return `<div class="mk-channel__extra" data-mk-google>
      <div class="atlas-field"><span class="atlas-label" id="mk-gbp-topic-label">Post type</span><div class="atlas-segmented" role="radiogroup" aria-labelledby="mk-gbp-topic-label">${GBP_TOPICS.map(([key, label]) => `<button type="button" role="radio" aria-checked="${g.topic === key}" data-mk-gbp-topic="${key}"${dis}>${label}</button>`).join('')}</div></div>
      <p class="help">${location ? `Posting to ${escapeHtml(location)}.` : 'Choose the Business Profile location in Settings › Integrations.'}</p>
      ${g.topic === 'EVENT' || g.topic === 'OFFER' ? `<div class="atlas-field"><label for="mk-gbp-title">${g.topic === 'EVENT' ? 'Event title' : 'Offer title'}</label><input class="atlas-input" id="mk-gbp-title" data-mk-gbp="event_title" maxlength="58" value="${escapeHtml(g.event_title)}"${dis}></div>
      <div class="atlas-grid-2"><div class="atlas-field"><label for="mk-gbp-start">Starts <span class="optional">(${escapeHtml(venueTimeLabel())})</span></label><input class="atlas-input" type="datetime-local" step="60" id="mk-gbp-start" data-mk-gbp="event_start" value="${escapeHtml(g.event_start)}"${dis}></div><div class="atlas-field"><label for="mk-gbp-end">Ends</label><input class="atlas-input" type="datetime-local" step="60" id="mk-gbp-end" data-mk-gbp="event_end" value="${escapeHtml(g.event_end)}"${minFrom('mk-gbp-start')}${dis}></div></div>` : ''}
      ${g.topic === 'OFFER' ? `<div class="atlas-grid-2"><div class="atlas-field"><label for="mk-gbp-coupon">Coupon code <span class="optional">(optional)</span></label><input class="atlas-input" id="mk-gbp-coupon" data-mk-gbp="coupon" maxlength="58" value="${escapeHtml(g.coupon)}"${dis}></div><div class="atlas-field"><label for="mk-gbp-redeem">Redeem online link <span class="optional">(optional)</span></label><input class="atlas-input" type="url" id="mk-gbp-redeem" data-mk-gbp="redeem_url" value="${escapeHtml(g.redeem_url)}" placeholder="https://"${dis}></div></div><div class="atlas-field"><label for="mk-gbp-terms">Terms <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="mk-gbp-terms" data-mk-gbp="terms" rows="2"${dis}>${escapeHtml(g.terms)}</textarea></div>`
        : `<div class="atlas-grid-2"><div class="atlas-field"><label for="mk-gbp-cta">Button</label><select class="atlas-select" id="mk-gbp-cta" data-mk-gbp="cta"${dis}>${GBP_BUTTONS.map(([key, label]) => `<option value="${key}"${g.cta === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>${g.cta && g.cta !== 'CALL' ? `<div class="atlas-field"><label for="mk-gbp-cta-url">Button link</label><input class="atlas-input" type="url" id="mk-gbp-cta-url" data-mk-gbp="cta_url" value="${escapeHtml(g.cta_url)}" placeholder="https://"${dis}></div>` : g.cta === 'CALL' ? '<p class="help mk-cta-help">Uses the phone number on your Business Profile.</p>' : ''}</div>`}
      <p class="help">Google removes posts with phone numbers in the text. Use the Call now button.</p>
    </div>`;
  }

  function channelSections(draft, editable) {
    const dis = editable ? '' : ' disabled';
    return draft.platforms.slice().sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)).map((platform) => {
      const name = CHANNELS[platform];
      const custom = typeof draft.overrides[platform] === 'string';
      const kinds = formatOptions(platform, draft);
      const kind = kindFor(platform, draft);
      const open = state.composer.openChannels?.has(platform);
      return `<details class="mk-channel" data-mk-channel-section="${platform}"${open ? ' open' : ''}><summary><span class="mk-channel__name">${escapeHtml(name)}</span><span class="mk-channel__state" data-mk-channel-state="${platform}">${escapeHtml(channelSummary(platform, draft))}</span></summary>
        <div class="mk-channel__body atlas-stack">
          ${kinds.length > 1 ? `<div class="atlas-field"><span class="atlas-label" id="mk-format-${platform}">Format</span><div class="atlas-segmented" role="radiogroup" aria-labelledby="mk-format-${platform}">${kinds.map((key) => `<button type="button" role="radio" aria-checked="${kind === key}" data-mk-format="${platform}" data-mk-kind="${key}"${dis}>${escapeHtml(FORMAT_LABEL[key] || humanize(key))}</button>`).join('')}</div></div>` : kind ? `<p class="help">Format: ${escapeHtml(FORMAT_LABEL[kind] || humanize(kind))}${platform === 'instagram' && kind === 'ig_carousel' ? ' (more than one photo or video)' : ''}.</p>` : ''}
          <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="mk-ov-label-${platform}">Write a different caption for ${escapeHtml(name)}</p></div><button type="button" class="atlas-toggle" role="switch" aria-labelledby="mk-ov-label-${platform}" aria-checked="${custom}" data-mk-override-toggle="${platform}"${dis}></button></div>
          ${custom ? `<div class="atlas-field"><label for="mk-override-${platform}">${escapeHtml(name)} caption</label><textarea class="atlas-textarea" id="mk-override-${platform}" rows="4" data-mk-override="${platform}"${dis}>${escapeHtml(draft.overrides[platform])}</textarea><p class="help mk-counter" data-mk-override-counter="${platform}">${escapeHtml(`${number(draft.overrides[platform].length)}${CAPTION_LIMIT[platform] < 10000 ? ` / ${number(CAPTION_LIMIT[platform])}` : ''}`)}</p>${editable ? `<button type="button" class="atlas-link mk-inline-link" data-mk-override-reset="${platform}">Use the common caption again</button>` : ''}</div>` : ''}
          ${platform === 'tiktok' ? tiktokSection(draft, editable) : ''}
          ${platform === 'google-business-profile' ? googleSection(draft, editable) : ''}
        </div></details>`;
    }).join('');
  }

  function whenEcho(draft) {
    const at = scheduledInstant(draft);
    if (draft.when === 'none') return 'It waits in Posts until someone sets a time or presses Publish now after approval.';
    if (draft.when === 'asap') return autoPublishing() ? 'It publishes as soon as it’s approved.' : 'It publishes as soon as it’s approved, once automatic publishing is on.';
    if (!at) return `Pick a date and time (${venueTimeLabel()}).`;
    let text = `Posts ${dateOnly(at)} at ${timeOnly(at)} ${venueTimeLabel()}.`;
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
      const localDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(at)).replace(',', '');
      const venueDay = dateOnly(at);
      if (local !== timeOnly(at) || localDay !== venueDay) {
        const city = String(zone || '').split('/').pop().replace(/_/g, ' ');
        text += ` That's ${localDay !== venueDay ? `${localDay}, ` : ''}${local} your time${city ? ` (${city})` : ''}.`;
      }
    } catch { /* the venue line stands alone */ }
    return text;
  }

  function previewMarkup(draft) {
    const channels = draft.platforms.slice().sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b));
    if (!channels.length) return '<p class="mk-muted">Choose a channel to see a preview.</p>';
    const active = channels.includes(state.composer.preview) ? state.composer.preview : channels[0];
    const media = draft.media;
    const cover = media[0];
    const at = scheduledInstant(draft);
    const when = at ? dateTime(at) : 'No time yet';
    const account = (platform) => targetFor(platform)?.resource?.label || `Your ${CHANNELS[platform]} account`;
    const frame = (ratio, item = cover) => `<div class="mk-preview__media mk-preview__media--${ratio}">${item?.thumb_url ? `<img src="${escapeHtml(item.thumb_url)}" alt="">` : '<span class="mk-preview__none"><i data-lucide="image" aria-hidden="true"></i>No media yet</span>'}</div>`;
    const caption = (platform, lines) => `<p class="mk-preview__text mk-preview__text--${lines}">${escapeHtml(captionFor(platform, draft) || 'Your caption appears here.')}</p>`;
    const kind = kindFor(active, draft);
    let card;
    if (active === 'instagram') {
      const vertical = kind === 'ig_reel';
      card = `<div class="mk-preview__head"><span class="atlas-avatar atlas-avatar--sm atlas-avatar--b" aria-hidden="true">${escapeHtml(account(active).charAt(0).toUpperCase())}</span><span>${escapeHtml(account(active))}</span></div>${frame(vertical ? 'vertical' : 'portrait')}${media.length > 1 ? `<p class="mk-preview__dots" aria-label="${media.length} items">${media.map((_, i) => `<span${i === 0 ? ' class="is-on"' : ''}></span>`).join('')}</p>` : ''}${caption(active, 2)}<p class="mk-preview__when" data-mk-preview-when>${escapeHtml(when)}</p>`;
    } else if (active === 'facebook') {
      card = `<div class="mk-preview__head"><span class="atlas-avatar atlas-avatar--sm atlas-avatar--c" aria-hidden="true">${escapeHtml(account(active).charAt(0).toUpperCase())}</span><span>${escapeHtml(account(active))}<span class="mk-preview__sub" data-mk-preview-when>${escapeHtml(when)}</span></span></div>${caption(active, 5)}${media.length ? `<div class="mk-preview__grid mk-preview__grid--${Math.min(media.length, 4)}">${media.slice(0, 4).map((m, i) => `<span class="mk-preview__cell">${m.thumb_url ? `<img src="${escapeHtml(m.thumb_url)}" alt="">` : ''}${i === 3 && media.length > 4 ? `<span class="mk-preview__more">+${media.length - 4}</span>` : ''}</span>`).join('')}</div>` : ''}`;
    } else if (active === 'tiktok') {
      const privacy = draft.tiktok.privacy_level ? `Visible to: ${TIKTOK_PRIVACY[draft.tiktok.privacy_level] || humanize(draft.tiktok.privacy_level)}` : kind === 'tiktok_video' ? 'Choose who can see it' : 'Finished in the TikTok app';
      card = `${frame('vertical', media.find((m) => m.kind === 'video') || cover)}${caption(active, 2)}<p class="mk-preview__when">${escapeHtml(privacy)} · <span data-mk-preview-when>${escapeHtml(when)}</span></p>`;
    } else {
      const g = draft.gbp;
      const button = GBP_BUTTONS.find(([key]) => key === g.cta)?.[1];
      card = `<div class="mk-preview__head"><span class="atlas-avatar atlas-avatar--sm atlas-avatar--d" aria-hidden="true">G</span><span>${escapeHtml(targetFor(active)?.resource?.label || 'Your Business Profile')}</span></div>${frame('landscape', media.find((m) => m.kind !== 'video'))}${g.topic !== 'STANDARD' && g.event_title ? `<p class="mk-preview__title">${escapeHtml(g.event_title)}</p>` : ''}${g.topic !== 'STANDARD' && fromInput(g.event_start) ? `<p class="mk-preview__sub">${escapeHtml(`${dateTime(fromInput(g.event_start))} – ${dateTime(fromInput(g.event_end), '')}`)}</p>` : ''}${caption(active, 4)}${g.topic === 'OFFER' ? '<p class="mk-preview__cta">View offer</p>' : button && g.cta ? `<p class="mk-preview__cta">${escapeHtml(button)}</p>` : ''}<p class="mk-preview__when" data-mk-preview-when>${escapeHtml(when)}</p>`;
    }
    return `${channels.length > 1 ? `<div class="atlas-segmented mk-preview-switch" role="group" aria-label="Preview channel">${channels.map((key) => `<button type="button" aria-pressed="${key === active}" data-mk-preview-channel="${key}">${escapeHtml(CHANNEL_SHORT[key])}</button>`).join('')}</div>` : ''}
      <div class="mk-preview__card mk-preview--${active === 'google-business-profile' ? 'google' : active}" aria-label="${escapeHtml(CHANNELS[active])} preview (approximate)">${card}</div>`;
  }

  function checksMarkup(checks) {
    if (!checks.must.length && !checks.worth.length) {
      const names = state.composer.draft.platforms.map((p) => CHANNELS[p]);
      return `<p class="help mk-checks__ok"><i data-lucide="circle-check" aria-hidden="true"></i>${escapeHtml(names.length ? `Ready for ${listText(names)}.` : 'Nothing to fix.')}</p>`;
    }
    const block = (list, tone, title) => `<div class="atlas-alert atlas-alert--${tone}"><i data-lucide="${tone === 'danger' ? 'circle-alert' : 'triangle-alert'}"></i><div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(title)}</p><ul class="mk-checks__list">${list.map((entry) => `<li><button type="button" class="atlas-link" data-mk-check-field="${escapeHtml(entry.field || '')}" data-mk-check-platform="${escapeHtml(entry.platform || '')}">${escapeHtml(entry.message)}</button></li>`).join('')}</ul></div></div>`;
    return `${checks.must.length ? block(checks.must, 'danger', `${plural(checks.must.length, 'thing')} to fix before this can be approved`) : ''}${checks.worth.length ? block(checks.worth, 'warning', `${plural(checks.worth.length, 'thing')} worth checking`) : ''}`;
  }

  function approvalBanner(item) {
    if (!item) return '';
    const approvals = Array.isArray(item.approval_history) ? item.approval_history : [];
    const last = approvals[0];
    if (item.status === 'pending_approval') {
      const sent = approvals.find((entry) => entry.decision === 'submitted');
      return `<div class="atlas-alert atlas-alert--info"><i data-lucide="info"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escapeHtml(`${sent?.actor_label || item.created_by_label || 'Someone'} sent this for approval${sent?.created_at ? ` on ${dateTime(sent.created_at)}` : ''}.`)}${sent?.note ? ` Note: “${escapeHtml(sent.note)}”` : ''}</p></div></div>`;
    }
    if (item.status === 'changes_requested' && last?.decision === 'changes_requested') {
      return `<div class="atlas-alert atlas-alert--warning"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escapeHtml(`${last.actor_label || 'An approver'} asked for changes${last.note ? `: “${last.note}”` : '.'}`)}</p></div></div>`;
    }
    return '';
  }

  function publishingSection(item) {
    if (!item || !deliveriesOf(item).length) return '';
    return `<section class="atlas-stack atlas-stack--sm mk-publishing" aria-labelledby="mk-publishing-title"><p class="atlas-label" id="mk-publishing-title">Publishing</p><ul class="atlas-list">${deliveryRows(item, { compact: true })}</ul></section>`;
  }

  // Footer per state (UX spec §5.9): one primary per state.
  function footerMarkup(item, checks) {
    const composer = state.composer;
    const blocked = checks.must.length;
    const fixFirst = blocked ? ` disabled data-atlas-tooltip="Fix ${plural(blocked, 'problem')} first" aria-describedby="mk-checks"` : '';
    const status = item?.status || 'draft';
    const canPublish = state.staff?.can_publish !== false;
    const tiktok = composer.draft.platforms.includes('tiktok');
    const consent = tiktok ? `<p class="help mk-consent">By posting, you agree to TikTok's ${composer.draft.tiktok.commercial && composer.draft.tiktok.brand_content ? `<a href="${TIKTOK_BRANDED_URL}" target="_blank" rel="noopener">Branded Content Policy</a> and ` : ''}<a href="${TIKTOK_MUSIC_URL}" target="_blank" rel="noopener">Music Usage Confirmation</a>.</p>` : '';
    const autoOff = !autoPublishing();
    const publishNow = `<button type="button" class="atlas-btn atlas-btn--primary" data-mk-publish-now${autoOff ? ' disabled data-atlas-tooltip="Automatic publishing is off. An administrator can turn it on in Settings › Marketing." aria-describedby="mk-auto-off"' : fixFirst}>Publish now</button>`;
    const autoOffLine = autoOff ? '<p class="help mk-foot-note" id="mk-auto-off">Automatic publishing is off, so Publish now isn\'t available. An administrator can turn it on in Settings › Marketing.</p>' : '';
    let buttons;
    if (!item || (composer.editing && EDITABLE.has(status))) {
      buttons = `${item ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-mk-delete-draft>Delete draft</button>' : '<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-mk-back>Cancel</button>'}<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-save>Save draft</button><button type="button" class="atlas-btn atlas-btn--primary" data-mk-submit${blocked ? fixFirst : ''}>Submit for approval</button>`;
    } else if (composer.editing) {
      // Editing an approved or scheduled post: saving sends it back for approval.
      buttons = '<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-mk-cancel-edit>Discard changes</button><button type="button" class="atlas-btn atlas-btn--primary" data-mk-save>Save changes</button>';
    } else if (status === 'pending_approval' && item.can_approve) {
      const at = item.scheduled_for;
      const past = at && Date.parse(at) <= Date.now();
      const label = at ? (past && autoPublishing() ? 'Approve and publish now' : 'Approve and schedule') : 'Approve';
      buttons = `<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-mk-decide="rejected">Reject</button><button type="button" class="atlas-btn atlas-btn--secondary" data-mk-decide="changes_requested">Request changes</button><button type="button" class="atlas-btn atlas-btn--primary" data-mk-decide="approved"${fixFirst}>${label}</button>`;
    } else if (['approved', 'scheduled'].includes(status) && canPublish) {
      const state_ = item.publication_state;
      const failed = deliveriesOf(item).filter((d) => ['failed', 'needs_attention'].includes(d.status));
      if (failed.length) {
        buttons = `<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-close>Close</button><button type="button" class="atlas-btn atlas-btn--primary" data-mk-retry-failed>Retry failed ${failed.length === 1 ? 'channel' : 'channels'}</button>`;
      } else if (state_ === 'publishing' || deliveriesOf(item).some((d) => IN_FLIGHT.has(d.status))) {
        buttons = '<button type="button" class="atlas-btn atlas-btn--primary" data-mk-close>Close</button>';
      } else if (state_ === 'partial' || state_ === 'published') {
        buttons = '<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-duplicate>Duplicate as new post</button><button type="button" class="atlas-btn atlas-btn--primary" data-mk-close>Close</button>';
      } else {
        buttons = `<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-mk-cancel-post>Cancel post</button><button type="button" class="atlas-btn atlas-btn--secondary" data-mk-edit>Edit</button>${state.staff?.can_mark_published && !deliveriesOf(item).length ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-published>Mark posted by hand</button>' : ''}${publishNow}`;
      }
    } else if (['published', 'completed', 'rejected', 'cancelled'].includes(status)) {
      buttons = `${canPublish ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-duplicate>Duplicate as new post</button>' : ''}<button type="button" class="atlas-btn atlas-btn--primary" data-mk-close>Close</button>`;
    } else {
      buttons = '<button type="button" class="atlas-btn atlas-btn--primary" data-mk-close>Close</button>';
    }
    const autoLine = ['approved', 'scheduled'].includes(status) && !composer.editing && canPublish && !deliveriesOf(item).some((d) => ['failed', 'needs_attention'].includes(d.status)) && !['publishing', 'partial', 'published'].includes(item?.publication_state) ? autoOffLine : '';
    return `${consent}${autoLine}<div class="mk-composer__buttons">${buttons}</div>`;
  }

  function composerFormMarkup(item, draft, editable) {
    const dis = editable ? '' : ' disabled';
    const typeOptions = [...new Set([...NEW_TYPES, ...(item ? [item.content_type] : [])])];
    const approvals = Array.isArray(item?.approval_history) ? item.approval_history : [];
    const counter = counterText(draft);
    const minNow = inputValue(new Date().toISOString());
    return `<form class="atlas-form mk-composer__form" data-mk-form novalidate>
      <div class="atlas-field"><label for="mk-title">Title</label><input class="atlas-input" id="mk-title" name="title" maxlength="180" required value="${escapeHtml(draft.title)}" data-mk-field="title"${dis}><p class="help">Only your team sees this.</p></div>
      <div class="atlas-grid-2">
        <div class="atlas-field"><label for="mk-type">Type</label><select class="atlas-select" id="mk-type" name="content_type" data-mk-field="content_type"${item ? ' disabled' : ''}>${typeOptions.map((key) => `<option value="${key}"${draft.content_type === key ? ' selected' : ''}>${TYPES[key]}</option>`).join('')}</select></div>
        <div class="atlas-field"><label for="mk-campaign">Campaign <span class="optional">(optional)</span></label><select class="atlas-select" id="mk-campaign" name="campaign_id" data-mk-field="campaign_id"${dis}><option value="">None</option>${campaigns().map((campaign) => `<option value="${escapeHtml(campaign.id)}"${draft.campaign_id === campaign.id ? ' selected' : ''}>${escapeHtml(campaign.name)}</option>`).join('')}</select></div>
      </div>
      <fieldset class="atlas-form-group mk-channels" id="mk-channels"><legend class="atlas-label">Channels</legend><div class="atlas-chips">${CHANNEL_ORDER.map((key) => `<button type="button" class="atlas-chip" aria-pressed="${draft.platforms.includes(key)}" data-mk-channel="${key}"${dis}>${CHANNELS[key]}</button>`).join('')}</div><p class="help" data-mk-readiness>${escapeHtml(readinessNote(draft))} <a href="#settings/integrations">Integrations in Settings</a></p></fieldset>
      <fieldset class="atlas-form-group" id="mk-media"><legend class="atlas-label">Photos and videos</legend><div class="mk-strip-host" data-mk-strip>${stripMarkup(draft, editable)}</div></fieldset>
      <div class="atlas-field"><label for="mk-caption">Caption</label><textarea class="atlas-textarea" id="mk-caption" name="caption_draft" rows="6" maxlength="10000" data-mk-field="caption"${dis}>${escapeHtml(draft.caption)}</textarea><p class="help mk-counter${counter.over ? ' is-over' : ''}" data-mk-counter>${escapeHtml(counter.text)}</p><p class="help" data-mk-hashtags${hashtags(draft.caption) ? '' : ' hidden'}>${escapeHtml(plural(hashtags(draft.caption), 'hashtag'))}</p>${editable ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm mk-ask-caption" data-mk-ask-caption><i data-lucide="sparkles"></i>Suggest a caption</button>' : ''}</div>
      <div class="mk-channel-list" data-mk-channel-list>${channelSections(draft, editable)}</div>
      <fieldset class="atlas-form-group" id="mk-when-group"><legend class="atlas-label">When</legend>
        <div class="atlas-segmented" role="radiogroup" aria-label="When">${[['time', 'At a time'], ['asap', 'As soon as it’s approved'], ['none', 'No time yet']].map(([key, label]) => `<button type="button" role="radio" aria-checked="${draft.when === key}" data-mk-when-mode="${key}"${dis}>${label}</button>`).join('')}</div>
        <div class="atlas-field" data-mk-when-field${draft.when === 'time' ? '' : ' hidden'}><label for="mk-when">Post on (${escapeHtml(venueTimeLabel())})</label><input class="atlas-input" type="datetime-local" step="60" id="mk-when" name="scheduled_for" min="${escapeHtml(minNow)}" value="${escapeHtml(draft.scheduled)}" data-mk-field="scheduled"${dis}>${editable ? '<div class="atlas-chips mk-quick"><button type="button" class="atlas-chip" data-mk-quick="1">Next day, same time</button><button type="button" class="atlas-chip" data-mk-quick="7">Next week, same time</button></div>' : ''}</div>
        <p class="help mk-when-echo" data-mk-when-echo>${escapeHtml(whenEcho(draft))}</p>
        <details class="mk-reminder"${draft.reminder !== 'off' ? ' open' : ''}><summary>Reminder</summary><div class="atlas-field"><label for="mk-reminder">Remind me to post by hand</label><select class="atlas-select" id="mk-reminder" data-mk-field="reminder"${dis}>${REMINDERS.map(([key, label]) => `<option value="${key}"${draft.reminder === key ? ' selected' : ''}>${label}</option>`).join('')}</select><p class="help">Only matters for channels you post by hand.</p></div></details>
      </fieldset>
      ${item?.can_approve && item.status === 'pending_approval' ? '<div class="atlas-field"><label for="mk-note">Note for the team <span class="optional">(needed to request changes or reject)</span></label><textarea class="atlas-textarea" id="mk-note" name="note" rows="2" data-mk-field="note"></textarea></div>' : (!item || EDITABLE.has(item.status)) && editable ? '<div class="atlas-field"><label for="mk-note">Note for the approver <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="mk-note" name="note" rows="2" data-mk-field="note"></textarea></div>' : ''}
      <div data-mk-publishing>${publishingSection(item)}</div>
      ${approvals.length ? `<section class="atlas-stack atlas-stack--sm"><p class="atlas-label">Approval history</p><ul class="atlas-list">${approvals.map((entry) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(({ submitted: 'Sent for approval', approved: 'Approved', changes_requested: 'Changes requested', rejected: 'Rejected', cancelled: 'Cancelled' })[entry.decision] || humanize(entry.decision))}${entry.actor_label ? ` by ${escapeHtml(entry.actor_label)}` : ''}</p><p class="atlas-row__meta">${escapeHtml(dateTime(entry.created_at, '—'))}${entry.note ? ` · ${escapeHtml(entry.note)}` : ''}</p></div></li>`).join('')}</ul></section>` : ''}
      <p class="error" data-mk-error role="alert" hidden></p>
    </form>`;
  }

  function composerTitle(item) {
    if (item) return item.title;
    if (state.composer.suggestion) return 'Plan a suggestion';
    return 'New post';
  }

  function composerSub(item) {
    const parts = [];
    if (item) parts.push(STATUS[item.status]?.[0] || humanize(item.status));
    if (item?.publication_state && PUBLICATION[item.publication_state]) parts.push(PUBLICATION[item.publication_state][0]);
    if (state.composer.savedAt) parts.push(`Saved ${timeOnly(state.composer.savedAt)}`);
    return parts.join(' · ') || 'Draft';
  }

  function renderComposer(force = false) {
    const element = host();
    const composer = state.composer;
    const item = composerItem() || (composer.requestedId ? findItem(composer.requestedId) : null);
    if (composer.requestedId && !item) {
      element.innerHTML = `<div class="atlas-page mk-page"><a class="atlas-link mk-back" href="#marketing/posts" data-mk-back><i data-lucide="chevron-left"></i>Marketing</a>${state.workspace || state.error ? emptyMarkup('file-question', 'This post isn’t in the loaded month', 'Open it from the calendar month it’s planned in, or from Posts.', '<a class="atlas-btn atlas-btn--secondary" href="#marketing/posts">Go to Posts</a>') : `<div class="mk-skeleton" aria-busy="true" aria-label="Loading the post">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(5)}</div>`}</div>`;
      window.lucide?.createIcons?.();
      return;
    }
    if (composer.requestedId && item && !composer.id) {
      composer.id = item.id;
      composer.draft = draftFromItem(item);
      composer.original = clone(composer.draft);
      composer.editing = item.can_edit !== false && EDITABLE.has(item.status);
      force = true;
    }
    const mountedHere = element.querySelector('[data-mk-composer]');
    if (composer.mounted && mountedHere && !force) {
      // Background refresh: keep what the manager typed; refresh live parts.
      const head = element.querySelector('.page-head__sub');
      if (head) head.textContent = composerSub(item);
      const publishing = element.querySelector('[data-mk-publishing]');
      if (publishing) publishing.innerHTML = publishingSection(item);
      refreshComposer();
      return;
    }
    const editable = composer.editing;
    const draft = composer.draft;
    if (draft.platforms.includes('tiktok') && !state.creatorInfo) loadCreatorInfo();
    const checks = allChecks(draft);
    element.innerHTML = `<div class="atlas-page mk-page mk-composer-page" data-mk-composer>
        <a class="atlas-link mk-back" href="#marketing/posts" data-mk-back><i data-lucide="chevron-left"></i>Marketing</a>
        ${window.AtlasShell.pageHead({ title: composerTitle(item), sub: composerSub(item) })}
        ${approvalBanner(item)}
        <div class="atlas-segmented mk-pane-switch" role="group" aria-label="Show"><button type="button" aria-pressed="${composer.pane === 'edit'}" data-mk-pane="edit">Edit</button><button type="button" aria-pressed="${composer.pane === 'preview'}" data-mk-pane="preview">Preview<span class="atlas-badge mk-pane-badge" data-mk-pane-badge${checks.must.length ? '' : ' hidden'}>${checks.must.length}</span></button></div>
        <div class="mk-composer is-pane-${composer.pane}">
          ${composerFormMarkup(item, draft, editable)}
          <aside class="mk-composer__side" aria-label="Checks and preview">
            <section class="mk-checks" id="mk-checks" aria-live="polite" data-mk-checks>${checksMarkup(checks)}</section>
            <section class="mk-previews" aria-label="Preview"><p class="atlas-label">Preview</p><p class="help">Approximate. Each platform decides the final look.</p><div data-mk-previews>${previewMarkup(draft)}</div></section>
          </aside>
        </div>
        <footer class="mk-composer__foot" data-atlas-sticky-actions data-mk-footer>${footerMarkup(item, checks)}</footer>
      </div>`;
    composer.mounted = true;
    bindComposer(element);
    window.lucide?.createIcons?.();
  }

  // Targeted updates after a change (no full re-render while typing).
  function refreshComposer({ sections = false, strip = false } = {}) {
    const element = host();
    const composer = state.composer;
    if (!element || !composer) return;
    const draft = composer.draft;
    const item = composerItem();
    const editable = composer.editing;
    if (strip) {
      const node = element.querySelector('[data-mk-strip]');
      if (node) { node.innerHTML = stripMarkup(draft, editable); bindAddMedia(element); }
    }
    if (sections) {
      const list = element.querySelector('[data-mk-channel-list]');
      if (list) {
        composer.openChannels = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.mkChannelSection));
        list.innerHTML = channelSections(draft, editable);
      }
      element.querySelectorAll('[data-mk-channel]').forEach((chip) => chip.setAttribute('aria-pressed', String(draft.platforms.includes(chip.dataset.mkChannel))));
      const note = element.querySelector('[data-mk-readiness]');
      if (note) note.innerHTML = `${escapeHtml(readinessNote(draft))} <a href="#settings/integrations">Integrations in Settings</a>`;
    }
    element.querySelectorAll('[data-mk-channel-state]').forEach((node) => { node.textContent = channelSummary(node.dataset.mkChannelState, draft); });
    const counter = counterText(draft);
    const counterNode = element.querySelector('[data-mk-counter]');
    if (counterNode) { counterNode.textContent = counter.text; counterNode.classList.toggle('is-over', counter.over); }
    const tags = element.querySelector('[data-mk-hashtags]');
    if (tags) { const n = hashtags(draft.caption); tags.hidden = !n; tags.textContent = plural(n, 'hashtag'); }
    element.querySelectorAll('[data-mk-override-counter]').forEach((node) => { const p = node.dataset.mkOverrideCounter; const text = draft.overrides[p] || ''; node.textContent = `${number(text.length)}${CAPTION_LIMIT[p] < 10000 ? ` / ${number(CAPTION_LIMIT[p])}` : ''}`; });
    const whenField = element.querySelector('[data-mk-when-field]');
    if (whenField) whenField.hidden = draft.when !== 'time';
    element.querySelectorAll('[data-mk-when-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mkWhenMode === draft.when)));
    const echo = element.querySelector('[data-mk-when-echo]');
    if (echo) echo.textContent = whenEcho(draft);
    const previews = element.querySelector('[data-mk-previews]');
    if (previews) previews.innerHTML = previewMarkup(draft);
    scheduleChecks();
    window.lucide?.createIcons?.();
  }

  function renderChecksNow() {
    const element = host();
    const composer = state.composer;
    if (!element || !composer) return;
    const checks = allChecks(composer.draft);
    const node = element.querySelector('[data-mk-checks]');
    if (node) node.innerHTML = checksMarkup(checks);
    const badge = element.querySelector('[data-mk-pane-badge]');
    if (badge) { badge.hidden = !checks.must.length; badge.textContent = String(checks.must.length); }
    const footer = element.querySelector('[data-mk-footer]');
    if (footer && !composer.busy) footer.innerHTML = footerMarkup(composerItem(), checks);
    window.lucide?.createIcons?.();
    return checks;
  }

  function scheduleChecks() {
    const composer = state.composer;
    if (!composer) return;
    window.clearTimeout(composer.checkTimer);
    composer.checkTimer = window.setTimeout(renderChecksNow, CHECK_DEBOUNCE_MS);
  }

  async function loadCreatorInfo() {
    if (state.creatorInfoLoading) return;
    state.creatorInfoLoading = true;
    try {
      const payload = await api('tiktok-creator-info');
      state.creatorInfo = payload.creator_info || { available: false };
    } catch {
      state.creatorInfo = { available: false, reason: 'unavailable' };
    } finally {
      state.creatorInfoLoading = false;
      if (state.composer?.draft.platforms.includes('tiktok')) refreshComposer({ sections: true });
    }
  }

  // ---- composer events ----

  function bindAddMedia(element) {
    const trigger = element.querySelector('#mk-add-media');
    const menu = element.querySelector('#mk-add-media-menu');
    if (trigger && menu) window.AtlasShell?.menu?.(trigger, menu, { align: 'start', onSelect: (entry) => addMedia(entry?.dataset?.mkMediaSource) });
    const file = element.querySelector('#mk-media-file');
    file?.addEventListener('change', () => { const files = [...(file.files || [])]; file.value = ''; if (files.length) uploadMedia(files); });
  }

  function bindComposer(element) {
    const form = element.querySelector('[data-mk-form]');
    form.addEventListener('input', onComposerInput);
    form.addEventListener('change', onComposerInput);
    bindAddMedia(element);
    // Desktop drag to reorder (buttons always work; drag is an extra).
    form.addEventListener('dragstart', (event) => {
      const item = event.target.closest?.('.mk-strip__item');
      if (!item) return;
      state.composer.dragFrom = Number(item.dataset.mkMediaIndex);
      event.dataTransfer?.setData('text/plain', String(state.composer.dragFrom));
    });
    form.addEventListener('dragover', (event) => { if (event.target.closest?.('.mk-strip__item')) event.preventDefault(); });
    form.addEventListener('drop', (event) => {
      const item = event.target.closest?.('.mk-strip__item');
      if (!item || state.composer.dragFrom === undefined) return;
      event.preventDefault();
      moveMedia(state.composer.dragFrom, Number(item.dataset.mkMediaIndex));
      state.composer.dragFrom = undefined;
    });
  }

  function onComposerInput(event) {
    const composer = state.composer;
    if (!composer || !composer.editing) return;
    const target = event.target;
    const draft = composer.draft;
    const field = target.dataset?.mkField;
    if (field === 'title') draft.title = target.value;
    else if (field === 'content_type') draft.content_type = target.value;
    else if (field === 'campaign_id') draft.campaign_id = target.value;
    else if (field === 'caption') draft.caption = target.value;
    else if (field === 'scheduled') draft.scheduled = target.value;
    else if (field === 'reminder') draft.reminder = target.value;
    else if (field === 'note') { draft.note = target.value; return; }
    else if (target.dataset?.mkOverride) { draft.overrides[target.dataset.mkOverride] = target.value; if (target.dataset.mkOverride === 'tiktok' && resetConsent()) return; }
    else if (target.id === 'mk-tt-consent') { if (event.type !== 'change') return; draft.tiktok.consent_confirmed_at = target.checked ? new Date().toISOString() : null; }
    else if (target.dataset?.mkTtPrivacy !== undefined && target.id === 'mk-tt-privacy') { if (event.type !== 'change') return; draft.tiktok.privacy_level = target.value; if (resetConsent()) return; }
    else if (target.dataset?.mkTt) { if (event.type !== 'change') return; draft.tiktok[target.dataset.mkTt] = target.checked; if (resetConsent() || target.dataset.mkTt === 'brand_content') { refreshComposer({ sections: true }); return; } }
    else if (target.dataset?.mkGbp) {
      draft.gbp[target.dataset.mkGbp] = target.value;
      if (target.dataset.mkGbp === 'cta' && event.type === 'change') { refreshComposer({ sections: true }); return; }
    } else return;
    target.removeAttribute('aria-invalid');
    refreshComposer();
  }

  // Any change to what TikTok receives asks for the consent again.
  function resetConsent() {
    const t = state.composer?.draft.tiktok;
    if (!t?.consent_confirmed_at) return false;
    t.consent_confirmed_at = null;
    refreshComposer({ sections: true });
    return true;
  }

  function toggleChannel(platform) {
    const draft = state.composer.draft;
    draft.platforms = draft.platforms.includes(platform) ? draft.platforms.filter((p) => p !== platform) : [...draft.platforms, platform];
    if (platform === 'tiktok' && draft.platforms.includes('tiktok') && !state.creatorInfo) loadCreatorInfo();
    refreshComposer({ sections: true });
  }

  function moveMedia(from, to) {
    const media = state.composer.draft.media;
    if (from === to || from < 0 || to < 0 || from >= media.length || to >= media.length) return;
    const [entry] = media.splice(from, 1);
    media.splice(to, 0, entry);
    refreshComposer({ strip: true, sections: true });
    const name = entry.title || entry.file_name || (entry.kind === 'video' ? 'Video' : 'Photo');
    announce(`${name} moved to position ${to + 1} of ${media.length}.`);
  }

  function announce(text) {
    let region = document.getElementById('mk-live');
    if (!region) { region = document.createElement('p'); region.id = 'mk-live'; region.className = 'sr-only'; region.setAttribute('aria-live', 'polite'); document.body.appendChild(region); }
    region.textContent = text;
  }

  function normalizeMedia(entry) {
    return {
      asset_id: entry.asset_id || entry.id,
      variant_id: entry.variant_id || null,
      collection_id: entry.collection_id || null,
      kind: entry.kind || (String(entry.mime_type || '').startsWith('video/') ? 'video' : 'image'),
      thumb_url: entry.thumb_url || null,
      width: entry.width ?? null,
      height: entry.height ?? null,
      duration_ms: entry.duration_ms ?? null,
      mime_type: entry.mime_type || null,
      byte_size: entry.byte_size ?? null,
      title: entry.title || entry.file_name || null,
      ...(entry.alt_text !== undefined ? { alt_text: entry.alt_text } : {})
    };
  }

  function addToDraft(entries, source) {
    const media = state.composer.draft.media;
    const before = media.length;
    entries.map(normalizeMedia).filter((m) => m.asset_id).forEach((m) => {
      if (!media.some((x) => x.asset_id === m.asset_id && (x.variant_id || null) === m.variant_id)) media.push(m);
    });
    const added = media.length - before;
    refreshComposer({ strip: true, sections: true });
    if (added && source) window.AtlasShell?.toast?.(`${plural(added, source === 'video' ? 'item' : 'photo or video', 'photos and videos')} added${source === 'collection' && entries[0]?.collection_name ? ` from ${entries[0].collection_name}` : ''}.`);
  }

  async function addMedia(source) {
    if (source === 'upload') { host()?.querySelector('#mk-media-file')?.click(); return; }
    const media = window.AtlasMarketingMedia || (await ensureMediaModule(), window.AtlasMarketingMedia);
    if (!media?.pick) { window.AtlasShell?.toast?.('The media library isn’t available yet. Reload Atlas and try again.', { tone: 'warning' }); return; }
    try {
      const picked = await media.pick({ multiple: true, kinds: ['image', 'video'], allowCollections: source === 'collection', initialTab: source === 'collection' ? 'collections' : 'library', exclude: state.composer.draft.media.map((m) => m.asset_id) });
      if (Array.isArray(picked) && picked.length && state.composer) addToDraft(picked, source);
    } catch {
      window.AtlasShell?.toast?.('Media couldn’t be loaded. Your files are safe. Try again.', { tone: 'warning' });
    }
  }

  async function uploadMedia(files) {
    const media = window.AtlasMarketingMedia || (await ensureMediaModule(), window.AtlasMarketingMedia);
    if (!media?.upload) { window.AtlasShell?.toast?.('The media library isn’t available yet. Reload Atlas and try again.', { tone: 'warning' }); return; }
    const composer = state.composer;
    composer.uploads += files.length;
    scheduleChecks();
    try {
      const assets = await media.upload(files);
      if (state.composer === composer && Array.isArray(assets)) addToDraft(assets.filter(Boolean), 'upload');
    } catch {
      window.AtlasShell?.toast?.('The upload stopped. The other files are fine. Try that one again.', { tone: 'warning' });
    } finally {
      composer.uploads = Math.max(0, composer.uploads - files.length);
      if (state.composer === composer) scheduleChecks();
    }
  }

  function composerError(message) {
    const line = host()?.querySelector('[data-mk-error]');
    if (!line) { window.AtlasShell?.toast?.(message, { tone: 'warning' }); return; }
    line.hidden = !message;
    line.textContent = message || '';
    if (message) line.scrollIntoView?.({ block: 'nearest' });
  }

  function busy(on, pressed = null) {
    const element = host();
    element?.querySelectorAll('[data-mk-footer] .atlas-btn').forEach((button) => {
      if (on) { button.dataset.mkWasDisabled = button.disabled ? '1' : ''; button.disabled = true; }
      else { button.disabled = button.dataset.mkWasDisabled === '1'; }
    });
    if (pressed) { pressed.classList.toggle('is-loading', on); pressed.setAttribute('aria-busy', String(on)); }
    if (state.composer) state.composer.busy = on;
  }

  function focusCheck(field, platform) {
    const element = host();
    if (!element) return;
    const composer = state.composer;
    if (composer.pane !== 'edit' && window.matchMedia?.('(max-width: 1023px)').matches) setPane('edit');
    const open = (key) => { const details = element.querySelector(`[data-mk-channel-section="${key}"]`); if (details) details.open = true; };
    const map = {
      title: '#mk-title', channels: '[data-mk-channel]', media: '#mk-add-media', caption: '#mk-caption', when: composer.draft.when === 'time' ? '#mk-when' : '[data-mk-when-mode]', 'tiktok-consent': '#mk-tt-consent',
      'tiktok-privacy': '#mk-tt-privacy', 'tiktok-commercial': '#mk-tt-commercial-kinds input, #mk-tt-commercial', 'gbp-cta-url': '#mk-gbp-cta-url', 'gbp-title': '#mk-gbp-title', 'gbp-start': '#mk-gbp-start', 'gbp-end': '#mk-gbp-end', 'gbp-redeem': '#mk-gbp-redeem'
    };
    if (String(field).startsWith('override-')) { open(field.slice(9)); }
    if (field.startsWith('tiktok')) open('tiktok');
    if (field.startsWith('gbp')) open('google-business-profile');
    const selector = String(field).startsWith('override-') ? `#mk-override-${field.slice(9)}` : map[field] || '#mk-title';
    const node = element.querySelector(selector);
    if (!node) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) node.setAttribute('aria-invalid', 'true');
    node.scrollIntoView?.({ block: 'center' });
    node.focus?.({ preventScroll: true });
  }

  function setPane(pane) {
    state.composer.pane = pane;
    const element = host();
    element?.querySelector('.mk-composer')?.classList.toggle('is-pane-edit', pane === 'edit');
    element?.querySelector('.mk-composer')?.classList.toggle('is-pane-preview', pane === 'preview');
    element?.querySelectorAll('[data-mk-pane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mkPane === pane)));
  }

  // Checks for an action; blocking ones stop it and explain in the panel.
  function gate(purpose) {
    const checks = allChecks(state.composer.draft, { purpose });
    renderChecksNow();
    if (checks.must.length) {
      composerError(`${plural(checks.must.length, 'thing')} to fix first. See the checks.`);
      focusCheck(checks.must[0].field, checks.must[0].platform);
      return false;
    }
    return true;
  }

  // Save (create or partial update + media). Returns the content id.
  async function saveComposer({ message = 'Draft saved.' } = {}) {
    const composer = state.composer;
    const draft = composer.draft;
    if (!draft.title.trim()) { focusCheck('title'); throw Object.assign(new Error('title'), { userMessage: 'Give the post a title.' }); }
    if (draft.when === 'time' && draft.scheduled && !fromInput(draft.scheduled)) { focusCheck('when'); throw Object.assign(new Error('when'), { userMessage: 'Enter a full date and time, or choose No time yet.' }); }
    const fields = contentFields(draft);
    const item = composerItem();
    if (composer.suggestion && !composer.id) {
      const result = await mutate('convert-recommendation', { recommendation_id: composer.suggestion.id, occurrence_date: state.workspace?.venue_date || venueToday(), client_request_id: requestId(), scheduled_for: fields.scheduled_for, reminder_at: fields.reminder_at }, null);
      const id = result?.content?.id || result?.content_id || result?.id;
      if (!id) throw Object.assign(new Error('no id'), { userMessage: 'The suggestion was planned, but Atlas couldn’t open it. Find it in Posts.' });
      composer.id = id;
      composer.suggestion = null;
      await mutate('update-content', { content_id: id, version: findItem(id)?.version ?? null, title: fields.title, platforms: fields.platforms, caption_draft: fields.caption_draft, campaign_id: fields.campaign_id, platform_options: fields.platform_options }, null);
      if (draft.media.length) await mutate('set-content-media', { content_id: id, items: mediaPayload(draft) }, null);
    } else if (!composer.id) {
      const result = await mutate('create-content', { client_request_id: requestId(), priority: 'normal', frames: [], media_requirements: {}, content_type: draft.content_type, ...fields, ...(draft.media.length ? { media: mediaPayload(draft) } : {}) }, null);
      const id = result?.content_id || result?.id || result?.content?.id;
      if (!id) throw Object.assign(new Error('no id'), { userMessage: 'The draft was saved, but Atlas couldn’t open it. Find it in Posts.' });
      composer.id = id;
    } else {
      const original = contentFields(composer.original);
      const patch = {};
      Object.keys(fields).forEach((key) => { if (JSON.stringify(fields[key]) !== JSON.stringify(original[key])) patch[key] = fields[key]; });
      if (Object.keys(patch).length) await mutate('update-content', { content_id: composer.id, version: item?.version ?? null, ...patch, note: null }, null);
      if (JSON.stringify(mediaPayload(draft)) !== JSON.stringify(mediaPayload(composer.original))) await mutate('set-content-media', { content_id: composer.id, items: mediaPayload(draft) }, null);
    }
    composer.original = clone(draft);
    composer.savedAt = new Date().toISOString();
    if (message) window.AtlasShell?.toast?.(message);
    return composer.id;
  }

  function routeToPost(id) {
    window.AtlasShell?.navigate?.(`#marketing/post?id=${encodeURIComponent(id)}`, { replace: true });
  }

  async function runComposerAction(button, fn) {
    if (state.composer?.busy) return;
    composerError('');
    busy(true, button);
    try {
      await fn();
    } catch (error) {
      composerError(error.userMessage || 'Nothing was changed. Try again.');
    } finally {
      if (state.composer) { busy(false, button); if (host()?.querySelector('[data-mk-footer]')) renderChecksNow(); }
    }
  }

  function remountComposer({ editing = null } = {}) {
    const composer = state.composer;
    if (!composer) return;
    const item = composerItem();
    if (item) {
      composer.draft = draftFromItem(item);
      composer.original = clone(composer.draft);
    }
    composer.editing = editing ?? (item ? item.can_edit !== false && EDITABLE.has(item.status) : true);
    composer.mounted = false;
    renderComposer(true);
  }

  async function confirm(options) {
    return window.AtlasModal?.confirm ? window.AtlasModal.confirm(options) : window.confirm(`${options.title}\n\n${options.body}`);
  }

  async function leaveComposer(target = '#marketing/posts') {
    if (dirty()) {
      const leave = await confirm({ title: 'Leave without saving?', body: 'Your changes to this post will be lost.', confirmLabel: 'Leave without saving', cancelLabel: 'Keep editing', danger: true });
      if (!leave) return;
    }
    closeComposer();
    window.AtlasShell?.navigate?.(target);
  }

  function handleComposerClick(target, event) {
    const composer = state.composer;
    const item = composerItem();
    const element = host();
    if (target.closest('[data-mk-back]')) { event.preventDefault(); leaveComposer(); return true; }
    if (target.closest('[data-mk-close]')) { leaveComposer(); return true; }
    const pane = target.closest('[data-mk-pane]');
    if (pane) { setPane(pane.dataset.mkPane); return true; }
    const previewChannel = target.closest('[data-mk-preview-channel]');
    if (previewChannel) { composer.preview = previewChannel.dataset.mkPreviewChannel; refreshComposer(); return true; }
    const check = target.closest('[data-mk-check-field]');
    if (check) { focusCheck(check.dataset.mkCheckField, check.dataset.mkCheckPlatform); return true; }
    if (target.closest('[data-mk-ask-caption]')) { window.AtlasAI?.askAbout?.({ type: 'marketing', id: composer.id || 'new', label: `Caption for ${composer.draft.title || 'a new post'}`.trim() }); return true; }
    if (composer.editing) {
      const chip = target.closest('[data-mk-channel]');
      if (chip && !chip.disabled) { toggleChannel(chip.dataset.mkChannel); return true; }
      const mode = target.closest('[data-mk-when-mode]');
      if (mode) { composer.draft.when = mode.dataset.mkWhenMode; refreshComposer(); if (composer.draft.when === 'time') element.querySelector('#mk-when')?.focus(); return true; }
      const quick = target.closest('[data-mk-quick]');
      if (quick) {
        const c = clock();
        const current = composer.draft.scheduled && fromInput(composer.draft.scheduled) ? composer.draft.scheduled : inputValue(new Date().toISOString());
        const [day, time] = current.split('T');
        composer.draft.scheduled = `${c.addDays(day, Number(quick.dataset.mkQuick))}T${time}`;
        const input = element.querySelector('#mk-when');
        if (input) input.value = composer.draft.scheduled;
        refreshComposer();
        return true;
      }
      const format = target.closest('[data-mk-format]');
      if (format) { composer.draft.kinds[format.dataset.mkFormat] = format.dataset.mkKind; if (format.dataset.mkFormat === 'tiktok') composer.draft.tiktok.consent_confirmed_at = null; refreshComposer({ sections: true }); return true; }
      const toggle = target.closest('[data-mk-override-toggle]');
      if (toggle) {
        const p = toggle.dataset.mkOverrideToggle;
        if (typeof composer.draft.overrides[p] === 'string') delete composer.draft.overrides[p];
        else composer.draft.overrides[p] = composer.draft.caption;
        composer.openChannels = new Set([...(composer.openChannels || []), p]);
        refreshComposer({ sections: true });
        element.querySelector(`#mk-override-${CSS.escape(p)}`)?.focus();
        return true;
      }
      const reset = target.closest('[data-mk-override-reset]');
      if (reset) {
        const p = reset.dataset.mkOverrideReset;
        const previous = composer.draft.overrides[p];
        delete composer.draft.overrides[p];
        refreshComposer({ sections: true });
        window.AtlasShell?.toast?.(`${CHANNELS[p]} uses the common caption again.`, { action: { label: 'Undo', onClick: () => { if (state.composer === composer) { composer.draft.overrides[p] = previous; refreshComposer({ sections: true }); } } } });
        return true;
      }
      const commercial = target.closest('[data-mk-tt-commercial]');
      if (commercial) { composer.draft.tiktok.commercial = !composer.draft.tiktok.commercial; composer.draft.tiktok.consent_confirmed_at = null; refreshComposer({ sections: true }); return true; }
      const topic = target.closest('[data-mk-gbp-topic]');
      if (topic) { composer.draft.gbp.topic = topic.dataset.mkGbpTopic; refreshComposer({ sections: true }); return true; }
      const strip = target.closest('.mk-strip__item');
      if (strip) {
        const index = Number(strip.dataset.mkMediaIndex);
        const move = target.closest('[data-mk-media-move]');
        if (move && !move.disabled) { moveMedia(index, index + Number(move.dataset.mkMediaMove)); host()?.querySelector(`[data-mk-media-index="${index + Number(move.dataset.mkMediaMove)}"] [data-mk-media-move="${move.dataset.mkMediaMove}"]:not([disabled])`)?.focus(); return true; }
        if (target.closest('[data-mk-media-cover]')) { moveMedia(index, 0); return true; }
        if (target.closest('[data-mk-media-remove]')) { composer.draft.media.splice(index, 1); refreshComposer({ strip: true, sections: true }); announce('Removed from the post.'); return true; }
      }
    }
    if (target.closest('[data-mk-save]')) {
      const button = target.closest('[data-mk-save]');
      const approvedEdit = item && ['approved', 'scheduled'].includes(item.status);
      runComposerAction(button, async () => {
        const wasNew = !composer.id;
        await saveComposer({ message: approvedEdit ? 'Saved. It needs approval again before it publishes.' : 'Draft saved.' });
        if (wasNew) routeToPost(composer.id);
        remountComposer();
      });
      return true;
    }
    if (target.closest('[data-mk-submit]')) {
      const button = target.closest('[data-mk-submit]');
      if (!gate('submit')) return true;
      runComposerAction(button, async () => {
        const wasNew = !composer.id;
        const note = element.querySelector('#mk-note')?.value.trim() || null;
        const id = await saveComposer({ message: null });
        await mutate('submit-approval', { content_id: id, note }, 'Sent for approval.');
        if (wasNew) routeToPost(id);
        remountComposer();
      });
      return true;
    }
    const decide = target.closest('[data-mk-decide]');
    if (decide) {
      const decision = decide.dataset.mkDecide;
      const note = element.querySelector('#mk-note')?.value.trim() || '';
      if (decision !== 'approved' && !note) { composerError('Add a note so the team knows what to change.'); element.querySelector('#mk-note')?.focus(); return true; }
      if (decision === 'approved' && !gate('approve')) return true;
      runComposerAction(decide, async () => {
        const past = item.scheduled_for && Date.parse(item.scheduled_for) <= Date.now();
        await mutate('decide-approval', { content_id: item.id, decision, note }, decision === 'approved' ? (item.scheduled_for ? `Approved. It publishes ${dateTime(item.scheduled_for)}.` : 'Approved.') : decision === 'rejected' ? 'Rejected.' : 'Changes requested.');
        if (decision === 'approved' && past && autoPublishing()) await mutate('publish-now', { content_id: item.id }, 'Publishing now…');
        remountComposer();
      });
      return true;
    }
    if (target.closest('[data-mk-edit]')) {
      confirm({ title: 'Edit this approved post?', body: 'Any change sends it back for approval and it won’t publish until it’s approved again.', confirmLabel: 'Edit post', cancelLabel: 'Keep it as is' }).then((ok) => { if (ok && state.composer === composer) remountComposer({ editing: true }); });
      return true;
    }
    if (target.closest('[data-mk-cancel-edit]')) { remountComposer({ editing: false }); return true; }
    if (target.closest('[data-mk-publish-now]')) {
      const button = target.closest('[data-mk-publish-now]');
      if (!gate('publish')) return true;
      const auto = (item.platforms || []).filter((p) => targetFor(p)?.ready);
      const hand = (item.platforms || []).filter((p) => !auto.includes(p));
      confirm({ title: auto.length ? `Publish to ${listText(auto.map((p) => CHANNELS[p]))} now?` : 'Publish now?', body: `It goes live straight away.${hand.length ? ` ${listText(hand.map((p) => CHANNELS[p]))} ${hand.length === 1 ? 'is' : 'are'} posted by hand.` : ''}`, confirmLabel: 'Publish now' }).then((ok) => {
        if (!ok || state.composer !== composer) return;
        runComposerAction(button, async () => {
          await mutate('publish-now', { content_id: item.id }, `Publishing to ${plural(auto.length || (item.platforms || []).length, 'channel')}…`);
          remountComposer({ editing: false });
        });
      });
      return true;
    }
    if (target.closest('[data-mk-retry-failed]')) {
      const button = target.closest('[data-mk-retry-failed]');
      const failed = deliveriesOf(item).filter((d) => ['failed', 'needs_attention'].includes(d.status));
      runComposerAction(button, async () => {
        for (const delivery of failed) await retryDelivery(delivery.id, delivery.provider_key, item, { quiet: true });
        window.AtlasShell?.toast?.(`Retrying ${listText(failed.map((d) => CHANNEL_SHORT[d.provider_key]))}. Channels already published won't post again.`);
        remountComposer({ editing: false });
      });
      return true;
    }
    if (target.closest('[data-mk-cancel-post]') || target.closest('[data-mk-delete-draft]')) {
      const button = target.closest('[data-mk-cancel-post], [data-mk-delete-draft]');
      const draftDelete = Boolean(target.closest('[data-mk-delete-draft]'));
      confirm(draftDelete
        ? { title: 'Delete this draft?', body: 'It’s removed from the plan. The photos and videos stay in the library.', confirmLabel: 'Delete draft', danger: true }
        : { title: 'Cancel this post?', body: 'It won’t be published. Channels that already published keep their post.', confirmLabel: 'Cancel post', cancelLabel: 'Keep it', danger: true }).then((ok) => {
        if (!ok || state.composer !== composer) return;
        runComposerAction(button, async () => {
          await mutate('cancel-content', { content_id: item.id }, draftDelete ? 'Draft deleted.' : 'Post cancelled. Nothing more will be published.');
          closeComposer();
          window.AtlasShell?.navigate?.('#marketing/posts');
        });
      });
      return true;
    }
    if (target.closest('[data-mk-duplicate]')) {
      const button = target.closest('[data-mk-duplicate]');
      runComposerAction(button, async () => {
        const result = await mutate('duplicate-content', { content_id: item.id }, 'Copied as a new draft.');
        const id = result?.content?.id || result?.content_id || result?.id;
        if (id) { state.composer = null; window.AtlasShell?.navigate?.(`#marketing/post?id=${encodeURIComponent(id)}`); }
      });
      return true;
    }
    if (target.closest('[data-mk-published]')) {
      const button = target.closest('[data-mk-published]');
      runComposerAction(button, async () => {
        await mutate('mark-published', { content_id: item.id, published_at: new Date().toISOString(), external_publication_ids: {}, note: null }, 'Marked as posted by hand. Nothing was posted by Atlas.');
        remountComposer({ editing: false });
      });
      return true;
    }
    return false;
  }

  // ---- channel actions (History and the composer's Publishing section) ----

  async function retryDelivery(deliveryId, platform, item, { quiet = false } = {}) {
    const name = CHANNEL_SHORT[platform] || humanize(platform);
    const published = deliveriesOf(item).filter((d) => d.status === 'published').map((d) => CHANNEL_SHORT[d.provider_key]);
    const message = quiet ? null : `Retrying ${name}.${published.length ? ` ${listText(published)} ${published.length === 1 ? 'is' : 'are'} already published and won't post again.` : ''}`;
    try {
      await mutate('retry-delivery', { delivery_id: deliveryId }, message, `The ${name} channel`);
    } catch (error) {
      if (error.code !== 'attestation_required') throw error;
      const ok = await confirm({ title: `Was it posted to ${name}?`, body: `Atlas couldn't confirm what happened. Check ${name} first. If the post isn't there, confirm and Atlas tries again.`, confirmLabel: 'It wasn’t posted, retry', cancelLabel: 'Cancel' });
      if (!ok) return;
      await mutate('retry-delivery', { delivery_id: deliveryId, confirmed_not_posted: true }, message, `The ${name} channel`);
    }
  }

  async function markDeliveryPosted(deliveryId, platform) {
    const name = CHANNELS[platform] || humanize(platform);
    const link = await window.AtlasModal?.prompt?.({ title: `Mark posted by hand on ${name}`, body: 'Paste the link to the post so the team can find it.', label: 'Post link', type: 'url', placeholder: 'https://', required: true, multiline: false, confirmLabel: 'Mark posted' });
    if (!link) return;
    if (!/^https:\/\/\S+$/i.test(link)) { window.AtlasShell?.toast?.('Enter a full link starting with https://', { tone: 'warning' }); return; }
    await mutate('mark-delivery-posted', { delivery_id: deliveryId, permalink: link }, `Marked as posted by hand on ${name}.`);
  }

  async function skipDelivery(deliveryId, platform) {
    const name = CHANNELS[platform] || humanize(platform);
    const ok = await confirm({ title: `Don't post to ${name}?`, body: `${name} is skipped for this post. Other channels aren't affected.`, confirmLabel: `Don't post to ${CHANNEL_SHORT[platform]}`, danger: true });
    if (!ok) return;
    await mutate('cancel-delivery', { delivery_id: deliveryId }, `${name} won't be posted.`);
  }

  async function openHistoryDetails(contentId) {
    const item = findItem(contentId);
    const root = modal('mk-history-sheet');
    root.innerHTML = `<section class="atlas-sheet atlas-sheet--wide atlas-sheet--full-phone" data-modal-panel aria-labelledby="mk-history-title"><span class="atlas-sheet__grabber"></span><header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="mk-history-title">${escapeHtml(item?.title || 'Post history')}</h2><p class="atlas-sheet__desc">Each channel's attempts, approvals and changes.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header><div class="atlas-sheet__body" data-mk-history-body><div class="mk-skeleton" aria-busy="true">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(4)}</div></div><footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--secondary" data-modal-close>Close</button></footer></section>`;
    window.AtlasModal.open(root);
    window.lucide?.createIcons?.();
    const body = root.querySelector('[data-mk-history-body]');
    try {
      const payload = await api('history', { params: { content_id: contentId } });
      const data = payload.history || {};
      const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
      body.innerHTML = `${deliveries.length ? deliveries.map((d) => `<section class="atlas-stack atlas-stack--sm mk-history-detail"><p class="atlas-label">${escapeHtml(CHANNELS[d.provider_key] || humanize(d.provider_key))} · ${escapeHtml(FORMAT_LABEL[d.target_kind] || humanize(d.target_kind))}</p>
          <p class="atlas-row__meta">${escapeHtml([humanize(d.status), d.published_at ? `published ${dateTime(d.published_at)}${d.published_source === 'manual' ? ' (by hand)' : ''}` : '', d.next_attempt_at && d.status === 'retrying' ? `next try ${dateTime(d.next_attempt_at)}` : '', `${d.attempt_count || 0} of ${d.max_attempts || 6} tries`].filter(Boolean).join(' · '))}</p>
          ${d.last_error_message ? `<p class="atlas-row__meta mk-channel-error">${escapeHtml(d.last_error_message)}</p>` : ''}
          ${d.provider_permalink ? `<p><a class="atlas-link" href="${escapeHtml(d.provider_permalink)}" target="_blank" rel="noopener">View the post<i data-lucide="arrow-up-right"></i></a></p>` : ''}
          ${Array.isArray(d.attempts) && d.attempts.length ? `<ul class="atlas-list">${d.attempts.map((a) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">Try ${escapeHtml(a.attempt_no)} · ${escapeHtml(humanize(a.outcome || a.claim_kind || ''))}</p><p class="atlas-row__meta">${escapeHtml(dateTime(a.started_at, '—'))}${Array.isArray(a.steps) && a.steps.length ? ` · ${escapeHtml(a.steps.map((s) => humanize(s.step)).filter(Boolean).join(', '))}` : ''}</p></div></li>`).join('')}</ul>` : ''}
        </section>`).join('') : '<p class="mk-muted">Nothing has been sent to a channel yet.</p>'}
        ${Array.isArray(data.approvals) && data.approvals.length ? `<section class="atlas-stack atlas-stack--sm"><p class="atlas-label">Approvals</p><ul class="atlas-list">${data.approvals.map((a) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(humanize(a.decision))}${a.actor_label ? ` by ${escapeHtml(a.actor_label)}` : ''}</p><p class="atlas-row__meta">${escapeHtml(dateTime(a.created_at, '—'))}${a.note ? ` · ${escapeHtml(a.note)}` : ''}</p></div></li>`).join('')}</ul></section>` : ''}`;
      window.lucide?.createIcons?.();
    } catch (error) {
      body.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="circle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escapeHtml(errorText(error, 'The history'))}</p></div></div>`;
      window.lucide?.createIcons?.();
    }
  }

  // ---------- sheets ----------

  function modal(id) {
    let element = document.getElementById(id);
    if (!element) {
      element = document.createElement('div');
      element.id = id;
      element.className = 'atlas-modal';
      element.hidden = true;
      element.setAttribute('data-atlas-modal', '');
      document.body.appendChild(element);
      window.AtlasModal.register(element, { closeOnBackdrop: true });
    }
    return element;
  }

  function openCampaign() {
    const root = modal('mk-campaign');
    root.innerHTML = `<section class="atlas-dialog atlas-dialog--form" data-modal-panel aria-labelledby="mk-campaign-title">
        <h2 class="atlas-dialog__title" id="mk-campaign-title">New campaign</h2>
        <form class="atlas-dialog__body atlas-form" data-mk-campaign-form>
          <div class="atlas-field"><label for="mk-c-name">Name</label><input class="atlas-input" id="mk-c-name" name="name" maxlength="180" required></div>
          <div class="atlas-field"><label for="mk-c-type">Type</label><select class="atlas-select" id="mk-c-type" name="campaign_type">${['promotion', 'event', 'seasonal', 'always_on', 'brand', 'other'].map((key) => `<option value="${key}">${humanize(key)}</option>`).join('')}</select></div>
          <div class="atlas-grid-2"><div class="atlas-field"><label for="mk-c-start">Starts</label><input class="atlas-input" ${DATE_FIELD} id="mk-c-start" name="start"></div><div class="atlas-field"><label for="mk-c-end">Ends</label><input class="atlas-input" ${DATE_FIELD} id="mk-c-end" name="end" data-atlas-min-from="mk-c-start"></div></div>
          <div class="atlas-field"><label for="mk-c-desc">Goal <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="mk-c-desc" name="description" rows="3"></textarea></div>
          <p class="error" data-mk-error hidden></p>
          <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary">Create campaign</button></div>
        </form></section>`;
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const line = form.querySelector('[data-mk-error]');
      if (!form.elements.name.value.trim()) { line.hidden = false; line.textContent = 'Give the campaign a name.'; return; }
      if (form.elements.start.value && form.elements.end.value && form.elements.end.value < form.elements.start.value) { line.hidden = false; line.textContent = 'The end date is before the start date.'; return; }
      try {
        await mutate('create-campaign', { name: form.elements.name.value.trim(), campaign_type: form.elements.campaign_type.value, campaign_start_date: form.elements.start.value || null, campaign_end_date: form.elements.end.value || null, platforms: [], objective: '', target_audience: '', description: form.elements.description.value }, 'Campaign created.', 'The campaign');
        window.AtlasModal.close(root, 'saved');
      } catch (error) { line.hidden = false; line.textContent = error.userMessage || 'Nothing was changed. Try again.'; }
    });
    window.AtlasModal.open(root);
  }

  // ---------- events and routing ----------

  function navigateToNew(params = '') {
    window.AtlasShell?.navigate?.(`#marketing/new${params}`);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    if (state.composer) { handleComposerClick(target, event); return; }
    if (target.closest('[data-mk-retry]')) { load(); return; }
    if (target.closest('[data-mk-media-retry]')) { state.mediaMounted = false; render(); return; }
    if (target.closest('[data-mk-ask]')) { window.AtlasAI?.askAbout?.({ type: 'marketing', id: state.tab, label: `Marketing ${TABS.find(([key]) => key === state.tab)?.[1] || ''}`.trim() }); return; }
    if (target.closest('[data-mk-new]')) { navigateToNew(); return; }
    const onDay = target.closest('[data-mk-new-on]');
    if (onDay) { if (state.staff?.can_create !== false) navigateToNew(`?date=${onDay.dataset.mkNewOn}`); return; }
    const retry = target.closest('[data-mk-retry-delivery]');
    if (retry) {
      const item = findItem(retry.dataset.mkContent);
      retry.classList.add('is-loading'); retry.disabled = true;
      retryDelivery(retry.dataset.mkRetryDelivery, retry.dataset.mkChannel, item).catch((error) => { window.AtlasShell?.toast?.(error.userMessage || 'Nothing was changed. Try again.', { tone: 'warning' }); render(); });
      return;
    }
    const posted = target.closest('[data-mk-mark-posted]');
    if (posted) { markDeliveryPosted(posted.dataset.mkMarkPosted, posted.dataset.mkChannel).catch((error) => window.AtlasShell?.toast?.(error.userMessage || 'Nothing was changed. Try again.', { tone: 'warning' })); return; }
    const skip = target.closest('[data-mk-skip-delivery]');
    if (skip) { skipDelivery(skip.dataset.mkSkipDelivery, skip.dataset.mkChannel).catch((error) => window.AtlasShell?.toast?.(error.userMessage || 'Nothing was changed. Try again.', { tone: 'warning' })); return; }
    const details = target.closest('[data-mk-history-details]');
    if (details) { openHistoryDetails(details.dataset.mkHistoryDetails); return; }
    const open = target.closest('[data-mk-open]');
    if (open) { window.AtlasShell?.navigate?.(`#marketing/post?id=${encodeURIComponent(open.dataset.mkOpen)}`); return; }
    const plan = target.closest('[data-mk-plan]');
    if (plan) { navigateToNew(`?suggestion=${encodeURIComponent(plan.dataset.mkPlan)}`); return; }
    if (target.closest('[data-mk-new-campaign]')) { openCampaign(); return; }
    const filter = target.closest('[data-mk-filter]');
    if (filter) { state.postFilter = filter.dataset.mkFilter; render(); return; }
    const historyFilter = target.closest('[data-mk-history-filter]');
    if (historyFilter) { state.historyFilter = historyFilter.dataset.mkHistoryFilter; render(); return; }
    const channelFilter = target.closest('[data-mk-channel-filter]');
    if (channelFilter) { state.channelFilter = channelFilter.dataset.mkChannelFilter; render(); return; }
    const expand = target.closest('[data-mk-expand-day]');
    if (expand) { state.expandedDay = state.expandedDay === expand.dataset.mkExpandDay ? null : expand.dataset.mkExpandDay; render(); return; }
    const month = target.closest('[data-mk-month]');
    if (month) {
      const step = Number(month.dataset.mkMonth);
      const current = monthRange();
      const c = clock();
      state.month = step === 0 ? venueToday().slice(0, 7) : step < 0 ? c.monthKey(c.addDays(current.start, -1)) : c.monthKey(c.addDays(current.end, 1));
      state.workspace = state.workspace ? { ...state.workspace } : null;
      load();
    }
  }

  // The shell routes #marketing/<section>; the composer's id travels as a
  // query (#marketing/post?id=…) because the route table keeps one segment.
  // A typed #marketing/post/<id> is read from the address as well.
  function composerRoute(params) {
    if (params.section === 'new') return { id: null };
    if (params.section !== 'post') return null;
    let id = params.id || params.post || null;
    if (!id) {
      const match = String(window.location.hash || '').match(/^#marketing\/post\/([^/?#]+)/);
      if (match && match[1] !== 'new') id = decodeURIComponent(match[1]);
    }
    return { id };
  }

  function onShow(params = {}) {
    state.focusSuggestion = params.recommendation ? String(params.recommendation) : null;
    const route = composerRoute(params);
    if (route) {
      const current = state.composer;
      const same = current && ((route.id && (current.id === route.id || current.requestedId === route.id)) || (!route.id && !current.id && !current.requestedId));
      if (!same) {
        const suggestion = params.suggestion ? suggestions().find((entry) => String(entry.id) === String(params.suggestion)) || null : null;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(params.date || '')) ? params.date : suggestion ? suggestion.occurrence_date || venueToday() : null;
        openComposer({ id: route.id, date, suggestion });
      } else render();
    } else {
      if (state.composer) closeComposer();
      const tab = state.focusSuggestion ? 'overview' : TAB_ALIASES[params.section] || params.section || 'overview';
      state.tab = TABS.some(([key]) => key === tab) ? tab : 'overview';
      state.linkedPost = state.tab === 'history' && params.post ? String(params.post) : null;
      render();
    }
    if (isManager() && !state.workspace && !state.loading) load();
    else schedulePoll();
  }

  function ensureStructure() {
    if (!host()) {
      const view = document.createElement('div');
      view.id = 'marketing-view';
      view.style.display = 'none';
      const parent = document.querySelector('.atlas-content.standard-view main') || document.querySelector('.atlas-content main');
      parent?.appendChild(view);
    }
    if (!state.registered && window.AtlasShell) {
      state.registered = true;
      window.AtlasShell.registerView('marketing', { root: host, title: 'Marketing', onShow });
      window.AtlasShell.on?.('view:hide', (detail) => { if (detail?.view === 'marketing') { window.clearTimeout(state.pollTimer); if (state.composer && !dirty()) closeComposer(); } });
      window.AtlasShell.actions?.register?.({ id: 'marketing.post.new', label: 'New post', icon: 'megaphone', keywords: ['post', 'instagram', 'facebook', 'tiktok', 'social', 'marketing'], roles: MANAGERS, contexts: ['marketing', 'home'], run: () => navigateToNew() });
      window.AtlasShell.actions?.register?.({ id: 'marketing.history.failed', label: 'Show failed posts', icon: 'circle-alert', keywords: ['failed', 'retry', 'marketing', 'publish'], roles: MANAGERS, contexts: ['marketing', 'home'], run: () => { state.historyFilter = 'failed'; window.AtlasShell.navigate('#marketing/history'); } });
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStructure();
    document.addEventListener('click', handleClick);
    window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
    window.AtlasShell?.on?.('profile:ready', () => { if (visible()) render(); });
  }

  window.AtlasMarketingWorkspace = {
    open: () => window.AtlasShell?.navigate?.('#marketing'),
    refresh: () => load(),
    snapshot: () => state.workspace,
    openContent: (contentId) => window.AtlasShell?.navigate?.(`#marketing/post?id=${encodeURIComponent(contentId)}`),
    newPost: (options = {}) => navigateToNew(options.date ? `?date=${encodeURIComponent(options.date)}` : '')
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
