// Messages — #messages, #messages/<conversationId> (docs/design/Atlas_Experience_Redesign.md §7.3, §8.5).
//
// Conversation list + thread with composer. Internal AtlasShell view id stays
// 'team' (spec §3.4: only the route changed; #team is the Team directory).
//
// Identity rules (S87, binding): a sender is shown by sender_id → the current
// roster's display name → a safe label derived from the stored sender_label →
// "Former team member". An email address is never shown. Photos come from
// AtlasTeamProfilePhotos.photoFor(sender_id). Atlas recommendation links are
// manager-only: the composer offers them only when the server says
// can_link_brain_recommendations, and staff see such a link without its title.
//
// Unread state: channel counts come from the same server snapshot that the
// shell badge (AtlasTeamUnreadBadge) polls; AtlasTeamMessages.unread() exposes
// the per-conversation counts for the notifications feed.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const POLL_FALLBACK_MS = 6000;
  const REQUEST_TIMEOUT_MS = 15000;
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const MANAGER_ROLES = ['admin', 'manager'];
  const HANDOVER_CHANNEL = 'shift-handover';
  const PHONE = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener() {} };
  const LINK_TYPES = [
    { type: 'inventory_item', label: 'Item', icon: 'package', noun: 'items' },
    { type: 'routine', label: 'Checklist', icon: 'clipboard-check', noun: 'checklists due today' },
    { type: 'shift', label: 'Shift', icon: 'calendar-days', noun: 'shifts' },
    { type: 'brain_recommendation', label: 'Recommendation', icon: 'sparkles', noun: 'Atlas recommendations', managerOnly: true }
  ];
  const LINK_ICONS = { inventory_item: 'package', routine: 'clipboard-check', shift: 'calendar-days', brain_recommendation: 'sparkles', knowledge_article: 'book-open' };

  const state = {
    snapshot: null,
    staff: null,
    members: [],
    selectedChannel: null,
    routeChannel: null,
    search: '',
    loading: false,
    channelLoading: false,
    submitting: false,
    markingRead: false,
    starring: false,
    error: null,
    failedAt: 0,
    drafts: Object.create(null),
    failed: Object.create(null),
    unreadFrom: Object.create(null),
    editingMessageId: null,
    selectedTarget: null,
    pollTimer: null,
    visible: false,
    initialized: false,
    root: null,
    renderedIds: '',
    pendingNew: 0,
    loadSerial: 0
  };

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatBody(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
  }

  function initials(value) {
    const words = String(value || 'Atlas').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'A';
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('');
  }

  const ROLE_LABELS = { admin: 'Administrator', manager: 'Manager', bartender: 'Bartender', viewer: 'Viewer' };
  function roleLabel(role) {
    return ROLE_LABELS[role] || String(role || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  // A visible name never shows an email address: an email-only label becomes
  // its readable local part ("sara.jonsdottir@…" → "Sara Jonsdottir").
  function safePersonLabel(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (!text.includes('@')) return text;
    const local = text.split('@')[0].replace(/\d+$/, '');
    const words = local.split(/[._+-]+/).filter(Boolean);
    return words.length ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : '';
  }

  // Presentation identity is resolved from sender_id against the current
  // profile roster; the stored sender_label is only a historical fallback for
  // people who are no longer active. Audit history is never rewritten.
  function senderIdentity(message) {
    const member = message.sender_id ? state.members.find((entry) => entry.id === message.sender_id) : null;
    const name = safePersonLabel(member?.label) || safePersonLabel(message.sender_label) || 'Former team member';
    return { id: message.sender_id || null, name, role: member?.role || message.sender_role || '', current: Boolean(member) };
  }

  // "Own" is the signed-in profile's id against the message's sender_id (the
  // staff record the service returns, else the shell profile); never an email.
  // Without a known viewer id the service's is_own flag is used.
  function viewerId() {
    return state.staff?.id || window.AtlasShell?.profile?.()?.id || null;
  }

  function isOwn(message) {
    if (!message || message.message_type === 'system') return false;
    const me = viewerId();
    return me ? Boolean(message.sender_id) && message.sender_id === me : message.is_own === true;
  }

  function avatarTint(key) {
    const text = String(key || 'atlas');
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
    return `atlas-avatar--${'abcd'[hash % 4]}`;
  }

  function avatarMarkup(identity, size = '') {
    const photo = identity.id ? window.AtlasTeamProfilePhotos?.photoFor?.(identity.id) : null;
    const classes = `atlas-avatar ${size} ${avatarTint(identity.id || identity.name)} msg-avatar${photo?.signed_url ? ' has-profile-photo' : ''}`;
    const inner = photo?.signed_url
      ? `<img src="${escapeHtml(photo.signed_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
      : escapeHtml(initials(identity.name));
    return `<span class="${classes}" ${identity.id ? `data-team-sender="${escapeHtml(identity.id)}"` : ''} aria-hidden="true">${inner}</span>`;
  }

  function clock() {
    return window.AtlasVenueClock || null;
  }

  function venueDateOf(value) {
    return clock()?.venueDate?.(value) || '';
  }

  // Same-day check in the venue zone (Atlas_Time_Migration.md, Team D).
  function formatStamp(value) {
    if (!value) return '';
    const vc = clock();
    if (!vc) return '';
    return venueDateOf(value) === venueDateOf(new Date()) ? vc.formatTime(value) : vc.formatDateTime(value);
  }

  function dayLabel(value) {
    const vc = clock();
    if (!vc) return '';
    const key = venueDateOf(value);
    const today = venueDateOf(new Date());
    if (key === today) return 'Today';
    if (key === vc.addDays(today, -1)) return 'Yesterday';
    return vc.formatDate(key, { long: true });
  }

  function isoOf(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  function icon(name) {
    return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
  }

  function paintIcons() {
    window.lucide?.createIcons?.();
  }

  function role() {
    return state.staff?.role || window.AtlasShell?.profile?.()?.role || window.atlasCurrentProfile?.role || null;
  }

  function isManager() {
    return MANAGER_ROLES.includes(role());
  }

  function host() {
    return document.getElementById('team-view');
  }

  function teamApi() {
    return String(cfg.TEAM_MESSAGES_API || '').trim();
  }

  function teamViewVisible() {
    const element = host();
    if (!element) return false;
    const app = document.getElementById('app-screen');
    return window.getComputedStyle(element).display !== 'none'
      && (!app || window.getComputedStyle(app).display !== 'none');
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  class MessagesError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
      this.atlasFixed = true;
    }
  }
  // Only this module's own fixed copy (atlasFixed) is shown; a JavaScript error
  // or server text reads as the fallback (AtlasApi.message).
  function shown(error, fallback) {
    if (window.AtlasApi?.message) return window.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }

  async function api(action, options = {}) {
    const endpoint = teamApi();
    if (!endpoint) throw new MessagesError('Messages are not set up for this Atlas yet.', 0);
    const session = await activeSession();
    if (!session?.access_token) throw new MessagesError('Sign in again to read messages.', 401);

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
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new MessagesError(friendlyError(response.status, payload.error), response.status);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new MessagesError('Messages took too long to answer. Check the connection and try again.', 0);
      if (error instanceof MessagesError) throw error;
      throw new MessagesError('Messages couldn’t be reached. Check the connection and try again.', 0);
    } finally {
      window.clearTimeout(timer);
    }
  }

  // Server messages are shown only when they are already written for people
  // (4xx validation answers); anything else becomes a plain sentence.
  // Fixed copy only (AtlasApi, atlas-api.js): server text is never shown,
  // whatever its length or wording.
  const API_MESSAGES = {
    auth: 'Atlas couldn’t confirm your sign-in for this. Try again in a moment.',
    forbidden: 'Your role can’t do that in Messages.',
    not_found: 'That conversation or message isn’t available any more.',
    conflict: 'This changed while you were writing. Refresh and try again.',
    invalid: 'That message couldn’t be sent. Check it and try again.',
    rate_limited: 'You’re sending messages quickly. Wait a moment, then try again.',
    unavailable: 'Messages are temporarily unavailable.',
    failed: 'Messages are temporarily unavailable.'
  };

  function friendlyError(status, message) {
    const api = window.AtlasApi;
    return api ? api.friendlyMessage(api.kindFor(status, null), null, API_MESSAGES) : 'Messages are temporarily unavailable.';
  }

  // ---------- data ----------

  function channels() {
    return Array.isArray(state.snapshot?.channels) ? state.snapshot.channels : [];
  }

  function messages() {
    return Array.isArray(state.snapshot?.messages) ? state.snapshot.messages : [];
  }

  function channelByKey(key) {
    return channels().find((channel) => channel.key === key) || null;
  }

  function selectedChannel() {
    return channelByKey(state.selectedChannel) || null;
  }

  function snapshotChannelKey() {
    return state.snapshot?.selected_channel_key || null;
  }

  function currentDraft() {
    return state.drafts[state.selectedChannel] || '';
  }

  function setCurrentDraft(value) {
    state.drafts[state.selectedChannel] = String(value ?? '');
  }

  function totalUnread() {
    return Number(state.snapshot?.summary?.total_unread || 0);
  }

  function canPostIn(channel) {
    return Boolean(state.staff?.can_post && channel?.can_post);
  }

  function userIsInteracting() {
    const element = document.activeElement;
    const inside = element && host()?.contains(element);
    return Boolean(state.editingMessageId || (inside && ['TEXTAREA', 'INPUT', 'SELECT'].includes(element.tagName) && currentDraft().trim()));
  }

  // ---------- skeleton ----------

  function ensureRoot() {
    const element = host();
    if (!element) return null;
    if (element.classList.contains('placeholder-view')) element.classList.remove('placeholder-view');
    if (element.dataset.msgReady === 'true' && state.root?.isConnected) return state.root;
    element.dataset.msgReady = 'true';
    element.classList.add('msg-host', 'page--full-height');
    element.innerHTML = `<div class="msg" data-msg-view="list">
      <aside class="msg-side" aria-label="Conversations">
        <header class="page-head msg-side__head"><div class="page-head__text"><h1 class="page-head__title">Messages</h1></div></header>
        <label class="atlas-search msg-side__search">${icon('search')}<input class="atlas-input" type="search" placeholder="Search conversations" aria-label="Search conversations" data-msg-search autocomplete="off"></label>
        <nav class="msg-side__list" aria-label="Conversations" data-msg-list></nav>
      </aside>
      <section class="msg-thread" data-msg-thread aria-labelledby="msg-thread-title">
        <header class="msg-thread__head" data-msg-head></header>
        <div class="msg-thread__alert" data-msg-alert></div>
        <div class="msg-thread__scroll" data-msg-scroll>
          <div class="msg-log" data-msg-log data-team-message-list role="log" aria-live="polite" aria-relevant="additions text" aria-labelledby="msg-thread-title"></div>
        </div>
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm msg-jump" data-msg-jump hidden>${icon('arrow-down')}<span data-msg-jump-label>New messages</span></button>
        <div class="msg-composer" data-msg-composer></div>
      </section>
    </div>`;
    state.root = element.querySelector('.msg');
    const scroll = element.querySelector('[data-msg-scroll]');
    scroll?.addEventListener('scroll', () => {
      if (nearBottom()) hideJump();
    }, { passive: true });
    paintIcons();
    return state.root;
  }

  function region(name) {
    return state.root?.querySelector(`[data-msg-${name}]`) || null;
  }

  // ---------- conversation list ----------

  function channelIcon(channel) {
    if (channel.key === 'announcements') return 'megaphone';
    if (channel.key === HANDOVER_CHANNEL) return 'repeat-2';
    return 'hash';
  }

  function previewOf(channel) {
    const last = channel.last_message;
    if (!last) return channel.description || 'No messages yet';
    if (last.deleted) return 'Message deleted';
    const who = last.message_type === 'system' ? 'Atlas' : safePersonLabel(last.sender_label);
    return who ? `${who}: ${last.body || ''}` : String(last.body || '');
  }

  function channelRowMarkup(channel) {
    const unread = Number(channel.unread_count || 0);
    const current = channel.key === state.selectedChannel && (!PHONE.matches || state.routeChannel);
    const time = channel.last_message?.created_at ? formatStamp(channel.last_message.created_at) : '';
    return `<a class="msg-channel${unread ? ' has-unread' : ''}" href="#messages/${encodeURIComponent(channel.key)}" data-team-channel="${escapeHtml(channel.key)}" ${current ? 'aria-current="page"' : ''} aria-label="${escapeHtml(channel.name)}${unread ? `, ${unread} unread` : ''}">
      <span class="msg-channel__icon">${icon(channelIcon(channel))}</span>
      <span class="msg-channel__body">
        <span class="msg-channel__name">${escapeHtml(channel.name)}${channel.starred ? `<span class="sr-only"> (pinned)</span>${icon('pin')}` : ''}</span>
        <span class="msg-channel__preview">${escapeHtml(previewOf(channel))}</span>
      </span>
      <span class="msg-channel__end">${time ? `<time class="msg-channel__time" datetime="${escapeHtml(isoOf(channel.last_message.created_at))}">${escapeHtml(time)}</time>` : ''}${unread ? `<span class="atlas-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</span>
    </a>`;
  }

  function renderList() {
    const list = region('list');
    if (!list) return;
    if (!state.snapshot) {
      list.innerHTML = state.error
        ? '<p class="msg-side__empty">Conversations couldn’t be loaded.</p>'
        : `<div class="msg-side__skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(5)}<span class="sr-only">Loading conversations</span></div>`;
      return;
    }
    const query = state.search.trim().toLowerCase();
    const rows = channels().filter((channel) => !query || [channel.name, channel.description, previewOf(channel)].some((text) => String(text || '').toLowerCase().includes(query)));
    const pinned = rows.filter((channel) => channel.starred);
    const others = rows.filter((channel) => !channel.starred);
    if (!rows.length) {
      list.innerHTML = `<p class="msg-side__empty">No conversations match “${escapeHtml(state.search.trim())}”.</p>`;
      return;
    }
    list.innerHTML = `${pinned.length ? `<p class="msg-side__group">Pinned</p>${pinned.map(channelRowMarkup).join('')}` : ''}
      <p class="msg-side__group">Channels</p>${others.map(channelRowMarkup).join('')}`;
    paintIcons();
  }

  // ---------- thread ----------

  function renderHead() {
    const head = region('head');
    if (!head) return;
    const channel = selectedChannel();
    if (!channel) {
      head.innerHTML = `<h2 class="msg-thread__title" id="msg-thread-title">${state.snapshot || state.error ? 'Messages' : 'Loading…'}</h2>`;
      return;
    }
    const handover = channel.key === HANDOVER_CHANNEL && canPostIn(channel);
    head.innerHTML = `<div class="msg-thread__text">
        <h2 class="msg-thread__title" id="msg-thread-title">${icon(channelIcon(channel))}<span>${escapeHtml(channel.name)}</span></h2>
        ${channel.description ? `<p class="msg-thread__desc">${escapeHtml(channel.description)}</p>` : ''}
      </div>
      <div class="msg-thread__actions">
        ${handover ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-msg-handover>${icon('notebook-pen')}Write handover</button>` : ''}
        <button type="button" class="atlas-icon-btn" data-team-star aria-pressed="${channel.starred ? 'true' : 'false'}" aria-label="${channel.starred ? 'Unpin' : 'Pin'} ${escapeHtml(channel.name)}" ${state.starring ? 'disabled' : ''}>${icon(channel.starred ? 'pin-off' : 'pin')}</button>
      </div>`;
    paintIcons();
  }

  function renderAlert() {
    const alert = region('alert');
    if (!alert) return;
    if (!state.error) { alert.innerHTML = ''; return; }
    alert.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(state.snapshot ? 'Messages couldn’t be updated.' : 'Messages couldn’t be loaded.')}</p><p class="atlas-alert__body">${escapeHtml(state.error)} Nothing you wrote has been lost.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-team-refresh>Try again</button></div></div>`;
    paintIcons();
  }

  function linkHref(link) {
    const key = encodeURIComponent(String(link.key || ''));
    if (link.type === 'inventory_item') return `#inventory/item/${key}`;
    if (link.type === 'knowledge_article') return `#knowledge/${key}`;
    if (link.type === 'routine') return '#operations';
    if (link.type === 'shift') {
      const starts = link.metadata?.starts_at;
      const week = starts && clock() ? clock().startOfWeek(clock().businessDate(starts)) : null;
      return week ? `#shifts?week=${week}` : '#shifts';
    }
    if (link.type === 'brain_recommendation') return link.key ? `#ai/decisions?recommendation=${encodeURIComponent(link.key)}` : '#ai/decisions';
    return '#home';
  }

  function linkMarkup(link) {
    if (!link) return '';
    const iconName = LINK_ICONS[link.type] || 'link-2';
    // Recommendation titles are manager context; staff see only that one exists.
    if (link.type === 'brain_recommendation' && !isManager()) {
      return `<span class="atlas-record-chip msg-link is-locked">${icon('lock')}<span>Atlas recommendation · managers only</span></span>`;
    }
    return `<a class="atlas-record-chip msg-link" href="${escapeHtml(linkHref(link))}" data-team-open-link="${escapeHtml(link.type)}" data-team-link-key="${escapeHtml(link.key)}">${icon(iconName)}<span>${escapeHtml(link.label || 'Linked record')}</span></a>`;
  }

  function readStatusMarkup(message) {
    if (!isOwn(message) || message.message_type !== 'user') return '';
    const readers = Array.isArray(message.read_by) ? message.read_by : [];
    const count = Number(message.read_by_count || readers.length || 0);
    if (!count) return '<span class="msg-item__read">Sent</span>';
    const names = readers.map((reader) => safePersonLabel(state.members.find((member) => member.id === reader.user_id)?.label || reader.user_label)).filter(Boolean).join(', ');
    return `<span class="msg-item__read" ${names ? `title="Read by ${escapeHtml(names)}"` : ''}>${icon('check-check')}Read by ${count}</span>`;
  }

  function messageMarkup(message, previous) {
    const time = message.created_at;
    const stamp = `<time class="msg-item__time" datetime="${escapeHtml(isoOf(time))}">${escapeHtml(formatStamp(time))}${message.edited_at ? ' · edited' : ''}</time>`;
    const own = isOwn(message);
    if (message.deleted) {
      return `<article class="msg-item is-deleted${own ? ' is-own' : ''}" data-team-message="${escapeHtml(message.id)}">
        <span class="msg-item__gutter"></span>
        <div class="msg-item__body"><p class="msg-item__text">Message deleted</p>${stamp}</div>
      </article>`;
    }
    const system = message.message_type === 'system';
    const identity = system ? { id: null, name: 'Atlas', role: '', current: true } : senderIdentity(message);
    const grouped = !system && previous && !previous.deleted && previous.message_type !== 'system'
      && previous.sender_id && previous.sender_id === message.sender_id
      && venueDateOf(previous.created_at) === venueDateOf(time)
      && (new Date(time) - new Date(previous.created_at)) < GROUP_WINDOW_MS;
    const roleText = system ? 'System update' : `${roleLabel(identity.role)}${identity.current ? '' : ' · no longer active'}`;
    const actions = [
      message.can_edit ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-edit="${escapeHtml(message.id)}">Edit</button>` : '',
      message.can_delete ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-delete="${escapeHtml(message.id)}">Delete</button>` : ''
    ].join('');
    const readStatus = readStatusMarkup(message);
    // Own messages sit on the right without an avatar; the header keeps the
    // time and says "You" to assistive tech only.
    const header = own
      ? `<header class="msg-item__meta"><strong class="msg-item__name sr-only">You</strong>${stamp}</header>`
      : `<header class="msg-item__meta"><strong class="msg-item__name">${escapeHtml(identity.name)}</strong><span class="msg-item__role">${escapeHtml(roleText)}</span>${stamp}</header>`;
    return `<article class="msg-item${grouped ? ' is-grouped' : ''}${system ? ' is-system' : ''}${own ? ' is-own' : ''}" data-team-message="${escapeHtml(message.id)}">
      <span class="msg-item__gutter">${grouped || own ? '' : system ? `<span class="atlas-avatar msg-avatar msg-avatar--atlas" aria-hidden="true">${icon('sparkles')}</span>` : avatarMarkup(identity)}</span>
      <div class="msg-item__body">
        ${grouped ? '' : header}
        <p class="msg-item__text">${formatBody(message.body)}</p>
        ${linkMarkup(message.link)}
        ${readStatus ? `<footer class="msg-item__foot">${readStatus}</footer>` : ''}
        ${actions ? `<span class="msg-item__actions">${actions}</span><button type="button" class="atlas-icon-btn atlas-icon-btn--sm msg-item__more" data-msg-more="${escapeHtml(message.id)}" aria-label="Message options">${icon('ellipsis')}</button>` : ''}
      </div>
    </article>`;
  }

  function failedMarkup() {
    const failed = state.failed[state.selectedChannel] || [];
    return failed.map((entry) => `<article class="msg-item is-own is-failed" data-msg-failed="${escapeHtml(entry.id)}">
      <span class="msg-item__gutter"></span>
      <div class="msg-item__body">
        <p class="msg-item__text">${formatBody(entry.body)}</p>
        <footer class="msg-item__foot"><span class="msg-item__failed">${icon('circle-alert')}Not sent</span><span class="msg-item__actions"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-msg-retry="${escapeHtml(entry.id)}">Retry</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-msg-discard="${escapeHtml(entry.id)}">Discard</button></span></footer>
      </div>
    </article>`).join('');
  }

  function logMarkup() {
    const channel = selectedChannel();
    if (!state.snapshot && state.error) return '';
    if (!state.snapshot || state.channelLoading || snapshotChannelKey() !== state.selectedChannel) {
      return `<div class="msg-log__skel" aria-busy="true">${'<div class="msg-skel"><span class="atlas-skel atlas-skel--circle"></span><span class="atlas-skel atlas-skel--text"></span></div>'.repeat(4)}<span class="sr-only">Loading messages</span></div>`;
    }
    const list = messages();
    if (!list.length && !(state.failed[state.selectedChannel] || []).length) {
      return `<div class="atlas-empty msg-log__empty"><div class="atlas-empty__icon">${icon('messages-square')}</div><h3 class="atlas-empty__title">No messages yet</h3><p class="atlas-empty__text">${canPostIn(channel) ? 'Say hello to the team.' : `Nothing has been posted in ${escapeHtml(channel?.name || 'this channel')} yet.`}</p></div>`;
    }
    const lastRead = state.unreadFrom[state.selectedChannel];
    const lastReadAt = lastRead ? new Date(lastRead).getTime() : null;
    let previous = null;
    let dividerShown = false;
    const parts = [];
    list.forEach((message) => {
      const day = venueDateOf(message.created_at);
      if (!previous || venueDateOf(previous.created_at) !== day) {
        parts.push(`<div class="msg-divider" role="separator"><span>${escapeHtml(dayLabel(message.created_at))}</span></div>`);
        previous = null;
      }
      const created = new Date(message.created_at).getTime();
      if (!dividerShown && lastRead !== undefined && !isOwn(message) && (lastReadAt === null || created > lastReadAt)) {
        parts.push('<div class="msg-divider msg-divider--new" role="separator"><span>New</span></div>');
        dividerShown = true;
        previous = null;
      }
      parts.push(messageMarkup(message, previous));
      previous = message;
    });
    return parts.join('') + failedMarkup();
  }

  function nearBottom() {
    const scroll = region('scroll');
    if (!scroll) return true;
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  }

  function scrollToBottom() {
    const scroll = region('scroll');
    if (!scroll) return;
    window.requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  function hideJump() {
    state.pendingNew = 0;
    const jump = region('jump');
    if (jump) jump.hidden = true;
  }

  function showJump(count) {
    const jump = region('jump');
    if (!jump) return;
    state.pendingNew += count;
    jump.querySelector('[data-msg-jump-label]').textContent = `${state.pendingNew} new ${state.pendingNew === 1 ? 'message' : 'messages'}`;
    jump.hidden = false;
  }

  function renderLog(options = {}) {
    const log = region('log');
    if (!log) return;
    const ids = messages().map((message) => `${message.id}:${message.edited_at || ''}:${message.deleted ? 1 : 0}:${message.read_by_count || 0}`).join('|')
      + `#${(state.failed[state.selectedChannel] || []).length}#${state.channelLoading}#${snapshotChannelKey()}#${state.selectedChannel}`;
    if (options.silent && ids === state.renderedIds) return;
    const stick = !options.silent || nearBottom();
    const previousIds = new Set([...log.querySelectorAll('[data-team-message]')].map((node) => node.dataset.teamMessage));
    log.innerHTML = logMarkup();
    state.renderedIds = ids;
    paintIcons();
    if (stick) {
      hideJump();
      scrollToBottom();
    } else {
      const added = messages().filter((message) => !previousIds.has(message.id) && !isOwn(message)).length;
      if (added) showJump(added);
    }
  }

  // ---------- composer ----------

  function composerMarkup() {
    const channel = selectedChannel();
    if (!channel || !state.staff) return '';
    if (!canPostIn(channel)) {
      const text = !state.staff?.can_post
        ? 'You can read messages. Ask a manager if you need to post.'
        : 'Only managers can post in Announcements. You can read everything here.';
      return `<p class="msg-composer__locked">${icon('lock')}<span>${escapeHtml(text)}</span></p>`;
    }
    const editing = messages().find((message) => message.id === state.editingMessageId);
    const target = state.selectedTarget;
    return `<form class="msg-compose" data-team-composer novalidate>
      ${editing ? `<div class="msg-compose__context">${icon('pencil')}<span>Editing your message</span><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-cancel-edit>Cancel</button></div>` : ''}
      ${target && !editing ? `<div class="msg-compose__context">${icon(LINK_ICONS[target.type] || 'link-2')}<span><strong>${escapeHtml(target.label)}</strong>${target.description ? ` · ${escapeHtml(target.description)}` : ''}</span><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-team-remove-link aria-label="Remove linked record">${icon('x')}</button></div>` : ''}
      <div class="msg-compose__box">
        ${editing ? '' : `<button type="button" class="atlas-icon-btn msg-compose__tool" data-team-toggle-attachment aria-label="Link a record" data-atlas-tooltip="Link a record">${icon('paperclip')}</button>`}
        <label class="sr-only" for="msg-draft">Message ${escapeHtml(channel.name)}</label>
        <textarea id="msg-draft" class="msg-compose__input" rows="1" maxlength="4000" data-team-draft placeholder="Message ${escapeHtml(channel.name)}" ${state.submitting ? 'disabled' : ''}>${escapeHtml(currentDraft())}</textarea>
        <button type="submit" class="atlas-btn atlas-btn--primary msg-compose__send" aria-label="${editing ? 'Save edit' : 'Send'}" ${state.submitting || !currentDraft().trim() ? 'disabled' : ''}>${icon(editing ? 'check' : 'arrow-up')}</button>
      </div>
      <p class="msg-compose__note">Messages are visible to everyone in this channel.</p>
    </form>`;
  }

  function autosize(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }

  function renderComposer(options = {}) {
    const composer = region('composer');
    if (!composer) return;
    const focused = document.activeElement?.matches?.('[data-team-draft]');
    composer.innerHTML = composerMarkup();
    const textarea = composer.querySelector('[data-team-draft]');
    autosize(textarea);
    if (textarea && (focused || options.focus)) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    paintIcons();
  }

  // ---------- layout & routing ----------

  function syncPhoneChrome() {
    const chrome = window.AtlasChrome;
    const inThread = PHONE.matches && Boolean(state.routeChannel);
    const channel = selectedChannel();
    state.root?.setAttribute('data-msg-view', inThread ? 'thread' : 'list');
    if (!state.visible) return;
    chrome?.setTabBarHidden?.('messages', inThread);
    if (inThread) {
      // The thread header is hidden on phones; its actions move to the top bar.
      const actions = [];
      if (channel?.key === HANDOVER_CHANNEL && canPostIn(channel)) actions.push({ icon: 'notebook-pen', label: 'Write handover', run: openHandoverSheet });
      if (channel) actions.push({ icon: channel.starred ? 'pin-off' : 'pin', label: channel.starred ? `Unpin ${channel.name}` : `Pin ${channel.name}`, run: setConversationStar });
      chrome?.setTopBar?.({ title: channel ? channel.name : 'Messages', back: () => routeTo('team', {}), actions });
    }
    else chrome?.setTopBar?.({});
  }

  function renderAll() {
    if (!ensureRoot()) return;
    renderList();
    renderHead();
    renderAlert();
    renderLog();
    renderComposer();
    syncPhoneChrome();
  }

  function defaultChannelKey() {
    const list = channels();
    const unread = list.find((channel) => Number(channel.unread_count || 0) > 0);
    return (unread || list.find((channel) => channel.key === 'general') || list[0] || { key: 'general' }).key;
  }

  function show(params = {}) {
    state.visible = true;
    ensureRoot();
    const requested = params.conversation ? String(params.conversation) : null;
    state.routeChannel = requested;
    const next = requested || state.selectedChannel || (state.snapshot ? defaultChannelKey() : 'general');
    const changed = next !== state.selectedChannel;
    if (changed) {
      state.selectedChannel = next;
      state.editingMessageId = null;
      state.selectedTarget = null;
    }
    renderAll();
    const needsLoad = !state.snapshot || snapshotChannelKey() !== state.selectedChannel;
    if (needsLoad) {
      if (changed || (!state.loading && Date.now() - state.failedAt >= 20000)) loadSnapshot({ channelSwitch: Boolean(state.snapshot) });
    } else {
      markSelectedChannelRead();
    }
    startPolling();
  }

  function hide() {
    state.visible = false;
    stopPolling();
    window.AtlasChrome?.setTabBarHidden?.('messages', false);
  }

  // Moves between this page's routes; AtlasShell.show() writes the address.
  function routeTo(view, params = {}) {
    window.AtlasShell?.show?.(view, params, { source: 'route' });
  }

  function openChannel(key, options = {}) {
    const shell = window.AtlasShell;
    if (shell?.show) routeTo('team', { conversation: key });
  }

  // ---------- server calls ----------

  function applyPayload(payload) {
    if (payload.snapshot) state.snapshot = payload.snapshot;
    if (payload.staff) state.staff = payload.staff;
    if (Array.isArray(payload.members)) state.members = payload.members;
    publishUnread();
  }

  function rememberReadMark() {
    const key = snapshotChannelKey();
    if (!key || state.unreadFrom[key] !== undefined) return;
    const channel = channelByKey(key);
    if (!channel) return;
    state.unreadFrom[key] = Number(channel.unread_count || 0) > 0 ? (channel.last_read_at || null) : new Date().toISOString();
  }

  async function loadSnapshot(options = {}) {
    // Silent polls never overlap a request; a channel switch supersedes one.
    if (options.silent && state.loading) return;
    const channelKey = state.selectedChannel || 'general';
    const serial = ++state.loadSerial;
    state.loading = true;
    state.channelLoading = Boolean(options.channelSwitch);
    if (!options.silent) state.error = null;
    if (!options.silent) { renderAlert(); renderLog(); }
    let ok = false;
    try {
      const payload = await api('snapshot', { params: { channel: channelKey, limit: 60 } });
      if (serial !== state.loadSerial) return;
      if (!payload?.snapshot) throw new MessagesError('Messages are temporarily unavailable.', 0);
      applyPayload(payload);
      if (!state.selectedChannel || !channelByKey(state.selectedChannel)) state.selectedChannel = snapshotChannelKey() || defaultChannelKey();
      rememberReadMark();
      state.error = null;
      state.failedAt = 0;
      ok = true;
    } catch (error) {
      if (serial !== state.loadSerial) return;
      if (!options.silent || !state.snapshot) {
        state.error = shown(error, 'Messages couldn’t be loaded. Your messages are safe; check the connection and try again.');
        state.failedAt = Date.now();
      }
    } finally {
      if (serial === state.loadSerial) {
        state.loading = false;
        state.channelLoading = false;
        if (state.root && state.visible) {
          renderList();
          renderHead();
          renderAlert();
          renderLog({ silent: options.silent });
          if (!options.silent || !region('composer')?.innerHTML) renderComposer();
          syncPhoneChrome();
        }
      }
    }
    if (ok) markSelectedChannelRead();
  }

  async function markSelectedChannelRead() {
    const channel = selectedChannel();
    if (!channel || state.markingRead || Number(channel.unread_count || 0) <= 0 || !state.visible || !teamViewVisible()) return;
    if (PHONE.matches && !state.routeChannel) return;
    if (snapshotChannelKey() !== channel.key) return;
    rememberReadMark();
    state.markingRead = true;
    try {
      const payload = await api('mark-read', { method: 'POST', body: { channel_key: channel.key, limit: 60 } });
      if (channel.key === state.selectedChannel) {
        applyPayload(payload);
        renderList();
        renderLog({ silent: true });
      }
      window.AtlasTeamUnreadBadge?.refresh?.();
    } catch (error) {
      // Read state is a convenience; the thread is already on screen.
    } finally {
      state.markingRead = false;
    }
  }

  async function setConversationStar() {
    const channel = selectedChannel();
    if (!channel || state.starring) return;
    state.starring = true;
    renderHead();
    try {
      const payload = await api('star', { method: 'POST', body: { channel_key: channel.key, starred: !channel.starred, limit: 60 } });
      applyPayload(payload);
      window.AtlasShell?.toast?.(channel.starred ? `${channel.name} unpinned` : `${channel.name} pinned to the top`);
    } catch (error) {
      window.AtlasShell?.toast?.(`${channel.name} couldn’t be ${channel.starred ? 'unpinned' : 'pinned'}. Try again.`);
    } finally {
      state.starring = false;
      renderList();
      renderHead();
      syncPhoneChrome();
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.visible) return;
    const interval = Math.max(4000, Number(state.snapshot?.policy?.poll_after_ms || POLL_FALLBACK_MS));
    state.pollTimer = window.setInterval(() => {
      if (!state.visible || !teamViewVisible() || document.hidden || state.submitting || state.loading) return;
      if (state.editingMessageId || document.querySelector('.msg-layer')) return;
      // Back off after a failure; Try again still loads at once.
      if (state.error && Date.now() - state.failedAt < 20000) return;
      loadSnapshot({ silent: true });
    }, interval);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function resetComposer() {
    setCurrentDraft('');
    state.editingMessageId = null;
    state.selectedTarget = null;
  }

  async function sendBody(body, link, clientRequestId, channelKey) {
    return api('send', {
      method: 'POST',
      body: {
        channel_key: channelKey,
        body,
        client_request_id: clientRequestId,
        link_type: link?.type || 'none',
        link_key: link?.key || null
      }
    });
  }

  async function sendOrEdit() {
    const body = currentDraft().trim();
    if (!body || state.submitting) return;
    const channelKey = state.selectedChannel;
    state.submitting = true;
    renderComposer();
    if (state.editingMessageId) {
      try {
        const payload = await api('edit', { method: 'POST', body: { channel_key: channelKey, message_id: state.editingMessageId, body } });
        applyPayload(payload);
        resetComposer();
        window.AtlasShell?.toast?.('Message updated');
      } catch (error) {
        state.error = shown(error, 'The edit couldn’t be saved. Try again.');
        renderAlert();
      } finally {
        state.submitting = false;
        renderLog();
        renderComposer({ focus: true });
      }
      return;
    }
    const link = state.selectedTarget;
    const entry = { id: requestId(), body, link };
    resetComposer();
    try {
      const payload = await sendBody(body, link, entry.id, channelKey);
      if (channelKey === state.selectedChannel) applyPayload(payload);
      state.error = null;
    } catch (error) {
      // Unsent messages stay in the thread with "Not sent · Retry" (spec §7.3).
      state.failed[channelKey] = [...(state.failed[channelKey] || []), entry];
    } finally {
      state.submitting = false;
      renderAlert();
      renderList();
      renderLog();
      renderComposer({ focus: true });
    }
  }

  async function retryFailed(id) {
    const channelKey = state.selectedChannel;
    const list = state.failed[channelKey] || [];
    const entry = list.find((item) => item.id === id);
    if (!entry || state.submitting) return;
    state.submitting = true;
    try {
      // The same client request id makes a retry safe to repeat.
      const payload = await sendBody(entry.body, entry.link, entry.id, channelKey);
      state.failed[channelKey] = list.filter((item) => item.id !== id);
      applyPayload(payload);
    } catch (error) {
      window.AtlasShell?.toast?.('Still not sent. Check the connection and try again.');
    } finally {
      state.submitting = false;
      renderList();
      renderLog();
      renderComposer();
    }
  }

  function discardFailed(id) {
    const channelKey = state.selectedChannel;
    state.failed[channelKey] = (state.failed[channelKey] || []).filter((item) => item.id !== id);
    renderLog();
  }

  async function deleteMessage(messageId) {
    const message = messages().find((candidate) => candidate.id === messageId);
    if (!message || state.submitting) return;
    const deletingAnother = message.sender_id !== state.staff?.id;
    const answer = await confirmDialog({
      title: 'Delete this message?',
      body: deletingAnother
        ? 'The message is replaced by “Message deleted” for everyone. The reason is kept in the audit history.'
        : 'The message is replaced by “Message deleted” for everyone. The audit history keeps a record.',
      confirmLabel: 'Delete message',
      danger: true,
      field: deletingAnother ? { label: 'Reason', required: true, placeholder: 'Why this message is removed' } : null
    });
    if (!answer) return;
    state.submitting = true;
    try {
      const payload = await api('delete', { method: 'POST', body: { channel_key: state.selectedChannel, message_id: messageId, reason: answer.value || null } });
      applyPayload(payload);
      window.AtlasShell?.toast?.('Message deleted');
    } catch (error) {
      state.error = shown(error, 'The message couldn’t be deleted. Try again.');
      renderAlert();
    } finally {
      state.submitting = false;
      renderList();
      renderLog();
      renderComposer();
    }
  }

  // ---------- layers (sheets and dialogs through AtlasModal) ----------

  // Layers and dialogs are the shared AtlasModal ones (modal.js).
  function openLayer({ id, panel, onClose, initialFocus }) {
    const root = window.AtlasModal.layer({ id, panel, className: 'msg-layer', onClose, initialFocus });
    paintIcons();
    return root;
  }

  function closeLayer(root) {
    if (root) window.AtlasModal.dismiss(root);
  }

  // Resolves { value } (the note when `field` is given) or null when dismissed.
  function confirmDialog({ title, body, confirmLabel, danger = false, field = null }) {
    const options = { id: 'msg-confirm', title, body, confirmLabel, danger };
    if (!field) return window.AtlasModal.confirm(options).then((ok) => (ok ? { value: '' } : null));
    return window.AtlasModal.prompt({ ...options, label: field.label, value: field.value, placeholder: field.placeholder, required: field.required, maxLength: 1000 })
      .then((value) => (value === null ? null : { value }));
  }

  function openHandoverSheet() {
    const channel = selectedChannel();
    if (!channel || !canPostIn(channel)) return;
    const root = openLayer({
      id: 'msg-handover',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="msg-handover-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="msg-handover-title">Write handover</h2><p class="atlas-sheet__desc">Posted in ${escapeHtml(channel.name)} for the next shift.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body" id="msg-handover-form" novalidate>
          <div class="atlas-field"><label for="msg-ho-happened">What happened</label><textarea class="atlas-input atlas-textarea" id="msg-ho-happened" name="happened" rows="3" maxlength="1300"></textarea></div>
          <div class="atlas-field"><label for="msg-ho-stock">Stock issues <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="msg-ho-stock" name="stock" rows="2" maxlength="1300"></textarea></div>
          <div class="atlas-field"><label for="msg-ho-next">For the next shift <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="msg-ho-next" name="next" rows="3" maxlength="1300"></textarea><p class="error" data-msg-ho-error hidden>Write at least one section.</p></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="msg-handover-form" class="atlas-btn atlas-btn--primary">Post handover</button></footer>
      </section>`
    });
    root.querySelector('#msg-handover-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const sections = [['What happened', form.happened.value], ['Stock issues', form.stock.value], ['For the next shift', form.next.value]]
        .map(([label, value]) => [label, String(value || '').trim()]).filter(([, value]) => value);
      if (!sections.length) {
        root.querySelector('[data-msg-ho-error]').hidden = false;
        form.happened.focus();
        return;
      }
      const body = sections.map(([label, value]) => `${label}\n${value}`).join('\n\n');
      closeLayer(root);
      setCurrentDraft(body);
      await sendOrEdit();
    });
  }

  // Phones: Edit and Delete sit behind a "…" button in a small action sheet.
  function openMessageActions(messageId) {
    const message = messages().find((candidate) => candidate.id === messageId);
    if (!message) return;
    const root = openLayer({
      id: 'msg-actions',
      panel: `<section class="atlas-sheet msg-actions" data-modal-panel aria-labelledby="msg-actions-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="msg-actions-title">Message</h2><p class="atlas-sheet__desc">${escapeHtml(String(message.body || '').slice(0, 80))}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <div class="atlas-sheet__body msg-actions__list">
          ${message.can_edit ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--lg atlas-btn--block" data-msg-action="edit">${icon('pencil')}Edit message</button>` : ''}
          ${message.can_delete ? `<button type="button" class="atlas-btn atlas-btn--danger atlas-btn--lg atlas-btn--block" data-msg-action="delete">${icon('trash-2')}Delete message</button>` : ''}
        </div>
      </section>`
    });
    root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-msg-action]')?.dataset.msgAction;
      if (!action) return;
      closeLayer(root);
      if (action === 'edit') {
        state.editingMessageId = message.id;
        state.selectedTarget = null;
        setCurrentDraft(message.body || '');
        renderComposer({ focus: true });
      } else {
        deleteMessage(message.id);
      }
    });
  }

  function openLinkSheet() {
    const types = LINK_TYPES.filter((entry) => !entry.managerOnly || state.staff?.can_link_brain_recommendations);
    let current = types.some((entry) => entry.type === state.selectedTarget?.type) ? state.selectedTarget.type : types[0].type;
    let query = '';
    let results = [];
    let chosen = state.selectedTarget;
    let timer = null;
    let serial = 0;
    const root = openLayer({
      id: 'msg-link',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="msg-link-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="msg-link-title">Link a record</h2><p class="atlas-sheet__desc">People can open it straight from the message.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <div class="atlas-sheet__body">
          <div class="atlas-segmented msg-link__types" role="group" aria-label="Record type">${types.map((entry) => `<button type="button" data-msg-link-type="${entry.type}" aria-pressed="${entry.type === current}">${escapeHtml(entry.label)}</button>`).join('')}</div>
          <label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" placeholder="Search" aria-label="Search records" data-team-target-search autocomplete="off"></label>
          <div class="msg-link__results" data-msg-link-results role="listbox" aria-label="Records"></div>
        </div>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-msg-link-attach disabled>Attach</button></footer>
      </section>`
    });
    const resultsEl = root.querySelector('[data-msg-link-results]');
    const attach = root.querySelector('[data-msg-link-attach]');
    const noun = () => types.find((entry) => entry.type === current)?.noun || 'records';
    const paintResults = (status) => {
      if (status === 'loading') {
        resultsEl.innerHTML = `${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(3)}<span class="sr-only">Loading</span>`;
      } else if (status === 'error') {
        resultsEl.innerHTML = `<p class="msg-link__state">${escapeHtml(noun().charAt(0).toUpperCase() + noun().slice(1))} couldn’t be loaded. Try again in a moment.</p>`;
      } else if (!results.length) {
        resultsEl.innerHTML = `<p class="msg-link__state">${query ? `No ${escapeHtml(noun())} match “${escapeHtml(query)}”.` : `No ${escapeHtml(noun())} to link.`}</p>`;
      } else {
        resultsEl.innerHTML = results.map((target) => `<button type="button" class="msg-link__option" role="option" aria-selected="${chosen?.key === target.key && chosen?.type === target.type}" data-team-select-target="${escapeHtml(target.key)}">
          <span class="msg-link__option-body"><span class="msg-link__option-title">${escapeHtml(target.label)}</span>${target.description ? `<span class="msg-link__option-meta">${escapeHtml(target.description)}</span>` : ''}</span>${icon(chosen?.key === target.key ? 'circle-check' : 'circle')}</button>`).join('');
      }
      attach.disabled = !chosen;
      paintIcons();
    };
    const load = async () => {
      const mine = ++serial;
      paintResults('loading');
      try {
        const payload = await api('targets', { params: { type: current, q: query } });
        if (mine !== serial) return;
        results = Array.isArray(payload.targets) ? payload.targets : [];
        paintResults();
      } catch (error) {
        if (mine !== serial) return;
        results = [];
        paintResults('error');
      }
    };
    root.addEventListener('click', (event) => {
      const typeButton = event.target.closest('[data-msg-link-type]');
      if (typeButton) {
        current = typeButton.dataset.msgLinkType;
        root.querySelectorAll('[data-msg-link-type]').forEach((button) => button.setAttribute('aria-pressed', String(button === typeButton)));
        load();
        return;
      }
      const option = event.target.closest('[data-team-select-target]');
      if (option) {
        chosen = results.find((target) => target.key === option.dataset.teamSelectTarget) || null;
        paintResults();
        return;
      }
      if (event.target.closest('[data-msg-link-attach]') && chosen) {
        state.selectedTarget = chosen;
        closeLayer(root);
        renderComposer({ focus: true });
      }
    });
    root.querySelector('[data-team-target-search]')?.addEventListener('input', (event) => {
      query = event.target.value.trim();
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 250);
    });
    load();
  }

  // ---------- events ----------

  function openLinkedRecord(type, key) {
    // Workspaces register their own link types with AtlasShell (Knowledge
    // articles, for example); otherwise the route in the chip's href is used.
    if (window.AtlasShell?.openLink?.(type, key, { source: 'team-messages' })) return true;
    return false;
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    const channelLink = target.closest('[data-team-channel]');
    if (channelLink) {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      openChannel(channelLink.dataset.teamChannel, { source: 'list' });
      return;
    }
    if (target.closest('[data-team-refresh]')) { event.preventDefault(); state.failedAt = 0; loadSnapshot(); return; }
    if (target.closest('[data-team-star]')) { event.preventDefault(); setConversationStar(); return; }
    if (target.closest('[data-msg-handover]')) { event.preventDefault(); openHandoverSheet(); return; }
    if (target.closest('[data-msg-jump]')) { event.preventDefault(); hideJump(); scrollToBottom(); return; }

    const editButton = target.closest('[data-team-edit]');
    if (editButton) {
      const message = messages().find((candidate) => candidate.id === editButton.dataset.teamEdit);
      if (!message) return;
      state.editingMessageId = message.id;
      state.selectedTarget = null;
      setCurrentDraft(message.body || '');
      renderComposer({ focus: true });
      return;
    }
    if (target.closest('[data-team-cancel-edit]')) { event.preventDefault(); resetComposer(); renderComposer({ focus: true }); return; }

    const more = target.closest('[data-msg-more]');
    if (more) { event.preventDefault(); openMessageActions(more.dataset.msgMore); return; }

    const deleteButton = target.closest('[data-team-delete]');
    if (deleteButton) { event.preventDefault(); deleteMessage(deleteButton.dataset.teamDelete); return; }

    const retry = target.closest('[data-msg-retry]');
    if (retry) { event.preventDefault(); retryFailed(retry.dataset.msgRetry); return; }
    const discard = target.closest('[data-msg-discard]');
    if (discard) { event.preventDefault(); discardFailed(discard.dataset.msgDiscard); return; }

    if (target.closest('[data-team-toggle-attachment]')) { event.preventDefault(); openLinkSheet(); return; }
    if (target.closest('[data-team-remove-link]')) { event.preventDefault(); state.selectedTarget = null; renderComposer({ focus: true }); return; }

    const linkedRecord = target.closest('[data-team-open-link]');
    if (linkedRecord && openLinkedRecord(linkedRecord.dataset.teamOpenLink, linkedRecord.dataset.teamLinkKey)) event.preventDefault();
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-team-composer]')) return;
    event.preventDefault();
    sendOrEdit();
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return;
    if (!host()?.contains(target)) return;
    if (target.matches('[data-team-draft]')) {
      setCurrentDraft(target.value);
      autosize(target);
      const sendButton = host()?.querySelector('.msg-compose__send');
      if (sendButton) sendButton.disabled = state.submitting || !target.value.trim();
    }
    if (target.matches('[data-msg-search]')) {
      state.search = target.value;
      renderList();
    }
  }

  function handleKeydown(event) {
    if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches('[data-team-draft]')) return;
    // Enter sends on a keyboard; Shift+Enter adds a line. Phones keep Enter as a new line.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.isComposing && ((event.metaKey || event.ctrlKey) || (!coarse && !event.shiftKey))) {
      event.preventDefault();
      sendOrEdit();
    }
    if (event.key === 'Escape' && state.editingMessageId) {
      resetComposer();
      renderComposer({ focus: true });
    }
  }

  function refreshAvatars() {
    host()?.querySelectorAll('.msg-avatar[data-team-sender]').forEach((avatar) => {
      const message = messages().find((entry) => entry.sender_id === avatar.dataset.teamSender);
      if (!message) return;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = avatarMarkup(senderIdentity(message));
      const next = wrapper.firstElementChild;
      if (next && next.outerHTML !== avatar.outerHTML) avatar.replaceWith(next);
    });
  }

  function handleVisibility() {
    if (document.hidden || !state.visible) stopPolling();
    else {
      startPolling();
      if (!userIsInteracting()) loadSnapshot({ silent: true });
    }
  }

  // ---------- unread for the shell (badge, notifications feed) ----------

  function unread() {
    return {
      total: totalUnread(),
      conversations: channels().map((channel) => ({
        id: channel.key,
        name: channel.name,
        unread: Number(channel.unread_count || 0),
        route: `#messages/${channel.key}`,
        lastMessageAt: channel.last_message?.created_at || null,
        preview: channel.last_message ? previewOf(channel) : '',
        lastMessage: channel.last_message ? { id: channel.last_message.id || null, sender: channel.last_message.message_type === 'system' ? 'Atlas' : senderIdentity(channel.last_message).name, body: channel.last_message.deleted ? '' : String(channel.last_message.body || '').slice(0, 140), deleted: Boolean(channel.last_message.deleted) } : null
      })).filter((entry) => entry.unread > 0)
    };
  }

  function publishUnread() {
    const detail = unread();
    window.AtlasShell?.emit?.('messages:unread', detail);
  }

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell?.registerView) return;
    shell.registerView('team', { root: () => host(), title: 'Messages', fullHeight: true, render: show, onHide: hide });
    shell.actions?.register?.({
      id: 'messages.handover', label: 'Write handover', icon: 'notebook-pen', keywords: ['handover', 'shift', 'next shift', 'message'],
      roles: ['admin', 'manager', 'bartender'], contexts: ['team', 'shifts', 'home'],
      run: () => {
        openChannel(HANDOVER_CHANNEL, { source: 'action' });
        window.setTimeout(() => { if (selectedChannel()?.key === HANDOVER_CHANNEL) openHandoverSheet(); }, 600);
      }
    });
    // The Messages view may already be showing (deep link opened before this
    // module loaded): take over now.
    if (shell.current?.() === 'team') show(shell.params?.() || {});
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    if (!host()) return;

    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('input', handleInput);
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('visibilitychange', handleVisibility);
    // Photos load independently; refresh only the avatars so the composer and
    // scroll position are not disturbed.
    window.addEventListener('atlas:profile-photos-updated', refreshAvatars);
    // A renamed or deactivated profile changes how existing messages are shown.
    window.addEventListener('atlas:team-roster-changed', () => { if (state.visible) loadSnapshot({ silent: true }); });
    PHONE.addEventListener?.('change', () => { if (state.visible) { renderList(); syncPhoneChrome(); } });
    registerWithShell();
  }

  window.AtlasTeamMessages = {
    refresh: () => loadSnapshot(),
    openChannel: (channelKey = 'general') => openChannel(channelKey, { source: 'api' }),
    unreadCount: () => totalUnread(),
    unread,
    snapshot: () => state.snapshot
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
