(function () {
  'use strict';

  const state = {
    observer: null,
    frame: null,
    modal: null,
    modalKind: null,
    modalId: null,
    initialized: false
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

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function formatTime(value) {
    return value ? String(value).slice(0, 5) : 'No due time';
  }

  function snapshot() {
    return window.AtlasCheckpointA?.snapshot?.() || null;
  }

  function routinesToday() {
    const routines = snapshot()?.routines;
    return Array.isArray(routines)
      ? routines.filter((routine) => routine.routine_type !== 'temperature')
      : [];
  }

  function temperatureData() {
    return snapshot()?.temperature || { summary: {}, points: [] };
  }

  function connectionData() {
    const connections = snapshot()?.connections;
    return Array.isArray(connections) ? connections : [];
  }

  function statusClass(status) {
    return String(status || 'scheduled').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }

  function routineIcon(type) {
    return ({
      inventory: 'clipboard-list',
      deep_cleaning: 'sparkles',
      storage: 'warehouse',
      temperature: 'thermometer'
    })[type] || 'calendar-check-2';
  }

  function progressText(routine) {
    const progress = routine.progress || {};
    return `${number(progress.completed)} of ${number(progress.required)} complete`;
  }

  function cardStatus(status) {
    const normalized = statusClass(status);
    return `<span class="checkpoint-a-compact-status is-${escapeHtml(normalized)}">${escapeHtml(humanize(status || 'scheduled'))}</span>`;
  }

  function compactRoutineCard(routine) {
    return `<article class="checkpoint-a-compact-card is-routine" data-state="${escapeHtml(statusClass(routine.status))}">
      <div class="checkpoint-a-compact-icon"><i data-lucide="${escapeHtml(routineIcon(routine.routine_type))}"></i></div>
      <div class="checkpoint-a-compact-copy">
        <span class="checkpoint-a-compact-eyebrow">Scheduled today · Due ${escapeHtml(formatTime(routine.due_time))}</span>
        <h3>${escapeHtml(routine.name)}</h3>
        <p>${escapeHtml(progressText(routine))}. ${escapeHtml(routine.description || '')}</p>
      </div>
      <div class="checkpoint-a-compact-actions">
        ${cardStatus(routine.status)}
        <button type="button" class="checkpoint-a-compact-button" data-checkpoint-compact-open="routine" data-routine-id="${escapeHtml(routine.id)}">
          Open checklist <i data-lucide="arrow-up-right"></i>
        </button>
      </div>
    </article>`;
  }

  function compactTemperatureCard() {
    const temperature = temperatureData();
    const summary = temperature.summary || {};
    const required = number(summary.required_points);
    const logged = number(summary.logged_points);
    const outside = number(summary.outside_range_points);
    const complete = Boolean(summary.complete);
    const status = outside > 0 ? 'outside_range' : complete ? 'completed' : logged > 0 ? 'in_progress' : 'scheduled';
    const detail = outside > 0
      ? `${outside} point${outside === 1 ? '' : 's'} need corrective action.`
      : `${logged} of ${required} refrigeration points logged today.`;

    return `<article class="checkpoint-a-compact-card is-temperature" data-state="${escapeHtml(statusClass(status))}">
      <div class="checkpoint-a-compact-icon"><i data-lucide="thermometer"></i></div>
      <div class="checkpoint-a-compact-copy">
        <span class="checkpoint-a-compact-eyebrow">Daily control</span>
        <h3>Temperature log</h3>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div class="checkpoint-a-compact-actions">
        ${cardStatus(status)}
        <button type="button" class="checkpoint-a-compact-button" data-checkpoint-compact-open="temperature">
          Open log <i data-lucide="arrow-up-right"></i>
        </button>
      </div>
    </article>`;
  }

  function compactBoardMarkup() {
    const routines = routinesToday();
    const hasManagerSettings = Boolean(document.querySelector('#operations-center [data-checkpoint-settings]'));
    const cards = routines.map(compactRoutineCard).join('') + compactTemperatureCard();

    return `<section class="checkpoint-a-compact-board" data-checkpoint-a-compact-board>
      <header class="checkpoint-a-compact-head">
        <div>
          <span class="checkpoint-a-compact-kicker"><i data-lucide="calendar-clock"></i>Today at VÁ</span>
          <h2>Scheduled routines</h2>
          <p>Atlas keeps the weekly schedule in the background and surfaces only what is due today.</p>
        </div>
        ${hasManagerSettings ? `<button type="button" class="checkpoint-a-compact-manage" data-checkpoint-compact-settings><i data-lucide="sliders-horizontal"></i>Manage schedules</button>` : ''}
      </header>
      <div class="checkpoint-a-compact-grid">${cards}</div>
    </section>`;
  }

  function transformOperations() {
    const host = document.getElementById('operations-center');
    const shell = host?.querySelector('.checkpoint-a-shell');
    if (!shell || shell.dataset.compactLayoutApplied === 'true') return;

    shell.dataset.compactLayoutApplied = 'true';
    shell.classList.add('checkpoint-a-compact-mode');

    const oldBoard = shell.querySelector('[data-checkpoint-a-compact-board]');
    oldBoard?.remove();
    shell.insertAdjacentHTML('afterbegin', compactBoardMarkup());

    shell.querySelector('.checkpoint-a-hero')?.setAttribute('hidden', '');
    shell.querySelector('.checkpoint-a-summary-grid')?.setAttribute('hidden', '');
    shell.querySelector('.checkpoint-a-layout')?.setAttribute('hidden', '');

    syncIntegrationsToSettings();
    syncHomePrompt();
    refreshOpenModal();

    if (window.lucide) window.lucide.createIcons();
  }

  function currentRoutine() {
    const routines = routinesToday().filter((routine) => !['completed', 'skipped'].includes(routine.status));
    return routines[0] || routinesToday()[0] || null;
  }

  function homePromptSignature() {
    const routine = currentRoutine();
    const summary = temperatureData().summary || {};
    return JSON.stringify({
      routine: routine ? [routine.id, routine.status, routine.progress?.completed, routine.progress?.required] : null,
      temperature: [summary.logged_points, summary.required_points, summary.outside_range_points, summary.complete]
    });
  }

  function homePromptMarkup() {
    const routine = currentRoutine();
    const summary = temperatureData().summary || {};
    const required = number(summary.required_points);
    const logged = number(summary.logged_points);
    const outside = number(summary.outside_range_points);
    const temperatureNeedsAttention = !summary.complete || outside > 0;

    if (!routine && !temperatureNeedsAttention) return '';

    const title = routine ? routine.name : 'Daily temperature log';
    const detail = routine
      ? `${progressText(routine)} · due ${formatTime(routine.due_time)}`
      : `${logged} of ${required} points logged today${outside ? ` · ${outside} out of range` : ''}`;
    const kind = routine ? 'routine' : 'temperature';

    return `<section class="checkpoint-a-home-prompt" data-checkpoint-a-home-prompt>
      <div class="checkpoint-a-home-icon"><i data-lucide="${escapeHtml(routine ? routineIcon(routine.routine_type) : 'thermometer')}"></i></div>
      <div class="checkpoint-a-home-copy">
        <span>Scheduled today</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
      </div>
      <button type="button" data-checkpoint-home-open="${escapeHtml(kind)}" ${routine ? `data-routine-id="${escapeHtml(routine.id)}"` : ''}>
        Open <i data-lucide="arrow-right"></i>
      </button>
    </section>`;
  }

  function syncHomePrompt() {
    const homeFocus = document.getElementById('home-focus');
    if (!homeFocus) return;

    const signature = homePromptSignature();
    const existing = document.querySelector('[data-checkpoint-a-home-prompt]');
    if (existing?.dataset.signature === signature) return;
    existing?.remove();

    const markup = homePromptMarkup();
    if (!markup) return;
    homeFocus.insertAdjacentHTML('afterend', markup);
    const prompt = document.querySelector('[data-checkpoint-a-home-prompt]');
    if (prompt) prompt.dataset.signature = signature;
    if (window.lucide) window.lucide.createIcons();
  }

  function integrationSignature() {
    return JSON.stringify(connectionData().map((connection) => [
      connection.provider_key,
      connection.status,
      connection.last_verified_at
    ]));
  }

  function integrationCard(connection) {
    const isTripadvisor = connection.provider_key === 'tripadvisor';
    const summary = isTripadvisor
      ? 'Reputation monitoring and response drafting only. Public responses stay in Tripadvisor Management Center until supported write access is verified.'
      : 'Planning is available before connection. Publishing and analytics remain locked until authorization and platform permissions are verified.';

    return `<article class="checkpoint-a-settings-connection ${isTripadvisor ? 'is-reputation' : ''}">
      <header>
        <div><span>${escapeHtml(humanize(connection.category))}</span><h3>${escapeHtml(connection.label)}</h3></div>
        ${cardStatus(connection.status)}
      </header>
      <p>${escapeHtml(summary)}</p>
      <details>
        <summary>Connection boundary</summary>
        <dl>${Object.entries(connection.capabilities || {}).map(([key, value]) => `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(humanize(value))}</dd></div>`).join('')}</dl>
      </details>
    </article>`;
  }

  function syncIntegrationsToSettings() {
    const settings = document.getElementById('settings-view');
    if (!settings) return;
    const connections = connectionData();
    const signature = integrationSignature();

    let section = document.getElementById('checkpoint-a-integrations-settings');
    if (section?.dataset.signature === signature) return;
    if (!section) {
      section = document.createElement('section');
      section.id = 'checkpoint-a-integrations-settings';
      section.className = 'checkpoint-a-settings-integrations';
      settings.appendChild(section);
    }

    section.dataset.signature = signature;
    section.innerHTML = `<header class="checkpoint-a-settings-head">
      <span>Settings · Integrations</span>
      <h2>Marketing and reputation connections</h2>
      <p>Connection readiness belongs in Settings. Operations Center now shows only the work due today.</p>
    </header>
    <div class="checkpoint-a-settings-grid">${connections.map(integrationCard).join('')}</div>`;

    if (window.lucide) window.lucide.createIcons();
  }

  function ensureModal() {
    if (state.modal?.isConnected) return state.modal;

    const modal = document.createElement('div');
    modal.className = 'checkpoint-a-context-modal';
    modal.hidden = true;
    modal.dataset.checkpointContextModal = 'true';
    modal.innerHTML = `<div class="checkpoint-a-context-backdrop" data-checkpoint-context-close></div>
      <section class="checkpoint-a-context-panel" role="dialog" aria-modal="true" aria-labelledby="checkpoint-a-context-title">
        <header class="checkpoint-a-context-header">
          <div><span>Today at VÁ</span><h2 id="checkpoint-a-context-title">Scheduled routine</h2></div>
          <button type="button" aria-label="Close" data-checkpoint-context-close><i data-lucide="x"></i></button>
        </header>
        <div class="checkpoint-a-context-body" data-checkpoint-context-body></div>
      </section>`;
    document.body.appendChild(modal);
    state.modal = modal;
    return modal;
  }

  function stripDuplicateIds(root) {
    root.removeAttribute('id');
    root.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    root.querySelectorAll('[hidden]').forEach((element) => element.removeAttribute('hidden'));
  }

  function sourceForModal(kind, id) {
    if (kind === 'temperature') {
      return document.querySelector('#operations-center #checkpoint-a-temperature');
    }
    if (kind === 'routine' && id) {
      return document.querySelector(`#operations-center .checkpoint-a-routine[data-checkpoint-routine="${CSS.escape(id)}"]`);
    }
    return null;
  }

  function modalTitle(kind, id) {
    if (kind === 'temperature') return 'Daily temperature log';
    const routine = routinesToday().find((entry) => entry.id === id);
    return routine?.name || 'Scheduled routine';
  }

  function refreshOpenModal() {
    if (!state.modal || state.modal.hidden || !state.modalKind) return;
    const source = sourceForModal(state.modalKind, state.modalId);
    const body = state.modal.querySelector('[data-checkpoint-context-body]');
    const title = state.modal.querySelector('#checkpoint-a-context-title');
    if (!source || !body || !title) {
      closeModal();
      return;
    }

    const clone = source.cloneNode(true);
    stripDuplicateIds(clone);
    clone.classList.add('checkpoint-a-context-clone');
    body.replaceChildren(clone);
    title.textContent = modalTitle(state.modalKind, state.modalId);
    state.modal.classList.remove('is-updating');
    if (window.lucide) window.lucide.createIcons();
  }

  function openModal(kind, id = null) {
    const modal = ensureModal();
    state.modalKind = kind;
    state.modalId = id;
    modal.hidden = false;
    document.body.classList.add('checkpoint-a-context-open');
    refreshOpenModal();
    requestAnimationFrame(() => modal.querySelector('[data-checkpoint-context-close]')?.focus());
  }

  function closeModal() {
    if (!state.modal) return;
    state.modal.hidden = true;
    state.modalKind = null;
    state.modalId = null;
    document.body.classList.remove('checkpoint-a-context-open');
  }

  function originalActionSelector(element) {
    if (element.matches('[data-checkpoint-toggle]')) {
      return `[data-checkpoint-toggle][data-routine-id="${CSS.escape(element.dataset.routineId || '')}"][data-item-id="${CSS.escape(element.dataset.itemId || '')}"]`;
    }
    if (element.matches('[data-checkpoint-note]')) {
      return `[data-checkpoint-note][data-routine-id="${CSS.escape(element.dataset.routineId || '')}"][data-item-id="${CSS.escape(element.dataset.itemId || '')}"]`;
    }
    if (element.hasAttribute('data-checkpoint-complete')) {
      return `[data-checkpoint-complete="${CSS.escape(element.dataset.checkpointComplete || '')}"]`;
    }
    if (element.hasAttribute('data-checkpoint-skip')) {
      return `[data-checkpoint-skip="${CSS.escape(element.dataset.checkpointSkip || '')}"]`;
    }
    if (element.hasAttribute('data-checkpoint-temperature')) {
      return `[data-checkpoint-temperature="${CSS.escape(element.dataset.checkpointTemperature || '')}"]`;
    }
    if (element.hasAttribute('data-checkpoint-range')) {
      return `[data-checkpoint-range="${CSS.escape(element.dataset.checkpointRange || '')}"]`;
    }
    if (element.hasAttribute('data-checkpoint-settings')) return '[data-checkpoint-settings]';
    if (element.hasAttribute('data-checkpoint-target')) {
      return `[data-checkpoint-target="${CSS.escape(element.dataset.checkpointTarget || '')}"]`;
    }
    return null;
  }

  function delegateCloneAction(element) {
    const selector = originalActionSelector(element);
    if (!selector) return false;
    const original = document.querySelector(`#operations-center ${selector}`);
    if (!original) return false;

    const keepOpen = element.matches('[data-checkpoint-toggle]');
    if (keepOpen) {
      state.modal?.classList.add('is-updating');
      original.click();
      window.setTimeout(refreshOpenModal, 500);
    } else {
      closeModal();
      window.setTimeout(() => original.click(), 0);
    }
    return true;
  }

  function activateOperationsAndOpen(kind, id) {
    if (typeof setActiveView === 'function') setActiveView('operations');
    window.setTimeout(() => openModal(kind, id), 180);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const close = target.closest('[data-checkpoint-context-close]');
    if (close) {
      event.preventDefault();
      closeModal();
      return;
    }

    const compactOpen = target.closest('[data-checkpoint-compact-open]');
    if (compactOpen) {
      event.preventDefault();
      openModal(compactOpen.dataset.checkpointCompactOpen, compactOpen.dataset.routineId || null);
      return;
    }

    const homeOpen = target.closest('[data-checkpoint-home-open]');
    if (homeOpen) {
      event.preventDefault();
      activateOperationsAndOpen(homeOpen.dataset.checkpointHomeOpen, homeOpen.dataset.routineId || null);
      return;
    }

    const settings = target.closest('[data-checkpoint-compact-settings]');
    if (settings) {
      event.preventDefault();
      document.querySelector('#operations-center [data-checkpoint-settings]')?.click();
      return;
    }

    const cloneAction = target.closest('[data-checkpoint-context-modal] button, [data-checkpoint-context-modal] [data-checkpoint-target]');
    if (cloneAction && state.modal?.contains(cloneAction)) {
      event.preventDefault();
      delegateCloneAction(cloneAction);
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.modal && !state.modal.hidden) closeModal();
  }

  function scheduleApply() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      transformOperations();
      syncHomePrompt();
      syncIntegrationsToSettings();
    });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);

    state.observer = new MutationObserver(scheduleApply);
    state.observer.observe(document.body, { childList: true, subtree: true });

    scheduleApply();
  }

  window.AtlasCheckpointALayout = {
    apply: scheduleApply,
    openRoutine: (id) => activateOperationsAndOpen('routine', id),
    openTemperature: () => activateOperationsAndOpen('temperature')
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
