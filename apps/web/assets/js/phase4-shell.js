(function () {
  'use strict';

  const VERSION = 'atlas-phase4-shell/0.3.0';
  const STYLE_HREF = 'assets/css/phase4-claude.css';
  const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  const THEME_KEY = 'atlas.phase4.theme';
  const COLLAPSE_KEY = 'atlas.phase4.sidebar-collapsed';
  const OPERATIONS_HUB_LABEL = 'Operations';

  const GROUPS = [
    ['home', 'HOME', [
      ['dashboard', 'Home', 'house', '[data-view="dashboard"]'],
    ]],
    ['operations', 'OPERATIONS', [
      ['inventory', 'Inventory', 'package', '[data-default="inventory"],[data-view="inventory"]'],
      ['recipes', 'Recipes', 'martini', '[data-default="recipes"],[data-view="recipes"]'],
      ['purchasing', 'Purchasing', 'truck', '[data-default="suppliers"],[data-view="suppliers"]'],
      ['imports', 'Import Center', 'file-up', '[data-view="imports"]'],
      ['real-va-data', 'Real VÁ Data', 'list-checks', '[data-view="sprint3-review"]'],
    ]],
    ['growth', 'GROWTH', [
      ['marketing', 'Marketing', 'megaphone', '[data-view="marketing"]'],
    ]],
    ['people', 'PEOPLE', [
      ['messages', 'Messages', 'messages-square', '[data-view="messages"]'],
      ['team', 'Team', 'users', '[data-view="team"]'],
      ['profiles', 'Profiles', 'contact', '[data-view="profiles"]'],
      ['shifts', 'Shifts', 'calendar-days', '[data-view="shifts"]'],
      ['knowledge', 'Knowledge', 'book-open', '[data-view="knowledge"]'],
    ]],
    ['insights', 'INSIGHTS', [
      ['brain', 'Atlas Brain', 'bot', '[data-view="brain"]'],
      ['business', 'Business Intelligence', 'chart-no-axes-combined', '[data-view="business"]'],
      ['reports', 'Reports', 'file-chart-column', '[data-view="reports"]'],
      ['accounting', 'Accounting', 'landmark', '[data-view="accounting"]', true],
    ]],
    ['system', 'SYSTEM', [
      ['settings', 'Settings', 'settings', '[data-view="settings"]'],
      ['system', 'System', 'activity', '[data-view="system"]'],
    ]],
  ];

  let installed = false;
  let commandEntries = [];
  let commandIndex = 0;
  let iconFrame = 0;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  function getStored(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function setStored(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* Storage can be disabled. */ }
  }

  function renderIcons() {
    if (iconFrame) return;
    iconFrame = requestAnimationFrame(() => {
      iconFrame = 0;
      try { window.lucide?.createIcons?.(); } catch (_) { /* Icons are decorative. */ }
    });
  }

  function ensureAssets() {
    if (!document.querySelector('link[data-atlas-phase4-font]')) {
      const font = document.createElement('link');
      font.rel = 'stylesheet';
      font.href = FONT_HREF;
      font.dataset.atlasPhase4Font = 'true';
      document.head.appendChild(font);
    }
    if (!document.querySelector(`link[href="${STYLE_HREF}"]`)) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = STYLE_HREF;
      stylesheet.dataset.atlasPhase4 = 'true';
      document.head.appendChild(stylesheet);
    }
  }

  function applyTheme(theme, persist = true) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.atlasTheme = next;
    document.documentElement.style.colorScheme = next;
    document.body.classList.toggle('atlas-theme-dark', next === 'dark');
    document.body.classList.toggle('atlas-theme-light', next === 'light');
    if (persist) setStored(THEME_KEY, next);

    const button = document.getElementById('phase4-theme-toggle');
    if (button) {
      const label = next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = `<i data-lucide="${next === 'dark' ? 'sun' : 'moon'}"></i>`;
      renderIcons();
    }
  }

  function applyCollapsed(collapsed, persist = true) {
    const next = Boolean(collapsed);
    document.body.classList.toggle('atlas-sidebar-collapsed', next);
    if (persist) setStored(COLLAPSE_KEY, next ? 'true' : 'false');

    const button = document.getElementById('phase4-sidebar-toggle');
    if (button) {
      const label = next ? 'Expand sidebar' : 'Collapse sidebar';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = `<i data-lucide="${next ? 'panel-left-open' : 'panel-left-close'}"></i>`;
      renderIcons();
    }
  }

  function installControls() {
    const topbar = document.querySelector('.atlas-topbar');
    const brand = document.querySelector('.atlas-brand');
    if (!topbar || !brand) return;

    if (!document.getElementById('phase4-sidebar-toggle')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'phase4-sidebar-toggle';
      button.className = 'phase4-icon-button phase4-sidebar-toggle';
      button.addEventListener('click', () => {
        applyCollapsed(!document.body.classList.contains('atlas-sidebar-collapsed'));
      });
      brand.appendChild(button);
    }

    if (!document.getElementById('phase4-theme-toggle')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'phase4-theme-toggle';
      button.className = 'phase4-icon-button';
      button.addEventListener('click', () => {
        applyTheme(document.documentElement.dataset.atlasTheme === 'dark' ? 'light' : 'dark');
      });
      topbar.insertBefore(button, document.getElementById('service-mode-btn'));
    }

    const preferredTheme = getStored(THEME_KEY)
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(preferredTheme, false);
    applyCollapsed(getStored(COLLAPSE_KEY) === 'true', false);
  }

  function createGroup(key, label) {
    const group = document.createElement('section');
    group.className = 'nav-group phase4-nav-group';
    group.dataset.phase4Group = key;
    group.innerHTML = `<div class="nav-label">${label}</div>`;
    return group;
  }

  function normalizeButton(button, key, label, icon) {
    button.classList.remove('nav-parent', 'open');
    button.dataset.phase4Destination = key;
    button.dataset.phase4Label = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.replaceChildren();

    const iconNode = document.createElement('i');
    iconNode.dataset.lucide = icon;
    const copy = document.createElement('span');
    copy.className = 'phase4-nav-copy';
    copy.textContent = label;
    button.append(iconNode, copy);
    return button;
  }

  function createPlaceholder(key, label, icon) {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = true;
    button.className = 'nav-item phase4-coming-soon';
    button.dataset.phase4Placeholder = key;
    button.setAttribute('aria-label', `${label}, coming later`);
    button.innerHTML = `<i data-lucide="${icon}"></i><span class="phase4-nav-copy">${label}</span><span class="phase4-nav-meta">Soon</span>`;
    return button;
  }

  function inferLabel(button) {
    return button.dataset.phase4Label
      || button.textContent?.trim()
      || button.dataset.view
      || button.dataset.default
      || 'Workspace';
  }

  function reorganizeNavigation() {
    const nav = document.querySelector('.atlas-nav');
    if (!nav || nav.dataset.phase4Organized === VERSION) return;

    const buttons = Array.from(nav.querySelectorAll('.nav-item'));
    const used = new Set();
    const fragment = document.createDocumentFragment();

    GROUPS.forEach(([groupKey, groupLabel, definitions]) => {
      const group = createGroup(groupKey, groupLabel);
      definitions.forEach(([key, label, icon, selector, placeholderAllowed]) => {
        const button = buttons.find((candidate) => !used.has(candidate) && candidate.matches(selector));
        if (button) {
          used.add(button);
          group.appendChild(normalizeButton(button, key, label, icon));
        } else if (placeholderAllowed) {
          group.appendChild(createPlaceholder(key, label, icon));
        }
      });
      if (group.querySelector('.nav-item')) fragment.appendChild(group);
    });

    const remaining = buttons.filter((button) => !used.has(button));
    if (remaining.length) {
      const more = createGroup('more', 'MORE');
      remaining.forEach((button) => {
        const label = inferLabel(button);
        const key = button.dataset.view
          || button.dataset.default
          || label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        more.appendChild(normalizeButton(button, key, label, 'circle-ellipsis'));
      });
      fragment.appendChild(more);
    }

    nav.replaceChildren(fragment);
    nav.dataset.phase4Organized = VERSION;
    nav.addEventListener('click', (event) => {
      const button = event.target.closest('.nav-item');
      if (!button || button.disabled) return;
      syncActive(button.dataset.phase4Destination);
      if (innerWidth <= 760) {
        document.getElementById('atlas-sidebar')?.classList.remove('open');
        document.getElementById('sidebar-backdrop')?.classList.remove('open');
      }
    });
    rebuildCommands();
    syncActive();
  }

  function destinationFromTitle() {
    const title = document.getElementById('atlas-page-title')?.textContent?.trim().toLowerCase() || '';
    return ({
      home: 'dashboard',
      operations: 'dashboard',
      inventory: 'inventory',
      recipes: 'recipes',
      purchasing: 'purchasing',
      suppliers: 'purchasing',
      'import center': 'imports',
      'real vá data': 'real-va-data',
      messages: 'messages',
      team: 'team',
      profiles: 'profiles',
      shifts: 'shifts',
      knowledge: 'knowledge',
      marketing: 'marketing',
      'atlas brain': 'brain',
      'business intelligence': 'business',
      reports: 'reports',
      accounting: 'accounting',
      settings: 'settings',
      system: 'system',
    })[title] || 'dashboard';
  }

  function syncActive(forced) {
    const destination = forced || destinationFromTitle();
    document.body.dataset.atlasView = destination;
    document.querySelectorAll('.atlas-nav .nav-item').forEach((button) => {
      const active = button.dataset.phase4Destination === destination;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function ensurePalette() {
    if (document.getElementById('phase4-command-palette')) return;
    const palette = document.createElement('div');
    palette.id = 'phase4-command-palette';
    palette.className = 'phase4-command-palette';
    palette.hidden = true;
    palette.setAttribute('role', 'dialog');
    palette.setAttribute('aria-modal', 'true');
    palette.setAttribute('aria-label', 'Atlas command palette');
    palette.innerHTML = `<div class="phase4-command-backdrop" data-command-close></div><section class="phase4-command-panel" tabindex="-1"><header><i data-lucide="search"></i><input id="phase4-command-input" type="search" autocomplete="off" placeholder="Search Atlas or jump to a workspace…" aria-label="Search Atlas"><kbd>Esc</kbd></header><div class="phase4-command-results" id="phase4-command-results" role="listbox"></div><footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>⌘</kbd><kbd>K</kbd> search</span></footer></section>`;
    document.body.appendChild(palette);

    palette.addEventListener('click', (event) => {
      if (event.target.closest('[data-command-close]')) closePalette();
      const option = event.target.closest('[data-command-index]');
      if (option) activateCommand(Number(option.dataset.commandIndex));
    });
    document.getElementById('phase4-command-input').addEventListener('input', renderCommands);
    document.getElementById('phase4-command-input').addEventListener('keydown', handlePaletteKeys);
  }

  function rebuildCommands() {
    commandEntries = Array.from(document.querySelectorAll('.atlas-nav .nav-item:not(:disabled)')).map((button) => ({
      label: button.dataset.phase4Label || button.textContent.trim(),
      group: button.closest('[data-phase4-group]')?.querySelector('.nav-label')?.textContent || 'Atlas',
      action: () => button.click(),
    }));
    commandIndex = 0;
  }

  function filteredCommands() {
    const query = document.getElementById('phase4-command-input')?.value.trim().toLowerCase() || '';
    if (!query) return commandEntries;
    return commandEntries.filter((entry) => `${entry.label} ${entry.group}`.toLowerCase().includes(query));
  }

  function renderCommands() {
    const target = document.getElementById('phase4-command-results');
    if (!target) return;
    const entries = filteredCommands();
    commandIndex = Math.min(commandIndex, Math.max(0, entries.length - 1));
    target.innerHTML = entries.length
      ? entries.map((entry, index) => `<button type="button" role="option" aria-selected="${index === commandIndex}" class="phase4-command-option${index === commandIndex ? ' active' : ''}" data-command-index="${index}"><span class="phase4-command-icon"><i data-lucide="arrow-right"></i></span><span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.group)}</small></span><i data-lucide="arrow-up-right"></i></button>`).join('')
      : '<div class="phase4-command-empty"><i data-lucide="search-x"></i><strong>No matching workspace</strong><span>Try inventory, recipes, shifts, reports or settings.</span></div>';
    renderIcons();
  }

  function openPalette() {
    ensurePalette();
    rebuildCommands();
    const palette = document.getElementById('phase4-command-palette');
    palette.hidden = false;
    palette.classList.add('open');
    document.body.classList.add('phase4-command-open');
    const input = document.getElementById('phase4-command-input');
    input.value = '';
    input.focus();
    renderCommands();
  }

  function closePalette() {
    const palette = document.getElementById('phase4-command-palette');
    if (!palette) return;
    palette.classList.remove('open');
    palette.hidden = true;
    document.body.classList.remove('phase4-command-open');
  }

  function activateCommand(index) {
    const entry = filteredCommands()[index];
    if (!entry) return;
    closePalette();
    entry.action();
  }

  function handlePaletteKeys(event) {
    const entries = filteredCommands();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      commandIndex = entries.length ? (commandIndex + 1) % entries.length : 0;
      renderCommands();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      commandIndex = entries.length ? (commandIndex - 1 + entries.length) % entries.length : 0;
      renderCommands();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activateCommand(commandIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  }

  function installSearch() {
    const existing = document.getElementById('global-search');
    if (!existing || existing.dataset.phase4Search) return;
    const input = existing.cloneNode(true);
    input.dataset.phase4Search = 'true';
    input.value = '';
    input.placeholder = 'Search Atlas…';
    input.setAttribute('aria-label', 'Search Atlas');
    existing.replaceWith(input);
    input.addEventListener('focus', openPalette);
    input.addEventListener('click', openPalette);
  }

  function installKeyboardNavigation() {
    document.addEventListener('keydown', (event) => {
      const typing = event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
        || event.target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openPalette();
      } else if (event.key === '/' && !typing && !document.body.classList.contains('phase4-command-open')) {
        event.preventDefault();
        openPalette();
      } else if (event.key === 'Escape' && document.body.classList.contains('phase4-command-open')) {
        event.preventDefault();
        closePalette();
      }
    }, true);
  }

  function labelIconButtons() {
    const labels = {
      bell: 'Notifications',
      menu: 'Open navigation',
      'log-out': 'Sign out',
      x: 'Close',
      'refresh-cw': 'Refresh',
    };
    document.querySelectorAll('button.top-icon,button.phase4-icon-button').forEach((button) => {
      if (button.getAttribute('aria-label')) return;
      const icon = button.querySelector('[data-lucide]')?.dataset.lucide;
      if (labels[icon]) button.setAttribute('aria-label', labels[icon]);
    });
  }

  function installViewSync() {
    document.addEventListener('click', (event) => {
      if (!event.target.closest('[data-view],[data-default],[data-target]')) return;
      requestAnimationFrame(() => syncActive());
    }, true);
    window.addEventListener('atlas:view-changed', (event) => syncActive(event.detail?.view));
  }

  function install() {
    if (installed || !window.atlasCurrentProfile?.active) return;
    installed = true;
    ensureAssets();
    document.body.classList.add('atlas-phase4');
    document.documentElement.dataset.atlasPhase = '4';
    document.documentElement.dataset.atlasPhase4Version = VERSION;
    document.body.dataset.atlasHomePurpose = OPERATIONS_HUB_LABEL;

    installControls();
    reorganizeNavigation();
    ensurePalette();
    installSearch();
    installKeyboardNavigation();
    installViewSync();
    labelIconButtons();
    renderIcons();

    window.addEventListener('resize', () => {
      if (innerWidth <= 760) return;
      document.getElementById('atlas-sidebar')?.classList.remove('open');
      document.getElementById('sidebar-backdrop')?.classList.remove('open');
    });

    window.AtlasPhase4Shell = Object.freeze({
      version: VERSION,
      applyTheme,
      applyCollapsed,
      openPalette,
      reorganizeNavigation,
      syncActive,
    });
    document.dispatchEvent(new CustomEvent('atlas:phase4-ready', { detail: { version: VERSION } }));
  }

  if (window.atlasCurrentProfile?.active) install();
  else window.addEventListener('atlas:profile-ready', (event) => {
    if (event.detail?.active) install();
  }, { once: true });
})();
