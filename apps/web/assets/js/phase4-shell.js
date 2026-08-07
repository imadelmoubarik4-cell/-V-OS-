(function () {
  'use strict';

  const VERSION = 'atlas-phase4-shell/0.2.0';
  const STYLE_HREF = 'assets/css/phase4-claude.css';
  const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  const THEME_KEY = 'atlas.phase4.theme';
  const COLLAPSE_KEY = 'atlas.phase4.sidebar-collapsed';

  const GROUPS = [
    ['home', 'HOME', [['dashboard', 'Home', 'house', '[data-view="dashboard"]']]],
    ['operations', 'OPERATIONS', [
      ['operations', 'Operations', 'clipboard-check', '[data-view="operations"]'],
      ['inventory', 'Inventory', 'package', '[data-default="inventory"],[data-view="inventory"]'],
      ['recipes', 'Recipes', 'martini', '[data-default="recipes"],[data-view="recipes"]'],
      ['purchasing', 'Purchasing', 'truck', '[data-default="suppliers"],[data-view="suppliers"]'],
      ['imports', 'Import Center', 'file-up', '[data-view="imports"]'],
      ['real-va-data', 'Real VÁ Data', 'list-checks', '[data-view="sprint3-review"]'],
    ]],
    ['growth', 'GROWTH', [['marketing', 'Marketing', 'megaphone', '[data-view="marketing"]']]],
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

  let reorganizing = false;
  let commandEntries = [];
  let commandIndex = 0;

  const getStored = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const setStored = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* storage may be disabled */ } };
  const renderIcons = () => { try { window.lucide?.createIcons?.(); } catch (_) { /* decorative */ } };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  function ensureAssets() {
    if (!document.querySelector('link[data-atlas-phase4-font]')) {
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = 'https://fonts.gstatic.com';
      preconnect.crossOrigin = 'anonymous';
      preconnect.dataset.atlasPhase4Font = 'preconnect';
      document.head.appendChild(preconnect);
      const font = document.createElement('link');
      font.rel = 'stylesheet';
      font.href = FONT_HREF;
      font.dataset.atlasPhase4Font = 'true';
      document.head.appendChild(font);
    }
    let stylesheet = document.querySelector(`link[href="${STYLE_HREF}"]`);
    if (!stylesheet) {
      stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = STYLE_HREF;
      stylesheet.dataset.atlasPhase4 = 'true';
      document.head.appendChild(stylesheet);
    }
    if (document.head.lastElementChild !== stylesheet) document.head.appendChild(stylesheet);
  }

  function observeHead() {
    new MutationObserver(() => {
      const stylesheet = document.querySelector(`link[href="${STYLE_HREF}"]`);
      if (stylesheet && document.head.lastElementChild !== stylesheet) document.head.appendChild(stylesheet);
    }).observe(document.head, { childList: true });
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
      button.title = next === 'dark' ? 'Light mode' : 'Dark mode';
      button.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
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
      button.title = next ? 'Expand sidebar' : 'Collapse sidebar';
      button.setAttribute('aria-label', next ? 'Expand sidebar' : 'Collapse sidebar');
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
      button.addEventListener('click', () => applyCollapsed(!document.body.classList.contains('atlas-sidebar-collapsed')));
      brand.appendChild(button);
    }
    if (!document.getElementById('phase4-theme-toggle')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'phase4-theme-toggle';
      button.className = 'phase4-icon-button';
      button.addEventListener('click', () => applyTheme(document.documentElement.dataset.atlasTheme === 'dark' ? 'light' : 'dark'));
      topbar.insertBefore(button, document.getElementById('service-mode-btn'));
    }
    const theme = getStored(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(theme, false);
    applyCollapsed(getStored(COLLAPSE_KEY) === 'true', false);
  }

  function topLevelButtons(nav) {
    return Array.from(nav.querySelectorAll(':scope > .nav-group > .nav-item, :scope > .phase4-nav-group > .nav-item')).filter((button) => !button.dataset.phase4Placeholder);
  }

  function ensureIcon(button, icon) {
    button.querySelectorAll('.chev,[data-lucide="chevron-down"],[data-lucide="chevron-right"]').forEach((node) => node.remove());
    if (!button.querySelector('svg,i[data-lucide]')) {
      const source = document.createElement('i');
      source.dataset.lucide = icon;
      button.prepend(source);
    }
  }

  function labelButton(button, label, key) {
    button.classList.remove('nav-parent', 'open');
    button.dataset.phase4Destination = key;
    button.dataset.phase4Label = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    let copy = button.querySelector('.phase4-nav-copy');
    if (!copy) {
      Array.from(button.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).forEach((node) => node.remove());
      copy = document.createElement('span');
      copy.className = 'phase4-nav-copy';
      const icon = button.querySelector('svg,i[data-lucide]');
      if (icon) icon.insertAdjacentElement('afterend', copy);
      else button.appendChild(copy);
    }
    copy.textContent = label;
  }

  function createPlaceholder(key, label, icon) {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = true;
    button.className = 'nav-item phase4-coming-soon';
    button.dataset.phase4Placeholder = key;
    button.innerHTML = `<i data-lucide="${icon}"></i><span class="phase4-nav-copy">${label}</span><span class="phase4-nav-meta">Soon</span>`;
    button.setAttribute('aria-label', `${label}, coming later`);
    return button;
  }

  function createGroup(key, label) {
    const group = document.createElement('section');
    group.className = 'nav-group phase4-nav-group';
    group.dataset.phase4Group = key;
    group.innerHTML = `<div class="nav-label">${label}</div>`;
    return group;
  }

  function findUnusedButton(buttons, used, selector) {
    return buttons.find((button) => !used.has(button) && button.matches(selector)) || null;
  }

  function inferLabel(button) {
    return button.dataset.phase4Label || button.querySelector('span:not(.phase4-nav-meta)')?.textContent?.trim() || Array.from(button.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ').trim() || 'Workspace';
  }

  function reorganizeNavigation() {
    const nav = document.querySelector('.atlas-nav');
    if (!nav || reorganizing) return;
    reorganizing = true;
    try {
      const buttons = topLevelButtons(nav);
      const used = new Set();
      const fragment = document.createDocumentFragment();
      GROUPS.forEach(([key, label, items]) => {
        const group = createGroup(key, label);
        items.forEach(([itemKey, itemLabel, icon, selector, allowPlaceholder]) => {
          const button = findUnusedButton(buttons, used, selector);
          if (button) {
            used.add(button);
            ensureIcon(button, icon);
            labelButton(button, itemLabel, itemKey);
            group.appendChild(button);
          } else if (allowPlaceholder) group.appendChild(createPlaceholder(itemKey, itemLabel, icon));
        });
        if (group.querySelector('.nav-item')) fragment.appendChild(group);
      });
      const remaining = buttons.filter((button) => !used.has(button));
      if (remaining.length) {
        const more = createGroup('more', 'MORE');
        remaining.forEach((button) => {
          const label = inferLabel(button);
          const destination = button.dataset.view || button.dataset.default || label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          ensureIcon(button, 'circle-ellipsis');
          labelButton(button, label, destination);
          more.appendChild(button);
        });
        fragment.appendChild(more);
      }
      nav.replaceChildren(fragment);
      nav.dataset.phase4Organized = 'true';
      installNavDelegation(nav);
      syncActive();
      rebuildCommands();
      renderIcons();
    } finally { reorganizing = false; }
  }

  function destinationFromTitle() {
    const title = document.getElementById('atlas-page-title')?.textContent?.trim().toLowerCase() || '';
    return ({ home: 'dashboard', operations: 'operations', inventory: 'inventory', recipes: 'recipes', purchasing: 'purchasing', suppliers: 'purchasing', 'import center': 'imports', 'real vá data': 'real-va-data', messages: 'messages', team: 'team', profiles: 'profiles', shifts: 'shifts', knowledge: 'knowledge', marketing: 'marketing', 'atlas brain': 'brain', 'business intelligence': 'business', reports: 'reports', accounting: 'accounting', settings: 'settings', system: 'system' })[title] || 'dashboard';
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

  function installNavDelegation(nav) {
    if (nav.dataset.phase4Delegation) return;
    nav.dataset.phase4Delegation = 'true';
    nav.addEventListener('click', (event) => {
      const button = event.target.closest('.nav-item');
      if (!button || button.disabled) return;
      syncActive(button.dataset.phase4Destination);
      if (innerWidth <= 760) {
        document.getElementById('atlas-sidebar')?.classList.remove('open');
        document.getElementById('sidebar-backdrop')?.classList.remove('open');
      }
    });
  }

  function observeNavigation() {
    const nav = document.querySelector('.atlas-nav');
    if (!nav || nav.dataset.phase4Observed) return;
    nav.dataset.phase4Observed = 'true';
    new MutationObserver((mutations) => {
      if (reorganizing) return;
      const unprocessed = mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => node instanceof Element && (node.matches('.nav-item:not([data-phase4-destination]):not([data-phase4-placeholder])') || node.querySelector('.nav-item:not([data-phase4-destination]):not([data-phase4-placeholder])'))));
      if (unprocessed) setTimeout(reorganizeNavigation, 30);
    }).observe(nav, { childList: true, subtree: true });
    const title = document.getElementById('atlas-page-title');
    if (title) new MutationObserver(() => syncActive()).observe(title, { childList: true, characterData: true, subtree: true });
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
      const result = event.target.closest('[data-command-index]');
      if (result) activateCommand(Number(result.dataset.commandIndex));
    });
    document.getElementById('phase4-command-input').addEventListener('input', renderCommands);
    document.getElementById('phase4-command-input').addEventListener('keydown', paletteKeys);
  }

  function rebuildCommands() {
    commandEntries = Array.from(document.querySelectorAll('.atlas-nav .nav-item:not(:disabled)')).map((button) => ({ label: button.dataset.phase4Label || button.textContent.trim(), group: button.closest('[data-phase4-group]')?.querySelector('.nav-label')?.textContent || 'Atlas', action: () => button.click() }));
    commandIndex = 0;
  }

  function filteredCommands() {
    const query = document.getElementById('phase4-command-input')?.value.trim().toLowerCase() || '';
    return query ? commandEntries.filter((entry) => `${entry.label} ${entry.group}`.toLowerCase().includes(query)) : commandEntries;
  }

  function renderCommands() {
    const target = document.getElementById('phase4-command-results');
    if (!target) return;
    const entries = filteredCommands();
    commandIndex = Math.min(commandIndex, Math.max(0, entries.length - 1));
    target.innerHTML = entries.length ? entries.map((entry, index) => `<button type="button" role="option" aria-selected="${index === commandIndex}" class="phase4-command-option${index === commandIndex ? ' active' : ''}" data-command-index="${index}"><span class="phase4-command-icon"><i data-lucide="arrow-right"></i></span><span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.group)}</small></span><i data-lucide="arrow-up-right"></i></button>`).join('') : '<div class="phase4-command-empty"><i data-lucide="search-x"></i><strong>No matching workspace</strong><span>Try inventory, recipes, shifts, reports or settings.</span></div>';
    renderIcons();
  }

  function openPalette() {
    ensurePalette();
    rebuildCommands();
    const palette = document.getElementById('phase4-command-palette');
    palette.hidden = false;
    requestAnimationFrame(() => palette.classList.add('open'));
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

  function paletteKeys(event) {
    const entries = filteredCommands();
    if (event.key === 'ArrowDown') { event.preventDefault(); commandIndex = entries.length ? (commandIndex + 1) % entries.length : 0; renderCommands(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); commandIndex = entries.length ? (commandIndex - 1 + entries.length) % entries.length : 0; renderCommands(); }
    else if (event.key === 'Enter') { event.preventDefault(); activateCommand(commandIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
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
    document.addEventListener('keydown', (event) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); }
      else if (event.key === '/' && !typing && !document.body.classList.contains('phase4-command-open')) { event.preventDefault(); openPalette(); }
      else if (event.key === 'Escape' && document.body.classList.contains('phase4-command-open')) { event.preventDefault(); closePalette(); }
    }, true);
  }

  function labelIconButtons() {
    const labels = { bell: 'Notifications', menu: 'Open navigation', 'log-out': 'Sign out', x: 'Close', 'refresh-cw': 'Refresh' };
    document.querySelectorAll('button.top-icon,button.phase4-icon-button').forEach((button) => {
      if (button.getAttribute('aria-label')) return;
      const icon = button.querySelector('[data-lucide]')?.dataset.lucide || button.querySelector('svg')?.getAttribute('data-lucide');
      if (labels[icon]) button.setAttribute('aria-label', labels[icon]);
    });
  }

  function install() {
    ensureAssets();
    observeHead();
    document.body.classList.add('atlas-phase4');
    document.documentElement.dataset.atlasPhase = '4';
    document.documentElement.dataset.atlasPhase4Version = VERSION;
    installControls();
    installSearch();
    ensurePalette();
    reorganizeNavigation();
    observeNavigation();
    labelIconButtons();
    renderIcons();
    [50, 250, 750, 1500, 3000, 6000].forEach((delay) => setTimeout(() => { reorganizeNavigation(); syncActive(); labelIconButtons(); ensureAssets(); renderIcons(); }, delay));
    addEventListener('resize', () => {
      if (innerWidth > 760) {
        document.getElementById('atlas-sidebar')?.classList.remove('open');
        document.getElementById('sidebar-backdrop')?.classList.remove('open');
      }
    });
    window.AtlasPhase4Shell = Object.freeze({ version: VERSION, applyTheme, applyCollapsed, openPalette, reorganizeNavigation, syncActive });
    document.dispatchEvent(new CustomEvent('atlas:phase4-ready', { detail: { version: VERSION } }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
