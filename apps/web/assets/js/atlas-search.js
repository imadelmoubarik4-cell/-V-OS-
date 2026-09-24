(function () {
  'use strict';

  // Search provider for the command palette (assets/js/atlas-palette.js,
  // spec §4.6–4.7): records, destinations ("Go to") and instant answers.
  //
  // It renders nothing itself. Records come from data other modules have
  // already loaded, and answers reuse the same shared truth those modules show
  // (AtlasStockTruth.belowPar, AtlasRecipes.recipeStatus,
  // AtlasOperations.orderSuggestions, the Shifts snapshot). When the source
  // data is not available, the answer says so instead of guessing. Role rules
  // come from AtlasShell.nav (spec §3.3): a hidden destination is never a
  // result.

  const MAX_PER_GROUP = 5;
  const VENUE_TIME_ZONE = 'Atlantic/Reykjavik';

  // Destinations and their sections: [nav id, label, route, keywords, roles?].
  // Top-level pages come from AtlasShell.nav; these are the linkable tabs.
  const MANAGERS = ['admin', 'manager'];
  const SECTIONS = [
    ['ai', 'Atlas AI › Decisions', '#ai/decisions', ['decisions', 'recommendations', 'outcomes'], MANAGERS],
    ['inventory', 'Inventory › Stock count', '#inventory/counts', ['stock count', 'count stock', 'stocktake', 'counts']],
    ['inventory', 'Inventory › Movements', '#inventory/movements', ['movement', 'movements', 'history', 'ledger']],
    ['inventory', 'Inventory › Waste', '#inventory/waste', ['waste', 'spoilage', 'breakage']],
    ['purchasing', 'Purchasing › Orders', '#purchasing/orders', ['order', 'orders', 'purchase order']],
    ['purchasing', 'Purchasing › Deliveries', '#purchasing/deliveries', ['delivery', 'deliveries', 'receive', 'restock']],
    ['purchasing', 'Purchasing › Suppliers', '#purchasing/suppliers', ['supplier', 'suppliers', 'vendor']],
    ['shifts', 'Shifts › Month', '#shifts/month', ['month', 'calendar']],
    ['shifts', 'Shifts › Availability', '#shifts/availability', ['availability', 'available']],
    ['shifts', 'Shifts › Time off', '#shifts/time-off', ['time off', 'holiday', 'leave', 'vacation']],
    ['knowledge', 'Knowledge › Required reading', '#knowledge/required', ['required', 'reading', 'must read']],
    ['knowledge', 'Knowledge › Training', '#knowledge/training', ['training', 'onboarding']],
    ['reports', 'Reports › Overview', '#reports/overview', ['overview', 'business', 'profit', 'margin', 'spend']],
    ['reports', 'Reports › Stock', '#reports/stock', ['stock report', 'valuation', 'inventory report']],
    ['reports', 'Reports › Purchasing', '#reports/purchasing', ['purchasing report', 'spend']],
    ['reports', 'Reports › Recipes', '#reports/recipes', ['recipe report', 'margins']],
    ['reports', 'Reports › Waste', '#reports/waste', ['waste report']],
    ['reports', 'Reports › Labour', '#reports/labour', ['labour', 'labor', 'hours worked']],
    ['data', 'Data › Import review', '#data/import-review', ['import review', 'review', 'real data']],
    ['data', 'Data › Issues', '#data/issues', ['issues', 'data issues', 'fix']],
    ['data', 'Data › Par levels', '#data/pars', ['par', 'pars', 'par levels']],
    ['settings', 'Settings › Venue and opening hours', '#settings/general', ['opening hours', 'business hours', 'hours', 'venue']],
    ['settings', 'Settings › Team access', '#settings/access', ['access', 'roles', 'permissions', 'invite']],
    ['settings', 'Settings › Operational rules', '#settings/operations', ['rules', 'operational rules']],
    ['settings', 'Settings › Integrations', '#settings/integrations', ['integrations', 'connections']],
    ['settings', 'Settings › Security', '#settings/security', ['security', 'password', 'sessions']],
    ['settings', 'Settings › Activity', '#settings/activity', ['activity', 'audit']],
    ['settings', 'Settings › System health', '#settings/system', ['system', 'health', 'status'], ['admin']],
    // Everyone's own settings (spec §3.3: staff reach these from the account menu).
    ['account', 'Preferences', '#settings/preferences', ['preference', 'preferences', 'start view', 'reduce motion'], null],
    ['account', 'Notification settings', '#settings/notifications', ['notification', 'notifications', 'alerts', 'push'], null]
  ];

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

  function role() {
    return window.AtlasShell?.profile?.()?.role || window.atlasCurrentProfile?.role || null;
  }

  // A destination (nav id or internal view) the signed-in role may open.
  function navVisible(target) {
    return Boolean(window.AtlasShell?.nav ? window.AtlasShell.nav.allowed(target, role()) : true);
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

  // ---------- destinations ("Go to") ----------

  function destinations(query) {
    const q = normalize(query);
    const shell = window.AtlasShell;
    const pages = (shell?.nav?.items({ role: role() }) || []).map((item) => ({ id: item.id, label: item.label, route: item.route, icon: item.icon, words: item.keywords, allowed: true }));
    const sections = SECTIONS.map(([id, label, route, words, roles]) => ({
      id, label, route, words, icon: id === 'account' ? (route.endsWith('notifications') ? 'bell' : 'sliders-horizontal') : (shell?.nav?.get(id)?.icon || 'arrow-right'),
      allowed: roles === null ? Boolean(role()) : (roles ? roles.includes(role()) : navVisible(id)) && (id === 'account' || navVisible(id))
    }));
    return [...pages, ...sections]
      .filter((entry) => entry.allowed)
      .map((entry) => ({ entry, value: q ? Math.max(score(entry.label, q), score(entry.label.split(' › ').pop(), q), ...entry.words.map((word) => score(word, q) - 5)) : 1 }))
      .filter((match) => match.value >= 40 || (!q && match.value > 0))
      .sort((a, b) => b.value - a.value)
      .map(({ entry, value }) => ({ group: 'Go to', type: 'page', id: entry.route, title: entry.label, detail: '', icon: entry.icon, score: value, route: entry.route, run: () => openRoute(entry.route) }));
  }

  // ---------- record results ----------
  // Every result carries { type, id, route } so the palette can offer
  // record-aware actions ("Count Campari") and remember recent records.

  function inventoryResults(query) {
    return inventory()
      .map((item) => ({ item, value: Math.max(score(item.name, query), score(item.supplier, query) - 20, score(item.sku, query), score(item.category, query) - 30) }))
      .filter((entry) => entry.value >= 30)
      .map((entry) => ({ group: 'Items', type: 'inventory_item', id: String(entry.item.id), title: entry.item.name, detail: stockLine(entry.item), icon: 'package', score: entry.value, route: `#inventory/item/${encodeURIComponent(entry.item.id)}`, run: () => openInventoryItem(entry.item) }));
  }

  function recipeResults(query) {
    return recipes()
      .map((recipe) => ({ recipe, value: score(recipe.name, query) }))
      .filter((entry) => entry.value >= 30)
      .map((entry) => {
        const status = window.AtlasRecipes?.recipeStatus?.(entry.recipe);
        return { group: 'Recipes', type: 'recipe', id: String(entry.recipe.id), title: entry.recipe.name, detail: status?.label || 'Recipe', icon: 'martini', score: entry.value, route: `#recipes/${encodeURIComponent(entry.recipe.id)}`, run: () => window.AtlasRecipes?.openRecipe?.(entry.recipe.id) };
      });
  }

  function supplierResults(query) {
    if (!isManager() || !navVisible('purchasing')) return [];
    return (globalList('suppliers') || [])
      .map((supplier) => ({ supplier, value: score(supplier.name, query) }))
      .filter((entry) => entry.value >= 40)
      .map((entry) => ({ group: 'Suppliers', type: 'supplier', id: String(entry.supplier.id), title: entry.supplier.name, detail: entry.supplier.contact_name || entry.supplier.email || 'Supplier', icon: 'truck', score: entry.value, route: `#purchasing/suppliers/${encodeURIComponent(entry.supplier.id)}`, run: () => openSupplier(entry.supplier) }));
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
      .map((entry) => ({ group: 'People', type: 'person', id: String(entry.person.id || ''), title: entry.person.name, detail: entry.person.role || 'Team member', icon: 'user-round', score: entry.value, route: entry.person.id ? `#team/${encodeURIComponent(entry.person.id)}` : '#team', run: () => openPerson(entry.person) }));
  }

  function knowledgeResults(query) {
    const articles = window.AtlasKnowledge?.snapshot?.()?.articles || [];
    const matches = articles
      .map((article) => ({ article, value: Math.max(score(article.title, query), score(article.category_name, query) - 20, score(article.summary, query) - 30) }))
      .filter((entry) => entry.value >= 30)
      .map((entry) => ({ group: 'Articles', type: 'knowledge_article', id: String(entry.article.id), title: entry.article.title, detail: entry.article.category_name || 'Knowledge', icon: 'book-open', score: entry.value, route: `#knowledge/${encodeURIComponent(entry.article.id)}`, run: () => window.AtlasKnowledge?.openArticle?.(entry.article.id) }));
    if (!matches.length && navVisible('knowledge') && normalize(query).length >= 3 && !detectIntent(query)) {
      matches.push({ group: 'Articles', type: 'knowledge_search', id: `search:${query}`, title: `Search Knowledge for “${query}”`, detail: 'Documents are searched inside Knowledge', icon: 'book-open', score: 1, route: '#knowledge', run: () => openKnowledgeSearch(query) });
    }
    return matches;
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
    if (!counted.length) return { text: `No item has a verified count yet, so Atlas cannot tell what is low.${unknownNote}`, tone: 'unknown', action: { label: 'Start stock count', run: () => openRoute('#inventory/counts') } };
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

  // Results open through AtlasShell routes, the same #view/section?param links
  // Atlas AI records carry (#inventory/item/…, #settings/notifications).
  function openView(view, params = {}) {
    window.AtlasShell.show(view, params, { source: 'nav' });
  }

  function openRoute(route) {
    window.AtlasShell.navigate(route, { source: 'nav' });
  }

  // index.html's Inventory view opens ?item= links: it filters to the item and
  // highlights its row.
  function openInventoryItem(item) {
    openView('inventory', { item: item.id });
  }

  function openSupplier(supplier) {
    openView('suppliers', { section: 'suppliers' });
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

  // Opens a remembered record ({ type, id, title, route }) the way a fresh
  // result would (recent items in the palette).
  function openRecord(record = {}) {
    const id = record.id;
    if (record.type === 'inventory_item') { openView('inventory', { item: id }); return; }
    if (record.type === 'recipe' && window.AtlasRecipes?.openRecipe) { window.AtlasRecipes.openRecipe(id); return; }
    if (record.type === 'supplier') { openSupplier({ id, name: record.title }); return; }
    if (record.type === 'person') { openPerson({ id, name: record.title }); return; }
    if (record.type === 'knowledge_article' && window.AtlasKnowledge?.openArticle) { window.AtlasKnowledge.openArticle(id); return; }
    if (record.route) openRoute(record.route);
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

  // ---------- provider API ----------

  const RECORD_SOURCES = [inventoryResults, recipeResults, supplierResults, teamResults, knowledgeResults];

  // Records only, best first within each type (max 5 per type).
  function records(query) {
    if (!normalize(query)) return [];
    return RECORD_SOURCES.flatMap((source) => {
      try { return source(query).sort((a, b) => b.score - a.score).slice(0, MAX_PER_GROUP); } catch { return []; }
    });
  }

  // Records followed by destinations (the pre-palette shape, kept for callers).
  function collect(query) {
    return [...records(query), ...destinations(query).slice(0, MAX_PER_GROUP)];
  }

  window.AtlasSearch = { detectIntent, answerFor, results: (query) => collect(query), records, destinations, openRecord };
})();
