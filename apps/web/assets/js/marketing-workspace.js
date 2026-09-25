// Marketing (#marketing, #marketing/<tab>) — plan posts and campaigns, get
// approvals, see what is scheduled (spec §7.13). Manager and admin only.
//
// Tabs: Overview (Coming up · Waiting for approval · Suggestions) · Calendar ·
// Posts · Campaigns · History. Publishing is manual until a social account is
// connected (Settings › Integrations). Every date and time is venue time:
// datetime inputs go through AtlasVenueClock.localInputValue/fromLocalInput,
// so a browser in another zone stores the instant the manager meant.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 15000;
  const MANAGERS = ['admin', 'manager'];
  const TABS = [['overview', 'Overview'], ['calendar', 'Calendar'], ['posts', 'Posts'], ['campaigns', 'Campaigns'], ['history', 'History']];
  const TAB_ALIASES = { content: 'posts', connections: 'overview' };
  const CHANNELS = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', 'google-business-profile': 'Google Business Profile' };
  const TYPES = { post: 'Post', story: 'Story', reel: 'Reel', campaign_task: 'Campaign task', event_promotion: 'Event promotion', content_idea: 'Idea', google_post: 'Google post' };
  const STATUS = {
    idea: ['Idea', 'neutral'], draft: ['Draft', 'neutral'], pending_approval: ['Waiting for approval', 'info'],
    changes_requested: ['Changes requested', 'warning'], approved: ['Approved', 'positive'], scheduled: ['Scheduled', 'positive'],
    published: ['Published', 'positive'], completed: ['Done', 'positive'], rejected: ['Rejected', 'neutral'], cancelled: ['Cancelled', 'neutral']
  };
  const FINAL = new Set(['published', 'completed', 'rejected', 'cancelled']);
  const HISTORY_LABELS = {
    campaign_created: 'Campaign created', content_created: 'Draft created', content_updated: 'Draft updated',
    approval_submitted: 'Sent for approval', approval_decided: 'Approval decided', content_published: 'Marked as published',
    content_completed: 'Marked as done', content_cancelled: 'Cancelled', recommendation_converted: 'Suggestion planned',
    recommendation_dismissed: 'Suggestion dismissed', connection_state_changed: 'Connection changed'
  };

  const state = {
    workspace: null,
    staff: null,
    members: [],
    tab: 'overview',
    month: null,
    postFilter: 'active',
    loading: false,
    submitting: false,
    error: null,
    initialized: false,
    registered: false
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = () => window.AtlasVenueClock;
  const humanize = (value) => { const text = String(value || '').replace(/[_-]+/g, ' ').trim(); return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''; };
  const requestId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `marketing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const venueToday = () => clock()?.venueDate?.() || new Date().toISOString().slice(0, 10);
  const venueKey = (value) => (value ? clock()?.venueDate?.(value) || String(value).slice(0, 10) : null);
  const dateTime = (value, fallback = 'Not scheduled') => (value ? clock()?.formatDateTime?.(value, {}, fallback) || fallback : fallback);
  const dateOnly = (value, fallback = '—') => (value ? clock()?.formatDate?.(value, {}, fallback) || fallback : fallback);
  const inputValue = (value) => (value ? clock()?.localInputValue?.(value) || '' : '');
  const fromInput = (value) => (value ? clock()?.fromLocalInput?.(value) || null : null);

  function profile() { return window.AtlasShell?.profile?.() || window.atlasCurrentProfile || null; }
  function isManager() { const p = profile(); return Boolean(p && p.active !== false && MANAGERS.includes(p.role)); }
  function host() { return document.getElementById('marketing-view'); }
  function visible() { return window.AtlasShell?.current?.() === 'marketing'; }
  const items = () => (Array.isArray(state.workspace?.content_items) ? state.workspace.content_items : []);
  const campaigns = () => (Array.isArray(state.workspace?.campaigns) ? state.workspace.campaigns : []);
  const suggestions = () => (Array.isArray(state.workspace?.recommendations) ? state.workspace.recommendations : []);
  const connections = () => (Array.isArray(state.workspace?.connections) ? state.workspace.connections : []);
  const history = () => (Array.isArray(state.workspace?.history) ? state.workspace.history : []);

  function monthRange() {
    const key = state.month || venueToday().slice(0, 7);
    return clock()?.monthRange ? clock().monthRange(key) : { month: key, start: `${key}-01`, end: `${key}-28` };
  }

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
      if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status });
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function errorText(error, what) {
    if (error?.status === 401) return 'Your session has ended. Sign in again, then try again.';
    if (error?.status === 403) return 'Your role can\'t do this. Ask an administrator.';
    if (error?.status === 404) return 'Marketing isn\'t switched on for this venue yet.';
    if (error?.status === 409) return `${what} changed while you were working. It has been reloaded — check it and try again.`;
    if (error?.name === 'AbortError') return 'The connection timed out. Nothing was changed. Try again.';
    return 'Nothing was changed. Check the connection and try again.';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    render();
    try {
      const range = monthRange();
      const payload = await api('snapshot', { params: { start: range.start, end: range.end } });
      state.workspace = payload.workspace || {};
      state.staff = payload.staff || state.staff;
      state.members = Array.isArray(payload.members) ? payload.members : state.members;
      state.error = null;
    } catch (error) {
      state.error = error;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, message, what = 'The post') {
    if (state.submitting) return false;
    state.submitting = true;
    try {
      const range = monthRange();
      const payload = await api(action, { method: 'POST', body: { ...body, start_date: range.start, end_date: range.end } });
      if (payload.workspace) state.workspace = payload.workspace;
      if (payload.staff) state.staff = payload.staff;
      if (Array.isArray(payload.members)) state.members = payload.members;
      window.AtlasShell?.toast?.(message);
      render();
      return true;
    } catch (error) {
      if (error?.status === 409) load();
      throw Object.assign(new Error('mutate'), { userMessage: errorText(error, what) });
    } finally {
      state.submitting = false;
    }
  }

  // ---------- markup ----------

  function pill(status) {
    const [label, tone] = STATUS[status] || [humanize(status), 'neutral'];
    return `<span class="atlas-pill atlas-pill--${tone}">${escapeHtml(label)}</span>`;
  }
  function channelText(list) {
    const names = (Array.isArray(list) ? list : []).map((key) => CHANNELS[key] || humanize(key));
    return names.length ? names.join(', ') : 'No channel';
  }
  function emptyMarkup(icon, title, text, action = '') {
    return `<div class="atlas-empty"><div class="atlas-empty__icon"><i data-lucide="${icon}"></i></div><h3 class="atlas-empty__title">${escapeHtml(title)}</h3>${text ? `<p class="atlas-empty__text">${escapeHtml(text)}</p>` : ''}${action ? `<div class="atlas-empty__actions">${action}</div>` : ''}</div>`;
  }
  function newPostButton(label = 'New post draft', variant = 'primary') {
    return state.staff?.can_create === false ? '' : `<button type="button" class="atlas-btn atlas-btn--${variant}" data-mk-new><i data-lucide="plus"></i>${label}</button>`;
  }

  function postRow(item) {
    return `<li class="atlas-row atlas-row--link"><span class="atlas-row__icon"><i data-lucide="${item.content_type === 'reel' ? 'clapperboard' : item.content_type === 'story' ? 'gallery-vertical-end' : item.content_type === 'campaign_task' ? 'list-checks' : 'image'}"></i></span>
        <div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="mk-link" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button></p><p class="atlas-row__meta">${escapeHtml([TYPES[item.content_type] || humanize(item.content_type), channelText(item.platforms), dateTime(item.scheduled_for)].join(' · '))}</p></div>
        <div class="atlas-row__end">${pill(item.status)}</div></li>`;
  }

  function overviewMarkup() {
    const today = venueToday();
    const horizon = clock()?.addDays ? clock().addDays(today, 14) : today;
    const coming = items()
      .filter((item) => !FINAL.has(item.status))
      .filter((item) => { const key = venueKey(item.scheduled_for || item.reminder_at); return key && key >= today && key <= horizon; })
      .sort((a, b) => String(a.scheduled_for || a.reminder_at).localeCompare(String(b.scheduled_for || b.reminder_at)));
    const waiting = items().filter((item) => item.status === 'pending_approval');
    const ideas = suggestions().filter((entry) => entry.available_for_today !== false);
    return `<section class="atlas-section" aria-labelledby="mk-coming"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-coming">Coming up</h2><span class="atlas-section__meta">Next 14 days</span></div>
        ${coming.length ? `<ul class="atlas-list">${coming.map(postRow).join('')}</ul>` : emptyMarkup('calendar', 'Nothing planned yet', 'Plan a post, story or campaign task and it shows here two weeks ahead.', newPostButton())}</section>
      <section class="atlas-section" aria-labelledby="mk-waiting"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-waiting">Waiting for approval</h2></div>
        ${waiting.length ? `<ul class="atlas-list">${waiting.map((item) => `<li class="atlas-row"><div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="mk-link" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button></p><p class="atlas-row__meta">${escapeHtml([item.created_by_label, dateTime(item.scheduled_for)].filter(Boolean).join(' · '))}</p></div><div class="atlas-row__end">${item.can_approve ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" data-mk-open="${escapeHtml(item.id)}">Review</button>` : pill(item.status)}</div></li>`).join('')}</ul>` : '<p class="mk-muted">Nothing is waiting for approval.</p>'}</section>
      ${ideas.length ? `<section class="atlas-section" aria-labelledby="mk-ideas"><div class="atlas-section__head"><h2 class="atlas-section__title" id="mk-ideas">Suggestions</h2><span class="atlas-section__meta">From your venue's routines — nothing is posted automatically</span></div>
        <ul class="atlas-list">${ideas.map((entry) => `<li class="atlas-row${state.focusSuggestion && String(entry.id) === state.focusSuggestion ? ' is-linked-target' : ''}" data-mk-suggestion="${escapeHtml(entry.id)}"${state.focusSuggestion && String(entry.id) === state.focusSuggestion ? ' aria-current="true"' : ''}><span class="atlas-row__icon"><i data-lucide="lightbulb"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(entry.title)} <span class="atlas-pill">Suggestion</span></p><p class="atlas-row__meta">${escapeHtml(entry.summary || '')}</p></div><div class="atlas-row__end">${entry.is_due_today && state.staff?.can_create !== false ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" data-mk-plan="${escapeHtml(entry.id)}">Plan this</button>` : ''}</div></li>`).join('')}</ul></section>` : ''}`;
  }

  function calendarMarkup() {
    const range = monthRange();
    const c = clock();
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
    const byDay = new Map();
    items().forEach((item) => {
      const key = venueKey(item.scheduled_for || item.reminder_at || item.event_starts_at);
      if (!key) return;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(item);
    });
    const monthName = c?.formatDate ? c.formatDate(first, { long: true, year: true }).split(' ').slice(2).join(' ') : range.month;
    return `<div class="atlas-toolbar"><div class="atlas-btn-group"><button type="button" class="atlas-icon-btn" data-mk-month="-1" aria-label="Previous month"><i data-lucide="chevron-left"></i></button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mk-month="0">This month</button><button type="button" class="atlas-icon-btn" data-mk-month="1" aria-label="Next month"><i data-lucide="chevron-right"></i></button></div><h2 class="mk-month">${escapeHtml(monthName)}</h2></div>
      <div class="mk-calendar" role="grid" aria-label="${escapeHtml(monthName)}">
        <div class="mk-calendar__head" role="row">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span role="columnheader">${d}</span>`).join('')}</div>
        <div class="mk-calendar__grid">${cells.map((key) => {
          const list = byDay.get(key) || [];
          const outside = key < range.start || key > range.end;
          return `<div class="mk-day${outside ? ' is-outside' : ''}${key === today ? ' is-today' : ''}" role="gridcell" aria-label="${escapeHtml(dateOnly(key))}${list.length ? `, ${list.length} planned` : ''}">
            <button type="button" class="mk-day__num" data-mk-new-on="${key}" aria-label="New post draft on ${escapeHtml(dateOnly(key))}">${Number(key.slice(8, 10))}</button>
            ${list.slice(0, 3).map((item) => `<button type="button" class="mk-day__item" data-mk-open="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join('')}${list.length > 3 ? `<span class="mk-day__more">${list.length - 3} more</span>` : ''}
          </div>`;
        }).join('')}</div>
      </div>
      <ul class="atlas-list mk-calendar-list">${[...byDay.entries()].filter(([key]) => key >= range.start && key <= range.end).sort(([a], [b]) => a.localeCompare(b)).flatMap(([, list]) => list).map(postRow).join('') || '<li class="mk-muted">Nothing planned this month.</li>'}</ul>`;
  }

  function postsMarkup() {
    const filters = [['active', 'Active'], ['drafts', 'Drafts'], ['approval', 'Waiting'], ['approved', 'Approved']];
    const list = items().filter((item) => {
      if (state.postFilter === 'drafts') return ['idea', 'draft', 'changes_requested'].includes(item.status);
      if (state.postFilter === 'approval') return item.status === 'pending_approval';
      if (state.postFilter === 'approved') return ['approved', 'scheduled'].includes(item.status);
      return !FINAL.has(item.status);
    });
    return `<div class="atlas-toolbar"><div class="atlas-segmented" role="group" aria-label="Show">${filters.map(([key, label]) => `<button type="button" aria-pressed="${state.postFilter === key}" data-mk-filter="${key}">${label}</button>`).join('')}</div><div class="atlas-toolbar__end">${list.length} ${list.length === 1 ? 'post' : 'posts'}</div></div>
      ${list.length ? `<ul class="atlas-list">${list.map(postRow).join('')}</ul>` : emptyMarkup('file-pen-line', 'No posts here', 'Drafts, posts waiting for approval and approved posts appear here.', newPostButton())}`;
  }

  function campaignsMarkup() {
    const list = campaigns();
    return `<div class="atlas-toolbar"><div class="atlas-toolbar__end">${state.staff?.can_approve ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mk-new-campaign><i data-lucide="plus"></i>New campaign</button>' : ''}</div></div>
      ${list.length ? `<ul class="atlas-list">${list.map((campaign) => `<li class="atlas-row"><span class="atlas-row__icon"><i data-lucide="target"></i></span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(campaign.name)}</p><p class="atlas-row__meta">${escapeHtml([humanize(campaign.campaign_type), `${dateOnly(campaign.start_date)} – ${dateOnly(campaign.end_date)}`, channelText(campaign.platforms)].join(' · '))}</p>${campaign.description ? `<p class="atlas-row__meta">${escapeHtml(campaign.description)}</p>` : ''}</div><div class="atlas-row__end">${pill(campaign.status)}</div></li>`).join('')}</ul>` : emptyMarkup('target', 'No campaigns yet', 'Group posts and tasks around one goal, such as a menu launch or an event.', state.staff?.can_approve ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-mk-new-campaign>New campaign</button>' : '')}`;
  }

  function historyMarkup() {
    const done = items().filter((item) => FINAL.has(item.status));
    return `<section class="atlas-section"><div class="atlas-section__head"><h2 class="atlas-section__title">Published and done</h2></div>${done.length ? `<ul class="atlas-list">${done.map(postRow).join('')}</ul>` : '<p class="mk-muted">Published and finished posts appear here.</p>'}</section>
      <section class="atlas-section"><div class="atlas-section__head"><h2 class="atlas-section__title">Activity</h2></div>${history().length ? `<ul class="atlas-list">${history().map((event) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(HISTORY_LABELS[event.event_type] || humanize(event.event_type))}${event.payload?.title ? ` · ${escapeHtml(event.payload.title)}` : ''}</p><p class="atlas-row__meta">${escapeHtml(event.actor_label || 'Atlas')} · ${escapeHtml(dateTime(event.created_at, '—'))}</p></div></li>`).join('')}</ul>` : '<p class="mk-muted">No marketing activity yet.</p>'}</section>`;
  }

  function connectionCaption() {
    const connected = connections().filter((entry) => entry.display_status === 'connected');
    const settings = isManager() ? ' <a href="#settings/integrations">Connections in Settings</a>' : '';
    return connected.length
      ? `${connected.map((entry) => escapeHtml(entry.label)).join(', ')} connected; posting is still marked by hand here.${settings}`
      : `Publishing is manual until a social account is connected.${settings}`;
  }

  function render() {
    const element = host();
    if (!element) return;
    if (!isManager()) {
      element.innerHTML = `<div class="atlas-page mk-page">${window.AtlasShell.pageHead({ title: 'Marketing' })}${emptyMarkup('lock', 'Marketing is for managers', 'Ask an administrator for access.', '<a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a>')}</div>`;
      window.lucide?.createIcons?.();
      return;
    }
    const actions = [{ label: 'Ask Atlas', icon: 'sparkles', variant: 'ghost', attrs: { 'data-mk-ask': '' } }];
    if (state.staff?.can_create !== false) actions.push({ label: 'New post draft', icon: 'plus', variant: 'primary', attrs: { 'data-mk-new': '' } });
    const waiting = items().filter((item) => item.status === 'pending_approval').length;
    let body;
    if (state.error && !state.workspace) body = `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="circle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Marketing couldn't be loaded.</p><p class="atlas-alert__body">${escapeHtml(errorText(state.error, 'Marketing'))}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-mk-retry>Try again</button></div></div>`;
    else if (!state.workspace) body = `<div class="mk-skeleton" aria-busy="true" aria-label="Loading marketing">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(5)}</div>`;
    else body = ({ calendar: calendarMarkup, posts: postsMarkup, campaigns: campaignsMarkup, history: historyMarkup })[state.tab]?.() || overviewMarkup();
    element.innerHTML = `<div class="atlas-page mk-page">
        ${window.AtlasShell.pageHead({ title: 'Marketing', sub: state.workspace ? `${items().filter((item) => !FINAL.has(item.status)).length} planned · ${waiting} waiting for approval` : 'Posts, campaigns and approvals', actions })}
        <p class="mk-caption">${connectionCaption()}</p>
        <nav class="atlas-tabs" aria-label="Marketing">${TABS.map(([key, label]) => `<a href="#marketing${key === 'overview' ? '' : `/${key}`}"${state.tab === key ? ' aria-current="page"' : ''}>${label}${key === 'posts' && waiting ? ` <span class="count">${waiting}</span>` : ''}</a>`).join('')}</nav>
        <div class="mk-body">${body}</div>
      </div>`;
    window.lucide?.createIcons?.();
    // #marketing?recommendation=<id> (Atlas AI record links): show that suggestion.
    if (state.focusSuggestion && state.workspace) {
      const row = [...element.querySelectorAll('[data-mk-suggestion]')].find((node) => node.dataset.mkSuggestion === state.focusSuggestion);
      if (row) { row.scrollIntoView({ block: 'center' }); row.querySelector('[data-mk-plan]')?.focus({ preventScroll: true }); }
      state.focusSuggestion = null;
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

  // Post editor (spec §7.13): channel chips, text, schedule, preview, and
  // Save draft / Submit for approval / manager Approve.
  function openEditor(item = null, { date = null, suggestion = null } = {}) {
    const root = modal('mk-editor');
    const editable = !item || item.can_edit;
    const values = {
      title: item?.title || suggestion?.title || '',
      type: item?.content_type || suggestion?.content_type || 'post',
      platforms: item?.platforms || suggestion?.platforms || [],
      caption: item?.caption_draft || suggestion?.caption_draft || '',
      brief: item?.creative_brief || suggestion?.creative_brief || '',
      media: item?.media_requirements?.notes || '',
      campaign: item?.campaign_id || '',
      scheduled: item?.scheduled_for ? inputValue(item.scheduled_for) : date ? `${date}T` : '',
      reminder: item?.reminder_at ? inputValue(item.reminder_at) : ''
    };
    const approvals = Array.isArray(item?.approval_history) ? item.approval_history : [];
    const canSubmit = item ? ['idea', 'draft', 'changes_requested'].includes(item.status) && item.can_edit : true;
    root.innerHTML = `<section class="atlas-sheet atlas-sheet--wide" data-modal-panel aria-labelledby="mk-editor-title">
        <span class="atlas-sheet__grabber"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="mk-editor-title">${item ? escapeHtml(item.title) : suggestion ? 'Plan a suggestion' : 'New post draft'}</h2><p class="atlas-sheet__desc">${item ? `${escapeHtml(TYPES[item.content_type] || '')} · ${STATUS[item.status]?.[0] || ''}` : 'Nothing is posted automatically.'}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header>
        <form class="atlas-sheet__body atlas-form mk-editor" data-mk-form>
          <div class="atlas-field"><label for="mk-title">Title</label><input class="atlas-input" id="mk-title" name="title" maxlength="180" required value="${escapeHtml(values.title)}"${editable ? '' : ' disabled'}></div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="mk-type">Type</label><select class="atlas-select" id="mk-type" name="content_type"${item ? ' disabled' : ''}>${Object.entries(TYPES).map(([key, label]) => `<option value="${key}"${values.type === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="atlas-field"><label for="mk-campaign">Campaign <span class="optional">(optional)</span></label><select class="atlas-select" id="mk-campaign" name="campaign_id"${editable ? '' : ' disabled'}><option value="">None</option>${campaigns().map((campaign) => `<option value="${escapeHtml(campaign.id)}"${values.campaign === campaign.id ? ' selected' : ''}>${escapeHtml(campaign.name)}</option>`).join('')}</select></div>
          </div>
          <fieldset class="mk-channels"><legend class="atlas-label">Channels</legend><div class="atlas-chips">${Object.entries(CHANNELS).map(([key, label]) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="platforms" value="${key}"${values.platforms.includes(key) ? ' checked' : ''}${editable ? '' : ' disabled'}>${label}</label>`).join('')}</div></fieldset>
          <div class="atlas-field"><label for="mk-caption">Text</label><textarea class="atlas-textarea" id="mk-caption" name="caption_draft" rows="5" maxlength="10000"${editable ? '' : ' disabled'}>${escapeHtml(values.caption)}</textarea></div>
          <div class="atlas-field"><label for="mk-media">Photos or video needed <span class="optional">(optional)</span></label><input class="atlas-input" id="mk-media" name="media" maxlength="2000" value="${escapeHtml(values.media)}" placeholder="e.g. Close-up of the new espresso martini"${editable ? '' : ' disabled'}><p class="help">Attach media when you post; Atlas doesn't store post media yet.</p></div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="mk-when">Post on <span class="optional">(venue time)</span></label><input class="atlas-input" type="datetime-local" id="mk-when" name="scheduled_for" value="${escapeHtml(values.scheduled)}"${editable ? '' : ' disabled'}></div>
            <div class="atlas-field"><label for="mk-reminder">Remind me <span class="optional">(optional)</span></label><input class="atlas-input" type="datetime-local" id="mk-reminder" name="reminder_at" value="${escapeHtml(values.reminder)}"${editable ? '' : ' disabled'}></div>
          </div>
          <section class="mk-preview" aria-label="Preview"><p class="atlas-label">Preview</p><div class="mk-preview__card"><p class="mk-preview__channel" data-mk-preview-channel>${escapeHtml(channelText(values.platforms))}</p><p class="mk-preview__text" data-mk-preview-text>${escapeHtml(values.caption || 'Your text appears here.')}</p><p class="mk-preview__when" data-mk-preview-when>${escapeHtml(values.scheduled && fromInput(values.scheduled) ? dateTime(fromInput(values.scheduled)) : 'Not scheduled')}</p></div></section>
          ${item?.can_approve && item.status === 'pending_approval' ? '<div class="atlas-field"><label for="mk-note">Note for the team <span class="optional">(needed to request changes or reject)</span></label><textarea class="atlas-textarea" id="mk-note" name="note" rows="2"></textarea></div>' : ''}
          ${approvals.length ? `<section class="atlas-stack atlas-stack--sm"><p class="atlas-label">Approval history</p><ul class="atlas-list">${approvals.map((entry) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(humanize(entry.decision))}</p><p class="atlas-row__meta">${escapeHtml(entry.actor_label || '')} · ${escapeHtml(dateTime(entry.created_at, '—'))}${entry.note ? ` · ${escapeHtml(entry.note)}` : ''}</p></div></li>`).join('')}</ul></section>` : ''}
          <p class="error" data-mk-error hidden></p>
        </form>
        <footer class="atlas-sheet__foot">
          ${item?.can_approve && item.status === 'pending_approval'
            ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-mk-decide="rejected">Reject</button><button type="button" class="atlas-btn atlas-btn--secondary" data-mk-decide="changes_requested">Request changes</button><button type="button" class="atlas-btn atlas-btn--primary" data-mk-decide="approved">Approve</button>'
            : item && ['approved', 'scheduled'].includes(item.status) && state.staff?.can_mark_published
              ? '<button type="button" class="atlas-btn atlas-btn--primary" data-mk-published>Mark as published</button>'
              : editable
                ? `<button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--secondary" data-mk-save>Save draft</button>${canSubmit ? '<button type="button" class="atlas-btn atlas-btn--primary" data-mk-submit>Submit for approval</button>' : ''}`
                : '<button type="button" class="atlas-btn atlas-btn--secondary" data-modal-close>Close</button>'}
        </footer>
      </section>`;
    const form = root.querySelector('form');
    form.addEventListener('input', () => {
      root.querySelector('[data-mk-preview-text]').textContent = form.elements.caption_draft.value || 'Your text appears here.';
      root.querySelector('[data-mk-preview-channel]').textContent = channelText([...form.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value));
      const when = fromInput(form.elements.scheduled_for.value);
      root.querySelector('[data-mk-preview-when]').textContent = when ? dateTime(when) : 'Not scheduled';
    });
    const fail = (message) => { const line = form.querySelector('[data-mk-error]'); line.hidden = false; line.textContent = message; };
    const busy = (on) => root.querySelectorAll('.atlas-sheet__foot .atlas-btn').forEach((button) => { button.disabled = on; });
    const collect = () => ({
      title: form.elements.title.value.trim(),
      content_type: item?.content_type || form.elements.content_type.value,
      campaign_id: form.elements.campaign_id.value || null,
      platforms: [...form.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value),
      caption_draft: form.elements.caption_draft.value,
      media_requirements: { notes: form.elements.media.value },
      scheduled_for: fromInput(form.elements.scheduled_for.value),
      reminder_at: fromInput(form.elements.reminder_at.value)
    });
    const validDates = () => {
      for (const name of ['scheduled_for', 'reminder_at']) {
        const raw = form.elements[name].value;
        if (raw && !fromInput(raw)) { form.elements[name].setAttribute('aria-invalid', 'true'); fail('Enter a full date and time, or leave it empty.'); return false; }
      }
      return true;
    };
    const save = async (submit) => {
      const values = collect();
      if (!values.title) { form.elements.title.setAttribute('aria-invalid', 'true'); fail('Give the post a title.'); form.elements.title.focus(); return; }
      if (!validDates()) return;
      busy(true);
      try {
        let contentId = item?.id || null;
        if (suggestion) {
          await mutate('convert-recommendation', { recommendation_id: suggestion.id, occurrence_date: state.workspace?.venue_date || venueToday(), client_request_id: requestId(), scheduled_for: values.scheduled_for, reminder_at: values.reminder_at }, 'Suggestion added as a draft.');
        } else if (item) {
          await mutate('update-content', { content_id: item.id, ...values, priority: item.priority || 'normal', note: null }, 'Draft saved.');
        } else {
          const before = new Set(items().map((entry) => entry.id));
          await mutate('create-content', { client_request_id: requestId(), priority: 'normal', frames: [], ...values }, 'Draft saved.');
          contentId = items().find((entry) => !before.has(entry.id))?.id || null;
        }
        if (submit && contentId) await mutate('submit-approval', { content_id: contentId, note: null }, 'Sent for approval.');
        window.AtlasModal.close(root, 'saved');
      } catch (error) {
        fail(error.userMessage || 'Nothing was changed. Try again.');
        busy(false);
      }
    };
    root.querySelector('[data-mk-save]')?.addEventListener('click', () => save(false));
    root.querySelector('[data-mk-submit]')?.addEventListener('click', () => save(true));
    root.querySelectorAll('[data-mk-decide]').forEach((button) => button.addEventListener('click', async () => {
      const decision = button.dataset.mkDecide;
      const note = form.elements.note?.value.trim() || '';
      if (decision !== 'approved' && !note) { fail('Add a note so the team knows what to change.'); form.elements.note?.focus(); return; }
      busy(true);
      try {
        await mutate('decide-approval', { content_id: item.id, decision, note }, decision === 'approved' ? 'Approved.' : decision === 'rejected' ? 'Rejected.' : 'Changes requested.');
        window.AtlasModal.close(root, 'saved');
      } catch (error) { fail(error.userMessage || 'Nothing was changed. Try again.'); busy(false); }
    }));
    root.querySelector('[data-mk-published]')?.addEventListener('click', async () => {
      busy(true);
      try {
        await mutate('mark-published', { content_id: item.id, published_at: new Date().toISOString(), external_publication_ids: {}, note: null }, 'Marked as published. Nothing was posted by Atlas.');
        window.AtlasModal.close(root, 'saved');
      } catch (error) { fail(error.userMessage || 'Nothing was changed. Try again.'); busy(false); }
    });
    window.AtlasModal.open(root);
    window.lucide?.createIcons?.();
  }

  function openCampaign() {
    const root = modal('mk-campaign');
    root.innerHTML = `<section class="atlas-dialog atlas-dialog--form" data-modal-panel aria-labelledby="mk-campaign-title">
        <h2 class="atlas-dialog__title" id="mk-campaign-title">New campaign</h2>
        <form class="atlas-dialog__body atlas-form" data-mk-campaign-form>
          <div class="atlas-field"><label for="mk-c-name">Name</label><input class="atlas-input" id="mk-c-name" name="name" maxlength="180" required></div>
          <div class="atlas-field"><label for="mk-c-type">Type</label><select class="atlas-select" id="mk-c-type" name="campaign_type">${['promotion', 'event', 'seasonal', 'always_on', 'brand', 'other'].map((key) => `<option value="${key}">${humanize(key)}</option>`).join('')}</select></div>
          <div class="atlas-grid-2"><div class="atlas-field"><label for="mk-c-start">Starts</label><input class="atlas-input" type="date" id="mk-c-start" name="start"></div><div class="atlas-field"><label for="mk-c-end">Ends</label><input class="atlas-input" type="date" id="mk-c-end" name="end"></div></div>
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

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    if (target.closest('[data-mk-retry]')) { load(); return; }
    if (target.closest('[data-mk-ask]')) { window.AtlasAI?.askAbout?.({ type: 'marketing', id: state.tab, label: `Marketing ${TABS.find(([key]) => key === state.tab)?.[1] || ''}`.trim() }); return; }
    if (target.closest('[data-mk-new]')) { openEditor(null); return; }
    const onDay = target.closest('[data-mk-new-on]');
    if (onDay) { if (state.staff?.can_create !== false) openEditor(null, { date: onDay.dataset.mkNewOn }); return; }
    const open = target.closest('[data-mk-open]');
    if (open) { const item = items().find((entry) => entry.id === open.dataset.mkOpen); if (item) openEditor(item); return; }
    const plan = target.closest('[data-mk-plan]');
    if (plan) { const suggestion = suggestions().find((entry) => entry.id === plan.dataset.mkPlan); if (suggestion) openEditor(null, { suggestion, date: suggestion.occurrence_date || venueToday() }); return; }
    if (target.closest('[data-mk-new-campaign]')) { openCampaign(); return; }
    const filter = target.closest('[data-mk-filter]');
    if (filter) { state.postFilter = filter.dataset.mkFilter; render(); return; }
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

  function onShow(params = {}) {
    state.focusSuggestion = params.recommendation ? String(params.recommendation) : null;
    const tab = state.focusSuggestion ? 'overview' : TAB_ALIASES[params.section] || params.section || 'overview';
    state.tab = TABS.some(([key]) => key === tab) ? tab : 'overview';
    render();
    if (isManager() && !state.workspace && !state.loading) load();
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
      window.AtlasShell.actions?.register?.({ id: 'marketing.post.new', label: 'New post draft', icon: 'megaphone', keywords: ['post', 'instagram', 'facebook', 'social', 'marketing'], roles: MANAGERS, contexts: ['marketing', 'home'], run: () => { window.AtlasShell.navigate('#marketing'); window.setTimeout(() => openEditor(null), 0); } });
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStructure();
    document.addEventListener('click', handleClick);
    window.AtlasShell?.on?.('profile:ready', () => { if (visible()) render(); });
  }

  window.AtlasMarketingWorkspace = {
    open: () => window.AtlasShell?.navigate?.('#marketing'),
    refresh: () => load(),
    snapshot: () => state.workspace,
    openContent: (contentId) => {
      window.AtlasShell?.navigate?.('#marketing/posts');
      const item = items().find((entry) => entry.id === contentId);
      if (item) openEditor(item);
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
