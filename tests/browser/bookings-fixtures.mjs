// Alcedo Bookings (S99) fixtures — a stateful mock of the atlas-bookings Edge
// Function, shaped like the ?action= HTTP contract the bookings-workspace.js
// frontend calls (handler.mjs is the source of truth). Modelled on
// training-fixtures.mjs / inventory-fixtures.mjs: bookingsBackend(...) returns
// { handler, calls } plus live state, so create/assign/set-status/save-* mutate
// what snapshot and config then return.
//
// The seeded room is a small VÁ-style test bar (area "Bar" with stools Bar 1..
// Bar 4 and a larger Long table, plus an "Ocean" area) — TEST DATA only; no
// production data is wired here.
import { emptyFunctions } from './fixtures.mjs';
import { USERS, fixtureTime } from './harness.mjs';

const MANAGER_ROLES = new Set(['admin', 'manager']);
const STAFF_ROLES = new Set(['admin', 'manager', 'bartender']);
export const TODAY = fixtureTime(0).slice(0, 10); // 2026-09-24 on the harness clock

function forbidden() {
  return { __status: 403, body: { error_code: 'forbidden', message: 'This isn’t available for your Alcedo role.' } };
}
function invalid() {
  return { __status: 400, body: { error_code: 'invalid_request', message: 'Some of the details weren’t valid.' } };
}
function notFound() {
  return { __status: 404, body: { error_code: 'not_found', message: 'That booking could not be found.' } };
}

// The default test room (VÁ-style bar). Test data only.
export function defaultRoom() {
  return {
    areas: [
      { id: 'area-bar', name: 'Bar', section_colour: 'teal', display_order: 1, is_active: true },
      { id: 'area-ocean', name: 'Ocean', section_colour: 'sage', display_order: 2, is_active: true }
    ],
    tables: [
      { id: 'tbl-bar-1', area_id: 'area-bar', label: 'Bar 1', seat_capacity: 2, min_party: 1, priority: 1, is_bookable: true, block_online: false, temporarily_unavailable: false, floor_x: 1, floor_y: 1, shape: 'round' },
      { id: 'tbl-bar-2', area_id: 'area-bar', label: 'Bar 2', seat_capacity: 2, min_party: 1, priority: 2, is_bookable: true, block_online: false, temporarily_unavailable: false, floor_x: 2, floor_y: 1, shape: 'round' },
      { id: 'tbl-bar-3', area_id: 'area-bar', label: 'Bar 3', seat_capacity: 2, min_party: 1, priority: 3, is_bookable: true, block_online: false, temporarily_unavailable: false, floor_x: 3, floor_y: 1, shape: 'round' },
      { id: 'tbl-bar-4', area_id: 'area-bar', label: 'Bar 4', seat_capacity: 2, min_party: 1, priority: 4, is_bookable: true, block_online: false, temporarily_unavailable: false, floor_x: 4, floor_y: 1, shape: 'round' },
      { id: 'tbl-long', area_id: 'area-bar', label: 'Long table', seat_capacity: 6, min_party: 2, priority: 5, is_bookable: true, block_online: false, temporarily_unavailable: false, floor_x: 1, floor_y: 2, shape: 'rect' },
      { id: 'tbl-ocean-1', area_id: 'area-ocean', label: 'Ocean 1', seat_capacity: 4, min_party: 1, priority: 1, is_bookable: true, block_online: false, temporarily_unavailable: false, floor_x: 1, floor_y: 3, shape: 'round' }
    ],
    combinations: [
      { id: 'combo-bar-12', name: 'Bar 1 + Bar 2', member_table_ids: ['tbl-bar-1', 'tbl-bar-2'], combined_capacity: 4, is_permitted: true }
    ],
    settings: {
      slot_interval_minutes: 15, default_duration_minutes: 120, duration_by_party: {}, turnaround_minutes: 15,
      last_start_offset_minutes: 60, advance_days: 60, max_party_online: 8, approval_party_threshold: 8,
      auto_confirm: true, hours: [], holiday_exceptions: [], version: 3
    },
    reservations: [
      { id: 'res-erla', source: 'phone', status: 'confirmed', start_at: `${TODAY}T19:00:00.000Z`, end_at: `${TODAY}T21:00:00.000Z`, party_size: 2, guest_name: 'Erla Guðrún', guest_phone: '+354 555 1000', guest_email: '', guest_requests: 'Window seat', staff_notes: '', booking_reference: 'ALC-1001', table_ids: ['tbl-bar-1'] },
      { id: 'res-bjorn', source: 'walk_in', status: 'seated', start_at: `${TODAY}T18:30:00.000Z`, end_at: `${TODAY}T20:30:00.000Z`, party_size: 2, guest_name: 'Björn', guest_phone: '', guest_email: '', guest_requests: '', staff_notes: '', booking_reference: 'ALC-1000', table_ids: ['tbl-bar-2'] }
    ]
  };
}

