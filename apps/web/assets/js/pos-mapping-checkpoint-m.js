(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 26000;
  const state = {
    workspace: null,
    loading: false,
    mutating: false,
    error: null,
    message: null,
    initialized: false,
    observer: null,
    retryTimer: null
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function endpoint() {
    const explicit = String(cfg.POS_MAPPING_API || '').trim();
    if (explicit) return explicit;
    const reports = String(cfg.REPORTS_API || '').trim();
    return reports.replace(/\/atlas-reports\/?$/, '/atlas-pos-mapping');
  }

  function root() {
    return document.getElementById('reports-view');
  }

  function reportShell() {
    return root()?.querySelector('.reports-shell:not(.reports-state)') || null;
  }

  function mountHost() {
    return reportShell();
  }

  function visible() {
    const element = mountHost();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action = 'snapshot', body = null) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Checkpoint M API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Checkpoint M.');
    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          'x-atlas-request-id': requestId,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.result?.error || payload?.error || `Checkpoint M request failed (${response.status}).`);
        error.status = response.status;
        error.code = payload?.result?.error_code || payload?.error_code || 'REQUEST_FAILED';
        throw error;
      }
      return payload?.result || payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Checkpoint M took too long to respond. Try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function statusTone(value) {
    if (value === 'healthy' || value === 'approved') return 'good';
    if (['degraded', 'expired', 'blocked', 'rejected'].includes(value)) return 'bad';
    return 'warn';
  }

  function formatDate(value) {
    if (!value) return 'Not verified';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not verified';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function formatIsk(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number).toLocaleString('en-GB')} ISK` : 'No price';
  }

  function summaryMarkup() {
    const summary = state.workspace?.summary || {};
    const cards = [
      ['list-music', 'Production targets', Number(summary.target_products || 0), 'Current recipe/menu catalogue'],
      ['scan-line', 'POS products', Number(summary.pos_products || 0), 'Staged external catalogue'],
      ['circle-help', 'Pending review', Number(summary.pending || 0), 'Manager decision required'],
      ['badge-check', 'Approved mappings', Number(summary.approved || 0), 'Still not sales ingestion']
    ];
    return `<div class="checkpoint-m-summary">${cards.map(([icon, label, value, note]) => `<article><i data-lucide="${icon}"></i><div><span>${escapeHtml(label)}</span><strong>${value.toLocaleString('en-GB')}</strong><small>${escapeHtml(note)}</small></div></article>`).join('')}</div>`;
  }

  function connectionMarkup() {
    const connection = state.workspace?.connection || {};
    const stateValue = connection.state || 'not_configured';
    const copy = stateValue === 'healthy'
      ? `Verified ${formatDate(connection.last_succeeded_at)}. External catalogue staging may begin through the approved server connector.`
      : stateValue === 'authorization_required'
      ? 'Dineout authorization is required before any external product catalogue can be read.'
      : 'Dineout is not connected. Atlas keeps sales, revenue and consumption intelligence unavailable.';
    return `<article class="checkpoint-m-connection is-${statusTone(stateValue)}"><div><span>Canonical provider</span><h3>${escapeHtml(connection.label || 'Dineout POS')}</h3><p>${escapeHtml(copy)}</p></div><strong>${escapeHtml(humanize(stateValue))}</strong></article>`;
  }

  function productMarkup(product) {
    const mapping = product.mapping || { status: 'pending' };
    const candidates = Array.isArray(product.candidates) ? product.candidates : [];
    const selected = mapping.target_id || candidates[0]?.target_id || '';
    return `<article class="checkpoint-m-product" data-pos-product="${escapeHtml(product.product_id)}">
      <header><div><small>${escapeHtml(product.category || 'POS product')} · ${escapeHtml(product.external_product_id)}</small><h4>${escapeHtml(product.name)}</h4></div><span class="is-${statusTone(mapping.status)}">${escapeHtml(humanize(mapping.status))}</span></header>
      <div class="checkpoint-m-product-body">
        <label><span>Mapping target</span><select data-pos-target><option value="">Choose a production product</option>${candidates.map((candidate) => `<option value="${escapeHtml(candidate.target_id)}" ${candidate.target_id === selected ? 'selected' : ''}>${escapeHtml(candidate.target_name)} · ${Math.round(Number(candidate.score || 0) * 100)}% · ${escapeHtml(formatIsk(candidate.menu_price))}</option>`).join('')}</select></label>
        <label><span>Decision note</span><input type="text" maxlength="2000" data-pos-note value="${escapeHtml(mapping.decision_note || '')}" placeholder="Why this match is correct or should be excluded"></label>
      </div>
      <footer><span>${candidates.length ? `${candidates.length} deterministic candidate${candidates.length === 1 ? '' : 's'} · never auto-approved` : 'No deterministic candidate meets the threshold'}</span><div><button type="button" data-pos-decision="ignore">Ignore</button><button type="button" data-pos-decision="reject">Reject</button><button type="button" class="is-primary" data-pos-decision="approve" ${selected ? '' : 'disabled'}>Approve mapping</button></div></footer>
    </article>`;
  }

  function productListMarkup() {
    const products = Array.isArray(state.workspace?.products) ? state.workspace.products : [];
    return `<section class="checkpoint-m-products"><header><div><span>Manager review queue</span><h3>POS product mappings</h3></div><strong>${products.length.toLocaleString('en-GB')} shown</strong></header><div>${products.length ? products.map(productMarkup).join('') : `<div class="checkpoint-m-empty"><i data-lucide="plug-zap"></i><h4>No POS products staged</h4><p>This is correct while Dineout is not connected. Refresh the production target catalogue now; external products remain blocked until authorization.</p></div>`}</div></section>`;
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="checkpoint-m-feedback is-error"><i data-lucide="triangle-alert"></i>${escapeHtml(state.error)}</div>`;
    if (state.message) return `<div class="checkpoint-m-feedback is-success"><i data-lucide="circle-check-big"></i>${escapeHtml(state.message)}</div>`;
    return '';
  }

  function workspaceMarkup() {
    return `<section class="checkpoint-m-shell" data-checkpoint-m-shell>
      <header class="checkpoint-m-hero"><div><span><i data-lucide="waypoints"></i>Phase 2.3 · Checkpoint M</span><h2>POS product mapping</h2><p>Deterministic candidates, manager approval and an explicit barrier before any sales intelligence.</p></div><div><button type="button" data-pos-refresh ${state.loading || state.mutating ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>Refresh</button><button type="button" class="is-primary" data-pos-refresh-targets ${state.mutating ? 'disabled' : ''}><i data-lucide="list-restart"></i>${state.mutating ? 'Refreshing…' : 'Refresh product targets'}</button></div></header>
      ${feedbackMarkup()}
      <div class="checkpoint-m-boundary"><i data-lucide="shield-ban"></i><div><strong>Sales intelligence remains off</strong><span>No sales facts, revenue, days-to-stockout, contribution margin, automatic ordering or Brain sales evidence are enabled by this checkpoint.</span></div></div>
      ${connectionMarkup()}
      ${summaryMarkup()}
      ${productListMarkup()}
    </section>`;
  }

  function loadingMarkup() {
    return `<section class="checkpoint-m-shell is-loading"><i data-lucide="loader-circle"></i><div><strong>Loading Checkpoint M</strong><small>Checking POS connection, product targets and mapping evidence.</small></div></section>`;
  }

  function render() {
    const shell = mountHost();
    if (!shell) return;
    let mount = shell.querySelector('[data-checkpoint-m-mount]');
    if (!mount) {
      mount = document.createElement('div');
      mount.dataset.checkpointMMount = 'true';
      const navigation = shell.querySelector('.reports-navigation');
      if (navigation) navigation.insertAdjacentElement('beforebegin', mount);
      else shell.prepend(mount);
    }
    mount.innerHTML = state.loading && !state.workspace ? loadingMarkup() : workspaceMarkup();
    window.lucide?.createIcons?.();
  }

  async function refresh(options = {}) {
    if (state.loading || !visible()) return;
    state.loading = true;
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot');
      state.workspace = payload.workspace || payload;
      state.error = null;
    } catch (error) {
      if (error?.status === 403) {
        state.workspace = null;
        state.error = 'Checkpoint M is manager-only.';
      } else {
        state.error = error instanceof Error ? error.message : 'Checkpoint M could not load.';
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshTargets() {
    if (state.mutating) return;
    state.mutating = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api('refresh-targets', {});
      state.workspace = payload.workspace || state.workspace;
      state.message = `${Number(payload.refresh?.targets_refreshed || 0).toLocaleString('en-GB')} production product targets refreshed. No sales data was ingested.`;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Production product targets could not be refreshed.';
    } finally {
      state.mutating = false;
      render();
    }
  }

  async function decide(productElement, decision) {
    if (state.mutating) return;
    const productId = productElement?.dataset?.posProduct;
    const targetId = productElement?.querySelector('[data-pos-target]')?.value || null;
    const note = productElement?.querySelector('[data-pos-note]')?.value || '';
    if (decision === 'approve' && !targetId) {
      state.error = 'Choose a production product before approving the mapping.';
      render();
      return;
    }
    state.mutating = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api('decide', {
        product_id: productId,
        target_id: targetId,
        decision,
        note
      });
      state.workspace = payload.workspace || state.workspace;
      state.message = `Mapping ${decision === 'approve' ? 'approved' : decision === 'ignore' ? 'ignored' : decision === 'reset' ? 'reset' : 'rejected'}. Sales ingestion remains disabled.`;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The mapping decision could not be saved.';
    } finally {
      state.mutating = false;
      render();
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-pos-refresh]')) {
      refresh();
      return;
    }
    if (target.closest('[data-pos-refresh-targets]')) {
      refreshTargets();
      return;
    }
    const decisionButton = target.closest('[data-pos-decision]');
    if (decisionButton) {
      decide(decisionButton.closest('[data-pos-product]'), decisionButton.dataset.posDecision);
    }
  }

  function mountWhenReady() {
    if (!mountHost()) return false;
    render();
    if (!state.workspace && !state.loading) refresh({ silent: true });
    return true;
  }

  function init() {
    if (state.initialized) return true;
    const reports = root();
    if (!reports) return false;
    state.initialized = true;
    reports.addEventListener('click', handleClick);
    state.observer = new MutationObserver(() => mountWhenReady());
    state.observer.observe(reports, { childList: true, subtree: true });
    mountWhenReady();
    window.addEventListener('pagehide', () => {
      reports.removeEventListener('click', handleClick);
      state.observer?.disconnect();
      if (state.retryTimer) window.clearInterval(state.retryTimer);
    }, { once: true });
    return true;
  }

  window.AtlasCheckpointM = { refresh, snapshot: () => state.workspace };
  if (!init()) {
    state.retryTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 150);
    window.setTimeout(() => {
      if (!state.retryTimer) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 12000);
  }
})();
