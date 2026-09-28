// Atlas Flavor Intelligence: the Flavor Map (#recipes/flavor[/<ingredient>])
// and the "Create with Atlas" flow on the Recipes page.
//
// Everything shown here comes from the deterministic atlas-ai flavour routes
// (docs/flavor/Engine.md §7): flavor-map, flavor-search, flavor-substitutes,
// flavor-candidates and flavor-compose. Nothing is saved until a manager taps
// Approve on the draft preview, which approves the stored proposal through the
// unchanged execute-action route; Discard rejects it (reject-action).
//
// Rules the page keeps:
//   - Stock is shown as the server reports it: verified in stock, verified
//     out, unknown (never zero), not stocked; a needs-review link is only a
//     "possible match" and never counts as stock.
//   - Evidence types stay separate and labelled (culinary, Atlas-learned,
//     scientific, AI interpretation); nothing is called scientific unless the
//     server says so.
//   - A filter the server does not offer (filters_available) is not shown.
//   - Staff (bartender, viewer) browse the map and substitutes; they never see
//     costs and cannot create or approve drafts.
//
// window.AtlasFlavorMap = { mount(root, { ingredient }), unmount(), openCreate(options), isMounted() }
(function () {
  'use strict';

  const USES = [['cocktail', 'Cocktails'], ['mocktail', 'Mocktails'], ['coffee', 'Coffee'], ['dessert', 'Desserts'], ['food', 'Food']];
  const EVIDENCE = {
    culinary: { label: 'Culinary', help: 'Curated bar and kitchen knowledge. A starting point, not laboratory data.' },
    atlas_learned: { label: 'Atlas-learned', help: 'Used together in your own Atlas recipes.' },
    scientific: { label: 'Scientific', help: 'From a published scientific source.' },
    ai_interpretation: { label: 'AI interpretation', help: 'Atlas AI’s reading. Check it before relying on it.' }
  };
  const RELATIONS = { complement: 'Complements', contrast: 'Contrasts', bridge: 'Bridges', substitute: 'Can replace' };
  const STOCK = {
    available: { label: 'Verified in stock', tone: 'positive' },
    out: { label: 'Not in stock', tone: 'danger' },
    unknown: { label: 'Stock unknown', tone: 'neutral' },
    not_stocked: { label: 'Not stocked in Atlas', tone: 'plain' }
  };
  const TYPES = [['', 'Any drink'], ['cocktail', 'Cocktail'], ['mocktail', 'Mocktail'], ['coffee', 'Coffee'], ['dessert', 'Dessert pairing'], ['food', 'Food pairing']];
  const GOALS = [['balanced', 'Best overall'], ['use_stock', 'Use what we have'], ['simple', 'Simplest to make'], ['novel', 'Most new to the menu'], ['low_cost', 'Lowest cost'], ['high_margin', 'Highest margin']];
  const FAMILIES = [['citrus', 'Citrus'], ['dairy', 'Dairy'], ['nut', 'Nuts'], ['egg', 'Egg'], ['coffee', 'Coffee'], ['chocolate', 'Chocolate'], ['liqueur', 'Liqueurs'], ['spirit', 'Spirits']];
  const ROLE_LABELS = { base: 'Base', sour: 'Sour', sweet: 'Sweet', top: 'Top', modifier: 'Modifier', bitters: 'Bitters', aperitif: 'Aperitif', sparkling: 'Sparkling', coffee: 'Coffee', milk: 'Milk', fruit: 'Fruit', syrup: 'Syrup', garnish: 'Garnish' };
  const MAP_LIMIT = 12;
  // Draft recipe type = a Recipes category slug (the engine's DRAFT_TYPE).
  const DRAFT_TYPES = { 'signature-cocktail': 'Signature cocktail', mocktail: 'Mocktail', coffee: 'Coffee' };

  // Fixed copy per failure (AtlasApi.request never shows server text).
  const MAP_MESSAGES = {
    not_found: 'That ingredient isn’t in the flavour library. Search for another one.',
    forbidden: 'Your Atlas role can’t open the Flavor Map.',
    rate_limited: 'Too many flavour requests in a minute. Wait a moment, then try again.',
    unavailable: 'The flavour library isn’t available right now. Nothing was changed. Try again shortly.',
    not_configured: 'Flavour Intelligence isn’t set up for this venue yet.'
  };
  const IDEAS_MESSAGES = {
    ...MAP_MESSAGES,
    invalid: 'Atlas couldn’t use that brief. Check the ingredients and try again.',
    forbidden: 'Only managers and administrators can create draft recipes.'
  };
  const COMPOSE_MESSAGES = {
    ...IDEAS_MESSAGES,
    conflict: 'This idea is no longer possible from verified stock, so nothing was prepared. The ideas were refreshed.',
    not_found: 'An ingredient in this idea is no longer in Atlas. The ideas were refreshed.'
  };
  const APPROVE_MESSAGES = {
    forbidden: 'Only managers and administrators can approve a draft recipe. Nothing was saved.',
    not_found: 'This draft is no longer waiting for approval. Nothing was saved. Prepare it again.',
    conflict: 'This draft was already handled or has expired. Nothing else was saved. Prepare it again.',
    rate_limited: 'Too many requests just now. Wait a moment, then try again. Nothing was saved.',
    unavailable: 'Atlas couldn’t save the draft right now. Nothing was saved. Try again shortly.',
    timeout: 'Atlas couldn’t confirm the result. Check Recipes › Drafts before trying again, so nothing is saved twice.',
    network: 'Atlas couldn’t confirm the result. Check Recipes › Drafts before trying again, so nothing is saved twice.'
  };
  const RESULT_MESSAGES = {
    name_taken: 'A recipe with this name already exists, so nothing was saved. Choose another name and prepare the draft again.',
    conflict: 'Stock or recipes changed since this draft was prepared. Nothing was saved. Prepare it again.',
    forbidden: 'Only managers and administrators can approve a draft recipe. Nothing was saved.',
    not_found: 'An item in this draft no longer exists. Nothing was saved. Prepare it again.'
  };

  const state = {
    root: null,
    mounted: false,
    slug: null,
    data: null,
    error: null,
    loading: false,
    seq: 0,
    filters: { use: '', inStock: false, evidence: [] },
    selected: null,
    previousCenter: null,
    search: { query: '', results: [], open: false, timer: 0, seq: 0, error: null, active: -1 }
  };

  // ---------- helpers ----------

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function icons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function canManage() {
    const profile = window.atlasCurrentProfile;
    if (profile?.active === true && ['admin', 'manager'].includes(profile.role)) return true;
    return typeof window.atlasCanManageCommercial === 'function' && window.atlasCanManageCommercial() === true;
  }

  function reducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('atlas-reduce-motion'));
  }

  function isPhone() {
    return Boolean(window.matchMedia?.('(max-width: 767px)').matches);
  }

  function percent(value) {
    return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—';
  }

  function money(value) {
    if (!Number.isFinite(Number(value))) return '—';
    return window.AtlasFormat?.money ? window.AtlasFormat.money(Number(value)) : `${Math.round(Number(value))} kr`;
  }

  function stockInfo(status) {
    return STOCK[status] || STOCK.unknown;
  }

  function stockPill(status) {
    const info = stockInfo(status);
    return `<span class="atlas-pill atlas-pill--${info.tone} flavor-stock" data-stock="${escape(status || 'unknown')}">${escape(info.label)}</span>`;
  }

  function evidencePill(type) {
    const info = EVIDENCE[type];
    if (!info) return '';
    return `<span class="atlas-pill atlas-pill--info flavor-evidence" data-evidence="${escape(type)}" title="${escape(info.help)}">${escape(info.label)}</span>`;
  }

  function endpoint() {
    return String(window.VABAR_CONFIG?.ATLAS_AI_API || '').trim();
  }

  // One request helper for every flavour call (bearer token, timeout and
  // fixed friendly copy come from AtlasApi.request).
  function api(action, { params = {}, body, messages = MAP_MESSAGES } = {}) {
    return window.AtlasApi.request(endpoint(), {
      method: body === undefined ? 'GET' : 'POST',
      params: { action, ...params },
      body,
      messages
    });
  }

  function message(error, fallback) {
    return window.AtlasApi?.message ? window.AtlasApi.message(error, fallback) : fallback;
  }

  function toast(text, tone = 'info') {
    window.AtlasShell?.toast?.(text, { tone });
  }

  function navigate(hash) {
    if (window.AtlasShell?.navigate) window.AtlasShell.navigate(hash);
    else location.hash = hash;
  }

  function mapHash(slug) {
    return slug ? `#recipes/flavor/${encodeURIComponent(slug)}` : '#recipes/flavor';
  }

  function knownRecipes() {
    try {
      // `recipes` is the shell's loaded list (index.html), role-filtered.
      // eslint-disable-next-line no-undef
      return typeof recipes !== 'undefined' && Array.isArray(recipes) ? recipes : [];
    } catch { return []; }
  }

  function recipeLink(name) {
    const found = knownRecipes().find((recipe) => String(recipe.name || '').toLowerCase() === String(name || '').toLowerCase());
    return found ? `<a href="#recipes/${escape(encodeURIComponent(found.id))}">${escape(found.name)}</a>` : escape(name);
  }

  // ---------- Flavor Map page ----------

  function mount(root, { ingredient = null } = {}) {
    if (!root) return;
    const slug = ingredient ? String(ingredient) : null;
    const fresh = !state.mounted || state.root !== root;
    state.root = root;
    state.mounted = true;
    if (fresh) {
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('keydown', onKeydown);
    }
    window.AtlasChrome?.setTopBar?.({ title: 'Flavor Map', back: '#recipes' });
    if (!fresh && state.data && slug && state.data.center?.slug === slug) { render(); return; }
    if (state.data?.center?.slug && slug !== state.data.center.slug) state.previousCenter = state.data.center.slug;
    // Evidence chips depend on the ingredient, so its filter never carries
    // over to another centre (a hidden chip must not hide pairings).
    if (slug !== state.slug) state.filters.evidence = [];
    state.slug = slug;
    load();
  }

  function unmount() {
    if (!state.mounted) return;
    const root = state.root;
    root?.removeEventListener('click', onClick);
    root?.removeEventListener('input', onInput);
    root?.removeEventListener('keydown', onKeydown);
    clearTimeout(state.search.timer);
    state.mounted = false;
    state.root = null;
    state.data = null;
    state.error = null;
    state.selected = null;
    state.previousCenter = null;
    state.filters = { use: '', inStock: false, evidence: [] };
    state.search = { query: '', results: [], open: false, timer: 0, seq: state.search.seq + 1, error: null, active: -1 };
  }

  async function load() {
    const seq = ++state.seq;
    state.loading = true;
    state.error = null;
    render();
    const params = { limit: MAP_LIMIT };
    if (state.slug) params.ingredient = state.slug;
    if (state.filters.use) params.use = state.filters.use;
    if (state.filters.inStock) params.in_stock_only = 'true';
    if (state.filters.evidence.length) params.evidence = state.filters.evidence.join(',');
    try {
      const data = await api('flavor-map', { params });
      if (seq !== state.seq || !state.mounted) return;
      state.loading = false;
      if (Array.isArray(data.needs_clarification) && data.needs_clarification.length) {
        state.data = null;
        state.error = { clarify: data.needs_clarification[0] };
        render();
        return;
      }
      state.data = data;
      // A filter the server no longer offers has no chip, so it is dropped.
      const offered = data.filters_available || {};
      if (state.filters.inStock && offered.in_stock_only !== true) state.filters.inStock = false;
      if (state.filters.use && Array.isArray(offered.uses) && !offered.uses.includes(state.filters.use)) state.filters.use = '';
      const slugs = (data.edges || []).map((edge) => edge.target);
      const keep = [state.previousCenter, state.selected].find((slug) => slug && slugs.includes(slug));
      state.selected = keep || slugs[0] || null;
      state.previousCenter = null;
      // Opened without an ingredient: show the centre's own address, so a
      // reload keeps the same map.
      if (!state.slug && data.center?.slug) {
        state.slug = data.center.slug;
        try { history.replaceState(history.state, '', mapHash(data.center.slug)); } catch { /* address stays #recipes/flavor */ }
      }
      render();
    } catch (error) {
      if (seq !== state.seq || !state.mounted) return;
      state.loading = false;
      state.data = null;
      state.error = { text: message(error, MAP_MESSAGES.unavailable) };
      render();
    }
  }

  function filtersAvailable() {
    return state.data?.filters_available || {};
  }

  function filtersMarkup() {
    const available = filtersAvailable();
    const uses = USES.filter(([key]) => Array.isArray(available.uses) && available.uses.includes(key));
    const evidence = Object.keys(EVIDENCE).filter((key) => Array.isArray(available.evidence) && available.evidence.includes(key));
    const chips = [];
    if (uses.length) {
      chips.push(`<div class="atlas-chips flavor-map__filter-group" role="group" aria-label="Used in">
        <button type="button" class="atlas-chip" aria-pressed="${!state.filters.use}" id="flavor-filter-use-all" data-flavor-use="">All</button>
        ${uses.map(([key, label]) => `<button type="button" class="atlas-chip" aria-pressed="${state.filters.use === key}" id="flavor-filter-use-${key}" data-flavor-use="${key}">${label}</button>`).join('')}
      </div>`);
    }
    const extra = [];
    if (available.in_stock_only === true) extra.push(`<button type="button" class="atlas-chip" aria-pressed="${state.filters.inStock}" id="flavor-filter-instock" data-flavor-instock><i data-lucide="package-check"></i>In stock only</button>`);
    // One evidence type is not a choice: the chips appear only when the
    // server has pairings of more than one type for this ingredient.
    if (evidence.length > 1) {
      evidence.forEach((key) => {
        const on = !state.filters.evidence.length || state.filters.evidence.includes(key);
        extra.push(`<button type="button" class="atlas-chip" aria-pressed="${on}" id="flavor-filter-evidence-${key}" data-flavor-evidence="${key}" title="${escape(EVIDENCE[key].help)}">${escape(EVIDENCE[key].label)}</button>`);
      });
    }
    if (extra.length) chips.push(`<div class="atlas-chips flavor-map__filter-group" role="group" aria-label="Stock and evidence">${extra.join('')}</div>`);
    return chips.length ? `<div class="flavor-map__filters">${chips.join('')}</div>` : '';
  }

  function searchMarkup() {
    const search = state.search;
    const results = search.open ? (search.error
      ? `<p class="flavor-map__search-note" role="status">${escape(search.error)}</p>`
      : search.results.length
        ? `<ul class="flavor-map__results" role="listbox" id="flavor-search-results" aria-label="Ingredients">${search.results.map((row, index) => `<li role="option" id="flavor-result-${index}" aria-selected="${index === search.active}"><button type="button" class="flavor-map__result${index === search.active ? ' is-active' : ''}" tabindex="-1" data-flavor-center="${escape(row.slug)}"><span class="flavor-map__result-name">${escape(row.name)}</span>${stockPill(row.stock_status)}</button></li>`).join('')}</ul>`
        : search.query.trim().length >= 2 ? '<p class="flavor-map__search-note" role="status">No ingredient matches that search.</p>' : '')
      : '';
    return `<div class="flavor-map__search">
      <label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" id="flavor-search" placeholder="Search an ingredient, e.g. gin or rhubarb" aria-label="Search the flavour library" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="flavor-search-results" aria-expanded="${Boolean(search.open && search.results.length)}"${search.active >= 0 ? ` aria-activedescendant="flavor-result-${search.active}"` : ''} value="${escape(search.query)}"></label>
      ${results}
    </div>`;
  }

  function nodeFor(slug) {
    return (state.data?.nodes || []).find((node) => node.slug === slug) || null;
  }

  function edgeFor(slug) {
    return (state.data?.edges || []).find((edge) => edge.target === slug) || null;
  }

  function nodeLabel(node, edge) {
    return `${node.name}: ${RELATIONS[edge.relation] ? RELATIONS[edge.relation].toLowerCase() : 'pairs'}, strength ${percent(edge.strength)}, ${stockInfo(node.stock_status).label.toLowerCase()}. Centre the map on ${node.name}.`;
  }

  function ringMarkup() {
    const data = state.data;
    const edges = data.edges || [];
    const count = edges.length;
    const radius = 37;
    const points = edges.map((edge, index) => {
      const angle = (-90 + (360 / Math.max(count, 1)) * index) * (Math.PI / 180);
      return { edge, x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
    });
    const lines = points.map(({ edge, x, y }) => `<line x1="50" y1="50" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" class="flavor-map__link${edge.target === state.selected ? ' is-selected' : ''}" style="--flavor-weight:${Math.max(0.15, Math.min(1, Number(edge.strength) || 0)).toFixed(2)}"></line>`).join('');
    const nodes = points.map(({ edge, x, y }, index) => {
      const node = nodeFor(edge.target) || { slug: edge.target, name: edge.target, stock_status: 'unknown' };
      return `<button type="button" class="flavor-map__node${edge.target === state.selected ? ' is-selected' : ''}" data-stock="${escape(node.stock_status)}" data-flavor-center="${escape(node.slug)}" data-ring-index="${index}" style="--x:${x.toFixed(2)}%;--y:${y.toFixed(2)}%" aria-label="${escape(nodeLabel(node, edge))}"><span class="flavor-map__dot" aria-hidden="true"></span><span class="flavor-map__label" aria-hidden="true">${escape(node.name)}</span></button>`;
    }).join('');
    const center = data.center;
    return `<section class="flavor-map__stage" aria-labelledby="flavor-ring-title">
      <h2 class="sr-only" id="flavor-ring-title">Pairing ring for ${escape(center.name)}</h2>
      <div class="flavor-map__ring">
        <svg class="flavor-map__links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${lines}</svg>
        <div class="flavor-map__center" data-stock="${escape(center.stock_status)}"><span class="flavor-map__center-name">${escape(center.name)}</span><span class="flavor-map__center-stock">${escape(stockInfo(center.stock_status).label)}</span></div>
        ${nodes}
      </div>
      <ul class="flavor-map__legend" aria-label="Stock key">${Object.entries(STOCK).map(([key, info]) => `<li data-stock="${key}"><span class="flavor-map__dot" aria-hidden="true"></span>${escape(info.label)}</li>`).join('')}</ul>
    </section>`;
  }

  function listMarkup() {
    const data = state.data;
    const edges = data.edges || [];
    const total = Number(data.total) || edges.length;
    const more = total > edges.length ? `<p class="recipe-muted">The ${edges.length} strongest of ${total} pairings.</p>` : '';
    return `<section class="flavor-map__list" aria-labelledby="flavor-list-title">
      <div class="flavor-map__list-head"><h2 class="recipe-section__title" id="flavor-list-title">Pairs with ${escape(data.center.name)}</h2>${more}</div>
      <ul class="flavor-map__rows">${edges.map((edge) => {
        const node = nodeFor(edge.target) || { slug: edge.target, name: edge.target, stock_status: 'unknown' };
        const selected = edge.target === state.selected;
        return `<li class="flavor-map__row${selected ? ' is-selected' : ''}">
          <button type="button" class="flavor-map__row-main" data-flavor-select="${escape(node.slug)}" aria-pressed="${selected}" aria-controls="flavor-detail">
            <span class="flavor-map__row-name">${escape(node.name)}</span>
            <span class="flavor-map__row-meta"><span class="flavor-meter" aria-hidden="true"><span style="--flavor-weight:${Math.max(0, Math.min(1, Number(edge.strength) || 0)).toFixed(2)}"></span></span><span class="num">${percent(edge.strength)}</span>${evidencePill(edge.evidence_type)}${stockPill(node.stock_status)}</span>
          </button>
          <button type="button" class="atlas-icon-btn flavor-map__row-centre" data-flavor-center="${escape(node.slug)}" aria-label="Centre the map on ${escape(node.name)}" title="Centre the map on ${escape(node.name)}"><i data-lucide="locate-fixed"></i></button>
        </li>`;
      }).join('')}</ul>
    </section>`;
  }

  function stockDetail(slug, name) {
    const entry = state.data?.stock?.[slug];
    const status = entry?.status || nodeFor(slug)?.stock_status || 'unknown';
    const items = (entry?.items || []).map((item) => {
      const counted = item.verified_quantity !== null && item.verified_quantity !== undefined && item.verified_quantity !== '' && Number.isFinite(Number(item.verified_quantity));
      // A current verified count (including a verified 0) is shown as counted;
      // only a missing or expired count reads as unknown.
      const quantity = counted && (item.available || item.freshness === 'current') ? `${Number(item.verified_quantity)} ${item.unit || ''} verified` : item.freshness && item.freshness !== 'current' ? `count ${item.freshness}` : 'no current count';
      return `<li>${escape(item.name)} <span class="recipe-muted">· ${escape(quantity.trim())}</span></li>`;
    }).join('');
    const possible = (entry?.possible_matches || []).map((item) => `<li class="flavor-possible">Possible match: ${escape(item.name)} <span class="recipe-muted">· needs review, not counted as stock</span></li>`).join('');
    const why = status === 'unknown' ? '<p class="recipe-muted">Unknown is not zero: Atlas has no current verified count for it.</p>' : '';
    return `<div class="flavor-detail__stock"><div class="flavor-detail__stock-head"><strong>${escape(name)}</strong>${stockPill(status)}</div>${items || possible ? `<ul class="flavor-detail__items">${items}${possible}</ul>` : ''}${why}</div>`;
  }

  function detailMarkup() {
    const data = state.data;
    const edge = edgeFor(state.selected);
    if (!edge) {
      return `<aside class="flavor-detail atlas-card" id="flavor-detail" aria-live="polite"><p class="recipe-muted">No pairings match these filters. Clear a filter to see more.</p></aside>`;
    }
    const node = nodeFor(edge.target) || { slug: edge.target, name: edge.target, stock_status: 'unknown' };
    const manager = canManage();
    const entries = Array.isArray(edge.evidence) && edge.evidence.length ? edge.evidence : [edge];
    const evidence = entries.map((entry) => `<li class="flavor-detail__evidence">${evidencePill(entry.evidence_type)}<p>${escape(entry.explanation || '')}</p><p class="recipe-muted">${RELATIONS[entry.relation] ? `${escape(RELATIONS[entry.relation])} · ` : ''}strength ${percent(entry.strength)} · confidence ${percent(entry.confidence)}</p></li>`).join('');
    const used = entries.filter((entry) => entry.evidence_type === 'atlas_learned' && Array.isArray(entry.recipes) && entry.recipes.length).flatMap((entry) => entry.recipes);
    const profile = [];
    if (edge.aroma != null) profile.push(`Aroma ${percent(edge.aroma)}${edge.dims_basis?.aroma === 'profile' ? ' (calculated from profiles)' : ''}`);
    if (edge.taste != null) profile.push(`Taste ${percent(edge.taste)}${edge.dims_basis?.taste === 'profile' ? ' (calculated from profiles)' : ''}`);
    if (edge.texture != null) profile.push(`Texture ${percent(edge.texture)}`);
    const inStockOffer = filtersAvailable().in_stock_only === true && !state.filters.inStock;
    const actions = [
      manager ? `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" data-flavor-create="${escape(node.slug)}"><i data-lucide="wand-sparkles"></i>Create recipe with this</button>` : '',
      inStockOffer ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-flavor-instock><i data-lucide="package-check"></i>Use only current stock</button>' : '',
      `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-flavor-substitutes="${escape(node.slug)}"><i data-lucide="replace"></i>Find substitutions</button>`
    ].filter(Boolean).join('');
    return `<aside class="flavor-detail atlas-card" id="flavor-detail" aria-labelledby="flavor-detail-title">
      <header class="flavor-detail__head">
        <h2 class="flavor-detail__title" id="flavor-detail-title">${escape(data.center.name)} + ${escape(node.name)}</h2>
        <p class="recipe-muted">${escape(RELATIONS[edge.relation] || 'Pairs')} · ${edge.evidence_type && EVIDENCE[edge.evidence_type] ? escape(EVIDENCE[edge.evidence_type].label) : 'Recorded'} evidence</p>
      </header>
      <dl class="flavor-detail__facts">
        <div><dt>Strength</dt><dd><span class="flavor-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((Number(edge.strength) || 0) * 100)}" aria-label="Pairing strength"><span style="--flavor-weight:${Math.max(0, Math.min(1, Number(edge.strength) || 0)).toFixed(2)}"></span></span><span class="num">${percent(edge.strength)}</span></dd></div>
        <div><dt>Confidence</dt><dd class="num">${percent(edge.confidence)}</dd></div>
      </dl>
      <section class="flavor-detail__section"><h3 class="flavor-detail__label">Why it works</h3><ul class="flavor-detail__evidence-list">${evidence}</ul>${profile.length ? `<p class="recipe-muted">${escape(profile.join(' · '))}</p>` : ''}</section>
      ${used.length ? `<section class="flavor-detail__section"><h3 class="flavor-detail__label">In your recipes</h3><p>${used.map(recipeLink).join(', ')}</p></section>` : ''}
      <section class="flavor-detail__section"><h3 class="flavor-detail__label">Stock</h3>${stockDetail(data.center.slug, data.center.name)}${stockDetail(node.slug, node.name)}</section>
      <div class="flavor-detail__actions">${actions}</div>
    </aside>`;
  }

  function headMarkup() {
    const manager = canManage();
    const center = state.data?.center;
    const sub = center ? `What pairs with ${center.name}. Pick a pairing to see why, and what is in stock.` : 'What pairs with what, from culinary knowledge and your own recipes.';
    const actions = [{ label: 'All recipes', icon: 'arrow-left', variant: 'ghost', attrs: { 'data-flavor-back': '' } }];
    if (manager) actions.push({ label: 'Create with Atlas', icon: 'atlas-bot', variant: 'primary', attrs: { 'data-flavor-open-create': '' } });
    return window.AtlasShell.pageHead({ title: 'Flavor Map', sub, actions });
  }

  function render() {
    const root = state.root;
    if (!root || !state.mounted) return;
    const focusedId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : '';
    let body;
    if (state.loading && !state.data) {
      body = `<div class="flavor-map flavor-map--loading" aria-busy="true" aria-label="Loading the Flavor Map"><div class="atlas-skel atlas-skel--block flavor-map__skel-ring"></div><div class="flavor-map__skel-list">${Array.from({ length: 5 }, () => '<span class="atlas-skel atlas-skel--text"></span>').join('')}</div></div>`;
    } else if (state.error?.clarify) {
      const clarify = state.error.clarify;
      body = `<div class="atlas-alert atlas-alert--info" role="status"><i data-lucide="info"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Which one did you mean?</p><div class="atlas-chips">${(clarify.candidates || []).map((entry) => `<button type="button" class="atlas-chip" data-flavor-center="${escape(entry.slug)}">${escape(entry.name)}</button>`).join('')}</div></div></div>`;
    } else if (state.error) {
      body = `<div class="atlas-alert atlas-alert--warning" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escape(state.error.text)}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-flavor-retry>Try again</button></div></div>`;
    } else if (state.data) {
      const empty = !(state.data.edges || []).length;
      body = `${filtersMarkup()}
        <div class="flavor-map${state.loading ? ' is-loading' : ''}${empty ? ' flavor-map--empty' : ''}" aria-busy="${state.loading}">
          ${empty ? `<div class="atlas-empty flavor-map__empty"><div class="atlas-empty__icon"><i data-lucide="orbit"></i></div><h3 class="atlas-empty__title">No pairings match these filters</h3><p class="atlas-empty__text">${escape(state.data.center.name)} has no recorded pairings with these filters.</p><div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-flavor-clear>Clear filters</button></div></div>` : `${ringMarkup()}${detailMarkup()}${listMarkup()}`}
        </div>
        <p class="recipe-muted flavor-map__basis">Pairings are Atlas-curated culinary knowledge and ingredients used together in your recipes, not laboratory data. Stock shows only verified current counts; unknown is never counted as zero.</p>`;
    } else {
      body = '';
    }
    root.innerHTML = `<div class="atlas-page recipes-page flavor-page">${headMarkup()}${searchMarkup()}${body}</div>`;
    icons();
    if (focusedId) {
      const next = document.getElementById(focusedId);
      if (next) {
        next.focus({ preventScroll: true });
        if (next.id === 'flavor-search') next.setSelectionRange(next.value.length, next.value.length);
      }
    }
    // After a keyboard re-centre, focus lands on the same kind of control in
    // the new map (the ring node or the list row of the pair just left).
    if (state.focusAfter && state.data && !state.loading) {
      const kind = state.focusAfter;
      state.focusAfter = null;
      const target = kind === 'ring'
        ? root.querySelector('.flavor-map__node.is-selected') || root.querySelector('.flavor-map__node')
        : kind === 'list' ? root.querySelector('.flavor-map__row.is-selected .flavor-map__row-main') || root.querySelector('.flavor-map__row-main')
          : null;
      (target || document.getElementById('flavor-search'))?.focus({ preventScroll: true });
    }
  }

  function recenter(slug, trigger = null) {
    if (!slug) return;
    state.focusAfter = trigger?.classList?.contains('flavor-map__node') ? 'ring' : trigger?.classList?.contains('flavor-map__row-centre') ? 'list' : 'search';
    state.search = { ...state.search, query: '', results: [], open: false, active: -1 };
    const hash = mapHash(slug);
    if (location.hash === hash) { if (state.slug !== slug) { state.slug = slug; load(); } return; }
    navigate(hash);
  }

  function select(slug) {
    state.selected = slug;
    render();
    const detail = document.getElementById('flavor-detail');
    if (detail && isPhone()) detail.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    document.querySelector(`[data-flavor-select="${CSS.escape(slug)}"]`)?.focus({ preventScroll: true });
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const center = target.closest('[data-flavor-center]');
    if (center) { recenter(center.dataset.flavorCenter, center); return; }
    const pick = target.closest('[data-flavor-select]');
    if (pick) { select(pick.dataset.flavorSelect); return; }
    const use = target.closest('[data-flavor-use]');
    if (use) { state.filters.use = use.dataset.flavorUse || ''; load(); return; }
    if (target.closest('[data-flavor-instock]')) { state.filters.inStock = !state.filters.inStock; load(); return; }
    const evidence = target.closest('[data-flavor-evidence]');
    if (evidence) { toggleEvidence(evidence.dataset.flavorEvidence); return; }
    if (target.closest('[data-flavor-clear]')) { state.filters = { use: '', inStock: false, evidence: [] }; load(); return; }
    if (target.closest('[data-flavor-retry]')) { load(); return; }
    if (target.closest('[data-flavor-back]')) { navigate('#recipes'); return; }
    if (target.closest('[data-flavor-open-create]')) { openCreate(); return; }
    const create = target.closest('[data-flavor-create]');
    if (create) {
      const seed = [state.data?.center?.slug, create.dataset.flavorCreate].filter(Boolean);
      openCreate({ step: 'brief', seed: seed.map((slug) => ({ slug, name: (nodeFor(slug) || {}).name || slug })) });
      return;
    }
    const subs = target.closest('[data-flavor-substitutes]');
    if (subs) {
      const slug = subs.dataset.flavorSubstitutes;
      openCreate({ step: 'substitute', ingredient: { slug, name: (nodeFor(slug) || {}).name || slug } });
    }
  }

  function toggleEvidence(type) {
    const all = (filtersAvailable().evidence || []).filter((key) => EVIDENCE[key]);
    let on = state.filters.evidence.length ? [...state.filters.evidence] : [...all];
    on = on.includes(type) ? on.filter((key) => key !== type) : [...on, type];
    if (!on.length) return; // at least one evidence type stays on
    state.filters.evidence = on.length === all.length ? [] : on;
    load();
  }

  function onInput(event) {
    if (event.target.id !== 'flavor-search') return;
    const query = event.target.value;
    state.search.query = query;
    state.search.active = -1;
    clearTimeout(state.search.timer);
    if (query.trim().length < 2) {
      state.search.results = [];
      state.search.open = false;
      state.search.error = null;
      render();
      return;
    }
    state.search.timer = setTimeout(() => runSearch(query), 250);
  }

  async function runSearch(query) {
    const seq = ++state.search.seq;
    try {
      const data = await api('flavor-search', { params: { q: query.trim().slice(0, 100), limit: 8 } });
      if (seq !== state.search.seq || !state.mounted) return;
      state.search.results = Array.isArray(data.results) ? data.results : [];
      state.search.error = null;
    } catch (error) {
      if (seq !== state.search.seq || !state.mounted) return;
      state.search.results = [];
      state.search.error = message(error, MAP_MESSAGES.unavailable);
    }
    state.search.open = true;
    render();
  }

  function onKeydown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.id === 'flavor-search') {
      const results = state.search.results;
      if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); state.search.active = (state.search.active + 1) % results.length; state.search.open = true; render(); return; }
      if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); state.search.active = state.search.active <= 0 ? results.length - 1 : state.search.active - 1; render(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        const row = results[Math.max(0, state.search.active)];
        if (row) recenter(row.slug);
        return;
      }
      if (event.key === 'Escape' && (state.search.open || state.search.query)) {
        event.preventDefault();
        event.stopPropagation();
        state.search = { ...state.search, query: '', results: [], open: false, active: -1 };
        render();
      }
      return;
    }
    // Arrow keys walk around the ring; Enter and Space (native buttons) re-centre.
    if (target.classList.contains('flavor-map__node') && ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const nodes = [...state.root.querySelectorAll('.flavor-map__node')];
      const index = nodes.indexOf(target);
      if (index < 0 || !nodes.length) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % nodes.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + nodes.length) % nodes.length;
      else if (event.key === 'Home') next = 0;
      else next = nodes.length - 1;
      nodes[next].focus();
    }
  }

  // ---------- Create with Atlas (sheet) ----------

  const flow = {
    root: null,
    step: 'choose',
    brief: null,
    ideas: null,
    ideasError: null,
    busy: false,
    approving: null,
    preview: null,
    previewError: null,
    nameError: null,
    substitute: null,
    pickerSeq: 0
  };

  function defaultBrief() {
    return { type: 'cocktail', seed: [], excludeFamilies: [], excludeIngredients: [], noNewPurchases: true, goal: 'balanced' };
  }

  function openCreate(options = {}) {
    const manager = canManage();
    const step = options.step || (manager ? 'choose' : 'substitute');
    if (step !== 'substitute' && !manager) {
      toast('Creating draft recipes is for managers. The Flavor Map is open to everyone.', 'info');
      navigate('#recipes/flavor');
      return;
    }
    flow.step = step;
    flow.brief = { ...defaultBrief(), ...(options.seed ? { seed: options.seed.slice(0, 4) } : {}) };
    flow.ideas = null;
    flow.ideasError = null;
    flow.preview = null;
    flow.previewError = null;
    flow.nameError = null;
    flow.busy = false;
    flow.substitute = step === 'substitute' ? { ingredient: options.ingredient || null, inStock: false, data: null, error: null, loading: false, query: options.ingredient?.name || '', results: [] } : null;
    flow.root = window.AtlasModal.layer({
      id: 'flavor-create',
      className: 'flavor-create-layer',
      panel: '<section class="atlas-sheet atlas-sheet--wide atlas-sheet--full-phone flavor-create" data-modal-panel aria-labelledby="flavor-create-title"></section>',
      onClose: onCreateClosed,
      // A misplaced tap outside must not throw away a prepared draft.
      closeOnBackdrop: false
    });
    flow.root.addEventListener('click', onCreateClick);
    flow.root.addEventListener('input', onCreateInput);
    flow.root.addEventListener('change', onCreateChange);
    flow.root.addEventListener('keydown', onCreateKeydown);
    // While a request is in flight (approve above all) the sheet stays open:
    // Escape is stopped here, before it reaches the modal's document listener
    // (approveDraft keeps focus inside the sheet).
    flow.root.addEventListener('keydown', holdEscapeWhileBusy);
    renderCreate();
    if (step === 'substitute' && flow.substitute.ingredient) loadSubstitutes();
  }

  function holdEscapeWhileBusy(event) {
    if (event.key === 'Escape' && flow.busy && flow.root) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onCreateClosed() {
    // Closing the sheet with a prepared, unapproved draft rejects it: nothing
    // is ever saved without Approve.
    // Never reject a proposal whose approval is in flight or has an unknown
    // outcome: it may already be saved.
    const pending = flow.preview?.proposal?.id;
    if (pending && !flow.preview.approved && !flow.preview.proposal.spent && !flow.approving && !flow.preview.outcomeUnknown) rejectProposal(pending);
    flow.root = null;
    flow.preview = null;
  }

  function closeCreate() {
    if (flow.root) window.AtlasModal.dismiss(flow.root, 'done');
  }

  function sheetTitle() {
    return {
      choose: ['Create with Atlas', 'Atlas suggests ideas from verified stock. Nothing is saved until you approve a draft.'],
      brief: ['Ideas from current stock', 'Choose what to make. Atlas uses only verified current stock unless you allow new purchases.'],
      ideas: ['Ideas', 'Every score is shown. Pick one to prepare a draft recipe.'],
      preview: ['Draft recipe', 'Check the draft. Nothing is saved until you approve it.'],
      substitute: ['Find a substitute', 'What can replace an ingredient, and whether it is in verified stock.']
    }[flow.step] || ['Create with Atlas', ''];
  }

  function renderCreate() {
    const panel = flow.root?.querySelector('.flavor-create');
    if (!panel) return;
    const focusedId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : '';
    const [title, desc] = sheetTitle();
    const back = flow.step !== 'choose' && canManage() ? `<button type="button" class="atlas-icon-btn flavor-create__back" data-create-back aria-label="Back"${flow.busy ? ' disabled' : ''}><i data-lucide="arrow-left"></i></button>` : '';
    panel.innerHTML = `<span class="atlas-sheet__grabber"></span>
      <header class="atlas-sheet__head">${back}<div><h2 class="atlas-sheet__title" id="flavor-create-title" tabindex="-1">${escape(title)}</h2><p class="atlas-sheet__desc">${escape(desc)}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close${flow.busy ? ' disabled' : ''}><i data-lucide="x"></i></button></header>
      <div class="atlas-sheet__body flavor-create__body" data-step="${escape(flow.step)}">${stepMarkup()}</div>
      ${footMarkup()}`;
    icons();
    const again = focusedId && document.getElementById(focusedId);
    if (again && panel.contains(again)) again.focus({ preventScroll: true });
  }

  function focusTitle() {
    const title = document.getElementById('flavor-create-title');
    title?.focus({ preventScroll: true });
    flow.root?.querySelector('.flavor-create__body')?.scrollTo?.({ top: 0 });
  }

  function goStep(step) {
    flow.step = step;
    renderCreate();
    focusTitle();
  }

  function stepMarkup() {
    switch (flow.step) {
      case 'brief': return briefMarkup();
      case 'ideas': return ideasMarkup();
      case 'preview': return previewMarkup();
      case 'substitute': return substituteMarkup();
      default: return chooseMarkup();
    }
  }

  function footMarkup() {
    if (flow.step === 'brief') {
      return `<footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary${flow.busy ? ' is-loading' : ''}" data-create-ideas${flow.busy ? ' disabled aria-busy="true"' : ''}><i data-lucide="sparkles"></i>Show ideas</button></footer>`;
    }
    if (flow.step === 'preview' && flow.preview) {
      const blocked = Boolean(flow.nameError) || flow.preview.approved || renamePending();
      return `<footer class="atlas-sheet__foot flavor-create__approve"><button type="button" class="atlas-btn atlas-btn--ghost" data-create-discard${flow.busy ? ' disabled' : ''}>Discard</button><button type="button" class="atlas-btn atlas-btn--primary${flow.busy ? ' is-loading' : ''}" data-create-approve${flow.busy || blocked ? ' disabled' : ''}${flow.busy ? ' aria-busy="true"' : ''}><i data-lucide="check"></i>Approve and save draft</button></footer>`;
    }
    return '';
  }

  function chooseMarkup() {
    const options = [
      ['stock', 'package-check', 'Use current stock', 'Drink ideas made only from what Atlas has verified in stock.'],
      ['pair', 'orbit', 'Pair ingredients', 'Search an ingredient and see what pairs with it, and why.'],
      ['substitute', 'replace', 'Find a substitute', 'What can replace an ingredient, and whether you have it.'],
      ['map', 'map', 'Open Flavor Map', 'Browse pairings around any ingredient.']
    ];
    return `<ul class="flavor-create__options">${options.map(([key, icon, label, help]) => `<li><button type="button" class="flavor-create__option" data-create-option="${key}"><span class="flavor-create__option-icon"><i data-lucide="${icon}"></i></span><span><span class="flavor-create__option-label">${label}</span><span class="flavor-create__option-help">${help}</span></span><i data-lucide="chevron-right"></i></button></li>`).join('')}</ul>`;
  }

  function chipList(entries, attr) {
    return entries.map((entry) => `<span class="atlas-chip is-active">${escape(entry.name)}<button type="button" class="atlas-chip__clear" ${attr}="${escape(entry.slug)}" aria-label="Remove ${escape(entry.name)}"><i data-lucide="x"></i></button></span>`).join('');
  }

  function pickerMarkup(kind, label, placeholder) {
    const picker = flow.picker?.kind === kind ? flow.picker : null;
    const results = picker?.results?.length
      ? `<ul class="flavor-map__results flavor-picker__results" role="listbox" id="flavor-picker-${kind}-results" aria-label="${escape(label)}">${picker.results.map((row) => `<li role="option" aria-selected="false"><button type="button" class="flavor-map__result" data-picker-add="${kind}" data-slug="${escape(row.slug)}" data-name="${escape(row.name)}"><span class="flavor-map__result-name">${escape(row.name)}</span>${stockPill(row.stock_status)}</button></li>`).join('')}</ul>`
      : picker?.note ? `<p class="flavor-map__search-note" role="status">${escape(picker.note)}</p>` : '';
    return `<div class="flavor-picker"><label class="atlas-search"><i data-lucide="search"></i><input class="atlas-input" type="search" id="flavor-picker-${kind}" data-picker="${kind}" placeholder="${escape(placeholder)}" aria-label="${escape(label)}" autocomplete="off" value="${escape(picker?.query || '')}"></label>${results}</div>`;
  }

  function briefMarkup() {
    const brief = flow.brief;
    const manager = canManage();
    const goals = GOALS.filter(([key]) => manager || !['low_cost', 'high_margin'].includes(key));
    return `<div class="flavor-brief">
      <fieldset class="flavor-brief__group"><legend class="atlas-label">What to make</legend>
        <div class="atlas-segmented flavor-brief__types" role="group" aria-label="What to make">${TYPES.map(([key, label]) => `<button type="button" aria-pressed="${brief.type === key}" id="flavor-brief-type-${key}" data-brief-type="${key}">${label}</button>`).join('')}</div>
        ${['dessert', 'food'].includes(brief.type) ? '<p class="atlas-field__help">Dessert and food ideas are pairing notes. Atlas drafts recipes for drinks only.</p>' : ''}
      </fieldset>
      <div class="atlas-toggle-row flavor-brief__toggle"><div><p class="atlas-toggle-row__label" id="flavor-brief-stock-label">No new purchases</p><p class="atlas-toggle-row__help">Use only verified current stock. Turn off to allow ingredients to buy; they are clearly marked.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${brief.noNewPurchases}" aria-labelledby="flavor-brief-stock-label" id="flavor-brief-stock" data-brief-stock></button></div>
      <div class="atlas-field"><span class="atlas-label" id="flavor-brief-seed-label">Must use <span class="optional">Optional, up to 4</span></span>
        ${brief.seed.length ? `<div class="atlas-chips" aria-labelledby="flavor-brief-seed-label">${chipList(brief.seed, 'data-brief-unseed')}</div>` : ''}
        ${brief.seed.length < 4 ? pickerMarkup('seed', 'Add an ingredient every idea must use', 'Add an ingredient, e.g. rhubarb') : ''}
      </div>
      <div class="atlas-field"><span class="atlas-label" id="flavor-brief-exclude-label">Leave out <span class="optional">Optional</span></span>
        <div class="atlas-chips" role="group" aria-labelledby="flavor-brief-exclude-label">${FAMILIES.map(([key, label]) => `<button type="button" class="atlas-chip" aria-pressed="${brief.excludeFamilies.includes(key)}" id="flavor-brief-family-${key}" data-brief-family="${key}">${label}</button>`).join('')}</div>
        ${brief.excludeIngredients.length ? `<div class="atlas-chips">${chipList(brief.excludeIngredients, 'data-brief-unexclude')}</div>` : ''}
        ${brief.excludeIngredients.length < 10 ? pickerMarkup('exclude', 'Leave out an ingredient', 'Leave out an ingredient, e.g. amaretto') : ''}
      </div>
      <div class="atlas-field"><label class="atlas-label" for="flavor-brief-goal">Order ideas by</label><select class="atlas-input atlas-select" id="flavor-brief-goal" data-brief-goal>${goals.map(([key, label]) => `<option value="${key}"${brief.goal === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
      ${flow.ideasError ? `<div class="atlas-alert atlas-alert--warning" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escape(flow.ideasError)}</p></div></div>` : ''}
    </div>`;
  }

  function scoreRow(label, value, hint = '') {
    return `<div><dt>${escape(label)}</dt><dd>${value}${hint ? `<span class="recipe-muted"> ${escape(hint)}</span>` : ''}</dd></div>`;
  }

  function candidateMarkup(candidate, index) {
    const scores = candidate.scores || {};
    const flavor = scores.flavor || {};
    const inventory = scores.inventory || {};
    const operations = scores.operations || {};
    const menu = scores.menu || {};
    const economics = scores.economics;
    const risk = inventory.low_stock_risk || {};
    const ingredients = (candidate.ingredients || []).map((part) => `<li class="flavor-idea__ingredient"><span class="flavor-idea__role">${escape(ROLE_LABELS[part.role] || part.role || '')}</span><span class="flavor-idea__name">${escape(part.name)}${part.preparation ? ` <span class="recipe-muted">(${escape(part.preparation.name || part.preparation)})</span>` : ''}${part.item?.name ? `<span class="recipe-muted"> · ${escape(part.item.name)}</span>` : ''}</span>${part.to_buy ? '<span class="atlas-pill atlas-pill--warning">To buy</span>' : stockPill(part.stock_status)}</li>`).join('');
    const lines = (candidate.lines || []).map((line) => `<li>${escape(line.display || `${line.quantity} ${line.unit} ${line.item_name}`)}${line.to_buy ? ' <span class="atlas-pill atlas-pill--warning">To buy</span>' : ''}</li>`).join('');
    const toBuy = Array.isArray(candidate.to_buy) && candidate.to_buy.length ? `<p class="flavor-idea__buy"><i data-lucide="shopping-cart"></i>To buy: ${escape(candidate.to_buy.map((entry) => (typeof entry === 'string' ? entry : entry?.name || '')).filter(Boolean).join(', '))}. Nothing is ordered.</p>` : '';
    const economy = economics ? `<div class="flavor-idea__group"><h4>Economics <span class="recipe-muted">(theoretical)</span></h4><dl>
        ${scoreRow('Cost per serve', economics.cost_per_serve == null ? '—' : money(economics.cost_per_serve), economics.cost_per_serve == null && economics.missing ? String(economics.missing.reason || economics.missing) : '')}
        ${scoreRow('Margin', economics.margin_at_price == null ? '—' : `${Math.round(economics.margin_at_price)}%`, economics.price_support?.reference_price ? `at ${money(economics.price_support.reference_price)}` : '')}
      </dl>${economics.price_support?.basis ? `<p class="recipe-muted">Reference price: ${escape(economics.price_support.basis)}.</p>` : ''}</div>` : '';
    const closest = menu.closest_recipe?.name ? `closest: ${menu.closest_recipe.name}` : '';
    const pair = (candidate.pairs || []).find((entry) => entry.basis === 'recorded');
    const action = candidate.composable === false
      ? '<p class="recipe-muted">Pairing notes only. Atlas drafts recipes for drinks.</p>'
      : `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" data-create-compose="${index}"${flow.busy ? ' disabled' : ''}><i data-lucide="file-plus-2"></i>Prepare draft</button>`;
    return `<li class="flavor-idea atlas-card" aria-labelledby="flavor-idea-${index}">
      <header class="flavor-idea__head"><div><h3 class="flavor-idea__title" id="flavor-idea-${index}">${escape(candidate.name)}</h3><p class="recipe-muted">${escape([candidate.template?.name, candidate.template?.glass, candidate.template?.technique].filter(Boolean).join(' · '))}</p></div>${action}</header>
      <ul class="flavor-idea__ingredients">${ingredients}</ul>
      ${lines ? `<ul class="flavor-idea__lines">${lines}</ul>` : ''}
      ${toBuy}
      ${pair ? `<p class="flavor-idea__pair">${evidencePill(pair.evidence_type)} ${escape(pair.explanation || '')}</p>` : ''}
      ${candidate.balance_note ? `<p class="recipe-muted">Balance: ${escape(candidate.balance_note)}</p>` : ''}
      <div class="flavor-idea__scores">
        <div class="flavor-idea__group"><h4>Flavour</h4><dl>${scoreRow('Compatibility', percent(flavor.compatibility))}${scoreRow('Balance', percent(flavor.balance))}${flavor.texture != null ? scoreRow('Texture', percent(flavor.texture)) : ''}</dl></div>
        <div class="flavor-idea__group"><h4>Inventory</h4><dl>${scoreRow('From stock', percent(inventory.coverage))}${scoreRow('Serves possible', Number.isFinite(Number(risk.servings_possible)) ? String(risk.servings_possible) : '—', risk.limiting_item ? `limited by ${risk.limiting_item}` : '')}</dl></div>
        <div class="flavor-idea__group"><h4>Operations</h4><dl>${scoreRow('Steps', escape(String(operations.steps ?? '—')))}${scoreRow('Batching', escape(operations.batching || '—'))}</dl></div>
        <div class="flavor-idea__group"><h4>Menu</h4><dl>${scoreRow('New to the menu', percent(menu.novelty), closest)}</dl></div>
        ${economy}
      </div>
    </li>`;
  }

  function ideasMarkup() {
    const ideas = flow.ideas || {};
    const list = Array.isArray(ideas.candidates) ? ideas.candidates : [];
    const unmet = (ideas.unmet_seeds || []).map((seed) => `<li>${escape(seed.name || seed.slug)}: ${escape(seed.reason || 'no usable stock')}</li>`).join('');
    const unused = (ideas.unused_seeds || []).map((seed) => `<li>${escape(seed.name || seed.slug)}: ${escape(seed.reason || 'fits no idea')}</li>`).join('');
    const unmeasurable = Array.isArray(ideas.unmeasurable) && ideas.unmeasurable.length
      ? `<div class="atlas-alert atlas-alert--info"><i data-lucide="ruler"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Some stock could not be measured</p><p class="atlas-alert__body">${escape(ideas.unmeasurable.map((item) => item.name).join(', '))}: no package size is set, so Atlas can’t measure a serve from ${ideas.unmeasurable.length === 1 ? 'it' : 'them'}. Set the package size in Inventory to include ${ideas.unmeasurable.length === 1 ? 'it' : 'them'}.</p></div></div>`
      : '';
    const notes = (ideas.notes || []).filter(Boolean).map((note) => `<li>${escape(note)}</li>`).join('');
    const request = ideas.request || {};
    const brief = `<p class="recipe-muted flavor-ideas__brief">${escape([TYPES.find(([key]) => key === (request.type || ''))?.[1] || 'Any drink', request.seed?.length ? `with ${request.seed.join(', ')}` : '', request.no_new_purchases === false ? 'new purchases allowed' : 'verified stock only'].filter(Boolean).join(' · '))} <button type="button" class="atlas-link" data-create-edit-brief>Change</button></p>`;
    const staleNote = flow.ideasError ? `<div class="atlas-alert atlas-alert--warning" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escape(flow.ideasError)}</p></div></div>` : '';
    const empty = !list.length ? `<div class="atlas-empty atlas-empty--inline"><div class="atlas-empty__icon"><i data-lucide="search-x"></i></div><h3 class="atlas-empty__title">No ideas from this brief</h3><p class="atlas-empty__text">${request.no_new_purchases === false ? 'Try another kind of drink or fewer exclusions.' : 'Try another kind of drink, fewer exclusions, or allow new purchases.'}</p></div>` : '';
    return `${brief}${staleNote}
      ${unmet ? `<div class="atlas-alert atlas-alert--warning"><i data-lucide="package-x"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Not usable from stock</p><ul class="flavor-list">${unmet}</ul></div></div>` : ''}
      ${unused ? `<div class="atlas-alert atlas-alert--info"><i data-lucide="info"></i><div class="atlas-alert__content"><p class="atlas-alert__title">In stock but not used</p><ul class="flavor-list">${unused}</ul></div></div>` : ''}
      ${unmeasurable}
      ${notes ? `<ul class="flavor-list recipe-muted">${notes}</ul>` : ''}
      ${empty}
      ${list.length ? `<ol class="flavor-ideas">${list.map(candidateMarkup).join('')}</ol>` : ''}`;
  }

  function previewMarkup() {
    const preview = flow.preview;
    if (!preview) return '';
    const draft = preview.draft || {};
    const proposal = preview.proposal || {};
    const view = proposal.preview || {};
    const manager = canManage();
    const lines = (draft.lines || []).map((line) => `<li class="recipe-build__row"><span class="recipe-build__qty num">${escape(`${line.quantity} ${line.unit}`)}</span><span class="recipe-build__name">${escape(line.item_name)}${line.role ? ` <span class="recipe-muted">· ${escape(ROLE_LABELS[line.role] || line.role)}</span>` : ''}</span><span class="recipe-build__end">${line.to_buy ? '<span class="atlas-pill atlas-pill--warning">To buy</span>' : '<span class="atlas-pill atlas-pill--positive">Verified in stock</span>'}</span></li>`).join('');
    const method = Array.isArray(draft.method) && draft.method.length ? `<ol class="recipe-method">${draft.method.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>` : '';
    const balance = draft.balance || {};
    const facts = [['Glass', draft.glass], ['Garnish', draft.garnish], ['Serves from stock', Number.isFinite(Number(draft.servings_possible)) ? String(draft.servings_possible) : null], ['Estimated ABV', Number.isFinite(Number(balance.abv_est)) ? `${balance.abv_est}%` : null]].filter(([, value]) => value);
    const cost = manager && view.totals?.estimated_total_label ? view.totals.estimated_total_label : null;
    const margin = manager && draft.costing && Number.isFinite(Number(draft.costing.margin_at_price)) ? `${Math.round(draft.costing.margin_at_price)}% at ${money(draft.costing.price_support?.reference_price)} (reference price)` : null;
    const failed = (draft.checks || []).filter((check) => check && check.ok === false).map((check) => `<li>${escape(check.detail || '')}</li>`).join('');
    const warnings = (view.warnings || []).map((entry) => `<li>${escape(typeof entry === 'string' ? entry : entry?.message || '')}</li>`).join('');
    const willChange = (view.will_change || []).filter(Boolean);
    const willNot = (view.will_not_change || []).filter(Boolean);
    const approved = preview.approved;
    return `<article class="flavor-draft atlas-card" aria-labelledby="flavor-draft-title">
      <header class="flavor-draft__head"><span class="flavor-draft__icon"><i data-lucide="martini"></i></span><div><h3 class="flavor-draft__title" id="flavor-draft-title">${escape(draft.name || 'Draft recipe')}</h3><p class="recipe-muted">${escape([DRAFT_TYPES[draft.type] || null, draft.glass, draft.technique].filter(Boolean).join(' · '))}</p></div><span class="atlas-pill atlas-pill--info">${approved ? 'Saved' : 'Needs approval'}</span></header>
      <p class="flavor-draft__promise"><i data-lucide="shield-check"></i>Saved as an inactive draft recipe — not on the menu. Nothing is saved until you tap Approve.</p>
      <div class="atlas-field flavor-draft__name"><label class="atlas-label" for="flavor-draft-name">Recipe name</label>
        <div class="flavor-draft__rename"><input class="atlas-input" id="flavor-draft-name" maxlength="120" value="${escape(flow.renameValue ?? draft.name ?? '')}"${flow.nameError ? ' aria-invalid="true" aria-describedby="flavor-draft-name-error"' : ''}><button type="button" class="atlas-btn atlas-btn--secondary" data-create-rename${flow.busy ? ' disabled' : ''}>Use this name</button></div>
        ${flow.nameError ? `<p class="atlas-field__error" id="flavor-draft-name-error" role="alert">${escape(flow.nameError)}</p>` : `<p class="atlas-field__help" id="flavor-draft-name-help" aria-live="polite">${renamePending() ? 'Tap “Use this name” to prepare the draft with this name before approving.' : 'Renaming prepares the draft again with the new name.'}</p>`}
      </div>
      <ul class="recipe-build">${lines}</ul>
      ${method ? `<section class="recipe-section"><h4 class="flavor-detail__label">Method</h4>${method}</section>` : ''}
      ${facts.length ? `<dl class="recipe-facts">${facts.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>` : ''}
      ${cost || margin ? `<dl class="recipe-facts flavor-draft__money">${cost ? `<div><dt>Cost per serve</dt><dd>${escape(cost)}</dd></div>` : ''}${margin ? `<div><dt>Theoretical margin</dt><dd>${escape(margin)}</dd></div>` : ''}</dl>` : ''}
      ${warnings || failed ? `<div class="atlas-alert atlas-alert--warning"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><ul class="flavor-list">${warnings}${failed}</ul></div></div>` : ''}
      ${willChange.length || willNot.length ? `<div class="flavor-draft__note">${willChange.length ? `<p><strong>Will change:</strong> ${escape(willChange.join(' '))}</p>` : ''}${willNot.length ? `<p><strong>Will not change:</strong> ${escape(willNot.join(' '))}</p>` : ''}</div>` : ''}
      ${flow.previewError ? `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="circle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escape(flow.previewError)}</p></div></div>` : ''}
    </article>`;
  }

  function substituteMarkup() {
    const sub = flow.substitute || {};
    const data = sub.data;
    const pickerOpen = !sub.ingredient;
    const head = sub.ingredient
      ? `<div class="flavor-sub__head"><p>Substitutes for <strong>${escape(sub.ingredient.name)}</strong></p><button type="button" class="atlas-link" data-sub-change>Choose another ingredient</button></div>`
      : pickerMarkup('substitute', 'Ingredient to replace', 'Ingredient to replace, e.g. lime');
    const toggle = sub.ingredient ? `<div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="flavor-sub-stock-label">Only what’s in stock</p><p class="atlas-toggle-row__help">Show only substitutes with a verified current count.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${Boolean(sub.inStock)}" aria-labelledby="flavor-sub-stock-label" data-sub-stock></button></div>` : '';
    let list = '';
    if (!pickerOpen) {
      if (sub.loading) list = `<div class="flavor-sub__loading" aria-busy="true">${Array.from({ length: 3 }, () => '<span class="atlas-skel atlas-skel--text"></span>').join('')}</div>`;
      else if (sub.error) list = `<div class="atlas-alert atlas-alert--warning" role="alert"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escape(sub.error)}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-sub-retry>Try again</button></div></div>`;
      else if (data) {
        const original = data.original || {};
        const originalStock = original.stock || {};
        const rows = Array.isArray(data.substitutes) ? data.substitutes : [];
        list = `<div class="flavor-sub__original">${escape(original.name || sub.ingredient.name)} ${stockPill(originalStock.status)}${(originalStock.possible_matches || []).map((item) => `<span class="recipe-muted flavor-possible">Possible match: ${escape(item.name)} · needs review, not counted</span>`).join('')}</div>
          ${rows.length ? `<ul class="flavor-sub__list">${rows.map((row) => `<li class="flavor-sub__row atlas-card">
            <div class="flavor-sub__row-head"><strong>${escape(row.ingredient?.name || '')}</strong>${stockPill(row.stock_status)}</div>
            <p class="flavor-sub__basis">${row.basis === 'recorded' ? `${evidencePill(row.evidence_type)} Recorded substitute` : '<span class="atlas-pill atlas-pill--neutral">Calculated</span> Similar flavour profile, not a recorded substitute'}</p>
            <p>${escape(row.explanation || '')}</p>
            ${row.differences?.length ? `<p class="recipe-muted">Differs: ${escape(row.differences.join(', '))}.</p>` : ''}
            ${row.adjustments?.length ? `<p class="recipe-muted">Adjust: ${escape(row.adjustments.join('; '))}.</p>` : ''}
            <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-sub-open="${escape(row.ingredient?.slug || '')}"><i data-lucide="orbit"></i>Open in Flavor Map</button>
          </li>`).join('')}</ul>` : `<div class="atlas-empty atlas-empty--inline"><div class="atlas-empty__icon"><i data-lucide="search-x"></i></div><h3 class="atlas-empty__title">No substitutes found</h3><p class="atlas-empty__text">${sub.inStock ? 'None with verified stock. Turn off “Only what’s in stock” to see all.' : 'Atlas has no recorded or similar substitute for this ingredient.'}</p></div>`}`;
      }
    }
    return `<div class="flavor-sub">${head}${toggle}${list}</div>`;
  }

  // --- sheet events

  function onCreateClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const option = target.closest('[data-create-option]');
    if (option) { chooseOption(option.dataset.createOption); return; }
    if (target.closest('[data-create-back]')) { stepBack(); return; }
    const type = target.closest('[data-brief-type]');
    if (type) { flow.brief.type = type.dataset.briefType; renderCreate(); return; }
    if (target.closest('[data-brief-stock]')) { flow.brief.noNewPurchases = !flow.brief.noNewPurchases; renderCreate(); return; }
    const family = target.closest('[data-brief-family]');
    if (family) {
      const key = family.dataset.briefFamily;
      flow.brief.excludeFamilies = flow.brief.excludeFamilies.includes(key) ? flow.brief.excludeFamilies.filter((entry) => entry !== key) : [...flow.brief.excludeFamilies, key];
      renderCreate();
      return;
    }
    const unseed = target.closest('[data-brief-unseed]');
    if (unseed) { flow.brief.seed = flow.brief.seed.filter((entry) => entry.slug !== unseed.dataset.briefUnseed); renderCreate(); return; }
    const unexclude = target.closest('[data-brief-unexclude]');
    if (unexclude) { flow.brief.excludeIngredients = flow.brief.excludeIngredients.filter((entry) => entry.slug !== unexclude.dataset.briefUnexclude); renderCreate(); return; }
    const add = target.closest('[data-picker-add]');
    if (add) { pickerAdd(add.dataset.pickerAdd, { slug: add.dataset.slug, name: add.dataset.name }); return; }
    if (target.closest('[data-create-ideas]')) { loadIdeas(); return; }
    if (target.closest('[data-create-edit-brief]')) { flow.ideasError = null; goStep('brief'); return; }
    const compose = target.closest('[data-create-compose]');
    if (compose) { composeIdea(Number(compose.dataset.createCompose)); return; }
    if (target.closest('[data-create-rename]')) { renameDraft(); return; }
    if (target.closest('[data-create-approve]')) { approveDraft(); return; }
    if (target.closest('[data-create-discard]')) { discardDraft(); return; }
    if (target.closest('[data-sub-stock]')) { flow.substitute.inStock = !flow.substitute.inStock; loadSubstitutes(); return; }
    if (target.closest('[data-sub-retry]')) { loadSubstitutes(); return; }
    if (target.closest('[data-sub-change]')) { flow.substitute = { ...flow.substitute, ingredient: null, data: null, error: null }; flow.picker = { kind: 'substitute', query: '', results: [] }; renderCreate(); document.getElementById('flavor-picker-substitute')?.focus(); return; }
    const open = target.closest('[data-sub-open]');
    if (open && open.dataset.subOpen) { closeCreate(); navigate(mapHash(open.dataset.subOpen)); }
  }

  function onCreateChange(event) {
    if (event.target.matches?.('[data-brief-goal]')) flow.brief.goal = event.target.value;
  }

  // True while the name field holds a name the prepared draft doesn't have:
  // Approve waits for "Use this name" so the saved name is the one shown.
  function renamePending() {
    return flow.renameValue !== null && flow.renameValue !== undefined
      && flow.renameValue.trim() !== String(flow.preview?.draft?.name ?? '').trim();
  }

  function onCreateInput(event) {
    const input = event.target;
    if (input.id === 'flavor-draft-name') {
      flow.renameValue = input.value;
      const approve = flow.root?.querySelector('[data-create-approve]');
      if (approve) approve.disabled = flow.busy || Boolean(flow.nameError) || Boolean(flow.preview?.approved) || renamePending();
      const help = document.getElementById('flavor-draft-name-help');
      if (help) help.textContent = renamePending() ? 'Tap “Use this name” to prepare the draft with this name before approving.' : 'Renaming prepares the draft again with the new name.';
      return;
    }
    const kind = input.dataset?.picker;
    if (!kind) return;
    flow.picker = { kind, query: input.value, results: flow.picker?.kind === kind ? flow.picker.results : [], note: null };
    clearTimeout(flow.pickerTimer);
    if (input.value.trim().length < 2) { flow.picker.results = []; renderCreate(); return; }
    flow.pickerTimer = setTimeout(() => pickerSearch(kind, input.value), 250);
  }

  function onCreateKeydown(event) {
    const input = event.target;
    if (input.dataset?.picker && event.key === 'Enter') {
      event.preventDefault();
      const first = flow.picker?.kind === input.dataset.picker ? flow.picker.results?.[0] : null;
      if (first) pickerAdd(input.dataset.picker, { slug: first.slug, name: first.name });
    }
    if (input.id === 'flavor-draft-name' && event.key === 'Enter') { event.preventDefault(); renameDraft(); }
  }

  async function pickerSearch(kind, query) {
    const seq = ++flow.pickerSeq;
    try {
      const data = await api('flavor-search', { params: { q: query.trim().slice(0, 100), limit: 6 } });
      if (seq !== flow.pickerSeq || !flow.root) return;
      const results = Array.isArray(data.results) ? data.results : [];
      flow.picker = { kind, query, results, note: results.length ? null : 'No ingredient matches that search.' };
    } catch (error) {
      if (seq !== flow.pickerSeq || !flow.root) return;
      flow.picker = { kind, query, results: [], note: message(error, MAP_MESSAGES.unavailable) };
    }
    renderCreate();
  }

  function pickerAdd(kind, entry) {
    if (!entry.slug) return;
    flow.picker = null;
    if (kind === 'seed' && !flow.brief.seed.some((seed) => seed.slug === entry.slug)) flow.brief.seed = [...flow.brief.seed, entry].slice(0, 4);
    if (kind === 'exclude' && !flow.brief.excludeIngredients.some((seed) => seed.slug === entry.slug)) flow.brief.excludeIngredients = [...flow.brief.excludeIngredients, entry].slice(0, 10);
    if (kind === 'substitute') {
      flow.substitute = { ...flow.substitute, ingredient: entry, data: null, error: null };
      renderCreate();
      loadSubstitutes();
      return;
    }
    renderCreate();
    document.getElementById(`flavor-picker-${kind}`)?.focus();
  }

  function chooseOption(key) {
    if (key === 'stock') { flow.brief = defaultBrief(); goStep('brief'); return; }
    if (key === 'substitute') {
      flow.substitute = { ingredient: null, inStock: false, data: null, error: null, loading: false };
      flow.picker = { kind: 'substitute', query: '', results: [] };
      goStep('substitute');
      document.getElementById('flavor-picker-substitute')?.focus();
      return;
    }
    closeCreate();
    if (key === 'pair') {
      navigate('#recipes/flavor');
      window.requestAnimationFrame(() => document.getElementById('flavor-search')?.focus());
      return;
    }
    navigate('#recipes/flavor');
  }

  function stepBack() {
    if (flow.step === 'preview') { discardDraft(); return; }
    if (flow.step === 'ideas') { goStep('brief'); return; }
    goStep('choose');
  }

  function briefBody() {
    const brief = flow.brief;
    const body = { type: brief.type || null, no_new_purchases: brief.noNewPurchases, goal: brief.goal || 'balanced', limit: 5 };
    if (brief.seed.length) body.seed = brief.seed.map((entry) => entry.slug);
    const exclude = {};
    if (brief.excludeFamilies.length) exclude.families = brief.excludeFamilies;
    if (brief.excludeIngredients.length) exclude.ingredients = brief.excludeIngredients.map((entry) => entry.slug);
    if (Object.keys(exclude).length) body.exclude = exclude;
    return body;
  }

  async function loadIdeas({ note = null } = {}) {
    if (flow.busy) return;
    flow.busy = true;
    flow.ideasError = null;
    renderCreate();
    try {
      const data = await api('flavor-candidates', { body: briefBody(), messages: IDEAS_MESSAGES });
      if (!flow.root) return;
      flow.busy = false;
      if (Array.isArray(data.needs_clarification) && data.needs_clarification.length) {
        flow.ideasError = `Atlas isn’t sure which ingredient you meant: ${data.needs_clarification.map((entry) => entry.query).join(', ')}. Pick it from the search list.`;
        goStep('brief');
        return;
      }
      flow.ideas = data;
      flow.ideasError = note;
      goStep('ideas');
    } catch (error) {
      if (!flow.root) return;
      flow.busy = false;
      flow.ideasError = message(error, IDEAS_MESSAGES.unavailable);
      if (flow.step === 'ideas') renderCreate(); else goStep('brief');
    }
  }

  async function composeIdea(index, name = null) {
    const candidate = flow.ideas?.candidates?.[index];
    if (!candidate || flow.busy) return;
    flow.busy = true;
    flow.previewError = null;
    renderCreate();
    try {
      const data = await api('flavor-compose', { body: { candidate: candidate.compose_request || { candidate_key: candidate.key }, name }, messages: COMPOSE_MESSAGES });
      if (!flow.root) { if (data?.proposal?.id) rejectProposal(data.proposal.id); return; }
      flow.busy = false;
      flow.preview = { proposal: data.proposal, draft: data.draft || {}, index, approved: false };
      flow.renameValue = null;
      flow.nameError = null;
      goStep('preview');
    } catch (error) {
      if (!flow.root) return;
      flow.busy = false;
      if (error?.kind === 'conflict' || error?.kind === 'not_found') {
        // The idea is stale: refresh the ideas from current stock.
        flow.step = 'ideas';
        loadIdeas({ note: message(error, COMPOSE_MESSAGES.conflict) });
        return;
      }
      if (flow.step === 'preview') { flow.previewError = message(error, COMPOSE_MESSAGES.unavailable); renderCreate(); return; }
      flow.ideasError = message(error, COMPOSE_MESSAGES.unavailable);
      renderCreate();
    }
  }

  async function renameDraft() {
    if (!flow.preview || flow.busy) return;
    const input = document.getElementById('flavor-draft-name');
    const name = String(input?.value ?? flow.renameValue ?? '').trim().slice(0, 120);
    if (!name) {
      flow.nameError = 'Give the draft a name.';
      renderCreate();
      document.getElementById('flavor-draft-name')?.focus();
      return;
    }
    const previous = flow.preview.proposal?.id;
    const index = flow.preview.index;
    flow.busy = true;
    flow.previewError = null;
    renderCreate();
    try {
      const candidate = flow.ideas?.candidates?.[index];
      const data = await api('flavor-compose', { body: { candidate: candidate.compose_request || { candidate_key: candidate.key }, name }, messages: COMPOSE_MESSAGES });
      if (!flow.root) { if (data?.proposal?.id) rejectProposal(data.proposal.id); return; }
      if (previous && !flow.preview?.proposal?.spent) rejectProposal(previous);
      flow.busy = false;
      flow.preview = { proposal: data.proposal, draft: data.draft || {}, index, approved: false };
      flow.renameValue = null;
      flow.nameError = null;
      renderCreate();
      window.AtlasShell?.toast?.('Draft prepared with the new name. Nothing is saved yet.', { tone: 'info' });
    } catch (error) {
      if (!flow.root) return;
      flow.busy = false;
      if (error?.kind === 'conflict' || error?.kind === 'not_found') {
        if (previous && !flow.preview?.proposal?.spent) rejectProposal(previous);
        flow.preview = null;
        flow.step = 'ideas';
        loadIdeas({ note: message(error, COMPOSE_MESSAGES.conflict) });
        return;
      }
      flow.previewError = message(error, COMPOSE_MESSAGES.unavailable);
      renderCreate();
    }
  }

  function rejectProposal(id) {
    if (!id) return Promise.resolve();
    return api('reject-action', { body: { action_id: id } }).catch(() => { /* an unapproved proposal expires on its own */ });
  }

  async function approveDraft() {
    const preview = flow.preview;
    if (!preview?.proposal?.id || flow.busy || preview.approved || renamePending()) return;
    flow.busy = true;
    flow.approving = preview.proposal.id;
    flow.previewError = null;
    renderCreate();
    // The Approve button is now disabled: keep focus in the sheet (on its
    // title) so the keyboard, Escape included, still reaches the sheet.
    document.getElementById('flavor-create-title')?.focus({ preventScroll: true });
    try {
      const result = await api('execute-action', { body: { action_id: preview.proposal.id }, messages: APPROVE_MESSAGES });
      flow.approving = null;
      flow.busy = false;
      if (result?.ok === true) {
        preview.approved = true;
        const record = Array.isArray(result.result?.records) ? result.result.records[0] : null;
        const route = record && typeof record.route === 'string' && record.route.startsWith('#recipes/') ? record.route : '#recipes';
        toast(`Draft recipe “${record?.label || preview.draft?.name || 'draft'}” saved. It is inactive and not on the menu.`, 'success');
        closeCreate();
        try { await window.atlasReloadData?.(); } catch { /* the recipe page shows its own load state */ }
        navigate(route);
        return;
      }
      if (!flow.root || flow.preview !== preview) {
        toast(RESULT_MESSAGES[String(result?.error?.code || '')] || 'The draft couldn’t be saved. Nothing was saved.', 'warning');
        return;
      }
      const code = String(result?.error?.code || 'failed');
      if (code === 'name_taken') {
        flow.nameError = RESULT_MESSAGES.name_taken;
        // The stored proposal is spent; the renamed draft is a new one.
        preview.proposal = { ...preview.proposal, spent: true };
        renderCreate();
        const input = document.getElementById('flavor-draft-name');
        input?.focus();
        input?.select?.();
        return;
      }
      flow.previewError = RESULT_MESSAGES[code] || 'The draft couldn’t be saved. Nothing was saved. Prepare it again.';
      preview.approved = false;
      renderCreate();
    } catch (error) {
      flow.approving = null;
      flow.busy = false;
      // The request may have reached Atlas: the outcome is unknown, so this
      // proposal is never rejected and the copy never claims nothing was saved.
      preview.outcomeUnknown = true;
      if (!flow.root || flow.preview !== preview) {
        toast('Atlas couldn’t confirm the approval. Check Recipes › Drafts before preparing it again.', 'warning');
        return;
      }
      flow.previewError = message(error, APPROVE_MESSAGES.unavailable);
      renderCreate();
    }
  }

  async function discardDraft() {
    if (flow.busy) return;
    const id = flow.preview?.proposal?.id;
    const spent = flow.preview?.proposal?.spent;
    const unknown = Boolean(flow.preview?.outcomeUnknown);
    flow.preview = null;
    flow.nameError = null;
    flow.previewError = null;
    flow.renameValue = null;
    if (id && !spent && !unknown) await rejectProposal(id);
    toast(unknown ? 'Draft closed. If the approval went through, the recipe is in Recipes › Drafts.' : 'Draft discarded. Nothing was saved.', 'info');
    if (flow.root) goStep(flow.ideas ? 'ideas' : 'brief');
  }

  async function loadSubstitutes() {
    const sub = flow.substitute;
    if (!sub?.ingredient) return;
    sub.loading = true;
    sub.error = null;
    renderCreate();
    const params = { ingredient: sub.ingredient.slug, limit: 8 };
    if (sub.inStock) params.in_stock_only = 'true';
    try {
      const data = await api('flavor-substitutes', { params });
      if (!flow.root || flow.substitute !== sub) return;
      sub.loading = false;
      if (Array.isArray(data.needs_clarification) && data.needs_clarification.length) {
        sub.error = 'Atlas isn’t sure which ingredient you meant. Choose it from the search list.';
      } else sub.data = data;
    } catch (error) {
      if (!flow.root || flow.substitute !== sub) return;
      sub.loading = false;
      sub.error = message(error, MAP_MESSAGES.unavailable);
    }
    renderCreate();
  }

  window.AtlasFlavorMap = Object.freeze({
    mount,
    unmount,
    openCreate,
    isMounted: () => state.mounted
  });
})();
