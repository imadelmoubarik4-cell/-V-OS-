(() => {
  'use strict';

  const SHELL_URL = new URL('next.html', window.location.href);
  const SCRIPT_TIMEOUT_MS = 15000;
  const SHELL_TIMEOUT_MS = 12000;
  const CORE_TIMEOUT_MS = 22000;

  const SUPABASE_SCRIPT = Object.freeze({
    src: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    integrity: 'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug',
    crossorigin: 'anonymous',
  });

  const CORE_SCRIPTS = Object.freeze([
    'assets/js/atlas-next-config.js',
    'assets/js/data/atlas-data.js',
    'assets/js/modal.js',
    'assets/js/atlas-next-gateway-bridge.js',
    // The adapter must register before the core emits the first auth/data events.
    'assets/js/atlas-next-workspaces.js',
    'assets/js/atlas-next.js',
  ]);

  const WORKSPACE_SCRIPTS = Object.freeze([
    'assets/js/atlas-next-stock-counts.js',
    'assets/js/atlas-next-purchasing.js',
    'assets/js/inventory-scanner.js',
    'assets/js/item-master-workspace.js',
    'assets/js/recipes.js',
    'assets/js/import-center.js',
    'assets/js/sprint3-review.js',
    'assets/js/operations-checkpoint-a.js',
    'assets/js/operations-checkpoint-a-layout.js',
    'assets/js/team-messages.js',
    'assets/js/team-unread-badge.js',
    'assets/js/marketing-workspace.js',
    'assets/js/team-profiles.source.js',
    'assets/js/team-profile-photos.js',
    'assets/js/team-profile-photo-gallery.js',
    'assets/js/shifts-workspace.js',
    'assets/js/shifts-month-calendar.js',
    'assets/js/shifts-month-tab-bridge.js',
    'assets/js/knowledge-workspace.js',
    'assets/js/knowledge-team-link-bridge.js',
    'assets/js/read-sources-p22.js',
    'assets/js/reports-workspace.js',
    'assets/js/pos-mapping-checkpoint-m.js',
    'assets/js/system-workspace.js',
    'assets/js/settings-workspace.js',
    'assets/js/settings-mount-bridge.js',
    'assets/js/connection-center.js',
    'assets/js/brain.js',
    'assets/js/brain-daily-briefing-v2.js',
    'assets/js/brain-phase3.js',
    'assets/js/brain-checkpoint-k.js',
    'assets/js/business.js',
  ]);

  const LUCIDE_SCRIPT = Object.freeze({
    src: 'https://unpkg.com/lucide@0.454.0/dist/umd/lucide.min.js',
    integrity: 'sha384-m/CoPp6wBQz6MoZXP+VveuxfvSx0NGXiQyyakzXVOVHgG1fP5bM/UiO4pSNPV6PT',
    crossorigin: 'anonymous',
  });

  const loadedScripts = new Map();
  let fatalShown = false;

  function bootstrapNode(id) {
    return document.getElementById(id);
  }

  function setBootstrapStatus(title, copy, showLogin = false) {
    const titleNode = bootstrapNode('atlas-bootstrap-title');
    const copyNode = bootstrapNode('atlas-bootstrap-copy');
    const loginNode = bootstrapNode('atlas-bootstrap-login');
    if (titleNode) titleNode.textContent = title;
    if (copyNode) copyNode.textContent = copy;
    if (loginNode) loginNode.hidden = !showLogin;

    const coreBoot = document.getElementById('atlas-boot');
    const coreCopy = coreBoot?.querySelector('span');
    if (coreCopy) coreCopy.textContent = title;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
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

  async function fetchShell() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SHELL_TIMEOUT_MS);
    try {
      const url = new URL(SHELL_URL.href);
      url.searchParams.set('shell', Date.now().toString(36));
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { accept: 'text/html' },
      });
      if (!response.ok) throw new Error(`Atlas shell request failed (${response.status}).`);
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      if (!parsed.getElementById('app-shell') || !parsed.getElementById('auth-screen')) {
        throw new Error('Atlas shell markup is incomplete.');
      }
      return parsed;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Atlas shell took too long to load.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function copyStyles(parsed) {
    const sourceBase = new URL('.', SHELL_URL);
    for (const link of parsed.querySelectorAll('link[rel="stylesheet"]')) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const absolute = new URL(href, sourceBase).href;
      if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((candidate) => candidate.href === absolute)) continue;
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = absolute;
      if (link.media) stylesheet.media = link.media;
      document.head.appendChild(stylesheet);
    }

    for (const link of parsed.querySelectorAll('link[rel="preconnect"]')) {
      const href = link.getAttribute('href');
      if (!href || Array.from(document.querySelectorAll('link[rel="preconnect"]')).some((candidate) => candidate.href === href)) continue;
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = href;
      if (link.crossOrigin) preconnect.crossOrigin = link.crossOrigin;
      document.head.appendChild(preconnect);
    }
  }

  function installShell(parsed) {
    copyStyles(parsed);
    document.title = parsed.title || 'Atlas · VÁ Hospitality OS';
    const shellBody = parsed.body.innerHTML;
    if (!shellBody.trim()) throw new Error('Atlas shell body is empty.');
    document.body.innerHTML = shellBody;
    document.body.dataset.atlasEntry = 'app';
  }

  function normalizeScriptDescriptor(descriptor) {
    if (typeof descriptor === 'string') return { src: new URL(descriptor, window.location.href).href };
    return { ...descriptor, src: new URL(descriptor.src, window.location.href).href };
  }

  function loadScript(descriptor, options = {}) {
    const normalized = normalizeScriptDescriptor(descriptor);
    const existingPromise = loadedScripts.get(normalized.src);
    if (existingPromise) return existingPromise;

    const promise = new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find((script) => script.src === normalized.src);
      if (existing?.dataset.atlasLoaded === 'true') {
        resolve(existing);
        return;
      }

      const script = existing || document.createElement('script');
      script.src = normalized.src;
      script.async = false;
      script.dataset.atlasManaged = 'true';
      if (normalized.integrity) script.integrity = normalized.integrity;
      if (normalized.crossorigin) script.crossOrigin = normalized.crossorigin;

      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        callback(value);
      };
      const timer = window.setTimeout(() => {
        finish(reject, new Error(`Atlas asset timed out: ${normalized.src}`));
      }, options.timeoutMs || SCRIPT_TIMEOUT_MS);

      script.onload = () => {
        script.dataset.atlasLoaded = 'true';
        finish(resolve, script);
      };
      script.onerror = () => finish(reject, new Error(`Atlas asset could not load: ${normalized.src}`));
      if (!existing) document.head.appendChild(script);
    });

    loadedScripts.set(normalized.src, promise);
    return promise;
  }

  function coreState() {
    const appScreen = document.getElementById('app-screen');
    const appShell = document.getElementById('app-shell');
    const authScreen = document.getElementById('auth-screen');
    if (appScreen && appShell && !appScreen.hidden && !appShell.hidden) return 'ready';
    if (authScreen && !authScreen.hidden) return 'auth';
    return null;
  }

  async function waitForCoreState() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < CORE_TIMEOUT_MS) {
      const state = coreState();
      if (state) return state;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error('Atlas core did not become ready within 22 seconds.');
  }

  function redirectToLogin(message = '') {
    const url = new URL('login.html', window.location.href);
    const currentView = window.location.hash.replace(/^#/, '').split('/')[0];
    if (/^[a-z-]+$/i.test(currentView)) url.searchParams.set('view', currentView);
    if (message) url.searchParams.set('message', message);
    url.searchParams.set('from', 'app');
    window.location.replace(url.href);
  }

  function showFatal(error) {
    if (fatalShown) return;
    fatalShown = true;
    console.error('Atlas staged bootstrap failed', error);
    const message = error instanceof Error ? error.message : 'Atlas could not open.';
    const coreBoot = document.getElementById('atlas-boot');
    if (coreBoot) {
      coreBoot.hidden = false;
      coreBoot.innerHTML = `<div class="atlas-boot-card"><strong>Atlas could not open</strong><span>${escapeHtml(message)}</span><a class="atlas-button" href="app.html?retry=${Date.now().toString(36)}">Try again</a><a class="atlas-button secondary" href="login.html">Return to sign in</a></div>`;
      return;
    }
    setBootstrapStatus('Atlas could not open', message, true);
  }

  async function loadConnectedWorkspaces() {
    const warnings = [];
    const lucidePromise = loadScript(LUCIDE_SCRIPT, { timeoutMs: 8000 }).catch((error) => {
      warnings.push(error);
      return null;
    });

    for (const path of WORKSPACE_SCRIPTS) {
      try {
        await loadScript(path);
        // Let the shell paint and remain interactive between optional modules.
        await new Promise((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
      } catch (error) {
        warnings.push(error);
        console.warn('Atlas optional workspace warning', path, error);
      }
    }

    await lucidePromise;
    try { window.lucide?.createIcons?.(); } catch (error) { warnings.push(error); }
    try { window.AtlasNextMarkupCompat?.normalize?.(); } catch (error) { warnings.push(error); }

    // Replay role-permitted reads after late modules have registered listeners.
    // This is read-only and does not create or publish operational evidence.
    try { await window.AtlasNext?.refresh?.({ quiet: true }); } catch (error) { warnings.push(error); }
    const route = window.AtlasNextWorkspaces?.route?.();
    if (route) {
      try { window.AtlasNextWorkspaces.activate(route); } catch (error) { warnings.push(error); }
    }

    document.body.dataset.atlasModules = warnings.length ? 'partial' : 'ready';
    document.dispatchEvent(new CustomEvent('atlas:workspaces-ready', {
      detail: { warnings: warnings.map((error) => error?.message || String(error)) },
    }));
  }

  async function boot() {
    setBootstrapStatus('Opening Atlas…', 'Loading the application shell before optional workspaces.');
    try {
      const shellPromise = fetchShell();
      const supabasePromise = loadScript(SUPABASE_SCRIPT);
      const parsed = await shellPromise;
      installShell(parsed);
      setBootstrapStatus('Starting Atlas…', 'Verifying the existing authenticated session.');
      await supabasePromise;

      for (const path of CORE_SCRIPTS) await loadScript(path);
      const state = await waitForCoreState();
      if (state === 'auth') {
        const message = document.getElementById('auth-error')?.textContent?.trim() || 'Your Atlas session has expired. Sign in again.';
        redirectToLogin(message);
        return;
      }

      // The core shell is now visible. Optional workspace modules continue in
      // the background and can no longer hold the user behind a full-screen boot.
      document.body.dataset.atlasModules = 'loading';
      void loadConnectedWorkspaces();
    } catch (error) {
      showFatal(error);
    }
  }

  window.addEventListener('error', (event) => {
    if (!coreState()) showFatal(event.error || new Error(event.message || 'Atlas startup error.'));
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (!coreState()) showFatal(event.reason instanceof Error ? event.reason : new Error('Atlas startup error.'));
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else void boot();
})();
