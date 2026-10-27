// Bookings — Alcedo staff booking workspace + manager configuration.
//
//   #bookings          the staff day view (floor plan + list, add booking,
//                      reservation detail, assign/move, change status)
//   #bookings/config   manager configuration (areas, tables, combinations, rules)
//   #bookings/<date>   the day view for a specific YYYY-MM-DD
//
// A self-contained shell view ('bookings') registered with AtlasShell. Role and
// permission are server-authoritative: the snapshot/config payload's
// permissions.can_configure only shows or hides the manager configuration; a
// non-manager sees a permission state, never the controls. Every server string
// is escaped. `requested` reservations are shown VISIBLY distinct and are never
// shown as confirmed (design §5). One authoritative service (atlas-bookings)
// answers snapshot, config, availability and the mutations; requests go through
// window.AtlasApi.request (bearer token, timeout, fixed friendly copy, 401 ->
// atlas:auth-required).
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 24000;
  const VIEW_STORAGE_KEY = 'atlas.bookings.view.v1';
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener() {} };

  // Section colours (design §10). Each maps to a token-based swatch class in
  // bookings-workspace.css so the floor plan inherits the Alcedo palette.
  const SECTION_COLOURS = ['teal', 'orange', 'sage', 'ivory', 'ink', 'plum', 'sky', 'clay'];

  // Status model (design §5). requested is deliberately distinct from confirmed.
  const STATUS_LABEL = {
    requested: 'Requested', confirmed: 'Confirmed', arrived: 'Arrived',
    seated: 'Seated', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show'
  };
  const STATUS_TONE = {
    requested: 'warning', confirmed: 'info', arrived: 'info',
    seated: 'positive', completed: 'neutral', cancelled: 'danger', no_show: 'danger'
  };
  // Allowed transitions (design §5): requested → confirmed → arrived → seated →
  // completed, plus cancelled and no_show from any live status.
  const TRANSITIONS = {
    requested: [['confirmed', 'Confirm'], ['cancelled', 'Cancel'], ['no_show', 'No-show']],
    confirmed: [['arrived', 'Arrive'], ['cancelled', 'Cancel'], ['no_show', 'No-show']],
    arrived: [['seated', 'Seat'], ['cancelled', 'Cancel'], ['no_show', 'No-show']],
    seated: [['completed', 'Complete'], ['cancelled', 'Cancel']],
    completed: [],
    cancelled: [],
    no_show: []
  };
  const LIVE_STATUSES = new Set(['requested', 'confirmed', 'arrived', 'seated']);
  // Statuses whose seats are taken (atlas_private.booking_table_free).
  const ALLOCATING_STATUSES = new Set(['confirmed', 'arrived', 'seated']);
  // S106 rules as approved; used only to explain availability before saving —
  // the server re-checks every rule (S110 booking_check_seat_group).
  const DEFAULT_TURNAROUND_MINUTES = 15;
  const DEFAULT_DURATION_MINUTES = 120;
  const SOURCE_LABEL = { phone: 'Phone', walk_in: 'Walk-in', web: 'Website', dineout: 'Dineout' };

  const state = {
    section: 'day',            // 'day' | 'config'
    date: null,
    mode: 'map',               // 'map' | 'list' (day view)
    snapshot: null,
    config: null,
    permissions: null,
    actorRole: null,
    loading: false,
    error: null,
    failedAt: 0,
    submitting: false,
    snapshotPromise: null,
    snapshotFor: null,         // the date the in-flight snapshot request is for
    snapshotSerial: 0,         // only the latest snapshot request may land
    loadedAt: 0,               // when the shown snapshot arrived (stale-on-return)
    configPromise: null,
    visible: false,
    initialized: false,
    cal: null                  // the open date popover: { month: 'YYYY-MM-01', focus: 'YYYY-MM-DD' }
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

  function pill(label, tone = 'neutral') {
    return `<span class="atlas-pill atlas-pill--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
  }

  function humanize(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  function host() {
    return document.getElementById('bookings-view');
  }

  function vc() {
    return window.AtlasVenueClock;
  }

  function todayISO() {
    return vc()?.today?.() || vc()?.venueDate?.() || new Date().toISOString().slice(0, 10);
  }

  function canConfigure() {
    return Boolean(state.permissions?.can_configure);
  }

  function canManageReservations() {
    return Boolean(state.permissions?.can_manage_reservations);
  }

  function sectionColour(area) {
    const colour = String(area?.section_colour || '').toLowerCase();
    return SECTION_COLOURS.includes(colour) ? colour : 'teal';
  }

  function formatTime(iso) {
    if (!iso) return '';
    const clock = vc()?.formatTime?.(iso);
    if (clock) return clock;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
  }

  // A staff-entered wall time is venue time (Reykjavik), whatever zone the
  // device is set to, so it is converted with the venue clock, never parsed
  // in the device zone. Without the clock the venue zone (UTC) is assumed.
  function venueInstantMs(dateKey, time) {
    const instant = vc()?.zonedToInstant?.(dateKey, time);
    const ms = instant instanceof Date ? instant.getTime() : NaN;
    return Number.isFinite(ms) ? ms : Date.parse(`${dateKey}T${time}:00Z`);
  }

  // One key per add-booking sheet: a retry after a lost response (timeout,
  // 5xx) replays the saved booking instead of creating a second one. The
  // server does not compare payloads on replay, so a changed party, date,
  // time or location gets a fresh key. 'staff:' never collides with the
  // public 'web:' keys.
  function newIdempotencyKey() {
    const crypto = window.crypto;
    if (crypto?.randomUUID) return `staff:${crypto.randomUUID()}`;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `staff:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  function sheetIdempotencyKey(sheet, signature) {
    if (!sheet.key || sheet.signature !== signature) {
      sheet.key = newIdempotencyKey();
      sheet.signature = signature;
    }
    return sheet.key;
  }

  function longDate(dateKey) {
    if (!dateKey) return '';
    const date = new Date(`${dateKey}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return dateKey;
    // Only used without the venue clock; never the device language (audit L35).
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function plural(count, word, many = `${word}s`) {
    return `${count} ${count === 1 ? word : many}`;
  }

  // "Today · Thursday 24 September" beside the date control.
  function dayLabel(dateKey) {
    const spelled = vc()?.formatDate?.(dateKey, { long: true }) || longDate(dateKey);
    const today = todayISO();
    const tomorrow = vc()?.tomorrow?.();
    const relative = dateKey === today ? 'Today' : dateKey === tomorrow ? 'Tomorrow' : '';
    return relative ? `${relative} · ${spelled}` : spelled;
  }

  // Positions on the time axis and the capacity bars are fractions carried in
  // data-bk-from / data-bk-span; CSP allows no style attribute in markup, so
  // they become custom properties through the CSSOM after each paint.
  function placeMarks(scope) {
    scope?.querySelectorAll?.('[data-bk-from], [data-bk-span]').forEach((node) => {
      if (node.dataset.bkFrom != null) node.style.setProperty('--bk-x', String(Number(node.dataset.bkFrom) || 0));
      if (node.dataset.bkSpan != null) node.style.setProperty('--bk-w', String(Number(node.dataset.bkSpan) || 0));
    });
  }

  // ---------- API ----------

  const API_MESSAGES = {
    auth: 'Your session has ended. Sign in again to open Bookings.',
    forbidden: 'Your role can’t do that in Bookings. Ask a manager if you need access.',
    not_found: 'That booking isn’t available any more. Refresh and try again.',
    conflict: 'That table is no longer free for that time. Refresh and try again.',
    invalid: 'Bookings couldn’t accept that. Check the details and try again.',
    unavailable: 'Bookings is temporarily unavailable. Nothing was changed.',
    timeout: 'Bookings took too long to answer. Nothing was changed. Try again.',
    network: 'Bookings couldn’t be reached. Check the connection and try again.',
    failed: 'Bookings is temporarily unavailable.',
    // A write whose answer was lost (timeout after sending, 502/503/504):
    // it may have been saved (audit M5). AtlasApi uses this for writes only.
    outcome_unknown: 'Bookings couldn’t confirm whether this was saved. Check the booking before trying again.'
  };

  function endpoint() {
    return String(cfg.BOOKINGS_API || '').trim();
  }

  function api(action, { params = {}, body, method } = {}) {
    if (!endpoint()) {
      return Promise.reject(window.AtlasApi.fixed('Bookings isn’t set up for this Alcedo yet.', { kind: 'not_configured' }));
    }
    return window.AtlasApi.request(endpoint(), {
      method: method || (body === undefined ? 'GET' : 'POST'),
      params: { action, ...params },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      messages: API_MESSAGES
    });
  }

  function shown(error, fallback) {
    return window.AtlasApi?.message ? window.AtlasApi.message(error, fallback) : fallback;
  }

  function toast(message, tone = 'info') {
    window.AtlasShell?.toast?.(message, { tone });
  }

  // ---------- data selectors ----------

  function areas() {
    return Array.isArray(state.snapshot?.areas) ? state.snapshot.areas.slice().sort((a, b) => (a.display_order || 0) - (b.display_order || 0)) : [];
  }

  function tables() {
    return Array.isArray(state.snapshot?.tables) ? state.snapshot.tables : [];
  }

  function reservations() {
    return Array.isArray(state.snapshot?.reservations) ? state.snapshot.reservations : [];
  }

  function holds() {
    return Array.isArray(state.snapshot?.holds) ? state.snapshot.holds : [];
  }

  function reservationById(id) {
    return reservations().find((reservation) => reservation.id === id) || null;
  }

  function tableById(id) {
    return tables().find((table) => table.id === id) || null;
  }

  // Live reservations allocated to a table on the loaded day: the seated party
  // first (it is what the table's status says), then by start time.
  function reservationsForTable(tableId) {
    return reservations().filter((reservation) => LIVE_STATUSES.has(reservation.status)
      && Array.isArray(reservation.tables) && reservation.tables.some((allocation) => allocation.table_id === tableId))
      .sort((a, b) => (b.status === 'seated') - (a.status === 'seated') || String(a.start_at).localeCompare(String(b.start_at)));
  }

  function reservationsForArea(areaId) {
    return reservations().filter((reservation) => reservation.area_id === areaId && LIVE_STATUSES.has(reservation.status));
  }

  function areaById(areaId) {
    return areas().find((area) => area.id === areaId) || null;
  }

  function tableIsUnavailable(table) {
    return Boolean(table.temporarily_unavailable) || table.is_bookable === false;
  }

  // Text status for a table (design §10: text label, never colour alone).
  function tableStatus(table) {
    if (tableIsUnavailable(table)) return { key: 'unavailable', label: 'Unavailable', tone: 'danger' };
    const allocations = reservationsForTable(table.id);
    if (allocations.some((reservation) => reservation.status === 'seated')) return { key: 'seated', label: 'Seated', tone: 'positive' };
    if (allocations.length) return { key: 'booked', label: 'Booked', tone: 'info' };
    if (holds().some((hold) => hold.table_id === table.id)) return { key: 'held', label: heldRequestForTable(table) ? 'Requested' : 'Held', tone: 'warning' };
    return { key: 'free', label: 'Free', tone: 'neutral' };
  }

  // A web request holds seats until staff confirm it; the hold carries the
  // request's exact window, so the request is the requested reservation in the
  // same location with that window.
  function heldRequestForTable(table) {
    const hold = holds().find((entry) => entry.table_id === table.id);
    if (!hold) return null;
    return reservations().find((reservation) => reservation.status === 'requested'
      && reservation.area_id === table.area_id
      && reservation.start_at === hold.start_at && reservation.end_at === hold.end_at) || null;
  }

  function requestedReservations() {
    return reservations().filter((reservation) => reservation.status === 'requested')
      .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
  }

  function tablesForArea(areaId) {
    return tables().filter((table) => table.area_id === areaId)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  }

  function freeTables() {
    return tables().filter((table) => tableStatus(table).key === 'free');
  }

  // ---------- seats: time-aware availability + the seat-group rule ----------
  // The floor plan's tableStatus() is day-wide (a stool booked at 16:00 reads
  // Booked all day). Choosing seats is time-aware instead: a seat is free for a
  // window unless another live allocation or active hold overlaps it once both
  // get the turnaround — the same test the server makes. The server stays
  // authoritative and re-checks every rule when the booking is saved.

  function turnaroundMs() {
    const minutes = Number(state.snapshot?.rules?.turnaround_minutes);
    return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_TURNAROUND_MINUTES) * 60000;
  }

  function seatAvailability(table, startMs, endMs, reservation = null) {
    if (tableIsUnavailable(table)) return { free: false, label: 'Unavailable' };
    if (table.unavailable_from && table.unavailable_until
        && Date.parse(table.unavailable_from) < endMs && Date.parse(table.unavailable_until) > startMs) {
      return { free: false, label: 'Unavailable' };
    }
    const buffer = turnaroundMs();
    const overlaps = (start, end) => startMs < end + buffer && start < endMs + buffer;
    const taken = reservations().find((other) => other.id !== reservation?.id
      && ALLOCATING_STATUSES.has(other.status)
      && Array.isArray(other.tables) && other.tables.some((allocation) => allocation.table_id === table.id)
      && overlaps(Date.parse(other.start_at), Date.parse(other.end_at || other.start_at)));
    if (taken) return { free: false, label: `Taken ${formatTime(taken.start_at)}–${formatTime(taken.end_at)}` };
    // A web request's own pending hold covers exactly its window; it never blocks
    // assigning that request (the server ignores a reservation's own holds).
    const ownHold = (hold) => reservation && hold.start_at === reservation.start_at && hold.end_at === reservation.end_at;
    const held = holds().find((hold) => hold.table_id === table.id && !ownHold(hold)
      && overlaps(Date.parse(hold.start_at), Date.parse(hold.end_at)));
    if (held) return { free: false, label: 'Held' };
    return { free: true, label: 'Free' };
  }

  function seatsInOrder(areaId) {
    return tables().filter((table) => table.area_id === areaId)
      .sort((a, b) => (a.position_index ?? 1e9) - (b.position_index ?? 1e9)
        || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  }

  function seatSections(areaId) {
    const sections = [];
    seatsInOrder(areaId).forEach((table) => {
      const key = table.segment || '';
      let section = sections.find((entry) => entry.key === key);
      if (!section) { section = { key, tables: [] }; sections.push(section); }
      section.tables.push(table);
    });
    return sections;
  }

  // Mirrors the server's seat-group rule so staff see the reason before saving.
  function seatGroupProblem(tableIds, party) {
    const chosen = tableIds.map(tableById).filter(Boolean);
    if (!chosen.length) return 'Choose at least one seat.';
    if (new Set(chosen.map((table) => table.area_id)).size > 1) return 'Choose seats in one location.';
    const capacity = chosen.reduce((sum, table) => sum + (Number(table.seat_capacity) || 0), 0);
    if (capacity < party) {
      return `Choose seats for ${party} guest${party === 1 ? '' : 's'} — the seats chosen hold ${capacity}.`;
    }
    if (chosen.length > 1) {
      const segments = new Set(chosen.map((table) => table.segment || null));
      const sectioned = !(segments.size === 1 && segments.has(null));
      if (sectioned) {
        if (segments.size > 1 || segments.has(null)) {
          return `${chosen.map((table) => table.label).join(' and ')} are in different sections. Choose seats next to each other within one section.`;
        }
        const positions = chosen.map((table) => Number(table.position_index)).sort((a, b) => a - b);
        const gapFree = positions.every((value, index) => Number.isFinite(value) && (index === 0 || value === positions[index - 1] + 1));
        if (!gapFree) return 'Choose seats next to each other, with no gaps.';
      }
    }
    return '';
  }

  // Server refusals arrive as fixed copy by kind; word the seat ones for staff.
  function seatErrorMessage(error) {
    if (error?.kind === 'conflict') {
      return 'A chosen seat is taken at that time (bookings need a 15-minute gap on the same seat). Choose other seats or another time.';
    }
    if (error?.kind === 'invalid') {
      return 'Bookings couldn’t use those seats. Choose enough seats next to each other within one section.';
    }
    return shown(error, 'The seats couldn’t be saved. Nothing was changed; try again.');
  }

  function seatPickerMarkup({ idPrefix, areaId, startMs, endMs, reservation = null, checked = new Set() }) {
    const sections = seatSections(areaId);
    if (!sections.length) return '<p class="bk-note">No seats configured here.</p>';
    return sections.map((section) => {
      const name = section.key ? `Section ${section.key}` : (areaById(areaId)?.name || 'Seats');
      const first = section.tables[0]?.label || '';
      const last = section.tables[section.tables.length - 1]?.label || '';
      const range = section.tables.length > 1 ? ` · ${first}–${last.replace(/^\D+/, '')}` : '';
      const seats = section.tables.map((table) => {
        const availability = seatAvailability(table, startMs, endMs, reservation);
        const isChecked = checked.has(table.id);
        const usable = availability.free || isChecked;
        const id = `${idPrefix}-${table.id}`;
        return `<label class="bk-seat${usable ? '' : ' is-unavailable'}" for="${escapeHtml(id)}">
          <input type="checkbox" class="atlas-check" id="${escapeHtml(id)}" name="seat" value="${escapeHtml(table.id)}" data-bookings-seat="${escapeHtml(table.id)}"${isChecked ? ' checked' : ''}${usable ? '' : ' disabled'}>
          <span class="bk-seat__label">${escapeHtml(table.label)}</span>
          <span class="bk-seat__state">${escapeHtml(availability.label)}</span>
        </label>`;
      }).join('');
      return `<div class="bk-seats__section" role="group" aria-label="${escapeHtml(name)}"><p class="bk-seats__section-name">${escapeHtml(name + range)}</p><div class="bk-seats__grid">${seats}</div></div>`;
    }).join('');
  }

  function checkedSeats(container) {
    return Array.from(container?.querySelectorAll('[data-bookings-seat]:checked') || []).map((input) => input.value);
  }

  function seatAreas() {
    return areas().filter((area) => area.allocation_mode !== 'pooled' && seatsInOrder(area.id).length);
  }

  // ---------- render: day view ----------
  // One question: who is coming, where do they sit, and what needs a decision?
  // The title row answers it in words (the finding first), the requests queue
  // carries the decisions, and the floor plan — the bar drawn as it stands —
  // is the biggest block. Every booking kind has one mark, shared by the floor
  // tiles, the time bars and the legend: free is a hairline tile, booked a pale
  // kingfisher fill, arrived adds a kingfisher edge, seated is pale green, and
  // a request (a held seat) is a dashed amber outline, the only full colour,
  // because it is the one thing waiting on staff.

  const MARK_LABEL = { free: 'Free', booked: 'Booked', arrived: 'Arrived', seated: 'Seated', held: 'Requested', unavailable: 'Unavailable' };
  const BAR_KIND = { requested: 'held', confirmed: 'booked', arrived: 'arrived', seated: 'seated' };

  function liveReservations() {
    return reservations().filter((reservation) => LIVE_STATUSES.has(reservation.status));
  }

  // The line under the title: the finding first (requests waiting), then the
  // day's size, computed from the rows on screen.
  function daySummary() {
    const live = liveReservations();
    if (!live.length) return 'No bookings yet for this day';
    const requests = live.filter((reservation) => reservation.status === 'requested').length;
    const booked = live.filter((reservation) => reservation.status !== 'requested');
    const guests = booked.reduce((sum, reservation) => sum + (Number(reservation.party_size) || 0), 0);
    const seated = booked.filter((reservation) => reservation.status === 'seated').length;
    const parts = [];
    if (requests) parts.push(`${plural(requests, 'request')} waiting to confirm`);
    parts.push(booked.length ? `${plural(booked.length, 'booking')}, ${plural(guests, 'guest')}` : 'nothing confirmed yet');
    if (seated) parts.push(`${plural(seated, 'party', 'parties')} seated`);
    return parts.join(' · ');
  }

  function headerMarkup() {
    // A failed load is said once, inside the failed block; the line under the
    // title stays neutral (the day itself is named by the pager below it).
    const sub = state.snapshot
      ? daySummary()
      : state.error ? 'The day’s bookings and floor plan' : 'Loading the day…';
    const actions = canManageReservations()
      ? `<button type="button" class="atlas-btn atlas-btn--primary" data-bookings-add>${icon('plus')}Add booking</button>` : '';
    const configLink = canConfigure()
      ? `<a class="atlas-btn atlas-btn--secondary bk-config-link" href="#bookings/config" data-bookings-config-link aria-label="Configure bookings">${icon('sliders-horizontal')}<span class="bk-config-link__text">Configure</span></a>` : '';
    return `<header class="page-head"><div class="page-head__text"><h1 class="page-head__title">Bookings</h1><p class="page-head__sub bk-summary" data-bookings-summary>${escapeHtml(sub)}</p></div><div class="page-head__actions">${configLink}${actions}</div></header>`;
  }

  // ---------- the day pager: ‹ Today › and the date that opens a calendar ----------
  // The same way through time as Shifts (‹ Today ›), plus the day itself
  // spelled the Alcedo way ("Thursday 24 September") as a button that opens a
  // small month calendar in the popover style. Weeks start on Monday. Dates
  // are calendar keys ('YYYY-MM-DD') stepped in UTC, so no zone shifts them.

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function keyToUTC(key) {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12));
  }

  function utcToKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function shiftDay(key, n) {
    const date = keyToUTC(key);
    date.setUTCDate(date.getUTCDate() + n);
    return utcToKey(date);
  }

  function shiftMonth(monthStart, n) {
    const date = keyToUTC(monthStart);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + n);
    return utcToKey(date);
  }

  function monthStartOf(key) {
    return `${String(key).slice(0, 7)}-01`;
  }

  function shortDay(dateKey) {
    return vc()?.formatDate?.(dateKey) || longDate(dateKey);
  }

  function relativeWord(dateKey) {
    if (dateKey === todayISO()) return 'Today';
    if (dateKey === (vc()?.tomorrow?.() || shiftDay(todayISO(), 1))) return 'Tomorrow';
    if (dateKey === shiftDay(todayISO(), -1)) return 'Yesterday';
    return '';
  }

  function calendarGridMarkup() {
    const cal = state.cal;
    const first = cal.month;
    const date = keyToUTC(first);
    const lead = (date.getUTCDay() + 6) % 7;          // Monday-first offset
    const start = shiftDay(first, -lead);
    const today = todayISO();
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const key = shiftDay(start, index);
      const inMonth = key.slice(0, 7) === first.slice(0, 7);
      if (index >= 35 && !inMonth && cells.length % 7 === 0) break;
      const selected = key === state.date;
      const focus = key === cal.focus;
      cells.push(`<button type="button" class="bk-cal__day${inMonth ? '' : ' is-outside'}${key === today ? ' is-today' : ''}${selected ? ' is-selected' : ''}" data-bookings-pick="${key}" tabindex="${focus ? '0' : '-1'}" aria-label="${escapeHtml(vc()?.formatDate?.(key, { long: true, year: true }) || key)}"${selected ? ' aria-pressed="true"' : ''}${key === today ? ' aria-current="date"' : ''}>${Number(key.slice(8, 10))}</button>`);
    }
    return `<div class="bk-cal__head">
        <p class="bk-cal__title" id="bk-cal-title" aria-live="polite">${escapeHtml(`${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`)}</p>
        <button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-bookings-cal-month="-1" aria-label="Previous month">${icon('chevron-left')}</button>
        <button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-bookings-cal-month="1" aria-label="Next month">${icon('chevron-right')}</button>
      </div>
      <div class="bk-cal__weekdays" aria-hidden="true">${WEEKDAYS_MON.map((day) => `<span>${day.slice(0, 2)}</span>`).join('')}</div>
      <div class="bk-cal__grid" role="group" aria-labelledby="bk-cal-title">${cells.join('')}</div>`;
  }

  function calendarMarkup() {
    if (!state.cal) return '';
    return `<div class="atlas-popover bk-cal" id="bk-cal" role="dialog" aria-label="Choose a date" data-bookings-cal><div class="bk-cal__body" data-bookings-cal-body>${calendarGridMarkup()}</div></div>`;
  }

  function controlsMarkup() {
    const relative = relativeWord(state.date);
    const long = vc()?.formatDate?.(state.date, { long: true }) || longDate(state.date);
    return `<div class="bk-controls">
      <div class="bk-date">
        <div class="bk-pager" role="group" aria-label="Day">
          <button type="button" class="atlas-icon-btn" data-bookings-day-step="-1" aria-label="Previous day">${icon('chevron-left')}</button>
          <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-today>Today</button>
          <button type="button" class="atlas-icon-btn" data-bookings-day-step="1" aria-label="Next day">${icon('chevron-right')}</button>
        </div>
        <div class="bk-date__anchor">
        <button type="button" class="bk-date__pick" data-bookings-calendar aria-haspopup="dialog" aria-expanded="${state.cal ? 'true' : 'false'}"${state.cal ? ' aria-controls="bk-cal"' : ''} aria-label="${escapeHtml(`Booking date: ${dayLabel(state.date)}. Choose a date`)}">
          <span class="bk-date__long">${escapeHtml(long)}</span><span class="bk-date__short">${escapeHtml(shortDay(state.date))}</span>${relative ? `<span class="bk-date__rel">${escapeHtml(relative)}</span>` : ''}${icon('chevron-down')}
        </button>
        ${calendarMarkup()}
        </div>
      </div>
      <div class="atlas-segmented bk-viewtoggle" role="group" aria-label="Floor plan or list" data-bookings-view-toggle>
        <button type="button" aria-pressed="${state.mode === 'map'}" data-bookings-view="map">${icon('layout-grid')}Floor plan</button>
        <button type="button" aria-pressed="${state.mode === 'list'}" data-bookings-view="list">${icon('list')}List</button>
      </div>
    </div>`;
  }

  function alertMarkup() {
    if (!state.error) return '';
    return `<div class="atlas-alert atlas-alert--danger bk-alert" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Bookings couldn’t be ${state.snapshot ? 'updated' : 'loaded'}.</p><p class="atlas-alert__body">${escapeHtml(state.error)}${state.snapshot ? ' You’re seeing what loaded last.' : ''}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-refresh>Try again</button></div></div>`;
  }

  function guestOf(reservation) {
    return reservation?.guest_name || SOURCE_LABEL[reservation?.source] || 'Booked';
  }

  // The mark a table shows on the floor: the status key, refined to "arrived"
  // when the party it shows has arrived (the text status stays the server's).
  function tableMark(table, status, reservation) {
    if (status.key === 'booked' && reservation?.status === 'arrived') return 'arrived';
    return status.key;
  }

  function tableButtonMarkup(table) {
    const status = tableStatus(table);
    const allocated = reservationsForTable(table.id);
    const reservation = allocated[0] || heldRequestForTable(table);
    // A one-seat stool says only its section; a table says its size too.
    const seats = Number(table.seat_capacity) || 0;
    const cap = [table.segment, seats > 1 ? plural(seats, 'seat') : null].filter(Boolean).join(' · ');
    const later = allocated.length > 1 ? `<span class="bk-table__more">+${allocated.length - 1}</span>` : '';
    const mark = tableMark(table, status, reservation);
    const text = mark === 'arrived' ? MARK_LABEL.arrived : status.label;
    const label = `${table.label} — ${text}${reservation?.guest_name ? `, ${reservation.guest_name}` : ''}`;
    return `<button type="button" class="bk-table bk-table--${escapeHtml(mark)}" data-bookings-table="${escapeHtml(table.id)}" data-bookings-position="${escapeHtml(String(table.position_index || ''))}"${reservation ? ` data-bookings-reservation="${escapeHtml(reservation.id)}"` : ''} aria-label="${escapeHtml(label)}">
      <span class="bk-table__top"><span class="bk-table__label">${escapeHtml(table.label)}</span>${reservation ? `<span class="bk-table__time">${escapeHtml(formatTime(reservation.start_at))}</span>` : ''}</span>
      ${reservation ? `<span class="bk-table__guest">${escapeHtml(guestOf(reservation))}${later}</span>` : ''}
      <span class="bk-table__foot"><span class="bk-table__status" data-bookings-status>${escapeHtml(text)}</span><span class="bk-table__cap">${escapeHtml(cap)}</span></span>
    </button>`;
  }

  function freeCount(list) {
    return list.filter((table) => tableStatus(table).key === 'free').length;
  }

  // An area's head counts seats, not tables, so it adds up from the tiles
  // ("6 seats", "2 seats"): the free seats out of every seat in the area.
  function seatsFreeLine(list) {
    const seatsOf = (table) => Math.max(1, Number(table.seat_capacity) || 1);
    const total = list.reduce((sum, table) => sum + seatsOf(table), 0);
    const free = list.filter((table) => tableStatus(table).key === 'free').reduce((sum, table) => sum + seatsOf(table), 0);
    return `${free} of ${plural(total, 'seat')} free`;
  }

  // The open centre of the stool ring is the counter. It carries the section
  // key — a seat group must stay inside one section — with each section's free
  // stools now, so the rule is read where the seats are chosen.
  function counterMarkup(area) {
    const sections = seatSections(area.id).filter((section) => section.key);
    const rows = sections.map((section) => {
      const first = section.tables[0]?.label || '';
      const last = section.tables[section.tables.length - 1]?.label || '';
      const range = section.tables.length > 1 ? `${first}–${last.replace(/^\D+/, '')}` : first;
      return `<li class="bk-counter__row"><span class="bk-counter__key">${escapeHtml(section.key)}</span><span class="bk-counter__range">${escapeHtml(range)}</span><span class="bk-counter__free">${escapeHtml(`${freeCount(section.tables)} of ${section.tables.length} free`)}</span></li>`;
    }).join('');
    return `<div class="bk-counter" aria-hidden="true"><p class="bk-counter__name">${escapeHtml(area.name)} counter</p>${rows ? `<ul class="bk-counter__sections">${rows}</ul>` : ''}</div>`;
  }

  function areaHeadMarkup(area, meta, tag = 'h2') {
    return `<header class="bk-block__head"><${tag} class="bk-block__title bk-area__title" id="bk-area-${escapeHtml(area.id)}"><span class="bk-swatch" aria-hidden="true"></span>${escapeHtml(area.name)}</${tag}>${meta ? `<span class="bk-block__meta">${escapeHtml(meta)}</span>` : ''}</header>`;
  }

  function pooledAreaMarkup(area) {
    const all = reservationsForArea(area.id).sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
    const occupying = all.filter((reservation) => ['confirmed', 'arrived', 'seated'].includes(reservation.status));
    const used = occupying.reduce((sum, reservation) => sum + (Number(reservation.party_size) || 0), 0);
    const capacity = Number(area.guest_capacity) || 30;
    const ratio = Math.min(1, used / capacity);
    const bookings = all.length
      ? `<ul class="atlas-list bk-location__bookings">${all.map((reservation) => `<li><button type="button" class="bk-res-row bk-location-row" data-bookings-reservation="${escapeHtml(reservation.id)}">
          <span class="bk-res-row__time">${escapeHtml(formatTime(reservation.start_at))}</span>
          <span class="bk-res-row__name">${escapeHtml(reservation.guest_name || 'Reservation')}</span>
          <span class="bk-res-row__party">${escapeHtml(plural(Number(reservation.party_size) || 0, 'guest'))}</span>
          <span class="bk-row__status">${pill(STATUS_LABEL[reservation.status] || humanize(reservation.status), STATUS_TONE[reservation.status] || 'neutral')}</span>
        </button></li>`).join('')}</ul>`
      : '<p class="bk-empty-line">No bookings for this location today.</p>';
    return `<section class="bk-area bk-location bk-c-${escapeHtml(sectionColour(area))}" data-bookings-area="${escapeHtml(area.id)}" aria-labelledby="bk-area-${escapeHtml(area.id)}">
      ${areaHeadMarkup(area, `${used} of ${capacity} guests`)}
      <div class="bk-capacity" role="img" aria-label="${escapeHtml(`${used} of ${capacity} guests booked`)}"><span class="bk-capacity__fill${ratio >= 1 ? ' is-full' : ''}" data-bk-span="${ratio.toFixed(4)}"></span></div>
      ${bookings}
    </section>`;
  }

  // The legend lists only the marks on screen; each swatch is the mark itself.
  function legendMarkup(keys) {
    const order = ['free', 'booked', 'arrived', 'seated', 'held', 'unavailable'];
    const shown = order.filter((key) => keys.has(key));
    if (shown.length < 2) return '';
    return `<ul class="bk-legend" aria-label="Key">${shown.map((key) => `<li class="bk-legend__item"><span class="bk-key bk-key--${key}" aria-hidden="true"></span>${escapeHtml(MARK_LABEL[key])}</li>`).join('')}</ul>`;
  }

  function mapMarkup() {
    const list = areas();
    if (!list.length) {
      return `<div class="atlas-empty bk-empty" data-bookings-empty><div class="atlas-empty__icon">${icon('map')}</div><h2 class="atlas-empty__title">No locations configured yet</h2><p class="atlas-empty__text">${canConfigure() ? 'Set up the bar, its seats and the booking rules to start taking bookings.' : 'Ask a manager to set up Bookings.'}</p>${canConfigure() ? '<div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#bookings/config">Configure Bookings</a></div>' : ''}</div>`;
    }
    const keys = new Set();
    const lastTiled = list.filter((area) => area.allocation_mode !== 'pooled' && tablesForArea(area.id).length).pop();
    list.forEach((area) => {
      if (area.allocation_mode === 'pooled') return;
      tablesForArea(area.id).forEach((table) => {
        const reservation = reservationsForTable(table.id)[0] || heldRequestForTable(table);
        keys.add(tableMark(table, tableStatus(table), reservation));
      });
    });
    const groups = list.map((area) => {
      if (area.allocation_mode === 'pooled') return pooledAreaMarkup(area);
      const colour = sectionColour(area);
      const areaTables = tablesForArea(area.id);
      // S106: the floor grid renders for any area whose stools have a laid-out
      // position_index. (It no longer keys off circular_adjacency — the Bar's
      // circular ring was replaced by three fixed sections; see s106 migration.)
      const floorClass = areaTables.some((table) => table.position_index) ? ' bk-floor-grid' : '';
      const isFloor = Boolean(floorClass);
      const meta = areaTables.length ? seatsFreeLine(areaTables) : '';
      return `<section class="bk-area bk-c-${escapeHtml(colour)}" data-bookings-area="${escapeHtml(area.id)}" aria-labelledby="bk-area-${escapeHtml(area.id)}">
        ${areaHeadMarkup(area, meta)}
        <div class="bk-area__tables${floorClass}">${areaTables.length ? areaTables.map(tableButtonMarkup).join('') + (isFloor ? counterMarkup(area) : '') : '<p class="bk-empty-line">No seats configured here.</p>'}</div>
        ${area === lastTiled ? legendMarkup(keys) : ''}
      </section>`;
    }).join('');
    return `<div class="bk-map" data-bookings-map role="group" aria-label="Booking locations">${groups}</div>`;
  }

  // ---------- list: the evening on a time axis ----------
  // Seats down a fixed column, grouped under their area; hours across on 1px
  // hour lines; each booking a 24px bar from its start to its end with the time
  // and guest inside; a request's held seats as a dashed bar. Today gets a
  // kingfisher "now" line. The text status pill closes every row.

  const HOUR_MS = 3600000;

  function timeWindow() {
    const spans = [];
    const add = (start, end) => {
      const from = Date.parse(start);
      if (!Number.isFinite(from)) return;
      const to = Date.parse(end);
      spans.push([from, Number.isFinite(to) && to > from ? to : from + DEFAULT_DURATION_MINUTES * 60000]);
    };
    liveReservations().forEach((reservation) => add(reservation.start_at, reservation.end_at));
    holds().forEach((hold) => add(hold.start_at, hold.end_at));
    let start;
    let end;
    if (spans.length) {
      start = Math.floor(Math.min(...spans.map((span) => span[0])) / HOUR_MS) * HOUR_MS;
      end = Math.ceil(Math.max(...spans.map((span) => span[1])) / HOUR_MS) * HOUR_MS;
    } else {
      // An empty day spans the saved opening hours; with none saved there is
      // no honest axis to draw, so the list shows the seats without one.
      const hours = vc()?.dayWindow?.(state.date);
      if (hours?.state !== 'open' || !hours.open || !hours.close) return null;
      start = Math.floor(new Date(hours.open).getTime() / HOUR_MS) * HOUR_MS;
      end = Math.ceil(new Date(hours.close).getTime() / HOUR_MS) * HOUR_MS;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    }
    if (end - start < 4 * HOUR_MS) end = start + 4 * HOUR_MS;
    return { start, end };
  }

  function fraction(win, ms) {
    return Math.max(0, Math.min(1, (ms - win.start) / (win.end - win.start)));
  }

  function barMarkup(win, { start, end, kind, text }) {
    const from = Date.parse(start);
    if (!Number.isFinite(from)) return '';
    const toRaw = Date.parse(end);
    const to = Number.isFinite(toRaw) && toRaw > from ? toRaw : from + DEFAULT_DURATION_MINUTES * 60000;
    const x = fraction(win, from);
    const w = Math.max(0.01, fraction(win, to) - x);
    return `<span class="bk-bar bk-bar--${escapeHtml(kind)}" data-bk-from="${x.toFixed(4)}" data-bk-span="${w.toFixed(4)}"><span class="bk-bar__time">${escapeHtml(formatTime(start))}</span><span class="bk-bar__text">${escapeHtml(text)}</span></span>`;
  }

  function tableBars(win, table) {
    const bars = reservationsForTable(table.id).map((reservation) => barMarkup(win, {
      start: reservation.start_at, end: reservation.end_at, kind: BAR_KIND[reservation.status] || 'booked', text: guestOf(reservation)
    }));
    holds().filter((hold) => hold.table_id === table.id).forEach((hold) => {
      const request = reservations().find((reservation) => reservation.status === 'requested'
        && reservation.area_id === table.area_id && reservation.start_at === hold.start_at && reservation.end_at === hold.end_at);
      bars.push(barMarkup(win, { start: hold.start_at, end: hold.end_at, kind: 'held', text: request?.guest_name || 'Held' }));
    });
    return bars.join('');
  }

  function nowLineMarkup(win) {
    if (state.date !== todayISO()) return '';
    const now = Date.now();
    if (now < win.start || now > win.end) return '';
    return `<span class="bk-now" data-bk-from="${fraction(win, now).toFixed(4)}"><span class="bk-now__label">${escapeHtml(formatTime(new Date(now).toISOString()))}</span></span>`;
  }

  function axisMarkup(win) {
    const hours = Math.round((win.end - win.start) / HOUR_MS);
    const step = hours > 10 ? 2 : 1;
    const ticks = [];
    for (let index = 0; index <= hours; index += step) {
      const ms = win.start + index * HOUR_MS;
      ticks.push(`<span class="bk-tick${index % 2 ? ' bk-tick--odd' : ''}${index === hours ? ' bk-tick--end' : ''}" data-bk-from="${fraction(win, ms).toFixed(4)}">${escapeHtml(formatTime(new Date(ms).toISOString()))}</span>`);
    }
    const lines = ticks.map((tick) => tick.replace('class="bk-tick', 'class="bk-hourline').replace(/>[^<]*<\/span>$/, '></span>'));
    return {
      axis: `<div class="bk-axis" aria-hidden="true"><span class="bk-axis__id">Seat</span><span class="bk-axis__track">${ticks.join('')}</span><span class="bk-axis__status">Status</span></div>`,
      grid: `<div class="bk-gridlines" aria-hidden="true"><span></span><span class="bk-gridlines__track">${lines.join('')}${nowLineMarkup(win)}</span><span></span></div>`
    };
  }

  function listMarkup() {
    const win = timeWindow();
    const lanes = areas().map((area) => {
      if (area.allocation_mode === 'pooled') {
        const rows = reservationsForArea(area.id).sort((a, b) => String(a.start_at).localeCompare(String(b.start_at))).map((reservation) => `<li class="atlas-row bk-row" data-bookings-row="reservation-${escapeHtml(reservation.id)}" data-bookings-reservation="${escapeHtml(reservation.id)}">
          <button type="button" class="bk-row__btn" aria-label="${escapeHtml(`${area.name} — ${reservation.guest_name || 'Reservation'}, ${formatTime(reservation.start_at)}, ${STATUS_LABEL[reservation.status] || humanize(reservation.status)}`)}">
            <span class="bk-row__id"><span class="bk-row__label">${escapeHtml(reservation.guest_name || 'Reservation')}</span><span class="bk-row__meta">${escapeHtml(`${formatTime(reservation.start_at)} · ${plural(Number(reservation.party_size) || 0, 'guest')}`)}</span></span>
            <span class="bk-track">${win ? barMarkup(win, { start: reservation.start_at, end: reservation.end_at, kind: BAR_KIND[reservation.status] || 'booked', text: plural(Number(reservation.party_size) || 0, 'guest') }) : ''}</span>
            <span class="bk-row__status">${pill(STATUS_LABEL[reservation.status] || humanize(reservation.status), STATUS_TONE[reservation.status] || 'neutral')}</span>
          </button>
        </li>`).join('');
        return rows ? `<section class="bk-lane" aria-labelledby="bk-lane-${escapeHtml(area.id)}"><h2 class="bk-lane__title" id="bk-lane-${escapeHtml(area.id)}"><span class="bk-swatch bk-c-${escapeHtml(sectionColour(area))}" aria-hidden="true"></span>${escapeHtml(area.name)}<span class="bk-lane__meta">${escapeHtml(plural(rows.split('data-bookings-row=').length - 1, 'booking'))}</span></h2><ul class="atlas-list">${rows}</ul></section>` : '';
      }
      const areaTables = seatsInOrder(area.id);
      if (!areaTables.length) return '';
      const rows = areaTables.map((table) => {
        const status = tableStatus(table);
        const reservation = reservationsForTable(table.id)[0] || heldRequestForTable(table);
        const arrived = tableMark(table, status, reservation) === 'arrived';
        const statusText = arrived ? MARK_LABEL.arrived : status.label;
        const meta = [table.segment ? `Section ${table.segment}` : null, table.seat_capacity ? plural(Number(table.seat_capacity), 'seat') : null].filter(Boolean).join(' · ');
        return `<li class="atlas-row bk-row" data-bookings-row="${escapeHtml(table.id)}" data-bookings-table="${escapeHtml(table.id)}"${reservation ? ` data-bookings-reservation="${escapeHtml(reservation.id)}"` : ''}>
          <button type="button" class="bk-row__btn" aria-label="${escapeHtml(`${table.label} — ${statusText}${reservation ? `, ${guestOf(reservation)} ${formatTime(reservation.start_at)}` : ''}`)}">
            <span class="bk-row__id"><span class="bk-row__label">${escapeHtml(table.label)}</span><span class="bk-row__meta${reservation ? ' bk-row__meta--seat' : ''}">${escapeHtml(meta)}</span>${reservation ? `<span class="bk-row__who">${escapeHtml(`${formatTime(reservation.start_at)} · ${guestOf(reservation)}`)}</span>` : ''}</span>
            <span class="bk-track">${win ? tableBars(win, table) : ''}</span>
            <span class="bk-row__status">${pill(statusText, status.key === 'unavailable' ? 'neutral' : status.tone)}</span>
          </button>
        </li>`;
      }).join('');
      return `<section class="bk-lane" aria-labelledby="bk-lane-${escapeHtml(area.id)}"><h2 class="bk-lane__title" id="bk-lane-${escapeHtml(area.id)}"><span class="bk-swatch bk-c-${escapeHtml(sectionColour(area))}" aria-hidden="true"></span>${escapeHtml(area.name)}<span class="bk-lane__meta">${escapeHtml(seatsFreeLine(areaTables))}</span></h2><ul class="atlas-list">${rows}</ul></section>`;
    }).join('');

    if (!lanes) {
      return `<div class="atlas-empty bk-empty"><div class="atlas-empty__icon">${icon('list')}</div><h2 class="atlas-empty__title">No booking resources yet</h2><p class="atlas-empty__text">Configure the booking locations first.</p></div>`;
    }
    const { axis, grid } = win ? axisMarkup(win) : { axis: '', grid: '' };
    const empty = liveReservations().length || holds().length ? '' : '<p class="bk-timeline__empty">No bookings on this day yet. Every seat is free.</p>';
    return `<div class="bk-list bk-timeline" data-bookings-list>${axis}${empty}<div class="bk-timeline__body">${grid}${lanes}</div></div>`;
  }

  // Requests waiting for confirmation on this day — website requests have no
  // seats yet, so without this list they would not appear anywhere. A queue of
  // decisions: the time leads, the guest and their details follow, and the
  // decision sits in one fixed trailing column on every row.
  function requestsMarkup() {
    const list = requestedReservations();
    if (!list.length) return '';
    const manage = canManageReservations();
    const rows = list.map((reservation) => {
      const area = areaById(reservation.area_id);
      const party = Number(reservation.party_size) || 0;
      const facts = [plural(party, 'guest'), area?.name, reservation.source ? (SOURCE_LABEL[reservation.source] || humanize(reservation.source)) : null].filter(Boolean).join(' · ');
      const contact = [reservation.guest_phone, reservation.guest_email].filter(Boolean);
      const name = reservation.guest_name || 'Guest';
      const seatBased = (reservation.area_allocation_mode || area?.allocation_mode) !== 'pooled' && !(reservation.tables || []).length;
      const action = manage
        ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm bk-req__confirm" data-bookings-confirm="${escapeHtml(reservation.id)}" aria-label="${escapeHtml(`Confirm ${name}${seatBased ? ' and assign seats' : ''}`)}">${icon('check')}Confirm</button>`
        : '';
      return `<li class="bk-req">
        <button type="button" class="bk-req__open bk-request-row" data-bookings-reservation="${escapeHtml(reservation.id)}" aria-label="${escapeHtml(`Request — ${name}, ${formatTime(reservation.start_at)}`)}">
          <span class="bk-req__time">${escapeHtml(formatTime(reservation.start_at))}</span>
          <span class="bk-req__body">
            <span class="bk-req__name">${escapeHtml(name)}</span>
            <span class="bk-req__meta">${escapeHtml(facts)}${contact.length ? `<span class="bk-req__contact">${contact.map((entry) => `<span>${escapeHtml(entry)}</span>`).join('')}</span>` : ''}</span>
            ${reservation.guest_requests ? `<span class="bk-req__note bk-request-row__note">${escapeHtml(reservation.guest_requests)}</span>` : ''}
          </span>
        </button>
        <div class="bk-req__action">${action}</div>
      </li>`;
    }).join('');
    return `<section class="bk-requests" data-bookings-requests aria-labelledby="bk-requests-title">
      <header class="bk-block__head"><h2 class="bk-block__title" id="bk-requests-title">Requests waiting</h2>${pill(`${list.length} to confirm`, 'warning')}</header>
      <ul class="atlas-list bk-queue">${rows}</ul>
    </section>`;
  }

  // Loading: the final layout with flat grey bars at the real size — the area
  // heading, then the stool tiles at their 76px height.
  function skeletonMarkup(label) {
    return `<div class="bk-skel" aria-busy="true"><span class="atlas-skel bk-skel__head"></span><div class="bk-skel__tiles">${'<span class="atlas-skel bk-skel__tile"></span>'.repeat(8)}</div><span class="sr-only">${escapeHtml(label)}</span></div>`;
  }

  function dayBodyMarkup() {
    if (!state.snapshot && !state.error) return skeletonMarkup('Loading Bookings');
    if (!state.snapshot) return '';
    return `<div class="bk-day" data-bookings-mode="${escapeHtml(state.mode)}">
      ${requestsMarkup()}
      ${state.mode === 'map' ? mapMarkup() : listMarkup()}
    </div>`;
  }

  function dayMarkup() {
    return `<div class="bk">${headerMarkup()}${controlsMarkup()}<div class="bk-body">${alertMarkup()}${dayBodyMarkup()}</div></div>`;
  }

  // ---------- render: reservation detail ----------

  // The sheet answers "what is this booking and what happens next?": the
  // status, then the three facts staff act on (time, party, seats) as one
  // divided strip, then contact and requests as key-value rows, then the
  // seats. The footer keeps the one forward step as the primary on the right
  // and the ending steps (decline, cancel, no-show) on the left.
  function reservationDetailMarkup(reservation) {
    const status = reservation.status;
    const pooled = reservation.area_allocation_mode === 'pooled' || areaById(reservation.area_id)?.allocation_mode === 'pooled';
    const tableLabels = (Array.isArray(reservation.tables) ? reservation.tables : []).map((allocation) => allocation.label || tableById(allocation.table_id)?.label).filter(Boolean);
    const contact = [reservation.guest_phone, reservation.guest_email].filter(Boolean);
    const party = Number(reservation.party_size) || 0;
    const location = reservation.location || areaById(reservation.area_id)?.name || 'Unassigned';
    const ending = [];
    const forward = [];
    (TRANSITIONS[status] || []).forEach(([to, label]) => {
      if (to === 'cancelled' || to === 'no_show') {
        const text = to === 'cancelled' ? (status === 'requested' ? 'Decline' : 'Cancel booking') : label;
        ending.push(`<button type="button" class="atlas-btn atlas-btn--danger" data-bookings-status-btn data-to-status="${escapeHtml(to)}">${escapeHtml(text)}</button>`);
        return;
      }
      const actionLabel = to === 'confirmed' && status === 'requested'
        && reservation.area_allocation_mode !== 'pooled' && !(reservation.tables || []).length
        ? 'Confirm & assign seats' : label;
      forward.push(`<button type="button" class="atlas-btn atlas-btn--primary" data-bookings-status-btn data-to-status="${escapeHtml(to)}">${escapeHtml(actionLabel)}</button>`);
    });
    const seatsFact = pooled
      ? `<div><dt>Location</dt><dd>${escapeHtml(location)}</dd></div>`
      : `<div><dt>Seats</dt><dd${tableLabels.length ? ' data-bookings-detail-tables' : ' class="bk-dash"'}>${escapeHtml(tableLabels.length ? tableLabels.join(', ') : 'Not assigned')}</dd></div>`;
    const reference = reservation.booking_reference ? `<span class="bk-ref">${escapeHtml(reservation.booking_reference)}</span>` : '';
    const source = SOURCE_LABEL[reservation.source] || humanize(reservation.source || '');
    return `<section class="atlas-sheet bk-detail" data-modal-panel aria-labelledby="bk-detail-title">
      <span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-detail-title">${escapeHtml(reservation.guest_name || 'Reservation')}</h2><p class="atlas-sheet__desc bk-detail__desc">${escapeHtml(source)}${source && reference ? ' · ' : ''}${reference}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <div class="atlas-sheet__body bk-detail__body">
        <p class="bk-detail__status" data-bookings-detail-status>${pill(STATUS_LABEL[status] || humanize(status), STATUS_TONE[status] || 'neutral')}${status === 'requested' ? '<span class="bk-detail__requested">Not yet confirmed</span>' : ''}</p>
        <dl class="bk-keyfacts">
          <div><dt>Time</dt><dd>${escapeHtml(formatTime(reservation.start_at))}${reservation.end_at ? `–${escapeHtml(formatTime(reservation.end_at))}` : ''}</dd></div>
          <div><dt>Party</dt><dd>${escapeHtml(plural(party, 'guest'))}</dd></div>
          ${seatsFact}
        </dl>
        <dl class="bk-detail__facts">
          ${pooled ? '' : `<div><dt>Location</dt><dd>${escapeHtml(location)}</dd></div>`}
          <div><dt>Contact</dt><dd${contact.length ? '' : ' class="bk-dash"'}>${contact.length ? contact.map((entry) => `<span class="bk-detail__line">${escapeHtml(entry)}</span>`).join('') : 'No contact details'}</dd></div>
          ${reservation.guest_requests ? `<div><dt>Requests</dt><dd>${escapeHtml(reservation.guest_requests)}</dd></div>` : ''}
          ${reservation.staff_notes ? `<div><dt>Staff notes</dt><dd>${escapeHtml(reservation.staff_notes)}</dd></div>` : ''}
        </dl>
        ${canManageReservations() && LIVE_STATUSES.has(status) && reservation.area_allocation_mode !== 'pooled' ? moveSeatsMarkup(reservation) : ''}
      </div>
      ${ending.length || forward.length ? `<footer class="atlas-sheet__foot bk-detail__foot" data-bookings-status-actions>${ending.length ? `<div class="bk-detail__ending">${ending.join('')}</div>` : ''}${forward.join('')}</footer>` : ''}
    </section>`;
  }

  // Assign / move: choose a valid seat group for this booking's own time window.
  function moveArea(reservation) {
    const current = (reservation.tables || []).map((allocation) => tableById(allocation.table_id)).find(Boolean);
    const candidates = seatAreas();
    return candidates.find((area) => area.id === current?.area_id)
      || candidates.find((area) => area.id === reservation.area_id) || candidates[0] || null;
  }

  function moveSeatsMarkup(reservation, areaId = moveArea(reservation)?.id) {
    if (!areaId) return '';
    const current = new Set((reservation.tables || []).map((allocation) => allocation.table_id));
    const startMs = Date.parse(reservation.start_at);
    const endMs = Date.parse(reservation.end_at || reservation.start_at);
    // Moving a booking to another area is not part of the KANEL release.
    const party = Number(reservation.party_size) || 1;
    const assigned = current.size > 0;
    return `<fieldset class="bk-detail__assign bk-seats" data-bookings-move-seats>
      <legend class="bk-detail__assign-label">${assigned ? 'Move seats' : 'Choose seats'}<span class="bk-detail__assign-sub">${escapeHtml(`${plural(party, 'guest')} · ${formatTime(reservation.start_at)}–${formatTime(reservation.end_at)}`)}</span></legend>
      <p class="bk-note">Choose seats next to each other within one section. Seats free at this time are shown; the 15-minute gap between bookings is included.</p>
      <div class="bk-seats__picker" data-bookings-seat-picker>${seatPickerMarkup({ idPrefix: 'bk-move-seat', areaId, startMs, endMs, reservation, checked: current })}</div>
      <p class="error bk-seats__error" role="alert" hidden data-bookings-seat-error></p>
      <div class="bk-detail__assign-row"><button type="button" class="atlas-btn atlas-btn--secondary" data-bookings-assign>${icon('move')}Save seats</button></div>
    </fieldset>`;
  }

  function openReservation(reservationId) {
    const reservation = reservationById(reservationId);
    if (!reservation) return;
    const root = window.AtlasModal.layer({
      id: 'bk-detail-layer', className: 'bk-layer',
      panel: reservationDetailMarkup(reservation)
    });
    paintIcons();

    root.addEventListener('click', async (event) => {
      const statusBtn = event.target.closest('[data-bookings-status-btn]');
      if (statusBtn) { await changeStatus(reservationId, statusBtn.dataset.toStatus, root); return; }
      if (event.target.closest('[data-bookings-assign]')) {
        const reservation = reservationById(reservationId);
        const fieldset = root.querySelector('[data-bookings-move-seats]');
        const error = fieldset?.querySelector('[data-bookings-seat-error]');
        const chosen = checkedSeats(fieldset);
        const current = (reservation?.tables || []).map((allocation) => allocation.table_id);
        let problem = seatGroupProblem(chosen, Number(reservation?.party_size) || 1);
        if (!problem && chosen.length === current.length && chosen.every((id) => current.includes(id))) {
          problem = 'Those are already this booking’s seats.';
        }
        if (error) { error.textContent = problem; error.hidden = !problem; }
        if (problem) { fieldset?.querySelector('[data-bookings-seat]:not(:disabled)')?.focus(); return; }
        await assignTable(reservationId, chosen, root);
      }
    });
  }

  function refreshReservationLayer(root, reservationId) {
    // A decision taken from the requests queue has no sheet to refresh.
    if (!root) return;
    const reservation = reservationById(reservationId);
    if (!reservation) { window.AtlasModal.dismiss(root); return; }
    const panel = root.querySelector('[data-modal-panel]');
    if (panel) { panel.outerHTML = reservationDetailMarkup(reservation); paintIcons(); }
  }

  // ---------- render: add booking ----------

  // Three groups in the order a phone call goes: the booking (how many,
  // when, where), the seats (auto-assign or choose, as two option tiles), the
  // guest. Saving is staff approval, so the one primary is "Save booking".
  function addBookingMarkup(prefill = {}) {
    const inferredAreaId = prefill.areaId || tableById(prefill.tableId)?.area_id || areas()[0]?.id || '';
    const locationOptions = areas().map((area) => `<option value="${escapeHtml(area.id)}"${area.id === inferredAreaId ? ' selected' : ''}>${escapeHtml(area.name)}</option>`).join('');
    const choose = Boolean(prefill.tableId);
    const seatLabel = prefill.tableId ? tableById(prefill.tableId)?.label : '';
    return `<section class="atlas-sheet bk-add" data-modal-panel aria-labelledby="bk-add-title">
      <span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-add-title">Add booking</h2><p class="atlas-sheet__desc">${escapeHtml(seatLabel ? `Phone or walk-in, starting from ${seatLabel}. A reference is shown when it saves.` : 'Phone or walk-in. A reference is shown when it saves.')}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <form class="atlas-sheet__body atlas-form bk-add__form" id="bk-add-form" data-bookings-create-form novalidate>
        <div class="bk-form__group" role="group" aria-labelledby="bk-add-g-booking">
          <h3 class="bk-form__title" id="bk-add-g-booking">Booking</h3>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="bk-add-party">Guests</label><input class="atlas-input" type="number" min="1" max="30" inputmode="numeric" id="bk-add-party" name="party_size" value="2" required><p class="error" hidden data-error-for="party_size">Enter 1–30 guests.</p></div>
            <div class="atlas-field"><label for="bk-add-source">Source</label><select class="atlas-select" id="bk-add-source" name="source"><option value="phone">Phone</option><option value="walk_in">Walk-in</option></select></div>
          </div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="bk-add-date">Date</label><input class="atlas-input" type="date" id="bk-add-date" name="date" value="${escapeHtml(prefill.date || state.date)}" required></div>
            <div class="atlas-field"><label for="bk-add-time">Time</label><input class="atlas-input" type="time" step="900" id="bk-add-time" name="time" required><p class="error" hidden data-error-for="time">Enter a time.</p></div>
          </div>
          <div class="atlas-field"><label for="bk-add-location">Location</label><select class="atlas-select" id="bk-add-location" name="area_id" required>${locationOptions}</select><p class="error" hidden data-error-for="area_id">Choose a location.</p></div>
        </div>
        <fieldset class="atlas-field bk-seats bk-form__group" data-bookings-seats${prefill.tableId ? ` data-prefill-seat="${escapeHtml(prefill.tableId)}"` : ''}>
          <legend class="bk-seats__legend bk-form__title">Seats</legend>
          <div class="bk-seats__modes">
            <label class="atlas-check-row bk-seats__mode"><input type="radio" class="atlas-radio" id="bk-seat-mode-auto" name="seat_mode" value="auto"${choose ? '' : ' checked'}><span class="bk-seats__mode-text"><span class="bk-seats__mode-title">Auto-assign</span><span class="bk-seats__mode-help">Adjacent free seats</span></span></label>
            <label class="atlas-check-row bk-seats__mode"><input type="radio" class="atlas-radio" id="bk-seat-mode-choose" name="seat_mode" value="choose"${choose ? ' checked' : ''}><span class="bk-seats__mode-text"><span class="bk-seats__mode-title">Choose seats</span><span class="bk-seats__mode-help">Pick them on the bar</span></span></label>
          </div>
          <p class="bk-note" data-bookings-seat-note hidden></p>
          <div class="bk-seats__picker" data-bookings-seat-picker hidden></div>
          <p class="error bk-seats__error" role="alert" hidden data-error-for="seats"></p>
        </fieldset>
        <div class="bk-form__group" role="group" aria-labelledby="bk-add-g-guest">
          <h3 class="bk-form__title" id="bk-add-g-guest">Guest</h3>
          <div class="atlas-field"><label for="bk-add-name">Guest name</label><input class="atlas-input" id="bk-add-name" name="guest_name" maxlength="120" placeholder="Name for the booking" autocomplete="off" required><p class="error" hidden data-error-for="guest_name">Add the guest name.</p></div>
          <div class="atlas-field"><label for="bk-add-phone">Phone <span class="optional">Optional</span></label><input class="atlas-input" id="bk-add-phone" name="guest_phone" maxlength="60" inputmode="tel" autocomplete="off"></div>
          <div class="atlas-field"><label for="bk-add-requests">Requests <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="bk-add-requests" name="guest_requests" rows="2" maxlength="1000"></textarea></div>
        </div>
      </form>
      <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="bk-add-form" class="atlas-btn atlas-btn--primary" data-bookings-create-submit>Save booking</button></footer>
    </section>`;
  }

  function openAddBooking(prefill = {}) {
    if (!canManageReservations()) return;
    const root = window.AtlasModal.layer({ id: 'bk-add-layer', className: 'bk-layer', panel: addBookingMarkup(prefill), initialFocus: '#bk-add-party' });
    paintIcons();
    const form = root.querySelector('form');
    const sheet = { key: null, signature: null };  // this sheet's idempotency key
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitBooking(root, sheet);
    });
    // Re-draw the seat picker when anything that decides availability changes.
    const SEAT_INPUTS = new Set(['party_size', 'area_id', 'date', 'time', 'seat_mode']);
    form?.addEventListener('change', (event) => {
      if (event.target.closest('[data-bookings-seat]')) { refreshAddSeatError(root); return; }
      if (SEAT_INPUTS.has(event.target.name)) renderAddSeats(root);
    });
    renderAddSeats(root);
  }

  // The window a new booking would occupy, from the form (venue time, like submit).
  function addWindow(root) {
    const form = root.querySelector('form');
    const date = String(form?.elements.date?.value || '').trim();
    const time = String(form?.elements.time?.value || '').trim();
    if (!date || !time) return null;
    const startMs = venueInstantMs(date, time);
    if (!Number.isFinite(startMs)) return null;
    return { date, startMs, endMs: startMs + DEFAULT_DURATION_MINUTES * 60000 };
  }

  function renderAddSeats(root) {
    const fieldset = root.querySelector('[data-bookings-seats]');
    if (!fieldset) return;
    const form = root.querySelector('form');
    const picker = fieldset.querySelector('[data-bookings-seat-picker]');
    const note = fieldset.querySelector('[data-bookings-seat-note]');
    const choose = fieldset.querySelector('#bk-seat-mode-choose')?.checked;
    const areaId = String(form?.elements.area_id?.value || '');
    const area = areaById(areaId);
    const previous = new Set(checkedSeats(picker));
    const prefill = fieldset.dataset.prefillSeat;
    if (prefill) { previous.add(prefill); delete fieldset.dataset.prefillSeat; }
    const say = (text) => { note.textContent = text; note.hidden = !text; };
    picker.hidden = true;
    picker.innerHTML = '';
    if (!choose) { say(''); refreshAddSeatError(root); return; }
    if (!area || area.allocation_mode === 'pooled' || !seatsInOrder(areaId).length) {
      say('This location doesn’t use seats. Auto-assign is used.');
      return;
    }
    const slot = addWindow(root);
    if (!slot) { say('Enter a date and time to see which seats are free.'); return; }
    if (slot.date !== state.snapshot?.date) {
      say(`Seats can be chosen for the day that’s open (${state.snapshot?.date || state.date}). Open that date first, or use auto-assign.`);
      return;
    }
    say('Seats free from this time for two hours are shown; the 15-minute gap between bookings is included.');
    picker.innerHTML = seatPickerMarkup({ idPrefix: 'bk-add-seat', areaId, startMs: slot.startMs, endMs: slot.endMs, checked: previous });
    picker.hidden = false;
    refreshAddSeatError(root);
  }

  // Clear a shown seat error once the choice changes; submit re-validates.
  function refreshAddSeatError(root) {
    const error = root.querySelector('[data-error-for="seats"]');
    if (error && !error.hidden) { error.hidden = true; error.textContent = ''; }
  }

  async function submitBooking(root, sheet = { key: null, signature: null }) {
    if (state.submitting) return;
    const form = root.querySelector('form');
    const data = new FormData(form);
    const party = Number(data.get('party_size'));
    const date = String(data.get('date') || '').trim();
    const time = String(data.get('time') || '').trim();
    const areaId = String(data.get('area_id') || '').trim();
    const guestName = String(data.get('guest_name') || '').trim();
    const startMs = time && date ? venueInstantMs(date, time) : NaN;
    const errors = { party_size: !Number.isInteger(party) || party < 1 || party > 30, time: !Number.isFinite(startMs), area_id: !areaId, guest_name: !guestName };
    Object.entries(errors).forEach(([key, bad]) => { const el = root.querySelector(`[data-error-for="${key}"]`); if (el) el.hidden = !bad; });
    if (Object.values(errors).some(Boolean)) return;
    const startAt = new Date(startMs).toISOString();
    const body = {
      party_size: party,
      start_at: startAt,
      source: String(data.get('source') || 'phone'),
      // This form is staff-only (phone / walk-in), so saving is itself the staff
      // approval. Guest/website requests omit this and remain requested.
      status: 'confirmed',
      area_id: areaId,
      guest_name: guestName,
      guest_phone: String(data.get('guest_phone') || '').trim() || undefined,
      guest_requests: String(data.get('guest_requests') || '').trim() || undefined
    };
    if (data.get('seat_mode') === 'choose') {
      const seatError = root.querySelector('[data-error-for="seats"]');
      const picker = root.querySelector('[data-bookings-seats] [data-bookings-seat-picker]');
      // A manual choice must never silently become automatic allocation.
      const pickerReady = Boolean(picker && !picker.hidden && picker.querySelector('[data-bookings-seat]'));
      const chosen = pickerReady ? checkedSeats(picker) : [];
      const problem = !pickerReady
        ? (date !== state.snapshot?.date
          ? `Open ${date} in Bookings first to choose seats, or select Auto-assign.`
          : 'Seat selection is unavailable for this date or location. Select Auto-assign or correct the details.')
        : seatGroupProblem(chosen, party);
      if (problem) {
        if (seatError) { seatError.textContent = problem; seatError.hidden = false; }
        picker?.querySelector('[data-bookings-seat]:not(:disabled)')?.focus();
        return;
      }
      if (chosen.length) body.table_ids = chosen;
    }
    body.idempotency_key = sheetIdempotencyKey(sheet, JSON.stringify([party, date, time, areaId]));
    state.submitting = true;
    const submit = root.querySelector('[data-bookings-create-submit]');
    if (submit) submit.disabled = true;
    try {
      const result = await api('create', { body });
      const reservation = result?.reservation || null;
      window.AtlasModal.dismiss(root);
      if (reservation && result?.replayed) {
        // The first attempt had already saved: say so, with what was saved.
        const party = Number(reservation.party_size);
        const saved = [formatTime(reservation.start_at), Number.isInteger(party) && party > 0 ? plural(party, 'guest') : '', areaById(reservation.area_id)?.name || '']
          .filter(Boolean).join(' · ');
        // The key leaves the seats out (a different seat choice must not make
        // a second booking), so a replay keeps the seats saved first. If this
        // attempt chose others, say so instead of implying they were set.
        const savedTables = (Array.isArray(reservation.tables) ? reservation.tables : []).filter((allocation) => allocation?.table_id);
        const savedIds = new Set(savedTables.map((allocation) => String(allocation.table_id)));
        const asked = Array.isArray(body.table_ids) ? body.table_ids.map(String) : null;
        const seatsDiffer = Boolean(asked) && (asked.length !== savedIds.size || asked.some((id) => !savedIds.has(id)));
        const savedLabels = savedTables.map((allocation) => allocation.label || tableById(allocation.table_id)?.label || '').filter(Boolean).join(' + ');
        const seatsNote = seatsDiffer
          ? ` It is seated at ${savedLabels || 'no tables yet'}; the new seat choice wasn’t applied. Change the seats in the booking.`
          : '';
        toast(`${reservation.booking_reference || 'This booking'} was already saved${saved ? ` — ${saved}` : ''}. No second booking was made.${seatsNote}`, seatsDiffer ? 'warning' : 'info');
      } else if (reservation) {
        const confirmed = reservation.status === 'confirmed';
        toast(`${reservation.booking_reference || 'Booking'} saved — ${confirmed ? 'confirmed' : 'requested (awaiting confirmation)'}`, confirmed ? 'success' : 'info');
      } else {
        toast('Booking saved', 'success');
      }
      if (reservation?.start_at) {
        const key = reservation.start_at.slice(0, 10);
        if (DATE_RE.test(key)) state.date = key;
      }
      await loadSnapshot({ force: true, silent: true });
    } catch (error) {
      if (body.table_ids) {
        const seatError = root.querySelector('[data-error-for="seats"]');
        if (seatError) { seatError.textContent = seatErrorMessage(error); seatError.hidden = false; }
      }
      toast(shown(error, 'The booking couldn’t be saved. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
      if (submit) submit.disabled = false;
    }
  }

  // ---------- mutations ----------

  // Staff approval for a seat-based website request also needs a seat allocation.
  // The database rejects set-status confirmed without seats; its existing assign
  // RPC validates the seating rules and confirms requested bookings atomically.
  function freeAdjacentSeatsForRequest(reservation) {
    const party = Number(reservation?.party_size);
    const startMs = Date.parse(reservation?.start_at);
    const endMs = Date.parse(reservation?.end_at);
    if (!reservation?.area_id || !Number.isInteger(party) || party < 1
        || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    for (const section of seatSections(reservation.area_id)) {
      for (let first = 0; first < section.tables.length; first += 1) {
        const ids = [];
        let capacity = 0;
        let previous = null;
        for (let index = first; index < section.tables.length; index += 1) {
          const table = section.tables[index];
          const position = Number(table.position_index);
          const prevPosition = Number(previous?.position_index);
          if (previous && Number.isFinite(position) && Number.isFinite(prevPosition)
              && position !== prevPosition + 1) break;
          if (!seatAvailability(table, startMs, endMs, reservation).free) break;
          ids.push(table.id);
          capacity += Math.max(0, Number(table.seat_capacity) || 0);
          if (capacity >= party && !seatGroupProblem(ids, party)) return ids;
          previous = table;
        }
      }
    }
    return [];
  }

  async function changeStatus(reservationId, toStatus, root) {
    if (state.submitting || !toStatus) return;
    const booking = reservationById(reservationId);
    const allocationMode = booking?.area_allocation_mode || areaById(booking?.area_id)?.allocation_mode;
    // A single Confirm click approves and allocates the free adjacent seats.
    // If staff selected seats in the detail sheet, respect that explicit choice.
    if (toStatus === 'confirmed' && booking?.status === 'requested'
        && allocationMode !== 'pooled' && !(booking.tables || []).length) {
      const fieldset = root?.querySelector('[data-bookings-move-seats]');
      const chosen = checkedSeats(fieldset);
      const seats = chosen.length ? chosen : freeAdjacentSeatsForRequest(booking);
      const problem = seats.length
        ? seatGroupProblem(seats, Number(booking.party_size) || 1)
        : 'No adjacent seats are available for this time. Choose other seats or contact the guest about another time.';
      if (problem) {
        const fieldError = fieldset?.querySelector('[data-bookings-seat-error]');
        if (fieldError) { fieldError.textContent = problem; fieldError.hidden = false; }
        toast(problem, 'warning');
        return;
      }
      await assignTable(reservationId, seats, root);
      return;
    }
    state.submitting = true;
    try {
      await api('set-status', { body: { reservation_id: reservationId, to_status: toStatus } });
      toast(`Marked ${STATUS_LABEL[toStatus] ? STATUS_LABEL[toStatus].toLowerCase() : toStatus}`, 'success');
      // A lifecycle change (approve/reject/cancel/no_show) may create booking
      // notifications; let the bell refresh without polling.
      try { window.dispatchEvent(new CustomEvent('atlas:bookings-changed')); } catch { /* no-op */ }
      await loadSnapshot({ force: true, silent: true });
      refreshReservationLayer(root, reservationId);
    } catch (error) {
      toast(shown(error, 'That status couldn’t be changed. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
    }
  }

  async function assignTable(reservationId, tableIds, root) {
    if (state.submitting || !tableIds.length) return;
    state.submitting = true;
    try {
      await api('assign', { body: { reservation_id: reservationId, table_ids: tableIds } });
      toast('Table updated', 'success');
      // Assigning a held request confirms it (a lifecycle change → notifications).
      try { window.dispatchEvent(new CustomEvent('atlas:bookings-changed')); } catch { /* no-op */ }
      await loadSnapshot({ force: true, silent: true });
      refreshReservationLayer(root, reservationId);
    } catch (error) {
      const seatError = root?.querySelector('[data-bookings-seat-error]');
      if (seatError) { seatError.textContent = seatErrorMessage(error); seatError.hidden = false; }
      toast(shown(error, 'That table couldn’t be assigned. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
    }
  }

  // ---------- render: config ----------

  // Configuration is a settings view: each section is a row with a label
  // column (title, one sentence, its add action) beside the panel it governs,
  // split by full-width rules. The rules section's label column says what the
  // saved values produce, so the numbers read as a booking, not as a form.

  function configHeadMarkup(sub) {
    return `<header class="page-head"><div class="page-head__text"><a class="bk-crumb" href="#bookings">${icon('chevron-left')}Bookings</a><h1 class="page-head__title">Configuration</h1>${sub ? `<p class="page-head__sub">${escapeHtml(sub)}</p>` : ''}</div></header>`;
  }

  function configDeniedMarkup() {
    return `<div class="bk">${configHeadMarkup('')}
      <div class="atlas-empty atlas-empty--page bk-empty" data-bookings-config-denied><div class="atlas-empty__icon">${icon('lock')}</div><h2 class="atlas-empty__title">Configuration is for managers</h2><p class="atlas-empty__text">Areas, tables and booking rules are set up by a manager. Ask an administrator if you need access.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#bookings">Back to Bookings</a></div></div></div>`;
  }

  function colourSelectMarkup(selected) {
    return SECTION_COLOURS.map((colour) => `<option value="${colour}"${colour === selected ? ' selected' : ''}>${humanize(colour)}</option>`).join('');
  }

  function cfgSectionMarkup({ id, title, desc, action = '', panel }) {
    return `<section class="bk-cfg-section" aria-labelledby="${id}">
      <div class="bk-cfg-head"><h2 class="bk-cfg-title" id="${id}">${escapeHtml(title)}</h2>${desc ? `<p class="bk-cfg-desc">${desc}</p>` : ''}${action}</div>
      <div class="bk-cfg-panel">${panel}</div>
    </section>`;
  }

  function configAreasMarkup() {
    const list = Array.isArray(state.config?.areas) ? state.config.areas : [];
    const tablesList = Array.isArray(state.config?.tables) ? state.config.tables : [];
    const rows = list.map((area) => {
      const count = tablesList.filter((table) => table.area_id === area.id).length;
      return `<li class="atlas-row bk-cfg-row" data-bookings-area-row="${escapeHtml(area.id)}">
      <span class="bk-swatch bk-c-${escapeHtml(sectionColour(area))}" aria-hidden="true"></span>
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(area.name)}</p><p class="atlas-row__meta">${escapeHtml([humanize(area.section_colour || 'teal'), area.allocation_mode === 'pooled' ? `Pooled${area.guest_capacity ? `, ${area.guest_capacity} guests` : ''}` : plural(count, 'table')].join(' · '))}</p></div>
      ${area.is_active === false ? '<span class="atlas-pill atlas-pill--neutral">Hidden</span>' : ''}
      <div class="bk-cfg-row__end"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-bookings-edit-area="${escapeHtml(area.id)}" aria-label="${escapeHtml(`Edit ${area.name}`)}">${icon('pencil')}Edit</button></div>
    </li>`;
    }).join('');
    return cfgSectionMarkup({
      id: 'bk-cfg-areas', title: 'Areas', desc: 'Where guests sit. An area’s colour marks it on the floor plan.',
      action: `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-add-area>${icon('plus')}Add area</button>`,
      panel: rows ? `<ul class="atlas-list bk-cfg-list">${rows}</ul>` : '<p class="bk-empty-line">No areas yet. Add the first area.</p>'
    });
  }

  function configTablesMarkup() {
    const list = Array.isArray(state.config?.tables) ? state.config.tables : [];
    const areaName = (id) => (state.config?.areas || []).find((area) => area.id === id)?.name || '—';
    const rows = list.map((table) => {
      const flags = [table.block_online ? '<span class="atlas-pill atlas-pill--neutral">Online blocked</span>' : '', table.temporarily_unavailable ? '<span class="atlas-pill atlas-pill--warning">Unavailable</span>' : ''].join('');
      return `<li class="atlas-row bk-cfg-row bk-cfg-row--table" data-bookings-table-row="${escapeHtml(table.id)}">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(table.label)}</p><p class="atlas-row__meta">${escapeHtml([areaName(table.area_id), table.segment ? `Section ${table.segment}` : null].filter(Boolean).join(' · '))}</p></div>
      <span class="bk-cfg-row__flags">${flags}</span>
      <span class="bk-cfg-row__num">${escapeHtml(plural(Number(table.seat_capacity) || 0, 'seat'))}</span>
      <div class="bk-cfg-row__end"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-bookings-edit-table="${escapeHtml(table.id)}" aria-label="${escapeHtml(`Edit ${table.label}`)}">${icon('pencil')}Edit</button></div>
    </li>`;
    }).join('');
    const seats = list.reduce((sum, table) => sum + (Number(table.seat_capacity) || 0), 0);
    return cfgSectionMarkup({
      id: 'bk-cfg-tables', title: 'Tables',
      desc: list.length ? escapeHtml(`${plural(list.length, 'table')}, ${plural(seats, 'seat')} in all. Blocking a table online still lets staff seat it.`) : 'Each table or stool guests can be seated at.',
      action: `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-add-table>${icon('plus')}Add table</button>`,
      panel: rows ? `<ul class="atlas-list bk-cfg-list">${rows}</ul>` : '<p class="bk-empty-line">No tables yet. Add the first table.</p>'
    });
  }

  function configCombosMarkup() {
    const list = Array.isArray(state.config?.combinations) ? state.config.combinations : [];
    const tableLabel = (id) => (state.config?.tables || []).find((table) => table.id === id)?.label || id;
    const rows = list.map((combo) => `<li class="atlas-row bk-cfg-row" data-bookings-combo-row="${escapeHtml(combo.id)}">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(combo.name)}</p><p class="atlas-row__meta">${escapeHtml((combo.member_table_ids || []).map(tableLabel).join(' + '))}</p></div>
      ${combo.is_permitted === false ? '<span class="atlas-pill atlas-pill--neutral">Not permitted</span>' : ''}
      <span class="bk-cfg-row__num">${escapeHtml(plural(Number(combo.combined_capacity) || 0, 'seat'))}</span>
    </li>`).join('');
    return cfgSectionMarkup({
      id: 'bk-cfg-combos', title: 'Permitted combinations', desc: 'Only the tables listed together here can be auto-assigned as one booking.',
      action: `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-add-combo>${icon('plus')}Add combination</button>`,
      panel: rows ? `<ul class="atlas-list bk-cfg-list">${rows}</ul>` : '<p class="bk-empty-line">No combinations. Only listed combinations can be auto-assigned.</p>'
    });
  }

  // What the saved rules produce, in one sentence beside them.
  function rulesSummary(settings) {
    const parts = [];
    if (settings.default_duration_minutes) parts.push(`A booking holds its seats for ${settings.default_duration_minutes} minutes`);
    if (settings.turnaround_minutes != null) parts.push(`with ${settings.turnaround_minutes} minutes before the next`);
    let text = parts.join(' ');
    if (settings.slot_interval_minutes) text += `${text ? '; guests' : 'Guests'} choose a time every ${settings.slot_interval_minutes} minutes`;
    if (settings.advance_days) text += `${text ? ', ' : 'Guests book '}up to ${settings.advance_days} days ahead`;
    return text ? `${text}.` : 'The rules every booking is checked against.';
  }

  function configSettingsMarkup() {
    const settings = state.config?.settings || {};
    const number = (name, value, min, max, step = 1) => `<input class="atlas-input" type="number" id="bk-set-${name}" name="${name}" value="${escapeHtml(String(value ?? ''))}" min="${min}" max="${max}" step="${step}" inputmode="numeric">`;
    const field = (name, label, unit, input) => `<div class="atlas-field"><label for="bk-set-${name}">${escapeHtml(label)}</label><div class="bk-unit">${input}<span class="bk-unit__suffix" aria-hidden="true">${escapeHtml(unit)}</span></div></div>`;
    const panel = `<form class="atlas-form bk-settings" id="bk-settings-form" data-bookings-settings-form novalidate>
        <div class="bk-settings__group">
          <h3 class="bk-form__title">Timing</h3>
          <div class="atlas-grid-2">
            ${field('slot_interval_minutes', 'Slot interval', 'min', number('slot_interval_minutes', settings.slot_interval_minutes, 5, 240, 5))}
            ${field('default_duration_minutes', 'Default duration', 'min', number('default_duration_minutes', settings.default_duration_minutes, 15, 600, 5))}
            ${field('turnaround_minutes', 'Turnaround', 'min', number('turnaround_minutes', settings.turnaround_minutes, 0, 240, 5))}
            ${field('last_start_offset_minutes', 'Last start before close', 'min', number('last_start_offset_minutes', settings.last_start_offset_minutes, 0, 360, 5))}
          </div>
        </div>
        <div class="bk-settings__group">
          <h3 class="bk-form__title">Online bookings</h3>
          <div class="atlas-grid-2">
            ${field('advance_days', 'Advance booking', 'days', number('advance_days', settings.advance_days, 1, 730))}
            ${field('max_party_online', 'Max party online', 'guests', number('max_party_online', settings.max_party_online, 1, 500))}
            ${field('approval_party_threshold', 'Approval threshold', 'guests', number('approval_party_threshold', settings.approval_party_threshold, 1, 500))}
          </div>
          <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="bk-set-auto-label">Auto-confirm website bookings</p><p class="atlas-toggle-row__help">Keep this off for VÁ: website requests wait for staff approval. Staff-created phone and walk-in bookings can confirm when saved.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${settings.auto_confirm ? 'true' : 'false'}" aria-labelledby="bk-set-auto-label" data-bookings-auto-confirm></button></div>
        </div>
        <input type="hidden" name="expected_version" value="${escapeHtml(String(settings.version ?? ''))}">
        <div class="bk-settings__foot"><button type="submit" class="atlas-btn atlas-btn--primary" data-bookings-settings-save>Save rules</button></div>
      </form>`;
    return cfgSectionMarkup({ id: 'bk-cfg-rules', title: 'Availability rules', desc: escapeHtml(rulesSummary(settings)), panel });
  }

  function configMarkup() {
    if (!state.config && !state.error) {
      return `<div class="bk bk-config">${configHeadMarkup('Areas, tables, combinations and booking rules')}<div class="bk-skel bk-skel--config" aria-busy="true">${'<span class="atlas-skel bk-skel__row"></span>'.repeat(5)}<span class="sr-only">Loading configuration</span></div></div>`;
    }
    return `<div class="bk bk-config" data-bookings-config>
      ${configHeadMarkup('Areas, tables, combinations and booking rules')}
      ${alertMarkup()}
      ${state.config ? `${configAreasMarkup()}${configTablesMarkup()}${configCombosMarkup()}${configSettingsMarkup()}` : ''}
    </div>`;
  }

  // ---------- config editors ----------

  function openAreaEditor(areaId) {
    const area = (state.config?.areas || []).find((entry) => entry.id === areaId) || {};
    const root = window.AtlasModal.layer({
      id: 'bk-area-layer', className: 'bk-layer', initialFocus: '#bk-area-name',
      panel: `<section class="atlas-sheet bk-editor" data-modal-panel aria-labelledby="bk-area-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-area-title">${area.id ? 'Edit area' : 'Add area'}</h2></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="bk-area-form" data-bookings-area-form novalidate>
          <input type="hidden" name="id" value="${escapeHtml(area.id || '')}">
          <div class="atlas-field"><label for="bk-area-name">Name</label><input class="atlas-input" id="bk-area-name" name="name" maxlength="80" required value="${escapeHtml(area.name || '')}"><p class="error" hidden data-error-for="name">Add a name.</p></div>
          <div class="atlas-field"><label for="bk-area-colour">Section colour</label><select class="atlas-select" id="bk-area-colour" name="section_colour">${colourSelectMarkup(sectionColour(area))}</select></div>
          <div class="atlas-field"><label for="bk-area-order">Display order</label><input class="atlas-input" type="number" id="bk-area-order" name="display_order" min="0" max="999" value="${escapeHtml(String(area.display_order ?? 0))}"></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="bk-area-form" class="atlas-btn atlas-btn--primary" data-bookings-area-save>Save area</button></footer>
      </section>`
    });
    paintIcons();
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      const name = String(data.get('name') || '').trim();
      const nameError = root.querySelector('[data-error-for="name"]');
      if (!name) { if (nameError) nameError.hidden = false; return; }
      const body = { name, section_colour: String(data.get('section_colour') || 'teal'), display_order: Number(data.get('display_order')) || 0 };
      if (data.get('id')) body.id = data.get('id');
      await saveConfig('save-area', body, root, 'Area saved');
    });
  }

  function openTableEditor(tableId) {
    const table = (state.config?.tables || []).find((entry) => entry.id === tableId) || {};
    const areaOptions = (state.config?.areas || []).map((area) => `<option value="${escapeHtml(area.id)}"${area.id === table.area_id ? ' selected' : ''}>${escapeHtml(area.name)}</option>`).join('');
    const root = window.AtlasModal.layer({
      id: 'bk-table-layer', className: 'bk-layer', initialFocus: '#bk-table-label',
      panel: `<section class="atlas-sheet bk-editor" data-modal-panel aria-labelledby="bk-table-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-table-title">${table.id ? 'Edit table' : 'Add table'}</h2></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="bk-table-form" data-bookings-table-form novalidate>
          <input type="hidden" name="id" value="${escapeHtml(table.id || '')}">
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="bk-table-label">Label</label><input class="atlas-input" id="bk-table-label" name="label" maxlength="40" required value="${escapeHtml(table.label || '')}"><p class="error" hidden data-error-for="label">Add a label.</p></div>
            <div class="atlas-field"><label for="bk-table-area">Area</label><select class="atlas-select" id="bk-table-area" name="area_id" required>${areaOptions || '<option value="">No areas yet</option>'}</select></div>
          </div>
          <div class="atlas-grid-2">
            <div class="atlas-field"><label for="bk-table-cap">Seat capacity</label><input class="atlas-input" type="number" id="bk-table-cap" name="seat_capacity" min="1" max="99" value="${escapeHtml(String(table.seat_capacity ?? 2))}" required></div>
            <div class="atlas-field"><label for="bk-table-min">Minimum party</label><input class="atlas-input" type="number" id="bk-table-min" name="min_party" min="0" max="99" value="${escapeHtml(String(table.min_party ?? 1))}"></div>
          </div>
          <div class="atlas-field"><label for="bk-table-priority">Priority</label><input class="atlas-input" type="number" id="bk-table-priority" name="priority" min="0" max="999" value="${escapeHtml(String(table.priority ?? 0))}"></div>
          <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="bk-table-block-label">Block online booking</p><p class="atlas-toggle-row__help">Staff can still seat this table.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${table.block_online ? 'true' : 'false'}" aria-labelledby="bk-table-block-label" data-bookings-block-online></button></div>
          <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="bk-table-unavail-label">Temporarily unavailable</p><p class="atlas-toggle-row__help">Hidden from booking until turned back on.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${table.temporarily_unavailable ? 'true' : 'false'}" aria-labelledby="bk-table-unavail-label" data-bookings-temp-unavailable></button></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="bk-table-form" class="atlas-btn atlas-btn--primary" data-bookings-table-save>Save table</button></footer>
      </section>`
    });
    paintIcons();
    root.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-bookings-block-online], [data-bookings-temp-unavailable]');
      if (toggle) toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'));
    });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      const label = String(data.get('label') || '').trim();
      const labelError = root.querySelector('[data-error-for="label"]');
      if (!label) { if (labelError) labelError.hidden = false; return; }
      const body = {
        label,
        area_id: String(data.get('area_id') || '') || undefined,
        seat_capacity: Number(data.get('seat_capacity')) || 1,
        min_party: Number(data.get('min_party')) || 0,
        priority: Number(data.get('priority')) || 0,
        block_online: root.querySelector('[data-bookings-block-online]').getAttribute('aria-checked') === 'true',
        temporarily_unavailable: root.querySelector('[data-bookings-temp-unavailable]').getAttribute('aria-checked') === 'true'
      };
      if (data.get('id')) body.id = data.get('id');
      await saveConfig('save-table', body, root, 'Table saved');
    });
  }

  function openComboEditor() {
    const tablesList = state.config?.tables || [];
    const root = window.AtlasModal.layer({
      id: 'bk-combo-layer', className: 'bk-layer', initialFocus: '#bk-combo-name',
      panel: `<section class="atlas-sheet bk-editor" data-modal-panel aria-labelledby="bk-combo-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-combo-title">Add combination</h2></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="bk-combo-form" data-bookings-combo-form novalidate>
          <div class="atlas-field"><label for="bk-combo-name">Name</label><input class="atlas-input" id="bk-combo-name" name="name" maxlength="60" required><p class="error" hidden data-error-for="name">Add a name.</p></div>
          <fieldset class="atlas-form-group bk-combo-members"><legend class="atlas-form-group__title">Member tables</legend>${tablesList.map((table) => `<label class="atlas-check-row"><input type="checkbox" class="atlas-check" name="member_table_ids" value="${escapeHtml(table.id)}">${escapeHtml(table.label)}</label>`).join('') || '<p class="bk-note">Add tables first.</p>'}</fieldset>
          <div class="atlas-field"><label for="bk-combo-cap">Combined capacity</label><input class="atlas-input" type="number" id="bk-combo-cap" name="combined_capacity" min="1" max="200" value="4"></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="bk-combo-form" class="atlas-btn atlas-btn--primary" data-bookings-combo-save>Save combination</button></footer>
      </section>`
    });
    paintIcons();
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      const name = String(data.get('name') || '').trim();
      const members = data.getAll('member_table_ids').map(String);
      const nameError = root.querySelector('[data-error-for="name"]');
      if (!name) { if (nameError) nameError.hidden = false; return; }
      const body = { name, member_table_ids: members, combined_capacity: Number(data.get('combined_capacity')) || members.length, is_permitted: true };
      await saveConfig('save-combination', body, root, 'Combination saved');
    });
  }

  async function saveConfig(action, body, root, successMessage) {
    if (state.submitting) return;
    state.submitting = true;
    try {
      await api(action, { body });
      toast(successMessage, 'success');
      if (root) window.AtlasModal.dismiss(root);
      await loadConfig({ force: true });
    } catch (error) {
      toast(shown(error, 'The change couldn’t be saved. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
    }
  }

  async function saveSettings(form) {
    if (state.submitting) return;
    const data = new FormData(form);
    const body = {
      slot_interval_minutes: Number(data.get('slot_interval_minutes')) || null,
      default_duration_minutes: Number(data.get('default_duration_minutes')) || null,
      turnaround_minutes: Number(data.get('turnaround_minutes')) || 0,
      approval_party_threshold: Number(data.get('approval_party_threshold')) || null,
      advance_days: Number(data.get('advance_days')) || null,
      last_start_offset_minutes: Number(data.get('last_start_offset_minutes')) || 0,
      max_party_online: Number(data.get('max_party_online')) || null,
      auto_confirm: form.querySelector('[data-bookings-auto-confirm]').getAttribute('aria-checked') === 'true',
      expected_version: data.get('expected_version') ? Number(data.get('expected_version')) : null
    };
    state.submitting = true;
    const save = form.querySelector('[data-bookings-settings-save]');
    if (save) save.disabled = true;
    try {
      await api('save-settings', { body });
      toast('Booking rules saved', 'success');
      await loadConfig({ force: true });
    } catch (error) {
      toast(shown(error, 'The rules couldn’t be saved. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
      if (save) save.disabled = false;
    }
  }

  // ---------- load ----------

  // Only the latest request lands: stepping quickly through days must never
  // leave one day's grid under another day's header. A superseded request
  // resolves with the latest one, so callers awaiting it see current data.
  function loadSnapshot(options = {}) {
    if (state.snapshotPromise && !options.force && state.snapshotFor === state.date) return state.snapshotPromise;
    const serial = ++state.snapshotSerial;
    const date = state.date;
    state.loading = true;
    if (!options.silent) state.error = null;
    if (!options.silent) paint();
    const latest = () => serial === state.snapshotSerial;
    const promise = (async () => {
      try {
        const payload = await api('snapshot', { params: { date } });
        if (!latest()) return state.snapshotPromise;
        // The open day changed without a new request: load that day instead.
        if (date !== state.date) return loadSnapshot({ ...options, force: true });
        if (payload?.date && payload.date !== date) throw new Error('The snapshot is for another day.');
        state.snapshot = payload || null;
        state.permissions = payload?.permissions || state.permissions;
        state.actorRole = payload?.actor_role || state.actorRole;
        state.error = null;
        state.failedAt = 0;
        state.loadedAt = Date.now();
      } catch (error) {
        if (!latest()) return state.snapshotPromise;
        if (!options.silent || !state.snapshot) state.error = shown(error, 'Bookings couldn’t be loaded. Check the connection and try again.');
        state.failedAt = Date.now();
      } finally {
        if (latest()) {
          state.loading = false;
          state.snapshotPromise = null;
          state.snapshotFor = null;
          paint();
        }
      }
      return undefined;
    })();
    state.snapshotPromise = promise;
    state.snapshotFor = date;
    return promise;
  }

  // A day view left open (or returned to) goes stale: new requests arrive
  // from the website. Reload quietly on return, but never under an open
  // sheet, form, calendar or save.
  const STALE_SNAPSHOT_MS = 60000;
  function snapshotIsStale() {
    return state.section === 'day' && Boolean(state.snapshot) && state.snapshot.date === state.date
      && !state.snapshotPromise && !state.submitting && !state.cal && state.loadedAt > 0
      && Date.now() - state.loadedAt > STALE_SNAPSHOT_MS
      && !document.querySelector('.bk-layer');
  }

  function loadConfig(options = {}) {
    if (state.configPromise && !options.force) return state.configPromise;
    if (!options.silent) state.error = null;
    if (!options.silent) paint();
    state.configPromise = (async () => {
      try {
        const payload = await api('config');
        state.config = payload || null;
        state.error = null;
      } catch (error) {
        state.error = shown(error, 'Configuration couldn’t be loaded. Check the connection and try again.');
      } finally {
        state.configPromise = null;
        paint();
      }
    })();
    return state.configPromise;
  }

  // ---------- render ----------

  function paint() {
    if (!state.visible) return;
    const view = host();
    if (!view) return;
    if (view.classList.contains('placeholder-view')) view.classList.remove('placeholder-view');
    view.classList.add('bk-host');
    if (state.section === 'config') {
      // Gate on the server-authoritative permission; a non-manager sees a
      // permission state, never the controls.
      if (state.permissions && !canConfigure()) view.innerHTML = configDeniedMarkup();
      else view.innerHTML = configMarkup();
    } else {
      view.innerHTML = dayMarkup();
    }
    placeMarks(view);
    paintIcons();
  }

  function render(params = {}) {
    state.visible = true;
    const rawSection = params.section != null ? String(params.section) : '';
    if (rawSection === 'config') {
      state.section = 'config';
    } else {
      state.section = 'day';
      if (DATE_RE.test(rawSection)) state.date = rawSection;
    }
    if (!state.date) state.date = todayISO();

    paint();
    // The snapshot carries permissions for both sections, so it loads first.
    const otherDay = Boolean(state.snapshot && state.snapshot.date && state.snapshot.date !== state.date);
    const needSnapshot = otherDay || (!state.snapshot && (!state.failedAt || Date.now() - state.failedAt > 20000));
    const stale = !needSnapshot && snapshotIsStale();
    const ensure = needSnapshot ? loadSnapshot(otherDay ? { force: true } : undefined)
      : stale ? loadSnapshot({ force: true, silent: true }) : Promise.resolve();
    // Whether this render fetched the day, or relies on the cached snapshot.
    const fetched = needSnapshot || stale;
    if (state.section === 'config') {
      ensure.then(() => { if (state.visible && state.section === 'config' && canConfigure() && !state.config) loadConfig(); });
    }
    // Deep link from a booking notification (#bookings/res/<id>): open that
    // reservation's detail once the day view is ready.
    // A booking made after the cached snapshot (a new website request) is not
    // in it yet: fetch the day once, quietly, before saying it isn't there.
    if (params.reservation) {
      const id = String(params.reservation);
      ensure.then(async () => {
        if (!state.visible) return;
        if (!reservationById(id) && state.snapshot && !fetched) {
          await loadSnapshot({ force: true, silent: true });
          if (!state.visible) return;
        }
        if (reservationById(id)) openReservation(id);
        else if (state.snapshot) toast('That booking isn’t on this day. Open its date to see it.', 'info');
      });
    }
    if (!params.section && !params.reservation) window.scrollTo?.(0, 0);
  }

  function onHide() {
    state.visible = false;
    state.cal = null;
  }

  // ---------- navigation ----------

  function go(section) {
    window.AtlasShell?.show?.('bookings', section ? { section } : {}, { source: 'route', route: section ? `#bookings/${section}` : '#bookings' });
  }

  // ---------- events ----------

  function setDay(key) {
    if (!DATE_RE.test(key)) return;
    state.cal = null;
    if (key === state.date) { paint(); return; }
    state.date = key;
    loadSnapshot({ force: true });
  }

  function openCalendar() {
    state.cal = { month: monthStartOf(state.date), focus: state.date };
    paint();
    host()?.querySelector('[data-bookings-cal] [tabindex="0"]')?.focus({ preventScroll: true });
  }

  function closeCalendar({ refocus = false } = {}) {
    if (!state.cal) return;
    state.cal = null;
    paint();
    if (refocus) host()?.querySelector('[data-bookings-calendar]')?.focus({ preventScroll: true });
  }

  // Moving inside the open calendar redraws only its body: no re-entry, no
  // animation for a keyboard step, and focus follows the day.
  function moveCalendar(focus, month = monthStartOf(focus)) {
    if (!state.cal) return;
    state.cal = { month, focus };
    const body = host()?.querySelector('[data-bookings-cal-body]');
    if (!body) return;
    body.innerHTML = calendarGridMarkup();
    paintIcons();
    body.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  }

  function handleKeydown(event) {
    if (!state.cal) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[data-bookings-cal]')) {
      if (event.key === 'Escape' && host()?.contains(target)) closeCalendar({ refocus: true });
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeCalendar({ refocus: true }); return; }
    if (!target.matches('[data-bookings-pick]')) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (step) { event.preventDefault(); moveCalendar(shiftDay(state.cal.focus, step)); return; }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      const month = shiftMonth(state.cal.month, event.key === 'PageUp' ? -1 : 1);
      const day = Math.min(Number(state.cal.focus.slice(8, 10)), 28);
      moveCalendar(`${month.slice(0, 8)}${String(day).padStart(2, '0')}`, month);
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    // A click anywhere outside the date control closes its calendar.
    if (state.cal && !target?.closest('.bk-date')) closeCalendar();
    if (!target || !host()?.contains(target)) return;

    const dayStep = target.closest('[data-bookings-day-step]');
    if (dayStep) { setDay(shiftDay(state.date, Number(dayStep.dataset.bookingsDayStep) || 0)); return; }
    if (target.closest('[data-bookings-today]')) { setDay(todayISO()); return; }
    if (target.closest('[data-bookings-calendar]')) { if (state.cal) closeCalendar(); else openCalendar(); return; }
    const calMonth = target.closest('[data-bookings-cal-month]');
    if (calMonth && state.cal) {
      const month = shiftMonth(state.cal.month, Number(calMonth.dataset.bookingsCalMonth) || 0);
      state.cal = { month, focus: state.date.slice(0, 7) === month.slice(0, 7) ? state.date : month };
      const body = host()?.querySelector('[data-bookings-cal-body]');
      if (body) { body.innerHTML = calendarGridMarkup(); paintIcons(); body.querySelector(`[data-bookings-cal-month="${calMonth.dataset.bookingsCalMonth}"]`)?.focus({ preventScroll: true }); }
      return;
    }
    const pick = target.closest('[data-bookings-pick]');
    if (pick) { setDay(pick.dataset.bookingsPick); host()?.querySelector('[data-bookings-calendar]')?.focus({ preventScroll: true }); return; }

    if (target.closest('[data-bookings-refresh]')) { state.failedAt = 0; if (state.section === 'config') loadConfig({ force: true }); else loadSnapshot({ force: true }); return; }
    if (target.closest('[data-bookings-add]')) { openAddBooking(); return; }

    const viewBtn = target.closest('[data-bookings-view]');
    if (viewBtn) { setMode(viewBtn.dataset.bookingsView); return; }

    // The requests queue's trailing decision: the same single-click Confirm as
    // the detail sheet (it assigns the free adjacent seats for a seat request).
    const confirmBtn = target.closest('[data-bookings-confirm]');
    if (confirmBtn) {
      if (!canManageReservations() || state.submitting) return;
      confirmBtn.classList.add('is-loading');
      changeStatus(confirmBtn.dataset.bookingsConfirm, 'confirmed', null)
        .finally(() => { if (confirmBtn.isConnected) confirmBtn.classList.remove('is-loading'); });
      return;
    }

    // Config editors.
    const editArea = target.closest('[data-bookings-edit-area]');
    if (editArea) { openAreaEditor(editArea.dataset.bookingsEditArea); return; }
    if (target.closest('[data-bookings-add-area]')) { openAreaEditor(null); return; }
    const editTable = target.closest('[data-bookings-edit-table]');
    if (editTable) { openTableEditor(editTable.dataset.bookingsEditTable); return; }
    if (target.closest('[data-bookings-add-table]')) { openTableEditor(null); return; }
    if (target.closest('[data-bookings-add-combo]')) { openComboEditor(); return; }
    const autoToggle = target.closest('[data-bookings-auto-confirm]');
    if (autoToggle) { autoToggle.setAttribute('aria-checked', String(autoToggle.getAttribute('aria-checked') !== 'true')); return; }

    // Any reservation card/row opens its detail.
    const reservationTrigger = target.closest('[data-bookings-reservation]');
    if (reservationTrigger?.dataset.bookingsReservation) {
      openReservation(reservationTrigger.dataset.bookingsReservation);
      return;
    }

    // A free table or list row offers to add a booking there.
    const tableTrigger = target.closest('[data-bookings-table]');
    if (tableTrigger) {
      const reservationId = tableTrigger.dataset.bookingsReservation;
      if (reservationId) openReservation(reservationId);
      else if (canManageReservations()) openAddBooking({ tableId: tableTrigger.dataset.bookingsTable, date: state.date });
      return;
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !host()?.contains(form)) return;
    if (form.matches('[data-bookings-settings-form]')) { event.preventDefault(); saveSettings(form); }
  }

  function setMode(mode) {
    if (mode !== 'map' && mode !== 'list') return;
    state.mode = mode;
    try { window.localStorage?.setItem(VIEW_STORAGE_KEY, mode); } catch { /* storage unavailable */ }
    paint();
  }

  function loadStoredMode() {
    try {
      const stored = window.localStorage?.getItem(VIEW_STORAGE_KEY);
      if (stored === 'map' || stored === 'list') state.mode = stored;
    } catch { /* storage unavailable: default map */ }
  }

  // ---------- registration ----------

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell?.registerView) return;
    shell.registerView('bookings', { root: () => host(), title: 'Bookings', render, onHide });
    shell.actions?.register?.({
      id: 'bookings.open', label: 'Open Bookings', icon: 'calendar-check', keywords: ['booking', 'reservation', 'table', 'floor', 'guests'], contexts: ['home'],
      run: () => go('')
    });
    shell.actions?.register?.({
      id: 'bookings.add', label: 'Add booking', icon: 'calendar-plus', keywords: ['booking', 'reservation', 'phone', 'walk-in'], contexts: ['home', 'bookings'],
      run: () => { go(''); window.setTimeout(() => openAddBooking(), 300); }
    });
    if (shell.current?.() === 'bookings') render(shell.params?.() || {});
  }

  function init() {
    if (state.initialized || !host()) return;
    state.initialized = true;
    loadStoredMode();
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('submit', handleSubmit);
    window.addEventListener('online', () => { if (state.visible) { if (state.section === 'config') loadConfig({ force: true, silent: true }); else loadSnapshot({ force: true, silent: true }); } });
    phoneQuery.addEventListener?.('change', () => { if (state.visible) paint(); });
    registerWithShell();
  }

  window.AtlasBookings = {
    open: () => go(''),
    openConfig: () => go('config'),
    refresh: () => (state.section === 'config' ? loadConfig({ force: true }) : loadSnapshot({ force: true })),
    snapshot: () => state.snapshot,
    config: () => state.config
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
