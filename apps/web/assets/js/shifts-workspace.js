(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 18000;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const RESPONSE_LABELS = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    change_requested: 'Change requested',
    declined: 'Declined'
  };

  const state = {
    workspace: null,
    staff: null,
    policy: null,
    weekStart: null,
    tab: 'schedule',
    loading: false,
    submitting: false,
    error: null,
    message: null,
    modal: null,
    availabilityPersonId: null,
    initialized: false,
    viewObserver: null,
    loadTimer: null
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
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
    return dateKey(date);
  }

  function formatDate(value, options = {}) {
    if (!value) return '';
    const date = dateFromKey(String(value).slice(0, 10));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: options.day || '2-digit',
      month: options.month || 'short',
      year: options.year || undefined,
      weekday: options.weekday || undefined
    }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function timeFromLocal(value) {
    if (!value) return '';
    return String(value).slice(11, 16);
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

  function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return Promise.resolve(null);
    return client.auth.getSession().then((result) => {
      if (result.error) throw result.error;
      return result.data.session || null;
    });
  }

  async function api(action, options = {}) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Shifts API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Shifts.');

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
      if (!response.ok) throw new Error(payload.error || `Shifts request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Shifts took too long to respond. Check the connection and try again.');
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

  function events() {
    return Array.isArray(state.workspace?.events) ? state.workspace.events : [];
  }

  function permission(name) {
    return Boolean(state.workspace?.permissions?.[name]);
  }

  function personFor(id) {
    return people().find((person) => person.id === id) || null;
  }

  function responseFor(shift) {
    return responses().find((response) => response.shift_id === shift.id && response.person_id === shift.person_id) || null;
  }

  function ownPerson() {
    return people().find((person) => person.profile_id === state.staff?.id) || null;
  }

  function selectedAvailabilityPerson() {
    const selected = people().find((person) => person.id === state.availabilityPersonId);
    return selected || ownPerson() || people().find((person) => person.active) || null;
  }

  function weekDates() {
    return Array.from({ length: 7 }, (_, index) => addDays(state.weekStart, index));
  }

  function weekLabel() {
    const end = addDays(state.weekStart, 6);
    return `${formatDate(state.weekStart, { day: '2-digit', month: 'short' })} – ${formatDate(end, { day: '2-digit', month: 'short', year: 'numeric' })}`;
  }

  function shiftWarnings(shift) {
    const warnings = [];
    const date = dateFromLocal(shift.starts_local);
    const weekday = dateFromKey(date).getUTCDay();
    const recurring = availability().find((entry) => entry.person_id === shift.person_id && Number(entry.weekday) === weekday);
    if (recurring?.unavailable) warnings.push('Marked unavailable');
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

  function summary() {
    const allShifts = shifts();
    const plannedHours = allShifts.reduce((total, shift) => total + hoursForShift(shift), 0);
    const scheduledPeople = new Set(allShifts.map((shift) => shift.person_id)).size;
    const pending = responses().filter((response) => response.response === 'pending').length;
    const open = responses().filter((response) => response.manager_status === 'open').length;
    return { shiftCount: allShifts.length, plannedHours, scheduledPeople, pending, open };
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="shift-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    if (state.message) return `<div class="shift-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    return '';
  }

  function statusPill() {
    const week = state.workspace?.week || {};
    const label = week.status === 'published'
      ? `Published · revision ${Number(week.revision || 0)}`
      : 'Draft schedule';
    return `<span class="shift-week-status is-${escapeHtml(week.status || 'draft')}">${escapeHtml(label)}</span>`;
  }

  function heroMarkup() {
    const canManage = permission('can_manage_schedule');
    return `<header class="shifts-hero">
      <div class="shifts-hero-copy">
        <span><i data-lucide="calendar-range"></i>Checkpoint F · People operations</span>
        <h1>Shifts</h1>
        <p>Plan the week, collect availability, publish one clear schedule and keep every response in one place.</p>
      </div>
      <div class="shifts-hero-actions">
        <button type="button" class="shift-secondary" data-shifts-handover><i data-lucide="messages-square"></i>Shift handover</button>
        ${canManage ? '<button type="button" class="shift-secondary" data-shifts-add-person><i data-lucide="user-plus"></i>Add team member</button>' : ''}
        <button type="button" class="shift-secondary" data-shifts-refresh><i data-lucide="refresh-cw"></i>Refresh</button>
      </div>
    </header>`;
  }

  function weekToolbarMarkup() {
    const canManage = permission('can_manage_schedule');
    const week = state.workspace?.week || {};
    return `<section class="shift-week-toolbar">
      <div class="shift-week-navigation">
        <button type="button" data-shifts-week="-1" aria-label="Previous week"><i data-lucide="chevron-left"></i></button>
        <button type="button" class="shift-week-today" data-shifts-today>Today</button>
        <button type="button" data-shifts-week="1" aria-label="Next week"><i data-lucide="chevron-right"></i></button>
        <div><span>Week of</span><strong>${escapeHtml(weekLabel())}</strong></div>
        ${statusPill()}
        ${week.has_unpublished_changes ? '<span class="shift-unsaved"><i data-lucide="circle-dot-dashed"></i>Unpublished changes</span>' : ''}
      </div>
      ${canManage ? `<div class="shift-week-actions">
        <button type="button" class="shift-secondary" data-shifts-copy-previous ${shifts().length ? 'disabled title="The selected week already contains shifts"' : ''}><i data-lucide="copy"></i>Copy previous week</button>
        <button type="button" class="shift-primary" data-shifts-add-shift><i data-lucide="plus"></i>Add shift</button>
        <button type="button" class="shift-publish" data-shifts-publish ${!shifts().length ? 'disabled' : ''}><i data-lucide="send"></i>${week.status === 'published' ? 'Publish update' : 'Publish week'}</button>
      </div>` : ''}
    </section>`;
  }

  function summaryMarkup() {
    const values = summary();
    return `<div class="shift-summary-grid">
      <article><span><i data-lucide="calendar-check-2"></i>Planned shifts</span><strong>${values.shiftCount}</strong><small>${state.workspace?.week?.status === 'published' ? 'Latest visible schedule' : 'Current manager draft'}</small></article>
      <article><span><i data-lucide="clock-3"></i>Planned hours</span><strong>${values.plannedHours.toFixed(1)}</strong><small>Breaks deducted</small></article>
      <article><span><i data-lucide="users-round"></i>People scheduled</span><strong>${values.scheduledPeople}</strong><small>${people().filter((person) => person.active).length} active in the roster</small></article>
      <article class="${values.open ? 'is-attention' : ''}"><span><i data-lucide="message-circle-warning"></i>Responses</span><strong>${values.open || values.pending}</strong><small>${values.open ? `${values.open} change request${values.open === 1 ? '' : 's'}` : `${values.pending} awaiting confirmation`}</small></article>
    </div>`;
  }

  function tabMarkup() {
    const tabs = [
      ['schedule', 'calendar-days', 'Schedule'],
      ['availability', 'calendar-clock', 'Availability'],
      ['time-off', 'calendar-off-2', 'Time off'],
      ['confirmations', 'badge-check', 'Confirmations'],
      ['activity', 'history', 'Activity']
    ];
    return `<div class="shift-tabs" role="tablist">${tabs.map(([key, icon, label]) => `<button type="button" role="tab" class="${state.tab === key ? 'is-active' : ''}" data-shifts-tab="${key}"><i data-lucide="${icon}"></i>${label}</button>`).join('')}</div>`;
  }

  function responseBadge(response) {
    const value = response?.response || 'pending';
    return `<span class="shift-response-badge is-${escapeHtml(value)}">${escapeHtml(RESPONSE_LABELS[value] || humanize(value))}</span>`;
  }

  function shiftCard(shift) {
    const person = personFor(shift.person_id) || { display_name: shift.person_name || 'Team member' };
    const response = responseFor(shift);
    const warnings = shiftWarnings(shift);
    const own = person.profile_id === state.staff?.id;
    const canManage = permission('can_manage_schedule');
    const published = state.workspace?.week?.status === 'published';
    return `<article class="shift-card ${warnings.length ? 'has-warning' : ''}" data-shift-id="${escapeHtml(shift.id)}">
      <header>
        <div><strong>${escapeHtml(person.display_name)}</strong><small>${escapeHtml(shift.role_name || person.default_role || 'Team')}</small></div>
        ${responseBadge(response)}
      </header>
      <div class="shift-time"><i data-lucide="clock-3"></i><strong>${escapeHtml(timeFromLocal(shift.starts_local))}–${escapeHtml(timeFromLocal(shift.ends_local))}</strong><span>${hoursForShift(shift).toFixed(1)} h</span></div>
      ${Number(shift.break_minutes || 0) ? `<p><i data-lucide="coffee"></i>${Number(shift.break_minutes)} min break</p>` : ''}
      ${shift.note ? `<p><i data-lucide="notebook-pen"></i>${escapeHtml(shift.note)}</p>` : ''}
      ${!person.login_enabled ? '<p class="shift-no-login"><i data-lucide="user-round-x"></i>Schedule-only profile · no Atlas confirmation</p>' : ''}
      ${warnings.length ? `<div class="shift-warning-list">${warnings.map((warning) => `<span><i data-lucide="triangle-alert"></i>${escapeHtml(warning)}</span>`).join('')}</div>` : ''}
      <footer>
        ${canManage ? `<button type="button" data-shifts-edit-shift="${escapeHtml(shift.id)}"><i data-lucide="pencil"></i>Edit</button><button type="button" class="is-danger" data-shifts-cancel-shift="${escapeHtml(shift.id)}"><i data-lucide="trash-2"></i>Remove</button>` : ''}
        ${!canManage && own && published ? `<button type="button" class="is-confirm" data-shifts-respond="confirmed" data-shift-id="${escapeHtml(shift.id)}"><i data-lucide="circle-check-big"></i>Confirm</button><button type="button" data-shifts-respond="change_requested" data-shift-id="${escapeHtml(shift.id)}"><i data-lucide="message-circle-more"></i>Request change</button>` : ''}
      </footer>
    </article>`;
  }

  function scheduleMarkup() {
    const today = venueDate();
    const days = weekDates();
    const canManage = permission('can_manage_schedule');
    return `<section class="shift-schedule-panel">
      <div class="shift-schedule-note"><i data-lucide="shield-check"></i><span>${canManage ? 'You are editing the isolated Checkpoint F schedule. Production public.shifts remains unchanged.' : 'The team sees only the latest published revision. Draft manager changes remain private.'}</span></div>
      <div class="shift-week-grid">${days.map((date) => {
        const dayNumber = dateFromKey(date).getUTCDay();
        const entries = shifts().filter((shift) => dateFromLocal(shift.starts_local) === date);
        return `<section class="shift-day-column ${date === today ? 'is-today' : ''}">
          <header><div><span>${escapeHtml(DAY_SHORT[dayNumber])}</span><strong>${escapeHtml(formatDate(date, { day: '2-digit', month: 'short' }))}</strong></div>${canManage ? `<button type="button" data-shifts-add-day="${escapeHtml(date)}" aria-label="Add shift on ${escapeHtml(DAY_NAMES[dayNumber])}"><i data-lucide="plus"></i></button>` : ''}</header>
          <div class="shift-day-cards">${entries.length ? entries.map(shiftCard).join('') : '<div class="shift-day-empty"><i data-lucide="calendar-x-2"></i><span>No shifts</span></div>'}</div>
        </section>`;
      }).join('')}</div>
      ${!shifts().length ? `<div class="shift-empty-week"><i data-lucide="calendar-plus-2"></i><h3>${canManage ? 'Build the first weekly schedule' : 'No published schedule for this week'}</h3><p>${canManage ? 'Add shifts day by day or copy a completed previous week.' : 'A manager has not published this week yet.'}</p>${canManage ? '<button type="button" class="shift-primary" data-shifts-add-shift><i data-lucide="plus"></i>Add first shift</button>' : ''}</div>` : ''}
    </section>`;
  }

  function availabilityEntry(personId, weekday) {
    return availability().find((entry) => entry.person_id === personId && Number(entry.weekday) === weekday) || null;
  }

  function availabilityMarkup() {
    const person = selectedAvailabilityPerson();
    if (!person) return '<section class="shift-empty-section"><i data-lucide="users-x"></i><h3>No team members available</h3></section>';
    const canChoose = permission('can_manage_all_availability');
    return `<section class="shift-two-column">
      <div class="shift-section-card">
        <header><div><span>Recurring week</span><h2>Availability</h2><p>Save the normal weekly pattern. Approved time off is handled separately.</p></div></header>
        ${canChoose ? `<label class="shift-person-selector"><span>Team member</span><select data-shifts-availability-person>${people().filter((entry) => entry.active).map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === person.id ? 'selected' : ''}>${escapeHtml(entry.display_name)}</option>`).join('')}</select></label>` : `<div class="shift-selected-person"><i data-lucide="user-round"></i><span>${escapeHtml(person.display_name)}</span></div>`}
        <div class="shift-availability-list">${[1,2,3,4,5,6,0].map((weekday) => {
          const entry = availabilityEntry(person.id, weekday) || {};
          return `<form class="shift-availability-row" data-shifts-availability-form data-person-id="${escapeHtml(person.id)}" data-weekday="${weekday}">
            <strong>${escapeHtml(DAY_NAMES[weekday])}</strong>
            <label class="shift-unavailable-toggle"><input type="checkbox" name="unavailable" ${entry.unavailable ? 'checked' : ''}/><span>Unavailable</span></label>
            <label><span>From</span><input type="time" name="available_from" value="${escapeHtml(String(entry.available_from || '').slice(0,5))}" ${entry.unavailable ? 'disabled' : ''}/></label>
            <label><span>To</span><input type="time" name="available_to" value="${escapeHtml(String(entry.available_to || '').slice(0,5))}" ${entry.unavailable ? 'disabled' : ''}/></label>
            <label class="is-note"><span>Note</span><input name="note" maxlength="2000" value="${escapeHtml(entry.note || '')}" placeholder="Optional" /></label>
            <button type="submit" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>Save</button>
          </form>`;
        }).join('')}</div>
      </div>
      <aside class="shift-section-card shift-guidance-card"><header><div><span>Planning signal</span><h2>How Atlas uses availability</h2></div></header><ul><li>Unavailable days are flagged on manager shift cards.</li><li>Approved leave appears as a scheduling warning.</li><li>Availability does not automatically delete a manager’s draft.</li><li>Coverage targets and labour-cost rules are not configured yet.</li></ul></aside>
    </section>`;
  }

  function timeOffMarkup() {
    const own = ownPerson();
    const canManage = permission('can_decide_time_off');
    const selectable = canManage ? people().filter((person) => person.active) : own ? [own] : [];
    const requests = timeOff();
    return `<section class="shift-two-column">
      <div class="shift-section-card">
        <header><div><span>Availability exception</span><h2>Request time off</h2><p>Managers receive requests immediately. Manager-created requests are approved automatically.</p></div></header>
        ${selectable.length ? `<form class="shift-time-off-form" data-shifts-time-off-form>
          <label><span>Team member</span><select name="person_id" ${canManage ? '' : 'disabled'}>${selectable.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.display_name)}</option>`).join('')}</select></label>
          <label><span>Type</span><select name="request_type"><option value="vacation">Vacation</option><option value="unavailable">Unavailable</option><option value="sick">Sick</option><option value="other">Other</option></select></label>
          <label><span>Start</span><input type="date" name="starts_on" required value="${escapeHtml(state.weekStart)}" /></label>
          <label><span>End</span><input type="date" name="ends_on" required value="${escapeHtml(state.weekStart)}" /></label>
          <label class="is-wide"><span>Note</span><textarea name="note" rows="3" maxlength="3000" placeholder="Reason or useful scheduling context"></textarea></label>
          <button type="submit" class="shift-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="send"></i>Submit request</button>
        </form>` : '<div class="shift-empty-section"><p>Your Atlas account is not linked to the shift roster.</p></div>'}
      </div>
      <div class="shift-section-card">
        <header><div><span>Requests</span><h2>Time-off history</h2><p>${canManage ? 'Review pending requests and upcoming approved leave.' : 'Your recent requests and decisions.'}</p></div></header>
        <div class="shift-request-list">${requests.length ? requests.map((request) => `<article>
          <span class="shift-request-status is-${escapeHtml(request.status)}">${escapeHtml(humanize(request.status))}</span>
          <div><strong>${escapeHtml(request.person_name || personFor(request.person_id)?.display_name || 'Team member')}</strong><small>${escapeHtml(humanize(request.request_type))} · ${escapeHtml(formatDate(request.starts_on, { day:'2-digit', month:'short' }))}–${escapeHtml(formatDate(request.ends_on, { day:'2-digit', month:'short', year:'numeric' }))}</small>${request.note ? `<p>${escapeHtml(request.note)}</p>` : ''}${request.manager_note ? `<em>Manager: ${escapeHtml(request.manager_note)}</em>` : ''}</div>
          ${canManage && request.status === 'pending' ? `<div class="shift-request-actions"><button type="button" class="is-approve" data-shifts-time-off-decision="approved" data-request-id="${escapeHtml(request.id)}"><i data-lucide="check"></i></button><button type="button" class="is-reject" data-shifts-time-off-decision="rejected" data-request-id="${escapeHtml(request.id)}"><i data-lucide="x"></i></button></div>` : ''}
        </article>`).join('') : '<div class="shift-empty-section"><i data-lucide="calendar-check-2"></i><p>No requests in this period.</p></div>'}</div>
      </div>
    </section>`;
  }

  function confirmationsMarkup() {
    const canManage = permission('can_manage_schedule');
    const rows = responses().map((response) => {
      const shift = shifts().find((entry) => entry.id === response.shift_id);
      const person = personFor(response.person_id);
      return { response, shift, person };
    }).filter((row) => row.shift && row.person);

    return `<section class="shift-section-card">
      <header><div><span>Published schedule</span><h2>Confirmations and requests</h2><p>${canManage ? 'Track every response and close change requests with an auditable manager note.' : 'Confirm your own shifts or request a change from the Schedule tab.'}</p></div></header>
      <div class="shift-confirmation-list">${rows.length ? rows.map(({ response, shift, person }) => `<article>
        <div class="shift-confirmation-date"><strong>${escapeHtml(formatDate(dateFromLocal(shift.starts_local), { weekday:'short', day:'2-digit' }))}</strong><span>${escapeHtml(timeFromLocal(shift.starts_local))}–${escapeHtml(timeFromLocal(shift.ends_local))}</span></div>
        <div><strong>${escapeHtml(person.display_name)}</strong><small>${escapeHtml(shift.role_name || person.default_role || 'Team')}</small>${response.note ? `<p>${escapeHtml(response.note)}</p>` : ''}${response.manager_note ? `<em>Manager: ${escapeHtml(response.manager_note)}</em>` : ''}</div>
        <div class="shift-confirmation-state">${responseBadge(response)}${canManage && response.manager_status === 'open' ? `<span class="is-open">Manager review</span>` : ''}</div>
        ${canManage && response.manager_status === 'open' ? `<div class="shift-confirmation-actions"><button type="button" data-shifts-response-decision="resolved" data-shift-id="${escapeHtml(shift.id)}" data-person-id="${escapeHtml(person.id)}">Resolve</button><button type="button" class="is-reject" data-shifts-response-decision="rejected" data-shift-id="${escapeHtml(shift.id)}" data-person-id="${escapeHtml(person.id)}">Reject</button></div>` : ''}
      </article>`).join('') : '<div class="shift-empty-section"><i data-lucide="badge-check"></i><h3>No confirmation records yet</h3><p>Publishing a week creates confirmation requests for staff with Atlas login access.</p></div>'}</div>
    </section>`;
  }

  function activityMarkup() {
    return `<section class="shift-section-card">
      <header><div><span>Audit trail</span><h2>Recent schedule activity</h2><p>Manager-visible history for schedule, availability, publishing and response changes.</p></div></header>
      <div class="shift-activity-list">${events().length ? events().map((event) => `<article><span><i data-lucide="history"></i></span><div><strong>${escapeHtml(humanize(event.event_type))}</strong><small>${escapeHtml(event.actor_label || 'Atlas')} · ${escapeHtml(formatDateTime(event.created_at))}</small></div></article>`).join('') : '<div class="shift-empty-section"><i data-lucide="history"></i><p>No shift activity recorded yet.</p></div>'}</div>
    </section>`;
  }

  function activeTabMarkup() {
    if (state.tab === 'availability') return availabilityMarkup();
    if (state.tab === 'time-off') return timeOffMarkup();
    if (state.tab === 'confirmations') return confirmationsMarkup();
    if (state.tab === 'activity') return activityMarkup();
    return scheduleMarkup();
  }

  function shiftModalMarkup(modal) {
    const shift = modal.shift || null;
    const date = modal.date || dateFromLocal(shift?.starts_local) || state.weekStart;
    const start = shift?.starts_local || `${date}T11:30:00`;
    const end = shift?.ends_local || `${date}T17:00:00`;
    return `<div class="shift-modal" role="dialog" aria-modal="true" aria-labelledby="shift-modal-title">
      <div class="shift-modal-backdrop" data-shifts-close-modal></div>
      <section><header><div><span>Weekly planner</span><h2 id="shift-modal-title">${shift ? 'Edit shift' : 'Add shift'}</h2></div><button type="button" data-shifts-close-modal aria-label="Close"><i data-lucide="x"></i></button></header>
      <form data-shifts-shift-form>
        <input type="hidden" name="shift_id" value="${escapeHtml(shift?.id || '')}" />
        <div class="shift-form-grid">
          <label><span>Team member</span><select name="person_id" required>${people().filter((person) => person.active).map((person) => `<option value="${escapeHtml(person.id)}" ${person.id === shift?.person_id ? 'selected' : ''}>${escapeHtml(person.display_name)}${person.login_enabled ? '' : ' · schedule only'}</option>`).join('')}</select></label>
          <label><span>Role</span><input name="role_name" maxlength="120" value="${escapeHtml(shift?.role_name || '')}" placeholder="Bartender, opening, closing…" /></label>
          <label><span>Starts</span><input type="datetime-local" name="starts_local" required value="${escapeHtml(String(start).slice(0,16))}" /></label>
          <label><span>Ends</span><input type="datetime-local" name="ends_local" required value="${escapeHtml(String(end).slice(0,16))}" /></label>
          <label><span>Break minutes</span><input type="number" name="break_minutes" min="0" max="720" step="5" value="${Number(shift?.break_minutes || 0)}" /></label>
          <label class="is-wide"><span>Shift note</span><textarea name="note" rows="3" maxlength="3000" placeholder="Opening duties, handover context, special event…">${escapeHtml(shift?.note || '')}</textarea></label>
        </div>
        <footer><button type="button" class="shift-secondary" data-shifts-close-modal>Cancel</button><button type="submit" class="shift-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>Save shift</button></footer>
      </form></section>
    </div>`;
  }

  function personModalMarkup() {
    return `<div class="shift-modal" role="dialog" aria-modal="true" aria-labelledby="shift-person-modal-title"><div class="shift-modal-backdrop" data-shifts-close-modal></div><section><header><div><span>Schedule roster</span><h2 id="shift-person-modal-title">Add team member</h2></div><button type="button" data-shifts-close-modal aria-label="Close"><i data-lucide="x"></i></button></header><form data-shifts-person-form><div class="shift-form-grid"><label><span>Name</span><input name="display_name" required maxlength="160" placeholder="Team member name" /></label><label><span>Email</span><input type="email" name="email" maxlength="320" placeholder="Optional" /></label><label class="is-wide"><span>Default role</span><input name="default_role" maxlength="120" placeholder="Bartender, barback, manager…" /></label></div><p class="shift-modal-note"><i data-lucide="info"></i>This adds a schedule-only person. It does not create an Atlas login account.</p><footer><button type="button" class="shift-secondary" data-shifts-close-modal>Cancel</button><button type="submit" class="shift-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="user-plus"></i>Add to roster</button></footer></form></section></div>`;
  }

  function modalMarkup() {
    if (!state.modal) return '';
    if (state.modal.mode === 'shift') return shiftModalMarkup(state.modal);
    if (state.modal.mode === 'person') return personModalMarkup();
    return '';
  }

  function shellMarkup() {
    return `<section class="shifts-shell">
      ${heroMarkup()}
      ${feedbackMarkup()}
      ${weekToolbarMarkup()}
      ${summaryMarkup()}
      ${tabMarkup()}
      ${activeTabMarkup()}
      <footer class="shift-trust"><i data-lucide="shield-check"></i><span>Private branch planning · Team sees published revisions only · Production shift table unchanged · Availability and responses audited · Push notifications not enabled</span></footer>
      ${modalMarkup()}
    </section>`;
  }

  function loadingMarkup() {
    return `<section class="shift-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading Shifts</h2><p>Preparing the weekly planner, team roster, availability and confirmations.</p></section>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.add('shifts-workspace-host');
    if (state.loading && !state.workspace) element.innerHTML = loadingMarkup();
    else if (state.error && !state.workspace) element.innerHTML = `<section class="shift-state"><span class="is-error"><i data-lucide="calendar-x-2"></i></span><h2>Shifts unavailable</h2><p>${escapeHtml(state.error)}</p><button type="button" class="shift-primary" data-shifts-refresh>Try again</button></section>`;
    else element.innerHTML = shellMarkup();
    document.body.classList.toggle('shift-modal-open', Boolean(state.modal));
    window.lucide?.createIcons?.();
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || (!viewVisible() && !options.force)) return;
    state.loading = !state.workspace;
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot', { params: { week_start: state.weekStart } });
      state.workspace = payload.workspace || {};
      state.staff = payload.staff || state.staff;
      state.policy = payload.policy || state.policy;
      const availablePerson = selectedAvailabilityPerson();
      state.availabilityPersonId = availablePerson?.id || null;
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Shifts could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api(action, {
        method: 'POST',
        body: { current_week: state.weekStart, ...body }
      });
      state.workspace = payload.workspace || state.workspace;
      state.staff = payload.staff || state.staff;
      state.policy = payload.policy || state.policy;
      state.modal = null;
      state.message = successMessage;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The shift change could not be saved.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function formValue(form, name) {
    return form.elements.namedItem(name)?.value?.trim?.() || '';
  }

  function submitShift(form) {
    mutate('save-shift', {
      week_start: state.weekStart,
      shift_id: formValue(form, 'shift_id') || null,
      person_id: formValue(form, 'person_id'),
      role_name: formValue(form, 'role_name') || null,
      starts_local: formValue(form, 'starts_local'),
      ends_local: formValue(form, 'ends_local'),
      break_minutes: Number(formValue(form, 'break_minutes') || 0),
      note: formValue(form, 'note') || null
    }, 'Shift saved to the private weekly draft.');
  }

  function submitPerson(form) {
    mutate('create-person', {
      display_name: formValue(form, 'display_name'),
      email: formValue(form, 'email') || null,
      default_role: formValue(form, 'default_role') || null
    }, 'Schedule-only team member added.');
  }

  function submitAvailability(form) {
    const unavailable = Boolean(form.elements.namedItem('unavailable')?.checked);
    mutate('save-availability', {
      person_id: form.dataset.personId,
      weekday: Number(form.dataset.weekday),
      unavailable,
      available_from: unavailable ? null : formValue(form, 'available_from') || null,
      available_to: unavailable ? null : formValue(form, 'available_to') || null,
      note: formValue(form, 'note') || null
    }, `${DAY_NAMES[Number(form.dataset.weekday)]} availability saved.`);
  }

  function submitTimeOff(form) {
    const personSelect = form.elements.namedItem('person_id');
    mutate('request-time-off', {
      person_id: personSelect?.value || ownPerson()?.id,
      request_type: formValue(form, 'request_type'),
      starts_on: formValue(form, 'starts_on'),
      ends_on: formValue(form, 'ends_on'),
      note: formValue(form, 'note') || null
    }, permission('can_decide_time_off') ? 'Time off recorded as approved.' : 'Time-off request submitted.');
  }

  function openHandover() {
    const teamButton = document.querySelector('.nav-item[data-view="team"]');
    if (teamButton) teamButton.click();
    window.setTimeout(() => window.AtlasTeamMessages?.openChannel?.('shift-handover'), 120);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    if (target.closest('[data-shifts-close-modal]')) {
      state.modal = null;
      render();
      return;
    }
    if (target.closest('[data-shifts-refresh]')) { loadSnapshot({ force: true }); return; }
    if (target.closest('[data-shifts-handover]')) { openHandover(); return; }
    if (target.closest('[data-shifts-today]')) {
      state.weekStart = mondayFor(venueDate());
      state.workspace = null;
      loadSnapshot({ force: true });
      return;
    }

    const weekButton = target.closest('[data-shifts-week]');
    if (weekButton) {
      state.weekStart = addDays(state.weekStart, Number(weekButton.dataset.shiftsWeek || 0) * 7);
      state.workspace = null;
      loadSnapshot({ force: true });
      return;
    }

    const tab = target.closest('[data-shifts-tab]');
    if (tab) {
      state.tab = tab.dataset.shiftsTab || 'schedule';
      state.error = null;
      state.message = null;
      render();
      return;
    }

    const addDay = target.closest('[data-shifts-add-day]');
    if (addDay) {
      state.modal = { mode: 'shift', date: addDay.dataset.shiftsAddDay, shift: null };
      render();
      return;
    }
    if (target.closest('[data-shifts-add-shift]')) {
      state.modal = { mode: 'shift', date: state.weekStart, shift: null };
      render();
      return;
    }
    if (target.closest('[data-shifts-add-person]')) {
      state.modal = { mode: 'person' };
      render();
      return;
    }

    const edit = target.closest('[data-shifts-edit-shift]');
    if (edit) {
      const shift = shifts().find((entry) => entry.id === edit.dataset.shiftsEditShift);
      if (shift) state.modal = { mode: 'shift', shift, date: dateFromLocal(shift.starts_local) };
      render();
      return;
    }

    const cancel = target.closest('[data-shifts-cancel-shift]');
    if (cancel) {
      if (!window.confirm('Remove this shift from the current draft? The audit event will be preserved.')) return;
      mutate('cancel-shift', { shift_id: cancel.dataset.shiftsCancelShift }, 'Shift removed from the draft.');
      return;
    }

    if (target.closest('[data-shifts-copy-previous]')) {
      const source = addDays(state.weekStart, -7);
      if (!window.confirm(`Copy all active shifts from the week of ${formatDate(source, { day:'2-digit', month:'short', year:'numeric' })}?`)) return;
      mutate('copy-week', { source_week: source, target_week: state.weekStart }, 'Previous week copied into this draft.');
      return;
    }

    if (target.closest('[data-shifts-publish]')) {
      const note = window.prompt('Publication note for the team (optional):') || '';
      if (!window.confirm('Publish this weekly schedule to the active team? This creates a new immutable revision.')) return;
      mutate('publish-week', { week_start: state.weekStart, note: note.trim() || null }, 'Weekly schedule published to the team.');
      return;
    }

    const respond = target.closest('[data-shifts-respond]');
    if (respond) {
      const response = respond.dataset.shiftsRespond;
      let note = null;
      if (response !== 'confirmed') {
        note = window.prompt('Explain the requested change:');
        if (!note?.trim()) return;
      }
      mutate('respond', { shift_id: respond.dataset.shiftId, response, note: note?.trim() || null }, response === 'confirmed' ? 'Shift confirmed.' : 'Shift change request sent.');
      return;
    }

    const timeOffDecision = target.closest('[data-shifts-time-off-decision]');
    if (timeOffDecision) {
      const status = timeOffDecision.dataset.shiftsTimeOffDecision;
      const note = window.prompt(status === 'approved' ? 'Approval note (optional):' : 'Reason for rejection:') || '';
      mutate('decide-time-off', { request_id: timeOffDecision.dataset.requestId, status, manager_note: note.trim() || null }, `Time-off request ${status}.`);
      return;
    }

    const responseDecision = target.closest('[data-shifts-response-decision]');
    if (responseDecision) {
      const managerStatus = responseDecision.dataset.shiftsResponseDecision;
      const note = window.prompt('Manager note (required):');
      if (!note?.trim()) return;
      mutate('decide-response', {
        shift_id: responseDecision.dataset.shiftId,
        person_id: responseDecision.dataset.personId,
        manager_status: managerStatus,
        manager_note: note.trim()
      }, `Shift request ${managerStatus}.`);
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;

    if (target.matches('[data-shifts-availability-person]')) {
      state.availabilityPersonId = target.value;
      render();
      return;
    }

    if (target.name === 'unavailable' && target.closest('[data-shifts-availability-form]')) {
      const form = target.closest('[data-shifts-availability-form]');
      form.querySelectorAll('input[type="time"]').forEach((input) => { input.disabled = target.checked; });
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !host()?.contains(form)) return;
    event.preventDefault();
    if (form.matches('[data-shifts-shift-form]')) submitShift(form);
    else if (form.matches('[data-shifts-person-form]')) submitPerson(form);
    else if (form.matches('[data-shifts-availability-form]')) submitAvailability(form);
    else if (form.matches('[data-shifts-time-off-form]')) submitTimeOff(form);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.modal) {
      state.modal = null;
      render();
    }
  }

  function initializeView() {
    const element = host();
    if (!element) return false;
    element.classList.remove('placeholder-view');
    element.classList.add('shifts-workspace-host');
    return true;
  }

  function checkVisibility() {
    if (!viewVisible()) return;
    if (!state.workspace && !state.loading) loadSnapshot({ force: true });
  }

  function init() {
    if (state.initialized || !initializeView()) return;
    state.initialized = true;
    state.weekStart = mondayFor(venueDate());
    render();

    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('keydown', handleKeydown);

    state.viewObserver = new MutationObserver(() => {
      window.clearTimeout(state.loadTimer);
      state.loadTimer = window.setTimeout(checkVisibility, 80);
    });
    state.viewObserver.observe(host(), { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

    window.addEventListener('focus', () => {
      if (viewVisible()) loadSnapshot({ force: true, silent: true });
    });
    window.addEventListener('pagehide', () => state.viewObserver?.disconnect(), { once: true });
    checkVisibility();
  }

  window.AtlasShifts = {
    open: () => {
      document.querySelector('.nav-item[data-view="shifts"]')?.click();
      window.setTimeout(checkVisibility, 100);
    },
    refresh: () => loadSnapshot({ force: true }),
    snapshot: () => state.workspace,
    week: () => state.weekStart
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
