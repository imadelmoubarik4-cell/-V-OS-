(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const state = {
    syncing: false,
    synced: false,
    error: null,
    intelligence: null,
    observer: null,
    frame: null,
    timer: null,
    lastSyncAt: 0
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function percent(value) {
    return `${Math.round(Math.max(0, Math.min(1, number(value))) * 100)}%`;
  }

  function formatMetric(value) {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number') return Math.round(value * 100) / 100;
    return String(value);
  }

  function endpoint() {
    return String(cfg.PHASE3_INTELLIGENCE_API || '').trim();
  }

  function brainVisible() {
    const shell = document.getElementById('brain-shell');
    const phase = shell?.querySelector('[data-phase3-brain]');
    return Boolean(shell && phase) && getComputedStyle(shell).display !== 'none';
  }

  async function session() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function requestRefresh() {
    const api = endpoint();
    if (!api) throw new Error('Checkpoint K intelligence API is not configured.');
    const activeSession = await session();
    if (!activeSession?.access_token) throw new Error('Sign in to Atlas to refresh intelligence.');
    const url = new URL(api);
    url.searchParams.set('action', 'refresh');
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${activeSession.access_token}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: '{}'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Checkpoint K refresh failed (${response.status}).`);
    return payload;
  }

  function domainIcon(key) {
    return ({ shortage: 'package-search', purchase: 'shopping-cart', menu: 'utensils', waste: 'recycle' })[key] || 'sparkles';
  }

  function statusTone(status) {
    if (['shadow_par_watch', 'shadow_drafts', 'setup_intelligence', 'operational_readiness', 'explicit_event_patterns'].includes(status)) return 'active';
    if (['recording_readiness', 'historical_review_only', 'evidence_gated'].includes(status)) return 'gated';
    if (status === 'no_records') return 'empty';
    return 'review';
  }

  function metricEntries(domain) {
    return Object.entries(domain.metrics || {}).slice(0, 6);
  }

  function domainMarkup(domain) {
    const confidence = domain.confidence || {};
    const blockers = Array.isArray(domain.blockers) ? domain.blockers : [];
    const limitations = Array.isArray(domain.limitations) ? domain.limitations : [];
    return `<article class="checkpoint-k-domain is-${escapeHtml(statusTone(domain.status))}">
      <header>
        <span class="checkpoint-k-icon"><i data-lucide="${escapeHtml(domainIcon(domain.key))}"></i></span>
        <div><small>${escapeHtml(humanize(domain.status))}</small><h4>${escapeHtml(domain.label)}</h4></div>
        <span class="checkpoint-k-confidence is-${escapeHtml(confidence.state || 'pending')}">${escapeHtml(humanize(confidence.state || 'pending'))} · ${percent(confidence.score)}</span>
      </header>
      <p>${escapeHtml(domain.enabled_scope || 'Evidence-gated shadow intelligence')}</p>
      <dl>${metricEntries(domain).map(([key, value]) => `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(formatMetric(value))}</dd></div>`).join('')}</dl>
      ${(blockers.length || limitations.length) ? `<details><summary>${blockers.length} blocker${blockers.length === 1 ? '' : 's'} · ${limitations.length} limitation${limitations.length === 1 ? '' : 's'}</summary>
        ${blockers.length ? `<strong>Evidence blockers</strong><ul>${blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
        ${limitations.length ? `<strong>Safety limits</strong><ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      </details>` : ''}
      <footer><i data-lucide="eye"></i><span>${domain.full_capability_enabled ? 'Full capability enabled' : 'Shadow scope only · manager review required'}</span></footer>
    </article>`;
  }

  function panelMarkup(intelligence) {
    const domains = Array.isArray(intelligence?.domains) ? intelligence.domains : [];
    return `<section class="phase3-panel checkpoint-k-panel" data-checkpoint-k-panel>
      <header class="phase3-panel-head checkpoint-k-head">
        <div><span><i data-lucide="sparkles"></i>Checkpoint K</span><h3>Operational intelligence readiness</h3><p>Atlas now evaluates shortage, purchasing, menu and waste evidence separately. It unlocks safe shadow scopes without pretending missing data is complete.</p></div>
        <aside><strong>${domains.length}/4</strong><small>domains assessed</small></aside>
      </header>
      ${state.error ? `<div class="checkpoint-k-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>` : ''}
      <div class="checkpoint-k-grid">${domains.length ? domains.map(domainMarkup).join('') : '<p class="phase3-empty">Checkpoint K has not completed its first source assessment yet.</p>'}</div>
      <div class="checkpoint-k-contract"><i data-lucide="shield-check"></i><span>Historical July stock is excluded from predictions · Negative adjustments are not waste · No automatic orders, menu changes or staff attribution</span></div>
    </section>`;
  }

  function currentIntelligence() {
    return window.AtlasPhase3Brain?.snapshot?.()?.intelligence || state.intelligence;
  }

  function render() {
    const main = document.querySelector('#brain-shell .phase3-main-stack');
    if (!main) return;
    const intelligence = currentIntelligence();
    if (!intelligence && !state.error) return;
    const signature = JSON.stringify({
      generated_at: intelligence?.generated_at || null,
      domains: intelligence?.domains || [],
      error: state.error
    });
    let panel = main.querySelector('[data-checkpoint-k-panel]');
    if (panel?.dataset.signature === signature) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = panelMarkup(intelligence || { domains: [] });
    const next = wrapper.firstElementChild;
    next.dataset.signature = signature;
    if (panel) panel.replaceWith(next);
    else main.prepend(next);

    const kicker = document.querySelector('#brain-shell .phase3-kicker');
    if (kicker && !kicker.textContent.includes('Checkpoint K')) {
      kicker.innerHTML = '<i data-lucide="brain-circuit"></i>Phase 3 · Decision Memory + Checkpoint K';
    }
    window.lucide?.createIcons?.();
  }

  function scheduleRender() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      render();
      if (brainVisible() && !state.synced && !state.syncing) sync(false);
    });
  }

  async function sync(force) {
    if (state.syncing) return;
    if (!force && state.synced) return;
    if (!force && Date.now() - state.lastSyncAt < 15000) return;
    state.syncing = true;
    state.error = null;
    state.lastSyncAt = Date.now();
    scheduleRender();
    try {
      const payload = await requestRefresh();
      state.intelligence = payload.intelligence || payload.snapshot?.intelligence || null;
      state.synced = true;
      await window.AtlasPhase3Brain?.refresh?.();
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Checkpoint K could not refresh.';
    } finally {
      state.syncing = false;
      scheduleRender();
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const refresh = target?.closest?.('#brain-shell [data-phase3-refresh]');
    if (!refresh) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    sync(true);
  }

  function init() {
    document.addEventListener('click', handleClick, true);
    state.observer = new MutationObserver(scheduleRender);
    state.observer.observe(document.getElementById('brain-shell') || document.body, { childList: true, subtree: true, attributes: true });
    state.timer = window.setInterval(() => {
      scheduleRender();
      if (brainVisible() && !state.synced && !state.syncing) sync(false);
    }, 1200);
    window.addEventListener('pagehide', () => {
      document.removeEventListener('click', handleClick, true);
      state.observer?.disconnect();
      if (state.timer) window.clearInterval(state.timer);
    }, { once: true });
    scheduleRender();
  }

  window.AtlasCheckpointK = {
    refresh: () => sync(true),
    intelligence: currentIntelligence
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
