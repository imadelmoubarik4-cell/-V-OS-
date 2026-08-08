(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const state = {
    host: null,
    timer: null,
    initialized: false,
    submitting: false,
    lastHandledElement: null,
    lastHandledAt: 0
  };

  function shiftsHost() {
    return document.getElementById('shifts-view');
  }

  function monthPanel() {
    return shiftsHost()?.querySelector('[data-shifts-month-panel]') || null;
  }

  function isMonthActive() {
    return Boolean(shiftsHost()?.classList.contains('shifts-month-active') && monthPanel());
  }

  function monthSnapshot() {
    return window.AtlasShiftsMonth?.snapshot?.() || {};
  }

  function monthStart() {
    return window.AtlasShiftsMonth?.month?.()
      || new Date().toISOString().slice(0, 8) + '01';
  }

  function dateFromKey(value) {
    return new Date(`${value}T12:00:00Z`);
  }

  function dateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function mondayFor(value) {
    const date = dateFromKey(value);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return dateKey(date);
  }

  function monthLabel(value) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric'
    }).format(dateFromKey(value));
  }

  function timeFromLocal(value) {
    return value ? String(value).slice(11, 16) : '';
  }

  function formatDay(value) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'long',
      day: '2-digit',
      month: 'short'
    }).format(dateFromKey(value));
  }

  function selectedDate() {
    const selectedAction = monthPanel()?.querySelector('.shift-month-day-detail [data-shifts-month-add-day]');
    const selected = selectedAction?.dataset?.shiftsMonthAddDay;
    if (selected) return selected;

    const selectedCell = monthPanel()?.querySelector('.shift-month-cell.is-selected [data-shifts-month-day]');
    const cellDate = selectedCell?.dataset?.shiftsMonthDay;
    if (cellDate) return cellDate;

    const currentMonth = monthStart();
    const today = new Date().toISOString().slice(0, 10);
    return today.slice(0, 7) === currentMonth.slice(0, 7) ? today : currentMonth;
  }

  function shiftById(id) {
    const rows = monthSnapshot()?.shifts;
    return Array.isArray(rows) ? rows.find((shift) => shift.id === id) || null : null;
  }

  function installInteractionStyles() {
    if (document.getElementById('shifts-month-interaction-fix')) return;
    const style = document.createElement('style');
    style.id = 'shifts-month-interaction-fix';
    style.textContent = `
      .shifts-month-active [data-shifts-month-panel]{position:relative;z-index:2;pointer-events:auto!important}
      .shifts-month-active [data-shifts-month-panel] button,
      .shifts-month-active [data-shifts-month-panel] input,
      .shifts-month-active [data-shifts-month-panel] select,
      .shifts-month-active [data-shifts-month-panel] textarea,
      .shifts-month-active [data-shifts-month-panel] label{
        pointer-events:auto!important;
        touch-action:manipulation;
      }
      .shifts-month-active [data-shifts-month-panel] button{position:relative;z-index:3}
      .shifts-month-bridge-toast{
        position:fixed;right:18px;bottom:18px;z-index:1600;display:flex;align-items:flex-start;gap:9px;
        width:min(430px,calc(100vw - 36px));padding:12px 14px;border:1px solid #c8d8ca;border-radius:12px;
        background:#edf4ee;color:#4f6d55;box-shadow:0 15px 40px rgba(32,30,26,.16);
        font:600 10px/1.45 'IBM Plex Sans',sans-serif;
      }
      .shifts-month-bridge-toast.is-error{border-color:#e4c1bc;background:#fbefed;color:#8d4c47}
      .shifts-month-bridge-toast svg{width:16px;height:16px;flex:0 0 auto}
    `;
    document.head.appendChild(style);
  }

  function toast(message, kind = 'success') {
    document.querySelector('.shifts-month-bridge-toast')?.remove();
    const element = document.createElement('div');
    element.className = `shifts-month-bridge-toast ${kind === 'error' ? 'is-error' : ''}`;
    element.innerHTML = `<i data-lucide="${kind === 'error' ? 'triangle-alert' : 'circle-check-big'}"></i><span></span>`;
    element.querySelector('span').textContent = message;
    document.body.appendChild(element);
    window.lucide?.createIcons?.();
    window.setTimeout(() => element.remove(), kind === 'error' ? 7000 : 4200);
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function shiftsApi(action, body = {}) {
    const endpoint = String(cfg.SHIFTS_API || '').trim();
    if (!endpoint) throw new Error('Shifts API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas before changing the monthly schedule.');

    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ current_month: monthStart(), ...body })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Monthly schedule request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The monthly schedule took too long to respond. Check the connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function stopOriginalEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function wasJustHandled(element) {
    const now = Date.now();
    if (state.lastHandledElement === element && now - state.lastHandledAt < 450) return true;
    state.lastHandledElement = element;
    state.lastHandledAt = now;
    return false;
  }

  function closeMonthModal() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }));
    window.setTimeout(() => {
      document.querySelector('.shift-month-modal')?.remove();
      document.body.classList.remove('shift-modal-open');
    }, 20);
  }

  function openAddShift(date) {
    const targetDate = date || selectedDate();
    window.AtlasShiftsMonth?.addShift?.(targetDate);
    window.setTimeout(() => {
      document.querySelector('.shift-month-modal select[name="person_id"]')?.focus?.();
    }, 60);
  }

  function openEditShift(shiftId) {
    const shift = shiftById(shiftId);
    if (!shift) {
      toast('This shift is no longer available. Refresh the month and try again.', 'error');
      return;
    }

    const date = String(shift.starts_local || '').slice(0, 10) || selectedDate();
    window.AtlasShiftsMonth?.addShift?.(date);
    window.setTimeout(() => {
      const form = document.querySelector('.shift-month-modal [data-shifts-month-shift-form]');
      if (!(form instanceof HTMLFormElement)) {
        toast('The shift editor could not open. Refresh the month and try again.', 'error');
        return;
      }
      const set = (name, value) => {
        const field = form.elements.namedItem(name);
        if (field && 'value' in field) field.value = value ?? '';
      };
      set('shift_id', shift.id);
      set('person_id', shift.person_id);
      set('role_name', shift.role_name || '');
      set('starts_local', String(shift.starts_local || '').slice(0, 16));
      set('ends_local', String(shift.ends_local || '').slice(0, 16));
      set('break_minutes', Number(shift.break_minutes || 0));
      set('note', shift.note || '');
      const title = document.getElementById('shift-month-modal-title');
      if (title) title.textContent = 'Edit shift';
      form.querySelector('select[name="person_id"]')?.focus?.();
    }, 70);
  }

  async function saveShift(form) {
    if (state.submitting) return;
    const value = (name) => form.elements.namedItem(name)?.value?.trim?.() || '';
    const startsLocal = value('starts_local');
    const endsLocal = value('ends_local');
    const startDate = startsLocal.slice(0, 10);

    if (!startsLocal || !endsLocal) {
      toast('Start and end times are required.', 'error');
      return;
    }
    if (startDate.slice(0, 7) !== monthStart().slice(0, 7)) {
      toast(`The shift must start inside ${monthLabel(monthStart())}.`, 'error');
      return;
    }
    if (endsLocal <= startsLocal) {
      toast('Shift end must be after shift start.', 'error');
      return;
    }

    state.submitting = true;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await shiftsApi('save-shift', {
        week_start: mondayFor(startDate),
        shift_id: value('shift_id') || null,
        person_id: value('person_id'),
        role_name: value('role_name') || null,
        starts_local: startsLocal,
        ends_local: endsLocal,
        break_minutes: Number(value('break_minutes') || 0),
        note: value('note') || null
      });
      closeMonthModal();
      await window.AtlasShiftsMonth?.refresh?.();
      toast('Shift saved to the private monthly draft. Publish the month when the full plan is ready.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The shift could not be saved.', 'error');
    } finally {
      state.submitting = false;
      if (submit) submit.disabled = false;
    }
  }

  async function removeShift(shiftId) {
    if (state.submitting) return;
    const shift = shiftById(shiftId);
    if (!shift) {
      toast('This shift is no longer available. Refresh the month and try again.', 'error');
      return;
    }
    const person = shift.person_name || 'this team member';
    const date = String(shift.starts_local || '').slice(0, 10);
    if (!window.confirm(`Remove ${person}'s ${timeFromLocal(shift.starts_local)} shift from ${formatDay(date)}? Staff will keep seeing the previous published month until you publish the update.`)) return;

    state.submitting = true;
    try {
      await shiftsApi('cancel-shift', { shift_id: shift.id });
      await window.AtlasShiftsMonth?.refresh?.();
      toast('Shift removed from the private monthly draft. Publish the update to make it visible to staff.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The shift could not be removed.', 'error');
    } finally {
      state.submitting = false;
    }
  }

  async function publishMonth() {
    if (state.submitting) return;
    const workspace = monthSnapshot();
    const month = workspace?.month || {};
    const revision = Number(month.revision || month.latest_publication?.revision || 0) + 1;
    const label = monthLabel(monthStart());
    const note = window.prompt(`Publication note for ${label} (optional):`, month.note || '');
    if (note === null) return;
    if (!window.confirm(`Publish the complete ${label} schedule as revision ${revision}? Staff will immediately see the month and all affected weekly views will update.`)) return;

    state.submitting = true;
    try {
      await shiftsApi('publish-month', {
        month_start: monthStart(),
        note: note.trim() || null
      });
      await window.AtlasShiftsMonth?.refresh?.();
      window.AtlasTeamUnreadBadge?.refresh?.();
      toast(`${label} schedule published to staff as revision ${revision}.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The monthly schedule could not be published.', 'error');
    } finally {
      state.submitting = false;
    }
  }

  function openWeeklyPlanner(date) {
    const targetDate = date || selectedDate();
    const targetWeek = mondayFor(targetDate);
    const currentWeek = window.AtlasShifts?.week?.() || targetWeek;
    const scheduleTab = shiftsHost()?.querySelector('[data-shifts-tab="schedule"]');
    scheduleTab?.click();

    window.setTimeout(() => {
      const refreshedWeek = window.AtlasShifts?.week?.() || currentWeek;
      const deltaDays = Math.round((dateFromKey(targetWeek) - dateFromKey(refreshedWeek)) / 86400000);
      const deltaWeeks = Math.round(deltaDays / 7);
      if (!deltaWeeks) return;
      const proxy = document.createElement('button');
      proxy.type = 'button';
      proxy.hidden = true;
      proxy.dataset.shiftsWeek = String(deltaWeeks);
      shiftsHost()?.appendChild(proxy);
      proxy.click();
      proxy.remove();
    }, 80);
  }

  function isMonthTabClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest?.('[data-shifts-tab="month"]');
    return Boolean(tab && shiftsHost()?.contains(tab));
  }

  function protectMonthTab(event) {
    if (!isMonthTabClick(event)) return;
    event.preventDefault();
    event.stopPropagation();
    window.requestAnimationFrame(() => {
      const host = shiftsHost();
      if (!host || host.classList.contains('shifts-month-active')) return;
      window.AtlasShiftsMonth?.open?.();
    });
  }

  function interactiveAction(target) {
    if (!isMonthActive()) return null;
    return target.closest([
      '[data-shifts-month-add]',
      '[data-shifts-month-add-day]',
      '[data-shifts-month-refresh]',
      '[data-shifts-month-publish]',
      '[data-shifts-month-open-week]',
      '[data-shifts-month-edit]',
      '[data-shifts-month-remove]',
      '[data-shifts-month-close]'
    ].join(','));
  }

  function handleMonthAction(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !shiftsHost()?.contains(target)) return;
    const action = interactiveAction(target);
    if (!action || wasJustHandled(action)) return;

    stopOriginalEvent(event);

    if (action.matches('[data-shifts-month-add-day]')) {
      openAddShift(action.dataset.shiftsMonthAddDay);
      return;
    }
    if (action.matches('[data-shifts-month-add]')) {
      openAddShift(selectedDate());
      return;
    }
    if (action.matches('[data-shifts-month-refresh]')) {
      window.AtlasShiftsMonth?.refresh?.();
      return;
    }
    if (action.matches('[data-shifts-month-publish]')) {
      publishMonth();
      return;
    }
    if (action.matches('[data-shifts-month-open-week]')) {
      openWeeklyPlanner(action.dataset.shiftsMonthOpenWeek);
      return;
    }
    if (action.matches('[data-shifts-month-edit]')) {
      openEditShift(action.dataset.shiftsMonthEdit);
      return;
    }
    if (action.matches('[data-shifts-month-remove]')) {
      removeShift(action.dataset.shiftsMonthRemove);
      return;
    }
    if (action.matches('[data-shifts-month-close]')) closeMonthModal();
  }

  function handleMonthSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)
        || !isMonthActive()
        || !form.matches('[data-shifts-month-shift-form]')) return;
    stopOriginalEvent(event);
    saveShift(form);
  }

  function init() {
    if (state.initialized) return true;
    const host = shiftsHost();
    if (!host) return false;

    state.initialized = true;
    state.host = host;
    installInteractionStyles();

    window.addEventListener('click', handleMonthAction, true);
    window.addEventListener('submit', handleMonthSubmit, true);
    host.addEventListener('click', protectMonthTab, true);

    window.addEventListener('pagehide', () => {
      window.removeEventListener('click', handleMonthAction, true);
      window.removeEventListener('submit', handleMonthSubmit, true);
      state.host?.removeEventListener('click', protectMonthTab, true);
      if (state.timer) window.clearInterval(state.timer);
    }, { once: true });

    return true;
  }

  window.AtlasShiftsMonthTabBridge = {
    ready: () => state.initialized,
    apply: init,
    addShift: openAddShift,
    refresh: () => window.AtlasShiftsMonth?.refresh?.(),
    publish: publishMonth,
    openWeek: openWeeklyPlanner
  };

  if (!init()) {
    state.timer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.timer);
      state.timer = null;
    }, 100);
    window.setTimeout(() => {
      if (!state.timer) return;
      window.clearInterval(state.timer);
      state.timer = null;
    }, 12000);
  }
})();