// Operations — #operations (docs/design/Atlas_Experience_Redesign.md §7.4).
//
// The one Operations implementation. It replaces operations.js (readiness
// hero, device-local checklist, suggested purchasing), operations-checkpoint-a.js
// (routine engine) and operations-checkpoint-a-layout.js (compact layer).
//
//   #operations              Today: today's server checklists and routines
//   #operations/<instanceId> one checklist with who/when on every item
//   #operations/temperature  temperature log
//   #operations/schedule     routine schedule (managers)
//
// Every checklist tick is a server write (atlas-operations-checkpoint-a
// ?action=set-item, S88 contract §2) on the venue's business date; nothing is
// stored on the device. Readiness moved to Home, suggested purchasing to
// Purchasing (AtlasOperations.orderSuggestions stays the canonical browser
// suggestion rule for Purchasing, Search and Atlas AI).
// No inventory quantity change from this module.
(function () {
  'use strict';
  // 24-hour time fields (AtlasVenueClock.TIME_INPUT_ATTRS): never the browser's 12-hour picker.
  const TIME_FIELD = window.AtlasVenueClock?.TIME_INPUT_ATTRS || 'type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" data-atlas-time';

  const WRITE_ROLES = ['admin', 'manager', 'bartender'];
  const MANAGER_ROLES = ['admin', 'manager'];
  const ALL_ROLES = ['admin', 'manager', 'bartender', 'viewer'];
  const REFRESH_AFTER_MS = 60000;
  const IMPORT_EVIDENCE = { source: 'device_checklist_import_s88' };
  // Keys the retired device-local checklist wrote (atlas.checklist.<date>.<type>).
  const DEVICE_CHECKLIST_KEY = /^atlas\.checklist\.(\d{4}-\d{2}-\d{2})\.(opening|closing)$/;
  const DEVICE_ORDER_NOTES_KEY = /^atlas\.order-status\./;

  const state = {
    initialized: false,
    view: null,
    // Server data
    status: 'idle', // idle | loading | ready | error
    error: null,
    snapshot: null,
    checklists: null,
    staff: null,
    loadedAt: 0,
    inflight: null,
    settings: null,
    settingsStatus: 'idle',
    settingsError: null,
    // UI
    section: 'today',
    pending: new Set(),
    itemErrors: {},
    pageMessage: null,
    deviceImport: null,
    deviceImportChecked: false
  };

  // ---------- helpers ----------

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clock() {
    return window.AtlasVenueClock || null;
  }

  function shell() {
    return window.AtlasShell || null;
  }

  function role() {
    return state.staff?.role || shell()?.profile?.()?.role || null;
  }

  function canWrite() {
    if (state.staff) return Boolean(state.staff.can_write);
    return WRITE_ROLES.includes(role());
  }

  function canManage() {
    if (state.staff) return Boolean(state.staff.can_manage);
    return MANAGER_ROLES.includes(role());
  }

  function icon(name) {
    return `<i data-lucide="${escape(name)}" aria-hidden="true"></i>`;
  }

  function formatTime(value) {
    return clock()?.formatTime?.(value) || '';
  }

  function formatWhen(value) {
    const venue = clock();
    if (!venue || !value) return '';
    return venue.venueDate(value) === venue.venueDate() ? venue.formatTime(value) : venue.formatDateTime(value);
  }

  function businessDateLabel(dateKey) {
    const venue = clock();
    if (!venue) return '';
    return venue.formatDate(dateKey || venue.today(), { long: true });
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function temperatureText(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? `${parsed.toFixed(1)} °C` : '';
  }

  function rangeText(point) {
    if (!point?.range_configured) return 'No target range yet';
    const min = point.min_temp_c;
    const max = point.max_temp_c;
    if (min != null && max != null) return `${min}–${max} °C`;
    if (min != null) return `At least ${min} °C`;
    return `At most ${max} °C`;
  }

  // ---------- canonical browser rules kept for other modules ----------

  // The shell's loaded, role-filtered records (index.html AtlasData).
  function items() {
    if (typeof window.AtlasData?.items === 'function') return window.AtlasData.items() || [];
    return Array.isArray(globalThis.items) ? globalThis.items : [];
  }

  function recipeList() {
    if (typeof window.AtlasData?.recipes === 'function') return window.AtlasData.recipes() || [];
    return Array.isArray(globalThis.recipes) ? globalThis.recipes : [];
  }

  // Items that need ordering: the canonical AtlasStockTruth.stockStatus
  // 'out' or 'below_par' (atlas-domain needsOrderingItems).
  function lowInventoryItems() {
    return (items() || []).filter((item) => item.active !== false && window.AtlasStockTruth?.needsOrdering(item));
  }

  function recipeIssues() {
    if (!window.AtlasRecipes?.recipeAvailability) return [];
    return (recipeList() || [])
      .filter((recipe) => recipe.active !== false)
      .map((recipe) => ({ recipe, availability: window.AtlasRecipes.recipeAvailability(recipe) }))
      .filter((entry) => entry.availability.status !== 'ready')
      .sort((a, b) => {
        const rank = { unavailable: 0, attention: 1, incomplete: 2 };
        return (rank[a.availability.status] ?? 9) - (rank[b.availability.status] ?? 9)
          || number(a.availability.servings, 999999) - number(b.availability.servings, 999999);
      });
  }

  // Suggested order lines for everything that needs ordering (out or below
  // par). "Ordered" means the item
  // is on a placed purchase order (shared across devices); the device-local
  // "Mark ordered" notes are retired with the Operations purchasing card.
  // Mirrors supabase/functions/_shared orderSuggestions (domain-parity-s88).
  function orderSuggestions() {
    const ordered = window.AtlasPurchaseOrders?.openItemIds?.() || new Set();
    return lowInventoryItems().map((item) => {
      const par = Math.max(0, number(item.par_level));
      const current = Math.max(0, number(item.quantity));
      const target = Math.max(par, Math.ceil(par * 2));
      const shortfall = Math.max(1, Math.ceil(target - current));
      const unitsPerCase = Math.max(0, number(item.units_per_case));
      const cases = unitsPerCase > 1 ? Math.max(1, Math.ceil(shortfall / unitsPerCase)) : null;
      const orderQuantity = cases ? cases * unitsPerCase : shortfall;
      // No usable cost → no estimate (null), never 0 kr (AtlasStockTruth.hasCost).
      const cost = window.AtlasStockTruth?.hasCost(item) ? number(item.cost_price) : null;
      return {
        id: item.id,
        name: item.name,
        unit: item.unit || 'units',
        supplier: item.supplier || 'Supplier not assigned',
        shortfall,
        orderQuantity,
        cases,
        estimatedCost: cost === null ? null : cost * orderQuantity,
        ordered: ordered.has(item.id)
      };
    });
  }

  // Server progress of the opening checklist, or null while it is unknown
  // (loading, unavailable or not set up). Unknown applies no penalty.
  function openingProgress() {
    const opening = state.checklists?.opening;
    if (!opening) return null;
    const required = number(opening.progress?.required);
    const completed = number(opening.progress?.completed);
    return { complete: completed, total: required, percent: required ? Math.round((completed / required) * 100) : 100 };
  }

  // Kept for Reports (Overview); Operations itself no longer shows a score.
  function readinessData() {
    const low = lowInventoryItems();
    const issues = recipeIssues();
    const opening = openingProgress();
    const unavailable = issues.filter((entry) => entry.availability.status === 'unavailable').length;
    const incomplete = issues.filter((entry) => entry.availability.status === 'incomplete').length;
    const checklistPenalty = opening ? Math.round((100 - opening.percent) * 0.22) : 0;
    const score = Math.max(0, Math.min(100,
      100 - Math.min(30, low.length * 4) - Math.min(25, unavailable * 10) - Math.min(15, incomplete * 4) - checklistPenalty
    ));
    let label = 'Ready for service';
    if (score < 85) label = 'Review before service';
    if (score < 60) label = 'Attention required';
    return { score, label, low, issues, opening };
  }

  // ---------- server ----------

  function endpoint() {
    return String(window.VABAR_CONFIG?.OPERATIONS_CHECKPOINT_A_API || '').trim();
  }

  async function accessToken() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    return result?.data?.session?.access_token || null;
  }

  class OperationsError extends Error {
    constructor(status, code, message) {
      super(message || code || 'failed');
      this.status = status;
      this.code = code || null;
    }
  }

  async function api(action, { method = 'GET', params = null, body = undefined } = {}) {
    const base = endpoint();
    if (!base) throw new OperationsError(0, 'not_configured');
    const token = await accessToken();
    if (!token) throw new OperationsError(401, 'unauthorized');
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([key, value]) => { if (value != null && value !== '') url.searchParams.set(key, String(value)); });
    let response;
    try {
      response = await fetch(url, {
        method,
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new OperationsError(0, 'network');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new OperationsError(response.status, payload?.code || null);
    return payload || {};
  }

  // What a failed write means for the person, never the server's text.
  function writeErrorText(error) {
    if (error?.code === 'checklist_day_closed') return 'This checklist day is closed. Earlier days can’t be changed.';
    if (error?.code === 'routine_closed') return 'This checklist is already completed or skipped.';
    if (error?.status === 403) return 'Your role can view checklists but not tick them.';
    if (error?.status === 404) return 'This checklist changed. Refresh to see the current one.';
    if (error?.code === 'network' || error?.status === 0) return 'You’re offline or Atlas couldn’t be reached. Nothing was saved — try again.';
    return 'That couldn’t be saved. Nothing was changed — try again.';
  }

  function applySnapshot(operations) {
    if (operations && typeof operations === 'object' && Array.isArray(operations.routines)) state.snapshot = operations;
  }

  async function load(options = {}) {
    if (state.inflight) return state.inflight;
    if (!options.force && state.status === 'ready' && Date.now() - state.loadedAt < REFRESH_AFTER_MS) return null;
    if (!endpoint()) {
      state.status = 'error';
      state.error = new OperationsError(0, 'not_configured');
      renderAll();
      return null;
    }
    if (state.status !== 'ready') state.status = 'loading';
    renderAll();
    state.inflight = (async () => {
      try {
        const [snapshot, daily] = await Promise.all([
          api('snapshot'),
          api('daily-checklists')
        ]);
        applySnapshot(snapshot?.operations);
        if (!snapshot?.operations) state.snapshot = state.snapshot || null;
        state.checklists = daily?.checklists && typeof daily.checklists === 'object' ? daily.checklists : null;
        state.staff = daily?.staff || snapshot?.staff || state.staff;
        state.status = 'ready';
        state.error = null;
        state.loadedAt = Date.now();
        checkDeviceChecklist();
      } catch (error) {
        state.error = error;
        state.status = state.snapshot || state.checklists ? 'ready' : 'error';
        if (state.status === 'ready') state.pageMessage = { tone: 'danger', text: 'Checklists couldn’t be refreshed. What you see may be out of date — anything you ticked is saved.' };
      } finally {
        state.inflight = null;
        renderAll();
      }
    })();
    return state.inflight;
  }

  async function loadSettings(force = false) {
    if (!canManage()) return;
    if (state.settingsStatus === 'loading' || (!force && state.settingsStatus === 'ready')) return;
    state.settingsStatus = 'loading';
    render();
    try {
      const payload = await api('settings');
      state.settings = payload?.settings || { templates: [] };
      state.settingsStatus = 'ready';
      state.settingsError = null;
    } catch (error) {
      state.settingsStatus = 'error';
      state.settingsError = error;
    }
    render();
  }

  async function write(action, body) {
    const payload = await api(action, { method: 'POST', body });
    applySnapshot(payload?.operations);
    if (payload?.staff) state.staff = payload.staff;
    // The daily checklist view carries editable/configured and who/when; re-read it.
    try {
      const daily = await api('daily-checklists');
      if (daily?.checklists) state.checklists = daily.checklists;
    } catch { /* the next load corrects it */ }
    state.loadedAt = Date.now();
    renderAll();
    return payload;
  }

  // ---------- derived data ----------

  function routines() {
    return Array.isArray(state.snapshot?.routines) ? state.snapshot.routines : [];
  }

  function dailyChecklist(type) {
    const fromDaily = state.checklists?.[type];
    if (fromDaily) return fromDaily;
    return routines().find((routine) => routine.routine_type === type) || null;
  }

  function otherRoutines() {
    return routines().filter((routine) => !['opening', 'closing', 'temperature'].includes(routine.routine_type));
  }

  function temperature() {
    const data = state.snapshot?.temperature;
    return { summary: data?.summary || {}, points: Array.isArray(data?.points) ? data.points : [] };
  }

  function routineById(id) {
    const key = String(id || '');
    return [dailyChecklist('opening'), dailyChecklist('closing'), ...routines()].find((routine) => routine && String(routine.id) === key) || null;
  }

  function progressOf(routine) {
    const items = Array.isArray(routine?.items) ? routine.items : [];
    const required = routine?.progress?.required != null ? number(routine.progress.required) : items.filter((item) => item.required !== false).length;
    const completed = routine?.progress?.completed != null ? number(routine.progress.completed) : items.filter((item) => item.required !== false && item.completed).length;
    return { required, completed, percent: required ? Math.round((completed / required) * 100) : (routine?.status === 'completed' ? 100 : 0) };
  }

  function checklistEditable(routine) {
    if (!routine) return false;
    if (['completed', 'skipped'].includes(routine.status)) return false;
    if (state.checklists && ['opening', 'closing'].includes(routine.routine_type) && state.checklists.editable === false) return false;
    return canWrite();
  }

  function whoTicked(routine) {
    const names = [...new Set((routine?.items || []).filter((item) => item.completed && item.completed_by_label).map((item) => item.completed_by_label))];
    return names.slice(0, 3).join(', ');
  }

  // "Sara is on it" / "Sara and Gunnar are on it" from who ticked items.
  function onIt(routine) {
    const names = [...new Set((routine?.items || []).filter((item) => item.completed && item.completed_by_label).map((item) => String(item.completed_by_label).split(/\s+/)[0]))];
    if (!names.length) return '';
    if (names.length === 1) return `${names[0]} is on it`;
    return `${names.slice(0, -1).slice(0, 2).join(', ')} and ${names.at(-1)} are on it`;
  }

  function statusPill(routine) {
    const status = String(routine?.status || 'scheduled');
    const progress = progressOf(routine);
    if (status === 'completed') return '<span class="atlas-pill atlas-pill--positive">Done</span>';
    if (status === 'skipped') return '<span class="atlas-pill atlas-pill--neutral">Skipped</span>';
    if (status === 'overdue') return '<span class="atlas-pill atlas-pill--danger">Overdue</span>';
    if (progress.completed > 0) return '<span class="atlas-pill atlas-pill--warning">In progress</span>';
    return '<span class="atlas-pill atlas-pill--neutral">Not started</span>';
  }

  function lastOrdersTime() {
    const venue = clock();
    const today = venue?.state?.().today;
    return today?.lastOrder || null;
  }

  function checklistMeta(routine, type) {
    const progress = progressOf(routine);
    const parts = [`${progress.completed} of ${progress.required} done`];
    if (routine.status === 'completed' && routine.completed_at) parts.push(`completed ${formatWhen(routine.completed_at)}${routine.completed_by_label ? ` by ${routine.completed_by_label}` : ''}`);
    else if (type === 'opening' && clock()?.state?.().today?.open) parts.push(`before opening at ${clock().state().today.open}`);
    else if (type === 'closing' && lastOrdersTime()) parts.push(`after last orders at ${lastOrdersTime()}`);
    else if (routine.due_time) parts.push(`due ${String(routine.due_time).slice(0, 5)}`);
    const who = whoTicked(routine);
    if (who && routine.status !== 'completed') parts.push(who);
    return parts.join(' · ');
  }

  // Today's rows for the Today tab and for Home.
  function todayRows() {
    const rows = [];
    ['opening', 'closing'].forEach((type) => {
      const routine = dailyChecklist(type);
      if (routine) rows.push({ kind: 'checklist', type, routine, name: routine.name || (type === 'opening' ? 'Opening checklist' : 'Closing checklist') });
    });
    const temp = temperature();
    if (temp.points.length) rows.push({ kind: 'temperature', summary: temp.summary, points: temp.points });
    otherRoutines().forEach((routine) => rows.push({ kind: 'routine', routine, name: routine.name }));
    return rows;
  }

  function summary() {
    const rows = todayRows();
    const checklists = rows.filter((row) => row.kind !== 'temperature');
    const done = checklists.filter((row) => row.routine.status === 'completed').length;
    const temp = temperature();
    return {
      status: state.status,
      businessDate: state.checklists?.business_date || state.snapshot?.venue_date || clock()?.today?.() || null,
      configured: state.checklists ? state.checklists.configured !== false : null,
      opening: dailyChecklist('opening'),
      closing: dailyChecklist('closing'),
      checklists: checklists.length,
      done,
      temperature: temp.points.length ? temp.summary : null,
      points: temp.points,
      routines: otherRoutines(),
      canWrite: canWrite(),
      canManage: canManage()
    };
  }

  // ---------- markup ----------

  function progressBar(percent, label) {
    return `<span class="ops-progress atlas-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}" aria-label="${escape(label)}"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></span>`;
  }

  function todayRowMarkup(row) {
    if (row.kind === 'temperature') {
      const logged = number(row.summary.logged_points);
      const required = number(row.summary.required_points, row.points.length);
      const outside = number(row.summary.outside_range_points);
      const done = required > 0 && logged >= required;
      const pill = outside > 0 ? '<span class="atlas-pill atlas-pill--danger">Out of range</span>'
        : done ? '<span class="atlas-pill atlas-pill--positive">Done</span>'
          : logged > 0 ? '<span class="atlas-pill atlas-pill--warning">In progress</span>' : '<span class="atlas-pill atlas-pill--neutral">Not logged</span>';
      const action = canWrite() && !done ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ops-log>Log reading</button>' : '<a class="atlas-btn atlas-btn--ghost atlas-btn--sm" href="#operations/temperature">View</a>';
      return `<li class="atlas-row ops-row">
        <span class="atlas-row__icon ${outside ? 'atlas-row__icon--danger' : done ? 'atlas-row__icon--positive' : 'atlas-row__icon--warning'}">${icon('thermometer')}</span>
        <div class="atlas-row__body"><a class="atlas-row__link ops-row__open" href="#operations/temperature">Temperature log</a><p class="atlas-row__meta">${escape(`${logged} of ${plural(required, 'point', 'points')} logged today`)}${outside ? escape(` · ${outside} out of range`) : ''}</p></div>
        ${progressBar(required ? (logged / required) * 100 : 0, 'Temperature readings logged')}
        <div class="ops-row__status">${pill}</div>
        <div class="atlas-row__end">${action}<span class="atlas-row__chevron">${icon('chevron-right')}</span></div>
      </li>`;
    }
    const routine = row.routine;
    const progress = progressOf(routine);
    const route = `#operations/${encodeURIComponent(routine.id)}`;
    const editable = checklistEditable(routine);
    const label = routine.status === 'completed' || routine.status === 'skipped' || !editable ? 'View' : progress.completed > 0 ? 'Continue' : 'Open';
    const meta = row.kind === 'checklist' ? checklistMeta(routine, row.type)
      : [routine.description, routine.due_time ? `Due ${String(routine.due_time).slice(0, 5)}` : null, `${progress.completed} of ${progress.required} done`].filter(Boolean).join(' · ');
    const tone = routine.status === 'completed' ? 'positive' : routine.status === 'overdue' ? 'danger' : progress.completed ? 'warning' : '';
    return `<li class="atlas-row ops-row">
      <span class="atlas-row__icon${tone ? ` atlas-row__icon--${tone}` : ''}">${icon(row.kind === 'checklist' ? 'list-checks' : 'calendar-check')}</span>
      <div class="atlas-row__body"><a class="atlas-row__link ops-row__open" href="${route}">${escape(row.name)}</a><p class="atlas-row__meta">${escape(meta)}</p></div>
      ${progressBar(progress.percent, `${row.name} progress`)}
      <div class="ops-row__status">${statusPill(routine)}</div>
      <div class="atlas-row__end"><a class="atlas-btn atlas-btn--${label === 'View' ? 'ghost' : 'secondary'} atlas-btn--sm" href="${route}">${label}</a><span class="atlas-row__chevron">${icon('chevron-right')}</span></div>
    </li>`;
  }

  function deviceImportMarkup() {
    const pending = state.deviceImport;
    if (!pending || !pending.count || !canWrite()) return '';
    return `<div class="atlas-alert atlas-alert--info ops-import" role="status">${icon('smartphone')}
      <div class="atlas-alert__content"><p class="atlas-alert__title">This device has ${escape(plural(pending.count, 'tick', 'ticks'))} from earlier today that the team can’t see</p>
      <p class="atlas-alert__body">Checklists are now shared. Ticking them again records them as you, now. They were never saved anywhere else.</p></div>
      <div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-ops-import-discard>Discard</button><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ops-import>Tick them as me</button></div></div>`;
  }

  function messageMarkup() {
    const message = state.pageMessage;
    if (!message) return '';
    return `<div class="atlas-alert atlas-alert--${message.tone === 'danger' ? 'danger' : 'positive'} ops-message" role="${message.tone === 'danger' ? 'alert' : 'status'}">${icon(message.tone === 'danger' ? 'circle-alert' : 'circle-check')}<div class="atlas-alert__content"><p class="atlas-alert__body">${escape(message.text)}</p></div>${message.tone === 'danger' ? '<div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ops-retry>Try again</button></div>' : ''}</div>`;
  }

  function errorMarkup() {
    const offline = state.error?.code === 'network';
    const notConfigured = state.error?.code === 'not_configured';
    const text = notConfigured ? 'Checklists aren’t available in this environment yet.'
      : offline ? 'You’re offline. Checklists load when you reconnect — anything you ticked is saved.'
        : 'Checklists couldn’t be loaded. Anything you ticked is saved.';
    return `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escape(text)}</p></div>${notConfigured ? '' : '<div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ops-retry>Try again</button></div>'}</div>`;
  }

  function skeletonRows(count = 4) {
    return `<ul class="atlas-list atlas-card ops-list" aria-busy="true">${'<li class="atlas-row"><span class="atlas-skel atlas-skel--circle"></span><div class="atlas-row__body"><span class="atlas-skel atlas-skel--text ops-skel-title"></span><span class="atlas-skel atlas-skel--text ops-skel-meta"></span></div></li>'.repeat(count)}</ul><span class="sr-only">Loading checklists</span>`;
  }

  function todayMarkup() {
    if (state.status === 'loading' || state.status === 'idle') return skeletonRows();
    if (state.status === 'error') return errorMarkup();
    const rows = todayRows();
    const notSetUp = state.checklists && state.checklists.configured === false
      ? `<div class="atlas-alert atlas-alert--warning" role="status">${icon('info')}<div class="atlas-alert__content"><p class="atlas-alert__title">Opening and closing checklists aren’t set up on the server yet</p><p class="atlas-alert__body">They appear here once they are. Atlas never keeps a checklist on one device.</p></div></div>`
      : '';
    if (!rows.length) {
      return `${notSetUp}<div class="atlas-empty"><div class="atlas-empty__icon">${icon('list-checks')}</div><h3>No checklists today</h3><p>${canManage() ? 'Routines you schedule appear here on their day.' : 'Checklists your manager schedules appear here on their day.'}</p>${canManage() ? '<a class="atlas-btn atlas-btn--secondary" href="#operations/schedule">Set up routines in Schedule</a>' : ''}</div>`;
    }
    return `${notSetUp}<ul class="atlas-list atlas-card ops-list">${rows.map(todayRowMarkup).join('')}</ul>
      <p class="ops-foot">Shared with the team. Every tick records who and when${state.checklists?.business_date ? ` for ${escape(businessDateLabel(state.checklists.business_date))}` : ''}.</p>`;
  }

  function itemMarkup(routine, item, editable) {
    const key = `${routine.id}:${item.id}`;
    const pending = state.pending.has(key);
    const error = state.itemErrors[key];
    const who = item.completed && item.completed_by_label
      ? `${item.completed_by_label}${item.completed_at ? ` · ${formatWhen(item.completed_at)}` : ''}`
      : '';
    return `<li class="ops-check${item.completed ? ' is-done' : ''}${pending ? ' is-pending' : ''}">
      <button type="button" class="ops-check__toggle" role="checkbox" aria-checked="${item.completed ? 'true' : 'false'}" data-ops-tick="${escape(item.id)}"${editable && !pending ? '' : ' disabled aria-disabled="true"'}>
        <span class="ops-check__box" aria-hidden="true">${item.completed ? icon('check') : ''}</span>
        <span class="ops-check__label">${escape(item.label)}${item.required === false ? ' <span class="ops-check__optional">Optional</span>' : ''}</span>
        ${who ? `<span class="ops-check__who">${escape(who)}</span>` : ''}
      </button>
      ${item.note ? `<p class="ops-check__note">${icon('message-square-text')}${escape(item.note)}</p>` : ''}
      ${error ? `<p class="ops-check__error" role="alert">${escape(error)}</p>` : ''}
      ${editable ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm ops-check__note-btn" data-ops-note="${escape(item.id)}">${item.note ? 'Edit note' : 'Add note'}</button>` : ''}
    </li>`;
  }

  function detailMarkup(routine) {
    if (!routine) {
      if (state.status === 'loading' || state.status === 'idle') return skeletonRows(6);
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('list-checks')}</div><h3>This checklist isn’t on today’s list</h3><p>It may belong to another day, or it was replaced.</p><a class="atlas-btn atlas-btn--secondary" href="#operations">Back to today</a></div>`;
    }
    const editable = checklistEditable(routine);
    const progress = progressOf(routine);
    const groups = new Map();
    (routine.items || []).forEach((item) => {
      const section = item.section && !['Opening', 'Closing', 'Checklist'].includes(item.section) ? item.section : '';
      if (!groups.has(section)) groups.set(section, []);
      groups.get(section).push(item);
    });
    const who = whoTicked(routine);
    const readOnly = !canWrite() ? '<p class="ops-detail__readonly">View only — your role can’t tick checklists.</p>'
      : ['completed', 'skipped'].includes(routine.status) ? `<p class="ops-detail__readonly">${routine.status === 'completed' ? `Completed${routine.completed_by_label ? ` by ${escape(routine.completed_by_label)}` : ''}${routine.completed_at ? ` · ${escape(formatWhen(routine.completed_at))}` : ''}` : 'Skipped'}</p>`
        : state.checklists?.editable === false && ['opening', 'closing'].includes(routine.routine_type) ? '<p class="ops-detail__readonly">This checklist day is closed.</p>' : '';
    const foot = editable
      ? `<div class="ops-detail__foot">${canManage() ? '<button type="button" class="atlas-btn atlas-btn--ghost" data-ops-skip>Skip with reason</button>' : ''}<button type="button" class="atlas-btn atlas-btn--primary" data-ops-complete>Complete checklist</button></div>`
      : '';
    return `<div class="ops-detail">
      <a class="atlas-btn atlas-btn--ghost atlas-btn--sm ops-back" href="#operations">${icon('chevron-left')}Today</a>
      <header class="ops-detail__head">
        <h2 class="ops-detail__title" id="ops-detail-title" tabindex="-1">${escape(routine.name)}</h2>
        <p class="ops-detail__meta">${escape(`${progress.completed} of ${progress.required} done`)}${who ? ` · ${escape(who)}` : ''}</p>
        ${progressBar(progress.percent, `${routine.name} progress`)}
        ${readOnly}
      </header>
      ${[...groups.entries()].map(([section, list]) => `${section ? `<h3 class="ops-detail__section">${escape(section)}</h3>` : ''}<ul class="ops-checks" aria-label="${escape(section || routine.name)}">${list.map((item) => itemMarkup(routine, item, editable)).join('')}</ul>`).join('')}
      ${foot}
    </div>`;
  }

  function temperatureMarkup() {
    if (state.status === 'loading' || state.status === 'idle') return skeletonRows(3);
    if (state.status === 'error') return errorMarkup();
    const { points, summary: tempSummary } = temperature();
    if (!points.length) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('thermometer')}</div><h3>No temperature points yet</h3><p>Fridges and freezers you log appear here once a manager adds them.</p></div>`;
    }
    const unconfigured = number(tempSummary.range_unconfigured_points);
    return `${unconfigured ? `<div class="atlas-alert atlas-alert--warning" role="status">${icon('info')}<div class="atlas-alert__content"><p class="atlas-alert__body">${escape(`${plural(unconfigured, 'point has', 'points have')} no target range yet. Readings are saved, but Atlas can’t say whether they are in range until a manager sets one.`)}</p></div></div>` : ''}
    <div class="atlas-table-wrap ops-temp"><table class="atlas-table">
      <thead><tr><th scope="col">Point</th><th scope="col">Target range</th><th scope="col" class="is-num">Today</th><th scope="col">Logged</th><th scope="col">Status</th><th scope="col" class="col-actions"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${points.map((point) => {
        const log = point.latest_log;
        const status = log?.range_status === 'outside_range' ? '<span class="atlas-pill atlas-pill--danger">Out of range</span>'
          : log?.range_status === 'inside_range' || log?.range_status === 'within_range' || log?.range_status === 'in_range' ? '<span class="atlas-pill atlas-pill--positive">In range</span>'
            : log ? '<span class="atlas-pill atlas-pill--neutral">Logged</span>' : '<span class="atlas-pill atlas-pill--warning">Not logged</span>';
        return `<tr>
          <td><span class="cell-primary">${escape(point.name)}</span>${point.location ? `<span class="cell-sub">${escape(point.location)}</span>` : ''}</td>
          <td>${escape(rangeText(point))}</td>
          <td class="is-num">${log ? escape(temperatureText(log.temperature_c)) : '<span class="ops-muted">—</span>'}</td>
          <td>${log ? escape(`${log.logged_by_label ? `${log.logged_by_label} · ` : ''}${formatWhen(log.reading_at)}`) : '<span class="ops-muted">Not logged today</span>'}</td>
          <td>${status}</td>
          <td class="col-actions"><div class="ops-temp__actions">${canWrite() ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ops-log="${escape(point.id)}">${log ? 'Log again' : 'Log reading'}</button>` : ''}${canManage() ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-ops-range="${escape(point.id)}">Edit range</button>` : ''}</div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="ops-foot">Readings are kept with who logged them and when. Today’s last reading is shown.</p>`;
  }

  function scheduleMarkup() {
    if (!canManage()) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('lock')}</div><h3>The routine schedule is for managers</h3><p>Ask a manager to change when routines appear.</p><a class="atlas-btn atlas-btn--secondary" href="#operations">Back to today</a></div>`;
    }
    if (state.settingsStatus === 'idle' || state.settingsStatus === 'loading') return skeletonRows(4);
    if (state.settingsStatus === 'error') {
      return `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">The routine schedule couldn’t be loaded. Nothing was changed.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ops-schedule-retry>Try again</button></div></div>`;
    }
    const templates = Array.isArray(state.settings?.templates) ? state.settings.templates : [];
    if (!templates.length) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('calendar-check')}</div><h3>No routines yet</h3><p>Routine templates are added on the server; once they exist you can change their days and times here.</p></div>`;
    }
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const roles = { any_active_staff: 'Anyone on shift', bartender: 'Bartenders', manager: 'Managers', admin: 'Administrators', viewer: 'Viewers' };
    return `<div class="atlas-table-wrap"><table class="atlas-table">
      <thead><tr><th scope="col">Routine</th><th scope="col">Days</th><th scope="col">Due</th><th scope="col">Who</th><th scope="col">Status</th><th scope="col" class="col-actions"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${templates.map((template) => {
        const list = (template.days_of_week || []).map((day) => days[Number(day)]).filter(Boolean);
        return `<tr>
          <td><span class="cell-primary">${escape(template.name)}</span><span class="cell-sub">${escape(plural(number(template.item_count), 'item', 'items'))}</span></td>
          <td>${escape(list.length === 7 ? 'Every day' : list.join(', ') || 'No days')}</td>
          <td>${template.due_time ? escape(String(template.due_time).slice(0, 5)) : '<span class="ops-muted">No due time</span>'}</td>
          <td>${escape(roles[template.assigned_role] || 'Anyone on shift')}</td>
          <td>${template.active ? '<span class="atlas-pill atlas-pill--positive">Active</span>' : '<span class="atlas-pill atlas-pill--neutral">Paused</span>'}</td>
          <td class="col-actions"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-ops-template="${escape(template.id)}">Edit</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }

  function subtitle() {
    const date = businessDateLabel(state.checklists?.business_date);
    if (state.status !== 'ready') return date;
    const rows = todayRows().filter((row) => row.kind !== 'temperature');
    if (!rows.length) return date;
    const done = rows.filter((row) => row.routine.status === 'completed').length;
    return `${date} · ${done} of ${plural(rows.length, 'checklist', 'checklists')} done`;
  }

  function tabsMarkup(section) {
    const tabs = [['today', 'Today', '#operations'], ['temperature', 'Temperature', '#operations/temperature']];
    if (canManage()) tabs.push(['schedule', 'Schedule', '#operations/schedule']);
    return `<nav class="atlas-tabs" aria-label="Operations sections">${tabs.map(([key, label, href]) => `<a href="${href}"${section === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }

  function readingDue() {
    const temp = temperature();
    return temp.points.length > 0 && number(temp.summary.outstanding_points, 0) > 0;
  }

  function render() {
    const root = state.view;
    if (!root || root.style.display === 'none') return;
    const section = state.section;
    const detail = !['today', 'temperature', 'schedule'].includes(section);
    const head = shell()?.pageHead?.({
      title: 'Operations',
      sub: subtitle(),
      actions: canWrite() && readingDue() && !detail ? [{ label: 'Log temperature', icon: 'thermometer', variant: 'primary', attrs: { 'data-ops-log': '' } }] : []
    }) || '<header class="page-head"><h1 class="page-head__title">Operations</h1></header>';
    const body = detail ? detailMarkup(routineById(section))
      : section === 'temperature' ? temperatureMarkup()
        : section === 'schedule' ? scheduleMarkup()
          : todayMarkup();
    const focus = document.activeElement && root.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    root.innerHTML = `<div class="ops">${head}${detail ? '' : tabsMarkup(section)}<div class="ops-body">${deviceImportMarkup()}${messageMarkup()}${body}</div></div>`;
    if (focus) root.querySelector(focus)?.focus();
    window.lucide?.createIcons?.();
  }

  function focusKey(element) {
    for (const name of ['data-ops-tick', 'data-ops-note', 'data-ops-log', 'data-ops-range', 'data-ops-template']) {
      if (element.hasAttribute(name)) return `[${name}="${CSS.escape(element.getAttribute(name))}"]`;
    }
    return null;
  }

  function renderAll() {
    render();
    shell()?.emit?.('notify:changed', { source: 'operations' });
    shell()?.emit?.('operations:changed', { status: state.status });
  }

  // ---------- dialogs: the shared AtlasModal.form (modal.js) ----------

  // onSubmit(form) returns an error text (the dialog stays open) or null.
  function openDialog({ title, body, submitLabel, danger = false, onSubmit, wide = false }) {
    return window.AtlasModal.form({ title, body, submitLabel, danger, wide, onSubmit });
  }

  let fieldSequence = 0;
  function field(label, control, help = '') {
    const id = `ops-field-${++fieldSequence}`;
    const withId = control.replace(/^\s*<(input|select|textarea)\b/, `<$1 id="${id}"`);
    return `<div class="atlas-field"><label for="${id}">${escape(label)}</label>${withId}${help ? `<p class="atlas-field__help">${escape(help)}</p>` : ''}</div>`;
  }

  // ---------- actions ----------

  async function tick(routineId, itemId, completed, extra = {}) {
    const routine = routineById(routineId);
    const item = (routine?.items || []).find((entry) => String(entry.id) === String(itemId));
    if (!routine || !item) return false;
    const key = `${routine.id}:${item.id}`;
    if (state.pending.has(key)) return false;
    state.pending.add(key);
    delete state.itemErrors[key];
    render();
    try {
      await write('set-item', {
        instance_id: routine.id,
        template_item_id: item.id,
        completed,
        note: extra.note !== undefined ? extra.note : (item.note || null),
        evidence: extra.evidence || item.evidence || {}
      });
      return true;
    } catch (error) {
      state.itemErrors[key] = writeErrorText(error);
      return false;
    } finally {
      state.pending.delete(key);
      render();
    }
  }

  function editNote(routineId, itemId) {
    const routine = routineById(routineId);
    const item = (routine?.items || []).find((entry) => String(entry.id) === String(itemId));
    if (!routine || !item) return;
    openDialog({
      title: item.note ? 'Edit note' : 'Add note',
      body: `<p>${escape(item.label)}</p>${field('Note', `<textarea class="atlas-input atlas-textarea" name="note" rows="3" maxlength="2000">${escape(item.note || '')}</textarea>`, 'Visible to the team with your name. Leave empty to remove it.')}`,
      submitLabel: 'Save note',
      onSubmit: async (form) => {
        try {
          await write('set-item', { instance_id: routine.id, template_item_id: item.id, completed: Boolean(item.completed), note: form.note.value.trim() || null, evidence: item.evidence || {} });
          return null;
        } catch (error) { return writeErrorText(error); }
      }
    });
  }

  function completeChecklist(routineId) {
    const routine = routineById(routineId);
    if (!routine) return;
    const open = (routine.items || []).filter((item) => item.required !== false && !item.completed).length;
    const submit = async (form) => {
      try {
        await write('complete-routine', { instance_id: routine.id, notes: form?.notes?.value?.trim() || null });
        state.pageMessage = { tone: 'positive', text: `${routine.name} completed.` };
        shell()?.navigate?.('#operations');
        shell()?.toast?.(`${routine.name} completed`);
        return null;
      } catch (error) { return writeErrorText(error); }
    };
    openDialog({
      title: open ? `${plural(open, 'item isn’t', 'items aren’t')} ticked. Complete anyway?` : `Complete ${routine.name.toLowerCase()}?`,
      body: `${open ? '<p>The unticked items stay visible in the history as not done.</p>' : '<p>Everyone sees it as done, with your name and the time.</p>'}${field('Note (optional)', '<textarea class="atlas-input atlas-textarea" name="notes" rows="2" maxlength="3000"></textarea>')}`,
      submitLabel: open ? 'Complete anyway' : 'Complete checklist',
      onSubmit: submit
    });
  }

  function skipChecklist(routineId) {
    const routine = routineById(routineId);
    if (!routine) return;
    openDialog({
      title: `Skip ${routine.name.toLowerCase()}?`,
      body: `<p>The reason is kept in the history with your name.</p>${field('Reason', '<textarea class="atlas-input atlas-textarea" name="reason" rows="2" maxlength="2000" required></textarea>')}`,
      submitLabel: 'Skip checklist',
      onSubmit: async (form) => {
        const reason = form.reason.value.trim();
        if (!reason) { form.reason.setAttribute('aria-invalid', 'true'); return 'Add a reason so the team knows why it was skipped.'; }
        try {
          await write('skip-routine', { instance_id: routine.id, reason });
          shell()?.navigate?.('#operations');
          return null;
        } catch (error) { return writeErrorText(error); }
      }
    });
  }

  function outOfRange(point, value) {
    if (!point?.range_configured || !Number.isFinite(value)) return false;
    return (point.min_temp_c != null && value < Number(point.min_temp_c)) || (point.max_temp_c != null && value > Number(point.max_temp_c));
  }

  function logTemperature(pointId) {
    const { points } = temperature();
    if (!points.length) {
      shell()?.navigate?.('#operations/temperature');
      return;
    }
    const initial = points.find((point) => String(point.id) === String(pointId))
      || points.find((point) => !point.latest_log) || points[0];
    const choices = points.map((point) => `<button type="button" role="radio" aria-checked="${point.id === initial.id ? 'true' : 'false'}" data-point="${escape(point.id)}">${escape(point.name)}</button>`).join('');
    const dialog = openDialog({
      title: 'Log temperature',
      wide: true,
      body: `<input type="hidden" name="point" value="${escape(initial.id)}">
        <div class="atlas-field"><span class="atlas-label" id="ops-point-label">Point</span><div class="atlas-segmented ops-points" role="radiogroup" aria-labelledby="ops-point-label">${choices}</div><p class="atlas-field__help" data-ops-range-help>${escape(`Target ${rangeText(initial)}`)}</p></div>
        ${field('Temperature (°C)', '<input class="atlas-input" name="value" type="number" inputmode="decimal" step="0.1" min="-60" max="120" required>')}
        <div class="atlas-alert atlas-alert--warning" data-ops-out hidden>${icon('triangle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">This is outside the target range. Say what you did about it.</p></div></div>
        <div data-ops-corrective hidden>${field('What you did', '<textarea class="atlas-input atlas-textarea" name="corrective" rows="2" maxlength="3000"></textarea>')}</div>
        ${field('Note (optional)', '<textarea class="atlas-input atlas-textarea" name="note" rows="2" maxlength="2000"></textarea>')}`,
      submitLabel: 'Save reading',
      onSubmit: async (form) => {
        const point = points.find((entry) => String(entry.id) === form.point.value);
        const value = Number(String(form.value.value).replace(',', '.'));
        if (!point) return 'Choose a point.';
        if (form.value.value === '' || !Number.isFinite(value) || value < -60 || value > 120) {
          form.value.setAttribute('aria-invalid', 'true');
          return 'Enter a temperature between −60 and 120 °C.';
        }
        const corrective = form.corrective.value.trim();
        if (outOfRange(point, value) && !corrective) {
          form.corrective.setAttribute('aria-invalid', 'true');
          return 'Add what you did about the out-of-range reading.';
        }
        try {
          await write('log-temperature', { point_id: point.id, temperature_c: value, note: form.note.value.trim() || null, corrective_action: corrective || null });
          shell()?.toast?.(`${point.name}: ${temperatureText(value)} logged`);
          return null;
        } catch (error) { return writeErrorText(error); }
      }
    });
    const form = dialog.form;
    const sync = () => {
      const point = points.find((entry) => String(entry.id) === form.point.value);
      const value = Number(String(form.value.value).replace(',', '.'));
      const out = form.value.value !== '' && outOfRange(point, value);
      form.querySelector('[data-ops-out]').hidden = !out;
      form.querySelector('[data-ops-corrective]').hidden = !out;
      form.querySelector('[data-ops-range-help]').textContent = `Target ${rangeText(point)}`;
    };
    form.addEventListener('input', sync);
    form.querySelector('.ops-points').addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-point]') : null;
      if (!button) return;
      form.point.value = button.dataset.point;
      form.querySelectorAll('[data-point]').forEach((node) => node.setAttribute('aria-checked', String(node === button)));
      sync();
    });
  }

  function editRange(pointId) {
    const point = temperature().points.find((entry) => String(entry.id) === String(pointId));
    if (!point) return;
    openDialog({
      title: `${point.name} target range`,
      wide: true,
      body: `<p>Atlas never invents food-safety limits; leave a value empty if there is none.</p>
        ${field('Name', `<input class="atlas-input" name="name" required maxlength="140" value="${escape(point.name)}">`)}
        ${field('Location', `<input class="atlas-input" name="location" maxlength="240" value="${escape(point.location || '')}">`)}
        <div class="atlas-grid-2">${field('Minimum (°C)', `<input class="atlas-input" name="min" type="number" inputmode="decimal" step="0.1" value="${point.min_temp_c ?? ''}">`)}${field('Maximum (°C)', `<input class="atlas-input" name="max" type="number" inputmode="decimal" step="0.1" value="${point.max_temp_c ?? ''}">`)}</div>
        <label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="active"${point.active === false ? '' : ' checked'}> Log this point every day</label>`,
      submitLabel: 'Save range',
      onSubmit: async (form) => {
        const min = form.min.value === '' ? null : Number(form.min.value);
        const max = form.max.value === '' ? null : Number(form.max.value);
        if (min != null && max != null && min > max) return 'The minimum can’t be above the maximum.';
        if (!form.name.value.trim()) return 'Add a name.';
        try {
          await write('update-temperature-point', { point_id: point.id, name: form.name.value.trim(), location: form.location.value.trim(), min_temp_c: min, max_temp_c: max, active: form.active.checked });
          return null;
        } catch (error) { return writeErrorText(error); }
      }
    });
  }

  function editTemplate(templateId) {
    const template = (state.settings?.templates || []).find((entry) => String(entry.id) === String(templateId));
    if (!template) return;
    const selected = new Set((template.days_of_week || []).map(Number));
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const time = (value) => (value ? String(value).slice(0, 5) : '');
    openDialog({
      title: `Edit ${template.name}`,
      wide: true,
      body: `${field('Name', `<input class="atlas-input" name="name" required maxlength="140" value="${escape(template.name)}">`)}
        ${field('Description', `<textarea class="atlas-input atlas-textarea" name="description" rows="2" maxlength="3000">${escape(template.description || '')}</textarea>`)}
        <fieldset class="ops-days"><legend class="atlas-label">Days</legend><div class="atlas-chips">${days.map((label, index) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="day" value="${index}"${selected.has(index) ? ' checked' : ''}> ${label}</label>`).join('')}</div></fieldset>
        <div class="atlas-grid-2">${field('Available from', `<input class="atlas-input" name="from" ${TIME_FIELD} value="${escape(time(template.available_from))}">`, 'Optional')}${field('Due by', `<input class="atlas-input" name="due" ${TIME_FIELD} value="${escape(time(template.due_time))}">`, 'Optional')}</div>
        ${field('Who does it', `<select class="atlas-select" name="role">${[['any_active_staff', 'Anyone on shift'], ['bartender', 'Bartenders'], ['manager', 'Managers'], ['admin', 'Administrators']].map(([value, label]) => `<option value="${value}"${template.assigned_role === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}
        <label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="signoff"${template.requires_manager_signoff ? ' checked' : ''}> Needs a manager to sign it off</label>
        <label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="active"${template.active ? ' checked' : ''}> Active</label>
        <p class="atlas-field__help">Changing the schedule never deletes past checklists.</p>`,
      submitLabel: 'Save routine',
      onSubmit: async (form) => {
        const chosen = [...form.querySelectorAll('input[name="day"]:checked')].map((input) => Number(input.value));
        if (!form.name.value.trim()) return 'Add a name.';
        try {
          await write('update-template', {
            template_id: template.id,
            name: form.name.value.trim(),
            description: form.description.value.trim(),
            days_of_week: chosen,
            available_from: form.from.value || null,
            due_time: form.due.value || null,
            assigned_role: form.role.value,
            active: form.active.checked,
            requires_manager_signoff: form.signoff.checked
          });
          state.settingsStatus = 'idle';
          loadSettings(true);
          return null;
        } catch (error) { return writeErrorText(error); }
      }
    });
  }

  // ---------- retired device checklist (explicit one-time import) ----------

  function storage() {
    try { return window.localStorage; } catch { return null; }
  }

  function deviceKeys() {
    const store = storage();
    if (!store) return [];
    const keys = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && (DEVICE_CHECKLIST_KEY.test(key) || DEVICE_ORDER_NOTES_KEY.test(key))) keys.push(key);
    }
    return keys;
  }

  function discardDeviceChecklist() {
    const store = storage();
    deviceKeys().forEach((key) => { try { store.removeItem(key); } catch { /* storage unavailable */ } });
    state.deviceImport = null;
  }

  // Local ticks carried no name or time and used the browser's date, so they
  // are never imported silently: a writer can tick today's ones again as
  // themselves, now. Older days and every other device key are discarded.
  function checkDeviceChecklist() {
    if (state.deviceImportChecked || state.status !== 'ready') return;
    state.deviceImportChecked = true;
    const store = storage();
    const keys = deviceKeys();
    if (!store || !keys.length) return;
    const venue = clock();
    const days = new Set([venue?.today?.(), venue?.venueDate?.()].filter(Boolean));
    const picks = [];
    keys.forEach((key) => {
      const match = DEVICE_CHECKLIST_KEY.exec(key);
      if (!match || !days.has(match[1])) return;
      let ticks = {};
      try { ticks = JSON.parse(store.getItem(key)) || {}; } catch { ticks = {}; }
      const routine = dailyChecklist(match[2]);
      (routine?.items || []).forEach((item) => {
        if (ticks[item.item_key] && !item.completed) picks.push({ routineId: routine.id, itemId: item.id });
      });
    });
    if (!picks.length || !canWrite() || !checklistEditable(dailyChecklist('opening') || dailyChecklist('closing'))) {
      discardDeviceChecklist();
      return;
    }
    state.deviceImport = { count: picks.length, picks };
  }

  async function importDeviceChecklist() {
    const pending = state.deviceImport;
    if (!pending) return;
    state.deviceImport = null;
    let failed = 0;
    for (const pick of pending.picks) {
      const ok = await tick(pick.routineId, pick.itemId, true, { evidence: IMPORT_EVIDENCE });
      if (!ok) failed += 1;
    }
    discardDeviceChecklist();
    state.pageMessage = failed
      ? { tone: 'danger', text: `${plural(failed, 'tick', 'ticks')} couldn’t be saved. Tick ${failed === 1 ? 'it' : 'them'} again in the checklist.` }
      : { tone: 'positive', text: `${plural(pending.count, 'tick was', 'ticks were')} recorded as you.` };
    render();
  }

  // ---------- events ----------

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !state.view?.contains(target)) return;
    const section = state.section;
    const tickButton = target.closest('[data-ops-tick]');
    if (tickButton && !tickButton.disabled) {
      const routine = routineById(section);
      const item = (routine?.items || []).find((entry) => String(entry.id) === tickButton.dataset.opsTick);
      if (routine && item) tick(routine.id, item.id, !item.completed);
      return;
    }
    const note = target.closest('[data-ops-note]');
    if (note) { editNote(section, note.dataset.opsNote); return; }
    if (target.closest('[data-ops-complete]')) { completeChecklist(section); return; }
    if (target.closest('[data-ops-skip]')) { skipChecklist(section); return; }
    const log = target.closest('[data-ops-log]');
    if (log) { logTemperature(log.dataset.opsLog || null); return; }
    const range = target.closest('[data-ops-range]');
    if (range) { editRange(range.dataset.opsRange); return; }
    const template = target.closest('[data-ops-template]');
    if (template) { editTemplate(template.dataset.opsTemplate); return; }
    if (target.closest('[data-ops-retry]')) { state.pageMessage = null; load({ force: true }); return; }
    if (target.closest('[data-ops-schedule-retry]')) { loadSettings(true); return; }
    if (target.closest('[data-ops-import]')) { importDeviceChecklist(); return; }
    if (target.closest('[data-ops-import-discard]')) { discardDeviceChecklist(); render(); }
  }

  function show(params = {}) {
    const section = params.section ? String(params.section) : 'today';
    const changed = section !== state.section;
    state.section = section;
    if (changed) state.pageMessage = state.pageMessage?.tone === 'positive' && section === 'today' ? state.pageMessage : null;
    if (section === 'schedule') loadSettings();
    load();
    render();
    const detail = !['today', 'temperature', 'schedule'].includes(section);
    window.AtlasChrome?.setTopBar?.(detail ? { title: routineById(section)?.name || 'Checklist', back: '#operations' } : {});
    if (detail) window.requestAnimationFrame(() => state.view?.querySelector('#ops-detail-title')?.focus({ preventScroll: true }));
  }

  // ---------- Home and notifications ----------

  // Spec §7.1 attention rows owned by Operations: checklists due, missing or
  // out-of-range temperature readings, overdue routines. Unknown stays quiet
  // (a row appears only from server data); a failed load says so once.
  function focusRows() {
    const rows = [];
    if (state.status === 'error' && state.error && !['not_configured', 'unauthorized'].includes(state.error.code)) {
      rows.push({ id: 'unavailable', severity: 'info', icon: 'list-checks', title: 'Checklists couldn’t be checked', detail: 'Anything already ticked is saved.', action: { label: 'Try again', route: '#operations' } });
      return rows;
    }
    if (state.status !== 'ready') return rows;
    const venue = clock();
    const now = new Date();
    const lastOrders = venue?.nextEvent?.(now, { types: ['last_orders', 'closes'] });
    const afterLastOrders = Boolean(lastOrders && lastOrders.type === 'closes' && lastOrders.businessDate === venue.today());
    const opening = dailyChecklist('opening');
    const closing = dailyChecklist('closing');
    const openingDue = venue?.state?.().today?.open || null;
    if (opening && !['completed', 'skipped'].includes(opening.status) && !afterLastOrders) {
      const progress = progressOf(opening);
      rows.push({
        id: `checklist:${opening.id}`,
        severity: 'warning',
        icon: 'list-checks',
        title: progress.completed ? `Opening checklist is ${progress.completed} of ${progress.required} done` : 'Opening checklist isn’t started',
        detail: [openingDue ? `Due by ${openingDue}` : null, onIt(opening)].filter(Boolean).join(' · ') || 'Shared with the team',
        action: { label: 'Open checklist', route: `#operations/${opening.id}` }
      });
    }
    if (closing && afterLastOrders && !['completed', 'skipped'].includes(closing.status)) {
      const progress = progressOf(closing);
      rows.push({
        id: `checklist:${closing.id}`,
        severity: 'warning',
        icon: 'list-checks',
        title: progress.completed ? `Closing checklist is ${progress.completed} of ${progress.required} done` : 'Closing checklist isn’t started',
        detail: lastOrders?.time ? `Close at ${lastOrders.time}` : 'Shared with the team',
        action: { label: 'Open checklist', route: `#operations/${closing.id}` }
      });
    }
    const temp = temperature();
    temp.points.filter((point) => point.latest_log?.range_status === 'outside_range').forEach((point) => {
      rows.push({
        id: `temperature-out:${point.id}`,
        severity: 'danger',
        icon: 'thermometer',
        title: `${point.name} is out of range`,
        detail: `${temperatureText(point.latest_log.temperature_c)} · target ${rangeText(point)}`,
        action: { label: 'View log', route: '#operations/temperature' }
      });
    });
    const missing = temp.points.filter((point) => !point.latest_log);
    if (missing.length === 1) {
      rows.push({ id: `temperature:${missing[0].id}`, severity: 'warning', icon: 'thermometer', title: `${missing[0].name} temperature not logged today`, detail: rangeText(missing[0]) === 'No target range yet' ? 'No reading yet today' : `Target ${rangeText(missing[0])}`, action: { label: 'Log reading', actionId: 'operations.temperature.log' }, roles: WRITE_ROLES });
      rows.push({ id: `temperature-view:${missing[0].id}`, severity: 'warning', icon: 'thermometer', title: `${missing[0].name} temperature not logged today`, detail: 'No reading yet today', action: { label: 'View log', route: '#operations/temperature' }, roles: ['viewer'] });
    } else if (missing.length > 1) {
      rows.push({ id: 'temperature:missing', severity: 'warning', icon: 'thermometer', title: `${missing.length} temperatures not logged today`, detail: missing.slice(0, 3).map((point) => point.name).join(', '), action: { label: 'Log reading', actionId: 'operations.temperature.log' }, roles: WRITE_ROLES });
      rows.push({ id: 'temperature-view:missing', severity: 'warning', icon: 'thermometer', title: `${missing.length} temperatures not logged today`, detail: missing.slice(0, 3).map((point) => point.name).join(', '), action: { label: 'View log', route: '#operations/temperature' }, roles: ['viewer'] });
    }
    otherRoutines().filter((routine) => routine.status === 'overdue').forEach((routine) => {
      rows.push({ id: `routine:${routine.id}`, severity: 'danger', icon: 'calendar-check', title: `${routine.name} is overdue`, detail: routine.due_time ? `Was due ${String(routine.due_time).slice(0, 5)}` : 'Due today', action: { label: 'Open', route: `#operations/${routine.id}` } });
    });
    otherRoutines().filter((routine) => ['scheduled', 'in_progress'].includes(routine.status)).forEach((routine) => {
      rows.push({ id: `routine:${routine.id}`, severity: 'info', icon: 'calendar-check', title: `${routine.name} is due today`, detail: routine.due_time ? `Due by ${String(routine.due_time).slice(0, 5)}` : 'Any time today', action: { label: 'Open', route: `#operations/${routine.id}` } });
    });
    return rows.map((row) => ({ roles: ALL_ROLES, ...row }));
  }

  function openTodaysChecklist() {
    const venue = clock();
    const next = venue?.nextEvent?.(new Date(), { types: ['last_orders', 'closes'] });
    const afterLastOrders = Boolean(next && next.type === 'closes' && next.businessDate === venue.today());
    const opening = dailyChecklist('opening');
    const closing = dailyChecklist('closing');
    const target = afterLastOrders ? closing : (opening && opening.status !== 'completed' ? opening : closing || opening);
    shell()?.navigate?.(target ? `#operations/${encodeURIComponent(target.id)}` : '#operations');
  }

  function registerWithShell() {
    const atlas = shell();
    if (!atlas) return;
    atlas.registerView('operations', { root: state.view, title: 'Operations', render: (params) => show(params) });
    atlas.home?.contribute?.('operations', { focusRows, order: 20 });
    atlas.actions.register({
      id: 'operations.checklist.open', label: 'Open today’s checklist', icon: 'list-checks', keywords: ['checklist', 'opening', 'closing'],
      roles: WRITE_ROLES, contexts: ['home', 'operations'],
      run: () => {
        if (state.status === 'ready') openTodaysChecklist();
        else load({ force: true }).then(openTodaysChecklist, openTodaysChecklist);
        atlas.navigate('#operations');
      }
    });
    atlas.actions.register({
      id: 'operations.temperature.log', label: 'Log temperature', icon: 'thermometer', keywords: ['temperature', 'fridge', 'freezer', 'reading'],
      roles: WRITE_ROLES, contexts: ['home', 'operations'],
      run: () => {
        atlas.navigate('#operations/temperature');
        const open = () => logTemperature(null);
        if (state.status === 'ready') open();
        else load({ force: true }).then(open, open);
      }
    });
    // Team Messages links (routine cards) open the checklist route.
    atlas.links?.register?.('routine', (key) => { atlas.navigate(key ? `#operations/${encodeURIComponent(key)}` : '#operations'); return true; });
    atlas.on('profile:ready', (profile) => { if (profile?.id) load({ force: true }); });
    atlas.onDataLoaded(() => load());
    atlas.on('venue-clock:changed', () => renderAll());
  }

  function ensureRoot() {
    if (state.view) return state.view;
    const main = document.querySelector('.atlas-content.standard-view main');
    if (!main) return null;
    let view = document.getElementById('operations-view');
    if (!view) {
      view = document.createElement('div');
      view.id = 'operations-view';
      view.style.display = 'none';
      main.insertBefore(view, document.getElementById('team-view') || null);
    }
    state.view = view;
    return view;
  }

  function init() {
    if (state.initialized) return;
    if (!ensureRoot()) return;
    state.initialized = true;
    registerWithShell();
    document.addEventListener('click', onClick);
    window.addEventListener('online', () => { if (state.status === 'error') load({ force: true }); });
    if (shell()?.profile?.()?.id) load({ force: true });
  }

  window.AtlasOperations = {
    init,
    render,
    refresh: () => load({ force: true }),
    orderSuggestions,
    readinessData,
    today: summary,
    focusRows,
    openChecklist: openTodaysChecklist,
    logTemperature: () => logTemperature(null)
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
