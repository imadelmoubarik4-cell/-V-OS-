// Atlas shell chrome (spec §4): sidebar and rail, top bar, phone tab bar and
// More sheet, account menu, notifications panel, offline bar and the page
// title. It renders on AtlasShell (navigation model, routes, notify feed,
// toast) and owns no data: destinations and roles come from AtlasShell.nav,
// notifications from AtlasShell.notify, actions from AtlasShell.actions.
//
// Public: window.AtlasChrome = { setAccount, icon, openMore, closeMore,
// openAccountMenu, closeAccountMenu, setTabBarHidden, setTopBar, refresh }.
(function () {
  'use strict';

  const shell = window.AtlasShell;
  if (!shell || window.AtlasChrome) return;

  const PHONE = window.matchMedia('(max-width: 767px)');
  const RAIL = window.matchMedia('(min-width: 768px) and (max-width: 1279px)');
  const COLLAPSE_KEY = 'atlas.sidebarCollapsed';
  const TAB_IDS = ['home', 'inventory', 'ai', 'recipes'];
  const ROLE_LABELS = { admin: 'Administrator', manager: 'Manager', bartender: 'Bartender', viewer: 'Viewer' };
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  const state = {
    account: { id: null, name: '', email: '', role: null },
    activeId: 'home',
    messagesUnread: 0,
    notifyFilter: 'all',
    notifyOpen: false,
    notifyTrigger: null,
    venueKey: undefined,
    topbar: { title: null, back: null, actions: [], own: false },
    moreTrigger: null,
    menuTrigger: null,
    pollTimer: null,
    initialHash: String(window.location.hash || '')
  };

  const $ = (id) => document.getElementById(id);
  const escape = (value) => shell.escape(value);

  // ---------- icons ----------
  // Inline Lucide SVG from the pinned library (no document-wide createIcons
  // pass for every panel render).
  function icon(name, { size = 16, stroke = 1.75, className = '' } = {}) {
    const pascal = String(name || '').split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    const node = window.lucide?.icons?.[pascal];
    if (!Array.isArray(node)) return `<i data-lucide="${escape(name)}" aria-hidden="true"></i>`;
    const children = (node[2] || []).map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}/>`).join('');
    return `<svg class="atlas-svg-icon lucide lucide-${escape(name)}${className ? ` ${className}` : ''}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${children}</svg>`;
  }

  function refreshStaticIcons() {
    if (document.querySelector('#app-screen i[data-lucide], #login-screen i[data-lucide]')) window.lucide?.createIcons?.();
  }

  // ---------- helpers ----------

  function role() {
    return shell.profile()?.role || state.account.role || null;
  }

  // The signed-in person, from setAccount() or the page (sign-in fills both).
  function account() {
    return {
      id: state.account.id || shell.profile()?.id || null,
      name: state.account.name || $('profile-name')?.textContent?.trim() || '',
      email: state.account.email || $('user-email')?.textContent?.trim() || ''
    };
  }

  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || 'A';
  }

  // One of four muted tints, stable per profile (spec §6.20).
  function avatarTint() {
    const key = String(account().id || account().name || '');
    let hash = 0;
    for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return `atlas-avatar--${'abcd'[hash % 4]}`;
  }

  function avatarMarkup(size = 28) {
    const source = $('user-avatar');
    const inner = source ? source.innerHTML : escape(initials(account().name));
    const photo = source?.classList.contains('has-profile-photo') ? ' has-profile-photo' : '';
    return `<span class="atlas-avatar ${avatarTint()}${size >= 40 ? ' atlas-avatar--lg' : ''}${photo}" aria-hidden="true">${inner}</span>`;
  }

  function focusables(root) {
    return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden && element.getClientRects().length > 0);
  }

  // Tab stays inside an open overlay (spec §6.18).
  function trapTab(event, root) {
    if (event.key !== 'Tab') return;
    const items = focusables(root);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function navigate(route, trigger, event) {
    shell.navigate(route, { source: 'nav', trigger: trigger || null, event: event || null });
  }

  function plainClick(event) {
    return !(event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  // ---------- roles: sidebar, rail and tab bar visibility (spec §3.3) ----------

  function applyRole() {
    const current = role();
    document.body.dataset.atlasRole = current || '';
    document.querySelectorAll('.atlas-sidebar .nav-item[data-nav-id]').forEach((link) => {
      link.hidden = !shell.nav.allowed(link.dataset.navId, current);
    });
    document.querySelectorAll('.atlas-sidebar .nav-group[data-nav-group]').forEach((group) => {
      group.hidden = !group.querySelector('.nav-item[data-nav-id]:not([hidden])');
    });
    const roleLabel = $('profile-role');
    if (roleLabel) roleLabel.textContent = ROLE_LABELS[current] || '';
    const accountButton = $('atlas-account-btn');
    if (accountButton) accountButton.setAttribute('aria-label', `Account: ${account().name || 'you'}${ROLE_LABELS[current] ? `, ${ROLE_LABELS[current]}` : ''}`);
    syncActive();
  }

  // ---------- active destination, page title ----------

  function activeItem() {
    const view = shell.current();
    const hash = window.location.hash;
    const byRoute = shell.nav.forRoute(hash);
    if (byRoute && view && shell.parseRoute(hash).view === view) return byRoute;
    return shell.nav.forView(view) || byRoute || shell.nav.get('home');
  }

  function syncActive() {
    const item = activeItem();
    state.activeId = item?.id || 'home';
    document.querySelectorAll('.atlas-sidebar .nav-item[data-nav-id]').forEach((link) => {
      const active = link.dataset.navId === state.activeId;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const tabId = TAB_IDS.includes(state.activeId) ? state.activeId : 'more';
    document.querySelectorAll('.atlas-tabbar__item[data-nav-id]').forEach((link) => {
      if (link.dataset.navId === tabId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const view = shell.view(shell.current());
    const label = item?.label || view?.title || 'Atlas';
    const title = $('atlas-page-title');
    const text = state.topbar.title || label;
    if (title && !document.body.classList.contains('stock-count-active')) title.textContent = text;
    document.title = text === 'Home' ? 'Atlas' : `${text} · Atlas`;
  }

  // ---------- page-owned phone top bar (spec §4.4) ----------
  // A page sets it from its onShow hook; every navigation resets it.
  //   setTopBar({ title, back: '#route' | fn, actions: [{ icon, label, run }], own: true })
  // `own` hides the global search and bell (Atlas AI conversations).
  function renderTopBar() {
    const back = $('atlas-topbar-back');
    if (back) back.hidden = !state.topbar.back;
    const slot = $('atlas-topbar-actions');
    if (slot) {
      slot.innerHTML = state.topbar.actions.map((action, index) => `<button type="button" class="atlas-icon-btn" data-topbar-action="${index}" aria-label="${escape(action.label)}">${icon(action.icon || 'ellipsis', { size: 20 })}</button>`).join('');
    }
    document.body.classList.toggle('atlas-topbar-own', Boolean(state.topbar.own));
    syncActive();
  }

  function setTopBar(options = {}) {
    state.topbar = {
      title: options.title ? String(options.title) : null,
      back: options.back || null,
      actions: Array.isArray(options.actions) ? options.actions.filter((action) => action && typeof action.run === 'function').slice(0, 2) : [],
      own: Boolean(options.own)
    };
    renderTopBar();
  }

  // ---------- sidebar collapse, rail overlay (spec §4.1, §4.2) ----------

  function readCollapsed() {
    try { return window.localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { return false; }
  }

  function writeCollapsed(value) {
    try { window.localStorage.setItem(COLLAPSE_KEY, String(value)); } catch { /* per-viewer convenience only */ }
  }

  function syncToggle() {
    const toggle = $('atlas-sidebar-toggle');
    if (!toggle) return;
    const overlay = RAIL.matches;
    const open = overlay ? document.body.classList.contains('atlas-sidebar-open') : !document.body.classList.contains('atlas-sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', overlay ? (open ? 'Close navigation' : 'Open navigation') : (open ? 'Collapse sidebar' : 'Expand sidebar'));
  }

  // body.atlas-rail: 64 px icon rail at 768–1279, or at ≥1280 when collapsed.
  function applyLayout() {
    const collapsed = !RAIL.matches && !PHONE.matches && readCollapsed();
    document.body.classList.toggle('atlas-sidebar-collapsed', collapsed);
    document.body.classList.toggle('atlas-rail', RAIL.matches || collapsed);
    if (!RAIL.matches) closeOverlaySidebar({ restoreFocus: false });
    syncToggle();
  }

  function openOverlaySidebar() {
    document.body.classList.add('atlas-sidebar-open');
    const scrim = $('atlas-sidebar-scrim');
    if (scrim) scrim.hidden = false;
    syncToggle();
    $('atlas-sidebar')?.querySelector('.nav-item[aria-current="page"], .nav-item:not([hidden])')?.focus();
  }

  function closeOverlaySidebar({ restoreFocus = true } = {}) {
    if (!document.body.classList.contains('atlas-sidebar-open')) return;
    document.body.classList.remove('atlas-sidebar-open');
    const scrim = $('atlas-sidebar-scrim');
    if (scrim) scrim.hidden = true;
    syncToggle();
    if (restoreFocus) $('atlas-sidebar-toggle')?.focus();
  }

  function toggleSidebar() {
    if (RAIL.matches) {
      if (document.body.classList.contains('atlas-sidebar-open')) closeOverlaySidebar();
      else openOverlaySidebar();
      return;
    }
    const collapsed = !document.body.classList.contains('atlas-sidebar-collapsed');
    writeCollapsed(collapsed);
    hideTooltip();
    applyLayout();
  }

  // Rail items show their label in a tooltip on hover/focus after 400 ms
  // (spec §4.2); the rail scrolls, so the tooltip is fixed-positioned.
  let tooltipTimer = null;
  function railTarget(element) {
    if (!document.body.classList.contains('atlas-rail') || document.body.classList.contains('atlas-sidebar-open')) return null;
    return element instanceof Element ? element.closest('.atlas-sidebar .nav-item[aria-label], .atlas-sidebar .atlas-account, .atlas-sidebar .atlas-brand__link') : null;
  }
  function showTooltip(target) {
    window.clearTimeout(tooltipTimer);
    tooltipTimer = window.setTimeout(() => {
      let tip = $('atlas-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'atlas-tooltip';
        tip.className = 'atlas-tooltip';
        tip.setAttribute('role', 'tooltip');
        document.body.appendChild(tip);
      }
      const label = target.matches('.atlas-account') ? (account().name || 'Account') : target.matches('.atlas-brand__link') ? 'Home' : target.getAttribute('aria-label');
      tip.textContent = label;
      const rect = target.getBoundingClientRect();
      tip.hidden = false;
      // Kept inside the viewport (8 px margin) at every width.
      const left = Math.min(Math.round(rect.right + 8), window.innerWidth - tip.offsetWidth - 8);
      const top = Math.round(rect.top + rect.height / 2 - tip.offsetHeight / 2);
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - tip.offsetHeight - 8))}px`;
      target.setAttribute('aria-describedby', 'atlas-tooltip');
    }, 400);
  }
  function hideTooltip() {
    window.clearTimeout(tooltipTimer);
    const tip = $('atlas-tooltip');
    if (tip) tip.hidden = true;
    document.querySelectorAll('[aria-describedby="atlas-tooltip"]').forEach((element) => element.removeAttribute('aria-describedby'));
  }

  // ---------- phone tab bar and More sheet (spec §4.4) ----------

  function moreRows() {
    const items = shell.nav.items({ role: role() }).filter((item) => !TAB_IDS.includes(item.id) && item.id !== 'settings');
    let group;
    return items.map((item) => {
      const divider = item.group !== group && group !== undefined ? '<li class="atlas-more__divider" role="presentation"></li>' : '';
      group = item.group;
      const badge = item.id === 'messages' && state.messagesUnread > 0 ? `<span class="atlas-badge">${state.messagesUnread > 99 ? '99+' : state.messagesUnread}</span>` : '';
      const current = item.id === state.activeId ? ' aria-current="page"' : '';
      return `${divider}<li><a class="atlas-more__row" href="${escape(item.route)}" data-nav-id="${escape(item.id)}"${current}>${icon(item.icon, { size: 20 })}<span class="atlas-more__label">${escape(item.label)}</span>${badge}${icon('chevron-right', { className: 'atlas-more__chevron' })}</a></li>`;
    }).join('');
  }

  function ensureMore() {
    let layer = $('atlas-more');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'atlas-more';
    layer.className = 'atlas-layer atlas-layer--sheet';
    layer.hidden = true;
    layer.innerHTML = `<div class="atlas-scrim" data-atlas-close></div>
      <section class="atlas-sheet-panel atlas-more" role="dialog" aria-modal="true" aria-label="More">
        <div class="atlas-sheet-panel__grabber" aria-hidden="true"></div>
        <div class="atlas-more__body"></div>
      </section>`;
    document.body.appendChild(layer);
    layer.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-atlas-close]')) { closeMore(); return; }
      const row = target.closest('a.atlas-more__row[href^="#"]');
      if (row && plainClick(event)) {
        event.preventDefault();
        closeMore({ restoreFocus: false });
        navigate(row.getAttribute('href'), row, event);
        return;
      }
      if (target.closest('[data-atlas-account]')) { closeMore({ restoreFocus: false }); openAccountMenu($('atlas-more-btn')); return; }
      if (target.closest('[data-atlas-sign-out]')) { event.preventDefault(); signOut(); }
    });
    layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMore(); return; }
      trapTab(event, layer.querySelector('.atlas-more'));
    });
    return layer;
  }

  function renderMore() {
    const layer = ensureMore();
    const settings = shell.nav.allowed('settings', role())
      ? `<li><a class="atlas-more__row" href="#settings" data-nav-id="settings"${state.activeId === 'settings' ? ' aria-current="page"' : ''}>${icon('settings', { size: 20 })}<span class="atlas-more__label">Settings</span>${icon('chevron-right', { className: 'atlas-more__chevron' })}</a></li>`
      : `<li><a class="atlas-more__row" href="#settings/preferences" data-nav-id="settings">${icon('sliders-horizontal', { size: 20 })}<span class="atlas-more__label">Preferences</span>${icon('chevron-right', { className: 'atlas-more__chevron' })}</a></li>`;
    layer.querySelector('.atlas-more__body').innerHTML = `
      <button type="button" class="atlas-more__account" data-atlas-account aria-haspopup="menu">${avatarMarkup(40)}<span class="atlas-more__account-text"><span class="atlas-more__account-name">${escape(account().name)}</span><span class="atlas-more__account-role">${escape(ROLE_LABELS[role()] || '')}</span></span>${icon('chevron-right', { className: 'atlas-more__chevron' })}</button>
      <ul class="atlas-more__list" role="list">${moreRows()}<li class="atlas-more__divider" role="presentation"></li>${settings}
        <li><button type="button" class="atlas-more__row atlas-more__row--plain" data-atlas-sign-out>${icon('log-out', { size: 20 })}<span class="atlas-more__label">Sign out</span></button></li></ul>`;
  }

  function openMore() {
    closeAccountMenu({ restoreFocus: false });
    const layer = ensureMore();
    renderMore();
    state.moreTrigger = $('atlas-more-btn');
    layer.hidden = false;
    document.body.classList.add('atlas-overlay-open');
    $('atlas-more-btn')?.setAttribute('aria-expanded', 'true');
    window.requestAnimationFrame(() => layer.classList.add('is-open'));
    (layer.querySelector('.atlas-more__row[aria-current="page"]') || layer.querySelector('.atlas-more__account'))?.focus();
  }

  function closeMore({ restoreFocus = true } = {}) {
    const layer = $('atlas-more');
    if (!layer || layer.hidden) return;
    layer.classList.remove('is-open');
    layer.hidden = true;
    document.body.classList.remove('atlas-overlay-open');
    $('atlas-more-btn')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) state.moreTrigger?.focus?.();
  }

  // ---------- account menu (spec §4.10) ----------

  function ensureMenu() {
    let layer = $('atlas-account-layer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'atlas-account-layer';
    layer.className = 'atlas-layer atlas-layer--menu';
    layer.hidden = true;
    layer.innerHTML = '<div class="atlas-scrim atlas-scrim--clear" data-atlas-close></div><div class="atlas-menu atlas-account-menu" id="atlas-account-menu" role="menu" aria-label="Account"></div>';
    document.body.appendChild(layer);
    layer.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-atlas-close]')) { closeAccountMenu(); return; }
      const item = target.closest('[role="menuitem"]');
      if (!item) return;
      event.preventDefault();
      runMenuItem(item.dataset.menuAction, item);
    });
    layer.addEventListener('keydown', menuKeydown);
    return layer;
  }

  function runMenuItem(action, item) {
    closeAccountMenu({ restoreFocus: action === 'shortcuts' });
    if (action === 'profile') navigate(account().id ? `#team/${encodeURIComponent(account().id)}` : '#team', item);
    else if (action === 'preferences') navigate('#settings/preferences', item);
    else if (action === 'notification-settings') navigate('#settings/notifications', item);
    else if (action === 'shortcuts') openShortcuts();
    else if (action === 'sign-out') signOut();
  }

  function renderMenu() {
    const menu = ensureMenu().querySelector('.atlas-menu');
    const item = (action, label, iconName, extra = '') => `<button type="button" class="atlas-menu__item${extra}" role="menuitem" tabindex="-1" data-menu-action="${action}">${icon(iconName)}<span>${escape(label)}</span></button>`;
    menu.innerHTML = `
      <div class="atlas-account-menu__head">${avatarMarkup(40)}<div class="atlas-account-menu__who"><div class="atlas-account-menu__name">${escape(account().name)}</div>${ROLE_LABELS[role()] ? `<span class="atlas-pill atlas-account-menu__role">${escape(ROLE_LABELS[role()])}</span>` : ''}</div></div>
      <div class="atlas-menu__sep" role="separator"></div>
      ${item('profile', 'Your profile', 'circle-user-round')}
      ${item('preferences', 'Preferences', 'sliders-horizontal')}
      ${item('notification-settings', 'Notification settings', 'bell')}
      <div class="atlas-menu__sep" role="separator"></div>
      ${PHONE.matches ? '' : item('shortcuts', 'Keyboard shortcuts', 'keyboard')}
      ${item('sign-out', 'Sign out', 'log-out', ' atlas-menu__item--danger')}`;
  }

  function positionMenu(trigger) {
    const menu = $('atlas-account-menu');
    if (!menu) return;
    menu.style.removeProperty('left');
    menu.style.removeProperty('bottom');
    menu.style.removeProperty('top');
    if (PHONE.matches || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    menu.style.left = `${left}px`;
    menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
  }

  function openAccountMenu(trigger = $('atlas-account-btn')) {
    const layer = ensureMenu();
    renderMenu();
    state.menuTrigger = trigger;
    layer.hidden = false;
    layer.classList.toggle('is-sheet', PHONE.matches);
    positionMenu(trigger);
    trigger?.setAttribute('aria-expanded', 'true');
    menuItems()[0]?.focus();
  }

  function closeAccountMenu({ restoreFocus = true } = {}) {
    const layer = $('atlas-account-layer');
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    state.menuTrigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) state.menuTrigger?.focus?.();
  }

  function menuItems() {
    return [...($('atlas-account-menu')?.querySelectorAll('[role="menuitem"]') || [])];
  }

  // Arrows, Home/End, type-ahead and Esc (spec §6.19).
  function menuKeydown(event) {
    const items = menuItems();
    const index = items.indexOf(document.activeElement);
    const move = (next) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); closeAccountMenu(); }
    else if (event.key === 'Tab') { closeAccountMenu({ restoreFocus: false }); }
    else if (/^[a-z]$/i.test(event.key)) {
      const start = index + 1;
      const match = [...items.slice(start), ...items.slice(0, start)].find((item) => item.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) { event.preventDefault(); match.focus(); }
    }
  }

  function signOut() {
    if (typeof window.atlasSignOut === 'function') window.atlasSignOut();
  }

  // ---------- keyboard shortcuts dialog ----------

  function openShortcuts() {
    let layer = $('atlas-shortcuts');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'atlas-shortcuts';
      layer.className = 'atlas-layer atlas-layer--dialog';
      layer.hidden = true;
      const mod = IS_MAC ? '⌘' : 'Ctrl';
      const row = (keys, label) => `<div class="atlas-shortcuts__row"><span>${escape(label)}</span><span class="atlas-shortcuts__keys">${keys.map((key) => `<kbd class="kbd">${escape(key)}</kbd>`).join('')}</span></div>`;
      layer.innerHTML = `<div class="atlas-scrim" data-atlas-close></div>
        <section class="atlas-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="atlas-shortcuts-title">
          <header class="atlas-dialog-panel__head"><h2 id="atlas-shortcuts-title">Keyboard shortcuts</h2><button type="button" class="atlas-icon-btn" data-atlas-close aria-label="Close">${icon('x', { size: 18 })}</button></header>
          <div class="atlas-shortcuts">
            ${row([mod, 'K'], 'Search or ask Atlas')}${row(['/'], 'Search (when not typing)')}${row(['↑', '↓'], 'Move in lists and menus')}
            ${row(['↵'], 'Open the selected result')}${row([mod, '↵'], 'Ask Atlas with what you typed')}${row(['Esc'], 'Close a panel or dialog')}
          </div>
        </section>`;
      document.body.appendChild(layer);
      layer.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('[data-atlas-close]')) closeShortcuts(); });
      layer.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeShortcuts(); return; }
        trapTab(event, layer.querySelector('.atlas-dialog-panel'));
      });
    }
    layer.hidden = false;
    layer.querySelector('button[data-atlas-close]')?.focus();
  }

  function closeShortcuts() {
    const layer = $('atlas-shortcuts');
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    state.menuTrigger?.focus?.();
  }

  // ---------- notifications panel (spec §4.9, §7.16) ----------

  function relativeTime(value) {
    const time = typeof value === 'number' ? value : Date.parse(value || '');
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(time));
  }

  const NOTIFY_ICONS = { danger: 'triangle-alert', warning: 'clock', info: 'bell', message: 'messages-square', attention: 'circle-alert' };

  function ensureNotifyPanel() {
    let layer = $('atlas-notifications');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'atlas-notifications';
    layer.className = 'atlas-layer atlas-layer--popover';
    layer.hidden = true;
    layer.innerHTML = `<div class="atlas-scrim atlas-scrim--clear" data-atlas-close></div>
      <section class="atlas-notify" role="dialog" aria-modal="false" aria-labelledby="atlas-notify-title">
        <header class="atlas-notify__head">
          <button type="button" class="atlas-icon-btn atlas-notify__back" data-atlas-close aria-label="Back">${icon('chevron-left', { size: 20 })}</button>
          <h2 class="atlas-notify__title" id="atlas-notify-title">Notifications <span class="atlas-notify__count"></span></h2>
          <div class="atlas-segmented atlas-notify__filter" role="radiogroup" aria-label="Show">
            <button type="button" role="radio" data-notify-filter="all">All</button>
            <button type="button" role="radio" data-notify-filter="needs-action">Needs action</button>
          </div>
          <button type="button" class="atlas-icon-btn" data-notify-more aria-haspopup="menu" aria-expanded="false" aria-label="More notification options">${icon('ellipsis', { size: 18 })}</button>
          <div class="atlas-menu atlas-notify__menu" role="menu" hidden>
            <button type="button" class="atlas-menu__item" role="menuitem" data-notify-action="read-all">${icon('check-check')}<span>Mark all as read</span></button>
            <button type="button" class="atlas-menu__item" role="menuitem" data-notify-action="settings">${icon('settings')}<span>Notification settings</span></button>
          </div>
        </header>
        <div class="atlas-notify__body"></div>
      </section>`;
    document.body.appendChild(layer);
    layer.addEventListener('click', onNotifyClick);
    layer.addEventListener('keydown', (event) => {
      const menu = layer.querySelector('.atlas-notify__menu');
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!menu.hidden) { menu.hidden = true; layer.querySelector('[data-notify-more]').setAttribute('aria-expanded', 'false'); layer.querySelector('[data-notify-more]').focus(); return; }
        shell.notify.close();
        return;
      }
      if (!menu.hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement);
        event.preventDefault();
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        return;
      }
      if (PHONE.matches) trapTab(event, layer.querySelector('.atlas-notify'));
    });
    return layer;
  }

  function notifyContext() {
    return { role: role(), context: state.activeId };
  }

  // Re-rendering keeps keyboard focus on the same control.
  function renderNotify() {
    const layer = ensureNotifyPanel();
    const focused = layer.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset?.notifyOpen ? `[data-notify-open="${CSS.escape(focused.dataset.notifyOpen)}"]`
      : focused?.dataset?.notifyRun ? `[data-notify-run="${CSS.escape(focused.dataset.notifyRun)}"]` : null;
    drawNotify(layer);
    if (focusKey) (layer.querySelector(focusKey) || layer.querySelector('[data-notify-filter][aria-checked="true"]'))?.focus();
  }

  function drawNotify(layer) {
    const all = shell.notify.items({ context: notifyContext() });
    const items = state.notifyFilter === 'needs-action' ? all.filter((item) => item.needsAction) : all;
    const unread = all.filter((item) => !item.read).length;
    layer.querySelector('.atlas-notify__count').textContent = unread ? `· ${unread} unread` : '';
    layer.querySelectorAll('[data-notify-filter]').forEach((button) => {
      const on = button.dataset.notifyFilter === state.notifyFilter;
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    });
    const body = layer.querySelector('.atlas-notify__body');
    if (!items.length) {
      body.innerHTML = `<div class="atlas-notify__empty">${icon('bell', { size: 20 })}<p class="atlas-notify__empty-title">${state.notifyFilter === 'needs-action' ? 'Nothing needs you right now' : "You're up to date"}</p><p class="atlas-notify__empty-text">New alerts, approvals and messages appear here.</p></div>`;
      return;
    }
    body.innerHTML = `<ul class="atlas-notify__list" role="list">${items.map((item) => {
      const tone = ['danger', 'warning'].includes(item.severity) ? item.severity : (item.type === 'message' ? 'accent' : 'neutral');
      const action = item.action?.label ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-notify__action" data-notify-run="${escape(item.id)}">${escape(item.action.label)}</button>` : '';
      return `<li class="atlas-notify__item${item.read ? '' : ' is-unread'}">
        <button type="button" class="atlas-notify__row" data-notify-open="${escape(item.id)}">
          <span class="atlas-notify__unread" aria-hidden="true"></span>
          <span class="atlas-notify__tile atlas-notify__tile--${tone}">${icon(item.icon || NOTIFY_ICONS[item.type] || NOTIFY_ICONS[item.severity] || 'bell')}</span>
          <span class="atlas-notify__text"><span class="atlas-notify__item-title">${item.read ? '' : '<span class="sr-only">Unread: </span>'}${escape(item.title)}</span>${item.detail ? `<span class="atlas-notify__detail">${escape(item.detail)}</span>` : ''}</span>
          <span class="atlas-notify__time">${escape(relativeTime(item.time))}</span>
        </button>${action}
      </li>`;
    }).join('')}</ul>`;
  }

  function onNotifyClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const layer = $('atlas-notifications');
    const menu = layer.querySelector('.atlas-notify__menu');
    if (target.closest('[data-atlas-close]')) { shell.notify.close(); return; }
    const filter = target.closest('[data-notify-filter]');
    if (filter) { state.notifyFilter = filter.dataset.notifyFilter; renderNotify(); layer.querySelector(`[data-notify-filter="${state.notifyFilter}"]`)?.focus(); return; }
    const more = target.closest('[data-notify-more]');
    if (more) {
      menu.hidden = !menu.hidden;
      more.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector('[role="menuitem"]')?.focus();
      return;
    }
    const action = target.closest('[data-notify-action]');
    if (action) {
      menu.hidden = true;
      layer.querySelector('[data-notify-more]').setAttribute('aria-expanded', 'false');
      if (action.dataset.notifyAction === 'read-all') { shell.notify.markAllRead(); layer.querySelector('[data-notify-more]').focus(); }
      else { shell.notify.close({ restoreFocus: false }); navigate('#settings/notifications', action); }
      return;
    }
    if (!menu.hidden && !target.closest('.atlas-notify__menu')) { menu.hidden = true; layer.querySelector('[data-notify-more]').setAttribute('aria-expanded', 'false'); }
    const open = target.closest('[data-notify-open], [data-notify-run]');
    if (open) {
      const id = open.dataset.notifyOpen || open.dataset.notifyRun;
      shell.notify.close({ restoreFocus: false });
      shell.notify.activate(id, notifyContext()).catch((error) => console.error('Notification action failed', error));
    }
  }

  function positionNotify() {
    const panel = $('atlas-notifications')?.querySelector('.atlas-notify');
    const bell = $('atlas-notifications-btn');
    if (!panel) return;
    panel.style.removeProperty('top');
    panel.style.removeProperty('right');
    if (PHONE.matches || !bell) return;
    const rect = bell.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  }

  const isNotifyHash = (hash) => /^#notifications(\?|$)/.test(String(hash || ''));

  // AtlasShell.notify.setPanel contract: open(options) / close(options).
  // options.filter ('all' | 'needs-action') preselects the filter, as does
  // #notifications?filter=needs-action.
  const notifyPanel = {
    open(options = {}) {
      const layer = ensureNotifyPanel();
      if (options.filter) state.notifyFilter = options.filter === 'needs-action' ? 'needs-action' : 'all';
      state.notifyTrigger = options.trigger || state.notifyTrigger || $('atlas-notifications-btn');
      renderNotify();
      layer.classList.toggle('is-fullscreen', PHONE.matches);
      layer.hidden = false;
      state.notifyOpen = true;
      document.body.classList.toggle('atlas-overlay-open', PHONE.matches);
      if (PHONE.matches && !isNotifyHash(window.location.hash) && !options.fromRoute) {
        try { window.history.pushState({ atlasNotifications: true }, '', '#notifications'); } catch { /* address bar only */ }
      }
      positionNotify();
      $('atlas-notifications-btn')?.setAttribute('aria-expanded', 'true');
      (layer.querySelector('[data-notify-filter][aria-checked="true"]') || layer.querySelector('button'))?.focus();
    },
    close(options = {}) {
      const layer = $('atlas-notifications');
      if (!layer || layer.hidden) return;
      layer.hidden = true;
      state.notifyOpen = false;
      document.body.classList.remove('atlas-overlay-open');
      $('atlas-notifications-btn')?.setAttribute('aria-expanded', 'false');
      // On phones the panel is the #notifications route: closing goes back.
      if (isNotifyHash(window.location.hash)) {
        if (window.history.state?.atlasNotifications) window.history.back();
        else shell.navigate('#home', { source: 'nav' });
      }
      if (options.restoreFocus !== false) state.notifyTrigger?.focus?.();
    }
  };

  // ---------- badges: Messages unread, bell dot ----------

  function readMessagesUnread() {
    const team = document.getElementById('team-view');
    const teamOpen = team && team.style.display !== 'none' && window.AtlasTeamMessages?.snapshot?.();
    const value = teamOpen ? window.AtlasTeamMessages.unreadCount?.() : window.AtlasTeamUnreadBadge?.count?.();
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function setBadge(selector, count) {
    document.querySelectorAll(selector).forEach((badge) => {
      badge.textContent = count <= 0 ? '' : count > 99 ? '99+' : String(count);
      badge.hidden = count <= 0;
    });
  }

  function syncBadges() {
    const unread = readMessagesUnread();
    if (unread !== state.messagesUnread) {
      state.messagesUnread = unread;
      shell.emit('notify:changed', { source: 'messages' });
    }
    setBadge('[data-nav-badge="messages"], [data-nav-badge="more"]', unread);
    const messagesLink = document.querySelector('.atlas-sidebar .nav-item[data-nav-id="messages"]');
    if (messagesLink) messagesLink.setAttribute('aria-label', unread ? `Messages, ${unread} unread` : 'Messages');
    const more = $('atlas-more-btn');
    if (more) more.setAttribute('aria-label', unread ? `More, ${unread} unread messages` : 'More');
    syncBell();
  }

  // Unread dot on the bell; the count is in the panel header (spec §4.9).
  function syncBell() {
    const unread = shell.notify.unreadCount({ context: notifyContext() });
    const bell = $('atlas-notifications-btn');
    if (!bell) return;
    bell.querySelector('.dot').hidden = unread <= 0;
    bell.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  }

  // Per-conversation message items come from the Home feed (assets/js/home.js,
  // notify.contribute('messages')); the unread change above tells it to refresh.

  // ---------- account ----------

  function setAccount(details = {}) {
    state.account = { ...state.account, ...details };
    const avatar = $('user-avatar');
    if (avatar) {
      avatar.classList.remove('atlas-avatar--a', 'atlas-avatar--b', 'atlas-avatar--c', 'atlas-avatar--d');
      avatar.classList.add(avatarTint());
    }
    applyRole();
    syncBadges();
  }

  // ---------- venue name (brand line, sign-in) ----------
  // Read from Settings › Venue (business name and city). Never invented: with
  // no venue on record the brand shows "Atlas" alone. The last value read is
  // remembered on this device for the sign-in screen.
  const VENUE_KEY = 'atlas.venue.v1';
  let venueRequested = false;

  function venueFromWorkspace(workspace) {
    const value = (workspace?.sections || []).find((section) => section.section_key === 'venue')?.value || null;
    const name = String(value?.business_name || '').trim();
    if (!name) return null;
    const city = String(value?.city || '').trim();
    return { name, city, line: city ? `${name} · ${city}` : name };
  }

  function readCachedVenue() {
    try { const value = JSON.parse(window.localStorage.getItem(VENUE_KEY) || 'null'); return value?.name ? value : null; } catch { return null; }
  }

  function applyVenue(venue) {
    const line = $('atlas-brand-venue');
    if (line) { line.textContent = venue ? venue.line : ''; line.hidden = !venue; }
    const link = document.querySelector('.atlas-brand__link');
    if (link) link.setAttribute('aria-label', venue ? `Atlas, ${venue.line} — Home` : 'Atlas — Home');
    document.querySelectorAll('[data-atlas-venue-line]').forEach((node) => { node.textContent = venue ? venue.line : ''; node.hidden = !venue; });
    const sub = $('login-sub');
    if (sub) sub.textContent = venue ? `Sign in to ${venue.name}.` : 'Sign in to continue.';
  }

  function setVenue(venue) {
    const key = JSON.stringify(venue || null);
    if (state.venueKey === key) return;
    state.venueKey = key;
    applyVenue(venue);
    try { if (venue) window.localStorage.setItem(VENUE_KEY, key); } catch { /* per-device convenience only */ }
  }

  async function loadVenue() {
    const loaded = venueFromWorkspace(window.AtlasSettings?.snapshot?.());
    if (loaded) { setVenue(loaded); return; }
    if (venueRequested) return;
    venueRequested = true;
    const endpoint = String(window.VABAR_CONFIG?.SETTINGS_API || '').trim();
    const client = window.atlasSupabase;
    if (!endpoint || !client?.auth) { setVenue(null); return; }
    try {
      const session = (await client.auth.getSession())?.data?.session;
      if (!session?.access_token) return;
      const url = new URL(endpoint);
      url.searchParams.set('action', 'snapshot');
      const response = await fetch(url, { cache: 'no-store', headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      const payload = response.ok ? await response.json().catch(() => ({})) : {};
      setVenue(venueFromWorkspace(payload.workspace));
    } catch (error) {
      console.warn('Venue name unavailable; the brand shows Atlas only.', error?.message || error);
      setVenue(null);
    }
  }

  // ---------- offline bar (spec §4.11) ----------

  function syncOnline() {
    let bar = $('atlas-offline');
    if (navigator.onLine) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'atlas-offline';
      bar.className = 'atlas-offline';
      bar.setAttribute('role', 'status');
      bar.innerHTML = `${icon('wifi-off')}<span>You're offline. Changes can't be saved until you reconnect.</span>`;
      $('atlas-topbar')?.insertAdjacentElement('afterend', bar);
    }
    bar.hidden = false;
  }

  // ---------- wiring ----------

  function onDocumentClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const skip = target.closest('[data-atlas-skip]');
    if (skip) { event.preventDefault(); $('atlas-main')?.focus(); return; }
    const tab = target.closest('.atlas-tabbar a.atlas-tabbar__item[href^="#"]');
    if (tab && plainClick(event)) { event.preventDefault(); navigate(tab.getAttribute('href'), tab, event); return; }
    if (target.closest('#atlas-more-btn')) { if ($('atlas-more')?.hidden === false) closeMore(); else openMore(); return; }
    if (target.closest('#atlas-sidebar-toggle')) { toggleSidebar(); return; }
    if (target.closest('#atlas-sidebar-scrim')) { closeOverlaySidebar(); return; }
    if (target.closest('#atlas-account-btn')) { if ($('atlas-account-layer')?.hidden === false) closeAccountMenu(); else openAccountMenu($('atlas-account-btn')); return; }
    if (target.closest('#atlas-topbar-back')) {
      const back = state.topbar.back;
      if (typeof back === 'function') back(event); else if (back) navigate(String(back), target, event);
      return;
    }
    const topbarAction = target.closest('[data-topbar-action]');
    if (topbarAction) { state.topbar.actions[Number(topbarAction.dataset.topbarAction)]?.run(event); return; }
    const bell = target.closest('#atlas-notifications-btn');
    if (bell) { event.preventDefault(); if (state.notifyOpen) shell.notify.close(); else shell.notify.open({ trigger: bell }); return; }
    // Choosing a destination in the overlay sidebar closes it.
    if (target.closest('.atlas-sidebar .nav-item') && document.body.classList.contains('atlas-sidebar-open')) closeOverlaySidebar({ restoreFocus: false });
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && document.body.classList.contains('atlas-sidebar-open')) { closeOverlaySidebar(); return; }
    if (event.key === 'Escape' && state.notifyOpen && !$('atlas-notifications')?.contains(document.activeElement)) shell.notify.close();
  }

  function init() {
    document.querySelectorAll('[data-shortcut-hint]').forEach((hint) => { hint.textContent = IS_MAC ? '⌘K' : 'Ctrl K'; });
    const omni = $('atlas-omni');
    if (omni) omni.setAttribute('aria-label', `Search or ask Atlas (${IS_MAC ? 'Command' : 'Control'} K)`);
    shell.notify.setPanel(notifyPanel);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('mouseover', (event) => { const target = railTarget(event.target); if (target) showTooltip(target); });
    document.addEventListener('mouseout', (event) => { if (railTarget(event.target)) hideTooltip(); });
    document.addEventListener('focusin', (event) => { const target = railTarget(event.target); if (target && target.matches(':focus-visible')) showTooltip(target); else hideTooltip(); });
    document.addEventListener('focusout', hideTooltip);
    window.addEventListener('scroll', () => $('atlas-topbar')?.classList.toggle('is-scrolled', window.scrollY > 4), { passive: true });
    window.addEventListener('resize', () => { if (state.notifyOpen) positionNotify(); if ($('atlas-account-layer')?.hidden === false) closeAccountMenu({ restoreFocus: false }); });
    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);
    window.addEventListener('hashchange', () => {
      if (window.location.hash !== '#notifications' && state.notifyOpen && PHONE.matches) shell.notify.close({ restoreFocus: false });
      syncActive();
    });
    [PHONE, RAIL].forEach((query) => query.addEventListener('change', () => { applyLayout(); closeMore({ restoreFocus: false }); if (state.notifyOpen) shell.notify.close({ restoreFocus: false }); }));
    shell.on('view:before-show', () => { if (state.topbar.title || state.topbar.back || state.topbar.actions.length || state.topbar.own) setTopBar({}); });
    shell.on('view:show', (detail) => {
      syncActive();
      closeMore({ restoreFocus: false });
      if (document.body.classList.contains('atlas-sidebar-open')) closeOverlaySidebar({ restoreFocus: false });
      if (isNotifyHash(state.initialHash) && detail.source === 'link') { const initial = shell.parseRoute(state.initialHash); state.initialHash = ''; shell.notify.open({ ...initial.params, fromRoute: false }); }
    });
    shell.on('profile:ready', (profile) => { applyRole(); if (profile) loadVenue(); });
    // The Messages unread worker (AtlasTeamUnreadBadge) announces each change:
    // the sidebar, rail and More badges follow at once instead of on the poll.
    shell.on('messages:unread', () => syncBadges());
    shell.on('notify:changed', () => {
      syncBell();
      if (state.notifyOpen) renderNotify();
    });
    applyLayout();
    applyRole();
    syncOnline();
    syncBadges();
    // Keeps badges current and picks up a venue name edited in Settings.
    state.pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      syncBadges();
      const edited = venueFromWorkspace(window.AtlasSettings?.snapshot?.());
      if (edited) setVenue(edited);
    }, 2500);
    // Sign-in screen: the venue last read on this device, else nothing.
    applyVenue(readCachedVenue());
    refreshStaticIcons();
  }

  window.AtlasChrome = {
    setAccount,
    icon,
    openMore,
    closeMore,
    openAccountMenu,
    closeAccountMenu,
    // Flows that own the bottom edge (Atlas AI conversation, stock count,
    // full-screen sheets) hide the phone tab bar while they are open.
    setTabBarHidden(reason, hidden) {
      const reasons = new Set((document.body.dataset.atlasTabbarHidden || '').split(' ').filter(Boolean));
      if (hidden) reasons.add(String(reason)); else reasons.delete(String(reason));
      document.body.dataset.atlasTabbarHidden = [...reasons].join(' ');
    },
    setTopBar,
    refresh: () => { applyRole(); syncBadges(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
