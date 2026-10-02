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
    configPromise: null,
    visible: false,
    initialized: false
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

  function longDate(dateKey) {
    if (!dateKey) return '';
    const date = new Date(`${dateKey}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return dateKey;
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
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
    failed: 'Bookings is temporarily unavailable.'
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

  // Live reservations allocated to a table on the loaded day.
  function reservationsForTable(tableId) {
    return reservations().filter((reservation) => LIVE_STATUSES.has(reservation.status)
      && Array.isArray(reservation.tables) && reservation.tables.some((allocation) => allocation.table_id === tableId));
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
    if (holds().some((hold) => hold.table_id === table.id)) return { key: 'held', label: 'Booked', tone: 'warning' };
    return { key: 'free', label: 'Free', tone: 'neutral' };
  }

  function tablesForArea(areaId) {
    return tables().filter((table) => table.area_id === areaId)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  }

  function freeTables() {
    return tables().filter((table) => tableStatus(table).key === 'free');
  }

  // ---------- render: day view ----------

  function headerMarkup() {
    const sub = state.snapshot
      ? `${reservations().filter((reservation) => LIVE_STATUSES.has(reservation.status)).length} on the floor · ${tables().length} tables`
      : state.error ? 'Bookings couldn’t be loaded' : 'The floor for the day';
    const actions = canManageReservations()
      ? `<button type="button" class="atlas-btn atlas-btn--primary" data-bookings-add>${icon('plus')}Add booking</button>` : '';
    const configLink = canConfigure()
      ? `<a class="atlas-btn atlas-btn--secondary" href="#bookings/config" data-bookings-config-link>${icon('sliders-horizontal')}Configure</a>` : '';
    return `<header class="page-head"><div class="page-head__text"><h1 class="page-head__title">Bookings</h1><p class="page-head__sub">${escapeHtml(sub)}</p></div><div class="page-head__actions">${configLink}${actions}</div></header>`;
  }

  function controlsMarkup() {
    return `<div class="bk-controls">
      <div class="atlas-field bk-date">
        <label for="bk-date-input">Date</label>
        <input class="atlas-input" type="date" id="bk-date-input" value="${escapeHtml(state.date)}" data-bookings-date aria-label="Booking date">
      </div>
      <div class="atlas-segmented bk-viewtoggle" role="group" aria-label="Floor plan or list" data-bookings-view-toggle>
        <button type="button" aria-pressed="${state.mode === 'map'}" data-bookings-view="map">${icon('layout-grid')}Floor plan</button>
        <button type="button" aria-pressed="${state.mode === 'list'}" data-bookings-view="list">${icon('list')}List</button>
      </div>
    </div>`;
  }

  function alertMarkup() {
    if (!state.error) return '';
    return `<div class="atlas-alert atlas-alert--danger bk-alert" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Bookings couldn’t be ${state.snapshot ? 'updated' : 'loaded'}.</p><p class="atlas-alert__body">${escapeHtml(state.error)} ${state.snapshot ? 'You’re seeing what loaded last.' : 'Nothing has changed.'}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-refresh>Try again</button></div></div>`;
  }

  function tableButtonMarkup(table) {
    const status = tableStatus(table);
    const reservation = reservationsForTable(table.id)[0] || null;
    const capacity = table.seat_capacity ? `${table.seat_capacity} seat${table.seat_capacity === 1 ? '' : 's'}` : '';
    const label = `${table.label} — ${status.label}${reservation?.guest_name ? `, ${reservation.guest_name}` : ''}`;
    return `<button type="button" class="bk-table bk-table--${escapeHtml(status.key)}" data-bookings-table="${escapeHtml(table.id)}"${reservation ? ` data-bookings-reservation="${escapeHtml(reservation.id)}"` : ''} aria-label="${escapeHtml(label)}">
      <span class="bk-table__label">${escapeHtml(table.label)}</span>
      <span class="bk-table__cap">${escapeHtml(capacity)}</span>
      <span class="bk-table__status" data-bookings-status>${escapeHtml(status.label)}</span>
      ${reservation ? `<span class="bk-table__guest">${escapeHtml(reservation.guest_name || SOURCE_LABEL[reservation.source] || 'Booked')} · ${escapeHtml(formatTime(reservation.start_at))}</span>` : ''}
    </button>`;
  }

  function mapMarkup() {
    const list = areas();
    if (!list.length) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('map')}</div><h2 class="atlas-empty__title">No areas configured yet</h2><p class="atlas-empty__text">${canConfigure() ? 'Add an area and its tables in Configure.' : 'Ask a manager to set up the floor plan.'}</p></div>`;
    }
    const groups = list.map((area) => {
      const colour = sectionColour(area);
      const areaTables = tablesForArea(area.id);
      return `<section class="bk-area bk-c-${escapeHtml(colour)}" data-bookings-area="${escapeHtml(area.id)}" aria-labelledby="bk-area-${escapeHtml(area.id)}">
        <h3 class="bk-area__title" id="bk-area-${escapeHtml(area.id)}"><span class="bk-swatch" aria-hidden="true"></span>${escapeHtml(area.name)}</h3>
        <div class="bk-area__tables">${areaTables.length ? areaTables.map(tableButtonMarkup).join('') : '<p class="bk-note">No tables in this area yet.</p>'}</div>
      </section>`;
    }).join('');
    return `<div class="bk-map" data-bookings-map role="group" aria-label="Floor plan">${groups}</div>`;
  }

  function listMarkup() {
    const rows = tables().map((table) => {
      const area = areas().find((entry) => entry.id === table.area_id);
      const status = tableStatus(table);
      const reservation = reservationsForTable(table.id)[0] || null;
      const meta = [area?.name, table.seat_capacity ? `${table.seat_capacity} seats` : null,
        reservation ? `${reservation.guest_name || SOURCE_LABEL[reservation.source] || 'Booked'} · ${formatTime(reservation.start_at)}` : null].filter(Boolean).join(' · ');
      return `<li class="atlas-row bk-row" data-bookings-row="${escapeHtml(table.id)}" data-bookings-table="${escapeHtml(table.id)}"${reservation ? ` data-bookings-reservation="${escapeHtml(reservation.id)}"` : ''}>
        <button type="button" class="bk-row__btn" aria-label="${escapeHtml(`${table.label} — ${status.label}`)}">
          <span class="bk-row__swatch bk-c-${escapeHtml(sectionColour(area))}" aria-hidden="true"></span>
          <span class="atlas-row__body"><span class="atlas-row__title">${escapeHtml(table.label)}</span><span class="atlas-row__meta">${escapeHtml(meta)}</span></span>
          <span class="bk-row__status">${pill(status.label, status.tone)}</span>
        </button>
      </li>`;
    }).join('');
    if (!rows) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('list')}</div><h2 class="atlas-empty__title">No tables yet</h2><p class="atlas-empty__text">${canConfigure() ? 'Add tables in Configure.' : 'Ask a manager to set up the tables.'}</p></div>`;
    }
    return `<ul class="atlas-list bk-list" data-bookings-list>${rows}</ul>`;
  }

  function dayBodyMarkup() {
    if (!state.snapshot && !state.error) {
      return `<div class="bk-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(5)}<span class="sr-only">Loading Bookings</span></div>`;
    }
    if (!state.snapshot) return '';
    return `<div class="bk-day" data-bookings-mode="${escapeHtml(state.mode)}">
      ${state.mode === 'map' ? mapMarkup() : listMarkup()}
    </div>`;
  }

  function dayMarkup() {
    return `<div class="bk">${headerMarkup()}${controlsMarkup()}${alertMarkup()}<div class="bk-body">${dayBodyMarkup()}</div></div>`;
  }

  // ---------- render: reservation detail ----------

  function reservationDetailMarkup(reservation) {
    const status = reservation.status;
    const tableLabels = (Array.isArray(reservation.tables) ? reservation.tables : []).map((allocation) => allocation.label || tableById(allocation.table_id)?.label).filter(Boolean);
    const contact = [reservation.guest_phone, reservation.guest_email].filter(Boolean);
    const transitions = (TRANSITIONS[status] || []).map(([to, label]) => {
      const tone = to === 'cancelled' || to === 'no_show' ? 'danger' : to === 'confirmed' ? 'primary' : 'secondary';
      return `<button type="button" class="atlas-btn atlas-btn--${tone} atlas-btn--sm" data-bookings-status-btn data-to-status="${escapeHtml(to)}">${escapeHtml(label)}</button>`;
    }).join('');
    const canAssign = canManageReservations() && LIVE_STATUSES.has(status);
    return `<section class="atlas-sheet bk-detail" data-modal-panel aria-labelledby="bk-detail-title">
      <span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-detail-title">${escapeHtml(reservation.guest_name || 'Reservation')}</h2><p class="atlas-sheet__desc">${escapeHtml(SOURCE_LABEL[reservation.source] || humanize(reservation.source || ''))} · ${escapeHtml(reservation.booking_reference || '')}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <div class="atlas-sheet__body bk-detail__body">
        <p class="bk-detail__status" data-bookings-detail-status>${pill(STATUS_LABEL[status] || humanize(status), STATUS_TONE[status] || 'neutral')}${status === 'requested' ? '<span class="bk-detail__requested">Not yet confirmed</span>' : ''}</p>
        <dl class="bk-detail__facts">
          <div><dt>Party</dt><dd>${escapeHtml(String(reservation.party_size || ''))}</dd></div>
          <div><dt>Time</dt><dd>${escapeHtml(formatTime(reservation.start_at))}${reservation.end_at ? `–${escapeHtml(formatTime(reservation.end_at))}` : ''}</dd></div>
          <div><dt>Tables</dt><dd data-bookings-detail-tables>${tableLabels.length ? escapeHtml(tableLabels.join(', ')) : 'Unassigned'}</dd></div>
          ${contact.length ? `<div><dt>Contact</dt><dd>${contact.map((entry) => escapeHtml(entry)).join('<br>')}</dd></div>` : ''}
          ${reservation.guest_requests ? `<div><dt>Requests</dt><dd>${escapeHtml(reservation.guest_requests)}</dd></div>` : ''}
          ${reservation.staff_notes ? `<div><dt>Staff notes</dt><dd>${escapeHtml(reservation.staff_notes)}</dd></div>` : ''}
        </dl>
        ${canAssign ? `<div class="bk-detail__assign"><label class="bk-detail__assign-label" for="bk-assign-select">Assign / move table</label>
          <div class="bk-detail__assign-row"><select class="atlas-select" id="bk-assign-select" data-bookings-assign-select>${assignOptions(reservation)}</select><button type="button" class="atlas-btn atlas-btn--secondary" data-bookings-assign>${icon('move')}Move</button></div></div>` : ''}
      </div>
      ${transitions ? `<footer class="atlas-sheet__foot bk-detail__foot" data-bookings-status-actions>${transitions}</footer>` : ''}
    </section>`;
  }

  function assignOptions(reservation) {
    const current = new Set((reservation.tables || []).map((allocation) => allocation.table_id));
    const options = tables()
      .filter((table) => !tableIsUnavailable(table))
      .filter((table) => current.has(table.id) || tableStatus(table).key === 'free')
      .map((table) => {
        const area = areas().find((entry) => entry.id === table.area_id);
        return `<option value="${escapeHtml(table.id)}"${current.has(table.id) ? ' selected' : ''}>${escapeHtml(table.label)}${area ? ` (${escapeHtml(area.name)})` : ''}</option>`;
      }).join('');
    return options || '<option value="">No free tables</option>';
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
        const select = root.querySelector('[data-bookings-assign-select]');
        const value = select?.value;
        if (value) await assignTable(reservationId, [value], root);
      }
    });
  }

  function refreshReservationLayer(root, reservationId) {
    const reservation = reservationById(reservationId);
    if (!root || !reservation) { window.AtlasModal.dismiss(root); return; }
    const panel = root.querySelector('[data-modal-panel]');
    if (panel) { panel.outerHTML = reservationDetailMarkup(reservation); paintIcons(); }
  }

  // ---------- render: add booking ----------

  function addBookingMarkup(prefill = {}) {
    const areaOptions = areas().map((area) => {
      const areaTables = tablesForArea(area.id).filter((table) => !tableIsUnavailable(table));
      if (!areaTables.length) return '';
      return `<optgroup label="${escapeHtml(area.name)}">${areaTables.map((table) => `<option value="${escapeHtml(table.id)}"${prefill.tableId === table.id ? ' selected' : ''}>${escapeHtml(table.label)}</option>`).join('')}</optgroup>`;
    }).join('');
    return `<section class="atlas-sheet bk-add" data-modal-panel aria-labelledby="bk-add-title">
      <span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="bk-add-title">Add booking</h2><p class="atlas-sheet__desc">Phone or walk-in. A reference is shown when it saves.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <form class="atlas-sheet__body atlas-form bk-add__form" id="bk-add-form" data-bookings-create-form novalidate>
        <div class="atlas-grid-2">
          <div class="atlas-field"><label for="bk-add-party">Party size</label><input class="atlas-input" type="number" min="1" max="500" inputmode="numeric" id="bk-add-party" name="party_size" value="2" required><p class="error" hidden data-error-for="party_size">Enter a party size.</p></div>
          <div class="atlas-field"><label for="bk-add-source">Source</label><select class="atlas-select" id="bk-add-source" name="source"><option value="phone">Phone</option><option value="walk_in">Walk-in</option></select></div>
        </div>
        <div class="atlas-grid-2">
          <div class="atlas-field"><label for="bk-add-date">Date</label><input class="atlas-input" type="date" id="bk-add-date" name="date" value="${escapeHtml(prefill.date || state.date)}" required></div>
          <div class="atlas-field"><label for="bk-add-time">Time</label><input class="atlas-input" type="time" id="bk-add-time" name="time" required><p class="error" hidden data-error-for="time">Enter a time.</p></div>
        </div>
        <div class="atlas-field"><label for="bk-add-table">Table <span class="optional">Optional</span></label><select class="atlas-select" id="bk-add-table" name="table_id"><option value="">Assign later</option>${areaOptions}</select></div>
        <div class="atlas-field"><label for="bk-add-name">Guest name</label><input class="atlas-input" id="bk-add-name" name="guest_name" maxlength="120" placeholder="Name for the booking"></div>
        <div class="atlas-field"><label for="bk-add-phone">Phone <span class="optional">Optional</span></label><input class="atlas-input" id="bk-add-phone" name="guest_phone" maxlength="60" inputmode="tel"></div>
        <div class="atlas-field"><label for="bk-add-requests">Requests <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="bk-add-requests" name="guest_requests" rows="2" maxlength="1000"></textarea></div>
      </form>
      <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="bk-add-form" class="atlas-btn atlas-btn--primary" data-bookings-create-submit>Save booking</button></footer>
    </section>`;
  }

  function openAddBooking(prefill = {}) {
    if (!canManageReservations()) return;
    const root = window.AtlasModal.layer({ id: 'bk-add-layer', className: 'bk-layer', panel: addBookingMarkup(prefill), initialFocus: '#bk-add-party' });
    paintIcons();
    root.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitBooking(root);
    });
  }

  async function submitBooking(root) {
    if (state.submitting) return;
    const form = root.querySelector('form');
    const data = new FormData(form);
    const party = Number(data.get('party_size'));
    const date = String(data.get('date') || '').trim();
    const time = String(data.get('time') || '').trim();
    const errors = { party_size: !Number.isInteger(party) || party < 1, time: !time || !date };
    Object.entries(errors).forEach(([key, bad]) => { const el = root.querySelector(`[data-error-for="${key}"]`); if (el) el.hidden = !bad; });
    if (Object.values(errors).some(Boolean)) return;
    const startAt = new Date(`${date}T${time}:00`).toISOString();
    const body = {
      party_size: party,
      start_at: startAt,
      source: String(data.get('source') || 'phone'),
      // This form is staff-only (phone / walk-in), so saving is itself the staff
      // approval. Guest/website requests omit this and remain requested.
      status: 'confirmed',
      guest_name: String(data.get('guest_name') || '').trim() || undefined,
      guest_phone: String(data.get('guest_phone') || '').trim() || undefined,
      guest_requests: String(data.get('guest_requests') || '').trim() || undefined
    };
    const tableId = String(data.get('table_id') || '').trim();
    if (tableId) body.table_ids = [tableId];
    state.submitting = true;
    const submit = root.querySelector('[data-bookings-create-submit]');
    if (submit) submit.disabled = true;
    try {
      const result = await api('create', { body });
      const reservation = result?.reservation || null;
      window.AtlasModal.dismiss(root);
      if (reservation) {
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
      toast(shown(error, 'The booking couldn’t be saved. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
      if (submit) submit.disabled = false;
    }
  }

  // ---------- mutations ----------

  async function changeStatus(reservationId, toStatus, root) {
    if (state.submitting || !toStatus) return;
    state.submitting = true;
    try {
      await api('set-status', { body: { reservation_id: reservationId, to_status: toStatus } });
      toast(`Marked ${STATUS_LABEL[toStatus] ? STATUS_LABEL[toStatus].toLowerCase() : toStatus}`, 'success');
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
      await loadSnapshot({ force: true, silent: true });
      refreshReservationLayer(root, reservationId);
    } catch (error) {
      toast(shown(error, 'That table couldn’t be assigned. Nothing was changed; try again.'), 'warning');
    } finally {
      state.submitting = false;
    }
  }

  // ---------- render: config ----------

  function configDeniedMarkup() {
    return `<div class="bk"><header class="page-head"><div class="page-head__text"><a class="bk-crumb" href="#bookings">${icon('chevron-left')}Bookings</a><h1 class="page-head__title">Configuration</h1></div></header>
      <div class="atlas-empty atlas-empty--page" data-bookings-config-denied><div class="atlas-empty__icon">${icon('lock')}</div><h2 class="atlas-empty__title">Configuration is for managers</h2><p class="atlas-empty__text">Areas, tables and booking rules are set up by a manager. Ask an administrator if you need access.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#bookings">Back to Bookings</a></div></div></div>`;
  }

  function colourSelectMarkup(selected) {
    return SECTION_COLOURS.map((colour) => `<option value="${colour}"${colour === selected ? ' selected' : ''}>${humanize(colour)}</option>`).join('');
  }

  function configAreasMarkup() {
    const list = Array.isArray(state.config?.areas) ? state.config.areas : [];
    const rows = list.map((area) => `<li class="atlas-row bk-cfg-row" data-bookings-area-row="${escapeHtml(area.id)}">
      <span class="bk-row__swatch bk-c-${escapeHtml(sectionColour(area))}" aria-hidden="true"></span>
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(area.name)}</p><p class="atlas-row__meta">${escapeHtml(humanize(area.section_colour || 'teal'))}${area.is_active === false ? ' · Hidden' : ''}</p></div>
      <div class="atlas-row__end"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-bookings-edit-area="${escapeHtml(area.id)}">${icon('pencil')}Edit</button></div>
    </li>`).join('');
    return `<section class="bk-cfg-section" aria-labelledby="bk-cfg-areas">
      <div class="bk-cfg-head"><h2 class="bk-cfg-title" id="bk-cfg-areas">Areas</h2><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-add-area>${icon('plus')}Add area</button></div>
      ${rows ? `<ul class="atlas-list bk-cfg-list">${rows}</ul>` : '<p class="bk-note">No areas yet. Add the first area.</p>'}
    </section>`;
  }

  function configTablesMarkup() {
    const list = Array.isArray(state.config?.tables) ? state.config.tables : [];
    const areaName = (id) => (state.config?.areas || []).find((area) => area.id === id)?.name || '—';
    const rows = list.map((table) => `<li class="atlas-row bk-cfg-row" data-bookings-table-row="${escapeHtml(table.id)}">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(table.label)}</p><p class="atlas-row__meta">${escapeHtml(areaName(table.area_id))} · ${escapeHtml(String(table.seat_capacity || 0))} seats${table.block_online ? ' · Online blocked' : ''}${table.temporarily_unavailable ? ' · Unavailable' : ''}</p></div>
      <div class="atlas-row__end"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-bookings-edit-table="${escapeHtml(table.id)}">${icon('pencil')}Edit</button></div>
    </li>`).join('');
    return `<section class="bk-cfg-section" aria-labelledby="bk-cfg-tables">
      <div class="bk-cfg-head"><h2 class="bk-cfg-title" id="bk-cfg-tables">Tables</h2><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-add-table>${icon('plus')}Add table</button></div>
      ${rows ? `<ul class="atlas-list bk-cfg-list">${rows}</ul>` : '<p class="bk-note">No tables yet. Add the first table.</p>'}
    </section>`;
  }

  function configCombosMarkup() {
    const list = Array.isArray(state.config?.combinations) ? state.config.combinations : [];
    const tableLabel = (id) => (state.config?.tables || []).find((table) => table.id === id)?.label || id;
    const rows = list.map((combo) => `<li class="atlas-row bk-cfg-row" data-bookings-combo-row="${escapeHtml(combo.id)}">
      <div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(combo.name)}</p><p class="atlas-row__meta">${escapeHtml((combo.member_table_ids || []).map(tableLabel).join(' + '))} · ${escapeHtml(String(combo.combined_capacity || 0))} seats${combo.is_permitted === false ? ' · Not permitted' : ''}</p></div>
    </li>`).join('');
    return `<section class="bk-cfg-section" aria-labelledby="bk-cfg-combos">
      <div class="bk-cfg-head"><h2 class="bk-cfg-title" id="bk-cfg-combos">Permitted combinations</h2><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-bookings-add-combo>${icon('plus')}Add combination</button></div>
      ${rows ? `<ul class="atlas-list bk-cfg-list">${rows}</ul>` : '<p class="bk-note">No combinations. Only listed combinations can be auto-assigned.</p>'}
    </section>`;
  }

  function configSettingsMarkup() {
    const settings = state.config?.settings || {};
    const number = (name, value, min, max, step = 1) => `<input class="atlas-input" type="number" id="bk-set-${name}" name="${name}" value="${escapeHtml(String(value ?? ''))}" min="${min}" max="${max}" step="${step}" inputmode="numeric">`;
    return `<section class="bk-cfg-section" aria-labelledby="bk-cfg-rules">
      <div class="bk-cfg-head"><h2 class="bk-cfg-title" id="bk-cfg-rules">Availability rules</h2></div>
      <form class="atlas-form bk-settings" id="bk-settings-form" data-bookings-settings-form novalidate>
        <div class="atlas-grid-2">
          <div class="atlas-field"><label for="bk-set-slot_interval_minutes">Slot interval (min)</label>${number('slot_interval_minutes', settings.slot_interval_minutes, 5, 240, 5)}</div>
          <div class="atlas-field"><label for="bk-set-default_duration_minutes">Default duration (min)</label>${number('default_duration_minutes', settings.default_duration_minutes, 15, 600, 5)}</div>
          <div class="atlas-field"><label for="bk-set-turnaround_minutes">Turnaround (min)</label>${number('turnaround_minutes', settings.turnaround_minutes, 0, 240, 5)}</div>
          <div class="atlas-field"><label for="bk-set-approval_party_threshold">Approval threshold (party)</label>${number('approval_party_threshold', settings.approval_party_threshold, 1, 500)}</div>
          <div class="atlas-field"><label for="bk-set-advance_days">Advance booking (days)</label>${number('advance_days', settings.advance_days, 1, 730)}</div>
          <div class="atlas-field"><label for="bk-set-last_start_offset_minutes">Last start before close (min)</label>${number('last_start_offset_minutes', settings.last_start_offset_minutes, 0, 360, 5)}</div>
          <div class="atlas-field"><label for="bk-set-max_party_online">Max party online</label>${number('max_party_online', settings.max_party_online, 1, 500)}</div>
        </div>
        <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="bk-set-auto-label">Auto-confirm website bookings</p><p class="atlas-toggle-row__help">Keep this off for VÁ: website requests wait for staff approval. Staff-created phone and walk-in bookings can confirm when saved.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${settings.auto_confirm ? 'true' : 'false'}" aria-labelledby="bk-set-auto-label" data-bookings-auto-confirm></button></div>
        <input type="hidden" name="expected_version" value="${escapeHtml(String(settings.version ?? ''))}">
        <div class="bk-settings__foot"><button type="submit" class="atlas-btn atlas-btn--primary" data-bookings-settings-save>Save rules</button></div>
      </form>
    </section>`;
  }

  function configMarkup() {
    if (!state.config && !state.error) {
      return `<div class="bk"><header class="page-head"><div class="page-head__text"><a class="bk-crumb" href="#bookings">${icon('chevron-left')}Bookings</a><h1 class="page-head__title">Configuration</h1></div></header><div class="bk-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(5)}<span class="sr-only">Loading configuration</span></div></div>`;
    }
    return `<div class="bk bk-config" data-bookings-config>
      <header class="page-head"><div class="page-head__text"><a class="bk-crumb" href="#bookings">${icon('chevron-left')}Bookings</a><h1 class="page-head__title">Configuration</h1><p class="page-head__sub">Areas, tables, combinations and booking rules</p></div></header>
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

  function loadSnapshot(options = {}) {
    if (state.snapshotPromise && !options.force) return state.snapshotPromise;
    state.loading = true;
    if (!options.silent) state.error = null;
    if (!options.silent) paint();
    state.snapshotPromise = (async () => {
      try {
        const payload = await api('snapshot', { params: { date: state.date } });
        state.snapshot = payload || null;
        state.permissions = payload?.permissions || state.permissions;
        state.actorRole = payload?.actor_role || state.actorRole;
        state.error = null;
        state.failedAt = 0;
      } catch (error) {
        if (!options.silent || !state.snapshot) state.error = shown(error, 'Bookings couldn’t be loaded. Check the connection and try again.');
        state.failedAt = Date.now();
      } finally {
        state.loading = false;
        state.snapshotPromise = null;
        paint();
      }
    })();
    return state.snapshotPromise;
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
    const needSnapshot = !state.snapshot && (!state.failedAt || Date.now() - state.failedAt > 20000);
    const ensure = needSnapshot ? loadSnapshot() : Promise.resolve();
    if (state.section === 'config') {
      ensure.then(() => { if (state.visible && state.section === 'config' && canConfigure() && !state.config) loadConfig(); });
    }
    if (!params.section) window.scrollTo?.(0, 0);
  }

  function onHide() {
    state.visible = false;
  }

  // ---------- navigation ----------

  function go(section) {
    window.AtlasShell?.show?.('bookings', section ? { section } : {}, { source: 'route', route: section ? `#bookings/${section}` : '#bookings' });
  }

  // ---------- events ----------

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    if (target.closest('[data-bookings-refresh]')) { state.failedAt = 0; if (state.section === 'config') loadConfig({ force: true }); else loadSnapshot({ force: true }); return; }
    if (target.closest('[data-bookings-add]')) { openAddBooking(); return; }

    const viewBtn = target.closest('[data-bookings-view]');
    if (viewBtn) { setMode(viewBtn.dataset.bookingsView); return; }

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

    // A table or a list row: open the reservation, else offer to add here.
    const tableTrigger = target.closest('[data-bookings-table]');
    if (tableTrigger) {
      const reservationId = tableTrigger.dataset.bookingsReservation;
      if (reservationId) openReservation(reservationId);
      else if (canManageReservations()) openAddBooking({ tableId: tableTrigger.dataset.bookingsTable, date: state.date });
      return;
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !host()?.contains(target)) return;
    if (target.matches('[data-bookings-date]')) {
      const value = target.value;
      if (DATE_RE.test(value)) { state.date = value; loadSnapshot({ force: true }); }
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
    document.addEventListener('change', handleChange);
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