export function bookingsBackend({ room = defaultRoom() } = {}) {
  const areas = new Map(room.areas.map((a) => [a.id, { ...a }]));
  const tables = new Map(room.tables.map((t) => [t.id, { ...t }]));
  const combinations = new Map(room.combinations.map((c) => [c.id, { ...c }]));
  const settings = { ...room.settings };
  const reservations = new Map();
  const allocations = new Map(); // reservation_id -> [table_id]
  const holds = [];
  const calls = [];
  let seq = 0;
  let refSeq = 1002;
  const uid = (prefix) => `${prefix}-${String((seq += 1)).padStart(4, '0')}`;

  for (const r of room.reservations) {
    reservations.set(r.id, { ...r });
    allocations.set(r.id, [...(r.table_ids || [])]);
  }

  function tableLabel(id) {
    return tables.get(id)?.label || id;
  }

  function reservationView(id) {
    const r = reservations.get(id);
    if (!r) return null;
    const tableIds = allocations.get(id) || [];
    return {
      id: r.id, source: r.source, status: r.status, start_at: r.start_at, end_at: r.end_at || null,
      party_size: r.party_size, guest_name: r.guest_name || '', guest_phone: r.guest_phone || '',
      guest_email: r.guest_email || '', guest_requests: r.guest_requests || '', staff_notes: r.staff_notes || '',
      booking_reference: r.booking_reference || '', provider_ref: r.provider_ref || null,
      created_by_label: r.created_by_label || 'Team member', created_at: r.created_at || `${TODAY}T12:00:00.000Z`,
      updated_at: r.updated_at || `${TODAY}T12:00:00.000Z`,
      tables: tableIds.map((tid) => ({ table_id: tid, label: tableLabel(tid), combination_id: null }))
    };
  }

  function permissionsFor(user) {
    return { can_configure: MANAGER_ROLES.has(user?.role), can_manage_reservations: STAFF_ROLES.has(user?.role) };
  }

  function snapshot(user, date) {
    const day = date || TODAY;
    const dayReservations = [...reservations.keys()]
      .filter((id) => reservations.get(id).start_at.slice(0, 10) === day)
      .map(reservationView);
    return {
      date: day,
      areas: [...areas.values()],
      tables: [...tables.values()],
      reservations: dayReservations,
      holds: holds.filter((h) => h.start_at.slice(0, 10) === day),
      permissions: permissionsFor(user),
      actor_role: user?.role || null
    };
  }

  function configView() {
    return {
      areas: [...areas.values()],
      tables: [...tables.values()],
      combinations: [...combinations.values()],
      settings: { ...settings }
    };
  }

  function decideStatus(partySize, requested) {
    if (requested && ['requested', 'confirmed'].includes(requested)) return requested;
    if (!settings.auto_confirm) return 'requested';
    if (settings.approval_party_threshold && partySize >= settings.approval_party_threshold) return 'requested';
    return 'confirmed';
  }

  // ---- handler ----
  function handler(ctx) {
    const { method, action, body, user } = ctx;
    const params = new URLSearchParams(ctx.search || '');
    calls.push({ method, action, body, search: ctx.search });
    if (!STAFF_ROLES.has(user?.role)) return forbidden();

    if (method === 'GET' && (action === 'snapshot' || !action)) return snapshot(user, params.get('date'));
    if (method === 'GET' && action === 'config') {
      if (!MANAGER_ROLES.has(user?.role)) return forbidden();
      return configView();
    }
    if (method === 'GET' && action === 'availability') {
      const party = Number(params.get('party_size'));
      if (!Number.isInteger(party) || party < 1) return invalid();
      const from = params.get('from');
      const slots = [];
      const base = Date.parse(from || `${TODAY}T17:00:00.000Z`);
      for (let i = 0; i < 6; i += 1) slots.push(new Date(base + i * settings.slot_interval_minutes * 60000).toISOString());
      return { party_size: party, duration_minutes: settings.default_duration_minutes, slots };
    }

    if (method === 'POST' && action === 'create') {
      if (!STAFF_ROLES.has(user?.role)) return forbidden();
      const party = Number(body.party_size);
      if (!Number.isInteger(party) || party < 1 || !body.start_at) return invalid();
      const id = uid('res');
      const status = decideStatus(party, body.status);
      const start = body.start_at;
      const end = new Date(Date.parse(start) + settings.default_duration_minutes * 60000).toISOString();
      const reservation = {
        id, source: body.source === 'walk_in' ? 'walk_in' : 'phone', status, start_at: start, end_at: end,
        party_size: party, guest_name: body.guest_name || '', guest_phone: body.guest_phone || '',
        guest_email: body.guest_email || '', guest_requests: body.guest_requests || '', staff_notes: body.staff_notes || '',
        booking_reference: `ALC-${(refSeq += 1)}`, created_by_label: user?.display_name || 'Team member',
        created_at: fixtureTime(0), updated_at: fixtureTime(0)
      };
      reservations.set(id, reservation);
      allocations.set(id, Array.isArray(body.table_ids) ? [...body.table_ids] : []);
      return { reservation: reservationView(id), replayed: false };
    }

    if (method === 'POST' && action === 'assign') {
      if (!STAFF_ROLES.has(user?.role)) return forbidden();
      const id = body.reservation_id;
      if (!reservations.get(id)) return notFound();
      if (!Array.isArray(body.table_ids) || !body.table_ids.length) return invalid();
      allocations.set(id, [...body.table_ids]);
      reservations.get(id).updated_at = fixtureTime(0);
      return { reservation: reservationView(id) };
    }

    if (method === 'POST' && action === 'set-status') {
      if (!STAFF_ROLES.has(user?.role)) return forbidden();
      const id = body.reservation_id;
      const r = reservations.get(id);
      if (!r) return notFound();
      const to = String(body.to_status || '');
      const unchanged = r.status === to;
      r.status = to;
      r.updated_at = fixtureTime(0);
      return { reservation: reservationView(id), unchanged };
    }

    if (method === 'POST' && action === 'save-area') {
      if (!MANAGER_ROLES.has(user?.role)) return forbidden();
      const id = body.id || uid('area');
      const area = { id, name: body.name, section_colour: body.section_colour || 'teal', display_order: body.display_order ?? (areas.size + 1), is_active: body.is_active !== false };
      areas.set(id, area);
      return { area };
    }

    if (method === 'POST' && action === 'save-table') {
      if (!MANAGER_ROLES.has(user?.role)) return forbidden();
      const id = body.id || uid('tbl');
      const existing = tables.get(id) || {};
      const table = {
        id, area_id: body.area_id || existing.area_id, label: body.label,
        seat_capacity: body.seat_capacity ?? existing.seat_capacity ?? 1,
        min_party: body.min_party ?? existing.min_party ?? 0,
        priority: body.priority ?? existing.priority ?? 0,
        is_bookable: body.is_bookable ?? existing.is_bookable ?? true,
        block_online: Boolean(body.block_online),
        temporarily_unavailable: Boolean(body.temporarily_unavailable),
        unavailable_from: body.unavailable_from ?? null, unavailable_until: body.unavailable_until ?? null,
        floor_x: body.floor_x ?? existing.floor_x ?? 0, floor_y: body.floor_y ?? existing.floor_y ?? 0,
        shape: body.shape || existing.shape || 'round'
      };
      tables.set(id, table);
      return { table };
    }

    if (method === 'POST' && action === 'save-combination') {
      if (!MANAGER_ROLES.has(user?.role)) return forbidden();
      const id = body.id || uid('combo');
      const combo = { id, name: body.name, member_table_ids: Array.isArray(body.member_table_ids) ? body.member_table_ids : [], combined_capacity: body.combined_capacity || 0, is_permitted: body.is_permitted !== false };
      combinations.set(id, combo);
      return { combination: combo };
    }

    if (method === 'POST' && action === 'save-settings') {
      if (!MANAGER_ROLES.has(user?.role)) return forbidden();
      if (body.expected_version != null && Number(body.expected_version) !== settings.version) {
        return { __status: 409, body: { error_code: 'conflict', message: 'This changed while you were working.' } };
      }
      ['slot_interval_minutes', 'default_duration_minutes', 'turnaround_minutes', 'approval_party_threshold', 'advance_days', 'last_start_offset_minutes', 'max_party_online', 'auto_confirm'].forEach((key) => {
        if (body[key] !== undefined && body[key] !== null) settings[key] = body[key];
      });
      settings.version += 1;
      return { settings: { ...settings } };
    }

    if (method === 'POST' && action === 'hold') {
      const hold = { id: uid('hold'), table_id: body.table_id, start_at: body.start_at, end_at: body.end_at, reason: body.reason || null, expires_at: fixtureTime(600000) };
      holds.push(hold);
      return { hold };
    }
    if (method === 'POST' && action === 'release-hold') {
      const index = holds.findIndex((h) => h.id === body.hold_id);
      if (index >= 0) holds.splice(index, 1);
      return { ok: true };
    }

    return notFound();
  }

  return {
    handler,
    calls,
    areas, tables, combinations, settings, reservations, allocations, holds,
    reservation: (id) => reservations.get(id),
    reservationView,
    table: (id) => tables.get(id),
    snapshotFor: (user, date) => snapshot(user, date),
    configFor: () => configView(),
    callsFor: (action) => calls.filter((c) => c.action === action)
  };
}

/** Assembles fixtures for launchAtlas: the bookings backend on atlas-bookings. */
export function bookingsWorld({ room = defaultRoom(), functions = {}, tables = {}, rpc = {} } = {}) {
  const bookings = bookingsBackend({ room });
  return {
    bookings,
    fixtures: {
      tables: { ...tables },
      rpc: { ...rpc },
      functions: { ...emptyFunctions(), 'atlas-bookings': bookings.handler, ...functions }
    }
  };
}
