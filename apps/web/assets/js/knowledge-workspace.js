// Knowledge — #knowledge, #knowledge/<articleId>, #knowledge/required,
// #knowledge/training (+ Sources and Activity for managers)
// (docs/design/Atlas_Experience_Redesign.md §7.11, §8.6).
//
// Search-first library (server full-text search through
// atlas-knowledge?action=search, which searches only what the signed-in person
// may read), a reading page for each article, required reading with
// version-specific acknowledgements, training, and manager authoring (private
// drafts, immutable published versions, sources). Staff never receive drafts or
// source URLs: the server filters them, and this page never asks for a draft
// unless the person manages Knowledge.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 24000;
  const SEARCH_DEBOUNCE_MS = 250;
  const TABS = [
    { key: 'library', label: 'Library' },
    { key: 'required', label: 'Required reading' },
    { key: 'training', label: 'Training' },
    { key: 'sources', label: 'Sources', manager: true },
    { key: 'activity', label: 'Activity', manager: true }
  ];
  const TYPE_LABELS = { policy: 'Policy', sop: 'Procedure', checklist: 'Checklist', training: 'Training', reference: 'Reference', live_resource: 'Live resource' };
  const EVENT_LABELS = { version_published: 'Version published', article_acknowledged: 'Read and confirmed', article_read: 'Opened', draft_saved: 'Draft saved', article_retired: 'Article retired', source_saved: 'Source saved', source_removed: 'Source removed', task_links_updated: 'Training links updated' };
  const LIVE_ROUTES = { operations: '#operations', recipes: '#recipes', inventory: '#inventory', shifts: '#shifts', brain: '#home', team: '#team', marketing: '#marketing' };
  const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener() {} };
  const railQuery = window.matchMedia ? window.matchMedia('(min-width: 1024px)') : { matches: true, addEventListener() {} };

  const state = {
    snapshot: null,
    staff: null,
    onboardingTasks: [],
    tab: 'library',
    category: 'all',
    search: '',
    searchResults: null,
    searchStatus: 'idle',
    searchSerial: 0,
    searchTimer: null,
    loading: false,
    error: null,
    failedAt: 0,
    submitting: false,
    articleId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    checks: new Map(),
    visible: false,
    initialized: false
  };

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
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

  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return text;
  }

  // Markdown subset. Raw HTML is escaped first; only the formatting below is
  // added. "- [ ] step" lines become check rows (ticked on this device only).
  function renderMarkdown(value, articleKey = '') {
    const lines = String(value || '').replace(/\r/g, '').split('\n');
    const output = [];
    let listType = null;
    let checkIndex = 0;
    const closeList = () => {
      if (!listType) return;
      output.push(listType === 'checks' ? '</ul>' : `</${listType}>`);
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
      const check = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/);
      if (check) {
        if (listType !== 'checks') { closeList(); listType = 'checks'; output.push('<ul class="kn-checks">'); }
        const key = `${articleKey}:${checkIndex}`;
        checkIndex += 1;
        const checked = state.checks.has(key) ? state.checks.get(key) : check[1].toLowerCase() === 'x';
        const id = `kn-check-${checkIndex}`;
        output.push(`<li><label class="atlas-check-row kn-check" for="${id}"><input type="checkbox" class="atlas-check" id="${id}" data-kn-check="${escapeHtml(key)}" ${checked ? 'checked' : ''}><span>${inlineMarkdown(check[2])}</span></label></li>`);
        continue;
      }
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

  function readingMinutes(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return words ? Math.max(1, Math.round(words / 200)) : null;
  }

  // Search snippets mark matches with **…** (ts_headline); show them as <mark>.
  function snippetMarkup(value) {
    return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>');
  }

  function host() {
    return document.getElementById('knowledge-view');
  }

  function role() {
    return state.staff?.role || window.AtlasShell?.profile?.()?.role || window.atlasCurrentProfile?.role || null;
  }

  function canManage() {
    if (state.staff) return Boolean(state.staff.can_manage_knowledge);
    if (state.snapshot?.permissions) return Boolean(state.snapshot.permissions.can_manage_articles);
    return ['admin', 'manager'].includes(role());
  }

  // ---------- API ----------

  class KnowledgeError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  // Fixed copy only (AtlasApi, atlas-api.js): server text is never shown,
  // whatever its length or wording.
  const API_MESSAGES = {
    auth: 'Your session has ended. Sign in again to read Knowledge.',
    forbidden: 'Your role can’t open that in Knowledge.',
    not_found: 'This article isn’t available. It may have been retired or isn’t shared with your role.',
    conflict: 'This article changed while you were editing. Refresh and try again.',
    invalid: 'Knowledge couldn’t accept that. Check the details and try again.',
    unavailable: 'Knowledge is temporarily unavailable.',
    failed: 'Knowledge is temporarily unavailable.'
  };

  function friendlyError(status, message) {
    const api = window.AtlasApi;
    return api ? api.friendlyMessage(api.kindFor(status, null), null, API_MESSAGES) : 'Knowledge is temporarily unavailable.';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, options = {}) {
    const endpoint = String(cfg.KNOWLEDGE_API || '').trim();
    if (!endpoint) throw new KnowledgeError('Knowledge is not set up for this Atlas yet.', 0);
    const session = await activeSession();
    if (!session?.access_token) throw new KnowledgeError('Sign in again to read Knowledge.', 401);
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
        headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new KnowledgeError(friendlyError(response.status, payload.error), response.status);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new KnowledgeError('Knowledge took too long to answer. Check the connection and try again.', 0);
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('Knowledge couldn’t be reached. Check the connection and try again.', 0);
    } finally {
      window.clearTimeout(timer);
    }
  }

  // ---------- data ----------

  function categories() {
    return Array.isArray(state.snapshot?.categories) ? state.snapshot.categories : [];
  }

  // Staff only ever see published articles (the server sends nothing else);
  // this keeps it so if a payload were ever wider than expected.
  function articles() {
    const list = Array.isArray(state.snapshot?.articles) ? state.snapshot.articles : [];
    return canManage() ? list : list.filter((article) => article.status === 'published');
  }

  function training() {
    return state.snapshot?.training || {};
  }

  function dueArticles() {
    return articles().filter((article) => article.required_due);
  }

  function articleById(id) {
    return articles().find((article) => article.id === id) || null;
  }

  function filtered() {
    const query = state.search.trim().toLowerCase();
    return articles().filter((article) => {
      if (state.category !== 'all' && article.category_key !== state.category) return false;
      if (!query) return true;
      return [article.title, article.summary, article.category_name, TYPE_LABELS[article.article_type]].filter(Boolean).some((text) => String(text).toLowerCase().includes(query));
    });
  }

  function statusPill(article) {
    if (article.required_due) return pill('Required · not read', 'warning');
    if (canManage() && article.status === 'draft') return pill('Draft', 'neutral');
    if (canManage() && article.draft_available) return pill('Draft update', 'neutral');
    if (article.status === 'retired') return pill('Retired');
    if (article.required && article.acknowledged) return pill('Read', 'positive');
    if (article.required) return pill('Required', 'info');
    return '';
  }

  function articleMeta(article) {
    const updated = article.published_at || article.updated_at;
    return [article.category_name, TYPE_LABELS[article.article_type], updated ? `Updated ${formatDate(updated)}` : null].filter(Boolean).join(' · ');
  }

  // ---------- layers ----------

  function openLayer({ id, panel, onClose, initialFocus }) {
    document.getElementById(id)?.remove();
    const root = document.createElement('div');
    root.id = id;
    root.className = 'atlas-modal kn-layer';
    root.setAttribute('data-atlas-modal', '');
    root.hidden = true;
    root.innerHTML = panel;
    document.body.appendChild(root);
    paintIcons();
    if (window.AtlasModal) {
      window.AtlasModal.register(root, { initialFocus, onClose: (reason) => { root.remove(); onClose?.(reason); } });
      window.AtlasModal.open(root);
    } else {
      root.hidden = false;
      root.classList.add('is-open');
    }
    return root;
  }

  function closeLayer(root) {
    if (!root) return;
    if (window.AtlasModal?.isOpen?.(root)) window.AtlasModal.close(root);
    else root.remove();
  }

  function confirmDialog({ title, body, confirmLabel, danger = false, field = null }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const root = openLayer({
        id: 'kn-confirm',
        panel: `<section class="atlas-dialog${field ? ' atlas-dialog--form' : ''}" data-modal-panel aria-labelledby="kn-confirm-title">
          <h2 class="atlas-dialog__title" id="kn-confirm-title">${escapeHtml(title)}</h2>
          <form class="atlas-dialog__body" data-kn-confirm-form novalidate>
            <p>${escapeHtml(body)}</p>
            ${field ? `<div class="atlas-field"><label for="kn-confirm-input">${escapeHtml(field.label)}${field.required ? '' : ' <span class="optional">Optional</span>'}</label><textarea class="atlas-input atlas-textarea" id="kn-confirm-input" rows="3" maxlength="3000">${escapeHtml(field.value || '')}</textarea><p class="error" data-kn-confirm-error hidden>${escapeHtml(field.label)} is required.</p></div>` : ''}
            <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn ${danger ? 'atlas-btn--danger-solid' : 'atlas-btn--primary'}">${escapeHtml(confirmLabel)}</button></div>
          </form>
        </section>`,
        onClose: () => finish(null)
      });
      root.querySelector('[data-kn-confirm-form]')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = root.querySelector('#kn-confirm-input');
        const value = input ? input.value.trim() : '';
        if (field?.required && !value) {
          input.setAttribute('aria-invalid', 'true');
          root.querySelector('[data-kn-confirm-error]').hidden = false;
          input.focus();
          return;
        }
        finish({ value });
        closeLayer(root);
      });
    });
  }

  // ---------- list pages ----------

  function headerMarkup() {
    const count = articles().filter((article) => article.status === 'published').length;
    const due = dueArticles().length;
    const sub = state.snapshot
      ? [`${count} ${count === 1 ? 'article' : 'articles'}`, due ? `${due} required for you` : null].filter(Boolean).join(' · ')
      : 'Procedures, policies and training for the team';
    return `<header class="page-head"><div class="page-head__text"><h1 class="page-head__title">Knowledge</h1><p class="page-head__sub">${escapeHtml(sub)}</p></div>${canManage() ? `<div class="page-head__actions"><button type="button" class="atlas-btn atlas-btn--primary" data-knowledge-new>${icon('plus')}New article</button></div>` : ''}</header>`;
  }

  function tabsMarkup() {
    const due = dueArticles().length;
    const tabs = TABS.filter((tab) => !tab.manager || canManage());
    return `<nav class="atlas-tabs kn-tabs" aria-label="Knowledge sections">${tabs.map((tab) => `<a href="${tab.key === 'library' ? '#knowledge' : `#knowledge/${tab.key}`}" data-knowledge-tab="${tab.key}" ${state.tab === tab.key ? 'aria-current="page"' : ''}>${escapeHtml(tab.label)}${tab.key === 'required' && due ? ` <span class="count">${due}</span>` : ''}</a>`).join('')}</nav>`;
  }

  function alertMarkup() {
    if (!state.error) return '';
    return `<div class="atlas-alert atlas-alert--danger kn-alert" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Knowledge couldn’t be ${state.snapshot ? 'updated' : 'loaded'}.</p><p class="atlas-alert__body">${escapeHtml(state.error)} ${state.snapshot ? 'You’re seeing what loaded last.' : 'Nothing has changed.'}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-knowledge-refresh>Try again</button></div></div>`;
  }

  function articleRow(article, options = {}) {
    return `<li class="atlas-row atlas-row--link kn-row"><a class="kn-row__link" href="#knowledge/${encodeURIComponent(article.id)}" data-knowledge-open="${escapeHtml(article.id)}">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(article.title)}</p><p class="atlas-row__meta">${options.snippet ? snippetMarkup(options.snippet) : escapeHtml(options.meta || articleMeta(article))}</p></div>
      <div class="atlas-row__end">${statusPill(article)}<span class="atlas-row__chevron">${icon('chevron-right')}</span></div>
    </a></li>`;
  }

  function categoryRailMarkup() {
    const counts = new Map();
    articles().forEach((article) => counts.set(article.category_key, (counts.get(article.category_key) || 0) + 1));
    return `<nav class="kn-rail" aria-label="Categories"><ul>
      <li><button type="button" class="kn-rail__item" data-knowledge-category="all" aria-pressed="${state.category === 'all'}"><span>All articles</span><span class="num">${articles().length}</span></button></li>
      ${categories().map((category) => `<li><button type="button" class="kn-rail__item" data-knowledge-category="${escapeHtml(category.key)}" aria-pressed="${state.category === category.key}"><span>${escapeHtml(category.name)}</span><span class="num">${counts.get(category.key) || 0}</span></button></li>`).join('')}
    </ul></nav>`;
  }

  function categorySelectMarkup() {
    return `<label class="sr-only" for="kn-category">Category</label><select class="atlas-select kn-category-select" id="kn-category" data-knowledge-category-select><option value="all">All categories</option>${categories().map((category) => `<option value="${escapeHtml(category.key)}" ${state.category === category.key ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select>`;
  }

  function searchResultsMarkup() {
    const query = state.search.trim();
    if (state.searchStatus === 'loading' && !state.searchResults) {
      return `<div class="kn-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(3)}<span class="sr-only">Searching</span></div>`;
    }
    // Server results when available; otherwise the titles and summaries on this page.
    const rows = state.searchResults
      ? state.searchResults.filter((row) => state.category === 'all' || row.category_key === state.category).map((row) => ({ article: articleById(row.article_id) || { id: row.article_id, title: row.title, category_name: row.category, required: row.required, status: row.status }, snippet: row.snippet }))
      : filtered().map((article) => ({ article }));
    const note = state.searchStatus === 'error' ? '<p class="kn-note">Full-text search is unavailable right now, so only titles and summaries are searched.</p>' : '';
    if (!rows.length) {
      return `${note}<div class="atlas-empty"><div class="atlas-empty__icon">${icon('search')}</div><h3 class="atlas-empty__title">No articles match “${escapeHtml(query)}”</h3><p class="atlas-empty__text">Try other words, or ask Atlas.</p><div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-knowledge-ask-search>${icon('sparkles')}Ask Atlas</button></div></div>`;
    }
    return `${note}<p class="kn-count" aria-live="polite">${rows.length} ${rows.length === 1 ? 'result' : 'results'}</p><ul class="atlas-list kn-list">${rows.map(({ article, snippet }) => articleRow(article, { snippet })).join('')}</ul>`;
  }

  function libraryListMarkup() {
    if (state.search.trim().length >= 2) return searchResultsMarkup();
    const rows = filtered();
    const due = state.category === 'all' ? dueArticles() : [];
    if (!articles().length) {
      return `<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon">${icon('book-open')}</div><h3 class="atlas-empty__title">${canManage() ? 'No articles yet' : 'Nothing here yet'}</h3><p class="atlas-empty__text">${canManage() ? 'Write the procedures and policies your team needs, and mark the ones everyone must read.' : 'Your manager will add procedures and training.'}</p>${canManage() ? `<div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--primary" data-knowledge-new>${icon('plus')}New article</button></div>` : ''}</div>`;
    }
    const sorted = rows.slice().sort((a, b) => String(b.published_at || b.updated_at || '').localeCompare(String(a.published_at || a.updated_at || '')));
    return `${due.length ? `<section class="kn-section" aria-labelledby="kn-due-title"><h2 class="kn-section__title" id="kn-due-title">Required for you</h2><ul class="atlas-list kn-list">${due.map((article) => articleRow(article)).join('')}</ul></section>` : ''}
      <section class="kn-section" aria-labelledby="kn-all-title"><h2 class="kn-section__title" id="kn-all-title">${state.category === 'all' ? 'Recently updated' : escapeHtml(categories().find((category) => category.key === state.category)?.name || 'Articles')}</h2>
      ${sorted.length ? `<ul class="atlas-list kn-list">${sorted.map((article) => articleRow(article)).join('')}</ul>` : '<p class="kn-note">No articles in this category yet.</p>'}</section>`;
  }

  function libraryMarkup() {
    const rail = railQuery.matches;
    return `<div class="kn-library${rail ? ' has-rail' : ''}">
      ${rail ? categoryRailMarkup() : ''}
      <div class="kn-library__main">
        <div class="kn-searchbar"><label class="atlas-search kn-search">${icon('search')}<input class="atlas-input" type="search" placeholder="Search procedures, recipes, policies" aria-label="Search Knowledge" data-knowledge-search value="${escapeHtml(state.search)}" autocomplete="off"><button type="button" class="atlas-search__clear" data-knowledge-clear aria-label="Clear search">${icon('x')}</button></label>${rail ? '' : categorySelectMarkup()}</div>
        <div class="kn-results" data-kn-results>${libraryListMarkup()}</div>
      </div>
    </div>`;
  }

  function requiredMarkup() {
    const required = articles().filter((article) => article.required && article.status === 'published');
    if (!required.length) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('book-check')}</div><h3 class="atlas-empty__title">No required reading</h3><p class="atlas-empty__text">${canManage() ? 'Mark an article as required to ask the team to read and confirm it.' : 'When your manager asks you to read something, it appears here.'}</p></div>`;
    }
    const due = required.filter((article) => article.required_due);
    const done = required.filter((article) => !article.required_due);
    return `<p class="kn-note">Required reading follows the published version: when a manager publishes a new version, it’s due again. Earlier confirmations are kept.</p>
      ${due.length ? `<section class="kn-section"><h2 class="kn-section__title">To read</h2><ul class="atlas-list kn-list">${due.map((article) => articleRow(article)).join('')}</ul></section>` : `<p class="kn-done">${icon('circle-check')}You’re up to date.</p>`}
      ${done.length ? `<section class="kn-section"><h2 class="kn-section__title">${canManage() ? 'Required articles' : 'Read'}</h2><ul class="atlas-list kn-list">${done.map((article) => articleRow(article)).join('')}</ul></section>` : ''}`;
  }

  function trainingMarkup() {
    const tasks = Array.isArray(training().tasks) ? training().tasks : [];
    const progress = training().own_progress || {};
    const total = Number(progress.required_total || 0);
    const completed = Number(progress.required_completed || 0);
    const team = Array.isArray(training().team) ? training().team : [];
    return `<section class="kn-section kn-training">
        <h2 class="kn-section__title">Your training</h2>
        <p class="kn-note">${total ? `${completed} of ${total} required steps done. Your manager confirms each step in Team.` : 'No training steps are set up yet.'}</p>
        ${total ? `<div class="atlas-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}" aria-label="Training progress"><i style="width:${Math.round((completed / total) * 100)}%"></i></div>` : ''}
        ${tasks.length ? `<ul class="atlas-list kn-list">${tasks.map((task) => {
          const linked = Array.isArray(task.linked_articles) ? task.linked_articles : [];
          return `<li class="atlas-row kn-task${task.completed ? ' is-done' : ''}"><span class="atlas-row__icon${task.completed ? ' atlas-row__icon--positive' : ''}">${icon(task.completed ? 'circle-check' : 'circle')}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(task.title)}</p><p class="atlas-row__meta">${escapeHtml([task.required ? 'Required' : 'Optional', task.completed ? `Done${task.completed_at ? ` ${formatDate(task.completed_at)}` : ''}` : null, task.description].filter(Boolean).join(' · '))}</p>${linked.length ? `<p class="kn-task__links">${linked.map((article) => `<a href="#knowledge/${encodeURIComponent(article.article_id)}" data-knowledge-open="${escapeHtml(article.article_id)}">${icon('book-open')}${escapeHtml(article.title)}</a>`).join('')}</p>` : ''}</div>${canManage() && !linked.length ? `<div class="atlas-row__end"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-knowledge-link-task="${escapeHtml(task.id)}">${icon('plus')}Write an article</button></div>` : ''}</li>`;
        }).join('')}</ul>` : ''}
      </section>
      ${canManage() && team.length ? `<section class="kn-section"><h2 class="kn-section__title">Team onboarding progress</h2><div class="atlas-table-wrap"><table class="atlas-table atlas-table--compact kn-table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col" class="is-num">Required steps</th></tr></thead><tbody>${team.map((person) => `<tr><td><span class="cell-primary">${escapeHtml(person.name)}</span></td><td>${escapeHtml(humanize(person.role))}</td><td class="is-num">${Number(person.required_completed || 0)} of ${Number(person.required_total || 0)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
  }

  function sourcesMarkup() {
    const rows = articles().filter((article) => Number(article.source_count || 0) > 0);
    const status = state.snapshot?.settings?.google_drive_connection_status || 'not_connected';
    return `<section class="kn-section"><h2 class="kn-section__title">Google Drive</h2>
        <div class="atlas-alert atlas-alert--info">${icon('info')}<div class="atlas-alert__content"><p class="atlas-alert__title">${status === 'connected' ? 'Connected' : 'Not connected'}</p><p class="atlas-alert__body">Atlas doesn’t sync Drive documents automatically. Source links are recorded by hand, and the links stay visible to managers only.</p></div></div>
      </section>
      <section class="kn-section"><h2 class="kn-section__title">Articles with sources</h2>${rows.length ? `<ul class="atlas-list kn-list">${rows.map((article) => articleRow(article, { meta: `${article.category_name || 'Knowledge'} · ${Number(article.source_count)} ${Number(article.source_count) === 1 ? 'source' : 'sources'}` })).join('')}</ul>` : '<p class="kn-note">No sources have been added to articles yet.</p>'}</section>`;
  }

  function activityMarkup() {
    const events = Array.isArray(state.snapshot?.events) ? state.snapshot.events : [];
    if (!events.length) return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('history')}</div><h3 class="atlas-empty__title">No Knowledge activity yet</h3><p class="atlas-empty__text">Publishing, confirmations and source changes appear here.</p></div>`;
    return `<section class="kn-section"><h2 class="kn-section__title">Knowledge activity</h2><ul class="atlas-list kn-list">${events.map((event) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon">${icon(event.event_type === 'article_acknowledged' ? 'circle-check' : event.event_type === 'version_published' ? 'send' : 'history')}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(EVENT_LABELS[event.event_type] || humanize(event.event_type))}${event.article_title ? ` · ${escapeHtml(event.article_title)}` : ''}</p><p class="atlas-row__meta">${escapeHtml(event.actor_label || 'Atlas')} · ${escapeHtml(vc()?.formatRelative?.(event.created_at) || formatDateTime(event.created_at))}</p></div></li>`).join('')}</ul></section>`;
  }

  function permissionMarkup() {
    return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('lock')}</div><h3 class="atlas-empty__title">This part of Knowledge is for managers</h3><p class="atlas-empty__text">You can read the library, your required reading and your training.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#knowledge">Go to the library</a></div></div>`;
  }

  function listContentMarkup() {
    if (!state.snapshot) {
      if (state.error) return '';
      return `<div class="kn-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(6)}<span class="sr-only">Loading Knowledge</span></div>`;
    }
    if (state.tab === 'required') return requiredMarkup();
    if (state.tab === 'training') return trainingMarkup();
    if (state.tab === 'sources') return canManage() ? sourcesMarkup() : permissionMarkup();
    if (state.tab === 'activity') return canManage() ? activityMarkup() : permissionMarkup();
    return libraryMarkup();
  }

  // ---------- article page ----------

  function articleMarkup() {
    if (state.detailLoading && !state.detail) {
      return `<div class="kn-article kn-reading" aria-busy="true"><div class="atlas-skel atlas-skel--title"></div>${'<div class="atlas-skel atlas-skel--text"></div>'.repeat(6)}<span class="sr-only">Loading article</span></div>`;
    }
    if (!state.detail) {
      return `<div class="kn-reading"><a class="atlas-btn atlas-btn--ghost atlas-btn--sm kn-back" href="#knowledge">${icon('chevron-left')}Knowledge</a><div class="atlas-empty"><div class="atlas-empty__icon">${icon('book-x')}</div><h1 class="atlas-empty__title">This article isn’t available</h1><p class="atlas-empty__text">${escapeHtml(state.detailError || 'It may have been retired, or it isn’t shared with your role.')}</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#knowledge">Back to Knowledge</a></div></div></div>`;
    }
    const detail = state.detail;
    const article = detail.article || {};
    const version = detail.version || {};
    const manager = canManage();
    const draft = version.state === 'draft';
    const minutes = readingMinutes(version.content);
    const meta = [article.category_name, TYPE_LABELS[article.article_type], version.published_at ? `Updated ${formatDate(version.published_at)}` : version.updated_at ? `Edited ${formatDate(version.updated_at)}` : null, minutes ? `${minutes} min read` : null, `Version ${Number(version.version_number || 1)}`].filter(Boolean).join(' · ');
    const sources = (Array.isArray(detail.sources) ? detail.sources : []).filter((source) => manager || source.visible_to_staff);
    const acknowledgements = Array.isArray(detail.acknowledgements) ? detail.acknowledgements : [];
    const history = Array.isArray(detail.version_history) ? detail.version_history : [];
    const requiredState = article.required
      ? (detail.can_acknowledge ? pill('Required · not read', 'warning') : pill('Required · read', 'positive'))
      : '';
    const readButton = detail.can_acknowledge && !draft
      ? `<button type="button" class="atlas-btn atlas-btn--primary" data-knowledge-acknowledge>${icon('check')}Mark as read</button>` : '';
    const ask = window.AtlasAI?.askAbout ? `<button type="button" class="atlas-btn atlas-btn--secondary" data-knowledge-ask>${icon('sparkles')}Ask Atlas about this</button>` : '';
    const managerActions = manager ? `<div class="kn-article__manage">
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-knowledge-edit>${icon('pencil')}${draft ? 'Edit draft' : 'Edit'}</button>
        ${draft ? `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" data-knowledge-publish>${icon('send')}Publish version</button>` : ''}
        ${article.status !== 'retired' ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-knowledge-retire>Retire</button>` : ''}
      </div>` : '';
    return `<article class="kn-article kn-reading" aria-labelledby="kn-article-title">
      <a class="atlas-btn atlas-btn--ghost atlas-btn--sm kn-back" href="#knowledge">${icon('chevron-left')}Knowledge</a>
      <header class="kn-article__head">
        <h1 class="kn-article__title" id="kn-article-title">${escapeHtml(version.title || article.title || 'Untitled')}</h1>
        <p class="kn-article__meta">${escapeHtml(meta)}</p>
        ${requiredState || draft ? `<p class="kn-article__state">${requiredState}${draft ? pill('Draft', 'neutral') : ''}</p>` : ''}
        ${managerActions}
      </header>
      ${draft ? `<div class="atlas-alert atlas-alert--warning">${icon('eye-off')}<div class="atlas-alert__content"><p class="atlas-alert__title">Private draft</p><p class="atlas-alert__body">Only managers see this. The team keeps reading the published version until you publish.</p></div></div>` : ''}
      ${version.summary ? `<p class="kn-article__summary">${escapeHtml(version.summary)}</p>` : ''}
      <div class="kn-prose">${renderMarkdown(version.content, `${article.id}:${version.id}`)}</div>
      ${article.live_route && LIVE_ROUTES[article.live_route] ? `<a class="atlas-btn atlas-btn--secondary kn-live" href="${LIVE_ROUTES[article.live_route]}">${icon('arrow-up-right')}Open ${escapeHtml(humanize(article.live_route))}</a>` : ''}
      <footer class="kn-article__foot">${readButton}${ask}${!detail.can_acknowledge && article.required && !draft ? `<p class="kn-done">${icon('circle-check')}You’ve read version ${Number(version.version_number || 1)}.</p>` : ''}</footer>
      ${sources.length || manager ? `<section class="kn-section kn-article__section"><div class="kn-section__head"><h2 class="kn-section__title">Sources</h2>${manager ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-knowledge-add-source>${icon('plus')}Add source</button>` : ''}</div>${sources.length ? `<ul class="atlas-list kn-list">${sources.map((source) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon">${icon(source.source_type === 'google_drive' ? 'cloud' : source.source_type === 'atlas_module' ? 'layers' : 'file-text')}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(source.source_label)}</p><p class="atlas-row__meta">${escapeHtml([humanize(source.source_type), manager ? source.source_version : null, manager ? (source.visible_to_staff ? 'Label shown to staff' : 'Managers only') : null].filter(Boolean).join(' · '))}</p></div>${manager ? `<div class="atlas-row__end">${source.source_url ? `<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-knowledge-source-open="${escapeHtml(source.id)}" aria-label="Open ${escapeHtml(source.source_label)}">${icon('external-link')}</button>` : ''}<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-knowledge-source-edit="${escapeHtml(source.id)}" aria-label="Edit ${escapeHtml(source.source_label)}">${icon('pencil')}</button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-knowledge-source-remove="${escapeHtml(source.id)}" aria-label="Remove ${escapeHtml(source.source_label)}">${icon('trash-2')}</button></div>` : ''}</li>`).join('')}</ul>` : '<p class="kn-note">No sources added.</p>'}</section>` : ''}
      ${manager && !draft ? `<section class="kn-section kn-article__section"><h2 class="kn-section__title">Who has read this version</h2>${acknowledgements.length ? `<ul class="atlas-list kn-list">${acknowledgements.map((item) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon atlas-row__icon--positive">${icon('circle-check')}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(item.user_label)}</p><p class="atlas-row__meta">${escapeHtml(humanize(item.user_role))} · ${escapeHtml(formatDateTime(item.acknowledged_at))}</p></div></li>`).join('')}</ul>` : '<p class="kn-note">No one has confirmed this version yet.</p>'}</section>` : ''}
      ${manager && history.length ? `<section class="kn-section kn-article__section"><h2 class="kn-section__title">Version history</h2><ul class="atlas-list kn-list">${history.map((item) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon num">v${Number(item.version_number)}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(item.title)}</p><p class="atlas-row__meta">${escapeHtml([humanize(item.state), formatDateTime(item.published_at || item.updated_at), item.change_note].filter(Boolean).join(' · '))}</p></div></li>`).join('')}</ul></section>` : ''}
    </article>
    ${phoneQuery.matches && (readButton || ask) ? `<div class="kn-bar">${readButton}${window.AtlasAI?.askAbout ? `<button type="button" class="atlas-icon-btn atlas-icon-btn--lg" data-knowledge-ask aria-label="Ask Atlas about this">${icon('sparkles')}</button>` : ''}</div>` : ''}`;
  }

  // ---------- editor ----------

  function openEditor(options = {}) {
    if (!canManage()) return;
    const detail = options.fresh ? null : state.detail;
    const article = detail?.article || {};
    const version = detail?.version || {};
    const selectedRoles = Array.isArray(article.target_roles) && article.target_roles.length ? article.target_roles : ['all'];
    const linkedTasks = new Set((detail?.task_links || []).map((item) => item.onboarding_task_id));
    if (!article.id && options.taskId) linkedTasks.add(options.taskId);
    const root = openLayer({
      id: 'kn-editor',
      panel: `<section class="atlas-sheet atlas-sheet--wide kn-editor" data-modal-panel aria-labelledby="kn-editor-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="kn-editor-title">${article.id ? 'Edit draft' : 'New article'}</h2><p class="atlas-sheet__desc">Saved as a private draft. The team sees it only after you publish.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="kn-editor-form" data-knowledge-editor-form novalidate>
          <input type="hidden" name="article_id" value="${escapeHtml(article.id || '')}">
          <input type="hidden" name="article_key" value="${escapeHtml(article.article_key || '')}">
          <div class="atlas-field"><label for="kn-title">Title</label><input class="atlas-input" id="kn-title" name="title" maxlength="220" required value="${escapeHtml(version.title || '')}" placeholder="Closing the bar"><p class="error" hidden data-error-for="title">Add a title.</p></div>
          <div class="atlas-field"><label for="kn-summary">Summary <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="kn-summary" name="summary" rows="2" maxlength="3000" placeholder="What the reader will learn">${escapeHtml(version.summary || '')}</textarea></div>
          <div class="atlas-field"><label for="kn-content">Article</label><textarea class="atlas-input atlas-textarea kn-editor__content" id="kn-content" name="content" rows="16" maxlength="250000" required placeholder="# Heading&#10;&#10;Steps, one per line:&#10;- [ ] Count the till">${escapeHtml(version.content || '')}</textarea><p class="help"># for headings, - for lists, - [ ] for checklist steps, **bold**.</p><p class="error" hidden data-error-for="content">Write the article before saving.</p></div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="kn-category-edit">Category</label><select class="atlas-select" id="kn-category-edit" name="category_id" required>${categories().map((category) => `<option value="${escapeHtml(category.id)}" ${category.id === article.category_id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select></div>
            <div class="atlas-field"><label for="kn-type">Type</label><select class="atlas-select" id="kn-type" name="article_type">${Object.entries(TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${value === (article.article_type || 'sop') ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          </div>
          <fieldset class="atlas-form-group kn-roles"><legend class="atlas-form-group__title">Who can read it</legend>${['all', 'admin', 'manager', 'bartender', 'viewer'].map((key) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="target_roles" value="${key}" ${selectedRoles.includes(key) ? 'checked' : ''}>${key === 'all' ? 'Everyone on the team' : escapeHtml(humanize(key === 'viewer' ? 'Read-only staff' : key === 'bartender' ? 'Bartenders' : key === 'manager' ? 'Managers' : 'Administrators'))}</label>`).join('')}<p class="error" hidden data-error-for="target_roles">Choose who can read it.</p></fieldset>
          <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="kn-required-label">Required reading</p><p class="atlas-toggle-row__help">Everyone who can read it must confirm each published version.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${article.required ? 'true' : 'false'}" aria-labelledby="kn-required-label" data-kn-required></button></div>
          <div class="atlas-field"><label for="kn-live">Links to <span class="optional">Optional</span></label><select class="atlas-select" id="kn-live" name="live_route"><option value="">Nothing</option>${Object.keys(LIVE_ROUTES).filter((key) => key !== 'brain').map((key) => `<option value="${key}" ${key === article.live_route ? 'selected' : ''}>${escapeHtml(humanize(key))}</option>`).join('')}</select></div>
          ${state.onboardingTasks.length ? `<fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Training steps it supports</legend>${state.onboardingTasks.map((task) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="task_ids" value="${escapeHtml(task.id)}" ${linkedTasks.has(task.id) ? 'checked' : ''}>${escapeHtml(task.title)}</label>`).join('')}</fieldset>` : ''}
          <div class="atlas-field"><label for="kn-note">What changed <span class="optional">Optional</span></label><input class="atlas-input" id="kn-note" name="change_note" maxlength="3000" value="${escapeHtml(version.change_note || '')}" placeholder="Updated the cash-up step"></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="kn-editor-form" class="atlas-btn atlas-btn--primary">Save private draft</button></footer>
      </section>`
    });
    root.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-kn-required]');
      if (toggle) toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'));
    });
    root.addEventListener('change', (event) => {
      const target = event.target;
      if (!target.matches('input[name="target_roles"]')) return;
      const form = target.form;
      if (target.value === 'all' && target.checked) form.querySelectorAll('input[name="target_roles"]:not([value="all"])').forEach((input) => { input.checked = false; });
      else if (target.checked) { const all = form.querySelector('input[name="target_roles"][value="all"]'); if (all) all.checked = false; }
    });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const roles = data.getAll('target_roles').map(String);
      const errors = { title: !String(data.get('title') || '').trim(), content: !String(data.get('content') || '').trim(), target_roles: !roles.length };
      Object.entries(errors).forEach(([key, bad]) => { const el = root.querySelector(`[data-error-for="${key}"]`); if (el) el.hidden = !bad; });
      form.title.setAttribute('aria-invalid', String(errors.title));
      form.content.setAttribute('aria-invalid', String(errors.content));
      if (errors.title || errors.content || errors.target_roles) {
        (errors.title ? form.title : errors.content ? form.content : form.querySelector('input[name="target_roles"]')).focus();
        return;
      }
      const ok = await mutate('save-draft', {
        article_id: data.get('article_id') || null,
        article_key: data.get('article_key') || null,
        category_id: data.get('category_id'),
        article_type: data.get('article_type'),
        title: data.get('title'),
        summary: data.get('summary'),
        content: data.get('content'),
        required: root.querySelector('[data-kn-required]').getAttribute('aria-checked') === 'true',
        target_roles: roles.includes('all') ? ['all'] : roles,
        live_route: data.get('live_route') || null,
        change_note: data.get('change_note') || null,
        task_ids: data.getAll('task_ids').map(String)
      }, 'Draft saved. Staff visibility has not changed.');
      if (ok) {
        closeLayer(root);
        const savedId = state.detail?.article?.id;
        if (savedId && savedId !== state.articleId) routeTo('knowledge', { article: savedId });
      }
    });
  }

  function openSourceEditor(sourceId = null) {
    if (!canManage() || !state.detail) return;
    const sources = Array.isArray(state.detail.sources) ? state.detail.sources : [];
    const source = sourceId ? sources.find((entry) => entry.id === sourceId) || {} : {};
    const root = openLayer({
      id: 'kn-source',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="kn-source-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="kn-source-title">${source.id ? 'Edit source' : 'Add source'}</h2><p class="atlas-sheet__desc">Where this article comes from. Only managers see links.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="kn-source-form" data-knowledge-source-form novalidate>
          <div class="atlas-field"><label for="ks-type">Type</label><select class="atlas-select" id="ks-type" name="source_type">${[['google_drive', 'Google Drive'], ['atlas_module', 'Atlas page'], ['sprint3_import', 'Imported file'], ['manual', 'Written by hand'], ['external', 'Other link']].map(([value, label]) => `<option value="${value}" ${value === (source.source_type || 'manual') ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          <div class="atlas-field"><label for="ks-label">Name</label><input class="atlas-input" id="ks-label" name="source_label" maxlength="220" required value="${escapeHtml(source.source_label || '')}"><p class="error" hidden data-error-for="source_label">Add a name.</p></div>
          <div class="atlas-field"><label for="ks-ref">Reference <span class="optional">Optional</span></label><input class="atlas-input" id="ks-ref" name="source_reference" maxlength="1000" value="${escapeHtml(source.source_reference || '')}"></div>
          <div class="atlas-field"><label for="ks-url">Private source URL <span class="optional">Optional</span></label><input class="atlas-input" id="ks-url" name="source_url" type="url" maxlength="3000" value="${escapeHtml(source.source_url || '')}"><p class="help">The URL remains manager-only.</p></div>
          <div class="atlas-field"><label for="ks-version">Version <span class="optional">Optional</span></label><input class="atlas-input" id="ks-version" name="source_version" maxlength="300" value="${escapeHtml(source.source_version || '')}"></div>
          <div class="atlas-field"><label for="ks-status">Status</label><select class="atlas-select" id="ks-status" name="connection_status">${[['manual_reference', 'Recorded by hand'], ['not_connected', 'Not connected'], ['current', 'Up to date'], ['stale', 'Out of date'], ['error', 'Can’t be reached']].map(([value, label]) => `<option value="${value}" ${value === (source.connection_status || 'manual_reference') ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          <label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="visible_to_staff" ${source.visible_to_staff ? 'checked' : ''}>Show the source name to staff</label>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="kn-source-form" class="atlas-btn atlas-btn--primary">Save source</button></footer>
      </section>`
    });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const label = String(data.get('source_label') || '').trim();
      root.querySelector('[data-error-for="source_label"]').hidden = Boolean(label);
      if (!label) { event.currentTarget.source_label.focus(); return; }
      const ok = await mutate('save-source', {
        article_id: state.detail.article.id,
        source_id: source.id || null,
        source_type: data.get('source_type'),
        source_label: label,
        source_reference: data.get('source_reference') || null,
        source_url: data.get('source_url') || null,
        source_version: data.get('source_version') || null,
        connection_status: data.get('connection_status'),
        visible_to_staff: data.get('visible_to_staff') === 'on',
        metadata: {}
      }, 'Source saved');
      if (ok) closeLayer(root);
    });
  }

  // ---------- load & save ----------

  function applyPayload(payload) {
    if (payload.workspace) state.snapshot = payload.workspace;
    if (payload.staff) state.staff = payload.staff;
    if (Array.isArray(payload.onboarding_tasks)) state.onboardingTasks = payload.onboarding_tasks;
    if (payload.detail) state.detail = payload.detail;
  }

  async function loadSnapshot(options = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!options.silent) state.error = null;
    paint();
    try {
      const payload = await api('snapshot');
      // A response without a workspace is a failure, not an empty library.
      if (!payload?.workspace) throw new KnowledgeError('Knowledge is temporarily unavailable.', 0);
      applyPayload(payload);
      state.error = null;
      state.failedAt = 0;
      contribute();
    } catch (error) {
      if (!options.silent || !state.snapshot) state.error = error.message;
      state.failedAt = Date.now();
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function loadArticle(articleId) {
    const serial = articleId;
    state.detailLoading = true;
    state.detailError = null;
    if (state.detail?.article?.id !== articleId) state.detail = null;
    paint();
    try {
      const payload = await api('detail', { params: { article_id: articleId, prefer_draft: canManage() ? 'true' : null } });
      if (state.articleId !== serial) return;
      state.detail = payload.article || null;
      if (payload.staff) state.staff = payload.staff;
      if (state.detail?.version?.state === 'published' && !state.detail.read) {
        api('mark-read', { method: 'POST', body: { article_id: state.detail.article.id, version_id: state.detail.version.id } })
          .then(() => { if (state.detail) state.detail.read = true; })
          .catch(() => { /* reading still works; the read mark is a convenience */ });
      }
    } catch (error) {
      if (state.articleId !== serial) return;
      state.detail = null;
      state.detailError = error.message;
    } finally {
      if (state.articleId === serial) {
        state.detailLoading = false;
        paint();
      }
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.submitting) return false;
    state.submitting = true;
    try {
      const payload = await api(action, { method: 'POST', body });
      applyPayload(payload);
      if (successMessage) window.AtlasShell?.toast?.(successMessage);
      contribute();
      return true;
    } catch (error) {
      window.AtlasShell?.toast?.(error.message || 'The change couldn’t be saved.');
      return false;
    } finally {
      state.submitting = false;
      paint();
    }
  }

  function runSearch() {
    const query = state.search.trim();
    window.clearTimeout(state.searchTimer);
    if (query.length < 2) {
      state.searchResults = null;
      state.searchStatus = 'idle';
      paintResults();
      return;
    }
    state.searchTimer = window.setTimeout(async () => {
      const serial = ++state.searchSerial;
      state.searchStatus = 'loading';
      paintResults();
      try {
        const payload = await api('search', { params: { q: query, limit: 25 } });
        if (serial !== state.searchSerial) return;
        state.searchResults = Array.isArray(payload.results) ? payload.results.filter((row) => canManage() || row.version_state === 'published') : [];
        state.searchStatus = 'ready';
      } catch (error) {
        if (serial !== state.searchSerial) return;
        state.searchResults = null;
        state.searchStatus = 'error';
      }
      paintResults();
    }, SEARCH_DEBOUNCE_MS);
  }

  // ---------- render ----------

  function paintResults() {
    const results = host()?.querySelector('[data-kn-results]');
    if (!results) return;
    results.innerHTML = libraryListMarkup();
    paintIcons();
  }

  function paint() {
    if (!state.visible) return;
    const view = host();
    if (!view) return;
    if (view.classList.contains('placeholder-view')) view.classList.remove('placeholder-view');
    view.classList.add('kn-host');
    const searchFocused = document.activeElement?.matches?.('[data-knowledge-search]');
    if (state.articleId) {
      view.innerHTML = `<div class="kn kn--article">${articleMarkup()}</div>`;
      window.AtlasChrome?.setTopBar?.({ title: state.detail?.version?.title || state.detail?.article?.title || 'Knowledge', back: () => routeTo('knowledge', {}), actions: canManage() && state.detail ? [{ icon: 'pencil', label: 'Edit draft', run: () => openEditor() }] : [] });
      window.AtlasChrome?.setTabBarHidden?.('knowledge', phoneQuery.matches);
    } else {
      view.innerHTML = `<div class="kn">${headerMarkup()}${tabsMarkup()}${alertMarkup()}<div class="kn-body">${listContentMarkup()}</div></div>`;
      window.AtlasChrome?.setTopBar?.(canManage() && phoneQuery.matches ? { actions: [{ icon: 'plus', label: 'New article', run: () => openEditor({ fresh: true }) }] } : {});
      window.AtlasChrome?.setTabBarHidden?.('knowledge', false);
    }
    paintIcons();
    if (searchFocused) {
      const input = view.querySelector('[data-knowledge-search]');
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function render(params = {}) {
    state.visible = true;
    const section = params.section || '';
    let article = params.article ? String(params.article) : null;
    // #knowledge/sources and #knowledge/activity arrive as article ids from the
    // shell's route table (it knows only required and training as sections).
    if (article && TABS.some((tab) => tab.key === article)) { state.tab = article; article = null; }
    else if (TABS.some((tab) => tab.key === section)) state.tab = section;
    else if (!article) state.tab = 'library';
    const changed = article !== state.articleId;
    state.articleId = article;
    if (!state.snapshot && !state.loading && (!state.failedAt || Date.now() - state.failedAt > 20000)) loadSnapshot();
    if (article && (changed || !state.detail)) loadArticle(article);
    else paint();
    if (!article) window.scrollTo?.(0, 0);
  }

  function hide() {
    state.visible = false;
    window.AtlasChrome?.setTabBarHidden?.('knowledge', false);
  }

  // ---------- events ----------

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    const tab = target.closest('[data-knowledge-tab]');
    if (tab) {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const key = tab.dataset.knowledgeTab;
      routeTo('knowledge', key === 'library' ? {} : key === 'required' || key === 'training' ? { section: key } : { article: key });
      return;
    }
    const open = target.closest('[data-knowledge-open]');
    if (open) {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      routeTo('knowledge', { article: open.dataset.knowledgeOpen });
      return;
    }
    const category = target.closest('[data-knowledge-category]');
    if (category) { state.category = category.dataset.knowledgeCategory || 'all'; paint(); return; }
    if (target.closest('[data-knowledge-clear]')) { state.search = ''; runSearch(); paint(); host()?.querySelector('[data-knowledge-search]')?.focus(); return; }
    if (target.closest('[data-knowledge-refresh]')) { state.failedAt = 0; loadSnapshot(); return; }
    if (target.closest('[data-knowledge-new]')) { openEditor({ fresh: true }); return; }
    const linkTask = target.closest('[data-knowledge-link-task]');
    if (linkTask) { openEditor({ fresh: true, taskId: linkTask.dataset.knowledgeLinkTask }); return; }
    if (target.closest('[data-knowledge-ask-search]')) { window.AtlasAI?.ask?.(state.search.trim()); return; }
    if (target.closest('[data-knowledge-ask]')) {
      const detail = state.detail;
      if (detail) window.AtlasAI?.askAbout?.({ type: 'knowledge_article', id: detail.article.id, label: detail.version?.title || detail.article.title });
      return;
    }
    if (target.closest('[data-knowledge-acknowledge]')) {
      const detail = state.detail;
      if (!detail) return;
      const ok = await mutate('acknowledge', { article_id: detail.article.id, version_id: detail.version.id }, 'Marked as read');
      if (ok && state.detail) state.detail.can_acknowledge = false;
      paint();
      return;
    }
    if (target.closest('[data-knowledge-edit]')) { openEditor(); return; }
    if (target.closest('[data-knowledge-publish]')) {
      const detail = state.detail;
      const answer = await confirmDialog({
        title: 'Publish this version?',
        body: 'Everyone it’s shared with sees it straight away. If it’s required reading, they’re asked to read it again. Existing acknowledgements remain attached to the previous version.',
        confirmLabel: 'Publish version',
        field: { label: 'What changed', value: detail?.version?.change_note || '' }
      });
      if (answer) mutate('publish', { article_id: detail.article.id, change_note: answer.value || null }, 'Version published to the team');
      return;
    }
    if (target.closest('[data-knowledge-retire]')) {
      const detail = state.detail;
      const answer = await confirmDialog({ title: 'Retire this article?', body: 'It disappears from the library for everyone. Its versions and confirmations are kept.', confirmLabel: 'Retire article', danger: true, field: { label: 'Reason', required: true } });
      if (!answer) return;
      const ok = await mutate('retire', { article_id: detail.article.id, reason: answer.value }, 'Article retired');
      if (ok) routeTo('knowledge', {});
      return;
    }
    if (target.closest('[data-knowledge-add-source]')) { openSourceEditor(); return; }
    const sourceEdit = target.closest('[data-knowledge-source-edit]');
    if (sourceEdit) { openSourceEditor(sourceEdit.dataset.knowledgeSourceEdit); return; }
    const sourceOpen = target.closest('[data-knowledge-source-open]');
    if (sourceOpen) {
      const source = (state.detail?.sources || []).find((entry) => entry.id === sourceOpen.dataset.knowledgeSourceOpen);
      if (source?.source_url) window.open(source.source_url, '_blank', 'noopener,noreferrer');
      return;
    }
    const sourceRemove = target.closest('[data-knowledge-source-remove]');
    if (sourceRemove) {
      const answer = await confirmDialog({ title: 'Remove this source?', body: 'The article and its versions stay as they are.', confirmLabel: 'Remove source', danger: true });
      if (answer) mutate('remove-source', { source_id: sourceRemove.dataset.knowledgeSourceRemove, article_id: state.detail?.article?.id || null }, 'Source removed');
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !host()?.contains(target)) return;
    if (target.matches('[data-knowledge-search]')) {
      state.search = target.value;
      state.searchResults = null;
      paintResults();
      runSearch();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!host()?.contains(target)) return;
    if (target.matches?.('[data-knowledge-category-select]')) { state.category = target.value; paint(); return; }
    if (target.matches?.('[data-kn-check]')) state.checks.set(target.dataset.knCheck, target.checked);
  }

  // AtlasShell.show() does not rewrite the address when the new route has
  // fewer parts than the current one (#messages/general → #messages), so this
  // page moves between its own routes through the address itself.
  function routeTo(view, params = {}) {
    const shell = window.AtlasShell;
    if (!shell?.href) return;
    const target = shell.href(view, params);
    if (window.location.hash !== target) window.location.hash = target;
    else shell.show(view, params, { history: false, source: 'route' });
  }

  function openArticleFromLink(articleId) {
    const id = String(articleId || '').trim();
    if (id) routeTo('knowledge', { article: id });
  }

  // Home and the notifications feed: required reading that's due.
  function contribute() {
    window.AtlasShell?.emit?.('knowledge:changed', { due: dueArticles().map((article) => ({ id: article.id, title: article.title, route: `#knowledge/${article.id}` })) });
  }

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell?.registerView) return;
    shell.registerView('knowledge', { root: () => host(), title: 'Knowledge', render, onHide: hide });
    // Knowledge links in Messages (and any other typed link) open through the
    // shell's link registry.
    shell.links?.register?.('knowledge_article', openArticleFromLink);
    shell.actions?.register?.({
      id: 'knowledge.new', label: 'New article', icon: 'file-plus', keywords: ['knowledge', 'procedure', 'policy', 'sop', 'article'], roles: ['admin', 'manager'], contexts: ['knowledge'],
      run: () => { routeTo('knowledge', {}); window.setTimeout(() => openEditor({ fresh: true }), 300); }
    });
    shell.actions?.register?.({
      id: 'knowledge.required', label: 'Open required reading', icon: 'book-check', keywords: ['required', 'reading', 'training', 'read'], contexts: ['knowledge', 'home'],
      run: () => routeTo('knowledge', { section: 'required' })
    });
    if (shell.current?.() === 'knowledge') render(shell.params?.() || {});
  }

  function init() {
    if (state.initialized || !host()) return;
    state.initialized = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    window.addEventListener('online', () => { if (state.visible) loadSnapshot({ silent: true }); });
    phoneQuery.addEventListener?.('change', () => { if (state.visible) paint(); });
    railQuery.addEventListener?.('change', () => { if (state.visible) paint(); });
    registerWithShell();
  }

  window.AtlasKnowledge = {
    open: () => routeTo('knowledge', {}),
    openArticle: (articleId) => openArticleFromLink(articleId),
    refresh: () => loadSnapshot(),
    snapshot: () => state.snapshot,
    detail: () => state.detail,
    due: () => dueArticles().map((article) => ({ id: article.id, title: article.title }))
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
