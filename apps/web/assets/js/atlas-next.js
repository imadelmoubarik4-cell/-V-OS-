(() => {
  'use strict';

  const VERSION = 'atlas-next/0.1.0';
  const CONFIG = Object.freeze({
    supabaseUrl: 'https://dnefgcmjcgxlynycxkts.supabase.co',
    supabaseKey: 'sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp',
    requestTimeoutMs: 12000,
    bootTimeoutMs: 15000,
  });

  const TITLES = Object.freeze({
    home: 'Home',
    inventory: 'Inventory',
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

  const PLACEHOLDERS = Object.freeze({
    recipes: ['Operations · Recipes', 'Recipes', 'The existing recipe library, costing and availability workflow will be connected directly to this screen.'],
    purchasing: ['Operations · Purchasing', 'Purchasing', 'Supplier records, review-only drafts and controlled deliveries will be connected without enabling supplier submission.'],
    imports: ['Operations · Import Center', 'Import Center', 'The private source queue and approval workflow will be connected without loading the legacy page.'],
    review: ['Data review', 'Real VÁ Data', 'The manager-only 1,104-record review workspace will be connected through its existing authenticated gateway.'],
    marketing: ['Growth', 'Marketing', 'Planning and approval workflows will be connected with automatic publishing remaining disabled.'],
    messages: ['People', 'Messages', 'Private team communication will be connected through the existing Team Messages gateway.'],
    team: ['People', 'Team', 'Profiles, roles and staff status will use the canonical public.profiles authorization model.'],
    shifts: ['People', 'Shifts', 'The weekly and monthly planning workspace will be connected to the existing private shifts gateway.'],
    knowledge: ['People', 'Knowledge', 'Published guidance, acknowledgements, training and Source Center will be connected directly.'],
    brain: ['Insights', 'Atlas Brain', 'Evidence-backed Checkpoint K recommendations will be connected without automatic execution.'],
    business: ['Insights', 'Business Intelligence', 'Only supported live evidence will be rendered; missing sales sources will remain explicit.'],
    reports: ['Insights', 'Reports', 'The authenticated reporting workspace and Checkpoint M will be connected directly.'],
    settings: ['System', 'Settings', 'The versioned Settings workspace and canonical Connection Center will be connected directly.'],
    system: ['System', 'System', 'Health, incidents, recovery and canonical connection evidence will be connected directly.'],
  });

  const state = {
    client: null,
    session: null,
    profile: null,
    inventory: [],
    currentView: 'home',
    commandIndex: 0,
    loadingData: false,
    inventoryQuery: '',
    inventoryCategory: 'all',
    bootFinished: false,
    authSubscription: null,
  };

  const dom = {};

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
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

  function cacheDom() {
    for (const id of [
      'atlas-boot', 'auth-screen', 'auth-form', 'auth-email', 'auth-password', 'auth-submit', 'auth-error',
      'app-shell', 'sidebar', 'sidebar-nav', 'mobile-menu', 'page-title', 'search-trigger', 'theme-toggle',
      'service-open', 'service-overlay', 'command-palette', 'command-input', 'command-results', 'sign-out',
      'profile-avatar', 'profile-label', 'profile-email', 'home-greeting', 'home-metrics', 'home-focus',
      'evidence-status', 'inventory-search', 'inventory-category', 'inventory-rows', 'inventory-empty',
      'placeholder-eyebrow', 'placeholder-title', 'placeholder-copy', 'toast', 'review-count',
    ]) dom[id] = document.getElementById(id);
  }

  function setBoot(visible, label) {
    if (!dom['atlas-boot']) return;
    dom['atlas-boot'].hidden = !visible;
    const copy = dom['atlas-boot'].querySelector('span');
    if (copy && label) copy.textContent = label;
  }

  function showAuth(message = '') {
    dom['app-shell'].hidden = true;
    dom['auth-screen'].hidden = false;
    setBoot(false);
    setAuthError(message);
    window.requestAnimationFrame(() => dom['auth-email']?.focus());
  }

  function showApp() {
    dom['auth-screen'].hidden = true;
    dom['app-shell'].hidden = false;
    setBoot(false);
    renderIcons();
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

  function showToast(message, duration = 4200) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { dom.toast.hidden = true; }, duration);
  }

  function ensureLibraries() {
    if (!window.supabase?.createClient) throw new Error('The Supabase client did not load. Check the network connection and refresh.');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(CONFIG.supabaseUrl)) throw new Error('Atlas has an invalid Supabase URL.');
  }

  function createClient() {
    ensureLibraries();
    return window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      global: {
        headers: { 'x-client-info': VERSION },
      },
    });
  }

  async function resolveProfile(user) {
    const response = await withTimeout(
      state.client.from('profiles').select('id,email,role,active').eq('id', user.id).maybeSingle(),
      CONFIG.requestTimeoutMs,
      'Profile verification took too long.',
    );
    if (response.error) throw response.error;
    const profile = response.data;
    if (!profile?.active) throw new Error('This account does not have active Atlas access. Ask an administrator to activate the profile.');
    return profile;
  }

  async function inventoryRequest(fields) {
    return withTimeout(
      state.client.from('inventory_items').select(fields).order('name', { ascending: true }),
      CONFIG.requestTimeoutMs,
      'Inventory took too long to respond.',
    );
  }

  async function loadInventory() {
    const preferred = 'id,name,category,quantity,unit,par_level,sku,barcode,bin_location,updated_at,active';
    const fallback = 'id,name,category,quantity,unit,par_level,sku,bin_location,updated_at';
    let response = await inventoryRequest(preferred);
    if (response.error && /column|schema cache/i.test(response.error.message || '')) response = await inventoryRequest(fallback);
    if (response.error) throw response.error;
    state.inventory = Array.isArray(response.data) ? response.data.filter((item) => item.active !== false) : [];
  }

  async function loadRuntimeData({ quiet = false } = {}) {
    if (state.loadingData) return;
    state.loadingData = true;
    if (!quiet) showToast('Refreshing live Atlas data…', 1600);
    try {
      await loadInventory();
      renderHome();
      renderInventory();
      if (!quiet) showToast('Atlas data refreshed.');
    } catch (error) {
      console.error('Atlas data load failed', error);
      state.inventory = [];
      renderHome();
      renderInventory();
      showToast(error instanceof Error ? error.message : 'Atlas data could not load.');
    } finally {
      state.loadingData = false;
    }
  }

  function profileDisplayName() {
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
  }

  async function enterApplication(session) {
    setBoot(true, 'Verifying Atlas access…');
    state.session = session;
    try {
      state.profile = await resolveProfile(session.user);
      installProfile();
      showApp();
      navigate('home', { replaceHistory: true });
      await loadRuntimeData({ quiet: true });
    } catch (error) {
      console.error('Atlas access verification failed', error);
      await state.client.auth.signOut().catch(() => undefined);
      state.session = null;
      state.profile = null;
      showAuth(error instanceof Error ? error.message : 'Atlas access could not be verified.');
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email = dom['auth-email'].value.trim();
    const password = dom['auth-password'].value;
    if (!email || !password) {
      setAuthError('Enter your email and password.');
      return;
    }
    setAuthError('');
    setAuthBusy(true);
    try {
      const response = await withTimeout(
        state.client.auth.signInWithPassword({ email, password }),
        CONFIG.requestTimeoutMs,
        'Sign-in took too long. Check the connection and try again.',
      );
      if (response.error) throw response.error;
      if (!response.data?.session) throw new Error('Atlas did not receive a valid session.');
      await enterApplication(response.data.session);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    setBoot(true, 'Signing out…');
    await state.client.auth.signOut().catch((error) => console.warn('Sign-out warning', error));
    state.session = null;
    state.profile = null;
    state.inventory = [];
    showAuth('');
  }

  function metric(icon, value, label) {
    return `<article class="metric-card"><div class="metric-icon"><i data-lucide="${icon}"></i></div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`;
  }

  function focusRow(tone, title, copy, badge) {
    return `<div class="focus-row"><span class="focus-dot" style="background:var(--atlas-${tone})"></span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span></div>${badge ? `<span class="status-pill ${tone === 'success' ? 'good' : tone === 'warning' ? 'warn' : tone === 'danger' ? 'bad' : ''}">${escapeHtml(badge)}</span>` : ''}</div>`;
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
    else if (stats.belowPar) focus.push(focusRow('warning', `${stats.belowPar} recorded item${stats.belowPar === 1 ? '' : 's'} below par`, 'Review the source evidence before creating any replenishment draft.', 'Attention'));
    else focus.push(focusRow('success', 'No recorded item is currently below par', 'This statement uses the available recorded quantities; it does not claim a fresh verified count.', 'Recorded'));
    if (stats.missingPar) focus.push(focusRow('warning', `${stats.missingPar} item${stats.missingPar === 1 ? '' : 's'} missing par`, 'Item-master completion is required before shortage guidance is complete.', 'L2'));
    focus.push(focusRow('accent', 'Stock changes remain controlled', 'The replacement interface contains no direct quantity editor.', 'Protected'));
    dom['home-focus'].innerHTML = focus.join('');

    dom['evidence-status'].innerHTML = [
      focusRow('success', 'Authenticated session', `Verified as ${state.profile?.role || 'staff'} through production Auth.`, 'Live'),
      focusRow(stats.records ? 'success' : 'warning', 'Production inventory read', `${stats.records} role-permitted records loaded.`, stats.records ? 'Loaded' : 'Unavailable'),
      focusRow('warning', 'Manager-verified current count', 'L1 evidence is not yet mounted in this replacement route.', 'Pending UI'),
      focusRow('success', 'Automatic side effects', 'Ordering, publishing and production synchronization remain disabled.', 'Off'),
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
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(number);
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
    const categories = [...new Set(state.inventory.map((item) => item.category).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    dom['inventory-category'].innerHTML = `<option value="all">All categories</option>${categories.map((category) => `<option value="${escapeHtml(category)}" ${category === selected ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}`;
  }

  function renderInventory() {
    renderInventoryCategories();
    const rows = filteredInventory();
    dom['inventory-rows'].innerHTML = rows.map((item) => {
      const belowPar = Number.isFinite(Number(item.par_level)) && Number(item.quantity) < Number(item.par_level);
      const [evidence, tone] = evidenceLabel(item);
      return `<tr>
        <td><span class="item-name">${escapeHtml(item.name || 'Unnamed item')}</span><span class="item-meta">${escapeHtml([item.sku, item.barcode].filter(Boolean).join(' · ') || 'No product code')}</span></td>
        <td>${escapeHtml(item.category || 'Uncategorised')}</td>
        <td>${escapeHtml(item.bin_location || 'Not assigned')}</td>
        <td><span class="quantity ${belowPar ? 'low' : ''}">${escapeHtml(formatQuantity(item.quantity))} ${escapeHtml(item.unit || '')}</span></td>
        <td>${item.par_level == null ? '—' : escapeHtml(`${formatQuantity(item.par_level)} ${item.unit || ''}`)}</td>
        <td><span class="status-pill ${tone}">${escapeHtml(evidence)}</span></td>
      </tr>`;
    }).join('');
    dom['inventory-empty'].hidden = rows.length > 0;
    dom['inventory-rows'].closest('table').hidden = rows.length === 0;
  }

  function renderPlaceholder(view) {
    const [eyebrow, title, copy] = PLACEHOLDERS[view] || ['Atlas workspace', TITLES[view] || 'Workspace', 'This workspace will be connected to the existing Atlas engine.'];
    dom['placeholder-eyebrow'].textContent = eyebrow;
    dom['placeholder-title'].textContent = title;
    dom['placeholder-copy'].textContent = copy;
  }

  function navigate(view, options = {}) {
    if (!TITLES[view]) view = 'home';
    state.currentView = view;
    dom['page-title'].textContent = TITLES[view];
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      const visible = panel.dataset.viewPanel === view || (panel.dataset.viewPanel === 'placeholder' && !['home', 'inventory'].includes(view));
      panel.hidden = !visible;
    });
    document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (!['home', 'inventory'].includes(view)) renderPlaceholder(view);
    document.body.classList.remove('nav-open');
    if (!options.replaceHistory) history.pushState({ view }, '', `#${view}`);
    else history.replaceState({ view }, '', `#${view}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
    renderIcons();
  }

  function commandEntries() {
    return Array.from(document.querySelectorAll('.nav-item[data-view]')).map((button) => ({
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
    dom['command-results'].innerHTML = entries.length ? entries.map((entry, index) => `<button class="command-option ${index === state.commandIndex ? 'active' : ''}" type="button" role="option" aria-selected="${index === state.commandIndex}" data-command-view="${escapeHtml(entry.view)}"><i data-lucide="arrow-right"></i><div><span>${escapeHtml(entry.label)}</span><small>${escapeHtml(entry.group)}</small></div></button>`).join('') : '<div class="empty-state"><i data-lucide="search-x"></i><h3>No matching workspace</h3><p>Try inventory, recipes, shifts, reports or settings.</p></div>';
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
    showToast(`${label} is being connected to the existing secure gateway. No stock change was performed.`);
  }

  function bindEvents() {
    dom['auth-form'].addEventListener('submit', handleLogin);
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
      if (actionButton) unavailableWorkflow(actionButton.dataset.serviceAction === 'scan' ? 'Barcode scanner' : 'L1 stock count');
    });
    dom['inventory-search'].addEventListener('input', (event) => { state.inventoryQuery = event.target.value; renderInventory(); });
    dom['inventory-category'].addEventListener('change', (event) => { state.inventoryCategory = event.target.value; renderInventory(); });
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'refresh') loadRuntimeData();
      else if (action === 'inventory') navigate('inventory');
      else if (action === 'scan') unavailableWorkflow('Barcode scanner');
      else if (action === 'start-count') unavailableWorkflow('L1 stock count');
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
    cacheDom();
    bindEvents();
    applyTheme(initialTheme());
    renderIcons();
    setBoot(true, 'Opening Atlas…');

    try {
      state.client = createClient();
      const sessionResponse = await withTimeout(state.client.auth.getSession(), CONFIG.bootTimeoutMs, 'Atlas session recovery timed out.');
      if (sessionResponse.error) throw sessionResponse.error;
      state.authSubscription = state.client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && !dom['auth-screen'].hidden) return;
        if (event === 'SIGNED_OUT') showAuth('');
        if (event === 'TOKEN_REFRESHED' && session) state.session = session;
      }).data.subscription;

      const session = sessionResponse.data?.session;
      if (session) await enterApplication(session);
      else showAuth('');
    } catch (error) {
      console.error('Atlas boot failed', error);
      showAuth(error instanceof Error ? error.message : 'Atlas could not start.');
    } finally {
      state.bootFinished = true;
    }
  }

  window.addEventListener('error', (event) => {
    console.error('Atlas runtime error', event.error || event.message);
    if (!state.bootFinished) showAuth('Atlas encountered a startup error. Refresh the page and try again.');
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Atlas rejected promise', event.reason);
    if (!state.bootFinished) showAuth('Atlas encountered a startup error. Refresh the page and try again.');
  });

  window.AtlasNext = Object.freeze({
    version: VERSION,
    navigate,
    refresh: loadRuntimeData,
    state: () => ({ currentView: state.currentView, role: state.profile?.role || null, inventoryRecords: state.inventory.length }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
