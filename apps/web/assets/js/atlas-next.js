(() => {
  'use strict';

  const VERSION = 'atlas-next/0.2.2';
  const CONFIG = Object.freeze({
    supabaseUrl: window.VABAR_CONFIG?.SUPABASE_URL || 'https://dnefgcmjcgxlynycxkts.supabase.co',
    supabaseKey: window.VABAR_CONFIG?.SUPABASE_ANON_KEY || 'sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp',
    requestTimeoutMs: 12000,
    bootTimeoutMs: 15000,
    signOutTimeoutMs: 4000,
  });

  const TITLES = Object.freeze({
    home: 'Home',
    inventory: 'Inventory',
    operations: 'Operations',
    recipes: 'Recipes',
    purchasing: 'Purchasing',
    imports: 'Import Center',
    review: 'Real VÁ Data',
    marketing: 'Marketing',
    messages: 'Messages',
    team: 'Team',
    shifts: 'Shifts',
    knowledge: 'Knowledge',
    brain: 'Atlas Brain',
    business: 'Business Intelligence',
    reports: 'Reports',
    settings: 'Settings',
    system: 'System',
  });

  const CONNECTED_VIEWS = new Set(Object.keys(TITLES).filter((view) => !['home', 'inventory'].includes(view)));

  const state = {
    client: null,
    session: null,
    profile: null,
    inventory: [],
    recipes: [],
    suppliers: [],
    movements: [],
    currentView: 'home',
    commandIndex: 0,
    loadingData: false,
    inventoryQuery: '',
    inventoryCategory: 'all',
    bootStarted: false,
    bootFinished: false,
    authSubscription: null,
  };

  const dom = {};
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  function renderIcons() {
    try { window.lucide?.createIcons?.(); } catch (error) { console.warn('Atlas icons could not render.', error); }
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => window.clearTimeout(timer));
  }

  async function boundedLocalSignOut() {
    if (!state.client?.auth?.signOut) return;
    try {
      await withTimeout(
        state.client.auth.signOut({ scope: 'local' }),
        CONFIG.signOutTimeoutMs,
        'Local sign-out cleanup took too long.',
      );
    } catch (error) {
      console.warn('Atlas local sign-out cleanup warning', error);
    }
  }

  function clearSessionState() {
    state.session = null;
    state.profile = null;
    state.inventory = [];
    state.recipes = [];
    state.suppliers = [];
    state.movements = [];
    document.body.dataset.atlasRole = 'unknown';
    window.currentUser = null;
    dispatchAuth();
    dispatchData();
  }

  function cacheDom() {
    for (const id of [
      'atlas-boot', 'auth-screen', 'auth-form', 'auth-email', 'auth-password', 'auth-submit', 'auth-error',
      'app-screen', 'app-shell', 'sidebar', 'sidebar-nav', 'mobile-menu', 'page-title', 'search-trigger',
      'theme-toggle', 'service-open', 'service-overlay', 'command-palette', 'command-input', 'command-results',
      'sign-out', 'profile-avatar', 'profile-label', 'profile-email', 'home-greeting', 'home-metrics',
      'home-focus', 'evidence-status', 'inventory-search', 'inventory-category', 'inventory-rows',
      'inventory-empty', 'placeholder-eyebrow', 'placeholder-title', 'placeholder-copy', 'toast', 'review-count',
    ]) dom[id] = document.getElementById(id);
  }

  function setBoot(visible, label) {
    if (!dom['atlas-boot']) return;
    dom['atlas-boot'].hidden = !visible;
    const copy = dom['atlas-boot'].querySelector('span');
    if (copy && label) copy.textContent = label;
  }

  function setAuthError(message = '') {
    if (!dom['auth-error']) return;
    dom['auth-error'].textContent = message;
    dom['auth-error'].hidden = !message;
  }

  function setAuthBusy(busy) {
    if (!dom['auth-submit']) return;
    dom['auth-submit'].disabled = busy;
    dom['auth-submit'].textContent = busy ? 'Signing in…' : 'Sign in';
  }

  function showAuth(message = '') {
    setBoot(false);
    const url = new URL('login.html', window.location.href);
    const requested = location.hash.replace(/^#/, '').split('/')[0];
    if (requested && TITLES[requested]) url.searchParams.set('view', requested);
    if (message) url.searchParams.set('message', message);
    url.searchParams.set('from', VERSION);
    window.location.replace(url.href);
  }

  function showApp() {
    if (dom['auth-screen']) dom['auth-screen'].hidden = true;
    if (dom['app-screen']) dom['app-screen'].hidden = false;
    if (dom['app-shell']) dom['app-shell'].hidden = false;
    setBoot(false);
    renderIcons();
  }

  function showToast(message, duration = 4200) {
    if (!dom.toast || !message) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { dom.toast.hidden = true; }, duration);
  }

  function ensureLibraries() {
    if (!window.supabase?.createClient) throw new Error('The Supabase client did not load. Check the network connection and refresh.');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(CONFIG.supabaseUrl)) throw new Error('Atlas has an invalid Supabase URL.');
  }

  function dispatchAuth() {
    document.dispatchEvent(new CustomEvent('atlas:auth', {
      detail: { client: state.client, session: state.session, profile: state.profile },
    }));
  }

  function createClient() {
    ensureLibraries();
    const client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      global: { headers: { 'x-client-info': VERSION } },
    });
    window.atlasSupabase = client;
    window.sb = client;
    window.AtlasData?.configure?.(client);
    state.client = client;
    dispatchAuth();
    return client;
  }

  async function resolveProfile(user) {
    const response = await withTimeout(
      state.client.from('profiles').select('id,email,display_name,role,active').eq('id', user.id).maybeSingle(),
      CONFIG.requestTimeoutMs,
      'Profile verification took too long.',
    );
    if (response.error) throw response.error;
    const profile = response.data;
    if (!profile?.active) throw new Error('This account does not have active Atlas access. Ask an administrator to activate the profile.');
    if (!['admin', 'manager', 'bartender', 'viewer'].includes(profile.role)) throw new Error('This Atlas profile has an unsupported role.');
    return profile;
  }

  function canManageCommercial() {
    return ['admin', 'manager'].includes(state.profile?.role || '');
  }

  async function managerInventoryRequest(fields) {
    return withTimeout(
      state.client.from('inventory_items').select(fields).order('name', { ascending: true }),
      CONFIG.requestTimeoutMs,
      'Inventory took too long to respond.',
    );
  }

  async function staffInventoryRequest(fields) {
    return withTimeout(
      state.client.from('inventory_catalog').select(fields).order('name', { ascending: true }),
      CONFIG.requestTimeoutMs,
      'Inventory took too long to respond.',
    );
  }

  async function loadInventory() {
    const safeFields = 'id,name,category,quantity,unit,par_level,sku,barcode,bin_location,updated_at,active,units_per_case,size_ml,package_size';
    const managerFields = `${safeFields},supplier,supplier_id,supplier_product_reference,cost_price,case_cost,critical_minimum,lead_time_days,minimum_order_quantity`;
    let response = canManageCommercial()
      ? await managerInventoryRequest(managerFields)
      : await staffInventoryRequest(safeFields);

    if (response.error && /column|schema cache|relation/i.test(response.error.message || '')) {
      response = await managerInventoryRequest(safeFields);
    }
    if (response.error) throw response.error;
    state.inventory = Array.isArray(response.data) ? response.data.filter((item) => item.active !== false) : [];
  }

  async function loadSupportingData() {
    if (!window.AtlasData) return;
    window.AtlasData.configure?.(state.client);
    const manage = canManageCommercial();
    const [recipeResult, supplierResult, movementResult] = await Promise.allSettled([
      withTimeout(window.AtlasData.getRecipes({ canManageCommercial: manage }), CONFIG.requestTimeoutMs, 'Recipes took too long to respond.'),
      withTimeout(window.AtlasData.getSuppliers({ canManageCommercial: manage }), CONFIG.requestTimeoutMs, 'Suppliers took too long to respond.'),
      withTimeout(window.AtlasData.getInventoryMovements({ canManageCommercial: manage, movementType: 'restock' }), CONFIG.requestTimeoutMs, 'Purchasing history took too long to respond.'),
    ]);
    state.recipes = recipeResult.status === 'fulfilled' && Array.isArray(recipeResult.value) ? recipeResult.value : [];
    state.suppliers = supplierResult.status === 'fulfilled' && Array.isArray(supplierResult.value) ? supplierResult.value : [];
    state.movements = movementResult.status === 'fulfilled' && Array.isArray(movementResult.value) ? movementResult.value : [];
    for (const result of [recipeResult, supplierResult, movementResult]) {
      if (result.status === 'rejected') console.warn('Atlas supporting data warning', result.reason);
    }
  }

  function dispatchData() {
    document.dispatchEvent(new CustomEvent('atlas:data', {
      detail: {
        client: state.client,
        session: state.session,
        profile: state.profile,
        inventory: state.inventory,
        recipes: state.recipes,
        suppliers: state.suppliers,
        movements: state.movements,
      },
    }));
  }

  async function loadRuntimeData({ quiet = false } = {}) {
    if (state.loadingData) return;
    state.loadingData = true;
    if (!quiet) showToast('Refreshing live Atlas data…', 1600);
    try {
      await loadInventory();
      await loadSupportingData();
      renderHome();
      renderInventory();
      dispatchData();
      if (!quiet) showToast('Atlas data refreshed.');
    } catch (error) {
      console.error('Atlas data load failed', error);
      state.inventory = [];
      state.recipes = [];
      state.suppliers = [];
      state.movements = [];
      renderHome();
      renderInventory();
      dispatchData();
      showToast(error instanceof Error ? error.message : 'Atlas data could not load.');
    } finally {
      state.loadingData = false;
    }
  }

  function profileDisplayName() {
    const explicit = String(state.profile?.display_name || '').trim();
    if (explicit) return explicit;
    const email = state.profile?.email || state.session?.user?.email || 'Atlas staff';
    const local = email.split('@')[0] || 'Atlas staff';
    return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function installProfile() {
    const name = profileDisplayName();
    const email = state.profile?.email || state.session?.user?.email || '';
    dom['profile-label'].textContent = name;
    dom['profile-email'].textContent = email;
    dom['profile-avatar'].textContent = name.charAt(0).toUpperCase() || 'A';
    dom['home-greeting'].textContent = `Good day, ${name.split(' ')[0]}.`;
    document.body.dataset.atlasRole = state.profile?.role || 'unknown';
    window.currentUser = state.session?.user || null;
    dispatchAuth();
  }

  async function enterApplication(session) {
    setBoot(true, 'Verifying Atlas access…');
    state.session = session;
    try {
      state.profile = await resolveProfile(session.user);
      installProfile();
      showApp();
      const requested = location.hash.replace(/^#/, '').split('/')[0];
      navigate(TITLES[requested] ? requested : 'home', { replaceHistory: true });
      await loadRuntimeData({ quiet: true });
    } catch (error) {
      console.error('Atlas access verification failed', error);
      const message = error instanceof Error ? error.message : 'Atlas access could not be verified.';
      clearSessionState();
      void boundedLocalSignOut();
      showAuth(message);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    showAuth('Use the isolated Atlas sign-in page.');
  }

  async function signOut() {
    setBoot(true, 'Signing out…');
    await boundedLocalSignOut();
    clearSessionState();
    showAuth('');
  }

  function metric(icon, value, label) {
    return `<article class="metric-card"><div class="metric-icon"><i data-lucide="${icon}"></i></div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`;
  }

  function focusRow(tone, title, copy, badge) {
    const statusClass = tone === 'success' ? 'good' : tone === 'warning' ? 'warn' : tone === 'danger' ? 'bad' : '';
    return `<div class="focus-row"><span class="focus-dot" style="background:var(--atlas-${tone})"></span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span></div>${badge ? `<span class="status-pill ${statusClass}">${escapeHtml(badge)}</span>` : ''}</div>`;
  }

  function inventoryStats() {
    const records = state.inventory.length;
    const belowPar = state.inventory.filter((item) => Number.isFinite(Number(item.par_level)) && Number(item.quantity) < Number(item.par_level)).length;
    const missingPar = state.inventory.filter((item) => item.par_level == null || item.par_level === '').length;
    const categories = new Set(state.inventory.map((item) => item.category).filter(Boolean)).size;
    const locations = new Set(state.inventory.map((item) => item.bin_location).filter(Boolean)).size;
    return { records, belowPar, missingPar, categories, locations };
  }

  function renderHome() {
    const stats = inventoryStats();
    dom['home-metrics'].innerHTML = [
      metric('package', stats.records, 'Active inventory records'),
      metric('triangle-alert', stats.belowPar, 'Recorded below par'),
      metric('tags', stats.categories, 'Inventory categories'),
      metric('map-pin', stats.locations, 'Storage locations'),
    ].join('');

    const focus = [];
    if (!stats.records) focus.push(focusRow('warning', 'Inventory evidence unavailable', 'No role-permitted inventory records were returned.', 'Review'));
    else if (stats.belowPar) focus.push(focusRow('warning', `${stats.belowPar} recorded item${stats.belowPar === 1 ? '' : 's'} below par`, 'Review the source evidence before preparing a replenishment draft.', 'Attention'));
    else focus.push(focusRow('success', 'No recorded item is currently below par', 'This uses the recorded quantities and does not claim a fresh physical count.', 'Recorded'));
    if (stats.missingPar) focus.push(focusRow('warning', `${stats.missingPar} item${stats.missingPar === 1 ? '' : 's'} missing par`, 'Complete the Item master before relying on shortage guidance.', 'L2'));
    focus.push(focusRow('accent', 'Stock changes remain controlled', 'Ordinary Inventory contains no direct quantity editor. Use Scanner, L1 or a controlled delivery.', 'Protected'));
    dom['home-focus'].innerHTML = focus.join('');

    dom['evidence-status'].innerHTML = [
      focusRow('success', 'Authenticated session', `Verified as ${state.profile?.role || 'staff'} through production Auth.`, 'Live'),
      focusRow(stats.records ? 'success' : 'warning', 'Production inventory read', `${stats.records} role-permitted records loaded.`, stats.records ? 'Loaded' : 'Unavailable'),
      focusRow('success', 'Manager-verified stock counts', 'Checkpoint L1 is connected in Inventory. Current, stale, historical and unverified states remain explicit.', 'Connected'),
      focusRow('success', 'Automatic external side effects', 'Supplier submission, social publishing and production synchronization remain disabled.', 'Off'),
    ].join('');
    renderIcons();
  }

  function filteredInventory() {
    const query = state.inventoryQuery.trim().toLowerCase();
    return state.inventory.filter((item) => {
      if (state.inventoryCategory !== 'all' && String(item.category || '') !== state.inventoryCategory) return false;
      if (!query) return true;
      return [item.name, item.category, item.sku, item.barcode, item.bin_location]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }

  function formatQuantity(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(parsed);
  }

  function evidenceLabel(item) {
    const updated = item.updated_at ? new Date(item.updated_at) : null;
    const valid = updated && !Number.isNaN(updated.getTime());
    const ageDays = valid ? (Date.now() - updated.getTime()) / 86400000 : null;
    if (ageDays != null && ageDays <= 7) return ['Recorded recently', 'good'];
    if (valid) return ['Recorded historical', 'warn'];
    return ['Unverified', ''];
  }

  function renderInventoryCategories() {
    const selected = state.inventoryCategory;
    const categories = [...new Set(state.inventory.map((item) => item.category).filter(Boolean))]
      .sort((left, right) => String(left).localeCompare(String(right)));
    dom['inventory-category'].innerHTML = `<option value="all">All categories</option>${categories.map((category) => `<option value="${escapeHtml(category)}" ${category === selected ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}`;
  }

  function renderInventory() {
    renderInventoryCategories();
    const rows = filteredInventory();
    dom['inventory-rows'].innerHTML = rows.map((item) => {
      const belowPar = Number.isFinite(Number(item.par_level)) && Number(item.quantity) < Number(item.par_level);
      const [evidence, tone] = evidenceLabel(item);
      const quantity = `${formatQuantity(item.quantity)} ${item.unit || ''}`.trim();
      const par = item.par_level == null ? '—' : `${formatQuantity(item.par_level)} ${item.unit || ''}`.trim();
      return `<tr>
        <td data-label="Item"><span class="item-name">${escapeHtml(item.name || 'Unnamed item')}</span><span class="item-meta">${escapeHtml([item.sku, item.barcode].filter(Boolean).join(' · ') || 'No product code')}</span></td>
        <td data-label="Category">${escapeHtml(item.category || 'Uncategorised')}</td>
        <td data-label="Location">${escapeHtml(item.bin_location || 'Not assigned')}</td>
        <td data-label="Quantity"><span class="quantity-stack"><span class="quantity ${belowPar ? 'low' : ''}">${escapeHtml(quantity)}</span>${belowPar ? '<span class="stock-badge warn">Below par</span>' : ''}</span></td>
        <td data-label="Par">${escapeHtml(par)}</td>
        <td data-label="Evidence"><span class="status-pill ${tone}">${escapeHtml(evidence)}</span></td>
      </tr>`;
    }).join('');
    dom['inventory-empty'].hidden = rows.length > 0;
    dom['inventory-rows'].closest('table').hidden = rows.length === 0;
  }

  function renderPlaceholder(view) {
    dom['placeholder-eyebrow'].textContent = 'Atlas workspace';
    dom['placeholder-title'].textContent = TITLES[view] || 'Workspace';
    dom['placeholder-copy'].textContent = 'This route is not part of the approved Atlas workspace registry.';
  }

  function navigate(view, options = {}) {
    if (!TITLES[view]) view = 'home';
    state.currentView = view;
    dom['page-title'].textContent = TITLES[view];
    const panelKey = view === 'home' ? 'home' : view === 'inventory' ? 'inventory' : CONNECTED_VIEWS.has(view) ? 'connected' : 'placeholder';
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== panelKey;
    });
    document.querySelectorAll('#sidebar-nav .nav-item[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (panelKey === 'placeholder') renderPlaceholder(view);
    document.body.classList.remove('nav-open');
    const hash = `#${view}`;
    if (options.replaceHistory) history.replaceState({ view }, '', hash);
    else if (location.hash !== hash) history.pushState({ view }, '', hash);
    document.dispatchEvent(new CustomEvent('atlas:navigate', { detail: { view, panel: panelKey } }));
    window.scrollTo({ top: 0, behavior: 'auto' });
    renderIcons();
  }

  function commandEntries() {
    return Array.from(document.querySelectorAll('#sidebar-nav .nav-item[data-view]')).map((button) => ({
      view: button.dataset.view,
      label: TITLES[button.dataset.view] || button.textContent.trim(),
      group: button.closest('.nav-group')?.querySelector('.nav-label')?.textContent || 'Atlas',
    }));
  }

  function filteredCommands() {
    const query = dom['command-input'].value.trim().toLowerCase();
    return commandEntries().filter((entry) => !query || `${entry.label} ${entry.group}`.toLowerCase().includes(query));
  }

  function renderCommands() {
    const entries = filteredCommands();
    state.commandIndex = Math.max(0, Math.min(state.commandIndex, entries.length - 1));
    dom['command-results'].innerHTML = entries.length
      ? entries.map((entry, index) => `<button class="command-option ${index === state.commandIndex ? 'active' : ''}" type="button" role="option" aria-selected="${index === state.commandIndex}" data-command-view="${escapeHtml(entry.view)}"><i data-lucide="arrow-right"></i><div><span>${escapeHtml(entry.label)}</span><small>${escapeHtml(entry.group)}</small></div></button>`).join('')
      : '<div class="empty-state"><i data-lucide="search-x"></i><h3>No matching workspace</h3><p>Try Inventory, Recipes, Shifts, Reports or Settings.</p></div>';
    renderIcons();
  }

  function openCommands() {
    dom['command-palette'].hidden = false;
    dom['command-input'].value = '';
    state.commandIndex = 0;
    renderCommands();
    window.requestAnimationFrame(() => dom['command-input'].focus());
  }

  function closeCommands() { dom['command-palette'].hidden = true; }

  function activateCommand() {
    const entry = filteredCommands()[state.commandIndex];
    if (!entry) return;
    closeCommands();
    navigate(entry.view);
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.atlasTheme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem('atlas.next.theme', next); } catch (_) { /* storage optional */ }
    dom['theme-toggle'].innerHTML = `<i data-lucide="${next === 'dark' ? 'sun' : 'moon'}"></i>`;
    dom['theme-toggle'].setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#111113' : '#f6f6f4');
    renderIcons();
  }

  function initialTheme() {
    try {
      const saved = localStorage.getItem('atlas.next.theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (_) { /* storage optional */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function openService() { dom['service-overlay'].hidden = false; renderIcons(); }
  function closeService() { dom['service-overlay'].hidden = true; }

  function unavailableWorkflow(label) {
    closeService();
    showToast(`${label} is not enabled in this deployment. No stock change was performed.`);
  }

  function bindEvents() {
    dom['auth-form']?.addEventListener('submit', handleLogin);
    dom['sign-out'].addEventListener('click', signOut);
    dom['mobile-menu'].addEventListener('click', () => document.body.classList.toggle('nav-open'));
    dom['sidebar-nav'].addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (button) navigate(button.dataset.view);
    });
    dom['theme-toggle'].addEventListener('click', () => applyTheme(document.documentElement.dataset.atlasTheme === 'dark' ? 'light' : 'dark'));
    dom['search-trigger'].addEventListener('click', openCommands);
    dom['service-open'].addEventListener('click', openService);
    dom['command-palette'].addEventListener('click', (event) => {
      if (event.target.closest('[data-command-close]')) closeCommands();
      const button = event.target.closest('[data-command-view]');
      if (button) { closeCommands(); navigate(button.dataset.commandView); }
    });
    dom['command-input'].addEventListener('input', () => { state.commandIndex = 0; renderCommands(); });
    dom['command-input'].addEventListener('keydown', (event) => {
      const entries = filteredCommands();
      if (event.key === 'ArrowDown') { event.preventDefault(); state.commandIndex = entries.length ? (state.commandIndex + 1) % entries.length : 0; renderCommands(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); state.commandIndex = entries.length ? (state.commandIndex - 1 + entries.length) % entries.length : 0; renderCommands(); }
      else if (event.key === 'Enter') { event.preventDefault(); activateCommand(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeCommands(); }
    });
    dom['service-overlay'].addEventListener('click', (event) => {
      if (event.target.closest('[data-service-close]')) closeService();
      const viewButton = event.target.closest('[data-service-view]');
      if (viewButton) { closeService(); navigate(viewButton.dataset.serviceView); }
      const actionButton = event.target.closest('[data-service-action]');
      if (actionButton?.dataset.serviceAction === 'count') return;
      if (actionButton?.dataset.serviceAction === 'scan') return;
      if (actionButton) unavailableWorkflow(actionButton.dataset.serviceAction || 'Workflow');
    });
    dom['inventory-search'].addEventListener('input', (event) => { state.inventoryQuery = event.target.value; renderInventory(); });
    dom['inventory-category'].addEventListener('change', (event) => { state.inventoryCategory = event.target.value; renderInventory(); });
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'refresh') loadRuntimeData();
      else if (action === 'inventory') navigate('inventory');
      else if (action === 'scan') window.AtlasInventoryScanner?.open?.();
      else if (action === 'start-count') return;
    });
    document.addEventListener('keydown', (event) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); }
      else if (event.key === '/' && !typing) { event.preventDefault(); openCommands(); }
      else if (event.key === 'Escape') { closeCommands(); closeService(); document.body.classList.remove('nav-open'); }
    }, true);
    window.addEventListener('popstate', (event) => navigate(event.state?.view || location.hash.slice(1) || 'home', { replaceHistory: true }));
  }

  async function boot() {
    if (state.bootStarted) return;
    state.bootStarted = true;
    cacheDom();
    bindEvents();
    applyTheme(initialTheme());
    renderIcons();
    setBoot(true, 'Opening Atlas…');

    const watchdog = window.setTimeout(() => {
      if (!state.bootFinished) showAuth('Atlas startup timed out. Sign in again to continue.');
    }, CONFIG.bootTimeoutMs + 2000);

    try {
      state.client = createClient();
      const sessionResponse = await withTimeout(state.client.auth.getSession(), CONFIG.bootTimeoutMs, 'Atlas session recovery timed out.');
      if (sessionResponse.error) throw sessionResponse.error;
      state.authSubscription = state.client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          clearSessionState();
          showAuth('');
        }
        if (event === 'TOKEN_REFRESHED' && session) {
          state.session = session;
          dispatchAuth();
        }
      }).data.subscription;

      const session = sessionResponse.data?.session;
      if (session) await enterApplication(session);
      else showAuth('');
    } catch (error) {
      console.error('Atlas boot failed', error);
      showAuth(error instanceof Error ? error.message : 'Atlas could not start.');
    } finally {
      window.clearTimeout(watchdog);
      state.bootFinished = true;
    }
  }

  window.addEventListener('error', (event) => {
    console.error('Atlas runtime error', event.error || event.message);
    if (!state.bootFinished) showAuth('Atlas encountered a startup error. Sign in again to continue.');
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Atlas rejected promise', event.reason);
    if (!state.bootFinished) showAuth('Atlas encountered a startup error. Sign in again to continue.');
  });

  window.AtlasNext = Object.freeze({
    version: VERSION,
    navigate,
    refresh: loadRuntimeData,
    renderHome,
    renderInventory,
    toast: showToast,
    state: () => ({
      currentView: state.currentView,
      role: state.profile?.role || null,
      inventoryRecords: state.inventory.length,
      recipeRecords: state.recipes.length,
      supplierRecords: state.suppliers.length,
      movementRecords: state.movements.length,
    }),
  });

  // atlas-next.js is itself loaded with `defer`, so the document has already
  // been parsed when this line runs. Boot immediately rather than waiting for
  // DOMContentLoaded, which is delayed by the many optional deferred workspace
  // bundles that follow this core runtime in /next.html.
  void boot();
})();
