// Command palette: "Search or ask Atlas" (spec §4.6, §4.7, §8.8).
//
// One entry point for records, canonical actions, destinations and Atlas AI.
// Opens from ⌘K / Ctrl K, "/" (outside a field), the top-bar field, the +
// button (Actions) and the phone search icon. Records, destinations and
// instant answers come from AtlasSearch (assets/js/atlas-search.js); actions
// from AtlasShell.actions.list(ctx); the "Ask Atlas" row routes to
// #ai/new?q=… for the Atlas AI workspace.
//
// Public: window.AtlasPalette = { open({ mode, query, trigger }), close(), isOpen(), clearRecent() }.
(function () {
  'use strict';

  const shell = window.AtlasShell;
  if (!shell || window.AtlasPalette) return;

  const PHONE = window.matchMedia('(max-width: 767px)');
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  // Recent records are per user (`atlas.palette.recent.v1:<user id>`) and are
  // cleared at sign-out and whenever a different user signs in, so a shared
  // device never shows one account's records to the next (security G3).
  const RECENT_PREFIX = 'atlas.palette.recent.v1';
  const MAX_ROWS = 5;
  const QUESTION = /\?\s*$|^(who|what|when|where|why|how|can|could|do|does|did|is|are|should|will|which)\b/i;
  const ACTION_GROUPS = [
    ['Stock', /^inventory\./], ['Purchasing', /^purchasing\./], ['Service', /^(operations|recipes|ai)\./],
    ['People', /^(shifts|messages|team|knowledge)\./], ['Business', /^(data|marketing|reports|settings)\./]
  ];

  const state = {
    open: false,
    mode: 'search',
    query: '',
    context: null,        // nav item of the page the palette was opened on
    sections: [],
    rows: [],
    active: -1,
    expanded: new Set(),
    trigger: null,
    answer: null,
    answerToken: 0,
    answerTimer: null
  };

  let layer = null;
  let input = null;
  let list = null;

  const escape = (value) => shell.escape(value);
  const icon = (name, options) => (window.AtlasChrome?.icon ? window.AtlasChrome.icon(name, options) : `<i data-lucide="${escape(name)}" aria-hidden="true"></i>`);
  const role = () => shell.profile()?.role || null;
  const normalize = (value) => String(value || '').trim();

  // ---------- recent records ----------

  function recentKey() {
    const id = shell.profile()?.id;
    return id ? `${RECENT_PREFIX}:${id}` : null;
  }

  // Removes every user's recents except `keepUserId`'s (none when omitted),
  // including the legacy unscoped key.
  function clearRecent(keepUserId = null) {
    try {
      const keep = keepUserId ? `${RECENT_PREFIX}:${keepUserId}` : null;
      const storage = window.localStorage;
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) keys.push(storage.key(index));
      keys.filter((key) => key && (key === RECENT_PREFIX || key.startsWith(`${RECENT_PREFIX}:`)) && key !== keep).forEach((key) => storage.removeItem(key));
    } catch { /* per-viewer convenience only */ }
  }

  function readRecent() {
    const key = recentKey();
    if (!key) return [];
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value.filter((entry) => entry && entry.title && entry.type) : [];
    } catch { return []; }
  }

  function remember(result) {
    if (!result?.type || !result.id || result.type === 'page' || result.type === 'knowledge_search') return;
    const key = recentKey();
    if (!key) return;
    const entry = { type: result.type, id: result.id, title: result.title, detail: result.detail || '', icon: result.icon, route: result.route || null };
    const next = [entry, ...readRecent().filter((item) => !(item.type === entry.type && item.id === entry.id))].slice(0, 8);
    try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  }

  // A different (or no) user: drop everyone else's recents.
  shell.on?.('profile:ready', (profile) => clearRecent(profile?.id || null));

  // ---------- rows ----------
  // Row: { id, kind: 'record'|'action'|'page'|'ask'|'more', label, meta, icon, hint, run() }

  function recordRow(result) {
    return {
      id: `record:${result.type}:${result.id}`, kind: 'record', label: result.title, meta: result.detail || '', icon: result.icon || 'file',
      run: () => { remember(result); result.run(); }
    };
  }

  function recentRow(entry) {
    return {
      id: `recent:${entry.type}:${entry.id}`, kind: 'record', label: entry.title, meta: entry.detail || '', icon: entry.icon || 'history',
      run: () => { remember(entry); window.AtlasSearch?.openRecord?.(entry); }
    };
  }

  function actionContext(extra = {}) {
    return { role: role(), context: state.context?.id || null, source: 'palette', ...extra };
  }

  function actionRow(action, record) {
    const label = record && action.recordLabel ? action.recordLabel.replace('{name}', record.label) : action.label;
    return {
      id: `action:${action.id}${record ? `:${record.type}:${record.id}` : ''}`, kind: 'action', label, meta: '', icon: action.icon || 'zap',
      run: () => shell.actions.run(action.id, actionContext(record ? { record } : {})).catch((error) => console.error(`Action ${action.id} failed`, error))
    };
  }

  function pageRow(result) {
    return { id: `page:${result.route}`, kind: 'page', label: result.title, meta: '', icon: result.icon || 'arrow-right', run: () => result.run() };
  }

  function askRow(query) {
    return {
      id: 'ask', kind: 'ask', icon: 'sparkles', label: query ? `Ask Atlas “${query}”` : 'Ask Atlas', query,
      hint: IS_MAC ? ['⌘', '↵'] : ['Ctrl', '↵'],
      run: () => askAtlas(query)
    };
  }

  function askAtlas(query) {
    const text = normalize(query);
    // Atlas AI (E6) reads q from #ai/new; the context tag rides along.
    const params = [text ? `q=${encodeURIComponent(text)}` : '', state.context && state.context.id !== 'ai' ? `from=${encodeURIComponent(state.context.id)}` : ''].filter(Boolean).join('&');
    const route = `#ai/new${params ? `?${params}` : ''}`;
    // The send intent rides in memory: the URL alone only prefills (G1).
    if (text) window.AtlasAI?.intendSend?.(text);
    if (window.location.hash === route) shell.navigate(route, { source: 'palette' });
    else window.location.hash = route;
  }

  // ---------- sections ----------

  function suggested() {
    if (!state.context) return [];
    return shell.actions.list({ role: role(), context: state.context.id, suggested: true }).slice(0, 4).map((action) => actionRow(action));
  }

  function allActionsGrouped() {
    const actions = shell.actions.list({ role: role() });
    return ACTION_GROUPS.map(([label, pattern]) => ({ label, rows: actions.filter((action) => pattern.test(action.id)).map((action) => actionRow(action)) }))
      .concat([{ label: 'More actions', rows: actions.filter((action) => !ACTION_GROUPS.some(([, pattern]) => pattern.test(action.id))).map((action) => actionRow(action)) }])
      .filter((group) => group.rows.length);
  }

  function buildSections() {
    const query = normalize(state.query);
    const sections = [];
    const add = (key, label, rows, options = {}) => { if (rows.length) sections.push({ key, label, rows, limit: options.limit ?? MAX_ROWS }); };
    const search = window.AtlasSearch;

    if (!query) {
      const top = state.mode !== 'actions' ? suggested() : [];
      add('suggested', 'Suggested', top);
      const recent = readRecent().slice(0, 5).map(recentRow);
      if (state.mode !== 'actions' && (!top.length || PHONE.matches)) add('recent', 'Recent', recent);
      // Every other permitted action, grouped (phone and the + button) or as one list.
      const shown = new Set(top.map((row) => row.id));
      allActionsGrouped().forEach((group) => add(`actions:${group.label}`, state.mode === 'actions' || PHONE.matches ? group.label : 'Actions', group.rows.filter((row) => !shown.has(row.id)), { limit: state.mode === 'actions' ? 99 : MAX_ROWS }));
      if (state.mode !== 'actions') add('ask', 'Ask Atlas', [askRow('')]);
      return mergeActionSections(sections);
    }

    // The Ask Atlas row replaces the "search Knowledge for…" fallback here.
    const findRecords = (text) => (search?.records?.(text) || []).filter((result) => result.type !== 'knowledge_search');
    // "count campari": a verb and a record. When the whole query names no
    // record, split it into the record part and the action part.
    let records = findRecords(query);
    let actionQuery = null;
    const words = query.split(/\s+/).filter(Boolean);
    for (let cut = 1; !records.length && cut < words.length; cut += 1) {
      const head = words.slice(0, cut).join(' ');
      const tail = words.slice(cut).join(' ');
      const byTail = findRecords(tail);
      const byHead = byTail.length ? [] : findRecords(head);
      if (byTail.length) { records = byTail; actionQuery = head; }
      else if (byHead.length) { records = byHead; actionQuery = tail; }
    }
    const byType = new Map();
    records.forEach((result) => { if (!byType.has(result.group)) byType.set(result.group, []); byType.get(result.group).push(result); });
    const recordSections = [...byType.entries()].map(([group, results]) => ({ key: `records:${group}`, label: group, rows: results.map(recordRow), limit: MAX_ROWS }));

    const matchesAction = (action, text) => !text || [action.label, action.recordLabel || '', ...action.keywords].some((value) => value.toLowerCase().includes(text.toLowerCase()));
    const matching = shell.actions.list({ role: role(), query: actionQuery || query }).map((action) => actionRow(action));
    const firstRecord = records.find((result) => result.type && result.id);
    const record = firstRecord ? { type: firstRecord.type, id: firstRecord.id, label: firstRecord.title } : null;
    const recordActions = record
      ? shell.actions.list({ role: role(), record })
        .filter((action) => action.forRecord === record.type && action.recordLabel && matchesAction(action, actionQuery))
        .map((action) => actionRow(action, record))
      : [];
    const actions = [...recordActions, ...matching.filter((row) => !recordActions.some((other) => other.id.startsWith(`${row.id}:`)))];
    const pages = (search?.destinations?.(query) || []).map(pageRow);
    const ask = { key: 'ask', label: 'Ask Atlas', rows: [askRow(query)], limit: 1 };

    if (QUESTION.test(query)) sections.push(ask);
    sections.push(...recordSections);
    add('actions', 'Actions', actions);
    add('pages', 'Go to', pages);
    if (!QUESTION.test(query)) sections.push(ask);
    return sections;
  }

  // Empty-query desktop view lists one "Actions" section, not one per group.
  function mergeActionSections(sections) {
    const merged = [];
    sections.forEach((section) => {
      const previous = merged[merged.length - 1];
      if (previous && previous.label === section.label && section.key.startsWith('actions:') && previous.key.startsWith('actions')) {
        previous.rows.push(...section.rows);
      } else merged.push({ ...section, key: section.key.startsWith('actions:') && section.label === 'Actions' ? 'actions' : section.key, rows: [...section.rows] });
    });
    return merged;
  }

  // ---------- rendering ----------

  function flatten() {
    const rows = [];
    state.sections.forEach((section) => {
      const expanded = state.expanded.has(section.key) || section.rows.length <= section.limit;
      const visible = expanded ? section.rows : section.rows.slice(0, section.limit);
      visible.forEach((row) => rows.push({ ...row, section: section.key }));
      if (!expanded) {
        rows.push({ id: `more:${section.key}`, kind: 'more', label: `Show all ${section.rows.length}`, icon: 'chevron-down', section: section.key, run: () => { state.expanded.add(section.key); render({ keep: `more:${section.key}` }); } });
      }
    });
    return rows;
  }

  function optionId(index) { return `atlas-palette-option-${index}`; }

  function rowMarkup(row, index) {
    const active = index === state.active;
    const hint = row.kind === 'ask' && row.hint ? `<span class="atlas-palette__hint">${row.hint.map((key) => `<kbd class="kbd">${escape(key)}</kbd>`).join('')}</span>`
      : active ? '<span class="atlas-palette__hint"><kbd class="kbd">↵</kbd></span>' : '';
    const label = row.kind === 'ask' && row.query
      ? `Ask Atlas “<b>${escape(row.query)}</b>”`
      : escape(row.label);
    return `<div class="atlas-palette__item atlas-palette__item--${row.kind}${active ? ' is-active' : ''}" id="${optionId(index)}" role="option" aria-selected="${active}" data-palette-index="${index}">
      ${icon(row.icon, { size: 16 })}<span class="atlas-palette__label">${label}</span>${row.meta ? `<span class="atlas-palette__meta">${escape(row.meta)}</span>` : ''}${hint}</div>`;
  }

  function answerMarkup() {
    const answer = state.answer;
    if (!answer) return '';
    return `<section class="atlas-palette__answer is-${escape(answer.tone || 'neutral')}" aria-live="polite">
      <div class="atlas-palette__answer-label">${icon('sparkles', { size: 14 })}Atlas</div>
      <p>${escape(answer.text)}</p>
      ${answer.lines?.length ? `<ul>${answer.lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : ''}
      ${answer.action ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-palette-answer-action>${escape(answer.action.label)}</button>` : ''}
    </section>`;
  }

  function render({ keep = null } = {}) {
    if (!layer) return;
    state.sections = buildSections();
    const previous = keep || state.rows[state.active]?.id || null;
    state.rows = flatten();
    let index = previous ? state.rows.findIndex((row) => row.id === previous) : -1;
    if (index < 0) index = defaultActive();
    state.active = state.rows.length ? Math.max(0, index) : -1;

    const groups = state.sections.map((section, sectionIndex) => {
      const rows = state.rows.map((row, rowIndex) => [row, rowIndex]).filter(([row]) => row.section === section.key);
      if (!rows.length) return '';
      const labelId = `atlas-palette-group-${sectionIndex}`;
      return `<div class="atlas-palette__group" role="group" aria-labelledby="${labelId}"><div class="atlas-palette__label-row" id="${labelId}" role="presentation">${escape(section.label)}</div>${rows.map(([row, rowIndex]) => rowMarkup(row, rowIndex)).join('')}</div>`;
    }).join('');
    const empty = !state.rows.length ? `<p class="atlas-palette__empty">No matches for “${escape(state.query)}”.</p>` : '';
    list.innerHTML = `${answerMarkup()}${groups}${empty}`;
    input.setAttribute('aria-expanded', String(state.rows.length > 0));
    if (state.active >= 0) input.setAttribute('aria-activedescendant', optionId(state.active));
    else input.removeAttribute('aria-activedescendant');
    scrollActive();
  }

  function defaultActive() {
    if (state.mode === 'actions' && !normalize(state.query)) {
      const first = state.rows.findIndex((row) => row.kind === 'action');
      return first >= 0 ? first : 0;
    }
    return 0;
  }

  function scrollActive() {
    const node = state.active >= 0 ? document.getElementById(optionId(state.active)) : null;
    node?.scrollIntoView({ block: 'nearest' });
  }

  function setActive(index) {
    if (!state.rows.length) return;
    const previous = document.getElementById(optionId(state.active));
    state.active = (index + state.rows.length) % state.rows.length;
    if (previous) { previous.classList.remove('is-active'); previous.setAttribute('aria-selected', 'false'); previous.querySelector('.atlas-palette__hint:not(:has(kbd + kbd))')?.remove(); }
    const next = document.getElementById(optionId(state.active));
    if (next) {
      next.classList.add('is-active');
      next.setAttribute('aria-selected', 'true');
      if (!next.querySelector('.atlas-palette__hint')) next.insertAdjacentHTML('beforeend', '<span class="atlas-palette__hint"><kbd class="kbd">↵</kbd></span>');
    }
    input.setAttribute('aria-activedescendant', optionId(state.active));
    scrollActive();
  }

  // Tab / Shift+Tab jump to the first row of the next / previous section.
  function jumpSection(direction) {
    if (!state.rows.length) return;
    const starts = [];
    state.rows.forEach((row, index) => { if (index === 0 || state.rows[index - 1].section !== row.section) starts.push(index); });
    const current = state.active < 0 ? -1 : starts.filter((start) => start <= state.active).length - 1;
    const next = (current + direction + starts.length) % starts.length;
    setActive(starts[next]);
  }

  function runRow(index) {
    const row = state.rows[index];
    if (!row) return;
    if (row.kind === 'more') { row.run(); return; }
    close({ restoreFocus: false });
    try { row.run(); } catch (error) { console.error('Palette row failed', error); }
  }

  // ---------- instant answers (AtlasSearch.answerFor) ----------

  function scheduleAnswer() {
    window.clearTimeout(state.answerTimer);
    const query = normalize(state.query);
    const intent = query ? window.AtlasSearch?.detectIntent?.(query) : null;
    if (!intent) { if (state.answer) { state.answer = null; render(); } return; }
    const token = ++state.answerToken;
    state.answerTimer = window.setTimeout(async () => {
      let answer = null;
      try { answer = await window.AtlasSearch.answerFor(query); } catch (error) { console.error('Instant answer failed', error); }
      if (token !== state.answerToken || !state.open) return;
      state.answer = answer;
      render();
    }, 160);
  }

  // ---------- open / close ----------

  function ensure() {
    if (layer) return;
    layer = document.createElement('div');
    layer.id = 'atlas-palette';
    layer.className = 'atlas-layer atlas-layer--palette';
    layer.hidden = true;
    layer.innerHTML = `<div class="atlas-scrim" data-palette-close></div>
      <section class="atlas-palette" role="dialog" aria-modal="true" aria-label="Search and quick actions">
        <div class="atlas-palette__input">
          ${icon('search', { size: 18 })}
          <input type="text" id="atlas-palette-input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="atlas-palette-list" aria-label="Search or ask Atlas" placeholder="Search or ask Atlas" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
          <span class="atlas-palette__ctx" hidden></span>
          <button type="button" class="atlas-palette__close" data-palette-close>Cancel</button>
        </div>
        <div class="atlas-palette__body" id="atlas-palette-list" role="listbox" aria-label="Results"></div>
        <footer class="atlas-palette__foot" aria-hidden="true">
          <span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd>Move</span><span><kbd class="kbd">↵</kbd>Open</span><span><kbd class="kbd">${IS_MAC ? '⌘' : 'Ctrl'}↵</kbd>Ask Atlas</span><span><kbd class="kbd">Tab</kbd>Next section</span><span><kbd class="kbd">esc</kbd>Close</span>
        </footer>
      </section>`;
    document.body.appendChild(layer);
    input = layer.querySelector('input');
    list = layer.querySelector('.atlas-palette__body');

    input.addEventListener('input', () => {
      state.query = input.value;
      state.expanded.clear();
      state.rows = [];
      render();
      scheduleAnswer();
    });
    input.addEventListener('keydown', onInputKeydown);
    layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab' && event.target !== input) { event.preventDefault(); input.focus(); }
    });
    layer.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-palette-close]')) { close(); return; }
      if (target.closest('[data-palette-answer-action]')) { const action = state.answer?.action; close({ restoreFocus: false }); action?.run?.(); return; }
      const option = target.closest('[data-palette-index]');
      if (option) runRow(Number(option.dataset.paletteIndex));
    });
    list.addEventListener('mousemove', (event) => {
      const option = event.target instanceof Element ? event.target.closest('[data-palette-index]') : null;
      if (option && Number(option.dataset.paletteIndex) !== state.active) setActive(Number(option.dataset.paletteIndex));
    });
    list.addEventListener('mousedown', (event) => event.preventDefault());
  }

  function onInputKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(state.active + (event.key === 'ArrowDown' ? 1 : -1)); return; }
    if (event.key === 'Home' && event.ctrlKey) { event.preventDefault(); setActive(0); return; }
    if (event.key === 'End' && event.ctrlKey) { event.preventDefault(); setActive(state.rows.length - 1); return; }
    if (event.key === 'Tab') { event.preventDefault(); jumpSection(event.shiftKey ? -1 : 1); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) { close({ restoreFocus: false }); askAtlas(state.query); return; }
      if (state.active >= 0) runRow(state.active);
      return;
    }
    if (event.key === 'Backspace' && !input.value && state.context) {
      event.preventDefault();
      state.context = null;
      syncContext();
      render();
    }
  }

  function syncContext() {
    const tag = layer.querySelector('.atlas-palette__ctx');
    tag.hidden = !state.context;
    tag.textContent = state.context?.label || '';
    tag.title = state.context ? `Suggestions for ${state.context.label}. Backspace removes it.` : '';
  }

  function open({ mode = 'search', query = '', trigger = null } = {}) {
    ensure();
    window.AtlasChrome?.closeMore?.();
    window.AtlasChrome?.closeAccountMenu?.({ restoreFocus: false });
    if (shell.notify.isOpen()) shell.notify.close({ restoreFocus: false });
    state.open = true;
    state.mode = mode;
    state.query = query;
    state.answer = null;
    state.expanded.clear();
    state.rows = [];
    state.trigger = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const current = shell.nav.forRoute(window.location.hash) || shell.nav.forView(shell.current());
    state.context = current && current.id !== 'settings' ? current : null;
    input.value = query;
    input.placeholder = mode === 'actions' ? 'Search actions' : 'Search or ask Atlas';
    syncContext();
    layer.classList.toggle('is-phone', PHONE.matches);
    layer.hidden = false;
    document.body.classList.add('atlas-palette-open');
    render();
    input.focus();
    if (query) scheduleAnswer();
  }

  function close({ restoreFocus = true } = {}) {
    if (!layer || layer.hidden) return;
    state.open = false;
    window.clearTimeout(state.answerTimer);
    state.answerToken += 1;
    layer.hidden = true;
    document.body.classList.remove('atlas-palette-open');
    list.innerHTML = '';
    if (restoreFocus && state.trigger?.isConnected) state.trigger.focus();
  }

  // ---------- triggers ----------

  function isTyping(target) {
    const element = target instanceof Element ? target : null;
    return Boolean(element?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }

  function signedIn() {
    const app = document.getElementById('app-screen');
    return Boolean(app && window.getComputedStyle(app).display !== 'none');
  }

  document.addEventListener('keydown', (event) => {
    if (!signedIn()) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.open) close(); else open({ trigger: document.activeElement });
      return;
    }
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !state.open && !isTyping(event.target)) {
      event.preventDefault();
      open({ trigger: document.activeElement });
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const trigger = target?.closest('#atlas-omni, #atlas-phone-search, #atlas-quick-actions');
    if (!trigger) return;
    event.preventDefault();
    open({ mode: trigger.id === 'atlas-quick-actions' ? 'actions' : 'search', trigger });
  });

  PHONE.addEventListener('change', () => { if (state.open) layer.classList.toggle('is-phone', PHONE.matches); });

  window.AtlasPalette = { open, close, isOpen: () => state.open, clearRecent: () => clearRecent() };
})();
