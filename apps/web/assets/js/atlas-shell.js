// Atlas shell: the single owner of navigation and view lifecycle.
//
// Before S88 the shell's globals (setActiveView, loadAll, renderAtlasHome) were
// reassigned by up to five modules, two of them loaded asynchronously, so the
// effective call chain depended on script arrival order. Modules now register
// with this API instead of wrapping each other:
//
//   AtlasShell.registerView(name, { root, title, display, render, onShow, onHide, guard })
//   AtlasShell.show(name, params)            one lifecycle per navigation
//   AtlasShell.on(type, fn) / off / once / emit
//   AtlasShell.registerHomeSection(id, renderFn, order)
//   AtlasShell.onDataLoaded(fn)
//   AtlasShell.parseRoute / href / navigate  (#view/section?param=value)
//   AtlasShell.registerLink(type, handler) / openLink(type, key)
//   AtlasShell.load(src, options)            deduplicated runtime script loader
//
// Loaded as a classic script before config.js and every module. It touches no
// browser API other than its own document click listener and history events.
(function (root) {
  'use strict';

  if (root.AtlasShell && root.AtlasShell.version) return;

  const VERSION = 's88-shell-1';
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

  const views = new Map();
  const listeners = new Map();
  const homeSections = new Map();
  const links = new Map();
  const loads = new Map();
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

  function parseRoute(input) {
    let text = String(input ?? '').trim();
    const hashAt = text.indexOf('#');
    if (hashAt >= 0) text = text.slice(hashAt + 1);
    const queryAt = text.indexOf('?');
    const pathPart = queryAt >= 0 ? text.slice(0, queryAt) : text;
    const query = queryAt >= 0 ? text.slice(queryAt + 1) : '';
    const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
    const segments = pathPart.split('/').filter(Boolean).map(decode);
    const params = {};
    if (query) {
      query.split('&').filter(Boolean).forEach((pair) => {
        const equals = pair.indexOf('=');
        const key = decode((equals >= 0 ? pair.slice(0, equals) : pair).replace(/\+/g, ' '));
        const value = decode((equals >= 0 ? pair.slice(equals + 1) : '').replace(/\+/g, ' '));
        if (key) params[key] = value;
      });
    }
    if (segments[1] && params.section == null) params.section = segments[1];
    return { view: canonicalName(segments[0] || ''), params };
  }

  function href(view, params = {}) {
    const name = canonicalName(view);
    const { section, ...rest } = params || {};
    const query = Object.entries(rest)
      .filter(([key, value]) => key && value != null && value !== '' && typeof value !== 'object' && typeof value !== 'function')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    if (name === 'dashboard' && !section && !query) return '';
    return `#${encodeURIComponent(name)}${section ? `/${encodeURIComponent(section)}` : ''}${query ? `?${query}` : ''}`;
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
    const target = href(name, params) || `${root.location.pathname}${root.location.search}`;
    try {
      if (replace) root.history.replaceState(root.history.state, '', target);
      else root.history.pushState(null, '', target);
    } catch (error) { report(error); }
  }

  function handleRouteChange() {
    if (!routing) return;
    const route = parseRoute(root.location.hash);
    if (route.view === current && routeMatches(route, current, currentParams)
        && Object.keys(route.params).length === Object.keys(currentParams).filter((key) => currentParams[key] != null).length) return;
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
    let key = canonicalName(name);
    let entry = views.get(key);
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
    return show(route.view, route.params, { source: 'link', ...options });
  }

  // ---------- Home composition ----------

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
    orderedHomeSections().forEach((section) => {
      metrics.home[section.id] = (metrics.home[section.id] || 0) + 1;
      order.push(section.id);
      safe(section.render, { reason });
    });
    emit('home:rendered', { sections: order, reason });
    return order;
  }

  function renderHomeSection(id, reason = 'update') {
    const section = homeSections.get(String(id || ''));
    if (!section) return false;
    metrics.home[section.id] = (metrics.home[section.id] || 0) + 1;
    safe(section.render, { reason });
    return true;
  }

  // ---------- data and profile lifecycle ----------

  function onDataLoaded(fn) { return on('data:loaded', fn); }

  function dataLoaded(detail = {}) {
    dataLoadedAt = Date.now();
    emit('data:loaded', { at: dataLoadedAt, ...detail });
  }

  function profileReady(profile) {
    lastProfile = profile ?? null;
    emit('profile:ready', lastProfile);
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
        } else resolve(options.global ? root[options.global] : true);
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
    registerView,
    unregisterView: (name) => unregisterView(name),
    view: getView,
    views: viewNames,
    show,
    current: () => current,
    params: () => ({ ...currentParams }),
    navigate,
    parseRoute,
    href,
    startRouting,
    setLayout(fn) { layout = typeof fn === 'function' ? fn : null; },
    on,
    off,
    once,
    emit,
    onView,
    registerHomeSection,
    homeSections: () => orderedHomeSections().map((section) => section.id),
    renderHome,
    renderHomeSection,
    onDataLoaded,
    dataLoaded,
    profileReady,
    profile: () => lastProfile,
    dataLoadedAt: () => dataLoadedAt,
    registerLink,
    openLink,
    load,
    debug: () => JSON.parse(JSON.stringify(metrics))
  };
})(typeof window === 'undefined' ? globalThis : window);
