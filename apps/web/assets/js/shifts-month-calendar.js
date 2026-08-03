(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const REFRESH_MS = 30000;
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  const state = {
    active: false,
    monthStart: null,
    workspace: null,
    staff: null,
    policy: null,
    loading: false,
    submitting: false,
    error: null,
    message: null,
    selectedDate: null,
    modal: null,
    observer: null,
    frame: null,
    initialized: false,
    requestSerial: 0,
    pollTimer: null
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function endpoint() {
    return String(cfg.SHIFTS_API || '').trim();
  }

  function host() {
    return document.getElementById('shifts-view');
  }

  function viewVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  function dateFromKey(value) {
    return new Date(`${value}T12:00:00Z`);
  }

  function dateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(value, amount) {
    const date = typeof value === 'string' ? dateFromKey(value) : new Date(value);
    date.setUTCDate(date.getUTCDate() + amount);
    return dateKey(date);
  }

  function mondayFor(value) {
    const date = dateFromKey(value);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return dateKey(date);
  }

  function venueDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Atlantic/Reykjavik',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function monthStartFor(value) {
    const date = dateFromKey(value);
    date.setUTCDate(1);
    return dateKey(date);
  }

  function addMonths(value, amount) {
    const date = dateFromKey(value);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + amount);
    return dateKey(date);
  }

  function monthBounds(monthStart) {
    const start = monthStartFor(monthStart);
    const next = dateFromKey(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    const monthEnd = dateKey(next);
    return {
      monthStart: start,
      monthEnd,
      gridStart: mondayFor(start),
      gridEnd: addDays(mondayFor(monthEnd), 6)
    };
  }

  function monthLabel(value) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric'
    }).format(dateFromKey(value));
  }

  function formatDay(value, options = {}) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: options.day || '2-digit',
      month: options.month || 'short',
      year: options.year || undefined,
      weekday: options.weekday || undefined
    }).format(dateFromKey(value));
  }

  function timeFromLocal(value) {
    return value ? String(value).slice(11, 16) : '';
  }

  function dateFromLocal(value) {
    return value ? String(value).slice(0, 10) : '';
  }

  function hoursForShift(shift) {
    const start = new Date(shift.starts_at);
    const end = new Date(shift.ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
    return Math.max(0, ((end - start) / 3600000) - (Number(shift.break_minutes || 0) / 60));
  }

  function humanize(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
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
    if (!apiUrl) throw new Error('Shifts API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open the month schedule.');

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
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Month schedule request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The month schedule took too long to respond. Check the connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function people() {
    return Array.isArray(state.workspace?.people) ? state.workspace.people : [];
  }

  function shifts() {
    return Array.isArray(state.workspace?.shifts) ? state.workspace.shifts : [];
  }

  function availability() {
    return Array.isArray(state.workspace?.availability) ? state.workspace.availability : [];
  }

  function timeOff() {
    return Array.isArray(state.workspace?.time_off) ? state.workspace.time_off : [];
  }

  function responses() {
    return Array.isArray(state.workspace?.responses) ? state.workspace.responses : [];
  }

  function weeks() {
    return Array.isArray(state.workspace?.weeks) ? state.workspace.weeks : [];
  }

  function monthInfo() {
    return state.workspace?.month || {};
  }

  function canManage() {
    return Boolean(state.workspace?.permissions?.can_manage_schedule || state.staff?.can_manage_schedule);
  }

  function personFor(id) {
    return people().find((person) => person.id === id) || null;
  }

  function responseForShift(shift) {
    return responses().find((response) => response.shift_id === shift.id && response.person_id === shift.person_id) || null;
  }

  function shiftsForDate(date) {
    return shifts().filter((shift) => dateFromLocal(shift.starts_local) === date);
  }

  function leaveForDate(date) {
    return timeOff().filter((request) => request.status === 'approved'
      && request.starts_on <= date
      && request.ends_on >= date);
  }

  function shiftsForWeek(weekStart) {
    return shifts().filter((shift) => shift.week_start === weekStart);
  }

  function weekForDate(date) {
    const weekStart = mondayFor(date);
    return weeks().find((week) => week.week_start === weekStart) || null;
  }

  function shiftWarnings(shift) {
    const warnings = [];
    const date = dateFromLocal(shift.starts_local);
    const weekday = dateFromKey(date).getUTCDay();
    const recurring = availability().find((entry) => entry.person_id === shift.person_id
      && Number(entry.weekday) === weekday);
    const startTime = timeFromLocal(shift.starts_local);
    const endTime = timeFromLocal(shift.ends_local);

    if (recurring?.unavailable) warnings.push('Marked unavailable');
    else if (recurring) {
      const availableFrom = String(recurring.available_from || '').slice(0, 5);
      const availableTo = String(recurring.available_to || '').slice(0, 5);
      if (availableFrom && startTime < availableFrom) warnings.push(`Available from ${availableFrom}`);
      if (availableTo && dateFromLocal(shift.ends_local) === date && endTime > availableTo) {
        warnings.push(`Available until ${availableTo}`);
      }
    }

    const approvedLeave = timeOff().find((request) => request.person_id === shift.person_id
      && request.status === 'approved'
      && request.starts_on <= date
      && request.ends_on >= date);
    if (approvedLeave) warnings.push(`${humanize(approvedLeave.request_type)} approved`);

    const overlap = shifts().some((other) => other.id !== shift.id
      && other.person_id === shift.person_id
      && new Date(other.starts_at) < new Date(shift.ends_at)
      && new Date(other.ends_at) > new Date(shift.starts_at));
    if (overlap) warnings.push('Overlapping shift');
    return warnings;
  }

  function responseTone(response) {
    const value = response?.response || 'pending';
    return ['confirmed', 'change_requested', 'declined'].includes(value) ? value : 'pending';
  }

  function summary() {
    const plannedHours = shifts().reduce((total, shift) => total + hoursForShift(shift), 0);
    return {
      shiftCount: shifts().length,
      plannedHours,
      scheduledPeople: new Set(shifts().map((shift) => shift.person_id)).size,
      scheduledDays: new Set(shifts().map((shift) => dateFromLocal(shift.starts_local))).size,
      confirmed: responses().filter((response) => response.response === 'confirmed').length,
      openRequests: responses().filter((response) => response.manager_status === 'open').length
    };
  }

  function feedbackMarkup() {
    if (state.error) {
      return `<div class="shift-month-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    }
    if (state.message) {
      return `<div class="shift-month-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    }
    return '';
  }

  function monthStatusMarkup() {
    const month = monthInfo();
    const revision = Number(month.revision || month.latest_publication?.revision || 0);
    if (month.status === 'published' && month.has_unpublished_changes) {
      return `<span class="shift-month-status is-update">Published r${revision} · update pending</span>`;
    }
    if (month.status === 'published' || month.latest_publication) {
      return `<span class="shift-month-status is-published">Published month · revision ${revision}</span>`;
    }
    return '<span class="shift-month-status is-draft">Draft month</span>';
  }

  function toolbarMarkup() {
    const manager = canManage();
    const month = monthInfo();
    const hasShifts = shifts().length > 0;
    const alreadyCurrent = month.status === 'published' && !month.has_unpublished_changes;
    const publishDisabled = state.submitting || !hasShifts || alreadyCurrent;
    const publishLabel = month.status === 'published'
      ? month.has_unpublished_changes ? 'Publish update' : 'Published'
      : 'Publish month';

    return `<header class="shift-month-toolbar">
      <div class="shift-month-navigation">
        <button type="button" data-shifts-month-nav="-1" aria-label="Previous month"><i data-lucide="chevron-left"></i></button>
        <button type="button" data-shifts-month-today>Today</button>
        <button type="button" data-shifts-month-nav="1" aria-label="Next month"><i data-lucide="chevron-right"></i></button>
        <div><span>Monthly shift plan</span><h2>${escapeHtml(monthLabel(state.monthStart))}</h2></div>
        ${monthStatusMarkup()}
      </div>
      <div class="shift-month-toolbar-actions">
        <button type="button" class="shift-month-refresh" data-shifts-month-refresh><i data-lucide="refresh-cw"></i>Refresh</button>
        ${manager ? `<button type="button" class="shift-month-add" data-shifts-month-add><i data-lucide="plus"></i>Add shift</button>
          <button type="button" class="shift-month-publish" data-shifts-month-publish ${publishDisabled ? 'disabled' : ''}><i data-lucide="send"></i>${escapeHtml(publishLabel)}</button>` : ''}
      </div>
    </header>`;
  }

  function summaryMarkup() {
    const values = summary();
    const manager = canManage();
    return `<div class="shift-month-summary">
      <article><span><i data-lucide="calendar-check-2"></i>Month shifts</span><strong>${values.shiftCount}</strong><small>${values.scheduledDays} scheduled days</small></article>
      <article><span><i data-lucide="clock-3"></i>Planned hours</span><strong>${values.plannedHours.toFixed(1)}</strong><small>Breaks deducted</small></article>
      <article><span><i data-lucide="users-round"></i>People scheduled</span><strong>${values.scheduledPeople}</strong><small>Across ${escapeHtml(monthLabel(state.monthStart))}</small></article>
      <article class="${values.openRequests ? 'is-attention' : ''}"><span><i data-lucide="badge-check"></i>${manager ? 'Responses' : 'Confirmations'}</span><strong>${manager ? values.openRequests || values.confirmed : values.confirmed}</strong><small>${manager && values.openRequests ? `${values.openRequests} change request${values.openRequests === 1 ? '' : 's'}` : `${values.confirmed} confirmed shift${values.confirmed === 1 ? '' : 's'}`}</small></article>
    </div>`;
  }

  function weekStateMarkup(date) {
    if (dateFromKey(date).getUTCDay() !== 1) return '';
    const week = weekForDate(date);
    if (!week) return '';
    if (canManage() && week.has_unpublished_changes) return '<span class="shift-month-week-state is-update">Update pending</span>';
    if (week.latest_publication || week.status === 'published') {
      return `<span class="shift-month-week-state is-published">Published r${Number(week.revision || week.latest_publication?.revision || 0)}</span>`;
    }
    if (canManage() && shiftsForWeek(week.week_start).length) return '<span class="shift-month-week-state is-draft">Draft</span>';
    return '';
  }

  function shiftChipMarkup(shift) {
    const response = responseForShift(shift);
    const warnings = shiftWarnings(shift);
    const person = personFor(shift.person_id);
    const attribute = canManage()
      ? `data-shifts-month-edit="${escapeHtml(shift.id)}"`
      : `data-shifts-month-day="${escapeHtml(dateFromLocal(shift.starts_local))}"`;
    return `<button type="button" class="shift-month-chip is-${responseTone(response)} ${warnings.length ? 'has-warning' : ''}" ${attribute} title="${escapeHtml(warnings.join(' · ') || `${shift.person_name || person?.display_name || 'Team'} ${timeFromLocal(shift.starts_local)}–${timeFromLocal(shift.ends_local)}`)}">
      <strong>${escapeHtml(timeFromLocal(shift.starts_local))}</strong>
      <em>${escapeHtml(shift.person_name || person?.display_name || 'Team')}</em>
    </button>`;
  }

  function monthCellMarkup(date) {
    const inMonth = date.slice(0, 7) === state.monthStart.slice(0, 7);
    const entries = inMonth ? shiftsForDate(date) : [];
    const leave = inMonth ? leaveForDate(date) : [];
    const visibleEntries = entries.slice(0, 3);
    const remaining = Math.max(0, entries.length - visibleEntries.length);
    const today = date === venueDate();
    const selected = date === state.selectedDate;
    const dayNumber = Number(date.slice(8, 10));

    return `<section class="shift-month-cell ${inMonth ? '' : 'is-outside'} ${today ? 'is-today' : ''} ${selected ? 'is-selected' : ''}">
      <header class="shift-month-cell-head">
        <button type="button" class="shift-month-day-button" ${inMonth ? `data-shifts-month-day="${escapeHtml(date)}"` : `data-shifts-month-adjacent="${escapeHtml(date)}"`} aria-label="Open ${escapeHtml(formatDay(date, { weekday: 'long', day: 'numeric', month: 'long' }))}">
          <strong>${dayNumber}</strong>${today ? '<em>Today</em>' : ''}
        </button>
        <span class="shift-month-cell-actions">${weekStateMarkup(date)}${canManage() && inMonth ? `<button type="button" class="shift-month-add-day" data-shifts-month-add-day="${escapeHtml(date)}" aria-label="Add shift on ${escapeHtml(formatDay(date, { weekday: 'long', day: 'numeric', month: 'long' }))}"><i data-lucide="plus"></i></button>` : ''}</span>
      </header>
      <div class="shift-month-cell-content">
        ${visibleEntries.map(shiftChipMarkup).join('')}
        ${leave.slice(0, 1).map((request) => `<button type="button" class="shift-month-leave" data-shifts-month-day="${escapeHtml(date)}"><i data-lucide="calendar-off-2"></i>${escapeHtml(request.person_name || personFor(request.person_id)?.display_name || 'Team')} · ${escapeHtml(humanize(request.request_type))}</button>`).join('')}
        ${inMonth && !entries.length && !leave.length ? `<button type="button" class="shift-month-empty" data-shifts-month-day="${escapeHtml(date)}">${canManage() ? 'Add or review shifts' : 'No shifts'}</button>` : ''}
        ${!inMonth ? `<button type="button" class="shift-month-empty" data-shifts-month-adjacent="${escapeHtml(date)}">Open ${escapeHtml(formatDay(date, { month: 'short' }))}</button>` : ''}
        ${remaining ? `<button type="button" class="shift-month-more" data-shifts-month-day="${escapeHtml(date)}">+${remaining} more shift${remaining === 1 ? '' : 's'}</button>` : ''}
      </div>
    </section>`;
  }

  function selectedDayMarkup() {
    if (!state.selectedDate || state.selectedDate.slice(0, 7) !== state.monthStart.slice(0, 7)) return '';
    const entries = shiftsForDate(state.selectedDate);
    const leave = leaveForDate(state.selectedDate);
    const manager = canManage();

    return `<section class="shift-month-day-detail">
      <header>
        <div><span>Selected day</span><h3>${escapeHtml(formatDay(state.selectedDate, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }))}</h3></div>
        <div class="shift-month-day-header-actions">
          ${manager ? `<button type="button" class="shift-month-add" data-shifts-month-add-day="${escapeHtml(state.selectedDate)}"><i data-lucide="plus"></i>Add shift</button>` : ''}
          <button type="button" class="shift-month-open-week" data-shifts-month-open-week="${escapeHtml(state.selectedDate)}"><i data-lucide="calendar-range"></i>Open weekly planner</button>
        </div>
      </header>
      <div class="shift-month-day-list">
        ${entries.length ? entries.map((shift) => {
          const person = personFor(shift.person_id);
          const response = responseForShift(shift);
          const warnings = shiftWarnings(shift);
          const own = person?.profile_id === state.staff?.id;
          return `<article class="${warnings.length ? 'has-warning' : ''}">
            <span class="shift-month-detail-time">${escapeHtml(timeFromLocal(shift.starts_local))}<small>${escapeHtml(timeFromLocal(shift.ends_local))}</small></span>
            <div><strong>${escapeHtml(shift.person_name || person?.display_name || 'Team member')}</strong><small>${escapeHtml(shift.role_name || person?.default_role || 'Team')} · ${hoursForShift(shift).toFixed(1)} h${Number(shift.break_minutes || 0) ? ` · ${Number(shift.break_minutes)} min break` : ''}</small>${shift.note ? `<p>${escapeHtml(shift.note)}</p>` : ''}${warnings.length ? `<div class="shift-month-warning-list">${warnings.map((warning) => `<span><i data-lucide="triangle-alert"></i>${escapeHtml(warning)}</span>`).join('')}</div>` : ''}</div>
            <span class="shift-month-response is-${responseTone(response)}">${escapeHtml(humanize(response?.response || 'pending'))}</span>
            <div class="shift-month-detail-actions">
              ${manager ? `<button type="button" data-shifts-month-edit="${escapeHtml(shift.id)}"><i data-lucide="pencil"></i>Edit</button><button type="button" class="is-danger" data-shifts-month-remove="${escapeHtml(shift.id)}"><i data-lucide="trash-2"></i>Remove</button>` : ''}
              ${!manager && own ? `<button type="button" class="is-confirm" data-shifts-month-respond="confirmed" data-shift-id="${escapeHtml(shift.id)}"><i data-lucide="circle-check-big"></i>Confirm</button><button type="button" data-shifts-month-respond="change_requested" data-shift-id="${escapeHtml(shift.id)}"><i data-lucide="message-circle-more"></i>Request change</button>` : ''}
            </div>
          </article>`;
        }).join('') : `<div class="shift-month-day-empty"><i data-lucide="calendar-x-2"></i><span>No shifts on this day.</span>${manager ? `<button type="button" data-shifts-month-add-day="${escapeHtml(state.selectedDate)}"><i data-lucide="plus"></i>Add first shift</button>` : ''}</div>`}
        ${leave.map((request) => `<article class="is-leave"><span class="shift-month-detail-time"><i data-lucide="calendar-off-2"></i></span><div><strong>${escapeHtml(request.person_name || personFor(request.person_id)?.display_name || 'Team member')}</strong><small>${escapeHtml(humanize(request.request_type))} · approved time off</small>${request.note ? `<p>${escapeHtml(request.note)}</p>` : ''}</div><span class="shift-month-response is-approved">Approved</span></article>`).join('')}
      </div>
    </section>`;
  }

  function shiftModalMarkup() {
    if (!state.modal || state.modal.mode !== 'shift') return '';
    const shift = state.modal.shift || null;
    const date = state.modal.date || dateFromLocal(shift?.starts_local) || state.selectedDate || state.monthStart;
    const start = shift?.starts_local || `${date}T11:30:00`;
    const end = shift?.ends_local || `${date}T17:00:00`;

    return `<div class="shift-modal shift-month-modal" role="dialog" aria-modal="true" aria-labelledby="shift-month-modal-title">
      <div class="shift-modal-backdrop" data-shifts-month-close></div>
      <section>
        <header><div><span>Monthly planner</span><h2 id="shift-month-modal-title">${shift ? 'Edit shift' : 'Add shift'}</h2></div><button type="button" data-shifts-month-close aria-label="Close"><i data-lucide="x"></i></button></header>
        <form data-shifts-month-shift-form>
          <input type="hidden" name="shift_id" value="${escapeHtml(shift?.id || '')}" />
          <div class="shift-form-grid">
            <label><span>Team member</span><select name="person_id" required>${people().filter((person) => person.active).map((person) => `<option value="${escapeHtml(person.id)}" ${person.id === shift?.person_id ? 'selected' : ''}>${escapeHtml(person.display_name)}${person.login_enabled ? '' : ' · schedule only'}</option>`).join('')}</select></label>
            <label><span>Role</span><input name="role_name" maxlength="120" value="${escapeHtml(shift?.role_name || '')}" placeholder="Bartender, opening, closing…" /></label>
            <label><span>Starts</span><input type="datetime-local" name="starts_local" required value="${escapeHtml(String(start).slice(0, 16))}" /></label>
            <label><span>Ends</span><input type="datetime-local" name="ends_local" required value="${escapeHtml(String(end).slice(0, 16))}" /></label>
            <label><span>Break minutes</span><input type="number" name="break_minutes" min="0" max="720" step="5" value="${Number(shift?.break_minutes || 0)}" /></label>
            <label class="is-wide"><span>Shift note</span><textarea name="note" rows="3" maxlength="3000" placeholder="Opening duties, handover context, special event…">${escapeHtml(shift?.note || '')}</textarea></label>
          </div>
          <p class="shift-modal-note"><i data-lucide="info"></i>Save as many dates as needed, then use <strong>Publish month</strong> once the full plan is ready for staff.</p>
          <footer><button type="button" class="shift-secondary" data-shifts-month-close>Cancel</button><button type="submit" class="shift-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>Save shift</button></footer>
        </form>
      </section>
    </div>`;
  }

  function loadingMarkup() {
    return `<section class="shift-month-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading ${escapeHtml(monthLabel(state.monthStart))}</h2><p>Preparing the complete monthly plan and latest staff-visible publication.</p></section>`;
  }

  function errorMarkup() {
    return `<section class="shift-month-state"><span class="is-error"><i data-lucide="calendar-x-2"></i></span><h2>Month schedule unavailable</h2><p>${escapeHtml(state.error)}</p><button type="button" data-shifts-month-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function monthMarkup() {
    if (state.loading && !state.workspace) return loadingMarkup();
    if (state.error && !state.workspace) return errorMarkup();

    const bounds = monthBounds(state.monthStart);
    const dates = [];
    for (let date = bounds.gridStart; date <= bounds.gridEnd; date = addDays(date, 1)) dates.push(date);
    const manager = canManage();
    const month = monthInfo();

    return `<section class="shift-month-panel">
      ${toolbarMarkup()}
      ${feedbackMarkup()}
      ${summaryMarkup()}
      <div class="shift-month-note"><i data-lucide="shield-check"></i><span>${manager ? `Edit the complete ${escapeHtml(monthLabel(state.monthStart))} plan here. Staff continue seeing revision ${Number(month.revision || month.latest_publication?.revision || 0)} until you publish the month${month.has_unpublished_changes ? '; unpublished changes are currently private' : ''}. Production public.shifts remains unchanged.` : `You are viewing the latest published ${escapeHtml(monthLabel(state.monthStart))} plan${month.latest_publication ? ` · revision ${Number(month.revision || month.latest_publication?.revision || 0)}` : ''}. Manager drafts remain private until the full month is published.`}</span></div>
      <div class="shift-month-calendar-scroll">
        <div class="shift-month-weekdays">${WEEKDAY_ORDER.map((day) => `<span>${DAY_SHORT[day]}</span>`).join('')}</div>
        <div class="shift-month-grid">${dates.map(monthCellMarkup).join('')}</div>
      </div>
      ${selectedDayMarkup()}
      ${shiftModalMarkup()}
    </section>`;
  }

  function ensureMonthTab() {
    const tabs = host()?.querySelector('.shift-tabs');
    if (!tabs) return null;
    let button = tabs.querySelector('[data-shifts-tab="month"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.shiftsTab = 'month';
      button.innerHTML = '<i data-lucide="calendar-range"></i>Month';
      const schedule = tabs.querySelector('[data-shifts-tab="schedule"]');
      if (schedule?.nextSibling) tabs.insertBefore(button, schedule.nextSibling);
      else tabs.appendChild(button);
    }
    button.classList.toggle('is-active', state.active);
    button.setAttribute('aria-selected', state.active ? 'true' : 'false');
    if (state.active) {
      tabs.querySelectorAll('[data-shifts-tab]:not([data-shifts-tab="month"])').forEach((tab) => tab.classList.remove('is-active'));
    }
    return button;
  }

  function ensurePanel() {
    const element = host();
    if (!element) return null;
    let panel = element.querySelector('[data-shifts-month-panel]');
    if (!panel) {
      panel = document.createElement('div');
      panel.dataset.shiftsMonthPanel = 'true';
      const trust = element.querySelector('.shift-trust');
      if (trust) trust.before(panel);
      else element.querySelector('.shifts-shell')?.appendChild(panel);
    }
    return panel;
  }

  function renderPanel() {
    if (!state.active) return;
    const panel = ensurePanel();
    if (!panel || !state.monthStart) return;
    panel.innerHTML = monthMarkup();
    document.body.classList.toggle('shift-modal-open', Boolean(state.modal));
    window.lucide?.createIcons?.();
  }

  function apply() {
    const element = host();
    if (!element || !element.querySelector('.shift-tabs')) return false;
    ensureMonthTab();
    element.classList.toggle('shifts-month-active', state.active);
    if (state.active) {
      if (!state.monthStart) state.monthStart = monthStartFor(window.AtlasShifts?.week?.() || venueDate());
      renderPanel();
      if (!state.loading && state.workspace?.month?.month_start !== state.monthStart) loadMonth();
    } else {
      element.querySelector('[data-shifts-month-panel]')?.remove();
      state.modal = null;
      document.body.classList.remove('shift-modal-open');
    }
    return true;
  }

  function scheduleApply() {
    if (state.frame) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = null;
      apply();
    });
  }

  async function loadMonth(options = {}) {
    if (!state.active || state.loading || !viewVisible() || state.modal) return;
    if (!options.force && state.workspace?.month?.month_start === state.monthStart) return;

    const requestSerial = ++state.requestSerial;
    state.loading = !state.workspace;
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    renderPanel();

    try {
      const payload = await api('month-snapshot', { params: { month_start: state.monthStart } });
      if (requestSerial !== state.requestSerial) return;
      state.workspace = payload.workspace || {};
      state.staff = payload.staff || state.staff;
      state.policy = payload.policy || state.policy;
      const today = venueDate();
      if (!state.selectedDate || state.selectedDate.slice(0, 7) !== state.monthStart.slice(0, 7)) {
        state.selectedDate = today.slice(0, 7) === state.monthStart.slice(0, 7) ? today : state.monthStart;
      }
      state.error = null;
    } catch (error) {
      if (requestSerial !== state.requestSerial) return;
      state.error = error instanceof Error ? error.message : 'The month schedule could not load.';
    } finally {
      if (requestSerial === state.requestSerial) {
        state.loading = false;
        renderPanel();
      }
    }
  }

  async function mutate(action, body, successMessage, options = {}) {
    if (state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.message = null;
    renderPanel();

    try {
      const payload = await api(action, {
        method: 'POST',
        body: { current_month: state.monthStart, ...body }
      });
      state.workspace = payload.workspace || state.workspace;
      state.staff = payload.staff || state.staff;
      state.policy = payload.policy || state.policy;
      state.modal = null;
      if (options.selectedDate) state.selectedDate = options.selectedDate;
      state.message = successMessage;
      window.AtlasTeamUnreadBadge?.refresh?.();
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The month schedule change could not be saved.';
    } finally {
      state.submitting = false;
      renderPanel();
    }
  }

  function formValue(form, name) {
    return form.elements.namedItem(name)?.value?.trim?.() || '';
  }

  function submitShift(form) {
    const startsLocal = formValue(form, 'starts_local');
    const endsLocal = formValue(form, 'ends_local');
    const startDate = startsLocal.slice(0, 10);

    if (startDate.slice(0, 7) !== state.monthStart.slice(0, 7)) {
      state.error = `The shift must start inside ${monthLabel(state.monthStart)}. Open another month to move it there.`;
      renderPanel();
      return;
    }
    if (endsLocal <= startsLocal) {
      state.error = 'Shift end must be after shift start.';
      renderPanel();
      return;
    }

    mutate('save-shift', {
      week_start: mondayFor(startDate),
      shift_id: formValue(form, 'shift_id') || null,
      person_id: formValue(form, 'person_id'),
      role_name: formValue(form, 'role_name') || null,
      starts_local: startsLocal,
      ends_local: endsLocal,
      break_minutes: Number(formValue(form, 'break_minutes') || 0),
      note: formValue(form, 'note') || null
    }, 'Shift saved to the private monthly draft. Publish the month when the complete plan is ready for staff.', {
      selectedDate: startDate
    });
  }

  function navigateToWeek(date) {
    const targetWeek = mondayFor(date);
    const currentWeek = window.AtlasShifts?.week?.() || targetWeek;
    state.active = false;
    state.modal = null;
    const scheduleTab = host()?.querySelector('[data-shifts-tab="schedule"]');
    scheduleTab?.click();

    window.requestAnimationFrame(() => {
      const refreshedCurrent = window.AtlasShifts?.week?.() || currentWeek;
      const deltaDays = Math.round((dateFromKey(targetWeek) - dateFromKey(refreshedCurrent)) / 86400000);
      const deltaWeeks = Math.round(deltaDays / 7);
      if (!deltaWeeks) return;
      const proxy = document.createElement('button');
      proxy.type = 'button';
      proxy.hidden = true;
      proxy.dataset.shiftsWeek = String(deltaWeeks);
      host()?.appendChild(proxy);
      proxy.click();
      proxy.remove();
    });
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    const tab = target.closest('[data-shifts-tab]');
    if (tab) {
      state.active = tab.dataset.shiftsTab === 'month';
      if (state.active) {
        state.monthStart = state.monthStart || monthStartFor(window.AtlasShifts?.week?.() || venueDate());
        state.error = null;
        state.message = null;
      }
      scheduleApply();
      if (state.active) window.setTimeout(() => loadMonth(), 0);
      return;
    }

    if (!state.active) return;

    if (target.closest('[data-shifts-month-close]')) {
      state.modal = null;
      state.error = null;
      renderPanel();
      return;
    }

    const navigation = target.closest('[data-shifts-month-nav]');
    if (navigation) {
      state.monthStart = addMonths(state.monthStart, Number(navigation.dataset.shiftsMonthNav || 0));
      state.workspace = null;
      state.error = null;
      state.message = null;
      state.selectedDate = null;
      renderPanel();
      loadMonth({ force: true });
      return;
    }

    if (target.closest('[data-shifts-month-today]')) {
      state.monthStart = monthStartFor(venueDate());
      state.workspace = null;
      state.error = null;
      state.message = null;
      state.selectedDate = venueDate();
      renderPanel();
      loadMonth({ force: true });
      return;
    }

    if (target.closest('[data-shifts-month-refresh]')) {
      loadMonth({ force: true });
      return;
    }

    const adjacent = target.closest('[data-shifts-month-adjacent]');
    if (adjacent) {
      state.monthStart = monthStartFor(adjacent.dataset.shiftsMonthAdjacent);
      state.workspace = null;
      state.error = null;
      state.message = null;
      state.selectedDate = adjacent.dataset.shiftsMonthAdjacent;
      renderPanel();
      loadMonth({ force: true });
      return;
    }

    const day = target.closest('[data-shifts-month-day]');
    if (day) {
      state.selectedDate = day.dataset.shiftsMonthDay;
      renderPanel();
      return;
    }

    const addDay = target.closest('[data-shifts-month-add-day]');
    if (addDay) {
      state.selectedDate = addDay.dataset.shiftsMonthAddDay;
      state.modal = { mode: 'shift', date: state.selectedDate, shift: null };
      state.error = null;
      renderPanel();
      return;
    }

    if (target.closest('[data-shifts-month-add]')) {
      const date = state.selectedDate?.slice(0, 7) === state.monthStart.slice(0, 7)
        ? state.selectedDate
        : state.monthStart;
      state.selectedDate = date;
      state.modal = { mode: 'shift', date, shift: null };
      state.error = null;
      renderPanel();
      return;
    }

    const edit = target.closest('[data-shifts-month-edit]');
    if (edit) {
      const shift = shifts().find((entry) => entry.id === edit.dataset.shiftsMonthEdit);
      if (shift) {
        state.selectedDate = dateFromLocal(shift.starts_local);
        state.modal = { mode: 'shift', date: state.selectedDate, shift };
        state.error = null;
        renderPanel();
      }
      return;
    }

    const remove = target.closest('[data-shifts-month-remove]');
    if (remove) {
      const shift = shifts().find((entry) => entry.id === remove.dataset.shiftsMonthRemove);
      if (!shift) return;
      if (!window.confirm(`Remove ${shift.person_name || personFor(shift.person_id)?.display_name || 'this team member'}'s ${timeFromLocal(shift.starts_local)} shift from ${formatDay(dateFromLocal(shift.starts_local), { weekday: 'long', day: '2-digit', month: 'short' })}? Staff will keep seeing the previous published month until you publish the update.`)) return;
      mutate('cancel-shift', { shift_id: shift.id }, 'Shift removed from the private monthly draft. Publish the month update to make the change visible to staff.', {
        selectedDate: dateFromLocal(shift.starts_local)
      });
      return;
    }

    if (target.closest('[data-shifts-month-publish]')) {
      const month = monthInfo();
      const note = window.prompt(`Publication note for ${monthLabel(state.monthStart)} (optional):`, month.note || '') || '';
      const revision = Number(month.revision || month.latest_publication?.revision || 0) + 1;
      if (!window.confirm(`Publish the complete ${monthLabel(state.monthStart)} schedule as revision ${revision}? Staff will immediately see this monthly plan and all affected weekly views will update.`)) return;
      mutate('publish-month', {
        month_start: state.monthStart,
        note: note.trim() || null
      }, `${monthLabel(state.monthStart)} schedule published to staff as revision ${revision}.`);
      return;
    }

    const respond = target.closest('[data-shifts-month-respond]');
    if (respond) {
      const response = respond.dataset.shiftsMonthRespond;
      let note = null;
      if (response !== 'confirmed') {
        note = window.prompt('Explain the requested change:');
        if (!note?.trim()) return;
      }
      mutate('respond', {
        shift_id: respond.dataset.shiftId,
        response,
        note: note?.trim() || null
      }, response === 'confirmed' ? 'Shift confirmed.' : 'Shift change request sent.');
      return;
    }

    const openWeek = target.closest('[data-shifts-month-open-week]');
    if (openWeek) navigateToWeek(openWeek.dataset.shiftsMonthOpenWeek);
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !state.active || !host()?.contains(form)) return;
    if (!form.matches('[data-shifts-month-shift-form]')) return;
    event.preventDefault();
    event.stopPropagation();
    submitShift(form);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.modal) {
      state.modal = null;
      state.error = null;
      renderPanel();
    }
  }

  function mutationIsInsideMonth(record) {
    const target = record.target instanceof Element ? record.target : record.target?.parentElement;
    return Boolean(target?.closest?.('[data-shifts-month-panel]'));
  }

  function init() {
    if (state.initialized || !window.AtlasShifts || !host()) return false;
    state.initialized = true;
    state.monthStart = monthStartFor(window.AtlasShifts.week?.() || venueDate());

    document.addEventListener('click', handleClick, true);
    document.addEventListener('submit', handleSubmit, true);
    document.addEventListener('keydown', handleKeydown, true);

    state.observer = new MutationObserver((records) => {
      if (records.some((record) => !mutationIsInsideMonth(record))) scheduleApply();
    });
    state.observer.observe(host(), { childList: true, subtree: true });

    state.pollTimer = window.setInterval(() => {
      if (state.active && viewVisible() && !document.hidden && !state.modal && !state.submitting) {
        loadMonth({ force: true, silent: true });
      }
    }, REFRESH_MS);

    window.addEventListener('focus', () => {
      if (state.active && viewVisible() && !state.modal) loadMonth({ force: true, silent: true });
    });
    window.addEventListener('online', () => {
      if (state.active && !state.modal) loadMonth({ force: true });
    });
    window.addEventListener('pagehide', () => {
      state.observer?.disconnect();
      if (state.frame) window.cancelAnimationFrame(state.frame);
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      state.requestSerial += 1;
    }, { once: true });

    apply();
    return true;
  }

  window.AtlasShiftsMonth = {
    open: () => {
      window.AtlasShifts?.open?.();
      window.setTimeout(() => host()?.querySelector('[data-shifts-tab="month"]')?.click(), 120);
    },
    refresh: () => loadMonth({ force: true }),
    month: () => state.monthStart,
    snapshot: () => state.workspace,
    addShift: (date) => {
      const target = date || state.selectedDate || state.monthStart || venueDate();
      state.monthStart = monthStartFor(target);
      state.selectedDate = target;
      state.active = true;
      state.modal = { mode: 'shift', date: target, shift: null };
      scheduleApply();
    }
  };

  if (!init()) {
    const timer = window.setInterval(() => {
      if (init()) window.clearInterval(timer);
    }, 120);
    window.setTimeout(() => window.clearInterval(timer), 12000);
  }
})();
