(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 24000;
  const TABS = ['library', 'required', 'training', 'sources', 'activity'];

  const state = {
    snapshot: null,
    staff: null,
    onboardingTasks: [],
    activeTab: 'library',
    activeCategory: 'all',
    search: '',
    loading: false,
    refreshing: false,
    submitting: false,
    error: null,
    message: null,
    detail: null,
    detailLoading: false,
    editorOpen: false,
    sourceEditorOpen: false,
    sourceEditing: null,
    initialized: false,
    viewObserver: null,
    authTimer: null
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDateTime(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return 'Not published';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    }).format(date);
  }

  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return text;
  }

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
      if (!line.trim()) {
        closeList();
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        closeList();
        const level = Math.min(4, heading[1].length + 1);
        output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      if (/^---+$/.test(line.trim())) {
        closeList();
        output.push('<hr>');
        continue;
      }

      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) {
        if (listType !== 'ul') {
          closeList();
          listType = 'ul';
          output.push('<ul>');
        }
        output.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
        continue;
      }

      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        if (listType !== 'ol') {
          closeList();
          listType = 'ol';
          output.push('<ol>');
        }
        output.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      const quote = line.match(/^>\s?(.+)$/);
      if (quote) {
        closeList();
        output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }

      closeList();
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }

    closeList();
    return output.join('');
  }

  function host() {
    return document.getElementById('knowledge-view');
  }

  function apiEndpoint() {
    return String(cfg.KNOWLEDGE_API || '').trim();
  }

  function viewVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, options = {}) {
    const endpoint = apiEndpoint();
    if (!endpoint) throw new Error('Knowledge API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Knowledge.');

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
      if (!response.ok) throw new Error(payload.error || `Knowledge request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Knowledge took too long to respond. Check the connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function categories() {
    return Array.isArray(state.snapshot?.categories) ? state.snapshot.categories : [];
  }

  function articles() {
    return Array.isArray(state.snapshot?.articles) ? state.snapshot.articles : [];
  }

  function training() {
    return state.snapshot?.training || {};
  }

  function canManage() {
    return Boolean(state.staff?.can_manage_knowledge || state.snapshot?.permissions?.can_manage_articles);
  }

  function filteredArticles(mode = state.activeTab) {
    const query = state.search.trim().toLowerCase();
    return articles().filter((article) => {
      if (mode === 'required' && !article.required) return false;
      if (state.activeCategory !== 'all' && article.category_key !== state.activeCategory) return false;
      if (!query) return true;
      return [
        article.title,
        article.summary,
        article.category_name,
        article.article_type,
        ...(article.target_roles || [])
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
    });
  }

  function articleStatusMarkup(article) {
    if (article.required_due) return '<span class="knowledge-pill is-due"><i data-lucide="circle-alert"></i>Action required</span>';
    if (article.acknowledged) return '<span class="knowledge-pill is-complete"><i data-lucide="badge-check"></i>Acknowledged</span>';
    if (canManage() && article.draft_available) return '<span class="knowledge-pill is-draft"><i data-lucide="pencil-line"></i>Draft update</span>';
    if (article.status === 'published') return `<span class="knowledge-pill is-published"><i data-lucide="circle-check-big"></i>Version ${Number(article.published_version_number || article.display_version_number || 1)}</span>`;
    return `<span class="knowledge-pill is-neutral">${escapeHtml(humanize(article.status))}</span>`;
  }

  function articleCard(article) {
    const roles = (article.target_roles || []).includes('all')
      ? 'All active staff'
      : (article.target_roles || []).map(humanize).join(', ');
    return `<button type="button" class="knowledge-article-card ${article.required_due ? 'is-due' : ''}" data-knowledge-open="${escapeHtml(article.id)}">
      <span class="knowledge-article-icon"><i data-lucide="${escapeHtml(article.category_icon || 'book-open')}"></i></span>
      <span class="knowledge-article-main">
        <span class="knowledge-card-top"><small>${escapeHtml(article.category_name || 'Knowledge')}</small>${articleStatusMarkup(article)}</span>
        <strong>${escapeHtml(article.title)}</strong>
        <span class="knowledge-card-summary">${escapeHtml(article.summary || 'No summary has been added.')}</span>
        <span class="knowledge-card-meta">
          <span><i data-lucide="book-marked"></i>${escapeHtml(humanize(article.article_type))}</span>
          <span><i data-lucide="users-round"></i>${escapeHtml(roles)}</span>
          ${article.required ? '<span><i data-lucide="badge-alert"></i>Required</span>' : ''}
          ${article.live_route ? '<span><i data-lucide="radio-tower"></i>Live resource</span>' : ''}
        </span>
      </span>
      <i class="knowledge-card-arrow" data-lucide="chevron-right"></i>
    </button>`;
  }

  function emptyArticlesMarkup(mode) {
    return `<div class="knowledge-empty"><span><i data-lucide="book-dashed"></i></span><h3>No ${mode === 'required' ? 'required reading' : 'articles'} in this view</h3><p>Change the current category or search, or create a new article.</p></div>`;
  }

  function categoryFiltersMarkup() {
    return `<div class="knowledge-category-row">
      <button type="button" class="${state.activeCategory === 'all' ? 'is-active' : ''}" data-knowledge-category="all">All <span>${articles().length}</span></button>
      ${categories().map((category) => `<button type="button" class="${state.activeCategory === category.key ? 'is-active' : ''}" data-knowledge-category="${escapeHtml(category.key)}"><i data-lucide="${escapeHtml(category.icon)}"></i>${escapeHtml(category.name)} <span>${Number(category.article_count || 0)}</span></button>`).join('')}
    </div>`;
  }

  function libraryMarkup(mode = 'library') {
    const rows = filteredArticles(mode);
    return `<section class="knowledge-library">
      <div class="knowledge-controls">
        <label class="knowledge-search"><i data-lucide="search"></i><input type="search" data-knowledge-search placeholder="Search policies, SOPs, checklists and training…" value="${escapeHtml(state.search)}"></label>
        <span>${rows.length} article${rows.length === 1 ? '' : 's'}</span>
      </div>
      ${categoryFiltersMarkup()}
      ${mode === 'required' ? `<div class="knowledge-required-note"><i data-lucide="badge-alert"></i><div><strong>Required reading follows the published version.</strong><span>A new manager-published version becomes due again while earlier acknowledgements remain preserved.</span></div></div>` : ''}
      <div class="knowledge-article-list">${rows.length ? rows.map(articleCard).join('') : emptyArticlesMarkup(mode)}</div>
    </section>`;
  }

  function trainingTaskMarkup(task) {
    const linked = Array.isArray(task.linked_articles) ? task.linked_articles : [];
    return `<article class="knowledge-training-task ${task.completed ? 'is-complete' : ''}">
      <span class="knowledge-training-check"><i data-lucide="${task.completed ? 'circle-check-big' : 'circle'}"></i></span>
      <div><span>${escapeHtml(task.category || 'Training')}</span><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.description || '')}</p>
        ${linked.length ? `<div class="knowledge-training-links">${linked.map((article) => `<button type="button" data-knowledge-open="${escapeHtml(article.article_id)}"><i data-lucide="book-open-check"></i>${escapeHtml(article.title)}</button>`).join('')}</div>` : '<small>No Knowledge article linked yet.</small>'}
      </div>
      <span class="knowledge-training-state">${task.completed ? `Completed${task.completed_at ? ` · ${escapeHtml(formatDate(task.completed_at))}` : ''}` : task.required ? 'Required' : 'Optional'}</span>
    </article>`;
  }

  function teamTrainingMarkup() {
    if (!canManage()) return '';
    const team = Array.isArray(training().team) ? training().team : [];
    return `<section class="knowledge-team-training"><header><div><span>Manager view</span><h2>Team onboarding progress</h2></div></header>
      <div class="knowledge-team-progress">${team.map((person) => {
        const total = Number(person.required_total || 0);
        const completed = Number(person.required_completed || 0);
        const percent = total ? Math.round((completed / total) * 100) : 100;
        return `<article><div><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(humanize(person.role))}</span></div><div class="knowledge-progress-track"><span style="width:${percent}%"></span></div><em>${completed}/${total} · ${percent}%</em></article>`;
      }).join('') || '<div class="knowledge-empty-inline">No active staff profiles.</div>'}</div>
    </section>`;
  }

  function trainingMarkup() {
    const tasks = Array.isArray(training().tasks) ? training().tasks : [];
    const progress = training().own_progress || {};
    const total = Number(progress.required_total || 0);
    const completed = Number(progress.required_completed || 0);
    const percent = total ? Math.round((completed / total) * 100) : 100;
    return `<section class="knowledge-training">
      <div class="knowledge-training-hero"><div><span><i data-lucide="graduation-cap"></i>Your training path</span><h2>${completed} of ${total} required steps completed</h2><p>Knowledge articles support the existing Atlas onboarding tasks; managers still verify practical completion in Team Profiles.</p></div><strong>${percent}%</strong></div>
      <div class="knowledge-progress-track is-large"><span style="width:${percent}%"></span></div>
      <div class="knowledge-training-list">${tasks.length ? tasks.map(trainingTaskMarkup).join('') : '<div class="knowledge-empty-inline">No onboarding tasks are active.</div>'}</div>
      ${teamTrainingMarkup()}
    </section>`;
  }

  function sourcesMarkup() {
    const sources = articles().flatMap((article) => (article.source_count ? [{
      article_id: article.id,
      title: article.title,
      category: article.category_name,
      count: article.source_count
    }] : []));
    const settings = state.snapshot?.settings || {};
    return `<section class="knowledge-sources-page">
      <article class="knowledge-connection-card">
        <span class="knowledge-source-logo"><i data-lucide="cloud"></i></span>
        <div><span>External source boundary</span><h2>Google Drive</h2><p>Source documents were reviewed through an authorized private connection, but Atlas automatic synchronization is not enabled.</p></div>
        <span class="knowledge-connection-state is-${escapeHtml(settings.google_drive_connection_status || 'not_connected')}">${escapeHtml(humanize(settings.google_drive_connection_status || 'not_connected'))}</span>
      </article>
      <div class="knowledge-trust-panel"><i data-lucide="shield-check"></i><div><strong>Private source contract</strong><span>Drive URLs are manager-only · Source text is not committed to the public repository · Staff see only approved published Knowledge · Credentials are excluded</span></div></div>
      <section class="knowledge-source-index"><header><div><span>Source attribution</span><h2>Articles with supporting sources</h2></div><strong>${Number(state.snapshot?.summary?.source_references || 0)} references</strong></header>
        <div>${sources.map((row) => `<button type="button" data-knowledge-open="${escapeHtml(row.article_id)}"><span><i data-lucide="file-check-2"></i></span><div><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.category)} · ${Number(row.count)} source${Number(row.count) === 1 ? '' : 's'}</small></div><i data-lucide="chevron-right"></i></button>`).join('') || '<div class="knowledge-empty-inline">No sources have been attached.</div>'}</div>
      </section>
    </section>`;
  }

  function activityMarkup() {
    if (!canManage()) return '<div class="knowledge-empty"><span><i data-lucide="lock-keyhole"></i></span><h3>Manager activity only</h3><p>Article publishing and acknowledgement audit history is available to managers.</p></div>';
    const events = Array.isArray(state.snapshot?.events) ? state.snapshot.events : [];
    return `<section class="knowledge-activity"><header><div><span>Private audit trail</span><h2>Knowledge activity</h2></div><strong>${events.length} recent events</strong></header>
      <div>${events.map((event) => `<article><span><i data-lucide="${event.event_type === 'article_acknowledged' ? 'badge-check' : event.event_type === 'version_published' ? 'send' : event.event_type === 'article_read' ? 'book-open-check' : 'history'}"></i></span><div><strong>${escapeHtml(humanize(event.event_type))}</strong><small>${escapeHtml(event.actor_label || 'Atlas system')} · ${escapeHtml(formatDateTime(event.created_at))}</small></div></article>`).join('') || '<div class="knowledge-empty-inline">No activity recorded yet.</div>'}</div>
    </section>`;
  }

  function tabContentMarkup() {
    if (state.activeTab === 'required') return libraryMarkup('required');
    if (state.activeTab === 'training') return trainingMarkup();
    if (state.activeTab === 'sources') return sourcesMarkup();
    if (state.activeTab === 'activity') return activityMarkup();
    return libraryMarkup('library');
  }

  function tabsMarkup() {
    const definitions = [
      ['library', 'Library', 'library-big'],
      ['required', 'Required reading', 'badge-alert'],
      ['training', 'Training', 'graduation-cap'],
      ['sources', 'Sources', 'database-zap'],
      ['activity', 'Activity', 'history']
    ];
    return `<div class="knowledge-tabs" role="tablist">${definitions.map(([key, label, icon]) => `<button type="button" role="tab" aria-selected="${state.activeTab === key}" class="${state.activeTab === key ? 'is-active' : ''}" data-knowledge-tab="${key}"><i data-lucide="${icon}"></i>${label}${key === 'required' && Number(state.snapshot?.summary?.required_due || 0) > 0 ? `<span>${Number(state.snapshot.summary.required_due)}</span>` : ''}</button>`).join('')}</div>`;
  }

  function loadingMarkup() {
    return `<section class="knowledge-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading Knowledge</h2><p>Checking published guidance, required reading, onboarding links and source attribution.</p></section>`;
  }

  function errorMarkup() {
    return `<section class="knowledge-state"><span class="is-error"><i data-lucide="book-x"></i></span><h2>Knowledge unavailable</h2><p>${escapeHtml(state.error || 'The workspace could not load.')}</p><button type="button" data-knowledge-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function shellMarkup() {
    const summary = state.snapshot?.summary || {};
    const published = Number(summary.published_articles || 0);
    const due = Number(summary.required_due || 0);
    const acknowledged = Number(summary.acknowledged || 0);
    const ownProgress = training().own_progress || {};
    const trainingTotal = Number(ownProgress.required_total || 0);
    const trainingCompleted = Number(ownProgress.required_completed || 0);
    return `<section class="knowledge-shell">
      <header class="knowledge-hero">
        <div><span><i data-lucide="book-open-check"></i>Checkpoint G · Approved internal knowledge</span><h1>Knowledge</h1><p>Policies, procedures, checklists, live resources and role-based training in one version-controlled staff library.</p></div>
        <div class="knowledge-hero-actions"><button type="button" data-knowledge-refresh><i data-lucide="refresh-cw"></i>Refresh</button>${canManage() ? '<button type="button" class="is-primary" data-knowledge-new><i data-lucide="plus"></i>New article</button>' : ''}</div>
      </header>

      ${state.message ? `<div class="knowledge-feedback is-success"><i data-lucide="circle-check-big"></i>${escapeHtml(state.message)}</div>` : ''}
      ${state.error ? `<div class="knowledge-feedback is-error"><i data-lucide="triangle-alert"></i>${escapeHtml(state.error)}</div>` : ''}

      <div class="knowledge-summary-grid">
        <article><span><i data-lucide="library-big"></i>Published guidance</span><strong>${published}</strong><small>Role-appropriate current versions</small></article>
        <article class="${due ? 'is-attention' : ''}"><span><i data-lucide="badge-alert"></i>Required reading due</span><strong>${due}</strong><small>${acknowledged} versions acknowledged</small></article>
        <article><span><i data-lucide="graduation-cap"></i>Onboarding progress</span><strong>${trainingCompleted}/${trainingTotal}</strong><small>Existing Atlas training tasks</small></article>
        <article><span><i data-lucide="database-zap"></i>Source references</span><strong>${Number(summary.source_references || 0)}</strong><small>Drive and live Atlas attribution</small></article>
      </div>

      ${tabsMarkup()}
      <div class="knowledge-content">${tabContentMarkup()}</div>
      <footer class="knowledge-footer-contract"><i data-lucide="shield-check"></i><span>Active staff only · Drafts private to managers · Published versions immutable · Acknowledgements version-specific · Drive auto-sync off · No credentials in Knowledge</span></footer>
    </section>`;
  }

  function sourceCard(source) {
    return `<article class="knowledge-detail-source">
      <span><i data-lucide="${source.source_type === 'google_drive' ? 'cloud' : source.source_type === 'atlas_module' ? 'radio-tower' : 'file-check-2'}"></i></span>
      <div><small>${escapeHtml(humanize(source.source_type))}</small><strong>${escapeHtml(source.source_label)}</strong><p>${escapeHtml(source.source_version || source.source_reference || '')}</p><em>${escapeHtml(humanize(source.connection_status))}${source.visible_to_staff ? ' · staff visible' : ' · manager only'}</em></div>
      ${canManage() ? `<div class="knowledge-source-actions">${source.source_url ? `<button type="button" data-knowledge-source-open="${escapeHtml(source.id)}"><i data-lucide="external-link"></i></button>` : ''}<button type="button" data-knowledge-source-edit="${escapeHtml(source.id)}"><i data-lucide="pencil"></i></button><button type="button" data-knowledge-source-remove="${escapeHtml(source.id)}"><i data-lucide="trash-2"></i></button></div>` : ''}
    </article>`;
  }

  function detailMarkup() {
    if (state.detailLoading) return `<div class="knowledge-drawer-backdrop" data-knowledge-close-detail></div><aside class="knowledge-drawer"><div class="knowledge-drawer-state"><i data-lucide="loader-circle"></i><span>Loading article…</span></div></aside>`;
    if (!state.detail) return '';
    const article = state.detail.article || {};
    const version = state.detail.version || {};
    const sources = Array.isArray(state.detail.sources) ? state.detail.sources : [];
    const acknowledgements = Array.isArray(state.detail.acknowledgements) ? state.detail.acknowledgements : [];
    const history = Array.isArray(state.detail.version_history) ? state.detail.version_history : [];
    const roles = (article.target_roles || []).includes('all') ? 'All active staff' : (article.target_roles || []).map(humanize).join(', ');
    return `<div class="knowledge-drawer-backdrop" data-knowledge-close-detail></div>
      <aside class="knowledge-drawer" aria-labelledby="knowledge-detail-title">
        <header><div><span>${escapeHtml(article.category_name || 'Knowledge')} · ${escapeHtml(humanize(article.article_type))}</span><h2 id="knowledge-detail-title">${escapeHtml(version.title || article.article_key)}</h2></div><button type="button" data-knowledge-close-detail aria-label="Close"><i data-lucide="x"></i></button></header>
        <div class="knowledge-drawer-scroll">
          <div class="knowledge-detail-meta">
            <span class="knowledge-pill ${version.state === 'draft' ? 'is-draft' : 'is-published'}"><i data-lucide="${version.state === 'draft' ? 'pencil-line' : 'circle-check-big'}"></i>${escapeHtml(humanize(version.state))} · Version ${Number(version.version_number || 1)}</span>
            ${article.required ? '<span class="knowledge-pill is-due"><i data-lucide="badge-alert"></i>Required reading</span>' : ''}
            <span><i data-lucide="users-round"></i>${escapeHtml(roles)}</span>
            <span><i data-lucide="calendar-clock"></i>${escapeHtml(version.published_at ? `Published ${formatDate(version.published_at)}` : `Updated ${formatDate(version.updated_at)}`)}</span>
          </div>
          ${version.summary ? `<p class="knowledge-detail-summary">${escapeHtml(version.summary)}</p>` : ''}
          ${version.state === 'draft' ? '<div class="knowledge-draft-warning"><i data-lucide="eye-off"></i><span>This draft is private to managers. Staff continue seeing the previous published version.</span></div>' : ''}
          <article class="knowledge-markdown">${renderMarkdown(version.content)}</article>
          ${article.live_route ? `<button type="button" class="knowledge-live-resource" data-knowledge-live="${escapeHtml(article.live_route)}"><span><i data-lucide="radio-tower"></i><strong>Open live Atlas resource</strong><small>The current operational record stays in its owning module.</small></span><i data-lucide="arrow-up-right"></i></button>` : ''}
          <section class="knowledge-detail-section"><header><div><span>Attribution</span><h3>Sources</h3></div>${canManage() ? '<button type="button" data-knowledge-add-source><i data-lucide="plus"></i>Add source</button>' : ''}</header><div>${sources.length ? sources.map(sourceCard).join('') : '<div class="knowledge-empty-inline">No source attribution attached.</div>'}</div></section>
          ${canManage() ? `<section class="knowledge-detail-section"><header><div><span>Version control</span><h3>History</h3></div></header><div class="knowledge-version-list">${history.map((item) => `<article><span>v${Number(item.version_number)}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(humanize(item.state))} · ${escapeHtml(formatDateTime(item.published_at || item.updated_at))}</small>${item.change_note ? `<p>${escapeHtml(item.change_note)}</p>` : ''}</div></article>`).join('') || '<div class="knowledge-empty-inline">No earlier versions.</div>'}</div></section>` : ''}
          ${canManage() && version.state === 'published' ? `<section class="knowledge-detail-section"><header><div><span>Required-reading evidence</span><h3>Acknowledgements</h3></div><strong>${acknowledgements.length}</strong></header><div class="knowledge-ack-list">${acknowledgements.map((item) => `<article><i data-lucide="badge-check"></i><div><strong>${escapeHtml(item.user_label)}</strong><small>${escapeHtml(humanize(item.user_role))} · ${escapeHtml(formatDateTime(item.acknowledged_at))}</small></div></article>`).join('') || '<div class="knowledge-empty-inline">No acknowledgements for this version.</div>'}</div></section>` : ''}
        </div>
        <footer>
          <div>${version.state === 'published' && state.detail.read ? '<span><i data-lucide="book-open-check"></i>Read recorded</span>' : ''}</div>
          <div>
            ${state.detail.can_acknowledge ? '<button type="button" class="is-acknowledge" data-knowledge-acknowledge><i data-lucide="badge-check"></i>Acknowledge version</button>' : ''}
            ${canManage() ? '<button type="button" data-knowledge-edit><i data-lucide="pencil"></i>Edit draft</button>' : ''}
            ${canManage() && version.state === 'draft' ? '<button type="button" class="is-primary" data-knowledge-publish><i data-lucide="send"></i>Publish version</button>' : ''}
            ${canManage() && article.status !== 'retired' ? '<button type="button" class="is-danger" data-knowledge-retire><i data-lucide="archive-x"></i>Retire</button>' : ''}
          </div>
        </footer>
      </aside>`;
  }

  function roleCheckbox(role, selected) {
    return `<label><input type="checkbox" name="target_roles" value="${role}" ${selected ? 'checked' : ''}><span>${escapeHtml(role === 'all' ? 'All active staff' : humanize(role))}</span></label>`;
  }

  function editorMarkup() {
    if (!state.editorOpen) return '';
    const detail = state.detail;
    const article = detail?.article || {};
    const version = detail?.version || {};
    const selectedRoles = Array.isArray(article.target_roles) && article.target_roles.length ? article.target_roles : ['all'];
    const linkedTasks = new Set((detail?.task_links || []).map((item) => item.onboarding_task_id));
    return `<div class="knowledge-modal-backdrop" data-knowledge-close-editor></div>
      <aside class="knowledge-editor-modal" aria-labelledby="knowledge-editor-title">
        <header><div><span>Manager workspace</span><h2 id="knowledge-editor-title">${article.id ? 'Edit Knowledge draft' : 'New Knowledge article'}</h2></div><button type="button" data-knowledge-close-editor><i data-lucide="x"></i></button></header>
        <form data-knowledge-editor-form>
          <input type="hidden" name="article_id" value="${escapeHtml(article.id || '')}">
          <input type="hidden" name="article_key" value="${escapeHtml(article.article_key || '')}">
          <div class="knowledge-form-grid">
            <label class="is-wide"><span>Article title</span><input name="title" maxlength="220" required value="${escapeHtml(version.title || '')}" placeholder="Example: Guest complaint procedure"></label>
            <label><span>Category</span><select name="category_id" required>${categories().map((category) => `<option value="${escapeHtml(category.id)}" ${category.id === article.category_id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select></label>
            <label><span>Article type</span><select name="article_type">${['policy','sop','checklist','training','reference','live_resource'].map((type) => `<option value="${type}" ${type === article.article_type ? 'selected' : ''}>${escapeHtml(humanize(type))}</option>`).join('')}</select></label>
            <label class="is-wide"><span>Summary</span><textarea name="summary" rows="2" maxlength="3000" placeholder="What staff should learn from this article">${escapeHtml(version.summary || '')}</textarea></label>
            <label><span>Live Atlas route</span><select name="live_route"><option value="">No live module</option>${['operations','recipes','inventory','shifts','brain','team','marketing'].map((route) => `<option value="${route}" ${route === article.live_route ? 'selected' : ''}>${escapeHtml(humanize(route))}</option>`).join('')}</select></label>
            <label class="knowledge-check-field"><input type="checkbox" name="required" ${article.required ? 'checked' : ''}><span><strong>Required reading</strong><small>Assigned staff must acknowledge every published version.</small></span></label>
          </div>
          <fieldset class="knowledge-role-field"><legend>Visible to roles</legend><div>${['all','admin','manager','bartender','viewer'].map((role) => roleCheckbox(role, selectedRoles.includes(role))).join('')}</div></fieldset>
          <fieldset class="knowledge-task-field"><legend>Linked onboarding tasks</legend><div>${state.onboardingTasks.map((task) => `<label><input type="checkbox" name="task_ids" value="${escapeHtml(task.id)}" ${linkedTasks.has(task.id) ? 'checked' : ''}><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.category || 'Training')}</small></span></label>`).join('') || '<p>No active onboarding tasks.</p>'}</div></fieldset>
          <label class="knowledge-content-field"><span>Article content · Markdown supported</span><textarea name="content" rows="20" maxlength="250000" required placeholder="# Heading\n\nApproved guidance…">${escapeHtml(version.content || '')}</textarea></label>
          <label><span>Draft / version note</span><input name="change_note" maxlength="3000" value="${escapeHtml(version.change_note || '')}" placeholder="What changed in this version"></label>
          <footer><button type="button" data-knowledge-close-editor>Cancel</button><button type="submit" class="is-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>${state.submitting ? 'Saving…' : 'Save private draft'}</button></footer>
        </form>
      </aside>`;
  }

  function sourceEditorMarkup() {
    if (!state.sourceEditorOpen || !state.detail) return '';
    const source = state.sourceEditing || {};
    return `<div class="knowledge-modal-backdrop is-source" data-knowledge-close-source></div>
      <aside class="knowledge-source-modal" aria-labelledby="knowledge-source-title"><header><div><span>Manager-only attribution</span><h2 id="knowledge-source-title">${source.id ? 'Edit source' : 'Add source'}</h2></div><button type="button" data-knowledge-close-source><i data-lucide="x"></i></button></header>
        <form data-knowledge-source-form>
          <input type="hidden" name="source_id" value="${escapeHtml(source.id || '')}">
          <label><span>Source type</span><select name="source_type">${['google_drive','atlas_module','sprint3_import','manual','external'].map((type) => `<option value="${type}" ${type === (source.source_type || 'manual') ? 'selected' : ''}>${escapeHtml(humanize(type))}</option>`).join('')}</select></label>
          <label><span>Source label</span><input name="source_label" maxlength="220" required value="${escapeHtml(source.source_label || '')}"></label>
          <label><span>Reference / document ID</span><input name="source_reference" maxlength="1000" value="${escapeHtml(source.source_reference || '')}"></label>
          <label><span>Private source URL</span><input name="source_url" type="url" maxlength="3000" value="${escapeHtml(source.source_url || '')}"></label>
          <label><span>Source version</span><input name="source_version" maxlength="300" value="${escapeHtml(source.source_version || '')}"></label>
          <label><span>Connection status</span><select name="connection_status">${['manual_reference','not_connected','current','stale','error'].map((status) => `<option value="${status}" ${status === (source.connection_status || 'manual_reference') ? 'selected' : ''}>${escapeHtml(humanize(status))}</option>`).join('')}</select></label>
          <label class="knowledge-check-field"><input type="checkbox" name="visible_to_staff" ${source.visible_to_staff ? 'checked' : ''}><span><strong>Show source label to staff</strong><small>The URL remains manager-only.</small></span></label>
          <footer><button type="button" data-knowledge-close-source>Cancel</button><button type="submit" class="is-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>Save source</button></footer>
        </form>
      </aside>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.remove('placeholder-view');
    if (state.loading && !state.snapshot) element.innerHTML = loadingMarkup();
    else if (state.error && !state.snapshot) element.innerHTML = errorMarkup();
    else element.innerHTML = `${shellMarkup()}${detailMarkup()}${editorMarkup()}${sourceEditorMarkup()}`;
    window.lucide?.createIcons?.();
  }

  function applyPayload(payload) {
    if (payload.workspace) state.snapshot = payload.workspace;
    if (payload.staff) state.staff = payload.staff;
    if (Array.isArray(payload.onboarding_tasks)) state.onboardingTasks = payload.onboarding_tasks;
    if (payload.detail) state.detail = payload.detail;
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || !viewVisible()) return;
    state.loading = !state.snapshot;
    state.refreshing = Boolean(options.silent);
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot');
      applyPayload(payload);
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Knowledge could not load.';
    } finally {
      state.loading = false;
      state.refreshing = false;
      render();
    }
  }

  async function openArticle(articleId, options = {}) {
    if (!articleId || state.detailLoading) return;
    state.detailLoading = true;
    state.error = null;
    state.detail = null;
    render();
    try {
      const payload = await api('detail', {
        params: {
          article_id: articleId,
          prefer_draft: Boolean(options.preferDraft ?? canManage())
        }
      });
      state.detail = payload.article || null;
      state.staff = payload.staff || state.staff;
      if (state.detail?.version?.state === 'published' && !state.detail.read) {
        try {
          await api('mark-read', {
            method: 'POST',
            body: {
              article_id: state.detail.article.id,
              version_id: state.detail.version.id
            }
          });
          state.detail.read = true;
        } catch (error) {
          console.warn('Knowledge read state could not be recorded:', error?.message || error);
        }
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The Knowledge article could not load.';
      state.detail = null;
    } finally {
      state.detailLoading = false;
      render();
    }
  }

  async function acknowledgeCurrent() {
    if (!state.detail?.article?.id || !state.detail?.version?.id || state.submitting) return;
    state.submitting = true;
    state.error = null;
    render();
    try {
      const payload = await api('acknowledge', {
        method: 'POST',
        body: {
          article_id: state.detail.article.id,
          version_id: state.detail.version.id
        }
      });
      applyPayload(payload);
      state.message = 'This published version has been acknowledged.';
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Acknowledgement could not be saved.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function openNewEditor() {
    state.detail = null;
    state.editorOpen = true;
    state.sourceEditorOpen = false;
    render();
  }

  function openEditor() {
    if (!canManage()) return;
    state.editorOpen = true;
    state.sourceEditorOpen = false;
    render();
  }

  async function saveEditor(form) {
    if (state.submitting) return;
    const data = new FormData(form);
    const targetRoles = data.getAll('target_roles').map(String);
    const taskIds = data.getAll('task_ids').map(String);
    if (!targetRoles.length) {
      state.error = 'Choose at least one role.';
      render();
      return;
    }
    const normalizedRoles = targetRoles.includes('all') ? ['all'] : targetRoles.filter((role) => role !== 'all');

    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api('save-draft', {
        method: 'POST',
        body: {
          article_id: data.get('article_id') || null,
          article_key: data.get('article_key') || null,
          category_id: data.get('category_id'),
          article_type: data.get('article_type'),
          title: data.get('title'),
          summary: data.get('summary'),
          content: data.get('content'),
          required: data.get('required') === 'on',
          target_roles: normalizedRoles,
          live_route: data.get('live_route') || null,
          change_note: data.get('change_note') || null,
          task_ids: taskIds
        }
      });
      applyPayload(payload);
      state.editorOpen = false;
      state.message = 'Private Knowledge draft saved. Staff visibility has not changed.';
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Knowledge draft could not be saved.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function publishCurrent() {
    if (!state.detail?.article?.id || !canManage() || state.submitting) return;
    const note = window.prompt('Publication note for this version:', state.detail.version?.change_note || 'Approved manager update');
    if (note === null) return;
    if (!window.confirm('Publish this version to the assigned active staff? Existing acknowledgements remain attached to the previous version.')) return;
    state.submitting = true;
    state.error = null;
    render();
    try {
      const payload = await api('publish', {
        method: 'POST',
        body: { article_id: state.detail.article.id, change_note: note.trim() || null }
      });
      applyPayload(payload);
      state.message = 'Knowledge version published. Assigned staff now receive the new version.';
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Knowledge version could not be published.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function retireCurrent() {
    if (!state.detail?.article?.id || !canManage() || state.submitting) return;
    const reason = window.prompt('Reason for retiring this article:');
    if (!reason?.trim()) return;
    state.submitting = true;
    state.error = null;
    render();
    try {
      const payload = await api('retire', {
        method: 'POST',
        body: { article_id: state.detail.article.id, reason: reason.trim() }
      });
      applyPayload(payload);
      state.detail = null;
      state.message = 'Knowledge article retired. Its version history remains preserved.';
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Knowledge article could not be retired.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function openSourceEditor(sourceId = null) {
    if (!canManage() || !state.detail) return;
    const sources = Array.isArray(state.detail.sources) ? state.detail.sources : [];
    state.sourceEditing = sourceId ? sources.find((source) => source.id === sourceId) || null : null;
    state.sourceEditorOpen = true;
    render();
  }

  async function saveSource(form) {
    if (state.submitting || !state.detail?.article?.id) return;
    const data = new FormData(form);
    state.submitting = true;
    state.error = null;
    render();
    try {
      const payload = await api('save-source', {
        method: 'POST',
        body: {
          article_id: state.detail.article.id,
          source_id: data.get('source_id') || null,
          source_type: data.get('source_type'),
          source_label: data.get('source_label'),
          source_reference: data.get('source_reference') || null,
          source_url: data.get('source_url') || null,
          source_version: data.get('source_version') || null,
          connection_status: data.get('connection_status'),
          visible_to_staff: data.get('visible_to_staff') === 'on',
          metadata: {}
        }
      });
      applyPayload(payload);
      state.sourceEditorOpen = false;
      state.sourceEditing = null;
      state.message = 'Knowledge source attribution saved.';
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Knowledge source could not be saved.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function removeSource(sourceId) {
    if (!sourceId || !canManage() || state.submitting) return;
    if (!window.confirm('Remove this source reference? The article and version history will remain.')) return;
    state.submitting = true;
    state.error = null;
    try {
      const payload = await api('remove-source', {
        method: 'POST',
        body: { source_id: sourceId, article_id: state.detail?.article?.id || null }
      });
      applyPayload(payload);
      state.message = 'Source reference removed.';
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Source reference could not be removed.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function navigateView(view) {
    const button = document.querySelector(`.nav-item[data-view="${CSS.escape(view)}"]`);
    if (button) button.click();
    else if (typeof window.setActiveView === 'function') window.setActiveView(view);
  }

  function openLiveRoute(route) {
    const map = {
      brain: 'brain',
      operations: 'operations',
      recipes: 'recipes',
      inventory: 'inventory',
      shifts: 'shifts',
      team: 'team',
      marketing: 'marketing'
    };
    navigateView(map[route] || route || 'knowledge');
  }

  function sourceById(id) {
    const sources = Array.isArray(state.detail?.sources) ? state.detail.sources : [];
    return sources.find((source) => source.id === id) || null;
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const tab = target.closest('[data-knowledge-tab]');
    if (tab && host()?.contains(tab)) {
      event.preventDefault();
      const next = tab.dataset.knowledgeTab;
      if (TABS.includes(next)) state.activeTab = next;
      state.error = null;
      render();
      return;
    }

    const category = target.closest('[data-knowledge-category]');
    if (category && host()?.contains(category)) {
      event.preventDefault();
      state.activeCategory = category.dataset.knowledgeCategory || 'all';
      render();
      return;
    }

    const open = target.closest('[data-knowledge-open]');
    if (open && host()?.contains(open)) {
      event.preventDefault();
      openArticle(open.dataset.knowledgeOpen);
      return;
    }

    if (target.closest('[data-knowledge-refresh]') && host()?.contains(target)) {
      event.preventDefault();
      loadSnapshot();
      return;
    }

    if (target.closest('[data-knowledge-new]') && host()?.contains(target)) {
      event.preventDefault();
      openNewEditor();
      return;
    }

    if (target.closest('[data-knowledge-close-detail]')) {
      event.preventDefault();
      state.detail = null;
      state.detailLoading = false;
      state.editorOpen = false;
      state.sourceEditorOpen = false;
      render();
      return;
    }

    if (target.closest('[data-knowledge-edit]')) {
      event.preventDefault();
      openEditor();
      return;
    }

    if (target.closest('[data-knowledge-publish]')) {
      event.preventDefault();
      publishCurrent();
      return;
    }

    if (target.closest('[data-knowledge-retire]')) {
      event.preventDefault();
      retireCurrent();
      return;
    }

    if (target.closest('[data-knowledge-acknowledge]')) {
      event.preventDefault();
      acknowledgeCurrent();
      return;
    }

    const live = target.closest('[data-knowledge-live]');
    if (live) {
      event.preventDefault();
      openLiveRoute(live.dataset.knowledgeLive);
      return;
    }

    if (target.closest('[data-knowledge-close-editor]')) {
      event.preventDefault();
      state.editorOpen = false;
      render();
      return;
    }

    if (target.closest('[data-knowledge-add-source]')) {
      event.preventDefault();
      openSourceEditor();
      return;
    }

    const sourceEdit = target.closest('[data-knowledge-source-edit]');
    if (sourceEdit) {
      event.preventDefault();
      openSourceEditor(sourceEdit.dataset.knowledgeSourceEdit);
      return;
    }

    const sourceRemove = target.closest('[data-knowledge-source-remove]');
    if (sourceRemove) {
      event.preventDefault();
      removeSource(sourceRemove.dataset.knowledgeSourceRemove);
      return;
    }

    const sourceOpen = target.closest('[data-knowledge-source-open]');
    if (sourceOpen) {
      event.preventDefault();
      const source = sourceById(sourceOpen.dataset.knowledgeSourceOpen);
      if (source?.source_url) window.open(source.source_url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (target.closest('[data-knowledge-close-source]')) {
      event.preventDefault();
      state.sourceEditorOpen = false;
      state.sourceEditing = null;
      render();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !host()?.contains(target)) return;
    if (target.matches('[data-knowledge-search]')) {
      state.search = target.value;
      render();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('input[name="target_roles"]')) return;
    const form = target.closest('[data-knowledge-editor-form]');
    if (!form) return;
    if (target.value === 'all' && target.checked) {
      form.querySelectorAll('input[name="target_roles"]:not([value="all"])').forEach((input) => { input.checked = false; });
    } else if (target.checked) {
      const all = form.querySelector('input[name="target_roles"][value="all"]');
      if (all) all.checked = false;
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches('[data-knowledge-editor-form]')) {
      event.preventDefault();
      saveEditor(form);
      return;
    }
    if (form.matches('[data-knowledge-source-form]')) {
      event.preventDefault();
      saveSource(form);
    }
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (state.sourceEditorOpen) {
      state.sourceEditorOpen = false;
      state.sourceEditing = null;
      render();
      return;
    }
    if (state.editorOpen) {
      state.editorOpen = false;
      render();
      return;
    }
    if (state.detail || state.detailLoading) {
      state.detail = null;
      state.detailLoading = false;
      render();
    }
  }

  function handleVisibility() {
    if (viewVisible() && !state.snapshot && !state.loading) loadSnapshot();
  }

  function init() {
    if (state.initialized || !host()) return false;
    state.initialized = true;
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('submit', handleSubmit, true);
    document.addEventListener('keydown', handleKeydown, true);

    state.viewObserver = new MutationObserver(handleVisibility);
    state.viewObserver.observe(host(), { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    const app = document.getElementById('app-screen');
    if (app) state.viewObserver.observe(app, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

    window.addEventListener('focus', () => {
      if (viewVisible() && state.snapshot) loadSnapshot({ silent: true });
    });
    window.addEventListener('online', () => {
      if (viewVisible()) loadSnapshot();
    });
    window.addEventListener('pagehide', () => {
      state.viewObserver?.disconnect();
      if (state.authTimer) window.clearInterval(state.authTimer);
    }, { once: true });

    handleVisibility();
    return true;
  }

  window.AtlasKnowledge = {
    open: () => navigateView('knowledge'),
    openArticle: (articleId) => {
      navigateView('knowledge');
      window.setTimeout(() => openArticle(articleId), 140);
    },
    refresh: () => loadSnapshot(),
    snapshot: () => state.snapshot,
    detail: () => state.detail
  };

  if (!init()) {
    state.authTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.authTimer);
      state.authTimer = null;
    }, 120);
    window.setTimeout(() => {
      if (!state.authTimer) return;
      window.clearInterval(state.authTimer);
      state.authTimer = null;
    }, 12000);
  }
})();
