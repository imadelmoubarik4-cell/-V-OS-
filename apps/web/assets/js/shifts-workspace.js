// Shifts — #shifts, #shifts/month, #shifts/availability, #shifts/time-off,
// #shifts/confirmations, #shifts/activity (docs/design/Atlas_Experience_Redesign.md §7.9, §8.4).
//
// One module for the week planner and the month calendar (the former
// shifts-month-calendar.js and its tab bridge are merged here). Managers plan
// and publish; staff see their own shifts, confirm them, set availability and
// request time off. Operational dates come from AtlasVenueClock: "today" is the
// business date, a shift belongs to the business date it starts on, and a new
// shift starts at the day's saved opening time (or empty when hours are not set).
(function () {
  'use strict';
  // Date fields as YYYY-MM-DD text (AtlasVenueClock.DATE_INPUT_ATTRS): never the browser's mm/dd/yyyy.
  const DATE_FIELD = window.AtlasVenueClock?.DATE_INPUT_ATTRS || 'type="text" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="YYYY-MM-DD" data-atlas-date';
  // 24-hour time fields (AtlasVenueClock.TIME_INPUT_ATTRS): never the browser's 12-hour picker.
  const TIME_FIELD = window.AtlasVenueClock?.TIME_INPUT_ATTRS || 'type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" data-atlas-time';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 18000;
  const MANAGER_ROLES = ['admin', 'manager'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const TABS = [
    { key: 'schedule', label: 'Schedule' },
    { key: 'availability', label: 'Availability', staff: true },
    { key: 'time-off', label: 'Time off', staff: true },
    { key: 'confirmations', label: 'Confirmations', manager: true },
    { key: 'activity', label: 'Activity', manager: true }
  ];
  const RESPONSE = {
    pending: { label: 'Needs confirmation', tone: 'warning' },
    confirmed: { label: 'Confirmed', tone: 'positive' },
    change_requested: { label: 'Change requested', tone: 'warning' },
    declined: { label: 'Declined', tone: 'danger' }
  };
  const TIME_OFF_TYPES = { vacation: 'Vacation', unavailable: 'Unavailable', sick: 'Sick', other: 'Other' };
  const TIME_OFF_STATUS = { pending: ['Pending', 'warning'], approved: ['Approved', 'positive'], rejected: ['Declined', 'neutral'], cancelled: ['Cancelled', 'neutral'] };
  const EVENT_LABELS = {
    week_published: 'Week published', month_published: 'Month published', shift_saved: 'Shift saved', shift_created: 'Shift added',
    shift_updated: 'Shift changed', shift_cancelled: 'Shift removed', week_copied: 'Week copied', availability_saved: 'Availability saved',
    time_off_requested: 'Time off requested', time_off_decided: 'Time off decided', response_saved: 'Shift response', response_decided: 'Change request closed',
    person_created: 'Person added', person_updated: 'Person updated'
  };
  const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener() {} };
  const narrowQuery = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : { matches: false, addEventListener() {} };

  const state = {
    tab: 'schedule',
    mode: 'week',
    staffView: 'mine',
    showEarlier: false,
    weekStart: null,
    monthStart: null,
    week: { workspace: null, key: null, loading: false, error: null, serial: 0 },
    month: { workspace: null, key: null, loading: false, error: null, serial: 0 },
    staff: null,
    submitting: false,
    availabilityPersonId: null,
    visible: false,
    root: null,
    initialized: false,
    failedAt: 0
  };

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function icon(name) {
    return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
  }

  function paintIcons() {
    window.lucide?.createIcons?.();
  }

  function vc() {
    return window.AtlasVenueClock;
  }

  // Date keys ('YYYY-MM-DD') are calendar values; arithmetic goes through the
  // venue clock (UTC-noon keys, zone independent).
  function today() {
    return vc()?.today?.() || vc()?.venueDate?.() || new Date().toISOString().slice(0, 10);
  }

  function addDays(key, n) {
    return vc().addDays(key, n);
  }

  function mondayOf(key) {
    return vc().startOfWeek(key);
  }

  function monthStartOf(key) {
    return `${String(key).slice(0, 7)}-01`;
  }

  function addMonths(monthStart, n) {
    const [year, month] = monthStart.split('-').map(Number);
    const index = (year * 12) + (month - 1) + n;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
  }

  function weekday(key) {
    return vc().weekday(key);
  }

  function dayNumber(key) {
    return Number(String(key).slice(8, 10));
  }

  function monthName(key) {
    return MONTH_NAMES[Number(String(key).slice(5, 7)) - 1] || '';
  }

  function shortDate(key) {
    return vc().formatDate(key);
  }

  function longDate(key) {
    return vc().formatDate(key, { long: true });
  }

  // "21–27 September" / "29 September – 5 October"
  function weekRangeLabel(start) {
    const end = addDays(start, 6);
    if (start.slice(0, 7) === end.slice(0, 7)) return `${dayNumber(start)}–${dayNumber(end)} ${monthName(end)}`;
    return `${dayNumber(start)} ${monthName(start)} – ${dayNumber(end)} ${monthName(end)}`;
  }

  function monthLabel(monthStart) {
    return `${monthName(monthStart)} ${monthStart.slice(0, 4)}`;
  }

  function timeOf(local) {
    return local ? String(local).slice(11, 16) : '';
  }

  function dateOf(local) {
    return local ? String(local).slice(0, 10) : '';
  }

  function hoursOf(shift) {
    const start = new Date(shift.starts_at);
    const end = new Date(shift.ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
    return Math.max(0, ((end - start) / 3600000) - (Number(shift.break_minutes || 0) / 60));
  }

  function formatHours(value) {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} h`;
  }

  // A shift belongs to the business date it starts on (a 01:00 start before
  // the previous night's close counts for that night).
  function businessDateOf(shift) {
    return (shift.starts_at && vc()?.businessDate?.(shift.starts_at)) || dateOf(shift.starts_local);
  }

  function role() {
    return state.staff?.role || window.AtlasShell?.profile?.()?.role || window.atlasCurrentProfile?.role || null;
  }

  function workspace() {
    return state.mode === 'month' && state.tab === 'schedule' ? state.month.workspace : state.week.workspace;
  }

  function anyWorkspace() {
    return state.week.workspace || state.month.workspace;
  }

  function canManage() {
    const ws = anyWorkspace();
    if (ws?.permissions) return Boolean(ws.permissions.can_manage_schedule);
    return MANAGER_ROLES.includes(role());
  }

  function canRespond() {
    return Boolean(anyWorkspace()?.permissions?.can_respond_to_shifts);
  }

  function isViewer() {
    return role() === 'viewer';
  }

  function list(ws, key) {
    return Array.isArray(ws?.[key]) ? ws[key] : [];
  }

  function people(ws = anyWorkspace()) {
    return list(ws, 'people');
  }

  function activePeople() {
    return people().filter((person) => person.active);
  }

  function personFor(id, ws) {
    return people(ws).find((person) => person.id === id) || null;
  }

  function ownPersonId() {
    const ws = anyWorkspace();
    return ws?.actor_person_id || people().find((person) => person.profile_id && person.profile_id === (state.staff?.id || window.AtlasShell?.profile?.()?.id))?.id || null;
  }

  function nameOf(shift, ws) {
    return personFor(shift.person_id, ws)?.display_name || shift.person_name || 'Team member';
  }

  function responseFor(shift, ws) {
    return list(ws, 'responses').find((row) => row.shift_id === shift.id && row.person_id === shift.person_id) || null;
  }

  function shiftsOn(ws, dateKey) {
    return list(ws, 'shifts').filter((shift) => dateOf(shift.starts_local) === dateKey)
      .sort((a, b) => String(a.starts_local).localeCompare(String(b.starts_local)));
  }

  function publishedAt(ws) {
    return ws?.week?.published_at || null;
  }

  // Unpublished = never published, or changed after the last publication.
  function isUnpublished(shift, ws) {
    if (!canManage()) return false;
    if (shift.last_published_revision == null) return true;
    const published = publishedAt(ws);
    return Boolean(published && shift.updated_at && Date.parse(shift.updated_at) > Date.parse(published));
  }

  function warningsFor(shift, ws) {
    const warnings = [];
    const date = dateOf(shift.starts_local);
    const day = weekday(date);
    const recurring = list(ws, 'availability').find((entry) => entry.person_id === shift.person_id && Number(entry.weekday) === day);
    if (recurring?.unavailable) warnings.push('Marked unavailable on this day');
    else if (recurring) {
      const from = String(recurring.available_from || '').slice(0, 5);
      const to = String(recurring.available_to || '').slice(0, 5);
      if (from && timeOf(shift.starts_local) < from) warnings.push(`Available from ${from}`);
      if (to && dateOf(shift.ends_local) === date && timeOf(shift.ends_local) > to) warnings.push(`Available until ${to}`);
    }
    const leave = list(ws, 'time_off').find((request) => request.person_id === shift.person_id && request.status === 'approved' && request.starts_on <= date && request.ends_on >= date);
    if (leave) warnings.push(`${TIME_OFF_TYPES[leave.request_type] || 'Time off'} approved`);
    const overlap = list(ws, 'shifts').some((other) => other.id !== shift.id && other.person_id === shift.person_id
      && new Date(other.starts_at) < new Date(shift.ends_at) && new Date(other.ends_at) > new Date(shift.starts_at));
    if (overlap) warnings.push('Overlaps another shift');
    const response = responseFor(shift, ws);
    if (canManage() && response?.response === 'change_requested') warnings.push(`Change requested${response.note ? `: ${response.note}` : ''}`);
    return warnings;
  }

  function avatarTint(key) {
    let hash = 0;
    for (const character of String(key || 'x')) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
    return `atlas-avatar--${'abcd'[hash % 4]}`;
  }

  function initials(value) {
    return String(value || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || '?';
  }

  function avatar(person, size = 'atlas-avatar--sm') {
    const name = person?.display_name || 'Team member';
    const photo = person?.profile_id ? window.AtlasTeamProfilePhotos?.photoFor?.(person.profile_id) : null;
    return `<span class="atlas-avatar ${size} ${avatarTint(person?.id || name)}" aria-hidden="true">${photo?.signed_url ? `<img src="${escapeHtml(photo.signed_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(initials(name))}</span>`;
  }

  function pill(label, tone = 'neutral') {
    return `<span class="atlas-pill atlas-pill--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
  }

  // ---------- API ----------

  function endpoint() {
    return String(cfg.SHIFTS_API || '').trim();
  }

  class ShiftsError extends Error {
    constructor(message, status) { super(message); this.status = status; this.atlasFixed = true; }
  }
  // Only this module's own fixed copy (atlasFixed) is shown; a JavaScript error
  // or server text reads as the fallback (AtlasApi.message).
  function shown(error, fallback) {
    if (window.AtlasApi?.message) return window.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }

  // Fixed copy only (AtlasApi, atlas-api.js): server text is never shown,
  // whatever its length or wording.
  const API_MESSAGES = {
    auth: 'Your session has ended. Sign in again to see shifts.',
    forbidden: 'Your role can’t do that in Shifts.',
    not_found: 'That shift isn’t available any more. Refresh and try again.',
    conflict: 'This week changed while you were working. Refresh and try again.',
    invalid: 'Shifts couldn’t accept that. Check the details and try again.',
    unavailable: 'Shifts are temporarily unavailable.',
    failed: 'Shifts are temporarily unavailable.'
  };

  function friendlyError(status, message) {
    const api = window.AtlasApi;
    return api ? api.friendlyMessage(api.kindFor(status, null), null, API_MESSAGES) : 'Shifts are temporarily unavailable.';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, options = {}) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new ShiftsError('Shifts are not set up for this Atlas yet.', 0);
    const session = await activeSession();
    if (!session?.access_token) throw new ShiftsError('Sign in again to see shifts.', 401);

    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new ShiftsError(friendlyError(response.status, payload.error), response.status);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new ShiftsError('Shifts took too long to answer. Check the connection and try again.', 0);
      if (error instanceof ShiftsError) throw error;
      throw new ShiftsError('Shifts couldn’t be reached. Check the connection and try again.', 0);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function loadWeek(options = {}) {
    // Search ("who works tomorrow?") and Home may ask before Shifts has opened.
    if (!state.weekStart) state.weekStart = mondayOf(today());
    const key = state.weekStart;
    if (!key) return;
    if (!options.force && state.week.key === key && state.week.workspace) return;
    const slot = state.week;
    const serial = ++slot.serial;
    slot.loading = true;
    if (!options.silent) slot.error = null;
    if (slot.key !== key) slot.workspace = null;
    paint();
    try {
      const payload = await api('snapshot', { params: { week_start: key } });
      if (serial !== slot.serial) return;
      if (!payload?.workspace) throw new ShiftsError('Shifts are temporarily unavailable.', 0);
      slot.workspace = payload.workspace;
      slot.key = key;
      state.staff = payload.staff || state.staff;
      slot.error = null;
      state.failedAt = 0;
      publishToday();
    } catch (error) {
      if (serial !== slot.serial) return;
      slot.error = shown(error, 'Shifts couldn’t be loaded. Your rota is safe; check the connection and try again.');
      state.failedAt = Date.now();
    } finally {
      if (serial === slot.serial) {
        slot.loading = false;
        paint();
      }
    }
  }

  async function loadMonth(options = {}) {
    const key = state.monthStart;
    if (!key) return;
    if (!options.force && state.month.key === key && state.month.workspace) return;
    const slot = state.month;
    const serial = ++slot.serial;
    slot.loading = true;
    if (!options.silent) slot.error = null;
    if (slot.key !== key) slot.workspace = null;
    paint();
    try {
      const payload = await api('month-snapshot', { params: { month_start: key } });
      if (serial !== slot.serial) return;
      if (!payload?.workspace) throw new ShiftsError('Shifts are temporarily unavailable.', 0);
      slot.workspace = payload.workspace;
      slot.key = key;
      state.staff = payload.staff || state.staff;
      slot.error = null;
    } catch (error) {
      if (serial !== slot.serial) return;
      slot.error = shown(error, 'Shifts couldn’t be loaded. Your rota is safe; check the connection and try again.');
    } finally {
      if (serial === slot.serial) {
        slot.loading = false;
        paint();
      }
    }
  }

  // Every change is saved against the view it came from; the other view is
  // marked stale so it reloads when opened.
  async function mutate(action, body, successMessage, options = {}) {
    if (state.submitting) return false;
    state.submitting = true;
    const monthMode = options.month ?? (state.mode === 'month' && state.tab === 'schedule');
    try {
      const payload = await api(action, {
        method: 'POST',
        body: monthMode ? { current_month: state.monthStart, ...body } : { current_week: state.weekStart, ...body }
      });
      state.staff = payload.staff || state.staff;
      const ws = payload.workspace || null;
      if (ws?.month) {
        state.month.workspace = ws;
        state.month.key = ws.month.month_start || state.monthStart;
        state.week.key = null;
      } else if (ws?.week) {
        if (ws.week.week_start === state.weekStart) {
          state.week.workspace = ws;
          state.week.key = state.weekStart;
        } else {
          state.week.key = null;
        }
        state.month.key = null;
      }
      state.week.error = null;
      state.month.error = null;
      if (successMessage) window.AtlasShell?.toast?.(successMessage);
      publishToday();
      return true;
    } catch (error) {
      window.AtlasShell?.toast?.(shown(error, 'The change couldn’t be saved. Nothing was changed; try again.'));
      if (options.throwOnError) throw error;
      return false;
    } finally {
      state.submitting = false;
      paint();
      if (state.tab === 'schedule' && state.mode === 'week' && state.week.key !== state.weekStart) loadWeek({ force: true, silent: true });
      if (state.tab === 'schedule' && state.mode === 'month' && state.month.key !== state.monthStart) loadMonth({ force: true, silent: true });
      if (state.tab !== 'schedule' && state.week.key !== state.weekStart) loadWeek({ force: true, silent: true });
    }
  }

  // ---------- layers (AtlasModal sheets and dialogs) ----------

  // Layers and dialogs are the shared AtlasModal ones (modal.js).
  function openLayer({ id, panel, onClose, initialFocus }) {
    const root = window.AtlasModal.layer({ id, panel, className: 'shifts-layer', onClose, initialFocus });
    paintIcons();
    return root;
  }

  function closeLayer(root) {
    if (root) window.AtlasModal.dismiss(root);
  }

  // Resolves { value } (the note when `field` is given) or null when dismissed.
  function confirmDialog({ title, body, confirmLabel, danger = false, field = null }) {
    const options = { id: 'shifts-confirm', title, body, confirmLabel, danger };
    if (!field) return window.AtlasModal.confirm(options).then((ok) => (ok ? { value: '' } : null));
    return window.AtlasModal.prompt({ ...options, label: field.label, value: field.value, placeholder: field.placeholder, required: field.required, maxLength: 3000 })
      .then((value) => (value === null ? null : { value }));
  }

  // ---------- shift editor ----------

  // New shifts start at the day's saved opening time; without saved hours the
  // start is left empty and the manager enters it (no invented service hours).
  function defaultStart(dateKey) {
    const window_ = vc()?.dayWindow?.(dateKey);
    if (window_?.state === 'open' && window_.open) return { time: vc().formatTime(window_.open), note: '' };
    if (window_?.state === 'closed') return { time: '', note: 'The venue is closed on this day — enter a start time.' };
    if (window_?.state === 'not_set') return { time: '', note: 'Business hours are not set — enter a start time.' };
    return { time: '', note: 'Opening hours are unavailable — enter a start time.' };
  }

  function openShiftEditor({ date, shift = null } = {}) {
    if (!canManage()) return;
    const ws = workspace() || anyWorkspace();
    const dateKey = shift ? dateOf(shift.starts_local) : (date || today());
    const start = shift ? { time: timeOf(shift.starts_local), note: '' } : defaultStart(dateKey);
    const end = shift ? timeOf(shift.ends_local) : '';
    const options = people(ws).filter((person) => person.active || person.id === shift?.person_id)
      .map((person) => `<option value="${escapeHtml(person.id)}" ${person.id === shift?.person_id ? 'selected' : ''}>${escapeHtml(person.display_name)}${person.login_enabled ? '' : ' (schedule only)'}</option>`).join('');
    const root = openLayer({
      id: 'shifts-editor',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="shifts-editor-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="shifts-editor-title">${shift ? 'Edit shift' : 'Add shift'}</h2><p class="atlas-sheet__desc">Saved as a draft. The team sees it after you publish.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="shifts-editor-form" data-shifts-shift-form novalidate>
          <input type="hidden" name="shift_id" value="${escapeHtml(shift?.id || '')}">
          <div class="atlas-field"><label for="shift-person">Person</label><select class="atlas-select" id="shift-person" name="person_id" required><option value="" ${shift ? '' : 'selected'} disabled>Choose a person</option>${options}</select><p class="error" data-error-for="person_id" hidden>Choose who works this shift.</p></div>
          <div class="atlas-field"><label for="shift-role">Role <span class="optional">Optional</span></label><input class="atlas-input" id="shift-role" name="role_name" maxlength="120" value="${escapeHtml(shift?.role_name || '')}" placeholder="Bartender, opening, closing"></div>
          <div class="atlas-field"><label for="shift-date">Date</label><input class="atlas-input" ${DATE_FIELD} id="shift-date" name="date" required value="${escapeHtml(dateKey)}"></div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="shift-start">Start</label><input class="atlas-input" ${TIME_FIELD} id="shift-start" name="start" required value="${escapeHtml(start.time)}"></div>
            <div class="atlas-field"><label for="shift-end">End</label><input class="atlas-input" ${TIME_FIELD} id="shift-end" name="end" required value="${escapeHtml(end)}"></div>
          </div>
          <p class="help shifts-editor__hint" data-shifts-start-note ${start.note ? '' : 'hidden'}>${escapeHtml(start.note)}</p>
          <p class="help shifts-editor__hint" data-shifts-next-day hidden>Ends the next day.</p>
          <p class="error" data-error-for="time" hidden>Enter a start and an end time. The end can’t be the same as the start.</p>
          <div class="atlas-field"><label for="shift-break">Break <span class="optional">Minutes</span></label><input class="atlas-input" type="number" id="shift-break" name="break_minutes" min="0" max="720" step="5" inputmode="numeric" value="${Number(shift?.break_minutes || 0)}"></div>
          <div class="atlas-field"><label for="shift-note">Note <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="shift-note" name="note" rows="3" maxlength="3000" placeholder="Opening duties, handover, a special event">${escapeHtml(shift?.note || '')}</textarea></div>
        </form>
        <footer class="atlas-sheet__foot">
          ${shift ? `<button type="button" class="atlas-btn atlas-btn--danger atlas-sheet__foot-start" data-shifts-remove="${escapeHtml(shift.id)}">Remove shift</button>` : ''}
          <button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button>
          <button type="submit" form="shifts-editor-form" class="atlas-btn atlas-btn--primary">${shift ? 'Save shift' : 'Add shift'}</button>
        </footer>
      </section>`
    });
    const form = root.querySelector('#shifts-editor-form');
    const syncNextDay = () => {
      const s = form.start.value;
      const e = form.end.value;
      root.querySelector('[data-shifts-next-day]').hidden = !(s && e && e < s);
    };
    form.addEventListener('input', (event) => {
      if (event.target.name === 'date' && !form.shift_id.value && !form.start.value) {
        const next = defaultStart(form.date.value);
        form.start.value = next.time;
        const note = root.querySelector('[data-shifts-start-note]');
        note.textContent = next.note;
        note.hidden = !next.note;
      }
      syncNextDay();
    });
    syncNextDay();
    root.querySelector('[data-shifts-remove]')?.addEventListener('click', async () => {
      closeLayer(root);
      removeShift(shift);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const person = form.person_id.value;
      const dateValue = form.date.value;
      const startValue = form.start.value;
      const endValue = form.end.value;
      const personError = root.querySelector('[data-error-for="person_id"]');
      const timeError = root.querySelector('[data-error-for="time"]');
      personError.hidden = Boolean(person);
      form.person_id.setAttribute('aria-invalid', String(!person));
      const timesOk = Boolean(dateValue && startValue && endValue && startValue !== endValue);
      timeError.hidden = timesOk;
      form.start.setAttribute('aria-invalid', String(!startValue));
      form.end.setAttribute('aria-invalid', String(!endValue || startValue === endValue));
      if (!person || !timesOk) {
        (!person ? form.person_id : !startValue ? form.start : form.end).focus();
        return;
      }
      const endDate = endValue < startValue ? addDays(dateValue, 1) : dateValue;
      const submit = root.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.classList.add('is-loading');
      submit.setAttribute('aria-busy', 'true');
      const ok = await mutate('save-shift', {
        week_start: mondayOf(dateValue),
        shift_id: form.shift_id.value || null,
        person_id: person,
        role_name: form.role_name.value.trim() || null,
        starts_local: `${dateValue}T${startValue}`,
        ends_local: `${endDate}T${endValue}`,
        break_minutes: Number(form.break_minutes.value || 0),
        note: form.note.value.trim() || null
      }, shift ? 'Shift saved as a draft' : 'Shift added as a draft');
      if (ok) closeLayer(root);
      else {
        submit.disabled = false;
        submit.classList.remove('is-loading');
        submit.removeAttribute('aria-busy');
      }
    });
  }

  async function removeShift(shift) {
    if (!shift) return;
    const answer = await confirmDialog({
      title: 'Remove this shift?',
      body: `${nameOf(shift)} · ${longDate(dateOf(shift.starts_local))}, ${timeOf(shift.starts_local)}–${timeOf(shift.ends_local)}. The team keeps seeing the published version until you publish again.`,
      confirmLabel: 'Remove shift',
      danger: true
    });
    if (!answer) return;
    mutate('cancel-shift', { shift_id: shift.id }, 'Shift removed from the draft');
  }

  // ---------- rendering ----------

  function ensureRoot() {
    const element = document.getElementById('shifts-view');
    if (!element) return null;
    if (element.classList.contains('placeholder-view')) element.classList.remove('placeholder-view');
    element.classList.add('shifts-host');
    state.root = element;
    return element;
  }

  function visibleTabs() {
    if (isViewer()) return TABS.filter((tab) => tab.key === 'schedule');
    return TABS.filter((tab) => (!tab.manager || canManage()));
  }

  function summaryText() {
    const ws = state.week.workspace;
    if (state.tab === 'schedule' && state.mode === 'month') {
      const month = state.month.workspace;
      if (!month) return monthLabel(state.monthStart);
      const shifts = list(month, 'shifts');
      const hours = shifts.reduce((total, shift) => total + hoursOf(shift), 0);
      return [monthLabel(state.monthStart), `${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'}`, formatHours(hours)].join(' · ');
    }
    const parts = [weekRangeLabel(state.weekStart)];
    if (ws && state.week.key === state.weekStart) {
      const shifts = list(ws, 'shifts');
      if (canManage()) {
        const hours = shifts.reduce((total, shift) => total + hoursOf(shift), 0);
        parts.push(`${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'}`, formatHours(hours));
        const awaiting = list(ws, 'responses').filter((row) => row.response === 'pending').length;
        if (awaiting) parts.push(`${awaiting} awaiting confirmation`);
      } else {
        const mine = shifts.filter((shift) => shift.person_id === ownPersonId());
        parts.push(`${mine.length} ${mine.length === 1 ? 'shift' : 'shifts'} for you`);
        const toConfirm = mine.filter((shift) => (responseFor(shift, ws)?.response || 'pending') === 'pending').length;
        if (toConfirm && canRespond()) parts.push(`${toConfirm} to confirm`);
      }
    }
    return parts.join(' · ');
  }

  function publishState() {
    const month = state.mode === 'month';
    const ws = month ? state.month.workspace : state.week.workspace;
    const info = month ? ws?.month : ws?.week;
    if (!ws || !info) return null;
    const shifts = list(ws, 'shifts');
    const changed = shifts.filter((shift) => isUnpublished(shift, ws)).length;
    const published = info.status === 'published' || Boolean(info.latest_publication);
    const pending = Boolean(info.has_unpublished_changes) || (!published && shifts.length > 0);
    return { published, pending, changed, revision: Number(info.revision || info.latest_publication?.revision || 0), empty: !shifts.length };
  }

  function statusMarkup() {
    const info = publishState();
    if (!info) return '';
    if (!canManage()) return info.published ? pill('Published', 'positive') : '';
    if (!info.published) return info.empty ? pill('Draft') : pill('Draft · not visible to the team', 'warning');
    if (info.pending) return pill('Unpublished changes', 'warning');
    return pill('Published', 'positive');
  }

  function headerMarkup() {
    const schedule = state.tab === 'schedule';
    const month = state.mode === 'month';
    const info = canManage() && schedule ? publishState() : null;
    const publishLabel = month ? 'Publish month' : 'Publish week';
    const publishDisabled = !info || !info.pending || info.empty || state.submitting;
    const caption = !info ? '' : info.empty ? '' : info.pending
      ? (info.changed ? `${info.changed} ${info.changed === 1 ? 'shift' : 'shifts'} changed since publishing` : 'Changes not published')
      : 'No changes to publish';
    const nav = schedule ? `<div class="shifts-nav" role="group" aria-label="${month ? 'Month' : 'Week'}">
        <button type="button" class="atlas-icon-btn" data-shifts-step="-1" aria-label="Previous ${month ? 'month' : 'week'}">${icon('chevron-left')}</button>
        <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-today>Today</button>
        <button type="button" class="atlas-icon-btn" data-shifts-step="1" aria-label="Next ${month ? 'month' : 'week'}">${icon('chevron-right')}</button>
      </div>
      <div class="atlas-segmented" role="group" aria-label="Calendar view"><button type="button" data-shifts-mode="week" aria-pressed="${!month}">Week</button><button type="button" data-shifts-mode="month" aria-pressed="${month}">Month</button></div>` : '';
    const primary = info && !info.empty ? `<div class="shifts-publish">${caption ? `<span class="shifts-publish__caption" id="shifts-publish-caption">${escapeHtml(caption)}</span>` : ''}<button type="button" class="atlas-btn atlas-btn--primary" data-shifts-publish ${publishDisabled ? 'disabled' : ''}${caption ? ' aria-describedby="shifts-publish-caption"' : ''}>${icon('send')}${publishLabel}</button></div>` : '';
    return `<header class="page-head shifts-head">
      <div class="page-head__text"><h1 class="page-head__title">Shifts</h1><p class="page-head__sub" data-shifts-summary>${escapeHtml(summaryText())}</p></div>
      ${nav || primary ? `<div class="page-head__actions shifts-head__actions">${nav}${primary}</div>` : ''}
    </header>`;
  }

  function tabsMarkup() {
    const tabs = visibleTabs();
    if (tabs.length < 2) return '';
    const ws = workspace() || anyWorkspace();
    const openRequests = canManage() ? list(ws, 'responses').filter((row) => row.manager_status === 'open').length : 0;
    const pendingLeave = canManage() ? list(ws, 'time_off').filter((row) => row.status === 'pending').length : 0;
    return `<nav class="atlas-tabs shifts-tabs" aria-label="Shifts sections">${tabs.map((tab) => {
      const count = tab.key === 'confirmations' ? openRequests : tab.key === 'time-off' ? pendingLeave : 0;
      const href = tab.key === 'schedule' ? (state.mode === 'month' ? '#shifts/month' : '#shifts') : `#shifts/${tab.key}`;
      return `<a href="${href}" data-shifts-tab="${tab.key}" ${state.tab === tab.key ? 'aria-current="page"' : ''}>${escapeHtml(tab.label)}${count ? ` <span class="count">${count}</span>` : ''}</a>`;
    }).join('')}</nav>`;
  }

  function alertMarkup(slot) {
    if (!slot.error) return '';
    return `<div class="atlas-alert atlas-alert--danger shifts-alert" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Shifts couldn’t be ${slot.workspace ? 'updated' : 'loaded'}.</p><p class="atlas-alert__body">${escapeHtml(slot.error)} ${slot.workspace ? 'You’re seeing the last schedule that loaded.' : 'Nothing has changed.'}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-retry>Try again</button></div></div>`;
  }

  function skeletonMarkup(kind = 'grid') {
    if (kind === 'list') return `<div class="shifts-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(5)}<span class="sr-only">Loading shifts</span></div>`;
    return `<div class="shifts-skel shifts-skel--grid" aria-busy="true">${'<div class="atlas-skel atlas-skel--block"></div>'.repeat(4)}<span class="sr-only">Loading shifts</span></div>`;
  }

  // "Who's on": today and tomorrow by business date (AtlasVenueClock).
  function whoIsOn(dateKey, ws = state.week.workspace) {
    return list(ws, 'shifts').filter((shift) => businessDateOf(shift) === dateKey)
      .sort((a, b) => String(a.starts_local).localeCompare(String(b.starts_local)))
      .map((shift) => ({ id: shift.id, personId: shift.person_id, name: nameOf(shift, ws), role: shift.role_name || '', start: timeOf(shift.starts_local), end: timeOf(shift.ends_local) }));
  }

  function onNowMarkup(ws) {
    // Phones show the day list, where today is marked; the strip is for wider screens.
    if (phoneQuery.matches) return '';
    const days = [[today(), 'Today'], [addDays(today(), 1), 'Tomorrow']]
      .filter(([key]) => key >= state.weekStart && key <= addDays(state.weekStart, 6));
    if (!days.length) return '';
    return `<section class="shifts-now" aria-label="Who is working">${days.map(([key, label]) => {
      const rows = whoIsOn(key, ws);
      return `<div class="shifts-now__day"><p class="shifts-now__label">${label} <span>${escapeHtml(shortDate(key))}</span></p>${rows.length
        ? `<p class="shifts-now__people">${rows.map((row) => `<span class="shifts-now__person">${avatar(personFor(row.personId, ws))}${escapeHtml(row.name.split(' ')[0])} <span class="num">${escapeHtml(row.start)}–${escapeHtml(row.end)}</span></span>`).join('')}</p>`
        : `<p class="shifts-now__none">${canManage() ? 'No one scheduled' : 'No published shifts'}</p>`}</div>`;
    }).join('')}${canManage() || canRespond() ? '<a class="atlas-btn atlas-btn--ghost atlas-btn--sm shifts-now__handover" href="#messages/shift-handover">' + icon('notebook-pen') + 'Handover</a>' : ''}</section>`;
  }

  // One word for a chip's warnings; the full text is the chip's title and label.
  function warningWord(warnings) {
    if (warnings.length > 1) return `${warnings.length} issues`;
    const text = warnings[0] || '';
    if (/overlap/i.test(text)) return 'Overlap';
    if (/unavailable|available/i.test(text)) return 'Not free';
    if (/change requested/i.test(text)) return 'Change';
    return 'Time off';
  }

  function chipMarkup(shift, ws) {
    const warnings = warningsFor(shift, ws);
    const unpublished = isUnpublished(shift, ws);
    const response = responseFor(shift, ws);
    const responseText = response ? RESPONSE[response.response]?.label || '' : (canManage() && !unpublished ? 'Not confirmed yet' : '');
    const label = `${nameOf(shift, ws)}, ${longDate(dateOf(shift.starts_local))}, ${timeOf(shift.starts_local)} to ${timeOf(shift.ends_local)}${shift.role_name ? `, ${shift.role_name}` : ''}${unpublished ? ', not published' : ''}${responseText ? `, ${responseText}` : ''}${warnings.length ? `. ${warnings.join('. ')}` : ''}`;
    const tag = canManage() ? 'button type="button"' : 'div';
    const close = canManage() ? 'button' : 'div';
    return `<${tag} class="shift-chip${unpublished ? ' is-unpublished' : ''}${warnings.length ? ' has-warning' : ''}" ${canManage() ? `data-shifts-edit="${escapeHtml(shift.id)}"` : ''} aria-label="${escapeHtml(label)}" ${warnings.length ? `title="${escapeHtml(warnings.join(' · '))}"` : ''}>
      <span class="shift-chip__time num">${escapeHtml(timeOf(shift.starts_local))}–${escapeHtml(timeOf(shift.ends_local))}</span>
      ${shift.role_name ? `<span class="shift-chip__role">${escapeHtml(shift.role_name)}</span>` : ''}
      ${warnings.length ? `<span class="shift-chip__warn">${icon('triangle-alert')}<span>${escapeHtml(warningWord(warnings))}</span></span>` : ''}
    </${close}>`;
  }

  function weekGridMarkup(ws) {
    const days = [0, 1, 2, 3, 4, 5, 6].map((index) => addDays(state.weekStart, index));
    const shifts = list(ws, 'shifts');
    const manage = canManage();
    const personIds = new Set(shifts.map((shift) => shift.person_id));
    const rows = people(ws).filter((person) => person.active || personIds.has(person.id))
      .filter((person) => manage || personIds.has(person.id));
    const current = today();
    const head = `<div class="shifts-grid__row shifts-grid__row--head" role="row">
      <div class="shifts-grid__corner" role="columnheader"><span class="sr-only">Person</span></div>
      ${days.map((key) => `<div class="shifts-grid__day${key === current ? ' is-today' : ''}" role="columnheader" ${key === current ? 'aria-current="date"' : ''}><span>${escapeHtml(DAY_NAMES[weekday(key)].slice(0, 3))}</span> <span class="num">${dayNumber(key)}</span>${key === current ? '<span class="sr-only"> (today)</span>' : ''}</div>`).join('')}
    </div>`;
    const body = rows.map((person) => {
      const personShifts = shifts.filter((shift) => shift.person_id === person.id);
      const hours = personShifts.reduce((total, shift) => total + hoursOf(shift), 0);
      return `<div class="shifts-grid__row" role="row">
        <div class="shifts-grid__person" role="rowheader">${avatar(person)}<span class="shifts-grid__name"><span class="shifts-grid__display">${escapeHtml(person.display_name)}</span><span class="shifts-grid__hours num">${personShifts.length ? formatHours(hours) : manage ? 'No shifts' : ''}</span></span></div>
        ${days.map((key) => {
          const cell = personShifts.filter((shift) => dateOf(shift.starts_local) === key).sort((a, b) => a.starts_local.localeCompare(b.starts_local));
          const leave = list(ws, 'time_off').find((request) => request.person_id === person.id && request.status === 'approved' && request.starts_on <= key && request.ends_on >= key);
          return `<div class="shifts-grid__cell${key === current ? ' is-today' : ''}" role="cell">${cell.map((shift) => chipMarkup(shift, ws)).join('')}${leave && !cell.length ? `<span class="shifts-grid__leave">${escapeHtml(TIME_OFF_TYPES[leave.request_type] || 'Time off')}</span>` : ''}${manage ? `<button type="button" class="shifts-grid__add" data-shifts-add="${escapeHtml(key)}" data-shifts-person="${escapeHtml(person.id)}" aria-label="Add a shift for ${escapeHtml(person.display_name)} on ${escapeHtml(longDate(key))}">${icon('plus')}</button>` : ''}</div>`;
        }).join('')}
      </div>`;
    }).join('');
    return `<div class="shifts-grid" role="table" aria-label="Week of ${escapeHtml(weekRangeLabel(state.weekStart))}">${head}${body}</div>`;
  }

  function dayListMarkup(ws, options = {}) {
    const days = [0, 1, 2, 3, 4, 5, 6].map((index) => addDays(state.weekStart, index));
    const manage = canManage();
    const current = today();
    const hidePast = options.mine && !state.showEarlier && state.weekStart <= current && current <= addDays(state.weekStart, 6);
    const earlier = hidePast
      ? days.filter((key) => key < current && shiftsOn(ws, key).some((shift) => shift.person_id === ownPersonId())).length : 0;
    return `<div class="shifts-days">${earlier ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm shifts-days__earlier" data-shifts-earlier>${icon('chevron-up')}Show earlier this week (${earlier})</button>` : ''}${days.map((key) => {
      const entries = shiftsOn(ws, key).filter((shift) => !options.mine || shift.person_id === ownPersonId());
      if (options.mine && !entries.length) return '';
      if (hidePast && key < current) return '';
      return `<section class="shifts-day" aria-labelledby="shifts-day-${key}">
        <header class="shifts-day__head"><h3 class="shifts-day__title" id="shifts-day-${key}">${escapeHtml(longDate(key))}</h3>${key === current ? pill('Today', 'info') : ''}${manage && !options.mine ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm shifts-day__add" data-shifts-add="${escapeHtml(key)}">${icon('plus')}Add shift</button>` : ''}</header>
        ${entries.length ? `<ul class="atlas-list shifts-day__list">${entries.map((shift) => shiftRowMarkup(shift, ws, options)).join('')}</ul>` : `<p class="shifts-day__empty">${manage ? 'No shifts yet.' : 'No shifts.'}</p>`}
      </section>`;
    }).join('')}</div>`;
  }

  function shiftRowMarkup(shift, ws, options = {}) {
    const manage = canManage();
    const response = responseFor(shift, ws);
    const own = shift.person_id === ownPersonId();
    const status = RESPONSE[response?.response || 'pending'];
    const warnings = manage ? warningsFor(shift, ws) : [];
    const unpublished = isUnpublished(shift, ws);
    const colleagues = options.mine ? whoIsOn(businessDateOf(shift), ws).filter((row) => row.personId !== shift.person_id) : [];
    const showConfirm = own && canRespond() && !manage && (response?.response || 'pending') === 'pending';
    const meta = [
      options.mine ? null : nameOf(shift, ws),
      shift.role_name,
      Number(shift.break_minutes || 0) ? `${Number(shift.break_minutes)} min break` : null,
      shift.note
    ].filter(Boolean).join(' · ');
    return `<li class="atlas-row shifts-row${unpublished ? ' is-unpublished' : ''}" data-shift-id="${escapeHtml(shift.id)}">
      <div class="atlas-row__body">
        <p class="atlas-row__title shifts-row__time num">${escapeHtml(timeOf(shift.starts_local))}–${escapeHtml(timeOf(shift.ends_local))}${options.mine ? '' : `<span class="shifts-row__name">${escapeHtml(nameOf(shift, ws))}</span>`}</p>
        ${meta && options.mine ? `<p class="atlas-row__meta">${escapeHtml(meta)}</p>` : meta && !options.mine ? `<p class="atlas-row__meta">${escapeHtml([shift.role_name, shift.note].filter(Boolean).join(' · '))}</p>` : ''}
        ${warnings.length ? `<p class="atlas-row__meta shifts-row__warn">${icon('triangle-alert')}${escapeHtml(warnings.join(' · '))}</p>` : ''}
        ${colleagues.length ? `<p class="shifts-row__with"><span class="sr-only">Working with </span>${colleagues.slice(0, 4).map((row) => avatar(personFor(row.personId, ws))).join('')}<span class="atlas-row__meta">with ${escapeHtml(colleagues.map((row) => row.name.split(' ')[0]).join(', '))}</span></p>` : ''}
      </div>
      <div class="atlas-row__end">
        ${unpublished ? pill('Not published', 'warning') : (own || manage) && (response || own) ? pill(status.label, status.tone) : ''}
        ${showConfirm ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-respond="confirmed" data-shift-id="${escapeHtml(shift.id)}">Confirm</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-shifts-respond="change_requested" data-shift-id="${escapeHtml(shift.id)}">Request change</button>` : ''}
        ${manage ? `<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-shifts-edit="${escapeHtml(shift.id)}" aria-label="Edit ${escapeHtml(nameOf(shift, ws))}'s shift">${icon('pencil')}</button>` : ''}
      </div>
    </li>`;
  }

  function weekEmptyMarkup() {
    if (canManage()) {
      return `<div class="atlas-empty shifts-empty"><div class="atlas-empty__icon">${icon('calendar-plus')}</div><h3 class="atlas-empty__title">No shifts this week</h3><p class="atlas-empty__text">Start from last week’s schedule or add shifts one by one. Nothing is visible to the team until you publish.</p><div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-shifts-copy>${icon('copy')}Copy last week</button><button type="button" class="atlas-btn atlas-btn--secondary" data-shifts-add="${escapeHtml(state.weekStart <= today() && today() <= addDays(state.weekStart, 6) ? today() : state.weekStart)}">${icon('plus')}Add shift</button></div></div>`;
    }
    return `<div class="atlas-empty shifts-empty"><div class="atlas-empty__icon">${icon('calendar')}</div><h3 class="atlas-empty__title">No published shifts this week</h3><p class="atlas-empty__text">Your manager hasn’t published this week yet. Published shifts appear here.</p></div>`;
  }

  function staffScheduleMarkup(ws) {
    const mine = list(ws, 'shifts').filter((shift) => shift.person_id === ownPersonId());
    const toggle = `<div class="atlas-segmented shifts-staff-toggle" role="group" aria-label="Whose shifts"><button type="button" data-shifts-staff-view="mine" aria-pressed="${state.staffView === 'mine'}">Mine</button><button type="button" data-shifts-staff-view="team" aria-pressed="${state.staffView === 'team'}">Team</button></div>`;
    let content;
    if (!list(ws, 'shifts').length) content = weekEmptyMarkup();
    else if (state.staffView === 'mine') {
      content = mine.length ? dayListMarkup(ws, { mine: true }) + (!state.showEarlier && state.weekStart <= today() && today() <= addDays(state.weekStart, 6) && !mine.some((shift) => dateOf(shift.starts_local) >= today()) ? `<p class="shifts-day__empty">No more shifts for you this week.</p>` : '')
        : `<div class="atlas-empty shifts-empty"><div class="atlas-empty__icon">${icon('calendar')}</div><h3 class="atlas-empty__title">No shifts for you this week</h3><p class="atlas-empty__text">${ownPersonId() ? 'You’re not on the published schedule this week.' : 'Your account isn’t linked to the shift roster yet. Ask a manager to add you.'}</p><div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-shifts-staff-view="team">See the team’s week</button></div></div>`;
    } else content = narrowQuery.matches ? dayListMarkup(ws) : weekGridMarkup(ws);
    return `<div class="atlas-toolbar shifts-toolbar">${toggle}${statusMarkup()}</div>${onNowMarkup(ws)}${content}`;
  }

  function weekScheduleMarkup() {
    const slot = state.week;
    const ws = slot.key === state.weekStart ? slot.workspace : null;
    if (!ws) return `${alertMarkup(slot)}${slot.error && !slot.loading ? '' : skeletonMarkup(narrowQuery.matches ? 'list' : 'grid')}`;
    if (!canManage()) return `${alertMarkup(slot)}${staffScheduleMarkup(ws)}`;
    const content = list(ws, 'shifts').length ? (narrowQuery.matches ? dayListMarkup(ws) : weekGridMarkup(ws)) : weekEmptyMarkup();
    return `${alertMarkup(slot)}<div class="atlas-toolbar shifts-toolbar">${statusMarkup()}<span class="shifts-toolbar__legend">${list(ws, 'shifts').some((shift) => isUnpublished(shift, ws)) ? '<span class="shift-chip shift-chip--legend is-unpublished" aria-hidden="true"></span>Dashed: not published yet' : ''}</span><div class="atlas-toolbar__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-add="${escapeHtml(state.weekStart <= today() && today() <= addDays(state.weekStart, 6) ? today() : state.weekStart)}">${icon('plus')}Add shift</button></div></div>${onNowMarkup(ws)}${content}`;
  }

  function monthScheduleMarkup() {
    const slot = state.month;
    const ws = slot.key === state.monthStart ? slot.workspace : null;
    if (!ws) return `${alertMarkup(slot)}${slot.error && !slot.loading ? '' : skeletonMarkup()}`;
    const first = state.monthStart;
    const last = addDays(addMonths(first, 1), -1);
    const gridStart = mondayOf(first);
    const gridEnd = addDays(mondayOf(last), 6);
    const current = today();
    const manage = canManage();
    const mineOnly = !manage;
    const own = ownPersonId();
    const cells = [];
    for (let key = gridStart; key <= gridEnd; key = addDays(key, 1)) cells.push(key);
    const cellMarkup = (key) => {
      const inMonth = key.slice(0, 7) === first.slice(0, 7);
      const all = inMonth ? shiftsOn(ws, key) : [];
      const entries = mineOnly ? all.filter((shift) => shift.person_id === own) : all;
      const win = inMonth ? vc()?.dayWindow?.(key) : null;
      const gap = manage && inMonth && key >= current && !all.length && win?.state === 'open';
      const labelParts = [longDate(key), `${all.length} ${all.length === 1 ? 'shift' : 'shifts'}`];
      if (gap) labelParts.push('open, no one scheduled');
      return `<button type="button" class="shifts-month__cell${inMonth ? '' : ' is-outside'}${key === current ? ' is-today' : ''}" data-shifts-day="${escapeHtml(key)}" ${inMonth ? '' : 'tabindex="-1"'} aria-label="${escapeHtml(labelParts.join(', '))}" ${key === current ? 'aria-current="date"' : ''}>
        <span class="shifts-month__num num">${dayNumber(key)}</span>
        ${inMonth ? `<span class="shifts-month__chips">${entries.slice(0, 3).map((shift) => `<span class="shifts-month__chip${isUnpublished(shift, ws) ? ' is-unpublished' : ''}"><span class="shifts-month__who">${escapeHtml(mineOnly ? 'You' : nameOf(shift, ws).split(' ')[0])}</span> <span class="num">${escapeHtml(timeOf(shift.starts_local))}</span></span>`).join('')}${entries.length > 3 ? `<span class="shifts-month__more">+${entries.length - 3} more</span>` : ''}</span>
        <span class="shifts-month__count num" aria-hidden="true">${entries.length ? entries.length : ''}</span>
        ${gap ? '<span class="shifts-month__gap">No one scheduled</span>' : ''}` : ''}
      </button>`;
    };
    return `${alertMarkup(slot)}<div class="atlas-toolbar shifts-toolbar">${statusMarkup()}${manage ? `<div class="atlas-toolbar__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-add="${escapeHtml(current.slice(0, 7) === first.slice(0, 7) ? current : first)}">${icon('plus')}Add shift</button></div>` : ''}</div>
      <div class="shifts-month" role="grid" aria-label="${escapeHtml(monthLabel(first))}">
        <div class="shifts-month__weekdays" role="row">${WEEK_ORDER.map((day) => `<span role="columnheader">${DAY_NAMES[day].slice(0, 3)}</span>`).join('')}</div>
        <div class="shifts-month__grid">${cells.map(cellMarkup).join('')}</div>
      </div>`;
  }

  function openDaySheet(dateKey) {
    const ws = state.month.workspace;
    if (!ws) return;
    const manage = canManage();
    const entries = shiftsOn(ws, dateKey).filter((shift) => manage || shift.person_id === ownPersonId() || true);
    const win = vc()?.dayWindow?.(dateKey);
    const hours = win?.state === 'open' ? `Open ${vc().formatTime(win.open)}–${vc().formatTime(win.close)}` : win?.state === 'closed' ? 'Closed' : '';
    const root = openLayer({
      id: 'shifts-day',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="shifts-day-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="shifts-day-title">${escapeHtml(longDate(dateKey))}</h2><p class="atlas-sheet__desc">${escapeHtml([`${entries.length} ${entries.length === 1 ? 'shift' : 'shifts'}`, hours].filter(Boolean).join(' · '))}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <div class="atlas-sheet__body">${entries.length ? `<ul class="atlas-list">${entries.map((shift) => shiftRowMarkup(shift, ws)).join('')}</ul>` : `<p class="shifts-day__empty">${manage ? 'No one is scheduled.' : 'No published shifts on this day.'}</p>`}</div>
        <footer class="atlas-sheet__foot"><a class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" href="#shifts?week=${escapeHtml(mondayOf(dateKey))}" data-shifts-open-week="${escapeHtml(dateKey)}">Open week</a>${manage ? `<button type="button" class="atlas-btn atlas-btn--primary" data-shifts-add="${escapeHtml(dateKey)}">${icon('plus')}Add shift</button>` : '<button type="button" class="atlas-btn atlas-btn--secondary" data-modal-close>Done</button>'}</footer>
      </section>`
    });
    root.addEventListener('click', (event) => {
      const edit = event.target.closest('[data-shifts-edit]');
      const add = event.target.closest('[data-shifts-add]');
      const week = event.target.closest('[data-shifts-open-week]');
      const respond = event.target.closest('[data-shifts-respond]');
      if (!edit && !add && !week && !respond) return;
      event.preventDefault();
      event.stopPropagation();
      closeLayer(root);
      if (edit) openShiftEditor({ shift: list(ws, 'shifts').find((shift) => shift.id === edit.dataset.shiftsEdit) });
      else if (add) openShiftEditor({ date: add.dataset.shiftsAdd });
      else if (respond) respondTo(respond.dataset.shiftId, respond.dataset.shiftsRespond, ws);
      else go({ tab: 'schedule', mode: 'week', weekStart: mondayOf(week.dataset.shiftsOpenWeek) });
    });
  }

  // ---------- availability ----------

  function availabilityMarkup() {
    const slot = state.week;
    const ws = slot.workspace;
    if (!ws) return `${alertMarkup(slot)}${slot.error && !slot.loading ? '' : skeletonMarkup('list')}`;
    const manage = Boolean(ws.permissions?.can_manage_all_availability);
    const choices = manage ? activePeople() : people().filter((person) => person.id === ownPersonId());
    const person = choices.find((entry) => entry.id === state.availabilityPersonId) || choices.find((entry) => entry.id === ownPersonId()) || choices[0] || null;
    if (!person) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('user-x')}</div><h3 class="atlas-empty__title">Your account isn’t on the shift roster</h3><p class="atlas-empty__text">Ask a manager to add you to the team in Atlas. Then you can set your availability here.</p></div>`;
    }
    state.availabilityPersonId = person.id;
    const rows = list(ws, 'availability');
    return `${alertMarkup(slot)}
      <div class="atlas-toolbar shifts-toolbar">
        ${manage ? `<div class="atlas-field shifts-inline-field"><label for="shifts-avail-person" class="sr-only">Person</label><select class="atlas-select" id="shifts-avail-person" data-shifts-availability-person>${choices.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === person.id ? 'selected' : ''}>${escapeHtml(entry.display_name)}</option>`).join('')}</select></div>` : ''}
        <p class="shifts-toolbar__note">Your usual week. Managers see a warning when a shift falls outside it; approved time off is set separately.</p>
      </div>
      <ul class="atlas-list shifts-avail">${WEEK_ORDER.map((day) => {
        const entry = rows.find((row) => row.person_id === person.id && Number(row.weekday) === day) || {};
        const available = !entry.unavailable;
        return `<li class="shifts-avail__row"><form class="shifts-avail__form" data-shifts-availability-form data-person-id="${escapeHtml(person.id)}" data-weekday="${day}" novalidate>
          <span class="shifts-avail__day" id="avail-day-${day}">${DAY_NAMES[day]}</span>
          <span class="shifts-avail__toggle"><button type="button" class="atlas-toggle" role="switch" aria-checked="${available}" aria-labelledby="avail-day-${day} avail-state-${day}" data-shifts-availability-toggle></button><span class="shifts-avail__state" id="avail-state-${day}">${available ? 'Available' : 'Unavailable'}</span></span>
          <span class="shifts-avail__times"><label class="sr-only" for="avail-from-${day}">${DAY_NAMES[day]} from</label><input class="atlas-input" ${TIME_FIELD} id="avail-from-${day}" name="available_from" value="${escapeHtml(String(entry.available_from || '').slice(0, 5))}" ${available ? '' : 'disabled'} aria-describedby="avail-hint-${day}"><span aria-hidden="true">–</span><label class="sr-only" for="avail-to-${day}">${DAY_NAMES[day]} until</label><input class="atlas-input" ${TIME_FIELD} id="avail-to-${day}" name="available_to" value="${escapeHtml(String(entry.available_to || '').slice(0, 5))}" ${available ? '' : 'disabled'}><span class="sr-only" id="avail-hint-${day}">Leave empty for any time</span></span>
          <span class="shifts-avail__note"><label class="sr-only" for="avail-note-${day}">${DAY_NAMES[day]} note</label><input class="atlas-input" id="avail-note-${day}" name="note" maxlength="2000" value="${escapeHtml(entry.note || '')}" placeholder="Note"></span>
          <input type="hidden" name="unavailable" value="${available ? 'false' : 'true'}">
          <button type="submit" class="atlas-btn atlas-btn--secondary atlas-btn--sm shifts-avail__save" disabled>Save</button>
        </form></li>`;
      }).join('')}</ul>`;
  }

  // ---------- time off ----------

  function timeOffMarkup() {
    const slot = state.week;
    const ws = slot.workspace;
    if (!ws) return `${alertMarkup(slot)}${slot.error && !slot.loading ? '' : skeletonMarkup('list')}`;
    const manage = Boolean(ws.permissions?.can_decide_time_off);
    const requests = list(ws, 'time_off').slice().sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || String(a.starts_on).localeCompare(String(b.starts_on)));
    const canRequest = manage || Boolean(ownPersonId());
    const rows = requests.map((request) => {
      const [label, tone] = TIME_OFF_STATUS[request.status] || [request.status, 'neutral'];
      const range = request.starts_on === request.ends_on ? longDate(request.starts_on) : `${shortDate(request.starts_on)} – ${shortDate(request.ends_on)}`;
      return `<li class="atlas-row" data-time-off="${escapeHtml(request.id)}">
        <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(manage ? (request.person_name || personFor(request.person_id)?.display_name || 'Team member') : range)}</p><p class="atlas-row__meta">${escapeHtml([manage ? range : null, TIME_OFF_TYPES[request.request_type] || 'Time off', request.note, request.manager_note ? `Manager: ${request.manager_note}` : null].filter(Boolean).join(' · '))}</p></div>
        <div class="atlas-row__end">${pill(label, tone)}${manage && request.status === 'pending' ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-time-off-decision="approved" data-request-id="${escapeHtml(request.id)}">Approve</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-shifts-time-off-decision="rejected" data-request-id="${escapeHtml(request.id)}">Decline</button>` : ''}</div>
      </li>`;
    }).join('');
    return `${alertMarkup(slot)}
      <div class="atlas-toolbar shifts-toolbar"><p class="shifts-toolbar__note">${manage ? 'Requests from the last two weeks and the next six.' : 'Your requests and what your manager decided.'}</p>${canRequest ? `<div class="atlas-toolbar__end"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-time-off-new>${icon('plus')}${manage ? 'Record time off' : 'Request time off'}</button></div>` : ''}</div>
      ${requests.length ? `<ul class="atlas-list shifts-list">${rows}</ul>` : `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('calendar-off')}</div><h3 class="atlas-empty__title">No time off requested</h3><p class="atlas-empty__text">${manage ? 'Requests from the team appear here for you to approve.' : canRequest ? 'Ask for days off here. Your manager approves them.' : 'Your account isn’t on the shift roster yet.'}</p></div>`}`;
  }

  function openTimeOffSheet() {
    const ws = state.week.workspace;
    if (!ws) return;
    const manage = Boolean(ws.permissions?.can_decide_time_off);
    const choices = manage ? activePeople() : people().filter((person) => person.id === ownPersonId());
    if (!choices.length) return;
    const start = today();
    const root = openLayer({
      id: 'shifts-time-off',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="shifts-time-off-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="shifts-time-off-title">${manage ? 'Record time off' : 'Request time off'}</h2><p class="atlas-sheet__desc">${manage ? 'Time off you record is approved straight away.' : 'Your manager is asked to approve it.'}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="shifts-time-off-form" data-shifts-time-off-form novalidate>
          ${manage ? `<div class="atlas-field"><label for="to-person">Person</label><select class="atlas-select" id="to-person" name="person_id">${choices.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.display_name)}</option>`).join('')}</select></div>` : `<input type="hidden" name="person_id" value="${escapeHtml(choices[0].id)}">`}
          <div class="atlas-field"><label for="to-type">Type</label><select class="atlas-select" id="to-type" name="request_type">${Object.entries(TIME_OFF_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="to-start">First day</label><input class="atlas-input" ${DATE_FIELD} id="to-start" name="starts_on" required value="${escapeHtml(start)}"></div>
            <div class="atlas-field"><label for="to-end">Last day</label><input class="atlas-input" ${DATE_FIELD} id="to-end" name="ends_on" required value="${escapeHtml(start)}"></div>
          </div>
          <p class="error" data-to-error hidden>The last day can’t be before the first day.</p>
          <div class="atlas-field"><label for="to-note">Note <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="to-note" name="note" rows="3" maxlength="3000" placeholder="Anything your manager should know"></textarea></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="shifts-time-off-form" class="atlas-btn atlas-btn--primary">${manage ? 'Record time off' : 'Send request'}</button></footer>
      </section>`
    });
    const form = root.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const invalid = !form.starts_on.value || !form.ends_on.value || form.ends_on.value < form.starts_on.value;
      root.querySelector('[data-to-error]').hidden = !invalid;
      form.ends_on.setAttribute('aria-invalid', String(invalid));
      if (invalid) { form.ends_on.focus(); return; }
      const ok = await mutate('request-time-off', {
        person_id: form.person_id.value,
        request_type: form.request_type.value,
        starts_on: form.starts_on.value,
        ends_on: form.ends_on.value,
        note: form.note.value.trim() || null
      }, manage ? 'Time off recorded' : 'Time-off request sent', { month: false });
      if (ok) closeLayer(root);
    });
  }

  // ---------- confirmations & activity (managers) ----------

  function confirmationsMarkup() {
    const slot = state.week;
    const ws = slot.workspace;
    if (!ws) return `${alertMarkup(slot)}${slot.error && !slot.loading ? '' : skeletonMarkup('list')}`;
    const rows = list(ws, 'responses').map((response) => ({ response, shift: list(ws, 'shifts').find((shift) => shift.id === response.shift_id) }))
      .filter((row) => row.shift)
      .sort((a, b) => (a.response.manager_status === 'open' ? -1 : 0) - (b.response.manager_status === 'open' ? -1 : 0) || a.shift.starts_local.localeCompare(b.shift.starts_local));
    if (!rows.length) {
      return `${alertMarkup(slot)}<div class="atlas-empty"><div class="atlas-empty__icon">${icon('badge-check')}</div><h3 class="atlas-empty__title">No responses for ${escapeHtml(weekRangeLabel(state.weekStart))}</h3><p class="atlas-empty__text">Publishing a week asks everyone with an Atlas login to confirm their shifts.</p></div>`;
    }
    return `${alertMarkup(slot)}<div class="atlas-toolbar shifts-toolbar"><p class="shifts-toolbar__note">Week of ${escapeHtml(weekRangeLabel(state.weekStart))}. Change requests need a note when you close them.</p></div><ul class="atlas-list shifts-list">${rows.map(({ response, shift }) => {
      const status = RESPONSE[response.response] || RESPONSE.pending;
      const open = response.manager_status === 'open';
      return `<li class="atlas-row"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(nameOf(shift, ws))}</p><p class="atlas-row__meta">${escapeHtml([`${shortDate(dateOf(shift.starts_local))}, ${timeOf(shift.starts_local)}–${timeOf(shift.ends_local)}`, response.note, response.manager_note ? `Manager: ${response.manager_note}` : null].filter(Boolean).join(' · '))}</p></div>
        <div class="atlas-row__end">${pill(status.label, status.tone)}${open ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-shifts-response-decision="resolved" data-shift-id="${escapeHtml(shift.id)}" data-person-id="${escapeHtml(response.person_id)}">Resolve</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-shifts-response-decision="rejected" data-shift-id="${escapeHtml(shift.id)}" data-person-id="${escapeHtml(response.person_id)}">Decline</button>` : ''}</div></li>`;
    }).join('')}</ul>`;
  }

  function activityMarkup() {
    const slot = state.week;
    const ws = slot.workspace;
    if (!ws) return `${alertMarkup(slot)}${slot.error && !slot.loading ? '' : skeletonMarkup('list')}`;
    const events = list(ws, 'events');
    if (!events.length) return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('history')}</div><h3 class="atlas-empty__title">No schedule activity yet</h3><p class="atlas-empty__text">Changes to shifts, availability, time off and publishing appear here.</p></div>`;
    return `<ul class="atlas-list shifts-list">${events.map((event) => `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon">${icon('history')}</span><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(EVENT_LABELS[event.event_type] || String(event.event_type || 'Change').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))}</p><p class="atlas-row__meta">${escapeHtml(event.actor_label || 'Atlas')} · <time datetime="${escapeHtml(event.created_at || '')}">${escapeHtml(vc()?.formatRelative?.(event.created_at) || '')}</time></p></div></li>`).join('')}</ul>`;
  }

  function contentMarkup() {
    if (state.tab === 'availability') return availabilityMarkup();
    if (state.tab === 'time-off') return timeOffMarkup();
    if (state.tab === 'confirmations') return canManage() ? confirmationsMarkup() : permissionMarkup();
    if (state.tab === 'activity') return canManage() ? activityMarkup() : permissionMarkup();
    return state.mode === 'month' ? monthScheduleMarkup() : weekScheduleMarkup();
  }

  function permissionMarkup() {
    return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('lock')}</div><h3 class="atlas-empty__title">This part of Shifts is for managers</h3><p class="atlas-empty__text">You can see your own shifts, availability and time off.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#shifts">Go to my shifts</a></div></div>`;
  }

  function paint() {
    if (!state.visible || !ensureRoot()) return;
    const root = state.root;
    const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    root.innerHTML = `<div class="shifts" data-view-mode="${state.mode}" data-view-tab="${state.tab}">${headerMarkup()}${tabsMarkup()}<div class="shifts-body">${contentMarkup()}</div></div>`;
    paintIcons();
    if (focusId) document.getElementById(focusId)?.focus?.({ preventScroll: true });
  }

  // ---------- navigation ----------

  function paramsFor(next = {}) {
    const tab = next.tab ?? state.tab;
    const mode = next.mode ?? state.mode;
    const weekStart = next.weekStart ?? state.weekStart;
    const monthStart = next.monthStart ?? state.monthStart;
    const params = {};
    if (tab === 'schedule') {
      if (mode === 'month') {
        params.section = 'month';
        if (monthStart !== monthStartOf(today())) params.month = monthStart;
      } else if (weekStart !== mondayOf(today())) params.week = weekStart;
    } else {
      params.section = tab;
    }
    return params;
  }

  // Moves between this page's routes; AtlasShell.show() writes the address.
  function routeTo(view, params = {}) {
    window.AtlasShell?.show?.(view, params, { source: 'route' });
  }

  function go(next = {}) {
    const params = paramsFor(next);
    if (window.AtlasShell?.href) routeTo('shifts', params);
    else render(params);
  }

  function applyParams(params = {}) {
    const section = String(params.section || '');
    if (section === 'month') { state.tab = 'schedule'; state.mode = 'month'; }
    else if (section && TABS.some((tab) => tab.key === section)) state.tab = section;
    else { state.tab = 'schedule'; state.mode = 'week'; }
    const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const scheduleWeek = state.tab === 'schedule' && state.mode === 'week';
    const scheduleMonth = state.tab === 'schedule' && state.mode === 'month';
    if (valid(params.week)) state.weekStart = mondayOf(params.week);
    else if (scheduleWeek || !state.weekStart) state.weekStart = mondayOf(today());
    if (valid(params.month)) state.monthStart = monthStartOf(params.month);
    else if (scheduleMonth || !state.monthStart) state.monthStart = monthStartOf(today());
  }

  function render(params = {}) {
    state.visible = true;
    applyParams(params || {});
    paint();
    if (state.tab === 'schedule' && state.mode === 'month') loadMonth();
    else loadWeek();
    window.AtlasChrome?.setTopBar?.(topBarFor());
  }

  function topBarFor() {
    if (!phoneQuery.matches) return {};
    const actions = [];
    if (canManage() && state.tab === 'schedule') actions.push({ icon: 'plus', label: 'Add shift', run: () => openShiftEditor({ date: today() }) });
    else if (!isViewer() && ownPersonId()) actions.push({ icon: 'calendar-off', label: 'Request time off', run: () => { go({ tab: 'time-off' }); window.setTimeout(openTimeOffSheet, 300); } });
    return actions.length ? { actions } : {};
  }

  function hide() {
    state.visible = false;
  }

  async function respondTo(shiftId, response, ws = state.week.workspace) {
    let note = null;
    if (response !== 'confirmed') {
      const shift = list(ws, 'shifts').find((entry) => entry.id === shiftId);
      const answer = await confirmDialog({
        title: 'Request a change',
        body: shift ? `${longDate(dateOf(shift.starts_local))}, ${timeOf(shift.starts_local)}–${timeOf(shift.ends_local)}. Your manager sees your note.` : 'Your manager sees your note.',
        confirmLabel: 'Send request',
        field: { label: 'What would you like to change?', required: true, placeholder: 'For example: can I start at 19:00?' }
      });
      if (!answer) return;
      note = answer.value;
    }
    mutate('respond', { shift_id: shiftId, response, note }, response === 'confirmed' ? 'Shift confirmed' : 'Change request sent');
  }

  async function publish() {
    const month = state.mode === 'month';
    const info = publishState();
    if (!info) return;
    const answer = await confirmDialog({
      title: month ? `Publish ${monthLabel(state.monthStart)}?` : `Publish ${weekRangeLabel(state.weekStart)}?`,
      body: `The team will see revision ${info.revision + 1} straight away and be asked to confirm their shifts.`,
      confirmLabel: month ? 'Publish month' : 'Publish week',
      field: { label: 'Note to the team', required: false, placeholder: 'For example: two extra shifts for the Friday event' }
    });
    if (!answer) return;
    if (month) mutate('publish-month', { month_start: state.monthStart, note: answer.value || null }, `${monthLabel(state.monthStart)} published to the team`);
    else mutate('publish-week', { week_start: state.weekStart, note: answer.value || null }, 'Week published to the team');
  }

  async function copyLastWeek() {
    const source = addDays(state.weekStart, -7);
    const answer = await confirmDialog({
      title: 'Copy last week?',
      body: `Every shift from ${weekRangeLabel(source)} is copied into this week as a draft. Nothing is published.`,
      confirmLabel: 'Copy shifts'
    });
    if (!answer) return;
    mutate('copy-week', { source_week: source, target_week: state.weekStart }, 'Last week copied as a draft', { month: false });
  }

  async function decideTimeOff(requestId, status) {
    const answer = await confirmDialog({
      title: status === 'approved' ? 'Approve time off?' : 'Decline time off?',
      body: status === 'approved' ? 'The person is told, and shifts on those days show a warning.' : 'The person is told that the request was declined.',
      confirmLabel: status === 'approved' ? 'Approve' : 'Decline',
      field: { label: status === 'approved' ? 'Note' : 'Reason', required: false }
    });
    if (!answer) return;
    mutate('decide-time-off', { request_id: requestId, status, manager_note: answer.value || null }, status === 'approved' ? 'Time off approved' : 'Time off declined', { month: false });
  }

  async function decideResponse(shiftId, personId, managerStatus) {
    const answer = await confirmDialog({
      title: managerStatus === 'resolved' ? 'Resolve this change request?' : 'Decline this change request?',
      body: 'Your note is shown to the person and kept with the schedule history.',
      confirmLabel: managerStatus === 'resolved' ? 'Resolve' : 'Decline',
      field: { label: 'Note', required: true }
    });
    if (!answer) return;
    mutate('decide-response', { shift_id: shiftId, person_id: personId, manager_status: managerStatus, manager_note: answer.value }, managerStatus === 'resolved' ? 'Change request resolved' : 'Change request declined', { month: false });
  }

  function shiftById(id) {
    return list(state.week.workspace, 'shifts').find((shift) => shift.id === id)
      || list(state.month.workspace, 'shifts').find((shift) => shift.id === id) || null;
  }

  // ---------- events ----------

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !state.root?.contains(target)) return;

    const tab = target.closest('[data-shifts-tab]');
    if (tab && tab.tagName === 'A') {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      go({ tab: tab.dataset.shiftsTab });
      return;
    }
    const mode = target.closest('[data-shifts-mode]');
    if (mode) {
      const next = mode.dataset.shiftsMode;
      go(next === 'month' ? { tab: 'schedule', mode: 'month', monthStart: monthStartOf(state.weekStart <= today() && today() <= addDays(state.weekStart, 6) ? today() : state.weekStart) } : { tab: 'schedule', mode: 'week', weekStart: state.monthStart === monthStartOf(today()) ? mondayOf(today()) : mondayOf(state.monthStart) });
      return;
    }
    const step = target.closest('[data-shifts-step]');
    if (step) {
      const n = Number(step.dataset.shiftsStep || 0);
      if (state.mode === 'month') go({ monthStart: addMonths(state.monthStart, n) });
      else go({ weekStart: addDays(state.weekStart, 7 * n) });
      return;
    }
    if (target.closest('[data-shifts-today]')) {
      go(state.mode === 'month' ? { monthStart: monthStartOf(today()) } : { weekStart: mondayOf(today()) });
      return;
    }
    if (target.closest('[data-shifts-retry]')) {
      if (state.tab === 'schedule' && state.mode === 'month') loadMonth({ force: true });
      else loadWeek({ force: true });
      return;
    }
    if (target.closest('[data-shifts-earlier]')) { state.showEarlier = true; paint(); return; }
    const staffView = target.closest('[data-shifts-staff-view]');
    if (staffView) {
      state.staffView = staffView.dataset.shiftsStaffView === 'team' ? 'team' : 'mine';
      paint();
      return;
    }
    if (target.closest('[data-shifts-publish]')) { publish(); return; }
    if (target.closest('[data-shifts-copy]')) { copyLastWeek(); return; }
    if (target.closest('[data-shifts-time-off-new]')) { openTimeOffSheet(); return; }

    const add = target.closest('[data-shifts-add]');
    if (add) {
      openShiftEditor({ date: add.dataset.shiftsAdd });
      const personId = add.dataset.shiftsPerson;
      if (personId) window.requestAnimationFrame(() => { const select = document.querySelector('#shifts-editor select[name="person_id"]'); if (select) select.value = personId; });
      return;
    }
    const edit = target.closest('[data-shifts-edit]');
    if (edit) {
      const shift = shiftById(edit.dataset.shiftsEdit);
      if (shift) openShiftEditor({ shift });
      return;
    }
    const day = target.closest('[data-shifts-day]');
    if (day) {
      const key = day.dataset.shiftsDay;
      if (key.slice(0, 7) !== state.monthStart.slice(0, 7)) go({ monthStart: monthStartOf(key) });
      else openDaySheet(key);
      return;
    }
    const respond = target.closest('[data-shifts-respond]');
    if (respond) { respondTo(respond.dataset.shiftId, respond.dataset.shiftsRespond); return; }
    const decision = target.closest('[data-shifts-time-off-decision]');
    if (decision) { decideTimeOff(decision.dataset.requestId, decision.dataset.shiftsTimeOffDecision); return; }
    const responseDecision = target.closest('[data-shifts-response-decision]');
    if (responseDecision) { decideResponse(responseDecision.dataset.shiftId, responseDecision.dataset.personId, responseDecision.dataset.shiftsResponseDecision); return; }

    const toggle = target.closest('[data-shifts-availability-toggle]');
    if (toggle) {
      const form = toggle.closest('form');
      const available = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(available));
      form.querySelector('.shifts-avail__state').textContent = available ? 'Available' : 'Unavailable';
      form.elements.namedItem('unavailable').value = available ? 'false' : 'true';
      form.querySelectorAll('input[name="available_from"], input[name="available_to"]').forEach((input) => { input.disabled = !available; });
      form.querySelector('.shifts-avail__save').disabled = false;
    }
  }

  function handleInput(event) {
    const form = event.target?.closest?.('[data-shifts-availability-form]');
    if (form && state.root?.contains(form)) form.querySelector('.shifts-avail__save').disabled = false;
  }

  function handleChange(event) {
    const target = event.target;
    if (target?.matches?.('[data-shifts-availability-person]')) {
      state.availabilityPersonId = target.value;
      paint();
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !state.root?.contains(form)) return;
    if (!form.matches('[data-shifts-availability-form]')) return;
    event.preventDefault();
    const unavailable = form.elements.namedItem('unavailable').value === 'true';
    const day = Number(form.dataset.weekday);
    mutate('save-availability', {
      person_id: form.dataset.personId,
      weekday: day,
      unavailable,
      available_from: unavailable ? null : form.elements.namedItem('available_from').value || null,
      available_to: unavailable ? null : form.elements.namedItem('available_to').value || null,
      note: form.elements.namedItem('note').value.trim() || null
    }, `${DAY_NAMES[day]} saved`, { month: false });
  }

  // ---------- shell ----------

  function publishToday() {
    window.AtlasShell?.emit?.('shifts:changed', { today: whoIsOn(today()), tomorrow: whoIsOn(addDays(today(), 1)) });
  }

  function nextShift() {
    const own = ownPersonId();
    const now = Date.now();
    return list(state.week.workspace, 'shifts')
      .filter((shift) => shift.person_id === own && Date.parse(shift.ends_at) > now)
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] || null;
  }

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell?.registerView) return;
    shell.registerView('shifts', { root: () => document.getElementById('shifts-view'), title: 'Shifts', render, onHide: hide });
    shell.actions?.register?.({
      id: 'shifts.add', label: 'Add shift', icon: 'calendar-plus', keywords: ['shift', 'schedule', 'rota', 'plan'], roles: MANAGER_ROLES, contexts: ['shifts', 'home'],
      run: () => { go({ tab: 'schedule' }); window.setTimeout(() => openShiftEditor({ date: today() }), 400); }
    });
    shell.actions?.register?.({
      id: 'shifts.time-off', label: 'Request time off', icon: 'calendar-off', keywords: ['time off', 'holiday', 'vacation', 'leave', 'sick'], roles: ['admin', 'manager', 'bartender'], contexts: ['shifts'],
      run: () => { go({ tab: 'time-off' }); window.setTimeout(openTimeOffSheet, 600); }
    });
    shell.actions?.register?.({
      id: 'shifts.availability', label: 'Set availability', icon: 'calendar-clock', keywords: ['availability', 'available', 'days'], roles: ['admin', 'manager', 'bartender'], contexts: ['shifts'],
      run: () => go({ tab: 'availability' })
    });
    if (shell.current?.() === 'shifts') render(shell.params?.() || {});
  }

  function init() {
    if (state.initialized || !document.getElementById('shifts-view')) return;
    state.initialized = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    document.addEventListener('input', handleInput);
    document.addEventListener('submit', handleSubmit);
    window.addEventListener('atlas:team-roster-changed', () => { state.week.key = null; state.month.key = null; if (state.visible) render(window.AtlasShell?.params?.() || {}); });
    window.addEventListener('focus', () => {
      if (!state.visible || document.querySelector('.shifts-layer')) return;
      if (state.tab === 'schedule' && state.mode === 'month') loadMonth({ force: true, silent: true });
      else loadWeek({ force: true, silent: true });
    });
    window.AtlasVenueClock?.onChange?.(() => { if (state.visible) paint(); });
    narrowQuery.addEventListener?.('change', () => { if (state.visible) paint(); });
    phoneQuery.addEventListener?.('change', () => { if (state.visible) window.AtlasChrome?.setTopBar?.(topBarFor()); });
    window.addEventListener('atlas:profile-photos-updated', () => { if (state.visible && state.tab === 'schedule') paint(); });
    registerWithShell();
  }

  window.AtlasShifts = {
    open: () => go({ tab: 'schedule', mode: 'week', weekStart: mondayOf(today()) }),
    refresh: () => (state.mode === 'month' && state.tab === 'schedule' ? loadMonth({ force: true }) : loadWeek({ force: true })),
    snapshot: () => state.week.workspace,
    week: () => state.weekStart,
    month: () => state.monthStart,
    whoIsOn: (dateKey = today()) => whoIsOn(dateKey),
    nextShift,
    addShift: (date) => openShiftEditor({ date })
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
