(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const state = {
    briefing: null,
    manager: null,
    loading: false,
    error: null,
    observer: null,
    authSubscription: null,
    refreshTimer: null,
    renderQueued: false
  };

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatNumber(value) {
    const rounded = Math.round(number(value));
    const sign = rounded < 0 ? '-' : '';
    return `${sign}${String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  }

  function formatPercent(value) {
    const rounded = Math.round(number(value) * 10) / 10;
    return `${String(rounded).replace('.', ',')}%`;
  }

  function formatDateTime(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (part) => String(part).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function confidence(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      state: String(raw.state || 'pending').toLowerCase(),
      score: Math.max(0, Math.min(1, number(raw.score, 0))),
      reason: String(raw.reason || 'Confidence has not been established.')
    };
  }

  function sourceLabel(source) {
    if (!source || typeof source !== 'object') return 'Source not recorded';
    const objectName = source.object || (Array.isArray(source.objects) ? source.objects.join(' + ') : null);
    return [source.schema, objectName].filter(Boolean).join('.') || humanize(source.kind || 'source');
  }

  function evidenceEntries(evidence) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
    return Object.entries(evidence).filter(([, value]) => value !== null && value !== undefined);
  }

  function valueMarkup(value) {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return formatNumber(value);
    if (Array.isArray(value)) return escape(value.map(humanize).join(', '));
    if (typeof value === 'object' && value) return escape(JSON.stringify(value));
    return escape(value);
  }

  function confidenceMarkup(raw) {
    const item = confidence(raw);
    return `<span class="daily-confidence is-${escape(item.state)}" title="${escape(item.reason)}"><i data-lucide="shield-check"></i>${escape(humanize(item.state))} · ${Math.round(item.score * 100)}%</span>`;
  }

  function evidenceMarkup(evidence) {
    const entries = evidenceEntries(evidence);
    if (!entries.length) return '<p class="daily-evidence-empty">No supporting values were returned.</p>';
    return `<dl class="daily-evidence-values">${entries.map(([key, value]) => `<div><dt>${escape(humanize(key))}</dt><dd>${valueMarkup(value)}</dd></div>`).join('')}</dl>`;
  }

  function navigate(target) {
    if (target === 'sprint3-review' && window.AtlasSprint3Review?.open) {
      window.AtlasSprint3Review.open();
      return;
    }
    const safeTarget = String(target || '').replace(/[^a-z0-9_-]/gi, '');
    const button = document.querySelector(`[data-view="${safeTarget}"]`);
    if (button instanceof HTMLElement) button.click();
  }

  function signalMarkup(signal) {
    const severity = String(signal.severity || 'info').toLowerCase();
    const action = signal.action || {};
    return `<article class="daily-signal-card is-${escape(severity)}">
      <header><span class="daily-severity">${escape(humanize(severity))}</span>${confidenceMarkup(signal.confidence)}</header>
      <h3>${escape(signal.title || 'Atlas signal')}</h3>
      <p>${escape(signal.detail || '')}</p>
      <div class="daily-source-line"><i data-lucide="database-zap"></i><span>${escape(sourceLabel(signal.source))}</span></div>
      ${evidenceMarkup(signal.evidence)}
      ${action.target ? `<button type="button" class="daily-card-action" data-daily-target="${escape(action.target)}">${escape(action.label || 'Open')}</button>` : ''}
    </article>`;
  }

  function sourceMarkup(source) {
    const details = {
      records: source.records,
      distinct_source_files: source.distinct_source_files,
      hashed_records: source.hashed_records,
      effective_from: source.effective_from,
      effective_to: source.effective_to,
      is_live_quantity: source.is_live_quantity
    };
    return `<article class="daily-source-card">
      <div class="daily-source-icon"><i data-lucide="file-check-2"></i></div>
      <div><h3>${escape(source.label || humanize(source.key))}</h3><p>${escape(sourceLabel(source))}</p>${confidenceMarkup(source.confidence)}</div>
      ${evidenceMarkup(details)}
    </article>`;
  }

  function coverageMarkup(entry) {
    const total = Math.max(0, number(entry.total));
    const reviewed = Math.max(0, number(entry.reviewed));
    const readiness = total ? Math.max(0, Math.min(100, number(entry.readiness_percent))) : 0;
    return `<div class="daily-coverage-row">
      <div class="daily-coverage-copy"><strong>${escape(humanize(entry.scope))}</strong><span>${formatNumber(reviewed)} reviewed · ${formatNumber(entry.pending)} pending</span></div>
      <div class="daily-coverage-meter" aria-label="${escape(humanize(entry.scope))} ${readiness}% reviewed"><span style="width:${readiness}%"></span></div>
      <b>${formatPercent(readiness)}</b>${confidenceMarkup(entry.confidence)}
    </div>`;
  }

  function loadingMarkup() {
    return `<section class="daily-briefing-shell is-loading" data-daily-briefing><div class="daily-state-icon"><i data-lucide="loader-circle"></i></div><div><h2>Preparing the Daily Atlas Briefing</h2><p>Atlas is reading the private source graph and its review state.</p></div></section>`;
  }

  function errorMarkup(message) {
    return `<section class="daily-briefing-shell is-error" data-daily-briefing><div class="daily-state-icon"><i data-lucide="shield-alert"></i></div><div class="daily-error-copy"><h2>Daily Briefing unavailable</h2><p>${escape(message)}</p></div><button type="button" class="daily-refresh-button" data-daily-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function briefingMarkup(briefing) {
    const summary = briefing.summary || {};
    const signals = Array.isArray(briefing.signals) ? briefing.signals.slice(0, 8) : [];
    const sources = Array.isArray(briefing.sources) ? briefing.sources : [];
    const coverage = Array.isArray(briefing.coverage) ? briefing.coverage : [];
    const limitations = Array.isArray(briefing.limitations) ? briefing.limitations : [];
    const trust = briefing.trust || {};

    return `<section class="daily-briefing-shell" data-daily-briefing>
      <header class="daily-briefing-head">
        <div><span class="daily-kicker"><i data-lucide="sunrise"></i>Daily Atlas Briefing · Phase 1</span><h2>${escape(briefing.headline || 'Atlas briefing')}</h2><p>Deterministic management intelligence with visible confidence, source attribution and supporting evidence.</p></div>
        <div class="daily-head-actions"><span class="daily-generated">Generated ${escape(formatDateTime(briefing.generated_at))}</span><button type="button" class="daily-refresh-button" data-daily-refresh><i data-lucide="refresh-cw"></i>Refresh</button></div>
      </header>
      <div class="daily-summary-grid">
        <article><span>Data maturity</span><strong>${formatPercent(summary.maturity_percent)}</strong><small>${formatNumber(summary.reviewed_rows)} reviewed</small></article>
        <article><span>Pending review</span><strong>${formatNumber(summary.pending_rows)}</strong><small>of ${formatNumber(summary.staged_rows)} staged rows</small></article>
        <article><span>Source files</span><strong>${formatNumber(summary.source_files)}</strong><small>${formatNumber(summary.hashed_batches)} hashed batches</small></article>
        <article><span>Open issues</span><strong>${formatNumber(summary.open_issue_rows)}</strong><small>${summary.promotion_ready ? 'Promotion gate clear' : 'Promotion remains blocked'}</small></article>
      </div>
      <div class="daily-layout">
        <div class="daily-main-stack">
          <section class="daily-panel"><header class="daily-panel-head"><div><h3>Evidence-backed priorities</h3><p>Ordered by operational severity and evidence quality.</p></div></header><div class="daily-signal-grid">${signals.length ? signals.map(signalMarkup).join('') : '<p class="daily-empty">No private-data priority was returned.</p>'}</div></section>
          <section class="daily-panel"><header class="daily-panel-head"><div><h3>Domain readiness</h3><p>Reviewed and pending coverage across the Real VÁ Data graph.</p></div></header><div class="daily-coverage-list">${coverage.map(coverageMarkup).join('')}</div></section>
        </div>
        <aside class="daily-side-stack">
          <section class="daily-panel"><header class="daily-panel-head"><div><h3>Source attribution</h3><p>Every briefing claim resolves to a named private database source.</p></div></header><div class="daily-source-list">${sources.map(sourceMarkup).join('')}</div></section>
          <section class="daily-panel daily-limitations"><header class="daily-panel-head"><div><h3>What Atlas will not assume</h3><p>Guardrails active in this briefing.</p></div></header><ul>${limitations.map((item) => `<li><i data-lucide="circle-slash-2"></i><span>${escape(item)}</span></li>`).join('')}</ul></section>
          <section class="daily-trust-strip"><i data-lucide="badge-check"></i><div><strong>Trust contract active</strong><span>AI generation: ${trust.ai_generation_used ? 'on' : 'off'} · Automatic mutation: ${trust.automatic_mutation ? 'on' : 'off'} · Historical stock used for reorder: ${trust.historical_stock_used_for_reorder ? 'yes' : 'no'}</span></div></section>
        </aside>
      </div>
    </section>`;
  }

  function host() {
    return document.getElementById('brain-shell');
  }

  function observerOptions() {
    return { childList: true };
  }

  function bindRenderedEvents(root) {
    root.querySelectorAll('[data-daily-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.dailyTarget)));
    root.querySelectorAll('[data-daily-refresh]').forEach((button) => button.addEventListener('click', () => refresh(true)));
  }

  function render() {
    const shell = host();
    if (!shell) return;

    state.observer?.disconnect();
    const existing = shell.querySelector('[data-daily-briefing]');
    const markup = state.loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : state.briefing ? briefingMarkup(state.briefing) : loadingMarkup();
    const template = document.createElement('template');
    template.innerHTML = markup.trim();
    const next = template.content.firstElementChild;
    if (!next) return;

    if (existing) existing.replaceWith(next);
    else {
      const hero = shell.querySelector('.brain-hero');
      if (hero) hero.insertAdjacentElement('afterend', next);
      else shell.prepend(next);
    }

    bindRenderedEvents(next);
    if (window.lucide) window.lucide.createIcons();
    state.observer?.observe(shell, observerOptions());
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      render();
    });
  }

  async function session() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function refresh(force = false) {
    if (state.loading && !force) return;
    const api = String(cfg.SPRINT4_BRIEFING_API || '').trim();
    if (!api) {
      state.error = 'Sprint 4 briefing API is not configured for this build.';
      state.loading = false;
      queueRender();
      return;
    }

    state.loading = true;
    state.error = null;
    queueRender();

    try {
      const activeSession = await session();
      if (!activeSession?.access_token) throw new Error('Sign in to Atlas to load the Daily Briefing.');
      const response = await fetch(api, {
        method: 'GET',
        cache: 'no-store',
        headers: { authorization: `Bearer ${activeSession.access_token}`, accept: 'application/json' }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Daily Briefing request failed (${response.status}).`);
      if (!payload.briefing || typeof payload.briefing !== 'object') throw new Error('Daily Briefing returned an invalid response.');
      state.briefing = payload.briefing;
      state.manager = payload.manager || null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Daily Briefing could not be loaded.';
    } finally {
      state.loading = false;
      queueRender();
    }
  }

  function installObserver() {
    const shell = host();
    if (!shell || state.observer) return;
    state.observer = new MutationObserver(() => {
      if (!shell.querySelector('[data-daily-briefing]')) queueRender();
    });
    state.observer.observe(shell, observerOptions());
  }

  function bindAuthWhenReady() {
    let attempts = 0;
    const bind = () => {
      attempts += 1;
      if (window.atlasSupabase?.auth) {
        if (!state.authSubscription) {
          const subscription = window.atlasSupabase.auth.onAuthStateChange((_event, nextSession) => {
            if (nextSession) refresh(true);
            else {
              state.briefing = null;
              state.error = 'Sign in to Atlas to load the Daily Briefing.';
              queueRender();
            }
          });
          state.authSubscription = subscription.data.subscription;
        }
        return true;
      }
      return attempts >= 60;
    };
    if (bind()) return;
    const timer = setInterval(() => { if (bind()) clearInterval(timer); }, 500);
  }

  function start() {
    let attempts = 0;
    const attach = () => {
      attempts += 1;
      if (!host()) return attempts >= 60;
      installObserver();
      queueRender();
      refresh();
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.refreshTimer = setInterval(() => refresh(), AUTO_REFRESH_MS);
      bindAuthWhenReady();
      return true;
    };
    if (attach()) return;
    const timer = setInterval(() => { if (attach()) clearInterval(timer); }, 500);
  }

  window.AtlasDailyBriefing = { refresh, render, getState: () => ({ ...state }) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
