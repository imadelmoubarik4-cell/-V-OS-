// Deterministic backends for the People pages (Messages, Shifts, Team,
// Knowledge) shaped like the atlas-team-messages, atlas-shifts,
// atlas-team-profiles and atlas-knowledge payloads. Test data only.
import { USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

export const NOW = '2026-09-24T14:30:00.000Z'; // Thursday, 14:30 in Reykjavik
export const WEEK = '2026-09-21';

const minutesAgo = (minutes) => new Date(Date.parse(NOW) - minutes * 60000).toISOString();

// ---------- Messages ----------

export const MEMBERS = [
  { id: USERS.admin.id, label: USERS.admin.display_name, role: 'admin' },
  { id: USERS.bartender.id, label: USERS.bartender.display_name, role: 'bartender' },
  { id: 'c0ffee00-0000-4000-8000-000000000003', label: 'gunnar.karlsson@example.test', role: 'bartender' }
];

function channel(key, name, description, extra = {}) {
  return { id: `ch-${key}`, key, name, description, icon: 'hash', tone: 'neutral', manager_post_only: key === 'announcements', can_post: true, unread_count: 0, last_read_at: null, last_message: null, starred: false, ...extra };
}

export function messagesBackend({ user = USERS.admin, empty = false, status = 200, sendStatus = 200 } = {}) {
  const manager = ['admin', 'manager'].includes(user.role);
  const channels = [
    channel('general', 'General', 'Everyday team communication and shared updates.'),
    channel('operations', 'Operations', 'Cleaning, inventory, maintenance and service operations.'),
    channel('shift-handover', 'Shift handover', 'What the next shift needs to know before taking over.'),
    channel('announcements', 'Announcements', 'Official management notices for the whole active team.', { can_post: manager }),
    channel('marketing', 'Marketing', 'Content ideas, campaigns, events and social-media coordination.')
  ];
  const threads = { general: [], operations: [], 'shift-handover': [], announcements: [], marketing: [] };
  if (!empty) {
    threads.general.push(
      { id: 'm1', sender_id: USERS.bartender.id, sender_label: 'sara.bartender@example.test', sender_role: 'bartender', body: 'Keg of Einstök changed, spare in the walk-in.', message_type: 'user', created_at: minutesAgo(26 * 60), read_by: [], read_by_count: 0 },
      { id: 'm2', sender_id: USERS.admin.id, sender_label: 'Imad', sender_role: 'admin', body: 'Thanks — the Globus order is in.', message_type: 'user', created_at: minutesAgo(90), read_by: [{ user_id: USERS.bartender.id, user_label: 'Sara' }], read_by_count: 1, link: { type: 'inventory_item', key: 'campari', label: 'Campari', route: 'inventory', metadata: {} } },
      { id: 'm3', sender_id: MEMBERS[2].id, sender_label: 'gunnar.karlsson@example.test', sender_role: 'bartender', body: 'Ice machine is making noise again.', message_type: 'user', created_at: minutesAgo(40), read_by: [], read_by_count: 0 },
      { id: 'm4', sender_id: MEMBERS[2].id, sender_label: 'gunnar.karlsson@example.test', sender_role: 'bartender', body: 'I put a note on it.', message_type: 'user', created_at: minutesAgo(38), read_by: [], read_by_count: 0 }
    );
    threads.announcements.push(
      { id: 'a1', sender_id: null, sender_label: 'Atlas', sender_role: null, body: 'Knowledge article published\nClosing the bar · Version 2\nRequired reading for assigned staff.', message_type: 'system', created_at: minutesAgo(300), link: { type: 'knowledge_article', key: 'k-closing', label: 'Closing the bar', route: 'knowledge', metadata: {} } },
      { id: 'a2', sender_id: USERS.admin.id, sender_label: 'Imad', sender_role: 'admin', body: 'Recommendation to review before Friday.', message_type: 'user', created_at: minutesAgo(200), link: { type: 'brain_recommendation', key: 'r1', label: 'Renegotiate the Globus contract', route: 'brain', metadata: {} } }
    );
    const general = channels[0];
    general.unread_count = 2;
    general.last_read_at = minutesAgo(60);
  }
  const backend = { calls: [], sent: [], threads, channels, status, sendStatus };
  const snapshot = (key) => {
    channels.forEach((entry) => {
      const list = threads[entry.key];
      const last = list[list.length - 1];
      entry.last_message = last ? { id: last.id, sender_label: last.sender_label, body: last.body.slice(0, 140), message_type: last.message_type, created_at: last.created_at, deleted: Boolean(last.deleted) } : null;
    });
    const selected = channels.find((entry) => entry.key === key) || channels[0];
    return {
      snapshot: {
        channels: channels.map((entry) => ({ ...entry })),
        messages: threads[selected.key].map((message) => ({ ...message, is_own: message.sender_id === user.id, can_edit: message.sender_id === user.id, can_delete: message.sender_id === user.id || manager })),
        selected_channel_key: selected.key,
        summary: { total_unread: channels.reduce((sum, entry) => sum + entry.unread_count, 0), active_members: MEMBERS.length }
      },
      members: MEMBERS,
      staff: { id: user.id, label: user.display_name, role: user.role, can_post: user.role !== 'viewer', can_announce: manager, can_link_brain_recommendations: manager }
    };
  };
  backend.handler = async (entry) => {
    backend.calls.push(entry);
    if (backend.status !== 200) return { __status: backend.status, body: { error: 'The team-message service is temporarily unavailable.' } };
    const params = new URLSearchParams(entry.search);
    if (entry.method === 'GET' && entry.action === 'snapshot') return snapshot(params.get('channel') || 'general');
    if (entry.method === 'GET' && entry.action === 'targets') {
      const type = params.get('type');
      if (type === 'brain_recommendation' && !manager) return { __status: 403, body: { error: 'Atlas recommendations can only be linked by managers and administrators.' } };
      const all = { inventory_item: [{ type, key: 'campari', label: 'Campari', description: 'Liqueurs · bottles' }, { type, key: 'gin', label: 'Gin', description: 'Gin · bottles' }], routine: [], shift: [], brain_recommendation: [{ type, key: 'r1', label: 'Renegotiate the Globus contract', description: 'purchase · active' }] }[type] || [];
      const q = (params.get('q') || '').toLowerCase();
      return { targets: all.filter((target) => !q || target.label.toLowerCase().includes(q)), type };
    }
    const body = entry.body || {};
    const key = body.channel_key || 'general';
    if (entry.action === 'mark-read') {
      const target = channels.find((item) => item.key === key);
      if (target) { target.unread_count = 0; target.last_read_at = NOW; }
      return snapshot(key);
    }
    if (entry.action === 'star') {
      const target = channels.find((item) => item.key === key);
      if (target) target.starred = Boolean(body.starred);
      return snapshot(key);
    }
    if (entry.action === 'send') {
      if (backend.sendStatus !== 200) return { __status: backend.sendStatus, body: { error: 'The team-message service is temporarily unavailable.' } };
      backend.sent.push(body);
      threads[key].push({ id: `sent-${backend.sent.length}`, sender_id: user.id, sender_label: user.display_name, sender_role: user.role, body: body.body, message_type: 'user', created_at: NOW, read_by: [], read_by_count: 0, link: body.link_type && body.link_type !== 'none' ? { type: body.link_type, key: body.link_key, label: body.link_key === 'campari' ? 'Campari' : body.link_key, metadata: {} } : null });
      return snapshot(key);
    }
    if (entry.action === 'delete') {
      const message = threads[key].find((item) => item.id === body.message_id);
      if (message) message.deleted = true;
      return snapshot(key);
    }
    if (entry.action === 'edit') {
      const message = threads[key].find((item) => item.id === body.message_id);
      if (message) { message.body = body.body; message.edited_at = NOW; }
      return snapshot(key);
    }
    return snapshot(key);
  };
  return backend;
}

export function peopleFunctions(overrides = {}) {
  return { ...emptyFunctions(), 'atlas-team-profile-photos': { photos: [], staff: { id: USERS.admin.id, can_manage_team: true } }, ...overrides };
}

// ---------- Venue clock (atlas-settings?action=venue-clock) ----------

export function clockBackend({ open = true, status = 200 } = {}) {
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hours = open ? labels.map((day_label, weekday) => ({
    weekday, day_label, is_open: weekday !== 1,
    open_time: weekday !== 1 ? '16:00:00' : null, close_time: weekday !== 1 ? (weekday >= 5 ? '03:00:00' : '01:00:00') : null, close_next_day: weekday !== 1,
    kitchen_close_time: null, kitchen_close_next_day: false, last_order_time: null, last_order_next_day: false, updated_at: NOW
  })) : [];
  const backend = { calls: [] };
  backend.handler = async (entry) => {
    backend.calls.push(entry);
    if (entry.method === 'GET' && entry.action === 'venue-clock') {
      if (status !== 200) return { __status: status, body: { error: 'Unavailable' } };
      return { clock: { timezone: 'Atlantic/Reykjavik', timezone_source: 'settings', hours_configured: hours.length === 7, business_hours: hours, offers: [], venue_date: null, business_date: null, venue_local_time: null, generated_at: NOW }, staff: { id: entry.user.id, role: entry.user.role, active: true, can_manage_hours: ['admin', 'manager'].includes(entry.user.role) } };
    }
    return {};
  };
  return backend;
}

// ---------- Shifts ----------

export const PEOPLE = [
  { id: 'p-imad', profile_id: USERS.admin.id, display_name: 'Imad El Moubarik', default_role: 'Manager', active: true, login_enabled: true },
  { id: 'p-sara', profile_id: USERS.bartender.id, display_name: 'Sara Jónsdóttir', default_role: 'Bartender', active: true, login_enabled: true },
  { id: 'p-gunnar', profile_id: 'c0ffee00-0000-4000-8000-000000000003', display_name: 'Gunnar Karlsson', default_role: 'Bartender', active: true, login_enabled: true },
  { id: 'p-jon', profile_id: null, display_name: 'Jón Gunnarsson', default_role: 'Barback', active: true, login_enabled: false }
];

function addDaysKey(key, n) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

// Reykjavik is UTC+0 all year, so local wall time equals UTC here.
function shiftRow(id, personId, day, start, end, extra = {}) {
  const date = addDaysKey(WEEK, day);
  const endDate = end <= start ? addDaysKey(date, 1) : date;
  const person = PEOPLE.find((entry) => entry.id === personId);
  return {
    id, week_start: WEEK, person_id: personId, person_name: person.display_name, profile_id: person.profile_id, login_enabled: person.login_enabled,
    role_name: extra.role || person.default_role, starts_at: `${date}T${start}:00Z`, ends_at: `${endDate}T${end}:00Z`,
    starts_local: `${date}T${start}:00`, ends_local: `${endDate}T${end}:00`, break_minutes: extra.breakMinutes || 0, note: extra.note || null,
    active: true, updated_at: extra.updated || '2026-09-20T10:00:00Z', last_published_revision: extra.unpublished ? null : 2
  };
}

export function shiftsBackend({ user = USERS.admin, empty = false, status = 200, published = true } = {}) {
  const manager = ['admin', 'manager'].includes(user.role);
  const own = PEOPLE.find((person) => person.profile_id === user.id);
  const backend = { calls: [], saved: [], status };
  backend.shifts = empty ? [] : [
    shiftRow('s1', 'p-sara', 0, '16:00', '00:00'),
    shiftRow('s2', 'p-gunnar', 1, '18:00', '01:00'),
    shiftRow('s3', 'p-sara', 2, '16:00', '00:00'),
    shiftRow('s4', 'p-sara', 3, '16:00', '00:00', { note: 'Quiz night' }),
    shiftRow('s5', 'p-gunnar', 3, '18:00', '01:30'),
    shiftRow('s6', 'p-imad', 3, '17:00', '23:00', { role: 'Manager' }),
    shiftRow('s7', 'p-sara', 4, '18:00', '02:00'),
    shiftRow('s8', 'p-gunnar', 4, '18:00', '02:00', { unpublished: true, updated: '2026-09-23T10:00:00Z' }),
    shiftRow('s9', 'p-jon', 5, '18:00', '02:00'),
    shiftRow('s10', 'p-gunnar', 5, '18:00', '03:00')
  ];
  backend.responses = empty ? [] : [
    { shift_id: 's1', person_id: 'p-sara', response: 'confirmed', note: null, manager_status: manager ? 'none' : null },
    { shift_id: 's3', person_id: 'p-sara', response: 'confirmed', note: null, manager_status: manager ? 'none' : null },
    { shift_id: 's4', person_id: 'p-sara', response: 'pending', note: null, manager_status: manager ? 'none' : null },
    { shift_id: 's7', person_id: 'p-sara', response: 'pending', note: null, manager_status: manager ? 'none' : null },
    { shift_id: 's5', person_id: 'p-gunnar', response: 'change_requested', note: 'Can I start at 19:00?', manager_status: manager ? 'open' : null }
  ];
  backend.timeOff = [
    { id: 't1', person_id: 'p-gunnar', person_name: 'Gunnar Karlsson', starts_on: '2026-10-02', ends_on: '2026-10-04', request_type: 'vacation', status: 'pending', note: 'Family visit', created_at: '2026-09-22T09:00:00Z' },
    { id: 't2', person_id: 'p-sara', person_name: 'Sara Jónsdóttir', starts_on: '2026-09-28', ends_on: '2026-09-28', request_type: 'unavailable', status: 'approved', note: null, created_at: '2026-09-18T09:00:00Z' }
  ].filter((request) => manager || request.person_id === own?.id);
  backend.availability = [
    { id: 'av1', person_id: 'p-sara', weekday: 1, unavailable: true, available_from: null, available_to: null, note: 'School' },
    { id: 'av2', person_id: 'p-sara', weekday: 5, unavailable: false, available_from: '17:00:00', available_to: null, note: null }
  ].filter((row) => manager || row.person_id === own?.id);
  const pendingChanges = () => manager && backend.shifts.some((entry) => entry.last_published_revision == null);
  const week = (weekStart) => ({ week_start: weekStart, status: published ? 'published' : 'draft', revision: published ? 2 : 0, has_unpublished_changes: pendingChanges(), published_at: published ? '2026-09-20T12:00:00Z' : null, published_by_label: 'Imad', latest_publication: published ? { revision: 2, shift_count: 9, published_at: '2026-09-20T12:00:00Z' } : null });
  const visibleShifts = (list) => (manager ? list : published ? list.filter((entry) => entry.last_published_revision != null) : []);
  const permissions = { can_manage_schedule: manager, can_add_people: manager, can_publish_week: manager, can_manage_all_availability: manager, can_decide_time_off: manager, can_respond_to_shifts: Boolean(own), can_publish_month: manager };
  const staff = { id: user.id, role: user.role, can_manage_schedule: manager };
  const events = manager ? [{ id: 'e1', event_type: 'week_published', actor_label: 'Imad El Moubarik', created_at: '2026-09-20T12:00:00Z' }, { id: 'e2', event_type: 'shift_saved', actor_label: 'Imad El Moubarik', created_at: '2026-09-23T10:00:00Z' }] : [];
  const inWeek = (weekStart) => (entry) => entry.week_start === weekStart;
  const weekWorkspace = (weekStart) => ({
    workspace: { week: week(weekStart), people: PEOPLE, shifts: visibleShifts(backend.shifts.filter(inWeek(weekStart))), availability: backend.availability, time_off: backend.timeOff, responses: backend.responses.filter((row) => (manager || row.person_id === own?.id) && backend.shifts.some((item) => item.id === row.shift_id && item.week_start === weekStart)), events, actor_person_id: own?.id || null, permissions },
    staff, policy: {}
  });
  const monthWorkspace = (monthStart) => ({
    workspace: { month: { month_start: monthStart, status: published ? 'published' : 'draft', revision: 1, has_unpublished_changes: pendingChanges() }, people: PEOPLE, shifts: visibleShifts(backend.shifts.filter((entry) => entry.starts_local.slice(0, 7) === monthStart.slice(0, 7))), availability: backend.availability, time_off: backend.timeOff, responses: backend.responses.filter((row) => manager || row.person_id === own?.id), weeks: [{ week_start: WEEK, status: 'published', revision: 2, has_unpublished_changes: pendingChanges() }], events, actor_person_id: own?.id || null, permissions },
    staff, policy: {}
  });
  backend.handler = async (entry) => {
    backend.calls.push(entry);
    if (backend.status !== 200) return { __status: backend.status, body: { error: 'The Shifts service is temporarily unavailable.' } };
    const params = new URLSearchParams(entry.search);
    if (entry.method === 'GET' && entry.action === 'snapshot') return weekWorkspace(params.get('week_start'));
    if (entry.method === 'GET' && entry.action === 'month-snapshot') return monthWorkspace(params.get('month_start'));
    const body = entry.body || {};
    if (entry.action === 'save-shift') {
      backend.saved.push(body);
      const person = PEOPLE.find((item) => item.id === body.person_id);
      const saved = { id: body.shift_id || `new-${backend.saved.length}`, week_start: body.week_start, person_id: body.person_id, person_name: person?.display_name, profile_id: person?.profile_id, role_name: body.role_name, starts_local: `${body.starts_local.slice(0, 16)}:00`, ends_local: `${body.ends_local.slice(0, 16)}:00`, starts_at: `${body.starts_local.slice(0, 16)}:00Z`, ends_at: `${body.ends_local.slice(0, 16)}:00Z`, break_minutes: body.break_minutes, note: body.note, last_published_revision: null, updated_at: NOW, active: true };
      const index = backend.shifts.findIndex((item) => item.id === saved.id);
      if (index >= 0) backend.shifts[index] = { ...backend.shifts[index], ...saved };
      else backend.shifts.push(saved);
    }
    if (entry.action === 'cancel-shift') backend.shifts = backend.shifts.filter((item) => item.id !== body.shift_id);
    if (entry.action === 'publish-week' || entry.action === 'publish-month') backend.shifts.forEach((item) => { item.last_published_revision = 3; });
    if (entry.action === 'copy-week') {
      backend.shifts.filter(inWeek(body.source_week)).forEach((item, index) => backend.shifts.push({ ...item, id: `copy-${index}`, week_start: body.target_week, last_published_revision: null }));
    }
    if (entry.action === 'respond') {
      const row = backend.responses.find((item) => item.shift_id === body.shift_id);
      if (row) { row.response = body.response; row.note = body.note; }
    }
    if (entry.action === 'request-time-off') backend.timeOff.push({ id: `t${backend.timeOff.length + 1}`, person_id: body.person_id, person_name: PEOPLE.find((item) => item.id === body.person_id)?.display_name, starts_on: body.starts_on, ends_on: body.ends_on, request_type: body.request_type, status: manager ? 'approved' : 'pending', note: body.note, created_at: NOW });
    if (entry.action === 'decide-time-off') { const row = backend.timeOff.find((item) => item.id === body.request_id); if (row) { row.status = body.status; row.manager_note = body.manager_note; } }
    if (entry.action === 'decide-response') { const row = backend.responses.find((item) => item.shift_id === body.shift_id); if (row) { row.manager_status = body.manager_status; row.manager_note = body.manager_note; } }
    if (entry.action === 'save-availability') {
      const row = backend.availability.find((item) => item.person_id === body.person_id && item.weekday === body.weekday);
      const next = { id: row?.id || `av${backend.availability.length + 1}`, person_id: body.person_id, weekday: body.weekday, unavailable: body.unavailable, available_from: body.available_from, available_to: body.available_to, note: body.note };
      if (row) Object.assign(row, next); else backend.availability.push(next);
    }
    if (body.current_month) return { result: { ok: true }, ...monthWorkspace(body.current_month) };
    return { result: { ok: true }, ...weekWorkspace(body.week_start || body.target_week || body.current_week || WEEK) };
  };
  return backend;
}

// ---------- Team (atlas-team-profiles) ----------

const TASKS = [
  { id: 'task-1', title: 'Bar tour', description: 'Walk through stations and storage.', category: 'Service', required: true },
  { id: 'task-2', title: 'Closing procedure', description: 'Close the bar with a manager.', category: 'Operations', required: true },
  { id: 'task-3', title: 'Allergen training', description: 'Read and sign the allergen sheet.', category: 'Health & safety', required: true }
];

function training(done, visible) {
  if (!visible) return { private: true };
  const tasks = TASKS.map((task, index) => ({ ...task, completed: index < done, completed_at: index < done ? '2026-09-10T12:00:00Z' : null }));
  return { private: false, total_required: 3, completed_required: done, percent: Math.round((done / 3) * 100), complete: done === 3, tasks };
}

export function teamBackend({ user = USERS.admin, status = 200, empty = false } = {}) {
  const manager = ['admin', 'manager'].includes(user.role);
  const sees = (id) => manager || id === user.id;
  const backend = { calls: [], status };
  const base = [
    { id: USERS.admin.id, name: 'Imad El Moubarik', display_name: 'Imad El Moubarik', email: 'owner@example.test', role: 'admin', active: true, job_title: 'Owner', department: 'management', employment_type: 'owner', start_date: '2024-05-01', phone: '+354 555 0101', phone_visibility: 'team', preferred_language: 'English', done: 3, contacts: [{ id: 'ec1', contact_name: 'Lina El Moubarik', relationship: 'Partner', phone: '+354 555 0199', priority: 1, note: null }] },
    { id: USERS.bartender.id, name: 'Sara Jónsdóttir', display_name: 'Sara Jónsdóttir', email: 'sara.bartender@example.test', role: 'bartender', active: true, job_title: 'Bartender', department: 'bar', employment_type: 'part_time', start_date: '2025-02-01', phone: '+354 555 0102', phone_visibility: 'managers_only', preferred_language: 'Icelandic', done: 2, contacts: [] },
    { id: 'c0ffee00-0000-4000-8000-000000000003', name: 'Gunnar Karlsson', display_name: 'Gunnar Karlsson', email: 'gunnar.karlsson@example.test', role: 'bartender', active: true, job_title: 'Bartender', department: 'bar', employment_type: 'full_time', start_date: '2025-06-15', phone: null, phone_visibility: 'managers_only', preferred_language: null, done: 3, contacts: [{ id: 'ec2', contact_name: 'Anna Karlsdóttir', relationship: 'Mother', phone: '+354 555 0177', priority: 1, note: null }] },
    { id: 'c0ffee00-0000-4000-8000-000000000004', name: 'Ása Helgadóttir', display_name: 'Ása Helgadóttir', email: 'asa@example.test', role: 'viewer', active: false, job_title: 'Former barback', department: 'bar', employment_type: 'temporary', start_date: '2024-01-10', phone: null, phone_visibility: 'managers_only', preferred_language: null, done: 1, contacts: [] }
  ];
  const profile = (row) => {
    const sensitive = sees(row.id);
    return {
      id: row.id, name: row.name, display_name: row.display_name, preferred_name: row.display_name, email: manager || row.id === user.id ? row.email : null, role: row.role, active: row.active,
      job_title: row.job_title, department: row.department, employment_type: sensitive ? row.employment_type : null, start_date: sensitive ? row.start_date : null,
      phone: sensitive || row.phone_visibility === 'team' ? row.phone : null, phone_visibility: row.phone_visibility, preferred_language: row.preferred_language,
      can_view_sensitive: sensitive, can_edit_profile: sensitive, can_manage_access: manager && row.id !== user.id, can_manage_training: manager,
      emergency_contacts: sensitive ? row.contacts : [], emergency_contact_count: sensitive ? row.contacts.length : 0,
      training: training(row.done, sensitive), profile_completion_percent: sensitive ? (row.contacts.length ? 100 : 75) : null,
      manager_notes: manager && row.id === USERS.bartender.id ? 'Prefers weekend shifts.' : null
    };
  };
  const snapshot = () => {
    const rows = empty ? [] : base.filter((row) => manager || row.active);
    return {
      workspace: {
        profiles: rows.map(profile),
        summary: { active_profiles: rows.filter((row) => row.active).length, managers: rows.filter((row) => ['admin', 'manager'].includes(row.role)).length, training_complete: manager ? rows.filter((row) => row.done === 3).length : null, emergency_contacts_complete: manager ? rows.filter((row) => row.contacts.length).length : null },
        events: manager ? [{ id: 'ev1', profile_id: USERS.bartender.id, event_type: 'profile_details_updated', actor_label: 'Imad El Moubarik', created_at: '2026-09-22T10:00:00Z' }] : []
      },
      staff: { id: user.id, role: user.role, can_manage_team: manager, can_edit_self: true, live_training_writes_enabled: true, live_profile_writes_enabled: true, account_invitations_enabled: true },
      policy: {}
    };
  };
  backend.handler = async (entry) => {
    backend.calls.push(entry);
    if (backend.status !== 200) return { __status: backend.status, body: { error: 'Team Profiles are temporarily unavailable.' } };
    const body = entry.body || {};
    if (entry.method === 'POST') {
      const row = base.find((item) => item.id === body.profile_id);
      if (entry.action === 'save-emergency-contact' && row) row.contacts = [...row.contacts.filter((c) => c.id !== body.contact_id), { id: body.contact_id || `ec-new-${row.contacts.length + 1}`, contact_name: body.contact_name, relationship: body.relationship, phone: body.phone, priority: body.priority, note: body.note }];
      if (entry.action === 'remove-emergency-contact' && row) row.contacts = row.contacts.filter((c) => c.id !== body.contact_id);
      if (entry.action === 'update-access' && row) { row.role = body.role; row.active = body.active; }
      if (entry.action === 'save-details' && row) { row.phone = body.phone || null; row.job_title = body.job_title ?? row.job_title; row.display_name = body.preferred_name || row.display_name; row.name = row.display_name; }
      if (entry.action === 'update-onboarding' && row) row.done = Math.max(0, Math.min(3, row.done + (body.completed ? 1 : -1)));
      if (entry.action === 'create-login-member') return { result: { id: 'new-member', email: body.email, invitation_token: 'tok_example' }, ...snapshot() };
      if (entry.action === 'renew-member-setup') return { result: { id: body.profile_id, email: row?.email, invitation_token: 'tok_renewed' }, ...snapshot() };
    }
    return snapshot();
  };
  return backend;
}

export function teamFunctions({ user = USERS.admin, status = 200, empty = false } = {}) {
  return {
    'atlas-team-profiles': teamBackend({ user, status, empty }).handler,
    'atlas-shifts': shiftsBackend({ user }).handler,
    'atlas-settings': clockBackend().handler
  };
}

// ---------- Knowledge (atlas-knowledge) ----------

export function knowledgeBackend({ user = USERS.admin, status = 200, empty = false, searchStatus = 200 } = {}) {
  const manager = ['admin', 'manager'].includes(user.role);
  const backend = { calls: [], status };
  const categories = [
    { id: 'cat-service', key: 'service', name: 'Service', icon: 'glass-water', article_count: 2 },
    { id: 'cat-open', key: 'opening-closing', name: 'Opening & closing', icon: 'door-open', article_count: 1 },
    { id: 'cat-safety', key: 'health-safety', name: 'Health & safety', icon: 'shield-check', article_count: 1 }
  ];
  const articles = empty ? [] : [
    { id: 'k-closing', article_key: 'closing-the-bar', title: 'Closing the bar', summary: 'Step by step close, cash-up and handover.', category_key: 'opening-closing', category_name: 'Opening & closing', category_id: 'cat-open', article_type: 'sop', status: 'published', required: true, required_due: user.role !== 'admin', acknowledged: user.role === 'admin', target_roles: ['all'], published_version_number: 2, updated_at: '2026-09-22T10:00:00Z', published_at: '2026-09-22T10:00:00Z', source_count: 1 },
    { id: 'k-complaint', article_key: 'guest-complaint', title: 'Handling a complaint', summary: 'Listen, apologise, fix, follow up.', category_key: 'service', category_name: 'Service', category_id: 'cat-service', article_type: 'policy', status: 'published', required: false, target_roles: ['all'], published_version_number: 1, updated_at: '2026-09-01T10:00:00Z', published_at: '2026-09-01T10:00:00Z', source_count: 0 },
    { id: 'k-allergens', article_key: 'allergens', title: 'Allergens at the bar', summary: 'Which drinks contain what, and how to answer.', category_key: 'health-safety', category_name: 'Health & safety', category_id: 'cat-safety', article_type: 'training', status: 'published', required: true, required_due: false, acknowledged: true, target_roles: ['all'], published_version_number: 3, updated_at: '2026-08-20T10:00:00Z', published_at: '2026-08-20T10:00:00Z', source_count: 2 },
    ...(manager ? [{ id: 'k-draft', article_key: 'wine-service', title: 'Wine service', summary: 'Draft: pouring and presenting wine.', category_key: 'service', category_name: 'Service', category_id: 'cat-service', article_type: 'sop', status: 'draft', draft_available: true, required: false, target_roles: ['bartender'], display_version_number: 1, updated_at: '2026-09-23T10:00:00Z', source_count: 0 }] : [])
  ];
  const detail = (id) => {
    const article = articles.find((item) => item.id === id);
    if (!article) return null;
    const draft = article.status === 'draft';
    return {
      article: { ...article },
      version: { id: `${id}-v`, state: draft ? 'draft' : 'published', version_number: article.published_version_number || 1, title: article.title, summary: article.summary, content: '# Before you start\n\nMake sure the **last orders** call was made.\n\n## Steps\n\n- [ ] Count the till\n- [ ] Wipe the bar\n- [ ] Lock the walk-in\n\n1. Turn off the taps\n2. Switch off the lights\n\n> Ask a manager if anything is unclear.', published_at: article.published_at, updated_at: article.updated_at, change_note: 'Updated the cash-up step' },
      sources: manager ? [{ id: 'src1', source_type: 'google_drive', source_label: 'Closing checklist (Drive)', source_reference: 'doc-1', source_url: 'https://drive.example/doc-1', source_version: 'rev 4', connection_status: 'manual_reference', visible_to_staff: true }] : [{ id: 'src1', source_type: 'google_drive', source_label: 'Closing checklist (Drive)', connection_status: 'manual_reference', visible_to_staff: true }],
      acknowledgements: manager ? [{ user_label: 'Gunnar Karlsson', user_role: 'bartender', acknowledged_at: '2026-09-23T12:00:00Z' }] : [],
      version_history: manager ? [{ version_number: 2, title: article.title, state: 'published', published_at: '2026-09-22T10:00:00Z', change_note: 'Updated the cash-up step' }, { version_number: 1, title: article.title, state: 'superseded', published_at: '2026-06-01T10:00:00Z' }] : [],
      task_links: [], read: false, can_acknowledge: Boolean(article.required && article.required_due)
    };
  };
  const snapshot = () => ({
    workspace: {
      categories, articles,
      summary: { published_articles: articles.filter((a) => a.status === 'published').length, required_due: articles.filter((a) => a.required_due).length, acknowledged: articles.filter((a) => a.acknowledged).length, source_references: 3 },
      training: { tasks: [{ id: 'task-1', title: 'Bar tour', description: 'Walk through stations and storage.', category: 'Service', required: true, completed: true, completed_at: '2026-09-10T12:00:00Z', linked_articles: [] }, { id: 'task-2', title: 'Closing procedure', description: 'Close the bar with a manager.', category: 'Operations', required: true, completed: false, linked_articles: [{ article_id: 'k-closing', title: 'Closing the bar' }] }], own_progress: { required_total: 2, required_completed: 1 }, team: manager ? [{ name: 'Sara Jónsdóttir', role: 'bartender', required_total: 2, required_completed: 1 }, { name: 'Gunnar Karlsson', role: 'bartender', required_total: 2, required_completed: 2 }] : [] },
      settings: { google_drive_connection_status: 'not_connected' },
      events: manager ? [{ event_type: 'version_published', actor_label: 'Imad El Moubarik', created_at: '2026-09-22T10:00:00Z' }, { event_type: 'article_acknowledged', actor_label: 'Gunnar Karlsson', created_at: '2026-09-23T12:00:00Z' }] : [],
      permissions: { can_manage_articles: manager }
    },
    staff: { id: user.id, role: user.role, can_manage_knowledge: manager },
    onboarding_tasks: [{ id: 'task-1', title: 'Bar tour', category: 'Service' }, { id: 'task-2', title: 'Closing procedure', category: 'Operations' }]
  });
  backend.handler = async (entry) => {
    backend.calls.push(entry);
    if (backend.status !== 200) return { __status: backend.status, body: { error: 'The Knowledge service is temporarily unavailable.' } };
    const params = new URLSearchParams(entry.search);
    if (entry.method === 'GET' && entry.action === 'snapshot') return snapshot();
    if (entry.method === 'GET' && entry.action === 'detail') {
      const found = detail(params.get('article_id'));
      return found ? { article: found, staff: snapshot().staff } : { __status: 404, body: { error: 'Knowledge article not found.' } };
    }
    if (entry.method === 'GET' && entry.action === 'search') {
      if (searchStatus !== 200) return { __status: searchStatus, body: { error: 'Search is unavailable.' } };
      const q = (params.get('q') || '').toLowerCase();
      const results = articles.filter((a) => (manager || a.status === 'published') && `${a.title} ${a.summary}`.toLowerCase().includes(q))
        .map((a) => ({ article_id: a.id, title: a.title, category: a.category_name, required: a.required, status: a.status, version_state: a.status === 'draft' ? 'draft' : 'published', snippet: `${a.title} — ${a.summary}`.replace(new RegExp(q, 'i'), (m) => `**${m}**`) }));
      return { results, count: results.length, query: params.get('q') };
    }
    const body = entry.body || {};
    if (entry.action === 'acknowledge') { const a = articles.find((item) => item.id === body.article_id); if (a) { a.required_due = false; a.acknowledged = true; } }
    if (entry.action === 'mark-read') return { result: { ok: true } };
    return { result: { ok: true }, ...snapshot(), detail: body.article_id ? detail(body.article_id) : null };
  };
  return backend;
}
