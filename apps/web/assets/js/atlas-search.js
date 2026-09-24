(function () {
  'use strict';

  // Global Search / Ask Atlas.
  //
  // One owner for the top-bar field. Typing only shows results; nothing
  // navigates until a result is chosen with Enter, click or tap. Records come
  // from data other modules have already loaded, and answers reuse the same
  // shared truth those modules show (AtlasStockTruth.belowPar, AtlasRecipes
  // .recipeStatus, AtlasOperations.orderSuggestions, the Shifts snapshot).
  // When the source data is not available, the answer says so instead of
  // guessing.

  const MAX_PER_GROUP = 5;
  const VENUE_TIME_ZONE = 'Atlantic/Reykjavik';

  const PAGES = [
    ['dashboard', 'Home', ['home', 'dashboard', 'today']],
    ['operations', 'Operations', ['operations', 'opening', 'checks', 'readiness']],
    ['inventory', 'Inventory', ['inventory', 'item', 'items', 'stock', 'count']],
    ['recipes', 'Recipes', ['recipe', 'recipes', 'cocktail', 'menu']],
    ['suppliers', 'Purchasing', ['supplier', 'suppliers', 'order', 'orders', 'purchase', 'purchasing', 'delivery']],
    ['team', 'Messages', ['message', 'messages', 'chat', 'team']],
    ['team-profiles', 'Team', ['profile', 'profiles', 'staff', 'team member', 'directory']],
    ['shifts', 'Shifts', ['shift', 'shifts', 'schedule', 'rota']],
    ['knowledge', 'Knowledge', ['knowledge', 'document', 'documents', 'checklist', 'sop', 'policy', 'training']],
    ['marketing', 'Marketing', ['marketing', 'social', 'instagram', 'facebook']],
    ['brain', 'Atlas Brain', ['brain', 'briefing', 'daily briefing', 'intelligence']],
    ['business', 'Business Intelligence', ['business', 'profit', 'margin', 'spend']],
    ['reports', 'Reports', ['report', 'reports', 'analytics', 'valuation']],
    ['imports', 'Import', ['import', 'excel', 'csv', 'upload']],
    ['movements', 'Inventory movements', ['movement', 'movements']],
    ['waste', 'Waste', ['waste', 'spoilage', 'breakage']],
    ['system', 'System', ['system', 'health', 'status']],
    ['settings', 'Settings', ['setting', 'settings', 'preferences']]
  ];
  const COMMANDS = [
    ['stock-count', 'Start a stock count', ['stock count', 'count stock', 'start count']],
    ['settings:notifications', 'Notification settings', ['notification', 'notifications', 'alerts', 'push']],
    ['settings:preferences', 'My preferences', ['preference', 'preferences', 'start view', 'reduce motion']],
    ['settings:general', 'Venue & opening hours', ['opening hours', 'business hours', 'hours', 'venue']]
  ];

  const state = { results: [], answer: null, active: -1, token: 0, timer: null };
  let input = null;
  let panel = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function normalize(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function score(haystack, query) {
    const text = normalize(haystack);
    const q = normalize(query);
    if (!q || !text) return 0;
    if (text === q) return 100;
    if (text.startsWith(q)) return 80;
    if (text.split(' ').some((word) => word.startsWith(q))) return 60;
    if (text.includes(q)) return 40;
    const tokens = q.split(' ').filter(Boolean);
    if (tokens.length > 1 && tokens.every((token) => text.includes(token))) return 30;
    return 0;
  }

  function globalList(name) {
    // Loaded records are read through the shell's read-only accessor.
    const value = window.AtlasData?.[name]?.();
    return Array.isArray(value) ? value : null;
  }

  function inventory() {
    return (globalList('items') || []).filter((item) => item.active !== false);
  }

  function recipes() {
    return (globalList('recipes') || []).filter((recipe) => recipe && recipe.name);
  }

  function isManager() {
    return Boolean(window.atlasCanManageCommercial?.());
  }

  function navVisible(view) {
    const button = document.querySelector(`.atlas-nav .nav-item[data-view="${view}"]`);
    return Boolean(button && button.offsetParent !== null);
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(number);
  }

  function venueDate(offsetDays = 0) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: VENUE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const date = new Date(`${parts}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  function stockLine(item) {
    const truth = window.AtlasStockTruth;
    if (!truth?.known(item)) return 'Not counted — no verified stock';
    const low = truth.belowPar(item) ? ' · below par' : '';
    const due = item.stock_recount_due ? ' · recount due' : '';
    return `${formatNumber(item.quantity)} ${item.unit || 'units'}${low}${due}`;
  }

  // ---------- record results ----------

  function pageResults(query) {
    const pages = PAGES
      .filter(([view]) => navVisible(view))
      .map(([view, label, words]) => ({ view, label, value: Math.max(score(label, query), ...words.map((word) => score(word, query))) }))
      .filter((entry) => entry.value >= 40)
      .map((entry) => ({ group: 'Pages', title: entry.label, detail: 'Open page', icon: 'arrow-right', score: entry.value, run: () => openView(entry.view) }));
    const commands = COMMANDS
      .filter(([key]) => (key === 'stock-count' ? navVisible('inventory') : true))
      .map(([key, label, words]) => ({ key, label, value: Math.max(score(label, query), ...words.map((word) => score(word, query))) }))
      .filter((entry) => entry.value >= 40)
      .map((entry) => ({ group: 'Pages', title: entry.label, detail: 'Command', icon: 'corner-down-right', score: entry.value - 1, run: () => runCommand(entry.key) }));
    return [...pages, ...commands];
  }

  function inventoryResults(query) {
    return inventory()
      .map((item) => ({ item, value: Math.max(score(item.name, query), score(item.supplier, query) - 20, score(item.sku, query), score(item.category, query) - 30) }))
      .filter((entry) => entry.value >= 30)
      .map((entry) => ({ group: 'Inventory', title: entry.item.name, detail: stockLine(entry.item), icon: 'package', score: entry.value, run: () => openInventoryItem(entry.item) }));
  }

  function recipeResults(query) {
    return recipes()
      .map((recipe) => ({ recipe, value: score(recipe.name, query) }))
      .filter((entry) => entry.value >= 30)
      .map((entry) => {
        const status = window.AtlasRecipes?.recipeStatus?.(entry.recipe);
        return { group: 'Recipes', title: entry.recipe.name, detail: status?.label || 'Recipe', icon: 'martini', score: entry.value, run: () => window.AtlasRecipes?.openRecipe?.(entry.recipe.id) };
      });
  }

  function supplierResults(query) {
    if (!isManager()) return [];
    return (globalList('suppliers') || [])
      .map((supplier) => ({ supplier, value: score(supplier.name, query) }))
      .filter((entry) => entry.value >= 40)
      .map((entry) => ({ group: 'Suppliers', title: entry.supplier.name, detail: entry.supplier.contact_name || entry.supplier.email || 'Supplier', icon: 'truck', score: entry.value, run: () => openSupplier(entry.supplier) }));
  }

  function people() {
    const seen = new Map();
    const add = (id, name, role) => {
      if (!name || seen.has(normalize(name))) return;
      seen.set(normalize(name), { id, name, role });
    };
    const shifts = window.AtlasShifts?.snapshot?.();
    (shifts?.people || []).filter((person) => person.active !== false).forEach((person) => add(person.profile_id || person.id, person.display_name, person.default_role));
    const team = window.AtlasTeamProfiles?.snapshot?.();
    (team?.profiles || []).filter((profile) => profile.active !== false).forEach((profile) => add(profile.id, profile.display_name || profile.preferred_name, profile.role));
    return [...seen.values()];
  }

  function teamResults(query) {
    return people()
      .map((person) => ({ person, value: score(person.name, query) }))
      .filter((entry) => entry.value >= 40)
      .map((entry) => ({ group: 'Team', title: entry.person.name, detail: entry.person.role || 'Team member', icon: 'user-round', score: entry.value, run: () => openPerson(entry.person) }));
  }

  function knowledgeResults(query) {
    const articles = window.AtlasKnowledge?.snapshot?.()?.articles || [];
    const matches = articles
      .map((article) => ({ article, value: Math.max(score(article.title, query), score(article.category_name, query) - 20, score(article.summary, query) - 30) }))
      .filter((entry) => entry.value >= 30)
      .map((entry) => ({ group: 'Knowledge', title: entry.article.title, detail: entry.article.category_name || 'Knowledge', icon: 'book-open', score: entry.value, run: () => window.AtlasKnowledge?.openArticle?.(entry.article.id) }));
    if (!matches.length && navVisible('knowledge') && normalize(query).length >= 3 && !detectIntent(query)) {
      matches.push({ group: 'Knowledge', title: `Search Knowledge for “${query}”`, detail: 'Documents are searched inside Knowledge', icon: 'book-open', score: 1, run: () => openKnowledgeSearch(query) });
    }
    return matches;
  }

  function settingsResults(query) {
    const tabs = [['general', 'Venue & hours'], ['access', 'Team access'], ['notifications', 'Notifications'], ['operations', 'Operational rules'], ['intelligence', 'Marketing & Brain'], ['integrations', 'Integrations'], ['security', 'Security'], ['preferences', 'Preferences'], ['activity', 'Settings activity']];
    return tabs
      .map(([tab, label]) => ({ tab, label, value: score(label, query) }))
      .filter((entry) => entry.value >= 60)
      .map((entry) => ({ group: 'Settings', title: entry.label, detail: 'Settings', icon: 'settings', score: entry.value - 5, run: () => runCommand(`settings:${entry.tab}`) }));
  }

  // ---------- Ask Atlas answers ----------

  function detectIntent(raw) {
    const q = normalize(raw);
    if (!q) return null;
    let match;
    if ((match = /^(?:can|could) (?:we|i|you) (?:make|serve|do|pour) (?:a |an |the |some )?(.+)$/.exec(q))) return { kind: 'can-make', subject: match[1] };
    if ((match = /^how (?:many|much) (.+?)(?: (?:do we have|we have|are there|is there|remain|remaining|left|in stock|remain in stock))+$/.exec(q)) || (match = /^how (?:many|much) (.+)$/.exec(q))) return { kind: 'how-many', subject: match[1] };
    if (/\b(what|which)\b.*\b(order|reorder|buy|purchase)\b|\bneeds? (ordering|to be ordered)\b|\bshopping list\b/.test(q)) return { kind: 'ordering' };
    if (/\b(low|below par|running (out|low)|short)\b/.test(q) && /\b(stock|inventory|what|which|items?)\b/.test(q)) return { kind: 'low-stock' };
    if ((match = /^who(?: s| is)? (?:works?|working|on shift|on|scheduled|in)(?: (today|tonight|tomorrow))?/.exec(q))) return { kind: 'who-works', day: match[1] === 'tomorrow' ? 1 : 0 };
    return null;
  }

  function stripUnits(subject) {
    return subject.replace(/\b(bottles?|units?|cases?|kegs?|cans?|litres?|liters?|kg|kilos?|of|do|we|have|are|there|remain(ing)?|left|in|stock)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function answerLowStock() {
    const list = inventory();
    if (!list.length) return { text: 'Inventory has not loaded yet, so Atlas cannot say what is low.', tone: 'unknown' };
    const truth = window.AtlasStockTruth;
    const counted = list.filter((item) => truth.known(item));
    const low = list.filter((item) => truth.belowPar(item))
      .sort((a, b) => (Number(a.quantity) / Number(a.par_level)) - (Number(b.quantity) / Number(b.par_level)));
    const unknown = list.length - counted.length;
    const unknownNote = unknown ? ` ${unknown} ${unknown === 1 ? 'item has' : 'items have'} no verified count, so ${unknown === 1 ? 'it is' : 'they are'} not included.` : '';
    if (!counted.length) return { text: `No item has a verified count yet, so Atlas cannot tell what is low.${unknownNote}`, tone: 'unknown', action: { label: 'Start a stock count', run: () => runCommand('stock-count') } };
    if (!low.length) return { text: `Nothing with a verified count is below par.${unknownNote}`, tone: 'good' };
    const lines = low.slice(0, 6).map((item) => `${item.name}: ${formatNumber(item.quantity)} of ${formatNumber(item.par_level)} ${item.unit || 'units'}`);
    return { text: `${low.length} ${low.length === 1 ? 'item is' : 'items are'} below par.${unknownNote}`, lines, tone: 'warn', action: { label: 'Open Inventory', run: () => openView('inventory') } };
  }

  function findRecipe(subject) {
    const target = normalize(subject.replace(/\b(cocktails?|drinks?|tonight|today|now)\b/g, ' '));
    const ranked = recipes()
      .map((recipe) => ({ recipe, value: score(recipe.name, target) }))
      .filter((entry) => entry.value >= 40)
      .sort((a, b) => b.value - a.value || (a.recipe.active === false) - (b.recipe.active === false));
    return ranked[0]?.recipe || null;
  }

  function answerCanMake(subject) {
    if (!recipes().length) return { text: 'Recipes have not loaded yet, so Atlas cannot check this.', tone: 'unknown' };
    const recipe = findRecipe(subject);
    if (!recipe) return { text: `Atlas has no recipe matching “${subject}”.`, tone: 'unknown' };
    const status = window.AtlasRecipes?.recipeStatus?.(recipe);
    if (!status) return { text: `Atlas could not read readiness for ${recipe.name}.`, tone: 'unknown' };
    const availability = status.availability || {};
    const limiting = availability.limiting?.item?.name || availability.limiting?.ingredient?.item_name || null;
    const open = { label: `Open ${recipe.name}`, run: () => window.AtlasRecipes?.openRecipe?.(recipe.id) };
    if (status.key === 'draft') return { text: `${recipe.name} is inactive, so it is not on service.`, tone: 'unknown', action: open };
    if (status.key === 'unavailable') return { text: `No — ${recipe.name} cannot be made from verified stock${limiting ? `; ${limiting} has run out` : ''}.`, tone: 'bad', action: open };
    if (status.key === 'incomplete') {
      const blockers = window.AtlasRecipes?.recipeBlockers?.(recipe) || [];
      const detail = blockers.length ? blockers.map((entry) => `${entry.name} — ${entry.reason}`).join('; ') : 'its ingredients cannot be checked against verified stock';
      return { text: `Atlas cannot confirm ${recipe.name}: ${detail}.`, tone: 'unknown', action: open };
    }
    const servings = Number(availability.servings);
    const count = Number.isFinite(servings) ? ` About ${servings} ${servings === 1 ? 'serving' : 'servings'} from verified stock` : '';
    if (status.key === 'attention') return { text: `Yes, but availability is low.${count}${limiting ? `; ${limiting} runs out first` : ''}.`, tone: 'warn', action: open };
    return { text: `Yes.${count}${limiting ? `; ${limiting} runs out first` : ''}.`, tone: 'good', action: open };
  }

  function answerHowMany(subject) {
    const list = inventory();
    if (!list.length) return { text: 'Inventory has not loaded yet, so Atlas cannot answer this.', tone: 'unknown' };
    const target = stripUnits(subject);
    if (!target) return null;
    const matches = list
      .map((item) => ({ item, value: Math.max(score(item.name, target), score(`${item.brand || ''} ${item.name}`, target)) }))
      .filter((entry) => entry.value >= 30)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
      .map((entry) => entry.item);
    if (!matches.length) return { text: `Atlas has no inventory item matching “${target}”.`, tone: 'unknown' };
    if (matches.length === 1) {
      const item = matches[0];
      const known = window.AtlasStockTruth?.known(item);
      return {
        text: known ? `${item.name}: ${stockLine(item)}.` : `${item.name} has no verified count, so Atlas does not know how many remain.`,
        tone: known ? (window.AtlasStockTruth.belowPar(item) ? 'warn' : 'good') : 'unknown',
        action: { label: `Show ${item.name}`, run: () => openInventoryItem(item) }
      };
    }
    return { text: `${matches.length} items match “${target}”:`, lines: matches.map((item) => `${item.name}: ${stockLine(item)}`), tone: 'neutral' };
  }

  function answerOrdering() {
    if (!inventory().length) return { text: 'Inventory has not loaded yet, so Atlas cannot build an order list.', tone: 'unknown' };
    const suggestions = window.AtlasOperations?.orderSuggestions?.();
    if (!Array.isArray(suggestions)) return { text: 'Order suggestions are not available on this page yet.', tone: 'unknown' };
    const open = suggestions.filter((entry) => !entry.ordered);
    const unknown = inventory().filter((item) => !window.AtlasStockTruth?.known(item)).length;
    const unknownNote = unknown ? ` Items without a verified count (${unknown}) are not included.` : '';
    if (!open.length) return { text: `Nothing needs ordering based on verified stock.${unknownNote}`, tone: 'good' };
    const lines = open.slice(0, 6).map((entry) => `${entry.name}: ${formatNumber(entry.orderQuantity)} ${entry.unit} · ${entry.supplier}`);
    return {
      text: `${open.length} ${open.length === 1 ? 'item needs' : 'items need'} ordering (suggested quantities restore twice the par level).${unknownNote}`,
      lines,
      tone: 'warn',
      action: navVisible('suppliers') ? { label: 'Open Purchasing', run: () => openView('suppliers') } : { label: 'Open Operations', run: () => openView('operations') }
    };
  }

  async function answerWhoWorks(offset) {
    const shifts = window.AtlasShifts;
    if (!shifts) return { text: 'The schedule is not available on this device.', tone: 'unknown' };
    if (!shifts.snapshot?.()) {
      try { await Promise.race([shifts.refresh?.(), new Promise((resolve) => setTimeout(resolve, 6000))]); } catch { /* reported below */ }
    }
    const workspace = shifts.snapshot?.();
    const dayLabel = offset ? 'tomorrow' : 'today';
    if (!workspace) return { text: `Atlas could not load the schedule, so it cannot say who works ${dayLabel}.`, tone: 'unknown', action: { label: 'Open Shifts', run: () => openView('shifts') } };
    const date = venueDate(offset);
    const weekStart = String(workspace.week?.week_start || shifts.week?.() || '');
    const weekEnd = weekStart ? new Date(`${weekStart}T12:00:00Z`) : null;
    if (weekEnd) weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    if (weekStart && (date < weekStart || date > weekEnd.toISOString().slice(0, 10))) {
      return { text: `${dayLabel[0].toUpperCase()}${dayLabel.slice(1)} is outside the week open in Shifts, so Atlas has not loaded it.`, tone: 'unknown', action: { label: 'Open Shifts', run: () => openView('shifts') } };
    }
    const peopleById = new Map((workspace.people || []).map((person) => [person.id, person]));
    const entries = (workspace.shifts || [])
      .filter((shift) => String(shift.starts_local || '').slice(0, 10) === date)
      .sort((a, b) => String(a.starts_local).localeCompare(String(b.starts_local)));
    const draft = workspace.week?.status !== 'published';
    const draftNote = draft ? ' This week is not published yet, so the schedule may still change.' : '';
    if (!entries.length) return { text: `Nobody is scheduled ${dayLabel}.${draftNote}`, tone: 'neutral', action: { label: 'Open Shifts', run: () => openView('shifts') } };
    const lines = entries.map((shift) => `${peopleById.get(shift.person_id)?.display_name || shift.person_name || 'Team member'}: ${String(shift.starts_local).slice(11, 16)}–${String(shift.ends_local).slice(11, 16)}${shift.role_name ? ` · ${shift.role_name}` : ''}`);
    return { text: `${entries.length} ${entries.length === 1 ? 'person works' : 'people work'} ${dayLabel}.${draftNote}`, lines, tone: draft ? 'warn' : 'good', action: { label: 'Open Shifts', run: () => openView('shifts') } };
  }

  async function answerFor(query) {
    const intent = detectIntent(query);
    if (!intent) return null;
    if (intent.kind === 'low-stock') return answerLowStock();
    if (intent.kind === 'can-make') return answerCanMake(intent.subject);
    if (intent.kind === 'how-many') return answerHowMany(intent.subject);
    if (intent.kind === 'ordering') return answerOrdering();
    if (intent.kind === 'who-works') return answerWhoWorks(intent.day);
    return null;
  }

  // ---------- navigation ----------

  function openView(view) {
    const button = document.querySelector(`.atlas-nav .nav-item[data-view="${view}"]`);
    if (button) button.click();
    else if (typeof window.setActiveView === 'function') window.setActiveView(view);
  }

  function runCommand(key) {
    if (key === 'stock-count') {
      openView('inventory');
      window.setTimeout(() => document.querySelector('[data-inventory-section="stock-count"]')?.click(), 60);
      return;
    }
    if (key.startsWith('settings:')) {
      openView('settings');
      const tab = key.slice('settings:'.length);
      window.setTimeout(() => window.AtlasSettings?.tab?.(tab), 80);
    }
  }

  function openInventoryItem(item) {
    openView('inventory');
    window.setTimeout(() => {
      const search = document.getElementById('inventory-search');
      if (search) {
        search.value = item.name;
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const row = document.querySelector(`#items-body [data-id="${CSS.escape(item.id)}"]`)?.closest('tr');
      if (row) {
        row.classList.add('atlas-search-highlight');
        row.scrollIntoView({ block: 'center' });
        window.setTimeout(() => row.classList.remove('atlas-search-highlight'), 2400);
      }
    }, 80);
  }

  function openSupplier(supplier) {
    openView('suppliers');
    window.setTimeout(() => {
      const search = document.getElementById('supplier-search');
      if (!search) return;
      search.value = supplier.name;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }, 80);
  }

  function openPerson(person) {
    if (window.AtlasTeamProfiles?.openProfile && person.id) window.AtlasTeamProfiles.openProfile(person.id);
    else openView('team-profiles');
  }

  function openKnowledgeSearch(query) {
    openView('knowledge');
    window.setTimeout(() => {
      const search = document.querySelector('#knowledge-view [data-knowledge-search]');
      if (!search) return;
      search.value = query;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }, 300);
  }

  // ---------- rendering ----------

  function collect(query) {
    const groups = [pageResults, inventoryResults, recipeResults, supplierResults, teamResults, knowledgeResults, settingsResults]
      .flatMap((source) => {
        try { return source(query).sort((a, b) => b.score - a.score).slice(0, MAX_PER_GROUP); } catch { return []; }
      });
    return groups;
  }

  function answerMarkup(answer) {
    if (!answer) return '';
    return `<section class="atlas-search-answer is-${escapeHtml(answer.tone || 'neutral')}" aria-live="polite">
      <span class="atlas-search-answer-label"><i data-lucide="sparkles"></i>Atlas</span>
      <p>${escapeHtml(answer.text)}</p>
      ${answer.lines?.length ? `<ul>${answer.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
      ${answer.action ? `<button type="button" class="atlas-search-answer-action" data-atlas-search-answer-action>${escapeHtml(answer.action.label)}<i data-lucide="arrow-right"></i></button>` : ''}
    </section>`;
  }

  function render(query) {
    if (!panel) return;
    const answer = state.answer;
    const results = state.results;
    if (!query) { close(); return; }
    let lastGroup = '';
    const options = results.map((result, index) => {
      const header = result.group !== lastGroup ? `<li class="atlas-search-group" role="presentation">${escapeHtml(result.group)}</li>` : '';
      lastGroup = result.group;
      return `${header}<li id="atlas-search-option-${index}" role="option" class="atlas-search-option ${index === state.active ? 'is-active' : ''}" aria-selected="${index === state.active}" data-atlas-search-index="${index}"><i data-lucide="${escapeHtml(result.icon)}"></i><span><strong>${escapeHtml(result.title)}</strong><small>${escapeHtml(result.detail)}</small></span></li>`;
    }).join('');
    const empty = !results.length && !answer
      ? '<p class="atlas-search-empty">No matches. Try an item, recipe, supplier, person or page — or ask “What is low in stock?”</p>'
      : '';
    panel.innerHTML = `${answerMarkup(answer)}${options ? `<ul role="listbox" aria-label="Search results">${options}</ul>` : ''}${empty}`;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (state.active >= 0) input.setAttribute('aria-activedescendant', `atlas-search-option-${state.active}`);
    else input.removeAttribute('aria-activedescendant');
    window.lucide?.createIcons?.();
  }

  function close() {
    if (!panel) return;
    panel.hidden = true;
    panel.innerHTML = '';
    state.active = -1;
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
  }

  async function update() {
    const query = input.value.trim();
    const token = ++state.token;
    state.active = -1;
    state.results = query ? collect(query) : [];
    const intent = detectIntent(query);
    state.answer = intent && intent.kind !== 'who-works' ? await answerFor(query) : null;
    if (intent?.kind === 'who-works') state.answer = { text: 'Press Enter to check the schedule.', tone: 'neutral' };
    if (token !== state.token) return;
    render(query);
  }

  function choose(index) {
    const result = state.results[index];
    if (!result) return;
    close();
    input.value = '';
    input.blur();
    result.run();
  }

  async function submit() {
    // A pending keystroke refresh must not overwrite the submitted answer.
    window.clearTimeout(state.timer);
    const query = input.value.trim();
    if (!query) return;
    if (state.active >= 0) { choose(state.active); return; }
    const intent = detectIntent(query);
    if (intent) {
      const token = ++state.token;
      state.answer = { text: 'Checking…', tone: 'neutral' };
      render(query);
      const answer = await answerFor(query);
      if (token !== state.token) return;
      state.answer = answer || { text: 'Atlas could not answer that from the data it has.', tone: 'unknown' };
      render(query);
      return;
    }
    if (state.results.length) choose(0);
  }

  function handleKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!state.results.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      state.active = (state.active + step + state.results.length) % state.results.length;
      render(input.value.trim());
      document.getElementById(`atlas-search-option-${state.active}`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (input.value) { input.value = ''; close(); } else input.blur();
    }
  }

  function init() {
    input = document.getElementById('global-search');
    if (!input || input.dataset.atlasSearchReady === 'true') return;
    input.dataset.atlasSearchReady = 'true';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'atlas-search-panel');
    input.setAttribute('aria-label', 'Search Atlas or ask a question');
    input.title = 'Search items, recipes, suppliers, people, documents and pages, or ask a question';
    input.dataset.searchScope = 'records';
    panel = document.createElement('div');
    panel.id = 'atlas-search-panel';
    panel.className = 'atlas-search-panel';
    panel.hidden = true;
    input.closest('.atlas-search')?.appendChild(panel);

    input.addEventListener('input', () => {
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(update, 80);
    });
    input.addEventListener('focus', () => { if (input.value.trim()) update(); });
    input.addEventListener('keydown', handleKeydown);
    panel.addEventListener('mousedown', (event) => event.preventDefault());
    panel.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const option = target?.closest('[data-atlas-search-index]');
      if (option) { choose(Number(option.dataset.atlasSearchIndex)); return; }
      if (target?.closest('[data-atlas-search-answer-action]')) {
        const action = state.answer?.action;
        close();
        input.value = '';
        action?.run();
      }
    });
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.atlas-search')) close();
    });
  }

  window.AtlasSearch = { detectIntent, answerFor, results: (query) => collect(query) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
