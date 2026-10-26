// Data — Home contributor shard (eager, small).
//
// The Data workspace UI (data-workspace.js, ~108 KB) is heavy and loads lazily
// on the first navigation to #data. But three things must work from the moment
// the app boots, before that UI exists:
//   1. the Home attention row "N catalogue changes are waiting for your approval";
//   2. the sidebar "Data" nav badge count;
//   3. the Home/Inventory command-palette actions that jump into Data.
// All three need only the lightweight review summary (one RPC) plus the manager
// role check — not the workspace. This shard owns that summary and is the single
// source of truth for it: the lazy workspace reads the same summary back through
// window.AtlasDataHome rather than fetching its own, so there is no duplicate
// request and no divergent copy of the counts.
(function (root) {
  'use strict';

  if (root.AtlasDataHome) return;

  const MANAGERS = ['admin', 'manager'];

  // ---------- small glue (matches data-workspace.js) ----------
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function profile() { return root.AtlasShell?.profile?.() || root.atlasCurrentProfile || null; }
  function isManager() {
    const current = profile();
    return Boolean(current && current.active !== false && MANAGERS.includes(current.role));
  }
  function client() { return root.atlasSupabase || null; }
  async function rpc(name, args) {
    const supabase = client();
    if (!supabase?.rpc) throw Object.assign(new Error('offline'), { status: 0 });
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw Object.assign(new Error('rpc failed'), { status: error.status || 400, code: error.code || null });
    return data;
  }

  // ---------- summary state (single source of truth) ----------
  const state = { summary: null, summaryError: null, summaryLoading: false, summaryAt: 0, registered: false };
  const listeners = new Set();

  function notify() { listeners.forEach((fn) => { try { fn(); } catch (error) { console.error(error); } }); }

  function issueCount(code) {
    const issue = (state.summary?.issues || []).find((entry) => entry.code === code);
    return issue ? Number(issue.count) || 0 : null;
  }
  function recordIssueTotal() {
    if (!state.summary?.issues) return null;
    return state.summary.issues.filter((entry) => entry.code !== 'catalog.pending_approval').reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
  }
  function pendingApprovals() {
    return issueCount('catalog.pending_approval');
  }

  async function loadSummary({ force = false } = {}) {
    if (!isManager() || state.summaryLoading) return;
    if (!force && state.summary && Date.now() - state.summaryAt < 30000) return;
    state.summaryLoading = true;
    try {
      state.summary = await rpc('atlas_data_review_summary', {});
      state.summaryError = null;
      state.summaryAt = Date.now();
    } catch (error) {
      state.summaryError = error;
    } finally {
      state.summaryLoading = false;
      syncBadge();
      contributeChanged();
      notify();
    }
  }

  // ---------- nav badge + Home attention ----------
  function syncBadge() {
    const count = isManager() ? pendingApprovals() : null;
    root.document?.querySelectorAll('[data-nav-badge="data"]').forEach((badge) => {
      badge.hidden = !count;
      badge.textContent = count ? String(count) : '';
    });
    const link = root.document?.querySelector('.atlas-sidebar .nav-item[data-nav-id="data"]');
    if (link) link.setAttribute('aria-label', count ? `Data, ${plural(count, 'change', 'changes')} waiting for approval` : 'Data');
  }

  function contributeChanged() {
    root.AtlasShell?.emit?.('notify:changed', { source: 'home:data' });
    if (root.AtlasShell?.current?.() === 'dashboard') root.AtlasShell?.renderHome?.('data');
  }

  function focusRows() {
    if (!isManager()) return [];
    const count = pendingApprovals();
    if (!count) return [];
    return [{
      id: 'catalog-approvals',
      severity: 'info',
      icon: 'badge-check',
      roles: MANAGERS,
      title: `${plural(count, 'catalogue change', 'catalogue changes')} ${count === 1 ? 'is' : 'are'} waiting for your approval`,
      detail: 'New names, barcodes, items and duplicates from scans, imports and Alcedo AI',
      action: { label: 'Review', route: '#data/approvals' }
    }];
  }

  // ---------- registration ----------
  function register() {
    const atlas = root.AtlasShell;
    if (!atlas || state.registered) return;
    state.registered = true;

    // Retired view ids (Real VÁ Data) open the matching Data tab. This is a
    // guard-only redirect with no UI, so it stays eager — a deep link to the
    // retired id must resolve without first loading the workspace.
    atlas.registerView?.('sprint3-review', { root: null, guard: () => { atlas.navigate('#data/import-review'); return false; } });

    atlas.home?.contribute?.('data', { order: 60, focusRows });

    // Nav-only actions reachable from outside the Data workspace (Home, Inventory,
    // the command palette). Each navigates to a #data route; the lazy workspace
    // then loads and renders. The workspace-only action (data.import, which opens
    // the uploader) stays in data-workspace.js because its context is ['data'] —
    // it can only be invoked once Data is already open.
    atlas.actions?.register?.({ id: 'data.pars', label: 'Set par levels', icon: 'gauge', keywords: ['par', 'par levels', 'reorder'], roles: MANAGERS, contexts: ['data', 'inventory'], run: () => atlas.navigate('#data/pars') });
    atlas.actions?.register?.({ id: 'data.approvals', label: 'Review catalogue changes', icon: 'badge-check', keywords: ['approve', 'alias', 'barcode', 'duplicate', 'catalogue'], roles: MANAGERS, contexts: ['data', 'home'], run: () => atlas.navigate('#data/approvals') });

    atlas.on?.('profile:ready', () => { loadSummary({ force: true }); });
    atlas.onDataLoaded?.(() => loadSummary());
    if (profile()) loadSummary({ force: true });
  }

  root.AtlasDataHome = {
    summary: () => state.summary,
    summaryError: () => state.summaryError,
    issueCount,
    recordIssueTotal,
    pendingApprovals,
    focusRows,
    loadSummary,
    refresh: () => loadSummary({ force: true }),
    syncBadge,
    // The lazy workspace subscribes so it re-renders when the summary changes
    // (a background refresh, or a refresh it triggered after a mutation).
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };

  // data-home.js loads after atlas-shell.js and atlas-app.js (window.AtlasShell /
  // window.AtlasData), so the shell is present by the time this runs. Mirror the
  // original data-workspace bootstrap: register now, or on DOMContentLoaded.
  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', register, { once: true });
  else register();
})(typeof window === 'undefined' ? globalThis : window);
