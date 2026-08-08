(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const state = {
    snapshot: null,
    staff: null,
    settings: null,
    loading: false,
    error: null,
    submitting: false,
    observer: null,
    renderQueued: false,
    modalMode: null,
    selectedRoutineId: null,
    selectedPointId: null,
    selectedTemplateId: null
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

  function formatTemperature(value) {
    return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} °C` : 'Not logged';
  }

  function formatTime(value) {
    if (!value) return 'No time set';
    return String(value).slice(0, 5);
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

  function apiEndpoint() {
    return String(cfg.OPERATIONS_CHECKPOINT_A_API || '').trim();
  }

  async function session() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, options = {}) {
    const endpoint = apiEndpoint();
    if (!endpoint) throw new Error('Checkpoint A operations API is not configured for this preview.');
    const activeSession = await session();
    if (!activeSession?.access_token) throw new Error('Sign in to Atlas to load operational routines.');

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
    if (!response.ok) throw new Error(payload.error || `Operations request failed (${response.status}).`);
    return payload;
  }

  function operationsHost() {
    return document.getElementById('operations-center');
  }

  function todayRoutines() {
    return Array.isArray(state.snapshot?.routines) ? state.snapshot.routines : [];
  }

  function nonTemperatureRoutines() {
    return todayRoutines().filter((routine) => routine.routine_type !== 'temperature');
  }

  function temperatureData() {
    return state.snapshot?.temperature || { summary: {}, points: [] };
  }

  function statusBadge(status) {
    const normalized = String(status || 'scheduled').toLowerCase();
    return `<span class="checkpoint-a-status is-${escapeHtml(normalized)}">${escapeHtml(humanize(normalized))}</span>`;
  }

  function emptyMarkup(title, detail) {
    return `<div class="checkpoint-a-empty"><i data-lucide="calendar-check-2"></i><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
  }

  function routineItemMarkup(routine, item) {
    const locked = ['completed', 'skipped'].includes(routine.status) || !state.staff?.can_write;
    const target = item.metadata?.target;
    const needsNote = ['note', 'maintenance', 'photo', 'stock_count'].includes(item.evidence_type);
    return `<article class="checkpoint-a-task ${item.completed ? 'is-complete' : ''}">
      <button type="button" class="checkpoint-a-task-toggle" data-checkpoint-toggle
        data-routine-id="${escapeHtml(routine.id)}" data-item-id="${escapeHtml(item.id)}"
        aria-pressed="${item.completed ? 'true' : 'false'}" ${locked ? 'disabled' : ''}>
        <span class="checkpoint-a-check">${item.completed ? '<i data-lucide="check"></i>' : ''}</span>
        <span class="checkpoint-a-task-copy"><strong>${escapeHtml(item.label)}</strong>${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}</span>
      </button>
      <div class="checkpoint-a-task-actions">
        ${target ? `<button type="button" data-checkpoint-target="${escapeHtml(target)}" title="Open linked workflow"><i data-lucide="arrow-up-right"></i></button>` : ''}
        ${needsNote ? `<button type="button" data-checkpoint-note data-routine-id="${escapeHtml(routine.id)}" data-item-id="${escapeHtml(item.id)}" title="Add note" ${locked ? 'disabled' : ''}><i data-lucide="message-square-text"></i></button>` : ''}
      </div>
      ${item.note ? `<p class="checkpoint-a-task-note"><i data-lucide="message-circle"></i>${escapeHtml(item.note)}</p>` : ''}
    </article>`;
  }

  function routineSectionsMarkup(routine) {
    const groups = new Map();
    (routine.items || []).forEach((item) => {
      const section = item.section || 'Checklist';
      if (!groups.has(section)) groups.set(section, []);
      groups.get(section).push(item);
    });
    return Array.from(groups, ([section, items]) => `<section class="checkpoint-a-task-section">
      <h4>${escapeHtml(section)}</h4>
      <div>${items.map((item) => routineItemMarkup(routine, item)).join('')}</div>
    </section>`).join('');
  }

  function routineMarkup(routine) {
    const progress = routine.progress || {};
    const completed = routine.status === 'completed';
    const skipped = routine.status === 'skipped';
    const actionLocked = completed || skipped || !state.staff?.can_write;
    return `<article class="checkpoint-a-routine ${routine.status === 'overdue' ? 'is-overdue' : ''}" data-checkpoint-routine="${escapeHtml(routine.id)}">
      <header class="checkpoint-a-routine-head">
        <div>
          <span class="checkpoint-a-kicker">${escapeHtml(humanize(routine.routine_type))}</span>
          <h3>${escapeHtml(routine.name)}</h3>
          <p>${escapeHtml(routine.description || '')}</p>
        </div>
        <div class="checkpoint-a-routine-state">${statusBadge(routine.status)}<small>Due ${escapeHtml(formatTime(routine.due_time))}</small></div>
      </header>
      <div class="checkpoint-a-progress-row">
        <div class="checkpoint-a-progress"><span style="width:${Math.max(0, Math.min(100, number(progress.percent)))}%"></span></div>
        <strong>${formatNumber(progress.completed)}/${formatNumber(progress.required)}</strong>
      </div>
      <div class="checkpoint-a-task-groups">${routineSectionsMarkup(routine)}</div>
      <footer class="checkpoint-a-routine-footer">
        <span>${routine.completed_by_label ? `Completed by ${escapeHtml(routine.completed_by_label)} · ${escapeHtml(formatDateTime(routine.completed_at))}` : 'Every completion is kept in the operations audit trail.'}</span>
        <div>
          ${state.staff?.can_manage && !completed && !skipped ? `<button type="button" class="checkpoint-a-quiet" data-checkpoint-skip="${escapeHtml(routine.id)}">Skip with reason</button>` : ''}
          <button type="button" class="checkpoint-a-primary" data-checkpoint-complete="${escapeHtml(routine.id)}" ${actionLocked ? 'disabled' : ''}><i data-lucide="badge-check"></i>${completed ? 'Completed' : 'Complete routine'}</button>
        </div>
      </footer>
    </article>`;
  }

  function temperaturePointMarkup(point) {
    const log = point.latest_log;
    const status = log?.range_status || (point.range_configured ? 'not_logged' : 'range_unconfigured');
    const range = point.range_configured
      ? `${point.min_temp_c == null ? '—' : point.min_temp_c} to ${point.max_temp_c == null ? '—' : point.max_temp_c} °C`
      : 'Manager range required';
    return `<article class="checkpoint-a-temperature-row is-${escapeHtml(status)}">
      <div class="checkpoint-a-temperature-icon"><i data-lucide="thermometer"></i></div>
      <div class="checkpoint-a-temperature-copy">
        <strong>${escapeHtml(point.name)}</strong>
        <span>${escapeHtml(point.location || humanize(point.equipment_type))} · ${escapeHtml(range)}</span>
        ${log ? `<small>${escapeHtml(formatTemperature(log.temperature_c))} · ${escapeHtml(formatDateTime(log.reading_at))} · ${escapeHtml(humanize(log.range_status))}</small>` : '<small>No reading recorded today.</small>'}
      </div>
      <div class="checkpoint-a-temperature-actions">
        ${state.staff?.can_manage ? `<button type="button" class="checkpoint-a-icon-button" data-checkpoint-range="${escapeHtml(point.id)}" title="Configure range"><i data-lucide="settings-2"></i></button>` : ''}
        <button type="button" class="checkpoint-a-primary compact" data-checkpoint-temperature="${escapeHtml(point.id)}" ${state.staff?.can_write ? '' : 'disabled'}>${log ? 'Log again' : 'Log'}</button>
      </div>
    </article>`;
  }

  function connectionMarkup(connection) {
    const isTripadvisor = connection.provider_key === 'tripadvisor';
    const capabilities = connection.capabilities || {};
    const boundaries = isTripadvisor
      ? [
          'Review and listing data only when authorized API access and terms permit it.',
          'Atlas may draft a response in shadow mode; public submission remains through Tripadvisor Management Center until a supported write API is verified.',
          'No social-post publishing, incentivized reviews, review gating or guest-identity guessing.'
        ]
      : [
          'Planning and draft generation can work before the account is connected.',
          'Publishing and analytics remain disabled until OAuth and platform permissions are verified.'
        ];
    return `<article class="checkpoint-a-connection ${isTripadvisor ? 'is-featured' : ''}">
      <header><div><span>${escapeHtml(humanize(connection.category))}</span><strong>${escapeHtml(connection.label)}</strong></div>${statusBadge(connection.status)}</header>
      <ul>${boundaries.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      <details><summary>Connection capabilities</summary><dl>${Object.entries(capabilities).map(([key, value]) => `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(humanize(value))}</dd></div>`).join('')}</dl></details>
    </article>`;
  }

  function shellMarkup() {
    const routines = nonTemperatureRoutines();
    const temperature = temperatureData();
    const summary = temperature.summary || {};
    const connections = Array.isArray(state.snapshot?.connections) ? state.snapshot.connections : [];
    const completedRoutines = routines.filter((routine) => routine.status === 'completed').length;
    const overdueRoutines = routines.filter((routine) => routine.status === 'overdue').length;
    const tripadvisor = connections.find((connection) => connection.provider_key === 'tripadvisor');
    const socialConnections = connections.filter((connection) => connection.provider_key !== 'tripadvisor');

    return `<section class="checkpoint-a-shell" data-checkpoint-a>
      <header class="checkpoint-a-hero">
        <div>
          <span class="checkpoint-a-kicker"><i data-lucide="calendar-check-2"></i>Checkpoint A · Daily routines</span>
          <h2>Today’s operational routines</h2>
          <p>Weekly cleaning, inventory reminders and daily temperature evidence appear only when they are due. Every action keeps its staff, time and notes.</p>
        </div>
        <button type="button" class="checkpoint-a-secondary" data-checkpoint-refresh><i data-lucide="refresh-cw"></i>Refresh</button>
      </header>

      <div class="checkpoint-a-summary-grid">
        <article><span>Routines today</span><strong>${formatNumber(routines.length)}</strong><small>${completedRoutines} completed</small></article>
        <article><span>Overdue</span><strong>${formatNumber(overdueRoutines)}</strong><small>Needs manager visibility</small></article>
        <article><span>Temperatures</span><strong>${formatNumber(summary.logged_points)}/${formatNumber(summary.required_points)}</strong><small>${formatNumber(summary.outstanding_points)} still due</small></article>
        <article><span>Out of range</span><strong>${formatNumber(summary.outside_range_points)}</strong><small>Corrective action required</small></article>
      </div>

      <div class="checkpoint-a-layout">
        <div class="checkpoint-a-main-stack">
          <section class="checkpoint-a-panel" id="checkpoint-a-routines">
            <header class="checkpoint-a-panel-head"><div><h3>Weekly routines</h3><p>Sunday inventory, Monday deep cleaning and Tuesday storage organisation appear on their scheduled day.</p></div></header>
            <div class="checkpoint-a-routine-list">${routines.length ? routines.map(routineMarkup).join('') : emptyMarkup('No weekly routine is scheduled today', 'Daily temperature logging remains available every day.')}</div>
          </section>

          <section class="checkpoint-a-panel" id="checkpoint-a-temperature">
            <header class="checkpoint-a-panel-head"><div><h3>Daily temperature log</h3><p>Record every active refrigeration point. Target ranges are intentionally blank until a manager confirms them.</p></div>${state.staff?.can_manage ? '<button type="button" class="checkpoint-a-secondary" data-checkpoint-settings><i data-lucide="sliders-horizontal"></i>Manage routines</button>' : ''}</header>
            ${number(summary.range_unconfigured_points) > 0 ? `<div class="checkpoint-a-notice"><i data-lucide="shield-alert"></i><span>${formatNumber(summary.range_unconfigured_points)} temperature ranges still require manager confirmation. Readings are saved as “range unconfigured” until then.</span></div>` : ''}
            <div class="checkpoint-a-temperature-list">${(temperature.points || []).map(temperaturePointMarkup).join('')}</div>
          </section>
        </div>

        <aside class="checkpoint-a-side-stack">
          <section class="checkpoint-a-panel">
            <header class="checkpoint-a-panel-head"><div><h3>Tripadvisor boundary</h3><p>Reputation management is separate from social publishing.</p></div></header>
            ${tripadvisor ? connectionMarkup(tripadvisor) : emptyMarkup('Tripadvisor boundary not found', 'The connection registry needs review.')}
          </section>

          <section class="checkpoint-a-panel">
            <header class="checkpoint-a-panel-head"><div><h3>Marketing connections</h3><p>Planning can begin before credentials exist; publishing remains locked.</p></div></header>
            <div class="checkpoint-a-connection-list">${socialConnections.map(connectionMarkup).join('')}</div>
          </section>

          <section class="checkpoint-a-trust">
            <i data-lucide="shield-check"></i>
            <div><strong>Operations evidence contract</strong><span>Private branch · Staff identity required · Temperature and checklist history preserved · No inventory quantity change from this module</span></div>
          </section>
        </aside>
      </div>
    </section>`;
  }

  function loadingMarkup() {
    return `<section class="checkpoint-a-shell is-loading" data-checkpoint-a><i data-lucide="loader-circle"></i><div><h2>Loading today’s routines</h2><p>Checking weekly tasks, temperature points and connection boundaries.</p></div></section>`;
  }

  function errorMarkup(message) {
    return `<section class="checkpoint-a-shell is-error" data-checkpoint-a><i data-lucide="triangle-alert"></i><div><h2>Operational routines unavailable</h2><p>${escapeHtml(message)}</p></div><button type="button" class="checkpoint-a-primary" data-checkpoint-refresh>Try again</button></section>`;
  }

  function hostMarkup() {
    if (state.loading && !state.snapshot) return loadingMarkup();
    if (state.error && !state.snapshot) return errorMarkup(state.error);
    return shellMarkup();
  }

  function renderOperations() {
    const host = operationsHost();
    if (!host) return;
    state.observer?.disconnect();
    const existing = host.querySelector('[data-checkpoint-a]');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = hostMarkup();
    const next = wrapper.firstElementChild;
    if (!next) return;
    if (existing) existing.replaceWith(next);
    else {
      const hero = host.querySelector('.operations-hero');
      if (hero) hero.insertAdjacentElement('afterend', next);
      else host.prepend(next);
    }
    bindEvents(next);
    renderHomeAlerts();
    window.lucide?.createIcons?.();
    observeHost();
  }

  function renderHomeAlerts() {
    const focus = document.getElementById('focus-list');
    if (!focus || !state.snapshot) return;
    focus.querySelectorAll('[data-checkpoint-a-focus]').forEach((row) => row.remove());
    const alerts = Array.isArray(state.snapshot.alerts) ? state.snapshot.alerts : [];
    alerts.slice().reverse().forEach((alert) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `focus-row checkpoint-a-focus is-${alert.severity || 'medium'}`;
      row.dataset.checkpointAFocus = 'true';
      row.innerHTML = `<span class="focus-dot"></span><span><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.detail || '')}</small></span><i data-lucide="arrow-right"></i>`;
      row.addEventListener('click', () => openOperationsTarget(alert.target));
      focus.prepend(row);
    });
    window.lucide?.createIcons?.();
  }

  function observeHost() {
    const host = operationsHost();
    if (!host || state.observer) {
      state.observer?.observe(host, { childList: true, subtree: true });
      return;
    }
    state.observer = new MutationObserver(() => {
      const currentHost = operationsHost();
      if (currentHost && !currentHost.querySelector('[data-checkpoint-a]')) queueRender();
    });
    state.observer.observe(host, { childList: true, subtree: true });
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderOperations();
    });
  }

  function openOperationsTarget(target) {
    if (typeof setActiveView === 'function') setActiveView('operations');
    const id = target === 'temperature-log' ? 'checkpoint-a-temperature' : 'checkpoint-a-routines';
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function loadSnapshot() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    renderOperations();
    try {
      const payload = await api('snapshot');
      state.snapshot = payload.operations || {};
      state.staff = payload.staff || null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Could not load operational routines.';
    } finally {
      state.loading = false;
      renderOperations();
    }
  }

  async function refreshSettings() {
    const payload = await api('settings');
    state.settings = payload.settings || {};
    return state.settings;
  }

  async function post(action, body) {
    if (state.submitting) return null;
    state.submitting = true;
    try {
      const payload = await api(action, { method: 'POST', body });
      state.snapshot = payload.operations || state.snapshot;
      state.error = null;
      renderOperations();
      return payload;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'The operation could not be saved.');
      return null;
    } finally {
      state.submitting = false;
    }
  }

  function routineById(id) {
    return todayRoutines().find((routine) => routine.id === id) || null;
  }

  function pointById(id) {
    return (temperatureData().points || []).find((point) => point.id === id) || null;
  }

  function itemById(routine, id) {
    return (routine?.items || []).find((item) => item.id === id) || null;
  }

  async function toggleItem(button) {
    const routine = routineById(button.dataset.routineId);
    const item = itemById(routine, button.dataset.itemId);
    if (!routine || !item) return;
    await post('set-item', {
      instance_id: routine.id,
      template_item_id: item.id,
      completed: !item.completed,
      note: item.note || null,
      evidence: item.evidence || {}
    });
  }

  async function editItemNote(button) {
    const routine = routineById(button.dataset.routineId);
    const item = itemById(routine, button.dataset.itemId);
    if (!routine || !item) return;
    const note = window.prompt('Add an operational note. Leave blank to remove the note.', item.note || '');
    if (note === null) return;
    await post('set-item', {
      instance_id: routine.id,
      template_item_id: item.id,
      completed: Boolean(item.completed),
      note,
      evidence: item.evidence || {}
    });
  }

  async function completeRoutine(id) {
    const routine = routineById(id);
    if (!routine) return;
    const notes = window.prompt('Completion notes (optional).', routine.completion_notes || '');
    if (notes === null) return;
    await post('complete-routine', { instance_id: id, notes });
  }

  async function skipRoutine(id) {
    const reason = window.prompt('Why is this routine being skipped? This reason is kept in the audit history.');
    if (!reason?.trim()) return;
    await post('skip-routine', { instance_id: id, reason });
  }

  function modalMarkup(content, label) {
    return `<div class="checkpoint-a-modal-backdrop" data-checkpoint-modal role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
      <section class="checkpoint-a-modal"><button type="button" class="checkpoint-a-modal-close" data-checkpoint-close aria-label="Close"><i data-lucide="x"></i></button>${content}</section>
    </div>`;
  }

  function temperatureFormMarkup(point) {
    const range = point.range_configured
      ? `${point.min_temp_c == null ? '—' : point.min_temp_c} to ${point.max_temp_c == null ? '—' : point.max_temp_c} °C`
      : 'Range not configured';
    return `<form class="checkpoint-a-form" id="checkpoint-temperature-form">
      <header><span>Daily temperature log</span><h2>${escapeHtml(point.name)}</h2><p>${escapeHtml(point.location || '')} · ${escapeHtml(range)}</p></header>
      <label><span>Temperature °C</span><input id="checkpoint-temperature-value" type="number" min="-60" max="120" step="0.1" required inputmode="decimal" /></label>
      <label><span>Note</span><textarea id="checkpoint-temperature-note" rows="3" placeholder="Optional context about the reading."></textarea></label>
      <label><span>Corrective action</span><textarea id="checkpoint-temperature-corrective" rows="3" placeholder="Required when the configured range is exceeded."></textarea></label>
      ${!point.range_configured ? '<div class="checkpoint-a-form-notice">This reading will be stored as “range unconfigured” until a manager confirms the target range.</div>' : ''}
      <div class="checkpoint-a-form-actions"><button type="button" class="checkpoint-a-secondary" data-checkpoint-close>Cancel</button><button type="submit" class="checkpoint-a-primary">Save reading</button></div>
    </form>`;
  }

  function rangeFormMarkup(point) {
    return `<form class="checkpoint-a-form" id="checkpoint-range-form">
      <header><span>Manager setting</span><h2>Temperature point</h2><p>Confirm the equipment name, location and acceptable range. Atlas does not invent food-safety limits.</p></header>
      <label><span>Name</span><input id="checkpoint-range-name" value="${escapeHtml(point.name)}" required /></label>
      <label><span>Location</span><input id="checkpoint-range-location" value="${escapeHtml(point.location || '')}" /></label>
      <div class="checkpoint-a-form-grid"><label><span>Minimum °C</span><input id="checkpoint-range-min" type="number" min="-60" max="120" step="0.1" value="${point.min_temp_c ?? ''}" /></label><label><span>Maximum °C</span><input id="checkpoint-range-max" type="number" min="-60" max="120" step="0.1" value="${point.max_temp_c ?? ''}" /></label></div>
      <label class="checkpoint-a-switch"><input id="checkpoint-range-active" type="checkbox" ${point.active === false ? '' : 'checked'} /><span>Active temperature point</span></label>
      <div class="checkpoint-a-form-actions"><button type="button" class="checkpoint-a-secondary" data-checkpoint-close>Cancel</button><button type="submit" class="checkpoint-a-primary">Save range</button></div>
    </form>`;
  }

  function scheduleFormMarkup(template) {
    const selected = new Set((template.days_of_week || []).map(Number));
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `<form class="checkpoint-a-form" id="checkpoint-schedule-form">
      <header><span>Manager setting</span><h2>${escapeHtml(template.name)}</h2><p>Change when this routine appears. Historical completions are never deleted.</p></header>
      <label><span>Name</span><input id="checkpoint-schedule-name" value="${escapeHtml(template.name)}" required /></label>
      <label><span>Description</span><textarea id="checkpoint-schedule-description" rows="3">${escapeHtml(template.description || '')}</textarea></label>
      <fieldset class="checkpoint-a-days"><legend>Days</legend>${dayLabels.map((label, index) => `<label><input type="checkbox" value="${index}" ${selected.has(index) ? 'checked' : ''} /><span>${label}</span></label>`).join('')}</fieldset>
      <div class="checkpoint-a-form-grid"><label><span>Available from</span><input id="checkpoint-schedule-from" type="time" value="${escapeHtml(formatTime(template.available_from).replace('No time set', ''))}" /></label><label><span>Due time</span><input id="checkpoint-schedule-due" type="time" value="${escapeHtml(formatTime(template.due_time).replace('No time set', ''))}" /></label></div>
      <label><span>Assigned role</span><select id="checkpoint-schedule-role"><option value="any_active_staff" ${template.assigned_role === 'any_active_staff' ? 'selected' : ''}>Any active staff</option><option value="bartender" ${template.assigned_role === 'bartender' ? 'selected' : ''}>Bartender</option><option value="manager" ${template.assigned_role === 'manager' ? 'selected' : ''}>Manager</option><option value="admin" ${template.assigned_role === 'admin' ? 'selected' : ''}>Administrator</option></select></label>
      <label class="checkpoint-a-switch"><input id="checkpoint-schedule-signoff" type="checkbox" ${template.requires_manager_signoff ? 'checked' : ''} /><span>Requires manager sign-off</span></label>
      <label class="checkpoint-a-switch"><input id="checkpoint-schedule-active" type="checkbox" ${template.active ? 'checked' : ''} /><span>Active routine</span></label>
      <div class="checkpoint-a-form-actions"><button type="button" class="checkpoint-a-secondary" data-checkpoint-close>Cancel</button><button type="submit" class="checkpoint-a-primary">Save routine</button></div>
    </form>`;
  }

  function settingsMarkup(settings) {
    const templates = Array.isArray(settings?.templates) ? settings.templates : [];
    return `<div class="checkpoint-a-settings-list"><header><span>Manager settings</span><h2>Routine schedules</h2><p>Edit days, times and ownership. Checklist content is stored separately so future Knowledge and Settings modules can manage it without losing completion history.</p></header>${templates.map((template) => `<button type="button" class="checkpoint-a-setting-row" data-checkpoint-template="${escapeHtml(template.id)}"><div><strong>${escapeHtml(template.name)}</strong><span>${escapeHtml((template.days_of_week || []).map((day) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', '))} · Due ${escapeHtml(formatTime(template.due_time))} · ${formatNumber(template.item_count)} items</span></div>${statusBadge(template.active ? 'active' : 'inactive')}<i data-lucide="chevron-right"></i></button>`).join('')}</div>`;
  }

  function closeModal() {
    document.querySelector('[data-checkpoint-modal]')?.remove();
    state.modalMode = null;
    state.selectedRoutineId = null;
    state.selectedPointId = null;
    state.selectedTemplateId = null;
  }

  function showModal(content, label) {
    closeModal();
    document.body.insertAdjacentHTML('beforeend', modalMarkup(content, label));
    const modal = document.querySelector('[data-checkpoint-modal]');
    modal?.querySelectorAll('[data-checkpoint-close]').forEach((button) => button.addEventListener('click', closeModal));
    modal?.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
    window.lucide?.createIcons?.();
  }

  function openTemperature(id) {
    const point = pointById(id);
    if (!point) return;
    state.selectedPointId = id;
    state.modalMode = 'temperature';
    showModal(temperatureFormMarkup(point), 'Temperature log');
    document.getElementById('checkpoint-temperature-form')?.addEventListener('submit', submitTemperature);
  }

  function openRange(id) {
    const point = pointById(id);
    if (!point) return;
    state.selectedPointId = id;
    state.modalMode = 'range';
    showModal(rangeFormMarkup(point), 'Temperature range');
    document.getElementById('checkpoint-range-form')?.addEventListener('submit', submitRange);
  }

  async function openSettings() {
    try {
      const settings = await refreshSettings();
      state.modalMode = 'settings';
      showModal(settingsMarkup(settings), 'Routine settings');
      document.querySelectorAll('[data-checkpoint-template]').forEach((button) => button.addEventListener('click', () => openSchedule(button.dataset.checkpointTemplate)));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not load routine settings.');
    }
  }

  function openSchedule(id) {
    const template = (state.settings?.templates || []).find((item) => item.id === id);
    if (!template) return;
    state.selectedTemplateId = id;
    state.modalMode = 'schedule';
    showModal(scheduleFormMarkup(template), 'Routine schedule');
    document.getElementById('checkpoint-schedule-form')?.addEventListener('submit', submitSchedule);
  }

  async function submitTemperature(event) {
    event.preventDefault();
    const point = pointById(state.selectedPointId);
    if (!point) return;
    const temperature = Number(document.getElementById('checkpoint-temperature-value')?.value);
    const note = document.getElementById('checkpoint-temperature-note')?.value || null;
    const corrective = document.getElementById('checkpoint-temperature-corrective')?.value || null;
    const outOfRange = point.range_configured && (
      (point.min_temp_c != null && temperature < Number(point.min_temp_c))
      || (point.max_temp_c != null && temperature > Number(point.max_temp_c))
    );
    if (outOfRange && !corrective?.trim()) {
      window.alert('Corrective action is required for an out-of-range temperature.');
      return;
    }
    const result = await post('log-temperature', {
      point_id: point.id,
      temperature_c: temperature,
      note,
      corrective_action: corrective
    });
    if (result) closeModal();
  }

  async function submitRange(event) {
    event.preventDefault();
    const point = pointById(state.selectedPointId);
    if (!point) return;
    const minValue = document.getElementById('checkpoint-range-min')?.value;
    const maxValue = document.getElementById('checkpoint-range-max')?.value;
    const result = await post('update-temperature-point', {
      point_id: point.id,
      name: document.getElementById('checkpoint-range-name')?.value,
      location: document.getElementById('checkpoint-range-location')?.value,
      min_temp_c: minValue === '' ? null : Number(minValue),
      max_temp_c: maxValue === '' ? null : Number(maxValue),
      active: Boolean(document.getElementById('checkpoint-range-active')?.checked)
    });
    if (result) closeModal();
  }

  async function submitSchedule(event) {
    event.preventDefault();
    const template = (state.settings?.templates || []).find((item) => item.id === state.selectedTemplateId);
    if (!template) return;
    const days = Array.from(document.querySelectorAll('.checkpoint-a-days input:checked')).map((input) => Number(input.value));
    const result = await post('update-template', {
      template_id: template.id,
      name: document.getElementById('checkpoint-schedule-name')?.value,
      description: document.getElementById('checkpoint-schedule-description')?.value,
      days_of_week: days,
      available_from: document.getElementById('checkpoint-schedule-from')?.value || null,
      due_time: document.getElementById('checkpoint-schedule-due')?.value || null,
      assigned_role: document.getElementById('checkpoint-schedule-role')?.value,
      active: Boolean(document.getElementById('checkpoint-schedule-active')?.checked),
      requires_manager_signoff: Boolean(document.getElementById('checkpoint-schedule-signoff')?.checked)
    });
    if (result) {
      state.settings = null;
      closeModal();
    }
  }

  function bindEvents(root) {
    root.querySelectorAll('[data-checkpoint-refresh]').forEach((button) => button.addEventListener('click', loadSnapshot));
    root.querySelectorAll('[data-checkpoint-toggle]').forEach((button) => button.addEventListener('click', () => toggleItem(button)));
    root.querySelectorAll('[data-checkpoint-note]').forEach((button) => button.addEventListener('click', () => editItemNote(button)));
    root.querySelectorAll('[data-checkpoint-complete]').forEach((button) => button.addEventListener('click', () => completeRoutine(button.dataset.checkpointComplete)));
    root.querySelectorAll('[data-checkpoint-skip]').forEach((button) => button.addEventListener('click', () => skipRoutine(button.dataset.checkpointSkip)));
    root.querySelectorAll('[data-checkpoint-temperature]').forEach((button) => button.addEventListener('click', () => openTemperature(button.dataset.checkpointTemperature)));
    root.querySelectorAll('[data-checkpoint-range]').forEach((button) => button.addEventListener('click', () => openRange(button.dataset.checkpointRange)));
    root.querySelectorAll('[data-checkpoint-target]').forEach((button) => button.addEventListener('click', () => {
      const target = button.dataset.checkpointTarget;
      if (target === 'temperature-log') openOperationsTarget(target);
      else if (typeof setActiveView === 'function') setActiveView(target);
    }));
    root.querySelector('[data-checkpoint-settings]')?.addEventListener('click', openSettings);
  }

  function patchApplication() {
    if (typeof setActiveView === 'function' && !setActiveView.__checkpointAPatched) {
      const originalSetActiveView = setActiveView;
      const patchedSetActiveView = function (view) {
        originalSetActiveView(view);
        if (view === 'operations') queueRender();
        if (view === 'dashboard' || view === 'home') renderHomeAlerts();
      };
      patchedSetActiveView.__checkpointAPatched = true;
      setActiveView = patchedSetActiveView;
    }

    if (typeof renderAtlasHome === 'function' && !renderAtlasHome.__checkpointAPatched) {
      const originalRenderAtlasHome = renderAtlasHome;
      const patchedRenderAtlasHome = function () {
        originalRenderAtlasHome();
        renderHomeAlerts();
      };
      patchedRenderAtlasHome.__checkpointAPatched = true;
      renderAtlasHome = patchedRenderAtlasHome;
    }
  }

  function init() {
    patchApplication();
    const waitForOperations = () => {
      if (operationsHost()) {
        observeHost();
        loadSnapshot();
        return;
      }
      window.setTimeout(waitForOperations, 120);
    };
    waitForOperations();
  }

  window.AtlasCheckpointA = {
    load: loadSnapshot,
    render: renderOperations,
    snapshot: () => state.snapshot
  };

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();
