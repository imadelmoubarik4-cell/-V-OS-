(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  const state = {
    active: false,
    monthStart: null,
    data: null,
    loading: false,
    error: null,
    selectedDate: null,
    observer: null,
    frame: null,
    initialized: false,
    requestSerial: 0,
    renderKey: null,
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

  function weekStartsForMonth(monthStart) {
    const bounds = monthBounds(monthStart);
    const values = [];
    for (let date = bounds.gridStart; date <= bounds.gridEnd; date = addDays(date, 7)) {
      values.push(date);
    }
    return values;
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

  async function fetchWeek(weekStart, accessToken) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Shifts API is not configured for this preview.');
    const url = new URL(apiUrl);
    url.searchParams.set('action', 'snapshot');
    url.searchParams.set('week_start', weekStart);

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json'
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Month calendar request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The month calendar took too long to load. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function uniqueRows(rows, keyFor) {
    const map = new Map();
    rows.forEach((row) => {
      const key = keyFor(row);
      if (key) map.set(key, row);
    });
    return [...map.values()];
  }

  function mergeMonth(payloads, monthStart) {
    const workspaces = payloads.map((payload) => payload.workspace || {});
    const people = uniqueRows(workspaces.flatMap((workspace) => workspace.people || []), (row) => row.id);
    const shifts = uniqueRows(workspaces.flatMap((workspace) => workspace.shifts || []), (row) => row.id)
      .sort((a, b) => String(a.starts_at || '').localeCompare(String(b.starts_at || '')) || String(a.person_name || '').localeCompare(String(b.person_name || '')));
    const availability = uniqueRows(workspaces.flatMap((workspace) => workspace.availability || []), (row) => `${row.person_id}:${row.weekday}`);
    const timeOff = uniqueRows(workspaces.flatMap((workspace) => workspace.time_off || []), (row) => row.id);
    const responses = uniqueRows(workspaces.flatMap((workspace) => workspace.responses || []), (row) => `${row.shift_id}:${row.person_id}`);
    const weeks = uniqueRows(workspaces.map((workspace) => workspace.week).filter(Boolean), (row) => row.week_start)
      .sort((a, b) => String(a.week_start || '').localeCompare(String(b.week_start || '')));
    const plannedHours = shifts.reduce((total, shift) => total + hoursForShift(shift), 0);
    const scheduledPeople = new Set(shifts.map((shift) => shift.person_id)).size;
    const scheduledDays = new Set(shifts.map((shift) => dateFromLocal(shift.starts_local))).size;
    const publishedWeeks = weeks.filter((week) => week.latest_publication || week.status === 'published').length;
    const draftWeeks = weeks.filter((week) => week.has_unpublished_changes || (week.status === 'draft' && shifts.some((shift) => shift.week_start === week.week_start))).length;
    const bounds = monthBounds(monthStart);

    return {
      monthStart: bounds.monthStart,
      monthEnd: bounds.monthEnd,
      gridStart: bounds.gridStart,
      gridEnd: bounds.gridEnd,
      people,
      shifts,
      availability,
      timeOff,
      responses,
      weeks,
      staff: payloads[0]?.staff || null,
      policy: payloads[0]?.policy || null,
      summary: {
        shiftCount: shifts.length,
        plannedHours,
        scheduledPeople,
        scheduledDays,
        publishedWeeks,
        draftWeeks
      },
      loadedAt: new Date().toISOString()
    };
  }

  async function loadMonth(options = {}) {
    if (!state.active || state.loading || !viewVisible()) return;
    const monthStart = state.monthStart || monthStartFor(window.AtlasShifts?.week?.() || venueDate());
    if (!options.force && state.data?.monthStart === monthStart) return;

    const requestSerial = ++state.requestSerial;
    state.monthStart = monthStart;
    state.loading = true;
    state.error = null;
    state.selectedDate = state.selectedDate && state.selectedDate.slice(0, 7) === monthStart.slice(0, 7)
      ? state.selectedDate
      : null;
    renderPanel();

    try {
      const session = await activeSession();
      if (!session?.access_token) throw new Error('Sign in to Atlas to open the month calendar.');
      const weekStarts = weekStartsForMonth(monthStart);
      const payloads = await Promise.all(weekStarts.map((weekStart) => fetchWeek(weekStart, session.access_token)));
      if (requestSerial !== state.requestSerial) return;
      state.data = mergeMonth(payloads, monthStart);
      state.error = null;
    } catch (error) {
      if (requestSerial !== state.requestSerial) return;
      state.error = error instanceof Error ? error.message : 'The month calendar could not load.';
    } finally {
      if (requestSerial === state.requestSerial) {
        state.loading = false;
        renderPanel();
      }
    }
  }

  function weekForDate(date) {
    const weekStart = mondayFor(date);
    return state.data?.weeks?.find((week) => week.week_start === weekStart) || null;
  }

  function responseForShift(shift) {
    return state.data?.responses?.find((response) => response.shift_id === shift.id && response.person_id === shift.person_id) || null;
  }

  function shiftsForDate(date) {
    return (state.data?.shifts || []).filter((shift) => dateFromLocal(shift.starts_local) === date);
  }

  function leaveForDate(date) {
    return (state.data?.timeOff || []).filter((request) => request.status === 'approved' && request.starts_on <= date && request.ends_on >= date);
  }

  function responseTone(response) {
    const value = response?.response || 'pending';
    return ['confirmed', 'change_requested', 'declined'].includes(value) ? value : 'pending';
  }

  function weekStateMarkup(date) {
    if (dateFromKey(date).getUTCDay() !== 1) return '';
    const week = weekForDate(date);
    if (!week) return '';
    const manager = Boolean(state.data?.staff?.can_manage_schedule);
    if (!manager && !week.latest_publication && week.status !== 'published') return '';
    if (week.has_unpublished_changes) return '<span class="shift-month-week-state is-update">Update pending</span>';
    if (week.latest_publication || week.status === 'published') return `<span class="shift-month-week-state is-published">Published r${Number(week.revision || week.latest_publication?.revision || 0)}</span>`;
    if (manager && shiftsForWeek(week.week_start).length) return '<span class="shift-month-week-state is-draft">Draft</span>';
    return '';
  }

  function shiftsForWeek(weekStart) {
    return (state.data?.shifts || []).filter((shift) => shift.week_start === weekStart);
  }

  function monthCellMarkup(date) {
    const entries = shiftsForDate(date);
    const leave = leaveForDate(date);
    const inMonth = date.slice(0, 7) === state.monthStart.slice(0, 7);
    const today = date === venueDate();
    const selected = date === state.selectedDate;
    const visibleEntries = entries.slice(0, 3);
    const remaining = Math.max(0, entries.length - visibleEntries.length);
    const dayNumber = Number(date.slice(8, 10));

    return `<button type="button" class="shift-month-cell ${inMonth ? '' : 'is-outside'} ${today ? 'is-today' : ''} ${selected ? 'is-selected' : ''}" data-shifts-month-day="${escapeHtml(date)}" aria-label="Open ${escapeHtml(formatDay(date, { weekday: 'long', day: 'numeric', month: 'long' }))}">
      <span class="shift-month-cell-head"><span><strong>${dayNumber}</strong>${today ? '<em>Today</em>' : ''}</span>${weekStateMarkup(date)}</span>
      <span class="shift-month-cell-content">
        ${visibleEntries.map((shift) => `<span class="shift-month-chip is-${responseTone(responseForShift(shift))}"><strong>${escapeHtml(timeFromLocal(shift.starts_local))}</strong><em>${escapeHtml(shift.person_name || state.data?.people?.find((person) => person.id === shift.person_id)?.display_name || 'Team')}</em></span>`).join('')}
        ${leave.slice(0, 1).map((request) => `<span class="shift-month-leave"><i data-lucide="calendar-off-2"></i>${escapeHtml(request.person_name || state.data?.people?.find((person) => person.id === request.person_id)?.display_name || 'Team')} - ${escapeHtml(humanize(request.request_type))}</span>`).join('')}
        ${!entries.length && !leave.length ? '<span class="shift-month-empty">No shifts</span>' : ''}
        ${remaining ? `<span class="shift-month-more">+${remaining} more shift${remaining === 1 ? '' : 's'}</span>` : ''}
      </span>
    </button>`;
  }

  function selectedDayMarkup() {
    if (!state.selectedDate) return '';
    const entries = shiftsForDate(state.selectedDate);
    const leave = leaveForDate(state.selectedDate);
    return `<section class="shift-month-day-detail">
      <header>
        <div><span>Selected day</span><h3>${escapeHtml(formatDay(state.selectedDate, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }))}</h3></div>
        <button type="button" class="shift-month-open-week" data-shifts-month-open-week="${escapeHtml(state.selectedDate)}"><i data-lucide="calendar-range"></i>Open weekly planner</button>
      </header>
      <div class="shift-month-day-list">
        ${entries.length ? entries.map((shift) => {
          const person = state.data?.people?.find((row) => row.id === shift.person_id);
          const response = responseForShift(shift);
          return `<article><span class="shift-month-detail-time">${escapeHtml(timeFromLocal(shift.starts_local))}<small>${escapeHtml(timeFromLocal(shift.ends_local))}</small></span><div><strong>${escapeHtml(shift.person_name || person?.display_name || 'Team member')}</strong><small>${escapeHtml(shift.role_name || person?.default_role || 'Team')} - ${hoursForShift(shift).toFixed(1)} h</small>${shift.note ? `<p>${escapeHtml(shift.note)}</p>` : ''}</div><span class="shift-month-response is-${responseTone(response)}">${escapeHtml(humanize(response?.response || 'pending'))}</span></article>`;
        }).join('') : '<div class="shift-month-day-empty"><i data-lucide="calendar-x-2"></i><span>No shifts on this day.</span></div>'}
        ${leave.map((request) => `<article class="is-leave"><span class="shift-month-detail-time"><i data-lucide="calendar-off-2"></i></span><div><strong>${escapeHtml(request.person_name || 'Team member')}</strong><small>${escapeHtml(humanize(request.request_type))} - approved time off</small>${request.note ? `<p>${escapeHtml(request.note)}</p>` : ''}</div></article>`).join('')}
      </div>
    </section>`;
  }

  function summaryMarkup() {
    const summary = state.data?.summary || {};
    const manager = Boolean(state.data?.staff?.can_manage_schedule);
    return `<div class="shift-month-summary">
      <article><span><i data-lucide="calendar-check-2"></i>Month shifts</span><strong>${Number(summary.shiftCount || 0)}</strong><small>${Number(summary.scheduledDays || 0)} scheduled days</small></article>
      <article><span><i data-lucide="clock-3"></i>Planned hours</span><strong>${Number(summary.plannedHours || 0).toFixed(1)}</strong><small>Breaks deducted</small></article>
      <article><span><i data-lucide="users-round"></i>People scheduled</span><strong>${Number(summary.scheduledPeople || 0)}</strong><small>Across the visible month</small></article>
      <article class="${manager && summary.draftWeeks ? 'is-attention' : ''}"><span><i data-lucide="send"></i>Published weeks</span><strong>${Number(summary.publishedWeeks || 0)}</strong><small>${manager ? `${Number(summary.draftWeeks || 0)} draft or pending update` : 'Latest team-visible revisions'}</small></article>
    </div>`;
  }

  function loadingMarkup() {
    return `<section class="shift-month-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading ${escapeHtml(monthLabel(state.monthStart))}</h2><p>Combining each weekly revision into one month calendar.</p></section>`;
  }

  function errorMarkup() {
    return `<section class="shift-month-state"><span class="is-error"><i data-lucide="calendar-x-2"></i></span><h2>Month calendar unavailable</h2><p>${escapeHtml(state.error)}</p><button type="button" data-shifts-month-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function monthMarkup() {
    if (state.loading && !state.data) return loadingMarkup();
    if (state.error && !state.data) return errorMarkup();
    const bounds = monthBounds(state.monthStart);
    const dates = [];
    for (let date = bounds.gridStart; date <= bounds.gridEnd; date = addDays(date, 1)) dates.push(date);
    const manager = Boolean(state.data?.staff?.can_manage_schedule);

    return `<section class="shift-month-panel">
      <header class="shift-month-toolbar">
        <div class="shift-month-navigation">
          <button type="button" data-shifts-month-nav="-1" aria-label="Previous month"><i data-lucide="chevron-left"></i></button>
          <button type="button" data-shifts-month-today>Today</button>
          <button type="button" data-shifts-month-nav="1" aria-label="Next month"><i data-lucide="chevron-right"></i></button>
          <div><span>Full month</span><h2>${escapeHtml(monthLabel(state.monthStart))}</h2></div>
        </div>
        <button type="button" class="shift-month-refresh" data-shifts-month-refresh><i data-lucide="refresh-cw"></i>Refresh month</button>
      </header>
      ${state.error ? `<div class="shift-month-warning"><i data-lucide="triangle-alert"></i>${escapeHtml(state.error)}</div>` : ''}
      ${summaryMarkup()}
      <div class="shift-month-note"><i data-lucide="shield-check"></i><span>${manager ? 'Month view combines private weekly drafts for planning. Open a week to add, edit or publish shifts. Production public.shifts remains unchanged.' : 'Month view combines the latest published weekly revisions. Draft manager changes stay private.'}</span></div>
      <div class="shift-month-calendar-scroll">
        <div class="shift-month-weekdays">${WEEKDAY_ORDER.map((day) => `<span>${DAY_SHORT[day]}</span>`).join('')}</div>
        <div class="shift-month-grid">${dates.map(monthCellMarkup).join('')}</div>
      </div>
      ${selectedDayMarkup()}
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
    const key = JSON.stringify({
      monthStart: state.monthStart,
      loadedAt: state.data?.loadedAt || null,
      loading: state.loading,
      error: state.error,
      selectedDate: state.selectedDate
    });
    if (panel.dataset.renderKey === key) return;
    panel.dataset.renderKey = key;
    panel.innerHTML = monthMarkup();
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
      if (!state.loading && state.data?.monthStart !== state.monthStart) loadMonth();
    } else {
      element.querySelector('[data-shifts-month-panel]')?.remove();
      state.renderKey = null;
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

  function navigateToWeek(date) {
    const targetWeek = mondayFor(date);
    const currentWeek = window.AtlasShifts?.week?.() || targetWeek;
    state.active = false;
    state.selectedDate = null;
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
      }
      scheduleApply();
      if (state.active) window.setTimeout(() => loadMonth(), 0);
      return;
    }

    if (!state.active) return;

    const navigation = target.closest('[data-shifts-month-nav]');
    if (navigation) {
      state.monthStart = addMonths(state.monthStart, Number(navigation.dataset.shiftsMonthNav || 0));
      state.data = null;
      state.error = null;
      state.selectedDate = null;
      renderPanel();
      loadMonth({ force: true });
      return;
    }

    if (target.closest('[data-shifts-month-today]')) {
      state.monthStart = monthStartFor(venueDate());
      state.data = null;
      state.error = null;
      state.selectedDate = venueDate();
      renderPanel();
      loadMonth({ force: true });
      return;
    }

    if (target.closest('[data-shifts-month-refresh]')) {
      state.data = null;
      state.error = null;
      loadMonth({ force: true });
      return;
    }

    const day = target.closest('[data-shifts-month-day]');
    if (day) {
      state.selectedDate = day.dataset.shiftsMonthDay;
      renderPanel();
      return;
    }

    const openWeek = target.closest('[data-shifts-month-open-week]');
    if (openWeek) navigateToWeek(openWeek.dataset.shiftsMonthOpenWeek);
  }

  function handleKeydown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!state.active || !target?.matches('[data-shifts-month-day]')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    state.selectedDate = target.dataset.shiftsMonthDay;
    renderPanel();
  }

  function init() {
    if (state.initialized || !window.AtlasShifts || !host()) return false;
    state.initialized = true;
    state.monthStart = monthStartFor(window.AtlasShifts.week?.() || venueDate());

    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeydown, true);

    state.observer = new MutationObserver((records) => {
      if (records.some((record) => record.addedNodes.length || record.removedNodes.length)) scheduleApply();
    });
    state.observer.observe(host(), { childList: true, subtree: true });

    window.addEventListener('focus', () => {
      if (state.active && viewVisible()) loadMonth({ force: true });
    });
    window.addEventListener('online', () => {
      if (state.active) loadMonth({ force: true });
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
    snapshot: () => state.data
  };

  if (!init()) {
    state.pollTimer = window.setInterval(() => {
      if (init()) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }, 120);
    window.setTimeout(() => {
      if (state.pollTimer) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }, 12000);
  }
})();
