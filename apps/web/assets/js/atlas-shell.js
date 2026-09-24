// Atlas shell: the single owner of navigation, view lifecycle, routes, Home
// composition, canonical actions, the notifications feed and runtime loading.
//
// Before S88 the shell's globals (setActiveView, loadAll, renderAtlasHome) were
// reassigned by up to five modules, two of them loaded asynchronously, so the
// effective call chain depended on script arrival order. Modules now register
// with this API instead of wrapping each other:
//
//   views     registerView(name, { root, title, display, render, onShow, onHide, guard })
//             show(name, params, options) · current() · params() · onView(name, { show, hide })
//   events    on(type, fn) / off / once / emit(type, detail)
//             view:before-show · view:hide · view:show · data:loaded · profile:ready
//             home:rendered · view:registered · view:unregistered
//             actions:changed · action:run · action:denied · notify:changed · notify:open · notify:close
//   routes    parseRoute(hash) · href(view, params) · navigate(hash | {view, params})
//             startRouting()   (#view[/sub[/id]][?query], spec route table + legacy aliases)
//   home      home.contribute(key, { render, focusRows, order }) · home.rows(ctx) · home.render()
//             registerHomeSection(id, renderFn, order)   (DOM-rendering sections, current Home)
//   data      onDataLoaded(fn) · dataLoaded(detail) · profileReady(profile) · profile()
//   actions   actions.register(def) · actions.run(id, ctx) · actions.list(ctx) · actions.get(id)
//   notify    notify.push(item) · notify.contribute(key, fn) · notify.items({ filter })
//             notify.unreadCount() · notify.markRead(id) · notify.markAllRead()
//             notify.open() / close() / toggle() / isOpen() · notify.setPanel(panel)
//   links     links.register(type, handler) · links.open(type, key)   (registerLink / openLink)
//   modules   modules.ensure({ js, global }) · load(src, options)       (deduplicated loader)
//
// Loaded as a classic script before config.js and every module. It installs one
// capture-phase and one bubbling document click listener (navigation) and the
// popstate/hashchange listeners; it never replaces a browser or module API.
(function (root) {
  'use strict';

  if (root.AtlasShell && root.AtlasShell.version) return;

  const VERSION = 's88-shell-2';
  // Internal view-id aliases accepted by show().
  const ALIASES = Object.freeze({ home: 'dashboard', '': 'dashboard' });
  // Shell events that older modules still observe as window events.
  const WINDOW_EVENTS = Object.freeze({
    'view:show': 'atlas:view-change',
    'profile:ready': 'atlas:profile-ready',
    'data:loaded': 'atlas:data-loaded'
  });
  // Navigation triggers routed by the shell's document listeners.
  const NAV_SELECTOR = '.atlas-nav .nav-item[data-view], .inventory-workspace-tab[data-view]';
  const SERVICE_SELECTOR = '[data-service-view]';
  const SEVERITY_RANK = Object.freeze({ danger: 0, warning: 1, info: 2 });
  const READ_STORAGE_KEY = 'atlas.notifications.read.v1';

  const views = new Map();
  const listeners = new Map();
  const homeSections = new Map();
  const homeContributions = new Map();
  const links = new Map();
  const loads = new Map();
  const actionRegistry = new Map();
  const notifyPushed = new Map();
  const notifyContributors = new Map();
  const metrics = { shows: {}, renders: {}, home: {}, homeRenders: 0, events: [] };

  let registrationSequence = 0;
  let showToken = 0;
  let current = null;
  let currentParams = {};
  let layout = null;
  let routing = false;
  let replaceNextRoute = false;
  let pending = null;
  let lastProfile = null;
  let dataLoadedAt = 0;
  let notifyPanel = null;
  let notifyIsOpen = false;
  let readIds = null;

  // A failing module must not stop the rest of the lifecycle. The error is
  // reported as uncaught (visible in the console and to page-error monitors)
  // instead of being swallowed.
  function report(error) {
    if (typeof root.reportError === 'function') root.reportError(error);
    else if (root.console) root.console.error(error);
  }

  function safe(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (error) { report(error); return undefined; }
  }

  function canonicalName(name) {
    const value = String(name ?? '').trim();
    return Object.prototype.hasOwnProperty.call(ALIASES, value) ? ALIASES[value] : value;
  }

  // ---------- events ----------

  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    listeners.get(type)?.delete(fn);
  }

  function once(type, fn) {
    const remove = on(type, (detail) => { remove(); fn(detail); });
    return remove;
  }

  // Lifecycle hooks for a view another script registered (for example a
  // module that renders into a base-shell view such as #knowledge-view).
  function onView(name, hooks = {}) {
    const key = canonicalName(name);
    const removers = [];
    if (typeof hooks.show === 'function') removers.push(on('view:show', (detail) => { if (detail.view === key) hooks.show(detail.params || {}, detail); }));
    if (typeof hooks.hide === 'function') removers.push(on('view:hide', (detail) => { if (detail.view === key) hooks.hide(detail); }));
    return () => removers.forEach((remove) => remove());
  }

  function emit(type, detail = {}) {
    if (metrics.events.length > 400) metrics.events.splice(0, 200);
    metrics.events.push({ type, view: detail?.view ?? null });
    [...(listeners.get(type) || [])].forEach((fn) => safe(fn, detail));
    const windowType = WINDOW_EVENTS[type];
    if (windowType && typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent(windowType, { detail }));
    }
  }

  // ---------- routes ----------
  //
  // Public routes follow docs/design/Atlas_Experience_Redesign.md §3.4 and map
  // to internal view ids (the Messages view keeps its internal id 'team').
  // A resolver returns candidates in priority order; the first candidate whose
  // view is registered wins, so a legacy hash keeps working both before and
  // after the page it names is retired (for example #brain → Brain today,
  // Home once Brain is gone).

  const section = (value, extra = {}) => (value ? { section: value, ...extra } : { ...extra });

  const ROUTES = {
    home: () => [['dashboard']],
    ai: (rest) => [['ai', rest[0] === 'c' ? { conversation: rest[1] || '' } : rest[0] === 'new' ? { new: '1' } : section(rest[0])]],
    messages: (rest) => [['team', rest[0] ? { conversation: rest[0] } : {}]],
    operations: (rest) => [['operations', section(rest[0])]],
    inventory: (rest) => {
      if (rest[0] === 'item' && rest[1]) return [['inventory', { item: rest[1] }]];
      if (rest[0] === 'counts') return [['inventory', section('stock-count', rest[1] ? { session: rest[1] } : {})]];
      if (rest[0] === 'movements') return [['movements']];
      if (rest[0] === 'waste') return [['waste']];
      return [['inventory', section(rest[0])]];
    },
    recipes: (rest) => [['recipes', rest[0] ? { recipe: rest[0], ...(rest[1] === 'edit' ? { edit: '1' } : {}) } : {}]],
    purchasing: (rest) => {
      if (rest[0] === 'order' && rest[1]) return [['suppliers', { section: 'orders', order: rest[1] }]];
      if (rest[0] === 'suppliers' && rest[1]) return [['suppliers', { section: 'suppliers', supplier: rest[1] }]];
      return [['suppliers', section(rest[0])]];
    },
    shifts: (rest) => [['shifts', section(rest[0])]],
    team: (rest) => [['team-profiles', rest[0] ? { profile: rest[0] } : {}]],
    knowledge: (rest) => [['knowledge', ['required', 'training'].includes(rest[0]) ? section(rest[0]) : rest[0] ? { article: rest[0] } : {}]],
    reports: (rest) => [['reports', section(rest[0])]],
    marketing: (rest) => [['marketing', section(rest[0])]],
    data: (rest) => {
      if (rest[0] === 'import-review') return [['data', section('import-review')], ['sprint3-review']];
      if (rest[0] === 'import' && rest[1]) return [['data', section('import', { batch: rest[1] })], ['imports']];
      if (rest[0]) return [['data', section(rest[0])]];
      return [['data'], ['imports']];
    },
    settings: (rest) => (rest[0] === 'system' ? [['system'], ['settings', section('system')]] : [['settings', section(rest[0])]]),
    // Legacy aliases, kept for one release (spec §3.4).
    dashboard: () => [['dashboard']],
    suppliers: () => [['suppliers', section('suppliers')]],
    imports: () => [['data'], ['imports']],
    'sprint3-review': () => [['sprint3-review'], ['data', section('import-review')]],
    movements: () => [['movements']],
    waste: () => [['waste']],
    brain: () => [['brain'], ['dashboard']],
    business: () => [['business'], ['reports', section('overview')]],
    system: () => [['system'], ['settings', section('system')]],
    'team-profiles': () => [['team-profiles']]
  };

  function decode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function chooseCandidate(candidates) {
    const list = candidates.filter((candidate) => candidate && candidate[0]);
    const registered = list.find(([view]) => views.has(view));
    return registered || list[0] || ['dashboard'];
  }

  // parseRoute('#purchasing/order/42?from=ai') → { view: 'suppliers', params: { section: 'orders', order: '42', from: 'ai' }, route: 'purchasing/order/42' }
  function parseRoute(input) {
    let text = String(input ?? '').trim();
    const hashAt = text.indexOf('#');
    if (hashAt >= 0) text = text.slice(hashAt + 1);
    const queryAt = text.indexOf('?');
    const pathPart = queryAt >= 0 ? text.slice(0, queryAt) : text;
    const query = queryAt >= 0 ? text.slice(queryAt + 1) : '';
    const segments = pathPart.split('/').filter(Boolean).map(decode);
    const queryParams = {};
    if (query) {
      query.split('&').filter(Boolean).forEach((pair) => {
        const equals = pair.indexOf('=');
        const key = decode((equals >= 0 ? pair.slice(0, equals) : pair).replace(/\+/g, ' '));
        const value = decode((equals >= 0 ? pair.slice(equals + 1) : '').replace(/\+/g, ' '));
        if (key) queryParams[key] = value;
      });
    }
    const [head = '', ...rest] = segments;
    if (head === 'notifications') return { view: null, params: queryParams, route: 'notifications', panel: 'notifications' };
    const resolver = Object.prototype.hasOwnProperty.call(ROUTES, head) ? ROUTES[head] : null;
    const [view, routeParams = {}] = resolver
      ? chooseCandidate(resolver(rest))
      : [canonicalName(head), section(rest[0])];
    return { view: canonicalName(view), params: { ...queryParams, ...routeParams }, route: segments.join('/') };
  }

  function takeParam(params, key) {
    const value = params[key];
    delete params[key];
    return value == null || value === '' ? null : String(value);
  }

  // href('suppliers', { section: 'deliveries' }) → '#purchasing/deliveries'
  function href(view, params = {}) {
    const name = canonicalName(view);
    const rest = { ...(params || {}) };
    let path;
    switch (name) {
      case 'dashboard': path = ['home']; break;
      case 'team': path = ['messages', takeParam(rest, 'conversation')]; break;
      case 'team-profiles': path = ['team', takeParam(rest, 'profile')]; break;
      case 'movements': path = ['inventory', 'movements']; break;
      case 'waste': path = ['inventory', 'waste']; break;
      case 'imports': path = ['data']; break;
      case 'sprint3-review': path = ['data', 'import-review']; break;
      case 'system': path = ['settings', 'system']; break;
      case 'inventory': {
        const item = takeParam(rest, 'item');
        const part = takeParam(rest, 'section');
        const session = takeParam(rest, 'session');
        path = item ? ['inventory', 'item', item] : part === 'stock-count' ? ['inventory', 'counts', session] : ['inventory', part];
        break;
      }
      case 'suppliers': {
        const order = takeParam(rest, 'order');
        const supplier = takeParam(rest, 'supplier');
        const part = takeParam(rest, 'section');
        path = order ? ['purchasing', 'order', order] : supplier ? ['purchasing', 'suppliers', supplier] : ['purchasing', part];
        break;
      }
      case 'recipes': {
        const recipe = takeParam(rest, 'recipe');
        const edit = takeParam(rest, 'edit');
        path = ['recipes', recipe, recipe && edit ? 'edit' : null];
        break;
      }
      case 'knowledge': {
        const article = takeParam(rest, 'article');
        path = ['knowledge', article || takeParam(rest, 'section')];
        break;
      }
      default: path = [name, takeParam(rest, 'section')];
    }
    const query = Object.entries(rest)
      .filter(([key, value]) => key && value != null && value !== '' && typeof value !== 'object' && typeof value !== 'function')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    return `#${path.filter(Boolean).map((part) => encodeURIComponent(part)).join('/')}${query ? `?${query}` : ''}`;
  }

  function routeMatches(route, name, params) {
    if (route.view !== name) return false;
    return Object.entries(params || {}).every(([key, value]) => (
      value == null || typeof value === 'object' || String(route.params[key] ?? '') === String(value)
    ));
  }

  function writeRoute(name, params) {
    if (!routing || !root.history || !root.location) return;
    const replace = replaceNextRoute;
    replaceNextRoute = false;
    if (routeMatches(parseRoute(root.location.hash), name, params)) return;
    try {
      if (replace) root.history.replaceState(root.history.state, '', href(name, params));
      else root.history.pushState(null, '', href(name, params));
    } catch (error) { report(error); }
  }

  function handleRouteChange() {
    if (!routing) return;
    const route = parseRoute(root.location.hash);
    if (route.panel === 'notifications') { openNotifications(); return; }
    const sameParams = Object.keys(route.params).length === Object.keys(currentParams).filter((key) => currentParams[key] != null).length;
    if (route.view === current && routeMatches(route, current, currentParams) && sameParams) return;
    show(route.view, route.params, { history: false, source: 'history' });
  }

  function startRouting() {
    if (routing) return;
    routing = true;
    replaceNextRoute = true;
  }

  // ---------- views ----------

  function resolveRoot(entry) {
    const spec = entry.root;
    if (!spec) return null;
    if (typeof spec === 'function') return safe(spec) || null;
    if (typeof spec === 'string') return root.document?.getElementById(spec) || null;
    return spec;
  }

  function registerView(name, definition = {}) {
    const key = canonicalName(name);
    if (!key) throw new Error('AtlasShell.registerView needs a view name.');
    const entry = {
      name: key,
      root: definition.root ?? null,
      title: definition.title ?? null,
      display: definition.display || 'block',
      render: definition.render || null,
      onShow: definition.onShow || null,
      onHide: definition.onHide || null,
      guard: definition.guard || null,
      sequence: ++registrationSequence
    };
    views.set(key, entry);
    emit('view:registered', { view: key });
    if (pending && pending.name === key) {
      const request = pending;
      pending = null;
      show(request.name, request.params, request.options);
    }
    return () => unregisterView(key, entry);
  }

  function unregisterView(name, entry) {
    const key = canonicalName(name);
    if (entry && views.get(key) !== entry) return false;
    const removed = views.delete(key);
    if (removed) emit('view:unregistered', { view: key });
    return removed;
  }

  function getView(name) {
    const entry = views.get(canonicalName(name));
    if (!entry) return null;
    return { name: entry.name, title: entry.title, display: entry.display, root: resolveRoot(entry) };
  }

  function viewNames() {
    return [...views.keys()];
  }

  function defaultLayout(name, entry) {
    const document = root.document;
    if (!document) return;
    if (document.body) document.body.dataset.atlasView = name;
    views.forEach((candidate) => {
      const element = resolveRoot(candidate);
      if (element && candidate !== entry) element.style.display = 'none';
    });
    const element = resolveRoot(entry);
    if (element) element.style.display = entry.display;
  }

  function show(name, params = {}, options = {}) {
    const key = canonicalName(name);
    const entry = views.get(key);
    const source = options.source || 'api';
    if (!entry) {
      // A destination whose module has not loaded yet opens as soon as it registers.
      pending = { name: key, params: params || {}, options };
      return false;
    }
    if (entry.guard) {
      const verdict = safe(entry.guard, params || {}, { source });
      if (verdict === false) return false;
      if (typeof verdict === 'string' && canonicalName(verdict) !== key) {
        return show(verdict, {}, { ...options, source });
      }
    }
    const token = ++showToken;
    const previous = current;
    const context = { view: key, previous, params: params || {}, source, trigger: options.trigger || null, event: options.event || null };

    // Order per navigation: view:before-show → layout (roots, title, nav state,
    // address bar) → previous view's onHide + view:hide → render → onShow →
    // view:show. Hide runs after layout so handlers see the view already hidden.
    // A nested show() (a guard or hook navigating elsewhere) ends this one.
    emit('view:before-show', context);
    if (token !== showToken) return true;

    current = key;
    currentParams = { ...(params || {}) };
    pending = null;
    metrics.shows[key] = (metrics.shows[key] || 0) + 1;
    safe(layout || defaultLayout, key, entry, context);
    if (options.history !== false) writeRoute(key, currentParams);
    if (token !== showToken) return true;

    if (previous && previous !== key) {
      const previousEntry = views.get(previous);
      if (previousEntry?.onHide) safe(previousEntry.onHide, { view: previous, next: key, source });
      emit('view:hide', { view: previous, next: key, source });
      if (token !== showToken) return true;
    }

    if (entry.render) {
      metrics.renders[key] = (metrics.renders[key] || 0) + 1;
      safe(entry.render, context.params, context);
      if (token !== showToken) return true;
    }
    if (entry.onShow) {
      safe(entry.onShow, context.params, context);
      if (token !== showToken) return true;
    }
    emit('view:show', context);
    return true;
  }

  function navigate(target, options = {}) {
    const route = typeof target === 'string' ? parseRoute(target) : { view: canonicalName(target?.view), params: target?.params || {} };
    if (route.panel === 'notifications') return openNotifications();
    return show(route.view, route.params, { source: 'link', ...options });
  }

  // ---------- Home composition ----------

  // DOM-rendering Home sections, run in order by renderHome(). The base shell's
  // section ('core', order 0) writes the metrics and focus list; modules add or
  // update their own rows (Operations 10, Brain 20, Business 30, Checkpoint A 40/50).
  function registerHomeSection(id, renderFn, order = 100) {
    const key = String(id || '').trim();
    if (!key || typeof renderFn !== 'function') throw new Error('AtlasShell.registerHomeSection needs an id and a render function.');
    const existing = homeSections.get(key);
    homeSections.set(key, { id: key, render: renderFn, order: Number(order) || 0, sequence: existing?.sequence || ++registrationSequence });
    return () => { if (homeSections.get(key)?.render === renderFn) homeSections.delete(key); };
  }

  function orderedHomeSections() {
    return [...homeSections.values()].sort((a, b) => (a.order - b.order) || (a.sequence - b.sequence));
  }

  function renderHome(reason = 'render') {
    metrics.homeRenders += 1;
    const order = [];
    orderedHomeSections().forEach((entry) => {
      metrics.home[entry.id] = (metrics.home[entry.id] || 0) + 1;
      order.push(entry.id);
      safe(entry.render, { reason });
    });
    emit('home:rendered', { sections: order, reason });
    return order;
  }

  function renderHomeSection(id, reason = 'update') {
    const entry = homeSections.get(String(id || ''));
    if (!entry) return false;
    metrics.home[entry.id] = (metrics.home[entry.id] || 0) + 1;
    safe(entry.render, { reason });
    return true;
  }

  // Spec §7.1 contribution: { render?, focusRows?(ctx) → Row[], order? }.
  // Row: { id, severity: 'danger'|'warning'|'info', icon, title, detail,
  //        action: { label, actionId | route }, due?, roles? }
  function contributeHome(key, contribution = {}) {
    const id = String(key || '').trim();
    if (!id) throw new Error('AtlasShell.home.contribute needs a key.');
    const removers = [];
    if (typeof contribution.render === 'function') removers.push(registerHomeSection(id, contribution.render, contribution.order ?? 100));
    if (typeof contribution.focusRows === 'function') {
      homeContributions.set(id, { key: id, focusRows: contribution.focusRows, order: Number(contribution.order ?? 100) || 0 });
      removers.push(() => homeContributions.delete(id));
      emit('notify:changed', { source: `home:${id}` });
    }
    return () => removers.forEach((remove) => remove());
  }

  function currentRole(context = {}) {
    return context.role ?? lastProfile?.role ?? null;
  }

  function roleAllows(roles, context) {
    if (!Array.isArray(roles) || !roles.length) return true;
    const role = currentRole(context);
    return Boolean(role) && roles.includes(role);
  }

  function dueValue(row) {
    const value = row.due ? Date.parse(row.due) : NaN;
    return Number.isFinite(value) ? value : Infinity;
  }

  function homeRows(context = {}) {
    const rows = [];
    [...homeContributions.values()].sort((a, b) => a.order - b.order).forEach((entry) => {
      const result = safe(entry.focusRows, context);
      (Array.isArray(result) ? result : []).forEach((row) => {
        if (!row || !row.title || !roleAllows(row.roles, context)) return;
        rows.push({ severity: 'info', ...row, id: `${entry.key}:${row.id ?? rows.length}`, source: entry.key });
      });
    });
    return rows.sort((a, b) => ((SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)) || (dueValue(a) - dueValue(b)));
  }

  // ---------- data and profile lifecycle ----------

  function onDataLoaded(fn) { return on('data:loaded', fn); }

  function dataLoaded(detail = {}) {
    dataLoadedAt = Date.now();
    emit('data:loaded', { at: dataLoadedAt, ...detail });
    emit('notify:changed', { source: 'data' });
  }

  function profileReady(profile) {
    lastProfile = profile ?? null;
    emit('profile:ready', lastProfile);
  }

  // ---------- canonical actions (spec §4.8) ----------
  //
  // One label, icon, permission check and implementation per action; the
  // palette, the + button, Home rows, notifications and Atlas AI all call
  // actions.run(id, ctx).

  function registerAction(definition = {}) {
    const id = String(definition.id || '').trim();
    if (!id || typeof definition.run !== 'function') throw new Error('AtlasShell.actions.register needs an id and a run function.');
    const entry = {
      id,
      label: String(definition.label || id),
      icon: definition.icon || null,
      keywords: Array.isArray(definition.keywords) ? definition.keywords.map(String) : [],
      roles: Array.isArray(definition.roles) ? definition.roles.map(String) : null,
      contexts: Array.isArray(definition.contexts) ? definition.contexts.map(String) : [],
      forRecord: definition.forRecord || null,
      when: typeof definition.when === 'function' ? definition.when : null,
      denied: typeof definition.denied === 'function' ? definition.denied : null,
      run: definition.run,
      sequence: ++registrationSequence
    };
    actionRegistry.set(id, entry);
    emit('actions:changed', { id });
    return () => {
      if (actionRegistry.get(id) !== entry) return;
      actionRegistry.delete(id);
      emit('actions:changed', { id });
    };
  }

  function describeAction(entry) {
    return { id: entry.id, label: entry.label, icon: entry.icon, keywords: [...entry.keywords], roles: entry.roles ? [...entry.roles] : null, contexts: [...entry.contexts], forRecord: entry.forRecord };
  }

  // ctx: { role?, context? (page key), suggested? (only actions for that context),
  //        query?, record? { type, id, label } }
  function listActions(context = {}) {
    const query = String(context.query || '').trim().toLowerCase();
    return [...actionRegistry.values()]
      .filter((entry) => roleAllows(entry.roles, context))
      .filter((entry) => !entry.when || Boolean(safe(entry.when, context)))
      .filter((entry) => !context.record || !entry.forRecord || entry.forRecord === context.record.type)
      .filter((entry) => !context.suggested || !context.context || entry.contexts.includes(context.context))
      .filter((entry) => !query || [entry.label, ...entry.keywords].some((text) => text.toLowerCase().includes(query)))
      .sort((a, b) => a.sequence - b.sequence)
      .map(describeAction);
  }

  async function runAction(id, context = {}) {
    const entry = actionRegistry.get(String(id || ''));
    if (!entry) throw new Error(`Unknown Atlas action: ${id}`);
    if (!roleAllows(entry.roles, context)) {
      emit('action:denied', { id: entry.id });
      if (entry.denied) safe(entry.denied, context);
      return { ok: false, reason: 'forbidden' };
    }
    if (entry.when && !safe(entry.when, context)) return { ok: false, reason: 'unavailable' };
    emit('action:run', { id: entry.id, context });
    const result = await entry.run(context);
    return { ok: true, result };
  }

  // ---------- notifications feed (spec §4.9) ----------
  //
  // Items: { id, type, severity, icon, title, detail, time, action: { label, actionId | route },
  // needsAction? }. Sources: pushed items, contributor functions and Home
  // attention rows. The panel UI registers itself with notify.setPanel().

  function loadReadIds() {
    if (readIds) return readIds;
    readIds = new Set();
    try {
      const stored = JSON.parse(root.localStorage?.getItem(READ_STORAGE_KEY) || '[]');
      if (Array.isArray(stored)) stored.slice(-300).forEach((id) => readIds.add(String(id)));
    } catch { /* storage unavailable: read state lasts for this page only */ }
    return readIds;
  }

  function saveReadIds() {
    try { root.localStorage?.setItem(READ_STORAGE_KEY, JSON.stringify([...loadReadIds()].slice(-300))); } catch { /* storage unavailable */ }
  }

  function normalizeNotification(item, source) {
    if (!item || !item.title) return null;
    const id = String(item.id ?? `${source}:${item.title}`);
    const severity = SEVERITY_RANK[item.severity] !== undefined ? item.severity : 'info';
    return {
      id,
      source,
      type: item.type || source,
      severity,
      icon: item.icon || null,
      title: String(item.title),
      detail: item.detail ? String(item.detail) : '',
      time: item.time ?? null,
      action: item.action || null,
      needsAction: item.needsAction ?? Boolean(item.action || severity !== 'info'),
      read: loadReadIds().has(id)
    };
  }

  function pushNotification(item) {
    const normalized = normalizeNotification(item, item?.source || 'push');
    if (!normalized) throw new Error('AtlasShell.notify.push needs an item with a title.');
    notifyPushed.set(normalized.id, { ...item, id: normalized.id });
    emit('notify:changed', { id: normalized.id });
    return normalized.id;
  }

  function removeNotification(id) {
    if (notifyPushed.delete(String(id))) emit('notify:changed', { id: String(id) });
  }

  function contributeNotifications(key, fn) {
    const id = String(key || '').trim();
    if (!id || typeof fn !== 'function') throw new Error('AtlasShell.notify.contribute needs a key and a function.');
    notifyContributors.set(id, fn);
    emit('notify:changed', { source: id });
    return () => {
      if (notifyContributors.get(id) !== fn) return;
      notifyContributors.delete(id);
      emit('notify:changed', { source: id });
    };
  }

  function timeValue(item) {
    const value = typeof item.time === 'number' ? item.time : Date.parse(item.time || '');
    return Number.isFinite(value) ? value : 0;
  }

  function notificationItems(options = {}) {
    const context = options.context || {};
    const merged = new Map();
    const add = (item, source) => {
      const normalized = normalizeNotification(item, source);
      if (normalized && !merged.has(normalized.id)) merged.set(normalized.id, normalized);
    };
    notifyPushed.forEach((item) => add(item, item.source || 'push'));
    notifyContributors.forEach((fn, key) => {
      const result = safe(fn, context);
      (Array.isArray(result) ? result : []).forEach((item) => add(item, key));
    });
    homeRows(context).forEach((row) => add({ ...row, id: `home:${row.id}`, type: 'attention', needsAction: true }, 'home'));
    let items = [...merged.values()];
    if (options.filter === 'needs-action') items = items.filter((item) => item.needsAction);
    return items.sort((a, b) => (Number(a.read) - Number(b.read)) || (timeValue(b) - timeValue(a))
      || ((SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)));
  }

  function unreadCount(options = {}) {
    return notificationItems(options).filter((item) => !item.read).length;
  }

  function markRead(id) {
    const ids = loadReadIds();
    if (ids.has(String(id))) return;
    ids.add(String(id));
    saveReadIds();
    emit('notify:changed', { id: String(id) });
  }

  function markAllRead() {
    const ids = loadReadIds();
    notificationItems().forEach((item) => ids.add(item.id));
    saveReadIds();
    emit('notify:changed', { all: true });
  }

  // Opens the item's canonical action or route and marks it read.
  function activateNotification(id, context = {}) {
    const item = notificationItems({ context }).find((entry) => entry.id === String(id));
    if (!item) return Promise.resolve({ ok: false, reason: 'not-found' });
    markRead(item.id);
    if (item.action?.actionId) return runAction(item.action.actionId, { ...context, notification: item });
    if (item.action?.route) return Promise.resolve({ ok: navigate(item.action.route, { source: 'notification' }) !== false });
    return Promise.resolve({ ok: true });
  }

  function setNotificationPanel(panel) {
    notifyPanel = panel && typeof panel.open === 'function' ? panel : null;
  }

  function openNotifications(options = {}) {
    notifyIsOpen = true;
    emit('notify:open', options);
    if (notifyPanel) safe(notifyPanel.open, options);
    return Boolean(notifyPanel);
  }

  function closeNotifications() {
    if (!notifyIsOpen) return;
    notifyIsOpen = false;
    if (notifyPanel?.close) safe(notifyPanel.close);
    emit('notify:close', {});
  }

  // ---------- typed links ----------

  function registerLink(type, handler) {
    const key = String(type || '').trim();
    if (!key || typeof handler !== 'function') throw new Error('AtlasShell.registerLink needs a type and a handler.');
    links.set(key, handler);
    return () => { if (links.get(key) === handler) links.delete(key); };
  }

  function openLink(type, key, context = {}) {
    const handler = links.get(String(type || ''));
    if (!handler) return false;
    safe(handler, key, context);
    return true;
  }

  // ---------- module loader ----------

  function scriptKey(src) {
    return String(src || '').split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\//, '');
  }

  function existingScript(key) {
    const document = root.document;
    if (!document) return null;
    return [...document.querySelectorAll('script[src]')].find((script) => scriptKey(script.getAttribute('src')) === key) || null;
  }

  // Loads a classic script once. Scripts already in the page (static tags or
  // earlier loads with a different cache key) are reused, never appended twice.
  // options: global (skip when already installed), requireGlobal (reject when
  // the script loads without installing it), async, timeout, dataset.
  function load(src, options = {}) {
    const key = scriptKey(src);
    if (!key) return Promise.reject(new Error('AtlasShell.load needs a script path.'));
    const installed = () => Boolean(options.global && root[options.global]);
    if (installed()) return Promise.resolve(root[options.global]);
    if (loads.has(key)) return loads.get(key);
    const document = root.document;
    const promise = new Promise((resolve, reject) => {
      const finish = () => {
        if (options.requireGlobal && !installed()) reject(new Error(`${key} loaded without installing ${options.global}.`));
        else resolve(installed() ? root[options.global] : true);
      };
      const existing = existingScript(key);
      if (existing) {
        if (existing.dataset.atlasShellState === 'loading' || (options.requireGlobal && !installed())) {
          existing.addEventListener('load', finish, { once: true });
          existing.addEventListener('error', () => reject(new Error(`Could not load ${key}`)), { once: true });
        } else resolve(installed() ? root[options.global] : true);
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = options.async !== undefined ? Boolean(options.async) : false;
      script.dataset.atlasShellState = 'loading';
      Object.entries(options.dataset || {}).forEach(([name, value]) => { script.dataset[name] = value; });
      let timer = null;
      if (options.timeout) {
        timer = root.setTimeout(() => {
          script.dataset.atlasShellState = 'timeout';
          loads.delete(key);
          reject(new Error(`Timed out loading ${key}`));
        }, options.timeout);
      }
      script.addEventListener('load', () => {
        if (timer) root.clearTimeout(timer);
        script.dataset.atlasShellState = 'loaded';
        finish();
      }, { once: true });
      script.addEventListener('error', () => {
        if (timer) root.clearTimeout(timer);
        script.dataset.atlasShellState = 'error';
        loads.delete(key);
        script.remove();
        reject(new Error(`Could not load ${key}`));
      }, { once: true });
      (document.body || document.head).appendChild(script);
    });
    loads.set(key, promise);
    promise.catch(() => loads.delete(key));
    return promise;
  }

  // ---------- navigation input ----------

  function navigationTrigger(event, selector) {
    const target = event.target instanceof root.Element ? event.target : null;
    const trigger = target?.closest?.(selector);
    return trigger && !trigger.disabled ? trigger : null;
  }

  // The one navigation listener for the sidebar and the Inventory section
  // tabs. It runs in the capture phase and is registered before any module, so
  // a module handler that stops propagation can never swallow navigation.
  function handleNavigation(event) {
    const trigger = navigationTrigger(event, NAV_SELECTOR);
    if (!trigger) return;
    const view = trigger.dataset.view;
    if (!view) return;
    const params = {};
    if (view === 'inventory' && trigger.dataset.inventorySection) params.section = trigger.dataset.inventorySection;
    const source = trigger.matches('.atlas-nav .nav-item') ? 'nav' : 'tab';
    show(view, params, { source, trigger, event });
  }

  // Service Mode cards route in the bubbling phase so a workspace can take over
  // its own card first (Recipes opens its service library instead).
  function handleServiceCard(event) {
    const trigger = navigationTrigger(event, SERVICE_SELECTOR);
    if (!trigger) return;
    show(trigger.dataset.serviceView, {}, { source: 'service', trigger, event });
  }

  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('click', handleNavigation, true);
    root.document.addEventListener('click', handleServiceCard);
  }
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('popstate', handleRouteChange);
    root.addEventListener('hashchange', handleRouteChange);
  }

  root.AtlasShell = {
    version: VERSION,
    // views and lifecycle
    registerView,
    unregisterView: (name) => unregisterView(name),
    view: getView,
    views: viewNames,
    show,
    current: () => current,
    params: () => ({ ...currentParams }),
    setLayout(fn) { layout = typeof fn === 'function' ? fn : null; },
    onView,
    // events
    on,
    off,
    once,
    emit,
    // routes
    navigate,
    parseRoute,
    href,
    startRouting,
    // Home
    home: {
      contribute: contributeHome,
      rows: homeRows,
      render: renderHome,
      sections: () => orderedHomeSections().map((entry) => entry.id)
    },
    registerHomeSection,
    homeSections: () => orderedHomeSections().map((entry) => entry.id),
    renderHome,
    renderHomeSection,
    // data and profile
    onDataLoaded,
    dataLoaded,
    profileReady,
    profile: () => lastProfile,
    dataLoadedAt: () => dataLoadedAt,
    // canonical actions
    actions: {
      register: registerAction,
      run: runAction,
      list: listActions,
      get: (id) => { const entry = actionRegistry.get(String(id || '')); return entry ? describeAction(entry) : null; }
    },
    // notifications feed
    notify: {
      push: pushNotification,
      remove: removeNotification,
      contribute: contributeNotifications,
      items: notificationItems,
      unreadCount,
      markRead,
      markAllRead,
      activate: activateNotification,
      open: openNotifications,
      close: closeNotifications,
      toggle: (options) => (notifyIsOpen ? closeNotifications() : openNotifications(options)),
      isOpen: () => notifyIsOpen,
      setPanel: setNotificationPanel
    },
    // typed links
    links: { register: registerLink, open: openLink },
    registerLink,
    openLink,
    // runtime modules
    modules: { ensure: ({ js, global, ...options } = {}) => load(js, { global, ...options }) },
    load,
    debug: () => JSON.parse(JSON.stringify(metrics))
  };
})(typeof window === 'undefined' ? globalThis : window);
