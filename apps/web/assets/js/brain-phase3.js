(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const state = {
    snapshot: null,
    manager: null,
    detail: null,
    loading: false,
    error: null,
    submitting: false,
    observer: null,
    authSubscription: null,
    renderQueued: false,
    modalMode: null,
    selectedRecommendationId: null
  };

  function escapeHtml(value) {
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
    return `${Math.round(number(value) * 100)}%`;
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

  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `phase3-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function host() {
    return document.getElementById('brain-shell');
  }

  function phase3Api() {
    return String(cfg.PHASE3_BRAIN_API || '').trim();
  }

  async function session() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, options = {}) {
    const endpoint = phase3Api();
    if (!endpoint) throw new Error('Phase 3 Brain API is not configured for this preview.');
    const activeSession = await session();
    if (!activeSession?.access_token) throw new Error('Sign in to Atlas to load Phase 3.');

    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });

    const response = await fetch(url, {
      method: options.method || 'GET',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${activeSession.access_token}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Phase 3 request failed (${response.status}).`);
    return payload;
  }

  function confidenceMarkup(raw) {
    const stateName = String(raw?.state || 'pending').toLowerCase();
    const score = Math.max(0, Math.min(1, number(raw?.score, 0)));
    return `<span class="phase3-confidence is-${escapeHtml(stateName)}"><i data-lucide="shield-check"></i>${escapeHtml(humanize(stateName))} · ${formatPercent(score)}</span>`;
  }

  function capabilityMarkup(capability) {
    const blockers = Array.isArray(capability.blockers) ? capability.blockers : [];
    return `<article class="phase3-capability ${capability.enabled ? 'is-enabled' : 'is-blocked'}">
      <div class="phase3-capability-icon"><i data-lucide="${capability.enabled ? 'badge-check' : 'lock-keyhole'}"></i></div>
      <div class="phase3-capability-copy">
        <div class="phase3-capability-head"><h4>${escapeHtml(capability.label)}</h4>${confidenceMarkup(capability.confidence)}</div>
        <p>${capability.enabled ? 'Available in the current shadow Brain.' : escapeHtml(blockers[0] || 'Required evidence is not connected.')}</p>
        ${blockers.length > 1 ? `<details><summary>${blockers.length} evidence blockers</summary><ul>${blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
      </div>
    </article>`;
  }

  function recommendationMarkup(recommendation) {
    const type = String(recommendation.recommendation_type || 'operations');
    const status = String(recommendation.status || 'active');
    const evidenceCount = Array.isArray(recommendation.evidence) ? recommendation.evidence.length : 0;
    const previousCount = Array.isArray(recommendation.previous_decisions) ? recommendation.previous_decisions.length : 0;
    return `<article class="phase3-recommendation" data-phase3-recommendation="${escapeHtml(recommendation.id)}">
      <header>
        <div><span class="phase3-type">${escapeHtml(humanize(type))}</span><span class="phase3-status is-${escapeHtml(status)}">${escapeHtml(humanize(status))}</span></div>
        ${confidenceMarkup({ state: recommendation.confidence_state, score: recommendation.confidence_score })}
      </header>
      <h3>${escapeHtml(recommendation.title)}</h3>
      <p>${escapeHtml(recommendation.summary)}</p>
      <div class="phase3-recommendation-meta">
        <span><i data-lucide="database"></i>${evidenceCount} evidence ${evidenceCount === 1 ? 'source' : 'sources'}</span>
        <span><i data-lucide="history"></i>${previousCount} previous ${previousCount === 1 ? 'decision' : 'decisions'}</span>
        <span><i data-lucide="eye"></i>Shadow mode</span>
      </div>
      <footer>
        <button type="button" class="phase3-secondary-action" data-phase3-why="${escapeHtml(recommendation.id)}"><i data-lucide="circle-help"></i>Why?</button>
        <button type="button" class="phase3-primary-action" data-phase3-decide="${escapeHtml(recommendation.id)}"><i data-lucide="gavel"></i>Decide</button>
      </footer>
    </article>`;
  }

  function memoryMarkup(memory) {
    const recommendationId = memory.context?.recommendation_id;
    return `<article class="phase3-memory-row">
      <div class="phase3-memory-marker"><i data-lucide="history"></i></div>
      <div>
        <div class="phase3-memory-head"><strong>${escapeHtml(memory.title)}</strong><time>${escapeHtml(formatDateTime(memory.occurred_at))}</time></div>
        <p>${escapeHtml(memory.summary)}</p>
        <span>${escapeHtml(memory.actor_label || 'Atlas manager')} · ${escapeHtml(humanize(memory.action))}</span>
      </div>
      ${recommendationId ? `<button type="button" data-phase3-memory-open="${escapeHtml(recommendationId)}" aria-label="Open recommendation memory"><i data-lucide="arrow-up-right"></i></button>` : ''}
    </article>`;
  }

  function loadingMarkup() {
    return `<section class="phase3-shell is-loading" data-phase3-brain>
      <div class="phase3-state-icon"><i data-lucide="loader-circle"></i></div>
      <div><h2>Building Atlas Decision Memory</h2><p>Reading recommendations, manager decisions, evidence gates and outcomes.</p></div>
    </section>`;
  }

  function errorMarkup(message) {
    return `<section class="phase3-shell is-error" data-phase3-brain>
      <div class="phase3-state-icon"><i data-lucide="brain-circuit"></i></div>
      <div><h2>Phase 3 unavailable</h2><p>${escapeHtml(message)}</p></div>
      <button type="button" class="phase3-primary-action" data-phase3-refresh><i data-lucide="refresh-cw"></i>Try again</button>
    </section>`;
  }

  function snapshotMarkup(snapshot) {
    const stats = snapshot.stats || {};
    const recommendations = Array.isArray(snapshot.recommendations) ? snapshot.recommendations : [];
    const capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
    const memory = Array.isArray(snapshot.memory) ? snapshot.memory.slice(0, 12) : [];
    const enabledCount = capabilities.filter((item) => item.enabled).length;

    return `<section class="phase3-shell" data-phase3-brain>
      <header class="phase3-hero">
        <div>
          <span class="phase3-kicker"><i data-lucide="brain-circuit"></i>Phase 3 · Atlas Decision Memory</span>
          <h2>Atlas remembers what VÁ decides.</h2>
          <p>Every recommendation keeps its evidence, manager response and eventual outcome. Operational predictions remain locked until their required live evidence is verified.</p>
        </div>
        <div class="phase3-hero-actions">
          <span class="phase3-shadow-badge"><i data-lucide="eye"></i>Shadow mode</span>
          <button type="button" class="phase3-secondary-action" data-phase3-refresh><i data-lucide="refresh-cw"></i>Refresh Brain</button>
        </div>
      </header>

      <div class="phase3-summary-grid">
        <article><span>Active recommendations</span><strong>${formatNumber(stats.active_recommendations)}</strong><small>Evidence-backed and reviewable</small></article>
        <article><span>Memory events</span><strong>${formatNumber(stats.memory_events)}</strong><small>Significant decisions remembered</small></article>
        <article><span>Manager decisions</span><strong>${formatNumber(stats.manager_decisions)}</strong><small>Recommendation responses</small></article>
        <article><span>Recorded outcomes</span><strong>${formatNumber(stats.recorded_outcomes)}</strong><small>Learning feedback</small></article>
        <article><span>Capabilities enabled</span><strong>${enabledCount}/${capabilities.length}</strong><small>Others remain evidence-gated</small></article>
      </div>

      <div class="phase3-layout">
        <div class="phase3-main-stack">
          <section class="phase3-panel">
            <header class="phase3-panel-head"><div><h3>Shadow recommendations</h3><p>Atlas can explain and remember these recommendations, but cannot change live operations.</p></div></header>
            <div class="phase3-recommendation-grid">${recommendations.length ? recommendations.map(recommendationMarkup).join('') : '<p class="phase3-empty">No active recommendations. Refresh the shadow engine to rebuild the evidence queue.</p>'}</div>
          </section>
        </div>

        <aside class="phase3-side-stack">
          <section class="phase3-panel">
            <header class="phase3-panel-head"><div><h3>Capability gates</h3><p>Atlas only unlocks operational intelligence when every required evidence stream is verified.</p></div></header>
            <div class="phase3-capability-list">${capabilities.map(capabilityMarkup).join('')}</div>
          </section>

          <section class="phase3-panel">
            <header class="phase3-panel-head"><div><h3>Decision memory</h3><p>Meaningful VÁ decisions, without duplicate no-op clicks.</p></div></header>
            <div class="phase3-memory-list">${memory.length ? memory.map(memoryMarkup).join('') : '<p class="phase3-empty">No significant decision memory has been recorded yet.</p>'}</div>
          </section>

          <section class="phase3-trust-strip">
            <i data-lucide="shield-check"></i>
            <div><strong>Phase 3 safety contract</strong><span>AI generation off · Automatic ordering off · Automatic menu changes off · Historical stock excluded from predictions · Manager review required</span></div>
          </section>
        </aside>
      </div>
    </section>`;
  }

  function evidenceMarkup(item) {
    const source = item.source || {};
    const values = item.value && typeof item.value === 'object' ? Object.entries(item.value) : [];
    return `<article class="phase3-evidence-card">
      <header><strong>${escapeHtml(item.label || item.evidence_key)}</strong>${confidenceMarkup(item.confidence)}</header>
      <code>${escapeHtml([source.schema, source.object].filter(Boolean).join('.') || source.kind || 'source')}</code>
      ${values.length ? `<dl>${values.map(([key, value]) => `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`).join('')}</dl>` : ''}
    </article>`;
  }

  function recommendationDetailMarkup(payload) {
    const recommendation = payload?.recommendation || {};
    const memory = Array.isArray(payload?.memory) ? payload.memory : [];
    const evidence = Array.isArray(recommendation.evidence) ? recommendation.evidence : [];
    const limitations = Array.isArray(recommendation.limitations) ? recommendation.limitations : [];
    const alternatives = Array.isArray(recommendation.alternatives) ? recommendation.alternatives : [];
    const consequence = recommendation.consequence_of_inaction || {};
    const lastOutcome = recommendation.last_outcome;

    return `<div class="phase3-modal-body-scroll">
      <header class="phase3-detail-head">
        <div><span>${escapeHtml(humanize(recommendation.recommendation_type))} · Version ${formatNumber(recommendation.version)}</span><h2>${escapeHtml(recommendation.title)}</h2><p>${escapeHtml(recommendation.summary)}</p></div>
        ${confidenceMarkup({ state: recommendation.confidence_state, score: recommendation.confidence_score })}
      </header>

      <section class="phase3-detail-section"><h3>Why Atlas recommends this</h3><p>${escapeHtml(recommendation.explanation)}</p><div class="phase3-confidence-reason"><i data-lucide="shield-question"></i><span>${escapeHtml(recommendation.confidence_reason)}</span></div></section>

      <section class="phase3-detail-section"><h3>Evidence</h3><div class="phase3-evidence-grid">${evidence.length ? evidence.map(evidenceMarkup).join('') : '<p class="phase3-empty">No evidence payload was returned.</p>'}</div></section>

      ${limitations.length ? `<section class="phase3-detail-section"><h3>Limitations</h3><ul class="phase3-limit-list">${limitations.map((item) => `<li><i data-lucide="circle-slash-2"></i>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}

      ${alternatives.length ? `<section class="phase3-detail-section"><h3>Alternatives</h3><div class="phase3-alternative-list">${alternatives.map((item) => `<article><strong>${escapeHtml(item.label || 'Alternative')}</strong><span>${escapeHtml(item.effect || item.target || '')}</span></article>`).join('')}</div></section>` : ''}

      ${Object.keys(consequence).length ? `<section class="phase3-detail-section"><h3>Consequence of doing nothing</h3><p>${escapeHtml(consequence.risk || JSON.stringify(consequence))}</p></section>` : ''}

      <section class="phase3-detail-section"><h3>Previous decisions and outcomes</h3>
        ${memory.length ? `<div class="phase3-detail-memory">${memory.map(memoryMarkup).join('')}</div>` : '<p class="phase3-empty">No previous decision exists for this subject.</p>'}
        ${lastOutcome ? `<article class="phase3-last-outcome"><strong>${escapeHtml(humanize(lastOutcome.outcome_type))}</strong><span>${escapeHtml(humanize(lastOutcome.outcome_status))} · ${lastOutcome.success_score == null ? 'Score not recorded' : formatPercent(lastOutcome.success_score)}</span><p>${escapeHtml(lastOutcome.notes || JSON.stringify(lastOutcome.result || {}))}</p></article>` : ''}
      </section>
    </div>`;
  }

  function decisionFormMarkup(recommendation) {
    const actionJson = JSON.stringify(recommendation?.suggested_action || {}, null, 2);
    return `<form class="phase3-form" id="phase3-decision-form">
      <header><span>Manager decision</span><h2>${escapeHtml(recommendation?.title || 'Recommendation')}</h2><p>Atlas records this decision as memory. No operational record is changed.</p></header>
      <label><span>Decision</span><select id="phase3-decision"><option value="accept">Accept recommendation</option><option value="reject">Reject recommendation</option><option value="modify">Modify recommendation</option><option value="defer">Defer recommendation</option><option value="reset">Reset to active</option></select></label>
      <label><span>Reason</span><select id="phase3-reason"><option value="evidence_supported">Evidence supports this</option><option value="local_context">Local context changed</option><option value="insufficient_evidence">Insufficient evidence</option><option value="cash_constraint">Cash constraint</option><option value="supplier_constraint">Supplier constraint</option><option value="timing">Timing</option><option value="other">Other</option></select></label>
      <label id="phase3-modified-action-wrap" hidden><span>Replacement action (JSON)</span><textarea id="phase3-modified-action" rows="7">${escapeHtml(actionJson)}</textarea></label>
      <label id="phase3-deferred-until-wrap" hidden><span>Defer until</span><input id="phase3-deferred-until" type="datetime-local" /></label>
      <label><span>Decision notes</span><textarea id="phase3-decision-notes" rows="4" placeholder="Explain the VÁ context Atlas should remember."></textarea></label>
      <div class="phase3-form-actions"><button type="button" class="phase3-secondary-action" data-phase3-close>Cancel</button><button type="submit" class="phase3-primary-action"><i data-lucide="save"></i>Save decision</button></div>
    </form>`;
  }

  function outcomeFormMarkup(recommendation) {
    return `<form class="phase3-form" id="phase3-outcome-form">
      <header><span>Outcome feedback</span><h2>${escapeHtml(recommendation?.title || 'Recommendation')}</h2><p>Record what happened so Atlas can measure usefulness later.</p></header>
      <label><span>Outcome status</span><select id="phase3-outcome-status"><option value="observed">Observed</option><option value="confirmed">Confirmed</option><option value="disputed">Disputed</option></select></label>
      <label><span>Success score (0–100)</span><input id="phase3-success-score" type="number" min="0" max="100" step="1" placeholder="80" /></label>
      <label><span>What happened?</span><textarea id="phase3-outcome-result" rows="4" placeholder="Example: one keg was sufficient after the event cancellation."></textarea></label>
      <label><span>Notes</span><textarea id="phase3-outcome-notes" rows="3" placeholder="Evidence source, caveat or follow-up."></textarea></label>
      <div class="phase3-form-actions"><button type="button" class="phase3-secondary-action" data-phase3-close>Cancel</button><button type="submit" class="phase3-primary-action"><i data-lucide="activity"></i>Record outcome</button></div>
    </form>`;
  }

  function modalMarkup(content, mode) {
    return `<div class="phase3-modal-backdrop" data-phase3-modal role="dialog" aria-modal="true" aria-label="Atlas Brain ${escapeHtml(mode)}">
      <div class="phase3-modal-panel"><button type="button" class="phase3-modal-close" data-phase3-close aria-label="Close"><i data-lucide="x"></i></button>${content}</div>
    </div>`;
  }

  function renderModal() {
    document.querySelector('[data-phase3-modal]')?.remove();
    if (!state.modalMode) return;
    let content = '<div class="phase3-modal-loading"><i data-lucide="loader-circle"></i><p>Reading Atlas memory…</p></div>';
    if (state.detail && ['why', 'memory'].includes(state.modalMode)) content = recommendationDetailMarkup(state.detail);
    if (state.detail && state.modalMode === 'decision') content = decisionFormMarkup(state.detail.recommendation);
    if (state.detail && state.modalMode === 'outcome') content = outcomeFormMarkup(state.detail.recommendation);

    const template = document.createElement('template');
    template.innerHTML = modalMarkup(content, state.modalMode).trim();
    const modal = template.content.firstElementChild;
    if (!modal) return;
    document.body.appendChild(modal);
    document.body.classList.add('phase3-modal-open');
    bindModal(modal);
    window.lucide?.createIcons?.();
  }

  function closeModal() {
    state.modalMode = null;
    state.detail = null;
    state.selectedRecommendationId = null;
    document.querySelector('[data-phase3-modal]')?.remove();
    document.body.classList.remove('phase3-modal-open');
  }

  function bindModal(modal) {
    modal.querySelectorAll('[data-phase3-close]').forEach((button) => button.addEventListener('click', closeModal));
    modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });

    const decisionSelect = modal.querySelector('#phase3-decision');
    const modifiedWrap = modal.querySelector('#phase3-modified-action-wrap');
    const deferWrap = modal.querySelector('#phase3-deferred-until-wrap');
    if (decisionSelect) {
      const update = () => {
        modifiedWrap.hidden = decisionSelect.value !== 'modify';
        deferWrap.hidden = decisionSelect.value !== 'defer';
      };
      decisionSelect.addEventListener('change', update);
      update();
    }

    modal.querySelector('#phase3-decision-form')?.addEventListener('submit', submitDecision);
    modal.querySelector('#phase3-outcome-form')?.addEventListener('submit', submitOutcome);

    if (state.detail && ['why', 'memory'].includes(state.modalMode)) {
      const footer = document.createElement('footer');
      footer.className = 'phase3-modal-footer';
      footer.innerHTML = `<button type="button" class="phase3-secondary-action" data-phase3-modal-outcome><i data-lucide="activity"></i>Record outcome</button><button type="button" class="phase3-primary-action" data-phase3-modal-decide><i data-lucide="gavel"></i>Decide</button>`;
      modal.querySelector('.phase3-modal-panel')?.appendChild(footer);
      footer.querySelector('[data-phase3-modal-decide]')?.addEventListener('click', () => { state.modalMode = 'decision'; renderModal(); });
      footer.querySelector('[data-phase3-modal-outcome]')?.addEventListener('click', () => { state.modalMode = 'outcome'; renderModal(); });
      window.lucide?.createIcons?.();
    }
  }

  async function loadSnapshot(forceRefresh = false) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    queueRender();
    try {
      const payload = forceRefresh
        ? await api('refresh', { method: 'POST', body: {} })
        : await api('snapshot');
      state.snapshot = payload.snapshot;
      state.manager = payload.manager || null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Phase 3 could not be loaded.';
    } finally {
      state.loading = false;
      queueRender();
    }
  }

  async function openRecommendation(id, mode) {
    state.selectedRecommendationId = id;
    state.modalMode = mode;
    state.detail = null;
    renderModal();
    try {
      const payload = await api('detail', { params: { id } });
      state.detail = payload.detail;
      renderModal();
    } catch (error) {
      state.modalMode = 'why';
      state.detail = {
        recommendation: { title: 'Recommendation unavailable', summary: error instanceof Error ? error.message : 'Could not read recommendation detail.' },
        memory: []
      };
      renderModal();
    }
  }

  async function submitDecision(event) {
    event.preventDefault();
    if (state.submitting || !state.selectedRecommendationId) return;
    const decision = document.getElementById('phase3-decision')?.value || 'accept';
    let modifiedAction = null;
    if (decision === 'modify') {
      try {
        modifiedAction = JSON.parse(document.getElementById('phase3-modified-action')?.value || '{}');
      } catch {
        window.alert('Replacement action must be valid JSON.');
        return;
      }
    }
    const deferValue = document.getElementById('phase3-deferred-until')?.value || null;
    state.submitting = true;
    try {
      await api('decision', {
        method: 'POST',
        body: {
          recommendation_id: state.selectedRecommendationId,
          decision,
          reason_code: document.getElementById('phase3-reason')?.value || null,
          notes: document.getElementById('phase3-decision-notes')?.value?.trim() || null,
          modified_action: modifiedAction,
          deferred_until: deferValue ? new Date(deferValue).toISOString() : null,
          client_request_id: requestId()
        }
      });
      closeModal();
      await loadSnapshot(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Decision could not be saved.');
    } finally {
      state.submitting = false;
    }
  }

  async function submitOutcome(event) {
    event.preventDefault();
    if (state.submitting || !state.selectedRecommendationId) return;
    const rawScore = document.getElementById('phase3-success-score')?.value;
    const score = rawScore === '' || rawScore == null ? null : Math.max(0, Math.min(100, Number(rawScore))) / 100;
    const resultText = document.getElementById('phase3-outcome-result')?.value?.trim() || '';
    state.submitting = true;
    try {
      await api('outcome', {
        method: 'POST',
        body: {
          recommendation_id: state.selectedRecommendationId,
          outcome_type: 'manager_observation',
          outcome_status: document.getElementById('phase3-outcome-status')?.value || 'observed',
          success_score: score,
          result: resultText ? { observation: resultText } : {},
          source_refs: [],
          notes: document.getElementById('phase3-outcome-notes')?.value?.trim() || null,
          observed_at: new Date().toISOString(),
          client_request_id: requestId()
        }
      });
      closeModal();
      await loadSnapshot(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Outcome could not be recorded.');
    } finally {
      state.submitting = false;
    }
  }

  function bindRenderedEvents(root) {
    root.querySelectorAll('[data-phase3-refresh]').forEach((button) => button.addEventListener('click', () => loadSnapshot(true)));
    root.querySelectorAll('[data-phase3-why]').forEach((button) => button.addEventListener('click', () => openRecommendation(button.dataset.phase3Why, 'why')));
    root.querySelectorAll('[data-phase3-decide]').forEach((button) => button.addEventListener('click', () => openRecommendation(button.dataset.phase3Decide, 'decision')));
    root.querySelectorAll('[data-phase3-memory-open]').forEach((button) => button.addEventListener('click', () => openRecommendation(button.dataset.phase3MemoryOpen, 'memory')));
  }

  function render() {
    const shell = host();
    if (!shell) return;
    state.observer?.disconnect();
    const existing = shell.querySelector('[data-phase3-brain]');
    const markup = state.loading && !state.snapshot
      ? loadingMarkup()
      : state.error
        ? errorMarkup(state.error)
        : state.snapshot
          ? snapshotMarkup(state.snapshot)
          : loadingMarkup();

    const template = document.createElement('template');
    template.innerHTML = markup.trim();
    const next = template.content.firstElementChild;
    if (!next) return;

    if (existing) existing.replaceWith(next);
    else {
      const daily = shell.querySelector('[data-daily-briefing]');
      if (daily) daily.insertAdjacentElement('afterend', next);
      else {
        const hero = shell.querySelector('.brain-hero');
        if (hero) hero.insertAdjacentElement('afterend', next);
        else shell.prepend(next);
      }
    }

    bindRenderedEvents(next);
    window.lucide?.createIcons?.();
    state.observer?.observe(shell, { childList: true });
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      render();
    });
  }

  function installObserver() {
    const shell = host();
    if (!shell || state.observer) return;
    state.observer = new MutationObserver(() => {
      if (!shell.querySelector('[data-phase3-brain]')) queueRender();
    });
    state.observer.observe(shell, { childList: true });
  }

  function bindAuthWhenReady() {
    let attempts = 0;
    const bind = () => {
      attempts += 1;
      if (window.atlasSupabase?.auth) {
        if (!state.authSubscription) {
          const subscription = window.atlasSupabase.auth.onAuthStateChange((_event, nextSession) => {
            if (nextSession) loadSnapshot(false);
            else {
              state.snapshot = null;
              state.error = 'Sign in to Atlas to load Phase 3.';
              queueRender();
            }
          });
          state.authSubscription = subscription.data.subscription;
        }
        return true;
      }
      return attempts >= 80;
    };
    if (bind()) return;
    const timer = setInterval(() => { if (bind()) clearInterval(timer); }, 250);
  }

  function start() {
    let attempts = 0;
    const attach = () => {
      attempts += 1;
      if (!host()) return attempts >= 80;
      installObserver();
      queueRender();
      loadSnapshot(false);
      bindAuthWhenReady();
      return true;
    };
    if (attach()) return;
    const timer = setInterval(() => { if (attach()) clearInterval(timer); }, 250);
  }

  window.AtlasPhase3Brain = {
    refresh: () => loadSnapshot(true),
    snapshot: () => state.snapshot,
    openRecommendation
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.modalMode) closeModal();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
