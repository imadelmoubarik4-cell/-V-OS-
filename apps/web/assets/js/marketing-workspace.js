(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 15000;
  const PLATFORM_LABELS = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    tiktok: 'TikTok',
    'google-business-profile': 'Google Business Profile'
  };
  const CONTENT_LABELS = {
    post: 'Post',
    story: 'Story',
    reel: 'Reel',
    campaign_task: 'Campaign task',
    event_promotion: 'Event promotion',
    content_idea: 'Content idea',
    google_post: 'Google post'
  };
  const STATUS_LABELS = {
    idea: 'Idea',
    draft: 'Draft',
    pending_approval: 'Waiting approval',
    changes_requested: 'Changes requested',
    approved: 'Approved',
    scheduled: 'Scheduled',
    published: 'Published',
    completed: 'Completed',
    rejected: 'Rejected',
    cancelled: 'Cancelled'
  };
  const CONNECTION_LABELS = {
    not_connected: 'Not connected',
    waiting_for_authorization: 'Waiting for authorization',
    connected: 'Connected',
    missing_publishing_permission: 'Missing publishing permission',
    missing_analytics_permission: 'Missing analytics permission',
    connection_expired: 'Connection expired'
  };

  const state = {
    workspace: null,
    staff: null,
    members: [],
    activeTab: 'overview',
    range: currentMonthRange(new Date()),
    loading: false,
    submitting: false,
    error: null,
    message: null,
    modal: null,
    selectedContentId: null,
    selectedRecommendationId: null,
    selectedCalendarDate: null,
    contentFilter: 'active',
    initialized: false,
    viewObserver: null,
    activating: false
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatBody(value) {
    return escapeHtml(value || '').replace(/\n/g, '<br>');
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `marketing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function currentMonthRange(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { start: dateKey(start), end: dateKey(end), cursor: start };
  }

  function shiftMonth(amount) {
    const cursor = state.range.cursor || new Date(`${state.range.start}T12:00:00`);
    state.range = currentMonthRange(new Date(cursor.getFullYear(), cursor.getMonth() + amount, 1));
  }

  function formatDate(value, options = {}) {
    if (!value) return options.fallback || 'Not scheduled';
    const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', options.dateOnly
      ? { day: '2-digit', month: 'short', year: 'numeric' }
      : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    ).format(date);
  }

  function formatTime(value) {
    if (!value) return '';
    return String(value).slice(0, 5);
  }

  function toLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
  }

  function inputToIso(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function venueDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Atlantic/Reykjavik',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function recommendationDefaultDateTime(recommendation) {
    const day = recommendation?.occurrence_date || state.workspace?.venue_date || venueDate();
    const time = formatTime(recommendation?.suggested_time) || '12:00';
    return `${day}T${time}`;
  }

  function marketingApi() {
    return String(cfg.MARKETING_WORKSPACE_API || '').trim();
  }

  function host() {
    return document.getElementById('marketing-view');
  }

  function marketingVisible() {
    const element = host();
    return Boolean(element) && window.getComputedStyle(element).display !== 'none';
  }

  function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return Promise.resolve(null);
    return client.auth.getSession().then((result) => {
      if (result.error) throw result.error;
      return result.data.session || null;
    });
  }

  async function api(action, options = {}) {
    const endpoint = marketingApi();
    if (!endpoint) throw new Error('Checkpoint D Marketing API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Marketing.');

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
      if (!response.ok) throw new Error(payload.error || `Marketing request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Marketing took too long to respond. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function contentItems() {
    return Array.isArray(state.workspace?.content_items) ? state.workspace.content_items : [];
  }

  function campaigns() {
    return Array.isArray(state.workspace?.campaigns) ? state.workspace.campaigns : [];
  }

  function recommendations() {
    return Array.isArray(state.workspace?.recommendations) ? state.workspace.recommendations : [];
  }

  function connections() {
    return Array.isArray(state.workspace?.connections) ? state.workspace.connections : [];
  }

  function reminders() {
    return Array.isArray(state.workspace?.reminders) ? state.workspace.reminders : [];
  }

  function history() {
    return Array.isArray(state.workspace?.history) ? state.workspace.history : [];
  }

  function selectedContent() {
    return contentItems().find((item) => item.id === state.selectedContentId) || null;
  }

  function selectedRecommendation() {
    return recommendations().find((item) => item.id === state.selectedRecommendationId) || null;
  }

  function platformBadges(platforms) {
    const values = Array.isArray(platforms) ? platforms : [];
    if (!values.length) return '<span class="marketing-platform is-neutral">Internal task</span>';
    return values.map((platform) => `<span class="marketing-platform is-${escapeHtml(platform)}">${escapeHtml(PLATFORM_LABELS[platform] || humanize(platform))}</span>`).join('');
  }

  function statusBadge(status) {
    return `<span class="marketing-status is-${escapeHtml(status || 'draft')}">${escapeHtml(STATUS_LABELS[status] || humanize(status))}</span>`;
  }

  function connectionBadge(status) {
    return `<span class="marketing-connection-status is-${escapeHtml(status || 'not_connected')}">${escapeHtml(CONNECTION_LABELS[status] || humanize(status))}</span>`;
  }

  function contentIcon(type) {
    return ({
      post: 'image', story: 'gallery-vertical-end', reel: 'clapperboard',
      campaign_task: 'list-checks', event_promotion: 'calendar-heart',
      content_idea: 'lightbulb', google_post: 'map-pin'
    })[type] || 'megaphone';
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="marketing-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    if (state.message) return `<div class="marketing-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    return '';
  }

  function tabsMarkup() {
    const tabs = [
      ['overview', 'Overview'], ['calendar', 'Calendar'], ['content', 'Content'],
      ['campaigns', 'Campaigns'], ['connections', 'Connections'], ['history', 'History']
    ];
    return `<nav class="marketing-tabs" aria-label="Marketing sections">${tabs.map(([key, label]) => `<button type="button" class="${state.activeTab === key ? 'is-active' : ''}" data-marketing-tab="${key}">${label}</button>`).join('')}</nav>`;
  }

  function statsMarkup() {
    const stats = state.workspace?.stats || {};
    const values = [
      ['calendar-days', 'Planned', Number(stats.total_items || 0), 'All content and campaign tasks'],
      ['file-pen-line', 'Drafts', Number(stats.drafts || 0), 'Ideas being prepared'],
      ['shield-question', 'Waiting approval', Number(stats.awaiting_approval || 0), 'Manager decision required'],
      ['alarm-clock', 'Overdue reminders', Number(stats.overdue_reminders || 0), 'Needs attention now'],
      ['badge-check', 'Published / complete', Number(stats.published || 0) + Number(stats.completed || 0), 'Preserved in history']
    ];
    return `<div class="marketing-stats">${values.map(([icon, label, value, note]) => `<article><span><i data-lucide="${icon}"></i>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('')}</div>`;
  }

  function recommendationCard(recommendation) {
    const due = Boolean(recommendation.is_due_today);
    const available = recommendation.available_for_today !== false;
    const frames = Array.isArray(recommendation.frames) ? recommendation.frames : [];
    const stateLabel = recommendation.occurrence_state
      ? `${humanize(recommendation.occurrence_state)} today`
      : due ? 'Suggested today' : recommendation.recurrence === 'weekly' ? 'Weekly idea' : 'Always-on idea';
    return `<article class="marketing-recommendation ${due ? 'is-due' : ''}">
      <header>
        <span class="marketing-recommendation-type"><i data-lucide="${contentIcon(recommendation.content_type)}"></i>${escapeHtml(CONTENT_LABELS[recommendation.content_type] || humanize(recommendation.content_type))}</span>
        <span class="marketing-confidence"><i data-lucide="shield-check"></i>${Math.round(Number(recommendation.confidence_score || 0) * 100)}%</span>
      </header>
      <h3>${escapeHtml(recommendation.title)}</h3>
      <p>${escapeHtml(recommendation.summary)}</p>
      <div class="marketing-platform-row">${platformBadges(recommendation.platforms)}</div>
      <dl>
        <div><dt>Format</dt><dd>${escapeHtml(recommendation.suggested_format || 'Format not set')}</dd></div>
        <div><dt>Timing</dt><dd>${escapeHtml(formatTime(recommendation.suggested_time) || 'Flexible')}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(stateLabel)}</dd></div>
      </dl>
      ${frames.length ? `<div class="marketing-frame-preview">${frames.slice(0, 3).map((frame) => `<span><strong>${escapeHtml(frame.title || `Frame ${frame.frame || ''}`)}</strong>${escapeHtml(frame.instruction || '')}</span>`).join('')}</div>` : ''}
      <footer>
        <button type="button" class="marketing-secondary" data-marketing-recommendation-detail="${escapeHtml(recommendation.id)}"><i data-lucide="circle-help"></i>View plan</button>
        ${due && available && state.staff?.can_create ? `<button type="button" class="marketing-primary" data-marketing-convert="${escapeHtml(recommendation.id)}"><i data-lucide="wand-sparkles"></i>Plan this</button>` : ''}
      </footer>
    </article>`;
  }

  function reminderRow(item) {
    const overdue = item.reminder_at && new Date(item.reminder_at) < new Date();
    return `<button type="button" class="marketing-reminder ${overdue ? 'is-overdue' : ''}" data-marketing-open-content="${escapeHtml(item.id)}">
      <span class="marketing-reminder-icon"><i data-lucide="${contentIcon(item.content_type)}"></i></span>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(formatDate(item.reminder_at))} · ${escapeHtml(CONTENT_LABELS[item.content_type] || humanize(item.content_type))}</small></span>
      ${statusBadge(item.status)}
    </button>`;
  }

  function compactConnection(connection) {
    return `<article class="marketing-connection-compact">
      <span class="marketing-connection-logo"><i data-lucide="${connection.provider_key === 'google-business-profile' ? 'map-pin' : 'share-2'}"></i></span>
      <span><strong>${escapeHtml(connection.label)}</strong><small>${escapeHtml(CONNECTION_LABELS[connection.display_status] || humanize(connection.display_status))}</small></span>
      ${connectionBadge(connection.display_status)}
    </article>`;
  }

  function approvalRow(item) {
    return `<button type="button" class="marketing-approval-row" data-marketing-open-content="${escapeHtml(item.id)}">
      <span><i data-lucide="shield-question"></i></span>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(CONTENT_LABELS[item.content_type] || humanize(item.content_type))} · ${escapeHtml(item.created_by_label || 'VÁ team')}</small></span>
      ${statusBadge(item.status)}
    </button>`;
  }

  function overviewMarkup() {
    const dueRecommendations = recommendations().filter((item) => item.is_due_today || item.recurrence === 'daily');
    const upcomingRecommendations = recommendations().filter((item) => !dueRecommendations.includes(item));
    const approvalItems = contentItems().filter((item) => item.status === 'pending_approval');
    return `<div class="marketing-overview">
      ${statsMarkup()}
      <div class="marketing-overview-grid">
        <section class="marketing-panel marketing-recommendation-panel">
          <header class="marketing-panel-head"><div><span>Atlas suggestions</span><h2>What VÁ could publish next</h2><p>Evidence-backed planning ideas. Nothing is posted automatically.</p></div></header>
          <div class="marketing-recommendation-grid">${dueRecommendations.length ? dueRecommendations.map(recommendationCard).join('') : '<p class="marketing-empty">No recommendation is due today.</p>'}</div>
          ${upcomingRecommendations.length ? `<details class="marketing-upcoming"><summary>${upcomingRecommendations.length} upcoming recommendation${upcomingRecommendations.length === 1 ? '' : 's'}</summary><div class="marketing-recommendation-grid">${upcomingRecommendations.map(recommendationCard).join('')}</div></details>` : ''}
        </section>

        <aside class="marketing-side-stack">
          <section class="marketing-panel">
            <header class="marketing-panel-head"><div><span>Reminders</span><h2>Coming up</h2></div><button type="button" data-marketing-tab-jump="calendar">Calendar</button></header>
            <div class="marketing-reminder-list">${reminders().length ? reminders().slice(0, 8).map(reminderRow).join('') : '<p class="marketing-empty">No reminders are scheduled yet.</p>'}</div>
          </section>
          <section class="marketing-panel">
            <header class="marketing-panel-head"><div><span>Approval workflow</span><h2>Waiting for review</h2></div></header>
            <div class="marketing-approval-list">${approvalItems.length ? approvalItems.map(approvalRow).join('') : '<p class="marketing-empty">Nothing is waiting for approval.</p>'}</div>
          </section>
          <section class="marketing-panel">
            <header class="marketing-panel-head"><div><span>Connections</span><h2>Publishing readiness</h2><p>Planning works now; publishing remains permission-gated.</p></div><button type="button" data-marketing-tab-jump="connections">View all</button></header>
            <div class="marketing-connection-compact-list">${connections().map(compactConnection).join('')}</div>
          </section>
        </aside>
      </div>
    </div>`;
  }

  function itemDates(item) {
    const dates = [];
    ['scheduled_for', 'reminder_at', 'event_starts_at'].forEach((field) => {
      if (!item[field]) return;
      const date = new Date(item[field]);
      if (!Number.isNaN(date.getTime())) dates.push(dateKey(date));
    });
    return [...new Set(dates)];
  }

  function calendarItemsFor(dayKey) {
    return contentItems().filter((item) => itemDates(item).includes(dayKey));
  }

  function calendarMarkup() {
    const cursor = state.range.cursor || new Date(`${state.range.start}T12:00:00`);
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const mondayOffset = (first.getDay() + 6) % 7;
    const cells = [];
    for (let offset = 0; offset < mondayOffset; offset += 1) {
      const date = new Date(first);
      date.setDate(first.getDate() - (mondayOffset - offset));
      cells.push({ date, outside: true });
    }
    for (let day = 1; day <= last.getDate(); day += 1) cells.push({ date: new Date(cursor.getFullYear(), cursor.getMonth(), day), outside: false });
    while (cells.length % 7) {
      const date = new Date(last);
      date.setDate(last.getDate() + (cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7)));
      const previous = cells[cells.length - 1]?.date || last;
      const next = new Date(previous);
      next.setDate(previous.getDate() + 1);
      cells.push({ date: next, outside: true });
    }

    const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(cursor);
    return `<section class="marketing-panel marketing-calendar-panel">
      <header class="marketing-calendar-head">
        <div><span>Content calendar</span><h2>${escapeHtml(monthLabel)}</h2><p>Posts, Stories, Reels, campaign tasks, reminders and event promotions.</p></div>
        <div><button type="button" data-marketing-month="-1" aria-label="Previous month"><i data-lucide="chevron-left"></i></button><button type="button" data-marketing-today>Today</button><button type="button" data-marketing-month="1" aria-label="Next month"><i data-lucide="chevron-right"></i></button></div>
      </header>
      <div class="marketing-calendar-weekdays">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day) => `<span>${day}</span>`).join('')}</div>
      <div class="marketing-calendar-grid">${cells.map(({ date, outside }) => {
        const key = dateKey(date);
        const items = calendarItemsFor(key);
        const today = key === venueDate();
        return `<article class="marketing-calendar-day ${outside ? 'is-outside' : ''} ${today ? 'is-today' : ''}" data-marketing-calendar-date="${key}">
          <header><button type="button" data-marketing-new-on-date="${key}">${date.getDate()}</button>${items.length ? `<span>${items.length}</span>` : ''}</header>
          <div>${items.slice(0, 4).map((item) => `<button type="button" class="marketing-calendar-item is-${escapeHtml(item.content_type)}" data-marketing-open-content="${escapeHtml(item.id)}"><i data-lucide="${contentIcon(item.content_type)}"></i><span>${escapeHtml(item.title)}</span></button>`).join('')}${items.length > 4 ? `<small>+${items.length - 4} more</small>` : ''}</div>
        </article>`;
      }).join('')}</div>
    </section>`;
  }

  function filteredContent() {
    const items = contentItems();
    if (state.contentFilter === 'history') return items.filter((item) => ['published','completed','rejected','cancelled'].includes(item.status));
    if (state.contentFilter === 'approval') return items.filter((item) => item.status === 'pending_approval');
    if (state.contentFilter === 'approved') return items.filter((item) => ['approved','scheduled'].includes(item.status));
    if (state.contentFilter === 'drafts') return items.filter((item) => ['idea','draft','changes_requested'].includes(item.status));
    return items.filter((item) => !['published','completed','rejected','cancelled'].includes(item.status));
  }

  function contentCard(item) {
    const canSubmit = ['idea','draft','changes_requested'].includes(item.status) && item.can_edit;
    const canComplete = !['published','completed','rejected','cancelled'].includes(item.status)
      && (item.content_type === 'campaign_task' || item.content_type === 'event_promotion' || state.staff?.can_approve);
    return `<article class="marketing-content-card">
      <header>
        <span class="marketing-content-icon"><i data-lucide="${contentIcon(item.content_type)}"></i></span>
        <div><span>${escapeHtml(CONTENT_LABELS[item.content_type] || humanize(item.content_type))}</span><h3>${escapeHtml(item.title)}</h3></div>
        ${statusBadge(item.status)}
      </header>
      <div class="marketing-platform-row">${platformBadges(item.platforms)}</div>
      <dl>
        <div><dt>Scheduled</dt><dd>${escapeHtml(formatDate(item.scheduled_for))}</dd></div>
        <div><dt>Reminder</dt><dd>${escapeHtml(formatDate(item.reminder_at))}</dd></div>
        <div><dt>Owner</dt><dd>${escapeHtml(item.owner_label || item.created_by_label || 'Unassigned')}</dd></div>
        <div><dt>Campaign</dt><dd>${escapeHtml(item.campaign_name || 'No campaign')}</dd></div>
      </dl>
      ${item.caption_draft ? `<div class="marketing-caption-preview"><span>Caption draft</span><p>${escapeHtml(item.caption_draft)}</p></div>` : ''}
      <footer>
        <button type="button" class="marketing-secondary" data-marketing-open-content="${escapeHtml(item.id)}">Open</button>
        ${canSubmit ? `<button type="button" class="marketing-secondary" data-marketing-submit-approval="${escapeHtml(item.id)}">Send for approval</button>` : ''}
        ${item.can_approve ? `<button type="button" class="marketing-primary" data-marketing-approval="${escapeHtml(item.id)}">Review</button>` : ''}
        ${state.staff?.can_mark_published && ['approved','scheduled'].includes(item.status) ? `<button type="button" class="marketing-primary" data-marketing-published="${escapeHtml(item.id)}">Mark published</button>` : ''}
        ${canComplete ? `<button type="button" class="marketing-secondary" data-marketing-complete="${escapeHtml(item.id)}">Complete</button>` : ''}
      </footer>
    </article>`;
  }

  function contentMarkup() {
    const filters = [['active','Active'],['drafts','Drafts'],['approval','Approval'],['approved','Approved'],['history','History']];
    const items = filteredContent();
    return `<section class="marketing-panel">
      <header class="marketing-panel-head marketing-content-head">
        <div><span>Content workspace</span><h2>Ideas, drafts and publishing history</h2><p>Create content independently of platform connections, then move it through approval.</p></div>
        ${state.staff?.can_create ? '<button type="button" class="marketing-primary" data-marketing-new-content><i data-lucide="plus"></i>New content</button>' : ''}
      </header>
      <div class="marketing-filter-row">${filters.map(([key,label]) => `<button type="button" class="${state.contentFilter === key ? 'is-active' : ''}" data-marketing-filter="${key}">${label}</button>`).join('')}</div>
      <div class="marketing-content-grid">${items.length ? items.map(contentCard).join('') : '<div class="marketing-empty-state"><i data-lucide="calendar-plus"></i><h3>No content here yet</h3><p>Create a draft or convert an Atlas recommendation.</p></div>'}</div>
    </section>`;
  }

  function campaignCard(campaign) {
    return `<article class="marketing-campaign-card">
      <header><span>${escapeHtml(humanize(campaign.campaign_type))}</span>${statusBadge(campaign.status)}</header>
      <h3>${escapeHtml(campaign.name)}</h3>
      <p>${escapeHtml(campaign.description || campaign.objective || 'Campaign brief not added yet.')}</p>
      <div class="marketing-platform-row">${platformBadges(campaign.platforms)}</div>
      <dl><div><dt>Start</dt><dd>${escapeHtml(formatDate(campaign.start_date,{dateOnly:true}))}</dd></div><div><dt>End</dt><dd>${escapeHtml(formatDate(campaign.end_date,{dateOnly:true}))}</dd></div></dl>
    </article>`;
  }

  function campaignsMarkup() {
    return `<section class="marketing-panel">
      <header class="marketing-panel-head"><div><span>Campaign planning</span><h2>Campaigns and event promotions</h2><p>Group content, tasks and reminders around one objective.</p></div>${state.staff?.can_approve ? '<button type="button" class="marketing-primary" data-marketing-new-campaign><i data-lucide="plus"></i>New campaign</button>' : ''}</header>
      <div class="marketing-campaign-grid">${campaigns().length ? campaigns().map(campaignCard).join('') : '<div class="marketing-empty-state"><i data-lucide="target"></i><h3>No campaigns yet</h3><p>Create the first campaign when several content items share one goal.</p></div>'}</div>
    </section>`;
  }

  function connectionRequirementText(connection) {
    const requirements = connection.requirements || {};
    const values = Object.entries(requirements).filter(([, value]) => Boolean(value));
    if (!values.length) return 'Authorization requirements have not been configured.';
    return values.slice(0, 5).map(([key, value]) => {
      const detail = Array.isArray(value) ? value.join(', ') : value === true ? 'required' : String(value);
      return `${humanize(key)}: ${detail}`;
    }).join(' · ');
  }

  function connectionCard(connection) {
    const publishing = humanize(connection.publishing_permission_state || 'not requested');
    const analytics = humanize(connection.analytics_permission_state || 'not requested');
    return `<article class="marketing-connection-card is-${escapeHtml(connection.display_status)}">
      <header><span class="marketing-connection-logo"><i data-lucide="${connection.provider_key === 'google-business-profile' ? 'map-pinned' : 'share-2'}"></i></span><div><span>Platform connection</span><h3>${escapeHtml(connection.label)}</h3></div>${connectionBadge(connection.display_status)}</header>
      <p>${escapeHtml(connectionRequirementText(connection))}</p>
      <dl>
        <div><dt>Authorization</dt><dd>${escapeHtml(humanize(connection.authorization_state))}</dd></div>
        <div><dt>Publishing permission</dt><dd>${escapeHtml(publishing)}</dd></div>
        <div><dt>Analytics permission</dt><dd>${escapeHtml(analytics)}</dd></div>
        <div><dt>Verified account</dt><dd>${escapeHtml(connection.external_account_label || 'None')}</dd></div>
      </dl>
      <footer><i data-lucide="lock-keyhole"></i><span>Publishing and analytics remain disabled until server-side authorization and required permissions are verified.</span></footer>
    </article>`;
  }

  function connectionsMarkup() {
    return `<section class="marketing-panel">
      <header class="marketing-panel-head"><div><span>Connection boundaries</span><h2>Social and business-profile readiness</h2><p>Atlas reports only verified states. A platform is never shown as connected without a valid server-side authorization check.</p></div></header>
      <div class="marketing-connection-grid">${connections().map(connectionCard).join('')}</div>
      <div class="marketing-connection-legend">${Object.entries(CONNECTION_LABELS).map(([key,label]) => connectionBadge(key).replace(label,label)).join('')}</div>
    </section>`;
  }

  function historyLabel(event) {
    const labels = {
      campaign_created: 'Campaign created', content_created: 'Content created', content_updated: 'Content updated',
      approval_submitted: 'Sent for approval', approval_decided: 'Approval decided', content_published: 'Marked published',
      content_completed: 'Completed', content_cancelled: 'Cancelled', recommendation_converted: 'Recommendation planned',
      recommendation_dismissed: 'Recommendation dismissed', connection_state_changed: 'Connection state changed'
    };
    return labels[event.event_type] || humanize(event.event_type);
  }

  function historyMarkup() {
    const finalItems = contentItems().filter((item) => ['published','completed','rejected','cancelled'].includes(item.status));
    return `<div class="marketing-history-layout">
      <section class="marketing-panel">
        <header class="marketing-panel-head"><div><span>Activity history</span><h2>Approvals and decisions</h2><p>Every significant change remains auditable.</p></div></header>
        <div class="marketing-history-list">${history().length ? history().map((event) => `<article><span><i data-lucide="history"></i></span><div><strong>${escapeHtml(historyLabel(event))}</strong><p>${escapeHtml(event.payload?.title || event.payload?.recommendation_key || event.payload?.note || '')}</p><small>${escapeHtml(event.actor_label || 'Atlas')} · ${escapeHtml(formatDate(event.created_at))}</small></div></article>`).join('') : '<p class="marketing-empty">No marketing activity has been recorded yet.</p>'}</div>
      </section>
      <section class="marketing-panel">
        <header class="marketing-panel-head"><div><span>Published / completed</span><h2>Content history</h2></div></header>
        <div class="marketing-history-content">${finalItems.length ? finalItems.map(contentCard).join('') : '<p class="marketing-empty">Published and completed content will appear here.</p>'}</div>
      </section>
    </div>`;
  }

  function bodyMarkup() {
    if (state.activeTab === 'calendar') return calendarMarkup();
    if (state.activeTab === 'content') return contentMarkup();
    if (state.activeTab === 'campaigns') return campaignsMarkup();
    if (state.activeTab === 'connections') return connectionsMarkup();
    if (state.activeTab === 'history') return historyMarkup();
    return overviewMarkup();
  }

  function platformCheckboxes(selected = []) {
    return Object.entries(PLATFORM_LABELS).map(([key,label]) => `<label class="marketing-check"><input type="checkbox" name="platforms" value="${key}" ${selected.includes(key) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('');
  }

  function framesToText(frames) {
    return (Array.isArray(frames) ? frames : []).map((frame) => `${frame.title || `Frame ${frame.frame || ''}`} | ${frame.instruction || ''}`).join('\n');
  }

  function parseFrames(value) {
    return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0,20).map((line,index) => {
      const [title, ...instruction] = line.split('|');
      return { frame:index + 1, title:title.trim(), instruction:instruction.join('|').trim() };
    });
  }

  function contentModalMarkup() {
    const item = state.modal?.mode === 'edit-content' ? selectedContent() : null;
    const scheduled = item?.scheduled_for || (state.selectedCalendarDate ? `${state.selectedCalendarDate}T12:00:00` : null);
    return `<div class="marketing-modal-backdrop" data-marketing-close-modal></div><section class="marketing-modal" role="dialog" aria-modal="true" aria-labelledby="marketing-modal-title">
      <header><div><span>Content planner</span><h2 id="marketing-modal-title">${item ? 'Edit content' : 'New content'}</h2></div><button type="button" data-marketing-close-modal aria-label="Close"><i data-lucide="x"></i></button></header>
      <form data-marketing-content-form>
        <div class="marketing-form-scroll">
          <div class="marketing-form-grid">
            <label class="is-wide"><span>Title</span><input name="title" maxlength="180" required value="${escapeHtml(item?.title || '')}" placeholder="What are we planning?" /></label>
            <label><span>Content type</span><select name="content_type" ${item ? 'disabled' : ''}>${Object.entries(CONTENT_LABELS).map(([key,label]) => `<option value="${key}" ${(item?.content_type || 'post') === key ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
            <label><span>Priority</span><select name="priority">${['low','normal','high','urgent'].map((key) => `<option value="${key}" ${(item?.priority || 'normal') === key ? 'selected' : ''}>${humanize(key)}</option>`).join('')}</select></label>
            <label><span>Campaign</span><select name="campaign_id"><option value="">No campaign</option>${campaigns().map((campaign) => `<option value="${campaign.id}" ${item?.campaign_id === campaign.id ? 'selected' : ''}>${escapeHtml(campaign.name)}</option>`).join('')}</select></label>
            <label><span>Owner</span><select name="owner_id"><option value="">Unassigned</option>${state.members.map((member) => `<option value="${member.id}" ${item?.owner_id === member.id ? 'selected' : ''}>${escapeHtml(member.label)} · ${escapeHtml(humanize(member.role))}</option>`).join('')}</select></label>
            <fieldset class="is-wide"><legend>Platforms</legend><div class="marketing-platform-picker">${platformCheckboxes(item?.platforms || [])}</div></fieldset>
            <label><span>Scheduled for</span><input type="datetime-local" name="scheduled_for" value="${escapeHtml(toLocalInput(scheduled))}" /></label>
            <label><span>Reminder</span><input type="datetime-local" name="reminder_at" value="${escapeHtml(toLocalInput(item?.reminder_at))}" /></label>
            <label><span>Event starts</span><input type="datetime-local" name="event_starts_at" value="${escapeHtml(toLocalInput(item?.event_starts_at))}" /></label>
            <label><span>Event ends</span><input type="datetime-local" name="event_ends_at" value="${escapeHtml(toLocalInput(item?.event_ends_at))}" /></label>
            <label class="is-wide"><span>Suggested format</span><input name="suggested_format" maxlength="2000" value="${escapeHtml(item?.suggested_format || '')}" placeholder="Example: Three-frame vertical Story" /></label>
            <label class="is-wide"><span>Draft caption</span><textarea name="caption_draft" rows="5" maxlength="10000" placeholder="Write or refine the caption here…">${escapeHtml(item?.caption_draft || '')}</textarea></label>
            <label class="is-wide"><span>Creative brief</span><textarea name="creative_brief" rows="4" maxlength="10000" placeholder="Describe the visual, hook and call to action…">${escapeHtml(item?.creative_brief || '')}</textarea></label>
            <label class="is-wide"><span>Frame / shot plan</span><textarea name="frames" rows="4" placeholder="Atmosphere | Show the bar and guests\nOffer | Show cocktails from 1,990 ISK\nVisit VÁ | Add location and booking link">${escapeHtml(framesToText(item?.frames))}</textarea><small>One line per frame: title | instruction</small></label>
            <label class="is-wide"><span>Media requirements</span><textarea name="media_requirements" rows="3" placeholder="Photos, video clips, logo, link, product shot…">${escapeHtml(item?.media_requirements?.notes || '')}</textarea></label>
            ${item ? `<label class="is-wide"><span>Change note</span><input name="note" maxlength="2000" placeholder="What changed?" /></label>` : ''}
          </div>
        </div>
        <footer><button type="button" class="marketing-secondary" data-marketing-close-modal>Cancel</button><button type="submit" class="marketing-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>${item ? 'Save changes' : 'Create draft'}</button></footer>
      </form>
    </section>`;
  }

  function campaignModalMarkup() {
    return `<div class="marketing-modal-backdrop" data-marketing-close-modal></div><section class="marketing-modal is-compact" role="dialog" aria-modal="true" aria-labelledby="marketing-modal-title"><header><div><span>Campaign planner</span><h2 id="marketing-modal-title">New campaign</h2></div><button type="button" data-marketing-close-modal><i data-lucide="x"></i></button></header><form data-marketing-campaign-form><div class="marketing-form-scroll"><div class="marketing-form-grid">
      <label class="is-wide"><span>Name</span><input name="name" maxlength="180" required placeholder="Campaign name" /></label>
      <label><span>Type</span><select name="campaign_type">${['promotion','event','seasonal','always_on','brand','other'].map((key) => `<option value="${key}">${humanize(key)}</option>`).join('')}</select></label>
      <label><span>Start date</span><input type="date" name="campaign_start_date" /></label>
      <label><span>End date</span><input type="date" name="campaign_end_date" /></label>
      <fieldset class="is-wide"><legend>Platforms</legend><div class="marketing-platform-picker">${platformCheckboxes([])}</div></fieldset>
      <label class="is-wide"><span>Objective</span><textarea name="objective" rows="3"></textarea></label>
      <label class="is-wide"><span>Target audience</span><textarea name="target_audience" rows="3"></textarea></label>
      <label class="is-wide"><span>Description</span><textarea name="description" rows="4"></textarea></label>
      </div></div><footer><button type="button" class="marketing-secondary" data-marketing-close-modal>Cancel</button><button type="submit" class="marketing-primary">Create campaign</button></footer></form></section>`;
  }

  function recommendationModalMarkup() {
    const recommendation = selectedRecommendation();
    if (!recommendation) return '';
    const frames = Array.isArray(recommendation.frames) ? recommendation.frames : [];
    const evidence = Array.isArray(recommendation.evidence) ? recommendation.evidence : [];
    return `<div class="marketing-modal-backdrop" data-marketing-close-modal></div><section class="marketing-modal" role="dialog" aria-modal="true" aria-labelledby="marketing-modal-title"><header><div><span>Atlas recommendation</span><h2 id="marketing-modal-title">${escapeHtml(recommendation.title)}</h2></div><button type="button" data-marketing-close-modal><i data-lucide="x"></i></button></header><div class="marketing-form-scroll marketing-recommendation-detail">
      <div class="marketing-platform-row">${platformBadges(recommendation.platforms)}<span class="marketing-confidence"><i data-lucide="shield-check"></i>${Math.round(Number(recommendation.confidence_score || 0)*100)}%</span></div>
      <p class="marketing-recommendation-summary">${escapeHtml(recommendation.summary)}</p>
      <section><span>Suggested format</span><h3>${escapeHtml(recommendation.suggested_format || 'Format not set')}</h3><p>${escapeHtml(recommendation.creative_brief || '')}</p></section>
      ${frames.length ? `<section><span>Frame / shot plan</span><div class="marketing-detail-frames">${frames.map((frame) => `<article><strong>${escapeHtml(frame.title || `Frame ${frame.frame || ''}`)}</strong><p>${escapeHtml(frame.instruction || '')}</p></article>`).join('')}</div></section>` : ''}
      ${recommendation.caption_draft ? `<section><span>Draft caption</span><div class="marketing-detail-caption">${formatBody(recommendation.caption_draft)}</div></section>` : ''}
      <section><span>Why Atlas suggests this</span><p>${escapeHtml(recommendation.reason || '')}</p>${evidence.length ? `<div class="marketing-evidence-list">${evidence.map((entry) => `<article><strong>${escapeHtml(entry.source || 'VÁ evidence')}</strong><p>${escapeHtml(entry.fact || '')}</p></article>`).join('')}</div>` : ''}</section>
    </div><footer>${state.staff?.can_approve && recommendation.is_due_today && recommendation.available_for_today !== false ? `<button type="button" class="marketing-secondary is-danger" data-marketing-dismiss="${escapeHtml(recommendation.id)}">Dismiss today</button>` : '<span></span>'}${state.staff?.can_create && recommendation.is_due_today && recommendation.available_for_today !== false ? `<button type="button" class="marketing-primary" data-marketing-convert="${escapeHtml(recommendation.id)}">Plan this</button>` : ''}</footer></section>`;
  }

  function convertModalMarkup() {
    const recommendation = selectedRecommendation();
    if (!recommendation) return '';
    const suggested = recommendationDefaultDateTime(recommendation);
    return `<div class="marketing-modal-backdrop" data-marketing-close-modal></div><section class="marketing-modal is-compact" role="dialog" aria-modal="true"><header><div><span>Convert recommendation</span><h2>Plan ${escapeHtml(recommendation.title)}</h2></div><button type="button" data-marketing-close-modal><i data-lucide="x"></i></button></header><form data-marketing-convert-form><div class="marketing-form-scroll"><p class="marketing-modal-intro">Atlas will create an editable draft. Nothing will be published.</p><div class="marketing-form-grid"><label class="is-wide"><span>Scheduled for</span><input type="datetime-local" name="scheduled_for" value="${escapeHtml(suggested)}" /></label><label class="is-wide"><span>Reminder</span><input type="datetime-local" name="reminder_at" /></label></div></div><footer><button type="button" class="marketing-secondary" data-marketing-close-modal>Cancel</button><button type="submit" class="marketing-primary">Create draft</button></footer></form></section>`;
  }

  function approvalModalMarkup() {
    const item = selectedContent();
    if (!item) return '';
    return `<div class="marketing-modal-backdrop" data-marketing-close-modal></div><section class="marketing-modal is-compact" role="dialog" aria-modal="true"><header><div><span>Approval workflow</span><h2>Review ${escapeHtml(item.title)}</h2></div><button type="button" data-marketing-close-modal><i data-lucide="x"></i></button></header><div class="marketing-form-scroll marketing-approval-detail"><div class="marketing-platform-row">${platformBadges(item.platforms)}${statusBadge(item.status)}</div><p>${formatBody(item.caption_draft || item.creative_brief || 'No caption or brief has been added.')}</p><label><span>Manager note</span><textarea data-marketing-approval-note rows="4" placeholder="Required when requesting changes or rejecting"></textarea></label></div><footer class="marketing-approval-actions"><button type="button" class="marketing-secondary is-danger" data-marketing-decide="rejected">Reject</button><button type="button" class="marketing-secondary" data-marketing-decide="changes_requested">Request changes</button><button type="button" class="marketing-primary" data-marketing-decide="approved">Approve</button></footer></section>`;
  }

  function contentDetailModalMarkup() {
    const item = selectedContent();
    if (!item) return '';
    const approvals = Array.isArray(item.approval_history) ? item.approval_history : [];
    return `<div class="marketing-modal-backdrop" data-marketing-close-modal></div><section class="marketing-modal" role="dialog" aria-modal="true"><header><div><span>${escapeHtml(CONTENT_LABELS[item.content_type] || humanize(item.content_type))}</span><h2>${escapeHtml(item.title)}</h2></div><button type="button" data-marketing-close-modal><i data-lucide="x"></i></button></header><div class="marketing-form-scroll marketing-content-detail"><div class="marketing-platform-row">${platformBadges(item.platforms)}${statusBadge(item.status)}</div><dl><div><dt>Scheduled</dt><dd>${escapeHtml(formatDate(item.scheduled_for))}</dd></div><div><dt>Reminder</dt><dd>${escapeHtml(formatDate(item.reminder_at))}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(item.owner_label || 'Unassigned')}</dd></div><div><dt>Campaign</dt><dd>${escapeHtml(item.campaign_name || 'None')}</dd></div></dl>${item.suggested_format ? `<section><span>Format</span><p>${escapeHtml(item.suggested_format)}</p></section>` : ''}${item.caption_draft ? `<section><span>Caption draft</span><div class="marketing-detail-caption">${formatBody(item.caption_draft)}</div></section>` : ''}${item.creative_brief ? `<section><span>Creative brief</span><p>${formatBody(item.creative_brief)}</p></section>` : ''}${Array.isArray(item.frames) && item.frames.length ? `<section><span>Frame / shot plan</span><div class="marketing-detail-frames">${item.frames.map((frame) => `<article><strong>${escapeHtml(frame.title || '')}</strong><p>${escapeHtml(frame.instruction || '')}</p></article>`).join('')}</div></section>` : ''}${approvals.length ? `<section><span>Approval history</span><div class="marketing-evidence-list">${approvals.map((approval) => `<article><strong>${escapeHtml(humanize(approval.decision))}</strong><p>${escapeHtml(approval.note || 'No note')}</p><small>${escapeHtml(approval.actor_label)} · ${escapeHtml(formatDate(approval.created_at))}</small></article>`).join('')}</div></section>` : ''}</div><footer>${item.can_edit ? `<button type="button" class="marketing-secondary" data-marketing-edit-content="${escapeHtml(item.id)}">Edit</button>` : '<span></span>'}<button type="button" class="marketing-primary" data-marketing-close-modal>Done</button></footer></section>`;
  }

  function modalMarkup() {
    if (!state.modal) return '';
    const body = state.modal.mode === 'new-content' || state.modal.mode === 'edit-content' ? contentModalMarkup()
      : state.modal.mode === 'new-campaign' ? campaignModalMarkup()
      : state.modal.mode === 'recommendation-detail' ? recommendationModalMarkup()
      : state.modal.mode === 'convert-recommendation' ? convertModalMarkup()
      : state.modal.mode === 'approval' ? approvalModalMarkup()
      : state.modal.mode === 'content-detail' ? contentDetailModalMarkup()
      : '';
    return body ? `<div class="marketing-modal-shell">${body}</div>` : '';
  }

  function shellMarkup() {
    return `<section class="marketing-shell">
      <header class="marketing-hero">
        <div><span><i data-lucide="megaphone"></i>Checkpoint D · Content planning</span><h1>Marketing</h1><p>Plan campaigns, reminders, content and approvals before any social connection exists.</p></div>
        <div class="marketing-hero-actions"><button type="button" class="marketing-secondary" data-marketing-team-channel><i data-lucide="messages-square"></i>Marketing chat</button>${state.staff?.can_create ? '<button type="button" class="marketing-primary" data-marketing-new-content><i data-lucide="plus"></i>New content</button>' : ''}</div>
      </header>
      <div class="marketing-trust"><i data-lucide="shield-check"></i><div><strong>Planning mode</strong><span>No automatic publishing · No analytics ingestion · OAuth tokens never enter the browser · Manager approval required</span></div></div>
      ${feedbackMarkup()}
      ${tabsMarkup()}
      ${bodyMarkup()}
      ${modalMarkup()}
    </section>`;
  }

  function loadingMarkup() {
    return `<section class="marketing-shell is-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading Marketing</h2><p>Reading the content calendar, reminders, campaigns, recommendations and connection boundaries.</p></section>`;
  }

  function errorMarkup() {
    return `<section class="marketing-shell is-state"><span class="is-error"><i data-lucide="megaphone-off"></i></span><h2>Marketing unavailable</h2><p>${escapeHtml(state.error || 'The workspace could not load.')}</p><button type="button" class="marketing-primary" data-marketing-refresh>Try again</button></section>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    if (state.loading && !state.workspace) element.innerHTML = loadingMarkup();
    else if (state.error && !state.workspace) element.innerHTML = errorMarkup();
    else element.innerHTML = shellMarkup();
    window.lucide?.createIcons?.();
    document.body.classList.toggle('marketing-modal-open', Boolean(state.modal));
  }

  async function loadSnapshot(options = {}) {
    if (state.loading) return;
    state.loading = !state.workspace;
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot', { params: { start: state.range.start, end: state.range.end } });
      state.workspace = payload.workspace || {};
      state.staff = payload.staff || state.staff;
      state.members = Array.isArray(payload.members) ? payload.members : state.members;
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Marketing could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api(action, {
        method: 'POST',
        body: { ...body, start_date: state.range.start, end_date: state.range.end }
      });
      if (payload.workspace) state.workspace = payload.workspace;
      if (payload.staff) state.staff = payload.staff;
      if (Array.isArray(payload.members)) state.members = payload.members;
      state.message = successMessage;
      state.modal = null;
      state.selectedContentId = null;
      state.selectedRecommendationId = null;
      state.selectedCalendarDate = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The Marketing action failed.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function selectedPlatforms(form) {
    return [...form.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value);
  }

  function formValue(form, name) {
    return form.elements.namedItem(name)?.value ?? '';
  }

  function submitContentForm(form) {
    const editing = state.modal?.mode === 'edit-content';
    const item = selectedContent();
    const body = {
      client_request_id: editing ? undefined : requestId(),
      content_id: editing ? item?.id : undefined,
      title: formValue(form, 'title'),
      content_type: editing ? item?.content_type : formValue(form, 'content_type'),
      priority: formValue(form, 'priority'),
      campaign_id: formValue(form, 'campaign_id') || null,
      owner_id: formValue(form, 'owner_id') || null,
      platforms: selectedPlatforms(form),
      scheduled_for: inputToIso(formValue(form, 'scheduled_for')),
      reminder_at: inputToIso(formValue(form, 'reminder_at')),
      event_starts_at: inputToIso(formValue(form, 'event_starts_at')),
      event_ends_at: inputToIso(formValue(form, 'event_ends_at')),
      suggested_format: formValue(form, 'suggested_format'),
      caption_draft: formValue(form, 'caption_draft'),
      creative_brief: formValue(form, 'creative_brief'),
      frames: parseFrames(formValue(form, 'frames')),
      media_requirements: { notes: formValue(form, 'media_requirements') },
      note: formValue(form, 'note'),
      metadata: { created_in_checkpoint: 'D' }
    };
    mutate(editing ? 'update-content' : 'create-content', body, editing ? 'Content updated.' : 'Draft created.');
  }

  function submitCampaignForm(form) {
    mutate('create-campaign', {
      name: formValue(form, 'name'),
      campaign_type: formValue(form, 'campaign_type'),
      campaign_start_date: formValue(form, 'campaign_start_date') || null,
      campaign_end_date: formValue(form, 'campaign_end_date') || null,
      platforms: selectedPlatforms(form),
      objective: formValue(form, 'objective'),
      target_audience: formValue(form, 'target_audience'),
      description: formValue(form, 'description')
    }, 'Campaign created.');
  }

  function submitConvertForm(form) {
    const recommendation = selectedRecommendation();
    if (!recommendation) return;
    mutate('convert-recommendation', {
      recommendation_id: recommendation.id,
      occurrence_date: state.workspace?.venue_date || venueDate(),
      client_request_id: requestId(),
      scheduled_for: inputToIso(formValue(form, 'scheduled_for')),
      reminder_at: inputToIso(formValue(form, 'reminder_at'))
    }, 'Atlas recommendation converted to an editable draft.');
  }

  function activateMarketing() {
    ensureStructure();
    state.activating = true;
    document.querySelectorAll('#inventory-view,#dashboard-view,#recipes-view,#suppliers-view,#imports-view,#team-view,#shifts-view,#knowledge-view,#reports-view,#settings-view,#operations-center,#brain-shell').forEach((view) => { view.style.display = 'none'; });
    ['home-intro','home-focus','home-metrics'].forEach((id) => { const element = document.getElementById(id); if (element) element.style.display = 'none'; });
    const element = host();
    if (element) element.style.display = 'block';
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = 'Marketing';
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === 'marketing'));
    document.getElementById('atlas-sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
    state.activating = false;
    if (!state.workspace && !state.loading) loadSnapshot();
    else render();
  }

  function hideMarketing() {
    const element = host();
    if (element && element.style.display !== 'none') element.style.display = 'none';
    state.modal = null;
    document.body.classList.remove('marketing-modal-open');
  }

  function ensureStructure() {
    let navButton = document.querySelector('.nav-item[data-view="marketing"]');
    if (!navButton) {
      const nav = document.querySelector('.atlas-nav');
      const group = document.createElement('div');
      group.className = 'nav-group';
      group.dataset.marketingNavGroup = 'true';
      group.innerHTML = '<div class="nav-label">GROWTH</div><button class="nav-item" data-view="marketing"><i data-lucide="megaphone"></i>Marketing</button>';
      const insights = [...document.querySelectorAll('.nav-group')].find((candidate) => candidate.querySelector('.nav-label')?.textContent?.trim() === 'INSIGHTS');
      if (nav) nav.insertBefore(group, insights || null);
      navButton = group.querySelector('[data-view="marketing"]');
      navButton?.addEventListener('click', (event) => { event.preventDefault(); activateMarketing(); });
    }

    if (!host()) {
      const view = document.createElement('div');
      view.id = 'marketing-view';
      view.className = 'marketing-view';
      view.style.display = 'none';
      const parent = document.getElementById('team-view')?.parentElement || document.querySelector('.atlas-content main');
      parent?.appendChild(view);
    }
    window.lucide?.createIcons?.();
  }

  function handleNavigationCapture(event) {
    const button = event.target instanceof Element ? event.target.closest('.nav-item[data-view]') : null;
    if (!button || button.dataset.view === 'marketing') return;
    hideMarketing();
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest('[data-marketing-close-modal]')) {
      event.preventDefault();
      state.modal = null;
      state.selectedContentId = null;
      state.selectedRecommendationId = null;
      render();
      return;
    }

    const tab = target.closest('[data-marketing-tab]');
    if (tab) { state.activeTab = tab.dataset.marketingTab || 'overview'; state.modal = null; render(); return; }
    const jump = target.closest('[data-marketing-tab-jump]');
    if (jump) { state.activeTab = jump.dataset.marketingTabJump || 'overview'; render(); return; }
    if (target.closest('[data-marketing-refresh]')) { loadSnapshot(); return; }
    if (target.closest('[data-marketing-team-channel]')) { window.AtlasTeamMessages?.openChannel?.('marketing'); return; }

    if (target.closest('[data-marketing-new-content]')) {
      state.selectedContentId = null;
      state.selectedCalendarDate = null;
      state.modal = { mode: 'new-content' };
      render();
      return;
    }
    const newOnDate = target.closest('[data-marketing-new-on-date]');
    if (newOnDate) {
      state.selectedCalendarDate = newOnDate.dataset.marketingNewOnDate;
      state.selectedContentId = null;
      state.modal = { mode: 'new-content' };
      render();
      return;
    }
    if (target.closest('[data-marketing-new-campaign]')) { state.modal = { mode: 'new-campaign' }; render(); return; }

    const openContent = target.closest('[data-marketing-open-content]');
    if (openContent) {
      state.selectedContentId = openContent.dataset.marketingOpenContent;
      state.modal = { mode: 'content-detail' };
      render();
      return;
    }
    const editContent = target.closest('[data-marketing-edit-content]');
    if (editContent) {
      state.selectedContentId = editContent.dataset.marketingEditContent;
      state.modal = { mode: 'edit-content' };
      render();
      return;
    }

    const detailRecommendation = target.closest('[data-marketing-recommendation-detail]');
    if (detailRecommendation) {
      state.selectedRecommendationId = detailRecommendation.dataset.marketingRecommendationDetail;
      state.modal = { mode: 'recommendation-detail' };
      render();
      return;
    }
    const convertRecommendation = target.closest('[data-marketing-convert]');
    if (convertRecommendation) {
      state.selectedRecommendationId = convertRecommendation.dataset.marketingConvert;
      state.modal = { mode: 'convert-recommendation' };
      render();
      return;
    }
    const dismissRecommendation = target.closest('[data-marketing-dismiss]');
    if (dismissRecommendation) {
      const reason = window.prompt('Why should Atlas dismiss this recommendation for today?');
      if (!reason?.trim()) return;
      mutate('dismiss-recommendation', {
        recommendation_id: dismissRecommendation.dataset.marketingDismiss,
        occurrence_date: state.workspace?.venue_date || venueDate(),
        reason: reason.trim()
      }, 'Recommendation dismissed for today.');
      return;
    }

    const submitApproval = target.closest('[data-marketing-submit-approval]');
    if (submitApproval) {
      mutate('submit-approval', { content_id: submitApproval.dataset.marketingSubmitApproval, note: null }, 'Content sent for manager approval.');
      return;
    }
    const approval = target.closest('[data-marketing-approval]');
    if (approval) {
      state.selectedContentId = approval.dataset.marketingApproval;
      state.modal = { mode: 'approval' };
      render();
      return;
    }
    const decision = target.closest('[data-marketing-decide]');
    if (decision) {
      const note = host()?.querySelector('[data-marketing-approval-note]')?.value || '';
      if (decision.dataset.marketingDecide !== 'approved' && !note.trim()) {
        state.error = 'Add a manager note before requesting changes or rejecting.';
        render();
        return;
      }
      mutate('decide-approval', {
        content_id: state.selectedContentId,
        decision: decision.dataset.marketingDecide,
        note
      }, decision.dataset.marketingDecide === 'approved' ? 'Content approved.' : 'Approval decision recorded.');
      return;
    }
    const published = target.closest('[data-marketing-published]');
    if (published) {
      const note = window.prompt('Optional publication note or link:') || '';
      mutate('mark-published', {
        content_id: published.dataset.marketingPublished,
        published_at: new Date().toISOString(),
        external_publication_ids: note.trim() ? { manual_reference: note.trim() } : {},
        note: note.trim() || null
      }, 'Content marked published. No platform API was called.');
      return;
    }
    const complete = target.closest('[data-marketing-complete]');
    if (complete) {
      const note = window.prompt('Completion note (optional):') || '';
      mutate('mark-completed', { content_id: complete.dataset.marketingComplete, note: note.trim() || null }, 'Marketing task completed.');
      return;
    }

    const month = target.closest('[data-marketing-month]');
    if (month) { shiftMonth(Number(month.dataset.marketingMonth || 0)); state.workspace = null; loadSnapshot(); return; }
    if (target.closest('[data-marketing-today]')) { state.range = currentMonthRange(new Date()); state.workspace = null; loadSnapshot(); return; }

    const filter = target.closest('[data-marketing-filter]');
    if (filter) { state.contentFilter = filter.dataset.marketingFilter || 'active'; render(); }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !host()?.contains(form)) return;
    event.preventDefault();
    if (form.matches('[data-marketing-content-form]')) submitContentForm(form);
    else if (form.matches('[data-marketing-campaign-form]')) submitCampaignForm(form);
    else if (form.matches('[data-marketing-convert-form]')) submitConvertForm(form);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.modal) {
      state.modal = null;
      render();
    }
  }

  function observeViewChanges() {
    const parent = host()?.parentElement;
    if (!parent) return;
    state.viewObserver?.disconnect();
    state.viewObserver = new MutationObserver(() => {
      if (state.activating || !marketingVisible()) return;
      const anotherVisible = [...parent.children].some((child) => child !== host() && window.getComputedStyle(child).display !== 'none');
      if (anotherVisible) hideMarketing();
    });
    state.viewObserver.observe(parent, { subtree: false, attributes: true, attributeFilter: ['style','class','hidden'] });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStructure();
    observeViewChanges();
    document.addEventListener('click', handleNavigationCapture, true);
    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('keydown', handleKeydown);
  }

  window.AtlasMarketingWorkspace = {
    open: activateMarketing,
    refresh: () => loadSnapshot(),
    snapshot: () => state.workspace,
    openContent: (contentId) => {
      activateMarketing();
      state.selectedContentId = contentId;
      state.modal = { mode: 'content-detail' };
      render();
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
