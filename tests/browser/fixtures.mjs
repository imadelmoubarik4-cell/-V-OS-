// Fixtures shaped like the production payloads read during the S87 audit.
import { USERS } from './harness.mjs';

const now = '2026-09-24T16:09:01.179Z';

function section(key, label, value, version = 1) {
  return { section_key: key, label, description: `${label} rules`, status: 'active', value, version, updated_at: now, can_edit: true };
}

export function settingsWorkspace(overrides = {}) {
  return {
    version: '0.1.1',
    trust: { environment: 'production' },
    permissions: { can_manage_organization: true, can_manage_security: true },
    sections: [
      section('venue', 'Venue', { business_name: 'VÁ Bar', legal_name: 'VÁ ehf.', timezone: 'Atlantic/Reykjavik', currency: 'ISK', primary_language: 'en' }, 2),
      section('operations', 'Operations', { week_starts_on: 1, default_break_minutes: 30, last_order_minutes_before_close: 30 }),
      section('inventory', 'Inventory', { automatic_reorder_suggestions: true, critical_stock_ratio: 0.25, variance_tolerance_percent: 5, waste_tolerance_percent: 3 }, 2),
      section('temperature', 'Temperature', { reminder_times: ['10:00'], escalation_minutes: 60, retention_months: 24 }),
      section('cleaning', 'Cleaning', { weekly_schedule: {}, overdue_escalation_minutes: 60 }),
      section('marketing', 'Marketing', { brand_voice: 'Warm', default_story_frames: 3 }),
      section('brain', 'Brain', { mode: 'assistant', explanation_level: 'brief', evidence_mode: 'strict', purchase_learning_enabled: true }, 2),
      section('security', 'Security', {}),
      section('appearance', 'Appearance', { theme: 'light' }, 2),
      section('modules', 'Modules', { reports: true, shifts: true, reports_state: 'ready' }, 2)
    ],
    business_hours: [],
    offers: [],
    roles: [],
    notification_policies: [],
    integrations: [],
    profiles_summary: { total: 2, active: 2, inactive: 0, roles: { admin: 1, bartender: 1 } },
    preferences: { theme: 'light', density: 'comfortable', language: 'en', start_view: 'briefing', timezone: 'Atlantic/Reykjavik', reduce_motion: false, browser_notifications: false, email_notifications: false },
    events: [],
    ...overrides
  };
}

/** A stateful atlas-settings mock that applies saves and bumps versions. */
export function settingsBackend({ user = USERS.admin, delayMs = 0, workspace = settingsWorkspace() } = {}) {
  const calls = [];
  const handler = async (entry) => {
    calls.push(entry);
    if (delayMs && entry.method === 'POST') await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (entry.method === 'POST' && entry.action === 'save-section') {
      const target = workspace.sections.find((row) => row.section_key === entry.body.section_key);
      if (target.version !== entry.body.expected_version) return { __status: 409, body: { error: 'Settings changed after this page was opened' } };
      target.value = entry.body.value;
      target.version += 1;
    }
    if (entry.method === 'POST' && entry.action === 'save-hours') {
      if (!Array.isArray(entry.body.hours) || entry.body.hours.length !== 7) return { __status: 400, body: { error: 'Business hours must contain all seven days.' } };
      workspace.business_hours = entry.body.hours.map((row) => ({ ...row, open_time: row.open_time && `${row.open_time}:00`, close_time: row.close_time && `${row.close_time}:00` }));
    }
    if (entry.method === 'POST' && entry.action === 'save-preferences') {
      const { preferences, ...rest } = entry.body;
      workspace.preferences = { ...workspace.preferences, ...rest };
    }
    return { workspace, staff: { id: user.id, label: user.display_name, role: user.role, active: true } };
  };
  return { handler, calls, workspace };
}

export function emptyFunctions(names = [
  'atlas-knowledge', 'atlas-shifts', 'atlas-team-messages', 'atlas-reports', 'atlas-system', 'atlas-settings',
  'atlas-marketing-workspace', 'atlas-team-profiles', 'atlas-operations-checkpoint-a', 'atlas-phase3-brain',
  'atlas-stock-counts', 'atlas-team-profile-photos', 'atlas-phase3-intelligence',
  'atlas-sprint3-review', 'atlas-notifications', 'atlas-item-master', 'atlas-inventory-scanner'
]) {
  return Object.fromEntries(names.map((name) => [name, {}]));
}

/**
 * Seven saved business-hour rows shaped like atlas-settings venue-clock rows
 * (weekday 0 = Sunday). Test data only: Atlas itself never ships default hours.
 */
export function weekHours({ open = '15:00:00', close = '00:00:00', lateClose = '03:00:00', lastOrder = '23:30:00', lateLastOrder = '02:30:00', closedWeekdays = [] } = {}) {
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return labels.map((day_label, weekday) => {
    const late = weekday === 5 || weekday === 6;
    const isOpen = !closedWeekdays.includes(weekday);
    return {
      weekday, day_label, is_open: isOpen,
      open_time: isOpen ? open : null, close_time: isOpen ? (late ? lateClose : close) : null, close_next_day: isOpen,
      kitchen_close_time: null, kitchen_close_next_day: false,
      last_order_time: isOpen ? (late ? lateLastOrder : lastOrder) : null, last_order_next_day: isOpen && late,
      updated_at: now
    };
  });
}

/**
 * atlas-settings mock answering GET ?action=venue-clock from mutable state
 * (`backend.hours`, `backend.offers`, `backend.timezone`); other actions go to
 * `fallback` (default: an empty 200). `status` forces an error status (404 =
 * function not deployed).
 */
export function venueClockBackend({ hours = [], offers = [], timezone = 'Atlantic/Reykjavik', status = 200, fallback = null } = {}) {
  const backend = { hours, offers, timezone, status, calls: [] };
  backend.handler = async (entry) => {
    if (entry.method === 'GET' && entry.action === 'venue-clock') {
      backend.calls.push(entry);
      if (backend.status !== 200) return { __status: backend.status, body: { error: backend.status === 404 ? 'Not found' : 'Unavailable' } };
      return {
        clock: {
          timezone: backend.timezone, timezone_source: 'settings', hours_configured: backend.hours.length === 7,
          business_hours: backend.hours, offers: backend.offers,
          venue_date: null, business_date: null, venue_local_time: null, generated_at: now
        },
        staff: { id: entry.user.id, role: entry.user.role, active: true, can_manage_hours: ['admin', 'manager'].includes(entry.user.role) }
      };
    }
    return fallback ? fallback(entry) : {};
  };
  return backend;
}
